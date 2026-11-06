import * as React from "react";
import ReactDOM from "react-dom";
import { cn } from "@/lib/utils";

export const Skeleton = ({ className }: { className?: string }) => (
  <div className={cn("animate-pulse rounded-md bg-muted", className)} />
);

export const Separator = ({ className }: { className?: string }) => (
  <div className={cn("h-px w-full bg-border", className)} />
);

export function Tabs({
  tabs, value, onChange, className,
}: {
  tabs: { key: string; label: string }[];
  value: string;
  onChange: (k: string) => void;
  className?: string;
}) {
  return (
    <div className={cn("inline-flex items-center gap-1 rounded-lg bg-muted p-0.5", className)}>
      {tabs.map((t) => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={cn(
            "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            value === t.key
              ? "bg-background text-foreground shadow-xs"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** 轻量悬浮提示：portal + fixed 定位，不被滚动容器裁切；children 为触发元素。 */
export function HoverTip({
  label, children, className, triggerClassName, side = "bottom",
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  triggerClassName?: string;
  side?: "top" | "bottom";
}) {
  const ref = React.useRef<HTMLSpanElement>(null);
  const tipRef = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ x: number; y: number } | null>(null);

  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ x: r.left + r.width / 2, y: side === "top" ? r.top : r.bottom });
  };
  const hide = React.useCallback(() => setPos(null), []);

  // 挂载后按实际宽度做视口边界修正，避免右侧溢出屏幕
  React.useLayoutEffect(() => {
    if (!pos || !tipRef.current) return;
    const w = tipRef.current.offsetWidth;
    const x = Math.min(Math.max(pos.x - w / 2, 8), window.innerWidth - w - 8);
    tipRef.current.style.left = `${x}px`;
    if (side === "top") tipRef.current.style.bottom = `${window.innerHeight - pos.y + 6}px`;
    else tipRef.current.style.top = `${pos.y + 6}px`;
  }, [pos, side]);

  // 滚动/缩放时提示易错位，直接隐藏
  React.useEffect(() => {
    if (!pos) return;
    const onScroll = () => hide();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [pos, hide]);

  return (
    <>
      <span
        ref={ref}
        onMouseEnter={show}
        onMouseLeave={hide}
        onClick={hide}
        className={cn("block min-w-0", triggerClassName)}
      >
        {children}
      </span>
      {pos && label != null && label !== "" && ReactDOM.createPortal(
        <div
          ref={tipRef}
          className={cn(
            "pointer-events-none fixed z-[120] max-w-[320px] whitespace-pre-line break-words rounded-md border border-border",
            "bg-popover px-2 py-1 text-[11px] leading-snug text-popover-foreground shadow-lg",
            className,
          )}
        >
          {label}
        </div>,
        document.body,
      )}
    </>
  );
}

export type RowTipState = { text: string } | null;

/**
 * 列表行「悬停 0.5 秒显示代码」的轻提示（原生 title 延迟约 1 秒且不可控）。
 * 气泡固定在鼠标右下方（+14/+18），跟随鼠标移动时只改 DOM 样式，不触发 React 重渲染。
 * 由列表容器持有状态（只渲染一个 portal），行只负责上报 code 与指针位置。
 */
export function useRowTip(delay = 500) {
  const [tip, setTip] = React.useState<RowTipState>(null);
  const nodeRef = React.useRef<HTMLDivElement | null>(null);
  const pos = React.useRef({ x: 0, y: 0 });
  const timer = React.useRef<any>(null);

  const place = React.useCallback(() => {
    const el = nodeRef.current;
    if (!el) return;
    const x = Math.max(8, Math.min(pos.current.x + 14, window.innerWidth - el.offsetWidth - 8));
    const y = Math.max(8, Math.min(pos.current.y + 18, window.innerHeight - el.offsetHeight - 8));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  }, []);

  const hide = React.useCallback(() => {
    clearTimeout(timer.current);
    setTip(null);
  }, []);

  const enter = React.useCallback((e: React.MouseEvent<HTMLElement>, text: string) => {
    clearTimeout(timer.current);
    pos.current = { x: e.clientX, y: e.clientY };
    if (!text) return;
    timer.current = setTimeout(() => setTip({ text }), delay);
  }, [delay]);

  // 鼠标移动：更新坐标，气泡已显示时直接挪 DOM（不 setState）
  const move = React.useCallback((e: React.MouseEvent<HTMLElement>) => {
    pos.current = { x: e.clientX, y: e.clientY };
    if (nodeRef.current) place();
  }, [place]);

  // 卸载清定时器；提示显示期间滚动/缩放会错位，直接隐藏
  React.useEffect(() => () => clearTimeout(timer.current), []);
  // useLayoutEffect：气泡挂载后立刻定位（rAF 在后台标签页会被节流，不能依赖它）
  React.useLayoutEffect(() => {
    if (!tip) return;
    place();
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [tip, place, hide]);

  return { tip, nodeRef, enter, move, leave: hide };
}

/** 配合 useRowTip 使用：渲染唯一那个提示气泡（坐标由 useRowTip 直接改样式）。 */
export function RowCodeTip({
  tip, nodeRef,
}: {
  tip: RowTipState;
  nodeRef: React.RefObject<HTMLDivElement | null>;
}) {
  if (!tip) return null;
  return ReactDOM.createPortal(
    <div
      ref={nodeRef}
      className="pointer-events-none fixed z-[120] whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-[11px] leading-snug text-popover-foreground shadow-lg"
      style={{ left: 0, top: 0 }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}

/** 数据区的空/错误态：短标题 + 1 句说明（可选 action），不抢焦点、不撑高布局。 */
export function EmptyState({
  title, hint, action, className,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-1 px-4 py-6 text-center", className)}>
      <div className="text-xs font-medium text-foreground">{title}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

export function Dialog({
  open, onClose, title, children, className,
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  if (!open) return null;
  // 挂到 body：调用方可能位于 sticky/transform 容器内，那样 fixed 会被限制在
  // 该层叠上下文里，被同级的后续列盖住（z-50 也救不回来）。
  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div
        className={cn(
          "relative z-10 max-h-[88vh] w-[min(92vw,760px)] overflow-auto rounded-xl border border-border bg-card p-4 shadow-2xl",
          className,
        )}
      >
        {title && <div className="mb-3 pr-6 text-sm font-semibold">{title}</div>}
        <button
          onClick={onClose}
          className="absolute right-3 top-3 text-muted-foreground hover:text-foreground"
        >
          ✕
        </button>
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** 右侧抽屉：点板块从右边滑出，不遮挡列表（详情/筛选类内容优先用它而不是居中弹窗）。 */
export function Drawer({
  open, onClose, title, subtitle, children, widthClass = "w-[min(96vw,620px)]",
}: {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
  widthClass?: string;
}) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return ReactDOM.createPortal(
    <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/55 backdrop-blur-[2px]" onClick={onClose} />
      <aside
        className={cn(
          "drawer-enter absolute right-0 top-0 flex h-full flex-col border-l border-border bg-card shadow-2xl",
          widthClass,
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b border-border/60 px-4 py-2.5">
          <div className="min-w-0">
            {title && <div className="truncate text-sm font-semibold">{title}</div>}
            {subtitle && <div className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            ✕
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-3">{children}</div>
      </aside>
    </div>,
    document.body,
  );
}
