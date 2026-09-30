import { db } from './db';
import { getSetting } from './settings';
import { broadcast } from './ws';
import type { AlertKind, AlertRow, ExpectMode, MonitorRow, MonitorStatus } from './types';

const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

function lastAlertTs(monitorId: number, kind: AlertKind): number | null {
  const row = db
    .prepare('SELECT ts FROM alerts WHERE monitor_id = ? AND kind = ? ORDER BY ts DESC LIMIT 1')
    .get(monitorId, kind) as { ts: number } | undefined;
  return row?.ts ?? null;
}

async function sendWebhook(alert: AlertRow, monitor: MonitorRow, systemName: string): Promise<void> {
  const url = getSetting('webhook_url');
  if (!url) return;
  const template = getSetting('webhook_template') || 'generic';
  const title = `[XMonitor] ${alert.kind.toUpperCase()} - ${monitor.name}`;
  const mode = monitor.expect_mode === 'down' ? '反向' : '正向';
  const text = `系统: ${systemName}\n监控项: ${monitor.name} (${monitor.type} ${monitor.url})\n模式: ${mode}\n类型: ${alert.kind}\n时间: ${new Date(alert.ts).toLocaleString()}\n详情: ${alert.message ?? ''}`;
  let body: unknown;
  if (template === 'dingtalk' || template === 'wecom') {
    body = { msgtype: 'markdown', markdown: { title, text: `## ${title}\n\n${text.replace(/\n/g, '\n\n')}` } };
  } else {
    body = {
      source: 'xmonitor',
      alert,
      monitor: {
        id: monitor.id,
        name: monitor.name,
        type: monitor.type,
        url: monitor.url,
        expect_mode: monitor.expect_mode,
      },
      system: systemName,
    };
  }
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) console.error(`[webhook] ${template} 返回 ${resp.status}`);
  } catch (e) {
    console.error(`[webhook] 发送失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function createAlert(monitor: MonitorRow, kind: AlertKind, message: string): AlertRow | null {
  const now = Date.now();
  // 同一 monitor 同类告警冷却 5 分钟（恢复类不冷却）
  if (kind !== 'recovered' && kind !== 'secured') {
    const last = lastAlertTs(monitor.id, kind);
    if (last !== null && now - last < ALERT_COOLDOWN_MS) return null;
  }
  const info = db
    .prepare('INSERT INTO alerts(monitor_id, ts, kind, message, acknowledged) VALUES (?, ?, ?, ?, 0)')
    .run(monitor.id, now, kind, message);
  const alert = db.prepare('SELECT * FROM alerts WHERE id = ?').get(info.lastInsertRowid) as AlertRow;
  broadcast('alert', { ...alert, monitor_name: monitor.name, system_id: monitor.system_id });
  const system = db.prepare('SELECT name FROM systems WHERE id = ?').get(monitor.system_id) as { name: string } | undefined;
  void sendWebhook(alert, monitor, system?.name ?? '');
  return alert;
}

function expectModeOf(monitor: MonitorRow): ExpectMode {
  return monitor.expect_mode === 'down' ? 'down' : 'up';
}

/**
 * 状态迁移：
 * - 正向（expect up）：down/slow 告警，恢复 recovered
 * - 反向（expect down）：可达 → reachable 告警；不可达 → secured
 */
export function handleStatusTransition(
  monitor: MonitorRow,
  oldStatus: MonitorStatus,
  newStatus: MonitorStatus,
  detail: { latency_ms: number | null; error?: string; reachable?: boolean },
): void {
  broadcast('status', {
    monitor_id: monitor.id,
    system_id: monitor.system_id,
    status: newStatus,
    expect_mode: expectModeOf(monitor),
    last_check_at: Date.now(),
    last_latency_ms: detail.latency_ms,
  });
  if (oldStatus === newStatus) return;

  const reverse = expectModeOf(monitor) === 'down';
  if (reverse) {
    if (newStatus === 'down') {
      createAlert(
        monitor,
        'reachable',
        detail.error
          ? `反向监控：接口仍可访问（${detail.error}）`
          : `反向监控：接口仍可访问${detail.latency_ms != null ? `，延迟 ${detail.latency_ms}ms` : ''}`,
      );
    } else if (newStatus === 'up' && (oldStatus === 'down' || oldStatus === 'slow' || oldStatus === 'unknown')) {
      createAlert(monitor, 'secured', '反向监控：已按预期不可达');
    }
    return;
  }

  if (newStatus === 'down') {
    createAlert(monitor, 'down', detail.error ? `监控项不可用: ${detail.error}` : '监控项不可用');
  } else if (newStatus === 'slow') {
    createAlert(monitor, 'slow', `响应缓慢: ${detail.latency_ms ?? '?'}ms 超过阈值`);
  } else if (newStatus === 'up' && (oldStatus === 'down' || oldStatus === 'slow')) {
    createAlert(monitor, 'recovered', `恢复正常，延迟 ${detail.latency_ms ?? '?'}ms`);
  }
}
