import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Star } from "lucide-react";
import { toast } from "sonner";
import { Frame, FramePanel, FrameHeader, FrameTitle } from "@/components/reui/frame";
import { Badge } from "@/components/reui/badge";
import { EmptyState, Skeleton, Tabs } from "@/components/ui/misc";
import { MoneyLinesChart } from "@/components/charts";
import { api } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { onGlobalRefresh } from "@/lib/refresh";
import { clsUpDown, pct, signedYi } from "@/lib/format";
import { cn } from "@/lib/utils";

const SCOPES = [
  { key: "all", label: "全部" },
  { key: "watch", label: "自选" },
];
const LINES = 8;

/** ETF 资金流（工单 06）：排行 + 分时 + 4 维拆解 + 自选。 */
export function EtfFlowPage() {
  const [scope, setScope] = useState("all");
  const [view, setView] = useState("series");
  const [dimCode, setDimCode] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const { data: health } = usePolling(() => api.boardHealth(), 60_000, [], { kind: "ctx", code: "board-health" });
  const interval = health?.trading ? 30_000 : 300_000;

  const { data, refresh, error } = usePolling(
    () => api.etfFlowRank("all"),
    interval,
    [interval],
    { kind: "etfrank", code: "all" },
  );

  useEffect(() => onGlobalRefresh(() => { void refresh(); }), [refresh]);

  const all: any[] = data?.items ?? [];
  const rows = useMemo(() => (scope === "watch" ? all.filter((r) => r.watch) : all), [all, scope]);

  const chartCodes = useMemo(() => rows.slice(0, LINES).map((r) => r.code).join(","), [rows]);
  const { data: series, refresh: refreshSeries } = usePolling(
    () => (chartCodes ? api.etfFlowSeries(chartCodes) : Promise.resolve({ axis: [], series: [] } as any)),
    interval,
    [chartCodes, interval],
    { kind: "etfseries", code: chartCodes || "none" },
  );

  const selected = dimCode ?? rows[0]?.code ?? null;
  const { data: dim4 } = usePolling(
    () => (selected ? api.etfFlow4dim(selected) : Promise.resolve(null)),
    60_000,
    [selected],
    { kind: "emseries", code: selected ?? "none" },
  );

  const toggleWatch = async (r: any) => {
    if (busy) return;
    setBusy(r.code);
    try {
      const res = r.watch ? await api.etfFlowWatchRemove(r.code) : await api.etfFlowWatchAdd(r.code, r.name);
      if (res?.error) throw new Error(res.error);
      await Promise.all([refresh(), refreshSeries()]);
    } catch (e: any) {
      toast("自选操作失败", { description: String(e?.message || e) });
    } finally {
      setBusy(null);
    }
  };

  const dimSeries = useMemo(() => {
    if (!dim4?.axis?.length) return [];
    const labels: Record<string, string> = { main: "主力", super: "超大单", large: "大单", medium: "中单", small: "小单" };
    return Object.entries(dim4.dims ?? {}).map(([k, v]) => ({
      code: k, name: labels[k] ?? k, values: v as (number | null)[],
    }));
  }, [dim4]);

  return (
    <main className="grid gap-3 p-3 xl:grid-cols-[minmax(0,560px)_minmax(0,1fr)]">
      <Frame spacing="sm">
        <FramePanel dense>
          <FrameHeader className="flex-row items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <FrameTitle className="text-sm">ETF资金流</FrameTitle>
              <Tabs tabs={SCOPES} value={scope} onChange={setScope} />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground">数据日期 {data?.date ?? "—"}</span>
              {data?.is_today === false && <Badge variant="warning-light">历史</Badge>}
              {health?.trading ? <Badge variant="success-light">交易中</Badge> : <Badge variant="outline">休市</Badge>}
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

          <div className="max-h-[calc(100vh-11rem)] overflow-auto border-t border-border/60">
            {error ? (
              <EmptyState title="接口失败" hint={String(error)} />
            ) : !data ? (
              <div className="flex flex-col gap-1 p-3">
                {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
              </div>
            ) : rows.length === 0 ? (
              <EmptyState title={scope === "watch" ? "还没有自选 ETF" : "暂无 ETF 数据"}
                hint={scope === "watch" ? "在全部列表里点右侧星标即可加入自选" : (data.error ?? "交易时段每 30 秒采集一次")} />
            ) : (
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur">
                  <tr className="text-left text-[11px] text-muted-foreground">
                    <th className="w-10 px-2 py-1.5 font-normal">#</th>
                    <th className="px-2 py-1.5 font-normal">ETF</th>
                    <th className="px-2 py-1.5 text-right font-normal">主力净流入</th>
                    <th className="px-2 py-1.5 text-right font-normal">涨跌幅</th>
                    <th className="w-10 px-2 py-1.5" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.code}
                      onClick={() => { setDimCode(r.code); setView("4dim"); }}
                      className={cn("cursor-pointer border-t border-border/40 hover:bg-muted/40",
                        selected === r.code && "bg-muted/25")}>
                      <td className="px-2 py-1 tnum text-muted-foreground">{i + 1}</td>
                      <td className="px-2 py-1">
                        <span className="font-medium">{r.name}</span>
                        <span className="ml-1.5 text-[10px] text-muted-foreground">{r.code}</span>
                        {r.type === "broad" && <Badge variant="outline" className="ml-1.5">宽基</Badge>}
                      </td>
                      <td className={cn("px-2 py-1 text-right tnum", (r.flow ?? 0) >= 0 ? "text-up" : "text-down")}>
                        {signedYi(r.flow)}
                      </td>
                      <td className={cn("px-2 py-1 text-right tnum", clsUpDown(r.pct))}>{pct(r.pct)}</td>
                      <td className="px-2 py-1 text-center">
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); void toggleWatch(r); }}
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
            <div className="flex items-center gap-2">
              <FrameTitle className="text-sm">资金分时</FrameTitle>
              <Tabs
                tabs={[{ key: "series", label: "前 8 分时" }, { key: "4dim", label: "4 维拆解" }]}
                value={view}
                onChange={setView}
              />
            </div>
            <span className="truncate text-[10px] text-muted-foreground">
              {view === "4dim"
                ? `${rows.find((r) => r.code === selected)?.name ?? selected ?? "—"} · 累计净流入`
                : `${data?.date ?? ""} · ${series?.points ?? 0} 个分时点`}
            </span>
          </FrameHeader>

          <div className="px-2 pb-2">
            {view === "series" ? (
              !series ? (
                <Skeleton className="h-[340px] w-full" />
              ) : !series.axis?.length ? (
                <EmptyState title="暂无分时数据" hint={series.error ?? "该日还没有累积到分时点"} />
              ) : (
                <>
                  <MoneyLinesChart id="etf-flow-lines" axis={series.axis} series={series.series as any}
                    height={360} maxLines={LINES} />
                  <div className="flex flex-wrap gap-x-3 gap-y-1 px-1 pt-1 text-[10px] text-muted-foreground">
                    {series.series.slice(0, LINES).map((s: any) => (
                      <span key={s.code} className="inline-flex items-center gap-1">
                        <span className="inline-block size-1.5 rounded-full bg-primary/70" />
                        {s.name}
                        <span className="tnum text-foreground/80">{signedYi(s.last)}</span>
                      </span>
                    ))}
                  </div>
                </>
              )
            ) : !selected ? (
              <EmptyState title="选择一只 ETF" hint="点左侧任意一行看它的 4 维资金结构" />
            ) : !dim4 ? (
              <Skeleton className="h-[340px] w-full" />
            ) : !dimSeries.length ? (
              <EmptyState title="暂无 4 维数据" hint={dim4.error ?? "该日还没有累积到分时点"} />
            ) : (
              <>
                <MoneyLinesChart id={`etf-4dim-${selected}`} axis={dim4.axis} series={dimSeries as any}
                  height={360} maxLines={5} />
                <div className="flex flex-wrap gap-x-3 gap-y-1 px-1 pt-1 text-[10px] text-muted-foreground">
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
