import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Frame, FrameHeader, FramePanel, FrameTitle } from "@/components/reui/frame";
import { Badge } from "@/components/reui/badge";
import { IntradayChart } from "@/components/charts";
import { TopBar } from "@/components/TopBar";
import { BiasBar, CandidateList, EtfList, OptionTQuote, PlanCard, SignalFeed } from "@/components/panels";
import { ContractDetail, KronosPredict, LlmPanel } from "@/components/detail";
import { AlertCenter } from "@/components/AlertCenter";
import { Skeleton } from "@/components/ui/misc";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { api } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { clsUpDown, nf, pct, signedWan } from "@/lib/format";

// 当前加载的前端 bundle 哈希（用于判断浏览器是否加载了最新构建）
const BUNDLE_ID = (() => {
  const s = document.querySelector('script[type="module"]') as HTMLScriptElement | null;
  const m = (s?.src || "").match(/index-([A-Za-z0-9_-]+)\.js/);
  return m ? m[1] : "dev";
})();

export default function App() {
  const [etfCode, setEtfCode] = useState("510300");
  const [month, setMonth] = useState<number | null>(null);
  const [contractSecid, setContractSecid] = useState<string | null>(null);
  const [clock, setClock] = useState(new Date().toLocaleTimeString("zh-CN", { hour12: false }));

  useEffect(() => {
    const t = setInterval(() => setClock(new Date().toLocaleTimeString("zh-CN", { hour12: false })), 1000);
    return () => clearInterval(t);
  }, []);


  const { data: universe } = usePolling(() => api.universe(), 3600_000);
  const { data: health } = usePolling(() => api.health(), 60_000);
  const { data: indices } = usePolling(() => api.indices(), 10_000);
  const { data: external } = usePolling(() => api.external(), 30_000);
  const { data: national } = usePolling(() => api.national(), 30_000);
  const { data: etfQuotes } = usePolling(() => api.etfs(), 10_000);
  const { data: directions } = usePolling(() => api.directions(), 60_000);
  const { data: spark } = usePolling(() => api.etfs_spark(), 120_000, []);

  const { data: ctx, refresh: refreshCtx } = usePolling(() => api.etf(etfCode, 1), 10_000, [etfCode]);
  const { data: chain } = usePolling(() => api.chain(etfCode, month ?? undefined), 15_000, [etfCode, month]);
  const { data: strategy } = usePolling(() => api.strategy(etfCode, 0, 1), 30_000, [etfCode]);
  const { data: revSignals } = usePolling(() => api.reversalSignals(etfCode), 30_000, [etfCode]);

  // 合约：优先链内按 secid 定位，保持实时刷新
  const contract = useMemo(() => {
    if (!chain?.contracts) return null;
    return chain.contracts.find((c: any) => c.secid === contractSecid) ?? null;
  }, [chain, contractSecid]);

  useEffect(() => { setMonth(null); setContractSecid(null); }, [etfCode]);

  // 未选合约时，自动选中该标的的优选（近月）合约，避免详情区空白
  useEffect(() => {
    if (contractSecid || !chain?.ranked) return;
    const top = chain.ranked.call?.[0] ?? chain.ranked.put?.[0];
    if (top?.secid) setContractSecid(top.secid);
  }, [chain, contractSecid]);

  const quotes: Record<string, any> = useMemo(() => {
    const m: Record<string, any> = {};
    (etfQuotes?.items ?? []).forEach((q: any) => (m[q.code] = q));
    return m;
  }, [etfQuotes]);

  const etfs = universe?.etfs ?? [];
  const trendsMap = spark?.items ?? {};

  // 切换标的时 usePolling 会保留上一只的数据，直到新请求返回；用 code 校验避免显示旧数据
  const ctxReady = !!ctx && ctx.etf?.code === etfCode;
  const chainReady = !!chain && chain.etf?.code === etfCode;
  // 主力资金序列 <2 点时不成序列，避免渲染成一根孤立柱子
  const flowSeries = (ctx?.flow?.length ?? 0) >= 2 ? ctx!.flow : [];

  const onPickContract = (c: any) => setContractSecid(c.secid);

  return (
    <div className="min-h-screen bg-background">
      <TopBar
        external={external?.items ?? []}
        national={national}
        health={health}
        clock={clock}
        onRefresh={() => { refreshCtx(); api.monitorCycle().catch(() => {}); }}
      />
      <main className="grid grid-cols-1 gap-3 p-3 lg:grid-cols-[340px_minmax(0,1fr)_360px]">
        {/* 左：标的 */}
        <div className="lg:sticky lg:top-[52px] lg:h-[calc(100vh-3.25rem)]">
          <EtfList etfs={etfs} quotes={quotes} trendsMap={trendsMap} directions={directions?.items ?? {}} indices={indices?.items ?? []} selected={etfCode} onSelect={setEtfCode} />
        </div>

        {/* 中：标的行情 + 合约详情 + T报价 */}
        <div className="flex min-w-0 flex-col gap-3">
          <Frame spacing="sm">
            <FramePanel dense>
              <FrameHeader className="flex-row items-center justify-between">
                <div className="flex items-center gap-2">
                  <FrameTitle className="text-sm">{ctxReady ? (ctx!.etf?.name ?? etfCode) : (etfs.find((e: any) => e.code === etfCode)?.name ?? etfCode)}</FrameTitle>
                  <Badge variant="outline" size="xs">{etfCode}</Badge>
                  {ctxReady && ctx?.quote ? (
                    <>
                      <span className="text-sm font-semibold tnum">{nf(ctx.quote.price, 3)}</span>
                      <span className={`text-xs tnum ${clsUpDown(ctx.quote.pct)}`}>{pct(ctx.quote.pct)}</span>
                    </>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" />加载中…
                    </span>
                  )}
                </div>
              </FrameHeader>
              {ctxReady && (
                <div className="flex flex-wrap items-center gap-2 px-3 pb-1 text-[11px] text-muted-foreground">
                  <MiniKv k="量能" v={`${ctx.volume?.ratio ?? "—"}x`} tone={ctx.volume?.is_surge ? "warn" : undefined} />
                  <MiniKv k="主力5分" v={signedWan(ctx.flow_main_delta5m)} tone={ctx.flow_main_delta5m == null ? undefined : ctx.flow_main_delta5m > 0 ? "up" : "down"} />
                  <MiniKv k="主力累计" v={signedWan(ctx.flow_snapshot?.main)} tone={ctx.flow_snapshot?.main == null ? undefined : ctx.flow_snapshot.main > 0 ? "up" : "down"} />
                  {ctx.flow_day && ctx.flow_day < new Date().toLocaleDateString("en-CA") && (
                    <Badge variant="outline" size="xs" className="text-amber-600 border-amber-300">昨日资金流</Badge>
                  )}
                  <MiniKv k="MACD" v={ctx.macd?.cross === "golden" ? "金叉" : ctx.macd?.cross === "dead" ? "死叉" : "—"} />
                  <MiniKv k="背离3分" v={ctx.macd3?.divergence?.type === "bullish" ? "底背离" : ctx.macd3?.divergence?.type === "bearish" ? "顶背离" : "无"} />
                  <MiniKv k="关联指数" v={`${ctx.track?.quote?.name ?? ""} ${pct(ctx.track?.quote?.pct)}`} />
                </div>
              )}
              <div className="px-1 pb-2">
                <ErrorBoundary label="标的行情图">
                  {!ctxReady ? (
                    <Skeleton className="h-[240px] w-full" />
                  ) : ctx?.trends?.length ? (
                    <IntradayChart id="main-chart" trends={ctx.trends} indexTrends={ctx.track?.trends ?? []} indexFlow={ctx.track?.flow ?? []} indexName={ctx.track?.quote?.name ?? ""} flow={flowSeries} signals={revSignals?.items ?? []} height={230} />
                  ) : (
                    <Skeleton className="h-[240px] w-full" />
                  )}
                </ErrorBoundary>
              </div>
            </FramePanel>
          </Frame>

          <Frame spacing="sm">
            <FramePanel dense>
              {chainReady && !chain.error ? (
                <OptionTQuote
                  chain={chain}
                  month={month ?? chain.front_month}
                  onMonth={setMonth}
                  selectedSecid={contractSecid ?? undefined}
                  onSelect={onPickContract}
                />
              ) : <Skeleton className="m-3 h-[380px]" />}
            </FramePanel>
          </Frame>

          <ContractDetail contract={contract} etfTrends={ctxReady ? (ctx?.trends ?? []) : []}
            flow={ctxReady ? flowSeries : []} etfPrevClose={ctxReady ? (ctx?.quote?.prev_close ?? null) : null} />
        </div>

        {/* 右：决策栏 */}
        <div className="flex flex-col gap-3">
          <AlertCenter />

          <Frame spacing="sm">
            <FramePanel dense>
              <FrameHeader><FrameTitle className="text-xs">日内方向与信号</FrameTitle></FrameHeader>
              <div className="flex flex-col gap-2 px-3 pb-3">
                {strategy ? <BiasBar bias={strategy.bias} /> : <Skeleton className="h-16" />}
                <SignalFeed signals={strategy?.signals ?? []} />
              </div>
            </FramePanel>
          </Frame>

          <Frame spacing="sm">
            <FramePanel dense>
              <FrameHeader className="flex-row items-center justify-between">
                <FrameTitle className="text-xs">Kronos 量化预测</FrameTitle>
                <span className="text-[10px] text-muted-foreground">5分钟级</span>
              </FrameHeader>
              <KronosPredict secid={ctx?.etf?.secid ?? etfs.find((e: any) => e.code === etfCode)?.secid ?? "1.510300"} klt={5} />
            </FramePanel>
          </Frame>

          {strategy && <PlanCard bundle={strategy} />}

          <Frame spacing="sm">
            <FramePanel dense>
              <FrameHeader><FrameTitle className="text-xs">优选合约（按日内性价比）</FrameTitle></FrameHeader>
              <div className="px-3 pb-3">
                {strategy?.candidates?.length ? (
                  <CandidateList candidates={strategy.candidates} selected={contractSecid ?? undefined} onSelect={onPickContract} />
                ) : <div className="py-4 text-center text-xs text-muted-foreground">—</div>}
              </div>
            </FramePanel>
          </Frame>

          <LlmPanel code={etfCode} />
        </div>
      </main>
      <footer className="px-4 py-3 text-center text-[10px] text-muted-foreground">
        数据来源：东方财富 · 期权定价 BS · 预测 Kronos · 决策大模型 — 仅供研究，不构成投资建议
        <span className="ml-2">· 构建 {BUNDLE_ID}</span>
      </footer>
    </div>
  );
}

function MiniKv({ k, v, tone }: { k: string; v: any; tone?: "up" | "down" | "warn" }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-muted/40 px-1.5 py-0.5">
      <span className="text-muted-foreground">{k}</span>
      <span className={tone === "up" ? "text-up" : tone === "down" ? "text-down" : tone === "warn" ? "text-warning" : ""}>{v}</span>
    </span>
  );
}
