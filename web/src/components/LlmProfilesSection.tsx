import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api } from '../api';
import type { LlmProfile, LlmTestResult } from '../types';
import { errMsg } from '../utils';
import { useConfirm } from './ConfirmDialog';
import { Card, ErrorBanner, Skeleton, Spinner } from './ui';

const inputCls =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200';

function isTruthy(v: unknown): boolean {
  return v === true || v === 'true' || v === '1' || v === 1;
}

interface FormState {
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  multimodal: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  base_url: 'https://api.openai.com/v1',
  api_key: '',
  model: '',
  multimodal: false,
};

/** 仅用于 AI 分析的大模型档案；与监控渠道无关 */
export default function LlmProfilesSection() {
  const confirm = useConfirm();
  const [profiles, setProfiles] = useState<LlmProfile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<'new' | number | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [tests, setTests] = useState<Record<number, { testing: boolean; result?: LlmTestResult }>>({});

  const load = useCallback(async () => {
    try {
      const res = await api.getLlmProfiles();
      setProfiles(res.profiles ?? []);
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openNew = () => {
    setForm(EMPTY_FORM);
    setEditing('new');
  };

  const openEdit = (p: LlmProfile) => {
    setForm({
      name: p.name,
      base_url: p.base_url,
      api_key: p.api_key,
      model: p.model,
      multimodal: isTruthy(p.multimodal),
    });
    setEditing(p.id);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (editing === 'new') {
        await api.createLlmProfile({
          name: form.name.trim(),
          base_url: form.base_url.trim(),
          api_key: form.api_key,
          model: form.model.trim(),
          multimodal: form.multimodal,
        });
      } else if (typeof editing === 'number') {
        const original = profiles?.find((p) => p.id === editing);
        const patch: Record<string, unknown> = {
          name: form.name.trim(),
          base_url: form.base_url.trim(),
          model: form.model.trim(),
          multimodal: form.multimodal,
        };
        if (form.api_key && form.api_key !== original?.api_key) {
          patch.api_key = form.api_key;
        }
        await api.updateLlmProfile(editing, patch);
      }
      setEditing(null);
      await load();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  const activate = async (p: LlmProfile) => {
    setError(null);
    try {
      await api.activateLlmProfile(p.id);
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const remove = async (p: LlmProfile) => {
    if (
      !(await confirm({
        title: '删除分析模型档案',
        message: `确定删除「${p.name}」？仅影响 AI 分析，不影响 LLM 监控渠道。`,
        confirmText: '删除',
        danger: true,
      }))
    )
      return;
    setError(null);
    try {
      await api.deleteLlmProfile(p.id);
      if (editing === p.id) setEditing(null);
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  const test = async (p: LlmProfile) => {
    setTests((prev) => ({ ...prev, [p.id]: { testing: true } }));
    try {
      const result = await api.testLlmProfile(p.id);
      setTests((prev) => ({ ...prev, [p.id]: { testing: false, result } }));
    } catch (e) {
      setTests((prev) => ({
        ...prev,
        [p.id]: { testing: false, result: { ok: false, error: errMsg(e) } },
      }));
    }
  };

  const set = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((prev) => ({
      ...prev,
      [key]: e.target.type === 'checkbox' ? e.target.checked : e.target.value,
    }));
  };

  const editingProfile = typeof editing === 'number' ? profiles?.find((p) => p.id === editing) : null;

  return (
    <Card className="p-5">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">分析用大模型</h3>
        {editing === null && (
          <button
            onClick={openNew}
            className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-slate-700"
          >
            <span className="text-sm leading-none">+</span> 添加档案
          </button>
        )}
      </div>
      <p className="mb-4 text-xs leading-relaxed text-slate-500">
        仅用于智能分析页面/接口。LLM API 巡检请在总览使用「新增 LLM 监控」，二者互不影响。
      </p>

      {error && (
        <div className="mb-4">
          <ErrorBanner message={error} />
        </div>
      )}

      {editing !== null && (
        <form
          onSubmit={(e) => void submit(e)}
          className="mb-4 flex flex-col gap-4 rounded-lg border border-slate-200 bg-slate-50/60 p-4"
        >
          <p className="text-xs font-medium uppercase tracking-wide text-slate-400">
            {editing === 'new' ? '新增分析档案' : `编辑「${editingProfile?.name ?? ''}」`}
          </p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">名称</label>
              <input className={inputCls} placeholder="例如：GPT-4o 分析" value={form.name} onChange={set('name')} required />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">模型</label>
              <input className={inputCls} placeholder="gpt-4o-mini" value={form.model} onChange={set('model')} required />
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">Base URL</label>
            <input className={inputCls} value={form.base_url} onChange={set('base_url')} required />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-slate-700">API Key</label>
            <input
              className={inputCls}
              type="password"
              autoComplete="new-password"
              placeholder={editing === 'new' ? 'sk-…' : '留空或保持打码值表示不修改'}
              value={form.api_key}
              onChange={set('api_key')}
              required={editing === 'new'}
            />
          </div>
          <label className="flex items-center gap-2.5 text-sm text-slate-700">
            <input type="checkbox" checked={form.multimodal} onChange={set('multimodal')} className="h-4 w-4 accent-slate-900" />
            支持多模态（分析时附带页面截图）
          </label>
          <div className="flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setEditing(null)}
              className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
            >
              取消
            </button>
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {busy && <Spinner className="border-white/40 border-t-white" />}
              {editing === 'new' ? '添加' : '保存'}
            </button>
          </div>
        </form>
      )}

      {profiles === null ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : profiles.length === 0 ? (
        <div className="rounded-lg border border-dashed border-slate-300 px-6 py-10 text-center">
          <p className="text-sm font-medium text-slate-700">还没有分析用模型档案</p>
          <p className="mt-1 text-sm text-slate-500">添加一个 OpenAI 兼容模型，用于 AI 分析页面与接口</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {profiles.map((p) => {
            const active = isTruthy(p.is_active);
            const t = tests[p.id];
            return (
              <li
                key={p.id}
                className={`rounded-lg border bg-white px-4 py-3.5 ${
                  active ? 'border-l-4 border-l-emerald-500 border-slate-200' : 'border-slate-200'
                }`}
              >
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-slate-800">{p.name}</span>
                      {active && (
                        <span className="shrink-0 rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-600">
                          分析中使用
                        </span>
                      )}
                      {isTruthy(p.multimodal) && (
                        <span className="shrink-0 rounded border border-violet-200 bg-violet-50 px-1.5 py-0.5 text-xs font-medium text-violet-600">
                          多模态
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-slate-400">
                      <span className="font-mono">{p.model}</span> · {p.base_url}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 text-xs">
                    {!active && (
                      <button
                        onClick={() => void activate(p)}
                        className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50"
                      >
                        设为激活
                      </button>
                    )}
                    <button
                      onClick={() => void test(p)}
                      disabled={t?.testing}
                      className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {t?.testing && <Spinner className="h-3 w-3" />}
                      测试连接
                    </button>
                    <button
                      onClick={() => openEdit(p)}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-600 hover:bg-slate-50"
                    >
                      编辑
                    </button>
                    <button
                      onClick={() => void remove(p)}
                      className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-slate-400 hover:border-rose-200 hover:bg-rose-50 hover:text-rose-500"
                    >
                      删除
                    </button>
                  </div>
                </div>
                {t?.result && (
                  <p className={`mt-2 text-xs ${t.result.ok ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {t.result.ok
                      ? `连接成功${t.result.latency_ms !== undefined ? `，延迟 ${Math.round(t.result.latency_ms)} ms` : ''}`
                      : `连接失败${t.result.error ? `：${t.result.error}` : ''}`}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
