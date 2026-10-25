import { Router } from 'express';
import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { db } from './db';
import { requirePermission } from './users';
import type { SystemLedgerRow } from './types';

export const ledgerRouter = Router();

/** 台账条目 + 可选关联的系统名 */
export interface PublicLedgerEntry extends SystemLedgerRow {
  system_name: string | null;
  system_base_url: string | null;
}

const SELECT_ENTRY = `
  SELECT l.*, s.name AS system_name, s.base_url AS system_base_url
  FROM system_ledgers l
  LEFT JOIN systems s ON s.id = l.system_id
`;

function getEntry(id: number): PublicLedgerEntry | undefined {
  return db.prepare(`${SELECT_ENTRY} WHERE l.id = ?`).get(id) as PublicLedgerEntry | undefined;
}

type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

/** IP：允许 IPv4 / IPv6，可带 /掩码，多个用逗号、空格或分号分隔 */
function normalizeIp(raw: unknown): Validated<string> {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ok: true, value: '' };
  const tokens = text.split(/[\s,，;；、]+/).filter(Boolean);
  const bad: string[] = [];
  for (const token of tokens) {
    const slash = token.indexOf('/');
    const addr = slash === -1 ? token : token.slice(0, slash);
    const maskText = slash === -1 ? '' : token.slice(slash + 1);
    const version = isIP(addr);
    if (version === 0) {
      bad.push(token);
      continue;
    }
    if (slash !== -1) {
      const mask = Number(maskText);
      const max = version === 4 ? 32 : 128;
      if (!maskText || !Number.isInteger(mask) || mask < 0 || mask > max) bad.push(token);
    }
  }
  if (bad.length > 0) {
    return { ok: false, error: `IP 格式不正确：${bad.join('、')}（支持 IPv4 / IPv6，可带掩码，多个用逗号或空格分隔）` };
  }
  return { ok: true, value: tokens.join(', ') };
}

const DOMAIN_LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
const DOMAIN_RE = new RegExp(`^${DOMAIN_LABEL}(\\.${DOMAIN_LABEL})+$`);

/** 域名：只填主机名，可带端口，允许通配符前缀，不带协议 */
function normalizeDomain(raw: unknown): Validated<string> {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return { ok: true, value: '' };
  const lower = text.toLowerCase();
  if (/^[a-z][a-z0-9+.-]*:\/\//.test(lower)) {
    return { ok: false, error: '域名只填主机名，不要带 http:// 或 https:// 前缀' };
  }
  if (lower.includes(' ')) return { ok: false, error: `域名格式不正确：${text}` };
  const colon = lower.lastIndexOf(':');
  const hasPort = colon !== -1;
  const host = (hasPort ? lower.slice(0, colon) : lower).replace(/\.$/, '');
  const portText = hasPort ? lower.slice(colon + 1) : '';
  const wildcard = host.startsWith('*.');
  const base = wildcard ? host.slice(2) : host;
  if (!base || !DOMAIN_RE.test(base)) return { ok: false, error: `域名格式不正确：${text}` };
  if (hasPort) {
    const port = Number(portText);
    if (!portText || !Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, error: `域名端口不正确：${text}` };
    }
  }
  return { ok: true, value: lower };
}

function normalizeText(raw: unknown, max = 500): string {
  return typeof raw === 'string' ? raw.trim().slice(0, max) : '';
}

function normalizeBool(raw: unknown): boolean {
  return raw === true || raw === 1 || raw === '1' || raw === 'true';
}

interface EntryInput {
  name: string;
  ops_unit: string;
  ip: string;
  external_access: number;
  domain_applied: number;
  domain: string;
  location: string;
  remark: string;
  system_id: number | null;
}

/**
 * 校验并归一化入参。
 * 规则：系统名称必填；域名只填一个主机名，失败时按字段返回 error；
 * 「是否申请域名」为是时必须填域名，为否时域名留空。
 */
function readEntryInput(body: unknown, existing?: SystemLedgerRow): Validated<EntryInput> {
  const b = (body ?? {}) as Record<string, unknown>;

  const name = b.name === undefined && existing ? existing.name : normalizeText(b.name, 120);
  if (!name) return { ok: false, error: '系统名称必填' };

  const ipResult = normalizeIp(b.ip === undefined && existing ? existing.ip : b.ip);
  if (!ipResult.ok) return ipResult;

  const externalAccess = b.external_access === undefined && existing
    ? existing.external_access
    : normalizeBool(b.external_access)
      ? 1
      : 0;

  const domainApplied = b.domain_applied === undefined && existing
    ? existing.domain_applied
    : normalizeBool(b.domain_applied)
      ? 1
      : 0;

  // 未申请域名时忽略传入的域名，避免残留旧值
  const domainRaw = domainApplied === 0 ? '' : b.domain === undefined && existing ? existing.domain : b.domain;
  const domainResult = normalizeDomain(domainRaw);
  if (!domainResult.ok) return domainResult;
  if (domainApplied === 1 && !domainResult.value) {
    return { ok: false, error: '已申请域名时，域名必填' };
  }

  let systemId: number | null = existing?.system_id ?? null;
  if (b.system_id !== undefined) {
    if (b.system_id === null || b.system_id === '' || b.system_id === 0) {
      systemId = null;
    } else {
      const parsed = Number(b.system_id);
      if (!Number.isInteger(parsed) || parsed <= 0) return { ok: false, error: 'system_id 不合法' };
      const system = db.prepare('SELECT id FROM systems WHERE id = ?').get(parsed);
      if (!system) return { ok: false, error: '关联的监控系统不存在' };
      systemId = parsed;
    }
  }

  return {
    ok: true,
    value: {
      name,
      ops_unit: b.ops_unit === undefined && existing ? existing.ops_unit : normalizeText(b.ops_unit, 120),
      ip: ipResult.value,
      external_access: externalAccess,
      domain_applied: domainApplied,
      domain: domainResult.value,
      location: b.location === undefined && existing ? existing.location : normalizeText(b.location, 200),
      remark: b.remark === undefined && existing ? existing.remark : normalizeText(b.remark, 2000),
      system_id: systemId,
    },
  };
}

// ---- 系统台账 ----

ledgerRouter.get('/ledger', (req, res) => {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (req.query.system_id !== undefined && req.query.system_id !== '') {
    const systemId = Number(req.query.system_id);
    if (!Number.isInteger(systemId) || systemId <= 0) return res.status(400).json({ error: 'system_id 不合法' });
    clauses.push('l.system_id = ?');
    params.push(systemId);
  }
  if (req.query.external_access === '1' || req.query.external_access === '0') {
    clauses.push('l.external_access = ?');
    params.push(Number(req.query.external_access));
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  const entries = db.prepare(`${SELECT_ENTRY}${where} ORDER BY l.id DESC`).all(...params) as PublicLedgerEntry[];
  res.json({ entries });
});

ledgerRouter.get('/ledger/:id', (req, res) => {
  const entry = getEntry(Number(req.params.id));
  if (!entry) return res.status(404).json({ error: '台账条目不存在' });
  res.json(entry);
});

ledgerRouter.post('/ledger', requirePermission('ledger.manage'), (req, res) => {
  const input = readEntryInput(req.body);
  if (!input.ok) return res.status(400).json({ error: input.error });
  const now = Date.now();
  const v = input.value;
  const info = db
    .prepare(
      `INSERT INTO system_ledgers(name, ops_unit, ip, external_access, domain_applied, domain, location, remark, system_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      v.name,
      v.ops_unit,
      v.ip,
      v.external_access,
      v.domain_applied,
      v.domain,
      v.location,
      v.remark,
      v.system_id,
      now,
      now,
    );
  res.status(201).json(getEntry(Number(info.lastInsertRowid)));
});

ledgerRouter.patch('/ledger/:id', requirePermission('ledger.manage'), (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM system_ledgers WHERE id = ?').get(id) as SystemLedgerRow | undefined;
  if (!existing) return res.status(404).json({ error: '台账条目不存在' });
  const input = readEntryInput(req.body, existing);
  if (!input.ok) return res.status(400).json({ error: input.error });
  const v = input.value;
  db.prepare(
    `UPDATE system_ledgers
     SET name = ?, ops_unit = ?, ip = ?, external_access = ?, domain_applied = ?, domain = ?, location = ?, remark = ?, system_id = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    v.name,
    v.ops_unit,
    v.ip,
    v.external_access,
    v.domain_applied,
    v.domain,
    v.location,
    v.remark,
    v.system_id,
    Date.now(),
    id,
  );
  res.json(getEntry(id));
});

ledgerRouter.delete('/ledger/:id', requirePermission('ledger.manage'), (req, res) => {
  const info = db.prepare('DELETE FROM system_ledgers WHERE id = ?').run(Number(req.params.id));
  if (info.changes === 0) return res.status(404).json({ error: '台账条目不存在' });
  res.json({ ok: true });
});

// ---- 域名解析（台账表单里的「解析 IP」） ----

const DNS_TIMEOUT_MS = 5000;

interface ResolvedAddress {
  address: string;
  family: number;
}

/** 从归一化后的域名里取出可解析的主机名：去掉端口与通配符前缀 */
function hostFromDomain(domain: string): { host: string; wildcard: boolean } {
  const colon = domain.lastIndexOf(':');
  const raw = (colon === -1 ? domain : domain.slice(0, colon)).replace(/\.$/, '');
  const wildcard = raw.startsWith('*.');
  return { host: wildcard ? raw.slice(2) : raw, wildcard };
}

/**
 * 用系统解析器（getaddrinfo，和 ping / curl 的第一步相同）查询域名：
 * 先读 /etc/hosts，再问 /etc/resolv.conf 里的 DNS，所以内网域名也能解析。
 */
function lookupHost(host: string): Promise<ResolvedAddress[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Object.assign(new Error('解析超时'), { code: 'ETIMEOUT' })),
      DNS_TIMEOUT_MS,
    );
    lookup(host, { all: true }, (err, addresses) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(addresses.map((a) => ({ address: a.address, family: a.family })));
    });
  });
}

function dnsErrorText(code: string | undefined, host: string): string {
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_NODATA':
      return `DNS 查不到 ${host} 的记录：域名可能拼错了，或服务器当前网络解析不了它`;
    case 'EAI_AGAIN':
      return `DNS 服务器暂时无响应，请稍后重试（${host}）`;
    case 'EAI_FAIL':
      return `DNS 服务器返回无效响应（${host}），请检查服务器上的 DNS 配置`;
    case 'ETIMEOUT':
      return `解析 ${host} 超时（${DNS_TIMEOUT_MS / 1000} 秒），请检查服务器 DNS 是否可达`;
    default:
      return `解析 ${host} 失败${code ? `（${code}）` : ''}`;
  }
}

/** 按域名查 DNS 记录并返回解析到的 IP，供台账表单自动填写 */
ledgerRouter.post('/ledger/resolve-domain', requirePermission('ledger.manage'), async (req, res) => {
  const domainResult = normalizeDomain((req.body ?? {}).domain);
  if (!domainResult.ok) return res.status(400).json({ error: domainResult.error });
  if (!domainResult.value) return res.status(400).json({ error: '请先填写域名' });

  const { host, wildcard } = hostFromDomain(domainResult.value);
  if (wildcard) return res.status(400).json({ error: '通配符域名（*. 开头）不能直接解析，请填写具体主机名' });

  const started = Date.now();
  try {
    const addresses = await lookupHost(host);
    if (addresses.length === 0) {
      return res.status(404).json({ error: `DNS 没有返回 ${host} 的地址记录` });
    }
    // IPv4 排前面，抄进 IP 字段更顺手
    addresses.sort((a, b) => a.family - b.family);
    res.json({ host, domain: domainResult.value, addresses, elapsed_ms: Date.now() - started });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    res.status(code === 'ETIMEOUT' ? 504 : 400).json({ error: dnsErrorText(code, host) });
  }
});

// ---- 一键 IP 扫描：批量按域名查 DNS，确认后再写回 IP ----

/** 一次扫描 / 写入的条目上限，避免一个请求里排太多 DNS 查询 */
const SCAN_MAX_IDS = 500;
/** DNS 查询并发数：比串行快，又不至于把内网 DNS 打爆 */
const SCAN_CONCURRENCY = 8;

/**
 * 单条扫描结果的状态：
 * fill=IP 为空可补上、change=与已有 IP 不同、same=与已有 IP 一致、
 * skipped=没有可解析的域名、error=解析失败、missing=条目已被删除
 */
type ScanStatus = 'fill' | 'change' | 'same' | 'skipped' | 'error' | 'missing';

interface ScanResultItem {
  id: number;
  name: string;
  domain: string;
  host: string | null;
  current_ip: string;
  resolved_ip: string | null;
  addresses: ResolvedAddress[];
  status: ScanStatus;
  message: string | null;
  elapsed_ms: number;
}

/** 按并发上限批量执行异步任务，结果顺序与入参一致 */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 解析一条台账的域名：只查 DNS，不碰数据库，是否写回由调用方决定 */
async function scanEntry(row: SystemLedgerRow): Promise<ScanResultItem> {
  const base: ScanResultItem = {
    id: row.id,
    name: row.name,
    domain: row.domain,
    host: null,
    current_ip: row.ip,
    resolved_ip: null,
    addresses: [],
    status: 'skipped',
    message: null,
    elapsed_ms: 0,
  };
  if (!row.domain) return { ...base, message: '未填写域名' };
  if (!normalizeBool(row.domain_applied)) return { ...base, message: '未申请域名' };

  const { host, wildcard } = hostFromDomain(row.domain);
  if (wildcard) return { ...base, host, message: '通配符域名（*. 开头）不能直接解析' };

  const started = Date.now();
  try {
    const addresses = await lookupHost(host);
    const elapsed = Date.now() - started;
    if (addresses.length === 0) {
      return { ...base, host, status: 'error', message: `DNS 没有返回 ${host} 的地址记录`, elapsed_ms: elapsed };
    }
    // IPv4 排前面，取第一个作为待写入的 IP
    addresses.sort((a, b) => a.family - b.family);
    const resolvedIp = addresses[0].address;
    // 台账的 IP 字段可以存多个（逗号/空格分隔）：解析结果已经在里面就不算变化，
    // 只有解析到新地址时才提示覆盖，避免把多 IP 记成「不同」又冲掉其余地址
    const currentIps = row.ip.split(/[\s,，;；、]+/).filter(Boolean);
    const status: ScanStatus = currentIps.length === 0 ? 'fill' : currentIps.includes(resolvedIp) ? 'same' : 'change';
    return { ...base, host, addresses, resolved_ip: resolvedIp, status, elapsed_ms: elapsed };
  } catch (e) {
    return {
      ...base,
      host,
      status: 'error',
      message: dnsErrorText((e as NodeJS.ErrnoException).code, host),
      elapsed_ms: Date.now() - started,
    };
  }
}

/** 批量按域名查 DNS（只读）。前端拿结果给用户复核，确认后再调 apply 写回 */
ledgerRouter.post('/ledger/scan-ips', requirePermission('ledger.manage'), async (req, res) => {
  const raw = (req.body ?? {}) as { ids?: unknown };
  if (!Array.isArray(raw.ids) || raw.ids.length === 0) {
    return res.status(400).json({ error: '请先勾选要扫描的台账条目' });
  }
  if (raw.ids.length > SCAN_MAX_IDS) {
    return res.status(400).json({ error: `一次最多扫描 ${SCAN_MAX_IDS} 条` });
  }
  const ids: number[] = [];
  for (const value of raw.ids) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: 'ids 里含有不合法的条目 ID' });
    if (!ids.includes(id)) ids.push(id);
  }

  const placeholders = ids.map(() => '?').join(', ');
  const rows = db
    .prepare(`SELECT * FROM system_ledgers WHERE id IN (${placeholders})`)
    .all(...ids) as SystemLedgerRow[];
  const byId = new Map(rows.map((row) => [row.id, row]));

  const results = await mapLimit(ids, SCAN_CONCURRENCY, async (id): Promise<ScanResultItem> => {
    const row = byId.get(id);
    if (!row) {
      return {
        id,
        name: `#${id}`,
        domain: '',
        host: null,
        current_ip: '',
        resolved_ip: null,
        addresses: [],
        status: 'missing',
        message: '条目已不存在（可能刚被删除）',
        elapsed_ms: 0,
      };
    }
    return scanEntry(row);
  });

  const summary = { total: results.length, fill: 0, change: 0, same: 0, skipped: 0, failed: 0 };
  for (const item of results) {
    if (item.status === 'fill') summary.fill += 1;
    else if (item.status === 'change') summary.change += 1;
    else if (item.status === 'same') summary.same += 1;
    else if (item.status === 'skipped') summary.skipped += 1;
    else summary.failed += 1;
  }
  res.json({ results, summary });
});

/** 把扫描结果里用户勾选过的 IP 写回台账 */
ledgerRouter.post('/ledger/scan-ips/apply', requirePermission('ledger.manage'), (req, res) => {
  const raw = (req.body ?? {}) as { updates?: unknown };
  if (!Array.isArray(raw.updates) || raw.updates.length === 0) {
    return res.status(400).json({ error: '没有要写入的条目' });
  }
  if (raw.updates.length > SCAN_MAX_IDS) {
    return res.status(400).json({ error: `一次最多写入 ${SCAN_MAX_IDS} 条` });
  }

  const updates: { id: number; ip: string }[] = [];
  for (const value of raw.updates) {
    const item = (value ?? {}) as { id?: unknown; ip?: unknown };
    const id = Number(item.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '条目 ID 不合法' });
    const ipResult = normalizeIp(item.ip);
    if (!ipResult.ok) return res.status(400).json({ error: ipResult.error });
    if (!ipResult.value) return res.status(400).json({ error: '写入的 IP 不能为空' });
    updates.push({ id, ip: ipResult.value });
  }

  const now = Date.now();
  const statement = db.prepare('UPDATE system_ledgers SET ip = ?, updated_at = ? WHERE id = ?');
  let updated = 0;
  const missing: number[] = [];
  const applyAll = db.transaction((rows: { id: number; ip: string }[]) => {
    for (const row of rows) {
      const info = statement.run(row.ip, now, row.id);
      if (info.changes > 0) updated += 1;
      else missing.push(row.id);
    }
  });
  applyAll(updates);

  res.json({ updated, missing });
});
