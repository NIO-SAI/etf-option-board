import { Badge } from "@/components/reui/badge";
import { Frame, FrameHeader, FramePanel, FrameTitle } from "@/components/reui/frame";
import { Sparkline } from "@/components/charts";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { Tabs } from "@/components/ui/misc";
import { clsUpDown, money, nf, pct, signedMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ArrowDownRight, ArrowUpRight, Flame, Minus } from "lucide-react";

/* ---------------- 标的列表 ---------------- */
// 方向标签：A 股约定 —— 看多红、看空绿、观望灰（与 bias.direction 对应）
const DIR_MAP: Record<string, { v: any; t: string }> = {
  call: { v: "destructive-light", t: "看多" },
  put: { v: "success-light", t: "看空" },
  neutral: { v: "secondary", t: "观望" },
};

export function EtfList({
  etfs, quotes, trendsMap, directions = {}, indices = [], selected, onSelect,
}: {
  etfs: any[];
  quotes: Record<string, any>;
  trendsMap: Record<string, number[]>;
  directions?: Record<string, { direction: string; score: number; confidence: number }>;
  indices?: any[];
  selected: string;
  onSelect: (c: string) => void;
}) {
  // 大盘指数（只读补充信息，非期权标的；固定清单保证始终显示）
  const BIG_INDEXES = [
    { code: "000001", name: "上证指数" },
    { code: "000985", name: "中证全指" },
    { code: "800000", name: "东财全A" },
    { code: "800005", name: "平均股价" },
  ];
  const indexRows = BIG_INDEXES.map((b) => ({ ...b, quote: indices.find((i) => i.code === b.code) }));
  return (
    <Frame spacing="sm" className="h-full">
      <FramePanel dense className="flex h-full flex-col">
        <FrameHeader>
          <FrameTitle className="text-xs">期权标的 · 大盘指数</FrameTitle>
        </FrameHeader>
        <div className="flex-1 divide-y divide-border/60 overflow-auto">
          <div className="px-3 py-1.5 text-[10px] font-medium text-muted-foreground">期权标的（{etfs.length}）</div>
          {etfs.map((e) => {
            const q = quotes[e.code];
            const on = e.code === selected;
            const dm = DIR_MAP[directions[e.code]?.direction] ?? null;
            return (
              <button
                key={e.code}
                onClick={() => onSelect(e.code)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors",
                  on ? "bg-primary/10" : "hover:bg-muted/50",
                )}
              >
                {/* 主信息：全名 + 方向标签 / 代码·指数 */}
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex items-center gap-1.5">
                    <span className={cn("truncate text-xs font-medium", on && "text-primary")}>{e.name}</span>
                    {dm && <Badge variant={dm.v} size="xs" className="shrink-0">{dm.t}</Badge>}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground tnum">{e.code} · {e.track}</div>
                </div>
                <Sparkline data={trendsMap[e.code] ?? []} up={(q?.pct ?? 0) >= 0} width={40} height={26} />
                <div className="w-14 shrink-0 text-right">
                  <div className="text-xs font-semibold tnum">{q ? nf(q.price, 3) : "—"}</div>
                  <div className={cn("text-[11px] tnum", clsUpDown(q?.pct))}>{q ? pct(q.pct) : "—"}</div>
                </div>
              </button>
            );
          })}
        </div>

        {/* 大盘指数：面板固定底栏（ETF 列表滚动、本区常驻可见），固定清单保证 4 行必渲染 */}
        <div className="shrink-0 border-t border-border/60 bg-card">
          <div className="px-3 py-1.5 text-[10px] font-medium text-muted-foreground">大盘指数（{indexRows.length}）</div>
          <div className="divide-y divide-border/60">
            {indexRows.map((ix) => {
              const q = ix.quote;
              return (
                <div key={ix.code} className="flex w-full items-center gap-2.5 px-3 py-2.5">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-medium">{ix.name}</span>
                      <Badge variant="outline" size="xs" className="shrink-0">指数</Badge>
                    </div>
                    <div className="truncate text-[10px] text-muted-foreground tnum">{ix.code}</div>
                  </div>
                  <Sparkline data={trendsMap[ix.code] ?? []} up={(q?.pct ?? 0) >= 0} width={40} height={26} />
                  <div className="w-14 shrink-0 text-right">
                    <div className="text-xs font-semibold tnum">{q ? nf(q.price, 2) : "—"}</div>
                    <div className={cn("text-[11px] tnum", clsUpDown(q?.pct))}>{q ? pct(q.pct) : "—"}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </FramePanel>
    </Frame>
  );
}

/* ---------------- 信号流 ---------------- */
const levelVariant: Record<string, any> = { critical: "destructive", warn: "warning", info: "info-light" };
const dirIcon = (d?: string) =>
  d === "bull" ? <ArrowUpRight className="size-3 text-up" />
  : d === "bear" ? <ArrowDownRight className="size-3 text-down" />
  : <Minus className="size-3 text-muted-foreground" />;

export function SignalFeed({ signals }: { signals: any[] }) {
  return (
    <div className="flex flex-col gap-1.5">
      {(!signals || signals.length === 0) && (
        <div className="py-4 text-center text-xs text-muted-foreground">暂无显著信号</div>
      )}
      {signals?.map((s, i) => (
        <div key={i} className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/20 px-2 py-1.5">
          <span className="mt-0.5">{dirIcon(s.dir)}</span>
          <span className="flex-1 text-xs leading-snug">{s.text}</span>
          <Badge variant={levelVariant[s.level] ?? "secondary"} size="xs">
            {s.level === "critical" ? "重要" : s.level === "warn" ? "关注" : "提示"}
          </Badge>
        </div>
      ))}
    </div>
  );
}

/* ---------------- 方向评分 ---------------- */
export function BiasBar({ bias }: { bias: any }) {
  const s = Math.max(-100, Math.min(100, bias?.score ?? 0));
  const pos = ((s + 100) / 200) * 100;
  const dir = bias?.direction ?? "neutral";
  const label = dir === "call" ? "看多（认购）" : dir === "put" ? "看空（认沽）" : "观望（中性）";
  // 统一：看多=红、看空=绿（与其它方向标签一致）
  const variant = dir === "call" ? "destructive-light" : dir === "put" ? "success-light" : "secondary";
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Badge variant={variant as any} size="sm">{label}</Badge>
        <span className="text-xs text-muted-foreground tnum">
          评分 <b className={clsUpDown(s)}>{s}</b> · 置信度 {(bias?.confidence ?? 0) * 100 | 0}%
        </span>
      </div>
      <div className="relative h-2 rounded-full bg-gradient-to-r from-down/40 via-muted to-up/40">
        <div className="absolute top-1/2 h-4 w-1 -translate-x-1/2 -translate-y-1/2 rounded bg-foreground" style={{ left: `${pos}%` }} />
        <div className="absolute left-1/2 top-0 h-2 w-px -translate-x-1/2 bg-border" />
      </div>
      <div className="flex flex-wrap gap-1">
        {Object.entries(bias?.detail ?? {}).map(([k, v]) => (
          <span key={k} className="rounded bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground tnum">
            {k} <b className={clsUpDown(v)}>{String(v)}</b>
          </span>
        ))}
      </div>
    </div>
  );
}

/* ---------------- 交易方案 ---------------- */
export function PlanCard({ bundle }: { bundle: any }) {
  const lv = bundle?.levels;
  const plans = bundle?.plans ?? [];
  if (!lv) return null;
  return (
    <Frame spacing="sm" stacked>
      <FramePanel dense>
        <FrameHeader><FrameTitle className="text-xs">标的点位（ETF）</FrameTitle></FrameHeader>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 px-3 pb-3 text-xs sm:grid-cols-3">
          <Kv k="方向" v={lv.side === "long" ? "偏多" : lv.side === "short" ? "偏空" : "观望"} />
          <Kv k="突破入场" v={nf(lv.entry_break, 4)} />
          <Kv k="回踩买点" v={nf(lv.entry_pullback, 4)} />
          <Kv k="止损" v={nf(lv.stop, 4)} />
          <Kv k="止盈" v={nf(lv.target, 4)} />
          <Kv k="ATR" v={nf(lv.atr, 4)} />
        </div>
      </FramePanel>
      {plans.length > 0 && (
        <FramePanel dense>
          <FrameHeader><FrameTitle className="text-xs">合约买卖点（按 Delta 折算）</FrameTitle></FrameHeader>
          <Table>
            <THead>
              <TR>
                <TH>合约</TH><TH className="text-right">现价</TH><TH className="text-right">入场</TH>
                <TH className="text-right">止损</TH><TH className="text-right">止盈</TH><TH className="text-right">盈亏比</TH>
              </TR>
            </THead>
            <TBody>
              {plans.map((p: any, i: number) => {
                const rr = p.stop_pct && p.target_pct ? Math.abs(p.target_pct / p.stop_pct) : null;
                return (
                  <TR key={i}>
                    <TD className="max-w-[140px] truncate">{p.contract}</TD>
                    <TD className="text-right tnum">{nf(p.current, 4)}</TD>
                    <TD className="text-right tnum">{nf(p.entry, 4)}<span className="ml-1 text-[10px] text-muted-foreground">{pct(p.entry_pct, 1)}</span></TD>
                    <TD className="text-right tnum text-down">{nf(p.stop, 4)}<span className="ml-1 text-[10px]">{pct(p.stop_pct, 1)}</span></TD>
                    <TD className="text-right tnum text-up">{nf(p.target, 4)}<span className="ml-1 text-[10px]">{pct(p.target_pct, 1)}</span></TD>
                    <TD className="text-right tnum">{rr ? `${rr.toFixed(1)}:1` : "—"}</TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </FramePanel>
      )}
    </Frame>
  );
}

function Kv({ k, v }: { k: string; v: any }) {
  return (
    <div className="flex items-center justify-between gap-1">
      <span className="text-muted-foreground">{k}</span>
      <span className="tnum">{v}</span>
    </div>
  );
}

/* ---------------- 候选合约排行 ---------------- */
export function CandidateList({
  candidates, selected, onSelect,
}: {
  candidates: any[];
  selected?: string;
  onSelect: (c: any) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      {candidates?.map((c, i) => (
        <button
          key={c.code}
          onClick={() => onSelect(c)}
          className={cn(
            "flex items-center gap-2 rounded-md border border-border/60 px-2 py-1.5 text-left transition-colors",
            c.secid === selected ? "border-primary/60 bg-primary/10" : "hover:bg-muted/40",
          )}
        >
          <span className="w-4 text-center text-[10px] text-muted-foreground">{i + 1}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{c.name}</div>
            <div className="text-[10px] text-muted-foreground tnum">
              {c.code} · Δ{c.delta} · IV{c.iv}% · 溢价{c.premium_rate}%
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs tnum">{nf(c.last, 4)}</div>
            <div className={`text-[10px] tnum ${clsUpDown(c.pct)}`}>{pct(c.pct)}</div>
          </div>
          <Badge variant="primary-light" size="xs" className="tnum">{c.score}</Badge>
        </button>
      ))}
    </div>
  );
}

/* ---------------- T 型报价 ---------------- */
export function OptionTQuote({
  chain, month, onMonth, selectedSecid, onSelect,
}: {
  chain: any;
  month: number | null;
  onMonth: (m: number) => void;
  selectedSecid?: string;
  onSelect: (c: any) => void;
}) {
  const tq = chain?.t_quote;
  const expiries = chain?.expiries ?? [];
  if (!chain || chain.error) return <div className="p-4 text-xs text-muted-foreground">加载中…</div>;
  const s = chain.underlying?.price ?? 0;
  const rows: any[] = tq?.rows ?? [];
  // 最接近当前标的价格的那一档行权价（单一行）→ 特殊色标记
  const atmStrike = rows.length
    ? rows.reduce((best: number, r: any) => (Math.abs(r.strike - s) < Math.abs(best - s) ? r.strike : best), rows[0].strike)
    : null;
  return (
    <div className="flex flex-col">
      <div className="flex items-center justify-between px-1 pb-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold">{chain.etf?.name} 期权链</span>
          <span className="text-[11px] text-muted-foreground tnum">标的 {nf(s, 3)}（{pct(chain.underlying?.pct)}）</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground">
            ATM IV {chain.stats?.atm_iv ?? "—"}% · 偏斜 {chain.stats?.skew ?? "—"} · PCR {chain.stats?.pcr ?? "—"}
          </span>
          <Tabs tabs={expiries.map((m: number) => ({ key: String(m), label: `${m}月` }))} value={String(month)} onChange={(k) => onMonth(Number(k))} />
        </div>
      </div>
      <div className="max-h-[62vh] overflow-auto">
        <Table>
          <THead>
            <TR>
              <TH colSpan={5} className="text-center text-up">认购 Call</TH>
              <TH className="text-center">行权价</TH>
              <TH colSpan={5} className="text-center text-down">认沽 Put</TH>
            </TR>
            <TR>
              <TH>名称</TH><TH className="text-right">现价</TH><TH className="text-right">涨跌</TH><TH className="text-right">IV</TH><TH className="text-right">Δ</TH>
              <TH className="text-center">K</TH>
              <TH className="text-right">Δ</TH><TH className="text-right">IV</TH><TH className="text-right">涨跌</TH><TH className="text-right">现价</TH><TH>名称</TH>
            </TR>
          </THead>
          <TBody>
            {rows.map((row: any) => {
              const c = row.call, p = row.put;
              const isAtm = row.strike === atmStrike;
              return (
                <TR key={row.strike} className={cn(isAtm && "bg-warning/15 ring-1 ring-inset ring-warning/40")}>
                  <ContractCells c={c} selected={selectedSecid} onSelect={onSelect} align="left" />
                  <TD className={cn("text-center font-semibold tnum", isAtm && "text-warning-foreground")}>
                    {isAtm && <span className="mr-1 rounded bg-warning/25 px-1 align-middle text-[9px] leading-4">ATM</span>}
                    {row.strike.toFixed(3)}
                  </TD>
                  <ContractCells c={p} selected={selectedSecid} onSelect={onSelect} align="right" />
                </TR>
              );
            })}
          </TBody>
        </Table>
      </div>
    </div>
  );
}

function ContractCells({ c, selected, onSelect, align }: { c: any; selected?: string; onSelect: (c: any) => void; align: "left" | "right" }) {
  if (!c) return <TD colSpan={5} className="text-center text-muted-foreground">—</TD>;
  const on = c.secid === selected;
  const num = (v: any, d = 4) => nf(v, d);
  const vals = [
    <TD key="last" className={cn("text-right tnum", on && "font-bold")}>{num(c.last)}</TD>,
    <TD key="pct" className={cn("text-right tnum", clsUpDown(c.pct))}>{pct(c.pct, 1)}</TD>,
    <TD key="iv" className="text-right tnum text-muted-foreground">{nf(c.iv, 1)}</TD>,
    <TD key="d" className="text-right tnum text-muted-foreground">{nf(c.delta, 2)}</TD>,
  ];
  const name = (
    <TD key="name" onClick={() => onSelect(c)} className={cn("cursor-pointer hover:text-primary", align === "right" && "text-right")}>
      {on && <Flame className="mr-0.5 inline size-3 text-warning" />}{c.name}
    </TD>
  );
  const cells = align === "left" ? [name, ...vals] : [...vals.reverse(), name];
  return <>{cells}</>;
}
