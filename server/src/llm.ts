import OpenAI from 'openai';
import { db } from './db';
import { getSetting } from './settings';
import type { LlmChannelRow, LlmModelRow, LlmProbeMode } from './types';

export interface LLMProfileLike {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  multimodal: number;
}

/** 当前用于 AI 分析的激活档案（与监控渠道完全独立） */
export function getActiveProfile(): LLMProfileLike | null {
  return (
    (db.prepare('SELECT id, name, base_url, api_key, model, multimodal FROM llm_profiles WHERE is_active = 1 ORDER BY id LIMIT 1').get() as
      | LLMProfileLike
      | undefined) ?? null
  );
}

/** LLM 请求超时（毫秒），来自设置 llm_timeout_sec（秒），默认 3600，限制在 5s ~ 4h */
export function llmTimeoutMs(): number {
  const sec = Number(getSetting('llm_timeout_sec'));
  const clamped = Number.isFinite(sec) && sec > 0 ? Math.min(14400, Math.max(5, sec)) : 3600;
  return clamped * 1000;
}

export function createLLMClient(profile: LLMProfileLike, timeoutMs?: number): OpenAI {
  // 超时可配置（默认 3600s）；不再自动重试，避免长超时下等待时间翻倍，
  // 需要降级重试的场景由调用方显式处理
  return new OpenAI({
    baseURL: profile.base_url,
    apiKey: profile.api_key,
    timeout: timeoutMs ?? llmTimeoutMs(),
    maxRetries: 0,
  });
}

/** 从模型输出中容错提取 JSON 数组，并报告是否走了降级修复路径 */
export function extractJsonArrayVerbose(text: string): { items: unknown[]; repaired: boolean } {
  const trimmed = text.trim();
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return { items: parsed, repaired: false };
    if (parsed && typeof parsed === 'object') {
      for (const v of Object.values(parsed)) if (Array.isArray(v)) return { items: v, repaired: false };
    }
  } catch {
    // fall through
  }
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      if (Array.isArray(parsed)) return { items: parsed, repaired: true };
    } catch {
      // fall through
    }
  }
  throw new Error('无法从 LLM 输出中解析 JSON 数组');
}

/** 从模型输出中容错提取 JSON 数组 */
export function extractJsonArray(text: string): unknown[] {
  return extractJsonArrayVerbose(text).items;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** 用档案的真实 key 发一个极短 chat completion 测试连通性 */
export async function testProfile(profile: LLMProfileLike): Promise<{ ok: boolean; latency_ms?: number; error?: string }> {
  if (!profile.api_key) return { ok: false, error: `档案「${profile.name}」未配置 api_key` };
  const start = Date.now();
  try {
    const client = createLLMClient(profile);
    await client.chat.completions.create({
      model: profile.model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 5,
    });
    return { ok: true, latency_ms: Date.now() - start };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export interface LlmProbeResult {
  ok: boolean;
  status_code: number | null;
  /** 端到端耗时（ms） */
  latency_ms: number;
  /** 首 token 时间（仅 stream） */
  ttft_ms?: number | null;
  /** 吐字速度 tok/s（仅 stream） */
  tps?: number | null;
  completion_tokens?: number | null;
  /** 429 限流 */
  rate_limited?: boolean;
  error?: string;
}

const STREAM_PROMPT = '只输出：1 2 3 4 5 6 7 8 9 10。不要解释。';
const STREAM_MAX_TOKENS = 48;

/** 粗估 completion tokens（无 usage 时） */
function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) || []).join('').length;
  const rest = text.length - cjk;
  return Math.max(1, cjk + Math.ceil(rest / 4));
}

function statusFromError(msg: string): { status: number | null; rateLimited: boolean } {
  if (/\b429\b/.test(msg) || /rate.?limit/i.test(msg)) return { status: 429, rateLimited: true };
  const m = msg.match(/\b([45]\d{2})\b/);
  return { status: m ? Number(m[1]) : null, rateLimited: false };
}

/** 从流式 delta 提取可见文本（兼容 content / reasoning 模型） */
function deltaText(delta: unknown): string {
  if (!delta || typeof delta !== 'object') return '';
  const d = delta as Record<string, unknown>;
  const parts: string[] = [];
  for (const key of ['content', 'reasoning', 'reasoning_content', 'text']) {
    const v = d[key];
    if (typeof v === 'string' && v) parts.push(v);
  }
  return parts.join('');
}

function streamCreateArgs(modelId: string) {
  // 尽量关闭思考链，避免 max_tokens 被 reasoning 占满（各网关字段不一，多余字段通常被忽略）
  return {
    model: modelId,
    messages: [{ role: 'user' as const, content: STREAM_PROMPT }],
    max_tokens: STREAM_MAX_TOKENS,
    stream: true as const,
    temperature: 0,
    // OpenAI SDK 允许透传
    ...({
      thinking: { type: 'disabled' },
      enable_thinking: false,
      chat_template_kwargs: { enable_thinking: false },
    } as Record<string, unknown>),
  };
}

/**
 * 按探测模式巡检单个模型：
 * - models：仅 GET /v1/models
 * - ping：非流式短补全
 * - chat：非流式短问，要求非空
 * - stream：流式短补全，采集 TTFT / TPS（推荐默认）
 */
export async function probeLlmModel(channel: LlmChannelRow, model: LlmModelRow): Promise<LlmProbeResult> {
  if (!channel.api_key) {
    return { ok: false, status_code: null, latency_ms: 0, error: `渠道「${channel.name}」未配置 api_key` };
  }
  const mode = (model.probe_mode || 'stream') as LlmProbeMode;
  const timeoutMs = Math.max(5, Math.min(300, model.timeout_sec || (mode === 'stream' ? 60 : 30))) * 1000;
  const start = Date.now();

  try {
    if (mode === 'models') {
      const url = `${normalizeBaseUrl(channel.base_url)}/models`;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const resp = await fetch(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${channel.api_key}` },
          signal: ctrl.signal,
        });
        const latency = Date.now() - start;
        if (resp.status === 429) {
          return { ok: false, status_code: 429, latency_ms: latency, rate_limited: true, error: 'HTTP 429' };
        }
        if (!resp.ok) {
          return { ok: false, status_code: resp.status, latency_ms: latency, error: `HTTP ${resp.status}` };
        }
        return { ok: true, status_code: resp.status, latency_ms: latency };
      } finally {
        clearTimeout(timer);
      }
    }

    const profile: LLMProfileLike = {
      id: model.id,
      name: model.name,
      base_url: channel.base_url,
      api_key: channel.api_key,
      model: model.model,
      multimodal: model.multimodal,
    };
    const client = createLLMClient(profile, timeoutMs);

    if (mode === 'stream') {
      type StreamResult = AsyncIterable<{
        choices?: Array<{ delta?: unknown }>;
        usage?: { completion_tokens?: number | null } | null;
      }>;
      let stream: StreamResult;
      const baseArgs = streamCreateArgs(model.model);
      try {
        stream = (await client.chat.completions.create({
          ...baseArgs,
          stream_options: { include_usage: true },
        } as Parameters<typeof client.chat.completions.create>[0])) as unknown as StreamResult;
      } catch {
        stream = (await client.chat.completions.create({
          model: model.model,
          messages: [{ role: 'user', content: STREAM_PROMPT }],
          max_tokens: STREAM_MAX_TOKENS,
          stream: true,
          temperature: 0,
        })) as unknown as StreamResult;
      }

      let ttftMs: number | null = null;
      let text = '';
      let completionTokens: number | null = null;

      for await (const chunk of stream) {
        const piece = deltaText(chunk.choices?.[0]?.delta);
        if (piece) {
          if (ttftMs == null) ttftMs = Date.now() - start;
          text += piece;
        }
        const usage = chunk.usage;
        if (usage?.completion_tokens != null) {
          completionTokens = usage.completion_tokens;
        }
      }

      const e2e = Date.now() - start;
      if (ttftMs == null && completionTokens && completionTokens > 0) {
        ttftMs = e2e;
      }
      if (ttftMs == null) {
        return {
          ok: false,
          status_code: 200,
          latency_ms: e2e,
          ttft_ms: null,
          tps: null,
          completion_tokens: completionTokens,
          error: '流式响应未收到任何 token',
        };
      }
      const tokens = completionTokens && completionTokens > 0 ? completionTokens : estimateTokens(text);
      const decodeMs = Math.max(1, e2e - (ttftMs < e2e ? ttftMs : 0));
      const genMs = ttftMs < e2e ? decodeMs : Math.max(1, e2e);
      const tps = Math.round((tokens / (genMs / 1000)) * 10) / 10;
      if (!text.trim() && tokens <= 0) {
        return {
          ok: false,
          status_code: 200,
          latency_ms: e2e,
          ttft_ms: ttftMs,
          tps: null,
          completion_tokens: tokens,
          error: '模型返回空内容',
        };
      }
      return {
        ok: true,
        status_code: 200,
        latency_ms: e2e,
        ttft_ms: ttftMs,
        tps,
        completion_tokens: tokens,
      };
    }

    const completion = await client.chat.completions.create({
      model: model.model,
      messages: [{ role: 'user', content: mode === 'chat' ? '用一个词回答：你好' : 'ping' }],
      max_tokens: mode === 'chat' ? 32 : 5,
    });
    const latency = Date.now() - start;
    if (mode === 'chat') {
      const text = completion.choices?.[0]?.message?.content?.trim() ?? '';
      if (!text) {
        return { ok: false, status_code: 200, latency_ms: latency, error: '模型返回空内容' };
      }
    }
    return { ok: true, status_code: 200, latency_ms: latency };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const { status, rateLimited } = statusFromError(msg);
    return {
      ok: false,
      status_code: status,
      latency_ms: Date.now() - start,
      rate_limited: rateLimited,
      error: msg,
    };
  }
}

