import { useEffect, useMemo, useState } from "react";
import { RefreshCw, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { Frame, FramePanel, FrameHeader, FrameTitle } from "@/components/reui/frame";
import { Badge } from "@/components/reui/badge";
import { Dialog, EmptyState, Skeleton, Tabs } from "@/components/ui/misc";
import { FlowListPanel, type SortKey } from "@/components/FlowListPanel";
import { DayTag } from "@/components/DayTag";
import { MoneyLinesChart } from "@/components/charts";
import { api } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { onGlobalRefresh } from "@/lib/refresh";
import { readHashParams, writeHashParams } from "@/lib/urlState";
import { signedFlow } from "@/lib/format";
import { cn } from "@/lib/utils";

const TARGETS = [
  { key: "concept", label: "概念" },
  { key: "index", label: "指数" },
  { key: "industry", label: "行业" },
];
const DIM_LABEL: Record<string, string> = {
  inst: "机构（超大单）", large: "大单", medium: "中户", retail: "散户",
};
/** 4 维各自的单笔金额口径（东财按单子大小拆分后的主动净买额） */
const DIM_HINT: Record<string, string> = {
  inst: "单笔 ≥ 100 万", large: "单笔 20 ~ 100 万",
  medium: "单笔 4 ~ 20 万", retail: "单笔 < 4 万",
};

type Row = { code: string; name: string; flow: number | null; pct: number | null };

/**
 * 四维资金（原「指数资金分时」）：概念 / 指数 / 行业的 4 维主动净买额曲线。
 * 列表与顶部按钮结构对齐「主力资金分时」：左列表搜索/排序（单选、无勾选框），
 * 右侧图为该目标的机构 / 大单 / 中户 / 散户。
 */
export function EmFlowPage() {
  const initial = useMemo(() => readHashParams(), []);
  const [kind, setKind] = useState(
    initial.kind === "industry" ? "industry" : initial.kind === "concept" ? "concept" : "index");
  const [code, setCode] = useState(initial.code ?? "");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("flow");
  const [sortDir, setSortDir] = useState(-1);
  const [mode, setMode] = useState<"line" | "stack">("line");
  const [cfgOpen, setCfgOpen] = useState(false);

  const { data: health } = usePolling(() => api.boardHealth(), 60_000, [], { kind: "ctx", code: "board-health" });
  const interval = 30_000;

  const { data: targets } = usePolling(() => api.emFlowTargets(), 60_000, [], { kind: "ctx", code: "em-targets" });
  const { data: industries, refresh: refreshIndustries } = usePolling(
    () => api.emFlowIndustries(), 300_000, [], { kind: "ctx", code: "em-industries" });
  const { data: concepts } = usePolling(
    () => api.emFlowConcepts(), 300_000, [], { kind: "ctx", code: "em-concepts" });

  const options: Row[] = useMemo(() => {
    if (kind === "index") {
      return (targets?.indices ?? []).map((i: any) => ({
        code: i.code, name: i.name, flow: i.flow ?? null, pct: i.pct ?? null,
      }));
    }
    const src = kind === "concept" ? concepts?.display : industries?.display;
    return (src ?? []).map((i: any) => ({
      code: i.code, name: i.name, flow: i.flow ?? null, pct: i.pct ?? null,
    }));
  }, [kind, targets, industries, concepts]);

  // 目标缺省：指数取第一个、行业取展示列表第一个；当前选中不在本口径列表里也回落
  const effectiveCode = useMemo(() => {
    if (code && options.some((o) => o.code === code)) return code;
    return options[0]?.code ?? "";
  }, [code, options]);

  const rows = useMemo(() => {
    const kw = search.trim();
    let list = options;
    if (kw) list = list.filter((o) => o.name.includes(kw) || o.code.toLowerCase().includes(kw.toLowerCase()));
    return [...list].sort((a, b) => {
      const va = (sortKey === "pct" ? a.pct : a.flow) ?? 0;
      const vb = (sortKey === "pct" ? b.pct : b.flow) ?? 0;
      return (va - vb) * sortDir;
    });
  }, [options, search, sortKey, sortDir]);

  const selected = useMemo(
    () => (effectiveCode ? { [effectiveCode]: true } : {}),
    [effectiveCode],
  );

  const { data: series, refresh, error } = usePolling(
    () => (effectiveCode ? api.emFlowSeries(kind, effectiveCode) : Promise.resolve(null)),
    interval,
    [kind, effectiveCode, interval],
    { kind: "emseries", code: `${kind}:${effectiveCode}` },
  );

  useEffect(() => onGlobalRefresh(() => { void refresh(); }), [refresh]);

  useEffect(() => {
    writeHashParams({ kind, code: effectiveCode || undefined });
  }, [kind, effectiveCode]);

  const dimSeries = useMemo(() => {
    if (!series?.axis?.length) return [];
    return Object.entries(series.dims ?? {}).map(([k, v]) => ({
      code: k, name: DIM_LABEL[k] ?? k, values: v as (number | null)[],
    }));
  }, [series]);

  /** 4 维当前「主动净买额」：取分时最后一个有效点 */
  const dimCards = useMemo(() => {
    const lastOf = (key: string) => {
      const arr = (series?.dims as any)?.[key] as (number | null)[] | undefined;
      const vals = (arr ?? []).filter((v) => v != null);
      return vals.length ? (vals[vals.length - 1] as number) : null;
    };
    const colors: Record<string, string> = {
      inst: "#ef4444", large: "#f59e0b", medium: "#8b5cf6", retail: "#22c55e",
    };
    return Object.keys(DIM_LABEL).map((key) => ({
      key, label: DIM_LABEL[key], hint: DIM_HINT[key] ?? "",
      value: lastOf(key), color: colors[key] ?? "#a1a1aa",
    }));
  }, [series]);

  const nameOf = useMemo(
    () => options.find((o) => o.code === effectiveCode)?.name ?? effectiveCode,
    [options, effectiveCode],
  );

  const latestDay = health?.last?.date ?? "";

  return (
    <main className="grid gap-3 p-3 xl:grid-cols-[320px_minmax(0,1fr)]">
      <FlowListPanel
        title="标的列表"
        countText={`共 ${rows.length} 个 · 单击切换`}
        rows={rows.map((r) => ({
          code: r.code, name: r.name, flow: r.flow ?? 0, pct: r.pct,
          type: r.code.startsWith("BK") ? "industry" : "index",
        }))}
        selected={selected}
        onToggle={(c) => setCode(c)}
        search={search}
        onSearch={setSearch}
        sortKey={sortKey}
        sortDir={sortDir}
        onSort={(k) => {
          if (k === sortKey) setSortDir((d) => -d);
          else { setSortKey(k); setSortDir(-1); }
        }}
        sortOptions={[{ key: "flow", label: "资金" }, { key: "pct", label: "涨幅" }]}
        showCheckbox={false}
        loading={kind === "index" ? !targets : kind === "concept" ? !concepts : !industries}
        emptyTitle={kind === "index" ? "暂无指数数据" : kind === "concept" ? "暂无概念数据" : "暂无行业数据"}
        emptyHint={kind === "index" ? undefined : "稍后重试或检查采集状态"}
        maxHeight="calc(100vh - 15rem)"
      />

      <Frame spacing="sm" className="flex min-h-0 flex-col xl:sticky xl:top-[52px] xl:h-[calc(100vh-104px)]">
        <FramePanel dense className="flex min-h-0 flex-1 flex-col">
          <FrameHeader className="flex-row flex-wrap items-center justify-between gap-2 py-1.5">
            <div className="flex min-w-0 items-center gap-2">
              <FrameTitle className="text-sm">{nameOf || "四维资金"}</FrameTitle>
              <Tabs tabs={TARGETS} value={kind} onChange={(k) => { setKind(k); setCode(""); setSearch(""); }} />
              <DayTag date={series?.date} latest={latestDay} />
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <Tabs
                tabs={[{ key: "line", label: "分线" }, { key: "stack", label: "堆叠" }]}
                value={mode}
                onChange={(k) => setMode(k as "line" | "stack")}
              />
              <span className="tnum text-muted-foreground">{series?.date ?? "—"}</span>
              <button
                type="button"
                onClick={() => setCfgOpen(true)}
                disabled={kind !== "industry"}
                className={cn("inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 transition-colors",
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
              {health?.trading ? <Badge variant="success-light">交易中</Badge> : <Badge variant="outline">休市</Badge>}
            </div>
          </FrameHeader>

          <div className="flex min-h-0 flex-1 flex-col px-2 pb-2">
            {error ? (
              <EmptyState title="接口失败" hint={String(error)} className="flex-1" />
            ) : !effectiveCode ? (
              <EmptyState title="没有可用的标的" hint="行业列表为空，稍后重试或检查采集状态" className="flex-1" />
            ) : !series ? (
              <Skeleton className="m-1 h-[380px]" />
            ) : (
              <>
                {!!dimSeries.length && (
                  <div className="grid grid-cols-2 gap-1.5 px-0.5 pb-2 sm:grid-cols-4">
                    {dimCards.map((c) => (
                      <div
                        key={c.key}
                        className="rounded-lg border border-border/60 bg-background/50 px-2 py-1.5"
                        style={{ borderLeft: `3px solid ${c.color}` }}
                      >
                        <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                          <span className="inline-block size-1.5 rounded-full" style={{ background: c.color }} />
                          {c.label}主动净买额
                        </div>
                        <div className={cn("mt-0.5 text-sm font-semibold tnum",
                          (c.value ?? 0) >= 0 ? "text-up" : "text-down")}>
                          {c.value == null ? "—" : signedFlow(c.value)}
                        </div>
                        <div className="text-[10px] text-muted-foreground">{c.hint}</div>
                      </div>
                    ))}
                  </div>
                )}
                {!dimSeries.length ? (
                  <EmptyState title="暂无 4 维数据" hint={series.error ?? "该标的当日还没有累积到分时点"} className="flex-1" />
                ) : (
                  <div className="min-h-0 flex-1">
                    <MoneyLinesChart id={`em-${kind}-${effectiveCode}`} axis={series.axis}
                      series={dimSeries as any} height="100%" maxLines={5} mode={mode} />
                  </div>
                )}
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2 px-1 text-[10px] text-muted-foreground">
                  <span>纵轴为当日累计主动净买额（亿元）· 机构 / 大单 / 中户 / 散户 按单笔金额划分</span>
                  <span>指数每 30 秒采集，行业 / 概念每 60 秒 · 行业、概念默认各取 |主力净流入| 前 {industries?.default_limit ?? 40} 个</span>
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
    <Dialog open={open} onClose={onClose} title="行业展示配置（4 维主动净买额）">
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
