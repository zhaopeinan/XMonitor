import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from './db';
import { checkObscuraHealth } from './obscura';
import { checkVmHealth, fetchProbeSeriesCount, vmEnabled, vmUrl, vmWriteQueueLength } from './vm';
import { wsClientCount } from './ws';

const STARTED_AT = Date.now();
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dataDir = path.join(rootDir, 'data');
const vmDataDir = path.join(rootDir, 'vm-data');

function fileSize(p: string): number | null {
  try {
    return fs.statSync(p).size;
  } catch {
    return null;
  }
}

function dirSizeBytes(dir: string, maxDepth = 4): number | null {
  try {
    if (!fs.existsSync(dir)) return null;
    let total = 0;
    const walk = (d: string, depth: number) => {
      if (depth < 0) return;
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, ent.name);
        try {
          if (ent.isDirectory()) walk(full, depth - 1);
          else if (ent.isFile()) total += fs.statSync(full).size;
        } catch {
          // skip unreadable
        }
      }
    };
    walk(dir, maxDepth);
    return total;
  } catch {
    return null;
  }
}

function count(sql: string): number {
  try {
    return (db.prepare(sql).get() as { n: number }).n;
  } catch {
    return 0;
  }
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
      /** 应用实际写入/查询的地址（容器内常为服务名） */
      url: string | null;
      /** 人类可读说明，例如「Docker 服务名（容器内）」 */
      url_note: string | null;
      /** 宿主机本机排查地址（若已映射），浏览器可打开 */
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

function describeVmUrl(url: string | null): { url_note: string | null; host_url: string | null } {
  if (!url) return { url_note: null, host_url: null };
  try {
    const u = new URL(url);
    // compose 服务名 / 容器名：仅在 Docker 网内可解析
    if (
      u.hostname === 'victoriametrics' ||
      u.hostname === 'xmonitor-vm' ||
      u.hostname.endsWith('.internal')
    ) {
      return {
        url_note: 'Docker 容器内地址（服务名），本机浏览器打不开属正常',
        host_url: `http://127.0.0.1:${u.port || '8428'}`,
      };
    }
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') {
      return { url_note: '本机回环地址', host_url: url };
    }
    return { url_note: '应用直连地址', host_url: null };
  } catch {
    return { url_note: null, host_url: null };
  }
}

export async function buildSystemStatus(): Promise<SystemStatusPayload> {
  const mem = process.memoryUsage();
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  const dbPath = path.join(dataDir, 'xmonitor.db');

  const [vmHealth, seriesCount, obscura] = await Promise.all([
    checkVmHealth(),
    vmEnabled() ? fetchProbeSeriesCount() : Promise.resolve(null),
    checkObscuraHealth(),
  ]);

  const vmOk = !vmEnabled() || vmHealth.ok;
  const overall: SystemStatusPayload['overall'] = !obscura.ok && !vmOk ? 'down' : !obscura.ok || !vmOk ? 'degraded' : 'ok';
  const url = vmUrl();
  const vmDesc = describeVmUrl(url);

  return {
    generated_at: Date.now(),
    process: {
      pid: process.pid,
      uptime_sec: Math.floor((Date.now() - STARTED_AT) / 1000),
      started_at: STARTED_AT,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      memory: {
        rss_mb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
        heap_used_mb: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
        heap_total_mb: Math.round((mem.heapTotal / 1024 / 1024) * 10) / 10,
        external_mb: Math.round((mem.external / 1024 / 1024) * 10) / 10,
      },
      loadavg: os.loadavg().map((v) => Math.round(v * 100) / 100),
      host_freemem_mb: Math.round(os.freemem() / 1024 / 1024),
      host_totalmem_mb: Math.round(os.totalmem() / 1024 / 1024),
    },
    components: {
      victoria_metrics: {
        enabled: vmEnabled(),
        url,
        url_note: vmDesc.url_note,
        host_url: vmDesc.host_url,
        ok: vmHealth.ok,
        error: vmHealth.error,
        series_count: seriesCount,
        write_queue: vmWriteQueueLength(),
        data_dir_bytes: dirSizeBytes(vmDataDir),
      },
      obscura: obscura,
      websocket: {
        clients: wsClientCount(),
      },
    },
    sqlite: {
      path: dbPath,
      db_bytes: fileSize(dbPath),
      wal_bytes: fileSize(`${dbPath}-wal`),
      shm_bytes: fileSize(`${dbPath}-shm`),
      data_dir_bytes: dirSizeBytes(dataDir),
      tables: {
        systems: count('SELECT COUNT(*) AS n FROM systems'),
        monitors: count('SELECT COUNT(*) AS n FROM monitors'),
        monitors_enabled: count('SELECT COUNT(*) AS n FROM monitors WHERE enabled = 1'),
        checks: count('SELECT COUNT(*) AS n FROM checks'),
        checks_24h: count(`SELECT COUNT(*) AS n FROM checks WHERE ts >= ${dayAgo}`),
        llm_channels: count('SELECT COUNT(*) AS n FROM llm_channels'),
        llm_models: count('SELECT COUNT(*) AS n FROM llm_models'),
        llm_models_monitored: count('SELECT COUNT(*) AS n FROM llm_models WHERE monitor_enabled = 1'),
        llm_checks: count('SELECT COUNT(*) AS n FROM llm_checks'),
        llm_checks_24h: count(`SELECT COUNT(*) AS n FROM llm_checks WHERE ts >= ${dayAgo}`),
        alerts_unacked: count('SELECT COUNT(*) AS n FROM alerts WHERE acknowledged = 0'),
        llm_alerts_unacked: count('SELECT COUNT(*) AS n FROM llm_alerts WHERE acknowledged = 0'),
        users: count('SELECT COUNT(*) AS n FROM users'),
      },
    },
    overall,
  };
}
