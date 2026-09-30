import type { Browser, Page } from 'puppeteer-core';
import { db } from './db';
import { lenientFetch, isBrowserNetworkError } from './http';
import { getBrowser } from './obscura';
import { createLLMClient, extractJsonArrayVerbose, getActiveProfile, llmTimeoutMs } from './llm';
import { detectLoginPage, performSsoLogin, ssoConfigured, waitForRedirectSettle } from './sso';
import { injectTokenCookie } from './auth';
import { getSetting } from './settings';
import type { CandidateRow, SystemRow } from './types';

export type AnalysisStatus = 'pending' | 'running' | 'done' | 'failed';
export type AnalysisLevel = 'info' | 'success' | 'warn' | 'error';

export interface AnalysisEvent {
  ts: number;
  phase: string;
  level: AnalysisLevel;
  message: string;
  data?: unknown;
}

export interface AnalysisJob {
  status: AnalysisStatus;
  progress: string[];
  events: AnalysisEvent[];
  error: string | null;
  started_at: number;
  finished_at: number | null;
}

const jobs = new Map<number, AnalysisJob>();

interface CollectedApi {
  method: string;
  url: string;
}

interface PageSnapshot {
  url: string;
  title: string;
  load_ms: number;
  links: string[];
  apis: CollectedApi[];
  text: string;
}

/** 去掉 query string，把纯数字或 UUID 路径段替换为 {id} */
export function templatizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    const segs = u.pathname.split('/').map((s) => {
      if (/^\d+$/.test(s)) return '{id}';
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return '{id}';
      return s;
    });
    return u.origin + segs.join('/');
  } catch {
    return rawUrl;
  }
}

function isSameDomain(base: string, url: string): boolean {
  try {
    return new URL(url).hostname === new URL(base).hostname;
  } catch {
    return false;
  }
}

async function collectPage(page: Page, url: string, collectLinks: boolean, timeoutMs = 30_000): Promise<PageSnapshot> {
  const apiMap = new Map<string, CollectedApi>();
  const onRequest = (req: { method(): string; url(): string; resourceType(): string }) => {
    const rt = req.resourceType();
    if (rt !== 'xhr' && rt !== 'fetch') return;
    const item: CollectedApi = { method: req.method(), url: templatizeUrl(req.url()) };
    apiMap.set(`${item.method} ${item.url}`, item);
  };
  page.on('request', onRequest);
  try {
    const start = Date.now();
    await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
    const loadMs = Date.now() - start;
    // 给异步 XHR 一点时间
    await new Promise((r) => setTimeout(r, 2500));
    const title = await page.title().catch(() => '');
    const links = (collectLinks
      ? await page
          .evaluate(`(() => {
            const set = new Set();
            for (const a of Array.from(document.querySelectorAll('a[href]'))) {
              const href = a.href;
              if (/^https?:\\/\\//.test(href)) set.add(href);
            }
            return Array.from(set).slice(0, 50);
          })()`)
          .catch(() => [] as string[])
      : []) as string[];
    const text = (await page
      .evaluate(`(document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').trim().slice(0, 2000)`)
      .catch(() => '')) as string;
    return { url, title, load_ms: loadMs, links, apis: Array.from(apiMap.values()), text };
  } finally {
    page.off('request', onRequest);
  }
}

interface LLMCandidate {
  type: 'page' | 'api';
  url: string;
  method?: string;
  category: 'login' | 'home' | 'menu' | 'nav' | 'detail' | 'other';
  name: string;
  reason: string;
  importance: number;
}

/** 不依赖浏览器的降级抓取：直接取 HTML，用正则提取标题、链接和疑似接口路径 */
async function collectViaHttp(url: string, collectLinks: boolean, timeoutMs = 15_000): Promise<PageSnapshot> {
  const start = Date.now();
  const res = await lenientFetch(url, {
    timeoutMs,
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36' },
  });
  const html = await res.text();
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? '';
  const origin = new URL(url).origin;
  const links: string[] = [];
  if (collectLinks) {
    const seen = new Set<string>();
    for (const m of html.matchAll(/<a\s[^>]*href=["']([^"'#]+)["']/gi)) {
      try {
        const abs = new URL(m[1], url).href;
        if (/^https?:\/\//.test(abs) && !seen.has(abs)) {
          seen.add(abs);
          links.push(abs);
          if (links.length >= 50) break;
        }
      } catch {
        // 非法链接跳过
      }
    }
  }
  // 疑似接口：HTML/内联脚本里出现的绝对路径（>=2 段、无静态扩展名）
  const apiSet = new Set<string>();
  for (const m of html.matchAll(/["'`](\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_{}.-]+)+)["'`]/g)) {
    const p = m[1];
    if (/\.(js|css|png|jpe?g|gif|svg|ico|woff2?|ttf|map|html?)($|\?)/i.test(p)) continue;
    apiSet.add(`${origin}${p}`);
    if (apiSet.size >= 30) break;
  }
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
  return {
    url,
    title,
    load_ms: Date.now() - start,
    links,
    apis: Array.from(apiSet).map((u) => ({ method: 'GET', url: templatizeUrl(u) })),
    text,
  };
}

const VALID_TYPES = new Set(['page', 'api']);
const VALID_CATEGORIES = new Set(['login', 'home', 'menu', 'nav', 'detail', 'other']);

function normalizeCandidate(raw: unknown): LLMCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const url = typeof o.url === 'string' ? o.url : '';
  if (!url) return null;
  return {
    type: VALID_TYPES.has(String(o.type)) ? (o.type as 'page' | 'api') : 'page',
    url,
    method: typeof o.method === 'string' ? o.method.toUpperCase() : 'GET',
    category: VALID_CATEGORIES.has(String(o.category)) ? (o.category as LLMCandidate['category']) : 'other',
    name: typeof o.name === 'string' && o.name ? o.name : url,
    reason: typeof o.reason === 'string' ? o.reason : '',
    importance: Math.min(5, Math.max(1, Number(o.importance) || 3)),
  };
}

export function startAnalysis(systemId: number): AnalysisJob {
  const existing = jobs.get(systemId);
  if (existing && (existing.status === 'pending' || existing.status === 'running')) return existing;
  const job: AnalysisJob = { status: 'pending', progress: [], events: [], error: null, started_at: Date.now(), finished_at: null };
  jobs.set(systemId, job);
  void runAnalysis(systemId, job);
  return job;
}

export function getAnalysis(systemId: number): { job: AnalysisJob | null; candidates: CandidateRow[] } {
  const candidates = db
    .prepare('SELECT * FROM candidates WHERE system_id = ? ORDER BY llm_score DESC, id ASC')
    .all(systemId) as CandidateRow[];
  return { job: jobs.get(systemId) ?? null, candidates };
}

async function runAnalysis(systemId: number, job: AnalysisJob): Promise<void> {
  const emit = (phase: string, level: AnalysisLevel, message: string, data?: unknown) => {
    const event: AnalysisEvent = { ts: Date.now(), phase, level, message };
    if (data !== undefined) event.data = data;
    job.events.push(event);
    job.progress.push(message);
  };
  job.status = 'running';
  let phase = 'init';
  try {
    const system = db.prepare('SELECT * FROM systems WHERE id = ?').get(systemId) as SystemRow | undefined;
    if (!system) throw new Error('系统不存在');

    const llmProfile = getActiveProfile();
    if (!llmProfile || !llmProfile.api_key) throw new Error('未配置激活的 LLM 档案，请先到设置页添加并激活');

    emit('init', 'info', `开始分析 ${system.base_url}`);

    let browser: Browser;
    try {
      browser = await getBrowser();
    } catch (e) {
      throw new Error(`无法连接 obscura: ${e instanceof Error ? e.message : String(e)}`);
    }

    // ---- 主页 ----
    phase = 'navigate';
    const mainPage = await browser.newPage();
    let main: PageSnapshot;
    let screenshotBase64: string | null = null;
    let browserBroken = false;
    try {
      // 若系统配置了访问令牌（如 Admin-Token），先注入 cookie 再采集，直接拿到已认证内容
      if (system.auth_token) {
        await injectTokenCookie(mainPage, system.base_url, system.auth_token);
        emit('init', 'info', '已注入系统访问令牌（auth_token）');
      }
      main = await collectPage(mainPage, system.base_url, true);
      emit('navigate', 'success', `主页导航完成：「${main.title}」`, { url: main.url, title: main.title, load_ms: main.load_ms });

      // SSO：先等跳转链稳定，落在登录页且系统开启 use_sso 且已配置凭据时自动登录，成功后重新采集
      await waitForRedirectSettle(mainPage);
      if (await detectLoginPage(mainPage.url(), mainPage)) {
        emit('sso', 'info', '检测到统一身份认证登录页', { login_url: mainPage.url() });
        if (system.use_sso === 1 && ssoConfigured()) {
          const login = await performSsoLogin(mainPage, {
            username: getSetting('sso_username'),
            password: getSetting('sso_password'),
            emit,
          });
          if (login.ok) {
            main = await collectPage(mainPage, system.base_url, true);
            emit('navigate', 'success', `登录后重新导航完成：「${main.title}」`, { url: main.url, title: main.title, load_ms: main.load_ms });
          }
          // 登录失败：performSsoLogin 已 emit error，按未登录状态继续
        } else if (system.use_sso !== 1) {
          emit('sso', 'info', '检测到登录跳转，但该系统未启用 SSO，跳过自动登录', { login_url: mainPage.url() });
        } else {
          emit('sso', 'warn', '检测到登录跳转但未配置 SSO 凭据（请到设置页填写统一身份认证账号）');
        }
      }

      phase = 'extract';
      emit('extract', 'success', `提取到链接 ${main.links.length} 条、接口 ${main.apis.length} 个、正文 ${main.text.length} 字`, {
        links: main.links,
        apis: main.apis,
        text_len: main.text.length,
      });
      if (llmProfile.multimodal === 1) {
        phase = 'screenshot';
        // JPEG 压缩截图，避免大图拖慢多模态请求
        screenshotBase64 = await mainPage.screenshot({ encoding: 'base64', type: 'jpeg', quality: 60 }).catch(() => null);
        if (screenshotBase64) {
          emit('screenshot', 'success', '主页截图完成', { bytes: Math.floor((screenshotBase64.length * 3) / 4) });
        } else {
          emit('screenshot', 'warn', '主页截图失败，继续无图分析');
        }
      }
    } catch (e) {
      if (!isBrowserNetworkError(e)) throw e;
      // 浏览器（严格 HTTP 解析）打不开该站点，降级为宽松 HTTP 直接抓取
      browserBroken = true;
      emit('navigate', 'warn', `浏览器无法加载该站点（${e instanceof Error ? e.message : String(e)}）`, undefined);
      emit('navigate', 'info', '降级为直接 HTTP 抓取：只能发现页面链接和静态可见的接口路径，异步接口无法捕获，SSO 登录与截图跳过');
      main = await collectViaHttp(system.base_url, true);
      phase = 'extract';
      emit('extract', 'success', `HTTP 抓取完成：「${main.title}」，链接 ${main.links.length} 条、疑似接口 ${main.apis.length} 个、正文 ${main.text.length} 字`, {
        url: main.url,
        title: main.title,
        load_ms: main.load_ms,
        fallback: true,
      });
    } finally {
      await mainPage.close().catch(() => {});
    }

    // ---- 子页面（前 5 个同域链接，单个失败记 warn 继续）----
    phase = 'subpage';
    const subPages: PageSnapshot[] = [];
    const sameDomainLinks = main.links.filter((l) => isSameDomain(system.base_url, l)).slice(0, 5);
    const total = sameDomainLinks.length;
    for (let i = 0; i < total; i++) {
      const link = sameDomainLinks[i];
      // 浏览器已判定不可用时，子页面同样走宽松 HTTP 抓取
      const p = browserBroken ? null : await browser.newPage();
      try {
        const snap = p ? await collectPage(p, link, false, 10_000) : await collectViaHttp(link, false, 10_000);
        subPages.push(snap);
        emit('subpage', 'success', `子页面 ${link} 抓取完成`, {
          index: i + 1,
          total,
          url: link,
          ok: true,
          links_found: snap.links.length,
          apis_found: snap.apis.length,
        });
      } catch (e) {
        emit('subpage', 'warn', `子页面 ${link} 抓取失败（跳过）: ${e instanceof Error ? e.message : String(e)}`, {
          index: i + 1,
          total,
          url: link,
          ok: false,
          links_found: 0,
          apis_found: 0,
        });
      } finally {
        await p?.close().catch(() => {});
      }
    }

    // ---- LLM ----
    phase = 'llm';
    const allApis = new Map<string, CollectedApi>();
    for (const snap of [main, ...subPages]) {
      for (const api of snap.apis) allApis.set(`${api.method} ${api.url}`, api);
    }
    const payload = {
      base_url: system.base_url,
      title: main.title,
      links: main.links,
      apis: Array.from(allApis.values()),
      text_summary: main.text,
      sub_pages: subPages.map((s) => ({ url: s.url, title: s.title, apis: s.apis })),
    };

    const systemPrompt =
      '你是网站监控分析专家。用户会给你抓取到的某个 Web 系统的页面信息（标题、链接、XHR/fetch 接口、正文摘要、子页面）。' +
      '请从中挑出最值得监控的关键页面和接口，特别是登录、主页、菜单、导航、详情类。' +
      '只输出严格的 JSON，不要输出任何其他文字。格式为 {"candidates": [...]}，数组元素格式：' +
      '[{"type":"page"|"api","url":"...","method":"GET","category":"login"|"home"|"menu"|"nav"|"detail"|"other","name":"简短中文名","reason":"推荐理由","importance":1-5}]。' +
      'importance 1-5，5 为最重要。最多返回 15 条。';
    const userText = `系统主页：${system.base_url}\n抓取数据：\n${JSON.stringify(payload, null, 2)}`;

    emit('llm', 'info', `发起大模型请求（${llmProfile.name} / ${llmProfile.model}）`, {
      model: llmProfile.model,
      multimodal: llmProfile.multimodal === 1,
      prompt_chars: systemPrompt.length + userText.length,
      timeout_sec: Math.round(llmTimeoutMs() / 1000),
    });

    const client = createLLMClient(llmProfile);
    type Msg = { role: 'system' | 'user'; content: unknown };
    const messages: Msg[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content:
          llmProfile.multimodal === 1 && screenshotBase64
            ? [
                { type: 'text', text: userText + '\n附主页截图供参考。' },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${screenshotBase64}` } },
              ]
            : userText,
      },
    ];
    const llmStart = Date.now();
    // 429/5xx/网络错误按 15s、30s 退避重试；400 类错误说明模型不支持 response_format，降级后继续
    const isTransient = (e: unknown): boolean => {
      const status = (e as { status?: number })?.status;
      if (status === 429 || (status !== undefined && status >= 500)) return true;
      const msg = e instanceof Error ? e.message : String(e);
      return /timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed/i.test(msg);
    };
    let completion: Awaited<ReturnType<typeof client.chat.completions.create>> | null = null;
    let useFormat = true;
    let lastErr: unknown = null;
    for (let attempt = 1; attempt <= 3 && !completion; attempt++) {
      try {
        completion = await client.chat.completions.create({
          model: llmProfile.model,
          ...(useFormat ? { response_format: { type: 'json_object' as const } } : {}),
          messages: messages as never,
        });
      } catch (e) {
        lastErr = e;
        const msg = e instanceof Error ? e.message : String(e);
        const status = (e as { status?: number })?.status;
        if (useFormat && status !== undefined && status >= 400 && status < 500 && status !== 429) {
          useFormat = false;
          emit('llm', 'warn', `模型不支持 response_format（HTTP ${status}），降级为纯文本 JSON 继续`);
          continue;
        }
        if (attempt < 3 && isTransient(e)) {
          const waitSec = attempt * 15;
          emit('llm', 'warn', `大模型请求失败（${msg}），${waitSec} 秒后重试（第 ${attempt + 1}/3 次）`);
          await new Promise((r) => setTimeout(r, waitSec * 1000));
          continue;
        }
        if (useFormat) {
          useFormat = false;
          emit('llm', 'warn', `带 response_format 调用失败，降级重试: ${msg}`);
          continue;
        }
        throw e;
      }
    }
    if (!completion) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    const llmLatency = Date.now() - llmStart;
    const content = completion.choices[0]?.message?.content ?? '';

    phase = 'parse';
    const { items: rawItems, repaired } = extractJsonArrayVerbose(content);
    emit('llm', 'success', `大模型返回，原始结果 ${rawItems.length} 条`, {
      latency_ms: llmLatency,
      raw_count: rawItems.length,
      raw_excerpt: content.slice(0, 500),
    });

    const items = rawItems
      .map(normalizeCandidate)
      .filter((c): c is LLMCandidate => c !== null)
      .slice(0, 15);
    if (repaired) {
      emit('parse', 'warn', `模型输出非严格 JSON，已容错截取解析，有效候选 ${items.length} 条`, { parsed_count: items.length });
    } else {
      emit('parse', 'success', `JSON 解析完成，有效候选 ${items.length} 条`, { parsed_count: items.length });
    }

    phase = 'save';
    db.prepare('DELETE FROM candidates WHERE system_id = ?').run(systemId);
    const insert = db.prepare(
      'INSERT INTO candidates(system_id, type, url, method, title, category, reason, llm_score, selected, sample_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)',
    );
    const now = Date.now();
    for (const c of items) {
      insert.run(systemId, c.type, c.url, c.method ?? 'GET', c.name, c.category, c.reason, c.importance, now);
    }
    emit('save', 'success', `已写入 ${items.length} 条候选`, { count: items.length });

    job.status = 'done';
    emit('done', 'success', '分析完成', { candidate_count: items.length, duration_ms: Date.now() - job.started_at });
  } catch (e) {
    job.status = 'failed';
    job.error = e instanceof Error ? e.message : String(e);
    emit(phase, 'error', `分析失败: ${job.error}`);
  } finally {
    job.finished_at = Date.now();
  }
}
