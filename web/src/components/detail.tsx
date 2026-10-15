import { useMemo, useState } from "react";
import { Badge } from "@/components/reui/badge";
import { Frame, FrameHeader, FramePanel, FrameTitle } from "@/components/reui/frame";
import { OverlayChart, PredictChart } from "@/components/charts";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { ErrorBoundary } from "@/components/ui/ErrorBoundary";
import { clsUpDown, money, nf, pct } from "@/lib/format";
import { api } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { BrainCircuit, Loader2 } from "lucide-react";

/* ---------------- 合约详情（分时叠加） ---------------- */
export function ContractDetail({
  contract, etfTrends, flow, etfPrevClose = null,
}: {
  contract: any;
  etfTrends: any[];
  flow: any[];
  etfPrevClose?: number | null;
}) {
  const secid = contract?.secid;
  const { data: trends } = usePolling(
    () => (secid ? api.optTrends(secid) : Promise.resolve({ trends: [] })),
    10_000, [secid]);

  // 注意：图表始终保持挂载（不因未选合约而卸载），避免 ECharts 在同一 DOM 节点上
  // 反复 dispose/init 造成崩溃；切合约只更新数据（固定 key）。
  const t = trends?.trends ?? [];
  return (
    <Frame spacing="sm" stacked>
      <FramePanel dense>
        <FrameHeader className="flex-row items-center justify-between">
          {contract ? (
            <>
              <div className="flex items-center gap-2">
                <FrameTitle className="text-sm">{contract.name}</FrameTitle>
                <span className="text-[11px] text-muted-foreground tnum">{contract.code}</span>
                <Badge variant={contract.type === "call" ? "destructive-light" : "success-light"} size="xs">
                  {contract.type === "call" ? "认购" : "认沽"}
                </Badge>
              </div>
              <div className="flex items-center gap-3 text-xs tnum">
                <span className="text-base font-semibold">{nf(contract.last, 4)}</span>
                <span className={clsUpDown(contract.pct)}>{pct(contract.pct)}</span>
                <span className="text-muted-foreground">IV {nf(contract.iv, 1)}%</span>
                <span className="text-muted-foreground">Δ {nf(contract.delta, 3)}</span>
                <span className="text-muted-foreground">溢价 {nf(contract.premium_rate, 2)}%</span>
                <span className="text-muted-foreground">离到期 {contract.days}天</span>
                <span className="text-muted-foreground">额 {money(contract.amount)}</span>
              </div>
            </>
          ) : (
            <FrameTitle className="text-xs text-muted-foreground">在 T 型报价或候选中选择合约查看详情</FrameTitle>
          )}
        </FrameHeader>
      </FramePanel>
      <FramePanel dense>
        <FrameHeader className="flex-row items-center justify-between">
          <FrameTitle className="text-xs">分时叠加（期权价 + 标的ETF + 主力资金）</FrameTitle>
          <span className="text-[10px] text-muted-foreground">右轴 涨跌幅%(期权) · 柱 主力净流入</span>
        </FrameHeader>
        <div className="px-1 pb-2">
          <ErrorBoundary label="分时叠加图">
            <OverlayChart id="overlay" optTrends={t} etfTrends={etfTrends} flow={flow}
              optPrevClose={contract?.prev_close ?? null} etfPrevClose={etfPrevClose} height={300} />
          </ErrorBoundary>
        </div>
      </FramePanel>
    </Frame>
  );
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
        <Badge variant={s?.bias === "up" ? "destructive-light" : s?.bias === "down" ? "success-light" : "secondary"} size="xs">
          预测 {s?.bias === "up" ? "偏多" : s?.bias === "down" ? "偏空" : "震荡"} {s?.pred_pct != null ? pct(s.pred_pct) : ""}
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
  const actionLabel = d?.action === "buy_call" ? "买入认购" : d?.action === "buy_put" ? "买入认沽" : d?.action === "wait" ? "观望" : "—";
  // 全站约定：看多=红、看空=绿（与 BiasBar / 左侧方向标签一致）
  const variant = d?.direction === "call" ? "destructive-light" : d?.direction === "put" ? "success-light" : "secondary";
  return (
    <Frame spacing="sm">
      <FramePanel dense>
        <FrameHeader className="flex-row items-center justify-between">
          <FrameTitle className="flex items-center gap-1.5 text-xs">
            <BrainCircuit className="size-3.5 text-primary" /> 大模型决策
          </FrameTitle>
          <Button size="xs" onClick={run} disabled={loading}>
            {loading ? <Loader2 className="animate-spin" /> : null}
            {loading ? "分析中…" : "生成决策"}
          </Button>
        </FrameHeader>
        <div className="px-3 pb-3">
          {!res && <div className="py-3 text-center text-xs text-muted-foreground">点击「生成决策」调用大模型综合分析并给出买卖点</div>}
          {res?.error && <div className="text-xs text-destructive">{res.error}</div>}
          {d && !d.error && (
            <div className="flex flex-col gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant={variant as any} size="sm">{actionLabel}</Badge>
                <Badge variant="outline" size="sm">置信度 {d.confidence}</Badge>
                {d.contract_name && <Badge variant="info-light" size="sm">{d.contract_name} {d.contract_code}</Badge>}
              </div>
              {(d.entry || d.stop || d.target) && (
                <div className="grid grid-cols-3 gap-2 text-center">
                  <Cell label="入场" value={nf(d.entry, 4)} />
                  <Cell label="止损" value={`${nf(d.stop, 4)} ${d.stop_pct != null ? pct(d.stop_pct, 1) : ""}`} tone="down" />
                  <Cell label="止盈" value={`${nf(d.target, 4)} ${d.target_pct != null ? pct(d.target_pct, 1) : ""}`} tone="up" />
                </div>
              )}
              {d.summary && <p className="rounded-md bg-muted/40 px-2 py-1.5 text-xs leading-snug">{d.summary}</p>}
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
            <span className="text-muted-foreground">•</span>{t}
          </li>
        ))}
      </ul>
    </div>
  );
}
