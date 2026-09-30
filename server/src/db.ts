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
  created_at INTEGER NOT NULL
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
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checks_monitor_ts ON checks(monitor_id, ts);
CREATE INDEX IF NOT EXISTS idx_alerts_monitor_ts ON alerts(monitor_id, ts);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
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
]) {
  try {
    db.exec(sql);
  } catch {
    // duplicate column
  }
}
