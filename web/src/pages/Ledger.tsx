import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useConfirm } from '../components/ConfirmDialog';
import { useAuth } from '../auth';
import { Card, ErrorBanner, PageHeader, Spinner } from '../components/ui';
import { Select } from '../components/Select';
import type { LedgerEntry, SystemInfo } from '../types';
import { errMsg, isTruthy } from '../utils';

const inputCls =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200';

type ExternalFilter = 'all' | 'yes' | 'no';
type DomainFilter = 'all' | 'yes' | 'no';
type LinkFilter = 'all' | 'linked' | 'unlinked';

function Modal({
  title,
  description,
  children,
  onClose,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  footer: ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 py-6" onClick={onClose}>
      <div
        className="flex max-h-full w-full max-w-lg flex-col rounded-2xl border border-slate-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="border-b border-slate-100 px-6 py-4">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
          {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        <div className="flex justify-end gap-2 border-t border-slate-100 px-6 py-4">{footer}</div>
      </div>
    </div>
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

interface FormState {
  name: string;
  ops_unit: string;
  ip: string;
  external_access: boolean;
  domain_applied: boolean;
  domain: string;
  location: string;
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
  remark: '',
  system_id: '',
};

function formFromEntry(entry: LedgerEntry): FormState {
  return {
    name: entry.name,
    ops_unit: entry.ops_unit ?? '',
    ip: entry.ip ?? '',
    external_access: isTruthy(entry.external_access),
    domain_applied: isTruthy(entry.domain_applied),
    domain: entry.domain ?? '',
    location: entry.location ?? '',
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
      return [e.name, e.ops_unit, e.ip, e.domain, e.location, e.remark, e.system_name ?? '']
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
        description="登记系统的运维单位、IP、外网开放与域名申请情况、物理机位置；可选关联到监控系统，资产信息与可用性监控各管一头。"
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

      <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
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
            <table className="w-full min-w-[1080px] text-sm">
              <thead>
                <tr className="whitespace-nowrap border-b border-slate-100 bg-slate-50/80 text-left text-xs text-slate-400">
                  <th className="px-5 py-3 font-medium">系统名称</th>
                  <th className="px-3 py-3 font-medium">运维单位</th>
                  <th className="px-3 py-3 font-medium">IP</th>
                  <th className="px-3 py-3 font-medium">外网访问</th>
                  <th className="px-3 py-3 font-medium">域名</th>
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
                  return (
                    <tr key={e.id} className="group border-b border-slate-50 last:border-0 hover:bg-slate-50">
                      <td className="whitespace-nowrap px-5 py-3.5">
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
                        <td className="sticky right-0 z-10 whitespace-nowrap border-l border-slate-100 bg-white px-5 py-3.5 text-right shadow-[-8px_0_12px_-12px_rgba(15,23,42,0.18)] group-hover:bg-slate-50">
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
    </div>
  );
}
