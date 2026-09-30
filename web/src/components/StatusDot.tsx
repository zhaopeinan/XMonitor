import type { MonitorStatus } from '../types';
import { statusLabel } from '../utils';

const DOT_COLORS: Record<MonitorStatus, string> = {
  up: 'bg-emerald-500',
  slow: 'bg-amber-400',
  down: 'bg-rose-500',
  unknown: 'bg-slate-300',
};

export function StatusDot({
  status,
  tooltip,
  size = 'h-2.5 w-2.5',
  className = '',
}: {
  status: MonitorStatus;
  tooltip?: string;
  size?: string;
  className?: string;
}) {
  const dot = (
    <span className={`relative flex ${className}`}>
      {status === 'down' && (
        <span
          className={`absolute inline-flex h-full w-full animate-ping rounded-full ${DOT_COLORS.down} opacity-60`}
        />
      )}
      <span className={`relative inline-flex rounded-full ${size} ${DOT_COLORS[status]}`} />
    </span>
  );
  if (!tooltip) return dot;
  return (
    <span className="group relative inline-flex">
      {dot}
      <span className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-800 px-2 py-1 text-xs text-white shadow-lg group-hover:block">
        {tooltip}
      </span>
    </span>
  );
}

const BADGE_STYLES: Record<MonitorStatus, string> = {
  up: 'bg-emerald-50 text-emerald-600 border-emerald-200',
  slow: 'bg-amber-50 text-amber-600 border-amber-200',
  down: 'bg-rose-50 text-rose-600 border-rose-200',
  unknown: 'bg-slate-100 text-slate-500 border-slate-200',
};

export function StatusBadge({ status, expectMode }: { status: MonitorStatus; expectMode?: string | null }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium ${BADGE_STYLES[status]}`}
    >
      <StatusDot status={status} size="h-1.5 w-1.5" />
      {statusLabel(status, expectMode)}
    </span>
  );
}

export function TypeBadge({ type }: { type: string }) {
  const isPage = type === 'page';
  return (
    <span
      className={`inline-flex rounded border px-1.5 py-0.5 text-xs font-medium ${
        isPage
          ? 'border-sky-200 bg-sky-50 text-sky-600'
          : 'border-violet-200 bg-violet-50 text-violet-600'
      }`}
    >
      {isPage ? '页面' : '接口'}
    </span>
  );
}

export function ExpectBadge({ mode }: { mode?: string | null }) {
  if (mode !== 'down') return null;
  return (
    <span className="inline-flex shrink-0 rounded border border-orange-200 bg-orange-50 px-1.5 py-0.5 text-[10px] font-medium text-orange-700">
      反向
    </span>
  );
}
