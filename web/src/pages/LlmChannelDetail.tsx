import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { useConfirm } from '../components/ConfirmDialog';
import LatencyChart from '../components/LatencyChart';
import { MultiSeriesMetricsChart } from '../components/MetricsSeriesChart';
import { StatusBadge } from '../components/StatusDot';
import { Card, ErrorBanner, PageHeader, Skeleton, Spinner } from '../components/ui';
import type {
  ChannelMetricsPayload,
  CheckRecord,
  LlmChannel,
  LlmModel,
  LlmTestResult,
  MetricsRange,
} from '../types';
import { errMsg, fmtDateTime, fmtLatency, fmtTps, normStatus, statusLabel } from '../utils';
import { subscribeWs } from '../ws';

function isOn(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

const RANGE_OPTIONS: { key: MetricsRange; label: string; hours: number; hint: string }[] = [
  { key: '24h', label: '24 小时', hours: 24, hint: '每 30 分钟一点' },
  { key: '7d', label: '7 天', hours: 24 * 7, hint: '每 2 小时一点' },
  { key: '30d', label: '30 天', hours: 24 * 30, hint: '每 6 小时一点' },
];

function ModelPanel({ modelId, hours }: { modelId: number; hours: number }) {
  const [checks, setChecks] = useState<CheckRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getLlmModelChecks(modelId, hours);
        if (!cancelled) setChecks(Array.isArray(res) ? res : res.checks ?? []);
      } catch (e) {
        if (!cancelled) setError(errMsg(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [modelId, hours]);

  if (error) {
    return (
      <div className="px-5 py-4">
        <ErrorBanner message={error} />
      </div>
    );
  }
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
    <div className="border-t border-slate-100 bg-slate-50/40 px-5 py-4">
      <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">{rangeLabel}延迟</h4>
      <LatencyChart checks={checks} emptyHint={`${rangeLabel}暂无探测数据`} />

      <h4 className="mb-2 mt-5 text-xs font-medium uppercase tracking-wide text-slate-400">最近探测记录</h4>
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
                  <td className="px-4 py-2 font-mono text-xs text-slate-600">{c.status_code ?? '—'}</td>
                  <td className="px-4 py-2 text-slate-600">
                    <div>{fmtLatency(c.latency_ms)}</div>
                    {'ttft_ms' in c && (c as { ttft_ms?: number | null }).ttft_ms != null && (
                      <div className="text-[11px] text-slate-400">
                        TTFT {fmtLatency((c as { ttft_ms?: number | null }).ttft_ms)}
                        {(c as { tps?: number | null }).tps != null && ` · ${fmtTps((c as { tps?: number | null }).tps)}`}
                      </div>
                    )}
                  </td>
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

export default function LlmChannelDetail() {
  const { id } = useParams();
  const channelId = Number(id);
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { hasPermission } = useAuth();
  const canManage = hasPermission('systems.manage') || hasPermission('settings.manage');

  const [channel, setChannel] = useState<LlmChannel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<number, { testing: boolean; result?: LlmTestResult }>>({});
  const [renaming, setRenaming] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [renameBusy, setRenameBusy] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [metricsRange, setMetricsRange] = useState<MetricsRange>('24h');
  const [metrics, setMetrics] = useState<ChannelMetricsPayload | null>(null);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [metricsLoading, setMetricsLoading] = useState(false);

  const load = useCallback(async () => {
    if (!Number.isFinite(channelId)) return;
    try {
      const res = await api.getLlmChannels();
      const found = (res.channels ?? []).find((c) => c.id === channelId) ?? null;
      setChannel(found);
      setError(found ? null : '渠道不存在');
    } catch (e) {
      setError(errMsg(e));
    }
  }, [channelId]);

  const loadMetrics = useCallback(async () => {
    if (!Number.isFinite(channelId) || channelId <= 0) return;
    setMetricsLoading(true);
    try {
      setMetrics(await api.getLlmChannelMetrics(channelId, metricsRange));
      setMetricsError(null);
    } catch (e) {
      setMetricsError(errMsg(e));
    } finally {
      setMetricsLoading(false);
    }
  }, [channelId, metricsRange]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadMetrics();
  }, [loadMetrics]);

  useEffect(
    () =>
      subscribeWs((msg) => {
        if (msg.type === 'status' || msg.type === 'alert' || msg.type === 'check') {
          void load();
          void loadMetrics();
        }
      }),
    [load, loadMetrics],
  );

  const toggleMonitor = async (m: LlmModel) => {
    try {
      await api.updateLlmModel(m.id, { monitor_enabled: !isOn(m.monitor_enabled) });
      await load();
      await loadMetrics();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const testModel = async (m: LlmModel) => {
    setTests((prev) => ({ ...prev, [m.id]: { testing: true } }));
    try {
      const result = await api.testLlmModel(m.id);
      setTests((prev) => ({ ...prev, [m.id]: { testing: false, result } }));
    } catch (e) {
      setTests((prev) => ({ ...prev, [m.id]: { testing: false, result: { ok: false, error: errMsg(e) } } }));
    }
  };

  const removeChannel = async () => {
    if (!channel) return;
    if (
      !(await confirm({
        title: '删除监控渠道',
        message: `确定删除「${channel.name}」及全部巡检模型？不影响设置中的分析用大模型。`,
        confirmText: '删除',
        danger: true,
      }))
    )
      return;
    try {
      await api.deleteLlmChannel(channel.id);
      navigate('/');
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const removeModel = async (m: LlmModel) => {
    if (
      !(await confirm({
        title: '删除模型',
        message: `确定删除模型「${m.name}」？`,
        confirmText: '删除',
        danger: true,
      }))
    )
      return;
    try {
      await api.deleteLlmModel(m.id);
      await load();
      await loadMetrics();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const startRename = () => {
    if (!channel) return;
    setNameDraft(channel.name);
    setRenaming(true);
  };

  const saveRename = async () => {
    if (!channel) return;
    const name = nameDraft.trim();
    if (!name) {
      setError('渠道名称不能为空');
      return;
    }
    if (name === channel.name) {
      setRenaming(false);
      return;
    }
    setRenameBusy(true);
    setError(null);
    try {
      const updated = await api.updateLlmChannel(channel.id, { name });
      setChannel(updated);
      setRenaming(false);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setRenameBusy(false);
    }
  };

  if (!channel && !error) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  if (!channel) {
    return (
      <div>
        <ErrorBanner message={error ?? '渠道不存在'} />
        <Link to="/" className="mt-4 inline-block text-sm text-slate-500 hover:text-slate-800">
          返回总览
        </Link>
      </div>
    );
  }

  const hours = RANGE_OPTIONS.find((r) => r.key === metricsRange)?.hours ?? 24;

  return (
    <div>
      <PageHeader
        title={
          renaming ? (
            <span className="flex flex-wrap items-center gap-2">
              <input
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-base font-semibold text-slate-900 outline-none focus:border-slate-500 focus:ring-2 focus:ring-slate-200"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void saveRename();
                  if (e.key === 'Escape') setRenaming(false);
                }}
                autoFocus
              />
              <button
                onClick={() => void saveRename()}
                disabled={renameBusy}
                className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
              >
                {renameBusy ? '保存中…' : '保存'}
              </button>
              <button
                onClick={() => setRenaming(false)}
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
              >
                取消
              </button>
            </span>
          ) : (
            channel.name
          )
        }
        description={channel.base_url}
        actions={
          <div className="flex flex-wrap gap-2">
            {canManage && !renaming && (
              <button
                onClick={startRename}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                重命名
              </button>
            )}
            {canManage && (
              <Link
                to="/llm/new"
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                + 再加模型/渠道
              </Link>
            )}
            {canManage && (
              <button
                onClick={() => void removeChannel()}
                className="rounded-lg border border-rose-200 px-3 py-2 text-sm font-medium text-rose-600 hover:bg-rose-50"
              >
                删除渠道
              </button>
            )}
          </div>
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorBanner message={error} />
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <span className="rounded border border-emerald-100 bg-emerald-50 px-2 py-0.5 font-medium text-emerald-700">
          监控渠道
        </span>
        <span>{isOn(channel.enabled) ? '已启用' : '已停用'}</span>
        <span>·</span>
        <span>{channel.models.length} 个模型</span>
        <span>·</span>
        <span>{channel.models.filter((m) => isOn(m.monitor_enabled)).length} 个巡检中</span>
      </div>

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
                  metricsRange === r.key ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
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
                <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">巡检模型</p>
                <p className="mt-1 text-lg font-semibold tabular-nums text-slate-900">
                  {metrics.summary.models_monitored}/{metrics.summary.models}
                </p>
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              <div>
                <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                  E2E 延迟
                  <span className="ml-1.5 font-normal normal-case tracking-normal text-slate-300">
                    端到端 · 按模型分色
                  </span>
                </h4>
                <MultiSeriesMetricsChart
                  range={metrics.range}
                  metric="latency"
                  overall={metrics.series}
                  lines={metrics.models
                    .filter((m) => m.monitor_enabled || (m.series && m.series.some((p) => p.avg_latency_ms != null || p.total > 0)))
                    .map((m) => ({
                      key: `m${m.id}`,
                      name: m.name,
                      points: m.series ?? [],
                    }))}
                />
              </div>
              <div>
                <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                  可用率
                  <span className="ml-1.5 font-normal normal-case tracking-normal text-slate-300">
                    按模型分色 · 点击图例可隐藏
                  </span>
                </h4>
                <MultiSeriesMetricsChart
                  range={metrics.range}
                  metric="uptime"
                  overall={metrics.series}
                  lines={metrics.models
                    .filter((m) => m.monitor_enabled || (m.series && m.series.some((p) => p.total > 0)))
                    .map((m) => ({
                      key: `m${m.id}`,
                      name: m.name,
                      points: m.series ?? [],
                    }))}
                />
              </div>
              <div>
                <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                  首 Token (TTFT)
                  <span className="ml-1.5 font-normal normal-case tracking-normal text-slate-300">
                    点数少时会显示圆点
                  </span>
                </h4>
                <MultiSeriesMetricsChart
                  range={metrics.range}
                  metric="ttft"
                  overall={metrics.series}
                  lines={metrics.models
                    .filter((m) => m.series && m.series.some((p) => p.avg_ttft_ms != null))
                    .map((m) => ({
                      key: `m${m.id}`,
                      name: m.name,
                      points: m.series ?? [],
                    }))}
                />
              </div>
              <div>
                <h4 className="mb-2 text-xs font-medium uppercase tracking-wide text-slate-400">
                  吐字速度 (TPS)
                  <span className="ml-1.5 font-normal normal-case tracking-normal text-slate-300">
                    tok/s · 点数少时会显示圆点
                  </span>
                </h4>
                <MultiSeriesMetricsChart
                  range={metrics.range}
                  metric="tps"
                  overall={metrics.series}
                  lines={metrics.models
                    .filter((m) => m.series && m.series.some((p) => p.avg_tps != null))
                    .map((m) => ({
                      key: `m${m.id}`,
                      name: m.name,
                      points: m.series ?? [],
                    }))}
                />
              </div>
            </div>

            {metrics.models.length > 0 && (
              <div className="mt-6 overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-100 bg-slate-50/80 text-left text-xs text-slate-400">
                      <th className="px-3 py-2 font-medium">模型</th>
                      <th className="px-3 py-2 font-medium">状态</th>
                      <th className="px-3 py-2 font-medium">可用率</th>
                      <th className="px-3 py-2 font-medium">E2E</th>
                      <th className="px-3 py-2 font-medium">TTFT</th>
                      <th className="px-3 py-2 font-medium">TPS</th>
                      <th className="px-3 py-2 font-medium">Tokens</th>
                      <th className="px-3 py-2 font-medium">最近</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.models.map((m) => (
                      <tr key={m.id} className="border-b border-slate-50 last:border-0">
                        <td className="px-3 py-2">
                          <div className="font-medium text-slate-800">{m.name}</div>
                          <div className="truncate font-mono text-[11px] text-slate-400">
                            {m.model} · {m.probe_mode}
                            {!m.monitor_enabled ? ' · 未巡检' : ''}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <StatusBadge status={normStatus(m.status)} expectMode={m.expect_mode} />
                        </td>
                        <td className="px-3 py-2 tabular-nums text-slate-700">
                          {m.uptime_pct == null ? '—' : `${m.uptime_pct}%`}
                        </td>
                        <td className="px-3 py-2 tabular-nums text-slate-700">{fmtLatency(m.avg_latency_ms)}</td>
                        <td className="px-3 py-2 tabular-nums text-slate-700">{fmtLatency(m.avg_ttft_ms)}</td>
                        <td className="px-3 py-2 tabular-nums text-slate-700">{fmtTps(m.avg_tps)}</td>
                        <td className="px-3 py-2 tabular-nums text-slate-700">
                          {m.avg_completion_tokens == null ? '—' : Math.round(m.avg_completion_tokens)}
                        </td>
                        <td className="px-3 py-2 text-[11px] tabular-nums text-slate-600">
                          <div>E2E {fmtLatency(m.last_latency_ms)}</div>
                          <div>TTFT {fmtLatency(m.last_ttft_ms)}</div>
                          <div>
                            {fmtTps(m.last_tps)}
                            {m.last_completion_tokens != null ? ` · ${m.last_completion_tokens} tok` : ''}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
      </Card>

      <Card className="overflow-hidden p-0">
        <div className="border-b border-slate-100 px-5 py-3.5">
          <h3 className="text-sm font-semibold text-slate-900">
            模型列表 <span className="font-normal text-slate-400">({channel.models.length})</span>
          </h3>
          <p className="mt-0.5 text-xs text-slate-400">点击行展开单项延迟曲线与探测记录</p>
        </div>
        {channel.models.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-slate-500">
            该渠道下还没有巡检模型。
            {canManage && (
              <div className="mt-3">
                <Link to="/llm/new" className="text-slate-900 underline">
                  去添加模型
                </Link>
              </div>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {channel.models.map((m) => {
              const t = tests[m.id];
              const expanded = expandedId === m.id;
              return (
                <li key={m.id}>
                  <div className="flex flex-wrap items-center gap-3 px-5 py-4">
                    <button
                      type="button"
                      onClick={() => setExpandedId(expanded ? null : m.id)}
                      className="min-w-0 flex-1 text-left"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-slate-800">{m.name}</span>
                        <StatusBadge status={normStatus(m.status)} expectMode={m.expect_mode} />
                        {!isOn(m.monitor_enabled) && (
                          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">
                            未巡检
                          </span>
                        )}
                        <svg
                          viewBox="0 0 20 20"
                          fill="currentColor"
                          className={`h-4 w-4 text-slate-300 transition-transform ${expanded ? 'rotate-180' : ''}`}
                        >
                          <path
                            fillRule="evenodd"
                            d="M5.23 7.21a.75.75 0 0 1 1.06.02L10 11.17l3.71-3.94a.75.75 0 1 1 1.08 1.04l-4.25 4.5a.75.75 0 0 1-1.08 0l-4.25-4.5a.75.75 0 0 1 .02-1.06z"
                            clipRule="evenodd"
                          />
                        </svg>
                      </div>
                      <p className="mt-0.5 truncate font-mono text-xs text-slate-400">
                        {m.model} · {m.probe_mode} · {m.interval_sec}s
                        {m.last_latency_ms != null && ` · E2E ${fmtLatency(m.last_latency_ms)}`}
                        {m.last_ttft_ms != null && ` · TTFT ${fmtLatency(m.last_ttft_ms)}`}
                        {m.last_tps != null && ` · ${fmtTps(m.last_tps)}`}
                        {' · '}
                        {statusLabel(normStatus(m.status), m.expect_mode)}
                      </p>
                      {t?.result && (
                        <p className={`mt-1 text-xs ${t.result.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {t.result.ok
                            ? `测试成功${t.result.latency_ms != null ? `，${Math.round(t.result.latency_ms)} ms` : ''}`
                            : `测试失败${t.result.error ? `：${t.result.error}` : ''}`}
                        </p>
                      )}
                    </button>
                    {canManage ? (
                      <div className="flex shrink-0 flex-wrap gap-2 text-xs">
                        <button
                          onClick={() => void toggleMonitor(m)}
                          className="rounded-lg border border-slate-300 px-2.5 py-1.5 font-medium text-slate-600 hover:bg-slate-50"
                        >
                          {isOn(m.monitor_enabled) ? '停巡检' : '开巡检'}
                        </button>
                        <button
                          onClick={() => void testModel(m)}
                          disabled={t?.testing}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1.5 font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                        >
                          {t?.testing && <Spinner className="h-3 w-3" />}
                          测试
                        </button>
                        <button
                          onClick={() => void removeModel(m)}
                          className="rounded-lg border border-slate-300 px-2.5 py-1.5 font-medium text-slate-400 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-500"
                        >
                          删除
                        </button>
                      </div>
                    ) : null}
                  </div>
                  {expanded && <ModelPanel modelId={m.id} hours={hours} />}
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
