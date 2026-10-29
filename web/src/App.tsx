import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Loader2, PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from "lucide-react";
import { Frame, FrameHeader, FramePanel, FrameTitle } from "@/components/reui/frame";
import { Badge } from "@/components/reui/badge";
import { IntradayChart } from "@/components/charts";
import { TopBar } from "@/components/TopBar";
import { BiasBar, BiasBarSkeleton, CandidateList, CandidateSkeleton, EtfList, ExpiryCalendar, OptionTQuote, PlanCard, SignalFeed } from "@/components/panels";
import { ContractDetail, KronosPredict, LlmPanel } from "@/components/detail";
import { AlertCenter } from "@/components/AlertCenter";
import { SettingsDialog } from "@/components/SettingsDialog";
import { EmptyState, Skeleton } from "@/components/ui/misc";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { api } from "@/lib/api";
import { usePolling, type CacheMeta } from "@/lib/usePolling";
import { dayKey } from "@/lib/cache";
import { usePrefetch } from "@/lib/prefetch";
import { clsUpDown, hhmmss, nf, pct, signedWan } from "@/lib/format";

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
  const [leftCollapsed, setLeftCollapsed] = usePersistedFlag("board.left-collapsed");
  const [rightCollapsed, setRightCollapsed] = usePersistedFlag("board.right-collapsed");
  const [settingsOpen, setSettingsOpen] = useState(false);

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
  // 到期日历：一天只变一次，10 分钟轮询足够（换来的是「当月还剩几天」永不陈旧）
  const { data: expiryView } = usePolling(() => api.expiry(), 600_000);

  // 四类数据都走「先渲染本地缓存 → 同时发真实请求」的 SWR，切标的时首帧即有内容。
  const { data: ctx, refresh: refreshCtx, cacheAt: ctxCache } = usePolling(
    () => api.etf(etfCode, 1), 10_000, [etfCode], { kind: "ctx", code: etfCode });
  const { data: chain, cacheAt: chainCache } = usePolling(
    () => api.chain(etfCode, month ?? undefined), 15_000, [etfCode, month],
    { kind: "chain", code: etfCode, extra: month ?? null });
  const { data: strategy, cacheAt: planCache } = usePolling(
    () => api.strategy(etfCode, 0, 1), 30_000, [etfCode], { kind: "plan", code: etfCode });
  const { data: revSignals, cacheAt: sigCache } = usePolling(
    () => api.reversalSignals(etfCode), 30_000, [etfCode], { kind: "sig", code: etfCode });

  // 合约：优先链内按 secid 定位，保持实时刷新
  const contract = useMemo(() => {
    if (!chain?.contracts) return null;
    return chain.contracts.find((c: any) => c.secid === contractSecid) ?? null;
  }, [chain, contractSecid]);

  useEffect(() => { setMonth(null); setContractSecid(null); }, [etfCode]);

  // 缓存里的合约可能已不在最新链里（换了月份/已到期）：链就绪后回退到默认优选合约
  const chainCode = chain?.etf?.code;
  useEffect(() => {
    if (!chainCode || chainCode !== etfCode || !contractSecid) return;
    const exists = (chain?.contracts ?? []).some((c: any) => c.secid === contractSecid);
    if (exists) return;
    const secid = chain?.best?.recommended?.secid
      ?? chain?.ranked?.call?.[0]?.secid ?? chain?.ranked?.put?.[0]?.secid ?? null;
    setContractSecid(secid);
  }, [chainCode, etfCode, chain, contractSecid]);

  // 未选合约时，自动选中该标的的优选（近月）合约，避免详情区空白
  useEffect(() => {
    if (contractSecid || !chain) return;
    // 优先选中「结合趋势」的主推合约，其次回退到旧版排序
    const secid = chain.best?.recommended?.secid
      ?? chain.ranked?.call?.[0]?.secid ?? chain.ranked?.put?.[0]?.secid;
    if (secid) setContractSecid(secid);
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

  // 预取：交易时段 + 可见 + 当前标的四类已就绪后，按左栏顺序串行预热其它标的
  usePrefetch(etfCode, etfs.map((e: any) => e.code), !!(ctxReady && chainReady && strategy && revSignals));

  const onPickContract = (c: any) => setContractSecid(c.secid);

  return (
    <div className="min-h-screen bg-background">
      <TopBar
        external={external?.items ?? []}
        national={national}
        health={health}
        clock={clock}
        onRefresh={() => { refreshCtx(); api.monitorCycle().catch(() => {}); }}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <main
        className="board-grid grid grid-cols-1 gap-3 p-3 transition-[grid-template-columns] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={{ "--board-left": leftCollapsed ? "3rem" : "340px", "--board-right": rightCollapsed ? "3rem" : "360px" } as CSSProperties}
      >
        {/* 左：标的 */}
        <div className="flex min-h-0 flex-col lg:sticky lg:top-[52px] lg:h-[calc(100vh-3.25rem)]">
          {leftCollapsed ? (
            <PanelRail side="left" label="标的" onExpand={() => setLeftCollapsed(false)} />
          ) : (
            <>
              <div className="mb-1 flex h-6 items-center justify-end">
                <button
                  type="button"
                  onClick={() => setLeftCollapsed(true)}
                  aria-label="收起左侧面板"
                  title="收起左侧面板"
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <PanelLeftClose className="size-3.5" />
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <EtfList etfs={etfs} quotes={quotes} trendsMap={trendsMap} directions={directions?.items ?? {}} indices={indices?.items ?? []} selected={etfCode} onSelect={setEtfCode} />
              </div>
            </>
          )}
        </div>

        {/* 中：标的行情 + 合约详情 + T报价 */}
        <div className="flex min-w-0 flex-col gap-3">
          <Frame spacing="sm">
            <FramePanel dense>
              <FrameHeader className="flex-row items-center justify-between">
                <div className="flex items-center gap-2">
                  <FrameTitle className="text-sm">{ctxReady ? (ctx!.etf?.name ?? etfCode) : (etfs.find((e: any) => e.code === etfCode)?.name ?? etfCode)}</FrameTitle>
                  <Badge variant="outline" className="shrink-0">{etfCode}</Badge>
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
                <CacheTag meta={ctxCache} />
              </FrameHeader>
              {ctxReady && (
                <div className="flex flex-wrap items-center gap-2 px-3 pb-1 text-[11px] text-muted-foreground">
                  <MiniKv k="量能" v={`${ctx.volume?.ratio ?? "—"}x`} tone={ctx.volume?.is_surge ? "warn" : undefined} />
                  <MiniKv k="主力5分" v={signedWan(ctx.flow_main_delta5m)} tone={ctx.flow_main_delta5m == null ? undefined : ctx.flow_main_delta5m > 0 ? "up" : "down"} />
                  <MiniKv k="主力累计" v={signedWan(ctx.flow_snapshot?.main)} tone={ctx.flow_snapshot?.main == null ? undefined : ctx.flow_snapshot.main > 0 ? "up" : "down"} />
                  {ctx.flow_day && ctx.flow_day < new Date().toLocaleDateString("en-CA") && (
                    <Badge variant="warning-light" title="当日资金流序列尚未产生，展示的是最近一个有数据的交易日">昨日资金流</Badge>
                  )}
                  <MiniKv k="MACD" v={ctx.macd?.cross === "golden" ? "金叉" : ctx.macd?.cross === "dead" ? "死叉" : "—"} />
                  <MiniKv k="背离15分" v={ctx.macd15?.divergence?.type === "bullish" ? "底背离" : ctx.macd15?.divergence?.type === "bearish" ? "顶背离" : "无"} />
                  <MiniKv k="关联指数" v={`${ctx.track?.quote?.name ?? ""} ${pct(ctx.track?.quote?.pct)}`} />
                </div>
              )}
              <div className="px-1 pb-2">
                <ErrorBoundary label="标的行情图">
                  {!ctxReady ? (
                    <Skeleton className="h-[240px] w-full" />
                  ) : ctx?.trends?.length ? (
                    <IntradayChart id="main-chart" trends={ctx.trends} indexTrends={ctx.track?.trends ?? []} indexFlow={ctx.track?.flow ?? []} indexName={ctx.track?.quote?.name ?? ""} flow={flowSeries} signals={revSignals?.items ?? []} prevClose={ctx.trends_prev_close ?? ctx.quote?.prev_close ?? null} indexPrevClose={ctx.track?.trends_prev_close ?? ctx.track?.quote?.prev_close ?? null} height={230} />
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
                  cacheTag={<CacheTag meta={chainCache} />}
                  month={month ?? chain.front_month}
                  onMonth={setMonth}
                  selectedSecid={contractSecid ?? undefined}
                  onSelect={onPickContract}
                />
              ) : <Skeleton className="m-3 h-[380px]" />}
            </FramePanel>
          </Frame>

          <ContractDetail contract={contract} etfTrends={ctxReady ? (ctx?.trends ?? []) : []}
            flow={ctxReady ? flowSeries : []} etfPrevClose={ctxReady ? (ctx?.trends_prev_close ?? ctx?.quote?.prev_close ?? null) : null} />
        </div>

        {/* 右：决策栏 */}
        <div className="flex min-h-0 flex-col">
          {rightCollapsed ? (
            <PanelRail side="right" label="决策" onExpand={() => setRightCollapsed(false)} />
          ) : (
            <div className="mb-1 flex h-6 items-center justify-start">
              <button
                type="button"
                onClick={() => setRightCollapsed(true)}
                aria-label="收起右侧面板"
                title="收起右侧面板"
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <PanelRightClose className="size-3.5" />
              </button>
            </div>
          )}
          <div className={`flex flex-col gap-3 ${rightCollapsed ? "hidden" : ""}`}>
          <AlertCenter onSelect={setEtfCode} />

          <Frame spacing="sm">
            <FramePanel dense>
              <FrameHeader className="flex-row items-center justify-between">
                <FrameTitle className="text-xs">日内方向与信号</FrameTitle>
                <CacheTag meta={mergeCache(planCache, sigCache)} />
              </FrameHeader>
              <div className="flex flex-col gap-2 px-3 pb-3">
                {strategy ? <BiasBar bias={strategy.bias} /> : <BiasBarSkeleton />}
                <SignalFeed signals={strategy?.signals ?? []} loading={!strategy} />
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

          <PlanCard bundle={strategy} />

          <ExpiryCalendar view={expiryView} />

          <Frame spacing="sm">
            <FramePanel dense>
              <FrameHeader className="flex-row items-center justify-between">
                <FrameTitle className="text-xs">优选合约（按日内性价比）</FrameTitle>
                <CacheTag meta={planCache} />
              </FrameHeader>
              <div className="px-3 pb-3">
                {!strategy ? (
                  <CandidateSkeleton />
                ) : strategy?.candidates?.length ? (
                  <CandidateList candidates={strategy.candidates} selected={contractSecid ?? undefined} onSelect={onPickContract} />
                ) : strategy?.error ? (
                  <EmptyState title="策略数据获取失败" hint="接口未返回，稍后自动重试" />
                ) : (
                  <EmptyState title="暂无优选合约" hint="期权链未返回可用报价或 Delta" />
                )}
              </div>
            </FramePanel>
          </Frame>

          <LlmPanel code={etfCode} />
          </div>
        </div>
      </main>
      <footer className="px-4 py-3 text-center text-[10px] text-muted-foreground">
        数据来源：东方财富 · 期权定价 BS · 预测 Kronos · 决策大模型 — 仅供研究，不构成投资建议
        <span className="ml-2">· 构建 {BUNDLE_ID}</span>
      </footer>
    </div>
  );
}

function usePersistedFlag(key: string) {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, on ? "1" : "0");
    } catch {
      /* 隐私模式等场景忽略：仅丢失持久化，不影响交互 */
    }
  }, [key, on]);
  return [on, setOn] as const;
}

function PanelRail({ side, label, onExpand }: { side: "left" | "right"; label: string; onExpand: () => void }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border/60 bg-card/40 px-2 py-1.5 lg:h-full lg:w-12 lg:flex-col lg:justify-start lg:gap-3 lg:px-0 lg:py-2">
      <button
        type="button"
        onClick={onExpand}
        aria-label={`展开${label}面板`}
        title={`展开${label}面板`}
        className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {side === "left" ? <PanelLeftOpen className="size-4" /> : <PanelRightOpen className="size-4" />}
      </button>
      <span className="text-[10px] text-muted-foreground lg:[writing-mode:vertical-rl]">{label}</span>
    </div>
  );
}

/** 合并两个缓存元信息：取更旧的一条，任一为昨日则按昨日展示。 */
function mergeCache(a: CacheMeta | null, b: CacheMeta | null): CacheMeta | null {
  if (!a) return b;
  if (!b) return a;
  if (a.day !== b.day) return a.day < b.day ? a : b;
  return a.ts <= b.ts ? a : b;
}

/** 数据新鲜度角标：每次刷新后都显式标注——缓存 = 红色，实时 = 绿色。 */
function CacheTag({ meta }: { meta: CacheMeta | null }) {
  if (!meta) {
    return (
      <Badge variant="success-light" className="shrink-0" title="当前展示的是本轮刷新取回的实时数据">
        实时
      </Badge>
    );
  }
  const stale = meta.day !== dayKey();
  return (
    <Badge
      variant="destructive-light"
      className="shrink-0"
      title={stale ? "展示的是上一交易日缓存的数据，正在获取最新数据" : "本地缓存数据，正在获取最新数据"}
    >
      {stale ? "缓存·昨日" : "缓存"} {hhmmss(new Date(meta.ts))}
    </Badge>
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
