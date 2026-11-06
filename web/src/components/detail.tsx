import { useEffect, useState } from "react";
import { Badge } from "@/components/reui/badge";
import { Frame, FrameHeader, FramePanel, FrameTitle } from "@/components/reui/frame";
import { OverlayChart, PredictChart } from "@/components/charts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { AutoTip, GLOSSARY, Tip } from "@/components/ui/term";
import { clsUpDown, flowMoney, money, nf, pct } from "@/lib/format";
import { api } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { BrainCircuit, Loader2 } from "lucide-react";

// 空数组兜底用同一个引用：`?? []` 每次渲染都是新数组，会让分时图 option 失效、notMerge 全量重建
const EMPTY: any[] = [];

/* ---------------- 合约详情（分时叠加） ---------------- */
export function ContractDetail({
  contract, code = "", etfTrends, flow, etfPrevClose = null, underName = "标的ETF",
}: {
  contract: any;
  code?: string;
  etfTrends: any[];
  flow: any[];
  etfPrevClose?: number | null;
  underName?: string;
}) {
  const secid = contract?.secid;
  // 盘中 10s、收盘后 60s：收盘后行情不再变化，高频轮询只是空转。
  const [open, setOpen] = useState(() => isTradingNow());
  useEffect(() => {
    const t = setInterval(() => setOpen(isTradingNow()), 60_000);
    return () => clearInterval(t);
  }, []);
  const { data: trends } = usePolling(
    () => (secid ? api.optTrends(secid) : Promise.resolve({ trends: [] })),
    open ? 15_000 : 120_000, [secid], secid ? { kind: "trends", code: secid } : undefined);
  // 关键位/计划以标的为单位（不随合约切换），滞后同步即可。
  const { data: levels } = usePolling(
    () => (secid && code ? api.optLevels(code, secid) : Promise.resolve(null)),
    60_000, [secid, code], secid ? { kind: "levels", code: secid } : undefined);

  // 注意：图表始终保持挂载（不因未选合约而卸载），避免 ECharts 在同一 DOM 节点上
  // 反复 dispose/init 造成崩溃；切合约只更新数据（固定 key）。
  const t = trends?.trends ?? EMPTY;
  return (
    <Frame spacing="sm" stacked>
      <FramePanel dense>
        <FrameHeader className="flex-row flex-wrap items-center justify-between gap-y-1.5">
          {contract ? (
            <>
              <div className="flex min-w-0 items-center gap-2">
                <FrameTitle className="truncate text-sm">{contract.name}</FrameTitle>
                <span className="shrink-0 text-[11px] text-muted-foreground tnum">{contract.code}</span>
                <Badge variant={contract.type === "call" ? "destructive-light" : "success-light"} className="shrink-0">
                  {contract.type === "call" ? "认购" : "认沽"}
                </Badge>
              </div>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs tnum">
                <span className="text-base font-semibold">{nf(contract.last, 4)}</span>
                <span className={clsUpDown(contract.pct)}>{pct(contract.pct)}</span>
                <span className="text-muted-foreground"><Tip label={`IV ${nf(contract.iv, 1)}%`} tip={GLOSSARY.IV} /></span>
                <span className="text-muted-foreground"><Tip label={`Δ ${nf(contract.delta, 3)}`} tip={GLOSSARY.Delta} /></span>
                <span className="text-muted-foreground"><Tip label={`溢价 ${nf(contract.premium_rate, 2)}%`} tip={GLOSSARY["溢价"]} /></span>
                <span className="text-muted-foreground"><Tip label={`离到期 ${contract.days}天`} tip={GLOSSARY["离到期"]} /></span>
                <span className="text-muted-foreground"><Tip label={`成交额 ${flowMoney(contract.amount)}`} tip={GLOSSARY["成交额"]} /></span>
              </div>
            </>
          ) : (
            <FrameTitle className="text-xs text-muted-foreground">在 T 型报价或候选中选择合约查看详情</FrameTitle>
          )}
        </FrameHeader>
      </FramePanel>
      <FramePanel dense>
        <FrameHeader className="flex-row flex-wrap items-center justify-between gap-y-1">
          <FrameTitle className="text-xs">分时叠加（合约价格 + {underName}价格 + {underName}主力净买额）</FrameTitle>
          <span className="text-xs text-muted-foreground">蓝线 合约价格 · 灰线 {underName}价格 · 紫线 {underName}主力净买额（右轴）</span>
        </FrameHeader>
        <div className="relative px-1 pb-2">
          <ErrorBoundary label="分时叠加图">
            <OverlayChart id="overlay" optTrends={t} etfTrends={etfTrends} flow={flow}
              underName={underName} levels={levels}
              breakEven={contract?.break_even ?? null} optDelta={contract?.delta ?? null}
              optLast={contract?.last ?? null}
              optPrevClose={contract?.prev_close ?? null} etfPrevClose={etfPrevClose} height={300} />
          </ErrorBoundary>
          {contract && t.length === 0 && (
            <div className="pointer-events-none absolute inset-x-0 top-1/3 text-center text-[11px] text-muted-foreground">
              该合约暂无分时数据（本地快照累积中，开盘后自动补齐）
            </div>
          )}
        </div>
      </FramePanel>
    </Frame>
  );
}

/** 是否处于连续竞价时段（含集合竞价）。周末直接判否，避免收盘/休市时白拉数据。 */
function isTradingNow(now = new Date()) {
  try {
    const d = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
    const wd = d.getDay();
    if (wd === 0 || wd === 6) return false;
    const m = d.getHours() * 60 + d.getMinutes();
    return (m >= 570 && m <= 690) || (m >= 780 && m <= 900);
  } catch {
    return true;
  }
}

/* ---------------- Kronos 预测图（内嵌到策略面板） ---------------- */
export function KronosPredict({ secid, klt = 5 }: { secid: string; klt?: number }) {
  const { data } = usePolling(() => api.predict(secid, klt, 120, 20), 60000, [secid, klt]);
  const bars = data?.bars ?? [];
  const pred = data;
  const s = data?.summary;
  if (!pred || pred.error) {
    return <div className="py-6 text-center text-xs text-muted-foreground">{pred?.error ?? "Kronos 预测中…"}</div>;
  }
  return (
    <div>
      <div className="flex items-center gap-2 px-3 pb-1 text-[11px]">
        <Badge variant={s?.bias === "up" ? "destructive-light" : s?.bias === "down" ? "success-light" : "outline"}>
          预测 {s?.bias === "up" ? "看多" : s?.bias === "down" ? "看空" : "观望"} {s?.pred_pct != null ? pct(s.pred_pct) : ""}
        </Badge>
        <span className="text-muted-foreground tnum">未来 {s?.path?.length ?? 0} 根 · 涨占比 {((s?.up_ratio ?? 0) * 100) | 0}% · 上沿 {nf(s?.pred_high, 4)} / 下沿 {nf(s?.pred_low, 4)}</span>
      </div>
      <ErrorBoundary label="Kronos预测图">
        <PredictChart id={secid} bars={bars} pred={pred} height={200} />
      </ErrorBoundary>
    </div>
  );
}

/* ---------------- LLM 决策 ---------------- */
export function LlmPanel({ code }: { code: string }) {
  const [loading, setLoading] = useState(false);
  const [res, setRes] = useState<any>(null);
  const run = async () => {
    setLoading(true);
    try {
      setRes(await api.llm(code, 1));
    } catch (e: any) {
      setRes({ error: String(e) });
    } finally {
      setLoading(false);
    }
  };
  const d = res?.decision;
  // 后端可能把失败写在顶层（bundle 失败）或 decision 内（LLM 调用失败），两种都要显示，
  // 否则用户点了「生成决策」只会看到面板毫无变化。
  const err: string | null = res?.error || d?.error || null;
  // 动作枚举与后端 services/decision.py 的 ACTION_LABELS 同集：多腿价差也算动作
  const actionLabel = ACTION_LABELS[d?.action] ?? "—";
  // 全站约定：看多=红、看空=绿（与 BiasBar / 左侧方向标签一致）
  const variant = d?.direction === "call" ? "destructive-light" : d?.direction === "put" ? "success-light" : "secondary";
  return (
    <Frame spacing="sm">
      <FramePanel dense>
        <FrameHeader className="flex-row items-center justify-between">
          <FrameTitle className="flex items-center gap-1.5 text-xs">
            <BrainCircuit className="size-3.5 text-primary" /> 大模型决策
          </FrameTitle>
          <Button size="sm" onClick={run} disabled={loading}>
            {loading ? <Loader2 className="animate-spin" /> : null}
            {loading ? "分析中…" : "生成决策"}
          </Button>
        </FrameHeader>
        <div className="px-3 pb-3">
          {loading && !d && (
            <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />大模型分析中，通常需要 10–60 秒…
            </div>
          )}
          {!res && !loading && <div className="py-3 text-center text-xs text-muted-foreground">点击「生成决策」调用大模型综合分析并给出买卖点</div>}
          {err && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1.5">
              <div className="text-xs font-medium text-destructive">决策生成失败</div>
              <div className="mt-0.5 text-[11px] leading-snug break-all text-destructive/90">{err}</div>
              {res?.ts && <div className="mt-1 text-[10px] text-muted-foreground">响应时间 {res.ts}</div>}
            </div>
          )}
          {d && !d.error && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant={variant as any}>{actionLabel}</Badge>
                <Badge variant="outline">置信度 {d.confidence}</Badge>
                {d.contracts != null && <Badge variant="outline" title="不得超过设置里的手数上限">{d.contracts} 张</Badge>}
                {d.contract_name && <Badge variant="info-light">{d.contract_name} {d.contract_code}</Badge>}
              </div>
              {d.legs && (d.legs.long?.code || d.legs.short?.code) && (
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-md border border-border/60 px-2 py-1">
                    <div className="text-[10px] text-muted-foreground">多头腿</div>
                    <div className="truncate text-[11px]">{d.legs.long?.name || d.legs.long?.code || "—"}</div>
                  </div>
                  <div className="rounded-md border border-border/60 px-2 py-1">
                    <div className="text-[10px] text-muted-foreground">空头腿</div>
                    <div className="truncate text-[11px]">{d.legs.short?.name || d.legs.short?.code || "—"}</div>
                  </div>
                </div>
              )}
              {(d.entry || d.stop || d.target) && (
                <div className="grid grid-cols-3 gap-2 text-center">
                  <Cell label="入场" value={nf(d.entry, 4)} />
                  <Cell label="止损" value={`${nf(d.stop, 4)} ${d.stop_pct != null ? pct(d.stop_pct, 1) : ""}`} tone="down" />
                  <Cell label="止盈" value={`${nf(d.target, 4)} ${d.target_pct != null ? pct(d.target_pct, 1) : ""}`} tone="up" />
                </div>
              )}
              {d.summary && <p className="rounded-md bg-muted/40 px-2 py-1.5 text-xs leading-snug">{d.summary}</p>}
              {/* 模型输出与规则层冲突时的校正记录（如「规则层观望却给了买单」），
                  不静默篡改：改了什么、为什么改，都摆在这里 */}
              {d.adjustments?.length > 0 && (
                <div className="rounded-md border border-border/60 px-2 py-1.5">
                  <div className="mb-0.5 text-[10px] font-medium text-warning-foreground">已按规则层校正</div>
                  <ul className="flex flex-col gap-0.5">
                    {d.adjustments.map((t: string, i: number) => (
                      <li key={i} className="flex gap-1 text-[11px] leading-snug">
                        <span className="text-muted-foreground">•</span>{t}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <Section title="理由" items={d.reasons} />
              <Section title="风险" items={d.risks} tone="warn" />
              {d.hold_window && <div className="text-[11px] text-muted-foreground">建议持有窗口：{d.hold_window}</div>}
            </div>
          )}
        </div>
      </FramePanel>
    </Frame>
  );
}

const ACTION_LABELS: Record<string, string> = {
  buy_call: "买入认购",
  buy_put: "买入认沽",
  bull_call_spread: "牛市看涨价差",
  bear_put_spread: "熊市看跌价差",
  wait: "观望",
};

function Cell({ label, value, tone }: { label: string; value: string; tone?: "up" | "down" }) {
  return (
    <div className="rounded-md border border-border/60 py-1.5">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className={`text-xs font-semibold tnum ${tone === "up" ? "text-up" : tone === "down" ? "text-down" : ""}`}>{value}</div>
    </div>
  );
}

function Section({ title, items, tone }: { title: string; items?: string[]; tone?: "warn" }) {
  if (!items?.length) return null;
  return (
    <div>
      <div className="mb-0.5 text-[10px] font-medium text-muted-foreground">{title}</div>
      <ul className="flex flex-col gap-0.5">
        {items.map((t, i) => (
          <li key={i} className={`flex gap-1 text-[11px] leading-snug ${tone === "warn" ? "text-warning-foreground" : ""}`}>
            <span className="text-muted-foreground">•</span><AutoTip text={t} />
          </li>
        ))}
      </ul>
    </div>
  );
}
