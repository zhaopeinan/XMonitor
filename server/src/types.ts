export type MonitorType = 'page' | 'api';
export type CheckMode = 'http' | 'browser';
export type MonitorStatus = 'up' | 'down' | 'slow' | 'unknown';
/** up=期望可访问（正向）；down=期望不可达（反向） */
export type ExpectMode = 'up' | 'down';
export type AlertKind = 'down' | 'slow' | 'recovered' | 'reachable' | 'secured';
export type LlmProbeMode = 'ping' | 'models' | 'chat' | 'stream';

export interface SystemRow {
  id: number;
  name: string;
  base_url: string;
  use_sso: number;
  auth_token: string | null;
  /** 归属运维单位：数据权限「仅本运维单位」按它过滤监控系统 */
  ops_unit: string;
  /** 创建人用户 id（历史数据为空）；数据权限「仅本人创建」按它过滤 */
  created_by: number | null;
  created_at: number;
}

/** 系统台账条目：资产登记信息，system_id 为可选关联的监控系统 */
export interface SystemLedgerRow {
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
  /** 最近一次 HTTPS 探测时间（毫秒时间戳） */
  https_checked_at: number | null;
  external_access: number;
  domain_applied: number;
  domain: string;
  location: string;
  /** 操作系统发行版/产品名，例如 CentOS、Windows Server */
  os_name: string;
  /** 操作系统版本号，例如 7.9、2022 */
  os_version: string;
  /** CPU 核心数；未填为空 */
  cpu_cores: number | null;
  /** 内存（GB）；未填为空 */
  memory_gb: number | null;
  /** 硬盘（GB）；未填为空 */
  disk_gb: number | null;
  /** 是否对接统一身份认证：1=是，0=否 */
  sso_integrated: number;
  /** 运维类型：long_term=长期运维，phased=阶段性运维，空=未填 */
  ops_type: string;
  /** 备份情况说明 */
  backup_info: string;
  remark: string;
  system_id: number | null;
  /** 创建人用户 id（历史数据为空）；数据权限「仅本人创建」按它过滤 */
  created_by: number | null;
  created_at: number;
  updated_at: number;
}

export type UserRole = 'admin' | 'operator' | 'viewer';

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: UserRole;
  /** 1=已停用，停用后不可登录、已有会话立即失效 */
  disabled: number;
  /** 所属运维单位：数据权限「仅本运维单位」按它比对台账与监控系统 */
  ops_unit: string;
  created_at: number;
}

export interface CandidateRow {
  id: number;
  system_id: number;
  type: MonitorType;
  url: string;
  method: string | null;
  title: string | null;
  category: string | null;
  reason: string | null;
  llm_score: number | null;
  selected: number;
  sample_json: string | null;
  created_at: number;
}

export interface MonitorRow {
  id: number;
  system_id: number;
  name: string;
  type: MonitorType;
  url: string;
  method: string;
  headers: string | null;
  body: string | null;
  check_mode: CheckMode;
  expected_json: string | null;
  interval_sec: number;
  timeout_sec: number;
  enabled: number;
  /** up=正向（宕机告警）；down=反向（可达告警） */
  expect_mode: ExpectMode;
  status: MonitorStatus;
  consecutive_fail: number;
  last_check_at: number | null;
  last_latency_ms: number | null;
}

export interface CheckRow {
  id: number;
  monitor_id: number;
  ts: number;
  ok: number;
  status_code: number | null;
  latency_ms: number | null;
  error: string | null;
}

export interface AlertRow {
  id: number;
  monitor_id: number;
  ts: number;
  kind: AlertKind;
  message: string;
  acknowledged: number;
}

export interface MonitorExpected {
  selector?: string;
  text?: string;
}

/** 大模型渠道（网关 / 供应商）：共享 base_url + api_key */
export interface LlmChannelRow {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  enabled: number;
  created_at: number;
}

/** 渠道下的具体模型；巡检粒度在模型级 */
export interface LlmModelRow {
  id: number;
  channel_id: number;
  name: string;
  model: string;
  multimodal: number;
  is_analysis_active: number;
  monitor_enabled: number;
  probe_mode: LlmProbeMode | string;
  interval_sec: number;
  timeout_sec: number;
  slow_threshold_ms: number | null;
  expect_mode: ExpectMode | string;
  status: MonitorStatus | string;
  consecutive_fail: number;
  last_check_at: number | null;
  last_latency_ms: number | null;
  last_ttft_ms: number | null;
  last_tps: number | null;
  backoff_until: number | null;
  created_at: number;
}

export interface LlmCheckRow {
  id: number;
  model_id: number;
  ts: number;
  ok: number;
  status_code: number | null;
  latency_ms: number | null;
  ttft_ms: number | null;
  tps: number | null;
  completion_tokens: number | null;
  error: string | null;
}

export interface LlmAlertRow {
  id: number;
  model_id: number;
  ts: number;
  kind: AlertKind | string;
  message: string | null;
  acknowledged: number;
}
