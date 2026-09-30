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
  PERMISSION_DEFS,
  ROLE_LABELS,
  getRolePermissions,
  permissionsForRole,
  setRolePermissions,
  type Permission,
} from './permissions';
import {
  SESSION_COOKIE,
  changeOwnPassword,
  createSession,
  createUser,
  deleteUser,
  destroySession,
  listUsers,
  login,
  requireAdminRole,
  requireAuth,
  requirePermission,
  tokenFromRequest,
  updateUser,
} from './users';
import type { SystemRow, UserRole } from './types';

export const apiRouter = Router();

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

  const user = login(username, password);
  if (!user) {
    recordLoginFailure(ip);
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  clearLoginFailures(ip);
  const { token, expiresAt } = createSession(user.id);
  res.setHeader(
    'Set-Cookie',
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((expiresAt - Date.now()) / 1000)}`,
  );
  const permissions = permissionsForRole(user.role);
  res.json({ user: { id: user.id, username: user.username, role: user.role }, permissions });
});

apiRouter.post('/auth/logout', (req, res) => {
  const token = tokenFromRequest(req);
  if (token) destroySession(token);
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

apiRouter.get('/auth/me', requireAuth, (req, res) => {
  const u = req.user!;
  res.json({
    user: { id: u.id, username: u.username, role: u.role },
    permissions: permissionsForRole(u.role),
  });
});

apiRouter.post('/auth/change-password', requireAuth, (req, res) => {
  const oldPassword = typeof req.body?.old_password === 'string' ? req.body.old_password : '';
  const newPassword = typeof req.body?.new_password === 'string' ? req.body.new_password : '';
  const result = changeOwnPassword(req.user!.id, oldPassword, newPassword);
  if (!result.ok) return res.status(400).json({ error: result.error });
  // 改密后所有会话已清除，当前会话也失效，要求重新登录
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

// ---- 用户管理 ----
apiRouter.get('/users', requirePermission('users.manage'), (_req, res) => {
  res.json({ users: listUsers() });
});

apiRouter.post('/users', requirePermission('users.manage'), (req, res) => {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : '';
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const role = typeof req.body?.role === 'string' ? req.body.role : 'viewer';
  const result = createUser(username, password, role);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.status(201).json({ users: listUsers() });
});

apiRouter.patch('/users/:id', requirePermission('users.manage'), (req, res) => {
  const id = Number(req.params.id);
  const patch: { role?: string; password?: string } = {};
  if (typeof req.body?.role === 'string') patch.role = req.body.role;
  if (typeof req.body?.password === 'string' && req.body.password) patch.password = req.body.password;
  const result = updateUser(id, patch, req.user!.id);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ users: listUsers() });
});

apiRouter.delete('/users/:id', requirePermission('users.manage'), (req, res) => {
  const result = deleteUser(Number(req.params.id), req.user!.id);
  if (!result.ok) return res.status(400).json({ error: result.error });
  res.json({ users: listUsers() });
});

// ---- 角色权限配置 ----
apiRouter.get('/roles/permissions', requirePermission('users.manage'), (_req, res) => {
  res.json({
    permissions: PERMISSION_DEFS,
    roles: ROLE_LABELS,
    role_permissions: getRolePermissions(),
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
  const role_permissions = setRolePermissions(patch);
  res.json({
    permissions: PERMISSION_DEFS,
    roles: ROLE_LABELS,
    role_permissions,
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
  const info = db
    .prepare('INSERT INTO systems(name, base_url, use_sso, created_at) VALUES (?, ?, ?, ?)')
    .run(name, baseUrl, useSso, Date.now());
  res.status(201).json(serializeSystem(db.prepare('SELECT * FROM systems WHERE id = ?').get(info.lastInsertRowid)));
});

apiRouter.get('/systems', (_req, res) => {
  res.json({ systems: (db.prepare('SELECT * FROM systems ORDER BY id').all() as unknown[]).map(serializeSystem) });
});

apiRouter.get('/systems/:id', (req, res) => {
  const system = db.prepare('SELECT * FROM systems WHERE id = ?').get(Number(req.params.id));
  if (!system) return res.status(404).json({ error: '系统不存在' });
  res.json(serializeSystem(system));
});

apiRouter.get('/systems/:id/metrics', async (req, res) => {
  const id = Number(req.params.id);
  const range = parseMetricsRange(req.query.range);
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
  const info = db.prepare('DELETE FROM systems WHERE id = ?').run(id);
  if (info.changes === 0) return res.status(404).json({ error: '系统不存在' });
  db.prepare('DELETE FROM candidates WHERE system_id = ?').run(id);
  const monitorIds = (db.prepare('SELECT id FROM monitors WHERE system_id = ?').all(id) as { id: number }[]).map((r) => r.id);
  for (const mid of monitorIds) {
    db.prepare('DELETE FROM checks WHERE monitor_id = ?').run(mid);
    db.prepare('DELETE FROM alerts WHERE monitor_id = ?').run(mid);
  }
  db.prepare('DELETE FROM monitors WHERE system_id = ?').run(id);
  res.json({ ok: true });
});

// ---- token 自动续期（SSO 登录 → 换取 Admin-Token 写回） ----
apiRouter.post('/systems/:id/renew-token', requirePermission('systems.manage'), async (req, res) => {
  const systemId = Number(req.params.id);
  const system = db.prepare('SELECT * FROM systems WHERE id = ?').get(systemId);
  if (!system) return res.status(404).json({ error: '系统不存在' });
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
  const job = startAnalysis(systemId);
  res.status(202).json(job);
});

apiRouter.get('/systems/:id/analysis', (req, res) => {
  const systemId = Number(req.params.id);
  const system = db.prepare('SELECT id FROM systems WHERE id = ?').get(systemId);
  if (!system) return res.status(404).json({ error: '系统不存在' });
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
apiRouter.get('/dashboard', async (_req, res) => {
  try {
    res.json(await buildDashboard());
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---- 监控大屏聚合数据 ----
apiRouter.get('/screen', async (_req, res) => {
  try {
    res.json(await buildScreen());
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

// ---- alerts ----
apiRouter.get('/alerts', (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const unackedOnly = req.query.acknowledged === '0';
  const rows = db
    .prepare(
      `SELECT a.*, m.name AS monitor_name, m.system_id, s.name AS system_name
       FROM alerts a
       JOIN monitors m ON m.id = a.monitor_id
       JOIN systems s ON s.id = m.system_id
       ${unackedOnly ? 'WHERE a.acknowledged = 0' : ''}
       ORDER BY a.ts DESC LIMIT ?`,
    )
    .all(limit);
  res.json({ alerts: rows });
});

apiRouter.post('/alerts/:id/ack', requirePermission('alerts.ack'), (req, res) => {
  const info = db.prepare('UPDATE alerts SET acknowledged = 1 WHERE id = ?').run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: '告警不存在' });
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
