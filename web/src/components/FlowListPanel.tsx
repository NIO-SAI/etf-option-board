import { Check, Eye, Loader2, Plus, Search } from "lucide-react";
import { Frame, FramePanel, FrameHeader, FrameTitle } from "@/components/reui/frame";
import { EmptyState } from "@/components/ui/misc";
import { clsUpDown, pct as fmtPct, signedFlow } from "@/lib/format";
import { cn } from "@/lib/utils";

export type FlowRow = {
  code: string;
  name: string;
  flow: number;
  pct?: number | null;
  speed?: number;
  type?: string;
  watch?: boolean;
  py?: string;
};

export type SortKey = "flow" | "pct" | "speed";
export type BatchMode = "pos10" | "neg10" | "all" | "none" | "invert";

const BATCHES: { key: BatchMode; label: string }[] = [
  { key: "pos10", label: "流入Top10" },
  { key: "neg10", label: "流出Top10" },
  { key: "all", label: "全选" },
  { key: "none", label: "清空" },
  { key: "invert", label: "反选" },
];

/**
 * 板块/ETF 列表面板：搜索、排序、批量勾选、行内自定义与详情。
 * 主力资金分时 / 主力资金多日 / ETF资金流 / 指数资金分时 四页共用，
 * 保证结构与宽度一致（360px，与「主力资金多日」对齐）；不传 `onBatch` 时隐藏批量勾选行（单标的选择用）。
 */
export function FlowListPanel({
  title, countText, rows, selected, onToggle,
  search, onSearch,
  sortKey, sortDir, onSort,
  sortOptions = [{ key: "pct", label: "涨幅" }, { key: "speed", label: "涨速" }, { key: "flow", label: "资金" }],
  onBatch,
  emptyTitle = "无匹配数据", emptyHint,
  showPct = true,
  showCheckbox = true,
  onToggleWatch,
  watchBusy,
  onDetail,
  onHoverRow,
  maxHeight = "calc(100vh - 19rem)",
  loading,
}: {
  title: string;
  countText: string;
  rows: FlowRow[];
  selected: Record<string, boolean>;
  onToggle: (code: string) => void;
  search: string;
  onSearch: (v: string) => void;
  sortKey: SortKey;
  sortDir: number;
  onSort: (k: SortKey) => void;
  sortOptions?: { key: SortKey; label: string }[];
  onBatch?: (mode: BatchMode) => void;
  emptyTitle?: string;
  emptyHint?: string;
  showPct?: boolean;
  /** 是否显示行首勾选框。单标的选择（四维资金 / ETF 4 维拆解）传 false，只靠行高亮表示当前目标。 */
  showCheckbox?: boolean;
  onToggleWatch?: (row: FlowRow) => void;
  watchBusy?: Record<string, boolean>;
  onDetail?: (row: FlowRow) => void;
  /** 悬停某行（用于图上高亮/红绿分段），离开时传 null */
  onHoverRow?: (code: string | null) => void;
  maxHeight?: string;
  loading?: boolean;
}) {
  return (
    <Frame spacing="sm" className="self-start xl:sticky xl:top-[52px]">
      <FramePanel dense>
        <FrameHeader className="flex-row items-center justify-between py-1.5">
          <FrameTitle className="text-sm">{title}</FrameTitle>
          <span className="text-[11px] text-muted-foreground tnum">{countText}</span>
        </FrameHeader>

        <div className="flex flex-col gap-2 px-2 pb-2">
          <label className="relative block">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <input
              id="flow-list-search"
              name="search"
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder="搜索..."
              aria-label="搜索"
              className="w-full rounded-md border border-border bg-card py-1 pl-7 pr-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </label>

          <div className="flex items-center gap-1 text-[11px]">
            <span className="text-muted-foreground">排序</span>
            <div className="flex items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5">
              {sortOptions.map((o) => (
                <button
                  key={o.key}
                  type="button"
                  onClick={() => onSort(o.key)}
                  aria-pressed={sortKey === o.key}
                  title={`按${o.label}排序（再点切换升/降序）`}
                  className={cn("rounded px-2 py-0.5 font-medium transition-colors",
                    sortKey === o.key
                      ? "bg-primary text-primary-foreground shadow-xs"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground")}
                >
                  {o.label}{sortKey === o.key ? (sortDir === -1 ? "↓" : "↑") : ""}
                </button>
              ))}
            </div>
          </div>

          {onBatch && (
            <div className="flex flex-wrap gap-1 text-[11px]">
              {BATCHES.map((b) => (
                <button
                  key={b.key}
                  type="button"
                  onClick={() => onBatch(b.key)}
                  className="rounded border border-border px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {b.label}
                </button>
              ))}
            </div>
          )}

          <div className="min-h-[240px] overflow-auto border-t border-border/60" style={{ maxHeight }}>
            {loading ? (
              <div className="flex flex-col gap-1 p-2">
                {Array.from({ length: 8 }).map((_, i) => <div key={i} className="h-6 w-full animate-pulse rounded bg-muted" />)}
              </div>
            ) : rows.length === 0 ? (
              <EmptyState title={emptyTitle} hint={emptyHint} />
            ) : (
              rows.map((b) => {
                const on = !!selected[b.code];
                return (
                  <div
                    key={b.code}
                    role="button"
                    tabIndex={0}
                    onClick={() => onToggle(b.code)}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onToggle(b.code); } }}
                    onMouseEnter={() => onHoverRow?.(b.code)}
                    onMouseLeave={() => onHoverRow?.(null)}
                    className={cn(
                      "flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[11px] transition-colors hover:bg-muted/60",
                      on && "bg-primary/5",
                    )}
                    title={`${b.code} · ${showCheckbox ? "单击勾选 / 取消" : "单击切换"}`}
                  >
                    {showCheckbox && (
                      <input type="checkbox" checked={on} readOnly aria-label={`勾选${b.name}`}
                        className="size-3 shrink-0 accent-primary" />
                    )}
                    <span className={cn("min-w-0 flex-1 truncate", on ? "font-medium text-foreground" : "text-foreground/80")}>
                      {b.name}
                      {b.type === "index" && !b.code.startsWith("47.") && (
                        <span className="ml-1 text-[10px] text-muted-foreground">({b.code.split(".")[1]})</span>
                      )}
                    </span>
                    {showPct && (
                      <span className={cn("w-[4.2em] shrink-0 text-right text-[10px] tabular-nums", clsUpDown(b.pct))}>
                        {b.pct == null ? "--" : fmtPct(b.pct, 2)}
                      </span>
                    )}
                    <span className={cn("w-[7.2em] shrink-0 whitespace-nowrap text-right text-[10px] tabular-nums",
                      b.flow >= 0 ? "text-up" : "text-down")}>
                      {signedFlow(b.flow)}
                    </span>
                    {onDetail && b.code.startsWith("BK") && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onDetail(b); }}
                        title="查看板块详情"
                        aria-label={`查看${b.name}详情`}
                        className="inline-flex size-5 shrink-0 items-center justify-center rounded border border-border bg-card text-muted-foreground transition-colors hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Eye className="size-3" aria-hidden />
                      </button>
                    )}
                    {onToggleWatch && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); onToggleWatch(b); }}
                        disabled={!!watchBusy?.[b.code]}
                        title={b.watch ? "已加入自定义，点击移除" : "加入自定义"}
                        aria-label={b.watch ? "移除自定义" : "添加自定义"}
                        aria-pressed={!!b.watch}
                        className={cn(
                          "inline-flex size-5 shrink-0 items-center justify-center rounded border transition-colors",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          b.watch
                            ? "border-warning/60 bg-warning/15 text-warning hover:border-destructive hover:text-destructive"
                            : "border-border bg-card text-muted-foreground hover:border-primary hover:bg-primary/10 hover:text-primary",
                          watchBusy?.[b.code] && "cursor-wait opacity-60",
                        )}
                      >
                        {watchBusy?.[b.code]
                          ? <Loader2 className="size-3 animate-spin" aria-hidden />
                          : b.watch ? <Check className="size-3" aria-hidden /> : <Plus className="size-3" aria-hidden />}
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </FramePanel>
    </Frame>
  );
}
