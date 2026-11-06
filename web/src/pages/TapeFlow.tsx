import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Zap } from "lucide-react";
import { toast } from "sonner";
import { Frame, FramePanel, FrameHeader, FrameTitle } from "@/components/reui/frame";
import { Badge } from "@/components/reui/badge";
import { Tabs } from "@/components/ui/misc";
import { DayTag } from "@/components/DayTag";
import { MoneyLinesChart } from "@/components/charts";
import { api } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { dateWithWeek, flowMoney, signedFlow } from "@/lib/format";
import { cn } from "@/lib/utils";

const PRESETS = [
  { key: "tdx", label: "通达信口径" },
  { key: "wind", label: "Wind 口径" },
];

/** 两套口径的默认门槛（万元），页面输入框可改 */
const DEFAULTS: Record<string, string[]> = {
  tdx: ["200", "50"],
  wind: ["2000", "500", "20"],
};

const NOTES: Record<string, string> = {
  tdx: "口径：全A（沪深，不含北交所）逐笔成交按单笔金额分档、每笔只记主动方一次；"
    + "主力 ≥200 万，跟风 50–200 万，散户 <50 万。各档「买+卖」合计 = 全市场成交额。",
  wind: "口径：同上分档；超大单 ≥2000 万，主力 500–2000 万，大户 20–500 万，散户 <20 万。"
    + "Wind 的「机构」线按账户/席位识别，逐笔数据里拿不到，本图用「超大单」替代，不复刻机构线。",
};

type Bucket = {
  key: string; name: string; thr: number;
  buy?: number; sell?: number; net?: number; share?: number;
};

/**
 * 资金流向：全A 逐笔分档的两张分时图（通达信 / Wind 两套口径）。
 *
 * 数据来自 `data/board_flow.db` 的逐笔直方图（每分钟 × 金额档 × 买卖），
 * 盘中每 10 分钟重算、收盘后 15:05 定稿；门槛改了只是重新求和，不重跑逐笔。
 */
export function TapeFlowPage() {
  const [preset, setPreset] = useState<string>("tdx");
  const [date, setDate] = useState("");
  const [vals, setVals] = useState<string[]>(DEFAULTS.tdx);
  /** 已应用的自定义门槛（空 = 用默认口径） */
  const [applied, setApplied] = useState("");

  useEffect(() => {
    setVals(DEFAULTS[preset] ?? []);
    setApplied("");
  }, [preset]);

  const { data: datesView } = usePolling(
    () => api.tapeFlowDates(120), 600_000, [], { kind: "ctx", code: "tape-dates" });
  const dates: string[] = datesView?.dates ?? [];
  const latest = dates[0] ?? "";

  const { data: health, refresh: refreshHealth } = usePolling(
    () => api.tapeFlowHealth(), 60_000, [], { kind: "ctx", code: "tape-health" });

  const { data, refresh, loading } = usePolling(
    () => api.tapeFlowSeries(preset, date || undefined, applied || undefined),
    60_000, [preset, date, applied]);

  const buckets: Bucket[] = data?.buckets ?? [];
  const series = useMemo(
    () => (data?.series ?? []).map((s: any) => ({ code: s.code, name: s.name, values: s.values })),
    [data]);
  const meta = data?.meta ?? {};
  const updated = meta.updated_at || health?.state?.last_run || "";
  const state = health?.state ?? {};
  const busy = !!state.busy;
  const err = data?.error;

  const dateOptions = useMemo(() => {
    const out = [...dates];
    if (date && !out.includes(date)) out.unshift(date);
    return out;
  }, [dates, date]);

  const apply = () => {
    const clean = vals.map((v) => v.trim()).filter(Boolean);
    if (!clean.length) {
      setApplied("");
      return;
    }
    setApplied(clean.join(","));
    toast.success(`门槛已改为 ${clean.join(" / ")} 万元`);
  };

  const scan = async () => {
    await api.tapeFlowScan();
    toast.success("已在后台重算全A逐笔，约 1~2 分钟后刷新");
    setTimeout(() => { refreshHealth(); refresh(); }, 95_000);
  };

  return (
    <div className="flex h-[calc(100vh-92px)] min-h-0 flex-col px-2 pb-1 pt-2">
      <Frame spacing="sm" className="flex min-h-0 flex-1 flex-col">
        <FramePanel dense className="flex min-h-0 flex-1 flex-col">
          <FrameHeader className="flex-row flex-wrap items-center justify-between gap-2 py-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <FrameTitle className="text-sm">资金流向</FrameTitle>
              <Tabs tabs={PRESETS} value={preset} onChange={setPreset} />
              <DayTag date={data?.date} latest={latest} />
              {busy ? <Badge variant="info-light">重算中…</Badge> : null}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <select
                id="tape-flow-date" name="date" aria-label="选择日期"
                value={data?.date ?? date}
                onChange={(e) => setDate(e.target.value)}
                className="rounded border border-border bg-card px-1.5 py-0.5 text-[11px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {dateOptions.length === 0 ? <option value="">—</option> : null}
                {dateOptions.map((d) => <option key={d} value={d}>{dateWithWeek(d)}</option>)}
              </select>
              <button
                type="button"
                onClick={() => setDate("")}
                title="切到最近交易日"
                className="rounded border border-border px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                今日
              </button>
              <span className="hidden text-muted-foreground tnum sm:inline">{updated}</span>
              <button
                type="button"
                onClick={() => { refreshHealth(); refresh(); }}
                title="刷新（本地库）"
                aria-label="刷新"
                className="rounded-md border border-border p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <RefreshCw className={cn("size-3", loading && "animate-spin")} aria-hidden />
              </button>
              <button
                type="button"
                onClick={scan}
                disabled={busy}
                title="重算全A逐笔（约 1~2 分钟，后台跑）"
                className="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
              >
                <Zap className="size-3" aria-hidden />重算
              </button>
            </div>
          </FrameHeader>

          {/* 门槛输入：改完点「应用」用库里的直方图重算（毫秒级，不重跑逐笔） */}
          <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/60 px-2 py-1 text-[11px]">
            <span className="text-muted-foreground">门槛（万元）</span>
            {vals.map((v, i) => (
              <input
                key={`${preset}-${i}`}
                value={v}
                inputMode="decimal"
                aria-label={`第 ${i + 1} 档门槛（万元）`}
                onChange={(e) => setVals((prev) => prev.map((x, j) => (j === i ? e.target.value : x)))}
                className="w-16 rounded border border-border bg-card px-1.5 py-0.5 text-[11px] tnum focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            ))}
            <button
              type="button"
              onClick={apply}
              className="rounded border border-border px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              应用
            </button>
            <button
              type="button"
              onClick={() => { setVals(DEFAULTS[preset] ?? []); setApplied(""); }}
              className="rounded border border-border px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              恢复默认
            </button>
            {applied ? <span className="text-warning">已用自定义门槛</span> : null}
          </div>

          {/* 各档当日买 / 卖 / 净买额（紧凑一行，把高度留给图） */}
          <div className="grid shrink-0 grid-cols-2 gap-1 px-2 py-1 sm:grid-cols-4">
            {buckets.map((b) => (
              <div key={b.key} className="rounded border border-border px-1.5 py-0.5">
                <div className="flex items-baseline justify-between gap-1">
                  <span className="text-[11px] font-medium text-foreground">{b.name}</span>
                  <span className={cn("text-[12px] font-semibold tnum",
                    (b.net ?? 0) >= 0 ? "text-up" : "text-down")}>
                    {signedFlow(b.net)}
                  </span>
                </div>
                <div className="flex justify-between gap-1 text-[10px] text-muted-foreground tnum">
                  <span>买 {flowMoney(b.buy)}</span>
                  <span>卖 {flowMoney(b.sell)}</span>
                </div>
              </div>
            ))}
            {buckets.length === 0 ? (
              <div className="col-span-full rounded border border-dashed border-border px-2 py-4 text-center text-[11px] text-muted-foreground">
                {err || "还没有数据"}
              </div>
            ) : null}
          </div>

          {/* 分时图：独占剩余高度，随窗口缩放重排 */}
          <div className="min-h-0 flex-1 px-2 pb-1">
            <MoneyLinesChart
              id={`tape-flow-${preset}`}
              axis={data?.axis ?? []}
              series={series}
              height="100%"
              endLabels
            />
          </div>

          <div className="shrink-0 space-y-0.5 px-2 pb-1 pt-0.5 text-[10px] leading-snug text-muted-foreground">
            <div className="truncate" title={NOTES[preset]}>{NOTES[preset]}</div>
            <div className="truncate">
              {meta.stocks_ok ? `覆盖 ${meta.stocks_ok}/${meta.stocks_total} 只 · ` : ""}
              {meta.amount ? `逐笔成交额 ${flowMoney(meta.amount)} · ` : ""}
              {data?.date ? `${data.date} · ` : ""}
              盘中每 10 分钟重算、收盘后 15:05 定稿；逐笔只能取最新一个交易日，历史靠本地库留存。
            </div>
            {err ? <div className="text-warning">{err}</div> : null}
          </div>
        </FramePanel>
      </Frame>
    </div>
  );
}
