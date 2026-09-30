import { db } from './db';
import type { AlertRow, LlmAlertRow, LlmChannelRow, LlmModelRow, MonitorStatus, SystemRow } from './types';
import { fetchProbeStats24h, vmEnabled } from './vm';

const STATUS_RANK: Record<MonitorStatus, number> = { up: 0, unknown: 1, slow: 2, down: 3 };

/** 取最差状态；无有效项时为 unknown。注意不能用 unknown 当初值再比 up，否则「全正常」会卡在未知。 */
function worstStatus(statuses: MonitorStatus[]): MonitorStatus {
  if (statuses.length === 0) return 'unknown';
  let worst: MonitorStatus = statuses[0]!;
  for (let i = 1; i < statuses.length; i++) {
    const s = statuses[i]!;
    if (STATUS_RANK[s] > STATUS_RANK[worst]) worst = s;
  }
  return worst;
}

export type RateKind = 'uptime' | 'block' | 'compliance';

export interface DashboardMonitor {
  id: number;
  name: string;
  type: string;
  url: string;
  method: string;
  check_mode: string;
  enabled: number;
  expect_mode: string;
  status: MonitorStatus;
  last_check_at: number | null;
  last_latency_ms: number | null;
  uptime_24h: number | null;
}

export interface DashboardSystem {
  id: number;
  name: string;
  base_url: string;
  use_sso: number;
  overall_status: MonitorStatus;
  reverse_count: number;
  reverse_all: boolean;
  rate_kind: RateKind;
  uptime_24h: number | null;
  monitors: DashboardMonitor[];
  recent_alerts: (AlertRow & { monitor_name: string })[];
}

export interface DashboardLlmModel {
  id: number;
  name: string;
  model: string;
  status: MonitorStatus;
  monitor_enabled: number;
  last_check_at: number | null;
  last_latency_ms: number | null;
  uptime_24h: number | null;
}

export interface DashboardLlmChannel {
  id: number;
  name: string;
  base_url: string;
  enabled: number;
  overall_status: MonitorStatus;
  uptime_24h: number | null;
  model_count: number;
  monitored_count: number;
  models: DashboardLlmModel[];
  recent_alerts: (LlmAlertRow & { monitor_name: string })[];
}

export async function buildDashboard(): Promise<{ systems: DashboardSystem[]; llm_channels: DashboardLlmChannel[] }> {
  const systems = db.prepare('SELECT * FROM systems ORDER BY id').all() as SystemRow[];
  const dayAgo = Date.now() - 24 * 3600 * 1000;

  const [vmMonStats, vmLlmStats] = vmEnabled()
    ? await Promise.all([fetchProbeStats24h('monitor'), fetchProbeStats24h('llm')])
    : [null, null];

  const monitorStmt = db.prepare(
    `SELECT id, name, type, url, method, check_mode, enabled, expect_mode, status, last_check_at, last_latency_ms
     FROM monitors WHERE system_id = ? ORDER BY id`,
  );
  const alertStmt = db.prepare(
    `SELECT a.*, m.name AS monitor_name FROM alerts a
     JOIN monitors m ON m.id = a.monitor_id
     WHERE m.system_id = ? ORDER BY a.ts DESC LIMIT 5`,
  );
  const statStmt = db.prepare(
    `SELECT monitor_id, COUNT(*) AS total, SUM(ok) AS ok_count
     FROM checks WHERE ts >= ? AND monitor_id IN (SELECT id FROM monitors WHERE system_id = ?)
     GROUP BY monitor_id`,
  );

  const dashboardSystems: DashboardSystem[] = systems.map((s) => {
    const monitors = monitorStmt.all(s.id) as Omit<DashboardMonitor, 'uptime_24h'>[];
    const stats = statStmt.all(dayAgo, s.id) as { monitor_id: number; total: number; ok_count: number }[];
    const statMap = new Map(stats.map((r) => [r.monitor_id, r]));
    if (vmMonStats && vmMonStats.size > 0) {
      for (const m of monitors) {
        const st = vmMonStats.get(m.id);
        if (!st) continue;
        const existing = statMap.get(m.id);
        if (existing && existing.total > st.total) continue;
        statMap.set(m.id, { monitor_id: m.id, total: st.total, ok_count: st.okSum });
      }
    }

    let sysTotal = 0;
    let sysMeet = 0;
    const enriched: DashboardMonitor[] = monitors.map((m) => {
      const st = statMap.get(m.id);
      let rate: number | null = null;
      if (st && st.total > 0) {
        const meet = m.expect_mode === 'down' ? st.total - (st.ok_count || 0) : st.ok_count || 0;
        rate = (meet / st.total) * 100;
        sysTotal += st.total;
        sysMeet += meet;
      }
      return { ...m, uptime_24h: rate };
    });
    // 总体状态只看启用中的监控项，停用项的 unknown 不应盖过「已阻断/正常」
    const overall = worstStatus(enriched.filter((m) => m.enabled).map((m) => m.status));

    const reverseCount = enriched.filter((m) => m.expect_mode === 'down').length;
    const reverseAll = enriched.length > 0 && reverseCount === enriched.length;
    const rateKind: RateKind = reverseAll ? 'block' : reverseCount > 0 ? 'compliance' : 'uptime';
    const recent_alerts = alertStmt.all(s.id) as (AlertRow & { monitor_name: string })[];

    return {
      id: s.id,
      name: s.name,
      base_url: s.base_url,
      use_sso: s.use_sso ?? 1,
      overall_status: overall,
      reverse_count: reverseCount,
      reverse_all: reverseAll,
      rate_kind: rateKind,
      uptime_24h: sysTotal > 0 ? (sysMeet / sysTotal) * 100 : null,
      monitors: enriched,
      recent_alerts,
    };
  });

  const channels = db.prepare('SELECT * FROM llm_channels ORDER BY id').all() as LlmChannelRow[];
  const modelStmt = db.prepare('SELECT * FROM llm_models WHERE channel_id = ? ORDER BY id');
  const llmStatStmt = db.prepare(
    `SELECT model_id, COUNT(*) AS total, SUM(ok) AS ok_count
     FROM llm_checks WHERE ts >= ? AND model_id IN (SELECT id FROM llm_models WHERE channel_id = ?)
     GROUP BY model_id`,
  );
  const llmAlertStmt = db.prepare(
    `SELECT a.*, m.name AS monitor_name FROM llm_alerts a
     JOIN llm_models m ON m.id = a.model_id
     WHERE m.channel_id = ? ORDER BY a.ts DESC LIMIT 5`,
  );

  const dashboardChannels: DashboardLlmChannel[] = channels.map((ch) => {
    const models = modelStmt.all(ch.id) as LlmModelRow[];
    const stats = llmStatStmt.all(dayAgo, ch.id) as { model_id: number; total: number; ok_count: number }[];
    const statMap = new Map(stats.map((r) => [r.model_id, r]));
    if (vmLlmStats && vmLlmStats.size > 0) {
      for (const m of models) {
        const st = vmLlmStats.get(m.id);
        if (!st) continue;
        const existing = statMap.get(m.id);
        if (existing && existing.total > st.total) continue;
        statMap.set(m.id, { model_id: m.id, total: st.total, ok_count: st.okSum });
      }
    }
    let total = 0;
    let meet = 0;
    const enriched: DashboardLlmModel[] = models.map((m) => {
      const status = (m.status || 'unknown') as MonitorStatus;
      const st = statMap.get(m.id);
      let rate: number | null = null;
      if (st && st.total > 0) {
        rate = ((st.ok_count || 0) / st.total) * 100;
        if (m.monitor_enabled) {
          total += st.total;
          meet += st.ok_count || 0;
        }
      }
      return {
        id: m.id,
        name: m.name,
        model: m.model,
        status,
        monitor_enabled: m.monitor_enabled,
        last_check_at: m.last_check_at,
        last_latency_ms: m.last_latency_ms,
        uptime_24h: rate,
      };
    });
    const monitoredStatuses = enriched.filter((m) => m.monitor_enabled).map((m) => m.status);
    let overall = worstStatus(monitoredStatuses);
    if (!ch.enabled) overall = 'unknown';
    const recent_alerts = llmAlertStmt.all(ch.id) as (LlmAlertRow & { monitor_name: string })[];
    return {
      id: ch.id,
      name: ch.name,
      base_url: ch.base_url,
      enabled: ch.enabled,
      overall_status: overall,
      uptime_24h: total > 0 ? (meet / total) * 100 : null,
      model_count: models.length,
      monitored_count: models.filter((m) => m.monitor_enabled).length,
      models: enriched,
      recent_alerts,
    };
  });

  return { systems: dashboardSystems, llm_channels: dashboardChannels };
}
