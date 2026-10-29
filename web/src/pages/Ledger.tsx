import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useConfirm } from '../components/ConfirmDialog';
import { useAuth } from '../auth';
import { Card, ErrorBanner, PageHeader, Spinner } from '../components/ui';
import { Select } from '../components/Select';
import type {
  LedgerEntry,
  LedgerHttpsProbeItem,
  LedgerHttpsProbeResult,
  LedgerScanItem,
  LedgerScanResult,
  LedgerScanStatus,
  SystemInfo,
} from '../types';
import {
  OS_FAMILIES,
  OPS_TYPE_OPTIONS,
  osSummary,
  opsTypeLabel,
  serverSpecSummary,
  versionsOf,
  type OpsTypeValue,
} from '../ledgerOs';
import {
  certBadge,
  certDaysLeft,
  errMsg,
  fmtDateTime,
  fmtDay,
  httpsOutcomeLabel,
  isInternalAddress,
  isTruthy,
} from '../utils';

function parseOptionalPositiveInt(raw: string, label: string): { ok: true; value: number | null } | { ok: false; error: string } {
  const t = raw.trim();
  if (!t) return { ok: true, value: null };
  if (!/^\d+$/.test(t)) return { ok: false, error: `${label}须为正整数` };
  const n = Number(t);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, error: `${label}须为正整数` };
  return { ok: true, value: n };
}

const inputCls =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200';

/** 扫描结果弹窗里的快捷勾选按钮样式 */
const chipBtnCls =
  'rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40';

type ExternalFilter = 'all' | 'yes' | 'no';
type DomainFilter = 'all' | 'yes' | 'no';
type LinkFilter = 'all' | 'linked' | 'unlinked';

function Modal({
  title,
  description,
  children,
  onClose,
  footer,
  size = 'md',
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  onClose: () => void;
  footer: ReactNode;
  /** md 用于表单，lg 用于需要并排展示新旧值的批量结果 */
  size?: 'md' | 'lg';
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 py-6" onClick={onClose}>
      <div
        className={`flex max-h-full w-full flex-col rounded-2xl border border-slate-200 bg-white shadow-xl ${
          size === 'lg' ? 'max-w-3xl' : 'max-w-lg'
        }`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="border-b border-slate-100 px-6 py-4">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          {description && <div className="mt-1 text-sm text-slate-500">{description}</div>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-6 py-4">{footer}</div>
      </div>
    </div>
  );
}

/** 自绘复选框：不使用系统原生控件，勾选态 / 半选态（全选）样式与自绘下拉保持一致 */
function Checkbox({
  checked,
  indeterminate,
  onChange,
  disabled,
  ariaLabel,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
}) {
  const on = checked || indeterminate === true;
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? 'mixed' : checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-[5px] border transition-colors ${
        on
          ? 'border-slate-900 bg-slate-900 text-white'
          : 'border-slate-300 bg-white text-transparent hover:border-slate-500'
      } ${disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer'}`}
    >
      {indeterminate ? (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" className="h-3 w-3">
          <path d="M4 8h8" strokeLinecap="round" />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" className="h-3 w-3">
          <path d="M3.5 8.5l3 3 6-6.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </button>
  );
}

function Field({
  label,
  required,
  hint,
  error,
  children,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="mb-4 block last:mb-0">
      <span className="mb-1.5 block text-sm font-medium text-slate-700">
        {label}
        {required && <span className="ml-1 text-rose-500">*</span>}
      </span>
      {children}
      {error ? (
        <span className="mt-1 block text-xs text-rose-600">{error}</span>
      ) : (
        hint && <span className="mt-1 block text-xs text-slate-400">{hint}</span>
      )}
    </label>
  );
}

/** 是 / 否 二选一 */
function YesNo({
  value,
  onChange,
  yesLabel = '是',
  noLabel = '否',
}: {
  value: boolean;
  onChange: (next: boolean) => void;
  yesLabel?: string;
  noLabel?: string;
}) {
  return (
    <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5">
      {[
        { v: true, label: yesLabel },
        { v: false, label: noLabel },
      ].map((opt) => (
        <button
          key={String(opt.v)}
          type="button"
          onClick={() => onChange(opt.v)}
          className={`rounded-md px-5 py-1.5 text-sm font-medium transition-colors ${
            value === opt.v ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function ExternalBadge({ on }: { on: boolean }) {
  return on ? (
    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
      开放
    </span>
  ) : (
    <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-500">
      未开放
    </span>
  );
}

/** 扫描结果每行的状态标签 */
const SCAN_STATUS: Record<LedgerScanItem['status'], { label: string; cls: string }> = {
  fill: { label: '可补 IP', cls: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  change: { label: '与已有 IP 不同', cls: 'border-amber-200 bg-amber-50 text-amber-700' },
  same: { label: '无变化', cls: 'border-slate-200 bg-slate-50 text-slate-500' },
  skipped: { label: '已跳过', cls: 'border-slate-200 bg-slate-50 text-slate-500' },
  error: { label: '解析失败', cls: 'border-rose-200 bg-rose-50 text-rose-600' },
  missing: { label: '条目不存在', cls: 'border-rose-200 bg-rose-50 text-rose-600' },
};

function scanSummaryText(s: LedgerScanResult['summary']): string {
  const parts = [`可补 IP ${s.fill} 条`, `与已有 IP 不同 ${s.change} 条`, `无变化 ${s.same} 条`];
  if (s.skipped > 0) parts.push(`跳过 ${s.skipped} 条`);
  if (s.failed > 0) parts.push(`失败 ${s.failed} 条`);
  return `扫描 ${s.total} 条：${parts.join('，')}`;
}

/** HTTPS / 证书探测结果每行的状态标签 */
const HTTPS_STATUS: Record<LedgerScanStatus, { label: string; cls: string }> = {
  fill: { label: '可补结论', cls: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  change: { label: '结论有变化', cls: 'border-amber-200 bg-amber-50 text-amber-700' },
  same: { label: '无变化', cls: 'border-slate-200 bg-slate-50 text-slate-500' },
  skipped: { label: '缺少地址', cls: 'border-slate-200 bg-slate-50 text-slate-500' },
  error: { label: '没有探到', cls: 'border-rose-200 bg-rose-50 text-rose-600' },
  missing: { label: '条目不存在', cls: 'border-rose-200 bg-rose-50 text-rose-600' },
};

function httpsSummaryText(s: LedgerHttpsProbeResult['summary']): string {
  const parts = [`支持 HTTPS ${s.yes} 条`, `仅 HTTP ${s.no} 条`, `未探到 ${s.unknown} 条`];
  if (s.expired > 0) parts.push(`证书已过期 ${s.expired} 条`);
  if (s.expiring > 0) parts.push(`30 天内到期 ${s.expiring} 条`);
  return `探测 ${s.total} 条：${parts.join('，')}`;
}

/** 证书剩余天数的文案（不带「证书」二字，调用处自己拼） */
function certDaysText(daysLeft: number | null): string {
  if (daysLeft === null) return '';
  return daysLeft < 0 ? `已过期 ${Math.abs(daysLeft)} 天` : `剩 ${daysLeft} 天`;
}

/** 证书剩余天数的标签配色：已过期红、30 天内黄、其余绿 */
function certDaysCls(daysLeft: number): string {
  if (daysLeft < 0) return 'border-rose-200 bg-rose-50 text-rose-600';
  if (daysLeft <= 30) return 'border-amber-200 bg-amber-50 text-amber-700';
  return 'border-emerald-200 bg-emerald-50 text-emerald-700';
}

interface FormState {
  name: string;
  ops_unit: string;
  ip: string;
  external_access: boolean;
  domain_applied: boolean;
  domain: string;
  location: string;
  os_name: string;
  os_version: string;
  /** 表单里用字符串承载，便于清空与校验 */
  cpu_cores: string;
  memory_gb: string;
  disk_gb: string;
  sso_integrated: boolean;
  ops_type: OpsTypeValue;
  backup_info: string;
  remark: string;
  system_id: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  ops_unit: '',
  ip: '',
  external_access: false,
  domain_applied: false,
  domain: '',
  location: '',
  os_name: '',
  os_version: '',
  cpu_cores: '',
  memory_gb: '',
  disk_gb: '',
  sso_integrated: false,
  ops_type: '',
  backup_info: '',
  remark: '',
  system_id: '',
};

function formFromEntry(entry: LedgerEntry): FormState {
  const opsType = (entry.ops_type ?? '') as OpsTypeValue;
  return {
    name: entry.name,
    ops_unit: entry.ops_unit ?? '',
    ip: entry.ip ?? '',
    external_access: isTruthy(entry.external_access),
    domain_applied: isTruthy(entry.domain_applied),
    domain: entry.domain ?? '',
    location: entry.location ?? '',
    os_name: entry.os_name ?? '',
    os_version: entry.os_version ?? '',
    cpu_cores: entry.cpu_cores == null ? '' : String(entry.cpu_cores),
    memory_gb: entry.memory_gb == null ? '' : String(entry.memory_gb),
    disk_gb: entry.disk_gb == null ? '' : String(entry.disk_gb),
    sso_integrated: isTruthy(entry.sso_integrated),
    ops_type: opsType === 'long_term' || opsType === 'phased' ? opsType : '',
    backup_info: entry.backup_info ?? '',
    remark: entry.remark ?? '',
    system_id: entry.system_id === null || entry.system_id === undefined ? '' : String(entry.system_id),
  };
}

export default function Ledger() {
  const { hasPermission } = useAuth();
  const confirm = useConfirm();
  const canWrite = hasPermission('ledger.manage');

  const [entries, setEntries] = useState<LedgerEntry[] | null>(null);
  const [systems, setSystems] = useState<SystemInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [externalFilter, setExternalFilter] = useState<ExternalFilter>('all');
  const [domainFilter, setDomainFilter] = useState<DomainFilter>('all');
  const [linkFilter, setLinkFilter] = useState<LinkFilter>('all');

  const [editing, setEditing] = useState<LedgerEntry | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingIds, setPendingIds] = useState<Set<number>>(new Set());
  // 「按域名解析 IP」：按钮 loading、成功提示、失败提示
  const [resolving, setResolving] = useState(false);
  const [resolveNotice, setResolveNotice] = useState<string | null>(null);
  const [resolveError, setResolveError] = useState<string | null>(null);
  // 列表批量选择 + IP 扫描
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [scanResult, setScanResult] = useState<LedgerScanResult | null>(null);
  const [scanChecked, setScanChecked] = useState<Set<number>>(new Set());
  const [scanError, setScanError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  // HTTPS / 证书探测
  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<LedgerHttpsProbeResult | null>(null);
  const [probeChecked, setProbeChecked] = useState<Set<number>>(new Set());
  const [probeError, setProbeError] = useState<string | null>(null);
  const [probeApplying, setProbeApplying] = useState(false);

  const load = useCallback(async () => {
    try {
      const [ledgerRes, systemsRes] = await Promise.all([api.getLedger(), api.listSystems()]);
      setEntries(ledgerRes.entries);
      setSystems(systemsRes.systems ?? []);
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(t);
  }, [notice]);

  // 条目被删除或列表刷新后，丢掉已经不在列表里的选中项
  useEffect(() => {
    if (!entries) return;
    const alive = new Set(entries.map((e) => e.id));
    setSelected((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set([...prev].filter((id) => alive.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [entries]);

  const markPending = (id: number, on: boolean) =>
    setPendingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const filtered = useMemo(() => {
    if (!entries) return null;
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      if (externalFilter !== 'all') {
        const on = isTruthy(e.external_access);
        if (externalFilter === 'yes' ? !on : on) return false;
      }
      if (domainFilter !== 'all') {
        const on = isTruthy(e.domain_applied);
        if (domainFilter === 'yes' ? !on : on) return false;
      }
      if (linkFilter !== 'all') {
        const linked = e.system_id !== null && e.system_id !== undefined;
        if (linkFilter === 'linked' ? !linked : linked) return false;
      }
      if (!q) return true;
      return [
        e.name,
        e.ops_unit,
        e.ip,
        e.domain,
        e.location,
        e.os_name,
        e.os_version,
        serverSpecSummary(e),
        opsTypeLabel(e.ops_type),
        e.backup_info,
        e.remark,
        e.system_name ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(q);
    });
  }, [entries, query, externalFilter, domainFilter, linkFilter]);

  const counts = useMemo(() => {
    const c = { total: 0, external: 0, domain: 0, linked: 0 };
    for (const e of entries ?? []) {
      c.total += 1;
      if (isTruthy(e.external_access)) c.external += 1;
      if (isTruthy(e.domain_applied)) c.domain += 1;
      if (e.system_id !== null && e.system_id !== undefined) c.linked += 1;
    }
    return c;
  }, [entries]);

  // ---- 列表批量选择 ----
  const visibleIds = useMemo(() => (filtered ?? []).map((e) => e.id), [filtered]);
  const selectedVisible = visibleIds.filter((id) => selected.has(id)).length;
  const allVisibleSelected = visibleIds.length > 0 && selectedVisible === visibleIds.length;
  const someVisibleSelected = selectedVisible > 0 && !allVisibleSelected;

  const toggleSelected = (id: number, next: boolean) =>
    setSelected((prev) => {
      const set = new Set(prev);
      if (next) set.add(id);
      else set.delete(id);
      return set;
    });

  /** 全选 / 取消全选：作用于当前筛选出来的列表 */
  const toggleAllVisible = (next: boolean) =>
    setSelected((prev) => {
      const set = new Set(prev);
      for (const id of visibleIds) {
        if (next) set.add(id);
        else set.delete(id);
      }
      return set;
    });

  /** 扫描弹窗里已勾选、且会覆盖已有 IP 的条数 */
  const overwriteCount = (scanResult?.results ?? []).filter(
    (it) => it.status === 'change' && scanChecked.has(it.id),
  ).length;

  /** 扫描结果里可一键纳入的条目：IP 为空的 / 与已有 IP 不同的 */
  const scanFillIds = useMemo(
    () => (scanResult?.results ?? []).filter((it) => it.status === 'fill' && it.resolved_ip).map((it) => it.id),
    [scanResult],
  );
  const scanChangeIds = useMemo(
    () => (scanResult?.results ?? []).filter((it) => it.status === 'change' && it.resolved_ip).map((it) => it.id),
    [scanResult],
  );

  /** IP 扫描：先按域名批量查 DNS（只读），结果给用户在弹窗里复核后才写回 */
  const runScan = async () => {
    if (scanning || selected.size === 0) return;
    setScanning(true);
    setScanError(null);
    setError(null);
    setNotice(null);
    try {
      const r = await api.scanLedgerIps([...selected]);
      setScanResult(r);
      // 默认只勾「IP 为空」的条目；已有 IP 且与解析结果不同的要用户自己勾，避免冲掉人工登记的地址
      setScanChecked(new Set(r.results.filter((it) => it.status === 'fill').map((it) => it.id)));
    } catch (e) {
      setScanError(errMsg(e));
    } finally {
      setScanning(false);
    }
  };

  /** 把弹窗里勾选过的解析结果写回台账 */
  const applyScan = async () => {
    if (!scanResult || applying) return;
    const updates = scanResult.results.flatMap((it) =>
      scanChecked.has(it.id) && it.resolved_ip ? [{ id: it.id, ip: it.resolved_ip }] : [],
    );
    if (updates.length === 0) return;
    setApplying(true);
    setScanError(null);
    try {
      const r = await api.applyLedgerIps(updates);
      setScanResult(null);
      setScanChecked(new Set());
      setSelected(new Set());
      setNotice(
        `已按扫描结果写入 ${r.updated} 条台账的 IP${
          r.overwritten > 0 ? `，其中 ${r.overwritten} 条旧 IP 已记入备注` : ''
        }${r.missing.length > 0 ? `；${r.missing.length} 条已不存在，未写入` : ''}`,
      );
      await load();
    } catch (e) {
      setScanError(errMsg(e));
    } finally {
      setApplying(false);
    }
  };

  /** HTTPS 探测结果里可写入的条目：探到结论的，或「探测过但没探到」（后者默认不勾，可手动勾来留档） */
  const probeWritable = (it: LedgerHttpsProbeItem) =>
    it.status === 'fill' || it.status === 'change' || it.https === 'unknown';

  const probeFillIds = useMemo(
    () => (probeResult?.results ?? []).filter((it) => it.status === 'fill').map((it) => it.id),
    [probeResult],
  );
  const probeChangeIds = useMemo(
    () => (probeResult?.results ?? []).filter((it) => it.status === 'change').map((it) => it.id),
    [probeResult],
  );
  const probeUnknownIds = useMemo(
    () => (probeResult?.results ?? []).filter((it) => it.status === 'error').map((it) => it.id),
    [probeResult],
  );

  /** HTTPS / 证书探测：只做 TLS 握手与 HTTP 跳转检查（只读），结果复核后才写回 */
  const runProbe = async () => {
    if (probing || selected.size === 0) return;
    setProbing(true);
    setProbeError(null);
    setError(null);
    setNotice(null);
    try {
      const r = await api.probeLedgerHttps([...selected]);
      setProbeResult(r);
      // 默认只勾还没结论的条目；已有结论的改动要用户自己勾，避免覆盖掉核对过的结论
      setProbeChecked(new Set(r.results.filter((it) => it.status === 'fill').map((it) => it.id)));
    } catch (e) {
      setProbeError(errMsg(e));
    } finally {
      setProbing(false);
    }
  };

  /** 把弹窗里勾选过的探测结论与依据写回台账 */
  const applyProbe = async () => {
    if (!probeResult || probeApplying) return;
    const updates = probeResult.results.flatMap((it) =>
      probeChecked.has(it.id) && it.https
        ? [
            {
              id: it.id,
              https: it.https,
              expires_at: it.cert?.validTo ?? null,
              target: it.target ?? '',
              lines: it.evidence,
            },
          ]
        : [],
    );
    if (updates.length === 0) return;
    setProbeApplying(true);
    setProbeError(null);
    try {
      const r = await api.applyLedgerHttps(updates);
      setProbeResult(null);
      setProbeChecked(new Set());
      setSelected(new Set());
      setNotice(
        `已写入 ${r.updated} 条台账的 HTTPS / 证书结论${
          r.missing.length > 0 ? `；${r.missing.length} 条已不存在，未写入` : ''
        }`,
      );
      await load();
    } catch (e) {
      setProbeError(errMsg(e));
    } finally {
      setProbeApplying(false);
    }
  };

  const openCreate = () => {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setResolveNotice(null);
    setResolveError(null);
    setFormOpen(true);
  };

  const openEdit = (entry: LedgerEntry) => {
    setEditing(entry);
    setForm(formFromEntry(entry));
    setFormError(null);
    setResolveNotice(null);
    setResolveError(null);
    setFormOpen(true);
  };

  const domainMissing = form.domain_applied && !form.domain.trim();

  /** 调服务端按域名查 DNS，把解析到的 IP 填进 IP 字段 */
  const doResolve = async () => {
    const domain = form.domain.trim();
    if (!domain) {
      setResolveError('请先填写域名再解析');
      return;
    }
    if (resolving) return;
    setResolving(true);
    setResolveError(null);
    setResolveNotice(null);
    try {
      const r = await api.resolveLedgerDomain(domain);
      const first = r.addresses[0];
      if (!first) {
        setResolveError('DNS 没有返回地址记录');
        return;
      }
      // 已有 IP 且与解析结果不同：先确认，避免覆盖人工维护的地址
      const current = form.ip.trim();
      if (current && current !== first.address) {
        const accepted = await confirm({
          title: '替换已有 IP？',
          message: `${domain} 解析到 ${first.address}，当前 IP 是「${current}」。\n确认后会用解析结果覆盖 IP 字段。`,
          confirmText: '替换 IP',
          cancelText: '保留原值',
        });
        if (!accepted) {
          setResolveNotice(`解析到 ${first.address}，已按你的选择保留原 IP`);
          return;
        }
      }
      setForm((f) => ({ ...f, ip: first.address }));
      const rest = r.addresses.slice(1).filter((a) => a.address !== first.address);
      const more = rest.length > 0 ? `；另有 ${rest.map((a) => a.address).join('、')}，需要时手动补进 IP` : '';
      setResolveNotice(`解析成功（${r.elapsed_ms}ms）：已填入 ${first.address}${more}`);
    } catch (e) {
      setResolveError(errMsg(e));
    } finally {
      setResolving(false);
    }
  };

  const submit = async () => {
    if (saving) return;
    if (!form.name.trim()) {
      setFormError('系统名称必填');
      return;
    }
    if (domainMissing) {
      setFormError('已申请域名时，域名必填');
      return;
    }
    if (form.domain.trim() && /:\/\//.test(form.domain)) {
      setFormError('域名只填主机名，不要带 http:// 或 https:// 前缀');
      return;
    }
    const cpu = parseOptionalPositiveInt(form.cpu_cores, 'CPU 核心数');
    if (!cpu.ok) {
      setFormError(cpu.error);
      return;
    }
    const mem = parseOptionalPositiveInt(form.memory_gb, '内存');
    if (!mem.ok) {
      setFormError(mem.error);
      return;
    }
    const disk = parseOptionalPositiveInt(form.disk_gb, '硬盘');
    if (!disk.ok) {
      setFormError(disk.error);
      return;
    }
    setSaving(true);
    setFormError(null);
    const payload = {
      name: form.name.trim(),
      ops_unit: form.ops_unit.trim(),
      ip: form.ip.trim(),
      external_access: form.external_access,
      domain_applied: form.domain_applied,
      domain: form.domain_applied ? form.domain.trim() : '',
      location: form.location.trim(),
      os_name: form.os_name.trim(),
      os_version: form.os_version.trim(),
      cpu_cores: cpu.value,
      memory_gb: mem.value,
      disk_gb: disk.value,
      sso_integrated: form.sso_integrated,
      ops_type: form.ops_type,
      backup_info: form.backup_info.trim(),
      remark: form.remark.trim(),
      system_id: form.system_id === '' ? null : Number(form.system_id),
    };
    try {
      if (editing) {
        await api.updateLedgerEntry(editing.id, payload);
        setNotice(`已更新台账「${payload.name}」`);
      } else {
        await api.createLedgerEntry(payload);
        setNotice(`已新增台账「${payload.name}」`);
      }
      setFormOpen(false);
      await load();
    } catch (e) {
      setFormError(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (entry: LedgerEntry) => {
    if (pendingIds.has(entry.id)) return;
    if (
      !(await confirm({
        title: '删除台账条目',
        message: `确定删除「${entry.name}」？\n\n仅删除台账登记信息，不影响对应的监控系统与告警。此操作不可撤销。`,
        confirmText: '删除条目',
        danger: true,
      }))
    )
      return;
    markPending(entry.id, true);
    setError(null);
    try {
      await api.deleteLedgerEntry(entry.id);
      setEntries((prev) => (prev ? prev.filter((e) => e.id !== entry.id) : prev));
      setNotice(`已删除「${entry.name}」`);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      markPending(entry.id, false);
    }
  };

  const filterChip = <T extends string>(
    current: T,
    value: T,
    label: string,
    onPick: (next: T) => void,
  ) => (
    <button
      key={value}
      type="button"
      onClick={() => onPick(value)}
      className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
        current === value ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-800'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="系统台账"
        description="登记系统的运维单位、IP、操作系统与服务器配置、是否对接统一身份认证、运维类型、备份情况、外网开放与域名、物理机位置；可选关联到监控系统。"
        actions={
          canWrite ? (
            <button
              type="button"
              onClick={openCreate}
              className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
            >
              新增台账
            </button>
          ) : undefined
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {(
          [
            { label: '台账条目', value: counts.total, hint: '全部登记系统' },
            { label: '开放外网', value: counts.external, hint: '需重点关注暴露面' },
            { label: '已申请域名', value: counts.domain, hint: '走域名访问' },
            { label: '已关联监控', value: counts.linked, hint: '与监控系统挂钩' },
          ] as const
        ).map((s) => (
          <div key={s.label} className="rounded-xl border border-slate-200 bg-white px-4 py-3">
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-medium text-slate-500">{s.label}</span>
              <span className="text-lg font-semibold tabular-nums text-slate-900">{s.value}</span>
            </div>
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">{s.hint}</p>
          </div>
        ))}
      </div>

      {error && (
        <div className="mb-4">
          <ErrorBanner message={error} />
        </div>
      )}
      {notice && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-5 py-3.5">
          <h3 className="text-sm font-semibold text-slate-900">台账列表</h3>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-0.5 rounded-lg border border-slate-200 bg-slate-50 p-0.5">
              {filterChip<ExternalFilter>(externalFilter, 'all', '外网全部', setExternalFilter)}
              {filterChip<ExternalFilter>(externalFilter, 'yes', '开放', setExternalFilter)}
              {filterChip<ExternalFilter>(externalFilter, 'no', '未开放', setExternalFilter)}
            </div>
            <div className="flex items-center gap-0.5 rounded-lg border border-slate-200 bg-slate-50 p-0.5">
              {filterChip<DomainFilter>(domainFilter, 'all', '域名全部', setDomainFilter)}
              {filterChip<DomainFilter>(domainFilter, 'yes', '已申请', setDomainFilter)}
              {filterChip<DomainFilter>(domainFilter, 'no', '未申请', setDomainFilter)}
            </div>
            <div className="flex items-center gap-0.5 rounded-lg border border-slate-200 bg-slate-50 p-0.5">
              {filterChip<LinkFilter>(linkFilter, 'all', '关联全部', setLinkFilter)}
              {filterChip<LinkFilter>(linkFilter, 'linked', '已关联', setLinkFilter)}
              {filterChip<LinkFilter>(linkFilter, 'unlinked', '未关联', setLinkFilter)}
            </div>
            <input
              className={`${inputCls} w-56 !py-1.5`}
              placeholder="搜索名称 / 运维单位 / IP / 域名 / 位置…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        {/* 批量操作条：勾选若干条或全选，一键按域名查 DNS 回填 IP，或探测 HTTPS 与证书 */}
        {canWrite && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-100 bg-slate-50/60 px-5 py-2.5">
            <Checkbox
              checked={allVisibleSelected}
              indeterminate={someVisibleSelected}
              disabled={visibleIds.length === 0}
              onChange={(next) => toggleAllVisible(next)}
              ariaLabel="全选当前列表"
            />
            <button
              type="button"
              disabled={visibleIds.length === 0}
              onClick={() => toggleAllVisible(!allVisibleSelected)}
              className="text-xs font-medium text-slate-600 transition-colors hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-50"
            >
              全选
            </button>
            {selected.size > 0 ? (
              <>
                <span className="text-xs text-slate-500">
                  已选 {selected.size} 条
                  {selectedVisible !== selected.size ? `（当前列表内 ${selectedVisible} 条）` : ''}
                </span>
                <button
                  type="button"
                  onClick={() => setSelected(new Set())}
                  className="text-xs font-medium text-slate-400 transition-colors hover:text-slate-700"
                >
                  清空选择
                </button>
              </>
            ) : (
              <span className="text-xs text-slate-400">勾选条目后可批量查 DNS 回填 IP，或探测 HTTPS 与证书有效期</span>
            )}
            <div className="ml-auto flex flex-wrap items-center gap-3">
              <span className="hidden text-[11px] text-slate-400 sm:inline">
                两次操作都只读网络、不改数据，结果确认后才写入
              </span>
              <button
                type="button"
                disabled={selected.size === 0 || probing}
                onClick={() => void runProbe()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {probing && <Spinner className="h-3.5 w-3.5" />}
                {probing ? '探测中…' : 'HTTPS 探测'}
              </button>
              <button
                type="button"
                disabled={selected.size === 0 || scanning || probing}
                onClick={() => void runScan()}
                className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {scanning && <Spinner className="h-3.5 w-3.5 border-white/40 border-t-white" />}
                {scanning ? '扫描中…' : 'IP 扫描'}
              </button>
            </div>
          </div>
        )}

        {!filtered ? (
          <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-400">
            <Spinner /> 加载中…
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-5 py-12 text-center text-sm text-slate-400">
            {entries && entries.length === 0 ? (
              <div className="flex flex-col items-center gap-3">
                <span>还没有台账条目</span>
                {canWrite && (
                  <button
                    type="button"
                    onClick={openCreate}
                    className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700"
                  >
                    新增第一条
                  </button>
                )}
              </div>
            ) : (
              '没有匹配的台账条目'
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            {/* 列较多，给表格一个最小宽度：窄屏时横向滚动，避免列被压成逐字换行 */}
            <table className="w-full min-w-[1680px] text-sm">
              <thead>
                <tr className="whitespace-nowrap border-b border-slate-100 bg-slate-50/80 text-left text-xs text-slate-400">
                  {canWrite && (
                    <th className="w-10 py-3 pl-5 pr-0 font-medium">
                      <Checkbox
                        checked={allVisibleSelected}
                        indeterminate={someVisibleSelected}
                        disabled={visibleIds.length === 0}
                        onChange={(next) => toggleAllVisible(next)}
                        ariaLabel="全选当前列表"
                      />
                    </th>
                  )}
                  <th className={`py-3 font-medium ${canWrite ? 'pl-2 pr-3' : 'px-5'}`}>系统名称</th>
                  <th className="px-3 py-3 font-medium">运维单位</th>
                  <th className="px-3 py-3 font-medium">IP</th>
                  <th className="px-3 py-3 font-medium">操作系统</th>
                  <th className="px-3 py-3 font-medium">服务器配置</th>
                  <th className="px-3 py-3 font-medium">统一身份认证</th>
                  <th className="px-3 py-3 font-medium">运维类型</th>
                  <th className="px-3 py-3 font-medium">外网访问</th>
                  <th className="px-3 py-3 font-medium">域名</th>
                  <th className="px-3 py-3 font-medium">HTTPS / 证书</th>
                  <th className="px-3 py-3 font-medium">物理机位置</th>
                  <th className="px-3 py-3 font-medium">关联监控</th>
                  <th className="px-3 py-3 font-medium">备注</th>
                  {canWrite && (
                    /* 操作列常驻表格右侧：数据列横向滚动时按钮始终可见 */
                    <th className="sticky right-0 z-20 w-32 border-l border-slate-100 bg-slate-50 px-5 py-3 text-right font-medium shadow-[-8px_0_12px_-12px_rgba(15,23,42,0.18)]">
                      操作
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {filtered.map((e) => {
                  const busy = pendingIds.has(e.id);
                  const picked = selected.has(e.id);
                  // HTTPS / 证书列：有证书有效期就先说还能用多久，否则退回探测结论
                  const cert = certBadge(e);
                  const certTitle = e.https_checked_at
                    ? `最近探测 ${fmtDateTime(e.https_checked_at)} · ${httpsOutcomeLabel(e.https_supported)}${
                        e.cert_expires_at ? ` · 证书 ${fmtDay(e.cert_expires_at)} 到期` : ''
                      }`
                    : '还没探测过：勾选后点「HTTPS 探测」';
                  return (
                    <tr
                      key={e.id}
                      className={`group border-b border-slate-50 last:border-0 ${
                        picked ? 'bg-indigo-50 hover:bg-indigo-100/70' : 'hover:bg-slate-50'
                      }`}
                    >
                      {canWrite && (
                        <td className="py-3.5 pl-5 pr-0">
                          <Checkbox
                            checked={picked}
                            onChange={(next) => toggleSelected(e.id, next)}
                            ariaLabel={`选择「${e.name}」`}
                          />
                        </td>
                      )}
                      <td className={`whitespace-nowrap py-3.5 ${canWrite ? 'pl-2 pr-3' : 'px-5'}`}>
                        <span className="font-medium text-slate-900">{e.name}</span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3.5 text-slate-600">
                        {e.ops_unit || <span className="text-slate-300">—</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3.5">
                        {e.ip ? (
                          <span className="font-mono text-xs text-slate-600">{e.ip}</span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3.5 text-slate-600">
                        {osSummary(e) || <span className="text-slate-300">—</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3.5 font-mono text-xs text-slate-600">
                        {serverSpecSummary(e) || <span className="font-sans text-sm text-slate-300">—</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3.5">
                        {isTruthy(e.sso_integrated) ? (
                          <span className="inline-flex items-center rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-700">
                            已对接
                          </span>
                        ) : (
                          <span className="text-slate-300">未对接</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3.5 text-slate-600">
                        {opsTypeLabel(e.ops_type) || <span className="text-slate-300">—</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3.5">
                        <ExternalBadge on={isTruthy(e.external_access)} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-3.5">
                        {isTruthy(e.domain_applied) && e.domain ? (
                          <a
                            href={`https://${e.domain}`}
                            target="_blank"
                            rel="noreferrer"
                            className="font-mono text-xs text-indigo-600 hover:underline"
                            title="在新标签以 https 打开"
                          >
                            {e.domain}
                          </a>
                        ) : isTruthy(e.domain_applied) ? (
                          <span className="text-xs text-amber-600">已申请·未填</span>
                        ) : (
                          <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-medium text-slate-500">
                            未申请
                          </span>
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3.5">
                        <span
                          className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${cert.cls}`}
                          title={certTitle}
                        >
                          {cert.label}
                        </span>
                      </td>
                      <td className="whitespace-nowrap px-3 py-3.5 text-slate-600">
                        {e.location || <span className="text-slate-300">—</span>}
                      </td>
                      <td className="whitespace-nowrap px-3 py-3.5">
                        {e.system_id !== null && e.system_id !== undefined ? (
                          <Link
                            to={`/systems/${e.system_id}`}
                            className="text-indigo-600 hover:underline"
                            title={e.system_base_url ?? ''}
                          >
                            {e.system_name ?? `#${e.system_id}`}
                          </Link>
                        ) : (
                          <span className="text-xs text-slate-400">未关联</span>
                        )}
                      </td>
                      <td className="w-[16rem] max-w-[16rem] px-3 py-3.5">
                        {e.remark ? (
                          <span className="block truncate text-slate-600" title={e.remark}>
                            {e.remark}
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      {canWrite && (
                        <td
                          className={`sticky right-0 z-10 whitespace-nowrap border-l border-slate-100 px-5 py-3.5 text-right shadow-[-8px_0_12px_-12px_rgba(15,23,42,0.18)] ${
                            picked ? 'bg-indigo-50' : 'bg-white group-hover:bg-slate-50'
                          }`}
                        >
                          <div className="flex items-center justify-end gap-1">
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => openEdit(e)}
                              className="rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-40"
                            >
                              编辑
                            </button>
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => void remove(e)}
                              className="rounded-lg border border-rose-200 px-2.5 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-40"
                            >
                              删除
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {filtered && filtered.length > 0 && (
          <div className="border-t border-slate-100 px-5 py-2.5 text-xs text-slate-400">
            显示 {filtered.length} / {entries?.length ?? 0} 条
          </div>
        )}
      </Card>

      {formOpen && (
        <Modal
          title={editing ? `编辑台账 · ${editing.name}` : '新增台账'}
          description="系统名称必填；「是否申请域名」选「是」时必须填写域名，选「否」时不需要填写。"
          onClose={() => !saving && setFormOpen(false)}
          footer={
            <>
              <button
                type="button"
                disabled={saving}
                onClick={() => setFormOpen(false)}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              >
                取消
              </button>
              <button
                type="button"
                disabled={saving || !form.name.trim() || domainMissing}
                onClick={() => void submit()}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
              >
                {saving && <Spinner className="border-white/40 border-t-white" />}
                {editing ? '保存修改' : '创建条目'}
              </button>
            </>
          }
        >
          {formError && (
            <div className="mb-4">
              <ErrorBanner message={formError} />
            </div>
          )}

          <Field label="系统名称" required>
            <input
              className={inputCls}
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              autoFocus
              placeholder="例如 统一身份认证平台"
            />
          </Field>

          <Field label="运维单位" hint="责任单位或运维厂商，例如 信息化办公室 / XX 科技公司；可留空">
            <input
              className={inputCls}
              value={form.ops_unit}
              onChange={(e) => setForm((f) => ({ ...f, ops_unit: e.target.value }))}
              placeholder="例如 信息化办公室"
            />
          </Field>

          <Field label="IP" hint="支持 IPv4 / IPv6，可带掩码；多个用逗号或空格分隔，例如 10.0.0.11, 10.0.0.12">
            <input
              className={`${inputCls} font-mono`}
              value={form.ip}
              onChange={(e) => setForm((f) => ({ ...f, ip: e.target.value }))}
              placeholder="10.0.0.11"
            />
            {/* 已申请域名时可让服务器按 DNS 解析，把 IP 自动填进来 */}
            {form.domain_applied && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => void doResolve()}
                  disabled={resolving || !form.domain.trim()}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {resolving && <Spinner className="h-3.5 w-3.5" />}
                  按域名解析 IP
                </button>
                {resolveNotice ? (
                  <span className="text-xs text-emerald-600">{resolveNotice}</span>
                ) : (
                  resolveError && <span className="text-xs text-rose-600">{resolveError}</span>
                )}
              </div>
            )}
          </Field>

          <div className="mb-4 flex flex-wrap gap-8">
            <div>
              <span className="mb-1.5 block text-sm font-medium text-slate-700">是否开放外网访问</span>
              <YesNo
                value={form.external_access}
                onChange={(next) => setForm((f) => ({ ...f, external_access: next }))}
                yesLabel="是"
                noLabel="否"
              />
            </div>
          </div>

          {/* 域名联动：先选「是」/「否」；选「是」强制填域名，选「否」不允许填 */}
          <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50/70 px-4 pt-3.5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm font-medium text-slate-700">是否申请域名</span>
              <YesNo
                value={form.domain_applied}
                onChange={(next) => {
                  setResolveNotice(null);
                  setResolveError(null);
                  setForm((f) => ({ ...f, domain_applied: next }));
                }}
                yesLabel="是"
                noLabel="否"
              />
            </div>
            <Field
              label="域名"
              required={form.domain_applied}
              hint={
                form.domain_applied
                  ? '只填主机名，可带端口，例如 oa.example.com；填好后可到下方 IP 处「按域名解析 IP」自动填入'
                  : '已选择「否」，不需要填写域名；保存时会清空该条目的域名'
              }
              error={form.domain_applied && form.domain === '' ? '选择「是」后必须填写域名' : undefined}
            >
              <input
                className={`${inputCls} font-mono ${
                  form.domain_applied ? '' : 'cursor-not-allowed bg-slate-100 text-slate-400'
                }`}
                value={form.domain_applied ? form.domain : ''}
                disabled={!form.domain_applied}
                onChange={(e) => {
                  setFormError(null);
                  setResolveNotice(null);
                  setResolveError(null);
                  setForm((f) => ({ ...f, domain: e.target.value }));
                }}
                placeholder={form.domain_applied ? 'oa.example.com' : '未申请域名，无需填写'}
              />
            </Field>
          </div>

          <Field label="物理机位置" hint="机房 / 机柜 / U 位等，便于现场排查">
            <input
              className={inputCls}
              value={form.location}
              onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
              placeholder="例如 核心机房 A03 机柜 12U"
            />
          </Field>

          {/* 操作系统：先选发行版，再选版本；「其他」可手填版本号 */}
          <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="操作系统" hint="先选系统，再选版本">
              <Select
                value={form.os_name}
                onChange={(v) =>
                  setForm((f) => ({
                    ...f,
                    os_name: v,
                    // 切换发行版时清掉旧版本，避免 CentOS 7 残留到 Ubuntu
                    os_version: '',
                  }))
                }
                ariaLabel="操作系统"
                options={[
                  { value: '', label: '未选择', divider: true },
                  ...OS_FAMILIES.map((f) => ({ value: f.name, label: f.name })),
                ]}
              />
            </Field>
            <Field
              label="系统版本"
              hint={
                form.os_name === '其他'
                  ? '可自由填写版本号'
                  : form.os_name
                    ? '从该系统常见版本中选择'
                    : '请先选择操作系统'
              }
            >
              {form.os_name === '其他' || (form.os_name && versionsOf(form.os_name).length === 0) ? (
                <input
                  className={inputCls}
                  value={form.os_version}
                  onChange={(e) => setForm((f) => ({ ...f, os_version: e.target.value }))}
                  placeholder="例如 自定义发行版版本号"
                  disabled={!form.os_name}
                />
              ) : (
                <Select
                  value={form.os_version}
                  onChange={(v) => setForm((f) => ({ ...f, os_version: v }))}
                  ariaLabel="系统版本"
                  disabled={!form.os_name}
                  options={[
                    { value: '', label: form.os_name ? '未选择' : '请先选操作系统', divider: true },
                    ...versionsOf(form.os_name).map((ver) => ({ value: ver, label: ver })),
                  ]}
                />
              )}
            </Field>
          </div>

          <div className="mb-1">
            <span className="mb-1.5 block text-sm font-medium text-slate-700">服务器配置</span>
            <p className="mb-2 text-xs text-slate-400">CPU 核数、内存与硬盘容量；均可留空</p>
          </div>
          <div className="mb-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="CPU（核心）">
              <input
                className={inputCls}
                inputMode="numeric"
                value={form.cpu_cores}
                onChange={(e) => setForm((f) => ({ ...f, cpu_cores: e.target.value.replace(/[^\d]/g, '') }))}
                placeholder="例如 8"
              />
            </Field>
            <Field label="内存（GB）">
              <input
                className={inputCls}
                inputMode="numeric"
                value={form.memory_gb}
                onChange={(e) => setForm((f) => ({ ...f, memory_gb: e.target.value.replace(/[^\d]/g, '') }))}
                placeholder="例如 16"
              />
            </Field>
            <Field label="硬盘（GB）">
              <input
                className={inputCls}
                inputMode="numeric"
                value={form.disk_gb}
                onChange={(e) => setForm((f) => ({ ...f, disk_gb: e.target.value.replace(/[^\d]/g, '') }))}
                placeholder="例如 500"
              />
            </Field>
          </div>

          <div className="mb-4 flex flex-wrap gap-8">
            <div>
              <span className="mb-1.5 block text-sm font-medium text-slate-700">是否对接统一身份认证</span>
              <YesNo
                value={form.sso_integrated}
                onChange={(next) => setForm((f) => ({ ...f, sso_integrated: next }))}
                yesLabel="是"
                noLabel="否"
              />
            </div>
          </div>

          <Field label="运维类型">
            <Select
              value={form.ops_type}
              onChange={(v) => setForm((f) => ({ ...f, ops_type: v as OpsTypeValue }))}
              ariaLabel="运维类型"
              options={[
                { value: '', label: '未选择', divider: true },
                ...OPS_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label })),
              ]}
            />
          </Field>

          <Field label="备份情况" hint="备份策略、周期、存放位置等">
            <textarea
              className={`${inputCls} min-h-20 resize-y`}
              value={form.backup_info}
              onChange={(e) => setForm((f) => ({ ...f, backup_info: e.target.value }))}
              placeholder="例如 每日增量 + 每周全量，备份至灾备机房"
            />
          </Field>

          <Field label="关联监控系统" hint="可选；关联后可直接跳到该系统的监控详情">
            <Select
              value={form.system_id}
              onChange={(v) => setForm((f) => ({ ...f, system_id: v }))}
              ariaLabel="关联监控系统"
              options={[
                { value: '', label: '不关联', divider: true },
                ...systems.map((s) => ({ value: String(s.id), label: s.name })),
              ]}
            />
          </Field>

          {/* HTTPS / 证书结论只由探测写入，这里只读展示，不参与人工登记 */}
          {editing && (editing.https_supported !== '' || editing.cert_evidence !== '') && (
            <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50/70 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium text-slate-700">HTTPS / 证书（由探测维护，不能手改）</span>
                <span className="text-xs text-slate-400">
                  {editing.https_checked_at ? `最近探测 ${fmtDateTime(editing.https_checked_at)}` : '还没探测过'}
                </span>
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
                <span
                  className={`inline-flex items-center rounded-full border px-2 py-0.5 font-medium ${
                    certBadge(editing).cls
                  }`}
                >
                  {httpsOutcomeLabel(editing.https_supported)}
                </span>
                {editing.cert_expires_at ? (
                  <span className="text-slate-500">
                    证书 {fmtDay(editing.cert_expires_at)} 到期（{certDaysText(certDaysLeft(editing.cert_expires_at))}）
                  </span>
                ) : null}
              </div>
              {editing.cert_evidence && (
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11px] leading-relaxed text-slate-500">
                  {editing.cert_evidence}
                </pre>
              )}
            </div>
          )}

          <Field label="备注">
            <textarea
              className={`${inputCls} min-h-24 resize-y`}
              value={form.remark}
              onChange={(e) => setForm((f) => ({ ...f, remark: e.target.value }))}
              placeholder="负责人、开通时间、特殊说明等"
            />
          </Field>
        </Modal>
      )}

      {/* IP 扫描结果：先复核新旧 IP，勾选后才写回台账 */}
      {scanResult && (
        <Modal
          title="IP 扫描结果"
          description={
            <>
              <p>{scanSummaryText(scanResult.summary)}</p>
              <p className="mt-1 text-xs text-slate-400">
                这次扫描只查了 DNS，还没有改动台账。勾选下方要写入的条目，再点「写入台账」。
              </p>
            </>
          }
          size="lg"
          onClose={() => !applying && setScanResult(null)}
          footer={
            <>
              <span className="mr-auto text-xs text-slate-500">
                {scanChecked.size > 0
                  ? `将写入 ${scanChecked.size} 条${
                      overwriteCount > 0 ? `（其中覆盖已有 IP ${overwriteCount} 条，旧值会记入备注）` : ''
                    }`
                  : '勾选要写入的条目'}
              </span>
              <button
                type="button"
                disabled={applying}
                onClick={() => setScanResult(null)}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              >
                关闭
              </button>
              <button
                type="button"
                disabled={applying || scanChecked.size === 0}
                onClick={() => void applyScan()}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
              >
                {applying && <Spinner className="border-white/40 border-t-white" />}
                写入台账
              </button>
            </>
          }
        >
          {scanError && (
            <div className="mb-4">
              <ErrorBanner message={scanError} />
            </div>
          )}

          {scanResult.results.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <button type="button" className={chipBtnCls} onClick={() => setScanChecked(new Set(scanFillIds))}>
                只选空值 ({scanFillIds.length})
              </button>
              <button
                type="button"
                className={chipBtnCls}
                disabled={scanChangeIds.length === 0}
                onClick={() => setScanChecked((prev) => new Set([...prev, ...scanChangeIds]))}
              >
                加上全部差异项 ({scanChangeIds.length})
              </button>
              <button
                type="button"
                className={chipBtnCls}
                disabled={scanChecked.size === 0}
                onClick={() => setScanChecked(new Set())}
              >
                全不选
              </button>
              <span className="ml-auto text-xs text-slate-400">已勾选 {scanChecked.size} 条</span>
            </div>
          )}

          {scanResult.summary.change > 0 && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs leading-relaxed text-amber-700">
              有 {scanResult.summary.change} 条记录的已有 IP 与解析结果不同（常见于台账登记内网地址、DNS 返回公网地址），
              默认不勾选；确认要改的可以逐条勾，或点上方「加上全部差异项」一键纳入。写入时旧 IP 会自动记入备注留痕。
            </div>
          )}

          {scanResult.results.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">没有可扫描的条目</p>
          ) : (
            <div className="space-y-2">
              {scanResult.results.map((it) => {
                const writable = (it.status === 'fill' || it.status === 'change') && it.resolved_ip !== null;
                const checked = scanChecked.has(it.id);
                const badge = SCAN_STATUS[it.status];
                return (
                  <div
                    key={it.id}
                    className={`flex items-start gap-3 rounded-xl border px-3.5 py-2.5 ${
                      checked ? 'border-indigo-200 bg-indigo-50/50' : 'border-slate-200'
                    }`}
                  >
                    <span className="pt-1">
                      <Checkbox
                        checked={checked}
                        disabled={!writable}
                        onChange={(next) =>
                          setScanChecked((prev) => {
                            const set = new Set(prev);
                            if (next) set.add(it.id);
                            else set.delete(it.id);
                            return set;
                          })
                        }
                        ariaLabel={`写入「${it.name}」的 IP`}
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-sm font-medium text-slate-900">{it.name}</span>
                        {it.domain && <span className="font-mono text-xs text-slate-500">{it.domain}</span>}
                        <span
                          className={`ml-auto inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${badge.cls}`}
                        >
                          {badge.label}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        <span className="text-slate-400">当前 IP</span>
                        <span className={`font-mono ${it.current_ip ? 'text-slate-600' : 'text-slate-300'}`}>
                          {it.current_ip || '空'}
                        </span>
                        <span className="text-slate-300">→</span>
                        <span className="text-slate-400">解析</span>
                        <span
                          className={`font-mono ${it.resolved_ip ? 'font-medium text-slate-900' : 'text-slate-300'}`}
                        >
                          {it.resolved_ip ?? '—'}
                        </span>
                        {it.status === 'change' &&
                          isInternalAddress(it.current_ip) &&
                          !isInternalAddress(it.resolved_ip) && (
                            <span
                              className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700"
                              title="台账登记的是内网地址，DNS 返回的是公网地址；写入后旧 IP 会记入备注"
                            >
                              内网 → 公网
                            </span>
                          )}
                        {it.elapsed_ms > 0 && <span className="text-slate-400">{it.elapsed_ms}ms</span>}
                      </div>
                      {it.addresses.length > 1 && (
                        <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                          DNS 共返回 {it.addresses.length} 个地址：
                          {it.addresses.map((a) => a.address).join('、')}，默认写入第一个；其余需要时手动补进 IP
                        </p>
                      )}
                      {it.message && <p className="mt-1 text-[11px] text-slate-500">{it.message}</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Modal>
      )}

      {/* HTTPS / 证书探测结果：先复核结论与证书，勾选后才写回台账 */}
      {probeResult && (
        <Modal
          title="HTTPS / 证书探测结果"
          description={
            <>
              <p>{httpsSummaryText(probeResult.summary)}</p>
              <p className="mt-1 text-xs text-slate-400">
                这次只做了 TLS 握手与 HTTP 跳转检查，还没有改动台账。勾选下方要写入的条目，再点「写入台账」；
                写入时探测依据会一起存档。
              </p>
            </>
          }
          size="lg"
          onClose={() => !probeApplying && setProbeResult(null)}
          footer={
            <>
              <span className="mr-auto text-xs text-slate-500">
                {probeChecked.size > 0 ? `将写入 ${probeChecked.size} 条` : '勾选要写入的条目'}
              </span>
              <button
                type="button"
                disabled={probeApplying}
                onClick={() => setProbeResult(null)}
                className="rounded-lg border border-slate-200 px-4 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-40"
              >
                关闭
              </button>
              <button
                type="button"
                disabled={probeApplying || probeChecked.size === 0}
                onClick={() => void applyProbe()}
                className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-40"
              >
                {probeApplying && <Spinner className="border-white/40 border-t-white" />}
                写入台账
              </button>
            </>
          }
        >
          {probeError && (
            <div className="mb-4">
              <ErrorBanner message={probeError} />
            </div>
          )}

          {probeResult.results.length > 0 && (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={chipBtnCls}
                onClick={() => setProbeChecked(new Set(probeFillIds))}
              >
                只选还没结论的 ({probeFillIds.length})
              </button>
              <button
                type="button"
                className={chipBtnCls}
                disabled={probeChangeIds.length === 0}
                onClick={() => setProbeChecked((prev) => new Set([...prev, ...probeChangeIds]))}
              >
                加上结论变化 ({probeChangeIds.length})
              </button>
              <button
                type="button"
                className={chipBtnCls}
                disabled={probeUnknownIds.length === 0}
                onClick={() => setProbeChecked((prev) => new Set([...prev, ...probeUnknownIds]))}
              >
                加上没探到的 ({probeUnknownIds.length})
              </button>
              <button
                type="button"
                className={chipBtnCls}
                disabled={probeChecked.size === 0}
                onClick={() => setProbeChecked(new Set())}
              >
                全不选
              </button>
              <span className="ml-auto text-xs text-slate-400">已勾选 {probeChecked.size} 条</span>
            </div>
          )}

          {probeResult.summary.change > 0 && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs leading-relaxed text-amber-700">
              有 {probeResult.summary.change} 条已有结论与本次探测不同，默认不勾选；确认要改的可以逐条勾，或点上方「加上结论变化」一键纳入。
              台账的 HTTPS 结论、证书有效期与探测依据完全由探测维护，覆盖不会动到人工登记的字段，所以不留备注痕迹。
            </div>
          )}

          {probeResult.results.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">没有可探测的条目</p>
          ) : (
            <div className="space-y-2">
              {probeResult.results.map((it) => {
                const writable = probeWritable(it);
                const checked = probeChecked.has(it.id);
                const badge = HTTPS_STATUS[it.status];
                const daysLeft = it.cert?.daysLeft ?? null;
                const target = it.target ?? (it.domain || it.ip || '没填地址');
                return (
                  <div
                    key={it.id}
                    className={`flex items-start gap-3 rounded-xl border px-3.5 py-2.5 ${
                      checked ? 'border-indigo-200 bg-indigo-50/50' : 'border-slate-200'
                    }`}
                  >
                    <span className="pt-1">
                      <Checkbox
                        checked={checked}
                        disabled={!writable}
                        onChange={(next) =>
                          setProbeChecked((prev) => {
                            const set = new Set(prev);
                            if (next) set.add(it.id);
                            else set.delete(it.id);
                            return set;
                          })
                        }
                        ariaLabel={`写入「${it.name}」的 HTTPS 结论`}
                      />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="text-sm font-medium text-slate-900">{it.name}</span>
                        <span className="font-mono text-xs text-slate-500">{target}</span>
                        <span
                          className={`ml-auto inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${badge.cls}`}
                        >
                          {badge.label}
                        </span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                        <span className="text-slate-400">台账已有</span>
                        <span className="text-slate-600">
                          {httpsOutcomeLabel(it.current_supported)}
                          {it.current_expires_at ? `（到期 ${fmtDay(it.current_expires_at)}）` : ''}
                        </span>
                        <span className="text-slate-300">→</span>
                        <span className="text-slate-400">本次</span>
                        <span className="font-medium text-slate-900">
                          {httpsOutcomeLabel(it.https)}
                          {it.cert?.validTo ? `（到期 ${fmtDay(it.cert.validTo)}）` : ''}
                        </span>
                        {daysLeft !== null && (
                          <span
                            className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${certDaysCls(daysLeft)}`}
                          >
                            证书{certDaysText(daysLeft)}
                          </span>
                        )}
                        {it.cert && !it.cert.authorized && (
                          <span
                            className="rounded border border-amber-200 bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700"
                            title={it.cert.authError ?? undefined}
                          >
                            {it.cert.selfSigned ? '自签名证书' : '信任链没通过'}
                          </span>
                        )}
                        {it.elapsed_ms > 0 && <span className="text-slate-400">{it.elapsed_ms}ms</span>}
                      </div>
                      {it.cert && (
                        <p className="mt-1 text-[11px] leading-relaxed text-slate-400">
                          证书 {it.cert.subject || '主体未知'} · 颁发者 {it.cert.issuer || '未知'}
                          {it.cert.protocol ? ` · ${it.cert.protocol}` : ''}
                          {it.cert.altNames.length > 0 ? ` · 备用名称 ${it.cert.altNames.slice(0, 4).join('、')}` : ''}
                        </p>
                      )}
                      {it.message && <p className="mt-1 text-[11px] text-slate-500">{it.message}</p>}
                      {it.evidence.length > 0 && (
                        <div className="mt-1 space-y-0.5">
                          {it.evidence.map((line, idx) => (
                            <p key={idx} className="text-[11px] leading-relaxed text-slate-400">
                              {line}
                            </p>
                          ))}
                        </div>
                      )}
                      {it.status === 'error' && (
                        <p className="mt-1 text-[11px] text-slate-400">
                          默认不勾选；勾上会把「未探到」记进台账，用来区分「没探过」和「探了但连不上」
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
