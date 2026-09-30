import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { CheckRecord } from '../types';
import { fmtDateTime, fmtLatency, fmtTime } from '../utils';

export default function LatencyChart({
  checks,
  emptyHint = '近 24 小时暂无探测数据',
}: {
  checks: CheckRecord[];
  emptyHint?: string;
}) {
  const data = checks.map((c) => ({
    t: fmtTime(String(c.ts)),
    full: fmtDateTime(c.ts),
    latency: c.latency_ms,
    ok: Boolean(c.ok),
  }));

  if (data.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center text-sm text-slate-400">
        {emptyHint}
      </div>
    );
  }

  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
          <XAxis
            dataKey="t"
            tick={{ fontSize: 11, fill: '#94a3b8' }}
            tickLine={false}
            axisLine={false}
            minTickGap={48}
          />
          <YAxis
            tick={{ fontSize: 11, fill: '#94a3b8' }}
            tickLine={false}
            axisLine={false}
            width={56}
            tickFormatter={(v: number) => fmtLatency(v)}
          />
          <Tooltip
            contentStyle={{
              borderRadius: 8,
              border: '1px solid #e2e8f0',
              fontSize: 12,
              boxShadow: '0 4px 12px rgba(15,23,42,0.08)',
            }}
            labelFormatter={(_, payload) => {
              const item = payload?.[0]?.payload as { full?: string } | undefined;
              return item?.full ?? '';
            }}
            formatter={(value: number | string) => [fmtLatency(Number(value)), '延迟']}
          />
          <Line
            type="monotone"
            dataKey="latency"
            stroke="#10b981"
            strokeWidth={2}
            dot={false}
            connectNulls
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
