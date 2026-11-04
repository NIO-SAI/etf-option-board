import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Frame, FramePanel, FrameHeader, FrameTitle } from "@/components/reui/frame";
import { Badge } from "@/components/reui/badge";
import { Dialog, EmptyState, Skeleton, Tabs } from "@/components/ui/misc";
import { MoneyLinesChart } from "@/components/charts";
import { api } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { onGlobalRefresh } from "@/lib/refresh";
import { signedYi } from "@/lib/format";
import { cn } from "@/lib/utils";

const TARGETS = [
  { key: "index", label: "指数" },
  { key: "industry", label: "行业" },
  { key: "market", label: "全A" },
];
const DIM_LABEL: Record<string, string> = {
  inst: "机构（超大单）", large: "大单", medium: "中户", retail: "散户",
};

/** 东财资金分时（工单 07）：指数 / 行业 / 全 A 的 4 维资金曲线。 */
export function EmFlowPage() {
  const [kind, setKind] = useState("index");
  const [code, setCode] = useState("");
  const [mode, setMode] = useState<"line" | "stack">("line");
  const [cfgOpen, setCfgOpen] = useState(false);

  const { data: health } = usePolling(() => api.boardHealth(), 60_000, [], { kind: "ctx", code: "board-health" });
  const interval = kind === "industry" ? 60_000 : 30_000;

  const { data: targets } = usePolling(() => api.emFlowTargets(), 3600_000, [], { kind: "ctx", code: "em-targets" });
  const { data: industries, refresh: refreshIndustries } = usePolling(
    () => api.emFlowIndustries(), 300_000, [], { kind: "ctx", code: "em-industries" });

  // 目标缺省：指数取第一个、行业取展示列表第一个、全A 固定
  const effectiveCode = useMemo(() => {
    if (code) return code;
    if (kind === "market") return targets?.market?.code ?? "";
    if (kind === "index") return targets?.indices?.[0]?.code ?? "";
    return industries?.display?.[0]?.code ?? "";
  }, [code, kind, targets, industries]);

  const { data: series, refresh, error } = usePolling(
    () => (effectiveCode ? api.emFlowSeries(kind, effectiveCode) : Promise.resolve(null)),
    interval,
    [kind, effectiveCode, interval],
    { kind: "emseries", code: `${kind}:${effectiveCode}` },
  );

  useEffect(() => onGlobalRefresh(() => { void refresh(); }), [refresh]);

  const dimSeries = useMemo(() => {
    if (!series?.axis?.length) return [];
    return Object.entries(series.dims ?? {}).map(([k, v]) => ({
      code: k, name: DIM_LABEL[k] ?? k, values: v as (number | null)[],
    }));
  }, [series]);

  const nameOf = useMemo(() => {
    if (kind === "market") return targets?.market?.name ?? "东方财富全A";
    if (kind === "index") return targets?.indices?.find((i: any) => i.code === effectiveCode)?.name ?? effectiveCode;
    return industries?.display?.find((i: any) => i.code === effectiveCode)?.name ?? effectiveCode;
  }, [kind, effectiveCode, targets, industries]);

  const options: { code: string; name: string }[] =
    kind === "market" ? (targets?.market ? [targets.market] : [])
      : kind === "index" ? (targets?.indices ?? [])
        : (industries?.display ?? []);

  return (
    <main className="grid gap-3 p-3 xl:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
      <Frame spacing="sm" className="self-start">
        <FramePanel dense>
          <FrameHeader className="flex-row items-center justify-between">
            <FrameTitle className="text-sm">东财资金分时</FrameTitle>
            {health?.trading ? <Badge variant="success-light">交易中</Badge> : <Badge variant="outline">休市</Badge>}
          </FrameHeader>
          <div className="flex flex-col gap-2 px-3 pb-3 text-[11px] text-muted-foreground">
            <Tabs tabs={TARGETS} value={kind} onChange={(k) => { setKind(k); setCode(""); }} />
            <label className="flex items-center gap-1">
              标的
              <select
                id="em-flow-code" name="code" aria-label="4 维资金标的"
                value={effectiveCode}
                onChange={(e) => setCode(e.target.value)}
                className="min-w-0 flex-1 rounded border border-border bg-card px-1.5 py-0.5 text-[11px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {options.map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}
              </select>
            </label>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setCfgOpen(true)}
                disabled={kind !== "industry"}
                className={cn("inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-1 transition-colors",
                  kind === "industry" ? "text-foreground hover:bg-muted" : "cursor-not-allowed opacity-50")}
                title="行业展示配置（自定义 Top40）"
              >
                <Settings2 className="size-3" aria-hidden /> 行业配置
              </button>
              <button
                type="button"
                onClick={() => void refresh()}
                title="立即刷新"
                aria-label="刷新"
                className="rounded-md border border-border p-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                <RefreshCw className="size-3" aria-hidden />
              </button>
              <span className="tnum">{series?.date ?? ""}</span>
            </div>
            <p className="leading-relaxed">
              横轴为连续竞价时段，纵轴为当日累计净流入。指数/全 A 每 30 秒采集，行业每 60 秒采集；
              行业默认取 |主力净流入| 前 {industries?.default_limit ?? 40} 个。
            </p>
          </div>
        </FramePanel>
      </Frame>

      <Frame spacing="sm">
        <FramePanel dense>
          <FrameHeader className="flex-row items-center justify-between">
            <div className="flex min-w-0 items-baseline gap-2">
              <FrameTitle className="text-sm">{nameOf}</FrameTitle>
              <span className="truncate text-[10px] text-muted-foreground">4 维资金（机构 / 大单 / 中户 / 散户）</span>
            </div>
            <Tabs
              tabs={[{ key: "line", label: "分线" }, { key: "stack", label: "堆叠" }]}
              value={mode}
              onChange={(k) => setMode(k as "line" | "stack")}
            />
          </FrameHeader>
          <div className="px-2 pb-2">
            {error ? (
              <EmptyState title="接口失败" hint={String(error)} />
            ) : !series ? (
              <Skeleton className="h-[380px] w-full" />
            ) : !dimSeries.length ? (
              <EmptyState title="暂无 4 维数据" hint={series.error ?? "该标的当日还没有累积到分时点"} />
            ) : (
              <>
                <MoneyLinesChart id={`em-${kind}-${effectiveCode}`} axis={series.axis}
                  series={dimSeries as any} height={420} maxLines={5} mode={mode} />
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

      <EmIndustryConfig
        open={cfgOpen}
        onClose={() => setCfgOpen(false)}
        data={industries}
        onChanged={() => void refreshIndustries()}
      />
    </main>
  );
}

/** 行业展示配置：新增 / 移除 / 重置为默认 Top40。 */
function EmIndustryConfig({
  open, onClose, data, onChanged,
}: {
  open: boolean;
  onClose: () => void;
  data: any;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const display: { code: string; name: string }[] = data?.display ?? [];
  const all: { code: string; name: string }[] = data?.all ?? [];
  const [pick, setPick] = useState("");

  const add = async () => {
    const item = all.find((a) => a.code === pick);
    if (!item || busy) return;
    setBusy(true);
    try {
      const res = await api.emFlowConfigAdd(item.code, item.name);
      if (res?.error) throw new Error(res.error);
      setPick("");
      onChanged();
    } catch (e: any) {
      toast("添加失败", { description: String(e?.message || e) });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (code: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.emFlowConfigRemove(code);
      if (res?.error) throw new Error(res.error);
      onChanged();
    } catch (e: any) {
      toast("移除失败", { description: String(e?.message || e) });
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.emFlowConfigReset();
      if (res?.error) throw new Error(res.error);
      onChanged();
      toast("已重置为默认 Top40");
    } catch (e: any) {
      toast("重置失败", { description: String(e?.message || e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="行业展示配置（4 维资金）">
      <div className="flex flex-col gap-3 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <select
            id="em-config-add" name="add-industry"
            value={pick}
            onChange={(e) => setPick(e.target.value)}
            aria-label="选择要添加的行业"
            className="min-w-0 flex-1 rounded border border-border bg-card px-2 py-1 text-[11px]"
          >
            <option value="">选择行业（按 |主力净流入| 排序前 200）</option>
            {all.map((a) => <option key={a.code} value={a.code}>{a.name} {a.code}</option>)}
          </select>
          <button type="button" onClick={() => void add()} disabled={!pick || busy}
            className="rounded-md border border-border px-2 py-1 text-[11px] disabled:opacity-50">添加</button>
          <button type="button" onClick={() => void reset()} disabled={busy}
            className="rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50">
            重置默认
          </button>
        </div>
        <div className="text-[11px] text-muted-foreground">
          当前 {display.length} 个（{data?.customized ? "自定义" : `默认 Top${data?.default_limit ?? 40}`}）
        </div>
        <div className="flex flex-wrap gap-1.5">
          {display.map((d) => (
            <span key={d.code} className="inline-flex items-center gap-1 rounded bg-muted/50 px-1.5 py-0.5 text-[11px]">
              {d.name}
              <button type="button" onClick={() => void remove(d.code)} disabled={busy}
                aria-label={`移除${d.name}`} title="移除" className="text-muted-foreground hover:text-destructive">✕</button>
            </span>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
