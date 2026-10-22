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

export const ROLE_LABELS: Record<UserRole, string> = {
  admin: '管理员',
  operator: '运维员',
  viewer: '查看员',
};

const SETTINGS_KEY = 'role_permissions';
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
