import { db } from './db';
import type { ExpectMode, MonitorRow, MonitorStatus } from './types';
import { fetchParentSeries, vmEnabled } from './vm';

export type MetricsRange = '24h' | '7d' | '30d';

const RANGE_MS: Record<MetricsRange, number> = {
  '24h': 24 * 3600 * 1000,
  '7d': 7 * 24 * 3600 * 1000,
  '30d': 30 * 24 * 3600 * 1000,
};

/** 桶宽：24h→30min，7d→2h，30d→6h */
const STEP_MS: Record<MetricsRange, number> = {
  '24h': 30 * 60 * 1000,
  '7d': 2 * 3600 * 1000,
  '30d': 6 * 3600 * 1000,
};

const VM_STEP: Record<MetricsRange, string> = {
  '24h': '30m',
  '7d': '2h',
  '30d': '6h',
};

const VM_WINDOW: Record<MetricsRange, string> = {
  '24h': '30m',
  '7d': '2h',
  '30d': '6h',
};

export function parseMetricsRange(raw: unknown): MetricsRange {
  if (raw === '7d' || raw === '30d' || raw === '24h') return raw;
  return '24h';
}

export interface SystemMetricsPoint {
  ts: number;
  avg_latency_ms: number | null;
  /** LLM stream：桶内平均 TTFT */
  avg_ttft_ms?: number | null;
  /** LLM stream：桶内平均 TPS */
  avg_tps?: number | null;
  uptime_pct: number | null;
  total: number;
  failed: number;
}

export interface SystemMonitorMetric {
  id: number;
  name: string;
  type: string;
  url: string;
  method: string;
  expect_mode: ExpectMode;
  status: MonitorStatus;
  enabled: number;
  last_check_at: number | null;
  last_latency_ms: number | null;
  total: number;
  ok_count: number;
  uptime_pct: number | null;
  avg_latency_ms: number | null;
}

export interface SystemMetricsPayload {
  system_id: number;
  range: MetricsRange;
  step_ms: number;
  generated_at: number;
  source: 'sqlite' | 'merged';
  summary: {
    monitors: number;
    monitors_enabled: number;
    total: number;
    ok_count: number;
    uptime_pct: number | null;
    avg_latency_ms: number | null;
  };
  series: SystemMetricsPoint[];
  monitors: SystemMonitorMetric[];
}

function expectOf(m: { expect_mode?: string | null }): ExpectMode {
  return m.expect_mode === 'down' ? 'down' : 'up';
}

function emptyBuckets(now: number, range: MetricsRange): SystemMetricsPoint[] {
  const span = RANGE_MS[range];
  const step = STEP_MS[range];
  const start = now - span;
  const n = Math.ceil(span / step);
  return Array.from({ length: n }, (_, i) => ({
    ts: start + i * step,
    avg_latency_ms: null,
    uptime_pct: null,
    total: 0,
    failed: 0,
  }));
}

function buildFromSqlite(systemId: number, range: MetricsRange, now: number): {
  series: SystemMetricsPoint[];
  monitors: SystemMonitorMetric[];
  summary: SystemMetricsPayload['summary'];
} {
  const since = now - RANGE_MS[range];
  const step = STEP_MS[range];
  const series = emptyBuckets(now, range);

  const monitors = db
    .prepare('SELECT * FROM monitors WHERE system_id = ? ORDER BY id')
    .all(systemId) as MonitorRow[];

  const checkRows = db
    .prepare(
      `SELECT c.monitor_id, c.ts, c.ok, c.latency_ms
       FROM checks c
       JOIN monitors m ON m.id = c.monitor_id
       WHERE m.system_id = ? AND c.ts >= ?
       ORDER BY c.ts`,
    )
    .all(systemId, since) as { monitor_id: number; ts: number; ok: number; latency_ms: number | null }[];

  const perMon = new Map<number, { total: number; ok: number; latSum: number; latN: number }>();
  for (const m of monitors) perMon.set(m.id, { total: 0, ok: 0, latSum: 0, latN: 0 });

  let sumTotal = 0;
  let sumOk = 0;
  let latSum = 0;
  let latN = 0;

  for (const c of checkRows) {
    const idx = Math.min(series.length - 1, Math.max(0, Math.floor((c.ts - since) / step)));
    const p = series[idx]!;
    p.total += 1;
    if (!c.ok) p.failed += 1;
    if (c.ok && c.latency_ms != null) {
      // 桶内延迟累加，后面再算均值
      (p as SystemMetricsPoint & { _latSum?: number; _latN?: number })._latSum =
        ((p as SystemMetricsPoint & { _latSum?: number })._latSum ?? 0) + c.latency_ms;
      (p as SystemMetricsPoint & { _latN?: number })._latN =
        ((p as SystemMetricsPoint & { _latN?: number })._latN ?? 0) + 1;
    }

    const st = perMon.get(c.monitor_id);
    if (st) {
      st.total += 1;
      if (c.ok) {
        st.ok += 1;
        if (c.latency_ms != null) {
          st.latSum += c.latency_ms;
          st.latN += 1;
        }
      }
    }
    sumTotal += 1;
    if (c.ok) {
      sumOk += 1;
      if (c.latency_ms != null) {
        latSum += c.latency_ms;
        latN += 1;
      }
    }
  }

  for (const p of series) {
    const ext = p as SystemMetricsPoint & { _latSum?: number; _latN?: number };
    if (ext._latN && ext._latN > 0) {
      p.avg_latency_ms = Math.round((ext._latSum ?? 0) / ext._latN);
    }
    delete ext._latSum;
    delete ext._latN;
    if (p.total > 0) {
      p.uptime_pct = Math.round(((p.total - p.failed) / p.total) * 1000) / 10;
    }
  }

  const monitorMetrics: SystemMonitorMetric[] = monitors.map((m) => {
    const st = perMon.get(m.id)!;
    const mode = expectOf(m);
    let uptime: number | null = null;
    if (st.total > 0) {
      const meet = mode === 'down' ? st.total - st.ok : st.ok;
      uptime = Math.round((meet / st.total) * 1000) / 10;
    }
    return {
      id: m.id,
      name: m.name,
      type: m.type,
      url: m.url,
      method: m.method || 'GET',
      expect_mode: mode,
      status: (m.status || 'unknown') as MonitorStatus,
      enabled: m.enabled,
      last_check_at: m.last_check_at,
      last_latency_ms: m.last_latency_ms,
      total: st.total,
      ok_count: st.ok,
      uptime_pct: uptime,
      avg_latency_ms: st.latN > 0 ? Math.round(st.latSum / st.latN) : null,
    };
  });

  return {
    series,
    monitors: monitorMetrics,
    summary: {
      monitors: monitors.length,
      monitors_enabled: monitors.filter((m) => m.enabled).length,
      total: sumTotal,
      ok_count: sumOk,
      uptime_pct: sumTotal > 0 ? Math.round((sumOk / sumTotal) * 1000) / 10 : null,
      avg_latency_ms: latN > 0 ? Math.round(latSum / latN) : null,
    },
  };
}

/** SQLite 打底，VM 补空槽（长期曲线在 VM 积累后逐渐完整） */
export async function buildSystemMetrics(systemId: number, range: MetricsRange): Promise<SystemMetricsPayload | null> {
  const system = db.prepare('SELECT id FROM systems WHERE id = ?').get(systemId);
  if (!system) return null;

  const now = Date.now();
  const fromSqlite = buildFromSqlite(systemId, range, now);
  let source: SystemMetricsPayload['source'] = 'sqlite';

  if (vmEnabled()) {
    const endSec = Math.floor(now / 1000);
    const startSec = endSec - Math.floor(RANGE_MS[range] / 1000);
    const vmSeries = await fetchParentSeries(
      'monitor',
      systemId,
      startSec,
      endSec,
      VM_STEP[range],
      VM_WINDOW[range],
    );
    if (vmSeries && vmSeries.length > 0) {
      source = 'merged';
      const step = STEP_MS[range];
      const since = now - RANGE_MS[range];
      for (const v of vmSeries) {
        const idx = Math.min(
          fromSqlite.series.length - 1,
          Math.max(0, Math.floor((v.ts - since) / step)),
        );
        const p = fromSqlite.series[idx]!;
        if (p.total === 0) {
          if (v.avg_latency_ms != null) p.avg_latency_ms = v.avg_latency_ms;
          if (v.ok_rate != null) {
            p.uptime_pct = Math.round(v.ok_rate * 1000) / 10;
            p.total = 100;
            p.failed = Math.round((1 - v.ok_rate) * 100);
          }
        } else if (p.avg_latency_ms == null && v.avg_latency_ms != null) {
          p.avg_latency_ms = v.avg_latency_ms;
        }
      }
    }
  }

  return {
    system_id: systemId,
    range,
    step_ms: STEP_MS[range],
    generated_at: now,
    source,
    summary: fromSqlite.summary,
    series: fromSqlite.series,
    monitors: fromSqlite.monitors,
  };
}

export interface ChannelModelMetric {
  id: number;
  name: string;
  model: string;
  probe_mode: string;
  expect_mode: ExpectMode;
  status: MonitorStatus;
  monitor_enabled: number;
  last_check_at: number | null;
  last_latency_ms: number | null;
  last_ttft_ms: number | null;
  last_tps: number | null;
  total: number;
  ok_count: number;
  uptime_pct: number | null;
  avg_latency_ms: number | null;
  avg_ttft_ms: number | null;
  avg_tps: number | null;
  avg_completion_tokens: number | null;
  last_completion_tokens: number | null;
  /** 该模型在区间内的分桶序列（与顶层 series 同轴） */
  series: SystemMetricsPoint[];
}

export interface ChannelMetricsPayload {
  channel_id: number;
  range: MetricsRange;
  step_ms: number;
  generated_at: number;
  source: 'sqlite' | 'merged';
  summary: {
    models: number;
    models_monitored: number;
    total: number;
    ok_count: number;
    uptime_pct: number | null;
    avg_latency_ms: number | null;
  };
  /** 渠道整体（全模型加权） */
  series: SystemMetricsPoint[];
  models: ChannelModelMetric[];
}

function finalizeBuckets(series: SystemMetricsPoint[]) {
  for (const p of series) {
    const ext = p as SystemMetricsPoint & {
      _latSum?: number;
      _latN?: number;
      _ttftSum?: number;
      _ttftN?: number;
      _tpsSum?: number;
      _tpsN?: number;
    };
    if (ext._latN && ext._latN > 0) p.avg_latency_ms = Math.round((ext._latSum ?? 0) / ext._latN);
    if (ext._ttftN && ext._ttftN > 0) p.avg_ttft_ms = Math.round((ext._ttftSum ?? 0) / ext._ttftN);
    if (ext._tpsN && ext._tpsN > 0) p.avg_tps = Math.round(((ext._tpsSum ?? 0) / ext._tpsN) * 10) / 10;
    delete ext._latSum;
    delete ext._latN;
    delete ext._ttftSum;
    delete ext._ttftN;
    delete ext._tpsSum;
    delete ext._tpsN;
    if (p.total > 0) p.uptime_pct = Math.round(((p.total - p.failed) / p.total) * 1000) / 10;
  }
}

function bumpBucket(
  p: SystemMetricsPoint,
  ok: number,
  latencyMs: number | null,
  ttftMs?: number | null,
  tps?: number | null,
) {
  p.total += 1;
  if (!ok) p.failed += 1;
  const ext = p as SystemMetricsPoint & {
    _latSum?: number;
    _latN?: number;
    _ttftSum?: number;
    _ttftN?: number;
    _tpsSum?: number;
    _tpsN?: number;
  };
  if (ok && latencyMs != null) {
    ext._latSum = (ext._latSum ?? 0) + latencyMs;
    ext._latN = (ext._latN ?? 0) + 1;
  }
  if (ok && ttftMs != null) {
    ext._ttftSum = (ext._ttftSum ?? 0) + ttftMs;
    ext._ttftN = (ext._ttftN ?? 0) + 1;
  }
  if (ok && tps != null) {
    ext._tpsSum = (ext._tpsSum ?? 0) + tps;
    ext._tpsN = (ext._tpsN ?? 0) + 1;
  }
}

function buildChannelFromSqlite(channelId: number, range: MetricsRange, now: number): {
  series: SystemMetricsPoint[];
  models: ChannelModelMetric[];
  summary: ChannelMetricsPayload['summary'];
} {
  const since = now - RANGE_MS[range];
  const step = STEP_MS[range];
  const series = emptyBuckets(now, range);

  const models = db
    .prepare('SELECT * FROM llm_models WHERE channel_id = ? ORDER BY id')
    .all(channelId) as import('./types').LlmModelRow[];

  const checkRows = db
    .prepare(
      `SELECT c.model_id, c.ts, c.ok, c.latency_ms, c.ttft_ms, c.tps, c.completion_tokens
       FROM llm_checks c
       JOIN llm_models m ON m.id = c.model_id
       WHERE m.channel_id = ? AND c.ts >= ?
       ORDER BY c.ts`,
    )
    .all(channelId, since) as {
    model_id: number;
    ts: number;
    ok: number;
    latency_ms: number | null;
    ttft_ms: number | null;
    tps: number | null;
    completion_tokens: number | null;
  }[];

  const perModel = new Map<
    number,
    {
      total: number;
      ok: number;
      latSum: number;
      latN: number;
      ttftSum: number;
      ttftN: number;
      tpsSum: number;
      tpsN: number;
      tokSum: number;
      tokN: number;
      lastTok: number | null;
      series: SystemMetricsPoint[];
    }
  >();
  for (const m of models) {
    perModel.set(m.id, {
      total: 0,
      ok: 0,
      latSum: 0,
      latN: 0,
      ttftSum: 0,
      ttftN: 0,
      tpsSum: 0,
      tpsN: 0,
      tokSum: 0,
      tokN: 0,
      lastTok: null,
      series: emptyBuckets(now, range),
    });
  }

  let sumTotal = 0;
  let sumOk = 0;
  let latSum = 0;
  let latN = 0;

  for (const c of checkRows) {
    const idx = Math.min(series.length - 1, Math.max(0, Math.floor((c.ts - since) / step)));
    bumpBucket(series[idx]!, c.ok, c.latency_ms, c.ttft_ms, c.tps);

    const st = perModel.get(c.model_id);
    if (st) {
      bumpBucket(st.series[idx]!, c.ok, c.latency_ms, c.ttft_ms, c.tps);
      st.total += 1;
      if (c.ok) {
        st.ok += 1;
        if (c.latency_ms != null) {
          st.latSum += c.latency_ms;
          st.latN += 1;
        }
        if (c.ttft_ms != null) {
          st.ttftSum += c.ttft_ms;
          st.ttftN += 1;
        }
        if (c.tps != null) {
          st.tpsSum += c.tps;
          st.tpsN += 1;
        }
        if (c.completion_tokens != null) {
          st.tokSum += c.completion_tokens;
          st.tokN += 1;
          st.lastTok = c.completion_tokens;
        }
      }
    }
    sumTotal += 1;
    if (c.ok) {
      sumOk += 1;
      if (c.latency_ms != null) {
        latSum += c.latency_ms;
        latN += 1;
      }
    }
  }

  finalizeBuckets(series);
  for (const st of perModel.values()) finalizeBuckets(st.series);

  const modelMetrics: ChannelModelMetric[] = models.map((m) => {
    const st = perModel.get(m.id)!;
    const mode = expectOf(m);
    let uptime: number | null = null;
    if (st.total > 0) {
      const meet = mode === 'down' ? st.total - st.ok : st.ok;
      uptime = Math.round((meet / st.total) * 1000) / 10;
    }
    return {
      id: m.id,
      name: m.name,
      model: m.model,
      probe_mode: m.probe_mode || 'stream',
      expect_mode: mode,
      status: (m.status || 'unknown') as MonitorStatus,
      monitor_enabled: m.monitor_enabled,
      last_check_at: m.last_check_at,
      last_latency_ms: m.last_latency_ms,
      last_ttft_ms: m.last_ttft_ms ?? null,
      last_tps: m.last_tps ?? null,
      total: st.total,
      ok_count: st.ok,
      uptime_pct: uptime,
      avg_latency_ms: st.latN > 0 ? Math.round(st.latSum / st.latN) : null,
      avg_ttft_ms: st.ttftN > 0 ? Math.round(st.ttftSum / st.ttftN) : null,
      avg_tps: st.tpsN > 0 ? Math.round((st.tpsSum / st.tpsN) * 10) / 10 : null,
      avg_completion_tokens: st.tokN > 0 ? Math.round(st.tokSum / st.tokN) : null,
      last_completion_tokens: st.lastTok,
      series: st.series,
    };
  });

  return {
    series,
    models: modelMetrics,
    summary: {
      models: models.length,
      models_monitored: models.filter((m) => m.monitor_enabled).length,
      total: sumTotal,
      ok_count: sumOk,
      uptime_pct: sumTotal > 0 ? Math.round((sumOk / sumTotal) * 1000) / 10 : null,
      avg_latency_ms: latN > 0 ? Math.round(latSum / latN) : null,
    },
  };
}

export async function buildChannelMetrics(
  channelId: number,
  range: MetricsRange,
): Promise<ChannelMetricsPayload | null> {
  const channel = db.prepare('SELECT id FROM llm_channels WHERE id = ?').get(channelId);
  if (!channel) return null;

  const now = Date.now();
  const fromSqlite = buildChannelFromSqlite(channelId, range, now);
  let source: ChannelMetricsPayload['source'] = 'sqlite';

  if (vmEnabled()) {
    const endSec = Math.floor(now / 1000);
    const startSec = endSec - Math.floor(RANGE_MS[range] / 1000);
    const vmSeries = await fetchParentSeries(
      'llm',
      channelId,
      startSec,
      endSec,
      VM_STEP[range],
      VM_WINDOW[range],
    );
    if (vmSeries && vmSeries.length > 0) {
      source = 'merged';
      const step = STEP_MS[range];
      const since = now - RANGE_MS[range];
      for (const v of vmSeries) {
        const idx = Math.min(fromSqlite.series.length - 1, Math.max(0, Math.floor((v.ts - since) / step)));
        const p = fromSqlite.series[idx]!;
        if (p.total === 0) {
          if (v.avg_latency_ms != null) p.avg_latency_ms = v.avg_latency_ms;
          if (v.ok_rate != null) {
            p.uptime_pct = Math.round(v.ok_rate * 1000) / 10;
            p.total = 100;
            p.failed = Math.round((1 - v.ok_rate) * 100);
          }
        } else if (p.avg_latency_ms == null && v.avg_latency_ms != null) {
          p.avg_latency_ms = v.avg_latency_ms;
        }
      }
    }
  }

  return {
    channel_id: channelId,
    range,
    step_ms: STEP_MS[range],
    generated_at: now,
    source,
    summary: fromSqlite.summary,
    series: fromSqlite.series,
    models: fromSqlite.models,
  };
}
