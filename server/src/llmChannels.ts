import { Router } from 'express';
import { db } from './db';
import { maskApiKey } from './settings';
import { probeLlmModel } from './llm';
import { fetchUpstreamModels } from './profiles';
import { buildChannelMetrics, parseMetricsRange } from './systemMetrics';
import { requireAnyPermission } from './users';
import type { ExpectMode, LlmChannelRow, LlmModelRow, LlmProbeMode } from './types';

export interface PublicLlmModel {
  id: number;
  channel_id: number;
  name: string;
  model: string;
  multimodal: number;
  monitor_enabled: number;
  probe_mode: string;
  interval_sec: number;
  timeout_sec: number;
  slow_threshold_ms: number | null;
  expect_mode: string;
  status: string;
  consecutive_fail: number;
  last_check_at: number | null;
  last_latency_ms: number | null;
  last_ttft_ms: number | null;
  last_tps: number | null;
  created_at: number;
}

export interface PublicLlmChannel {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  enabled: number;
  created_at: number;
  models: PublicLlmModel[];
}

function toPublicModel(row: LlmModelRow): PublicLlmModel {
  return {
    id: row.id,
    channel_id: row.channel_id,
    name: row.name,
    model: row.model,
    multimodal: row.multimodal,
    monitor_enabled: row.monitor_enabled,
    probe_mode: row.probe_mode || 'stream',
    interval_sec: row.interval_sec,
    timeout_sec: row.timeout_sec,
    slow_threshold_ms: row.slow_threshold_ms,
    expect_mode: row.expect_mode || 'up',
    status: row.status || 'unknown',
    consecutive_fail: row.consecutive_fail,
    last_check_at: row.last_check_at,
    last_latency_ms: row.last_latency_ms,
    last_ttft_ms: row.last_ttft_ms ?? null,
    last_tps: row.last_tps ?? null,
    created_at: row.created_at,
  };
}

function toPublicChannel(row: LlmChannelRow, models: LlmModelRow[]): PublicLlmChannel {
  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    api_key: maskApiKey(row.api_key),
    enabled: row.enabled,
    created_at: row.created_at,
    models: models.map(toPublicModel),
  };
}

function getChannel(id: number): LlmChannelRow | null {
  return (db.prepare('SELECT * FROM llm_channels WHERE id = ?').get(id) as LlmChannelRow | undefined) ?? null;
}

function getModel(id: number): LlmModelRow | null {
  return (db.prepare('SELECT * FROM llm_models WHERE id = ?').get(id) as LlmModelRow | undefined) ?? null;
}

function modelsOfChannel(channelId: number): LlmModelRow[] {
  return db.prepare('SELECT * FROM llm_models WHERE channel_id = ? ORDER BY id').all(channelId) as LlmModelRow[];
}

export const llmChannelsRouter = Router();

llmChannelsRouter.get('/llm-channels', (_req, res) => {
  const channels = db.prepare('SELECT * FROM llm_channels ORDER BY id').all() as LlmChannelRow[];
  res.json({
    channels: channels.map((c) => toPublicChannel(c, modelsOfChannel(c.id))),
  });
});

/** 凭 Base URL + API Key 从上游拉取模型列表（不落库） */
llmChannelsRouter.post(
  '/llm-channels/list-models',
  requireAnyPermission('systems.manage', 'settings.manage'),
  async (req, res) => {
    const b = req.body ?? {};
    const baseUrl = typeof b.base_url === 'string' ? b.base_url.trim() : '';
    let apiKey = typeof b.api_key === 'string' ? b.api_key : '';
    // 若传渠道 id 且 key 为打码，用库中真实 key
    if (Number(b.channel_id) > 0 && (!apiKey || apiKey.startsWith('****'))) {
      const ch = getChannel(Number(b.channel_id));
      if (ch) apiKey = ch.api_key;
    }
    const result = await fetchUpstreamModels(baseUrl, apiKey);
    if (!result.ok) return res.status(400).json(result);
    res.json(result);
  },
);

llmChannelsRouter.post('/llm-channels', requireAnyPermission('systems.manage', 'settings.manage'), (req, res) => {
  const b = req.body ?? {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const baseUrl = typeof b.base_url === 'string' ? b.base_url.trim() : '';
  if (!name || !baseUrl) return res.status(400).json({ error: 'name、base_url 必填' });
  const apiKey = typeof b.api_key === 'string' ? b.api_key : '';
  const info = db
    .prepare('INSERT INTO llm_channels(name, base_url, api_key, enabled, created_at) VALUES (?, ?, ?, 1, ?)')
    .run(name, baseUrl, apiKey, Date.now());
  const row = getChannel(Number(info.lastInsertRowid))!;
  res.status(201).json(toPublicChannel(row, []));
});

llmChannelsRouter.patch('/llm-channels/:id', requireAnyPermission('systems.manage', 'settings.manage'), (req, res) => {
  const id = Number(req.params.id);
  const row = getChannel(id);
  if (!row) return res.status(404).json({ error: '渠道不存在' });
  const b = req.body ?? {};
  const sets: string[] = [];
  const values: unknown[] = [];
  if (typeof b.name === 'string' && b.name.trim()) {
    sets.push('name = ?');
    values.push(b.name.trim());
  }
  if (typeof b.base_url === 'string' && b.base_url.trim()) {
    sets.push('base_url = ?');
    values.push(b.base_url.trim());
  }
  if (typeof b.api_key === 'string' && !b.api_key.startsWith('****')) {
    sets.push('api_key = ?');
    values.push(b.api_key);
  }
  if (typeof b.enabled === 'boolean' || b.enabled === 0 || b.enabled === 1) {
    sets.push('enabled = ?');
    values.push(b.enabled ? 1 : 0);
  }
  if (sets.length > 0) {
    db.prepare(`UPDATE llm_channels SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }
  res.json(toPublicChannel(getChannel(id)!, modelsOfChannel(id)));
});

llmChannelsRouter.delete('/llm-channels/:id', requireAnyPermission('systems.manage', 'settings.manage'), (req, res) => {
  const id = Number(req.params.id);
  const row = getChannel(id);
  if (!row) return res.status(404).json({ error: '渠道不存在' });
  db.prepare('DELETE FROM llm_channels WHERE id = ?').run(id);
  res.json({ ok: true });
});

llmChannelsRouter.post('/llm-channels/:id/models', requireAnyPermission('systems.manage', 'settings.manage'), (req, res) => {
  const channelId = Number(req.params.id);
  const channel = getChannel(channelId);
  if (!channel) return res.status(404).json({ error: '渠道不存在' });
  const b = req.body ?? {};
  const modelId = typeof b.model === 'string' ? b.model.trim() : '';
  const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim() : modelId;
  if (!modelId) return res.status(400).json({ error: 'model 必填' });
  const multimodal = b.multimodal ? 1 : 0;
  const probeMode: LlmProbeMode =
    b.probe_mode === 'models' || b.probe_mode === 'chat' || b.probe_mode === 'ping' || b.probe_mode === 'stream'
      ? b.probe_mode
      : 'stream';
  const intervalSec = Number(b.interval_sec) > 0 ? Math.min(3600, Math.max(30, Number(b.interval_sec))) : 300;
  const timeoutSec = Number(b.timeout_sec) > 0 ? Math.min(300, Math.max(5, Number(b.timeout_sec))) : 60;
  const monitorEnabled = b.monitor_enabled === false || b.monitor_enabled === 0 ? 0 : 1;

  // 同渠道同 model id 去重
  const exists = db
    .prepare('SELECT id FROM llm_models WHERE channel_id = ? AND model = ?')
    .get(channelId, modelId) as { id: number } | undefined;
  if (exists) return res.status(409).json({ error: `模型「${modelId}」已在该渠道下` });

  const info = db
    .prepare(
      `INSERT INTO llm_models(
        channel_id, name, model, multimodal, is_analysis_active, monitor_enabled,
        probe_mode, interval_sec, timeout_sec, expect_mode, status, consecutive_fail, created_at
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 'up', 'unknown', 0, ?)`,
    )
    .run(channelId, name, modelId, multimodal, monitorEnabled, probeMode, intervalSec, timeoutSec, Date.now());

  res.status(201).json(toPublicModel(getModel(Number(info.lastInsertRowid))!));
});

llmChannelsRouter.patch('/llm-models/:id', requireAnyPermission('systems.manage', 'settings.manage'), (req, res) => {
  const id = Number(req.params.id);
  const row = getModel(id);
  if (!row) return res.status(404).json({ error: '模型不存在' });
  const b = req.body ?? {};
  const sets: string[] = [];
  const values: unknown[] = [];

  if (typeof b.name === 'string' && b.name.trim()) {
    sets.push('name = ?');
    values.push(b.name.trim());
  }
  if (typeof b.model === 'string' && b.model.trim()) {
    sets.push('model = ?');
    values.push(b.model.trim());
  }
  if (typeof b.multimodal === 'boolean' || b.multimodal === 0 || b.multimodal === 1) {
    sets.push('multimodal = ?');
    values.push(b.multimodal ? 1 : 0);
  }
  if (typeof b.monitor_enabled === 'boolean' || b.monitor_enabled === 0 || b.monitor_enabled === 1) {
    sets.push('monitor_enabled = ?');
    values.push(b.monitor_enabled ? 1 : 0);
  }
  if (b.probe_mode === 'ping' || b.probe_mode === 'models' || b.probe_mode === 'chat' || b.probe_mode === 'stream') {
    sets.push('probe_mode = ?');
    values.push(b.probe_mode);
  }
  if (Number(b.interval_sec) > 0) {
    sets.push('interval_sec = ?');
    values.push(Math.min(3600, Math.max(30, Number(b.interval_sec))));
  }
  if (Number(b.timeout_sec) > 0) {
    sets.push('timeout_sec = ?');
    values.push(Math.min(300, Math.max(5, Number(b.timeout_sec))));
  }
  if (b.slow_threshold_ms === null) {
    sets.push('slow_threshold_ms = NULL');
  } else if (Number(b.slow_threshold_ms) > 0) {
    sets.push('slow_threshold_ms = ?');
    values.push(Math.round(Number(b.slow_threshold_ms)));
  }
  if (b.expect_mode === 'up' || b.expect_mode === 'down') {
    sets.push('expect_mode = ?');
    values.push(b.expect_mode as ExpectMode);
  }

  if (sets.length > 0) {
    db.prepare(`UPDATE llm_models SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }
  res.json(toPublicModel(getModel(id)!));
});

llmChannelsRouter.delete('/llm-models/:id', requireAnyPermission('systems.manage', 'settings.manage'), (req, res) => {
  const id = Number(req.params.id);
  const row = getModel(id);
  if (!row) return res.status(404).json({ error: '模型不存在' });
  db.prepare('DELETE FROM llm_models WHERE id = ?').run(id);
  res.json({ ok: true });
});

llmChannelsRouter.get('/llm-models/:id/checks', (req, res) => {
  const id = Number(req.params.id);
  const model = getModel(id);
  if (!model) return res.status(404).json({ error: '模型不存在' });
  const hours = Math.min(24 * 30, Math.max(1, Number(req.query.hours) || 24));
  const since = Date.now() - hours * 3600 * 1000;
  const checks = db
    .prepare('SELECT * FROM llm_checks WHERE model_id = ? AND ts >= ? ORDER BY ts ASC')
    .all(id, since);
  res.json({ checks });
});

llmChannelsRouter.get('/llm-channels/:id/metrics', async (req, res) => {
  const id = Number(req.params.id);
  const range = parseMetricsRange(req.query.range);
  try {
    const payload = await buildChannelMetrics(id, range);
    if (!payload) return res.status(404).json({ error: '渠道不存在' });
    res.json(payload);
  } catch (e) {
    res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

llmChannelsRouter.post('/llm-models/:id/test', requireAnyPermission('systems.manage', 'settings.manage'), async (req, res) => {
  const id = Number(req.params.id);
  const model = getModel(id);
  if (!model) return res.status(404).json({ ok: false, error: '模型不存在' });
  const channel = getChannel(model.channel_id);
  if (!channel) return res.status(404).json({ ok: false, error: '渠道不存在' });
  const result = await probeLlmModel(channel, model);
  res.json({
    ok: result.ok,
    latency_ms: result.latency_ms,
    ttft_ms: result.ttft_ms ?? null,
    tps: result.tps ?? null,
    completion_tokens: result.completion_tokens ?? null,
    error: result.error,
    status_code: result.status_code,
  });
});

llmChannelsRouter.post('/llm-channels/:id/test', requireAnyPermission('systems.manage', 'settings.manage'), async (req, res) => {
  const id = Number(req.params.id);
  const channel = getChannel(id);
  if (!channel) return res.status(404).json({ ok: false, error: '渠道不存在' });
  const fake: LlmModelRow = {
    id: 0,
    channel_id: id,
    name: channel.name,
    model: '',
    multimodal: 0,
    is_analysis_active: 0,
    monitor_enabled: 1,
    probe_mode: 'models',
    interval_sec: 120,
    timeout_sec: 30,
    slow_threshold_ms: null,
    expect_mode: 'up',
    status: 'unknown',
    consecutive_fail: 0,
    last_check_at: null,
    last_latency_ms: null,
    last_ttft_ms: null,
    last_tps: null,
    backoff_until: null,
    created_at: channel.created_at,
  };
  const result = await probeLlmModel(channel, fake);
  res.json({ ok: result.ok, latency_ms: result.latency_ms, error: result.error });
});
