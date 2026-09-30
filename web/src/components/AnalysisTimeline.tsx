import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AnalysisEvent, AnalysisJob } from '../types';
import { Card } from './ui';

// ---- 相位图标（20x20 SVG，currentColor） ----

function svg(path: string): ReactNode {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-3.5 w-3.5">
      <path d={path} />
    </svg>
  );
}

const PHASE_ICONS: Record<string, ReactNode> = {
  sso: svg('M10 2a4 4 0 0 0-4 4v2H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1h-1V6a4 4 0 0 0-4-4zM8 8V6a2 2 0 1 1 4 0v2H8z'),
  init: svg('M6 4l10 6-10 6V4z'),
  navigate: svg(
    'M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM4 9h3.2c.1-2.3.6-4.3 1.4-5.6A6 6 0 0 0 4 9zm6-5.1c.9.8 1.6 2.6 1.8 5.1H8.2c.2-2.5.9-4.3 1.8-5.1zM11.4 3.4c.8 1.3 1.3 3.3 1.4 5.6H16a6 6 0 0 0-4.6-5.6zM4 11h3.2c.1 2.3.6 4.3 1.4 5.6A6 6 0 0 1 4 11zm4.2 0h3.6c-.2 2.5-.9 4.3-1.8 5.1-.9-.8-1.6-2.6-1.8-5.1zm4.6 0H16a6 6 0 0 1-4.6 5.6c.8-1.3 1.3-3.3 1.4-5.6z',
  ),
  extract: svg('M5 3h8l4 4v10H5V3zm7 1.5V7h2.5L12 4.5zM7 9h6v1.5H7V9zm0 3h6v1.5H7V12z'),
  screenshot: svg(
    'M7 4l1.5-2h3L13 4h4a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h4zm3 4a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
  ),
  subpage: svg('M3 3h6v6H3V3zm8 0h6v6h-6V3zM3 11h6v6H3v-6zm8 0h6v6h-6v-6z'),
  llm: svg(
    'M10 2l1.3 3.9L15.5 7.3l-4.2 1.4L10 12.6 8.7 8.7 4.5 7.3l4.2-1.4L10 2zm6 8l.8 2.3 2.3.8-2.3.8-.8 2.3-.8-2.3-2.3-.8 2.3-.8.8-2.3zM4.5 12.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2z',
  ),
  parse: svg(
    'M7 5L3 10l4 5 1.4-1.2L5.6 10l2.8-3.8L7 5zm6 0l-1.4 1.2 2.8 3.8-2.8 3.8L13 15l4-5-4-5z',
  ),
  save: svg(
    'M10 2C6 2 3 3.6 3 5.5v9C3 16.4 6 18 10 18s7-1.6 7-3.5v-9C17 3.6 14 2 10 2zm5 12.5c0 .8-2 1.5-5 1.5s-5-.7-5-1.5V12c1.2 1 3.4 1.5 5 1.5s3.8-.5 5-1.5v2.5zm0-4c0 .8-2 1.5-5 1.5s-5-.7-5-1.5V8c1.2 1 3.4 1.5 5 1.5s3.8-.5 5-1.5v2.5z',
  ),
  done: svg(
    'M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zm3.7 6.3l-4.5 4.5-2.2-2.2 1.1-1.1 1.1 1.1 3.4-3.4 1.1 1.1z',
  ),
};

const LEVEL_DOT: Record<string, string> = {
  info: 'bg-slate-300',
  success: 'bg-emerald-500',
  warn: 'bg-amber-400',
  error: 'bg-rose-500',
};

const LEVEL_ICON_TEXT: Record<string, string> = {
  info: 'text-slate-400',
  success: 'text-emerald-500',
  warn: 'text-amber-500',
  error: 'text-rose-500',
};

// ts 兼容秒 / 毫秒两种时间戳
function normTs(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

function fmtClock(ts: number): string {
  return new Date(normTs(ts)).toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function phaseTitle(e: AnalysisEvent | undefined): string {
  if (!e) return '准备分析任务…';
  const d = e.data ?? {};
  switch (e.phase) {
    case 'sso':
      return e.level === 'success'
        ? '统一身份认证登录成功'
        : e.level === 'error'
          ? '统一身份认证登录失败'
          : '正在执行统一身份认证登录…';
    case 'init':
      return '初始化分析任务…';
    case 'navigate':
      return '正在访问主页…';
    case 'extract':
      return '正在提取页面内容…';
    case 'screenshot':
      return '正在截取页面截图…';
    case 'subpage':
      return `正在访问子页面 ${String(d.index ?? '?')}/${String(d.total ?? '?')}`;
    case 'llm':
      return e.level === 'success' ? '大模型已返回结果' : '正在等待大模型响应…';
    case 'parse':
      return '正在解析模型输出…';
    case 'save':
      return '正在保存候选项…';
    case 'done':
      return '分析完成';
    default:
      return e.message;
  }
}

// ---- 事件 data 详情（可展开） ----

interface ExtractData {
  links?: string[];
  apis?: { method: string; url: string }[];
  text_len?: number;
}

function EventDetail({ ev }: { ev: AnalysisEvent }) {
  const [open, setOpen] = useState(false);
  const d = ev.data ?? {};
  const keys = Object.keys(d);
  if (keys.length === 0) return null;

  const isExtract = ev.phase === 'extract';
  const excerpt =
    ev.phase === 'llm' && typeof d.raw_excerpt === 'string' ? (d.raw_excerpt as string) : null;

  let summary = '详情';
  if (isExtract) {
    const ed = d as ExtractData;
    summary = `发现 ${ed.links?.length ?? 0} 个链接、${ed.apis?.length ?? 0} 个接口`;
  } else if (excerpt) {
    summary = '查看模型原始输出摘录';
  }

  const kvEntries = keys
    .filter((k) => {
      if (isExtract && (k === 'links' || k === 'apis')) return false;
      if (k === 'raw_excerpt') return false;
      const v = d[k];
      return v === null || ['string', 'number', 'boolean'].includes(typeof v);
    })
    .map((k) => [k, d[k]] as const);

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-xs text-slate-400 transition-colors hover:text-slate-600"
      >
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`}
        >
          <path
            fillRule="evenodd"
            d="M7.21 5.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L10.94 10 7.21 6.28a.75.75 0 0 1 0-1.06z"
            clipRule="evenodd"
          />
        </svg>
        {summary}
      </button>

      {open && (
        <div className="mt-1.5 rounded-lg border border-slate-200 bg-slate-50/70 p-3">
          {kvEntries.length > 0 && (
            <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs">
              {kvEntries.map(([k, v]) => (
                <div key={k} className="flex gap-1.5">
                  <dt className="text-slate-400">{k}</dt>
                  <dd className="font-medium text-slate-600">{String(v)}</dd>
                </div>
              ))}
            </dl>
          )}

          {isExtract && (
            <div className={kvEntries.length > 0 ? 'mt-2' : ''}>
              {(() => {
                const ed = d as ExtractData;
                return (
                  <>
                    {ed.links && ed.links.length > 0 && (
                      <div>
                        <p className="mb-1 text-xs font-medium text-slate-500">
                          链接（{ed.links.length}）
                        </p>
                        <ul className="max-h-36 overflow-y-auto rounded border border-slate-200 bg-white px-3 py-1.5 font-mono text-xs text-slate-500">
                          {ed.links.map((u, i) => (
                            <li key={i} className="truncate py-0.5" title={u}>
                              {u}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {ed.apis && ed.apis.length > 0 && (
                      <div className="mt-2">
                        <p className="mb-1 text-xs font-medium text-slate-500">
                          接口（{ed.apis.length}）
                        </p>
                        <ul className="max-h-36 overflow-y-auto rounded border border-slate-200 bg-white px-3 py-1.5 font-mono text-xs text-slate-500">
                          {ed.apis.map((a, i) => (
                            <li key={i} className="truncate py-0.5" title={a.url}>
                              <span className="mr-1.5 rounded bg-slate-100 px-1 text-slate-600">
                                {a.method}
                              </span>
                              {a.url}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          {excerpt && (
            <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded border border-slate-200 bg-white p-3 font-mono text-xs leading-relaxed text-slate-600">
              {excerpt}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ---- 时间线主体 ----

export default function AnalysisTimeline({
  job,
  onRetry,
}: {
  job: AnalysisJob | null;
  onRetry: () => void;
}) {
  const events = useMemo(() => job?.events ?? [], [job]);
  const status = job?.status;
  const running = status === 'pending' || status === 'running';
  const failed = status === 'failed';
  const done = status === 'done';

  const [showReview, setShowReview] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const scrollRef = useRef<HTMLDivElement>(null);

  // 秒级耗时跳动
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);

  // 自动滚动到底部
  useEffect(() => {
    const el = scrollRef.current;
    if (el && !done) el.scrollTop = el.scrollHeight;
  }, [events.length, done]);

  const startTs = events.length > 0 ? normTs(events[0].ts) : null;
  const endTs = done && events.length > 0 ? normTs(events[events.length - 1].ts) : now;
  const elapsedSec = startTs === null ? 0 : Math.max(0, (endTs - startTs) / 1000);

  const lastEvent = events[events.length - 1];
  const lastPhase = lastEvent?.phase;
  const doneData = (done ? lastEvent?.data : undefined) ?? {};

  const timelineBody = (
    <div ref={scrollRef} className="max-h-96 overflow-y-auto px-5 py-4">
      {events.length === 0 ? (
        <p className="py-6 text-center text-sm text-slate-400">等待分析任务启动…</p>
      ) : (
        <ol className="relative ml-1.5 border-l border-slate-200">
          {events.map((ev, i) => {
            const isLast = i === events.length - 1;
            const pulsing = running && isLast && !done;
            const dotColor = LEVEL_DOT[ev.level] ?? LEVEL_DOT.info;
            return (
              <li key={i} className="relative mb-4 ml-6 last:mb-0">
                <span className="absolute -left-[27px] top-1.5 flex h-3 w-3">
                  {pulsing && (
                    <span
                      className={`absolute inline-flex h-full w-full animate-ping rounded-full ${dotColor} opacity-60`}
                    />
                  )}
                  <span
                    className={`relative inline-flex h-3 w-3 rounded-full border-2 border-white ${dotColor}`}
                  />
                </span>
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-mono text-xs text-slate-400">{fmtClock(ev.ts)}</span>
                  <span className={LEVEL_ICON_TEXT[ev.level] ?? LEVEL_ICON_TEXT.info}>
                    {PHASE_ICONS[ev.phase] ?? PHASE_ICONS.init}
                  </span>
                  <span
                    className={`text-sm ${
                      ev.level === 'error'
                        ? 'font-medium text-rose-600'
                        : ev.level === 'warn'
                          ? 'text-amber-600'
                          : 'text-slate-700'
                    }`}
                  >
                    {ev.message}
                  </span>
                </div>
                <EventDetail ev={ev} />
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );

  // done：折叠为可回看的摘要条
  if (done) {
    return (
      <Card className="p-0">
        <button
          type="button"
          onClick={() => setShowReview((v) => !v)}
          className="flex w-full items-center gap-3 px-5 py-3.5 text-left transition-colors hover:bg-slate-50"
        >
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-emerald-50 text-emerald-500">
            {PHASE_ICONS.done}
          </span>
          <span className="text-sm text-slate-700">
            分析完成，发现{' '}
            <span className="font-semibold text-slate-900">
              {String(doneData.candidate_count ?? '—')}
            </span>{' '}
            个候选，耗时 {elapsedSec.toFixed(0)} 秒
          </span>
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-slate-400">
            查看分析过程
            <svg
              viewBox="0 0 20 20"
              fill="currentColor"
              className={`h-3.5 w-3.5 transition-transform ${showReview ? 'rotate-180' : ''}`}
            >
              <path
                fillRule="evenodd"
                d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06z"
                clipRule="evenodd"
              />
            </svg>
          </span>
        </button>
        {showReview && <div className="border-t border-slate-100">{timelineBody}</div>}
      </Card>
    );
  }

  return (
    <Card className="p-0">
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          {running && (
            <span className="relative flex h-2.5 w-2.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-sky-400 opacity-60" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-sky-500" />
            </span>
          )}
          <p className={`text-sm font-medium ${failed ? 'text-rose-600' : 'text-slate-800'}`}>
            {failed ? '分析失败' : phaseTitle(lastEvent)}
          </p>
        </div>
        <span className="font-mono text-xs tabular-nums text-slate-400">
          已耗时 {elapsedSec.toFixed(0)}s
        </span>
      </div>

      {timelineBody}

      {failed && (
        <div className="flex items-center justify-between gap-4 border-t border-rose-100 bg-rose-50/60 px-5 py-3.5">
          <p className="text-sm text-rose-500">
            {job?.error || lastEvent?.message || '未知错误'}
          </p>
          <button
            onClick={onRetry}
            className="shrink-0 rounded-lg border border-rose-300 bg-white px-4 py-2 text-sm font-medium text-rose-600 transition-colors hover:bg-rose-50"
          >
            重试
          </button>
        </div>
      )}
    </Card>
  );
}
