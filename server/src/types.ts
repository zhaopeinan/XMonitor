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
  created_at: number;
}

export type UserRole = 'admin' | 'operator' | 'viewer';

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: UserRole;
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
