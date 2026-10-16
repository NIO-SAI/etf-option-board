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
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
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
    </div>
  );
}
