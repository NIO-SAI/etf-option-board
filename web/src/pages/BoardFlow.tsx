import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Star } from "lucide-react";
import { Frame, FramePanel, FrameHeader, FrameTitle } from "@/components/reui/frame";
import { Badge } from "@/components/reui/badge";
import { EmptyState, Skeleton, Tabs } from "@/components/ui/misc";
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

/** 概念资金分时（工单 02）：先落排行表，分时曲线见工单 03。 */
export function BoardFlowPage() {
  const [type, setType] = useState("concept");
  const [sort, setSort] = useState<SortKey>("flow");
  const [busy, setBusy] = useState<string | null>(null);

  // 采集状态：决定轮询频率（盘中 30s / 非交易 300s）
  const { data: health } = usePolling(() => api.boardHealth(), 60_000, [], { kind: "ctx", code: "board-health" });
  const trading = !!health?.trading;
  const interval = trading ? 30_000 : 300_000;

  // 一次把概念+行业+自选全拿回来，切标签/排序都在本地重排，不再发请求
  const { data, refresh, error } = usePolling(
    () => api.boardRank("all"),
    interval,
    [interval],
    { kind: "brank", code: "all" },
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

  const last = health?.last;
  const toggleWatch = async (r: any) => {
    const key = r.code;
    if (busy) return;
    setBusy(key);
    try {
      if (r.watch) await api.boardWatchRemove(key);
      else await api.boardWatchAdd(key, r.name);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  return (
    <main className="grid gap-3 p-3">
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
            <span>数据日期 {data?.date ?? "—"}</span>
            {data?.is_today === false && <Badge variant="warning-light">历史</Badge>}
            <span>· 共 {rows.length} 个板块</span>
            <span className="flex items-center gap-1">
              · 排序
              {([["flow", "主力净流入"], ["pct", "涨跌幅"], ["name", "名称"]] as [SortKey, string][]).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setSort(k)}
                  className={cn(
                    "rounded px-1.5 py-0.5 transition-colors",
                    sort === k ? "bg-muted text-foreground" : "hover:text-foreground",
                  )}
                >
                  {label}
                </button>
              ))}
            </span>
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
                    <th className="px-2 py-1.5 font-normal">板块</th>
                    <th className="px-2 py-1.5 text-right font-normal">主力净流入</th>
                    <th className="px-2 py-1.5 text-right font-normal">涨跌幅</th>
                    <th className="w-16 px-2 py-1.5 text-right font-normal">名次</th>
                    <th className="w-10 px-2 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((r, i) => (
                    <tr key={r.code} className="border-t border-border/40 hover:bg-muted/40">
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
                          className={cn(
                            "rounded p-0.5 transition-colors hover:text-warning",
                            r.watch ? "text-warning" : "text-muted-foreground/50",
                          )}
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
    </main>
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
