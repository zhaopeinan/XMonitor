import { db } from './db';
import { checkMonitor } from './checker';
import { handleStatusTransition } from './alerts';
import { handleLlmStatusTransition } from './llmAlerts';
import { probeLlmModel, type LlmProbeResult } from './llm';
import { getSetting } from './settings';
import { writeProbe } from './vm';
import type { ExpectMode, LlmChannelRow, LlmModelRow, MonitorRow, MonitorStatus } from './types';

const SCAN_INTERVAL_MS = 5_000;
/** 业务 HTTP 监控并发 */
const MAX_MONITOR_CONCURRENCY = 5;
/** LLM 探测全局并发（控干扰） */
const MAX_LLM_CONCURRENCY = 2;
const FAIL_THRESHOLD = 2;
/** 默认 TTFT 慢阈值 */
const DEFAULT_TTFT_SLOW_MS = 5_000;
/** 默认最低吐字速度 */
const DEFAULT_TPS_MIN = 10;
const BACKOFF_CAP_MS = 30 * 60 * 1000;

let monitorRunning = 0;
let llmRunning = 0;
/** 渠道内串行：正在探测的 channel_id */
const llmChannelBusy = new Set<number>();
let timer: NodeJS.Timeout | null = null;

function expectModeOf(m: { expect_mode?: string | null }): ExpectMode {
  return m.expect_mode === 'down' ? 'down' : 'up';
}

function nextBackoffUntil(model: LlmModelRow, now: number): number {
  const base = Math.max(30, model.interval_sec || 300) * 1000;
  const prevRemain = model.backoff_until && model.backoff_until > now ? model.backoff_until - now : 0;
  const next = Math.min(BACKOFF_CAP_MS, Math.max(base * 2, prevRemain * 2 || base * 2));
  return now + next;
}

async function runCheck(m: MonitorRow): Promise<void> {
  const now = Date.now();
  let result;
  try {
    result = await checkMonitor(m);
  } catch (e) {
    result = { ok: false, status_code: null, latency_ms: 0, error: e instanceof Error ? e.message : String(e) };
  }

  const stillExists = db.prepare('SELECT 1 FROM monitors WHERE id = ?').get(m.id);
  if (!stillExists) return;

  try {
    db.prepare('INSERT INTO checks(monitor_id, ts, ok, status_code, latency_ms, error) VALUES (?, ?, ?, ?, ?, ?)').run(
      m.id,
      now,
      result.ok ? 1 : 0,
      result.status_code,
      result.latency_ms,
      result.error ?? null,
    );
  } catch (e) {
    console.warn(`[scheduler] 写入探测记录失败（monitor ${m.id}）: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  writeProbe({
    kind: 'monitor',
    id: m.id,
    parentId: m.system_id,
    ok: result.ok,
    latencyMs: result.latency_ms,
    tsMs: now,
  });

  const oldStatus = m.status;
  let newStatus: MonitorStatus = oldStatus;
  let consecutiveFail = m.consecutive_fail;
  const slowThreshold = Number(getSetting('slow_threshold_ms')) || 3000;
  const reverse = expectModeOf(m) === 'down';

  if (reverse) {
    if (result.ok) {
      consecutiveFail += 1;
      if (consecutiveFail >= FAIL_THRESHOLD) newStatus = 'down';
    } else {
      consecutiveFail = 0;
      newStatus = 'up';
    }
  } else if (result.ok) {
    consecutiveFail = 0;
    newStatus = result.latency_ms > slowThreshold ? 'slow' : 'up';
  } else {
    consecutiveFail += 1;
    if (consecutiveFail >= FAIL_THRESHOLD) newStatus = 'down';
  }

  try {
    db.prepare('UPDATE monitors SET status = ?, consecutive_fail = ?, last_check_at = ?, last_latency_ms = ? WHERE id = ?').run(
      newStatus,
      consecutiveFail,
      now,
      result.latency_ms,
      m.id,
    );

    handleStatusTransition({ ...m, status: newStatus, expect_mode: expectModeOf(m) }, oldStatus, newStatus, {
      latency_ms: result.latency_ms,
      error: result.error,
      reachable: result.ok,
    });
  } catch (e) {
    console.warn(`[scheduler] 更新监控状态失败（monitor ${m.id}）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function evaluateLlmSlow(
  model: LlmModelRow,
  result: LlmProbeResult,
): { slow: boolean; reason: string } {
  const globalSlow = Number(getSetting('slow_threshold_ms')) || 3000;
  const e2eThreshold = model.slow_threshold_ms && model.slow_threshold_ms > 0 ? model.slow_threshold_ms : globalSlow;
  const reasons: string[] = [];
  if (result.latency_ms > e2eThreshold) {
    reasons.push(`E2E ${result.latency_ms}ms > ${e2eThreshold}ms`);
  }
  if (result.ttft_ms != null && result.ttft_ms > DEFAULT_TTFT_SLOW_MS) {
    reasons.push(`TTFT ${result.ttft_ms}ms > ${DEFAULT_TTFT_SLOW_MS}ms`);
  }
  if (result.tps != null && result.tps < DEFAULT_TPS_MIN) {
    reasons.push(`TPS ${result.tps} < ${DEFAULT_TPS_MIN}`);
  }
  return { slow: reasons.length > 0, reason: reasons.join('；') };
}

async function runLlmCheck(model: LlmModelRow, channel: LlmChannelRow): Promise<void> {
  const now = Date.now();
  let result: LlmProbeResult;
  try {
    result = await probeLlmModel(channel, model);
  } catch (e) {
    result = { ok: false, status_code: null, latency_ms: 0, error: e instanceof Error ? e.message : String(e) };
  }

  const stillExists = db.prepare('SELECT 1 FROM llm_models WHERE id = ?').get(model.id);
  if (!stillExists) return;

  try {
    db.prepare(
      `INSERT INTO llm_checks(model_id, ts, ok, status_code, latency_ms, ttft_ms, tps, completion_tokens, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      model.id,
      now,
      result.ok ? 1 : 0,
      result.status_code,
      result.latency_ms,
      result.ttft_ms ?? null,
      result.tps ?? null,
      result.completion_tokens ?? null,
      result.error ?? null,
    );
  } catch (e) {
    console.warn(`[scheduler] 写入 LLM 探测失败（model ${model.id}）: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }

  writeProbe({
    kind: 'llm',
    id: model.id,
    parentId: channel.id,
    ok: result.ok,
    latencyMs: result.latency_ms,
    ttftMs: result.ttft_ms ?? undefined,
    tps: result.tps ?? undefined,
    tsMs: now,
  });

  const oldStatus = (model.status || 'unknown') as MonitorStatus;
  let newStatus: MonitorStatus = oldStatus;
  let consecutiveFail = model.consecutive_fail;
  const reverse = expectModeOf(model) === 'down';
  let slowReason = '';

  let backoffUntil: number | null = model.backoff_until && model.backoff_until > now ? model.backoff_until : null;
  if (result.rate_limited || result.status_code === 429) {
    backoffUntil = nextBackoffUntil(model, now);
    console.warn(
      `[scheduler] LLM 429 退避 model=${model.id} until=${new Date(backoffUntil).toISOString()}`,
    );
  } else if (result.ok) {
    backoffUntil = null;
  }

  if (reverse) {
    if (result.ok) {
      consecutiveFail += 1;
      if (consecutiveFail >= FAIL_THRESHOLD) newStatus = 'down';
    } else {
      consecutiveFail = 0;
      newStatus = 'up';
    }
  } else if (result.ok) {
    consecutiveFail = 0;
    const ev = evaluateLlmSlow(model, result);
    slowReason = ev.reason;
    newStatus = ev.slow ? 'slow' : 'up';
  } else {
    consecutiveFail += 1;
    if (consecutiveFail >= FAIL_THRESHOLD) newStatus = 'down';
  }

  try {
    db.prepare(
      `UPDATE llm_models SET status = ?, consecutive_fail = ?, last_check_at = ?, last_latency_ms = ?,
       last_ttft_ms = ?, last_tps = ?, backoff_until = ? WHERE id = ?`,
    ).run(
      newStatus,
      consecutiveFail,
      now,
      result.latency_ms,
      result.ttft_ms ?? null,
      result.tps ?? null,
      backoffUntil,
      model.id,
    );

    handleLlmStatusTransition({ ...model, status: newStatus, expect_mode: expectModeOf(model) }, channel, oldStatus, newStatus, {
      latency_ms: result.latency_ms,
      ttft_ms: result.ttft_ms ?? null,
      tps: result.tps ?? null,
      error: result.error || (newStatus === 'slow' ? slowReason : undefined),
      reachable: result.ok,
      slow_reason: slowReason || undefined,
    });
  } catch (e) {
    console.warn(`[scheduler] 更新 LLM 状态失败（model ${model.id}）: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function tick(): void {
  const now = Date.now();
  const dueMonitors = db
    .prepare(
      'SELECT * FROM monitors WHERE enabled = 1 AND (last_check_at IS NULL OR last_check_at + interval_sec * 1000 <= ?) ORDER BY last_check_at ASC',
    )
    .all(now) as MonitorRow[];

  const dueModels = db
    .prepare(
      `SELECT m.* FROM llm_models m
       JOIN llm_channels c ON c.id = m.channel_id
       WHERE c.enabled = 1 AND m.monitor_enabled = 1
         AND (m.backoff_until IS NULL OR m.backoff_until <= ?)
         AND (m.last_check_at IS NULL OR m.last_check_at + m.interval_sec * 1000 <= ?)
       ORDER BY m.last_check_at ASC`,
    )
    .all(now, now) as LlmModelRow[];

  for (const m of dueMonitors) {
    if (monitorRunning >= MAX_MONITOR_CONCURRENCY) break;
    monitorRunning += 1;
    void runCheck(m).finally(() => {
      monitorRunning -= 1;
    });
  }

  for (const model of dueModels) {
    if (llmRunning >= MAX_LLM_CONCURRENCY) break;
    if (llmChannelBusy.has(model.channel_id)) continue;
    const channel = db.prepare('SELECT * FROM llm_channels WHERE id = ?').get(model.channel_id) as
      | LlmChannelRow
      | undefined;
    if (!channel) continue;

    llmRunning += 1;
    llmChannelBusy.add(model.channel_id);
    void runLlmCheck(model, channel).finally(() => {
      llmRunning -= 1;
      llmChannelBusy.delete(model.channel_id);
    });
  }
}

export function startScheduler(): void {
  if (timer) return;
  timer = setInterval(() => {
    try {
      tick();
    } catch (e) {
      console.error(`[scheduler] tick 失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, SCAN_INTERVAL_MS);
  console.log(
    `[scheduler] 轮询引擎已启动（监控并发 ${MAX_MONITOR_CONCURRENCY}，LLM 并发 ${MAX_LLM_CONCURRENCY}，渠道内串行）`,
  );
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
