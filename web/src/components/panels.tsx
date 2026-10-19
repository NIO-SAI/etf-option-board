import { Badge } from "@/components/reui/badge";
import { Frame, FrameHeader, FramePanel, FrameTitle } from "@/components/reui/frame";
import { Sparkline } from "@/components/charts";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { EmptyState, Skeleton, Tabs } from "@/components/ui/misc";
import { clsUpDown, nf, pct } from "@/lib/format";
import { cn } from "@/lib/utils";
import { ArrowDownRight, ArrowUpRight, Flame, Minus } from "lucide-react";

/* ---------------- 方向标签 ---------------- */
// 方向本质是「看多/看空/观望」这一状态：复用 ReUI 已装的 <tone>-light 状态徽标
// （destructive=红=看多、success=绿=看空，A 股约定；观望为中性态用 outline），
// 不新造色阶、不用 solid 填充。强调靠「尺寸 + 图标 + 位置」，不靠换颜色。
type Dir = "call" | "put" | "neutral";

const DIR: Record<Dir, { variant: "destructive-light" | "success-light" | "outline"; label: string; Icon: typeof Minus }> = {
  call: { variant: "destructive-light", label: "看多", Icon: ArrowUpRight },
  put: { variant: "success-light", label: "看空", Icon: ArrowDownRight },
  neutral: { variant: "outline", label: "观望", Icon: Minus },
};

const DIR_TIP: Record<Dir, string> = {
  call: "综合方向：多因子合力（标的动量/价格vs均价/关联指数/指数MACD/国家队/外围），评分 ≥ +15 判定看多",
  put: "综合方向：多因子合力（标的动量/价格vs均价/关联指数/指数MACD/国家队/外围），评分 ≤ -15 判定看空",
  neutral: "综合方向：多因子合力评分落在 ±15 之间，无明确方向，观望",
};

/** 方向徽标：全站唯一的方向口径（左栏列表 / 方向评分 / 交易方案共用）。 */
function DirBadge({
  dir, size = "default", tip, className,
}: {
  dir: Dir;
  size?: "default" | "lg" | "xl";
  tip?: string;
  className?: string;
}) {
  const d = DIR[dir] ?? DIR.neutral;
  const Icon = d.Icon;
  const iconSize = size === "xl" ? "size-4" : size === "lg" ? "size-3.5" : undefined;
  return (
    <Badge variant={d.variant} size={size} className={className} title={tip ?? DIR_TIP[dir]}>
      <Icon className={iconSize} aria-hidden />
      {d.label}
    </Badge>
  );
}

// 变盘点：来自 reversal 高周期转折引擎（5m 确认 + 15m 结构转向，阈值 65）。
// 它是综合方向的加分因子（±15，60 分钟衰减）——方向结论已含变盘信息，此处角标只是
// 标注其高周期依据。同一行只允许 1 枚状态徽标，故降级为「内联状态文字」+ 箭头图标。
const SIGNAL_DIR: Record<string, { label: string; Icon: typeof Minus; cls: string }> = {
  bull: { label: "变盘看多", Icon: ArrowUpRight, cls: "text-destructive-foreground dark:text-destructive" },
  bear: { label: "变盘看空", Icon: ArrowDownRight, cls: "text-success-foreground dark:text-success" },
};

function SignalMark({ signal }: { signal?: { dir: string; score: number; ts: string } }) {
  const s = signal && SIGNAL_DIR[signal.dir];
  if (!s) return null;
  const Icon = s.Icon;
  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-0.5 text-xs font-medium", s.cls)}
      title={`变盘点：5m 确认 + 15m 结构转向（阈值 65），已并入综合方向加分（±15，60 分钟衰减）；${String(signal!.ts ?? "").slice(11, 16)} 触发 ${signal!.score ?? "—"} 分`}
    >
      <Icon className="size-3" aria-hidden />
      {s.label}
    </span>
  );
}

/* ---------------- 标的列表 ---------------- */

export function EtfList({
  etfs, quotes, trendsMap, directions = {}, indices = [], selected, onSelect,
}: {
  etfs: any[];
  quotes: Record<string, any>;
  trendsMap: Record<string, number[]>;
  directions?: Record<string, {
    direction: string; score: number; confidence: number;
    signal?: { dir: string; score: number; ts: string };
  }>;
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
        <div className="min-h-0 flex-1 divide-y divide-border/60 overflow-auto">
          <div className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground">期权标的（{etfs.length}）</div>
          {etfs.map((e) => {
            const q = quotes[e.code];
            const on = e.code === selected;
            const dir = (directions[e.code]?.direction ?? "neutral") as Dir;
            const sig = directions[e.code]?.signal;
            return (
              <button
                key={e.code}
                type="button"
                aria-current={on ? "true" : undefined}
                onClick={() => onSelect(e.code)}
                className={cn(
                  "flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  on ? "bg-muted dark:bg-muted/50" : "hover:bg-muted/50",
                )}
              >
                {/* 主信息：全名 + 方向徽标，第二行 代码·指数 */}
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className={cn("truncate text-xs font-medium", on && "text-primary")}>{e.name}</span>
                    <DirBadge dir={dir} className="shrink-0" />
                  </div>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-[10px] text-muted-foreground tnum">{e.code} · {e.track}</span>
                    <SignalMark signal={sig} />
                  </div>
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

        {/* 大盘指数：面板固定底栏（ETF 列表滚动、本区常驻可见）；窗口过矮时本区内部滚动，保证不被裁切 */}
        <div className="flex min-h-0 flex-col border-t border-border/60 bg-card">
          <div className="px-3 py-1.5 text-[10px] font-medium text-muted-foreground">大盘指数（{indexRows.length}）</div>
          <div className="divide-y divide-border/60 overflow-auto">
            {indexRows.map((ix) => {
              const q = ix.quote;
              return (
                <div key={ix.code} className="flex w-full items-center gap-2.5 px-3 py-2.5">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-medium">{ix.name}</span>
                      <Badge variant="outline" className="shrink-0">指数</Badge>
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
// 级别是状态 → 一律 <tone>-light（禁止 solid 填充）；尺寸用 default，不用 xs。
const LEVEL: Record<string, { variant: "destructive-light" | "warning-light" | "info-light"; label: string }> = {
  critical: { variant: "destructive-light", label: "重要" },
  warn: { variant: "warning-light", label: "关注" },
  info: { variant: "info-light", label: "提示" },
};
const dirIcon = (d?: string) =>
  d === "bull" ? <ArrowUpRight className="size-3.5 text-up" aria-hidden />
  : d === "bear" ? <ArrowDownRight className="size-3.5 text-down" aria-hidden />
  : <Minus className="size-3.5 text-muted-foreground" aria-hidden />;

const levelBadge = (level?: string) => {
  const l = LEVEL[level as string] ?? LEVEL.info;
  return <Badge variant={l.variant}>{l.label}</Badge>;
};

export function SignalFeed({ signals, loading }: { signals: any[]; loading?: boolean }) {
  if (loading) {
    return (
      <div className="flex flex-col gap-1.5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-2">
            <Skeleton className="size-3.5 shrink-0 rounded-full" />
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-5 w-10 shrink-0" />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1.5" role="status" aria-live="polite">
      {(!signals || signals.length === 0) && (
        <EmptyState title="暂无显著信号" hint="出现放量、资金异动或背离时在此提示" />
      )}
      {signals?.map((s, i) => (
        <div
          key={i}
          className={cn(
            "flex items-start gap-2 rounded-md border border-border/60 bg-muted/20 px-2.5 py-2",
            "border-l-2",
            s.dir === "bull" ? "border-l-up/60" : s.dir === "bear" ? "border-l-down/60" : "border-l-transparent",
          )}
        >
          <span className="mt-0.5">{dirIcon(s.dir)}</span>
          <span className="min-w-0 flex-1 text-xs leading-snug">{s.text}</span>
          {levelBadge(s.level)}
        </div>
      ))}
    </div>
  );
}

/* ---------------- 方向评分 ---------------- */
export function BiasBarSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <Skeleton className="h-6 w-24 rounded-sm" />
        <Skeleton className="h-4 w-28" />
      </div>
      <Skeleton className="h-2.5 w-full rounded-full" />
      <div className="flex gap-1">
        <Skeleton className="h-4 w-16 rounded" />
        <Skeleton className="h-4 w-14 rounded" />
        <Skeleton className="h-4 w-20 rounded" />
      </div>
    </div>
  );
}

export function BiasBar({ bias }: { bias: any }) {
  const s = Math.max(-100, Math.min(100, bias?.score ?? 0));
  const pos = ((s + 100) / 200) * 100;
  const dir = (bias?.direction ?? "neutral") as Dir;
  const conf = Math.round((bias?.confidence ?? 0) * 100);
  // 主焦点：方向徽标（xl + 图标）。评分退居其右，用 KPI 字号而非 10px 小字。
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <DirBadge
          dir={dir}
          size="xl"
          tip={`${DIR_TIP[dir]}；当前评分 ${s}，置信度 ${conf}%`}
        />
        <span className="flex items-baseline gap-1.5 text-xs text-muted-foreground">
          {/* 评分不重复上色：整卡只有方向徽标一个彩色焦点，评分作为它的量纲读 */}
          <span className="text-lg font-semibold text-foreground tnum">{s}</span>
          <span className="tnum">置信度 {conf}%</span>
        </span>
      </div>
      {/* 评分条：0 居中、左空右多。语义双色带，不用装饰性渐变。 */}
      <div
        className="relative h-2.5 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`多空评分 ${s}，区间 -100 看空 至 +100 看多，中心 0`}
      >
        <div className="absolute inset-y-0 left-0 w-1/2 bg-down/25" aria-hidden />
        <div className="absolute inset-y-0 right-0 w-1/2 bg-up/25" aria-hidden />
        <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border" aria-hidden />
        <div
          className="absolute top-1/2 h-4 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground"
          style={{ left: `${pos}%` }}
          aria-hidden
        />
      </div>
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>看空 -100</span>
        <span>看多 +100</span>
      </div>
      <div className="flex flex-wrap gap-1">
        {Object.entries(bias?.detail ?? {}).map(([k, v]) => (
          <span key={k} className="inline-flex items-center gap-1 rounded bg-muted/50 px-1.5 py-0.5 text-xs text-muted-foreground tnum">
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
  const plans: any[] = bundle?.plans ?? [];
  const side = lv?.side;
  // 方向 = 本卡的主焦点，且与左列「综合方向」同源同口径（都用 DirBadge），
  // 但这里多给一句可执行信息（突破/跌破哪个价入场），避免重复而无增量。
  const dir: Dir = side === "long" ? "call" : side === "short" ? "put" : "neutral";
  const entryHint = side === "long" ? `突破 ${nf(lv?.entry_break, 4)} 入场`
    : side === "short" ? `跌破 ${nf(lv?.entry_break, 4)} 入场` : null;
  return (
    <Frame spacing="sm" stacked>
      <FramePanel dense>
        <FrameHeader><FrameTitle>标的点位（ETF）</FrameTitle></FrameHeader>
        {!bundle ? (
          <PlanSkeleton />
        ) : !lv ? (
          <EmptyState
            title={bundle?.error ? "点位数据暂不可用" : "方向不明，暂无点位方案"}
            hint={bundle?.error ? "接口未返回，稍后自动重试" : "评分落在 ±15 之间，等待方向选择"}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pb-2">
              <DirBadge dir={dir} size="lg" tip={DIR_TIP[dir]} />
              {entryHint && <span className="text-xs text-muted-foreground tnum">{entryHint}</span>}
            </div>
            {/* label 在上、值在下：窄栏下也不会出现「突破入场」被折行、与数值挤在一行的情形 */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 px-3 pb-3 sm:grid-cols-3">
              <Stat label="突破入场" value={nf(lv.entry_break, 4)} />
              <Stat label="回踩买点" value={nf(lv.entry_pullback, 4)} />
              <Stat label="止损" value={nf(lv.stop, 4)} tone="down" />
              <Stat label="止盈" value={nf(lv.target, 4)} tone="up" />
              <Stat label="ATR" value={nf(lv.atr, 4)} />
              <Stat label="日内区间" value={`${nf(lv.day_low, 4)}~${nf(lv.day_high, 4)}`} muted />
            </div>
          </>
        )}
      </FramePanel>
      <FramePanel dense>
        <FrameHeader><FrameTitle>合约买卖点（按 Delta 折算）</FrameTitle></FrameHeader>
        {plans.length > 0 ? (
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
                    <TD className="text-right tnum">{nf(p.entry, 4)}<span className="ml-1 text-xs text-muted-foreground">{pct(p.entry_pct, 1)}</span></TD>
                    <TD className="text-right tnum text-down">{nf(p.stop, 4)}<span className="ml-1 text-xs">{pct(p.stop_pct, 1)}</span></TD>
                    <TD className="text-right tnum text-up">{nf(p.target, 4)}<span className="ml-1 text-xs">{pct(p.target_pct, 1)}</span></TD>
                    <TD className="text-right font-semibold tnum">{rr ? `${rr.toFixed(1)}:1` : "—"}</TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        ) : !bundle ? (
          <Skeleton className="mx-3 mb-3 h-16" />
        ) : (
          <EmptyState title="暂无合约方案" hint="缺少可用 Delta 或昨收，无法折算买卖点" />
        )}
      </FramePanel>
    </Frame>
  );
}

function PlanSkeleton() {
  return (
    <div className="flex flex-col gap-2 px-3 pb-3">
      <Skeleton className="h-5 w-24 rounded-sm" />
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-1">
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 点位单元格：label（text-xs muted）在上、数值在下。
 * `muted`：非委托价位（如日内区间）降一档字号与颜色——区间是上下文，不是下单点位，
 * 且 4.2010~4.2820 这类长串在 3 列窄格里会把格子撑破。
 */
function Stat({ label, value, tone, muted }: { label: string; value: any; tone?: "up" | "down"; muted?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="truncate text-xs text-muted-foreground">{label}</span>
      <span
        className={cn(
          "truncate tnum",
          muted ? "text-xs text-muted-foreground" : "text-sm font-semibold",
          !muted && tone === "up" ? "text-up" : !muted && tone === "down" ? "text-down" : "",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/* ---------------- 候选合约排行 ---------------- */
export function CandidateSkeleton() {
  return (
    <div className="flex flex-col gap-1">
      {[0, 1, 2, 3, 4, 5].map((i) => (
        <div key={i} className="flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-2">
          <Skeleton className="size-3 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1">
            <Skeleton className="h-3 w-2/3" />
            <Skeleton className="mt-1 h-3 w-1/2" />
          </div>
          <Skeleton className="h-3 w-10 shrink-0" />
          <Skeleton className="h-5 w-8 shrink-0" />
        </div>
      ))}
    </div>
  );
}

export function CandidateList({
  candidates, selected, onSelect,
}: {
  candidates: any[];
  selected?: string;
  onSelect: (c: any) => void;
}) {
  return (
    <div className="flex flex-col gap-1" role="list">
      {candidates?.map((c, i) => (
        <button
          key={c.code}
          type="button"
          role="listitem"
          aria-current={c.secid === selected ? "true" : undefined}
          onClick={() => onSelect(c)}
          className={cn(
            "flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-2 text-left transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            c.secid === selected ? "border-primary/60 bg-muted dark:bg-muted/50" : "hover:bg-muted/40",
          )}
        >
          <span className="w-4 shrink-0 text-center text-xs text-muted-foreground tnum" aria-hidden>{i + 1}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{c.name}</div>
            <div className="truncate text-xs text-muted-foreground tnum">
              {c.code} · Δ{c.delta} · IV{c.iv}% · 溢价{c.premium_rate}%
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-xs font-medium tnum">{nf(c.last, 4)}</div>
            <div className={cn("text-xs tnum", clsUpDown(c.pct))}>{pct(c.pct)}</div>
          </div>
          <Badge variant="primary-light" className="tnum" title={`日内性价比评分 ${c.score}`} aria-label={`性价比评分 ${c.score}`}>
            {c.score}
          </Badge>
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
  // 近月剩余天数（expiry_list 按天数升序，首个即近月）
  const expiryDays = chain.expiry_list?.[0]?.days ?? null;
  // 最接近当前标的价格的那一档行权价（单一行）→ 特殊色标记
  const atmStrike = rows.length
    ? rows.reduce((best: number, r: any) => (Math.abs(r.strike - s) < Math.abs(best - s) ? r.strike : best), rows[0].strike)
    : null;
  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2 px-1 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-semibold">{chain.etf?.name} 期权链</span>
          <span className="shrink-0 text-xs text-muted-foreground tnum">标的 {nf(s, 3)}（{pct(chain.underlying?.pct)}）</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            ATM IV {chain.stats?.atm_iv ?? "—"}%{chain.stats?.atm_iv_pctl20 != null ? ` · 20日分位${Math.round(chain.stats.atm_iv_pctl20)}%` : ""} · 偏斜 {chain.stats?.skew ?? "—"} · PCR {chain.stats?.pcr ?? "—"}
            {expiryDays != null && expiryDays < 7 && (
              <span className="ml-1 font-semibold text-warning">距到期{expiryDays}天·Theta衰减快</span>
            )}
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
    <TD key="name" className={cn("p-0", align === "right" && "text-right")}>
      {/* 可点选 → 必须是真按钮，才能键盘 Tab 到、Enter 触发并显示焦点环 */}
      <button
        type="button"
        onClick={() => onSelect(c)}
        className={cn(
          "inline-flex w-full max-w-full items-center gap-0.5 px-2 py-1 text-left transition-colors",
          "hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          align === "right" && "justify-end",
        )}
      >
        {on && <Flame className="size-3 shrink-0 text-warning" aria-hidden />}
        <span className="truncate">{c.name}</span>
      </button>
    </TD>
  );
  const cells = align === "left" ? [name, ...vals] : [...vals.reverse(), name];
  return <>{cells}</>;
}
