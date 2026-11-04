import { useEffect, useState } from "react";
import { Drawer, EmptyState, Skeleton } from "@/components/ui/misc";
import { FlowDetailChart, FlowHistoryChart, MoneyLinesChart } from "@/components/charts";
import { api } from "@/lib/api";
import { clsUpDown, pct as fmtPct, signedYi } from "@/lib/format";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* 详情抽屉（双击板块打开）：六块内容各自降级                          */
/* ------------------------------------------------------------------ */
export function BoardDetailDrawer({
  selected, date, onClose,
}: {
  selected: { code: string; name: string } | null;
  date: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selected) { setData(null); return; }
    let alive = true;
    setLoading(true);
    api.boardDetail(selected.code, date || undefined).then((d) => {
      if (alive) setData(d);
    }).catch(() => {
      if (alive) setData({ error: "详情加载失败" });
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => { alive = false; };
  }, [selected?.code, date]);

  const d = data;
  const errors = d?.errors ?? {};
  const series = d?.series;
  const vs = d?.vs_index;
  const history = d?.history ?? [];
  const stocks = d?.stocks ?? [];
  const heat = d?.report_heat;

  return (
    <Drawer
      open={!!selected}
      onClose={onClose}
      widthClass="w-[50vw] min-w-[420px] max-w-[1000px]"
      title={selected ? `${selected.name} ${selected.code}` : ""}
      subtitle={d && !loading
        ? `${date} · ${d.type === "industry" ? "行业" : d.type === "index" ? "指数" : "概念"} · 主力净流入 ${signedYi(d.flow)}${d.pct != null ? ` · 涨跌幅 ${fmtPct(d.pct)}` : ""}`
        : `${date} · 加载中…`}
    >
      {!d || loading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Section title="当日资金分时" hint={errors.series ?? (series?.axis?.length ? "累计折线 + 每分钟增量柱" : undefined)}>
            {series?.axis?.length ? (
              <FlowDetailChart id={`bd-${d.code}`} axis={series.axis} values={series.values} />
            ) : (
              <EmptyState title="暂无分时数据" hint={errors.series ?? "该板块当日还没有累积到分时点"} />
            )}
          </Section>

          <Section title={`成分股主力净流入（Top ${Math.min(stocks.length, 12)}）`} hint={errors.stocks}>
            {stocks.length ? (
              <table className="w-full border-collapse text-[11px]">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="px-1 py-1 font-normal">股票</th>
                    <th className="px-1 py-1 text-right font-normal">最新价</th>
                    <th className="px-1 py-1 text-right font-normal">涨跌幅</th>
                    <th className="px-1 py-1 text-right font-normal">主力净流入</th>
                  </tr>
                </thead>
                <tbody>
                  {stocks.slice(0, 12).map((s: any) => (
                    <tr key={s.code} className="border-t border-border/40">
                      <td className="px-1 py-0.5">
                        <span className="font-medium">{s.name}</span>
                        <span className="ml-1 text-[10px] text-muted-foreground">{s.code}</span>
                      </td>
                      <td className="px-1 py-0.5 text-right tnum">{s.price ? s.price.toFixed(2) : "—"}</td>
                      <td className={cn("px-1 py-0.5 text-right tnum", clsUpDown(s.pct))}>{s.pct == null ? "—" : fmtPct(s.pct)}</td>
                      <td className={cn("px-1 py-0.5 text-right tnum", (s.flow ?? 0) >= 0 ? "text-up" : "text-down")}>
                        {signedYi(s.flow)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState title="暂无成分股数据" hint={errors.stocks} />
            )}
          </Section>

          <Section title="近 20 个交易日资金流" hint={errors.history ?? `覆盖 ${history.length} 个交易日`}>
            {history.length ? (
              <FlowHistoryChart id={`bh-${d.code}`} dates={history.map((h: any) => h.date)}
                values={history.map((h: any) => h.flow)} />
            ) : (
              <EmptyState title="暂无历史数据" hint="库里还没有该板块的每日快照" />
            )}
          </Section>

          <Section title="与上证指数资金走势对比" hint={errors.vs_index ?? vs?.index_day}>
            {vs?.axis?.length ? (
              <MoneyLinesChart id={`bv-${d.code}`} axis={vs.axis} maxLines={2}
                series={[
                  { code: d.code, name: d.name ?? "板块", values: vs.board },
                  { code: "1.000001", name: "上证指数", values: vs.index },
                ]} height={200} />
            ) : (
              <EmptyState title="暂无可对比数据" hint={errors.vs_index ?? "指数分时暂无数据"} />
            )}
          </Section>

          <Section title={`研报热度（近 ${heat?.days ?? 90} 天）`} hint={errors.report_heat}>
            {heat ? (
              <>
                <div className="mb-1 text-xs text-muted-foreground">
                  合计 <span className="font-semibold text-foreground">{heat.count}</span> 篇（成分股前 3 名聚合）
                </div>
                <div className="flex flex-wrap gap-2 text-[11px]">
                  {(heat.top ?? []).map((t: any) => (
                    <span key={t.code} className="rounded bg-muted/50 px-1.5 py-0.5">
                      {t.name} <span className="tnum text-foreground/80">{t.hits}</span>
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <EmptyState title="暂无研报数据" hint={errors.report_heat} />
            )}
          </Section>
        </div>
      )}
    </Drawer>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border/60 bg-background/40">
      <header className="flex items-baseline justify-between gap-2 border-b border-border/40 px-2.5 py-1.5">
        <h4 className="text-xs font-medium">{title}</h4>
        {hint && <span className="truncate text-[10px] text-muted-foreground">{hint}</span>}
      </header>
      <div className="p-2">{children}</div>
    </section>
  );
}
