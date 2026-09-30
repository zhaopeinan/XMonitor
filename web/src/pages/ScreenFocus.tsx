import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { LatencySeriesChart, MultiSeriesMetricsChart, UptimeSeriesChart } from '../components/MetricsSeriesChart';
import type {
  ChannelMetricsPayload,
  MetricsRange,
  ScreenLlmChannel,
  ScreenSystem,
  SystemMetricsPayload,
} from '../types';
import { errMsg, fmtLatency, fmtMonitorEndpoint, normStatus, rateKindLabel, statusLabel } from '../utils';

const MONO = `'Geist Mono', 'SF Mono', 'JetBrains Mono', ui-monospace, 'PingFang SC', monospace`;

const STATUS_META: Record<string, { label: string; fg: string; bg: string; dot: string }> = {
  up: { label: '正常', fg: '#346538', bg: '#EDF3EC', dot: '#5F9E67' },
  slow: { label: '缓慢', fg: '#956400', bg: '#FBF3DB', dot: '#D9A62E' },
  down: { label: '故障', fg: '#9F2F2D', bg: '#FDEBEC', dot: '#D05A57' },
  unknown: { label: '未知', fg: '#787774', bg: '#F0EFEC', dot: '#C4C2BD' },
};

function statusMeta(s: string | null | undefined, expectMode?: string | null) {
  const st = normStatus(s);
  const base = STATUS_META[st] ?? STATUS_META.unknown;
  if (expectMode === 'down') return { ...base, label: statusLabel(st, 'down') };
  return base;
}

const RANGE_OPTIONS: { key: MetricsRange; label: string }[] = [
  { key: '24h', label: '24h' },
  { key: '7d', label: '7d' },
  { key: '30d', label: '30d' },
];

function cardStyle(): React.CSSProperties {
  return { border: '1px solid #EAEAEA', background: '#FFFFFF' };
}

/** 大屏内详情：只读观察，不打断大屏语境；完整编辑走工作台 */
export function ScreenSystemFocus({
  system,
  generatedAt,
  heatStrip,
}: {
  system: ScreenSystem;
  generatedAt: number;
  heatStrip: React.ReactNode;
}) {
  const [range, setRange] = useState<MetricsRange>('24h');
  const [metrics, setMetrics] = useState<SystemMetricsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setMetrics(await api.getSystemMetrics(system.id, range));
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [system.id, range]);

  useEffect(() => {
    void load();
  }, [load]);

  const rateKind = system.rate_kind ?? (system.reverse_all ? 'block' : (system.reverse_count ?? 0) > 0 ? 'compliance' : 'uptime');
  const meta = statusMeta(system.overall_status, system.reverse_all ? 'down' : undefined);

  return (
    <div className="mx-auto max-w-[1100px] px-8 pb-12 pt-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            to="/screen"
            className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-medium transition-colors hover:opacity-80"
            style={{ color: '#787774' }}
          >
            ← 返回总览
          </Link>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[28px] font-semibold tracking-tight" style={{ color: '#111111' }}>
              {system.name}
            </h1>
            <span className="rounded-full px-2.5 py-0.5 text-[11px] font-medium" style={{ background: meta.bg, color: meta.fg }}>
              {meta.label}
            </span>
            {(system.reverse_count ?? 0) > 0 && (
              <span className="rounded-full px-2.5 py-0.5 text-[11px] font-medium" style={{ background: '#FFF4E5', color: '#9A6700' }}>
                反向 {system.reverse_count}/{system.monitor_count}
              </span>
            )}
          </div>
          <p className="mt-1 truncate text-[12px]" style={{ color: '#A6A39D', fontFamily: MONO }} title={system.base_url}>
            {system.base_url}
          </p>
        </div>
        <Link
          to={`/systems/${system.id}`}
          className="shrink-0 rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
          style={{ border: '1px solid #EAEAEA', color: '#2F3437', background: '#FAFAF8' }}
        >
          工作台管理 →
        </Link>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: rateKindLabel(rateKind), value: system.uptime_24h == null ? '—' : `${system.uptime_24h.toFixed(1)}%` },
          { label: '平均延迟', value: system.avg_latency_ms == null ? '—' : fmtLatency(system.avg_latency_ms) },
          { label: '监控项', value: String(system.monitor_count) },
          { label: '当前', value: `${system.up_count} 正常 · ${system.down_count} 故障` },
        ].map((k) => (
          <div key={k.label} className="rounded-xl p-4" style={cardStyle()}>
            <p className="text-[10px] font-medium uppercase tracking-wide" style={{ color: '#A6A39D' }}>
              {k.label}
            </p>
            <p className="mt-1 text-[18px] font-semibold tabular-nums" style={{ color: '#2F3437', fontFamily: MONO }}>
              {k.value}
            </p>
          </div>
        ))}
      </div>

      <div className="mb-5 rounded-xl p-5" style={cardStyle()}>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold" style={{ color: '#111111' }}>
            近 24 小时状态
          </h2>
          <span className="text-[10px]" style={{ color: '#A6A39D', fontFamily: MONO }}>
            {new Date(generatedAt).toLocaleString('zh-CN', { hour12: false })}
          </span>
        </div>
        {heatStrip}
      </div>

      <div className="mb-5 rounded-xl p-5" style={cardStyle()}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold" style={{ color: '#111111' }}>
            监控趋势
          </h2>
          <div className="flex gap-1 rounded-lg p-0.5" style={{ background: '#F1F0ED' }}>
            {RANGE_OPTIONS.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => setRange(r.key)}
                className="rounded-md px-2.5 py-1 text-[11px] font-medium"
                style={{
                  background: range === r.key ? '#FFFFFF' : 'transparent',
                  color: range === r.key ? '#111111' : '#787774',
                  boxShadow: range === r.key ? '0 1px 2px rgba(0,0,0,0.04)' : 'none',
                }}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        {error && (
          <p className="mb-3 text-sm" style={{ color: '#9F2F2D' }}>
            {error}
          </p>
        )}
        {loading && !metrics ? (
          <div className="flex h-40 items-center justify-center text-sm" style={{ color: '#A6A39D' }}>
            加载趋势…
          </div>
        ) : metrics ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wide" style={{ color: '#A6A39D' }}>
                平均延迟
              </p>
              <LatencySeriesChart series={metrics.series} range={metrics.range} />
            </div>
            <div>
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wide" style={{ color: '#A6A39D' }}>
                可用率
              </p>
              <UptimeSeriesChart series={metrics.series} range={metrics.range} />
            </div>
          </div>
        ) : null}
      </div>

      <div className="rounded-xl p-5" style={cardStyle()}>
        <h2 className="mb-3 text-sm font-semibold" style={{ color: '#111111' }}>
          监控项
        </h2>
        {system.monitors.length === 0 ? (
          <p className="text-sm" style={{ color: '#A6A39D' }}>
            暂无监控项
          </p>
        ) : (
          <ul className="divide-y" style={{ borderColor: '#F1F0ED' }}>
            {system.monitors.map((m) => {
              const mm = statusMeta(m.status, m.expect_mode);
              return (
                <li key={m.id} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: mm.dot }} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium" style={{ color: '#2F3437' }}>
                      {m.name}
                    </div>
                    {m.url && (
                      <div
                        className="mt-0.5 truncate text-[11px]"
                        style={{ color: '#787774', fontFamily: MONO }}
                        title={m.url}
                      >
                        {fmtMonitorEndpoint(m.url, m.method, m.type)}
                      </div>
                    )}
                    <div className="text-[11px]" style={{ color: '#A6A39D' }}>
                      {mm.label}
                      {m.expect_mode === 'down' ? ' · 反向' : ''}
                      {m.uptime_24h != null ? ` · ${m.uptime_24h.toFixed(0)}%` : ''}
                    </div>
                  </div>
                  <span className="shrink-0 text-[12px] tabular-nums" style={{ color: '#787774', fontFamily: MONO }}>
                    {m.last_latency_ms == null ? '—' : fmtLatency(m.last_latency_ms)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

export function ScreenChannelFocus({
  channel,
  generatedAt,
  heatStrip,
}: {
  channel: ScreenLlmChannel;
  generatedAt: number;
  heatStrip: React.ReactNode;
}) {
  const [range, setRange] = useState<MetricsRange>('24h');
  const [metrics, setMetrics] = useState<ChannelMetricsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setMetrics(await api.getLlmChannelMetrics(channel.id, range));
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, [channel.id, range]);

  useEffect(() => {
    void load();
  }, [load]);

  const meta = statusMeta(channel.enabled ? channel.overall_status : 'unknown');
  const rateKind = channel.rate_kind ?? 'uptime';

  return (
    <div className="mx-auto max-w-[1100px] px-8 pb-12 pt-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <Link
            to="/screen"
            className="mb-3 inline-flex items-center gap-1.5 text-[12px] font-medium transition-colors hover:opacity-80"
            style={{ color: '#787774' }}
          >
            ← 返回总览
          </Link>
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-[28px] font-semibold tracking-tight" style={{ color: '#111111' }}>
              {channel.name}
            </h1>
            <span className="rounded-full px-2.5 py-0.5 text-[11px] font-medium" style={{ background: meta.bg, color: meta.fg }}>
              {!channel.enabled ? '已停用' : meta.label}
            </span>
            <span className="rounded-full px-2.5 py-0.5 text-[11px] font-medium" style={{ background: '#E8EEE9', color: '#3D5240' }}>
              模型渠道
            </span>
          </div>
          <p className="mt-1 truncate text-[12px]" style={{ color: '#A6A39D', fontFamily: MONO }} title={channel.base_url}>
            {channel.base_url}
          </p>
        </div>
        <Link
          to={`/llm/channels/${channel.id}`}
          className="shrink-0 rounded-md px-3 py-1.5 text-xs font-medium"
          style={{ border: '1px solid #EAEAEA', color: '#2F3437', background: '#FAFAF8' }}
        >
          工作台管理 →
        </Link>
      </div>

      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: rateKindLabel(rateKind), value: channel.uptime_24h == null ? '—' : `${channel.uptime_24h.toFixed(1)}%` },
          { label: '平均延迟', value: channel.avg_latency_ms == null ? '—' : fmtLatency(channel.avg_latency_ms) },
          { label: '巡检中', value: `${channel.monitored_count}/${channel.model_count}` },
          {
            label: '当前',
            value: `${channel.up_count} 正常 · ${channel.slow_count} 缓慢 · ${channel.down_count} 故障`,
          },
        ].map((k) => (
          <div key={k.label} className="rounded-xl p-4" style={cardStyle()}>
            <p className="text-[10px] font-medium uppercase tracking-wide" style={{ color: '#A6A39D' }}>
              {k.label}
            </p>
            <p className="mt-1 text-[18px] font-semibold tabular-nums" style={{ color: '#2F3437', fontFamily: MONO }}>
              {k.value}
            </p>
          </div>
        ))}
      </div>

      <div className="mb-5 rounded-xl p-5" style={cardStyle()}>
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold" style={{ color: '#111111' }}>
            近 24 小时状态
          </h2>
          <span className="text-[10px]" style={{ color: '#A6A39D', fontFamily: MONO }}>
            {new Date(generatedAt).toLocaleString('zh-CN', { hour12: false })}
          </span>
        </div>
        {heatStrip}
      </div>

      <div className="mb-5 rounded-xl p-5" style={cardStyle()}>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold" style={{ color: '#111111' }}>
            监控趋势
          </h2>
          <div className="flex gap-1 rounded-lg p-0.5" style={{ background: '#F1F0ED' }}>
            {RANGE_OPTIONS.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => setRange(r.key)}
                className="rounded-md px-2.5 py-1 text-[11px] font-medium"
                style={{
                  background: range === r.key ? '#FFFFFF' : 'transparent',
                  color: range === r.key ? '#111111' : '#787774',
                  boxShadow: range === r.key ? '0 1px 2px rgba(0,0,0,0.04)' : 'none',
                }}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
        {error && (
          <p className="mb-3 text-sm" style={{ color: '#9F2F2D' }}>
            {error}
          </p>
        )}
        {loading && !metrics ? (
          <div className="flex h-40 items-center justify-center text-sm" style={{ color: '#A6A39D' }}>
            加载趋势…
          </div>
        ) : metrics ? (
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wide" style={{ color: '#A6A39D' }}>
                E2E 延迟 · 按模型
              </p>
              <MultiSeriesMetricsChart
                range={metrics.range}
                metric="latency"
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
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wide" style={{ color: '#A6A39D' }}>
                可用率 · 按模型
              </p>
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
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wide" style={{ color: '#A6A39D' }}>
                TTFT · 按模型
              </p>
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
              <p className="mb-2 text-[11px] font-medium uppercase tracking-wide" style={{ color: '#A6A39D' }}>
                TPS · 按模型
              </p>
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
        ) : null}
      </div>

      <div className="rounded-xl p-5" style={cardStyle()}>
        <h2 className="mb-3 text-sm font-semibold" style={{ color: '#111111' }}>
          模型
        </h2>
        {channel.models.length === 0 ? (
          <p className="text-sm" style={{ color: '#A6A39D' }}>
            暂无挂载模型
          </p>
        ) : (
          <ul>
            {channel.models.map((m) => {
              const mm = statusMeta(m.status, m.expect_mode);
              return (
                <li
                  key={m.id}
                  className="flex items-center gap-3 border-b py-3 last:border-0"
                  style={{ borderColor: '#F1F0ED', opacity: m.monitor_enabled ? 1 : 0.55 }}
                >
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: mm.dot }} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium" style={{ color: '#2F3437' }}>
                      {m.name}
                    </div>
                    <div className="truncate text-[11px]" style={{ color: '#A6A39D', fontFamily: MONO }}>
                      {m.model}
                      {!m.monitor_enabled && ' · 未巡检'}
                    </div>
                  </div>
                  <div className="shrink-0 text-right text-[11px] tabular-nums" style={{ color: '#787774', fontFamily: MONO }}>
                    <div>{m.last_latency_ms == null ? '—' : fmtLatency(m.last_latency_ms)}</div>
                    <div style={{ color: '#A6A39D' }}>{m.uptime_24h == null ? '—' : `${m.uptime_24h.toFixed(0)}%`}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
