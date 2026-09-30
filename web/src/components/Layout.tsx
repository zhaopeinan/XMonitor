import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { api } from '../api';
import { ROLE_LABELS, useAuth } from '../auth';
import type { Alert, LlmChannel, SystemSummary } from '../types';
import { errMsg, normStatus } from '../utils';
import { subscribeConnection, subscribeWs } from '../ws';
import { StatusDot } from './StatusDot';

const miniInputCls =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200';

function ChangePasswordModal({ onClose }: { onClose: () => void }) {
  const { logout } = useAuth();
  const [oldPass, setOldPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async () => {
    if (pending || !oldPass || !newPass) return;
    setPending(true);
    setError(null);
    try {
      await api.changePassword(oldPass, newPass);
      // 改密后会话失效，需要重新登录
      await logout();
    } catch (e) {
      setError(errMsg(e));
      setPending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 px-4" onClick={onClose}>
      <div
        className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-4 text-sm font-semibold text-slate-900">修改密码</h3>
        <input
          className={`${miniInputCls} mb-3`}
          type="password"
          placeholder="原密码"
          value={oldPass}
          onChange={(e) => setOldPass(e.target.value)}
          autoComplete="current-password"
        />
        <input
          className={`${miniInputCls} mb-3`}
          type="password"
          placeholder="新密码（至少 6 位）"
          value={newPass}
          onChange={(e) => setNewPass(e.target.value)}
          autoComplete="new-password"
        />
        {error && <p className="mb-3 text-xs text-rose-600">{error}</p>}
        <p className="mb-4 text-xs text-slate-400">修改成功后需要重新登录。</p>
        <div className="flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
          >
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={pending || !oldPass || !newPass}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
          >
            {pending ? '提交中…' : '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}

function navClasses({ isActive }: { isActive: boolean }) {
  return `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
    isActive
      ? 'bg-slate-900 text-white font-medium'
      : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
  }`;
}

export default function Layout() {
  const { user, logout, hasPermission } = useAuth();
  const [systems, setSystems] = useState<SystemSummary[]>([]);
  const [llmChannels, setLlmChannels] = useState<LlmChannel[]>([]);
  const [unack, setUnack] = useState(0);
  const [wsOk, setWsOk] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [showChangePass, setShowChangePass] = useState(false);
  const canUsers = hasPermission('users.manage');
  const canSettings = hasPermission('settings.manage');
  const isAdmin = user?.role === 'admin';
  const roleLabel = user ? ROLE_LABELS[user.role] ?? user.role : '';
  const roleBadgeCls =
    user?.role === 'admin'
      ? 'border-indigo-200 bg-indigo-50 text-indigo-600'
      : user?.role === 'operator'
        ? 'border-amber-200 bg-amber-50 text-amber-700'
        : 'border-slate-200 bg-slate-50 text-slate-500';

  const loadSystems = useCallback(async () => {
    try {
      const data = await api.dashboard();
      setSystems(data.systems ?? []);
    } catch {
      // 后端未就绪时静默，侧边栏仅显示导航
    }
  }, []);

  const loadLlmChannels = useCallback(async () => {
    try {
      const res = await api.getLlmChannels();
      setLlmChannels(res.channels ?? []);
    } catch {
      // 忽略
    }
  }, []);

  const loadUnack = useCallback(async () => {
    try {
      const res = await api.getAlerts();
      const list: Alert[] = Array.isArray(res) ? res : res.alerts ?? [];
      setUnack(list.filter((a) => !a.acknowledged).length);
    } catch {
      // 忽略
    }
  }, []);

  useEffect(() => {
    void loadSystems();
    void loadLlmChannels();
    void loadUnack();
  }, [loadSystems, loadLlmChannels, loadUnack]);

  useEffect(
    () =>
      subscribeWs((msg) => {
        if (msg.type === 'alert' || msg.type === 'snapshot' || msg.type === 'status') {
          void loadSystems();
          void loadLlmChannels();
          void loadUnack();
        }
      }),
    [loadSystems, loadLlmChannels, loadUnack],
  );

  useEffect(() => subscribeConnection(setWsOk), []);

  return (
    <div className="flex min-h-screen">
      {/* 侧边栏 */}
      <aside className="fixed inset-y-0 left-0 flex w-60 flex-col border-r border-slate-200 bg-white">
        <div className="flex h-14 items-center gap-2 border-b border-slate-100 px-5">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-slate-900 text-xs font-bold text-white">
            XM
          </span>
          <span className="text-base font-semibold tracking-tight text-slate-900">XMonitor</span>
        </div>

        <nav className="flex flex-col gap-1 px-3 pt-4">
          <NavLink to="/" end className={navClasses}>
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M3 3h6v6H3V3zm8 0h6v6h-6V3zM3 11h6v6H3v-6zm8 0h6v6h-6v-6z" />
            </svg>
            Dashboard
          </NavLink>
          <NavLink to="/alerts" className={navClasses}>
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M10 2a6 6 0 0 0-6 6v3.5l-1.5 3a.75.75 0 0 0 .67 1.1h13.66a.75.75 0 0 0 .67-1.1l-1.5-3V8a6 6 0 0 0-6-6zm0 16a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 10 18z" />
            </svg>
            告警
            {unack > 0 && (
              <span className="ml-auto rounded-full bg-rose-500 px-1.5 py-0.5 text-xs font-medium leading-none text-white">
                {unack > 99 ? '99+' : unack}
              </span>
            )}
          </NavLink>
          <NavLink to="/screen" className={navClasses}>
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
              <path d="M2 4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-3v2h2a.75.75 0 0 1 0 1.5H5a.75.75 0 0 1 0-1.5h2v-2H4a2 2 0 0 1-2-2V4zm2.5 6.2 2.6-2.6 2.1 2.1 3.6-3.6 1.1 1.1-4.7 4.7-2.1-2.1-1.5 1.5-1.1-1.1z" />
            </svg>
            监控大屏
          </NavLink>
          {canUsers && (
            <NavLink to="/users" className={navClasses}>
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                <path d="M10 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3.465 14.493a1.23 1.23 0 0 0 .41 1.412A9.957 9.957 0 0 0 10 18c2.31 0 4.438-.784 6.131-2.1.43-.333.604-.903.408-1.41a7.002 7.002 0 0 0-13.074.003z" />
              </svg>
              用户与权限
            </NavLink>
          )}
          {isAdmin && (
            <NavLink to="/system-status" className={navClasses}>
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                <path
                  fillRule="evenodd"
                  d="M10 1.5a.75.75 0 0 1 .67.415l1.4 2.75 3.05.45a.75.75 0 0 1 .415 1.28l-2.2 2.15.52 3.03a.75.75 0 0 1-1.09.79L10 11.52l-2.76 1.45a.75.75 0 0 1-1.09-.79l.52-3.03-2.2-2.15a.75.75 0 0 1 .415-1.28l3.05-.45 1.4-2.75A.75.75 0 0 1 10 1.5zM5.5 14a.75.75 0 0 1 .75.75v1a.75.75 0 0 1-1.5 0v-1A.75.75 0 0 1 5.5 14zm4.5 0a.75.75 0 0 1 .75.75v2.5a.75.75 0 0 1-1.5 0v-2.5A.75.75 0 0 1 10 14zm4.5 0a.75.75 0 0 1 .75.75V17a.75.75 0 0 1-1.5 0v-2.25a.75.75 0 0 1 .75-.75z"
                  clipRule="evenodd"
                />
              </svg>
              系统状况
            </NavLink>
          )}
          {canSettings && (
            <NavLink to="/settings" className={navClasses}>
              <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                <path
                  fillRule="evenodd"
                  d="M11.07 2.25a1.5 1.5 0 0 0-2.14 0l-.6.65a1.5 1.5 0 0 1-1.32.44l-.91-.1a1.5 1.5 0 0 0-1.61 1.61l.1.9c.07.5-.1 1.03-.44 1.33l-.65.6a1.5 1.5 0 0 0 0 2.14l.65.6c.34.3.5.83.44 1.32l-.1.91a1.5 1.5 0 0 0 1.61 1.61l.9-.1c.5-.07 1.03.1 1.33.44l.6.65a1.5 1.5 0 0 0 2.14 0l.6-.65c.3-.34.83-.5 1.32-.44l.91.1a1.5 1.5 0 0 0 1.61-1.61l-.1-.9a1.5 1.5 0 0 1 .44-1.33l.65-.6a1.5 1.5 0 0 0 0-2.14l-.65-.6a1.5 1.5 0 0 1-.44-1.32l.1-.91a1.5 1.5 0 0 0-1.61-1.61l-.9.1a1.5 1.5 0 0 1-1.33-.44l-.6-.65zM10 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z"
                  clipRule="evenodd"
                />
              </svg>
              设置
            </NavLink>
          )}
        </nav>

        <div className="mt-6 px-5 pb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
          系统
        </div>
        <div className="max-h-[40%] overflow-y-auto px-3">
          {systems.length === 0 ? (
            <p className="px-3 py-2 text-xs text-slate-400">暂无系统</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {systems.map((s) => (
                <li key={s.id}>
                  <NavLink
                    to={`/systems/${s.id}`}
                    className={({ isActive }) =>
                      `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                        isActive
                          ? 'bg-slate-100 font-medium text-slate-900'
                          : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                      }`
                    }
                  >
                    <StatusDot status={normStatus(s.overall_status)} size="h-2 w-2" />
                    <span className="truncate">{s.name}</span>
                  </NavLink>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 px-5 pb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
          大模型
        </div>
        <div className="flex-1 overflow-y-auto px-3 pb-4">
          {llmChannels.length === 0 ? (
            <p className="px-3 py-2 text-xs text-slate-400">暂无渠道</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {llmChannels.map((c) => {
                const monitored = c.models.filter((m) => m.monitor_enabled === true || m.monitor_enabled === 1);
                const worst = monitored.reduce<'up' | 'slow' | 'down' | 'unknown'>((acc, m) => {
                  const st = normStatus(m.status);
                  const rank = { up: 0, unknown: 1, slow: 2, down: 3 } as const;
                  return rank[st] > rank[acc] ? st : acc;
                }, 'unknown');
                return (
                  <li key={c.id}>
                    <NavLink
                      to={`/llm/channels/${c.id}`}
                      className={({ isActive }) =>
                        `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                          isActive
                            ? 'bg-slate-100 font-medium text-slate-900'
                            : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900'
                        }`
                      }
                    >
                      <StatusDot status={monitored.length ? worst : 'unknown'} size="h-2 w-2" />
                      <span className="min-w-0 flex-1 truncate">{c.name}</span>
                      <span className="shrink-0 text-[10px] text-slate-400">{c.models.length}</span>
                    </NavLink>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* 主区域 */}
      <div className="ml-60 flex min-h-screen flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-end gap-4 border-b border-slate-200 bg-white/80 px-6 backdrop-blur">
          <span className="flex items-center gap-1.5 text-xs text-slate-400">
            <span className={`h-1.5 w-1.5 rounded-full ${wsOk ? 'bg-emerald-500' : 'bg-slate-300'}`} />
            {wsOk ? '实时已连接' : '连接中…'}
          </span>
          <Link
            to="/alerts"
            className="relative rounded-lg p-2 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700"
            title="告警"
          >
            <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5">
              <path d="M10 2a6 6 0 0 0-6 6v3.5l-1.5 3a.75.75 0 0 0 .67 1.1h13.66a.75.75 0 0 0 .67-1.1l-1.5-3V8a6 6 0 0 0-6-6zm0 16a2.5 2.5 0 0 0 2.45-2h-4.9A2.5 2.5 0 0 0 10 18z" />
            </svg>
            {unack > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold text-white">
                {unack > 99 ? '99+' : unack}
              </span>
            )}
          </Link>

          {/* 用户菜单 */}
          <div className="relative">
            <button
              onClick={() => setUserMenuOpen((v) => !v)}
              className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-slate-600 transition-colors hover:bg-slate-100"
            >
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-slate-900 text-xs font-medium text-white">
                {user?.username.slice(0, 1).toUpperCase()}
              </span>
              <span className="font-medium">{user?.username}</span>
              <span
                className={`rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${roleBadgeCls}`}
              >
                {roleLabel}
              </span>
            </button>
            {userMenuOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setUserMenuOpen(false)} />
                <div className="absolute right-0 z-30 mt-1 w-40 rounded-xl border border-slate-200 bg-white py-1 shadow-lg">
                  <button
                    onClick={() => {
                      setUserMenuOpen(false);
                      setShowChangePass(true);
                    }}
                    className="block w-full px-4 py-2 text-left text-sm text-slate-600 hover:bg-slate-50"
                  >
                    修改密码
                  </button>
                  <button
                    onClick={() => void logout()}
                    className="block w-full px-4 py-2 text-left text-sm text-rose-600 hover:bg-rose-50"
                  >
                    退出登录
                  </button>
                </div>
              </>
            )}
          </div>
        </header>
        <main className="flex-1 px-6 py-6">
          <Outlet />
        </main>
        {showChangePass && <ChangePasswordModal onClose={() => setShowChangePass(false)} />}
      </div>
    </div>
  );
}
