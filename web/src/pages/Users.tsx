import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api } from '../api';
import { useConfirm } from '../components/ConfirmDialog';
import { ROLE_LABELS, useAuth, type UserRole } from '../auth';
import { Card, ErrorBanner, PageHeader, Spinner } from '../components/ui';
import type { UserItem } from '../types';
import { errMsg, fmtDateTime } from '../utils';

const inputCls =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200';

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

type TabKey = 'accounts' | 'rbac';

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
  const [menuId, setMenuId] = useState<number | null>(null);

  const [permDefs, setPermDefs] = useState<PermDef[]>([]);
  const [rolePerms, setRolePerms] = useState<Record<string, string[]>>({});
  const [savedPerms, setSavedPerms] = useState<Record<string, string[]>>({});
  const [permSaving, setPermSaving] = useState(false);

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
    return users.filter((u) => u.username.toLowerCase().includes(q) || (ROLE_LABELS[u.role as UserRole] ?? u.role).includes(q));
  }, [users, query]);

  const counts = useMemo(() => {
    const c = { admin: 0, operator: 0, viewer: 0, total: 0 };
    for (const u of users ?? []) {
      c.total += 1;
      if (u.role === 'admin' || u.role === 'operator' || u.role === 'viewer') c[u.role] += 1;
    }
    return c;
  }, [users]);

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
    setMenuId(null);
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
    setMenuId(null);
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
          ) : (
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
          )
        }
      />

      <div className="mb-5 flex gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1">
        {(
          [
            { key: 'accounts' as const, label: '账号', hint: `${counts.total} 人` },
            { key: 'rbac' as const, label: '角色权限', hint: dirty ? '有未保存' : 'RBAC' },
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
          <div className="mb-4 grid grid-cols-3 gap-3">
            {(['admin', 'operator', 'viewer'] as UserRole[]).map((role) => (
              <div key={role} className={`rounded-xl border border-slate-200 px-4 py-3 ${ROLE_META[role].soft}`}>
                <div className="flex items-center justify-between">
                  <RoleBadge role={role} />
                  <span className="text-lg font-semibold tabular-nums text-slate-900">{counts[role]}</span>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-slate-500">{ROLE_META[role].desc}</p>
              </div>
            ))}
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
                  return (
                    <li key={u.id} className="relative flex items-center gap-4 px-5 py-4">
                      <Avatar name={u.username} />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-medium text-slate-900">{u.username}</span>
                          {isMe && (
                            <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                              当前登录
                            </span>
                          )}
                          <RoleBadge role={u.role} />
                        </div>
                        <p className="mt-0.5 text-xs text-slate-400">创建于 {fmtDateTime(u.created_at)}</p>
                      </div>

                      <div className="relative shrink-0">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setMenuId((id) => (id === u.id ? null : u.id))}
                          className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                        >
                          管理
                        </button>
                        {menuId === u.id && (
                          <>
                            <div className="fixed inset-0 z-10" onClick={() => setMenuId(null)} />
                            <div className="absolute right-0 z-20 mt-1 w-48 overflow-hidden rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
                              <p className="px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                                变更角色
                              </p>
                              {(['viewer', 'operator', 'admin'] as UserRole[]).map((role) => (
                                <button
                                  key={role}
                                  type="button"
                                  disabled={isMe || u.role === role}
                                  onClick={() => void changeRole(u, role)}
                                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40"
                                >
                                  {ROLE_LABELS[role]}
                                  {u.role === role && <span className="text-xs text-emerald-600">当前</span>}
                                </button>
                              ))}
                              <div className="my-1 border-t border-slate-100" />
                              <button
                                type="button"
                                onClick={() => {
                                  setMenuId(null);
                                  setResetUser(u);
                                  setResetPass('');
                                  setResetConfirm('');
                                  setError(null);
                                }}
                                className="block w-full px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50"
                              >
                                重置密码
                              </button>
                              {!isMe && (
                                <button
                                  type="button"
                                  onClick={() => void remove(u)}
                                  className="block w-full px-3 py-2 text-left text-sm text-rose-600 hover:bg-rose-50"
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
              {(['viewer', 'operator', 'admin'] as UserRole[]).map((role) => (
                <button
                  key={role}
                  type="button"
                  onClick={() => setNewRole(role)}
                  className={`flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
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
                  </span>
                </button>
              ))}
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
