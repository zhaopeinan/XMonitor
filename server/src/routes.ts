import { Router } from 'express';
import { db } from './db';
import { getMaskedSettings, updateSettings } from './settings';
import { getActiveProfile, testProfile } from './llm';
import { checkObscuraHealth, getBrowser } from './obscura';
import { ensureSession, renewSystemToken, type SsoLevel } from './sso';
import { getAnalysis, startAnalysis } from './analyzer';
import { buildDashboard } from './dashboard';
import { buildScreen } from './screen';
import { buildSystemStatus } from './systemStatus';
import { buildSystemMetrics, parseMetricsRange } from './systemMetrics';
import { checkVmHealth } from './vm';
import { monitorsRouter } from './monitors';
import { ledgerRouter } from './ledger';
import { llmProfilesRouter } from './profiles';
import { llmChannelsRouter } from './llmChannels';
import {
  assertNotLocked,
  clearLoginFailures,
  clientIp,
  consumeCaptcha,
  createCaptcha,
  recordLoginFailure,
} from './captcha';
import {
  ALL_PERMISSIONS,
  DATA_SCOPE_DEFS,
  PERMISSION_DEFS,
  ROLE_LABELS,
  getRoleDataScopes,
  getRolePermissions,
  dataScopeForRole,
  permissionsForRole,
  setRoleDataScopes,
  setRolePermissions,
  type DataScope,
  type Permission,
} from './permissions';
import {
  OUT_OF_SCOPE_ERROR,
  alertInScope,
  dataScopeOf,
  idListSql,
  ledgerInScope,
  systemInScope,
  systemScopeSql,
} from './scope';
import {
  SESSION_COOKIE,
  changeOwnPassword,
  createSession,
  createUser,
  deleteUser,
  destroySession,
  getUserBrief,
  getSessionUser,
  listSessions,
  listUsers,
  login,
  normalizeOpsUnit,
  requireAdminRole,
  requireAuth,
  requirePermission,
  revokeSessionById,
  revokeUserSessions,
  sessionIdOf,
  tokenFromRequest,
  updateUser,
} from './users';
import { AUDIT_ACTION_LABELS, listAuditLogs, recordAudit } from './audit';
import type { SystemRow, UserRole, UserRow } from './types';

export const apiRouter = Router();

/**
 * 登录与「取当前用户」返回同一份身份信息：
 * 角色、功能权限（能做什么）、数据范围（能看哪些数据）。
 * 数据范围每个请求现算，因此管理员改了配置立刻生效，不需要用户重新登录。
 */
function identityOf(user: Pick<UserRow, 'id' | 'username' | 'role' | 'ops_unit'>) {
  return {
    user: { id: user.id, username: user.username, role: user.role, ops_unit: user.ops_unit ?? '' },
    permissions: permissionsForRole(user.role),
    data_scope: dataScopeForRole(user.role),
  };
}

/** 登录接口记录来源 IP 与客户端，供「在线会话」展示 */
function userAgentOf(req: { headers: Record<string, unknown> }): string {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua.slice(0, 300) : '';
}

// ---- 认证（登录/验证码公开，其余 /api 均需登录） ----
apiRouter.get('/auth/captcha', (_req, res) => {
  const { id, svg } = createCaptcha();
  res.json({ captcha_id: id, captcha_svg: svg });
});

apiRouter.post('/auth/login', (req, res) => {
  const ip = clientIp(req);
  const lock = assertNotLocked(ip);
  if (!lock.ok) {
    return res.status(429).json({ error: `登录失败过多，请 ${lock.retryAfterSec} 秒后重试` });
  }

  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const captchaId = typeof req.body?.captcha_id === 'string' ? req.body.captcha_id : '';
  const captchaCode = typeof req.body?.captcha_code === 'string' ? req.body.captcha_code : '';
  if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
  if (!captchaId || !captchaCode) return res.status(400).json({ error: '请填写验证码' });
  if (!consumeCaptcha(captchaId, captchaCode)) {
    recordLoginFailure(ip);
    return res.status(400).json({ error: '验证码错误或已过期' });
  }

  const outcome = login(username, password);
  if (!outcome.ok) {
    if (outcome.countFailure) recordLoginFailure(ip);
    recordAudit({
      actorId: outcome.actorId ?? null,
      actorName: username,
      action: 'login_failed',
      target: username,
      detail: outcome.error,
      ip,
    });
    return res.status(401).json({ error: outcome.error });
  }
  const user = outcome.user;
  clearLoginFailures(ip);
  const { token, expiresAt } = createSession(user.id, ip, userAgentOf(req));
  recordAudit({
    actorId: user.id,
    actorName: user.username,
    action: 'login',
    target: user.username,
    detail: `角色：${ROLE_LABELS[user.role] ?? user.role}${user.ops_unit ? ` · 运维单位：${user.ops_unit}` : ''}`,
    ip,
  });
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((expiresAt - Date.now()) / 1000)}`,
  );
  res.json(identityOf(user));
});

apiRouter.post('/auth/logout', (req, res) => {
  const token = tokenFromRequest(req);
  if (token) {
    const user = getSessionUser(token);
    if (user) {
      recordAudit({
        actorId: user.id,
        actorName: user.username,
        action: 'logout',
        target: user.username,
        ip: clientIp(req),
      });
    }
    destroySession(token);
  }
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

apiRouter.get('/auth/me', requireAuth, (req, res) => {
  res.json(identityOf(req.user!));
});

apiRouter.post('/auth/change-password', requireAuth, (req, res) => {
  const oldPassword = typeof req.body?.old_password === 'string' ? req.body.old_password : '';
  const newPassword = typeof req.body?.new_password === 'string' ? req.body.new_password : '';
  const result = changeOwnPassword(req.user!.id, oldPassword, newPassword);
  if (!result.ok) return res.status(400).json({ error: result.error });
  recordAudit({
    actorId: req.user!.id,
    actorName: req.user!.username,
    action: 'password_change',
    target: req.user!.username,
    detail: '所有会话已失效，需重新登录',
    ip: clientIp(req),
  });
  // 改密后所有会话已清除，当前会话也失效，要求重新登录
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

// ---- 用户管理 ----
apiRouter.get('/users', requirePermission('users.manage'), (_req, res) => {
  res.json({ users: listUsers() });
});

/** 台账里出现过的运维单位：作为「所属运维单位」的候选，保证两边写法一致 */
apiRouter.get('/users/ops-units', requirePermission('users.manage'), (_req, res) => {
  const rows = db
    .prepare(
      `SELECT DISTINCT TRIM(ops_unit) AS unit FROM system_ledgers WHERE TRIM(ops_unit) != ''
       UNION
       SELECT DISTINCT TRIM(ops_unit) AS unit FROM systems WHERE TRIM(ops_unit) != ''
       ORDER BY unit`,
    )
    .all() as { unit: string }[];
  res.json({ units: rows.map((r) => r.unit) });
});

apiRouter.post('/users', requirePermission('users.manage'), (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const role = typeof req.body?.role === 'string' ? req.body.role : 'viewer';
  const opsUnit = normalizeOpsUnit(req.body?.ops_unit);
  const result = createUser({ username, password, role, opsUnit }, req.user!.role);
  if (!result.ok) return res.status(400).json({ error: result.error });
  recordAudit({
    actorId: req.user!.id,
    actorName: req.user!.username,
    action: 'user.create',
    target: username,
    detail: `角色：${ROLE_LABELS[role as UserRole] ?? role}${opsUnit ? ` · 运维单位：${opsUnit}` : ''}`,
    ip: clientIp(req),
  });
  res.status(201).json({ users: listUsers() });
});

apiRouter.patch('/users/:id', requirePermission('users.manage'), (req, res) => {
  const id = Number(req.params.id);
  const patch: { role?: string; password?: string; disabled?: boolean; opsUnit?: string } = {};
  if (typeof req.body?.role === 'string') patch.role = req.body.role;
  if (typeof req.body?.password === 'string' && req.body.password) patch.password = req.body.password;
  if (typeof req.body?.disabled === 'boolean') patch.disabled = req.body.disabled;
  if (typeof req.body?.ops_unit === 'string') patch.opsUnit = req.body.ops_unit;
  const target = getUserBrief(id);
  const result = updateUser(id, patch, req.user!.id);
  if (!result.ok) return res.status(400).json({ error: result.error });
  const actor = { actorId: req.user!.id, actorName: req.user!.username, ip: clientIp(req) };
  const name = target?.username ?? `#${id}`;
  if (patch.role !== undefined) {
    recordAudit({ ...actor, action: 'user.role', target: name, detail: `→ ${ROLE_LABELS[patch.role as UserRole] ?? patch.role}` });
  }
  if (patch.password !== undefined) {
    recordAudit({ ...actor, action: 'user.password_reset', target: name, detail: '会话已全部失效' });
  }
  if (patch.disabled !== undefined) {
    recordAudit({
      ...actor,
      action: patch.disabled ? 'user.disable' : 'user.enable',
      target: name,
      detail: patch.disabled ? '已踢下线' : '',
    });
  }
  if (patch.opsUnit !== undefined) {
    const from = target?.ops_unit ?? '';
    const to = normalizeOpsUnit(patch.opsUnit);
    recordAudit({
      ...actor,
      action: 'user.ops_unit',
      target: name,
      detail: `${from || '（未设置）'} → ${to || '（不设置）'}`,
    });
  }
  res.json({ users: listUsers() });
});

apiRouter.delete('/users/:id', requirePermission('users.manage'), (req, res) => {
  const id = Number(req.params.id);
  const target = getUserBrief(id);
  const result = deleteUser(id, req.user!.id);
  if (!result.ok) return res.status(400).json({ error: result.error });
  recordAudit({
    actorId: req.user!.id,
    actorName: req.user!.username,
    action: 'user.delete',
    target: target?.username ?? `#${id}`,
    detail: target ? `原角色：${ROLE_LABELS[target.role] ?? target.role}` : '',
    ip: clientIp(req),
  });
  res.json({ users: listUsers() });
});

// ---- 在线会话：查看与强制下线 ----
apiRouter.get('/sessions', requirePermission('users.manage'), (req, res) => {
  res.json({ sessions: listSessions(tokenFromRequest(req)) });
});

apiRouter.delete('/sessions/:id', requirePermission('users.manage'), (req, res) => {
  const current = tokenFromRequest(req);
  if (current && req.params.id === sessionIdOf(current)) {
    return res.status(400).json({ error: '不能踢出当前登录的会话，如需退出请用「退出登录」' });
  }
  const result = revokeSessionById(String(req.params.id), req.user!.role);
  if (!result.ok) return res.status(400).json({ error: result.error });
  recordAudit({
    actorId: req.user!.id,
    actorName: req.user!.username,
    action: 'session.revoke',
    target: result.username,
    detail: result.ip ? `来源 ${result.ip}` : '',
    ip: clientIp(req),
  });
  res.json({ sessions: listSessions(current) });
});

apiRouter.delete('/users/:id/sessions', requirePermission('users.manage'), (req, res) => {
  const id = Number(req.params.id);
  const target = getUserBrief(id);
  if (!target) return res.status(400).json({ error: '用户不存在' });
  if (target.role === 'admin' && req.user!.role !== 'admin') {
    return res.status(400).json({ error: '仅管理员可以操作管理员的会话' });
  }
  const current = tokenFromRequest(req);
  // 踢自己时保留当前会话，等价于「其他设备下线」
  const keepCurrent = id === req.user!.id ? current : null;
  const revoked = revokeUserSessions(id, keepCurrent);
  recordAudit({
    actorId: req.user!.id,
    actorName: req.user!.username,
    action: 'session.revoke_user',
    target: target.username,
    detail: `下线 ${revoked} 个会话${keepCurrent ? '（保留当前会话）' : ''}`,
    ip: clientIp(req),
  });
  res.json({ sessions: listSessions(current), revoked });
});

// ---- 审计日志 ----
apiRouter.get('/audit-logs', requirePermission('users.manage'), (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const action = typeof req.query.action === 'string' ? req.query.action.trim() : '';
  res.json({ ...listAuditLogs({ limit, offset, q, action }), actions: AUDIT_ACTION_LABELS });
});

// ---- 角色权限配置：功能权限（能做什么）+ 数据权限（能看哪些数据） ----
apiRouter.get('/roles/permissions', requirePermission('users.manage'), (_req, res) => {
  res.json({
    permissions: PERMISSION_DEFS,
    data_scopes: DATA_SCOPE_DEFS,
    roles: ROLE_LABELS,
    role_permissions: getRolePermissions(),
    role_data_scopes: getRoleDataScopes(),
  });
});

apiRouter.put('/roles/permissions', requirePermission('users.manage'), (req, res) => {
  const body = req.body ?? {};
  const patch: Partial<Record<UserRole, Permission[]>> = {};
  for (const role of ['operator', 'viewer'] as UserRole[]) {
    const list = body[role];
    if (!Array.isArray(list)) continue;
    patch[role] = list.filter((p: unknown): p is Permission => typeof p === 'string' && (ALL_PERMISSIONS as string[]).includes(p));
  }
  // 数据权限与功能权限分开传：只传了其中一项时，另一项保持原样
  const scopePatch: Partial<Record<UserRole, DataScope>> = {};
  const rawScopes = (body.data_scopes ?? {}) as Record<string, unknown>;
  for (const role of ['operator', 'viewer'] as UserRole[]) {
    const value = rawScopes[role];
    if (value === 'all' || value === 'unit' || value === 'self') scopePatch[role] = value;
  }
  const before = getRolePermissions();
  const beforeScopes = getRoleDataScopes();
  const role_permissions = setRolePermissions(patch);
  const role_data_scopes = setRoleDataScopes(scopePatch);
  const labelOf = (key: string) => PERMISSION_DEFS.find((p) => p.key === key)?.label ?? key;
  const scopeLabelOf = (key: string) => DATA_SCOPE_DEFS.find((d) => d.key === key)?.label ?? key;
  const diff: string[] = [];
  for (const role of ['operator', 'viewer'] as UserRole[]) {
    const parts: string[] = [];
    if (patch[role]) {
      const prev = new Set(before[role] ?? []);
      const next = new Set(role_permissions[role] ?? []);
      const added = [...next].filter((k) => !prev.has(k)).map(labelOf);
      const removed = [...prev].filter((k) => !next.has(k)).map(labelOf);
      if (added.length) parts.push(`功能权限新增「${added.join('、')}」`);
      if (removed.length) parts.push(`功能权限移除「${removed.join('、')}」`);
    }
    if (scopePatch[role] && beforeScopes[role] !== role_data_scopes[role]) {
      parts.push(`数据范围 ${scopeLabelOf(beforeScopes[role])} → ${scopeLabelOf(role_data_scopes[role])}`);
    }
    if (patch[role] || scopePatch[role]) diff.push(`${ROLE_LABELS[role]}：${parts.length ? parts.join('，') : '无变化'}`);
  }
  recordAudit({
    actorId: req.user!.id,
    actorName: req.user!.username,
    action: 'role.permissions',
    target: '角色权限矩阵',
    detail: diff.join('；'),
    ip: clientIp(req),
  });
  res.json({
    permissions: PERMISSION_DEFS,
    data_scopes: DATA_SCOPE_DEFS,
    roles: ROLE_LABELS,
    role_permissions,
    role_data_scopes,
  });
});

// 除公开认证接口外的所有 API 均需登录
apiRouter.use(requireAuth);

// ---- 以下为原有路由 ----

apiRouter.get('/health/obscura', async (_req, res) => {
  res.json(await checkObscuraHealth());
});

apiRouter.get('/health/vm', async (_req, res) => {
  res.json(await checkVmHealth());
});

/** 本机基础设施状况：仅管理员角色 */
apiRouter.get('/system-status', requireAdminRole, async (_req, res) => {
  try {
    res.json(await buildSystemStatus());
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---- SSO 登录测试 ----
apiRouter.post('/sso/test', requirePermission('settings.manage'), async (req, res) => {
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
  if (!url) return res.status(400).json({ error: 'url 必填' });
  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'url 不是合法 URL' });
  }
  const steps: { phase: string; level: SsoLevel; message: string }[] = [];
  const emit = (phase: string, level: SsoLevel, message: string) => steps.push({ phase, level, message });
  let page: import('puppeteer-core').Page | null = null;
  try {
    const browser = await getBrowser();
    // 测试接口强制走完整登录流程（即使未启用 SSO 或未配置凭据）；
    // 允许请求体携带表单上未保存的凭据，空值/省略则回落到已保存的设置
    const u = typeof req.body?.username === 'string' && req.body.username.trim() ? req.body.username.trim() : undefined;
    const p = typeof req.body?.password === 'string' && req.body.password && !req.body.password.startsWith('****') ? req.body.password : undefined;
    const result = await ensureSession(browser, url, emit, { force: true, username: u, password: p });
    page = result.page;
    const lastProblem = [...steps].reverse().find((s) => s.level === 'error' || s.level === 'warn');
    res.json({
      ok: result.loggedIn,
      message: result.loggedIn ? 'SSO 登录成功' : lastProblem?.message ?? '未检测到登录页',
      steps,
    });
  } catch (e) {
    res.json({ ok: false, message: e instanceof Error ? e.message : String(e), steps });
  } finally {
    if (page) await page.close().catch(() => {});
  }
});

// ---- systems ----
// auth_token 序列化时打码，绝不返回原文
function serializeSystem(s: unknown): unknown {
  const row = s as Record<string, unknown>;
  if (!row) return s;
  const t = typeof row.auth_token === 'string' ? row.auth_token : '';
  return { ...row, auth_token: undefined, has_token: !!t, auth_token_masked: t ? `****${t.slice(-4)}` : '' };
}

apiRouter.post('/systems', requirePermission('systems.manage'), (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
  const baseUrl = typeof req.body?.base_url === 'string' ? req.body.base_url.trim() : '';
  if (!name || !baseUrl) return res.status(400).json({ error: 'name 和 base_url 必填' });
  try {
    new URL(baseUrl);
  } catch {
    return res.status(400).json({ error: 'base_url 不是合法 URL' });
  }
  const useSso = req.body?.use_sso === false || req.body?.use_sso === 0 ? 0 : 1;
  // 归属运维单位：默认取操作者自己的单位，避免新建后正是本单位的账号看不到
  const opsUnit =
    typeof req.body?.ops_unit === 'string' ? req.body.ops_unit.trim().slice(0, 120) : (req.user!.ops_unit ?? '').trim();
  const info = db
    .prepare('INSERT INTO systems(name, base_url, use_sso, ops_unit, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(name, baseUrl, useSso, opsUnit, req.user!.id, Date.now());
  res.status(201).json(serializeSystem(db.prepare('SELECT * FROM systems WHERE id = ?').get(info.lastInsertRowid)));
});

apiRouter.get('/systems', (req, res) => {
  const scope = systemScopeSql(dataScopeOf(req.user!), 's');
  res.json({
    systems: (
      db.prepare(`SELECT s.* FROM systems s WHERE ${scope.sql} ORDER BY s.id`).all(...scope.params) as unknown[]
    ).map(serializeSystem),
  });
});

apiRouter.get('/systems/:id', (req, res) => {
  const id = Number(req.params.id);
  const system = db.prepare('SELECT * FROM systems WHERE id = ?').get(id);
  if (!system) return res.status(404).json({ error: '系统不存在' });
  if (!systemInScope(dataScopeOf(req.user!), id)) return res.status(403).json({ error: OUT_OF_SCOPE_ERROR });
  res.json(serializeSystem(system));
});

apiRouter.get('/systems/:id/metrics', async (req, res) => {
  const id = Number(req.params.id);
  const range = parseMetricsRange(req.query.range);
  if (!systemInScope(dataScopeOf(req.user!), id)) return res.status(403).json({ error: OUT_OF_SCOPE_ERROR });
  try {
    const payload = await buildSystemMetrics(id, range);
    if (!payload) return res.status(404).json({ error: '系统不存在' });
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

apiRouter.patch('/systems/:id', requirePermission('systems.manage'), (req, res) => {
  const id = Number(req.params.id);
  const system = db.prepare('SELECT * FROM systems WHERE id = ?').get(id);
  if (!system) return res.status(404).json({ error: '系统不存在' });
  if (!systemInScope(dataScopeOf(req.user!), id)) return res.status(403).json({ error: OUT_OF_SCOPE_ERROR });
  const b = req.body ?? {};
  const sets: string[] = [];
  const values: unknown[] = [];
  if (typeof b.name === 'string' && b.name.trim()) {
    sets.push('name = ?');
    values.push(b.name.trim());
  }
  if (typeof b.base_url === 'string' && b.base_url.trim()) {
    try {
      new URL(b.base_url.trim());
    } catch {
      return res.status(400).json({ error: 'base_url 不是合法 URL' });
    }
    sets.push('base_url = ?');
    values.push(b.base_url.trim());
  }
  if (typeof b.use_sso === 'boolean' || b.use_sso === 0 || b.use_sso === 1) {
    sets.push('use_sso = ?');
    values.push(b.use_sso ? 1 : 0);
  }
  if (typeof b.ops_unit === 'string') {
    sets.push('ops_unit = ?');
    values.push(b.ops_unit.trim().slice(0, 120));
  }
  // auth_token：空串清除；打码值（**** 开头）表示不修改
  if (typeof b.auth_token === 'string') {
    if (b.auth_token === '') {
      sets.push('auth_token = NULL');
    } else if (!b.auth_token.startsWith('****')) {
      sets.push('auth_token = ?');
      values.push(b.auth_token.trim());
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: '没有可更新的字段' });
  db.prepare(`UPDATE systems SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  res.json(serializeSystem(db.prepare('SELECT * FROM systems WHERE id = ?').get(id)));
});

apiRouter.delete('/systems/:id', requirePermission('systems.manage'), (req, res) => {
  const id = Number(req.params.id);
  if (!systemInScope(dataScopeOf(req.user!), id)) {
    const exists = db.prepare('SELECT id FROM systems WHERE id = ?').get(id);
    return exists ? res.status(403).json({ error: OUT_OF_SCOPE_ERROR }) : res.status(404).json({ error: '系统不存在' });
  }
  const info = db.prepare('DELETE FROM systems WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: '系统不存在' });
  db.prepare('DELETE FROM candidates WHERE system_id = ?').run(id);
  const monitorIds = (db.prepare('SELECT id FROM monitors WHERE system_id = ?').all(id) as { id: number }[]).map((r) => r.id);
  for (const mid of monitorIds) {
    db.prepare('DELETE FROM checks WHERE monitor_id = ?').run(mid);
    db.prepare('DELETE FROM alerts WHERE monitor_id = ?').run(mid);
  }
  db.prepare('DELETE FROM monitors WHERE system_id = ?').run(id);
  // 台账里的关联是可选引用：系统删除后条目保留，仅解除关联
  db.prepare('UPDATE system_ledgers SET system_id = NULL, updated_at = ? WHERE system_id = ?').run(Date.now(), id);
  res.json({ ok: true });
});

// ---- token 自动续期（SSO 登录 → 换取 Admin-Token 写回） ----
apiRouter.post('/systems/:id/renew-token', requirePermission('systems.manage'), async (req, res) => {
  const systemId = Number(req.params.id);
  const system = db.prepare('SELECT * FROM systems WHERE id = ?').get(systemId);
  if (!system) return res.status(404).json({ error: '系统不存在' });
  if (!systemInScope(dataScopeOf(req.user!), systemId)) return res.status(403).json({ error: OUT_OF_SCOPE_ERROR });
  const steps: { phase: string; level: SsoLevel; message: string }[] = [];
  const emit = (phase: string, level: SsoLevel, message: string) => steps.push({ phase, level, message });
  try {
    const result = await renewSystemToken(systemId, emit, { force: true });
    res.json({ ...result, steps });
  } catch (e) {
    res.json({ ok: false, message: e instanceof Error ? e.message : String(e), steps });
  }
});

// ---- analysis ----
apiRouter.post('/systems/:id/analyze', requirePermission('analyze'), (req, res) => {
  const systemId = Number(req.params.id);
  const system = db.prepare('SELECT id FROM systems WHERE id = ?').get(systemId) as SystemRow | undefined;
  if (!system) return res.status(404).json({ error: '系统不存在' });
  if (!systemInScope(dataScopeOf(req.user!), systemId)) return res.status(403).json({ error: OUT_OF_SCOPE_ERROR });
  const job = startAnalysis(systemId);
  res.status(202).json(job);
});

apiRouter.get('/systems/:id/analysis', (req, res) => {
  const systemId = Number(req.params.id);
  const system = db.prepare('SELECT id FROM systems WHERE id = ?').get(systemId);
  if (!system) return res.status(404).json({ error: '系统不存在' });
  if (!systemInScope(dataScopeOf(req.user!), systemId)) return res.status(403).json({ error: OUT_OF_SCOPE_ERROR });
  const { job, candidates } = getAnalysis(systemId);
  res.json({
    status: job?.status ?? 'idle',
    progress: job?.progress ?? [],
    events: job?.events ?? [],
    error: job?.error ?? null,
    started_at: job?.started_at ?? null,
    finished_at: job?.finished_at ?? null,
    candidates,
  });
});

// ---- dashboard ----
apiRouter.get('/dashboard', async (req, res) => {
  try {
    res.json(await buildDashboard(dataScopeOf(req.user!)));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---- 监控大屏聚合数据 ----
apiRouter.get('/screen', async (req, res) => {
  try {
    res.json(await buildScreen(dataScopeOf(req.user!)));
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---- alerts ----
apiRouter.get('/alerts', (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const unackedOnly = req.query.acknowledged === '0';
  const scope = systemScopeSql(dataScopeOf(req.user!), 's');
  const rows = db
    .prepare(
      `SELECT a.*, m.name AS monitor_name, m.system_id, s.name AS system_name
       FROM alerts a
       JOIN monitors m ON m.id = a.monitor_id
       JOIN systems s ON s.id = m.system_id
       WHERE ${scope.sql}${unackedOnly ? ' AND a.acknowledged = 0' : ''}
       ORDER BY a.ts DESC LIMIT ?`,
    )
    .all(...scope.params, limit);
  res.json({ alerts: rows });
});

apiRouter.post('/alerts/:id/ack', requirePermission('alerts.ack'), (req, res) => {
  const id = Number(req.params.id);
  const exists = db.prepare('SELECT id FROM alerts WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: '告警不存在' });
  if (!alertInScope(dataScopeOf(req.user!), id)) return res.status(403).json({ error: OUT_OF_SCOPE_ERROR });
  db.prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ?').run(id);
  res.json({ ok: true });
});

// ---- settings ----
apiRouter.get('/settings', (_req, res) => {
  res.json(getMaskedSettings());
});

apiRouter.put('/settings', requirePermission('settings.manage'), (req, res) => {
  if (!req.body || typeof req.body !== 'object') return res.status(400).json({ error: '请求体必须是对象' });
  updateSettings(req.body as Record<string, unknown>);
  res.json(getMaskedSettings());
});

// 兼容旧路由：测试当前激活档案
apiRouter.post('/settings/test-llm', requirePermission('settings.manage'), async (_req, res) => {
  const profile = getActiveProfile();
  if (!profile) return res.json({ ok: false, error: '未配置激活的 LLM 档案，请先到设置页添加并激活' });
  res.json(await testProfile(profile));
});

// ---- LLM：分析档案 与 监控渠道 完全分离 ----
apiRouter.use(llmProfilesRouter);
apiRouter.use(llmChannelsRouter);

// ---- monitor CRUD ----
apiRouter.use(monitorsRouter);

// ---- 系统台账 ----
apiRouter.use(ledgerRouter);
