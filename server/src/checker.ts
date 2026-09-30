import { db } from './db';
import { lenientFetch, isBrowserNetworkError } from './http';
import { getBrowser } from './obscura';
import { detectLoginPage, performSsoLogin, renewSystemToken, ssoConfigured, waitForRedirectSettle } from './sso';
import { getSystemToken, injectTokenCookie, tokenAuthHeaders } from './auth';
import { getSetting } from './settings';
import type { Page } from 'puppeteer-core';
import type { MonitorExpected, MonitorRow, SystemRow } from './types';

export interface CheckResult {
  ok: boolean;
  status_code: number | null;
  latency_ms: number;
  error?: string;
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function isGoodStatus(code: number | null): boolean {
  return code !== null && code >= 200 && code < 400;
}

function isAuthStatus(code: number | null): boolean {
  return code === 401 || code === 403;
}

/** 若依类后端的认证失败常以 HTTP 200 + {"code":401} 返回，需看响应体识别 */
function isAuthFailure(status: number | null, bodySnippet: string, useSso: boolean): boolean {
  if (isAuthStatus(status)) return true;
  if (!useSso) return false;
  return /"code"\s*:\s*"?40[13]"?/.test(bodySnippet);
}

function loadSystem(systemId: number): SystemRow | undefined {
  return db.prepare('SELECT * FROM systems WHERE id = ?').get(systemId) as SystemRow | undefined;
}

function tokenRenewEligible(system: SystemRow | undefined): system is SystemRow {
  return !!system && system.use_sso === 1 && ssoConfigured();
}

/** 认证失败时尝试自动续期 token；成功返回新 token，失败返回 null（60s 冷却，并发共享） */
async function tryRenewToken(system: SystemRow | undefined): Promise<string | null> {
  if (!tokenRenewEligible(system)) return null;
  const result = await renewSystemToken(system.id).catch(() => null);
  return result?.ok ? getSystemToken(system.id) : null;
}

/** 导航后若落在登录页且系统开启 SSO 且已配置凭据，先自动续期 token，失败再浏览器表单登录；返回 {didLogin, error} */
async function ssoLoginIfNeeded(
  m: MonitorRow,
  page: Page,
): Promise<{ didLogin: boolean; error?: string }> {
  const system = loadSystem(m.system_id);
  if (!system || system.use_sso !== 1 || !ssoConfigured()) return { didLogin: false };
  await waitForRedirectSettle(page);
  if (!(await detectLoginPage(page.url(), page))) return { didLogin: false };
  const newToken = await tryRenewToken(system);
  if (newToken) {
    await injectTokenCookie(page, system.base_url, newToken);
    return { didLogin: true };
  }
  const result = await performSsoLogin(page, {
    username: getSetting('sso_username'),
    password: getSetting('sso_password'),
  });
  if (!result.ok) {
    return { didLogin: false, error: result.message.startsWith('SSO 登录失败') ? result.message : `SSO 登录失败: ${result.message}` };
  }
  return { didLogin: true };
}

async function checkPageMonitor(m: MonitorRow, expected: MonitorExpected | null): Promise<CheckResult> {
  const start = Date.now();
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    const token = getSystemToken(m.system_id);
    if (token) await injectTokenCookie(page, m.url, token);
    let resp;
    try {
      resp = await page.goto(m.url, { timeout: m.timeout_sec * 1000, waitUntil: 'domcontentloaded' });
    } catch (e) {
      // 浏览器打不开（如目标站返回非法响应头）：降级为宽松 HTTP 探测状态
      if (!isBrowserNetworkError(e)) throw e;
      const headers: Record<string, string> = {};
      if (token) Object.assign(headers, tokenAuthHeaders(token));
      const res = await lenientFetch(m.url, { headers, timeoutMs: m.timeout_sec * 1000 });
      await res.text().catch(() => '');
      return {
        ok: isGoodStatus(res.status),
        status_code: res.status,
        latency_ms: Date.now() - start,
        error: isGoodStatus(res.status) ? undefined : `HTTP 状态码 ${res.status}`,
      };
    }
    const sso = await ssoLoginIfNeeded(m, page);
    if (sso.error) {
      return { ok: false, status_code: null, latency_ms: Date.now() - start, error: sso.error };
    }
    if (sso.didLogin) {
      resp = await page.goto(m.url, { timeout: m.timeout_sec * 1000, waitUntil: 'domcontentloaded' });
    }
    const statusCode = resp ? resp.status() : null;
    if (!isGoodStatus(statusCode)) {
      return { ok: false, status_code: statusCode, latency_ms: Date.now() - start, error: `HTTP 状态码 ${statusCode ?? '无响应'}` };
    }
    if (expected?.selector) {
      const el = await page.$(expected.selector).catch(() => null);
      if (!el) {
        return { ok: false, status_code: statusCode, latency_ms: Date.now() - start, error: `选择器 ${expected.selector} 不存在` };
      }
    }
    if (expected?.text) {
      const content = await page.content().catch(() => '');
      if (!content.includes(expected.text)) {
        return { ok: false, status_code: statusCode, latency_ms: Date.now() - start, error: `页面不包含文本 "${expected.text}"` };
      }
    }
    return { ok: true, status_code: statusCode, latency_ms: Date.now() - start };
  } finally {
    await page.close().catch(() => {});
  }
}

async function checkApiHttp(m: MonitorRow): Promise<CheckResult> {
  const start = Date.now();
  const doFetch = async (token: string | null) => {
    const headers = parseJson<Record<string, string>>(m.headers) ?? {};
    if (token) Object.assign(headers, tokenAuthHeaders(token));
    const method = (m.method || 'GET').toUpperCase();
    // 用宽松解析的 HTTP 客户端：部分老系统返回非法响应头（如 `Cache=Control`），
    // 标准 fetch 会整包拒收
    return lenientFetch(m.url, {
      method,
      headers,
      body: m.body && method !== 'GET' && method !== 'HEAD' ? m.body : undefined,
      timeoutMs: m.timeout_sec * 1000,
    });
  };
  try {
    const system = loadSystem(m.system_id);
    const useSso = system?.use_sso === 1;
    let resp = await doFetch(getSystemToken(m.system_id));
    let bodySnippet = await resp.text().catch(() => '');
    if (isAuthFailure(resp.status, bodySnippet.slice(0, 1000), useSso)) {
      const newToken = await tryRenewToken(system);
      if (newToken) {
        resp = await doFetch(newToken);
        bodySnippet = await resp.text().catch(() => '');
      }
    }
    const latency = Date.now() - start;
    if (!isGoodStatus(resp.status)) {
      return { ok: false, status_code: resp.status, latency_ms: latency, error: `HTTP 状态码 ${resp.status}` };
    }
    if (isAuthFailure(resp.status, bodySnippet.slice(0, 1000), useSso)) {
      return { ok: false, status_code: resp.status, latency_ms: latency, error: '认证失败（响应体 code 401/403），令牌续期未生效' };
    }
    return { ok: true, status_code: resp.status, latency_ms: latency };
  } catch (e) {
    return { ok: false, status_code: null, latency_ms: Date.now() - start, error: e instanceof Error ? e.message : String(e) };
  }
}

async function checkApiBrowser(m: MonitorRow): Promise<CheckResult> {
  const start = Date.now();
  const system = db.prepare('SELECT * FROM systems WHERE id = ?').get(m.system_id) as SystemRow | undefined;
  if (!system) return { ok: false, status_code: null, latency_ms: 0, error: '系统不存在' };
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    const token = getSystemToken(m.system_id);
    if (token) await injectTokenCookie(page, system.base_url, token);
    await page.goto(system.base_url, { timeout: m.timeout_sec * 1000, waitUntil: 'domcontentloaded' });
    const sso = await ssoLoginIfNeeded(m, page);
    if (sso.error) {
      return { ok: false, status_code: null, latency_ms: Date.now() - start, error: sso.error };
    }
    if (sso.didLogin) {
      await page.goto(system.base_url, { timeout: m.timeout_sec * 1000, waitUntil: 'domcontentloaded' });
    }
    const headers = parseJson<Record<string, string>>(m.headers) ?? {};
    const method = (m.method || 'GET').toUpperCase();
    const runFetch = (bearer: string | null) => {
      const reqHeaders = { ...headers };
      if (bearer) reqHeaders['Authorization'] = `Bearer ${bearer}`;
      const evaluated = page.evaluate(
        async (url: string, reqMethod: string, reqHeaders: Record<string, string>, reqBody: string | null) => {
          try {
            const resp = await fetch(url, {
              method: reqMethod,
              headers: reqHeaders,
              body: reqBody && reqMethod !== 'GET' && reqMethod !== 'HEAD' ? reqBody : undefined,
              credentials: 'include',
            });
            const text = await resp.text().catch(() => '');
            return { status: resp.status, snippet: text.slice(0, 1000), error: null as string | null };
          } catch (e) {
            return { status: null as number | null, snippet: '', error: String(e) };
          }
        },
        m.url,
        method,
        reqHeaders,
        m.body,
      );
      return Promise.race([
        evaluated,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('浏览器内 fetch 超时')), m.timeout_sec * 1000)),
      ]);
    };
    let result = await runFetch(token);
    if (isAuthFailure(result.status, result.snippet ?? '', system.use_sso === 1)) {
      const newToken = await tryRenewToken(system);
      if (newToken) {
        await injectTokenCookie(page, system.base_url, newToken);
        result = await runFetch(newToken);
      }
    }
    const latency = Date.now() - start;
    if (result.error) return { ok: false, status_code: result.status, latency_ms: latency, error: result.error };
    if (!isGoodStatus(result.status)) {
      return { ok: false, status_code: result.status, latency_ms: latency, error: `HTTP 状态码 ${result.status ?? '无响应'}` };
    }
    if (isAuthFailure(result.status, result.snippet ?? '', system.use_sso === 1)) {
      return { ok: false, status_code: result.status, latency_ms: latency, error: '认证失败（响应体 code 401/403），令牌续期未生效' };
    }
    return { ok: true, status_code: result.status, latency_ms: latency };
  } finally {
    await page.close().catch(() => {});
  }
}

export async function checkMonitor(m: MonitorRow): Promise<CheckResult> {
  const expected = parseJson<MonitorExpected>(m.expected_json);
  try {
    if (m.type === 'page') return await checkPageMonitor(m, expected);
    if (m.check_mode === 'browser') return await checkApiBrowser(m);
    return await checkApiHttp(m);
  } catch (e) {
    return { ok: false, status_code: null, latency_ms: 0, error: e instanceof Error ? e.message : String(e) };
  }
}
