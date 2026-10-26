import { db } from './db';
import { dataScopeForRole, type DataScope } from './permissions';
import type { UserRow } from './types';

/**
 * 数据权限（行级可见范围）的统一入口。
 *
 * 需要隔离的数据只有两类：台账条目（system_ledgers）与监控系统（systems）；
 * 监控项、检查记录、告警都挂在监控系统下面，按 system_id 跟着走。
 * 大模型监控（llm_channels / llm_models）不归属运维单位，保持全局可见。
 *
 * 范围来自角色配置，用户不用重新登录即时生效（每个请求现算）。
 */
export interface DataScopeCtx {
  scope: DataScope;
  /** 所属运维单位；scope=unit 时用于比对，空串表示未设置（此时看不到任何数据） */
  opsUnit: string;
  userId: number;
}

export interface SqlFragment {
  sql: string;
  params: unknown[];
}

export function dataScopeOf(user: Pick<UserRow, 'id' | 'role' | 'ops_unit'>): DataScopeCtx {
  return {
    scope: dataScopeForRole(user.role),
    opsUnit: (user.ops_unit ?? '').trim(),
    userId: user.id,
  };
}

/** 一条 SQL 片段是否等价于「不过滤」 */
export function isUnfiltered(fragment: SqlFragment): boolean {
  return fragment.sql === '1=1';
}

/** 台账条目的可见性条件（alias 是 system_ledgers 的别名） */
export function ledgerScopeSql(ctx: DataScopeCtx, alias = 'l'): SqlFragment {
  if (ctx.scope === 'all') return { sql: '1=1', params: [] };
  if (ctx.scope === 'self') return { sql: `${alias}.created_by = ?`, params: [ctx.userId] };
  // 单位为空时给不出范围：明确返回空集，而不是把所有单位为空的条目都放出去
  if (!ctx.opsUnit) return { sql: '0=1', params: [] };
  return { sql: `TRIM(${alias}.ops_unit) = ?`, params: [ctx.opsUnit] };
}

/** 监控系统的可见性条件（alias 是 systems 的别名） */
export function systemScopeSql(ctx: DataScopeCtx, alias = 's'): SqlFragment {
  if (ctx.scope === 'all') return { sql: '1=1', params: [] };
  if (ctx.scope === 'self') return { sql: `${alias}.created_by = ?`, params: [ctx.userId] };
  if (!ctx.opsUnit) return { sql: '0=1', params: [] };
  return { sql: `TRIM(${alias}.ops_unit) = ?`, params: [ctx.opsUnit] };
}

/** 监控项 / 告警的可见性条件：按所属监控系统判断 */
export function monitorScopeSql(ctx: DataScopeCtx, alias = 'm'): SqlFragment {
  const inner = systemScopeSql(ctx, 's');
  return { sql: `${alias}.system_id IN (SELECT s.id FROM systems s WHERE ${inner.sql})`, params: inner.params };
}

/** 把 id 列表拼成 IN 条件；空列表等价于「查不到任何行」 */
export function idListSql(column: string, ids: number[]): SqlFragment {
  if (ids.length === 0) return { sql: '0=1', params: [] };
  return { sql: `${column} IN (${ids.map(() => '?').join(', ')})`, params: [...ids] };
}

/**
 * 当前用户可见的监控系统 id。
 * 返回 null 表示不受限（全部数据）——此时调用方应完全跳过过滤，避免拼出无谓的大 IN。
 */
export function visibleSystemIds(ctx: DataScopeCtx): number[] | null {
  const fragment = systemScopeSql(ctx, 's');
  if (isUnfiltered(fragment)) return null;
  const rows = db.prepare(`SELECT s.id FROM systems s WHERE ${fragment.sql}`).all(...fragment.params) as { id: number }[];
  return rows.map((r) => r.id);
}

/** 台账条目级校验：写入类接口在动某一条之前必须过这一关 */
export function ledgerInScope(ctx: DataScopeCtx, id: number): boolean {
  const fragment = ledgerScopeSql(ctx, 'l');
  const row = db
    .prepare(`SELECT l.id FROM system_ledgers l WHERE l.id = ? AND ${fragment.sql}`)
    .get(id, ...fragment.params);
  return !!row;
}

export function systemInScope(ctx: DataScopeCtx, id: number): boolean {
  const fragment = systemScopeSql(ctx, 's');
  const row = db.prepare(`SELECT s.id FROM systems s WHERE s.id = ? AND ${fragment.sql}`).get(id, ...fragment.params);
  return !!row;
}

export function monitorInScope(ctx: DataScopeCtx, id: number): boolean {
  const fragment = monitorScopeSql(ctx, 'm');
  const row = db.prepare(`SELECT m.id FROM monitors m WHERE m.id = ? AND ${fragment.sql}`).get(id, ...fragment.params);
  return !!row;
}

export function alertInScope(ctx: DataScopeCtx, id: number): boolean {
  const fragment = monitorScopeSql(ctx, 'm');
  const row = db
    .prepare(`SELECT a.id FROM alerts a JOIN monitors m ON m.id = a.monitor_id WHERE a.id = ? AND ${fragment.sql}`)
    .get(id, ...fragment.params);
  return !!row;
}

/** 批量筛选台账 id：只保留当前用户范围内的，供 IP 扫描 / HTTPS 探测这类批量接口使用 */
export function ledgerIdsInScope(ctx: DataScopeCtx, ids: number[]): Map<number, boolean> {
  const out = new Map<number, boolean>();
  if (ids.length === 0) return out;
  const fragment = ledgerScopeSql(ctx, 'l');
  if (isUnfiltered(fragment)) {
    for (const id of ids) out.set(id, true);
    return out;
  }
  const list = idListSql('l.id', ids);
  const rows = db
    .prepare(`SELECT l.id FROM system_ledgers l WHERE ${list.sql} AND ${fragment.sql}`)
    .all(...list.params, ...fragment.params) as { id: number }[];
  const allowed = new Set(rows.map((r) => r.id));
  for (const id of ids) out.set(id, allowed.has(id));
  return out;
}

/** 越权访问数据时的统一错误文案 */
export const OUT_OF_SCOPE_ERROR = '该数据不在你的数据范围内（由角色的数据权限决定）';
