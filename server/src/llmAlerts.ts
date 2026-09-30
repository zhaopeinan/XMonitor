import { db } from './db';
import { getSetting } from './settings';
import { broadcast } from './ws';
import type { AlertKind, ExpectMode, LlmAlertRow, LlmChannelRow, LlmModelRow, MonitorStatus } from './types';

const ALERT_COOLDOWN_MS = 5 * 60 * 1000;

function lastLlmAlertTs(modelId: number, kind: AlertKind): number | null {
  const row = db
    .prepare('SELECT ts FROM llm_alerts WHERE model_id = ? AND kind = ? ORDER BY ts DESC LIMIT 1')
    .get(modelId, kind) as { ts: number } | undefined;
  return row?.ts ?? null;
}

async function sendLlmWebhook(
  alert: LlmAlertRow,
  model: LlmModelRow,
  channel: LlmChannelRow,
): Promise<void> {
  const url = getSetting('webhook_url');
  if (!url) return;
  const template = getSetting('webhook_template') || 'generic';
  const title = `[XMonitor][LLM] ${String(alert.kind).toUpperCase()} - ${model.name}`;
  const text = `渠道: ${channel.name}\n模型: ${model.name} (${model.model})\n端点: ${channel.base_url}\n类型: ${alert.kind}\n时间: ${new Date(alert.ts).toLocaleString()}\n详情: ${alert.message ?? ''}`;
  let body: unknown;
  if (template === 'dingtalk' || template === 'wecom') {
    body = { msgtype: 'markdown', markdown: { title, text: `## ${title}\n\n${text.replace(/\n/g, '\n\n')}` } };
  } else {
    body = {
      source: 'xmonitor',
      domain: 'llm',
      alert,
      channel: { id: channel.id, name: channel.name, base_url: channel.base_url },
      model: { id: model.id, name: model.name, model: model.model },
    };
  }
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) console.error(`[webhook][llm] ${template} 返回 ${resp.status}`);
  } catch (e) {
    console.error(`[webhook][llm] 发送失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function createLlmAlert(model: LlmModelRow, channel: LlmChannelRow, kind: AlertKind, message: string): LlmAlertRow | null {
  const now = Date.now();
  if (kind !== 'recovered' && kind !== 'secured') {
    const last = lastLlmAlertTs(model.id, kind);
    if (last !== null && now - last < ALERT_COOLDOWN_MS) return null;
  }
  const info = db
    .prepare('INSERT INTO llm_alerts(model_id, ts, kind, message, acknowledged) VALUES (?, ?, ?, ?, 0)')
    .run(model.id, now, kind, message);
  const alert = db.prepare('SELECT * FROM llm_alerts WHERE id = ?').get(info.lastInsertRowid) as LlmAlertRow;
  broadcast('alert', {
    ...alert,
    domain: 'llm',
    monitor_name: model.name,
    system_name: channel.name,
    channel_id: channel.id,
    model_id: model.id,
  });
  void sendLlmWebhook(alert, model, channel);
  return alert;
}

function expectModeOf(model: LlmModelRow): ExpectMode {
  return model.expect_mode === 'down' ? 'down' : 'up';
}

export function handleLlmStatusTransition(
  model: LlmModelRow,
  channel: LlmChannelRow,
  oldStatus: MonitorStatus,
  newStatus: MonitorStatus,
  detail: {
    latency_ms: number | null;
    ttft_ms?: number | null;
    tps?: number | null;
    error?: string;
    reachable?: boolean;
    slow_reason?: string;
  },
): void {
  broadcast('status', {
    domain: 'llm',
    model_id: model.id,
    channel_id: channel.id,
    status: newStatus,
    expect_mode: expectModeOf(model),
    last_check_at: Date.now(),
    last_latency_ms: detail.latency_ms,
    last_ttft_ms: detail.ttft_ms ?? null,
    last_tps: detail.tps ?? null,
  });
  if (oldStatus === newStatus) return;

  const reverse = expectModeOf(model) === 'down';
  if (reverse) {
    if (newStatus === 'down') {
      createLlmAlert(
        model,
        channel,
        'reachable',
        detail.error
          ? `[LLM] 反向：模型仍可调用（${detail.error}）`
          : `[LLM] 反向：模型仍可调用${detail.latency_ms != null ? `，延迟 ${detail.latency_ms}ms` : ''}`,
      );
    } else if (newStatus === 'up' && (oldStatus === 'down' || oldStatus === 'slow' || oldStatus === 'unknown')) {
      createLlmAlert(model, channel, 'secured', '[LLM] 反向：已按预期不可用');
    }
    return;
  }

  if (newStatus === 'down') {
    createLlmAlert(model, channel, 'down', detail.error ? `[LLM] 模型不可用: ${detail.error}` : '[LLM] 模型不可用');
  } else if (newStatus === 'slow') {
    const reason = detail.slow_reason || detail.error || `${detail.latency_ms ?? '?'}ms`;
    createLlmAlert(model, channel, 'slow', `[LLM] 响应缓慢: ${reason}`);
  } else if (newStatus === 'up' && (oldStatus === 'down' || oldStatus === 'slow')) {
    const bits = [`E2E ${detail.latency_ms ?? '?'}ms`];
    if (detail.ttft_ms != null) bits.push(`TTFT ${detail.ttft_ms}ms`);
    if (detail.tps != null) bits.push(`TPS ${detail.tps}`);
    createLlmAlert(model, channel, 'recovered', `[LLM] 恢复正常，${bits.join('，')}`);
  }
}
