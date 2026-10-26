import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { useConfirm } from '../components/ConfirmDialog';
import { ROLE_LABELS, useAuth, type UserRole } from '../auth';
import { Card, ErrorBanner, PageHeader, Spinner } from '../components/ui';
import { Select } from '../components/Select';
import type {
  AuditLogItem,
  AuditLogPayload,
  DataScopeDef,
  DataScopeKey,
  PermissionDef,
  SessionItem,
  UserItem,
} from '../types';
import { errMsg, fmtDateTime, fmtRelative, isTruthy } from '../utils';

const inputCls =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200';

/** 离视口边缘至少留出的间距，避免下拉贴边 */
const MENU_VIEWPORT_GAP = 8;

const ROLE_META: Record<UserRole, { label: string; cls: string; soft: string }> = {
  admin: {
    label: '管理员',
    cls: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    soft: 'bg-indigo-50/80',
  },
  operator: {
    label: '运维员',
    cls: 'bg-amber-50 text-amber-800 border-amber-200',
    soft: 'bg-amber-50/60',
  },
  viewer: {
    label: '查看员',
    cls: 'bg-slate-100 text-slate-600 border-slate-200',
    soft: 'bg-slate-50',
  },
};

/** 数据权限的兜底文案：角色权限接口返回前也能正常显示 */
const DATA_SCOPE_LABELS: Record<string, string> = {
  all: '全部数据',
  unit: '仅本运维单位',
  self: '仅本人创建',
};

/** 数据权限的补充说明：光看「仅本运维单位」不知道按什么过滤 */
const DATA_SCOPE_HINTS: Record<string, string> = {
  all: '',
  unit: '按本人运维单位过滤',
  self: '只看本人新建的记录',
};

/**
 * 功能权限按「未勾选时的表现」分两组展示。
 * 勾选框只管「能不能改」，不勾并不等于看不到数据，所以要把只读与隐藏分别写清楚。
 */
const PERM_GROUPS: { key: PermissionDef['unchecked']; title: string; note: string }[] = [
  { key: 'readonly', title: '操作能力', note: '未勾选 = 只读：页面照常可看，只是不能改' },
  { key: 'hidden', title: '功能入口', note: '未勾选 = 看不到：菜单与页面入口一并隐藏' },
];

type TabKey = 'accounts' | 'rbac' | 'sessions' | 'audit';

interface RoleAbilities {
  /** 功能权限：授予了哪些能力，或「无操作权限（只读）」 */
  permText: string;
  /** 数据权限：能看哪些数据 */
  scopeText: string;
}

/**
 * 把一个角色的功能权限与数据权限折成具体文案，
 * 替代「日常监控运维」这类看不出实际权限的描述。
 */
function describeRole(
  role: UserRole,
  permDefs: PermissionDef[],
  rolePerms: Record<string, string[]>,
  scopeDefs: DataScopeDef[],
  roleScopes: Record<string, DataScopeKey>,
): RoleAbilities {
  const keys = role === 'admin' ? permDefs.map((p) => p.key) : (rolePerms[role] ?? []);
  const labels = permDefs.filter((p) => keys.includes(p.key)).map((p) => p.label);
  const permText = labels.length
    ? labels.length === permDefs.length && permDefs.length > 0
      ? `全部 ${permDefs.length} 项（${labels.join(' · ')}）`
      : labels.join(' · ')
    : '无操作权限（只读）';

  // 管理员固定全部数据，服务端也这么处理
  const scope = role === 'admin' ? 'all' : (roleScopes[role] ?? 'all');
  const label = scopeDefs.find((d) => d.key === scope)?.label ?? DATA_SCOPE_LABELS[scope] ?? scope;
  const hint = DATA_SCOPE_HINTS[scope] ?? '';
  return { permText, scopeText: hint ? `${label}（${hint}）` : label };
}

/** 角色卡片里的两行权限说明；只用 span，便于嵌进按钮等行内元素 */
function AbilityLines({ permText, scopeText, className = '' }: RoleAbilities & { className?: string }) {
  return (
    <span className={`block text-[11px] leading-relaxed ${className}`}>
      <span className="flex gap-1.5">
        <span className="shrink-0 text-slate-400">功能权限</span>
        <span className="min-w-0 text-slate-600">{permText}</span>
      </span>
      <span className="flex gap-1.5">
        <span className="shrink-0 text-slate-400">数据权限</span>
        <span className="min-w-0 text-slate-600">{scopeText}</span>
      </span>
    </span>
  );
}

/** 审计动作的展示样式：危险动作红色、成功/登录绿色、普通改动靛蓝 */
const AUDIT_META: Record<string, { label: string; cls: string }> = {
  login: { label: '登录成功', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  login_failed: { label: '登录失败', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  logout: { label: '退出登录', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
  password_change: { label: '修改本人密码', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  'user.create': { label: '新建账号', cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  'user.role': { label: '变更角色', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  'user.ops_unit': { label: '变更运维单位', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  'user.password_reset': { label: '重置密码', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  'user.disable': { label: '停用账号', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  'user.enable': { label: '启用账号', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  'user.delete': { label: '删除账号', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  'session.revoke': { label: '强制下线', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  'session.revoke_user': { label: '踢出全部会话', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  'role.permissions': { label: '更新角色权限', cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
};

function auditMeta(action: string): { label: string; cls: string } {
  return AUDIT_META[action] ?? { label: action, cls: 'bg-slate-100 text-slate-600 border-slate-200' };
}

/** 把 User-Agent 折成一句话，原始串放到 title 里 */
function describeUa(ua: string): string {
  if (!ua) return '未知客户端';
  const os = /Windows NT/i.test(ua)
    ? 'Windows'
    : /Mac OS X|Macintosh/i.test(ua)
      ? 'macOS'
      : /Android/i.test(ua)
        ? 'Android'
        : /iPhone|iPad|iOS/i.test(ua)
          ? 'iOS'
          : /Linux/i.test(ua)
            ? 'Linux'
            : '';
  const browser = /Edg\//i.test(ua)
    ? 'Edge'
    : /OPR\//i.test(ua)
      ? 'Opera'
      : /Chrome\//i.test(ua)
        ? 'Chrome'
        : /Safari\//i.test(ua)
          ? 'Safari'
          : /Firefox\//i.test(ua)
            ? 'Firefox'
            : '';
  const parts = [browser, os].filter(Boolean);
  if (parts.length) return parts.join(' · ');
  if (/curl|wget|python|node|go-http/i.test(ua)) return '脚本 / 命令行';
  return ua.slice(0, 24);
}

function Modal({
  title,
  description,
  children,
  onClose,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  footer: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="border-b border-slate-100 px-6 py-4">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
        </div>
        <div className="px-6 py-5">{children}</div>
        <div className="flex justify-end gap-2 border-t border-slate-100 px-6 py-4">{footer}</div>
      </div>
    </div>
  );
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="mb-4 block last:mb-0">
      <span className="mb-1.5 block text-sm font-medium text-slate-700">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}

function RoleBadge({ role }: { role: string }) {
  const meta = ROLE_META[(role as UserRole) in ROLE_META ? (role as UserRole) : 'viewer'];
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${meta.cls}`}>
      {meta.label}
    </span>
  );
}

function Avatar({ name }: { name: string }) {
  const letter = (name.trim()[0] || '?').toUpperCase();
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-slate-900 text-sm font-semibold text-white">
      {letter}
    </span>
  );
}

function samePerms(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
  for (const role of ['operator', 'viewer'] as const) {
    const x = [...(a[role] ?? [])].sort().join(',');
    const y = [...(b[role] ?? [])].sort().join(',');
    if (x !== y) return false;
  }
  return true;
}

/** 数据权限只有三个取值，逐个比对即可 */
function sameScopes(a: Record<string, DataScopeKey>, b: Record<string, DataScopeKey>): boolean {
  for (const role of ['operator', 'viewer'] as const) {
    if ((a[role] ?? 'all') !== (b[role] ?? 'all')) return false;
  }
  return true;
}

/** 账号「所属运维单位」输入：自由文本，另给一行台账里已有的单位做快捷填入 */
function OpsUnitField({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
}) {
  return (
    <div>
      <span className="mb-1.5 block text-sm font-medium text-slate-700">所属运维单位</span>
      <input
        className={inputCls}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        placeholder="例如 网络中心；留空表示不设置"
      />
      <span className="mt-1 block text-xs text-slate-400">
        数据权限为「仅本运维单位」时按它过滤台账与监控系统，写法需与台账里的运维单位一致；留空则在该范围下看不到数据。
      </span>
      {options.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] text-slate-400">台账里已有：</span>
          {options.slice(0, 8).map((unit) => (
            <button
              key={unit}
              type="button"
              onClick={() => onChange(unit)}
              className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                unit === value.trim()
                  ? 'border-slate-900 bg-slate-900 text-white'
                  : 'border-slate-200 text-slate-600 hover:border-slate-300 hover:bg-slate-50'
              }`}
            >
              {unit}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Users() {
  const { user: me } = useAuth();
  const confirm = useConfirm();
  const isAdminActor = me?.role === 'admin';
  /** 管理员账号只允许管理员操作；服务端会再校验一次 */
  const adminLocked = (role: string) => role === 'admin' && !isAdminActor;
  const [tab, setTab] = useState<TabKey>('accounts');
  const [users, setUsers] = useState<UserItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newPass, setNewPass] = useState('');
  const [newRole, setNewRole] = useState<UserRole>('viewer');
  const [newUnit, setNewUnit] = useState('');
  const [creating, setCreating] = useState(false);

  /** 单独维护某个账号的「所属运维单位」 */
  const [unitUser, setUnitUser] = useState<UserItem | null>(null);
  const [unitValue, setUnitValue] = useState('');

  const [resetUser, setResetUser] = useState<UserItem | null>(null);
  const [resetPass, setResetPass] = useState('');
  const [resetConfirm, setResetConfirm] = useState('');
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
  /** 账号行的「管理」下拉：固定定位渲染，避免被列表卡片的 overflow-hidden 裁掉 */
  const [menu, setMenu] = useState<{
    id: number;
    top?: number;
    bottom?: number;
    right: number;
    /** 按钮上边缘（视口坐标），供上翻时对齐按钮上方 */
    anchorTop: number;
  } | null>(null);

  const [permDefs, setPermDefs] = useState<PermissionDef[]>([]);
  const [rolePerms, setRolePerms] = useState<Record<string, string[]>>({});
  const [savedPerms, setSavedPerms] = useState<Record<string, string[]>>({});
  const [dataScopeDefs, setDataScopeDefs] = useState<DataScopeDef[]>([]);
  const [roleScopes, setRoleScopes] = useState<Record<string, DataScopeKey>>({});
  const [savedScopes, setSavedScopes] = useState<Record<string, DataScopeKey>>({});
  /** 台账里出现过的运维单位，供账号「所属运维单位」快捷填入 */
  const [opsUnits, setOpsUnits] = useState<string[]>([]);
  const [permSaving, setPermSaving] = useState(false);

  // 在线会话
  const [sessions, setSessions] = useState<SessionItem[] | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const [revokingIds, setRevokingIds] = useState<Set<string>>(new Set());

  // 审计日志
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[] | null>(null);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditActions, setAuditActions] = useState<Record<string, string>>({});
  const [auditQ, setAuditQ] = useState('');
  const [auditAction, setAuditAction] = useState('');
  const [auditLoading, setAuditLoading] = useState(false);
  const auditLogsRef = useRef<AuditLogItem[]>([]);

  const dirty = useMemo(
    () => !samePerms(rolePerms, savedPerms) || !sameScopes(roleScopes, savedScopes),
    [rolePerms, savedPerms, roleScopes, savedScopes],
  );

  const load = useCallback(async () => {
    try {
      const [u, r, ou] = await Promise.all([
        api.getUsers(),
        api.getRolePermissions(),
        // 候选运维单位只影响输入框的快捷填入，单独失败不拖垮整页
        api.getOpsUnits().catch(() => ({ units: [] as string[] })),
      ]);
      setUsers(u.users);
      setPermDefs(r.permissions);
      setDataScopeDefs(r.data_scopes ?? []);
      setRolePerms(r.role_permissions);
      setSavedPerms({
        operator: [...(r.role_permissions.operator ?? [])],
        viewer: [...(r.role_permissions.viewer ?? [])],
        admin: [...(r.role_permissions.admin ?? [])],
      });
      setRoleScopes(r.role_data_scopes ?? {});
      setSavedScopes({ ...(r.role_data_scopes ?? {}) });
      setOpsUnits(ou.units);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** 当前配置下某个角色的具体权限：功能权限 + 数据权限 */
  const abilitiesOf = (role: UserRole) => describeRole(role, permDefs, rolePerms, dataScopeDefs, roleScopes);

  /** 权限矩阵按「未勾选时的表现」分组；旧服务端没下发该字段时一律按只读处理 */
  const permGroups = useMemo(
    () =>
      PERM_GROUPS.map((g) => ({
        ...g,
        defs: permDefs.filter((p) => (p.unchecked === 'hidden') === (g.key === 'hidden')),
      })).filter((g) => g.defs.length > 0),
    [permDefs],
  );

  /** 权限矩阵的一行：能力说明 + 管理员锁定 + 运维员/查看员开关 */
  const renderPermRow = (p: PermissionDef) => {
    const opOn = (rolePerms.operator ?? []).includes(p.key);
    const vwOn = (rolePerms.viewer ?? []).includes(p.key);
    return (
      <tr key={p.key} className="border-b border-slate-50 last:border-0">
        <td className="px-5 py-3.5">
          <div className="font-medium text-slate-800">{p.label}</div>
          <div className="mt-0.5 text-xs text-slate-400">{p.desc}</div>
          <code className="mt-1 inline-block rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">
            {p.key}
          </code>
        </td>
        <td className="px-3 py-3.5 text-center">
          <span
            className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-indigo-50 text-xs font-semibold text-indigo-600"
            title="管理员固定拥有"
          >
            ✓
          </span>
        </td>
        <td className="px-3 py-3.5 text-center">
          <button
            type="button"
            role="switch"
            aria-checked={opOn}
            aria-label={`运维员 · ${p.label}`}
            onClick={() => togglePerm('operator', p.key)}
            className={`relative mx-auto h-6 w-11 rounded-full transition-colors ${
              opOn ? 'bg-emerald-500' : 'bg-slate-200'
            }`}
          >
            <span
              className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform"
              style={{ transform: opOn ? 'translateX(20px)' : 'translateX(0)' }}
            />
          </button>
        </td>
        <td className="px-3 py-3.5 text-center">
          <button
            type="button"
            role="switch"
            aria-checked={vwOn}
            aria-label={`查看员 · ${p.label}`}
            onClick={() => togglePerm('viewer', p.key)}
            className={`relative mx-auto h-6 w-11 rounded-full transition-colors ${
              vwOn ? 'bg-emerald-500' : 'bg-slate-200'
            }`}
          >
            <span
              className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform"
              style={{ transform: vwOn ? 'translateX(20px)' : 'translateX(0)' }}
            />
          </button>
        </td>
      </tr>
    );
  };

  /** 打开/收起账号行的「管理」下拉：先贴在按钮下方，渲染后再按实际高度校正 */
  const toggleMenu = (id: number, el: HTMLButtonElement) => {
    if (menu?.id === id) {
      setMenu(null);
      return;
    }
    const r = el.getBoundingClientRect();
    setMenu({
      id,
      top: r.bottom + 4,
      right: Math.max(MENU_VIEWPORT_GAP, window.innerWidth - r.right),
      anchorTop: r.top,
    });
  };

  const menuRef = useRef<HTMLDivElement | null>(null);

  // 下拉是固定定位：渲染后量一次实际高度（在绘制前完成，不会闪），
  // 下方放不下就翻到按钮上方，上下都放不下则贴住视口底部
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!menu || !el || menu.bottom != null) return;
    const r = el.getBoundingClientRect();
    if (r.bottom <= window.innerHeight - MENU_VIEWPORT_GAP) return;
    if (menu.anchorTop - 4 - r.height >= MENU_VIEWPORT_GAP) {
      setMenu({ ...menu, top: undefined, bottom: window.innerHeight - menu.anchorTop + 4 });
    } else {
      setMenu({ ...menu, top: Math.max(MENU_VIEWPORT_GAP, window.innerHeight - r.height - MENU_VIEWPORT_GAP) });
    }
  }, [menu]);

  // 下拉是固定定位，滚动或缩放后会与按钮脱节，直接收起
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menu]);

  const AUDIT_PAGE = 50;

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    try {
      const res = await api.getSessions();
      setSessions(res.sessions);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  const loadAudit = useCallback(
    async (append = false) => {
      setAuditLoading(true);
      try {
        const res = await api.getAuditLogs({
          limit: AUDIT_PAGE,
          offset: append ? auditLogsRef.current.length : 0,
          q: auditQ.trim() || undefined,
          action: auditAction || undefined,
        });
        const next = append ? [...auditLogsRef.current, ...res.logs] : res.logs;
        auditLogsRef.current = next;
        setAuditLogs(next);
        setAuditTotal(res.total);
        setAuditActions(res.actions);
      } catch (e) {
        setError(errMsg(e));
      } finally {
        setAuditLoading(false);
      }
    },
    [auditQ, auditAction],
  );

  useEffect(() => {
    if (tab === 'sessions') void loadSessions();
  }, [tab, loadSessions]);

  // 关键字输入加一点防抖，避免每敲一个字就查一次
  useEffect(() => {
    if (tab !== 'audit') return;
    const t = setTimeout(() => void loadAudit(), auditQ ? 300 : 0);
    return () => clearTimeout(t);
  }, [tab, auditQ, auditAction, loadAudit]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  const markPending = (id: number, on: boolean) =>
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const filtered = useMemo(() => {
    if (!users) return null;
    const q = query.trim().toLowerCase();
    if (!q) return users;
    return users.filter((u) => {
      const roleLabel = ROLE_LABELS[u.role as UserRole] ?? u.role;
      const stateLabel = isTruthy(u.disabled) ? '已停用' : '启用中';
      return u.username.toLowerCase().includes(q) || roleLabel.includes(q) || stateLabel.includes(q);
    });
  }, [users, query]);

  const counts = useMemo(() => {
    const c = { admin: 0, operator: 0, viewer: 0, disabled: 0, total: 0 };
    for (const u of users ?? []) {
      c.total += 1;
      if (u.role === 'admin' || u.role === 'operator' || u.role === 'viewer') c[u.role] += 1;
      if (isTruthy(u.disabled)) c.disabled += 1;
    }
    return c;
  }, [users]);

  /** 每个账号当前的会话数，用于决定是否显示「该账号全部下线」 */
  const sessionCountByUser = useMemo(() => {
    const m = new Map<number, number>();
    for (const s of sessions ?? []) m.set(s.user_id, (m.get(s.user_id) ?? 0) + 1);
    return m;
  }, [sessions]);

  const openCreate = () => {
    setNewName('');
    setNewPass('');
    setNewRole('viewer');
    setNewUnit('');
    setCreateOpen(true);
    setError(null);
  };

  const create = async () => {
    if (creating) return;
    if (newName.trim().length < 2) {
      setError('用户名至少 2 个字符');
      return;
    }
    if (newPass.length < 6) {
      setError('密码至少 6 位');
      return;
    }
    if (newRole === 'admin' && !isAdminActor) {
      setError('仅管理员可以创建管理员账号');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const res = await api.createUser({
        username: newName.trim(),
        password: newPass,
        role: newRole,
        ops_unit: newUnit.trim(),
      });
      setUsers(res.users);
      setCreateOpen(false);
      setNotice(`已创建账号「${newName.trim()}」`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setCreating(false);
    }
  };

  /** 保存账号的「所属运维单位」；数据权限按它过滤，改完即时生效 */
  const saveUnit = async () => {
    if (!unitUser || pendingIds.has(unitUser.id)) return;
    if (unitValue.trim() === (unitUser.ops_unit ?? '')) {
      setUnitUser(null);
      return;
    }
    markPending(unitUser.id, true);
    setError(null);
    try {
      const res = await api.updateUser(unitUser.id, { ops_unit: unitValue.trim() });
      setUsers(res.users);
      setNotice(
        unitValue.trim()
          ? `已将「${unitUser.username}」的运维单位设为「${unitValue.trim()}」`
          : `已清空「${unitUser.username}」的运维单位`,
      );
      setUnitUser(null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      markPending(unitUser.id, false);
    }
  };

  const changeRole = async (u: UserItem, role: UserRole) => {
    if (pendingIds.has(u.id) || u.role === role) return;
    const next = abilitiesOf(role);
    const ok = await confirm({
      title: '变更角色',
      message: `将「${u.username}」从「${ROLE_LABELS[u.role as UserRole] ?? u.role}」改为「${ROLE_LABELS[role]}」？\n\n功能权限：${next.permText}\n数据权限：${next.scopeText}\n\n保存后服务端立即生效；对方已打开的页面需刷新（或重新登录），菜单与按钮才会跟着变。`,
      confirmText: '确认变更',
    });
    if (!ok) return;
    markPending(u.id, true);
    setError(null);
    setMenu(null);
    try {
      const res = await api.updateUser(u.id, { role });
      setUsers(res.users);
      setNotice(`已更新 ${u.username} 的角色`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      markPending(u.id, false);
    }
  };

  const resetPassword = async () => {
    if (!resetUser || pendingIds.has(resetUser.id)) return;
    if (resetPass.length < 6) {
      setError('新密码至少 6 位');
      return;
    }
    if (resetPass !== resetConfirm) {
      setError('两次输入的密码不一致');
      return;
    }
    markPending(resetUser.id, true);
    setError(null);
    try {
      const res = await api.updateUser(resetUser.id, { password: resetPass });
      setUsers(res.users);
      setNotice(`已重置「${resetUser.username}」的密码，对方需重新登录`);
      setResetUser(null);
      setResetPass('');
      setResetConfirm('');
    } catch (e) {
      setError(errMsg(e));
    } finally {
      markPending(resetUser.id, false);
    }
  };

  const remove = async (u: UserItem) => {
    if (pendingIds.has(u.id)) return;
    setMenu(null);
    if (
      !(await confirm({
        title: '删除用户',
        message: `确定删除「${u.username}」？\n\n删除后该账号立即失效，无法登录。此操作不可撤销。`,
        confirmText: '删除账号',
        danger: true,
      }))
    )
      return;
    markPending(u.id, true);
    setError(null);
    try {
      const res = await api.deleteUser(u.id);
      setUsers(res.users);
      setNotice(`已删除「${u.username}」`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      markPending(u.id, false);
    }
  };

  /** 停用/启用账号：停用会连同已有会话一起踢下线 */
  const toggleDisabled = async (u: UserItem) => {
    if (pendingIds.has(u.id)) return;
    const next = !isTruthy(u.disabled);
    setMenu(null);
    if (
      !(await confirm({
        title: next ? '停用账号' : '启用账号',
        message: next
          ? `停用「${u.username}」？\n\n该账号将无法登录，已登录的会话立即失效（被踢下线）。账号与历史记录保留，随时可重新启用。`
          : `启用「${u.username}」？\n\n启用后该账号恢复登录能力，需要本人重新登录。`,
        confirmText: next ? '停用并踢下线' : '启用',
        danger: next,
      }))
    )
      return;
    markPending(u.id, true);
    setError(null);
    try {
      const res = await api.updateUser(u.id, { disabled: next });
      setUsers(res.users);
      setNotice(next ? `已停用「${u.username}」并踢下线` : `已启用「${u.username}」`);
      if (sessions) void loadSessions();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      markPending(u.id, false);
    }
  };

  const markRevoking = (id: string, on: boolean) =>
    setRevokingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  /** 强制下线单个会话 */
  const revokeSession = async (s: SessionItem) => {
    if (revokingIds.has(s.id)) return;
    if (
      !(await confirm({
        title: '强制下线',
        message: `让「${s.username}」的这个会话立即失效？\n\n${describeUa(s.user_agent)}${s.ip ? ` · ${s.ip}` : ''}\n登录于 ${fmtDateTime(s.created_at)}\n\n对方需要重新登录才能继续使用。`,
        confirmText: '强制下线',
        danger: true,
      }))
    )
      return;
    markRevoking(s.id, true);
    setError(null);
    try {
      const res = await api.revokeSession(s.id);
      setSessions(res.sessions);
      setNotice(`已踢出「${s.username}」的一个会话`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      markRevoking(s.id, false);
    }
  };

  /** 踢出某账号的全部会话；对自己操作时保留当前会话，等价于「其他设备下线」 */
  const revokeAllOfUser = async (s: SessionItem) => {
    const mine = s.user_id === me?.id;
    if (
      !(await confirm({
        title: mine ? '其他设备下线' : '踢出全部会话',
        message: mine
          ? '让本账号在其他设备/浏览器上的会话全部失效？当前这个会话会保留。'
          : `让「${s.username}」的所有会话立即失效？\n\n对方会被立刻登出，需要重新登录。`,
        confirmText: mine ? '其他设备下线' : '全部踢出',
        danger: true,
      }))
    )
      return;
    setError(null);
    try {
      const res = await api.revokeUserSessions(s.user_id);
      setSessions(res.sessions);
      setNotice(mine ? `已踢出其他设备上的 ${res.revoked} 个会话` : `已踢出「${s.username}」的 ${res.revoked} 个会话`);
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const togglePerm = (role: 'operator' | 'viewer', key: string) => {
    setRolePerms((prev) => {
      const cur = new Set(prev[role] ?? []);
      if (cur.has(key)) cur.delete(key);
      else cur.add(key);
      return { ...prev, [role]: [...cur] };
    });
  };

  const discardPerms = () => {
    setRolePerms({
      operator: [...(savedPerms.operator ?? [])],
      viewer: [...(savedPerms.viewer ?? [])],
      admin: [...(savedPerms.admin ?? [])],
    });
    setRoleScopes({ ...savedScopes });
  };

  const savePerms = async () => {
    if (permSaving || !dirty) return;
    const ok = await confirm({
      title: '保存角色权限',
      message:
        '将更新运维员与查看员的功能权限与数据权限。\n\n保存后服务端立即生效；对应用户已打开的页面需刷新（或重新登录），菜单与按钮才会跟着变。管理员始终为全部权限与全部数据，不受影响。',
      confirmText: '保存变更',
    });
    if (!ok) return;
    setPermSaving(true);
    setError(null);
    try {
      const res = await api.updateRolePermissions({
        operator: rolePerms.operator ?? [],
        viewer: rolePerms.viewer ?? [],
        data_scopes: {
          operator: roleScopes.operator ?? 'all',
          viewer: roleScopes.viewer ?? 'all',
        },
      });
      setRolePerms(res.role_permissions);
      setSavedPerms({
        operator: [...(res.role_permissions.operator ?? [])],
        viewer: [...(res.role_permissions.viewer ?? [])],
        admin: [...(res.role_permissions.admin ?? [])],
      });
      setRoleScopes(res.role_data_scopes ?? {});
      setSavedScopes({ ...(res.role_data_scopes ?? {}) });
      setNotice('角色权限已保存');
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setPermSaving(false);
    }
  };

  const switchTab = async (next: TabKey) => {
    if (next === tab) return;
    if (tab === 'rbac' && dirty) {
      const ok = await confirm({
        title: '未保存的权限变更',
        message: '功能权限与数据权限有未保存修改，离开将丢弃这些更改。',
        confirmText: '丢弃并离开',
        danger: true,
      });
      if (!ok) return;
      discardPerms();
    }
    setTab(next);
  };

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="用户与权限"
        description="账号归属角色；角色决定功能权限（能做什么）与数据权限（能看哪些数据）。管理员始终为全部权限、全部数据。"
        actions={
          tab === 'accounts' ? (
            <button
              type="button"
              onClick={openCreate}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              新建用户
            </button>
          ) : tab === 'rbac' ? (
            <div className="flex items-center gap-2">
              {dirty && (
                <button
                  type="button"
                  onClick={discardPerms}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
                >
                  放弃更改
                </button>
              )}
              <button
                type="button"
                onClick={() => void savePerms()}
                disabled={permSaving || !dirty}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
              >
                {permSaving && <Spinner className="border-white/40 border-t-white" />}
                {dirty ? '保存权限' : '已是最新'}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => (tab === 'sessions' ? void loadSessions() : void loadAudit())}
              disabled={tab === 'sessions' ? sessionsLoading : auditLoading}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40"
            >
              {(tab === 'sessions' ? sessionsLoading : auditLoading) && <Spinner />}
              刷新
            </button>
          )
        }
      />

      <div className="mb-5 flex gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1">
        {(
          [
            { key: 'accounts' as const, label: '账号', hint: `${counts.total} 人` },
            { key: 'rbac' as const, label: '角色权限', hint: dirty ? '有未保存' : 'RBAC' },
            { key: 'sessions' as const, label: '在线会话', hint: sessions ? `${sessions.length} 个` : '会话' },
            { key: 'audit' as const, label: '审计日志', hint: auditLogs ? `${auditTotal} 条` : '记录' },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => void switchTab(t.key)}
            className={`flex flex-1 items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors ${
              tab === t.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
            }`}
          >
            {t.label}
            <span className={`rounded-full px-1.5 py-0.5 text-[10px] ${tab === t.key ? 'bg-slate-100 text-slate-500' : 'bg-slate-200/60 text-slate-400'}`}>
              {t.hint}
            </span>
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-4">
          <ErrorBanner message={error} />
        </div>
      )}
      {notice && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      {tab === 'accounts' && (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {(['admin', 'operator', 'viewer'] as UserRole[]).map((role) => {
              const ability = abilitiesOf(role);
              return (
                <div key={role} className={`rounded-xl border border-slate-200 px-4 py-3 ${ROLE_META[role].soft}`}>
                  <div className="flex items-center justify-between">
                    <RoleBadge role={role} />
                    <span className="text-lg font-semibold tabular-nums text-slate-900">{counts[role]}</span>
                  </div>
                  <AbilityLines {...ability} className="mt-2" />
                </div>
              );
            })}
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
              <div className="flex items-center justify-between">
                <span
                  className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${
                    counts.disabled ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-slate-200 bg-slate-100 text-slate-500'
                  }`}
                >
                  已停用
                </span>
                <span className="text-lg font-semibold tabular-nums text-slate-900">{counts.disabled}</span>
              </div>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-500">停用后不可登录，已登录会话立即失效；账号与记录保留</p>
            </div>
          </div>

          <Card className="overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
              <h3 className="text-sm font-semibold text-slate-900">账号列表</h3>
              <input
                className={`${inputCls} w-56 !py-1.5`}
                placeholder="搜索用户名或角色…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {!filtered ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400">
                <Spinner /> 加载中…
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-5 py-12 text-center text-sm text-slate-400">
                {query ? '没有匹配的用户' : '暂无用户'}
              </div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {filtered.map((u) => {
                  const isMe = me?.id === u.id;
                  const busy = pendingIds.has(u.id);
                  const roleLocked = adminLocked(u.role);
                  return (
                    <li key={u.id} className="relative flex items-center gap-4 px-5 py-4">
                      <Avatar name={u.username} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`font-medium ${isTruthy(u.disabled) ? 'text-slate-400 line-through' : 'text-slate-900'}`}>
                            {u.username}
                          </span>
                          {isMe && (
                            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                              当前登录
                            </span>
                          )}
                          <RoleBadge role={u.role} />
                          {isTruthy(u.disabled) && (
                            <span className="rounded-full border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-600">
                              已停用
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-slate-400">
                          创建于 {fmtDateTime(u.created_at)} · 运维单位：
                          {u.ops_unit ? <span className="text-slate-500">{u.ops_unit}</span> : <span className="text-amber-600">未设置</span>}
                        </p>
                      </div>

                      <div className="relative shrink-0">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={(e) => toggleMenu(u.id, e.currentTarget)}
                          className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                        >
                          管理
                        </button>
                        {menu?.id === u.id && (
                          <>
                            <div className="fixed inset-0 z-10" onClick={() => setMenu(null)} />
                            <div
                              ref={menuRef}
                              className="fixed z-20 w-52 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg"
                              style={{ top: menu.top, bottom: menu.bottom, right: menu.right }}
                            >
                              {roleLocked && (
                                <p className="border-b border-slate-100 bg-slate-50 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
                                  管理员账号仅管理员可管理
                                </p>
                              )}
                              <p className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                                变更角色
                              </p>
                              {(['viewer', 'operator', 'admin'] as UserRole[]).map((role) => {
                                const blocked = roleLocked || (role === 'admin' && !isAdminActor);
                                return (
                                  <button
                                    key={role}
                                    type="button"
                                    disabled={isMe || u.role === role || blocked}
                                    title={
                                      roleLocked
                                        ? '仅管理员可以修改管理员账号'
                                        : role === 'admin' && !isAdminActor
                                          ? '仅管理员可以授予管理员角色'
                                          : undefined
                                    }
                                    onClick={() => void changeRole(u, role)}
                                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                                  >
                                    {ROLE_LABELS[role]}
                                    {u.role === role && <span className="text-xs text-emerald-600">当前</span>}
                                  </button>
                                );
                              })}
                              <div className="my-1 border-t border-slate-100" />
                              {!isMe && (
                                <button
                                  type="button"
                                  disabled={roleLocked}
                                  title={roleLocked ? '仅管理员可以修改管理员账号' : undefined}
                                  onClick={() => void toggleDisabled(u)}
                                  className="block w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                                >
                                  {isTruthy(u.disabled) ? '启用账号' : '停用账号'}
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={roleLocked}
                                title={roleLocked ? '仅管理员可以修改管理员账号' : undefined}
                                onClick={() => {
                                  setMenu(null);
                                  setUnitUser(u);
                                  setUnitValue(u.ops_unit ?? '');
                                  setError(null);
                                }}
                                className="block w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                              >
                                设置运维单位
                              </button>
                              <button
                                type="button"
                                disabled={roleLocked}
                                title={roleLocked ? '仅管理员可以修改管理员账号' : undefined}
                                onClick={() => {
                                  setMenu(null);
                                  setResetUser(u);
                                  setResetPass('');
                                  setResetConfirm('');
                                  setError(null);
                                }}
                                className="block w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                              >
                                重置密码
                              </button>
                              {!isMe && (
                                <button
                                  type="button"
                                  disabled={roleLocked}
                                  title={roleLocked ? '仅管理员可以删除管理员账号' : undefined}
                                  onClick={() => void remove(u)}
                                  className="block w-full px-3 py-2 text-left text-sm text-rose-600 hover:bg-rose-50 disabled:opacity-40"
                                >
                                  删除账号
                                </button>
                              )}
                            </div>
                          </>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </>
      )}

      {tab === 'rbac' && (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            {(['admin', 'operator', 'viewer'] as UserRole[]).map((role) => {
              const n =
                role === 'admin'
                  ? permDefs.length
                  : (rolePerms[role] ?? []).filter((k) => permDefs.some((p) => p.key === k)).length;
              const ability = abilitiesOf(role);
              return (
                <div key={role} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                  <div className="flex items-center justify-between">
                    <RoleBadge role={role} />
                    <span className="text-xs tabular-nums text-slate-400">
                      {n}/{permDefs.length || '—'} 项
                    </span>
                  </div>
                  <AbilityLines {...ability} className="mt-2" />
                </div>
              );
            })}
          </div>

          <Card className="overflow-hidden">
            <div className="border-b border-slate-100 px-5 py-4">
              <h3 className="text-sm font-semibold text-slate-900">数据权限</h3>
              <p className="mt-0.5 text-xs text-slate-400">
                决定角色能看到哪些台账与监控系统，与上面的功能权限相互独立；管理员固定为全部数据。
              </p>
            </div>
            <div className="divide-y divide-slate-50">
              {(['admin', 'operator', 'viewer'] as UserRole[]).map((role) => {
                const locked = role === 'admin';
                const current = locked ? 'all' : (roleScopes[role] ?? 'all');
                const activeDef = dataScopeDefs.find((d) => d.key === current);
                return (
                  <div key={role} className="flex flex-col gap-2 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <RoleBadge role={role} />
                        {locked && <span className="text-[11px] text-slate-400">固定全部数据</span>}
                      </div>
                      <p className="mt-1 text-xs leading-relaxed text-slate-500">
                        {activeDef?.desc ?? DATA_SCOPE_LABELS[current]}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1">
                      {(dataScopeDefs.length
                        ? dataScopeDefs
                        : (['all', 'unit', 'self'] as DataScopeKey[]).map((key) => ({
                            key,
                            label: DATA_SCOPE_LABELS[key],
                            desc: '',
                          }))
                      ).map((def) => {
                        const on = def.key === current;
                        return (
                          <button
                            key={def.key}
                            type="button"
                            disabled={locked}
                            aria-pressed={on}
                            onClick={() => setRoleScopes((prev) => ({ ...prev, [role]: def.key }))}
                            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed ${
                              on ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-white hover:text-slate-900'
                            } ${locked && !on ? 'opacity-40' : ''}`}
                          >
                            {def.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="border-t border-amber-100 bg-amber-50/70 px-5 py-3 text-xs leading-relaxed text-amber-800">
              「仅本运维单位」按账号的「所属运维单位」过滤，未设置单位的账号在该范围下看不到任何台账与监控；「仅本人创建」只看本人新建的记录，历史数据没有创建人，对任何人都不可见。
            </p>
          </Card>

          <Card className="overflow-hidden">
            <div className="border-b border-slate-100 px-5 py-4">
              <h3 className="text-sm font-semibold text-slate-900">功能权限矩阵</h3>
              <p className="mt-0.5 text-xs leading-relaxed text-slate-400">
                勾选即为授予「操作能力」；未勾选不等于看不到——能看哪些数据由上方「数据权限」决定。管理员列锁定为全部权限；功能权限与数据权限改动后需点右上角一起保存。
              </p>
            </div>
            {permDefs.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400">
                <Spinner /> 加载中…
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-xs text-slate-400">
                      <th className="px-5 py-3 font-medium">权限能力</th>
                      <th className="w-28 px-3 py-3 text-center font-medium">管理员</th>
                      <th className="w-28 px-3 py-3 text-center font-medium">运维员</th>
                      <th className="w-28 px-3 py-3 text-center font-medium">查看员</th>
                    </tr>
                  </thead>
                  <tbody>
                    {permGroups.map((g) => (
                      <Fragment key={g.key}>
                        {/* 分组行：把「不勾选会怎样」写在这里，勾选框本身只管能不能改 */}
                        <tr className="border-y border-slate-100 bg-slate-50/60">
                          <td colSpan={4} className="px-5 py-2">
                            <span className="text-xs font-semibold text-slate-700">{g.title}</span>
                            <span className="ml-2 text-xs text-slate-400">{g.note}</span>
                          </td>
                        </tr>
                        {g.defs.map((p) => renderPermRow(p))}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {dirty && (
              <div className="flex items-center justify-between gap-3 border-t border-amber-100 bg-amber-50/80 px-5 py-3 text-sm text-amber-800">
                <span>有未保存的权限变更</span>
                <div className="flex gap-2">
                  <button type="button" onClick={discardPerms} className="rounded-lg px-3 py-1.5 text-xs font-medium hover:bg-amber-100">
                    放弃
                  </button>
                  <button
                    type="button"
                    onClick={() => void savePerms()}
                    disabled={permSaving}
                    className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700"
                  >
                    保存
                  </button>
                </div>
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === 'sessions' && (
        <div className="space-y-4">
          <p className="rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-3 text-xs leading-relaxed text-slate-500">
            会话默认 7 天到期。停用账号、重置密码、删除账号都会自动踢下线；这里可以手动让某个会话立即失效。服务端不会把会话凭证下发到浏览器，只显示摘要 id。
          </p>
          {!sessions ? (
            <Card className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400">
              <Spinner /> 加载中…
            </Card>
          ) : sessions.length === 0 ? (
            <Card className="px-5 py-12 text-center text-sm text-slate-400">当前没有在线会话</Card>
          ) : (
            <Card className="overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3.5">
                <h3 className="text-sm font-semibold text-slate-900">在线会话</h3>
                <span className="text-xs text-slate-400">
                  {sessions.length} 个会话 · {new Set(sessions.map((s) => s.user_id)).size} 个账号
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[820px] text-sm">
                  <thead>
                    <tr className="whitespace-nowrap border-b border-slate-100 bg-slate-50/80 text-left text-xs text-slate-400">
                      <th className="px-5 py-3 font-medium">账号</th>
                      <th className="px-3 py-3 font-medium">来源</th>
                      <th className="px-3 py-3 font-medium">登录时间</th>
                      <th className="px-3 py-3 font-medium">最近活跃</th>
                      <th className="px-3 py-3 font-medium">到期时间</th>
                      {/* 操作列常驻表格右侧：数据列横向滚动时按钮始终可见 */}
                      <th className="sticky right-0 z-20 w-44 border-l border-slate-100 bg-slate-50 px-5 py-3 text-right font-medium shadow-[-8px_0_12px_-12px_rgba(15,23,42,0.18)]">
                        操作
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((s) => {
                      const busy = revokingIds.has(s.id);
                      const count = sessionCountByUser.get(s.user_id) ?? 1;
                      const sessionLocked = adminLocked(s.role);
                      return (
                        <tr key={s.id} className="group border-b border-slate-50 last:border-0 hover:bg-slate-50">
                          <td className="whitespace-nowrap px-5 py-3.5">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-slate-900">{s.username}</span>
                              <RoleBadge role={s.role} />
                              {s.current && (
                                <span className="rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                                  当前会话
                                </span>
                              )}
                              {isTruthy(s.disabled) && (
                                <span className="rounded-full border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[10px] font-medium text-rose-600">
                                  已停用
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="whitespace-nowrap px-3 py-3.5">
                            <div className="text-xs text-slate-600" title={s.user_agent}>
                              {describeUa(s.user_agent)}
                            </div>
                            <div className="font-mono text-[11px] text-slate-400">{s.ip || '未知 IP'}</div>
                          </td>
                          <td className="whitespace-nowrap px-3 py-3.5 text-xs text-slate-500">{fmtDateTime(s.created_at)}</td>
                          <td className="whitespace-nowrap px-3 py-3.5 text-xs text-slate-500">
                            {s.last_seen_at ? fmtRelative(s.last_seen_at) : '—'}
                          </td>
                          <td className="whitespace-nowrap px-3 py-3.5 text-xs text-slate-500">{fmtDateTime(s.expires_at)}</td>
                          <td className="sticky right-0 z-10 whitespace-nowrap border-l border-slate-100 bg-white px-5 py-3.5 text-right shadow-[-8px_0_12px_-12px_rgba(15,23,42,0.18)] group-hover:bg-slate-50">
                            <div className="inline-flex items-center gap-2">
                              {!s.current && (
                                <button
                                  type="button"
                                  disabled={busy || sessionLocked}
                                  title={sessionLocked ? '仅管理员可以操作管理员的会话' : undefined}
                                  onClick={() => void revokeSession(s)}
                                  className="rounded-lg border border-rose-200 px-2.5 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-40"
                                >
                                  强制下线
                                </button>
                              )}
                              {count > 1 && (
                                <button
                                  type="button"
                                  disabled={busy || sessionLocked}
                                  title={sessionLocked ? '仅管理员可以操作管理员的会话' : undefined}
                                  onClick={() => void revokeAllOfUser(s)}
                                  className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                                >
                                  {s.user_id === me?.id ? '其他设备下线' : '该账号全部下线'}
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      )}

      {tab === 'audit' && (
        <Card className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-3.5">
            <h3 className="text-sm font-semibold text-slate-900">审计日志</h3>
            <span className="text-xs text-slate-400">共 {auditTotal} 条</span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Select
                size="sm"
                className="!w-44"
                value={auditAction}
                onChange={setAuditAction}
                ariaLabel="按动作筛选审计日志"
                options={[
                  { value: '', label: '全部动作', divider: true },
                  ...Object.entries(auditActions).map(([key, label]) => ({ value: key, label })),
                ]}
              />
              <input
                className={`${inputCls} w-56 !py-1.5`}
                placeholder="搜索操作人 / 对象 / 详情…"
                value={auditQ}
                onChange={(e) => setAuditQ(e.target.value)}
              />
            </div>
          </div>

          {!auditLogs ? (
            <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400">
              <Spinner /> 加载中…
            </div>
          ) : auditLogs.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-slate-400">
              {auditQ || auditAction ? '没有匹配的记录' : '暂无审计记录'}
            </div>
          ) : (
            <>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-sm">
                  <thead>
                    <tr className="whitespace-nowrap border-b border-slate-100 bg-slate-50/80 text-left text-xs text-slate-400">
                      <th className="px-5 py-3 font-medium">时间</th>
                      <th className="px-3 py-3 font-medium">动作</th>
                      <th className="px-3 py-3 font-medium">操作人</th>
                      <th className="px-3 py-3 font-medium">对象</th>
                      <th className="px-3 py-3 font-medium">详情</th>
                      <th className="px-5 py-3 font-medium">来源 IP</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditLogs.map((log) => {
                      const meta = auditMeta(log.action);
                      return (
                        <tr key={log.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/60">
                          <td className="whitespace-nowrap px-5 py-3.5 text-xs text-slate-500">{fmtDateTime(log.ts)}</td>
                          <td className="whitespace-nowrap px-3 py-3.5">
                            <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${meta.cls}`}>
                              {meta.label}
                            </span>
                          </td>
                          <td className="whitespace-nowrap px-3 py-3.5 text-slate-700">{log.actor_name || '—'}</td>
                          <td className="whitespace-nowrap px-3 py-3.5 text-slate-700">{log.target || '—'}</td>
                          <td className="max-w-[22rem] px-3 py-3.5">
                            {log.detail ? (
                              <span className="block truncate text-slate-500" title={log.detail}>
                                {log.detail}
                              </span>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </td>
                          <td className="whitespace-nowrap px-5 py-3.5 font-mono text-[11px] text-slate-400">{log.ip || '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {auditLogs.length < auditTotal && (
                <div className="border-t border-slate-100 px-5 py-3 text-center">
                  <button
                    type="button"
                    disabled={auditLoading}
                    onClick={() => void loadAudit(true)}
                    className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                  >
                    {auditLoading && <Spinner />}
                    加载更多（已显示 {auditLogs.length} / {auditTotal}）
                  </button>
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {createOpen && (
        <Modal
          title="新建用户"
          description="创建后即可用该账号登录。角色决定功能权限与数据权限，可在「角色权限」中调整。"
          onClose={() => !creating && setCreateOpen(false)}
          footer={
            <>
              <button
                type="button"
                disabled={creating}
                onClick={() => setCreateOpen(false)}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={creating || !newName.trim() || !newPass}
                onClick={() => void create()}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
              >
                {creating && <Spinner className="border-white/40 border-t-white" />}
                创建账号
              </button>
            </>
          }
        >
          <Field label="用户名" hint="建议使用工号或实名拼音，至少 2 个字符">
            <input
              className={inputCls}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoComplete="off"
              autoFocus
              placeholder="例如 zhangsan"
            />
          </Field>
          <Field label="初始密码" hint="至少 6 位；请告知本人后督促其首次登录修改">
            <input
              className={inputCls}
              type="password"
              value={newPass}
              onChange={(e) => setNewPass(e.target.value)}
              autoComplete="new-password"
              placeholder="••••••••"
            />
          </Field>
          <Field label="角色">
            <div className="space-y-2">
              {(['viewer', 'operator', 'admin'] as UserRole[]).map((role) => {
                const blocked = role === 'admin' && !isAdminActor;
                const ability = abilitiesOf(role);
                return (
                  <button
                    key={role}
                    type="button"
                    disabled={blocked}
                    title={blocked ? '仅管理员可以创建管理员账号' : undefined}
                    onClick={() => setNewRole(role)}
                    className={`flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                      newRole === role
                        ? 'border-slate-900 bg-slate-50 ring-1 ring-slate-900'
                        : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <span
                      className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                        newRole === role ? 'border-slate-900 bg-slate-900' : 'border-slate-300'
                      }`}
                    >
                      {newRole === role && <span className="h-1.5 w-1.5 rounded-full bg-white" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-slate-900">{ROLE_LABELS[role]}</span>
                      <AbilityLines {...ability} className="mt-0.5" />
                      {blocked && <span className="mt-0.5 block text-xs text-amber-600">只有管理员能创建管理员</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </Field>
          <OpsUnitField value={newUnit} onChange={setNewUnit} options={opsUnits} />
        </Modal>
      )}

      {unitUser && (
        <Modal
          title={`所属运维单位 · ${unitUser.username}`}
          description="数据权限为「仅本运维单位」时，该账号只能看到这个单位名下的台账与监控系统。"
          onClose={() => !pendingIds.has(unitUser.id) && setUnitUser(null)}
          footer={
            <>
              <button
                type="button"
                disabled={pendingIds.has(unitUser.id)}
                onClick={() => setUnitUser(null)}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              >
                取消
              </button>
              <button
                type="button"
                disabled={pendingIds.has(unitUser.id)}
                onClick={() => void saveUnit()}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
              >
                {pendingIds.has(unitUser.id) && <Spinner className="border-white/40 border-t-white" />}
                保存
              </button>
            </>
          }
        >
          <OpsUnitField value={unitValue} onChange={setUnitValue} options={opsUnits} />
        </Modal>
      )}

      {resetUser && (
        <Modal
          title={`重置密码 · ${resetUser.username}`}
          description="重置后对方需使用新密码重新登录。请通过安全渠道告知。"
          onClose={() => {
            if (!pendingIds.has(resetUser.id)) {
              setResetUser(null);
              setResetPass('');
              setResetConfirm('');
            }
          }}
          footer={
            <>
              <button
                type="button"
                onClick={() => {
                  setResetUser(null);
                  setResetPass('');
                  setResetConfirm('');
                }}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                取消
              </button>
              <button
                type="button"
                disabled={pendingIds.has(resetUser.id) || !resetPass || !resetConfirm}
                onClick={() => void resetPassword()}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
              >
                {pendingIds.has(resetUser.id) && <Spinner className="border-white/40 border-t-white" />}
                确认重置
              </button>
            </>
          }
        >
          <Field label="新密码">
            <input
              className={inputCls}
              type="password"
              value={resetPass}
              onChange={(e) => setResetPass(e.target.value)}
              autoComplete="new-password"
              autoFocus
              placeholder="至少 6 位"
            />
          </Field>
          <Field label="再次确认">
            <input
              className={inputCls}
              type="password"
              value={resetConfirm}
              onChange={(e) => setResetConfirm(e.target.value)}
              autoComplete="new-password"
              placeholder="再次输入新密码"
            />
          </Field>
        </Modal>
      )}
    </div>
  );
}
