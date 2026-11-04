import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Frame, FramePanel, FrameHeader, FrameTitle } from "@/components/reui/frame";
import { Badge } from "@/components/reui/badge";
import { EmptyState, Skeleton, Tabs } from "@/components/ui/misc";
import { MoneyLinesChart } from "@/components/charts";
import { api } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { onGlobalRefresh } from "@/lib/refresh";
import { clsUpDown, pct, signedYi } from "@/lib/format";
import { cn } from "@/lib/utils";

const TYPES = [
  { key: "concept", label: "概念" },
  { key: "industry", label: "行业" },
];
const MAX_LINES = 6;

/** 主力资金多日图（工单 05）：区间累计排行 + 多板块走势对比。 */
export function BoardMultiPage() {
  const [type, setType] = useState("concept");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  // 用户手动改过选择后，轮询刷新不再自动回填默认前 3
  const touched = useRef(false);

  const { data: health } = usePolling(() => api.boardHealth(), 60_000, [], { kind: "ctx", code: "board-health" });
  const interval = health?.trading ? 120_000 : 600_000;

  const { data, refresh, error } = usePolling(
    () => api.boardMulti(start || undefined, end || undefined, type),
    600_000,
    [type, start, end],
    { kind: "bmulti", code: `${type}:${start || "auto"}:${end || "auto"}` },
  );

  useEffect(() => onGlobalRefresh(() => { void refresh(); }), [refresh]);

  const items: any[] = data?.items ?? [];
  const dates: string[] = data?.dates ?? [];

  // 默认选前 3；数据/区间变化后若原选择已不在榜内则回落到前 3
  useEffect(() => {
    if (!items.length || touched.current) return;
    const codes = new Set(items.map((i) => i.code));
    setPicked((prev) => {
      const keep = prev.filter((c) => codes.has(c));
      if (keep.length) return keep;
      return items.slice(0, 3).map((i) => i.code);
    });
  }, [items]);

  const byCode = useMemo(() => {
    const m: Record<string, any> = {};
    items.forEach((i) => (m[i.code] = i));
    return m;
  }, [items]);

  const chartSeries = picked
    .map((c) => byCode[c])
    .filter(Boolean)
    .slice(0, MAX_LINES)
    .map((i) => ({ code: i.code, name: i.name, values: i.values }));

  const toggle = (code: string) => {
    touched.current = true;
    setPicked((prev) => {
      if (prev.includes(code)) return prev.filter((c) => c !== code);
      if (prev.length >= MAX_LINES) return [...prev.slice(1), code];
      return [...prev, code];
    });
  };

  return (
    <main className="grid gap-3 p-3 xl:grid-cols-[minmax(0,560px)_minmax(0,1fr)]">
      <Frame spacing="sm">
        <FramePanel dense>
          <FrameHeader className="flex-row items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <FrameTitle className="text-sm">主力资金多日图</FrameTitle>
              <Tabs tabs={TYPES} value={type} onChange={(k) => { setType(k); setPicked([]); }} />
            </div>
            <div className="flex items-center gap-2">
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

          <div className="flex flex-wrap items-center gap-2 px-3 pb-2 text-[11px] text-muted-foreground">
            <label className="flex items-center gap-1">
              起
              <select
                id="board-multi-start" name="start" aria-label="起始日期"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                className="rounded border border-border bg-card px-1.5 py-0.5 text-[11px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">默认</option>
                {(data?.available_dates ?? []).map((d: string) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-1">
              止
              <select
                id="board-multi-end" name="end" aria-label="结束日期"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                className="rounded border border-border bg-card px-1.5 py-0.5 text-[11px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">默认</option>
                {(data?.available_dates ?? []).map((d: string) => <option key={d} value={d}>{d}</option>)}
              </select>
            </label>
            <span>· {data?.start ?? "—"} ~ {data?.end ?? "—"}（{dates.length} 个交易日）</span>
            <span>· 已选 {picked.length}/{MAX_LINES}</span>
          </div>

          <div className="max-h-[calc(100vh-13rem)] overflow-auto border-t border-border/60">
            {error ? (
              <EmptyState title="接口失败" hint={String(error)} />
            ) : !data ? (
              <div className="flex flex-col gap-1 p-3">
                {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
              </div>
            ) : items.length === 0 ? (
              <EmptyState title="暂无区间数据" hint={data.error ?? "换一个日期区间试试"} />
            ) : (
              <table className="w-full border-collapse text-xs">
                <thead className="sticky top-0 z-10 bg-card/95 backdrop-blur">
                  <tr className="text-left text-[11px] text-muted-foreground">
                    <th className="w-8 px-2 py-1.5 font-normal">选</th>
                    <th className="px-2 py-1.5 font-normal">板块</th>
                    <th className="px-2 py-1.5 text-right font-normal">区间累计</th>
                    <th className="px-2 py-1.5 text-right font-normal">上榜天数</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => {
                    const on = picked.includes(r.code);
                    return (
                      <tr key={r.code} onClick={() => toggle(r.code)}
                        className={cn("cursor-pointer border-t border-border/40 hover:bg-muted/40",
                          on && "bg-muted/20")}>
                        <td className="px-2 py-1">
                          <input type="checkbox" checked={on} readOnly aria-label={`选择${r.name}`} className="size-3 accent-primary" />
                        </td>
                        <td className="px-2 py-1">
                          <span className="font-medium">{r.name}</span>
                          <span className="ml-1.5 text-[10px] text-muted-foreground">{r.code}</span>
                        </td>
                        <td className={cn("px-2 py-1 text-right tnum", (r.total ?? 0) >= 0 ? "text-up" : "text-down")}>
                          {signedYi(r.total)}
                        </td>
                        <td className="px-2 py-1 text-right tnum text-muted-foreground">{r.days}/{dates.length}</td>
                      </tr>
                    );
                  })}
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
              <FrameTitle className="text-sm">
                {picked.length === 1 ? "单板块走势" : "区间资金走势对比"}
              </FrameTitle>
              <span className="truncate text-[10px] text-muted-foreground">
                每个点的值是当日主力净流入（不是累计）
              </span>
            </div>
          </FrameHeader>
          <div className="px-2 pb-2">
            {!data ? (
              <Skeleton className="h-[360px] w-full" />
            ) : !dates.length || !chartSeries.length ? (
              <EmptyState title="还没有选中板块" hint="在左侧勾选最多 6 个板块看走势对比" />
            ) : (
              <>
                <MoneyLinesChart id="board-multi-lines" axis={dates} series={chartSeries as any}
                  height={380} maxLines={MAX_LINES} />
                <div className="flex flex-wrap gap-x-3 gap-y-1 px-1 pt-1 text-[10px] text-muted-foreground">
                  {chartSeries.map((s) => (
                    <span key={s.code} className="inline-flex items-center gap-1">
                      <span className="inline-block size-1.5 rounded-full bg-primary/70" />
                      {s.name}
                      <span className={cn("tnum", (byCode[s.code]?.total ?? 0) >= 0 ? "text-up" : "text-down")}>
                        {signedYi(byCode[s.code]?.total)}
                      </span>
                    </span>
                  ))}
                </div>
                {picked.length === 1 && (
                  <div className="mt-2 flex flex-wrap gap-3 px-1 text-[10px] text-muted-foreground">
                    {dates.map((d, i) => (
                      <span key={d}>
                        {d.slice(5)}{" "}
                        <span className={cn("tnum", clsUpDown(chartSeries[0].values[i]))}>
                          {signedYi(chartSeries[0].values[i])}
                        </span>
                      </span>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        </FramePanel>
      </Frame>
    </main>
  );
}
