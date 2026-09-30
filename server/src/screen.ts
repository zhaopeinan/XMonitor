import { db } from './db';
import { getSetting } from './settings';
import { fetchParentHourlyOk, fetchProbeStats24h, fetchTrend12h, vmEnabled } from './vm';
import type {
  AlertRow,
  ExpectMode,
  LlmAlertRow,
  LlmChannelRow,
  LlmModelRow,
  MonitorRow,
  MonitorStatus,
  SystemRow,
} from './types';

const STATUS_RANK: Record<MonitorStatus, number> = { up: 0, unknown: 1, slow: 2, down: 3 };

function worstStatus(statuses: MonitorStatus[]): MonitorStatus {
  if (statuses.length === 0) return 'unknown';
  let worst: MonitorStatus = statuses[0]!;
  for (let i = 1; i < statuses.length; i++) {
    const s = statuses[i]!;
    if (STATUS_RANK[s] > STATUS_RANK[worst]) worst = s;
  }
  return worst;
}

export type BucketStatus = 'up' | 'slow' | 'down' | 'none';

/** 24h 主指标语义：正向=可用率；全反向=阻断率；混合=符合预期比例 */
export type RateKind = 'uptime' | 'block' | 'compliance';

export interface ScreenMonitor {
  id: number;
  name: string;
  type: string;
  url: string;
  method: string;
  status: MonitorStatus;
  expect_mode: ExpectMode;
  last_check_at: number | null;
  last_latency_ms: number | null;
  /** 期望符合率：正向=可达占比，反向=不可达占比 */
  uptime_24h: number | null;
}

export interface ScreenSystem {
  id: number;
  name: string;
  base_url: string;
  use_sso: number;
  overall_status: MonitorStatus;
  reverse_count: number;
  reverse_all: boolean;
  rate_kind: RateKind;
  uptime_24h: number | null;
  avg_latency_ms: number | null;
  monitor_count: number;
  up_count: number;
  down_count: number;
  monitors: ScreenMonitor[];
  timeline: BucketStatus[]; // 最近 24 小时，每小时一格；颜色按「是否符合期望」着色
}

export interface ScreenLlmModel {
  id: number;
  name: string;
  model: string;
  status: MonitorStatus;
  expect_mode: ExpectMode;
  probe_mode: string;
  last_check_at: number | null;
  last_latency_ms: number | null;
  uptime_24h: number | null;
  monitor_enabled: boolean;
}

export interface ScreenLlmChannel {
  id: number;
  name: string;
  base_url: string;
  enabled: boolean;
  overall_status: MonitorStatus;
  rate_kind: RateKind;
  uptime_24h: number | null;
  avg_latency_ms: number | null;
  model_count: number;
  monitored_count: number;
  up_count: number;
  down_count: number;
  slow_count: number;
  models: ScreenLlmModel[];
  timeline: BucketStatus[];
}

export interface ScreenTrendPoint {
  ts: number;
  avg_latency_ms: number | null;
  total: number;
  failed: number;
  /** 模型探测均延迟（与业务延迟分开，避免量纲混在一条线看不清） */
  llm_avg_latency_ms?: number | null;
  llm_total?: number;
  llm_failed?: number;
}

export interface ScreenAlertItem {
  id: number;
  ts: number;
  kind: string;
  message: string | null;
  acknowledged: number;
  domain: 'system' | 'llm';
  monitor_name: string;
  system_name: string;
}

export interface ScreenData {
  generated_at: number;
  totals: {
    systems: number;
    monitors: number;
    up: number;
    slow: number;
    down: number;
    unknown: number;
    uptime_24h: number | null;
    avg_latency_ms: number | null;
    checks_24h: number;
    unacked_alerts: number;
    reverse_monitors: number;
    /** 大模型侧 */
    llm_channels: number;
    llm_models: number;
    llm_up: number;
    llm_slow: number;
    llm_down: number;
    llm_unknown: number;
    llm_uptime_24h: number | null;
    llm_avg_latency_ms: number | null;
    llm_checks_24h: number;
    /** 业务+模型加权符合率 */
    overall_uptime_24h: number | null;
  };
  trend: ScreenTrendPoint[];
  systems: ScreenSystem[];
  llm_channels: ScreenLlmChannel[];
  alerts: ScreenAlertItem[];
}

interface CheckStatRow {
  monitor_id: number;
  total: number;
  ok_count: number;
  avg_latency: number | null;
}

interface LlmCheckStatRow {
  model_id: number;
  total: number;
  ok_count: number;
  avg_latency: number | null;
}

function expectOf(m: { expect_mode?: string | null }): ExpectMode {
  return m.expect_mode === 'down' ? 'down' : 'up';
}

/** 单次探测是否「符合期望」：正向要可达，反向要不可达 */
function meetsExpectation(ok: boolean, mode: ExpectMode): boolean {
  return mode === 'down' ? !ok : !!ok;
}

/**
 * 将单次探测映射为健康色块（绿=好/符合，红=坏/不符合）
 * 反向：可达→down，不可达→up；正向保持原语义（含 slow）
 */
function checkHealth(
  ok: boolean,
  latencyMs: number | null,
  mode: ExpectMode,
  slowThreshold: number,
): 'up' | 'slow' | 'down' {
  if (mode === 'down') {
    return ok ? 'down' : 'up';
  }
  if (!ok) return 'down';
  if (latencyMs !== null && latencyMs > slowThreshold) return 'slow';
  return 'up';
}

function buildTimeline(
  buckets: { total: number; bad: number; slow: number }[] | undefined,
): BucketStatus[] {
  return Array.from({ length: 24 }, (_, i) => {
    const b = buckets?.[i];
    if (!b || b.total === 0) return 'none';
    const badRatio = b.bad / b.total;
    const slowRatio = b.slow / b.total;
    if (badRatio > 0.5) return 'down';
    if (badRatio > 0.05 || slowRatio > 0.5) return 'slow';
    return 'up';
  });
}

/** VM 小时级 avg(ok) → 色带（无延迟细分时，<0.95 标为缓慢） */
function okRatesToTimeline(rates: (number | null)[] | undefined): BucketStatus[] {
  if (!rates) return Array.from({ length: 24 }, () => 'none' as BucketStatus);
  return rates.map((r) => {
    if (r === null || r === undefined) return 'none';
    if (r < 0.5) return 'down';
    if (r < 0.95) return 'slow';
    return 'up';
  });
}

/**
 * SQLite 打底 + VM 补缺口。
 * VM 刚上线时只有最近几小时，若整段改用 VM 会把历史刷成「无数据」。
 */
function mergeTimeline(
  sqliteBuckets: { total: number; bad: number; slow: number }[] | undefined,
  vmRates: (number | null)[] | undefined,
): BucketStatus[] {
  const fromSqlite = buildTimeline(sqliteBuckets);
  if (!vmRates) return fromSqlite;
  const fromVm = okRatesToTimeline(vmRates);
  return fromSqlite.map((s, i) => (s !== 'none' ? s : fromVm[i] ?? 'none'));
}

/** 趋势点：有 SQLite 实测则保留；VM 仅填补仍为空的槽位 */
function mergeTrend(sqlite: ScreenTrendPoint[], vm: ScreenTrendPoint[] | null): ScreenTrendPoint[] {
  if (!vm) return sqlite;
  return sqlite.map((p, i) => {
    const v = vm[i];
    if (!v) return p;
    const useVmBiz = p.total === 0 && (v.total > 0 || v.avg_latency_ms != null);
    const useVmLlm = (p.llm_total ?? 0) === 0 && ((v.llm_total ?? 0) > 0 || v.llm_avg_latency_ms != null);
    return {
      ts: p.ts,
      avg_latency_ms: useVmBiz ? v.avg_latency_ms : p.avg_latency_ms,
      total: useVmBiz ? v.total : p.total,
      failed: useVmBiz ? v.failed : p.failed,
      llm_avg_latency_ms: useVmLlm ? v.llm_avg_latency_ms : p.llm_avg_latency_ms,
      llm_total: useVmLlm ? v.llm_total : p.llm_total,
      llm_failed: useVmLlm ? v.llm_failed : p.llm_failed,
    };
  });
}

export async function buildScreen(): Promise<ScreenData> {
  const now = Date.now();
  const dayAgo = now - 24 * 3600 * 1000;
  const slowThreshold = Number(getSetting('slow_threshold_ms')) || 3000;

  const systems = db.prepare('SELECT * FROM systems ORDER BY id').all() as SystemRow[];
  const monitors = db.prepare('SELECT * FROM monitors ORDER BY id').all() as MonitorRow[];
  const expectByMonitor = new Map(monitors.map((m) => [m.id, expectOf(m)]));

  const channels = db.prepare('SELECT * FROM llm_channels ORDER BY id').all() as LlmChannelRow[];
  const llmModels = db.prepare('SELECT * FROM llm_models ORDER BY id').all() as LlmModelRow[];
  const expectByLlmModel = new Map(llmModels.map((m) => [m.id, expectOf(m)]));
  const slowByLlmModel = new Map(
    llmModels.map((m) => [m.id, m.slow_threshold_ms && m.slow_threshold_ms > 0 ? m.slow_threshold_ms : slowThreshold]),
  );

  // 时序优先 VictoriaMetrics；失败则回退 SQLite checks
  const [vmMonStats, vmLlmStats, vmSysHourly, vmChHourly, vmTrend] = vmEnabled()
    ? await Promise.all([
        fetchProbeStats24h('monitor'),
        fetchProbeStats24h('llm'),
        fetchParentHourlyOk('monitor', now),
        fetchParentHourlyOk('llm', now),
        fetchTrend12h(now),
      ])
    : [null, null, null, null, null];

  const statRows = db
    .prepare(
      `SELECT monitor_id, COUNT(*) AS total, SUM(ok) AS ok_count, AVG(latency_ms) AS avg_latency
       FROM checks WHERE ts >= ? GROUP BY monitor_id`,
    )
    .all(dayAgo) as CheckStatRow[];
  const statByMonitor = new Map(statRows.map((r) => [r.monitor_id, r]));
  if (vmMonStats && vmMonStats.size > 0) {
    for (const [id, st] of vmMonStats) {
      const existing = statByMonitor.get(id);
      // VM 上线初期序列短于 SQLite 时，保留更完整的 24h 统计
      if (existing && existing.total > st.total) continue;
      statByMonitor.set(id, {
        monitor_id: id,
        total: st.total,
        ok_count: st.okSum,
        avg_latency: st.avgLatency,
      });
    }
  }

  const llmStatRows = db
    .prepare(
      `SELECT model_id, COUNT(*) AS total, SUM(ok) AS ok_count, AVG(latency_ms) AS avg_latency
       FROM llm_checks WHERE ts >= ? GROUP BY model_id`,
    )
    .all(dayAgo) as LlmCheckStatRow[];
  const statByLlmModel = new Map(llmStatRows.map((r) => [r.model_id, r]));
  if (vmLlmStats && vmLlmStats.size > 0) {
    for (const [id, st] of vmLlmStats) {
      const existing = statByLlmModel.get(id);
      if (existing && existing.total > st.total) continue;
      statByLlmModel.set(id, {
        model_id: id,
        total: st.total,
        ok_count: st.okSum,
        avg_latency: st.avgLatency,
      });
    }
  }

  const checkRows = db
    .prepare(
      `SELECT c.monitor_id, c.ts, c.ok, c.latency_ms, m.system_id
       FROM checks c JOIN monitors m ON m.id = c.monitor_id
       WHERE c.ts >= ? ORDER BY c.ts`,
    )
    .all(dayAgo) as { monitor_id: number; ts: number; ok: number; latency_ms: number | null; system_id: number }[];

  const llmCheckRows = db
    .prepare(
      `SELECT c.model_id, c.ts, c.ok, c.latency_ms, m.channel_id
       FROM llm_checks c JOIN llm_models m ON m.id = c.model_id
       WHERE c.ts >= ? ORDER BY c.ts`,
    )
    .all(dayAgo) as { model_id: number; ts: number; ok: number; latency_ms: number | null; channel_id: number }[];

  // 时间线按「健康」累计：bad=不符合期望，slow=正向缓慢
  const timelineBySystem = new Map<number, { total: number; bad: number; slow: number }[]>();
  for (const c of checkRows) {
    let buckets = timelineBySystem.get(c.system_id);
    if (!buckets) {
      buckets = Array.from({ length: 24 }, () => ({ total: 0, bad: 0, slow: 0 }));
      timelineBySystem.set(c.system_id, buckets);
    }
    const idx = Math.min(23, Math.floor((c.ts - dayAgo) / 3600000));
    const b = buckets[idx]!;
    const mode = expectByMonitor.get(c.monitor_id) ?? 'up';
    const health = checkHealth(!!c.ok, c.latency_ms, mode, slowThreshold);
    b.total += 1;
    if (health === 'down') b.bad += 1;
    else if (health === 'slow') b.slow += 1;
  }

  const timelineByChannel = new Map<number, { total: number; bad: number; slow: number }[]>();
  for (const c of llmCheckRows) {
    let buckets = timelineByChannel.get(c.channel_id);
    if (!buckets) {
      buckets = Array.from({ length: 24 }, () => ({ total: 0, bad: 0, slow: 0 }));
      timelineByChannel.set(c.channel_id, buckets);
    }
    const idx = Math.min(23, Math.floor((c.ts - dayAgo) / 3600000));
    const b = buckets[idx]!;
    const mode = expectByLlmModel.get(c.model_id) ?? 'up';
    const health = checkHealth(!!c.ok, c.latency_ms, mode, slowByLlmModel.get(c.model_id) ?? slowThreshold);
    b.total += 1;
    if (health === 'down') b.bad += 1;
    else if (health === 'slow') b.slow += 1;
  }

  const trendStart = now - 12 * 3600 * 1000;
  const trend: ScreenTrendPoint[] = Array.from({ length: 24 }, (_, i) => ({
    ts: trendStart + i * 1800000,
    avg_latency_ms: null,
    total: 0,
    failed: 0,
    llm_avg_latency_ms: null,
    llm_total: 0,
    llm_failed: 0,
  }));
  const latencySum = new Array<number>(24).fill(0);
  const latencyN = new Array<number>(24).fill(0);
  const llmLatencySum = new Array<number>(24).fill(0);
  const llmLatencyN = new Array<number>(24).fill(0);
  for (const c of checkRows) {
    if (c.ts < trendStart) continue;
    const idx = Math.min(23, Math.floor((c.ts - trendStart) / 1800000));
    const p = trend[idx]!;
    const mode = expectByMonitor.get(c.monitor_id) ?? 'up';
    p.total += 1;
    if (!meetsExpectation(!!c.ok, mode)) p.failed += 1;
    if (c.ok && c.latency_ms !== null) {
      latencySum[idx]! += c.latency_ms;
      latencyN[idx]! += 1;
    }
  }
  for (const c of llmCheckRows) {
    if (c.ts < trendStart) continue;
    const idx = Math.min(23, Math.floor((c.ts - trendStart) / 1800000));
    const p = trend[idx]!;
    const mode = expectByLlmModel.get(c.model_id) ?? 'up';
    p.llm_total = (p.llm_total ?? 0) + 1;
    if (!meetsExpectation(!!c.ok, mode)) p.llm_failed = (p.llm_failed ?? 0) + 1;
    if (c.ok && c.latency_ms !== null) {
      llmLatencySum[idx]! += c.latency_ms;
      llmLatencyN[idx]! += 1;
    }
  }
  trend.forEach((p, i) => {
    p.avg_latency_ms = latencyN[i]! > 0 ? Math.round(latencySum[i]! / latencyN[i]!) : null;
    p.llm_avg_latency_ms = llmLatencyN[i]! > 0 ? Math.round(llmLatencySum[i]! / llmLatencyN[i]!) : null;
  });
  const finalTrend: ScreenTrendPoint[] = mergeTrend(trend, vmTrend);

  const enabledMonitors = monitors.filter((m) => m.enabled);
  const monitorsBySystem = new Map<number, MonitorRow[]>();
  for (const m of monitors) {
    const list = monitorsBySystem.get(m.system_id) ?? [];
    list.push(m);
    monitorsBySystem.set(m.system_id, list);
  }

  const screenSystems: ScreenSystem[] = systems.map((s) => {
    const ms = monitorsBySystem.get(s.id) ?? [];
    const reverseCount = ms.filter((m) => expectOf(m) === 'down').length;
    const reverseAll = ms.length > 0 && reverseCount === ms.length;
    const rateKind: RateKind = reverseAll ? 'block' : reverseCount > 0 ? 'compliance' : 'uptime';

    let upCount = 0;
    let downCount = 0;
    const screenMonitors: ScreenMonitor[] = ms.map((m) => {
      const status = (m.status ?? 'unknown') as MonitorStatus;
      if (status === 'up') upCount += 1;
      if (status === 'down') downCount += 1;
      const stat = statByMonitor.get(m.id);
      const mode = expectOf(m);
      let rate: number | null = null;
      if (stat && stat.total > 0) {
        const meet = mode === 'down' ? stat.total - (stat.ok_count || 0) : stat.ok_count || 0;
        rate = (meet / stat.total) * 100;
      }
      return {
        id: m.id,
        name: m.name,
        type: m.type,
        url: m.url,
        method: m.method || 'GET',
        status,
        expect_mode: mode,
        last_check_at: m.last_check_at,
        last_latency_ms: m.last_latency_ms,
        uptime_24h: rate,
      };
    });
    const overall = worstStatus(
      ms.filter((m) => m.enabled).map((m) => (m.status ?? 'unknown') as MonitorStatus),
    );

    // 系统级符合率：按探测次数加权
    let total = 0;
    let meetCount = 0;
    let latSum = 0;
    let latN = 0;
    for (const m of ms) {
      const stat = statByMonitor.get(m.id);
      if (!stat || stat.total <= 0) continue;
      total += stat.total;
      const mode = expectOf(m);
      meetCount += mode === 'down' ? stat.total - (stat.ok_count || 0) : stat.ok_count || 0;
      if (stat.avg_latency != null && (stat.ok_count || 0) > 0) {
        latSum += stat.avg_latency * (stat.ok_count || 0);
        latN += stat.ok_count || 0;
      }
    }
    if (latN === 0) {
      for (const c of checkRows) {
        if (c.system_id !== s.id || !c.ok || c.latency_ms === null) continue;
        latSum += c.latency_ms;
        latN += 1;
      }
    }

    return {
      id: s.id,
      name: s.name,
      base_url: s.base_url,
      use_sso: s.use_sso ?? 1,
      overall_status: overall,
      reverse_count: reverseCount,
      reverse_all: reverseAll,
      rate_kind: rateKind,
      uptime_24h: total > 0 ? (meetCount / total) * 100 : null,
      avg_latency_ms: latN > 0 ? Math.round(latSum / latN) : null,
      monitor_count: ms.length,
      up_count: upCount,
      down_count: downCount,
      monitors: screenMonitors,
      timeline: mergeTimeline(timelineBySystem.get(s.id), vmSysHourly?.get(s.id)),
    };
  });

  const modelsByChannel = new Map<number, LlmModelRow[]>();
  for (const m of llmModels) {
    const list = modelsByChannel.get(m.channel_id) ?? [];
    list.push(m);
    modelsByChannel.set(m.channel_id, list);
  }

  const screenChannels: ScreenLlmChannel[] = channels.map((ch) => {
    const ms = modelsByChannel.get(ch.id) ?? [];
    const monitored = ms.filter((m) => m.monitor_enabled === 1);
    let upCount = 0;
    let downCount = 0;
    let slowCount = 0;

    const screenModels: ScreenLlmModel[] = ms.map((m) => {
      const status = (m.status ?? 'unknown') as MonitorStatus;
      if (m.monitor_enabled) {
        if (status === 'up') upCount += 1;
        if (status === 'down') downCount += 1;
        if (status === 'slow') slowCount += 1;
      }
      const stat = statByLlmModel.get(m.id);
      const mode = expectOf(m);
      let rate: number | null = null;
      if (stat && stat.total > 0) {
        const meet = mode === 'down' ? stat.total - (stat.ok_count || 0) : stat.ok_count || 0;
        rate = (meet / stat.total) * 100;
      }
      return {
        id: m.id,
        name: m.name,
        model: m.model,
        status,
        expect_mode: mode,
        probe_mode: m.probe_mode || 'ping',
        last_check_at: m.last_check_at,
        last_latency_ms: m.last_latency_ms,
        uptime_24h: rate,
        monitor_enabled: m.monitor_enabled === 1,
      };
    });

    let overall = worstStatus(
      screenModels.filter((m) => m.monitor_enabled).map((m) => m.status as MonitorStatus),
    );
    if (!ch.enabled) overall = 'unknown';

    let total = 0;
    let meetCount = 0;
    let latSum = 0;
    let latN = 0;
    for (const m of monitored) {
      const stat = statByLlmModel.get(m.id);
      if (!stat || stat.total <= 0) continue;
      total += stat.total;
      const mode = expectOf(m);
      meetCount += mode === 'down' ? stat.total - (stat.ok_count || 0) : stat.ok_count || 0;
      if (stat.avg_latency != null && (stat.ok_count || 0) > 0) {
        latSum += stat.avg_latency * (stat.ok_count || 0);
        latN += stat.ok_count || 0;
      }
    }
    if (latN === 0) {
      for (const c of llmCheckRows) {
        if (c.channel_id !== ch.id || !c.ok || c.latency_ms === null) continue;
        latSum += c.latency_ms;
        latN += 1;
      }
    }

    return {
      id: ch.id,
      name: ch.name,
      base_url: ch.base_url,
      enabled: ch.enabled === 1,
      overall_status: overall,
      rate_kind: 'uptime' as RateKind,
      uptime_24h: total > 0 ? (meetCount / total) * 100 : null,
      avg_latency_ms: latN > 0 ? Math.round(latSum / latN) : null,
      model_count: ms.length,
      monitored_count: monitored.length,
      up_count: upCount,
      down_count: downCount,
      slow_count: slowCount,
      models: screenModels,
      timeline: mergeTimeline(timelineByChannel.get(ch.id), vmChHourly?.get(ch.id)),
    };
  });

  let up = 0;
  let slow = 0;
  let down = 0;
  let unknown = 0;
  let reverseMonitors = 0;
  for (const m of enabledMonitors) {
    const st = (m.status ?? 'unknown') as MonitorStatus;
    if (st === 'up') up += 1;
    else if (st === 'slow') slow += 1;
    else if (st === 'down') down += 1;
    else unknown += 1;
    if (expectOf(m) === 'down') reverseMonitors += 1;
  }

  const enabledLlmModels = llmModels.filter((m) => {
    const ch = channels.find((c) => c.id === m.channel_id);
    return ch?.enabled === 1 && m.monitor_enabled === 1;
  });
  let llmUp = 0;
  let llmSlow = 0;
  let llmDown = 0;
  let llmUnknown = 0;
  for (const m of enabledLlmModels) {
    const st = (m.status ?? 'unknown') as MonitorStatus;
    if (st === 'up') llmUp += 1;
    else if (st === 'slow') llmSlow += 1;
    else if (st === 'down') llmDown += 1;
    else llmUnknown += 1;
  }

  // 全局 KPI：按期望符合率聚合
  let allTotal = 0;
  let allMeet = 0;
  let allLatSum = 0;
  let allLatN = 0;
  for (const r of statRows) {
    allTotal += r.total;
    const mode = expectByMonitor.get(r.monitor_id) ?? 'up';
    allMeet += mode === 'down' ? r.total - (r.ok_count || 0) : r.ok_count || 0;
  }
  for (const c of checkRows) {
    if (c.ok && c.latency_ms !== null) {
      allLatSum += c.latency_ms;
      allLatN += 1;
    }
  }

  let llmTotal = 0;
  let llmMeet = 0;
  let llmLatSum = 0;
  let llmLatN = 0;
  for (const r of llmStatRows) {
    llmTotal += r.total;
    const mode = expectByLlmModel.get(r.model_id) ?? 'up';
    llmMeet += mode === 'down' ? r.total - (r.ok_count || 0) : r.ok_count || 0;
  }
  for (const c of llmCheckRows) {
    if (c.ok && c.latency_ms !== null) {
      llmLatSum += c.latency_ms;
      llmLatN += 1;
    }
  }

  const overallTotal = allTotal + llmTotal;
  const overallMeet = allMeet + llmMeet;

  const unackedSys = db.prepare('SELECT COUNT(*) AS n FROM alerts WHERE acknowledged = 0').get() as { n: number };
  const unackedLlm = db.prepare('SELECT COUNT(*) AS n FROM llm_alerts WHERE acknowledged = 0').get() as { n: number };

  const sysAlerts = db
    .prepare(
      `SELECT a.id, a.ts, a.kind, a.message, a.acknowledged, m.name AS monitor_name, s.name AS system_name
       FROM alerts a
       JOIN monitors m ON m.id = a.monitor_id
       JOIN systems s ON s.id = m.system_id
       ORDER BY a.acknowledged ASC, a.ts DESC LIMIT 12`,
    )
    .all() as (Pick<AlertRow, 'id' | 'ts' | 'kind' | 'message' | 'acknowledged'> & {
    monitor_name: string;
    system_name: string;
  })[];

  const llmAlerts = db
    .prepare(
      `SELECT a.id, a.ts, a.kind, a.message, a.acknowledged, m.name AS monitor_name, c.name AS system_name
       FROM llm_alerts a
       JOIN llm_models m ON m.id = a.model_id
       JOIN llm_channels c ON c.id = m.channel_id
       ORDER BY a.acknowledged ASC, a.ts DESC LIMIT 12`,
    )
    .all() as (Pick<LlmAlertRow, 'id' | 'ts' | 'kind' | 'message' | 'acknowledged'> & {
    monitor_name: string;
    system_name: string;
  })[];

  const alerts: ScreenAlertItem[] = [
    ...sysAlerts.map((a) => ({ ...a, domain: 'system' as const, message: a.message ?? null })),
    ...llmAlerts.map((a) => ({ ...a, domain: 'llm' as const, kind: String(a.kind), message: a.message ?? null })),
  ]
    .sort((a, b) => {
      if (a.acknowledged !== b.acknowledged) return a.acknowledged - b.acknowledged;
      return b.ts - a.ts;
    })
    .slice(0, 12);

  return {
    generated_at: now,
    totals: {
      systems: systems.length,
      monitors: enabledMonitors.length,
      up,
      slow,
      down,
      unknown,
      uptime_24h: allTotal > 0 ? (allMeet / allTotal) * 100 : null,
      avg_latency_ms: allLatN > 0 ? Math.round(allLatSum / allLatN) : null,
      checks_24h: allTotal,
      unacked_alerts: unackedSys.n + unackedLlm.n,
      reverse_monitors: reverseMonitors,
      llm_channels: channels.filter((c) => c.enabled === 1).length,
      llm_models: enabledLlmModels.length,
      llm_up: llmUp,
      llm_slow: llmSlow,
      llm_down: llmDown,
      llm_unknown: llmUnknown,
      llm_uptime_24h: llmTotal > 0 ? (llmMeet / llmTotal) * 100 : null,
      llm_avg_latency_ms: llmLatN > 0 ? Math.round(llmLatSum / llmLatN) : null,
      llm_checks_24h: llmTotal,
      overall_uptime_24h: overallTotal > 0 ? (overallMeet / overallTotal) * 100 : null,
    },
    trend: finalTrend,
    systems: screenSystems,
    llm_channels: screenChannels,
    alerts,
  };
}
