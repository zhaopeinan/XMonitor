import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { StatusBadge, StatusDot } from '../components/StatusDot';
import { Card, EmptyState, ErrorBanner, PageHeader, Skeleton, SsoBadge } from '../components/ui';
import type { DashboardData, DashboardLlmChannelSummary, SystemSummary } from '../types';
import { errMsg, fmtRelative, isTruthy, normStatus, rateKindHint, rateKindLabel, statusLabel } from '../utils';
import { subscribeWs } from '../ws';

function systemUptime(s: SystemSummary): number | null {
  if (typeof s.uptime_24h === 'number') return s.uptime_24h;
  const vals = s.monitors
    .map((m) => m.uptime_24h)
    .filter((v): v is number => typeof v === 'number');
  if (vals.length === 0) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

function systemRateKind(s: SystemSummary): 'uptime' | 'block' | 'compliance' {
  if (s.rate_kind) return s.rate_kind;
  const reverseCount = s.reverse_count ?? s.monitors.filter((m) => m.expect_mode === 'down').length;
  if (s.reverse_all || (s.monitors.length > 0 && reverseCount === s.monitors.length)) return 'block';
  if (reverseCount > 0) return 'compliance';
  return 'uptime';
}

function SystemCard({ system }: { system: SystemSummary }) {
  const status = normStatus(system.overall_status);
  const uptime = systemUptime(system);
  const latestAlert = system.recent_alerts?.[0];
  const reverseCount = system.reverse_count ?? system.monitors.filter((m) => m.expect_mode === 'down').length;
  const rateKind = systemRateKind(system);

  return (
    <Link to={`/systems/${system.id}`}>
      <Card className="h-full p-5 transition-shadow hover:shadow-md">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-base font-semibold text-slate-900">{system.name}</h3>
              {isTruthy(system.use_sso) && <SsoBadge />}
              {reverseCount > 0 && (
                <span className="rounded border border-orange-200 bg-orange-50 px-1.5 py-0.5 text-[10px] font-medium text-orange-700">
                  反向 {reverseCount}
                </span>
              )}
            </div>
            <p className="mt-0.5 truncate text-xs text-slate-400" title={system.base_url}>
              {system.base_url}
            </p>
          </div>
          <StatusBadge status={status} expectMode={system.reverse_all ? 'down' : 'up'} />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          {system.monitors.length === 0 ? (
            <span className="text-xs text-slate-400">暂无监控项</span>
          ) : (
            system.monitors.map((m) => (
              <StatusDot
                key={m.id}
                status={normStatus(m.status)}
                className={!isTruthy(m.enabled) ? 'opacity-35' : undefined}
                tooltip={`${m.name} · ${statusLabel(normStatus(m.status), m.expect_mode)}${m.expect_mode === 'down' ? '（反向）' : ''}${!isTruthy(m.enabled) ? '（已停用）' : ''}`}
              />
            ))
          )}
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-xs">
          <span className="text-slate-400" title={rateKindHint(rateKind)}>
            {rateKindLabel(rateKind)}{' '}
            <span className={`font-medium ${rateKind === 'uptime' ? 'text-slate-700' : 'text-orange-700'}`}>
              {uptime === null ? '—' : `${uptime.toFixed(1)}%`}
            </span>
          </span>
          {latestAlert ? (
            <span className="max-w-[55%] truncate text-rose-500" title={latestAlert.message}>
              {fmtRelative(latestAlert.ts)} · {latestAlert.message}
            </span>
          ) : (
            <span className="text-slate-300">无近期告警</span>
          )}
        </div>
      </Card>
    </Link>
  );
}

function LlmChannelCard({ channel }: { channel: DashboardLlmChannelSummary }) {
  const status = normStatus(channel.overall_status);
  const latestAlert = channel.recent_alerts?.[0];
  const enabled = isTruthy(channel.enabled);

  return (
    <Link to={`/llm/channels/${channel.id}`}>
      <Card className="h-full p-5 transition-shadow hover:shadow-md">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate text-base font-semibold text-slate-900">{channel.name}</h3>
              <span className="rounded border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                模型渠道
              </span>
              {!enabled && (
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-500">已停用</span>
              )}
            </div>
            <p className="mt-0.5 truncate text-xs text-slate-400" title={channel.base_url}>
              {channel.base_url}
            </p>
          </div>
          <StatusBadge status={enabled ? status : 'unknown'} />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          {channel.models.length === 0 ? (
            <span className="text-xs text-slate-400">暂无模型</span>
          ) : (
            channel.models.map((m) => (
              <StatusDot
                key={m.id}
                status={isTruthy(m.monitor_enabled) ? normStatus(m.status) : 'unknown'}
                tooltip={`${m.name} · ${m.model} · ${statusLabel(normStatus(m.status))}${!isTruthy(m.monitor_enabled) ? '（未巡检）' : ''}`}
              />
            ))
          )}
        </div>

        <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-xs">
          <span className="text-slate-400">
            24h 可用率{' '}
            <span className="font-medium text-slate-700">
              {channel.uptime_24h === null ? '—' : `${channel.uptime_24h.toFixed(1)}%`}
            </span>
            <span className="ml-2 text-slate-300">
              {channel.monitored_count}/{channel.model_count} 巡检
            </span>
          </span>
          {latestAlert ? (
            <span className="max-w-[45%] truncate text-rose-500" title={latestAlert.message}>
              {fmtRelative(latestAlert.ts)} · {latestAlert.message}
            </span>
          ) : (
            <span className="text-slate-300">无近期告警</span>
          )}
        </div>
      </Card>
    </Link>
  );
}

export default function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await api.dashboard());
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(
    () =>
      subscribeWs((msg) => {
        if (msg.type === 'alert' || msg.type === 'snapshot' || msg.type === 'check' || msg.type === 'status') void load();
      }),
    [load],
  );

  const { hasPermission } = useAuth();
  const canAnalyze = hasPermission('analyze');
  const canLlm = hasPermission('systems.manage') || hasPermission('settings.manage');
  const actions =
    canAnalyze || canLlm ? (
      <div className="flex flex-wrap items-center gap-2">
        {canLlm && (
          <Link
            to="/llm/new"
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 shadow-sm transition-colors hover:bg-slate-50"
          >
            <span className="text-base leading-none">+</span> 新增 LLM 监控
          </Link>
        )}
        {canAnalyze && (
          <Link
            to="/analyze"
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors hover:bg-slate-700"
          >
            <span className="text-base leading-none">+</span> 新建系统并分析
          </Link>
        )}
      </div>
    ) : undefined;

  const systems = data?.systems ?? [];
  const llmChannels = data?.llm_channels ?? [];
  const empty = data && systems.length === 0 && llmChannels.length === 0;

  return (
    <div>
      <PageHeader
        title="监控总览"
        description="业务系统页面/接口，与大模型渠道的健康状态"
        actions={actions}
      />

      {error && (
        <div className="mb-4">
          <ErrorBanner message={error} />
        </div>
      )}

      {!data && !error ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-40" />
          ))}
        </div>
      ) : empty ? (
        <EmptyState
          title="还没有监控任何系统或模型"
          description="可新建业务系统并分析，或新增 LLM 渠道与模型巡检。"
          action={actions}
        />
      ) : (
        <div className="space-y-8">
          <section>
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-slate-900">业务系统</h2>
              <span className="text-xs text-slate-400">{systems.length} 个</span>
            </div>
            {systems.length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">
                暂无业务系统
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {systems.map((s) => (
                  <SystemCard key={s.id} system={s} />
                ))}
              </div>
            )}
          </section>

          <section>
            <div className="mb-3 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-slate-900">大模型渠道</h2>
              <span className="text-xs text-slate-400">{llmChannels.length} 个</span>
            </div>
            {llmChannels.length === 0 ? (
              <p className="rounded-xl border border-dashed border-slate-200 px-4 py-8 text-center text-sm text-slate-400">
                暂无 LLM 监控渠道。点击右上角「新增 LLM 监控」添加。
              </p>
            ) : (
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {llmChannels.map((c) => (
                  <LlmChannelCard key={c.id} channel={c} />
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
