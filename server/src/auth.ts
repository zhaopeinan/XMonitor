import { db } from './db';
import type { Page } from 'puppeteer-core';
import type { SystemRow } from './types';

/** 读取系统配置的访问令牌（若依类系统为 Admin-Token JWT） */
export function getSystemToken(systemId: number): string | null {
  const row = db.prepare('SELECT auth_token FROM systems WHERE id = ?').get(systemId) as Pick<SystemRow, 'auth_token'> | undefined;
  return row?.auth_token || null;
}

/** 计算 cookie 生效的父域：edu.cn 这类多级公共后缀取后三段，其余取后两段 */
export function cookieDomain(host: string): string {
  const parts = host.split('.');
  const secondLevelTlds = ['edu.cn', 'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'ac.cn'];
  const last2 = parts.slice(-2).join('.');
  if (secondLevelTlds.includes(last2)) return '.' + parts.slice(-3).join('.');
  return '.' + last2;
}

/** 把 token 以 Admin-Token cookie 注入 obscura（浏览器模式页面/接口检查用） */
export async function injectTokenCookie(page: Page, url: string, token: string): Promise<void> {
  try {
    const host = new URL(url).host;
    const client = await page.createCDPSession();
    await client.send('Network.setCookies', {
      cookies: [{ name: 'Admin-Token', value: token, domain: cookieDomain(host), path: '/' }],
    });
  } catch {
    // 注入失败不阻断检查
  }
}

/** HTTP 直连模式要携带的认证头（Bearer + Admin-Token cookie 双保险） */
export function tokenAuthHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, Cookie: `Admin-Token=${token}` };
}
