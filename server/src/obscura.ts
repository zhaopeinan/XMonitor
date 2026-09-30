import puppeteer, { type Browser } from 'puppeteer-core';
import { getSetting } from './settings';

let browser: Browser | null = null;
let connecting: Promise<Browser> | null = null;

/** 支持 ws(s):// 直连，或 http(s)://host:9222 经 /json/version 发现 webSocketDebuggerUrl */
async function resolveBrowserWSEndpoint(endpoint: string): Promise<string> {
  const trimmed = endpoint.trim();
  if (!trimmed) throw new Error('obscura_endpoint 未配置');
  if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) return trimmed;

  const base = trimmed.replace(/\/$/, '');
  const versionUrl = /\/json\/version\/?$/.test(base) ? base : `${base}/json/version`;
  const res = await fetch(versionUrl);
  if (!res.ok) throw new Error(`CDP 发现失败 HTTP ${res.status} (${versionUrl})`);
  const data = (await res.json()) as { webSocketDebuggerUrl?: string };
  if (!data.webSocketDebuggerUrl) throw new Error('CDP /json/version 未返回 webSocketDebuggerUrl');
  return data.webSocketDebuggerUrl;
}

export async function getBrowser(): Promise<Browser> {
  if (browser && browser.connected) return browser;
  if (connecting) return connecting;

  const endpoint = getSetting('obscura_endpoint');
  connecting = (async () => {
    try {
      const browserWSEndpoint = await resolveBrowserWSEndpoint(endpoint);
      const b = await puppeteer.connect({ browserWSEndpoint });
      b.on('disconnected', () => {
        browser = null;
      });
      browser = b;
      return b;
    } finally {
      connecting = null;
    }
  })();
  return connecting;
}

export async function checkObscuraHealth(): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    const b = await getBrowser();
    const version = await b.version();
    return { ok: true, version };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
