import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

export interface SelectOption {
  value: string;
  label: string;
  /** 选项右侧的次要说明（例如接口地址），过长时省略 */
  note?: string;
  disabled?: boolean;
  /** 在该选项下方画一条分隔线，用于把「不关联 / 全部」这类选项与其余选项分开 */
  divider?: boolean;
}

/** 下拉与触发器之间的间距 */
const DROPDOWN_GAP = 4;
/** 下拉离视口边缘至少留出的间距，避免贴边 */
const VIEWPORT_GAP = 8;
/** 下拉最大高度；视口更矮时按可用空间收窄 */
const MAX_MENU_H = 288;
/** 下拉最大宽度，避免长文本把菜单撑得过宽 */
const MAX_MENU_W = 360;
/** 连打字母时，多久之内算一次连续输入（用于首字母跳转） */
const TYPEAHEAD_MS = 700;

interface Placement {
  /** 触发器上边缘（视口坐标），上翻时用来对齐 */
  anchorTop: number;
  /** 触发器下边缘（视口坐标），向下展开时用来对齐 */
  anchorBottom: number;
  left: number;
  width: number;
  maxWidth: number;
  /** 向上展开（触发器贴近视口底部时） */
  up: boolean;
}

/** 从 from 出发按 dir 找下一个可选项，跳过禁用项；找不到时保持原位 */
function step(options: SelectOption[], from: number, dir: 1 | -1): number {
  const n = options.length;
  if (n === 0) return -1;
  let i = from < 0 ? (dir === 1 ? -1 : 0) : from;
  for (let k = 0; k < n; k += 1) {
    i = (i + dir + n) % n;
    if (!options[i].disabled) return i;
  }
  return from;
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      aria-hidden="true"
      className={`h-4 w-4 shrink-0 text-slate-400 transition-transform duration-150 ${
        open ? 'rotate-180' : ''
      }`}
    >
      <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * 统一的自绘下拉选择：不使用系统原生 <select>，展开层固定定位（不会被卡片 overflow 裁掉），
 * 空间不足时自动上翻，支持方向键 / Home / End / 首字母跳转、Esc 关闭。
 */
export function Select({
  value,
  options,
  onChange,
  className = '',
  size = 'md',
  placeholder = '请选择',
  disabled = false,
  ariaLabel,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** 触发器附加样式，例如 `!w-44` 控制宽度 */
  className?: string;
  size?: 'md' | 'sm';
  /** 没有匹配到任何选项时显示的灰色文案 */
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [active, setActive] = useState(-1);
  const typed = useRef({ text: '', at: 0 });

  const selectedIndex = options.findIndex((o) => o.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  /** 量触发器位置：先按「向下展开」放置，渲染后由 layout effect 按实际内容高度决定是否上翻 */
  const measure = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const maxWidth = Math.min(MAX_MENU_W, window.innerWidth - VIEWPORT_GAP * 2);
    const left = Math.min(
      Math.max(VIEWPORT_GAP, r.left),
      Math.max(VIEWPORT_GAP, window.innerWidth - VIEWPORT_GAP - maxWidth),
    );
    setPlacement({
      anchorTop: r.top,
      anchorBottom: r.bottom,
      left,
      width: r.width,
      maxWidth,
      up: false,
    });
  }, []);

  const openMenu = useCallback(() => {
    if (disabled) return;
    measure();
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }, [disabled, measure, selectedIndex]);

  const close = useCallback(() => {
    setOpen(false);
    setPlacement(null);
  }, []);

  const commit = useCallback(
    (index: number) => {
      const opt = options[index];
      if (!opt || opt.disabled) return;
      onChange(opt.value);
      close();
      triggerRef.current?.focus();
    },
    [close, onChange, options],
  );

  // 固定定位 + 先按下方展开渲染，再按滚动区内容高度决定方向：
  // 下方放不下而上方更宽裕时上翻；上下都放不下则保持下方、由 maxHeight 收窄并内部滚动
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!open || !placement || !el || placement.up) return;
    const vh = window.innerHeight;
    const desired = Math.min(MAX_MENU_H, el.scrollHeight);
    const spaceAbove = placement.anchorTop - DROPDOWN_GAP - VIEWPORT_GAP;
    const spaceBelow = vh - VIEWPORT_GAP - placement.anchorBottom - DROPDOWN_GAP;
    if (desired <= spaceBelow || spaceAbove <= spaceBelow) return;
    setPlacement({ ...placement, up: true });
  }, [open, placement]);

  // 键盘上下移动时，把当前项滚进可视区
  useLayoutEffect(() => {
    if (!open) return;
    const el = menuRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  // 固定定位的下拉会随页面滚动与触发器脱节：跟随重算位置，触发器滚出视口则收起
  useEffect(() => {
    if (!open) return;
    const onScroll = (e: Event) => {
      const menu = menuRef.current;
      if (menu && e.target instanceof Node && menu.contains(e.target)) return;
      const el = triggerRef.current;
      if (!el) {
        close();
        return;
      }
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) {
        close();
        return;
      }
      measure();
    };
    const onResize = () => close();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [close, measure, open]);

  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!open) {
        openMenu();
        return;
      }
      if (e.key === 'ArrowDown') setActive((i) => step(options, i, 1));
      else if (e.key === 'ArrowUp') setActive((i) => step(options, i, -1));
      else commit(active);
      return;
    }
    if (e.key === 'Escape') {
      if (open) {
        e.preventDefault();
        close();
      }
      return;
    }
    if (e.key === 'Home' && open) {
      e.preventDefault();
      setActive(step(options, -1, 1));
      return;
    }
    if (e.key === 'End' && open) {
      e.preventDefault();
      setActive(step(options, 0, -1));
      return;
    }
    if (open && e.key.length === 1 && e.key !== ' ') {
      const now = Date.now();
      const buf = now - typed.current.at > TYPEAHEAD_MS ? e.key : typed.current.text + e.key;
      typed.current = { text: buf, at: now };
      const idx = options.findIndex(
        (o) => !o.disabled && o.label.toLowerCase().startsWith(buf.toLowerCase()),
      );
      if (idx >= 0) setActive(idx);
    }
  };

  const style: CSSProperties = {};
  if (placement) {
    const vh = window.innerHeight;
    const avail = placement.up
      ? placement.anchorTop - DROPDOWN_GAP - VIEWPORT_GAP
      : vh - VIEWPORT_GAP - placement.anchorBottom - DROPDOWN_GAP;
    style.left = placement.left;
    style.minWidth = placement.width;
    style.maxWidth = placement.maxWidth;
    style.maxHeight = Math.min(MAX_MENU_H, Math.max(96, avail));
    if (placement.up) style.bottom = vh - placement.anchorTop + DROPDOWN_GAP;
    else style.top = placement.anchorBottom + DROPDOWN_GAP;
  }

  const triggerCls =
    size === 'sm'
      ? 'gap-2 rounded-lg border px-3 py-1.5 text-sm'
      : 'gap-2 rounded-lg border px-3 py-2 text-sm';

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKeyDown}
        className={`${triggerCls} flex w-full items-center justify-between bg-white text-left outline-none transition disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-400 ${
          open
            ? 'border-slate-500 ring-2 ring-slate-200'
            : 'border-slate-300 focus:border-slate-500 focus:ring-2 focus:ring-slate-200'
        } ${className}`}
      >
        <span className={`truncate ${selected ? 'text-slate-800' : 'text-slate-400'}`}>
          {selected ? selected.label : placeholder}
        </span>
        <Chevron open={open} />
      </button>

      {open && placement && (
        <>
          <div className="fixed inset-0 z-10" onClick={close} />
          <div
            ref={menuRef}
            role="listbox"
            aria-label={ariaLabel}
            id={listId}
            style={style}
            className="fixed z-20 overflow-y-auto overscroll-contain rounded-xl border border-slate-200 bg-white py-1 shadow-lg"
          >
            {options.length === 0 && (
              <p className="px-3 py-2 text-sm text-slate-400">暂无可选项</p>
            )}
            {options.map((opt, i) => {
              const isSelected = i === selectedIndex;
              const isActive = i === active;
              return (
                <button
                  key={opt.value}
                  type="button"
                  id={`${listId}-${i}`}
                  data-idx={i}
                  role="option"
                  aria-selected={isSelected}
                  disabled={opt.disabled}
                  onMouseEnter={() => !opt.disabled && setActive(i)}
                  onClick={() => commit(i)}
                  title={opt.note ? `${opt.label} · ${opt.note}` : opt.label}
                  className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    isActive ? 'bg-slate-100' : ''
                  } ${isSelected ? 'font-medium text-slate-900' : 'text-slate-700'} ${
                    opt.divider && i < options.length - 1 ? 'mb-1 border-b border-slate-100' : ''
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate">{opt.label}</span>
                  {opt.note && (
                    <span className="max-w-[12rem] shrink-0 truncate text-xs text-slate-400">
                      {opt.note}
                    </span>
                  )}
                  {isSelected && (
                    <svg
                      viewBox="0 0 20 20"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                      className="h-4 w-4 shrink-0 text-slate-900"
                    >
                      <path d="M5 10.5l3.2 3.2L15 7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
