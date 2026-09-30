import { Router } from 'express';
import { db } from './db';
import { getSetting, maskApiKey } from './settings';
import { testProfile } from './llm';
import { requirePermission } from './users';

export interface LLMProfileRow {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  multimodal: number;
  is_active: number;
  created_at: number;
}

export interface PublicLLMProfile {
  id: number;
  name: string;
  base_url: string;
  model: string;
  multimodal: number;
  is_active: number;
  api_key: string;
}

export function toPublicProfile(row: LLMProfileRow): PublicLLMProfile {
  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    model: row.model,
    multimodal: row.multimodal,
    is_active: row.is_active,
    api_key: maskApiKey(row.api_key),
  };
}

export function getActiveProfileRow(): LLMProfileRow | null {
  return (db.prepare('SELECT * FROM llm_profiles WHERE is_active = 1 ORDER BY id LIMIT 1').get() as LLMProfileRow | undefined) ?? null;
}

export function activateProfile(id: number): void {
  db.prepare('UPDATE llm_profiles SET is_active = 0').run();
  db.prepare('UPDATE llm_profiles SET is_active = 1 WHERE id = ?').run(id);
}

/** 迁移：llm_profiles 为空且旧 settings 里 llm_api_key 非空时，创建名为"默认"的档案并激活 */
function migrateLLMProfiles(): void {
  const count = (db.prepare('SELECT COUNT(*) AS c FROM llm_profiles').get() as { c: number }).c;
  if (count > 0) return;
  const oldKey = getSetting('llm_api_key');
  if (!oldKey) return;
  db.prepare(
    'INSERT INTO llm_profiles(name, base_url, api_key, model, multimodal, is_active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
  ).run(
    '默认',
    getSetting('llm_base_url') || 'https://api.openai.com/v1',
    oldKey,
    getSetting('llm_model') || 'gpt-4o-mini',
    getSetting('llm_multimodal') === 'true' ? 1 : 0,
    Date.now(),
  );
  console.log('[llm-profiles] 已从旧 settings 迁移出激活档案「默认」');
}

migrateLLMProfiles();

export const llmProfilesRouter = Router();

llmProfilesRouter.get('/llm-profiles', (_req, res) => {
  const rows = db.prepare('SELECT * FROM llm_profiles ORDER BY id').all() as LLMProfileRow[];
  res.json({ profiles: rows.map(toPublicProfile) });
});

llmProfilesRouter.post('/llm-profiles', requirePermission('settings.manage'), (req, res) => {
  const b = req.body ?? {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const baseUrl = typeof b.base_url === 'string' ? b.base_url.trim() : '';
  const model = typeof b.model === 'string' ? b.model.trim() : '';
  if (!name || !baseUrl || !model) return res.status(400).json({ error: 'name、base_url、model 必填' });
  const apiKey = typeof b.api_key === 'string' ? b.api_key : '';
  const multimodal = b.multimodal ? 1 : 0;
  const count = (db.prepare('SELECT COUNT(*) AS c FROM llm_profiles').get() as { c: number }).c;
  const isActive = count === 0 ? 1 : 0;
  const info = db
    .prepare('INSERT INTO llm_profiles(name, base_url, api_key, model, multimodal, is_active, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(name, baseUrl, apiKey, model, multimodal, isActive, Date.now());
  const row = db.prepare('SELECT * FROM llm_profiles WHERE id = ?').get(info.lastInsertRowid) as LLMProfileRow;
  res.status(201).json(toPublicProfile(row));
});

llmProfilesRouter.patch('/llm-profiles/:id', requirePermission('settings.manage'), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM llm_profiles WHERE id = ?').get(id) as LLMProfileRow | undefined;
  if (!row) return res.status(404).json({ error: '档案不存在' });
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
  if (typeof b.model === 'string' && b.model.trim()) {
    sets.push('model = ?');
    values.push(b.model.trim());
  }
  if (typeof b.multimodal === 'boolean' || b.multimodal === 0 || b.multimodal === 1) {
    sets.push('multimodal = ?');
    values.push(b.multimodal ? 1 : 0);
  }
  if (typeof b.api_key === 'string' && !b.api_key.startsWith('****')) {
    sets.push('api_key = ?');
    values.push(b.api_key);
  }
  if (sets.length === 0) return res.json(toPublicProfile(row));
  db.prepare(`UPDATE llm_profiles SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  res.json(toPublicProfile(db.prepare('SELECT * FROM llm_profiles WHERE id = ?').get(id) as LLMProfileRow));
});

llmProfilesRouter.delete('/llm-profiles/:id', requirePermission('settings.manage'), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM llm_profiles WHERE id = ?').get(id) as LLMProfileRow | undefined;
  if (!row) return res.status(404).json({ error: '档案不存在' });
  const wasActive = row.is_active === 1;
  db.prepare('DELETE FROM llm_profiles WHERE id = ?').run(id);
  if (wasActive) {
    const next = db.prepare('SELECT id FROM llm_profiles ORDER BY id LIMIT 1').get() as { id: number } | undefined;
    if (next) activateProfile(next.id);
  }
  res.json({ ok: true });
});

llmProfilesRouter.post('/llm-profiles/:id/activate', requirePermission('settings.manage'), (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM llm_profiles WHERE id = ?').get(id) as LLMProfileRow | undefined;
  if (!row) return res.status(404).json({ error: '档案不存在' });
  activateProfile(id);
  res.json(toPublicProfile({ ...row, is_active: 1 }));
});

llmProfilesRouter.post('/llm-profiles/test', requirePermission('settings.manage'), async (req, res) => {
  const profileId = req.body?.profile_id;
  let row: LLMProfileRow | null;
  if (profileId !== undefined && profileId !== null) {
    row = (db.prepare('SELECT * FROM llm_profiles WHERE id = ?').get(Number(profileId)) as LLMProfileRow | undefined) ?? null;
    if (!row) return res.status(404).json({ ok: false, error: '档案不存在' });
  } else {
    row = getActiveProfileRow();
    if (!row) return res.json({ ok: false, error: '未配置激活的 LLM 档案，请先到设置页添加并激活' });
  }
  res.json(await testProfile(row));
});

/** 预览拉取上游模型列表（不落库；用于监控向导勾选） */
export async function fetchUpstreamModels(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 20000,
): Promise<{ ok: boolean; models?: { id: string; owned_by?: string }[]; error?: string }> {
  if (!baseUrl.trim()) return { ok: false, error: 'base_url 必填' };
  if (!apiKey.trim()) return { ok: false, error: 'api_key 必填' };
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      return { ok: false, error: `上游返回 HTTP ${resp.status}${text ? `: ${text.slice(0, 200)}` : ''}` };
    }
    const data = (await resp.json()) as { data?: Array<{ id?: string; owned_by?: string }> };
    const list = Array.isArray(data?.data) ? data.data : [];
    const models = list
      .map((m) => ({ id: String(m.id ?? '').trim(), owned_by: m.owned_by }))
      .filter((m) => m.id)
      .sort((a, b) => a.id.localeCompare(b.id));
    return { ok: true, models };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg.includes('abort') ? '拉取超时' : msg };
  } finally {
    clearTimeout(timer);
  }
}
