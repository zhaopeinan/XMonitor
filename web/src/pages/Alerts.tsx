import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Card, EmptyState, ErrorBanner, PageHeader, Skeleton } from '../components/ui';
import type { Alert } from '../types';
import { alertKindMeta, errMsg, fmtDateTime, fmtRelative } from '../utils';
import { resetUnread, subscribeWs } from '../ws';

export default function Alerts() {
  const { hasPermission } = useAuth();
  const [alerts, setAlerts] = useState<Alert[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ackingIds, setAckingIds] = useState<Set<number>>(new Set());

  const load = useCallback(async () => {
    try {
      const res = await api.getAlerts();
      setAlerts(Array.isArray(res) ? res : res.alerts ?? []);
      setError(null);
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    resetUnread();
    void load();
  }, [load]);

  useEffect(
    () =>
      subscribeWs((msg) => {
        if (msg.type === 'alert') {
          resetUnread();
          void load();
        }
      }),
    [load],
  );

  const ack = async (a: Alert) => {
    setAckingIds((prev) => new Set(prev).add(a.id));
    try {
      await api.ackAlert(a.id);
      setAlerts((prev) =>
        prev ? prev.map((x) => (x.id === a.id ? { ...x, acknowledged: 1 } : x)) : prev,
      );
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setAckingIds((prev) => {
        const next = new Set(prev);
        next.delete(a.id);
        return next;
      });
    }
  };

  const unackCount = alerts?.filter((a) => !a.acknowledged).length ?? 0;

  return (
    <div>
      <PageHeader
        title="告警"
        description={
          unackCount > 0 ? `${unackCount} 条未确认` : '所有告警均已确认'
        }
      />

      {error && (
        <div className="mb-4">
          <ErrorBanner message={error} />
        </div>
      )}

      {!alerts && !error ? (
        <div className="flex flex-col gap-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16" />
          ))}
        </div>
      ) : alerts && alerts.length === 0 ? (
        <EmptyState title="暂无告警" description="系统运行正常，出现异常时会第一时间在这里通知你。" />
      ) : (
        <ul className="flex flex-col gap-2.5">
          {alerts?.map((a) => {
            const meta = alertKindMeta(a.kind);
            const unack = !a.acknowledged;
            return (
              <Card
                key={a.id}
                className={`flex items-center gap-4 px-5 py-4 ${
                  unack ? 'border-rose-200 bg-rose-50/40' : 'opacity-75'
                }`}
              >
                <span className={`rounded border px-2 py-0.5 text-xs font-medium ${meta.classes}`}>
                  {meta.label}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-slate-800" title={a.message}>
                    {a.message}
                  </p>
                  <p className="mt-0.5 text-xs text-slate-400">
                    {a.system_name ? `${a.system_name} · ` : ''}
                    {a.monitor_name ? `${a.monitor_name} · ` : ''}
                    <span title={fmtDateTime(a.ts)}>{fmtRelative(a.ts)}</span>
                  </p>
                </div>
                {unack && hasPermission('alerts.ack') ? (
                  <button
                    onClick={() => void ack(a)}
                    disabled={ackingIds.has(a.id)}
                    className="shrink-0 rounded-lg border border-slate-300 bg-white px-3.5 py-1.5 text-xs font-medium text-slate-600 transition-colors hover:bg-slate-50 disabled:opacity-40"
                  >
                    确认
                  </button>
                ) : (
                  <span className="shrink-0 text-xs text-slate-400">已确认</span>
                )}
              </Card>
            );
          })}
        </ul>
      )}
    </div>
  );
}
