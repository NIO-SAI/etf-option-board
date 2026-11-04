import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Frame, FramePanel, FrameHeader, FrameTitle } from "@/components/reui/frame";
import { Badge } from "@/components/reui/badge";
import { EmptyState, Skeleton, Tabs } from "@/components/ui/misc";
import { FlowListPanel, type BatchMode, type SortKey } from "@/components/FlowListPanel";
import { BoardDetailDrawer } from "@/components/BoardDetailDrawer";
import { MoneyLinesChart } from "@/components/charts";
import { api } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { onGlobalRefresh } from "@/lib/refresh";
import { signedYi } from "@/lib/format";
import { cn } from "@/lib/utils";

const TYPES = [
  { key: "concept", label: "概念" },
  { key: "industry", label: "行业" },
  { key: "custom", label: "自定义" },
];
/** 图上最多画 6 条；勾选数量不限制 */
const MAX_LINES = 6;

/** 主力资金多日图：左侧列表（搜索/排序/批量勾选）+ 右侧分钟级累计资金曲线。 */
export function BoardMultiPage() {
  const [type, setType] = useState("concept");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("flow");
  const [sortDir, setSortDir] = useState(-1);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [detailCode, setDetailCode] = useState<{ code: string; name: string } | null>(null);
  const [watchItems, setWatchItems] = useState<{ code: string; name: string }[]>([]);
  const [watchBusy, setWatchBusy] = useState<Record<string, boolean>>({});
  const touched = useRef(false);

  const { data: health } = usePolling(() => api.boardHealth(), 60_000, [], { kind: "ctx", code: "board-health" });
  const interval = health?.trading ? 120_000 : 600_000;

  // 一次取「概念+行业」全量，切页签/自定义都本地过滤，避免切 tab 重新请求
  const { data, refresh, error } = usePolling(
    () => api.boardMulti(start || undefined, end || undefined, "all"),
    interval,
    [start, end, interval],
    { kind: "bmulti", code: `all:${start || "auto"}:${end || "auto"}` },
  );

  const { data: watchView, refresh: refreshWatch } = usePolling(
    () => api.boardWatch(), 300_000, [], { kind: "ctx", code: "board-watch" });
  useEffect(() => {
    if (Array.isArray(watchView?.items)) setWatchItems(watchView.items);
  }, [watchView]);
  const watchSet = useMemo(() => new Set(watchItems.map((i) => i.code)), [watchItems]);

  useEffect(() => onGlobalRefresh(() => { void refresh(); }), [refresh]);

  const items: any[] = data?.items ?? [];
  const byCode = useMemo(() => {
    const m: Record<string, any> = {};
    items.forEach((i) => (m[i.code] = i));
    return m;
  }, [items]);
  const sourceItems = useMemo(() => {
    if (type === "custom") {
      // 多日图是板块维度（BK），指数（1.xxxxxx）没有板块日快照，这里只列板块
      return watchItems.filter((w) => w.code.startsWith("BK")).map((w) => byCode[w.code] ?? {
        code: w.code, name: w.name, type: "concept", total: 0, pct: 0, days: 0, values: [], watch: true,
      }).map((i) => ({ ...i, watch: true }));
    }
    return items.filter((i) => i.type === type);
  }, [type, items, watchItems, byCode]);

  const rows = useMemo(() => {
    const kw = search.trim().toLowerCase();
    let list = sourceItems;
    if (kw) {
      const raw = search.trim();
      list = list.filter((i) => i.name.includes(raw) || i.code.toLowerCase().includes(kw)
        || String(i.py ?? "").includes(kw));
    }
    return [...list].sort((a, b) => {
      const va = sortKey === "pct" ? (a.pct ?? 0) : a.total;
      const vb = sortKey === "pct" ? (b.pct ?? 0) : b.total;
      return (va - vb) * sortDir;
    });
  }, [sourceItems, search, sortKey, sortDir]);

  // 默认选前 3（手动改过就不再回填）
  useEffect(() => {
    if (!sourceItems.length || touched.current) return;
    setSelected((prev) => {
      const codes = new Set(sourceItems.map((i) => i.code));
      const keep = Object.keys(prev).filter((c) => codes.has(c));
      if (keep.length) return prev;
      if (type === "custom") {
        return Object.fromEntries(sourceItems.map((i) => [i.code, true]));
      }
      return Object.fromEntries(sourceItems.slice(0, 3).map((i) => [i.code, true]));
    });
  }, [sourceItems, type]);

  const selectedCodes = rows.filter((r) => selected[r.code]).map((r) => r.code);
  const chartCodes = selectedCodes.slice(0, MAX_LINES);
  const codesKey = chartCodes.join(",");

  const { data: intraday } = usePolling(
    () => (codesKey
      ? api.boardMultiSeries(codesKey, start || data?.start, end || data?.end)
      : Promise.resolve(null)),
    interval,
    [codesKey, start, end, data?.start, data?.end, interval],
    { kind: "bseries", code: `multi:${codesKey}`, extra: `${start || "auto"}:${end || "auto"}` },
  );

  const chartSeries = (intraday?.series ?? []).map((s: any) => ({
    code: s.code, name: s.name, values: s.values,
  }));

  const toggle = (code: string) => {
    touched.current = true;
    setSelected((prev) => {
      const next = { ...prev };
      if (next[code]) delete next[code];
      else next[code] = true;
      return next;
    });
  };

  const batch = (mode: BatchMode) => {
    touched.current = true;
    const base = [...sourceItems].sort((a, b) => b.total - a.total);
    const next: Record<string, boolean> = {};
    if (mode === "all") base.forEach((b) => (next[b.code] = true));
    else if (mode === "pos10") base.filter((b) => b.total >= 0).slice(0, 10).forEach((b) => (next[b.code] = true));
    else if (mode === "neg10") base.filter((b) => b.total < 0).slice(-10).forEach((b) => (next[b.code] = true));
    else if (mode === "invert") base.forEach((b) => { if (!selected[b.code]) next[b.code] = true; });
    setSelected(next);
  };

  const toggleWatch = async (b: any) => {
    if (watchBusy[b.code]) return;
    const isWatched = watchSet.has(b.code);
    setWatchBusy((m) => ({ ...m, [b.code]: true }));
    setWatchItems((prev) => (isWatched
      ? prev.filter((i) => i.code !== b.code)
      : [...prev, { code: b.code, name: b.name }]));
    try {
      const res = isWatched ? await api.boardWatchRemove(b.code) : await api.boardWatchAdd(b.code, b.name);
      if (res?.error) throw new Error(res.error);
      void refreshWatch();
    } catch (e: any) {
      setWatchItems((prev) => (isWatched
        ? [...prev, { code: b.code, name: b.name }]
        : prev.filter((i) => i.code !== b.code)));
      toast("自定义操作失败", { description: String(e?.message ?? e) });
    } finally {
      setWatchBusy((m) => ({ ...m, [b.code]: false }));
    }
  };

  const quickRange = (n: number) => {
    const asc = [...(data?.available_dates ?? [])].sort();
    if (!asc.length) return;
    setStart(asc[Math.max(0, asc.length - n)]);
    setEnd(asc[asc.length - 1]);
  };

  const dates = intraday?.dates ?? data?.dates ?? [];

  return (
    <main className="grid gap-3 p-3 xl:grid-cols-[320px_minmax(0,1fr)]">
      <FlowListPanel
        title="板块列表"
        countText={`共 ${rows.length} 个 · 已选 ${selectedCodes.length}`}
        rows={rows.map((r: any) => ({
          code: r.code, name: r.name, flow: r.total, pct: r.pct ?? null, type: r.type,
          watch: watchSet.has(r.code),
        }))}
        selected={selected}
        onToggle={toggle}
        search={search}
        onSearch={setSearch}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={(k) => {
          if (k === sortKey) setSortDir((d) => -d);
          else { setSortKey(k); setSortDir(-1); }
        }}
        sortOptions={[{ key: "pct", label: "涨幅" }, { key: "flow", label: "资金" }]}
        onBatch={batch}
        onDetail={(r) => setDetailCode({ code: r.code, name: r.name })}
        onToggleWatch={toggleWatch}
        watchBusy={watchBusy}
        loading={!data}
        emptyTitle="暂无区间数据"
        emptyHint={data?.error ?? undefined}
        maxHeight="calc(100vh - 20rem)"
      />

      <Frame spacing="sm" className="flex min-h-0 flex-col xl:sticky xl:top-[52px] xl:h-[calc(100vh-104px)]">
        <FramePanel dense className="flex min-h-0 flex-1 flex-col">
          <FrameHeader className="flex-row flex-wrap items-center justify-between gap-2 py-1.5">
            <div className="flex items-center gap-2">
              <FrameTitle className="text-sm">主力资金多日图</FrameTitle>
              <Tabs tabs={TYPES} value={type} onChange={(k) => { setType(k); setSelected({}); setSearch(""); touched.current = false; }} />
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <select
                id="board-multi-start" name="start" aria-label="起始日期"
                value={start} onChange={(e) => setStart(e.target.value)}
                className="rounded border border-border bg-card px-1.5 py-0.5 text-[11px] text-foreground"
              >
                <option value="">默认起</option>
                {(data?.available_dates ?? []).map((d: string) => <option key={d} value={d}>{d}</option>)}
              </select>
              <span className="text-muted-foreground">至</span>
              <select
                id="board-multi-end" name="end" aria-label="结束日期"
                value={end} onChange={(e) => setEnd(e.target.value)}
                className="rounded border border-border bg-card px-1.5 py-0.5 text-[11px] text-foreground"
              >
                <option value="">默认止</option>
                {(data?.available_dates ?? []).map((d: string) => <option key={d} value={d}>{d}</option>)}
              </select>
              <span className="flex items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5">
                {[3, 5, 8].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => quickRange(n)}
                    className={cn("rounded px-1.5 py-0.5 transition-colors",
                      dates.length === n ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground")}
                  >
                    {n}日
                  </button>
                ))}
              </span>
              <button
                type="button" onClick={() => refresh()} title="刷新" aria-label="刷新"
                className="rounded-md border border-border p-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                <RefreshCw className="size-3" aria-hidden />
              </button>
            </div>
          </FrameHeader>

          <div className="flex min-h-0 flex-1 flex-col px-1 pb-1">
            {error ? (
              <EmptyState title="接口失败" hint={String(error)} className="flex-1" />
            ) : !data ? (
              <Skeleton className="m-2 h-[380px]" />
            ) : !chartSeries.length ? (
              <EmptyState title={selectedCodes.length ? "加载分钟级曲线…" : "还没有选中板块"}
                hint={selectedCodes.length ? undefined : "在左侧勾选，或点「流入Top10」批量激活"}
                className="flex-1" />
            ) : (
              <div className="min-h-0 flex-1">
                <MoneyLinesChart
                  id="board-multi-lines"
                  axis={intraday?.axis ?? []}
                  series={chartSeries as any}
                  height="100%"
                  maxLines={MAX_LINES}
                  vLines={intraday?.day_breaks ?? []}
                  showEndLabel
                />
              </div>
            )}
            <div className="mt-1 flex flex-wrap items-center justify-between gap-2 px-2 text-[10px] text-muted-foreground">
              <span>区间累计资金（分钟级）· 图上最多 {MAX_LINES} 条，已选 {selectedCodes.length} 个</span>
            </div>
          </div>
        </FramePanel>
      </Frame>

      <BoardDetailDrawer
        selected={detailCode}
        date={end || intraday?.end || data?.end || ""}
        onClose={() => setDetailCode(null)}
      />
    </main>
  );
}
