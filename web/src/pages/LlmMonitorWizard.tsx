import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api';
import type { LlmChannel } from '../types';
import { errMsg } from '../utils';
import { Card, ErrorBanner, PageHeader, Spinner } from '../components/ui';

const inputCls =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder-slate-400 outline-none transition focus:border-slate-500 focus:ring-2 focus:ring-slate-200';

interface UpstreamModel {
  id: string;
  owned_by?: string;
}

export default function LlmMonitorWizard() {
  const navigate = useNavigate();
  const [monitorChannels, setMonitorChannels] = useState<LlmChannel[]>([]);
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [existingId, setExistingId] = useState<number | ''>('');
  const [channelName, setChannelName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [upstream, setUpstream] = useState<UpstreamModel[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState('');
  const [probeMode, setProbeMode] = useState<'ping' | 'models' | 'chat' | 'stream'>('stream');
  const [intervalSec, setIntervalSec] = useState(300);
  const [fetching, setFetching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchHint, setFetchHint] = useState<string | null>(null);

  const loadChannels = useCallback(async () => {
    try {
      const res = await api.getLlmChannels();
      setMonitorChannels(res.channels ?? []);
    } catch {
      // 可忽略，新建不依赖已有渠道
    }
  }, []);

  useEffect(() => {
    void loadChannels();
  }, [loadChannels]);

  useEffect(() => {
    if (mode !== 'existing' || !existingId) return;
    const ch = monitorChannels.find((c) => c.id === existingId);
    if (!ch) return;
    setChannelName(ch.name);
    setBaseUrl(ch.base_url);
    setApiKey(ch.api_key); // 打码值；拉取时后端可用 channel_id 取真钥
  }, [mode, existingId, monitorChannels]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return upstream;
    return upstream.filter((m) => m.id.toLowerCase().includes(q) || (m.owned_by ?? '').toLowerCase().includes(q));
  }, [upstream, filter]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllFiltered = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const m of filtered) next.add(m.id);
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  const fetchModels = async () => {
    setFetching(true);
    setError(null);
    setFetchHint(null);
    try {
      if (!baseUrl.trim()) throw new Error('请先填写 Base URL');
      const body: { base_url: string; api_key?: string; channel_id?: number } = {
        base_url: baseUrl.trim(),
      };
      if (mode === 'existing' && existingId) {
        body.channel_id = Number(existingId);
        if (apiKey && !apiKey.startsWith('****')) body.api_key = apiKey;
      } else {
        if (!apiKey.trim() || apiKey.startsWith('****')) throw new Error('请填写 API Key');
        body.api_key = apiKey;
      }
      const res = await api.listUpstreamModels(body);
      const list = res.models ?? [];
      setUpstream(list);
      setSelected(new Set());
      setFetchHint(list.length === 0 ? '上游未返回任何模型' : `已获取 ${list.length} 个模型，请勾选要巡检的项`);
    } catch (e) {
      setUpstream([]);
      setSelected(new Set());
      setError(errMsg(e));
    } finally {
      setFetching(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (selected.size === 0) throw new Error('请至少勾选一个模型');
      let channelId: number;
      if (mode === 'existing') {
        if (!existingId) throw new Error('请选择已有监控渠道');
        channelId = Number(existingId);
      } else {
        if (!channelName.trim() || !baseUrl.trim()) throw new Error('渠道名称与 Base URL 必填');
        if (!apiKey.trim()) throw new Error('请填写 API Key');
        const created = await api.createLlmChannel({
          name: channelName.trim(),
          base_url: baseUrl.trim(),
          api_key: apiKey,
        });
        channelId = created.id;
      }

      for (const modelId of selected) {
        try {
          await api.createLlmModel(channelId, {
            name: modelId,
            model: modelId,
            monitor_enabled: true,
            probe_mode: probeMode,
            interval_sec: intervalSec,
          });
        } catch (err) {
          // 已存在则跳过
          const msg = errMsg(err);
          if (!msg.includes('已在该渠道')) throw err;
        }
      }
      navigate(`/llm/channels/${channelId}`);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="新增 LLM 监控"
        description="监控渠道与「设置 → 分析用大模型」完全独立。填写网关凭证后从上游拉取模型列表并勾选巡检。"
        actions={
          <Link to="/" className="text-sm text-slate-500 hover:text-slate-800">
            返回总览
          </Link>
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorBanner message={error} />
        </div>
      )}

      <form onSubmit={(e) => void submit(e)} className="mx-auto max-w-2xl space-y-5">
        <Card className="p-5">
          <h3 className="mb-3 text-sm font-semibold text-slate-900">1. 监控渠道</h3>
          <p className="mb-4 text-xs text-slate-500">
            此处只配置巡检用网关，不会影响 AI 分析所用的大模型档案。
          </p>

          {monitorChannels.length > 0 && (
            <div className="mb-4 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setMode('new');
                  setUpstream([]);
                  setSelected(new Set());
                }}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  mode === 'new' ? 'bg-slate-900 text-white' : 'border border-slate-300 text-slate-600 hover:bg-slate-50'
                }`}
              >
                新建监控渠道
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('existing');
                  setUpstream([]);
                  setSelected(new Set());
                  if (monitorChannels[0]) setExistingId(monitorChannels[0].id);
                }}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
                  mode === 'existing' ? 'bg-slate-900 text-white' : 'border border-slate-300 text-slate-600 hover:bg-slate-50'
                }`}
              >
                挂到已有监控渠道（{monitorChannels.length}）
              </button>
            </div>
          )}

          {mode === 'existing' ? (
            <div className="mb-4">
              <label className="mb-1.5 block text-sm font-medium text-slate-700">已有监控渠道</label>
              <select
                className={inputCls}
                value={existingId}
                onChange={(e) => {
                  setExistingId(e.target.value ? Number(e.target.value) : '');
                  setUpstream([]);
                  setSelected(new Set());
                }}
              >
                {monitorChannels.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} · {c.base_url}（{c.models.length} 模型）
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <div className="mb-4">
              <label className="mb-1.5 block text-sm font-medium text-slate-700">渠道名称</label>
              <input
                className={inputCls}
                placeholder="例如：SiliconFlow / 本地 vLLM"
                value={channelName}
                onChange={(e) => setChannelName(e.target.value)}
                required
              />
            </div>
          )}

          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">Base URL</label>
              <input
                className={inputCls}
                placeholder="https://api.example.com/v1"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                required
                disabled={mode === 'existing'}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-700">API Key</label>
              <input
                className={inputCls}
                type="password"
                autoComplete="new-password"
                placeholder={mode === 'existing' ? '已保存；留空沿用渠道密钥' : 'sk-…'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                required={mode === 'new'}
              />
              {mode === 'existing' && apiKey.startsWith('****') && (
                <p className="mt-1 text-xs text-slate-400">将使用该渠道已保存的密钥拉取；也可重新填入新 Key</p>
              )}
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-slate-900">2. 从上游获取模型并勾选</h3>
            <button
              type="button"
              onClick={() => void fetchModels()}
              disabled={fetching}
              className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {fetching && <Spinner className="h-3 w-3 border-white/40 border-t-white" />}
              从上游获取
            </button>
          </div>

          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">探测模式（应用于所选模型）</label>
              <select
                className={inputCls}
                value={probeMode}
                onChange={(e) => setProbeMode(e.target.value as typeof probeMode)}
              >
                <option value="stream">流式短补全（TTFT/TPS，推荐）</option>
                <option value="ping">短对话 ping</option>
                <option value="models">仅网关 /models</option>
                <option value="chat">完整短对话</option>
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-slate-600">巡检间隔（秒）</label>
              <input
                className={inputCls}
                type="number"
                min={30}
                max={3600}
                value={intervalSec}
                onChange={(e) => setIntervalSec(Number(e.target.value) || 120)}
              />
            </div>
          </div>

          {fetchHint && <p className="mb-3 text-xs text-slate-500">{fetchHint}</p>}

          {upstream.length > 0 && (
            <>
              <div className="mb-2 flex flex-wrap items-center gap-2">
                <input
                  className={`${inputCls} max-w-xs`}
                  placeholder="筛选模型…"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                />
                <button type="button" onClick={selectAllFiltered} className="text-xs text-slate-600 underline">
                  全选当前列表
                </button>
                <button type="button" onClick={clearSelection} className="text-xs text-slate-400 underline">
                  清空勾选
                </button>
                <span className="ml-auto text-xs text-slate-400">已选 {selected.size}</span>
              </div>
              <ul className="max-h-80 overflow-y-auto rounded-lg border border-slate-200 divide-y divide-slate-100">
                {filtered.map((m) => (
                  <li key={m.id}>
                    <label className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-slate-50">
                      <input
                        type="checkbox"
                        checked={selected.has(m.id)}
                        onChange={() => toggle(m.id)}
                        className="h-4 w-4 accent-slate-900"
                      />
                      <span className="min-w-0 flex-1 truncate font-mono text-sm text-slate-800">{m.id}</span>
                      {m.owned_by && <span className="shrink-0 text-[10px] text-slate-400">{m.owned_by}</span>}
                    </label>
                  </li>
                ))}
                {filtered.length === 0 && (
                  <li className="px-3 py-6 text-center text-xs text-slate-400">无匹配模型</li>
                )}
              </ul>
            </>
          )}

          {upstream.length === 0 && !fetching && (
            <div className="rounded-lg border border-dashed border-slate-300 px-4 py-10 text-center text-xs text-slate-400">
              填写 Base URL 与 API Key 后，点击「从上游获取」加载可选模型
            </div>
          )}
        </Card>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={busy || selected.size === 0}
            className="inline-flex items-center gap-2 rounded-lg bg-slate-900 px-5 py-2 text-sm font-medium text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {busy && <Spinner className="border-white/40 border-t-white" />}
            创建并开始巡检（{selected.size}）
          </button>
        </div>
      </form>
    </div>
  );
}
