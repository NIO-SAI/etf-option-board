import { useEffect, useMemo, useState } from "react";
import { LineChart, Loader2, RefreshCw, Star } from "lucide-react";
import { toast } from "sonner";
import { Frame, FramePanel, FrameHeader, FrameTitle } from "@/components/reui/frame";
import { Badge } from "@/components/reui/badge";
import { EmptyState, Skeleton, Tabs } from "@/components/ui/misc";
import { MoneyLinesChart } from "@/components/charts";
import { api } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { onGlobalRefresh } from "@/lib/refresh";
import { clsUpDown, hhmmss, pct, signedYi } from "@/lib/format";
import { cn } from "@/lib/utils";

type SortKey = "flow" | "pct" | "name";
const TYPES = [
  { key: "concept", label: "概念" },
  { key: "industry", label: "行业" },
  { key: "watch", label: "自选" },
];
const CHART_LINES = 8;

/** 概念资金分时（工单 02/03）：排行表 + 当日多板块资金曲线 + 历史日期回看。 */
export function BoardFlowPage() {
  const [type, setType] = useState("concept");
  const [sort, setSort] = useState<SortKey>("flow");
  const [date, setDate] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [showChart, setShowChart] = useStoredBool("board.flow-chart", true);

  // 采集状态：决定轮询频率（盘中 30s / 非交易 300s）
  const { data: health } = usePolling(() => api.boardHealth(), 60_000, [], { kind: "ctx", code: "board-health" });
  const trading = !!health?.trading;
  const interval = trading ? 30_000 : 300_000;

  // 可回看的日期（历史回看用，很少变）
  const { data: datesView } = usePolling(() => api.boardDates(60), 600_000, [], { kind: "ctx", code: "board-dates" });
  const dates: string[] = datesView?.dates ?? [];

  // 一次把概念+行业+自选全拿回来，切标签/排序都在本地重排，不再发请求
  const { data, refresh, error } = usePolling(
    () => api.boardRank("all", date || undefined),
    interval,
    [interval, date],
    { kind: "brank", code: `all:${date || "latest"}` },
  );

  // 顶栏刷新按钮 → 本页也刷一次
  useEffect(() => onGlobalRefresh(() => { void refresh(); }), [refresh]);

  const all: any[] = data?.items ?? [];
  const rows = useMemo(() => {
    if (type === "watch") return all.filter((r) => r.watch);
    return all.filter((r) => r.type === type);
  }, [all, type]);

  const sorted = useMemo(() => {
    const list = [...rows];
    if (sort === "pct") list.sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0));
    else if (sort === "name") list.sort((a, b) => String(a.name).localeCompare(String(b.name), "zh"));
    else list.sort((a, b) => (b.flow ?? 0) - (a.flow ?? 0));
    return list;
  }, [rows, sort]);

  // 曲线取当前排序下的前 8（工单 03：点表头换排序，曲线跟着换）
  const chartCodes = useMemo(() => sorted.slice(0, CHART_LINES).map((r) => r.code), [sorted]);
  const codesKey = chartCodes.join(",");

  const { data: series, refresh: refreshSeries } = usePolling(
    () => (codesKey ? api.boardSeries(codesKey, date || undefined, type) : Promise.resolve({ axis: [], series: [] } as any)),
    interval,
    [codesKey, date, interval],
    { kind: "bseries", code: `${type}:${codesKey}`, extra: date || null },
  );

  const last = health?.last;
  const toggleWatch = async (r: any) => {
    if (busy) return;
    setBusy(r.code);
    try {
      const res = r.watch ? await api.boardWatchRemove(r.code) : await api.boardWatchAdd(r.code, r.name);
      if (res?.error) throw new Error(res.error);
      await Promise.all([refresh(), refreshSeries()]);
    } catch (e: any) {
      toast("自选操作失败", { description: String(e?.message || e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="grid gap-3 p-3 xl:grid-cols-[minmax(0,560px)_minmax(0,1fr)]">
      <Frame spacing="sm">
        <FramePanel dense>
          <FrameHeader className="flex-row items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <FrameTitle className="text-sm">概念资金分时</FrameTitle>
              <Tabs tabs={TYPES} value={type} onChange={setType} />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-[11px] text-muted-foreground tnum">
                {last?.last_ts ? `最后采集 ${hhmmss(new Date(last.last_ts.replace(" ", "T")))}` : "尚未采集"}
              </span>
              {trading ? (
                <Badge variant="success-light" title="交易时段：每 30 秒采集一次">交易中</Badge>
              ) : (
                <Badge variant="outline" title="非交易时段不再采集，展示最近一轮数据">休市</Badge>
              )}
              <button
                type="button"
                onClick={() => void refresh()}
                title="立即刷新（读本地库）"
                aria-label="刷新"
                className="rounded-md border border-border p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <RefreshCw className="size-3" aria-hidden />
              </button>
            </div>
          </FrameHeader>

          <div className="flex flex-wrap items-center gap-2 px-3 pb-2 text-[11px] text-muted-foreground">
            <label className="flex items-center gap-1">
              日期
              <select
                id="board-flow-date"
                name="date"
                aria-label="回看日期"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="rounded border border-border bg-card px-1.5 py-0.5 text-[11px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">最新（{data?.date ?? "—"}）</option>
                {dates.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            {data?.is_today === false && <Badge variant="warning-light">历史</Badge>}
            <span>共 {rows.length} 个板块</span>
            <span>· 点表头排序</span>
          </div>

          <div className="max-h-[calc(100vh-13rem)] overflow-auto border-t border-border/60">
            {error ? (
              <EmptyState title="接口失败" hint={String(error)} />
            ) : !data ? (
              <div className="flex flex-col gap-1 p-3">
                {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
              </div>
            ) : sorted.length === 0 ? (
              <EmptyState title={type === "watch" ? "还没有自选板块" : "暂无采集数据"}
                hint={type === "watch"
                  ? "在概念/行业列表里点右侧星标即可加入自选"
                  : (data.error ?? "交易时段每 30 秒采集一次，稍等再看")} />
            ) : (
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur">
                  <tr className="text-left text-[11px] text-muted-foreground">
                    <th className="w-10 px-2 py-1.5 font-normal">#</th>
                    <SortTh label="板块" k="name" sort={sort} onSort={setSort} />
                    <SortTh label="主力净流入" k="flow" sort={sort} onSort={setSort} align="right" />
                    <SortTh label="涨跌幅" k="pct" sort={sort} onSort={setSort} align="right" />
                    <th className="w-16 px-2 py-1.5 text-right font-normal">名次</th>
                    <th className="w-10 px-2 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r, i) => (
                    <tr key={r.code} className={cn("border-t border-border/40 hover:bg-muted/40",
                      chartCodes.includes(r.code) && "bg-muted/20")}>
                      <td className="px-2 py-1 tnum text-muted-foreground">{i + 1}</td>
                      <td className="px-2 py-1">
                        <span className="font-medium">{r.name}</span>
                        <span className="ml-1.5 text-[10px] text-muted-foreground">{r.code}</span>
                      </td>
                      <td className={cn("px-2 py-1 text-right tnum", (r.flow ?? 0) >= 0 ? "text-up" : "text-down")}>
                        {signedYi(r.flow)}
                      </td>
                      <td className={cn("px-2 py-1 text-right tnum", clsUpDown(r.pct))}>{pct(r.pct)}</td>
                      <td className="px-2 py-1 text-right tnum">
                        <RankDelta delta={r.rank_delta} rank={r.rank} />
                      </td>
                      <td className="px-2 py-1 text-center">
                        <button
                          type="button"
                          onClick={() => void toggleWatch(r)}
                          aria-label={r.watch ? "移出自选" : "加入自选"}
                          title={r.watch ? "移出自选" : "加入自选"}
                          className={cn("rounded p-0.5 transition-colors hover:text-warning",
                            r.watch ? "text-warning" : "text-muted-foreground/50")}
                        >
                          {busy === r.code
                            ? <Loader2 className="size-3.5 animate-spin" aria-hidden />
                            : <Star className="size-3.5" fill={r.watch ? "currentColor" : "none"} aria-hidden />}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </FramePanel>
      </Frame>

      <Frame spacing="sm" className="self-start xl:sticky xl:top-[52px]">
        <FramePanel dense>
          <FrameHeader className="flex-row items-center justify-between">
            <div className="flex min-w-0 items-baseline gap-2">
              <FrameTitle className="text-sm">资金分时 · 前 {CHART_LINES}</FrameTitle>
              <span className="truncate text-[10px] text-muted-foreground">
                {data?.date ?? ""} · 累计净流入（{series?.points ?? 0} 个分时点）
              </span>
            </div>
            <button
              type="button"
              onClick={() => setShowChart((v) => !v)}
              aria-pressed={showChart}
              disabled={!series?.axis?.length}
              title={showChart ? "隐藏曲线" : "显示曲线"}
              className={cn("inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-1 text-[11px] transition-colors",
                showChart ? "text-foreground" : "text-muted-foreground",
                !series?.axis?.length && "cursor-not-allowed opacity-50")}
            >
              <LineChart className="size-3" aria-hidden /> 曲线
            </button>
          </FrameHeader>

          <div className="px-2 pb-2">
            {!series ? (
              <Skeleton className="h-[320px] w-full" />
            ) : !series.axis?.length ? (
              <EmptyState title="暂无分时数据" hint={series.error ?? "该板块当日还没有累积到分时点"} />
            ) : showChart ? (
              <>
                <MoneyLinesChart id="board-flow-lines" axis={series.axis} series={series.series}
                  height={340} maxLines={CHART_LINES} />
                <div className="flex flex-wrap gap-x-3 gap-y-1 px-1 pt-1 text-[10px] text-muted-foreground">
                  {series.series.slice(0, CHART_LINES).map((s: any) => (
                    <span key={s.code} className="inline-flex items-center gap-1">
                      <span className={cn("inline-block size-1.5 rounded-full", s.watch ? "bg-warning" : "bg-primary/70")} />
                      {s.name}
                      <span className="tnum text-foreground/80">{signedYi(s.last)}</span>
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <EmptyState title="曲线已隐藏" hint="点右上角「曲线」重新显示" />
            )}
          </div>
        </FramePanel>
      </Frame>
    </main>
  );
}

/** 可点表头：点一次按该列排序，当前列显示箭头。 */
function SortTh({ label, k, sort, onSort, align = "left" }: {
  label: string; k: SortKey; sort: SortKey; onSort: (k: SortKey) => void; align?: "left" | "right";
}) {
  const active = sort === k;
  return (
    <th className={cn("px-2 py-1.5 font-normal", align === "right" ? "text-right" : "text-left")}>
      <button
        type="button"
        onClick={() => onSort(k)}
        aria-pressed={active}
        className={cn("inline-flex items-center gap-0.5 transition-colors hover:text-foreground",
          active ? "text-foreground" : "")}
        title={`按${label}排序`}
      >
        {label}
        <span aria-hidden className={cn("text-[9px]", active ? "opacity-100" : "opacity-0")}>▼</span>
      </button>
    </th>
  );
}

/** 名次变化：正数=上升，负数=下降，新上榜显示「新」。 */
function RankDelta({ delta, rank }: { delta: number | null; rank: number | null }) {
  if (rank == null) return <span className="text-muted-foreground">—</span>;
  if (delta == null) return <span className="text-muted-foreground" title="上一轮不在榜内">新</span>;
  if (delta === 0) return <span className="text-muted-foreground">持平</span>;
  return (
    <span className={delta > 0 ? "text-up" : "text-down"}>
      {delta > 0 ? `↑${delta}` : `↓${-delta}`}
    </span>
  );
}

/** 布尔偏好持久化（曲线显隐跨刷新保留）。 */
function useStoredBool(key: string, initial: boolean) {
  const [on, setOn] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(key);
      return v == null ? initial : v === "1";
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, on ? "1" : "0");
    } catch {
      /* 隐私模式忽略 */
    }
  }, [key, on]);
  return [on, setOn] as const;
}
