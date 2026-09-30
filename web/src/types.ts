export type MonitorStatus = 'up' | 'slow' | 'down' | 'unknown';
export type MonitorType = 'page' | 'api';
export type ExpectMode = 'up' | 'down';
export type AlertKind = 'down' | 'slow' | 'recovered' | 'reachable' | 'secured';

export interface MonitorSummary {
  id: number;
  name: string;
  type: MonitorType;
  url?: string;
  method?: string;
  check_mode?: string;
  enabled?: boolean | number;
  expect_mode?: ExpectMode | string;
  status: MonitorStatus | string | null;
  last_check_at: string | null;
  last_latency_ms: number | null;
  uptime_24h?: number | null;
}

export interface Monitor extends MonitorSummary {
  system_id: number;
  url: string;
  method: string;
  enabled: boolean | number;
  interval_sec?: number;
  timeout_sec?: number;
}

export interface SystemInfo {
  id: number;
  name: string;
  base_url: string;
  use_sso?: boolean | number | string;
  has_token?: boolean;
  auth_token_masked?: string;
}

export interface SystemRow extends SystemInfo {
  use_sso: boolean | number | string;
  created_at?: string;
}

export interface SystemSummary extends SystemInfo {
  overall_status: MonitorStatus | string | null;
  reverse_count?: number;
  reverse_all?: boolean;
  rate_kind?: 'uptime' | 'block' | 'compliance';
  uptime_24h?: number | null;
  monitors: MonitorSummary[];
  recent_alerts: Alert[];
}

export interface DashboardData {
  systems: SystemSummary[];
  llm_channels?: DashboardLlmChannelSummary[];
}

export interface DashboardLlmModelSummary {
  id: number;
  name: string;
  model: string;
  status: MonitorStatus | string;
  monitor_enabled: boolean | number;
  last_check_at: number | null;
  last_latency_ms: number | null;
  uptime_24h: number | null;
}

export interface DashboardLlmChannelSummary {
  id: number;
  name: string;
  base_url: string;
  enabled: boolean | number;
  overall_status: MonitorStatus | string;
  uptime_24h: number | null;
  model_count: number;
  monitored_count: number;
  models: DashboardLlmModelSummary[];
  recent_alerts: Alert[];
}

export interface Alert {
  id: number;
  monitor_id: number;
  ts: string;
  kind: AlertKind | string;
  message: string;
  acknowledged: boolean | number;
  monitor_name?: string;
  system_name?: string;
}

export type AlertsResponse = Alert[] | { alerts: Alert[] };

export interface Candidate {
  id: number;
  type: MonitorType | string;
  url: string;
  method: string;
  name?: string;
  title?: string;
  category: string;
  reason?: string;
  importance?: number;
  llm_score?: number;
  selected?: boolean | number;
}

export type AnalysisPhase =
  | 'sso'
  | 'init'
  | 'navigate'
  | 'extract'
  | 'screenshot'
  | 'subpage'
  | 'llm'
  | 'parse'
  | 'save'
  | 'done';

export type AnalysisEventLevel = 'info' | 'success' | 'warn' | 'error';

export interface AnalysisEvent {
  ts: number;
  phase: AnalysisPhase | string;
  level: AnalysisEventLevel | string;
  message: string;
  data?: Record<string, unknown>;
}

export interface AnalysisJob {
  status: 'idle' | 'pending' | 'running' | 'done' | 'failed';
  progress?: string[];
  events?: AnalysisEvent[];
  error?: string | null;
  started_at?: number | null;
  finished_at?: number | null;
}

export interface AnalysisResult extends AnalysisJob {
  candidates?: Candidate[];
}

export interface CheckRecord {
  id: number;
  monitor_id: number;
  ts: string;
  ok: boolean | number;
  status_code: number | null;
  latency_ms: number | null;
  error: string | null;
}

export interface LlmProfile {
  id: number;
  name: string;
  base_url: string;
  model: string;
  multimodal: boolean | number | string;
  is_active: boolean | number;
  api_key: string;
}

export interface LlmModel {
  id: number;
  channel_id: number;
  name: string;
  model: string;
  multimodal: boolean | number;
  is_analysis_active?: boolean | number;
  monitor_enabled: boolean | number;
  probe_mode: 'ping' | 'models' | 'chat' | 'stream' | string;
  interval_sec: number;
  timeout_sec: number;
  slow_threshold_ms: number | null;
  expect_mode: ExpectMode | string;
  status: MonitorStatus | string;
  consecutive_fail: number;
  last_check_at: number | null;
  last_latency_ms: number | null;
  last_ttft_ms?: number | null;
  last_tps?: number | null;
  created_at: number;
}

export interface LlmChannel {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  enabled: boolean | number;
  created_at: number;
  models: LlmModel[];
}

export interface LlmTestResult {
  ok: boolean;
  latency_ms?: number;
  error?: string;
  status_code?: number | null;
}

export interface SsoTestStep {
  phase: string;
  level: 'info' | 'success' | 'warn' | 'error' | string;
  message: string;
}

export interface SsoTestResult {
  ok: boolean;
  message?: string;
  steps?: SsoTestStep[];
}

export interface SettingsMap {
  obscura_endpoint: string;
  sso_enabled: string;
  sso_username: string;
  sso_password: string;
  webhook_url: string;
  webhook_template: string;
  default_interval_sec: string;
  default_timeout_sec: string;
  slow_threshold_ms: string;
  llm_timeout_sec: string;
  [key: string]: unknown;
}

export interface TestResult {
  ok: boolean;
  message?: string;
  error?: string;
}

export interface UserItem {
  id: number;
  username: string;
  role: 'admin' | 'operator' | 'viewer';
  created_at: number;
}

// ---- 监控大屏 ----

export type ScreenBucketStatus = 'up' | 'slow' | 'down' | 'none';
export type ScreenRateKind = 'uptime' | 'block' | 'compliance';

export interface ScreenMonitor {
  id: number;
  name: string;
  type: string;
  url: string;
  method: string;
  status: MonitorStatus | string;
  expect_mode?: ExpectMode | string;
  last_check_at: number | null;
  last_latency_ms: number | null;
  uptime_24h: number | null;
}

export interface ScreenSystem {
  id: number;
  name: string;
  base_url: string;
  use_sso: number;
  overall_status: MonitorStatus | string;
  reverse_count?: number;
  reverse_all?: boolean;
  rate_kind?: ScreenRateKind;
  uptime_24h: number | null;
  avg_latency_ms: number | null;
  monitor_count: number;
  up_count: number;
  down_count: number;
  monitors: ScreenMonitor[];
  timeline: ScreenBucketStatus[];
}

export interface ScreenLlmModel {
  id: number;
  name: string;
  model: string;
  status: MonitorStatus | string;
  expect_mode?: ExpectMode | string;
  probe_mode?: string;
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
  overall_status: MonitorStatus | string;
  rate_kind?: ScreenRateKind;
  uptime_24h: number | null;
  avg_latency_ms: number | null;
  model_count: number;
  monitored_count: number;
  up_count: number;
  down_count: number;
  slow_count: number;
  models: ScreenLlmModel[];
  timeline: ScreenBucketStatus[];
}

export interface ScreenTrendPoint {
  ts: number;
  avg_latency_ms: number | null;
  total: number;
  failed: number;
  llm_avg_latency_ms?: number | null;
  llm_total?: number;
  llm_failed?: number;
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
    reverse_monitors?: number;
    llm_channels?: number;
    llm_models?: number;
    llm_up?: number;
    llm_slow?: number;
    llm_down?: number;
    llm_unknown?: number;
    llm_uptime_24h?: number | null;
    llm_avg_latency_ms?: number | null;
    llm_checks_24h?: number;
    overall_uptime_24h?: number | null;
  };
  trend: ScreenTrendPoint[];
  systems: ScreenSystem[];
  llm_channels?: ScreenLlmChannel[];
  alerts: (Alert & { domain?: 'system' | 'llm' })[];
}

export interface SystemStatusPayload {
  generated_at: number;
  process: {
    pid: number;
    uptime_sec: number;
    started_at: number;
    node: string;
    platform: string;
    arch: string;
    memory: {
      rss_mb: number;
      heap_used_mb: number;
      heap_total_mb: number;
      external_mb: number;
    };
    loadavg: number[];
    host_freemem_mb: number;
    host_totalmem_mb: number;
  };
  components: {
    victoria_metrics: {
      enabled: boolean;
      url: string | null;
      url_note: string | null;
      host_url: string | null;
      ok: boolean;
      error?: string;
      series_count: number | null;
      write_queue: number;
      data_dir_bytes: number | null;
    };
    obscura: {
      ok: boolean;
      version?: string;
      error?: string;
    };
    websocket: {
      clients: number;
    };
  };
  sqlite: {
    path: string;
    db_bytes: number | null;
    wal_bytes: number | null;
    shm_bytes: number | null;
    data_dir_bytes: number | null;
    tables: {
      systems: number;
      monitors: number;
      monitors_enabled: number;
      checks: number;
      checks_24h: number;
      llm_channels: number;
      llm_models: number;
      llm_models_monitored: number;
      llm_checks: number;
      llm_checks_24h: number;
      alerts_unacked: number;
      llm_alerts_unacked: number;
      users: number;
    };
  };
  overall: 'ok' | 'degraded' | 'down';
}

export type MetricsRange = '24h' | '7d' | '30d';

export interface SystemMetricsPoint {
  ts: number;
  avg_latency_ms: number | null;
  avg_ttft_ms?: number | null;
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
  expect_mode: ExpectMode | string;
  status: MonitorStatus | string;
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

export interface ChannelModelMetric {
  id: number;
  name: string;
  model: string;
  probe_mode: string;
  expect_mode: ExpectMode | string;
  status: MonitorStatus | string;
  monitor_enabled: number;
  last_check_at: number | null;
  last_latency_ms: number | null;
  last_ttft_ms?: number | null;
  last_tps?: number | null;
  total: number;
  ok_count: number;
  uptime_pct: number | null;
  avg_latency_ms: number | null;
  avg_ttft_ms?: number | null;
  avg_tps?: number | null;
  avg_completion_tokens?: number | null;
  last_completion_tokens?: number | null;
  series?: SystemMetricsPoint[];
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
  series: SystemMetricsPoint[];
  models: ChannelModelMetric[];
}
