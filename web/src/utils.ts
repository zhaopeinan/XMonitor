import type { AlertKind, MonitorStatus } from './types';

export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export function isTruthy(v: unknown): boolean {
  return v === true || v === 'true' || v === '1' || v === 1;
}

/**
 * 判断地址是否属于内网/保留段：IPv4 覆盖 10/8、172.16/12、192.168/16、169.254/16、100.64/10、127/8，
 * IPv6 覆盖 ::1、fe80::/10、fc00::/7。用于台账扫描结果里提示「内网 → 公网」这类差异。
 */
export function isInternalAddress(ip?: string | null): boolean {
  if (!ip) return false;
  const lower = ip.trim().toLowerCase();
  if (lower.includes(':')) {
    if (lower === '::1') return true;
    if (/^fe[89ab]/.test(lower)) return true;
    return lower.startsWith('fc') || lower.startsWith('fd');
  }
  const parts = lower.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  if (a === 10 || a === 127) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

/** 毫秒时间戳 → 2026-11-03：证书到期这类只关心日期的地方用 */
export function fmtDay(ts?: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** HTTPS 探测结论的文案：''=还没探测过 */
export function httpsOutcomeLabel(outcome?: string | null): string {
  if (outcome === 'yes') return '支持 HTTPS';
  if (outcome === 'no') return '仅 HTTP';
  if (outcome === 'unknown') return '未探到';
  return '未探测';
}

/** 证书剩余天数（负数表示已过期），按当前时间实时算，不写死在库里 */
export function certDaysLeft(expiresAt?: number | null): number | null {
  if (!expiresAt) return null;
  return Math.floor((expiresAt - Date.now()) / 86_400_000);
}

/**
 * 台账列表「HTTPS / 证书」列的标签：有证书有效期就先说还能用多久（已过期红、30 天内黄、其余绿），
 * 没有证书时退回探测结论；没探测过是灰色的「未探测」，和「探了但没探到」区分开。
 */
export function certBadge(entry: {
  https_supported?: string | null;
  cert_expires_at?: number | null;
}): { label: string; cls: string } {
  const daysLeft = certDaysLeft(entry.cert_expires_at);
  if (daysLeft !== null) {
    if (daysLeft < 0) return { label: `已过期 ${Math.abs(daysLeft)} 天`, cls: 'border-rose-200 bg-rose-50 text-rose-600' };
    if (daysLeft <= 30) return { label: `剩 ${daysLeft} 天`, cls: 'border-amber-200 bg-amber-50 text-amber-700' };
    return { label: `剩 ${daysLeft} 天`, cls: 'border-emerald-200 bg-emerald-50 text-emerald-700' };
  }
  const outcome = entry.https_supported ?? '';
  if (outcome === 'yes') return { label: '支持 HTTPS', cls: 'border-emerald-200 bg-emerald-50 text-emerald-700' };
  if (outcome === 'no') return { label: '仅 HTTP', cls: 'border-slate-200 bg-slate-50 text-slate-500' };
  if (outcome === 'unknown') return { label: '未探到', cls: 'border-slate-200 bg-slate-50 text-slate-400' };
  return { label: '未探测', cls: 'border-slate-200 bg-slate-50 text-slate-400' };
}

export function normStatus(s?: string | null): MonitorStatus {
  if (s === 'up' || s === 'slow' || s === 'down') return s;
  return 'unknown';
}

export const STATUS_LABELS: Record<MonitorStatus, string> = {
  up: '正常',
  slow: '缓慢',
  down: '故障',
  unknown: '未知',
};

/** 按期望模式给出状态文案：反向监控下 up=已阻断、down=仍可访问 */
export function statusLabel(status: MonitorStatus, expectMode?: string | null): string {
  if (expectMode === 'down') {
    if (status === 'up') return '已阻断';
    if (status === 'down') return '仍可访问';
    if (status === 'slow') return '仍可访问';
    return '待探测';
  }
  return STATUS_LABELS[status];
}

/** 24h 主指标文案 */
export function rateKindLabel(kind?: string | null): string {
  if (kind === 'block') return '24h 阻断率';
  if (kind === 'compliance') return '24h 符合率';
  return '24h 可用率';
}

export function rateKindHint(kind?: string | null): string {
  if (kind === 'block') return '反向监控：不可达占比越高越好';
  if (kind === 'compliance') return '正反向混合：探测结果符合各自期望的占比';
  return '正向监控：可达占比';
}

export const CATEGORY_LABELS: Record<string, string> = {
  login: '登录',
  home: '首页',
  menu: '菜单',
  nav: '导航',
  detail: '详情',
  other: '其他',
};

export const ALERT_KIND_META: Record<string, { label: string; classes: string }> = {
  down: { label: '故障', classes: 'bg-rose-50 text-rose-600 border-rose-200' },
  slow: { label: '缓慢', classes: 'bg-amber-50 text-amber-600 border-amber-200' },
  recovered: { label: '恢复', classes: 'bg-emerald-50 text-emerald-600 border-emerald-200' },
  reachable: { label: '仍可访问', classes: 'bg-rose-50 text-rose-600 border-rose-200' },
  secured: { label: '已阻断', classes: 'bg-emerald-50 text-emerald-600 border-emerald-200' },
};

export function alertKindMeta(kind: string) {
  return ALERT_KIND_META[kind] ?? { label: kind, classes: 'bg-slate-100 text-slate-500 border-slate-200' };
}

export function fmtDateTime(ts?: string | number | null): string {
  if (ts === null || ts === undefined || ts === '') return '—';
  const d = typeof ts === 'number' ? new Date(ts) : new Date(ts);
  if (Number.isNaN(d.getTime())) return String(ts);
  return d.toLocaleString('zh-CN', { hour12: false });
}

export function fmtTime(ts?: string | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}

export function fmtRelative(ts?: string | number | null): string {
  if (!ts) return '—';
  const d = new Date(ts).getTime();
  if (Number.isNaN(d)) return String(ts);
  const diff = Date.now() - d;
  if (diff < 0) return fmtDateTime(ts);
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;
  return fmtDateTime(ts);
}

export function fmtLatency(ms?: number | null): string {
  if (ms === null || ms === undefined) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

export function fmtTps(tps?: number | null): string {
  if (tps === null || tps === undefined || !Number.isFinite(tps)) return '—';
  return `${tps.toFixed(1)} tok/s`;
}

export function fmtBytes(n?: number | null): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtUptime(sec?: number | null): string {
  if (sec === null || sec === undefined || !Number.isFinite(sec) || sec < 0) return '—';
  const s = Math.floor(sec);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (d > 0) return `${d}天 ${h}小时`;
  if (h > 0) return `${h}小时 ${m}分`;
  if (m > 0) return `${m}分 ${r}秒`;
  return `${r}秒`;
}

/** 监控项地址展示：优先 path+query；解析失败则回退原文 */
export function fmtMonitorPath(url?: string | null): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    return u.pathname + u.search + u.hash || '/';
  } catch {
    return url;
  }
}

export function fmtMonitorEndpoint(url?: string | null, method?: string | null, type?: string | null): string {
  const path = fmtMonitorPath(url);
  if (!path) return '';
  if (type === 'api' || (method && method.toUpperCase() !== 'GET')) {
    return `${(method || 'GET').toUpperCase()} ${path}`;
  }
  return path;
}
