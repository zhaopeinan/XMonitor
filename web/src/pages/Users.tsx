import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '../api';
import { useConfirm } from '../components/ConfirmDialog';
import { ROLE_LABELS, useAuth, type UserRole } from '../auth';
import { Card, ErrorBanner, PageHeader, Spinner } from '../components/ui';
import type { AuditLogItem, AuditLogPayload, SessionItem, UserItem } from '../types';
import { errMsg, fmtDateTime, fmtRelative, isTruthy } from '../utils';

const inputCls =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200';

/** 离视口边缘至少留出的间距，避免下拉贴边 */
const MENU_VIEWPORT_GAP = 8;

const ROLE_META: Record<
  UserRole,
  { label: string; cls: string; soft: string; desc: string }
> = {
  admin: {
    label: '管理员',
    cls: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    soft: 'bg-indigo-50/80',
    desc: '全部权限，含用户与角色配置；不可通过矩阵降权',
  },
  operator: {
    label: '运维员',
    cls: 'bg-amber-50 text-amber-800 border-amber-200',
    soft: 'bg-amber-50/60',
    desc: '日常监控运维；具体能力由下方 RBAC 矩阵决定',
  },
  viewer: {
    label: '查看员',
    cls: 'bg-slate-100 text-slate-600 border-slate-200',
    soft: 'bg-slate-50',
    desc: '默认可读；可单独授予确认告警等操作权限',
  },
};

interface PermDef {
  key: string;
  label: string;
  desc: string;
}

type TabKey = 'accounts' | 'rbac' | 'sessions' | 'audit';

/** 审计动作的展示样式：危险动作红色、成功/登录绿色、普通改动靛蓝 */
const AUDIT_META: Record<string, { label: string; cls: string }> = {
  login: { label: '登录成功', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  login_failed: { label: '登录失败', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  logout: { label: '退出登录', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
  password_change: { label: '修改本人密码', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  'user.create': { label: '新建账号', cls: 'bg-indigo-50 text-indigo-700 border-indigo-200' },
  'user.role': { label: '变更角色', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
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
  const [creating, setCreating] = useState(false);

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

  const [permDefs, setPermDefs] = useState<PermDef[]>([]);
  const [rolePerms, setRolePerms] = useState<Record<string, string[]>>({});
  const [savedPerms, setSavedPerms] = useState<Record<string, string[]>>({});
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

  const dirty = useMemo(() => !samePerms(rolePerms, savedPerms), [rolePerms, savedPerms]);

  const load = useCallback(async () => {
    try {
      const [u, r] = await Promise.all([api.getUsers(), api.getRolePermissions()]);
      setUsers(u.users);
      setPermDefs(r.permissions);
      setRolePerms(r.role_permissions);
      setSavedPerms({
        operator: [...(r.role_permissions.operator ?? [])],
        viewer: [...(r.role_permissions.viewer ?? [])],
        admin: [...(r.role_permissions.admin ?? [])],
      });
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
      const res = await api.createUser({ username: newName.trim(), password: newPass, role: newRole });
      setUsers(res.users);
      setCreateOpen(false);
      setNotice(`已创建账号「${newName.trim()}」`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setCreating(false);
    }
  };

  const changeRole = async (u: UserItem, role: UserRole) => {
    if (pendingIds.has(u.id) || u.role === role) return;
    const ok = await confirm({
      title: '变更角色',
      message: `将「${u.username}」从「${ROLE_LABELS[u.role as UserRole] ?? u.role}」改为「${ROLE_LABELS[role]}」？\n\n${ROLE_META[role].desc}\n\n该用户需重新登录后权限生效。`,
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
  };

  const savePerms = async () => {
    if (permSaving || !dirty) return;
    const ok = await confirm({
      title: '保存角色权限',
      message:
        '将更新运维员与查看员的权限集。\n\n已登录的对应用户需重新登录后生效；管理员权限始终为全部，不受影响。',
      confirmText: '保存变更',
    });
    if (!ok) return;
    setPermSaving(true);
    setError(null);
    try {
      const res = await api.updateRolePermissions({
        operator: rolePerms.operator ?? [],
        viewer: rolePerms.viewer ?? [],
      });
      setRolePerms(res.role_permissions);
      setSavedPerms({
        operator: [...(res.role_permissions.operator ?? [])],
        viewer: [...(res.role_permissions.viewer ?? [])],
        admin: [...(res.role_permissions.admin ?? [])],
      });
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
        message: '角色权限矩阵有未保存修改，离开将丢弃这些更改。',
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
        description="账号归属角色，能力由 RBAC 矩阵授予。管理员始终拥有全部权限。"
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
            {(['admin', 'operator', 'viewer'] as UserRole[]).map((role) => (
              <div key={role} className={`rounded-xl border border-slate-200 px-4 py-3 ${ROLE_META[role].soft}`}>
                <div className="flex items-center justify-between">
                  <RoleBadge role={role} />
                  <span className="text-lg font-semibold tabular-nums text-slate-900">{counts[role]}</span>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{ROLE_META[role].desc}</p>
              </div>
            ))}
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
                        <p className="mt-0.5 text-xs text-slate-400">创建于 {fmtDateTime(u.created_at)}</p>
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
              return (
                <div key={role} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
                  <div className="flex items-center justify-between">
                    <RoleBadge role={role} />
                    <span className="text-xs tabular-nums text-slate-400">
                      {n}/{permDefs.length || '—'} 项
                    </span>
                  </div>
                  <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{ROLE_META[role].desc}</p>
                </div>
              );
            })}
          </div>

          <Card className="overflow-hidden">
            <div className="border-b border-slate-100 px-5 py-4">
              <h3 className="text-sm font-semibold text-slate-900">权限矩阵</h3>
              <p className="mt-0.5 text-xs text-slate-400">
                勾选即为授予。管理员列锁定为全部权限；修改后需点右上角保存。
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
                    {permDefs.map((p) => {
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
                    })}
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
              <select
                className={`${inputCls} !w-44 !py-1.5`}
                value={auditAction}
                onChange={(e) => setAuditAction(e.target.value)}
              >
                <option value="">全部动作</option>
                {Object.entries(auditActions).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
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
          description="创建后即可用该账号登录。角色决定初始能力，可在「角色权限」中微调。"
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
                    <span>
                      <span className="block text-sm font-medium text-slate-900">{ROLE_LABELS[role]}</span>
                      <span className="mt-0.5 block text-xs text-slate-500">{ROLE_META[role].desc}</span>
                      {blocked && <span className="mt-0.5 block text-xs text-amber-600">只有管理员能创建管理员</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </Field>
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
