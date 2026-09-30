/**
 * VictoriaMetrics 客户端：探测时序写入 + PromQL 查询。
 * 未配置 XMONITOR_VM_URL 时全部 no-op / 返回 null，调用方回退 SQLite。
 */
const DEFAULT_TIMEOUT_MS = 5_000;

export function vmUrl(): string | null {
  const u = (process.env.XMONITOR_VM_URL || '').trim().replace(/\/+$/, '');
  return u || null;
}

export function vmEnabled(): boolean {
  return vmUrl() !== null;
}

function escLabel(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '');
}

export interface ProbeSample {
  kind: 'monitor' | 'llm';
  id: number;
  parentId: number;
  ok: boolean;
  latencyMs: number;
  ttftMs?: number;
  tps?: number;
  tsMs?: number;
}

/** Prometheus exposition 行（含毫秒时间戳） */
function toPromLines(s: ProbeSample): string[] {
  const ts = s.tsMs ?? Date.now();
  const labels = `kind="${s.kind}",id="${s.id}",parent="${s.parentId}"`;
  const lines = [`xmonitor_probe_ok{${labels}} ${s.ok ? 1 : 0} ${ts}`];
  if (s.ok && s.latencyMs >= 0) {
    lines.push(`xmonitor_probe_latency_ms{${labels}} ${s.latencyMs} ${ts}`);
  }
  if (s.ok && s.ttftMs != null && s.ttftMs >= 0) {
    lines.push(`xmonitor_probe_ttft_ms{${labels}} ${s.ttftMs} ${ts}`);
  }
  if (s.ok && s.tps != null && s.tps >= 0) {
    lines.push(`xmonitor_probe_tps{${labels}} ${s.tps} ${ts}`);
  }
  return lines;
}

let writeQueue: string[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushing = false;

async function flushQueue(): Promise<void> {
  const base = vmUrl();
  if (!base || writeQueue.length === 0 || flushing) return;
  flushing = true;
  const batch = writeQueue.splice(0, 500);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
    try {
      const resp = await fetch(`${base}/api/v1/import/prometheus`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: batch.join('\n') + '\n',
        signal: ctrl.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        console.warn(`[vm] import 失败 HTTP ${resp.status}: ${text.slice(0, 200)}`);
        // 失败塞回队列头部（有限次，避免无限膨胀）
        if (writeQueue.length < 2000) writeQueue.unshift(...batch);
      }
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.warn(`[vm] import 异常: ${e instanceof Error ? e.message : String(e)}`);
    if (writeQueue.length < 2000) writeQueue.unshift(...batch);
  } finally {
    flushing = false;
    if (writeQueue.length > 0) scheduleFlush(200);
  }
}

function scheduleFlush(delayMs = 1000): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushQueue();
  }, delayMs);
}

/** 异步写入探测点（批量刷盘，不阻塞调度） */
export function writeProbe(sample: ProbeSample): void {
  if (!vmEnabled()) return;
  writeQueue.push(...toPromLines(sample));
  if (writeQueue.length >= 40) scheduleFlush(50);
  else scheduleFlush(1000);
}

export async function flushMetricsNow(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushQueue();
}

interface PromValue {
  metric: Record<string, string>;
  value?: [number, string];
  values?: [number, string][];
}

async function promRequest(
  path: string,
  params: Record<string, string>,
): Promise<{ resultType: string; result: PromValue[] } | null> {
  const base = vmUrl();
  if (!base) return null;
  const qs = new URLSearchParams(params);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const resp = await fetch(`${base}${path}?${qs}`, { signal: ctrl.signal });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { status?: string; data?: { resultType: string; result: PromValue[] } };
    if (json.status !== 'success' || !json.data) return null;
    return json.data;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function queryInstant(promql: string, timeSec?: number): Promise<PromValue[] | null> {
  const params: Record<string, string> = { query: promql };
  if (timeSec !== undefined) params.time = String(timeSec);
  const data = await promRequest('/api/v1/query', params);
  return data?.result ?? null;
}

export async function queryRange(
  promql: string,
  startSec: number,
  endSec: number,
  step: string,
): Promise<PromValue[] | null> {
  const data = await promRequest('/api/v1/query_range', {
    query: promql,
    start: String(startSec),
    end: String(endSec),
    step,
  });
  return data?.result ?? null;
}

export interface VmProbeStat {
  total: number;
  okSum: number;
  avgLatency: number | null;
}

/** 拉取 24h 内各 id 的探测次数、成功次数、平均延迟 */
export async function fetchProbeStats24h(kind: 'monitor' | 'llm'): Promise<Map<number, VmProbeStat> | null> {
  const [countRes, sumRes, latRes] = await Promise.all([
    queryInstant(`count_over_time(xmonitor_probe_ok{kind="${escLabel(kind)}"}[24h])`),
    queryInstant(`sum_over_time(xmonitor_probe_ok{kind="${escLabel(kind)}"}[24h])`),
    queryInstant(
      `sum_over_time(xmonitor_probe_latency_ms{kind="${escLabel(kind)}"}[24h]) / count_over_time(xmonitor_probe_latency_ms{kind="${escLabel(kind)}"}[24h])`,
    ),
  ]);
  if (!countRes) return null;

  const map = new Map<number, VmProbeStat>();
  for (const r of countRes) {
    const id = Number(r.metric.id);
    if (!Number.isFinite(id)) continue;
    const total = Number(r.value?.[1] ?? 0);
    map.set(id, { total, okSum: 0, avgLatency: null });
  }
  for (const r of sumRes ?? []) {
    const id = Number(r.metric.id);
    const st = map.get(id);
    if (!st) continue;
    st.okSum = Number(r.value?.[1] ?? 0);
  }
  for (const r of latRes ?? []) {
    const id = Number(r.metric.id);
    const st = map.get(id);
    if (!st) continue;
    const v = Number(r.value?.[1]);
    st.avgLatency = Number.isFinite(v) ? v : null;
  }
  return map;
}

/** 按 parent 聚合的 24h 小时桶：返回 parentId -> 24 个 avg(ok)（0~1，缺测为 null） */
export async function fetchParentHourlyOk(
  kind: 'monitor' | 'llm',
  nowMs = Date.now(),
): Promise<Map<number, (number | null)[]> | null> {
  const end = Math.floor(nowMs / 1000);
  const start = end - 24 * 3600;
  const series = await queryRange(
    `avg by (parent) (avg_over_time(xmonitor_probe_ok{kind="${escLabel(kind)}"}[1h]))`,
    start,
    end,
    '1h',
  );
  if (!series) return null;

  const map = new Map<number, (number | null)[]>();
  for (const s of series) {
    const parent = Number(s.metric.parent);
    if (!Number.isFinite(parent)) continue;
    const buckets: (number | null)[] = Array.from({ length: 24 }, () => null);
    for (const [ts, val] of s.values ?? []) {
      const idx = Math.min(23, Math.max(0, Math.floor((ts - start) / 3600)));
      const n = Number(val);
      buckets[idx] = Number.isFinite(n) ? n : null;
    }
    map.set(parent, buckets);
  }
  return map;
}

/** 12h 趋势：30min 粒度全局平均延迟 + 失败率近似 */
export async function fetchTrend12h(nowMs = Date.now()): Promise<
  | {
      ts: number;
      avg_latency_ms: number | null;
      llm_avg_latency_ms: number | null;
      total: number;
      failed: number;
      llm_total: number;
      llm_failed: number;
    }[]
  | null
> {
  const end = Math.floor(nowMs / 1000);
  const start = end - 12 * 3600;
  const [bizLat, llmLat, bizOk, llmOk] = await Promise.all([
    queryRange(`avg(avg_over_time(xmonitor_probe_latency_ms{kind="monitor"}[30m]))`, start, end, '30m'),
    queryRange(`avg(avg_over_time(xmonitor_probe_latency_ms{kind="llm"}[30m]))`, start, end, '30m'),
    queryRange(`avg(avg_over_time(xmonitor_probe_ok{kind="monitor"}[30m]))`, start, end, '30m'),
    queryRange(`avg(avg_over_time(xmonitor_probe_ok{kind="llm"}[30m]))`, start, end, '30m'),
  ]);
  if (!bizLat && !llmLat && !bizOk && !llmOk) return null;

  const points = Array.from({ length: 24 }, (_, i) => ({
    ts: (start + i * 1800) * 1000,
    avg_latency_ms: null as number | null,
    llm_avg_latency_ms: null as number | null,
    total: 0,
    failed: 0,
    llm_total: 0,
    llm_failed: 0,
  }));

  const applyLat = (series: PromValue[] | null, key: 'avg_latency_ms' | 'llm_avg_latency_ms') => {
    for (const s of series ?? []) {
      for (const [ts, val] of s.values ?? []) {
        const idx = Math.min(23, Math.max(0, Math.floor((ts - start) / 1800)));
        const n = Number(val);
        if (Number.isFinite(n)) points[idx]![key] = Math.round(n);
      }
    }
  };
  applyLat(bizLat, 'avg_latency_ms');
  applyLat(llmLat, 'llm_avg_latency_ms');

  const applyOk = (series: PromValue[] | null, totalKey: 'total' | 'llm_total', failKey: 'failed' | 'llm_failed') => {
    for (const s of series ?? []) {
      for (const [ts, val] of s.values ?? []) {
        const idx = Math.min(23, Math.max(0, Math.floor((ts - start) / 1800)));
        const okRate = Number(val);
        if (!Number.isFinite(okRate)) continue;
        // 无绝对次数时用 100 作为权重占位，仅驱动失败标记
        points[idx]![totalKey] = 100;
        points[idx]![failKey] = Math.round((1 - okRate) * 100);
      }
    }
  };
  applyOk(bizOk, 'total', 'failed');
  applyOk(llmOk, 'llm_total', 'llm_failed');

  return points;
}

export async function checkVmHealth(): Promise<{ ok: boolean; error?: string }> {
  const base = vmUrl();
  if (!base) return { ok: false, error: '未配置 XMONITOR_VM_URL' };
  try {
    const resp = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
    return resp.ok ? { ok: true } : { ok: false, error: `HTTP ${resp.status}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** 待刷盘队列长度（诊断用） */
export function vmWriteQueueLength(): number {
  return writeQueue.length;
}

/** 当前活跃探针序列数 */
export async function fetchProbeSeriesCount(): Promise<number | null> {
  const res = await queryInstant('count(xmonitor_probe_ok)');
  if (!res || res.length === 0) return null;
  const n = Number(res[0]?.value?.[1]);
  return Number.isFinite(n) ? n : null;
}

export interface ParentSeriesPoint {
  ts: number;
  avg_latency_ms: number | null;
  ok_rate: number | null;
}

/** 指定 parent（系统/渠道）在区间内的延迟与可用率序列 */
export async function fetchParentSeries(
  kind: 'monitor' | 'llm',
  parentId: number,
  startSec: number,
  endSec: number,
  step: string,
  window: string,
): Promise<ParentSeriesPoint[] | null> {
  const parent = escLabel(String(parentId));
  const k = escLabel(kind);
  const [latRes, okRes] = await Promise.all([
    queryRange(
      `avg(avg_over_time(xmonitor_probe_latency_ms{kind="${k}",parent="${parent}"}[${window}]))`,
      startSec,
      endSec,
      step,
    ),
    queryRange(
      `avg(avg_over_time(xmonitor_probe_ok{kind="${k}",parent="${parent}"}[${window}]))`,
      startSec,
      endSec,
      step,
    ),
  ]);
  if (!latRes && !okRes) return null;

  const byTs = new Map<number, ParentSeriesPoint>();
  const ensure = (ts: number) => {
    let p = byTs.get(ts);
    if (!p) {
      p = { ts, avg_latency_ms: null, ok_rate: null };
      byTs.set(ts, p);
    }
    return p;
  };
  for (const s of latRes ?? []) {
    for (const [ts, val] of s.values ?? []) {
      const n = Number(val);
      if (Number.isFinite(n)) ensure(ts * 1000).avg_latency_ms = Math.round(n);
    }
  }
  for (const s of okRes ?? []) {
    for (const [ts, val] of s.values ?? []) {
      const n = Number(val);
      if (Number.isFinite(n)) ensure(ts * 1000).ok_rate = n;
    }
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}
