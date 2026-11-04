import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Frame, FramePanel, FrameHeader, FrameTitle } from "@/components/reui/frame";
import { Badge } from "@/components/reui/badge";
import { EmptyState, Skeleton, Tabs } from "@/components/ui/misc";
import { FlowListPanel, type BatchMode, type SortKey, type FlowRow } from "@/components/FlowListPanel";
import { BoardFlowChart, MoneyLinesChart, type FlowLine } from "@/components/charts";
import { api } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { onGlobalRefresh } from "@/lib/refresh";
import { signedYi } from "@/lib/format";
import { cn } from "@/lib/utils";

const SCOPES = [
  { key: "all", label: "全部" },
  { key: "watch", label: "自选" },
];
const MAX_LINES = 6;
const DIM_LABEL: Record<string, string> = {
  main: "主力", super: "超大单", large: "大单", medium: "中单", small: "小单",
};

/** ETF 资金流：左侧列表（搜索/排序/批量/自选）+ 右侧多线叠加 / 4 维拆解。 */
export function EtfFlowPage() {
  const [scope, setScope] = useState("all");
  const [view, setView] = useState<"series" | "4dim">("series");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("flow");
  const [sortDir, setSortDir] = useState(-1);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [watchItems, setWatchItems] = useState<{ code: string; name: string }[]>([]);
  const [watchBusy, setWatchBusy] = useState<Record<string, boolean>>({});
  const [hoverCode, setHoverCode] = useState<string | null>(null);
  const touched = useRef(false);

  const { data: health } = usePolling(() => api.boardHealth(), 60_000, [], { kind: "ctx", code: "board-health" });
  const interval = health?.trading ? 30_000 : 300_000;

  const { data, refresh, error } = usePolling(
    () => api.etfFlowRank("all"),
    interval,
    [interval],
    { kind: "etfrank", code: "all" },
  );
  const { data: watchView, refresh: refreshWatch } = usePolling(
    () => api.etfFlowWatch(), 300_000, [], { kind: "ctx", code: "etf-watch" });
  useEffect(() => {
    if (Array.isArray(watchView?.items)) setWatchItems(watchView.items);
  }, [watchView]);
  const watchSet = useMemo(() => new Set(watchItems.map((i) => i.code)), [watchItems]);

  useEffect(() => onGlobalRefresh(() => { void refresh(); }), [refresh]);

  const all: FlowRow[] = useMemo(
    () => (data?.items ?? []).map((r: any) => ({
      code: r.code, name: r.name, type: r.type, flow: r.flow ?? 0,
      pct: r.pct ?? null, watch: watchSet.has(r.code),
    })),
    [data, watchSet],
  );
  const baseRows = useMemo(() => (scope === "watch" ? all.filter((r) => r.watch) : all), [all, scope]);
  const rows = useMemo(() => {
    const kw = search.trim().toLowerCase();
    let list = baseRows;
    if (kw) list = list.filter((r) => r.name.toLowerCase().includes(kw) || r.code.includes(kw));
    return [...list].sort((a, b) => {
      const va = sortKey === "pct" ? (a.pct ?? 0) : a.flow;
      const vb = sortKey === "pct" ? (b.pct ?? 0) : b.flow;
      return (va - vb) * sortDir;
    });
  }, [baseRows, search, sortKey, sortDir]);

  const baseKey = useMemo(() => baseRows.map((r) => r.code).sort().join(","), [baseRows]);

  useEffect(() => {
    if (!rows.length) return;
    const codes = new Set(rows.map((r) => r.code));
    if (touched.current) {
      setSelected((prev) => Object.fromEntries(Object.keys(prev).filter((c) => codes.has(c)).map((c) => [c, true])));
      return;
    }
    const pos = rows.filter((r) => r.flow >= 0).slice(0, 10);
    const neg = rows.filter((r) => r.flow < 0).slice(-5);
    setSelected(Object.fromEntries([...pos, ...neg].map((r) => [r.code, true])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseKey, scope]);

  const selectedCodes = rows.filter((r) => selected[r.code]).map((r) => r.code);
  const chartCodes = selectedCodes.slice(0, MAX_LINES);
  const codesKey = chartCodes.join(",");

  const { data: series } = usePolling(
    () => (codesKey ? api.etfFlowSeries(codesKey) : Promise.resolve(null)),
    interval,
    [codesKey, interval],
    { kind: "etfseries", code: codesKey || "none" },
  );

  const dimCode = chartCodes[0] ?? null;
  const { data: dim4 } = usePolling(
    () => (dimCode ? api.etfFlow4dim(dimCode) : Promise.resolve(null)),
    60_000,
    [dimCode],
    { kind: "emseries", code: dimCode ?? "none" },
  );

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
    const base = [...baseRows].sort((a, b) => b.flow - a.flow);
    const next: Record<string, boolean> = {};
    if (mode === "all") base.forEach((b) => (next[b.code] = true));
    else if (mode === "pos10") base.filter((b) => b.flow >= 0).slice(0, 10).forEach((b) => (next[b.code] = true));
    else if (mode === "neg10") base.filter((b) => b.flow < 0).slice(-10).forEach((b) => (next[b.code] = true));
    else if (mode === "invert") base.forEach((b) => { if (!selected[b.code]) next[b.code] = true; });
    setSelected(next);
  };

  const toggleWatch = async (b: FlowRow) => {
    if (watchBusy[b.code]) return;
    const isWatched = watchSet.has(b.code);
    setWatchBusy((m) => ({ ...m, [b.code]: true }));
    setWatchItems((prev) => (isWatched
      ? prev.filter((i) => i.code !== b.code)
      : [...prev, { code: b.code, name: b.name }]));
    try {
      const res = isWatched ? await api.etfFlowWatchRemove(b.code) : await api.etfFlowWatchAdd(b.code, b.name);
      if (res?.error) throw new Error(res.error);
      void refreshWatch();
    } catch (e: any) {
      setWatchItems((prev) => (isWatched
        ? [...prev, { code: b.code, name: b.name }]
        : prev.filter((i) => i.code !== b.code)));
      toast("自选操作失败", { description: String(e?.message ?? e) });
    } finally {
      setWatchBusy((m) => ({ ...m, [b.code]: false }));
    }
  };

  const etfLines: FlowLine[] = useMemo(() => {
    const axis: string[] = (series as any)?.axis ?? [];
    return ((series as any)?.series ?? []).slice(0, MAX_LINES).map((s: any) => ({
      code: s.code,
      name: s.name,
      pct: rows.find((r) => r.code === s.code)?.pct ?? null,
      points: axis
        .map((t, i) => [t, s.values[i]] as [string, number | null])
        .filter((p) => p[1] != null) as [string, number][],
    }));
  }, [series, rows]);

  // 历史导入的分时点只有「主力」一列，四维全 0；此时用实时快照卡片展示
  const dimsAllZero = useMemo(() => {
    const d = dim4?.dims ?? {};
    return (["super", "large", "medium", "small"] as const)
      .every((k) => !((d as any)[k] ?? []).some((v: any) => v));
  }, [dim4]);

  const dimSeries = useMemo(() => {
    if (!dim4?.axis?.length) return [];
    return Object.entries(dim4.dims ?? {}).map(([k, v]) => ({
      code: k, name: DIM_LABEL[k] ?? k, values: v as (number | null)[],
    }));
  }, [dim4]);

  return (
    <main className="grid gap-3 p-3 xl:grid-cols-[320px_minmax(0,1fr)]">
      <FlowListPanel
        title="ETF 列表"
        countText={`共 ${rows.length} 只 · 已选 ${selectedCodes.length}`}
        rows={rows}
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
        onToggleWatch={toggleWatch}
        watchBusy={watchBusy}
        onHoverRow={setHoverCode}
        loading={!data}
        emptyTitle={scope === "watch" ? "还没有自选 ETF" : "暂无 ETF 数据"}
        emptyHint={scope === "watch" ? "在「全部」里点 + 加入自选" : undefined}
        maxHeight="calc(100vh - 20rem)"
      />

      <Frame spacing="sm" className="flex min-h-0 flex-col xl:sticky xl:top-[52px] xl:h-[calc(100vh-104px)]">
        <FramePanel dense className="flex min-h-0 flex-1 flex-col">
          <FrameHeader className="flex-row flex-wrap items-center justify-between gap-2 py-1.5">
            <div className="flex items-center gap-2">
              <FrameTitle className="text-sm">ETF 资金流</FrameTitle>
              <Tabs tabs={SCOPES} value={scope} onChange={(k) => { setScope(k); setSearch(""); touched.current = false; }} />
              <Tabs
                tabs={[{ key: "series", label: "资金分时" }, { key: "4dim", label: "4 维拆解" }]}
                value={view}
                onChange={(k) => setView(k as "series" | "4dim")}
              />
            </div>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span>数据日期 {data?.date ?? "—"}</span>
              {data?.is_today === false && <Badge variant="warning-light">历史</Badge>}
              {health?.trading ? <Badge variant="success-light">交易中</Badge> : <Badge variant="outline">休市</Badge>}
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
            ) : view === "series" ? (
              !chartCodes.length ? (
                <EmptyState title="还没有选中 ETF" hint="在左侧勾选，或点「流入Top10」批量激活" className="flex-1" />
              ) : !series?.axis?.length ? (
                <EmptyState title="暂无分时数据" hint={(series as any)?.error ?? "加载中…"} className="flex-1" />
              ) : (
                <>
                  <div className="min-h-0 flex-1">
                    <BoardFlowChart id="etf-flow-lines" lines={etfLines} hoverCode={hoverCode}
                      height="100%" onHoverCode={setHoverCode} />
                  </div>
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 px-2 pb-1 text-[10px] text-muted-foreground">
                    {etfLines.map((s) => (
                      <span key={s.code} className="inline-flex items-center gap-1">
                        <span className="inline-block size-1.5 rounded-full bg-primary/70" />
                        {s.name}
                        <span className="tnum text-foreground/80">
                          {signedYi(s.points.length ? s.points[s.points.length - 1][1] : null)}
                        </span>
                      </span>
                    ))}
                  </div>
                </>
              )
            ) : !dimCode ? (
              <EmptyState title="还没有选中 ETF" hint="先勾选一只，再看它的 4 维资金结构" className="flex-1" />
            ) : (!dimSeries.length || dimsAllZero) ? (
              (dim4 as any)?.snapshot ? (
                <div className="flex flex-1 flex-col justify-center gap-3 p-4">
                  <div className="text-xs text-muted-foreground">
                    {(dim4 as any)?.error ?? "该日只有主力口径，以下为实时 4 维快照"}
                  </div>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {([["super", "超大单"], ["large", "大单"], ["medium", "中单"], ["small", "小单"]] as const).map(([k, label]) => {
                      const v = (dim4 as any).snapshot[k] ?? 0;
                      return (
                        <div key={k} className="rounded-lg border border-border/60 bg-background/40 px-3 py-2">
                          <div className="text-[11px] text-muted-foreground">{label}</div>
                          <div className={cn("text-sm font-semibold tnum", v >= 0 ? "text-up" : "text-down")}>
                            {signedYi(v)}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <EmptyState title="暂无 4 维数据" hint={dim4?.error ?? "加载中…"} className="flex-1" />
              )
            ) : (
              <>
                <div className="min-h-0 flex-1">
                  <MoneyLinesChart id={`etf-4dim-${dimCode}`} axis={dim4!.axis} series={dimSeries as any}
                    height="100%" maxLines={5} />
                </div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 px-2 pb-1 text-[10px] text-muted-foreground">
                  {dimSeries.map((s: any) => (
                    <span key={s.code} className="inline-flex items-center gap-1">
                      <span className="inline-block size-1.5 rounded-full bg-primary/70" />
                      {s.name}
                      <span className="tnum text-foreground/80">{signedYi(s.values[s.values.length - 1])}</span>
                    </span>
                  ))}
                </div>
              </>
            )}
          </div>
        </FramePanel>
      </Frame>
    </main>
  );
}
