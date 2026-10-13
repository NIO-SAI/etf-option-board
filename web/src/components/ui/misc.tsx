import * as React from "react";
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
