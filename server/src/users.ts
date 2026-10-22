import crypto from 'node:crypto';
import type express from 'express';
import { db } from './db';
import { isValidRole, permissionsForRole, type Permission } from './permissions';
import type { UserRow, UserRole } from './types';

export const SESSION_COOKIE = 'xm_session';
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000; // 7 天

// ---- 密码散列（scrypt + 随机盐） ----
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

function verifyPassword(password: string, stored: string): boolean {
  const [scheme, salt, hash] = stored.split(':');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const calc = crypto.scryptSync(password, salt, 64);
  const expect = Buffer.from(hash, 'hex');
  return calc.length === expect.length && crypto.timingSafeEqual(calc, expect);
}

// ---- 首次启动播种默认管理员 ----
export function seedDefaultAdmin(): void {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (count > 0) return;
  db.prepare('INSERT INTO users(username, password_hash, role, created_at) VALUES (?, ?, ?, ?)').run(
    'admin',
    hashPassword('admin123'),
    'admin',
    Date.now(),
  );
  console.log('[auth] 已创建默认管理员账号 admin / admin123，请登录后尽快修改密码');
}

// ---- 会话 ----
export function createSession(userId: number, ip = '', userAgent = ''): { token: string; expiresAt: number } {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  db.prepare(
    'INSERT INTO sessions(token, user_id, created_at, expires_at, ip, user_agent, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(token, userId, now, expiresAt, ip, userAgent, now);
  // 顺带清理过期会话
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  return { token, expiresAt };
}

export function destroySession(token: string): void {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/** 会话对外只暴露 token 的散列前缀，原始 token 不下发前端 */
export function sessionIdOf(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex').slice(0, 32);
}

export interface SessionListItem {
  id: string;
  user_id: number;
  username: string;
  role: UserRole;
  disabled: number;
  ip: string;
  user_agent: string;
  created_at: number;
  last_seen_at: number | null;
  expires_at: number;
  /** 是否为发起本次查询的会话 */
  current: boolean;
}

/** 在线会话（未过期），按最近活跃倒序 */
export function listSessions(currentToken?: string | null): SessionListItem[] {
  const rows = db
    .prepare(
      `SELECT s.token, s.user_id, s.ip, s.user_agent, s.created_at, s.expires_at, s.last_seen_at,
              u.username, u.role, u.disabled
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.expires_at > ?
        ORDER BY COALESCE(s.last_seen_at, s.created_at) DESC`,
    )
    .all(Date.now()) as Array<{
    token: string;
    user_id: number;
    ip: string;
    user_agent: string;
    created_at: number;
    expires_at: number;
    last_seen_at: number | null;
    username: string;
    role: UserRole;
    disabled: number;
  }>;
  return rows.map((r) => ({
    id: sessionIdOf(r.token),
    user_id: r.user_id,
    username: r.username,
    role: r.role,
    disabled: r.disabled,
    ip: r.ip,
    user_agent: r.user_agent,
    created_at: r.created_at,
    last_seen_at: r.last_seen_at,
    expires_at: r.expires_at,
    current: !!currentToken && r.token === currentToken,
  }));
}

export function revokeSessionById(
  id: string,
  actorRole?: UserRole,
): { ok: true; username: string; ip: string } | { ok: false; error: string } {
  const rows = db.prepare('SELECT s.token, s.ip, u.username, u.role FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.expires_at > ?').all(Date.now()) as Array<{
    token: string;
    ip: string;
    username: string;
    role: UserRole;
  }>;
  const hit = rows.find((r) => sessionIdOf(r.token) === id);
  if (!hit) return { ok: false, error: '会话不存在或已过期，请刷新列表' };
  // 管理员的会话不对非管理员开放，避免运维员把管理员反复踢下线
  if (hit.role === 'admin' && actorRole !== 'admin') return { ok: false, error: '仅管理员可以操作管理员的会话' };
  db.prepare('DELETE FROM sessions WHERE token = ?').run(hit.token);
  return { ok: true, username: hit.username, ip: hit.ip };
}

/** 踢出某用户的全部会话，返回被清理的会话数；exceptToken 用于保留调用者自己的当前会话 */
export function revokeUserSessions(userId: number, exceptToken?: string | null): number {
  if (exceptToken) {
    return db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(userId, exceptToken).changes;
  }
  return db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId).changes;
}

/** 最近 60 秒内已写过活跃时间的会话不再重复写库 */
const LAST_SEEN_THROTTLE_MS = 60_000;

export function getSessionUser(token: string | undefined | null): UserRow | null {
  if (!token) return null;
  const session = db.prepare('SELECT user_id, last_seen_at FROM sessions WHERE token = ? AND expires_at > ?').get(token, Date.now()) as
    | { user_id: number; last_seen_at: number | null }
    | undefined;
  if (!session) return null;
  // 停用账号的会话立即失效
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND disabled = 0').get(session.user_id) as UserRow | undefined;
  if (!user) return null;
  const now = Date.now();
  if (!session.last_seen_at || now - session.last_seen_at > LAST_SEEN_THROTTLE_MS) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token = ?').run(now, token);
  }
  return user;
}

export type LoginOutcome =
  | { ok: true; user: UserRow }
  | { ok: false; error: string; /** 是否计入登录失败锁定 */ countFailure: boolean; actorId?: number };

export function login(username: string, password: string): LoginOutcome {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  if (!user || !verifyPassword(password, user.password_hash)) {
    return { ok: false, error: '用户名或密码错误', countFailure: true };
  }
  if (user.disabled) {
    // 密码正确但账号已停用：不计入爆破锁定，避免连累同 IP 的其他用户
    return { ok: false, error: '账号已停用，请联系管理员', countFailure: false, actorId: user.id };
  }
  return { ok: true, user };
}

// ---- cookie ----
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

export function tokenFromRequest(req: express.Request): string | null {
  return parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? null;
}

// ---- 中间件 ----
declare module 'express-serve-static-core' {
  interface Request {
    user?: UserRow;
  }
}

export function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const user = getSessionUser(tokenFromRequest(req));
  if (!user) {
    res.status(401).json({ error: '未登录或会话已过期' });
    return;
  }
  req.user = user;
  next();
}

export function requirePermission(perm: Permission) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const user = req.user ?? getSessionUser(tokenFromRequest(req));
    if (!user) {
      res.status(401).json({ error: '未登录或会话已过期' });
      return;
    }
    req.user = user;
    if (!permissionsForRole(user.role).includes(perm)) {
      res.status(403).json({ error: '权限不足' });
      return;
    }
    next();
  };
}

/** 仅管理员角色（不可通过权限配置下放给运维/查看员） */
export function requireAdminRole(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const user = req.user ?? getSessionUser(tokenFromRequest(req));
  if (!user) {
    res.status(401).json({ error: '未登录或会话已过期' });
    return;
  }
  req.user = user;
  if (user.role !== 'admin') {
    res.status(403).json({ error: '仅管理员可访问' });
    return;
  }
  next();
}

/** 满足任一权限即可（如 LLM 巡检：运维可管系统，管理员也可走设置权限） */
export function requireAnyPermission(...perms: Permission[]) {
  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    const user = req.user ?? getSessionUser(tokenFromRequest(req));
    if (!user) {
      res.status(401).json({ error: '未登录或会话已过期' });
      return;
    }
    req.user = user;
    const granted = permissionsForRole(user.role);
    if (!perms.some((p) => granted.includes(p))) {
      res.status(403).json({ error: '权限不足' });
      return;
    }
    next();
  };
}

/** @deprecated 使用 requirePermission('users.manage')；保留兼容旧 import */
export function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  return requirePermission('users.manage')(req, res, next);
}

// ---- 用户 CRUD ----
export type UserBrief = Omit<UserRow, 'password_hash'>;

export function listUsers(): UserBrief[] {
  return db
    .prepare('SELECT id, username, role, disabled, created_at FROM users ORDER BY id')
    .all() as UserBrief[];
}

export function getUserBrief(id: number): UserBrief | null {
  return (
    (db.prepare('SELECT id, username, role, disabled, created_at FROM users WHERE id = ?').get(id) as UserBrief | undefined) ??
    null
  );
}

function countEnabledAdmins(): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get() as { n: number }).n;
}

/** 操作者角色；管理员账号只允许管理员管理，避免 users.manage 被下放后越权 */
function roleOf(userId: number): UserRole | null {
  const row = db.prepare('SELECT role FROM users WHERE id = ?').get(userId) as { role: UserRole } | undefined;
  return row?.role ?? null;
}

export function createUser(
  username: string,
  password: string,
  role: string,
  actorRole: UserRole | null,
): { ok: boolean; error?: string } {
  if (!/^[a-zA-Z0-9_.-]{2,32}$/.test(username)) return { ok: false, error: '用户名需为 2-32 位字母、数字或 _.-' };
  if (password.length < 6) return { ok: false, error: '密码至少 6 位' };
  if (!isValidRole(role)) return { ok: false, error: '角色必须是 admin / operator / viewer' };
  // 新建管理员等于凭空多一个全权账号，只允许管理员本人操作
  if (role === 'admin' && actorRole !== 'admin') return { ok: false, error: '仅管理员可以创建管理员账号' };
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) return { ok: false, error: '用户名已存在' };
  db.prepare('INSERT INTO users(username, password_hash, role, created_at) VALUES (?, ?, ?, ?)').run(
    username,
    hashPassword(password),
    role,
    Date.now(),
  );
  return { ok: true };
}

export function updateUser(
  id: number,
  patch: { role?: string; password?: string; disabled?: boolean },
  actorId: number,
): { ok: boolean; error?: string } {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  if (!user) return { ok: false, error: '用户不存在' };
  const actorRole = roleOf(actorId);
  // 管理员账号只能由管理员改动：否则拥有 users.manage 的运维员可以重置管理员密码、停用或降权后接管
  if (user.role === 'admin' && actorRole !== 'admin') return { ok: false, error: '仅管理员可以修改管理员账号' };
  if (patch.role === 'admin' && actorRole !== 'admin') return { ok: false, error: '仅管理员可以授予管理员角色' };

  // 先整体校验，任一字段不合法就不落地，避免出现“改了一半”的状态
  if (patch.role !== undefined && !isValidRole(patch.role)) return { ok: false, error: '角色必须是 admin / operator / viewer' };
  if (patch.password !== undefined && patch.password.length < 6) return { ok: false, error: '密码至少 6 位' };
  if (patch.role !== undefined && user.id === actorId && patch.role !== 'admin') {
    return { ok: false, error: '不能降级自己的管理员角色' };
  }
  if (patch.disabled !== undefined && patch.disabled && user.id === actorId) {
    return { ok: false, error: '不能停用自己' };
  }
  // 停用管理员、或把在用的管理员降级，都要保证仍有一个启用的管理员
  const disablingAdmin =
    user.disabled === 0 &&
    user.role === 'admin' &&
    (patch.disabled === true || (patch.role !== undefined && patch.role !== 'admin'));
  if (disablingAdmin && countEnabledAdmins() <= 1) {
    return { ok: false, error: '至少保留一个启用状态的管理员' };
  }

  if (patch.role !== undefined) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(patch.role, id);
  if (patch.password !== undefined) {
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(patch.password), id);
    // 改密后强制该用户重新登录
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  if (patch.disabled !== undefined) {
    const next = patch.disabled ? 1 : 0;
    if (next !== user.disabled) {
      db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(next, id);
      // 停用后立刻踢下线，避免旧会话继续访问
      if (next === 1) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    }
  }
  return { ok: true };
}

export function deleteUser(id: number, actorId: number): { ok: boolean; error?: string } {
  if (id === actorId) return { ok: false, error: '不能删除自己' };
  const user = db.prepare('SELECT id, role, disabled FROM users WHERE id = ?').get(id) as
    | Pick<UserRow, 'id' | 'role' | 'disabled'>
    | undefined;
  if (!user) return { ok: false, error: '用户不存在' };
  if (user.role === 'admin' && roleOf(actorId) !== 'admin') return { ok: false, error: '仅管理员可以删除管理员账号' };
  if (user.role === 'admin' && user.disabled === 0 && countEnabledAdmins() <= 1) {
    return { ok: false, error: '至少保留一个启用状态的管理员' };
  }
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  return { ok: true };
}

export function changeOwnPassword(userId: number, oldPassword: string, newPassword: string): { ok: boolean; error?: string } {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
  if (!user) return { ok: false, error: '用户不存在' };
  if (!verifyPassword(oldPassword, user.password_hash)) return { ok: false, error: '原密码不正确' };
  if (newPassword.length < 6) return { ok: false, error: '新密码至少 6 位' };
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(newPassword), userId);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return { ok: true };
}
