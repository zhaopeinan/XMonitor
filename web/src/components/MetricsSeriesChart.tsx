import { useMemo, useState } from 'react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { SystemMetricsPoint } from '../types';
import { fmtDateTime, fmtLatency } from '../utils';

/** 最多约 10 条曲线仍可读；超出靠 legend 点击隐藏 */
const SERIES_COLORS = [
  '#0f766e',
  '#2563eb',
  '#c2410c',
  '#7c3aed',
  '#be185d',
  '#0369a1',
  '#a16207',
  '#15803d',
  '#4338ca',
  '#9f1239',
];

const OVERALL_KEY = '__overall__';
const OVERALL_COLOR = '#94a3b8';

function axisLabel(ts: number, range: string): string {
  const d = new Date(ts);
  if (range === '24h') {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  if (range === '7d') {
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function LatencySeriesChart({
  series,
  range,
}: {
  series: SystemMetricsPoint[];
  range: string;
}) {
  return (
    <MultiSeriesMetricsChart
      range={range}
      metric="latency"
      lines={[{ key: 'latency', name: '平均延迟', color: '#0f766e', points: series }]}
    />
  );
}

export function UptimeSeriesChart({
  series,
  range,
}: {
  series: SystemMetricsPoint[];
  range: string;
}) {
  return (
    <MultiSeriesMetricsChart
      range={range}
      metric="uptime"
      lines={[{ key: 'uptime', name: '可用率', color: '#059669', points: series }]}
    />
  );
}

export interface MetricsLine {
  key: string;
  name: string;
  color?: string;
  points: SystemMetricsPoint[];
}

/** 多模型/多监控项：同图多曲线 + Legend（点击可隐藏） */
export function MultiSeriesMetricsChart({
  range,
  metric,
  lines,
  overall,
  emptyText,
}: {
  range: string;
  metric: 'latency' | 'uptime' | 'ttft' | 'tps';
  lines: MetricsLine[];
  /** 可选：渠道/系统整体，虚线灰色 */
  overall?: SystemMetricsPoint[];
  emptyText?: string;
}) {
  const colored = useMemo(
    () =>
      lines.map((l, i) => ({
        ...l,
        color: l.color || SERIES_COLORS[i % SERIES_COLORS.length]!,
      })),
    [lines],
  );

  const allKeys = useMemo(() => {
    const keys = colored.map((l) => l.key);
    if (overall && overall.length > 0) keys.push(OVERALL_KEY);
    return keys;
  }, [colored, overall]);

  const [hidden, setHidden] = useState<Set<string>>(() => new Set());

  const data = useMemo(() => {
    const byTs = new Map<number, Record<string, string | number | null>>();
    const touch = (ts: number) => {
      let row = byTs.get(ts);
      if (!row) {
        row = { ts, t: axisLabel(ts, range), full: fmtDateTime(ts) };
        byTs.set(ts, row);
      }
      return row;
    };

    const readVal = (p: SystemMetricsPoint): number | null => {
      if (metric === 'latency') return p.avg_latency_ms;
      if (metric === 'uptime') return p.uptime_pct;
      if (metric === 'ttft') return p.avg_ttft_ms ?? null;
      return p.avg_tps ?? null;
    };
    const hasData = (p: SystemMetricsPoint) => {
      const v = readVal(p);
      // TTFT/TPS：不能用 total>0 凑数（旧 ping 探测没有这些字段，否则会画出空坐标系）
      if (metric === 'ttft' || metric === 'tps') return v != null;
      return v != null || p.total > 0;
    };

    for (const line of colored) {
      for (const p of line.points) {
        if (!hasData(p)) continue;
        const row = touch(p.ts);
        row[line.key] = readVal(p);
      }
    }
    if (overall) {
      for (const p of overall) {
        if (!hasData(p)) continue;
        const row = touch(p.ts);
        row[OVERALL_KEY] = readVal(p);
      }
    }

    return [...byTs.values()].sort((a, b) => Number(a.ts) - Number(b.ts));
  }, [colored, overall, metric, range]);

  if (data.length === 0 || colored.length === 0) {
    const emptyDefault =
      metric === 'latency'
        ? '该时间范围内暂无延迟数据'
        : metric === 'uptime'
          ? '该时间范围内暂无可用率数据'
          : metric === 'ttft'
            ? '该时间范围内暂无 TTFT 数据（需 stream 探测）'
            : '该时间范围内暂无 TPS 数据（需 stream 探测）';
    return (
      <div className="flex h-52 items-center justify-center text-sm text-slate-400">
        {emptyText || emptyDefault}
      </div>
    );
  }

  const toggle = (key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      // 至少留一条可见
      if (allKeys.every((k) => next.has(k))) next.delete(key);
      return next;
    });
  };

  return (
    <div className="h-60 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
          <XAxis dataKey="t" tick={{ fontSize: 11, fill: '#94a3b8' }} tickLine={false} axisLine={false} minTickGap={40} />
          <YAxis
            domain={metric === 'uptime' ? [0, 100] : undefined}
            tick={{ fontSize: 11, fill: '#94a3b8' }}
            tickLine={false}
            axisLine={false}
            width={metric === 'uptime' || metric === 'tps' ? 48 : 52}
            tickFormatter={(v: number) => {
              if (metric === 'uptime') return `${v}%`;
              if (metric === 'tps') return `${v}`;
              return fmtLatency(v);
            }}
          />
          <Tooltip
            contentStyle={{
              borderRadius: 8,
              border: '1px solid #e2e8f0',
              fontSize: 12,
              boxShadow: '0 4px 12px rgba(15,23,42,0.08)',
            }}
            labelFormatter={(_, payload) => (payload?.[0]?.payload as { full?: string } | undefined)?.full ?? ''}
            formatter={(value: number | string, name: string) => {
              const n = Number(value);
              if (!Number.isFinite(n)) return ['—', name];
              if (metric === 'uptime') return [`${n.toFixed(1)}%`, name];
              if (metric === 'tps') return [`${n.toFixed(1)} tok/s`, name];
              return [fmtLatency(n), name];
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 11, paddingTop: 4 }}
            onClick={(e) => {
              const key = String((e as { dataKey?: string }).dataKey ?? '');
              if (key) toggle(key);
            }}
            formatter={(value, entry) => {
              const key = String((entry as { dataKey?: string }).dataKey ?? '');
              const dim = hidden.has(key);
              return <span style={{ color: dim ? '#cbd5e1' : '#475569', textDecoration: dim ? 'line-through' : undefined }}>{value}</span>;
            }}
          />
          {overall && overall.length > 0 && (
            <Line
              type="monotone"
              dataKey={OVERALL_KEY}
              name="整体"
              stroke={OVERALL_COLOR}
              strokeWidth={1.5}
              strokeDasharray="4 3"
              dot={data.length <= 12 ? { r: 2.5, strokeWidth: 0, fill: OVERALL_COLOR } : false}
              activeDot={{ r: 4 }}
              connectNulls
              hide={hidden.has(OVERALL_KEY)}
              isAnimationActive={false}
            />
          )}
          {colored.map((line) => (
            <Line
              key={line.key}
              type="monotone"
              dataKey={line.key}
              name={line.name}
              stroke={line.color}
              strokeWidth={2}
              dot={data.length <= 12 ? { r: 3, strokeWidth: 0, fill: line.color } : false}
              activeDot={{ r: 4 }}
              connectNulls
              hide={hidden.has(line.key)}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export { SERIES_COLORS };
