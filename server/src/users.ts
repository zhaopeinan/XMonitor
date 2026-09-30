import crypto from 'node:crypto';
import type express from 'express';
import { db } from './db';
import { isValidRole, permissionsForRole, type Permission } from './permissions';
import type { UserRow } from './types';

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
export function createSession(userId: number): { token: string; expiresAt: number } {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  db.prepare('INSERT INTO sessions(token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)').run(token, userId, now, expiresAt);
  // 顺带清理过期会话
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  return { token, expiresAt };
}

export function destroySession(token: string): void {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

export function getSessionUser(token: string | undefined | null): UserRow | null {
  if (!token) return null;
  const row = db
    .prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?')
    .get(token, Date.now()) as UserRow | undefined;
  return row ?? null;
}

export function login(username: string, password: string): UserRow | null {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
  if (!user || !verifyPassword(password, user.password_hash)) return null;
  return user;
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
export function listUsers(): Omit<UserRow, 'password_hash'>[] {
  return db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id').all() as Omit<UserRow, 'password_hash'>[];
}

export function createUser(username: string, password: string, role: string): { ok: boolean; error?: string } {
  if (!/^[a-zA-Z0-9_.-]{2,32}$/.test(username)) return { ok: false, error: '用户名需为 2-32 位字母、数字或 _.-' };
  if (password.length < 6) return { ok: false, error: '密码至少 6 位' };
  if (!isValidRole(role)) return { ok: false, error: '角色必须是 admin / operator / viewer' };
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

export function updateUser(id: number, patch: { role?: string; password?: string }, actorId: number): { ok: boolean; error?: string } {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  if (!user) return { ok: false, error: '用户不存在' };
  if (patch.role !== undefined) {
    if (!isValidRole(patch.role)) return { ok: false, error: '角色必须是 admin / operator / viewer' };
    if (user.id === actorId && patch.role !== 'admin') return { ok: false, error: '不能降级自己的管理员角色' };
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(patch.role, id);
  }
  if (patch.password !== undefined) {
    if (patch.password.length < 6) return { ok: false, error: '密码至少 6 位' };
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(patch.password), id);
    // 改密后强制该用户重新登录
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
  }
  return { ok: true };
}

export function deleteUser(id: number, actorId: number): { ok: boolean; error?: string } {
  if (id === actorId) return { ok: false, error: '不能删除自己' };
  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id) as Pick<UserRow, 'id' | 'role'> | undefined;
  if (!user) return { ok: false, error: '用户不存在' };
  if (user.role === 'admin') {
    const admins = (db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get() as { n: number }).n;
    if (admins <= 1) return { ok: false, error: '至少保留一个管理员' };
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
