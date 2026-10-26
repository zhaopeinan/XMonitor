import { db } from './db';

/**
 * 审计日志：记录身份与权限相关动作（登录、账号变更、角色权限、会话强制下线）。
 * 动作 key 保持英文稳定值，前端映射成中文标签。
 */
export interface AuditLogRow {
  id: number;
  ts: number;
  actor_id: number | null;
  actor_name: string;
  action: string;
  target: string;
  detail: string;
  ip: string;
}

export interface AuditInput {
  /** 动作发起人的用户 id；登录失败等场景可能未知 */
  actorId?: number | null;
  actorName: string;
  action: string;
  target?: string;
  detail?: string;
  ip?: string;
}

/** 保留的审计条数上限，超出后只保留最新的这些条 */
const MAX_ROWS = 20000;

export function recordAudit(entry: AuditInput): void {
  try {
    db.prepare(
      'INSERT INTO audit_logs(ts, actor_id, actor_name, action, target, detail, ip) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(Date.now(), entry.actorId ?? null, entry.actorName ?? '', entry.action, entry.target ?? '', entry.detail ?? '', entry.ip ?? '');
    // 清理只按概率触发，避免每次写入都做一次全表统计
    if (Math.random() < 0.01) {
      db.prepare('DELETE FROM audit_logs WHERE id <= (SELECT MAX(id) - ? FROM audit_logs)').run(MAX_ROWS);
    }
  } catch (e) {
    // 审计写入失败不能影响主流程
    console.warn('[audit] 写入审计日志失败：', e instanceof Error ? e.message : e);
  }
}

export function listAuditLogs(opts: { limit: number; offset: number; q?: string; action?: string }): {
  logs: AuditLogRow[];
  total: number;
} {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.action) {
    where.push('action = ?');
    params.push(opts.action);
  }
  if (opts.q) {
    where.push('(actor_name LIKE ? OR target LIKE ? OR detail LIKE ? OR action LIKE ?)');
    const like = `%${opts.q}%`;
    params.push(like, like, like, like);
  }
  const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM audit_logs${clause}`).get(...params) as { n: number }).n;
  const logs = db
    .prepare(`SELECT * FROM audit_logs${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, opts.limit, opts.offset) as AuditLogRow[];
  return { logs, total };
}

/** 审计动作 → 中文标签（前端也用同一份列表做筛选项） */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  login: '登录成功',
  login_failed: '登录失败',
  logout: '退出登录',
  password_change: '修改本人密码',
  'user.create': '新建账号',
  'user.role': '变更角色',
  'user.ops_unit': '变更运维单位',
  'user.password_reset': '重置密码',
  'user.disable': '停用账号',
  'user.enable': '启用账号',
  'user.delete': '删除账号',
  'session.revoke': '强制下线',
  'session.revoke_user': '踢出全部会话',
  'role.permissions': '更新角色权限',
};
