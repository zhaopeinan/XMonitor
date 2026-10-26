import { db } from './db';
import type { UserRole } from './types';

/** 可配置的细粒度权限 */
export const PERMISSION_DEFS = [
  { key: 'systems.manage', label: '管理系统与监控项', desc: '新增/编辑/删除系统与监控、续期 Token' },
  { key: 'ledger.manage', label: '管理系统台账', desc: '新增/编辑/删除系统台账条目' },
  { key: 'analyze', label: '智能分析', desc: '运行页面/接口分析向导' },
  { key: 'alerts.ack', label: '确认告警', desc: '确认并处理告警' },
  { key: 'settings.manage', label: '系统设置', desc: 'SSO、Webhook、LLM 档案、Obscura 等' },
  { key: 'users.manage', label: '用户与角色', desc: '管理账号、修改角色与权限配置' },
] as const;

export type Permission = (typeof PERMISSION_DEFS)[number]['key'];

export const ALL_PERMISSIONS: Permission[] = PERMISSION_DEFS.map((p) => p.key);

/**
 * 数据权限：决定「能看到哪些数据」，与上面的功能权限正交。
 * all=全部数据；unit=只看本人所属运维单位名下的台账与系统（含其告警）；
 * self=只看本人在台账/系统里新建的条目（历史条目没有创建人，因此看不到）。
 */
export const DATA_SCOPE_DEFS = [
  { key: 'all', label: '全部数据', desc: '不限运维单位，全部台账、监控系统与告警可见' },
  { key: 'unit', label: '仅本运维单位', desc: '只看本人「所属运维单位」名下的台账、监控系统及其告警' },
  { key: 'self', label: '仅本人创建', desc: '只看本人在台账、监控系统里新建的记录及其告警' },
] as const;

export type DataScope = (typeof DATA_SCOPE_DEFS)[number]['key'];

export const ALL_DATA_SCOPES: DataScope[] = DATA_SCOPE_DEFS.map((d) => d.key);

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: '管理员',
  operator: '运维员',
  viewer: '查看员',
};

const SETTINGS_KEY = 'role_permissions';
const DATA_SCOPE_KEY = 'role_data_scopes';
const MIGRATION_MARKER_KEY = 'role_permissions_ledger_granted';

/** 默认权限：管理员全开；运维员可管监控/台账/分析/告警；查看员只读 */
export const DEFAULT_ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  admin: [...ALL_PERMISSIONS],
  operator: ['systems.manage', 'ledger.manage', 'analyze', 'alerts.ack'],
  viewer: [],
};

function isPermission(v: unknown): v is Permission {
  return typeof v === 'string' && (ALL_PERMISSIONS as string[]).includes(v);
}

function normalizeRolePerms(raw: unknown): Record<UserRole, Permission[]> {
  const out: Record<UserRole, Permission[]> = {
    admin: [...ALL_PERMISSIONS],
    operator: [...DEFAULT_ROLE_PERMISSIONS.operator],
    viewer: [...DEFAULT_ROLE_PERMISSIONS.viewer],
  };
  if (!raw || typeof raw !== 'object') return out;
  const obj = raw as Record<string, unknown>;
  for (const role of ['operator', 'viewer'] as UserRole[]) {
    const list = obj[role];
    if (!Array.isArray(list)) continue;
    out[role] = [...new Set(list.filter(isPermission))];
  }
  out.admin = [...ALL_PERMISSIONS];
  return out;
}

export function getRolePermissions(): Record<UserRole, Permission[]> {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value: string } | undefined;
  if (!row?.value) return { admin: [...ALL_PERMISSIONS], operator: [...DEFAULT_ROLE_PERMISSIONS.operator], viewer: [...DEFAULT_ROLE_PERMISSIONS.viewer] };
  try {
    return normalizeRolePerms(JSON.parse(row.value));
  } catch {
    return { admin: [...ALL_PERMISSIONS], operator: [...DEFAULT_ROLE_PERMISSIONS.operator], viewer: [...DEFAULT_ROLE_PERMISSIONS.viewer] };
  }
}

export function setRolePermissions(patch: Partial<Record<UserRole, Permission[]>>): Record<UserRole, Permission[]> {
  const current = getRolePermissions();
  if (patch.operator) current.operator = [...new Set(patch.operator.filter(isPermission))];
  if (patch.viewer) current.viewer = [...new Set(patch.viewer.filter(isPermission))];
  current.admin = [...ALL_PERMISSIONS];
  db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(SETTINGS_KEY, JSON.stringify({ operator: current.operator, viewer: current.viewer }));
  return current;
}

export function permissionsForRole(role: string): Permission[] {
  const map = getRolePermissions();
  if (role === 'admin') return [...ALL_PERMISSIONS];
  if (role === 'operator') return [...map.operator];
  if (role === 'viewer') return [...map.viewer];
  return [];
}

/**
 * 默认数据范围：全部数据。
 * 与功能权限不同，这里刻意不做任何收紧——升级到带数据权限的版本后，
 * 已有账号看到的数据与升级前完全一致，是否隔离由管理员显式配置。
 */
export const DEFAULT_ROLE_DATA_SCOPES: Record<UserRole, DataScope> = {
  admin: 'all',
  operator: 'all',
  viewer: 'all',
};

function isDataScope(v: unknown): v is DataScope {
  return typeof v === 'string' && (ALL_DATA_SCOPES as string[]).includes(v);
}

function defaultDataScopes(): Record<UserRole, DataScope> {
  return { ...DEFAULT_ROLE_DATA_SCOPES, admin: 'all' };
}

export function getRoleDataScopes(): Record<UserRole, DataScope> {
  const out = defaultDataScopes();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(DATA_SCOPE_KEY) as
    | { value: string }
    | undefined;
  if (!row?.value) return out;
  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    for (const role of ['operator', 'viewer'] as UserRole[]) {
      if (isDataScope(parsed[role])) out[role] = parsed[role];
    }
  } catch {
    // 配置损坏时回落到默认（全部数据），避免把管理员锁在外面
  }
  out.admin = 'all';
  return out;
}

export function setRoleDataScopes(patch: Partial<Record<UserRole, DataScope>>): Record<UserRole, DataScope> {
  const current = getRoleDataScopes();
  for (const role of ['operator', 'viewer'] as UserRole[]) {
    const next = patch[role];
    if (isDataScope(next)) current[role] = next;
  }
  current.admin = 'all';
  db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(DATA_SCOPE_KEY, JSON.stringify({ operator: current.operator, viewer: current.viewer }));
  return current;
}

/** 某个角色的数据范围；管理员始终是全部数据 */
export function dataScopeForRole(role: string): DataScope {
  if (role === 'admin') return 'all';
  const map = getRoleDataScopes();
  if (role === 'operator') return map.operator;
  if (role === 'viewer') return map.viewer;
  return 'self';
}

export function isValidRole(role: string): role is UserRole {
  return role === 'admin' || role === 'operator' || role === 'viewer';
}

/**
 * 一次性迁移：早于「系统台账」的实例里，已保存的 role_permissions 不含 ledger.manage，
 * 无法区分「管理员主动取消」与「该权限当时还不存在」，因此只自动授予一次并留下标记。
 * 未保存过配置的实例走 DEFAULT_ROLE_PERMISSIONS，无需迁移。
 */
function grantLedgerPermissionOnce(): void {
  const marker = db.prepare('SELECT value FROM settings WHERE key = ?').get(MIGRATION_MARKER_KEY);
  if (marker) return;
  db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(MIGRATION_MARKER_KEY, '1');

  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY) as { value: string } | undefined;
  if (!row?.value) return;
  try {
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
    const operator = Array.isArray(parsed.operator) ? (parsed.operator as unknown[]) : [];
    if (operator.includes('ledger.manage')) return;
    parsed.operator = [...operator, 'ledger.manage'];
    db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(JSON.stringify(parsed), SETTINGS_KEY);
  } catch {
    // 配置损坏时跳过；管理员可在「角色权限」中手动勾选
  }
}

grantLedgerPermissionOnce();
