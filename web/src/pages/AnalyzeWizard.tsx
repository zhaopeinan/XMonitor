import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import AnalysisTimeline from '../components/AnalysisTimeline';
import { TypeBadge } from '../components/StatusDot';
import { Card, ErrorBanner, PageHeader, Spinner } from '../components/ui';
import type { AnalysisJob, Candidate } from '../types';
import { CATEGORY_LABELS, errMsg } from '../utils';

const STEPS = ['填写系统信息', 'AI 分析候选', '确认并创建'];

type TypeFilter = 'all' | 'page' | 'api';

function StepIndicator({ current }: { current: number }) {
  return (
    <ol className="mb-8 flex items-center gap-2">
      {STEPS.map((label, i) => {
        const n = i + 1;
        const active = n === current;
        const done = n < current;
        return (
          <li key={label} className="flex items-center gap-2">
            {i > 0 && <span className="h-px w-8 bg-slate-200" />}
            <span
              className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                done
                  ? 'bg-emerald-500 text-white'
                  : active
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-200 text-slate-500'
              }`}
            >
              {done ? '✓' : n}
            </span>
            <span
              className={`text-sm ${active ? 'font-medium text-slate-900' : 'text-slate-400'}`}
            >
              {label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function Stars({ value }: { value?: number }) {
  const v = Math.max(0, Math.min(5, Math.round(value ?? 0)));
  if (v === 0) return <span className="text-slate-300">—</span>;
  return (
    <span className="whitespace-nowrap text-sm tracking-tight">
      <span className="text-amber-400">{'★'.repeat(v)}</span>
      <span className="text-slate-200">{'★'.repeat(5 - v)}</span>
    </span>
  );
}

const inputCls =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200';

export default function AnalyzeWizard() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const [step, setStep] = useState(1);
  const [systemId, setSystemId] = useState<number | null>(null);
  const [systemName, setSystemName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [useSso, setUseSso] = useState(true);
  const [job, setJob] = useState<AnalysisJob | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<TypeFilter>('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (id: number) => {
      stopPolling();
      const tick = async () => {
        try {
          const res = await api.getAnalysis(id);
          setJob(res);
          const list = res.candidates ?? [];
          setCandidates(list);
          if (res.status === 'done') {
            stopPolling();
            setChecked((prev) =>
              prev.size > 0
                ? prev
                : new Set(list.filter((c) => c.selected === undefined || c.selected).map((c) => c.id)),
            );
          } else if (res.status === 'failed') {
            stopPolling();
          }
        } catch (e) {
          setError(errMsg(e));
          stopPolling();
        }
      };
      void tick();
      pollRef.current = setInterval(() => void tick(), 1000);
    },
    [stopPolling],
  );

  useEffect(() => stopPolling, [stopPolling]);

  const beginAnalysis = useCallback(
    async (id: number) => {
      setError(null);
      setJob(null);
      setCandidates([]);
      setChecked(new Set());
      try {
        await api.startAnalysis(id);
      } catch (e) {
        setError(errMsg(e));
      }
      setStep(2);
      startPolling(id);
    },
    [startPolling],
  );

  // 从系统详情页"重新分析"进入：/analyze?system=<id>
  // 若已有进行中/已完成的 job 则直接附着，避免重复触发分析
  const autoRef = useRef(false);
  useEffect(() => {
    const sid = Number(searchParams.get('system'));
    if (sid && !autoRef.current) {
      autoRef.current = true;
      setSystemId(sid);
      void (async () => {
        try {
          const res = await api.getAnalysis(sid);
          if (res.status === 'running' || res.status === 'pending') {
            setStep(2);
            startPolling(sid);
            return;
          }
          if (res.status === 'done' && (res.candidates?.length ?? 0) > 0) {
            setJob(res);
            const list = res.candidates ?? [];
            setCandidates(list);
            setChecked(
              new Set(list.filter((c) => c.selected === undefined || c.selected).map((c) => c.id)),
            );
            setStep(2);
            return;
          }
        } catch {
          // 查询失败则按全新分析处理
        }
        void beginAnalysis(sid);
      })();
    }
  }, [searchParams, beginAnalysis, startPolling]);

  const submitStep1 = async (e: FormEvent) => {
    e.preventDefault();
    if (!systemName.trim() || !baseUrl.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const sys = await api.createSystem({
        name: systemName.trim(),
        base_url: baseUrl.trim(),
        use_sso: useSso,
      });
      setSystemId(sys.id);
      await beginAnalysis(sys.id);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const filtered = useMemo(
    () => candidates.filter((c) => filter === 'all' || c.type === filter),
    [candidates, filter],
  );
  const allChecked = filtered.length > 0 && filtered.every((c) => checked.has(c.id));

  const toggleAll = () => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (allChecked) filtered.forEach((c) => next.delete(c.id));
      else filtered.forEach((c) => next.add(c.id));
      return next;
    });
  };

  const toggleOne = (id: number) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectedCandidates = useMemo(
    () => candidates.filter((c) => checked.has(c.id)),
    [candidates, checked],
  );

  const createMonitors = async () => {
    if (!systemId || checked.size === 0) return;
    setBusy(true);
    setError(null);
    try {
      await api.createMonitors(systemId, Array.from(checked));
      navigate(`/systems/${systemId}`);
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader title="新建系统并分析" description="AI 自动发现系统中的关键页面与接口" />
      <StepIndicator current={step} />

      {error && (
        <div className="mb-4">
          <ErrorBanner message={error} />
        </div>
      )}

      {/* 第一步：填写系统信息 */}
      {step === 1 && (
        <Card className="mx-auto max-w-lg p-6">
          <form onSubmit={submitStep1} className="flex flex-col gap-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">系统名称</label>
              <input
                className={inputCls}
                placeholder="例如：订单管理系统"
                value={systemName}
                onChange={(e) => setSystemName(e.target.value)}
                required
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">主页 URL</label>
              <input
                className={inputCls}
                type="url"
                placeholder="https://example.com"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                required
              />
              <p className="mt-1.5 text-xs text-slate-400">
                系统将通过浏览器抓取该页面及其链接与接口，再由大模型筛选出关键监控对象
              </p>
            </div>
            <label className="flex items-center gap-2.5 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={useSso}
                onChange={(e) => setUseSso(e.target.checked)}
                className="h-4 w-4 accent-slate-900"
              />
              该系统需要统一身份认证登录
            </label>
            <button
              type="submit"
              disabled={busy}
              className="mt-2 inline-flex items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-50"
            >
              {busy && <Spinner className="border-white/40 border-t-white" />}
              开始分析
            </button>
          </form>
        </Card>
      )}

      {/* 第二步：实时分析过程时间线 + 候选表格 */}
      {step === 2 && (
        <div className="flex flex-col gap-4">
          <AnalysisTimeline
            job={job}
            onRetry={() => systemId && void beginAnalysis(systemId)}
          />

          {job?.status === 'done' && (
            <>
              <Card className="p-0">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
                  <p className="text-sm text-slate-600">
                    发现 <span className="font-semibold text-slate-900">{candidates.length}</span>{' '}
                    个候选监控项，已勾选{' '}
                    <span className="font-semibold text-slate-900">{checked.size}</span> 个
                  </p>
                  <div className="flex rounded-lg border border-slate-200 p-0.5 text-xs">
                    {(
                      [
                        ['all', '全部'],
                        ['page', '页面'],
                        ['api', '接口'],
                      ] as [TypeFilter, string][]
                    ).map(([key, label]) => (
                      <button
                        key={key}
                        onClick={() => setFilter(key)}
                        className={`rounded-md px-3 py-1.5 transition-colors ${
                          filter === key
                            ? 'bg-slate-900 font-medium text-white'
                            : 'text-slate-500 hover:text-slate-800'
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-slate-100 text-left text-xs text-slate-400">
                        <th className="w-10 px-5 py-2.5">
                          <input
                            type="checkbox"
                            checked={allChecked}
                            onChange={toggleAll}
                            className="h-4 w-4 accent-slate-900"
                          />
                        </th>
                        <th className="px-3 py-2.5 font-medium">类型</th>
                        <th className="px-3 py-2.5 font-medium">名称</th>
                        <th className="px-3 py-2.5 font-medium">分类</th>
                        <th className="px-3 py-2.5 font-medium">URL</th>
                        <th className="px-3 py-2.5 font-medium">方法</th>
                        <th className="px-3 py-2.5 font-medium">AI 理由</th>
                        <th className="px-5 py-2.5 font-medium">重要性</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((c) => (
                        <tr
                          key={c.id}
                          onClick={() => toggleOne(c.id)}
                          className={`cursor-pointer border-b border-slate-50 transition-colors hover:bg-slate-50 ${
                            checked.has(c.id) ? 'bg-slate-50/60' : ''
                          }`}
                        >
                          <td className="px-5 py-3">
                            <input
                              type="checkbox"
                              checked={checked.has(c.id)}
                              onChange={() => toggleOne(c.id)}
                              onClick={(e) => e.stopPropagation()}
                              className="h-4 w-4 accent-slate-900"
                            />
                          </td>
                          <td className="px-3 py-3">
                            <TypeBadge type={c.type} />
                          </td>
                          <td className="max-w-40 truncate px-3 py-3 font-medium text-slate-800">
                            {c.name || c.title || '—'}
                          </td>
                          <td className="px-3 py-3 text-slate-600">
                            {CATEGORY_LABELS[c.category] ?? c.category}
                          </td>
                          <td
                            className="max-w-64 truncate px-3 py-3 text-slate-500"
                            title={c.url}
                          >
                            {c.url}
                          </td>
                          <td className="px-3 py-3">
                            <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-600">
                              {c.method}
                            </span>
                          </td>
                          <td
                            className="max-w-56 truncate px-3 py-3 text-slate-500"
                            title={c.reason}
                          >
                            {c.reason || '—'}
                          </td>
                          <td className="px-5 py-3">
                            <Stars value={c.importance ?? c.llm_score} />
                          </td>
                        </tr>
                      ))}
                      {filtered.length === 0 && (
                        <tr>
                          <td colSpan={8} className="px-5 py-10 text-center text-slate-400">
                            该类型下暂无候选
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </Card>

              <div className="flex justify-end">
                <button
                  onClick={() => setStep(3)}
                  disabled={checked.size === 0}
                  className="rounded-lg bg-slate-900 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-40"
                >
                  下一步（已选 {checked.size} 项）
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* 第三步：确认并创建 */}
      {step === 3 && (
        <Card className="mx-auto max-w-2xl p-6">
          <h3 className="text-base font-semibold text-slate-900">确认创建监控</h3>
          <p className="mt-1 text-sm text-slate-500">
            将为以下 {selectedCandidates.length} 个候选创建监控项，创建后立即开始轮询探测。
          </p>
          <ul className="mt-4 max-h-72 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
            {selectedCandidates.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <TypeBadge type={c.type} />
                <span className="font-medium text-slate-800">{c.name || c.title || c.url}</span>
                <span className="text-xs text-slate-400">
                  {CATEGORY_LABELS[c.category] ?? c.category}
                </span>
                <span className="ml-auto max-w-56 truncate text-xs text-slate-400">{c.url}</span>
              </li>
            ))}
          </ul>
          <div className="mt-6 flex justify-end gap-3">
            <button
              onClick={() => setStep(2)}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-50"
            >
              返回修改
            </button>
            <button
              onClick={() => void createMonitors()}
              disabled={busy || selectedCandidates.length === 0}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-slate-700 disabled:opacity-40"
            >
              {busy && <Spinner className="border-white/40 border-t-white" />}
              创建监控
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}
