import type { Browser, Page } from 'puppeteer-core';
import { sm2 } from 'sm-crypto';
import { db } from './db';
import { lenientRequest, type LenientResponse } from './http';
import { getActiveProfile, createLLMClient } from './llm';
import { getSetting } from './settings';
import type { SystemRow } from './types';

export type SsoLevel = 'info' | 'success' | 'warn' | 'error';
export type SsoEmit = (phase: string, level: SsoLevel, message: string, data?: unknown) => void;
const noopEmit: SsoEmit = () => {};

// 旧 CAS(/auth/login) + 新统一身份认证(sso.bjtu.edu.cn/sso/login)
const LOGIN_URL_RE = /cas\.|sso\.bjtu\.edu\.cn|\/auth\/login|\/sso(?:\/|$|\?)|ids\.|authserver/i;
// 按优先级逐个尝试；不能用逗号合并选择器（querySelector 返回文档序第一个，logo 等含 "images" 的 src 会误命中）
const CAPTCHA_IMG_SELECTORS = ['img.captcha', 'img[src*="captcha" i]', 'img[src*="verify" i]', 'img[src*="image" i]'];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SSO_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const RENEW_UA = SSO_UA;

async function findCaptchaImg(page: Page) {
  for (const sel of CAPTCHA_IMG_SELECTORS) {
    const el = await page.$(sel).catch(() => null);
    if (el) return el;
  }
  return null;
}

export function ssoConfigured(): boolean {
  return getSetting('sso_enabled') === 'true' && !!getSetting('sso_username') && !!getSetting('sso_password');
}

/** URL 命中常见 SSO/CAS 登录路径，或页面含 password 输入框且正文稀少时判定为登录页 */
export async function detectLoginPage(url: string, page?: Page): Promise<boolean> {
  if (LOGIN_URL_RE.test(url)) return true;
  if (!page) return false;
  // evaluate 在页面导航中可能永不返回（obscura），加超时兜底
  const result = await Promise.race([
    page
      .evaluate(`(() => {
        const pw = document.querySelector('input[type=password]');
        if (!pw) return false;
        const textLen = (document.body ? document.body.innerText : '').replace(/\\s+/g, '').length;
        return textLen < 300;
      })()`)
      .catch(() => false),
    sleep(3000).then(() => false),
  ]);
  return !!result;
}

/**
 * 导航后等待可能的 SSO 跳转链完成：很多系统先返回自身页面再由 JS/慢速 302 跳到认证页，
 * domcontentloaded 后数秒跳转才发生。通过 framenavigated 事件观察（不在导航中调 evaluate，
 * 避免 CDP 调用挂死）；命中登录 URL 立即返回，导航静默约 2.5s 后返回。
 */
export async function waitForRedirectSettle(page: Page, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastNav = Date.now();
  const onNav = () => {
    lastNav = Date.now();
  };
  page.on('framenavigated', onNav);
  try {
    while (Date.now() < deadline) {
      await sleep(500);
      if (LOGIN_URL_RE.test(page.url())) return;
      if (Date.now() - lastNav < 3000) continue;
      // 导航静默 3s 后探测页面状态（带超时保护，避免导航途中 evaluate 挂死）
      const probe = (await Promise.race([
        page
          .evaluate(`(() => {
            return JSON.stringify({
              pwd: !!document.querySelector('input[type=password]'),
              nodes: document.querySelectorAll('*').length,
            });
          })()`)
          .catch(() => null),
        sleep(3000).then(() => null),
      ])) as string | null;
      const parsed = probe ? (JSON.parse(probe) as { pwd: boolean; nodes: number }) : null;
      if (parsed?.pwd) return; // 出现密码框：登录页
      // 真实内容页（DOM 节点多）才算落地；SPA 加载壳节点很少，继续等跳转
      if (parsed && parsed.nodes >= 300) return;
    }
  } finally {
    page.off('framenavigated', onNav);
  }
}

/** 用激活的多模态 LLM 档案识别验证码 */
export async function solveCaptcha(imageBase64: string): Promise<string> {
  const profile = getActiveProfile();
  if (!profile || !profile.api_key) throw new Error('未配置激活的 LLM 档案，请先到设置页添加并激活');
  if (profile.multimodal !== 1) throw new Error('当前激活的 LLM 档案未开启多模态，无法识别验证码');
  const client = createLLMClient(profile);
  // 推理模型（如 qwen3）会先在 reasoning 里消耗 token，max_tokens 给足避免截断后 content 为空
  const completion = await client.chat.completions.create({
    model: profile.model,
    max_tokens: 800,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '这是一张验证码图片，可能是算术题（如 9*4=）或字符。只回复验证码的答案本身（算术题回复计算结果的数字），不要任何其他文字。',
          },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${imageBase64}` } },
        ],
      },
    ],
  } as never);
  const text = completion.choices[0]?.message?.content ?? '';
  return text.trim().replace(/\s+/g, '');
}

/** 截验证码区域：元素截图 → boundingBox clip → 同会话 fetch img.src 转 base64 */
export async function captureCaptchaImage(page: Page): Promise<string | null> {
  const el = await findCaptchaImg(page);
  if (el) {
    try {
      return (await el.screenshot({ encoding: 'base64' })) as string;
    } catch {
      // obscura 上 elementHandle.screenshot 可能不可用，继续退化
    }
    try {
      const box = await el.boundingBox();
      if (box && box.width > 0 && box.height > 0) {
        return (await page.screenshot({ encoding: 'base64', clip: box })) as string;
      }
    } catch {
      // 继续退化
    }
  }
  try {
    const selectorExpr = JSON.stringify(CAPTCHA_IMG_SELECTORS);
    const src = await page.evaluate(`(() => {
      for (const sel of ${selectorExpr}) {
        const img = document.querySelector(sel);
        if (img) return img.src;
      }
      return null;
    })()`);
    if (typeof src !== 'string' || !src) return null;
    if (src.startsWith('data:image/')) return src.slice(src.indexOf('base64,') + 7);
    const b64 = await page.evaluate(`(async () => {
      const r = await fetch(${JSON.stringify(src)}, { credentials: 'include' });
      const buf = await r.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    })()`);
    return typeof b64 === 'string' && b64 ? b64 : null;
  } catch {
    return null;
  }
}

interface FillResult {
  username_found: boolean;
  password_found: boolean;
  captcha_found: boolean;
}

async function fillLoginForm(page: Page, username: string, password: string, captchaAnswer: string): Promise<FillResult> {
  const result = await page.evaluate(`(() => {
    const setVal = (el, v) => {
      el.focus();
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const pw = document.querySelector('input[type=password]');
    let un = document.querySelector('input[name="username"]')
      || document.querySelector('#id_loginname')
      || document.querySelector('input[name*="user" i]')
      || document.querySelector('input[name*="loginname" i]');
    if (!un && pw) {
      const inputs = Array.from(document.querySelectorAll('input'));
      const idx = inputs.indexOf(pw);
      for (let i = idx - 1; i >= 0; i--) {
        const t = (inputs[i].getAttribute('type') || 'text').toLowerCase();
        if (t === 'text' || t === 'email') { un = inputs[i]; break; }
      }
    }
    const cap = document.querySelector('input[name="captcha_1"]') || document.querySelector('input[name*="captcha" i]');
    if (un) setVal(un, ${JSON.stringify(username)});
    if (pw) setVal(pw, ${JSON.stringify(password)});
    if (cap) setVal(cap, ${JSON.stringify(captchaAnswer)});
    return { username_found: !!un, password_found: !!pw, captcha_found: !!cap };
  })()`);
  return (result as FillResult) ?? { username_found: false, password_found: false, captcha_found: false };
}

async function submitLoginForm(page: Page): Promise<void> {
  await page
    .evaluate(`(() => {
      const btn = document.querySelector('button[type=submit], .login-btn, input[type=submit], button[class*="login" i]');
      if (btn) { btn.click(); return 'click'; }
      const pw = document.querySelector('input[type=password]');
      const form = (pw && pw.form) || document.querySelector('form');
      if (form) { if (form.requestSubmit) form.requestSubmit(); else form.submit(); return 'submit'; }
      return 'none';
    })()`)
    .catch(() => {});
}

async function waitLeaveLoginPage(page: Page, timeoutMs: number): Promise<boolean> {
  const startUrl = page.url();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(500);
    const url = page.url();
    if (url !== startUrl && !LOGIN_URL_RE.test(url)) return true;
  }
  return false;
}

async function captchaImgSrc(page: Page): Promise<string | null> {
  const src = await page
    .evaluate(`(() => {
      for (const sel of ${JSON.stringify(CAPTCHA_IMG_SELECTORS)}) {
        const img = document.querySelector(sel);
        if (img) return img.src;
      }
      return null;
    })()`)
    .catch(() => null);
  return typeof src === 'string' ? src : null;
}

async function refreshCaptcha(page: Page): Promise<void> {
  const el = await findCaptchaImg(page);
  if (el) {
    const before = await captchaImgSrc(page);
    await el.click().catch(() => {});
    await sleep(1200);
    const after = await captchaImgSrc(page);
    // 部分主题没有接线点击刷新 JS（src 未变），退化为整页 reload 换取新验证码
    if (after && before !== after) return;
  }
  await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(500);
}

async function extractLoginError(page: Page): Promise<string> {
  const text = await page
    .evaluate(`(() => {
      const els = Array.from(document.querySelectorAll('.alert, .errorlist, [class*="error" i], [id*="error" i]'));
      const t = els.map((e) => (e.innerText || '').trim()).filter(Boolean).join('；');
      return t.slice(0, 200);
    })()`)
    .catch(() => '');
  return typeof text === 'string' ? text : '';
}

export interface SsoLoginOptions {
  username: string;
  password: string;
  emit?: SsoEmit;
  maxAttempts?: number;
}

export interface SsoLoginResult {
  ok: boolean;
  message: string;
  final_url: string;
}

// ---------- Node 层 HTTP 登录 ----------
// obscura 的合成表单提交（click/form.submit）不会真正发出 POST（实测 Network 无记录、页面无错误重渲染），
// 页面内 fetch 也存在 cookie/传输差异。对 django-simple-captcha 类表单（含 captcha_0），
// 改在 Node 层完成整个登录：GET 登录页 → 解析表单 → GET 验证码 → LLM 识别 → POST →
// 跟随 OAuth 重定向链（authorize → 系统 callback）收集各域 cookie → 全部回注 obscura。

class DomainCookies {
  private domains = new Map<string, Map<string, string>>();
  private jarFor(url: string): Map<string, string> {
    const host = new URL(url).host;
    if (!this.domains.has(host)) this.domains.set(host, new Map());
    return this.domains.get(host)!;
  }
  mergeFromResponse(url: string, res: { headers: Headers }) {
    const jar = this.jarFor(url);
    for (const c of res.headers.getSetCookie()) {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }
  mergePairs(url: string, pairs: [string, string][]) {
    const jar = this.jarFor(url);
    for (const [k, v] of pairs) jar.set(k, v);
  }
  header(url: string): string {
    return Array.from(this.jarFor(url))
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }
  byDomain(): [string, [string, string][]][] {
    return Array.from(this.domains.entries()).map(([host, m]) => [host, Array.from(m.entries())]);
  }
}

interface HttpFormSnapshot {
  action: string;
  fields: Record<string, string>;
  captcha0: string | null;
  captchaImg: string | null;
}

/** 新版统一身份认证（sso.bjtu.edu.cn）登录页解析结果 */
interface ModernSsoPage {
  flowId: string;
  pageName: string;
  sm2Enabled: boolean;
  sm2PublicKey: string | null;
  delegatorList: string[] | null;
  loginUserName: string;
  errorMsg: string;
  captchaType: string | null;
  actionPath: string;
}

function parseModernSsoHtml(html: string): ModernSsoPage | null {
  if (!/name="flowId"|loginType|sm2\.encrypt|ssoConfig/i.test(html)) return null;
  const flowId = html.match(/name="flowId"\s+value="([^"]*)"/i)?.[1] ?? '';
  const pageName = html.match(/var\s+pageName\s*=\s*"([^"]*)"/)?.[1] ?? 'login';
  const pub = html.match(/"publicKey"\s*:\s*"([^"]+)"/)?.[1]?.replace(/\\\//g, '/') ?? null;
  const sm2Enabled = /"sm2"\s*:\s*\{[^}]*"enabled"\s*:\s*true/i.test(html) || !!pub;
  let delegatorList: string[] | null = null;
  const dl = html.match(/var\s+delegatorList\s*=\s*(\[[\s\S]*?\]|null)\s*;/);
  if (dl?.[1] && dl[1] !== 'null') {
    try {
      delegatorList = JSON.parse(dl[1]) as string[];
    } catch {
      delegatorList = null;
    }
  }
  const loginUserName = html.match(/var\s+loginUserName\s*=\s*"([^"]*)"/)?.[1] ?? '';
  const errRaw = html.match(/var\s+error\s*=\s*(null|\{[\s\S]*?\})\s*;/)?.[1] ?? 'null';
  let errorMsg = '';
  let captchaType: string | null = null;
  if (errRaw !== 'null') {
    try {
      const err = JSON.parse(errRaw) as { msg?: string; data?: { captchaType?: string } | null };
      errorMsg = err.msg ?? '';
      captchaType = err.data?.captchaType ?? null;
    } catch {
      errorMsg = errRaw.slice(0, 120);
    }
  }
  const actionPath = html.match(/<form[^>]*\baction="([^"]*)"/i)?.[1] ?? '/sso/login';
  return {
    flowId,
    pageName,
    sm2Enabled,
    sm2PublicKey: pub,
    delegatorList,
    loginUserName,
    errorMsg,
    captchaType,
    actionPath,
  };
}

function isModernSsoHtml(html: string): boolean {
  return !!parseModernSsoHtml(html)?.flowId || /name="loginType"[\s\S]*username_password/i.test(html);
}

/** 与浏览器 sm2.min.js 包装一致：公钥 base64 → hex，密文 hex → base64，cipherMode=1 (C1C3C2) */
function encryptSm2Password(password: string, publicKeyB64: string): string {
  const pubHex = Buffer.from(publicKeyB64, 'base64').toString('hex');
  const cipherHex = sm2.doEncrypt(password, pubHex, 1);
  return Buffer.from(cipherHex, 'hex').toString('base64');
}

async function fetchPenggleCaptcha(
  origin: string,
  jar: DomainCookies,
): Promise<{ captchaId: string; imgB64: string } | null> {
  const url = `${origin}/api/captcha/getCaptcha?rnd=${Math.random()}`;
  try {
    const res = await httpFetch(url, { method: 'POST', headers: { Accept: 'application/json' } }, jar);
    const json = JSON.parse(await res.text()) as {
      code?: number;
      data?: { captchaId?: string; captchaImg?: string };
    };
    const id = json.data?.captchaId;
    let img = json.data?.captchaImg;
    if (!id || !img) return null;
    if (img.startsWith('data:image/')) img = img.slice(img.indexOf('base64,') + 7);
    return { captchaId: id, imgB64: img };
  } catch {
    return null;
  }
}

function buildModernLoginBody(
  page: ModernSsoPage,
  fields: {
    username?: string;
    password?: string;
    loginType?: string;
    captcha?: string;
    delegator?: string;
    pageFrom?: string;
  },
): string {
  return new URLSearchParams({
    username: fields.username ?? '',
    password: fields.password ?? '',
    loginType: fields.loginType ?? 'username_password',
    flowId: page.flowId,
    client_id: '',
    redirect_uri: '',
    response_type: '',
    scope: '',
    state: '',
    captcha: fields.captcha ?? '',
    delegator: fields.delegator ?? '',
    tokenCode: '',
    continue: '',
    asserts: '',
    pageFrom: fields.pageFrom ?? '',
    submit: '登录',
  }).toString();
}

/**
 * 新版统一身份认证 HTTP 登录：
 * GET 登录页 → SM2 加密密码 POST →（可选）身份选择 → 302 回业务系统。
 * 失败后若要求图片验证码，则拉 penggle 验证码 + LLM 识别后重试。
 */
async function modernSsoLoginHttp(
  loginUrl: string,
  jar: DomainCookies,
  username: string,
  password: string,
  emit: SsoEmit,
  maxAttempts = 3,
): Promise<{ ok: boolean; reason: string }> {
  const origin = new URL(loginUrl).origin;
  let lastReason = '';
  let needCaptcha = false;
  let captchaType: string | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let page: ModernSsoPage | null = null;
    let postUrl = loginUrl;
    try {
      const res = await httpFetch(loginUrl, { headers: { 'User-Agent': RENEW_UA, Referer: origin + '/' } }, jar);
      // 已有 SSO 会话时，访问登录页会直接 302 回业务系统
      if (res.status >= 300 && res.status < 400) {
        await res.arrayBuffer().catch(() => {});
        emit('sso', 'success', '统一身份认证登录成功（已有会话）', { attempt });
        return { ok: true, reason: '' };
      }
      const html = await res.text();
      page = parseModernSsoHtml(html);
      if (page) postUrl = new URL(page.actionPath || '/sso/login', loginUrl).toString();
      // 保留查询串（service / pageName），与浏览器提交一致
      if (!postUrl.includes('?') && loginUrl.includes('?')) {
        postUrl = postUrl + loginUrl.slice(loginUrl.indexOf('?'));
      }
    } catch (e) {
      lastReason = `获取登录页失败: ${e instanceof Error ? e.message : String(e)}`;
      emit('sso', 'warn', lastReason, { attempt });
      continue;
    }
    if (!page?.flowId) {
      lastReason = '登录页解析失败（非新版统一身份认证表单）';
      emit('sso', 'warn', lastReason, { attempt });
      return { ok: false, reason: lastReason };
    }
    if (!page.sm2PublicKey && page.sm2Enabled) {
      lastReason = '登录页未下发 SM2 公钥';
      emit('sso', 'error', lastReason);
      return { ok: false, reason: lastReason };
    }

    let captchaField = '';
    if (needCaptcha || (captchaType && /penggle|image/i.test(captchaType))) {
      const cap = await fetchPenggleCaptcha(origin, jar);
      if (!cap) {
        lastReason = '获取验证码失败';
        emit('sso', 'warn', lastReason, { attempt });
        continue;
      }
      try {
        const answer = await solveCaptcha(cap.imgB64);
        emit('sso', 'info', `识别验证码: ${answer}`, { attempt, answer });
        captchaField = JSON.stringify({ captchaId: cap.captchaId, captchaValue: answer });
      } catch (e) {
        lastReason = `验证码识别失败: ${e instanceof Error ? e.message : String(e)}`;
        emit('sso', 'warn', `${lastReason}，重试`, { attempt });
        continue;
      }
    }

    let encPassword = password;
    if (page.sm2PublicKey) {
      try {
        encPassword = encryptSm2Password(password, page.sm2PublicKey);
      } catch (e) {
        lastReason = `SM2 加密失败: ${e instanceof Error ? e.message : String(e)}`;
        emit('sso', 'error', lastReason);
        return { ok: false, reason: lastReason };
      }
    }

    emit('sso', 'info', '登录提交', { attempt });
    try {
      const res = await httpFetch(
        postUrl,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': RENEW_UA,
            Referer: loginUrl,
            Origin: origin,
          },
          body: buildModernLoginBody(page, {
            username,
            password: encPassword,
            loginType: 'username_password',
            captcha: captchaField,
            pageFrom: 'login',
          }),
        },
        jar,
      );

      // 直接 302 回业务系统
      if (res.status >= 300 && res.status < 400) {
        await res.arrayBuffer().catch(() => {});
        emit('sso', 'success', '统一身份认证登录成功', { attempt });
        return { ok: true, reason: '' };
      }

      const html = await res.text();
      const next = parseModernSsoHtml(html);

      // 多身份选择
      if (next?.pageName === 'select' && next.delegatorList?.length) {
        const delegator = next.delegatorList.includes(username)
          ? username
          : (next.loginUserName && next.delegatorList.includes(next.loginUserName)
              ? next.loginUserName
              : next.delegatorList[0]);
        emit('sso', 'info', `选择登录身份: ${delegator}`, { attempt, delegatorList: next.delegatorList });
        const selRes = await httpFetch(
          postUrl,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': RENEW_UA,
              Referer: loginUrl,
              Origin: origin,
            },
            body: buildModernLoginBody(next, {
              username: next.loginUserName || username,
              loginType: 'username_password',
              delegator,
              pageFrom: 'select',
            }),
          },
          jar,
        );
        if (selRes.status >= 300 && selRes.status < 400) {
          await selRes.arrayBuffer().catch(() => {});
          emit('sso', 'success', '统一身份认证登录成功', { attempt });
          return { ok: true, reason: '' };
        }
        const selHtml = await selRes.text();
        const selPage = parseModernSsoHtml(selHtml);
        lastReason = selPage?.errorMsg || `身份选择后仍停留在 ${selPage?.pageName || '未知'} 页`;
        if (selPage?.pageName === 'mfa') {
          lastReason = '需要双因子认证（短信/TOTP/网证），当前自动化不支持';
          emit('sso', 'error', lastReason);
          return { ok: false, reason: lastReason };
        }
        emit('sso', 'warn', `登录未完成（${lastReason}），重试`, { attempt });
        continue;
      }

      if (next?.pageName === 'mfa') {
        lastReason = '需要双因子认证（短信/TOTP/网证），当前自动化不支持';
        emit('sso', 'error', lastReason);
        return { ok: false, reason: lastReason };
      }

      lastReason = next?.errorMsg || `服务器返回 ${res.status}，仍在登录页`;
      if (next?.captchaType) {
        needCaptcha = true;
        captchaType = next.captchaType;
      } else if (/验证码|captcha/i.test(lastReason)) {
        needCaptcha = true;
      }
      emit('sso', 'warn', `登录被拒（${lastReason}），重试`, { attempt });
    } catch (e) {
      lastReason = `登录请求失败: ${e instanceof Error ? e.message : String(e)}`;
      emit('sso', 'warn', `${lastReason}，重试`, { attempt });
    }
  }
  return { ok: false, reason: lastReason || '登录失败' };
}

function parseLoginHtml(html: string, pageUrl: string): HttpFormSnapshot | null {
  // 页面可能有多个表单（语言切换、搜索等），优先取包含密码/验证码字段的登录表单
  const forms = html.match(/<form[^>]*>/gi) ?? [];
  let formTag: string | null = null;
  for (const m of html.matchAll(/<form[^>]*>[\s\S]*?<\/form>/gi)) {
    if (/type="password"|captcha_0|loginname|password/i.test(m[0])) {
      formTag = m[0].match(/<form[^>]*>/i)?.[0] ?? null;
      break;
    }
  }
  if (!formTag) formTag = forms[0] ?? null;
  if (!formTag) return null;
  const actionMatch = formTag.match(/action="([^"]*)"/i);
  const action = actionMatch ? new URL(actionMatch[1], pageUrl).toString() : pageUrl;
  const fields: Record<string, string> = {};
  for (const m of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0];
    const name = tag.match(/name="([^"]*)"/i)?.[1];
    if (!name) continue;
    const value = tag.match(/value="([^"]*)"/i)?.[1] ?? '';
    fields[name] = value;
  }
  let captchaImg: string | null = null;
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    if (/class="[^"]*captcha/i.test(m[0])) {
      const src = m[0].match(/src="([^"]*)"/i)?.[1];
      if (src) captchaImg = new URL(src, pageUrl).toString();
      break;
    }
  }
  return { action, fields, captcha0: fields['captcha_0'] ?? null, captchaImg };
}

function fillCredentialFields(fields: Record<string, string>, username: string, password: string, captchaAnswer: string) {
  const out = { ...fields };
  let hasUser = false;
  let hasPass = false;
  for (const k of Object.keys(out)) {
    if (/loginname|username|user/i.test(k)) { out[k] = username; hasUser = true; }
    else if (/password/i.test(k)) { out[k] = password; hasPass = true; }
  }
  if (!hasUser) out['loginname'] = username;
  if (!hasPass) out['password'] = password;
  if ('captcha_1' in out) out['captcha_1'] = captchaAnswer;
  return out;
}

function extractHtmlError(html: string): string {
  const pick = (re: RegExp) => {
    const m = html.match(re);
    return m ? m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
  };
  return pick(/<ul class="errorlist[^"]*">([\s\S]*?)<\/ul>/i) || pick(/<p class="tishi">([\s\S]*?)<\/p>/i) || '';
}

async function httpFetch(url: string, init: RequestInit, jar: DomainCookies, timeoutMs = 15_000): Promise<LenientResponse> {
  // 用宽松解析的 HTTP 客户端：部分老系统返回非法响应头（如 `Cache=Control`），标准 fetch 会整包拒收
  const headers = new Headers(init.headers);
  const ch = jar.header(url);
  if (ch) headers.set('cookie', ch);
  const res = await lenientRequest(url, {
    method: init.method ?? 'GET',
    headers,
    body: init.body == null ? undefined : String(init.body),
    timeoutMs,
  });
  jar.mergeFromResponse(url, res);
  return res;
}

/** 把认证后的各域 cookie 回注 obscura 浏览器，后续页面导航即带登录态 */
async function injectCookies(page: Page, jar: DomainCookies): Promise<void> {
  const client = await page.createCDPSession();
  for (const [host, pairs] of jar.byDomain()) {
    const cookies = pairs.map(([name, value]) => ({ name, value, url: `https://${host}` }));
    await client.send('Network.setCookies', { cookies }).catch(() => {});
  }
}

/** 以当前页面 cookie 为种子建 jar，供 Node 层 HTTP 登录后回注浏览器 */
async function jarFromPage(page: Page, origin: string): Promise<DomainCookies> {
  const jar = new DomainCookies();
  try {
    const client = await page.createCDPSession();
    const ck = (await client.send('Network.getCookies', { urls: [origin] })) as {
      cookies?: { name: string; value: string }[];
    };
    jar.mergePairs(
      origin,
      (ck.cookies ?? []).map((c) => [c.name, c.value]),
    );
  } catch {
    // 空 jar 起步
  }
  return jar;
}

/** 登录成功后跟随重定向链，把沿途 cookie 回注浏览器 */
async function followRedirectsAndInject(
  page: Page,
  jar: DomainCookies,
  startUrl: string,
  location: string | null,
  emit: SsoEmit,
): Promise<void> {
  let current = location ?? '';
  let hops = 0;
  while (current && hops < 8) {
    hops++;
    const next = new URL(current, startUrl).toString();
    emit('sso', 'info', `跟随重定向链 (${hops})`, { url: next });
    try {
      const hop = await httpFetch(next, { headers: { 'User-Agent': SSO_UA, Referer: startUrl } }, jar);
      if (hop.status >= 300 && hop.status < 400 && hop.headers.get('location')) {
        current = hop.headers.get('location')!;
        await hop.arrayBuffer().catch(() => {});
      } else {
        await hop.arrayBuffer().catch(() => {});
        break;
      }
    } catch {
      break;
    }
  }
  await injectCookies(page, jar).catch(() => {});
}

async function performModernSsoLoginHttp(page: Page, opts: SsoLoginOptions, emit: SsoEmit): Promise<SsoLoginResult> {
  const loginUrl = page.url();
  const origin = new URL(loginUrl).origin;
  const jar = await jarFromPage(page, origin);
  const result = await modernSsoLoginHttp(loginUrl, jar, opts.username, opts.password, emit, opts.maxAttempts ?? 3);
  if (!result.ok) {
    const msg = `SSO 登录失败: ${result.reason}`;
    emit('sso', 'error', msg, { reason: result.reason });
    return { ok: false, message: msg, final_url: page.url() };
  }
  // 再走一遍 authorize/业务回调链，收集业务域 cookie
  try {
    const probe = await httpFetch(loginUrl, { headers: { 'User-Agent': SSO_UA } }, jar);
    const loc = probe.headers.get('location');
    if (probe.status >= 300 && probe.status < 400 && loc) {
      await followRedirectsAndInject(page, jar, loginUrl, loc, emit);
    } else {
      await probe.arrayBuffer().catch(() => {});
      await injectCookies(page, jar).catch(() => {});
    }
  } catch {
    await injectCookies(page, jar).catch(() => {});
  }
  emit('sso', 'success', 'SSO 登录成功', { final_url: page.url() });
  return { ok: true, message: 'SSO 登录成功', final_url: page.url() };
}

async function performDjangoSsoLoginHttp(page: Page, opts: SsoLoginOptions, emit: SsoEmit): Promise<SsoLoginResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const loginUrl = page.url();
  const origin = new URL(loginUrl).origin;
  const jar = await jarFromPage(page, origin);

  let lastReason = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let snap: HttpFormSnapshot | null = null;
    try {
      const res = await httpFetch(loginUrl, { headers: { Referer: origin + '/' } }, jar);
      snap = parseLoginHtml(await res.text(), loginUrl);
    } catch (e) {
      lastReason = `获取登录页失败: ${e instanceof Error ? e.message : String(e)}`;
      emit('sso', 'warn', lastReason, { attempt });
      continue;
    }
    if (!snap || !snap.captcha0 || !snap.captchaImg) {
      lastReason = '登录页表单解析失败（非 django-captcha 结构）';
      emit('sso', 'warn', lastReason, { attempt });
      break;
    }
    let answer = '';
    try {
      const imgRes = await httpFetch(snap.captchaImg, { headers: { Referer: loginUrl } }, jar);
      const b64 = Buffer.from(await imgRes.arrayBuffer()).toString('base64');
      answer = await solveCaptcha(b64);
      emit('sso', 'info', `识别验证码: ${answer}`, { attempt, answer });
    } catch (e) {
      lastReason = `验证码识别失败: ${e instanceof Error ? e.message : String(e)}`;
      emit('sso', 'warn', `${lastReason}，重试`, { attempt });
      continue;
    }
    const body = new URLSearchParams(fillCredentialFields(snap.fields, opts.username, opts.password, answer)).toString();
    emit('sso', 'info', '登录提交', { attempt });
    try {
      const res = await httpFetch(
        snap.action,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: loginUrl, Origin: origin },
          body,
        },
        jar,
      );
      if (res.status >= 300 && res.status < 400) {
        await followRedirectsAndInject(page, jar, snap.action, res.headers.get('location'), emit);
        emit('sso', 'success', 'SSO 登录成功', { final_url: page.url() });
        return { ok: true, message: 'SSO 登录成功', final_url: page.url() };
      }
      const html = await res.text();
      const errText = extractHtmlError(html);
      lastReason = errText || `服务器返回 ${res.status}，仍在登录页`;
      emit('sso', 'warn', `登录被拒（${lastReason}），重试`, { attempt });
    } catch (e) {
      lastReason = `登录请求失败: ${e instanceof Error ? e.message : String(e)}`;
      emit('sso', 'warn', `${lastReason}，重试`, { attempt });
    }
  }
  const msg = `SSO 登录失败: ${lastReason || `${maxAttempts} 次尝试均失败`}`;
  emit('sso', 'error', msg, { reason: lastReason });
  return { ok: false, message: msg, final_url: page.url() };
}

async function detectLoginFormKind(page: Page): Promise<'modern' | 'django' | 'generic'> {
  const kind = await Promise.race([
    page
      .evaluate(`(() => {
        if (document.querySelector('input[name="flowId"]') && document.querySelector('input[name="loginType"]')) return 'modern';
        if (document.querySelector('input[name="captcha_0"]')) return 'django';
        const html = document.documentElement ? document.documentElement.innerHTML : '';
        if (/ssoConfig|"publicKey"|sm2\\.encrypt/i.test(html)) return 'modern';
        return 'generic';
      })()`)
      .catch(() => 'generic'),
    sleep(3000).then(() => 'generic' as const),
  ]);
  return kind === 'modern' || kind === 'django' ? kind : 'generic';
}

export async function performSsoLogin(page: Page, opts: SsoLoginOptions): Promise<SsoLoginResult> {
  const emit = opts.emit ?? noopEmit;
  const kind = await detectLoginFormKind(page);
  if (kind === 'modern') return performModernSsoLoginHttp(page, opts, emit);
  if (kind === 'django') return performDjangoSsoLoginHttp(page, opts, emit);

  // URL 已是新版 SSO，但兼容壳尚未渲染出字段时，仍走 HTTP 新链路
  if (/sso\.bjtu\.edu\.cn|\/sso\/login/i.test(page.url())) {
    return performModernSsoLoginHttp(page, opts, emit);
  }

  // 其他登录表单：合成事件提交路径
  const maxAttempts = opts.maxAttempts ?? 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let answer = '';
    const captchaB64 = await captureCaptchaImage(page).catch(() => null);
    if (captchaB64) {
      try {
        answer = await solveCaptcha(captchaB64);
        emit('sso', 'info', `识别验证码: ${answer}`, { attempt, answer });
      } catch (e) {
        emit('sso', 'warn', `验证码识别失败，重试: ${e instanceof Error ? e.message : String(e)}`, { attempt });
        await refreshCaptcha(page);
        continue;
      }
    }
    const fill = await fillLoginForm(page, opts.username, opts.password, answer).catch(() => null);
    if (!fill || !fill.username_found || !fill.password_found) {
      const msg = 'SSO 登录失败: 未找到登录表单字段';
      emit('sso', 'error', msg, { reason: '未找到登录表单字段' });
      return { ok: false, message: msg, final_url: page.url() };
    }
    emit('sso', 'info', '登录提交', { attempt });
    await submitLoginForm(page);
    const left = await waitLeaveLoginPage(page, 15_000).catch(() => false);
    if (left) {
      emit('sso', 'success', 'SSO 登录成功', { final_url: page.url() });
      return { ok: true, message: 'SSO 登录成功', final_url: page.url() };
    }
    if (attempt < maxAttempts) {
      emit('sso', 'warn', '验证码识别失败，重试（仍停留在登录页）', { attempt });
      await refreshCaptcha(page);
    }
  }
  const pageError = await extractLoginError(page);
  const msg = `SSO 登录失败: ${maxAttempts} 次尝试后仍停留在登录页${pageError ? `，页面提示: ${pageError}` : ''}`;
  emit('sso', 'error', msg, { reason: pageError || '仍停留在登录页' });
  return { ok: false, message: msg, final_url: page.url() };
}

export interface EnsureSessionResult {
  page: Page;
  loggedIn: boolean;
}

/**
 * 打开页面并确保已认证：落在登录页且 SSO 已配置（或 force）时自动登录，
 * 成功后再导航一次 url 确认不再跳登录。调用方负责关闭返回的 page。
 */
export async function ensureSession(
  browser: Browser,
  url: string,
  emit: SsoEmit = noopEmit,
  opts: { force?: boolean; timeoutMs?: number; username?: string; password?: string } = {},
): Promise<EnsureSessionResult> {
  const page = await browser.newPage();
  await page.goto(url, { timeout: opts.timeoutMs ?? 30_000, waitUntil: 'domcontentloaded' });
  await waitForRedirectSettle(page);
  const isLogin = await detectLoginPage(page.url(), page);
  // 未落在登录页 = 页面可直接访问（无需登录，或浏览器中已有有效会话）
  if (!isLogin) {
    emit('sso', 'success', '页面可直接访问（已有会话或无需登录）', { final_url: page.url() });
    return { page, loggedIn: true };
  }
  emit('sso', 'info', '检测到统一身份认证登录页', { login_url: page.url() });
  const username = opts.username ?? getSetting('sso_username');
  const password = opts.password ?? getSetting('sso_password');
  const configured = ssoConfigured() || (opts.force && !!username);
  if (!configured && !opts.force) {
    emit('sso', 'warn', '检测到登录跳转但未配置 SSO 凭据');
    return { page, loggedIn: false };
  }
  const result = await performSsoLogin(page, { username, password, emit });
  if (!result.ok) return { page, loggedIn: false };
  await page.goto(url, { timeout: opts.timeoutMs ?? 30_000, waitUntil: 'domcontentloaded' }).catch(() => {});
  await waitForRedirectSettle(page);
  const stillLogin = await detectLoginPage(page.url(), page);
  return { page, loggedIn: !stillLogin };
}

// ---------- Token 自动续期（若依 OAuth2 + 统一身份认证，纯 Node 链路） ----------
// 链路：{prefix}/oauthLogin → 302 authorize →（匿名先探出登录页 URL）→
// 新版 SM2 SSO（或旧版 django-captcha）登录拿 session → authorize 出 code →
// oauthCallBack 一次性消费 code → 302 响应的 Set-Cookie: Admin-Token 即 token。
// code 只能消费一次，每跳严格请求一次。

export interface TokenRenewResult {
  ok: boolean;
  message: string;
}

/** 从该系统已知的监控/候选 URL 推断 API 前缀（如 /party-system），并附常见兜底 */
function discoverApiPrefixes(systemId: number, origin: string): string[] {
  const rows = [
    ...(db.prepare('SELECT url FROM monitors WHERE system_id = ?').all(systemId) as { url: string }[]),
    ...(db.prepare('SELECT url FROM candidates WHERE system_id = ?').all(systemId) as { url: string }[]),
  ];
  const prefixes: string[] = [];
  const seen = new Set<string>();
  const skip = new Set(['assets', 'static', 'favicon.ico', 'oauthCallBack', 'oauthLogin']);
  for (const { url } of rows) {
    try {
      const u = new URL(url);
      if (u.origin !== origin) continue;
      const seg = u.pathname.split('/').filter(Boolean)[0];
      if (!seg || skip.has(seg)) continue;
      const p = '/' + seg;
      if (!seen.has(p)) {
        seen.add(p);
        prefixes.push(p);
      }
    } catch {
      // 非法 URL 跳过
    }
  }
  for (const p of ['/party-system', '/prod-api', '/api']) {
    if (!seen.has(p)) prefixes.push(p);
  }
  prefixes.push(''); // 无前缀兜底
  return prefixes;
}

/** 探测系统的 OAuth 入口：GET {prefix}/oauthLogin 应 302 到 authorize URL */
async function discoverOauthEntry(
  origin: string,
  prefixes: string[],
  jar: DomainCookies,
  emit: SsoEmit,
): Promise<{ authorizeUrl: string; prefix: string } | null> {
  for (const prefix of prefixes) {
    const entry = `${origin}${prefix}/oauthLogin`;
    try {
      const res = await httpFetch(entry, { headers: { 'User-Agent': RENEW_UA } }, jar);
      const loc = res.headers.get('location') ?? '';
      await res.arrayBuffer().catch(() => {});
      if (res.status >= 300 && res.status < 400 && /authorize|sso|cas/i.test(loc)) {
        emit('renew', 'info', `发现 OAuth 入口: ${prefix || '/'}/oauthLogin`);
        return { authorizeUrl: new URL(loc, entry).toString(), prefix };
      }
    } catch {
      // 尝试下一个前缀
    }
  }
  return null;
}

/** 匿名访问 authorize，跟随到 CAS/新版 SSO 登录页，拿到登录页 URL */
async function discoverCasLoginUrl(authorizeUrl: string, jar: DomainCookies): Promise<string | null> {
  // 登录页特征；authorize 本身也含 cas. 域名，不能单靠域名判定
  const LOGIN_PAGE_RE = /\/auth\/login|authserver|ids\.|\/sso\/login|sso\.bjtu\.edu\.cn/i;
  let cur: string | null = authorizeUrl;
  for (let hop = 0; hop < 8 && cur; hop++) {
    const res = await httpFetch(cur, { headers: { 'User-Agent': RENEW_UA } }, jar);
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.arrayBuffer().catch(() => {});
      cur = new URL(loc, cur).toString();
      if (LOGIN_PAGE_RE.test(cur)) return cur;
      continue;
    }
    const html = await res.text().catch(() => '');
    if (html && (isModernSsoHtml(html) || /captcha_0/i.test(html) || LOGIN_PAGE_RE.test(cur))) return cur;
    break;
  }
  return LOGIN_PAGE_RE.test(authorizeUrl) ? authorizeUrl : null;
}

/** 统一身份认证登录（新版 SM2 / 旧版 django-captcha），成功后会话写入 jar */
async function casLoginHttp(
  loginUrl: string,
  jar: DomainCookies,
  username: string,
  password: string,
  emit: SsoEmit,
  maxAttempts = 3,
): Promise<{ ok: boolean; reason: string }> {
  let html = '';
  try {
    const res = await httpFetch(loginUrl, { headers: { 'User-Agent': RENEW_UA } }, jar);
    html = await res.text();
  } catch (e) {
    return { ok: false, reason: `获取登录页失败: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (isModernSsoHtml(html)) {
    const bridged: SsoEmit = (phase, level, message, data) =>
      emit(phase === 'sso' ? 'renew' : phase, level, message, data);
    return modernSsoLoginHttp(loginUrl, jar, username, password, bridged, maxAttempts);
  }

  // 旧版 django-simple-captcha 兜底
  let lastReason = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let snap: HttpFormSnapshot | null = null;
    try {
      const res = await httpFetch(loginUrl, { headers: { 'User-Agent': RENEW_UA } }, jar);
      snap = parseLoginHtml(await res.text(), loginUrl);
    } catch (e) {
      lastReason = `获取登录页失败: ${e instanceof Error ? e.message : String(e)}`;
      emit('renew', 'warn', lastReason, { attempt });
      continue;
    }
    if (!snap || !snap.captcha0 || !snap.captchaImg) {
      lastReason = '登录页表单解析失败（非 django-captcha / 新版 SSO 结构）';
      emit('renew', 'warn', lastReason, { attempt });
      break;
    }
    let answer = '';
    try {
      const imgRes = await httpFetch(snap.captchaImg, { headers: { 'User-Agent': RENEW_UA, Referer: loginUrl } }, jar);
      const b64 = Buffer.from(await imgRes.arrayBuffer()).toString('base64');
      answer = await solveCaptcha(b64);
      emit('renew', 'info', `识别验证码: ${answer}`, { attempt });
    } catch (e) {
      lastReason = `验证码识别失败: ${e instanceof Error ? e.message : String(e)}`;
      emit('renew', 'warn', `${lastReason}，重试`, { attempt });
      continue;
    }
    const body = new URLSearchParams(fillCredentialFields(snap.fields, username, password, answer)).toString();
    emit('renew', 'info', '登录提交', { attempt });
    try {
      const res = await httpFetch(
        snap.action,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Referer: loginUrl,
            Origin: new URL(loginUrl).origin,
            'User-Agent': RENEW_UA,
          },
          body,
        },
        jar,
      );
      await res.arrayBuffer().catch(() => {});
      if (res.status >= 300 && res.status < 400) {
        emit('renew', 'success', '统一身份认证登录成功', { attempt });
        return { ok: true, reason: '' };
      }
      lastReason = `服务器返回 ${res.status}，仍在登录页`;
      emit('renew', 'warn', `登录被拒（${lastReason}），重试`, { attempt });
    } catch (e) {
      lastReason = `登录请求失败: ${e instanceof Error ? e.message : String(e)}`;
      emit('renew', 'warn', `${lastReason}，重试`, { attempt });
    }
  }
  return { ok: false, reason: lastReason || '登录失败' };
}

/** 带会话走 authorize → code → oauthCallBack 链，捕获 Set-Cookie 中的 Admin-Token */
async function exchangeCodeForToken(authorizeUrl: string, jar: DomainCookies, emit: SsoEmit): Promise<string | null> {
  let cur: string | null = authorizeUrl;
  for (let hop = 0; hop < 10 && cur; hop++) {
    const res = await httpFetch(cur, { headers: { 'User-Agent': RENEW_UA } }, jar);
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(';')[0];
      const i = pair.indexOf('=');
      if (i > 0 && pair.slice(0, i).trim() === 'Admin-Token') {
        const v = pair.slice(i + 1).trim();
        if (v.startsWith('eyJ')) return v;
      }
    }
    const loc = res.headers.get('location');
    emit('renew', 'info', `跟随跳转 (${hop + 1})`, {
      status: res.status,
      url: cur.slice(0, 120),
      set_cookies: res.headers.getSetCookie().map((sc) => sc.split(';')[0].split('=')[0]?.trim()),
    });
    await res.arrayBuffer().catch(() => {});
    if (!(res.status >= 300 && res.status < 400 && loc)) break;
    cur = new URL(loc, cur).toString();
  }
  return null;
}

const renewInflight = new Map<number, Promise<TokenRenewResult>>();
const renewLastAttempt = new Map<number, number>();

/**
 * 自动续期系统的访问令牌（Admin-Token）。成功则写回 systems.auth_token。
 * 同一系统并发调用共享一次执行；失败后 60s 冷却，避免巡检高频触发打爆 CAS。
 */
export async function renewSystemToken(
  systemId: number,
  emit: SsoEmit = noopEmit,
  opts: { force?: boolean } = {},
): Promise<TokenRenewResult> {
  const inflight = renewInflight.get(systemId);
  if (inflight) return inflight;
  if (!opts.force) {
    const last = renewLastAttempt.get(systemId) ?? 0;
    if (Date.now() - last < 60_000) return { ok: false, message: '续期冷却中（60s 内已尝试过）' };
  }
  const promise = doRenewSystemToken(systemId, emit).finally(() => {
    renewInflight.delete(systemId);
  });
  renewInflight.set(systemId, promise);
  renewLastAttempt.set(systemId, Date.now());
  return promise;
}

async function doRenewSystemToken(systemId: number, emit: SsoEmit): Promise<TokenRenewResult> {
  const fail = (message: string): TokenRenewResult => {
    emit('renew', 'error', message);
    return { ok: false, message };
  };
  const system = db.prepare('SELECT * FROM systems WHERE id = ?').get(systemId) as SystemRow | undefined;
  if (!system) return fail('系统不存在');
  if (system.use_sso !== 1) return fail('该系统未开启统一身份认证');
  if (!ssoConfigured()) return fail('未配置统一身份认证凭据，请先到设置页填写');

  const origin = new URL(system.base_url).origin;
  const jar = new DomainCookies();

  emit('renew', 'info', '探测 OAuth 入口');
  const entry = await discoverOauthEntry(origin, discoverApiPrefixes(systemId, origin), jar, emit);
  if (!entry) return fail('未找到 OAuth 入口（{前缀}/oauthLogin 均未跳转认证中心）');

  emit('renew', 'info', '探测统一身份认证登录页');
  const loginUrl = await discoverCasLoginUrl(entry.authorizeUrl, jar);
  if (!loginUrl) return fail('未能定位统一身份认证登录页');

  const login = await casLoginHttp(loginUrl, jar, getSetting('sso_username'), getSetting('sso_password'), emit);
  if (!login.ok) return fail(`统一身份认证登录失败: ${login.reason}`);

  emit('renew', 'info', '换取访问令牌');
  const token = await exchangeCodeForToken(entry.authorizeUrl, jar, emit);
  if (!token) return fail('未换取到访问令牌（回调未下发 Admin-Token）');

  db.prepare('UPDATE systems SET auth_token = ? WHERE id = ?').run(token, systemId);
  emit('renew', 'success', `访问令牌已更新（****${token.slice(-4)}）`);

  // 用 getInfo 验证 token 可用性（非阻断）
  try {
    const res = await httpFetch(`${origin}${entry.prefix}/getInfo`, {
      headers: { 'User-Agent': RENEW_UA, Authorization: `Bearer ${token}`, Accept: 'application/json' },
    }, jar);
    const ok = res.status === 200;
    await res.arrayBuffer().catch(() => {});
    emit('renew', ok ? 'success' : 'warn', ok ? '令牌验证通过（getInfo 200）' : `令牌验证返回 ${res.status}`);
  } catch {
    emit('renew', 'warn', '令牌验证请求失败（不影响续期结果）');
  }
  return { ok: true, message: '访问令牌已自动续期' };
}
