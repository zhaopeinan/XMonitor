import crypto from 'node:crypto';

const CAPTCHA_TTL_MS = 5 * 60 * 1000;
const MAX_STORE = 5000;

interface CaptchaEntry {
  answer: string;
  expiresAt: number;
}

const store = new Map<string, CaptchaEntry>();

function purge(): void {
  const now = Date.now();
  for (const [id, e] of store) {
    if (e.expiresAt <= now) store.delete(id);
  }
  // 防止异常增长：丢掉最旧的一半
  if (store.size > MAX_STORE) {
    const keys = [...store.keys()].slice(0, Math.floor(store.size / 2));
    for (const k of keys) store.delete(k);
  }
}

/** 生成易辨认、排除易混淆字符的 4 位验证码 */
function randomCode(len = 4): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i]! % alphabet.length];
  return out;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildSvg(code: string): string {
  const w = 140;
  const h = 48;
  const noise: string[] = [];
  for (let i = 0; i < 6; i++) {
    const x1 = Math.floor(Math.random() * w);
    const y1 = Math.floor(Math.random() * h);
    const x2 = Math.floor(Math.random() * w);
    const y2 = Math.floor(Math.random() * h);
    noise.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#cbd5e1" stroke-width="1"/>`,
    );
  }
  for (let i = 0; i < 28; i++) {
    const cx = Math.floor(Math.random() * w);
    const cy = Math.floor(Math.random() * h);
    noise.push(`<circle cx="${cx}" cy="${cy}" r="1" fill="#94a3b8"/>`);
  }
  const chars = code.split('').map((ch, i) => {
    const x = 18 + i * 30;
    const y = 30 + Math.floor(Math.random() * 6) - 3;
    const rot = Math.floor(Math.random() * 30) - 15;
    return `<text x="${x}" y="${y}" font-size="24" font-family="ui-monospace,Menlo,monospace" font-weight="700" fill="#0f172a" transform="rotate(${rot} ${x} ${y})">${escapeXml(ch)}</text>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="100%" height="100%" fill="#f8fafc"/>
  ${noise.join('\n  ')}
  ${chars.join('\n  ')}
</svg>`;
}

export function createCaptcha(): { id: string; svg: string } {
  purge();
  const id = crypto.randomBytes(16).toString('hex');
  const answer = randomCode(4);
  store.set(id, { answer, expiresAt: Date.now() + CAPTCHA_TTL_MS });
  return { id, svg: buildSvg(answer) };
}

/** 校验并消费验证码（一次性） */
export function consumeCaptcha(id: string, code: string): boolean {
  purge();
  if (!id || !code) return false;
  const entry = store.get(id);
  store.delete(id);
  if (!entry || entry.expiresAt <= Date.now()) return false;
  return entry.answer.toUpperCase() === code.trim().toUpperCase();
}

// ---- 登录失败限流（按 IP） ----
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_LIMIT = 8;
const LOCK_MS = 15 * 60 * 1000;

interface FailState {
  count: number;
  windowStart: number;
  lockedUntil: number;
}

const fails = new Map<string, FailState>();

export function clientIp(req: { headers: Record<string, unknown>; socket?: { remoteAddress?: string } }): string {
  const xf = req.headers['x-forwarded-for'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0]!.trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

export function assertNotLocked(ip: string): { ok: true } | { ok: false; retryAfterSec: number } {
  const st = fails.get(ip);
  if (!st) return { ok: true };
  const now = Date.now();
  if (st.lockedUntil > now) {
    return { ok: false, retryAfterSec: Math.ceil((st.lockedUntil - now) / 1000) };
  }
  if (now - st.windowStart > FAIL_WINDOW_MS) {
    fails.delete(ip);
  }
  return { ok: true };
}

export function recordLoginFailure(ip: string): void {
  const now = Date.now();
  let st = fails.get(ip);
  if (!st || now - st.windowStart > FAIL_WINDOW_MS) {
    st = { count: 0, windowStart: now, lockedUntil: 0 };
  }
  st.count += 1;
  if (st.count >= FAIL_LIMIT) {
    st.lockedUntil = now + LOCK_MS;
    st.count = 0;
    st.windowStart = now;
  }
  fails.set(ip, st);
}

export function clearLoginFailures(ip: string): void {
  fails.delete(ip);
}
