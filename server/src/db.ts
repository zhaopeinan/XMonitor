import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataDir = path.join(rootDir, 'data');
fs.mkdirSync(dataDir, { recursive: true });

export const db: Database.Database = new Database(path.join(dataDir, 'xmonitor.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS systems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  use_sso INTEGER NOT NULL DEFAULT 1,
  auth_token TEXT,
  ops_unit TEXT NOT NULL DEFAULT '',
  created_by INTEGER,
  created_at INTEGER NOT NULL
);
-- 系统台账：资产登记，与监控系统（systems）独立，可选关联
CREATE TABLE IF NOT EXISTS system_ledgers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  ops_unit TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  external_access INTEGER NOT NULL DEFAULT 0,
  domain_applied INTEGER NOT NULL DEFAULT 0,
  domain TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  remark TEXT NOT NULL DEFAULT '',
  system_id INTEGER REFERENCES systems(id) ON DELETE SET NULL,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  url TEXT NOT NULL,
  method TEXT,
  title TEXT,
  category TEXT,
  reason TEXT,
  llm_score INTEGER,
  selected INTEGER NOT NULL DEFAULT 0,
  sample_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS monitors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  url TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'GET',
  headers TEXT,
  body TEXT,
  check_mode TEXT NOT NULL DEFAULT 'browser',
  expected_json TEXT,
  interval_sec INTEGER NOT NULL DEFAULT 60,
  timeout_sec INTEGER NOT NULL DEFAULT 15,
  enabled INTEGER NOT NULL DEFAULT 1,
  expect_mode TEXT NOT NULL DEFAULT 'up',
  status TEXT NOT NULL DEFAULT 'unknown',
  consecutive_fail INTEGER NOT NULL DEFAULT 0,
  last_check_at INTEGER,
  last_latency_ms INTEGER
);
CREATE TABLE IF NOT EXISTS checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  status_code INTEGER,
  latency_ms INTEGER,
  error TEXT
);
CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  message TEXT,
  acknowledged INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS llm_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  multimodal INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
-- 大模型监控：渠道（网关/供应商）→ 多模型
CREATE TABLE IF NOT EXISTS llm_channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  api_key TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS llm_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES llm_channels(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  multimodal INTEGER NOT NULL DEFAULT 0,
  is_analysis_active INTEGER NOT NULL DEFAULT 0,
  monitor_enabled INTEGER NOT NULL DEFAULT 1,
  probe_mode TEXT NOT NULL DEFAULT 'stream',
  interval_sec INTEGER NOT NULL DEFAULT 300,
  timeout_sec INTEGER NOT NULL DEFAULT 60,
  slow_threshold_ms INTEGER,
  expect_mode TEXT NOT NULL DEFAULT 'up',
  status TEXT NOT NULL DEFAULT 'unknown',
  consecutive_fail INTEGER NOT NULL DEFAULT 0,
  last_check_at INTEGER,
  last_latency_ms INTEGER,
  last_ttft_ms INTEGER,
  last_tps REAL,
  backoff_until INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS llm_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES llm_models(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  status_code INTEGER,
  latency_ms INTEGER,
  ttft_ms INTEGER,
  tps REAL,
  completion_tokens INTEGER,
  error TEXT
);
CREATE TABLE IF NOT EXISTS llm_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id INTEGER NOT NULL REFERENCES llm_models(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  message TEXT,
  acknowledged INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  disabled INTEGER NOT NULL DEFAULT 0,
  -- 所属运维单位：数据权限「仅本运维单位」按它比对台账与监控系统
  ops_unit TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  last_seen_at INTEGER
);
-- 身份与权限审计：登录、账号变更、角色权限、会话强制下线
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor_id INTEGER,
  actor_name TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_system_ledgers_system ON system_ledgers(system_id);
CREATE INDEX IF NOT EXISTS idx_checks_monitor_ts ON checks(monitor_id, ts);
CREATE INDEX IF NOT EXISTS idx_alerts_monitor_ts ON alerts(monitor_id, ts);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_id ON audit_logs(id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_llm_models_channel ON llm_models(channel_id);
CREATE INDEX IF NOT EXISTS idx_llm_checks_model_ts ON llm_checks(model_id, ts);
CREATE INDEX IF NOT EXISTS idx_llm_alerts_model_ts ON llm_alerts(model_id, ts);
`);

// 迁移：老库的 systems 表补 use_sso 列（已存在则跳过）
try {
  db.exec('ALTER TABLE systems ADD COLUMN use_sso INTEGER NOT NULL DEFAULT 1');
} catch {
  // duplicate column
}
try {
  db.exec('ALTER TABLE systems ADD COLUMN auth_token TEXT');
} catch {
  // duplicate column
}
try {
  db.exec("ALTER TABLE monitors ADD COLUMN expect_mode TEXT NOT NULL DEFAULT 'up'");
} catch {
  // duplicate column
}
for (const sql of [
  'ALTER TABLE llm_checks ADD COLUMN ttft_ms INTEGER',
  'ALTER TABLE llm_checks ADD COLUMN tps REAL',
  'ALTER TABLE llm_checks ADD COLUMN completion_tokens INTEGER',
  'ALTER TABLE llm_models ADD COLUMN last_ttft_ms INTEGER',
  'ALTER TABLE llm_models ADD COLUMN last_tps REAL',
  'ALTER TABLE llm_models ADD COLUMN backoff_until INTEGER',
  // 账号启用/停用、会话来源与活跃时间（老库补齐）
  'ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0',
  "ALTER TABLE sessions ADD COLUMN ip TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE sessions ADD COLUMN user_agent TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE sessions ADD COLUMN last_seen_at INTEGER',
  // 台账运维单位（老库补齐）
  "ALTER TABLE system_ledgers ADD COLUMN ops_unit TEXT NOT NULL DEFAULT ''",
  // 台账 HTTPS / 证书探测：supported 是结论（yes / no / unknown），cert_expires_at 是证书过期时间，
  // cert_evidence 是探测依据原文，https_checked_at 是最近一次探测时间
  "ALTER TABLE system_ledgers ADD COLUMN https_supported TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE system_ledgers ADD COLUMN cert_expires_at INTEGER',
  "ALTER TABLE system_ledgers ADD COLUMN cert_evidence TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE system_ledgers ADD COLUMN https_checked_at INTEGER',
  // 数据权限：账号所属运维单位，以及台账/监控系统的创建人（「仅本人创建」范围用）
  "ALTER TABLE users ADD COLUMN ops_unit TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE systems ADD COLUMN ops_unit TEXT NOT NULL DEFAULT ''",
  'ALTER TABLE systems ADD COLUMN created_by INTEGER',
  'ALTER TABLE system_ledgers ADD COLUMN created_by INTEGER',
]) {
  try {
    db.exec(sql);
  } catch {
    // duplicate column
  }
}

// 操作系统探测功能已下线：老库里把遗留的三列删掉（新库本来就没有，删不到会报错，忽略即可）
for (const sql of [
  'ALTER TABLE system_ledgers DROP COLUMN os',
  'ALTER TABLE system_ledgers DROP COLUMN os_evidence',
  'ALTER TABLE system_ledgers DROP COLUMN os_checked_at',
]) {
  try {
    db.exec(sql);
  } catch {
    // 列不存在，跳过
  }
}
