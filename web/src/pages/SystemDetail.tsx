import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import LatencyChart from '../components/LatencyChart';
import { LatencySeriesChart, UptimeSeriesChart } from '../components/MetricsSeriesChart';
import { useConfirm } from '../components/ConfirmDialog';
import { StatusBadge, StatusDot, TypeBadge, ExpectBadge } from '../components/StatusDot';
import { Card, EmptyState, ErrorBanner, PageHeader, Skeleton, Spinner, SsoBadge, Toggle } from '../components/ui';
import type { Alert, CheckRecord, MetricsRange, MonitorSummary, SystemMetricsPayload, SystemSummary } from '../types';
import {
  alertKindMeta,
  errMsg,
  fmtDateTime,
  fmtLatency,
  fmtMonitorEndpoint,
  fmtMonitorPath,
  fmtRelative,
  isTruthy,
  normStatus,
  statusLabel,
} from '../utils';
import { subscribeWs } from '../ws';

const inputCls =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200';

const RANGE_OPTIONS: { key: MetricsRange; label: string; hours: number; hint: string }[] = [
  { key: '24h', label: '24 小时', hours: 24, hint: '每 30 分钟一点' },
  { key: '7d', label: '7 天', hours: 24 * 7, hint: '每 2 小时一点' },
  { key: '30d', label: '30 天', hours: 24 * 30, hint: '每 6 小时一点' },
];

function MonitorPanel({ monitorId, hours }: { monitorId: number; hours: number }) {
  const [checks, setChecks] = useState<CheckRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getChecks(monitorId, hours);
        if (!cancelled) setChecks(Array.isArray(res) ? res : res.checks ?? []);
      } catch (e) {
        if (!cancelled) setError(errMsg(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [monitorId, hours]);

  if (error) return <div className="px-5 py-4"><ErrorBanner message={error} /></div>;
  if (!checks) {
    return (
      <div className="flex items-center justify-center gap-2 px-5 py-10 text-sm text-slate-400">
        <Spinner /> 加载探测数据…
      </div>
    );
  }

  const recent = [...checks].reverse().slice(0, 20);
  const rangeLabel = hours <= 24 ? '近 24 小时' : hours <= 24 * 7 ? '近 7 天' : '近 30 天';

  return (
    <div className="px-0 py-1">
      <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
        {rangeLabel}延迟
      </h4>
      <LatencyChart checks={checks} emptyHint={`${rangeLabel}暂无探测数据`} />

      <h4 className="mb-2 mt-5 text-xs font-medium uppercase tracking-wide text-slate-400">
        最近探测记录
      </h4>
      {recent.length === 0 ? (
        <p className="py-4 text-center text-sm text-slate-400">暂无记录</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-100 text-left text-xs text-slate-400">
                <th className="px-4 py-2 font-medium">结果</th>
                <th className="px-4 py-2 font-medium">状态码</th>
                <th className="px-4 py-2 font-medium">延迟</th>
                <th className="px-4 py-2 font-medium">时间</th>
                <th className="px-4 py-2 font-medium">错误</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((c) => (
                <tr key={c.id} className="border-b border-slate-50 last:border-0">
                  <td className="px-4 py-2">
                    {c.ok ? (
                      <span className="text-xs font-medium text-emerald-600">成功</span>
                    ) : (
                      <span className="text-xs font-medium text-rose-600">失败</span>
                    )}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-slate-600">
                    {c.status_code ?? '—'}
                  </td>
                  <td className="px-4 py-2 text-slate-600">{fmtLatency(c.latency_ms)}</td>
                  <td className="px-4 py-2 text-slate-500">{fmtDateTime(c.ts)}</td>
                  <td className="max-w-64 truncate px-4 py-2 text-xs text-rose-500" title={c.error ?? ''}>
                    {c.error || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function SystemDetail() {
  const { id } = useParams<{ id: string }>();
  const { hasPermission } = useAuth();
  const confirm = useConfirm();
  const canManage = hasPermission('systems.manage');
  const isAdmin = canManage; // 详情页写操作统一按 systems.manage
  const navigate = useNavigate();
  const systemId = Number(id);

  const [system, setSystem] = useState<SystemSummary | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [metricsRange, setMetricsRange] = useState<MetricsRange>('24h');
  const [metrics, setMetrics] = useState<SystemMetricsPayload | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
  const [ssoPending, setSsoPending] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [tokenPending, setTokenPending] = useState(false);
  const [renewPending, setRenewPending] = useState(false);
  const [renewSteps, setRenewSteps] = useState<{ level: string; message: string }[] | null>(null);
  const [renewOk, setRenewOk] = useState<boolean | null>(null);
  const [showEdit, setShowEdit] = useState(false);
  const [editName, setEditName] = useState('');
  const [editBaseUrl, setEditBaseUrl] = useState('');
  const [editPending, setEditPending] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [reversePending, setReversePending] = useState(false);

  const load = useCallback(async () => {
    try {
      const [dash, alertsRes] = await Promise.all([api.dashboard(), api.getAlerts()]);
      const sys = dash.systems.find((s) => s.id === systemId);
      if (!sys) {
        setNotFound(true);
        return;
      }
      // dashboard 的 systems 项不一定带 has_token/auth_token_masked，缺时补拉完整系统对象
      let merged = sys;
      if (sys.has_token === undefined) {
        try {
          const res = await api.getSystem(systemId);
          const full = 'system' in res ? res.system : res;
          merged = { ...sys, ...full };
        } catch {
          // 接口不可用时保留 dashboard 数据
        }
      }
      setSystem(merged);
      setNotFound(false);
      setError(null);
      const all: Alert[] = Array.isArray(alertsRes) ? alertsRes : alertsRes.alerts ?? [];
      const monitorIds = new Set(sys.monitors.map((m) => m.id));
      setAlerts(all.filter((a) => monitorIds.has(a.monitor_id)));
    } catch (e) {
      setError(errMsg(e));
    }
  }, [systemId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMetrics = useCallback(async () => {
    if (!Number.isFinite(systemId) || systemId <= 0) return;
    setMetricsLoading(true);
    try {
      setMetrics(await api.getSystemMetrics(systemId, metricsRange));
      setMetricsError(null);
    } catch (e) {
      setMetricsError(errMsg(e));
    } finally {
      setMetricsLoading(false);
    }
  }, [systemId, metricsRange]);

  useEffect(() => {
    void loadMetrics();
  }, [loadMetrics]);

  useEffect(
    () =>
      subscribeWs((msg) => {
        if (msg.type === 'alert' || msg.type === 'check' || msg.type === 'snapshot') {
          void load();
          void loadMetrics();
        }
      }),
    [load, loadMetrics],
  );

  const markPending = (mid: number, on: boolean) => {
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(mid);
      else next.delete(mid);
      return next;
    });
  };

  const toggleEnabled = async (m: MonitorSummary) => {
    const enabled = !Boolean((m as { enabled?: boolean | number }).enabled);
    markPending(m.id, true);
    // 乐观更新
    setSystem((prev) =>
      prev
        ? {
            ...prev,
            monitors: prev.monitors.map((x) =>
              x.id === m.id ? ({ ...x, enabled } as MonitorSummary) : x,
            ),
          }
        : prev,
    );
    try {
      await api.patchMonitor(m.id, { enabled });
    } catch (e) {
      setError(errMsg(e));
      await load();
    } finally {
      markPending(m.id, false);
    }
  };

  const removeMonitor = async (m: MonitorSummary) => {
    if (
      !(await confirm({
        title: '删除监控项',
        message: `确定删除监控「${m.name}」？该操作不可撤销。`,
        confirmText: '删除',
        danger: true,
      }))
    )
      return;
    markPending(m.id, true);
    try {
      await api.deleteMonitor(m.id);
      await load();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      markPending(m.id, false);
    }
  };

  const toggleExpectMode = async (m: MonitorSummary) => {
    if (pendingIds.has(m.id)) return;
    const next = m.expect_mode === 'down' ? 'up' : 'down';
    markPending(m.id, true);
    setSystem((prev) =>
      prev
        ? {
            ...prev,
            monitors: prev.monitors.map((x) =>
              x.id === m.id ? { ...x, expect_mode: next, status: 'unknown' } : x,
            ),
          }
        : prev,
    );
    try {
      await api.patchMonitor(m.id, { expect_mode: next });
      await load();
    } catch (e) {
      setError(errMsg(e));
      await load();
    } finally {
      markPending(m.id, false);
    }
  };

  /** 一键将该系统全部监控切换为反向 / 恢复正向 */
  const toggleSystemReverse = async () => {
    if (!system || reversePending) return;
    const enableReverse = !system.reverse_all;
    const ok = await confirm({
      title: enableReverse ? '开启反向监控' : '关闭反向监控',
      message: enableReverse
        ? '开启后：该系统下全部监控变为「反向」——接口仍可访问时告警，不可达视为正常。\n\n可与单项正向监控混合使用（之后可单独改回）。'
        : '关闭后：该系统下全部监控恢复为「正向」——宕机/缓慢时告警。',
      confirmText: enableReverse ? '开启反向' : '恢复正向',
      danger: enableReverse,
    });
    if (!ok) return;
    setReversePending(true);
    setError(null);
    try {
      await api.setSystemReverse(system.id, enableReverse);
      await load();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setReversePending(false);
    }
  };

  const toggleSso = async () => {
    if (!system || ssoPending) return;
    const use_sso = !isTruthy(system.use_sso);
    setSsoPending(true);
    // 乐观更新
    setSystem((prev) => (prev ? { ...prev, use_sso } : prev));
    try {
      await api.patchSystem(system.id, { use_sso });
    } catch (e) {
      setError(errMsg(e));
      await load();
    } finally {
      setSsoPending(false);
    }
  };

  const saveToken = async () => {
    if (!system || tokenPending) return;
    const token = tokenInput.trim();
    // 空值或打码值（**** 开头）都表示不修改，不发起请求
    if (!token || token.startsWith('****')) return;
    setTokenPending(true);
    setError(null);
    try {
      await api.patchSystem(system.id, { auth_token: token });
      setTokenInput('');
      await load();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setTokenPending(false);
    }
  };

  const clearToken = async () => {
    if (!system || tokenPending) return;
    if (
      !(await confirm({
        title: '清除访问令牌',
        message: '确定清除访问令牌？清除后分析和巡检将不再携带该令牌。',
        confirmText: '清除',
        danger: true,
      }))
    )
      return;
    setTokenPending(true);
    setError(null);
    try {
      await api.patchSystem(system.id, { auth_token: '' });
      setTokenInput('');
      await load();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setTokenPending(false);
    }
  };

  const renewToken = async () => {
    if (!system || renewPending) return;
    setRenewPending(true);
    setRenewSteps(null);
    setRenewOk(null);
    setError(null);
    try {
      const result = await api.renewToken(system.id);
      setRenewSteps(result.steps ?? []);
      setRenewOk(result.ok);
      if (result.ok) await load();
    } catch (e) {
      setError(errMsg(e));
      setRenewOk(false);
    } finally {
      setRenewPending(false);
    }
  };

  const openEdit = () => {
    if (!system) return;
    setEditName(system.name);
    setEditBaseUrl(system.base_url);
    setShowEdit(true);
  };

  const saveEdit = async () => {
    if (!system || editPending) return;
    const name = editName.trim();
    const baseUrl = editBaseUrl.trim();
    if (!name || !baseUrl) return;
    setEditPending(true);
    setError(null);
    try {
      await api.patchSystem(system.id, { name, base_url: baseUrl });
      setShowEdit(false);
      await load();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setEditPending(false);
    }
  };

  const removeSystem = async () => {
    if (!system || deletePending) return;
    if (
      !(await confirm({
        title: '删除系统',
        message: `确定删除系统「${system.name}」？\n\n其下所有监控项、探测记录和告警都会被一并删除，且不可恢复。`,
        confirmText: '删除系统',
        danger: true,
      }))
    )
      return;
    setDeletePending(true);
    setError(null);
    try {
      await api.deleteSystem(system.id);
      navigate('/');
    } catch (e) {
      setError(errMsg(e));
      setDeletePending(false);
    }
  };

  if (notFound) {
    return (
      <EmptyState
        title="未找到该系统"
        description="系统可能已被删除，或后端尚未同步数据。"
        action={
          <button
            onClick={() => navigate('/')}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
          >
            返回总览
          </button>
        }
      />
    );
  }

  if (!system) {
    return (
      <div>
        <Skeleton className="mb-4 h-8 w-48" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={
          <span className="inline-flex items-center gap-2.5">
            {system.name}
            {isTruthy(system.use_sso) && <SsoBadge />}
            {!!system.reverse_count && system.reverse_count > 0 && (
              <span className="rounded-full border border-orange-200 bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-700">
                反向 {system.reverse_count}/{system.monitors.length}
              </span>
            )}
          </span>
        }
        description={system.base_url}
        actions={
          isAdmin ? (
            <div className="flex flex-wrap items-center gap-3">
              <label
                className="flex items-center gap-2 text-sm text-slate-600"
                title="开启后：接口仍能访问则告警；关闭则恢复正向（宕机告警）"
              >
                <Toggle
                  on={!!system.reverse_all}
                  onChange={() => void toggleSystemReverse()}
                  disabled={reversePending || system.monitors.length === 0}
                />
                <span className={system.reverse_all ? 'font-medium text-orange-700' : ''}>反向监控</span>
              </label>
              <label className="flex items-center gap-2 text-sm text-slate-600" title="统一身份认证登录">
                <Toggle on={isTruthy(system.use_sso)} onChange={() => void toggleSso()} disabled={ssoPending} />
                SSO
              </label>
              <button
                onClick={() => navigate(`/analyze?system=${system.id}`)}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
              >
                重新分析
              </button>
              <button
                onClick={openEdit}
                className="rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition-colors hover:bg-slate-50"
              >
                编辑
              </button>
              <button
                onClick={() => void removeSystem()}
                disabled={deletePending}
                className="rounded-lg border border-rose-200 bg-white px-4 py-2 text-sm font-medium text-rose-600 shadow-sm transition-colors hover:bg-rose-50 disabled:opacity-40"
              >
                {deletePending ? '删除中…' : '删除系统'}
              </button>
            </div>
          ) : undefined
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorBanner message={error} />
        </div>
      )}

      {(system.reverse_count ?? 0) > 0 && (
        <div className="mb-4 rounded-xl border border-orange-200 bg-orange-50/70 px-4 py-3 text-sm text-orange-800">
          <span className="font-medium">反向监控已启用</span>
          <span className="text-orange-700/80">
            {' '}
            · {system.reverse_count}/{system.monitors.length} 项期望不可达；若仍能访问将告警「仍可访问」。其余项保持正向（宕机/缓慢告警）。
          </span>
        </div>
      )}

      {/* 长期监控曲线 */}
      <Card className="mb-5 p-5">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">监控趋势</h3>
            <p className="mt-0.5 text-xs text-slate-400">
              {RANGE_OPTIONS.find((r) => r.key === metricsRange)?.hint ?? ''}
              {metrics?.source === 'merged' ? ' · 已合并时序库' : ''}
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 p-0.5">
            {RANGE_OPTIONS.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => setMetricsRange(r.key)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  metricsRange === r.key
                    ? 'bg-white text-slate-900 shadow-sm'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>

        {metricsError && (
          <div className="mb-3">
            <ErrorBanner message={metricsError} />
          </div>
        )}

        {metricsLoading && !metrics ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-400">
            <Spinner /> 加载趋势…
          </div>
        ) : metrics ? (
          <>
            <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-lg border border-slate-100 bg-slate-50/80 px-3 py-2.5">
                <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">可用率</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-slate-900">
                  {metrics.summary.uptime_pct == null ? '—' : `${metrics.summary.uptime_pct}%`}
                </p>
              </div>
              <div className="rounded-lg border border-slate-100 bg-slate-50/80 px-3 py-2.5">
                <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">平均延迟</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-slate-900">
                  {fmtLatency(metrics.summary.avg_latency_ms)}
                </p>
              </div>
              <div className="rounded-lg border border-slate-100 bg-slate-50/80 px-3 py-2.5">
                <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">探测次数</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-slate-900">
                  {metrics.summary.total.toLocaleString()}
                </p>
              </div>
              <div className="rounded-lg border border-slate-100 bg-slate-50/80 px-3 py-2.5">
                <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">监控项</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-slate-900">
                  {metrics.summary.monitors_enabled}/{metrics.summary.monitors}
                </p>
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <div>
                <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">平均延迟</h4>
                <LatencySeriesChart series={metrics.series} range={metrics.range} />
              </div>
              <div>
                <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">可用率</h4>
                <UptimeSeriesChart series={metrics.series} range={metrics.range} />
              </div>
            </div>

            {metrics.monitors.length > 0 && (
              <div className="mt-6 overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-xs text-slate-400">
                      <th className="px-3 py-2 font-medium">监控项</th>
                      <th className="px-3 py-2 font-medium">状态</th>
                      <th className="px-3 py-2 font-medium">区间可用率</th>
                      <th className="px-3 py-2 font-medium">均延迟</th>
                      <th className="px-3 py-2 font-medium">探测次数</th>
                      <th className="px-3 py-2 font-medium">最近延迟</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.monitors.map((m) => (
                      <tr key={m.id} className="border-b border-slate-50 last:border-0">
                        <td className="px-3 py-2">
                          <div className="font-medium text-slate-800">{m.name}</div>
                          <div className="truncate font-mono text-[11px] text-slate-400" title={m.url}>
                            {fmtMonitorEndpoint(m.url, m.method, m.type)}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <StatusBadge status={normStatus(m.status)} expectMode={m.expect_mode} />
                        </td>
                        <td className="px-3 py-2 tabular-nums text-slate-700">
                          {m.uptime_pct == null ? '—' : `${m.uptime_pct}%`}
                        </td>
                        <td className="px-3 py-2 tabular-nums text-slate-700">{fmtLatency(m.avg_latency_ms)}</td>
                        <td className="px-3 py-2 tabular-nums text-slate-600">{m.total.toLocaleString()}</td>
                        <td className="px-3 py-2 tabular-nums text-slate-600">{fmtLatency(m.last_latency_ms)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
      </Card>

      {/* 访问令牌（仅管理员） */}
      {isAdmin && (
      <Card className="mb-5 p-5">
        <div className="mb-1.5 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">访问令牌（auth_token）</h3>
          {system.has_token ? (
            <span className="flex items-center gap-1.5 text-xs text-emerald-600">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
              已配置 <span className="font-mono">{system.auth_token_masked ?? '****'}</span>
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-xs text-slate-400">
              <span className="h-1.5 w-1.5 rounded-full bg-slate-300" />
              未配置
            </span>
          )}
        </div>
        <p className="mb-3 text-xs leading-relaxed text-slate-400">
          用于需要登录的系统（如若依框架的 Admin-Token）。点击「自动续期」将通过统一身份认证自动登录并换取新令牌；
          巡检检测到令牌失效（401）时也会自动续期。也可以手动粘贴：浏览器登录系统后 F12 →
          Application → Cookies 复制 Admin-Token 的值。
        </p>
        <div className="flex gap-2">
          <input
            className={inputCls}
            type="password"
            autoComplete="new-password"
            placeholder={
              system.has_token
                ? `当前：${system.auth_token_masked ?? '****'}，输入新值以替换`
                : '粘贴令牌值'
            }
            value={tokenInput}
            onChange={(e) => setTokenInput(e.target.value)}
          />
          <button
            onClick={() => void saveToken()}
            disabled={
              tokenPending || !tokenInput.trim() || tokenInput.trim().startsWith('****')
            }
            className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-40"
          >
            {tokenPending && <Spinner className="border-white/40 border-t-white" />}
            保存
          </button>
          {isTruthy(system.use_sso) && (
            <button
              onClick={() => void renewToken()}
              disabled={renewPending}
              className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-medium text-indigo-600 transition-colors hover:bg-indigo-100 disabled:opacity-40"
            >
              {renewPending && <Spinner className="border-indigo-300 border-t-indigo-600" />}
              {renewPending ? '续期中…' : '自动续期'}
            </button>
          )}
          {system.has_token && (
            <button
              onClick={() => void clearToken()}
              disabled={tokenPending}
              className="shrink-0 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:border-rose-200 hover:bg-rose-50 hover:text-rose-500 disabled:opacity-40"
            >
              清除
            </button>
          )}
        </div>
        {renewSteps && (
          <div
            className={`mt-3 rounded-lg border px-3 py-2 ${
              renewOk ? 'border-emerald-200 bg-emerald-50/60' : 'border-rose-200 bg-rose-50/60'
            }`}
          >
            <p className={`mb-1 text-xs font-medium ${renewOk ? 'text-emerald-600' : 'text-rose-600'}`}>
              {renewOk ? '续期成功' : '续期失败'}
            </p>
            <ol className="space-y-0.5">
              {renewSteps.map((s, i) => (
                <li key={i} className="flex items-start gap-1.5 text-xs text-slate-500">
                  <span
                    className={`mt-1.5 h-1 w-1 shrink-0 rounded-full ${
                      s.level === 'success'
                        ? 'bg-emerald-500'
                        : s.level === 'error'
                          ? 'bg-rose-500'
                          : s.level === 'warn'
                            ? 'bg-amber-400'
                            : 'bg-slate-300'
                    }`}
                  />
                  {s.message}
                </li>
              ))}
            </ol>
          </div>
        )}
      </Card>
      )}

      {/* 告警时间线 */}
      <Card className="mb-5 p-5">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">告警时间线</h3>
          <StatusBadge
            status={normStatus(system.overall_status)}
            expectMode={system.reverse_all ? 'down' : undefined}
          />
        </div>
        {alerts.length === 0 ? (
          <p className="py-2 text-sm text-slate-400">暂无告警记录</p>
        ) : (
          <ol className="relative ml-2 border-l border-slate-200">
            {alerts.slice(0, 10).map((a) => {
              const meta = alertKindMeta(a.kind);
              return (
                <li key={a.id} className="relative mb-4 ml-5 last:mb-0">
                  <span
                    className={`absolute -left-[26px] top-1 h-2.5 w-2.5 rounded-full border-2 border-white ${
                      a.kind === 'down'
                        ? 'bg-rose-500'
                        : a.kind === 'slow'
                          ? 'bg-amber-400'
                          : 'bg-emerald-500'
                    }`}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`rounded border px-1.5 py-0.5 text-xs font-medium ${meta.classes}`}
                    >
                      {meta.label}
                    </span>
                    <span className="text-sm text-slate-700">{a.message}</span>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-400">{fmtDateTime(a.ts)}</p>
                </li>
              );
            })}
          </ol>
        )}
      </Card>

      {/* 监控项列表 */}
      <Card className="p-0">
        <div className="border-b border-slate-100 px-5 py-3.5">
          <h3 className="text-sm font-semibold text-slate-900">
            监控项 <span className="font-normal text-slate-400">({system.monitors.length})</span>
          </h3>
        </div>
        {system.monitors.length === 0 ? (
          <div className="px-5 py-10 text-center text-sm text-slate-400">
            暂无监控项，点击右上角「重新分析」添加
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {system.monitors.map((m) => {
              const st = normStatus(m.status);
              const enabled = Boolean((m as { enabled?: boolean | number }).enabled ?? true);
              const expanded = expandedId === m.id;
              return (
                <li key={m.id}>
                  <div
                    onClick={() => setExpandedId(expanded ? null : m.id)}
                    className="flex cursor-pointer items-center gap-4 px-5 py-3.5 transition-colors hover:bg-slate-50"
                  >
                    <StatusDot status={st} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-slate-800">
                          {m.name}
                        </span>
                        <TypeBadge type={m.type} />
                        <ExpectBadge mode={m.expect_mode} />
                        {m.check_mode === 'browser' && (
                          <span className="shrink-0 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">
                            浏览器
                          </span>
                        )}
                      </div>
                      {m.url && (
                        <p
                          className="mt-0.5 truncate font-mono text-xs text-slate-500"
                          title={m.url}
                        >
                          {fmtMonitorEndpoint(m.url, m.method, m.type)}
                        </p>
                      )}
                      <p className="mt-0.5 text-xs text-slate-400">
                        {statusLabel(st, m.expect_mode)} · 最近检查 {fmtRelative(m.last_check_at)}
                      </p>
                    </div>
                    <span className="w-20 text-right text-sm text-slate-600">
                      {fmtLatency(m.last_latency_ms)}
                    </span>
                    {isAdmin && (
                      <>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            void toggleExpectMode(m);
                          }}
                          disabled={pendingIds.has(m.id)}
                          title={
                            m.expect_mode === 'down'
                              ? '当前反向：可达则告警。点击切回正向'
                              : '当前正向：宕机则告警。点击切换为反向'
                          }
                          className={`rounded-md border px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-40 ${
                            m.expect_mode === 'down'
                              ? 'border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100'
                              : 'border-slate-200 bg-white text-slate-500 hover:bg-slate-50'
                          }`}
                        >
                          {m.expect_mode === 'down' ? '反向' : '正向'}
                        </button>
                        <Toggle
                          on={enabled}
                          disabled={pendingIds.has(m.id)}
                          onChange={() => void toggleEnabled(m)}
                        />
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            void removeMonitor(m);
                          }}
                          disabled={pendingIds.has(m.id)}
                          className="rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-500 disabled:opacity-40"
                          title="删除监控"
                        >
                          <svg viewBox="0 0 20 20" fill="currentColor" className="h-4 w-4">
                            <path
                              fillRule="evenodd"
                              d="M8.5 3a1.5 1.5 0 0 1 3 0H14a2 2 0 0 1 2 2v.5H4V5a2 2 0 0 1 2-2h2.5zM5 7.5h10l-.7 8.4A2 2 0 0 1 12.3 18H7.7a2 2 0 0 1-2-2.1L5 7.5z"
                              clipRule="evenodd"
                            />
                          </svg>
                        </button>
                      </>
                    )}
                    <svg
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      className={`h-4 w-4 text-slate-300 transition-transform ${expanded ? 'rotate-180' : ''}`}
                    >
                      <path
                        fillRule="evenodd"
                        d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </div>
                  {expanded && (
                    <div className="border-t border-slate-100 bg-slate-50/30 px-5 py-3">
                      {m.url && (
                        <div className="mb-3 rounded-lg border border-slate-200 bg-white px-3 py-2.5">
                          <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-slate-400">
                            请求详情
                          </div>
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            {m.type === 'api' && (
                              <span className="rounded bg-violet-50 px-1.5 py-0.5 font-mono font-semibold text-violet-600">
                                {(m.method || 'GET').toUpperCase()}
                              </span>
                            )}
                            <span className="break-all font-mono text-slate-700" title={m.url}>
                              {fmtMonitorPath(m.url) || m.url}
                            </span>
                          </div>
                          <p className="mt-1 break-all font-mono text-[11px] text-slate-400">{m.url}</p>
                        </div>
                      )}
                      <MonitorPanel
                        monitorId={m.id}
                        hours={RANGE_OPTIONS.find((r) => r.key === metricsRange)?.hours ?? 24}
                      />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* 编辑系统弹窗 */}
      {showEdit && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/30 px-4" onClick={() => !editPending && setShowEdit(false)}>
          <div
            className="w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-4 text-sm font-semibold text-slate-900">编辑系统</h3>
            <div className="flex flex-col gap-4">
              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700">系统名称</label>
                <input className={inputCls} value={editName} onChange={(e) => setEditName(e.target.value)} />
              </div>
              <div>
                <label className="mb-1.5 block text-sm font-medium text-slate-700">主页 URL</label>
                <input className={inputCls} type="url" value={editBaseUrl} onChange={(e) => setEditBaseUrl(e.target.value)} />
                <p className="mt-1 text-xs text-slate-400">
                  修改 URL 后建议重新分析，已有监控项的地址不会自动变更。
                </p>
              </div>
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <button
                onClick={() => setShowEdit(false)}
                disabled={editPending}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              >
                取消
              </button>
              <button
                onClick={() => void saveEdit()}
                disabled={editPending || !editName.trim() || !editBaseUrl.trim()}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
              >
                {editPending && <Spinner className="border-white/40 border-t-white" />}
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
