import { db } from './db';

export const SETTING_DEFAULTS: Record<string, string> = {
  obscura_endpoint: 'ws://127.0.0.1:9222/devtools/browser',
  webhook_url: '',
  webhook_template: 'generic',
  default_interval_sec: '60',
  default_timeout_sec: '15',
  slow_threshold_ms: '3000',
  llm_timeout_sec: '3600',
  sso_enabled: 'false',
  sso_username: '',
  sso_password: '',
};

// GET 时需要打码、PUT 时传打码值保留原值的键
const SECRET_KEYS = new Set(['sso_password']);

const insertDefault = db.prepare('INSERT OR IGNORE INTO settings(key, value) VALUES (?, ?)');
for (const [k, v] of Object.entries(SETTING_DEFAULTS)) insertDefault.run(k, v);

/** 部署环境变量覆盖（如 Docker 内连 browserless） */
const ENV_OVERRIDES: Record<string, string> = {
  obscura_endpoint: 'XMONITOR_OBSCURA_ENDPOINT',
};

export function getSetting(key: string): string {
  const envName = ENV_OVERRIDES[key];
  if (envName) {
    const fromEnv = process.env[envName];
    if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  }
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? SETTING_DEFAULTS[key] ?? '';
}

export function getAllSettings(): Record<string, string> {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const out: Record<string, string> = { ...SETTING_DEFAULTS };
  for (const r of rows) if (r.key in SETTING_DEFAULTS) out[r.key] = r.value;
  return out;
}

export function maskApiKey(value: string): string {
  if (!value) return '';
  return '****' + value.slice(-4);
}

export function getMaskedSettings(): Record<string, string> {
  const all = getAllSettings();
  for (const k of SECRET_KEYS) all[k] = maskApiKey(all[k]);
  return all;
}

export function updateSettings(patch: Record<string, unknown>): void {
  const upsert = db.prepare(
    'INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  for (const [key, raw] of Object.entries(patch)) {
    if (!(key in SETTING_DEFAULTS)) continue;
    if (typeof raw !== 'string') continue;
    // 保密键传入打码值（****xxxx）时保留原值
    if (SECRET_KEYS.has(key) && raw.startsWith('****')) continue;
    upsert.run(key, raw);
  }
}
