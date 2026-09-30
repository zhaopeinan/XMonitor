import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import type { ScreenBucketStatus, ScreenData, ScreenLlmChannel, ScreenRateKind, ScreenSystem } from '../types';
import { errMsg, fmtLatency, fmtMonitorEndpoint, fmtRelative, normStatus, rateKindHint, rateKindLabel, statusLabel } from '../utils';
import { subscribeConnection, subscribeWs } from '../ws';
import { ScreenChannelFocus, ScreenSystemFocus } from './ScreenFocus';

// ---- 设计基调：暖白画布 + 炭黑文字 + 低饱和状态色（仅用于语义） ----
const DISPLAY = `'SF Pro Display', 'Geist Sans', 'Helvetica Neue', 'PingFang SC', 'HarmonyOS Sans SC', 'Microsoft YaHei', sans-serif`;
const MONO = `'Geist Mono', 'SF Mono', 'JetBrains Mono', ui-monospace, 'PingFang SC', monospace`;

const STATUS_META: Record<string, { label: string; fg: string; bg: string; dot: string }> = {
  up: { label: '正常', fg: '#346538', bg: '#EDF3EC', dot: '#5F9E67' },
  slow: { label: '缓慢', fg: '#956400', bg: '#FBF3DB', dot: '#D9A62E' },
  down: { label: '故障', fg: '#9F2F2D', bg: '#FDEBEC', dot: '#D05A57' },
  unknown: { label: '未知', fg: '#787774', bg: '#F0EFEC', dot: '#C4C2BD' },
};

const BUCKET_COLOR: Record<ScreenBucketStatus, string> = {
  up: '#8FCB9B',
  slow: '#F2C94C',
  down: '#E25B57',
  none: '#ECEAE5',
};

function bucketLabels(kind?: ScreenRateKind | null): Record<ScreenBucketStatus, string> {
  if (kind === 'block') {
    return { up: '已阻断', slow: '部分可达', down: '仍可访问', none: '无数据' };
  }
  if (kind === 'compliance') {
    return { up: '符合预期', slow: '部分异常', down: '未达预期', none: '无数据' };
  }
  return { up: '正常', slow: '缓慢/部分失败', down: '故障', none: '无数据' };
}

function statusMeta(s: string | null | undefined, expectMode?: string | null) {
  const st = normStatus(s);
  const base = STATUS_META[st] ?? STATUS_META.unknown;
  if (expectMode === 'down' || expectMode === 'system-reverse') {
    return { ...base, label: statusLabel(st, 'down') };
  }
  return base;
}

function useClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

// ---- 入场动画 ----
function Reveal({ index = 0, children, className = '' }: { index?: number; children: React.ReactNode; className?: string }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setOn(true), 40 + index * 80);
    return () => clearTimeout(t);
  }, [index]);
  return (
    <div
      className={className}
      style={{
        opacity: on ? 1 : 0,
        transform: on ? 'translateY(0)' : 'translateY(12px)',
        transition: 'opacity 600ms cubic-bezier(0.16,1,0.3,1), transform 600ms cubic-bezier(0.16,1,0.3,1)',
      }}
    >
      {children}
    </div>
  );
}

// ---- 顶部时钟 ----
function ClockBlock() {
  const now = useClock();
  const pad = (n: number) => String(n).padStart(2, '0');
  const week = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()];
  return (
    <div className="text-right">
      <div className="tabular-nums" style={{ fontFamily: MONO, fontSize: 28, lineHeight: 1.1, color: '#2F3437', letterSpacing: '0.02em' }}>
        {pad(now.getHours())}:{pad(now.getMinutes())}
        <span style={{ color: '#B9B6B0' }}>:{pad(now.getSeconds())}</span>
      </div>
      <div className="mt-0.5 text-xs" style={{ color: '#787774', fontFamily: MONO }}>
        {now.getFullYear()}-{pad(now.getMonth() + 1)}-{pad(now.getDate())} · 星期{week}
      </div>
    </div>
  );
}

// ---- KPI 卡片 ----
function Kpi({ index, label, value, sub, accent }: { index: number; label: string; value: string; sub?: string; accent?: string }) {
  return (
    <Reveal index={index}>
      <div className="h-full rounded-xl bg-white p-5" style={{ border: '1px solid #EAEAEA' }}>
        <div className="text-[11px] font-medium uppercase" style={{ color: '#787774', letterSpacing: '0.08em' }}>
          {label}
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="tabular-nums" style={{ fontFamily: MONO, fontSize: 30, lineHeight: 1, color: accent ?? '#2F3437' }}>
            {value}
          </span>
          {sub && (
            <span className="text-xs" style={{ color: '#A6A39D' }}>
              {sub}
            </span>
          )}
        </div>
      </div>
    </Reveal>
  );
}

// ---- 响应趋势图（12h / 30min 粒度，纯 SVG；业务 + 模型双线） ----
function TrendChart({ data }: { data: ScreenData['trend'] }) {
  const W = 560;
  const H = 140;
  const PAD = { l: 34, r: 8, t: 10, b: 20 };
  const bizVals = data.map((p) => p.avg_latency_ms);
  const llmVals = data.map((p) => p.llm_avg_latency_ms ?? null);
  const max = Math.max(100, ...bizVals.map((v) => v ?? 0), ...llmVals.map((v) => v ?? 0));
  const x = (i: number) => PAD.l + (i / Math.max(1, data.length - 1)) * (W - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / max) * (H - PAD.t - PAD.b);

  const buildLine = (vals: (number | null)[]) => {
    const pts = vals.map((v, i) => (v === null ? null : ([x(i), y(v)] as const)));
    let d = '';
    let open = false;
    pts.forEach((pt) => {
      if (!pt) {
        open = false;
        return;
      }
      d += open ? ` L ${pt[0].toFixed(1)} ${pt[1].toFixed(1)}` : `M ${pt[0].toFixed(1)} ${pt[1].toFixed(1)}`;
      open = true;
    });
    return d;
  };

  const linePath = useMemo(() => buildLine(bizVals), [data, max]);
  const llmLinePath = useMemo(() => buildLine(llmVals), [data, max]);

  const gridVals = [0, max / 2, max];
  const hourLabel = (ts: number) => {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {gridVals.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke="#EFEEEA" strokeWidth="1" />
            <text x={PAD.l - 6} y={y(v) + 3} textAnchor="end" fontSize="9" fill="#B9B6B0" fontFamily={MONO}>
              {v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}`}
            </text>
          </g>
        ))}
        {linePath && <path d={linePath} fill="none" stroke="#1F6C9F" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />}
        {llmLinePath && (
          <path
            d={llmLinePath}
            fill="none"
            stroke="#5B6E5C"
            strokeWidth="1.6"
            strokeDasharray="4 3"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {data.map((p, i) =>
          p.failed > 0 || (p.llm_failed ?? 0) > 0 ? (
            <circle key={i} cx={x(i)} cy={H - PAD.b} r="2.4" fill="#D05A57" />
          ) : null,
        )}
        {data.length > 0 && (
          <>
            <text x={PAD.l} y={H - 6} fontSize="9" fill="#B9B6B0" fontFamily={MONO}>
              {hourLabel(data[0].ts)}
            </text>
            <text x={W - PAD.r} y={H - 6} textAnchor="end" fontSize="9" fill="#B9B6B0" fontFamily={MONO}>
              {hourLabel(data[data.length - 1].ts + 1800000)}
            </text>
          </>
        )}
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-4 text-[10px]" style={{ color: '#A6A39D' }}>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-4" style={{ background: '#1F6C9F' }} />
          业务均延迟
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-[2px] w-4" style={{ background: '#5B6E5C', borderTop: '1px dashed transparent' }} />
          模型均延迟
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: '#D05A57' }} />
          该时段存在未达预期
        </span>
      </div>
    </div>
  );
}

// ---- 24 小时状态条 ----
function HeatStrip({
  timeline,
  generatedAt,
  rateKind,
}: {
  timeline: ScreenBucketStatus[];
  generatedAt: number;
  rateKind?: ScreenRateKind | null;
}) {
  const labels = bucketLabels(rateKind);
  const hourLabel = (i: number) => {
    const start = new Date(generatedAt - 24 * 3600000 + i * 3600000);
    return `${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')} ${String(start.getHours()).padStart(2, '0')}:00`;
  };
  return (
    <div>
      <div className="flex items-center gap-[3px]">
        {timeline.map((b, i) => (
          <span
            key={i}
            title={`${hourLabel(i)} 时段 · ${labels[b] ?? labels.none}`}
            className="h-3.5 flex-1 rounded-[2px] transition-transform hover:scale-y-125"
            style={{ background: BUCKET_COLOR[b] ?? BUCKET_COLOR.none }}
          />
        ))}
      </div>
      <div className="mt-2 flex items-center gap-3 text-[10px]" style={{ color: '#A6A39D' }}>
        {(Object.keys(labels) as ScreenBucketStatus[]).map((k) => (
          <span key={k} className="flex items-center gap-1">
            <span className="inline-block h-2 w-2 rounded-[2px]" style={{ background: BUCKET_COLOR[k] }} />
            {labels[k]}
          </span>
        ))}
        <span className="ml-auto" style={{ fontFamily: MONO }}>
          ← 24h 前 · 现在 →
        </span>
      </div>
    </div>
  );
}

// ---- 系统卡片 ----
function SystemPanel({ system, index, generatedAt }: { system: ScreenSystem; index: number; generatedAt: number }) {
  const rateKind = system.rate_kind ?? (system.reverse_all ? 'block' : (system.reverse_count ?? 0) > 0 ? 'compliance' : 'uptime');
  const meta = statusMeta(system.overall_status, system.reverse_all ? 'down' : undefined);
  return (
    <Reveal index={index}>
      <Link
        to={`/screen/systems/${system.id}`}
        className="block rounded-xl bg-white p-5 transition-shadow duration-200 hover:shadow-[0_2px_8px_rgba(0,0,0,0.06)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
        style={{ border: '1px solid #EAEAEA' }}
        title={`查看 ${system.name}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h3 className="truncate text-[15px] font-semibold tracking-tight" style={{ color: '#2F3437' }}>
                {system.name}
              </h3>
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-medium uppercase"
                style={{ background: meta.bg, color: meta.fg, letterSpacing: '0.06em' }}
              >
                {meta.label}
              </span>
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{ background: '#F0EFEC', color: '#787774', letterSpacing: '0.04em' }}
              >
                业务
              </span>
              {(system.reverse_count ?? 0) > 0 && (
                <span
                  className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                  style={{ background: '#FFF4E5', color: '#9A6700', letterSpacing: '0.04em' }}
                >
                  反向 {system.reverse_count}/{system.monitor_count}
                </span>
              )}
            </div>
            <p className="mt-1 truncate text-[11px]" style={{ color: '#A6A39D', fontFamily: MONO }} title={system.base_url}>
              {system.base_url}
            </p>
          </div>
          <div className="shrink-0 text-right" title={rateKindHint(rateKind)}>
            <div className="tabular-nums" style={{ fontFamily: MONO, fontSize: 20, color: '#2F3437', lineHeight: 1.1 }}>
              {system.uptime_24h === null ? '—' : `${system.uptime_24h.toFixed(1)}%`}
            </div>
            <div className="text-[10px]" style={{ color: rateKind === 'uptime' ? '#A6A39D' : '#9A6700' }}>
              {rateKindLabel(rateKind)}
            </div>
          </div>
        </div>

        <div className="mt-4">
          <HeatStrip timeline={system.timeline} generatedAt={generatedAt} rateKind={rateKind} />
        </div>

        <div className="mt-4 flex items-center justify-between" style={{ borderTop: '1px solid #F1F0ED', paddingTop: 12 }}>
          <div className="flex flex-wrap items-center gap-1.5">
            {system.monitors.length === 0 ? (
              <span className="text-[11px]" style={{ color: '#C4C2BD' }}>
                暂无监控项
              </span>
            ) : (
              system.monitors.map((m) => {
                const mm = statusMeta(m.status, m.expect_mode);
                return (
                  <span
                    key={m.id}
                    title={`${m.name} · ${mm.label}${m.expect_mode === 'down' ? '（反向）' : ''}${m.url ? ` · ${fmtMonitorEndpoint(m.url, m.method, m.type)}` : ''}${m.last_latency_ms !== null ? ` · ${fmtLatency(m.last_latency_ms)}` : ''}`}
                    className="h-2 w-2 rounded-full"
                    style={{ background: mm.dot }}
                  />
                );
              })
            )}
          </div>
          <div className="flex items-center gap-4 text-[11px] tabular-nums" style={{ color: '#787774', fontFamily: MONO }}>
            <span>{system.monitor_count} 项</span>
            <span>均 {system.avg_latency_ms === null ? '—' : fmtLatency(system.avg_latency_ms)}</span>
            <span style={{ color: '#A6A39D' }}>查看 →</span>
          </div>
        </div>
      </Link>
    </Reveal>
  );
}

// ---- 大模型渠道卡片（渠道 → 多模型明细） ----
function ChannelPanel({ channel, index, generatedAt }: { channel: ScreenLlmChannel; index: number; generatedAt: number }) {
  const meta = statusMeta(channel.enabled ? channel.overall_status : 'unknown');
  const rateKind = channel.rate_kind ?? 'uptime';
  return (
    <Reveal index={index}>
      <Link
        to={`/screen/llm/${channel.id}`}
        className="block rounded-xl bg-white p-5 transition-shadow duration-200 hover:shadow-[0_2px_8px_rgba(0,0,0,0.06)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400"
        style={{ border: '1px solid #EAEAEA' }}
        title={`查看渠道 ${channel.name}`}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h3 className="truncate text-[15px] font-semibold tracking-tight" style={{ color: '#2F3437' }}>
                {channel.name}
              </h3>
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-medium uppercase"
                style={{ background: meta.bg, color: meta.fg, letterSpacing: '0.06em' }}
              >
                {!channel.enabled ? '已停用' : meta.label}
              </span>
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                style={{ background: '#E8EEE9', color: '#3D5240', letterSpacing: '0.04em' }}
              >
                模型渠道
              </span>
            </div>
            <p className="mt-1 truncate text-[11px]" style={{ color: '#A6A39D', fontFamily: MONO }} title={channel.base_url}>
              {channel.base_url}
            </p>
          </div>
          <div className="shrink-0 text-right">
            <div className="tabular-nums" style={{ fontFamily: MONO, fontSize: 20, color: '#2F3437', lineHeight: 1.1 }}>
              {channel.uptime_24h === null ? '—' : `${channel.uptime_24h.toFixed(1)}%`}
            </div>
            <div className="text-[10px]" style={{ color: '#A6A39D' }}>
              {rateKindLabel(rateKind)}
            </div>
          </div>
        </div>

        <div className="mt-4">
          <HeatStrip timeline={channel.timeline} generatedAt={generatedAt} rateKind={rateKind} />
        </div>

        <div className="mt-4" style={{ borderTop: '1px solid #F1F0ED', paddingTop: 10 }}>
          {channel.models.length === 0 ? (
            <span className="text-[11px]" style={{ color: '#C4C2BD' }}>
              暂无挂载模型
            </span>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {channel.models.map((m) => {
                const mm = statusMeta(m.status, m.expect_mode);
                return (
                  <li
                    key={m.id}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5"
                    style={{ background: m.monitor_enabled ? '#FAFAF8' : 'transparent', opacity: m.monitor_enabled ? 1 : 0.55 }}
                  >
                    <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: mm.dot }} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12px] font-medium" style={{ color: '#2F3437' }}>
                        {m.name}
                      </div>
                      <div className="truncate text-[10px]" style={{ color: '#A6A39D', fontFamily: MONO }}>
                        {m.model}
                        {!m.monitor_enabled && ' · 未巡检'}
                      </div>
                    </div>
                    <div className="shrink-0 text-right text-[10px] tabular-nums" style={{ color: '#787774', fontFamily: MONO }}>
                      <div>{m.last_latency_ms == null ? '—' : fmtLatency(m.last_latency_ms)}</div>
                      <div style={{ color: '#A6A39D' }}>{m.uptime_24h == null ? '—' : `${m.uptime_24h.toFixed(0)}%`}</div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="mt-3 flex items-center justify-between text-[11px] tabular-nums" style={{ color: '#787774', fontFamily: MONO }}>
          <span>
            {channel.monitored_count}/{channel.model_count} 巡检中
          </span>
          <span>
            均 {channel.avg_latency_ms === null ? '—' : fmtLatency(channel.avg_latency_ms)}
            <span className="ml-3" style={{ color: '#A6A39D' }}>
              查看 →
            </span>
          </span>
        </div>
      </Link>
    </Reveal>
  );
}

// ---- 告警条目 ----
function AlertRowItem({ alert }: { alert: ScreenData['alerts'][number] }) {
  const kind = alert.kind === 'down' || alert.kind === 'reachable' ? STATUS_META.down : alert.kind === 'slow' ? STATUS_META.slow : STATUS_META.up;
  const isLlm = alert.domain === 'llm';
  return (
    <div className="flex items-start gap-3 py-2.5" style={{ borderBottom: '1px solid #F1F0ED' }}>
      <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: kind.dot }} />
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 flex items-center gap-1.5">
          <span
            className="rounded px-1 py-px text-[9px] font-medium uppercase"
            style={{
              background: isLlm ? '#E8EEE9' : '#F0EFEC',
              color: isLlm ? '#3D5240' : '#787774',
              letterSpacing: '0.04em',
            }}
          >
            {isLlm ? '模型' : '业务'}
          </span>
        </div>
        <p className="truncate text-xs" style={{ color: '#2F3437' }} title={alert.message ?? ''}>
          {alert.message ?? alert.kind}
        </p>
        <p className="mt-0.5 truncate text-[10px]" style={{ color: '#A6A39D', fontFamily: MONO }}>
          {alert.system_name} · {alert.monitor_name}
        </p>
      </div>
      <span className="shrink-0 text-[10px] tabular-nums" style={{ color: '#A6A39D', fontFamily: MONO }}>
        {fmtRelative(String(alert.ts))}
      </span>
    </div>
  );
}

export default function Screen() {
  const { systemId: systemIdParam, channelId: channelIdParam } = useParams<{
    systemId?: string;
    channelId?: string;
  }>();
  const focusSystemId = systemIdParam ? Number(systemIdParam) : null;
  const focusChannelId = channelIdParam ? Number(channelIdParam) : null;
  const focusMode = focusSystemId ? 'system' : focusChannelId ? 'llm' : 'overview';

  const [data, setData] = useState<ScreenData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wsOk, setWsOk] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await api.screen());
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(
    () =>
      subscribeWs((msg) => {
        if (msg.type === 'alert' || msg.type === 'snapshot' || msg.type === 'check') void load();
      }),
    [load],
  );
  useEffect(() => subscribeConnection(setWsOk), []);

  const totals = data?.totals;
  const bizDown = totals?.down ?? 0;
  const bizSlow = totals?.slow ?? 0;
  const llmDown = totals?.llm_down ?? 0;
  const llmSlow = totals?.llm_slow ?? 0;
  const totalTargets = (totals?.monitors ?? 0) + (totals?.llm_models ?? 0);
  const totalDown = bizDown + llmDown;
  const totalSlow = bizSlow + llmSlow;
  const allHealthy = totals !== undefined && totalDown === 0 && totalSlow === 0 && totalTargets > 0;
  const headline = !totals
    ? '正在载入'
    : totalTargets === 0
      ? '等待监控项接入'
      : allHealthy
        ? '业务与模型运行正常'
        : totalDown > 0
          ? `${totalDown} 项故障${llmDown > 0 && bizDown > 0 ? '（含业务与模型）' : llmDown > 0 ? '（模型）' : '（业务）'}`
          : `${totalSlow} 项响应缓慢`;

  const overallRate = totals?.overall_uptime_24h ?? totals?.uptime_24h;

  const focusSystem = focusSystemId && data ? data.systems.find((s) => s.id === focusSystemId) : null;
  const focusChannel =
    focusChannelId && data ? data.llm_channels?.find((c) => c.id === focusChannelId) ?? null : null;
  const generatedAt = data?.generated_at ?? Date.now();

  return (
    <div className="min-h-screen" style={{ background: '#F7F6F3', color: '#2F3437' }}>
      {/* 顶部栏 */}
      <header className="flex items-center justify-between px-8 py-5" style={{ borderBottom: '1px solid #EAEAEA', background: '#FFFFFF' }}>
        <div className="flex items-center gap-3">
          <Link
            to="/screen"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-[11px] font-bold text-white"
            style={{ background: '#111111' }}
            title="返回大屏总览"
          >
            XM
          </Link>
          <div>
            <div className="text-sm font-semibold tracking-tight" style={{ color: '#111111' }}>
              {focusMode === 'overview'
                ? 'XMonitor · 全局监控大屏'
                : focusMode === 'system'
                  ? focusSystem?.name ?? '业务系统'
                  : focusChannel?.name ?? '模型渠道'}
            </div>
            <div className="text-[10px] uppercase" style={{ color: '#A6A39D', letterSpacing: '0.1em', fontFamily: MONO }}>
              {focusMode === 'overview'
                ? 'Real-time Service Observatory'
                : focusMode === 'system'
                  ? 'system · live'
                  : 'channel · live'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <span className="flex items-center gap-1.5 text-[11px]" style={{ color: '#787774' }}>
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: wsOk ? '#5F9E67' : '#C4C2BD' }} />
            {wsOk ? '实时推送' : '15s 轮询'}
          </span>
          <ClockBlock />
          {focusMode !== 'overview' && (
            <Link
              to="/screen"
              className="rounded-md px-3 py-1.5 text-xs font-medium transition-colors"
              style={{ border: '1px solid #EAEAEA', color: '#2F3437' }}
            >
              总览
            </Link>
          )}
          <Link
            to="/"
            className="rounded-md px-3 py-1.5 text-xs font-medium text-white transition-colors"
            style={{ background: '#111111' }}
            title="返回工作台"
          >
            工作台
          </Link>
        </div>
      </header>

      {error && (
        <div className="mx-auto mt-6 max-w-[1440px] px-8">
          <div className="rounded-xl px-5 py-4 text-sm" style={{ border: '1px solid #F0D3D2', background: '#FDEBEC', color: '#9F2F2D' }}>
            {error}
          </div>
        </div>
      )}

      {focusMode === 'system' && focusSystem && (
        <ScreenSystemFocus
          system={focusSystem}
          generatedAt={generatedAt}
          heatStrip={
            <HeatStrip
              timeline={focusSystem.timeline}
              generatedAt={generatedAt}
              rateKind={focusSystem.rate_kind ?? (focusSystem.reverse_all ? 'block' : (focusSystem.reverse_count ?? 0) > 0 ? 'compliance' : 'uptime')}
            />
          }
        />
      )}

      {focusMode === 'llm' && focusChannel && (
        <ScreenChannelFocus
          channel={focusChannel}
          generatedAt={generatedAt}
          heatStrip={
            <HeatStrip
              timeline={focusChannel.timeline}
              generatedAt={generatedAt}
              rateKind={focusChannel.rate_kind ?? 'uptime'}
            />
          }
        />
      )}

      {focusMode !== 'overview' && data && !focusSystem && !focusChannel && (
        <div className="mx-auto max-w-[1100px] px-8 py-16 text-center">
          <p className="text-sm" style={{ color: '#787774' }}>
            未找到该对象，可能已被删除。
          </p>
          <Link to="/screen" className="mt-4 inline-block text-sm font-medium" style={{ color: '#111111' }}>
            ← 返回总览
          </Link>
        </div>
      )}

      {focusMode === 'overview' && (
      <main className="mx-auto max-w-[1440px] px-8 pb-10">

        {/* 主标题区 */}
        <Reveal index={0}>
          <div className="flex flex-wrap items-end justify-between gap-6 py-10">
            <div>
              <div className="mb-3 flex items-center gap-2">
                <span
                  className="inline-block h-1.5 w-1.5 rounded-full"
                  style={{
                    background: !totals ? '#C4C2BD' : totalDown > 0 ? '#D05A57' : totalSlow > 0 ? '#D9A62E' : '#5F9E67',
                    boxShadow: `0 0 0 3px ${!totals ? '#F0EFEC' : totalDown > 0 ? '#FDEBEC' : totalSlow > 0 ? '#FBF3DB' : '#EDF3EC'}`,
                    animation: 'xm-pulse 2s ease-in-out infinite',
                  }}
                />
                <span className="text-[10px] font-medium uppercase" style={{ color: '#A6A39D', letterSpacing: '0.14em', fontFamily: MONO }}>
                  Business · LLM · Live
                </span>
              </div>
              <h1
                style={{
                  fontFamily: DISPLAY,
                  fontSize: 46,
                  fontWeight: 700,
                  lineHeight: 1.05,
                  letterSpacing: '-0.035em',
                  color: allHealthy ? '#111111' : totalDown ? '#9F2F2D' : '#956400',
                }}
              >
                {headline}
              </h1>
            </div>
            <p className="max-w-md pb-2 text-sm leading-relaxed" style={{ color: '#787774' }}>
              覆盖 {totals?.systems ?? 0} 个业务系统、{totals?.llm_channels ?? 0} 个模型渠道（
              {totals?.llm_models ?? 0} 个模型），24 小时内累计巡检{' '}
              <span className="tabular-nums" style={{ fontFamily: MONO, color: '#2F3437' }}>
                {(totals?.checks_24h ?? 0) + (totals?.llm_checks_24h ?? 0)}
              </span>{' '}
              次。
            </p>
          </div>
        </Reveal>

        {/* KPI 行：总览 + 业务/模型拆分 */}
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          <Kpi
            index={1}
            label="综合符合率"
            value={overallRate == null ? '—' : `${overallRate.toFixed(2)}%`}
            sub="业务 + 模型加权"
            accent="#346538"
          />
          <Kpi
            index={2}
            label="业务可用"
            value={totals?.uptime_24h == null ? '—' : `${totals.uptime_24h.toFixed(1)}%`}
            sub={`${totals?.up ?? 0}/${totals?.monitors ?? 0} 正常`}
            accent="#1F6C9F"
          />
          <Kpi
            index={3}
            label="模型可用"
            value={totals?.llm_uptime_24h == null ? '—' : `${totals.llm_uptime_24h.toFixed(1)}%`}
            sub={`${totals?.llm_up ?? 0}/${totals?.llm_models ?? 0} 正常`}
            accent="#3D5240"
          />
          <Kpi
            index={4}
            label="业务均延迟"
            value={totals?.avg_latency_ms == null ? '—' : fmtLatency(totals.avg_latency_ms)}
            sub="24h 可达"
            accent="#1F6C9F"
          />
          <Kpi
            index={5}
            label="模型均延迟"
            value={totals?.llm_avg_latency_ms == null ? '—' : fmtLatency(totals.llm_avg_latency_ms)}
            sub="24h 成功调用"
            accent="#3D5240"
          />
          <Kpi
            index={6}
            label="未确认告警"
            value={String(totals?.unacked_alerts ?? 0)}
            sub={`故障 ${totalDown} · 缓慢 ${totalSlow}`}
            accent={totals?.unacked_alerts ? '#9F2F2D' : undefined}
          />
        </div>

        {/* 主体：业务系统 + 大模型渠道并排，右栏趋势/告警 */}
        <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-3">
          <div className="flex flex-col gap-8 xl:col-span-2">
            <section>
              <Reveal index={3}>
                <div className="mb-3 flex items-baseline justify-between">
                  <h2 className="text-sm font-semibold tracking-tight" style={{ color: '#111111' }}>
                    业务系统
                  </h2>
                  <span className="text-[10px] uppercase" style={{ color: '#A6A39D', letterSpacing: '0.08em', fontFamily: MONO }}>
                    systems · pages & apis
                  </span>
                </div>
              </Reveal>
              {data && data.systems.length === 0 ? (
                <Reveal index={4}>
                  <div className="rounded-xl bg-white p-10 text-center text-sm" style={{ border: '1px solid #EAEAEA', color: '#787774' }}>
                    还没有接入任何系统。回到工作台，输入系统主页 URL，AI 会自动分析出关键页面与接口。
                  </div>
                </Reveal>
              ) : (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  {data?.systems.map((s, i) => (
                    <SystemPanel key={s.id} system={s} index={4 + i} generatedAt={data?.generated_at ?? Date.now()} />
                  ))}
                </div>
              )}
            </section>

            <section>
              <Reveal index={5}>
                <div className="mb-3 flex items-baseline justify-between">
                  <h2 className="text-sm font-semibold tracking-tight" style={{ color: '#111111' }}>
                    大模型服务
                  </h2>
                  <span className="text-[10px] uppercase" style={{ color: '#A6A39D', letterSpacing: '0.08em', fontFamily: MONO }}>
                    channels · models
                  </span>
                </div>
              </Reveal>
              {data && (data.llm_channels?.length ?? 0) === 0 ? (
                <Reveal index={6}>
                  <div className="rounded-xl bg-white p-10 text-center text-sm" style={{ border: '1px solid #EAEAEA', color: '#787774' }}>
                    尚未配置模型渠道。在设置页添加渠道并挂载模型后，此处将按「渠道 → 模型」展示健康状态。
                  </div>
                </Reveal>
              ) : (
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  {data?.llm_channels?.map((ch, i) => (
                    <ChannelPanel key={ch.id} channel={ch} index={6 + i} generatedAt={data?.generated_at ?? Date.now()} />
                  ))}
                </div>
              )}
            </section>
          </div>

          <div className="flex flex-col gap-6">
            <Reveal index={4}>
              <div className="rounded-xl bg-white p-5" style={{ border: '1px solid #EAEAEA' }}>
                <div className="mb-3 flex items-baseline justify-between">
                  <h2 className="text-sm font-semibold tracking-tight" style={{ color: '#111111' }}>
                    响应趋势
                  </h2>
                  <span className="text-[10px]" style={{ color: '#A6A39D', letterSpacing: '0.02em' }}>
                    近 12 小时 · 每 30 分钟一点
                  </span>
                </div>
                {data ? (
                  <TrendChart data={data.trend} />
                ) : (
                  <div className="h-[140px] animate-pulse rounded-lg" style={{ background: '#F1F0ED' }} />
                )}
              </div>
            </Reveal>

            <Reveal index={5}>
              <div className="rounded-xl bg-white p-5" style={{ border: '1px solid #EAEAEA' }}>
                <div className="mb-2 flex items-baseline justify-between">
                  <h2 className="text-sm font-semibold tracking-tight" style={{ color: '#111111' }}>
                    最新告警
                  </h2>
                  <span className="text-[10px] uppercase" style={{ color: '#A6A39D', letterSpacing: '0.08em', fontFamily: MONO }}>
                    business · llm
                  </span>
                </div>
                {!data ? (
                  <div className="space-y-2">
                    {[0, 1, 2].map((i) => (
                      <div key={i} className="h-8 animate-pulse rounded" style={{ background: '#F1F0ED' }} />
                    ))}
                  </div>
                ) : data.alerts.length === 0 ? (
                  <p className="py-6 text-center text-xs" style={{ color: '#A6A39D' }}>
                    暂无告警记录
                  </p>
                ) : (
                  <div>
                    {data.alerts.map((a) => (
                      <AlertRowItem key={`${a.domain ?? 'system'}-${a.id}`} alert={a} />
                    ))}
                  </div>
                )}
              </div>
            </Reveal>
          </div>
        </div>

        <footer className="mt-10 flex items-center justify-between text-[10px] uppercase" style={{ color: '#C4C2BD', letterSpacing: '0.08em', fontFamily: MONO }}>
          <span>XMonitor · 业务系统与大模型 API</span>
          <span className="tabular-nums">
            {data ? `数据生成于 ${new Date(data.generated_at).toLocaleTimeString('zh-CN', { hour12: false })}` : ''}
          </span>
        </footer>
      </main>
      )}
    </div>
  );
}
