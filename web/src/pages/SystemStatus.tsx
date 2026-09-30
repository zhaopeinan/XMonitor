import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Card, ErrorBanner, PageHeader, Skeleton, Spinner } from '../components/ui';
import type { SystemStatusPayload } from '../types';
import { errMsg, fmtBytes, fmtDateTime, fmtUptime } from '../utils';

function overallMeta(o: SystemStatusPayload['overall']) {
  if (o === 'ok') return { label: '正常', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500' };
  if (o === 'degraded') return { label: '降级', cls: 'bg-amber-50 text-amber-700 border-amber-200', dot: 'bg-amber-400' };
  return { label: '异常', cls: 'bg-rose-50 text-rose-700 border-rose-200', dot: 'bg-rose-500' };
}

function CompBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium ${
        ok ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-rose-200 bg-rose-50 text-rose-700'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${ok ? 'bg-emerald-500' : 'bg-rose-500'}`} />
      {label}
    </span>
  );
}

function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-slate-100 bg-slate-50/80 px-3 py-2.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-slate-400">{label}</p>
      <p
        className="mt-1 break-all text-sm font-semibold tabular-nums text-slate-900"
        title={typeof value === 'string' || typeof value === 'number' ? String(value) : undefined}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 truncate text-[11px] text-slate-400" title={hint}>{hint}</p>}
    </div>
  );
}

function Section({ title, children, extra }: { title: string; children: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        {extra}
      </div>
      {children}
    </Card>
  );
}

export default function SystemStatus() {
  const [data, setData] = useState<SystemStatusPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    try {
      setData(await api.systemStatus());
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(true), 15_000);
    return () => clearInterval(t);
  }, [load]);

  if (loading && !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const meta = data ? overallMeta(data.overall) : null;
  const t = data?.sqlite.tables;

  return (
    <div>
      <PageHeader
        title="系统状况"
        description="本机基础设施与依赖健康度，仅管理员可见"
        actions={
          <button
            type="button"
            onClick={() => void load(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {refreshing ? <Spinner /> : null}
            刷新
          </button>
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorBanner message={error} />
        </div>
      )}

      {data && meta && (
        <div className="space-y-4">
          <Card className="flex flex-wrap items-center gap-4 p-5">
            <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-sm font-medium ${meta.cls}`}>
              <span className={`h-2 w-2 rounded-full ${meta.dot}`} />
              总体 {meta.label}
            </div>
            <p className="text-xs text-slate-400">采集于 {fmtDateTime(data.generated_at)}</p>
            <div className="ml-auto flex flex-wrap gap-2">
              <CompBadge
                ok={!data.components.victoria_metrics.enabled || data.components.victoria_metrics.ok}
                label={
                  data.components.victoria_metrics.enabled
                    ? data.components.victoria_metrics.ok
                      ? 'VictoriaMetrics'
                      : 'VictoriaMetrics 异常'
                    : 'VM 未启用'
                }
              />
              <CompBadge
                ok={data.components.obscura.ok}
                label={data.components.obscura.ok ? 'Obscura / Chromium' : 'Obscura 异常'}
              />
            </div>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="进程">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Stat label="运行时长" value={fmtUptime(data.process.uptime_sec)} />
                <Stat label="启动时间" value={fmtDateTime(data.process.started_at)} />
                <Stat label="PID" value={data.process.pid} />
                <Stat label="Node" value={data.process.node} />
                <Stat label="平台" value={`${data.process.platform}/${data.process.arch}`} />
                <Stat label="RSS" value={`${data.process.memory.rss_mb} MB`} />
                <Stat
                  label="Heap"
                  value={`${data.process.memory.heap_used_mb} / ${data.process.memory.heap_total_mb} MB`}
                />
                <Stat label="负载" value={data.process.loadavg.join(' / ')} hint="1 / 5 / 15 分钟" />
                <Stat
                  label="主机内存"
                  value={`${data.process.host_freemem_mb} / ${data.process.host_totalmem_mb} MB`}
                  hint="可用 / 总量"
                />
              </div>
            </Section>

            <Section
              title="VictoriaMetrics"
              extra={
                <CompBadge
                  ok={!data.components.victoria_metrics.enabled || data.components.victoria_metrics.ok}
                  label={data.components.victoria_metrics.ok ? '健康' : data.components.victoria_metrics.enabled ? '异常' : '关闭'}
                />
              }
            >
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 [&>*]:min-w-0">
                <Stat label="启用" value={data.components.victoria_metrics.enabled ? '是' : '否'} />
                <Stat
                  label="容器内地址"
                  value={data.components.victoria_metrics.url || '—'}
                  hint={data.components.victoria_metrics.url_note || undefined}
                />
                {data.components.victoria_metrics.host_url && (
                  <Stat
                    label="宿主机排查"
                    value={data.components.victoria_metrics.host_url}
                    hint="浏览器可打开"
                  />
                )}
                <Stat label="活跃序列" value={data.components.victoria_metrics.series_count ?? '—'} />
                <Stat label="写入队列" value={data.components.victoria_metrics.write_queue} />
                <Stat label="数据目录" value={fmtBytes(data.components.victoria_metrics.data_dir_bytes)} />
              </div>
              {data.components.victoria_metrics.error && (
                <p className="mt-3 text-xs text-rose-600">{data.components.victoria_metrics.error}</p>
              )}
            </Section>

            <Section
              title="Obscura / Chromium"
              extra={<CompBadge ok={data.components.obscura.ok} label={data.components.obscura.ok ? '健康' : '异常'} />}
            >
              <div className="grid grid-cols-2 gap-2">
                <Stat label="版本" value={data.components.obscura.version || '—'} />
                <Stat label="WebSocket 客户端" value={data.components.websocket.clients} />
              </div>
              {data.components.obscura.error && (
                <p className="mt-3 text-xs text-rose-600">{data.components.obscura.error}</p>
              )}
            </Section>

            <Section title="SQLite">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Stat label="库文件" value={fmtBytes(data.sqlite.db_bytes)} />
                <Stat label="WAL" value={fmtBytes(data.sqlite.wal_bytes)} />
                <Stat label="data 目录" value={fmtBytes(data.sqlite.data_dir_bytes)} />
                <Stat label="系统 / 监控项" value={`${t?.systems ?? 0} / ${t?.monitors ?? 0}`} hint={`启用 ${t?.monitors_enabled ?? 0}`} />
                <Stat label="探测记录" value={(t?.checks ?? 0).toLocaleString()} hint={`近 24h ${t?.checks_24h ?? 0}`} />
                <Stat
                  label="LLM 渠道 / 模型"
                  value={`${t?.llm_channels ?? 0} / ${t?.llm_models ?? 0}`}
                  hint={`巡检中 ${t?.llm_models_monitored ?? 0}`}
                />
                <Stat label="LLM 探测" value={(t?.llm_checks ?? 0).toLocaleString()} hint={`近 24h ${t?.llm_checks_24h ?? 0}`} />
                <Stat
                  label="未确认告警"
                  value={(t?.alerts_unacked ?? 0) + (t?.llm_alerts_unacked ?? 0)}
                  hint={`业务 ${t?.alerts_unacked ?? 0} · 模型 ${t?.llm_alerts_unacked ?? 0}`}
                />
                <Stat label="用户" value={t?.users ?? 0} />
              </div>
              <p className="mt-3 truncate text-[11px] text-slate-400" title={data.sqlite.path}>
                {data.sqlite.path}
              </p>
            </Section>
          </div>
        </div>
      )}
    </div>
  );
}
