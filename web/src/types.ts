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

/** 系统台账条目：资产登记信息，system_id 为可选关联的监控系统 */
export interface LedgerEntry {
  id: number;
  name: string;
  ops_unit: string;
  ip: string;
  /** HTTPS 探测结论：''=未探测，yes=支持、no=不支持、unknown=探测不到 */
  https_supported: string;
  /** 证书过期时间（毫秒时间戳），只在探测到证书时有值 */
  cert_expires_at: number | null;
  /** HTTPS 探测依据原文（含探测目标与时间），只由探测写入 */
  cert_evidence: string;
  /** 最近一次 HTTPS 探测时间（毫秒时间戳），没探测过时为空 */
  https_checked_at: number | null;
  external_access: boolean | number;
  domain_applied: boolean | number;
  domain: string;
  location: string;
  /** 操作系统发行版/产品名 */
  os_name: string;
  /** 操作系统版本号 */
  os_version: string;
  /** CPU 核心数；未填为空 */
  cpu_cores: number | null;
  /** 内存（GB）；未填为空 */
  memory_gb: number | null;
  /** 硬盘（GB）；未填为空 */
  disk_gb: number | null;
  /** 是否对接统一身份认证 */
  sso_integrated: boolean | number;
  /** 运维类型：long_term / phased / 空 */
  ops_type: string;
  /** 备份情况 */
  backup_info: string;
  remark: string;
  system_id: number | null;
  system_name: string | null;
  system_base_url: string | null;
  created_at: number;
  updated_at: number;
}

export interface LedgerEntryInput {
  name: string;
  ops_unit?: string;
  ip?: string;
  external_access?: boolean;
  domain_applied?: boolean;
  domain?: string;
  location?: string;
  os_name?: string;
  os_version?: string;
  cpu_cores?: number | null;
  memory_gb?: number | null;
  disk_gb?: number | null;
  sso_integrated?: boolean;
  ops_type?: string;
  backup_info?: string;
  remark?: string;
  system_id?: number | null;
}

/** 服务端按域名查 DNS 的结果，用于台账表单里的「解析 IP」 */
export interface DomainResolveResult {
  host: string;
  domain: string;
  addresses: { address: string; family: number }[];
  elapsed_ms: number;
}

/** 「一键 IP 扫描」单条结果的状态 */
export type LedgerScanStatus = 'fill' | 'change' | 'same' | 'skipped' | 'error' | 'missing';

export interface LedgerScanItem {
  id: number;
  name: string;
  domain: string;
  host: string | null;
  current_ip: string;
  resolved_ip: string | null;
  addresses: { address: string; family: number }[];
  status: LedgerScanStatus;
  message: string | null;
  elapsed_ms: number;
}

/** 「一键 IP 扫描」的批量结果：results 逐条给出新旧 IP 对比，summary 是各类计数 */
export interface LedgerScanResult {
  results: LedgerScanItem[];
  summary: { total: number; fill: number; change: number; same: number; skipped: number; failed: number };
}

/** 「写入台账」的结果：overwritten 为覆盖掉旧 IP 的条数，旧值已记入备注 */
export interface LedgerApplyResult {
  updated: number;
  missing: number[];
  overwritten: number;
}

/** HTTPS 探测结论：''=没探测过，yes=支持，no=只提供 HTTP，unknown=连不上或无法判定 */
export type LedgerHttpsOutcome = '' | 'yes' | 'no' | 'unknown';

/** 证书里的关键信息，全部来自 TLS 握手，不需要登录目标机器 */
export interface LedgerCertInfo {
  /** 证书主体（优先 CN），例如 *.example.com */
  subject: string;
  /** 颁发者（优先 CN） */
  issuer: string;
  validFrom: number | null;
  validTo: number | null;
  /** 距离过期还有多少天（负数表示已过期） */
  daysLeft: number | null;
  altNames: string[];
  /** 是否通过系统信任链验证：自签名、过期、名字不匹配都会是 false */
  authorized: boolean;
  authError: string | null;
  /** 握手用的 TLS 版本，例如 TLSv1.3 */
  protocol: string | null;
  fingerprint256: string;
  selfSigned: boolean;
}

/** HTTPS / 证书探测的单条结果 */
export interface LedgerHttpsProbeItem {
  id: number;
  name: string;
  ip: string;
  domain: string;
  /** 实际探测的目标，例如 example.com:443；没有可探测目标时为 null */
  target: string | null;
  /** 台账里已有的结论（''=没探测过）与证书过期时间 */
  current_supported: string;
  current_expires_at: number | null;
  /** 本次探测结论 */
  https: LedgerHttpsOutcome;
  cert: LedgerCertInfo | null;
  /** 逐条证据，写回台账时原文存档 */
  evidence: string[];
  status: LedgerScanStatus;
  message: string | null;
  elapsed_ms: number;
}

/** HTTPS / 证书探测的批量结果 */
export interface LedgerHttpsProbeResult {
  results: LedgerHttpsProbeItem[];
  summary: {
    total: number;
    /** 支持 / 只提供 HTTP / 探不出来 的条数 */
    yes: number;
    no: number;
    unknown: number;
    fill: number;
    change: number;
    same: number;
    /** 证书已过期 / 30 天内到期的条数 */
    expired: number;
    expiring: number;
    failed: number;
  };
}

/** HTTPS 探测写回结果：这些字段只由探测维护，不会覆盖人工登记的内容，所以没有「覆盖」计数 */
export interface LedgerHttpsApplyResult {
  updated: number;
  missing: number[];
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
  /** 1=已停用：不可登录，已有会话已失效 */
  disabled: number;
  /** 所属运维单位：数据权限「仅本运维单位」按它比对台账与监控系统，空串表示未设置 */
  ops_unit: string;
  created_at: number;
}

/** 功能权限定义（服务端 PERMISSION_DEFS）：决定角色「能做什么」 */
export interface PermissionDef {
  key: string;
  label: string;
  desc: string;
  /** 未勾选时的表现：readonly=页面仍可查看、只是不能改；hidden=看不到页面与菜单入口 */
  unchecked: 'readonly' | 'hidden';
}

/** 数据权限取值：全部数据 / 仅本运维单位 / 仅本人创建 */
export type DataScopeKey = 'all' | 'unit' | 'self';

/** 数据权限定义（服务端 DATA_SCOPE_DEFS）：决定角色「能看哪些数据」 */
export interface DataScopeDef {
  key: DataScopeKey;
  label: string;
  desc: string;
}

/** 角色权限配置：功能权限矩阵 + 数据权限范围 */
export interface RolePermissionPayload {
  permissions: PermissionDef[];
  data_scopes: DataScopeDef[];
  roles: Record<string, string>;
  role_permissions: Record<string, string[]>;
  role_data_scopes: Record<string, DataScopeKey>;
}

/** 在线会话（服务端只下发 token 的散列 id，不含原始 token） */
export interface SessionItem {
  id: string;
  user_id: number;
  username: string;
  role: 'admin' | 'operator' | 'viewer';
  disabled: number;
  ip: string;
  user_agent: string;
  created_at: number;
  last_seen_at: number | null;
  expires_at: number;
  current: boolean;
}

export interface AuditLogItem {
  id: number;
  ts: number;
  actor_id: number | null;
  actor_name: string;
  action: string;
  target: string;
  detail: string;
  ip: string;
}

export interface AuditLogPayload {
  logs: AuditLogItem[];
  total: number;
  /** 动作 key → 中文标签 */
  actions: Record<string, string>;
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
      ledger_entries: number;
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
