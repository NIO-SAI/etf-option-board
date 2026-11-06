import { Badge } from "@/components/reui/badge";
import { Frame, FrameHeader, FramePanel, FrameTitle } from "@/components/reui/frame";
import { Sparkline } from "@/components/charts";
import { IndexLevelsDialog } from "@/components/IndexLevelsDialog";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/table";
import { EmptyState, RowCodeTip, Skeleton, Tabs, useRowTip } from "@/components/ui/misc";
import { Fold } from "@/components/ui/fold";
import { AutoTip, GLOSSARY, Tip } from "@/components/ui/term";
import { clsUpDown, flowMoney, gamma, money, nf, pct, signedMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Loader2, Minus, Star } from "lucide-react";

/* ---------------- T 型报价列定义 ---------------- */

/**
 * 一列 = 一个字段 + 一句「这列到底什么意思」。help 文案是随手可查的口径说明：
 * 这些列（打和点/内在/时间价值/希腊字母）对新手不是自明的，缺了就得去翻书。
 */
type Col = { key: string; label: string; help: string; get: (c: any, ctx: { rv: any; rf: any }) => ReactNode };

const COLS: Col[] = [
  { key: "last", label: "现价", help: "最新成交价；无成交时取买卖中间价", get: (c) => nf(c.last, 4) },
  { key: "change", label: "涨跌", help: "现价 − 昨日结算价（权利金变动额）", get: (c) => <span className={clsUpDown(c.change)}>{nf(c.change, 4)}</span> },
  { key: "pct", label: "涨幅", help: "涨跌 ÷ 昨收 × 100%", get: (c) => <span className={clsUpDown(c.pct)}>{pct(c.pct, 1)}</span> },
  { key: "volume", label: "总量", help: "当日累计成交张数", get: (c) => money(c.volume) },
  { key: "oi", label: "持仓", help: "未平仓合约张数（持仓量）；买卖盘厚不厚主要看它", get: (c) => money(c.oi) },
  { key: "limitUp", label: "涨停", help: "交易所涨停价；行情源未提供时显示 —", get: (c) => (c.limit_up ? nf(c.limit_up, 4) : "—") },
  { key: "breakEven", label: "打和点", help: "到期盈亏平衡价：认购 = 行权价 + 权利金，认沽 = 行权价 − 权利金", get: (c) => nf(c.break_even, 4) },
  { key: "intrinsic", label: "内在", help: "内在价值：立即行权能拿到的价值（认购 S−K，认沽 K−S，最低 0）", get: (c) => nf(c.intrinsic, 4) },
  { key: "timeValue", label: "时间", help: "时间价值 = 现价 − 内在价值；到期归零，买方每天都在为它付钱", get: (c) => nf(c.time_value, 4) },
  { key: "premium", label: "溢价率", help: "溢价率%：到期时标的要涨/跌多少才能覆盖权利金（越低越「实」）", get: (c) => (c.premium_rate == null ? "—" : `${nf(c.premium_rate, 2)}%`) },
  { key: "leverage", label: "杠杆", help: "杠杆比率 = 标的价 ÷ 权利金（静态）；实际杠杆 = 杠杆 × |Δ|", get: (c) => nf(c.leverage, 1) },
  { key: "hv", label: "历史波", help: "历史波动率%：标的近 20 日已实现波动（年化），衡量「实际发生了多大波动」", get: (_c, ctx) => (ctx.rv == null ? "—" : `${nf(ctx.rv, 1)}%`) },
  { key: "iv", label: "隐波", help: "隐含波动率%：由现价反推的市场预期年化波动（BS 口径）；越高权利金越贵", get: (c) => (c.iv == null ? "—" : `${nf(c.iv, 1)}%`) },
  { key: "rf", label: "无风险", help: "无风险利率%：定价模型里的年化无风险利率，短期合约影响很小", get: (_c, ctx) => (ctx.rf == null ? "—" : `${nf(ctx.rf, 2)}%`) },
  { key: "delta", label: "Δ", help: "Delta：标的价格每变动 1 元，期权价格的变动量（认购 0~1、认沽 −1~0）", get: (c) => nf(c.delta, 3) },
  { key: "gamma", label: "Γ", help: "Gamma：标的价格每变动 1 元，Delta 的变动量；平值附近最大，日内爆发力来源", get: (c) => gamma(c.gamma) },
  { key: "vega", label: "Vega", help: "Vega：隐含波动率每变动 1 个百分点，期权价格的变动量（买方怕降波）", get: (c) => nf(c.vega, 4) },
  { key: "rho", label: "Rho", help: "Rho：无风险利率每变动 1 个百分点，期权价格的变动量（短期影响很小）", get: (c) => nf(c.rho, 4) },
  { key: "theta", label: "Theta", help: "Theta：每过 1 天的时间价值损耗（买方为负，越临近到期越快）", get: (c) => nf(c.theta, 4) },
  { key: "theory", label: "理论价", help: "按 20 日已实现波动定价的参考价；现价明显高于它说明市场为波动率多付了钱", get: (c) => nf(c.theory, 4) },
];

// 常看字段在前；紧凑模式只留这 4 列 + 名称，避免 20 列横向滚到看不清。
const PINNED = ["last", "pct", "delta", "gamma"];
const OTHER = COLS.map((c) => c.key).filter((k) => !PINNED.includes(k));
// 认购在左、认沽在右，两侧镜像：远离行权价的一端放最不常看的列。
const ORDER = {
  call: [...OTHER].reverse().concat(["name", ...PINNED]),
  put: [...PINNED].reverse().concat(["name", ...OTHER]),
  callComfort: ["name", ...PINNED],
  putComfort: [...PINNED].reverse().concat("name"),
};
const COL_OF: Record<string, Col> = Object.fromEntries(COLS.map((c) => [c.key, c]));

/**
 * 带口径说明的表头。tooltip 在 hover 时**立即**出现（不等浏览器默认的 1s+ 延迟），
 * 且 `whitespace-normal` + 固定宽度：说明文字是整句中文，若继承表头的 nowrap 会拉成一条长线。
 */
function HelpTh({ col }: { col: Col }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  return (
    <TH
      className="text-right whitespace-nowrap"
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setPos({ x: r.left + r.width / 2, y: r.bottom });
      }}
      onMouseLeave={() => setPos(null)}
      onFocus={() => setPos(null)}
    >
      <span className="cursor-help border-b border-dotted border-muted-foreground/50">{col.label}</span>
      {pos && (
        <span
          role="tooltip"
          className="pointer-events-none fixed z-50 w-56 whitespace-normal rounded-md border border-border bg-card px-2 py-1.5 text-left text-[11px] font-normal leading-snug text-foreground shadow-lg"
          style={{ left: pos.x, top: pos.y + 6, transform: "translateX(-50%)" }}
        >
          <b className="mb-0.5 block text-[10px] text-muted-foreground">{col.label}</b>
          {col.help}
        </span>
      )}
    </TH>
  );
}

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
  etfs, futOpts = [], quotes, trendsMap, directions = {}, indices = [], selected, onSelect,
}: {
  etfs: any[];
  /** 股指品种（IO/HO/MO 期权 + 仅期货的 IC）。与 ETF 并列展示，但标「中金所」以示规则不同。 */
  futOpts?: any[];
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
  // 悬停 0.5 秒显示代码
  const { tip, nodeRef, enter, move, leave } = useRowTip();

  // 大盘指数（只读补充信息，非期权标的；固定清单保证始终显示）
  // 只留两条：上证指数（可看关键位）与平均股价（板块口径的赚钱效应）。多一条就会
  // 把矮窗口下的底栏挤到需要滚动，而底栏的存在意义正是「不滚动也能看全」。
  const BIG_INDEXES = [
    { code: "000001", name: "上证指数" },
    { code: "800005", name: "平均股价" },
  ];
  const indexRows = BIG_INDEXES.map((b) => ({ ...b, quote: indices.find((i) => i.code === b.code) }));
  const [idxOpen, setIdxOpen] = useState(false);
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
                onMouseEnter={(ev) => enter(ev, e.code)}
                onMouseMove={move}
                onMouseLeave={leave}
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
                <div className="w-16 shrink-0 text-right">
                  <div className="text-xs font-semibold tnum">{q ? nf(q.price, 3) : "—"}</div>
                  <div className={cn("text-[11px] tnum", clsUpDown(q?.pct))}>{q ? pct(q.pct) : "—"}</div>
                  <div className="text-[10px] tnum text-muted-foreground" title="当日成交额">
                    {q?.amount ? flowMoney(q.amount) : "—"}
                  </div>
                </div>
              </button>
            );
          })}
          {futOpts.length > 0 && (
            <>
              <div className="px-3 py-1.5 text-[11px] font-medium text-muted-foreground">股指期权/期货（{futOpts.length}）</div>
              {futOpts.map((f) => {
                const q = quotes[f.code];
                const on = f.code === selected;
                const dir = (directions[f.code]?.direction ?? "neutral") as Dir;
                return (
                  <button
                    key={f.code}
                    type="button"
                    aria-current={on ? "true" : undefined}
                    onMouseEnter={(ev) => enter(ev, f.code)}
                    onMouseMove={move}
                    onMouseLeave={leave}
                    onClick={() => onSelect(f.code)}
                    className={cn(
                      "flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      on ? "bg-muted dark:bg-muted/50" : "hover:bg-muted/50",
                    )}
                  >
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className={cn("truncate text-xs font-medium", on && "text-primary")}>{f.name}</span>
                        <DirBadge dir={dir} className="shrink-0" />
                      </div>
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate text-[10px] text-muted-foreground tnum">{f.code} · {f.track}</span>
                        {/* 中金所现结/合约乘数与 ETF 期权不同，直接标出来，避免按 ETF 口径误读 */}
                        <Badge variant="outline" className="shrink-0 text-[9px] leading-4">中金所</Badge>
                      </div>
                    </div>
                    <Sparkline data={trendsMap[f.code] ?? []} up={(q?.pct ?? 0) >= 0} width={40} height={26} />
                    <div className="w-16 shrink-0 text-right">
                      <div className="text-xs font-semibold tnum">{q ? nf(q.price, 2) : "—"}</div>
                      <div className={cn("text-[11px] tnum", clsUpDown(q?.pct))}>{q ? pct(q.pct) : "—"}</div>
                      <div className="text-[10px] tnum text-muted-foreground" title="当日成交额">
                        {q?.amount ? flowMoney(q.amount) : "—"}
                      </div>
                    </div>
                  </button>
                );
              })}
            </>
          )}
        </div>

        {/* 大盘指数：面板固定底栏（ETF 列表滚动、本区常驻可见）；窗口过矮时本区内部滚动，保证不被裁切 */}
        <div className="flex min-h-0 flex-col border-t border-border/60 bg-card">
          <div className="px-3 py-1.5 text-[10px] font-medium text-muted-foreground">大盘指数（{indexRows.length}）</div>
          <div className="divide-y divide-border/60 overflow-auto">
            {indexRows.map((ix) => {
              const q = ix.quote;
              const clickable = ix.code === "000001";
              const Row: any = clickable ? "button" : "div";
              const rowProps = clickable
                ? { type: "button" as const, onClick: () => setIdxOpen(true), "aria-expanded": idxOpen, "aria-haspopup": "dialog" as const }
                : {};
              return (
                <Row
                  key={ix.code}
                  {...rowProps}
                  onMouseEnter={(ev) => enter(ev, ix.code)}
                  onMouseMove={move}
                  onMouseLeave={leave}
                  className={cn(
                    "flex w-full items-center gap-2.5 px-3 py-2.5 text-left",
                    clickable && "transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  )}
                >
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-xs font-medium">{ix.name}</span>
                      <DirBadge dir={(directions[ix.code]?.direction ?? "neutral") as Dir} className="shrink-0" />
                      <Badge variant="outline" className="shrink-0">指数</Badge>
                    </div>
                    <div className="truncate text-[10px] text-muted-foreground tnum">{ix.code}{clickable && " · 关键位"}</div>
                  </div>
                  <Sparkline data={trendsMap[ix.code] ?? []} up={(q?.pct ?? 0) >= 0} width={40} height={26} />
                  <div className="w-14 shrink-0 text-right">
                    <div className="text-xs font-semibold tnum">{q ? nf(q.price, 2) : "—"}</div>
                    <div className={cn("text-[11px] tnum", clsUpDown(q?.pct))}>{q ? pct(q.pct) : "—"}</div>
                  </div>
                </Row>
              );
            })}
          </div>
        </div>
        <IndexLevelsDialog open={idxOpen} onClose={() => setIdxOpen(false)} />
      </FramePanel>
      <RowCodeTip tip={tip} nodeRef={nodeRef} />
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

/** 没有期权的股指品种（中证500/IC）：期权链位置改列该品种在中金所的全部真实期货合约。 */
export function FutContracts({ items, spot }: { items: any[]; spot?: number | null }) {
  if (!items?.length) {
    return <EmptyState title="暂无期货合约数据" hint="中金所合约列表未返回，稍后自动重试" />;
  }
  return (
    <div className="p-3">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>
          中金所股指期货 · 共 {items.length} 个合约（该品种无对应期权）
          {spot ? <span className="ml-2 tnum">现货 {nf(spot, 2)}</span> : null}
        </span>
        <span className="tnum">基差 = 合约价 ÷ 现货 − 1</span>
      </div>
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="text-left text-muted-foreground">
            <th className="px-1 py-1 font-normal">合约</th>
            <th className="px-1 py-1 font-normal">到期</th>
            <th className="px-1 py-1 text-right font-normal">最新价</th>
            <th className="px-1 py-1 text-right font-normal">涨跌幅</th>
            <th className="px-1 py-1 text-right font-normal">基差</th>
            <th className="px-1 py-1 text-right font-normal">成交量(手)</th>
            <th className="px-1 py-1 text-right font-normal">持仓量(手)</th>
            <th className="px-1 py-1 text-right font-normal">成交额</th>
          </tr>
        </thead>
        <tbody>
          {items.map((c: any) => (
            <tr key={c.code} className="border-t border-border/40 hover:bg-muted/40">
              <td className="whitespace-nowrap px-1 py-1">
                <span className="font-medium">{c.code}</span>
                {c.is_main && <Badge variant="outline" className="ml-1 shrink-0 text-[9px] leading-4">主力</Badge>}
              </td>
              <td className="px-1 py-1 text-muted-foreground tnum">{c.expiry ?? "—"}</td>
              <td className="px-1 py-1 text-right tnum">{c.price == null ? "—" : nf(c.price, 1)}</td>
              <td className={cn("px-1 py-1 text-right tnum", clsUpDown(c.pct))}>{c.pct == null ? "—" : pct(c.pct)}</td>
              <td className={cn("px-1 py-1 text-right tnum", clsUpDown(c.basis_pct))}>
                {c.basis_pct == null ? "—"
                  : (() => { const v = Math.abs(Number(c.basis_pct)) < 0.005 ? 0 : Number(c.basis_pct);
                    return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`; })()}
              </td>
              <td className="px-1 py-1 text-right tnum">{c.volume == null ? "—" : Math.round(c.volume).toLocaleString()}</td>
              <td className="px-1 py-1 text-right tnum">{c.oi == null ? "—" : Math.round(c.oi).toLocaleString()}</td>
              <td className="px-1 py-1 text-right tnum">{c.amount == null ? "—" : flowMoney(c.amount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

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

/* ---------------- 今日推荐合约 ---------------- */

/**
 * 单张推荐卡：主推（顺应当前方向）/ 反向备选（只在对冲或反转信号时小仓参与）。
 *
 * 「买 1 张」的盈亏是按张数折算后的绝对金额——百分比看不出一张合约到底赚多少，
 * 而仓位决策恰恰是按金额做的。
 */
function RecommendOne({ rec, onSelect, tone, note }: {
  rec: any;
  onSelect: (c: any) => void;
  tone: "primary" | "reverse";
  note?: string;
}) {
  const isCall = rec.side === "call";
  const roi = rec.rr?.roi;
  const { entry, stop, target } = rec;
  // 盈亏比用**价格结构**（目标距离 ÷ 止损距离），不取后端给的 pct 比值：
  // 百分比都是相对同一入场价算的，两者等价但价格口径不受取整影响。
  const rr = entry != null && stop != null && target != null && entry !== stop
    ? Math.abs((target - entry) / (entry - stop))
    : null;
  // 触发价离现价超过 3% 时，标「触发买入」而不是「买入」：它不是现价能成交的价位。
  const farEntry = rec.entry_pct != null && Math.abs(rec.entry_pct) >= 3;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Badge variant={isCall ? "destructive-light" : "success-light"}>
          {tone === "primary" ? "推荐买入" : "反向备选"} · {isCall ? "认购" : "认沽"}
        </Badge>
        <button
          type="button"
          onClick={() => onSelect(rec)}
          className={cn("truncate text-sm font-semibold transition-colors hover:text-primary",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring")}
          title="点击查看该合约详情"
        >
          {rec.name}
        </button>
        <span className="text-[11px] text-muted-foreground tnum">
          <Tip label={`评分 ${rec.score}`} tip={GLOSSARY["评分"]} />
          {" · "}<Tip label={`Δ${nf(rec.delta, 2)}`} tip={GLOSSARY.Delta} />
          {" · "}<Tip label={`IV${nf(rec.iv, 1)}%`} tip={GLOSSARY.IV} />
          {" · "}<Tip label={`剩${rec.days}天`} tip={GLOSSARY["离到期"]} />
        </span>
        <span className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground tnum">
          {rr ? <span><Tip label={`盈亏比 ${rr.toFixed(1)}:1`} tip={GLOSSARY["盈亏比"]} /></span> : null}
          {roi != null ? (
            <span className={roi >= 0 ? "text-up" : "text-down"}>
              <Tip label={`期望 ${roi >= 0 ? "+" : ""}${(roi * 100).toFixed(0)}%`} tip={GLOSSARY["期望收益"]} />
            </span>
          ) : null}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-muted/25 px-2.5 py-2 sm:grid-cols-4">
        <PriceCell label="现价" value={rec.price} />
        <PriceCell label={farEntry ? "触发买入" : "买入"} value={rec.entry} sub={rec.entry_pct} tone="primary" />
        <PriceCell label="止损" value={rec.stop} sub={rec.stop_pct} tone="down" />
        <PriceCell label="止盈" value={rec.target} sub={rec.target_pct} tone="up" />
      </div>
      {(rec.profit != null || rec.loss != null) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] tnum">
          <span className="text-muted-foreground">买 1 张（<Tip label="成本" tip="买入一张合约要占用的现金 = 入场价 × 合约乘数（ETF 期权 10000 份/张，股指期权 100 元/点）。" /> ¥{Math.round(rec.cost ?? 0).toLocaleString()}）：</span>
          {rec.profit != null && <span className="text-up">止盈 +¥{Math.round(rec.profit).toLocaleString()}</span>}
          {rec.loss != null && <span className="text-down">止损 −¥{Math.round(Math.abs(rec.loss)).toLocaleString()}</span>}
        </div>
      )}
      {(rec.reasons ?? []).length > 0 && (
        <p className="text-[11px] leading-snug text-muted-foreground">
          {(rec.reasons as string[]).map((r, i) => (
            <span key={i}>
              {i > 0 && " ｜ "}
              <AutoTip text={r} />
            </span>
          ))}
        </p>
      )}
      {tone === "reverse" && note && <div className="text-[10px] text-warning" role="note">{note}</div>}
    </div>
  );
}

function PriceCell({ label, value, sub, tone }: { label: string; value: any; sub?: any; tone?: "primary" | "up" | "down" }) {
  const cls = tone === "down" ? "text-down" : tone === "up" ? "text-up" : tone === "primary" ? "text-primary" : "";
  return (
    <div className="flex flex-col">
      <span className="text-[10px] text-muted-foreground"><Tip label={label} /></span>
      <span className={cn("text-sm font-semibold tnum", cls)}>{value == null ? "—" : nf(value, 4)}</span>
      {sub != null && <span className={cn("text-[10px] tnum", cls)}>{pct(sub, 1)}</span>}
    </div>
  );
}

export function RecommendCard({ rec, onSelect }: { rec: any; onSelect: (c: any) => void }) {
  const primary = rec?.primary;
  const reverse = rec?.reverse;
  return (
    <FramePanel dense>
      <FrameHeader className="flex-row items-center justify-between">
        <FrameTitle className="text-xs">今日推荐合约</FrameTitle>
        <span className="text-[10px] text-muted-foreground"><AutoTip text="日内性价比 + 目标/止损盈亏比" /></span>
      </FrameHeader>
      <div className="flex flex-col gap-2 px-3 pb-3">
        {!primary && !reverse ? (
          rec ? (
            <EmptyState title="暂无推荐" hint="期权链未返回可用报价或方向不明" />
          ) : (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-5 w-40" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          )
        ) : null}
        {primary && <RecommendOne rec={primary} onSelect={onSelect} tone="primary" />}
        {primary && reverse && <div className="h-px bg-border" />}
        {reverse && <RecommendOne rec={reverse} onSelect={onSelect} tone="reverse" note={rec?.reverse_note} />}
      </div>
    </FramePanel>
  );
}

/* ---------------- 交易方案 ---------------- */
export function PlanCard({ bundle, onSelect }: { bundle: any; onSelect?: (c: any) => void }) {
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
      <DecisionCard bundle={bundle} />
      {onSelect && <RecommendCard rec={bundle?.recommendation} onSelect={onSelect} />}
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
        <Fold title="合约买卖点（按 Delta 折算）" hint={<span className="shrink-0 text-[10px] tnum">{plans.length} 只</span>}>
        {plans.length > 0 ? (
          <Table>
            <THead>
              <TR>
                <TH>合约</TH><TH className="text-right"><Tip label="现价" /></TH>
                <TH className="text-right"><Tip label="入场" /></TH>
                <TH className="text-right"><Tip label="止损" /></TH><TH className="text-right"><Tip label="止盈" /></TH>
                <TH className="text-right"><Tip label="盈亏比" /></TH>
              </TR>
            </THead>
            <TBody>
              {plans.map((p: any, i: number) => {
                // 盈亏比用**价格结构**（止损/止盈幅度已相对入场价，这里仍用价格算，口径统一）
                const pe = p.entry, ps = p.stop, pt = p.target;
                const rr = pe != null && ps != null && pt != null && pe !== ps
                  ? Math.abs((pt - pe) / (pe - ps)) : null;
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
        </Fold>
      </FramePanel>
    </Frame>
  );
}

/* ---------------- 策略与仓位（决策层：策略类型 / 手数 / 敞口 / 临期） ---------------- */
/**
 * 决策卡：策略类型、理由、手数上限、组合 Greeks 敞口与限额、临期约束。
 *
 * 字段全部来自后端纯规则层（`services/decision.py`），前端**不重算**任何口径 ——
 * 一份公式两处实现，迟早会分叉。敞口按 ADR-0001 的定位显式标注为「估算」。
 */
export function DecisionCard({ bundle }: { bundle: any }) {
  const st = bundle?.strategy;
  const pos = bundle?.position;
  const exp = bundle?.expiry;
  const exposure = bundle?.exposure;
  const lim = bundle?.limits;
  const chk = bundle?.limit_check;
  const wait = st?.strategy === "wait";
  const lvl = exp?.level as string | null | undefined;
  const expiryTip = exp?.rows?.[0]?.expiry ? `到期日 ${exp.rows[0].expiry}` : undefined;
  const delta = exposure?.delta_notional;
  const deltaLimit = chk?.limit ?? lim?.amounts?.delta;
  const used = chk?.checked && deltaLimit ? Math.abs(Number(delta) || 0) / deltaLimit : null;
  return (
    <FramePanel dense>
      <Fold
        title="策略与仓位"
        right={st?.month === "next" ? (
          <Badge variant="warning-light" title="当月合约临期，新开仓改用次月">
            改推次月
          </Badge>
        ) : undefined}
      >
      {!bundle ? (
        <PlanSkeleton />
      ) : !st ? (
        <EmptyState title="决策数据暂不可用" hint="接口未返回，稍后自动重试" />
      ) : (
        <div className="flex flex-col gap-2 px-3 pb-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={wait ? "outline" : st.vertical_kind ? "info-light" : "secondary"}>
              {st.label}
            </Badge>
            {exp?.excluded_front && (
              <Badge variant="warning-light" title="当月已临期，不新开当月头寸">当月临期已排除</Badge>
            )}
            {st.degraded && (
              <Badge variant="outline" title="IV 历史样本不足，未能判断权利金贵贱，按中性口径处理">
                IV样本不足
              </Badge>
            )}
            {lvl === "critical" ? (
              <Badge variant="destructive-light" title={expiryTip}>距到期 {exp?.front_days} 天</Badge>
            ) : lvl === "warning" ? (
              <Badge variant="warning-light" title={expiryTip}>距到期 {exp?.front_days} 天</Badge>
            ) : null}
          </div>
          {st.reason && (
            <p className="rounded-md bg-muted/40 px-2 py-1.5 text-[11px] leading-snug">{st.reason}</p>
          )}
          <div className="grid grid-cols-3 gap-x-3 gap-y-2">
            <Stat label="手数上限" value={pos?.max_contracts != null ? `${pos.max_contracts} 张` : "—"} />
            <Stat label="单张最大亏损(元)" value={money(pos?.loss_per_contract)} />
            <Stat label="单笔风险预算(元)" value={money(pos?.budget)} />
          </div>
          {pos?.reason && <div className="text-[11px] text-warning-foreground">{pos.reason}</div>}
          {pos?.note && <div className="text-[11px] text-warning-foreground">{pos.note}</div>}

          {/* 组合 Greeks 敞口：按档位近似（docs/adr/0001），必须标注为估算 */}
          <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
            <span>组合敞口·估算</span>
            {exposure?.tier_label && (
              <Badge variant="outline" className="text-[10px]">
                {exposure.tier_label}
                {exposure.tier !== "flat" && exposure.size_label ? ` · ${exposure.size_label}` : ""}
                {exposure.contracts != null && exposure.tier !== "flat" ? ` · ${exposure.contracts} 张` : ""}
              </Badge>
            )}
          </div>
          <div className="grid grid-cols-3 gap-x-3 gap-y-2">
            <Stat label="Δ敞口(元)" value={signedMoney(delta)}
              tone={delta == null ? undefined : delta > 0 ? "up" : delta < 0 ? "down" : undefined} />
            <Stat label="Δ限额(元)" value={money(deltaLimit)} />
            <Stat label="限额占用" value={used == null ? "—" : `${(used * 100).toFixed(0)}%`} />
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-2">
            <Stat label="日Theta(元)" value={money(exposure?.theta_daily)} />
            <Stat label="Vega/1%(元)" value={money(exposure?.vega_per_pct)} />
          </div>
          {chk?.breached ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1.5 text-[11px] leading-snug text-destructive">
              已超 Δ 限额 {money(chk.over)} 元：{chk.suggestion}
            </div>
          ) : chk?.checked ? (
            <div className="text-[11px] text-muted-foreground">未超限，剩余额度 {money(chk.headroom)} 元</div>
          ) : (
            chk?.note ? <div className="text-[11px] text-muted-foreground">{chk.note}</div> : null
          )}
          {exposure?.ok === false && exposure?.reason && (
            <div className="text-[11px] text-muted-foreground">{exposure.reason}</div>
          )}
        </div>
      )}
      </Fold>
    </FramePanel>
  );
}

/* ---------------- 合约到期日历 ---------------- */
export function ExpiryCalendar({ view }: { view: any }) {
  const rows: any[] = view?.items ?? [];
  return (
    <Frame spacing="sm">
      <FramePanel dense>
        <FrameHeader className="flex-row items-center justify-between">
          <FrameTitle className="text-xs">合约到期日历</FrameTitle>
          <span className="text-[10px] text-muted-foreground">到期月第 4 个星期三</span>
        </FrameHeader>
        {!view ? (
          <Skeleton className="mx-3 mb-3 h-20" />
        ) : view?.error ? (
          <EmptyState title="到期日历暂不可用" hint="接口未返回，稍后自动重试" />
        ) : (
          <div className="px-2 pb-1">
            <Table>
              <THead>
                <TR>
                  <TH>合约月</TH><TH>到期日</TH>
                  <TH className="text-right">剩余</TH><TH className="text-right">状态</TH>
                </TR>
              </THead>
              <TBody>
                {rows.map((r: any) => (
                  <TR key={`${r.year}-${r.month}`}>
                    <TD>
                      {r.month} 月
                      {r.is_front && <span className="ml-1 text-[10px] text-muted-foreground">当月</span>}
                      {r.is_next && <span className="ml-1 text-[10px] text-muted-foreground">下月</span>}
                    </TD>
                    <TD className="tnum">{r.expiry}</TD>
                    <TD className="text-right tnum">
                      {r.days_left === 0 ? "今日到期" : `${r.days_left} 天`}
                    </TD>
                    <TD className="text-right">
                      {r.level === "critical" ? (
                        <Badge variant="destructive-light">临期</Badge>
                      ) : r.level === "warning" ? (
                        <Badge variant="warning-light">临近</Badge>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        )}
        {view?.warning_days != null && (
          <div className="px-3 pb-2 text-[10px] leading-relaxed text-muted-foreground">
            距到期 ≤{view.critical_days} 天为临期（不新开当月，改推次月），
            {view.critical_days + 1}~{view.warning_days} 天为临近（留意 Theta 加速）。
          </div>
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
      <span className="truncate text-xs text-muted-foreground"><Tip label={label} /></span>
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
  const [side, setSide] = useState<"all" | "call" | "put">("all");
  const all = candidates ?? [];
  const callN = all.filter((c) => c.type === "call").length;
  const putN = all.filter((c) => c.type === "put").length;
  const shown = side === "all" ? all : all.filter((c) => c.type === side);
  const opts: { key: "all" | "call" | "put"; label: string; tone?: string; n: number }[] = [
    { key: "all", label: "全部", n: all.length },
    { key: "call", label: "认购", tone: "text-up", n: callN },
    { key: "put", label: "认沽", tone: "text-down", n: putN },
  ];
  return (
    <div className="flex flex-col gap-1" role="list">
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <div className="inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5">
          {opts.map((o) => (
            <button
              key={o.key}
              type="button"
              onClick={() => setSide(o.key)}
              aria-pressed={side === o.key}
              className={cn(
                "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                side === o.key ? "bg-background shadow-xs" : "text-muted-foreground hover:text-foreground",
                side === o.key && o.tone,
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
        <span className="text-[10px] text-muted-foreground tnum">
          全部 {all.length} · 认购 {callN} · 认沽 {putN}
        </span>
      </div>
      {shown.length === 0 ? (
        <EmptyState
          title={side === "all" ? "暂无优选合约" : `当前无${side === "call" ? "认购" : "认沽"}合约`}
          hint={side === "all" ? "期权链未返回可用报价或 Delta" : "切换到其他档位查看"}
        />
      ) : null}
      {shown.map((c, i) => (
        <button
          key={c.code}
          type="button"
          role="listitem"
          aria-current={c.secid === selected ? "true" : undefined}
          onClick={() => onSelect(c)}
          className={cn(
            "flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-2 text-left transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            c.secid === selected ? "border-primary bg-primary/12 ring-2 ring-inset ring-primary" : "hover:bg-muted/40",
          )}
        >
          <span className="w-4 shrink-0 text-center text-xs text-muted-foreground tnum" aria-hidden>{i + 1}</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium">{c.name}</div>
            <div className="text-xs leading-tight text-muted-foreground tnum">
              {c.code} · <Tip label={`Δ${nf(c.delta, 2)}`} tip={GLOSSARY["Delta"]} />
              {" · "}<Tip label={`Γ${gamma(c.gamma)}`} tip={GLOSSARY["Gamma"]} />
              {" · "}<Tip label={`IV${c.iv == null ? "—" : `${c.iv}%`}`} tip={GLOSSARY["IV"]} />
              {" · "}<Tip label={`溢价${c.premium_rate == null ? "—" : `${c.premium_rate}%`}`} tip={GLOSSARY["溢价率"]} />
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

/* ---------------- 跨标的优选（全市场 9 标的横评） ---------------- */
export function TopPicksList({
  items, onSelect, selectedSecid, loading,
}: {
  items: any[];
  onSelect: (p: any) => void;
  selectedSecid?: string | null;
  loading?: boolean;
}) {
  if (loading) return <CandidateSkeleton />;
  if (!items?.length) {
    return <EmptyState title="暂无跨标的优选" hint="等待期权链与方向数据返回（约 30 秒）" />;
  }
  return (
    <div className="flex flex-col gap-1" role="list">
      {items.map((p) => {
        const dir = DIR[(p.direction === "call" || p.direction === "put" ? p.direction : "neutral") as Dir];
        // 方向观望时只表示「按涨跌择边」，别把中性标的写成看多/看空
        const dirLabel = p.direction === "call" ? "看多" : p.direction === "put" ? "看空"
          : p.side === "call" ? "观望·偏多" : "观望·偏空";
        const eff = (p.leverage || 0) * Math.abs(p.delta || 0);
        return (
          <button
            key={`${p.etf_code}-${p.secid}`}
            type="button"
            role="listitem"
            aria-current={p.secid === selectedSecid ? "true" : undefined}
            onClick={() => onSelect(p)}
            title={(p.reasons || []).join("；")}
            className={cn(
              "flex items-center gap-2 rounded-md border border-border/60 px-2.5 py-2 text-left transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              p.secid === selectedSecid ? "border-primary bg-primary/12 ring-2 ring-inset ring-primary" : "hover:bg-muted/40",
            )}
          >
            <span className="w-4 shrink-0 text-center text-xs text-muted-foreground tnum" aria-hidden>{p.rank}</span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-xs font-medium">{p.etf_name}</span>
                <Badge variant={dir.variant} className="shrink-0" title="该标的当前综合方向；观望时按涨跌择边">{dirLabel}</Badge>
                <span className="text-[10px] text-muted-foreground tnum">{p.etf_code}</span>
              </div>
              <div className="truncate text-[11px] text-muted-foreground tnum">{p.name}</div>
              <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[10px] tnum">
                <span className="rounded bg-primary/10 px-1 text-primary" title="综合分 = 性价比×0.6 + 波动×0.4">综合 {p.pick_score}</span>
                <span className="rounded bg-muted px-1 text-muted-foreground" title="性价比：与单标的优选同一套打分（流动性/期望收益/Δ/Theta/IV/溢价…）">性价比 {p.quality}</span>
                <span className="rounded bg-warning/15 px-1 text-warning" title="波动分：有效杠杆（|Δ|×标的价/权利金）+ 合约当日涨幅 + 标的日内振幅">波动 {p.vol}</span>
              </div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-xs font-medium tnum">{nf(p.last, 4)}</div>
              <div className={cn("text-xs tnum", clsUpDown(p.pct))}>{pct(p.pct)}</div>
              <div className="text-[10px] text-muted-foreground tnum" title="有效杠杆：标的涨 1% 时合约约涨多少">
                ×{nf(eff, 1)}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

/* ---------------- T 型报价 ---------------- */
export function OptionTQuote({
  chain, month, onMonth, selectedSecid, onSelect, cacheTag, loading,
}: {
  chain: any;
  month: number | null;
  onMonth: (m: number) => void;
  loading?: boolean;
  selectedSecid?: string;
  onSelect: (c: any) => void;
  cacheTag?: ReactNode;
}) {
  const tq = chain?.t_quote;
  const expiries = chain?.expiries ?? [];
  // 20 列默认铺开，横向会超出容器：打开时自动滚到中间，让平值附近（最常看的行权价）
  // 落在视野中央，而不是停在最左边那堆虚值认购上。
  const [compact, setCompact] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rowCount = (chain?.t_quote?.rows ?? []).length;
  useEffect(() => {
    const box = scrollRef.current?.firstElementChild as HTMLElement | null;
    if (box) box.scrollLeft = Math.max(0, (box.scrollWidth - box.clientWidth) / 2);
  }, [rowCount, month, compact]);
  if (!chain || chain.error) return <div className="p-4 text-xs text-muted-foreground">加载中…</div>;
  const callOrder = compact ? ORDER.callComfort : ORDER.call;
  const putOrder = compact ? ORDER.putComfort : ORDER.put;
  // 历史波/无风险利率是标的级口径，整张表共用一份（列定义里以 ctx 传入）。
  const colCtx = { rv: chain.rv20, rf: chain.risk_free_rate };
  const s = chain.underlying?.price ?? 0;
  const rows: any[] = tq?.rows ?? [];
  const best = chain.best;
  const callPick = best?.call;
  const putPick = best?.put;
  const pickOf = (c: any): "call" | "put" | undefined => {
    if (!c) return undefined;
    if (callPick?.secid === c.secid) return "call";
    if (putPick?.secid === c.secid) return "put";
    return undefined;
  };
  const pickContract = (c: any) => {
    if (!c) return;
    onSelect(c);
    if (month != null && c.month != null && month !== c.month) onMonth(c.month);
  };
  // 近月剩余天数（expiry_list 按天数升序，首个即近月）
  const expiryDays = chain.expiry_list?.[0]?.days ?? null;
  // 最接近当前标的价格的那一档行权价（单一行）→ 特殊色标记
  const atmStrike = rows.length
    ? rows.reduce((best: number, r: any) => (Math.abs(r.strike - s) < Math.abs(best - s) ? r.strike : best), rows[0].strike)
    : null;
  return (
    <div className={cn("flex flex-col transition-opacity duration-200", loading && "pointer-events-none opacity-60")} aria-busy={loading || undefined}>
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2 px-1 pb-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-xs font-semibold">
            {chain.etf?.name}{chain.underlying?.kind === "index" ? "" : " 期权链"}
          </span>
          {cacheTag}
          {loading && (
            <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground" role="status">
              <Loader2 className="size-3 animate-spin" aria-hidden />
              切换中…
            </span>
          )}
          <span className="shrink-0 text-xs text-muted-foreground tnum">标的 {nf(s, chain.underlying?.kind === "index" ? 2 : 3)}（{pct(chain.underlying?.pct)}）</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            <Tip label={`ATM IV ${chain.stats?.atm_iv ?? "—"}%`} tip={GLOSSARY["ATM IV"]} />
            {chain.stats?.atm_iv_pctl20 != null && (
              <>{" · "}<Tip label={`20日分位 ${Math.round(chain.stats.atm_iv_pctl20)}%`} tip={GLOSSARY["IV 分位"]} /></>
            )}
            {" · "}<Tip label={`偏斜 ${chain.stats?.skew ?? "—"}`} tip={GLOSSARY["偏斜"]} />
            {" · "}<Tip label={`PCR ${chain.stats?.pcr ?? "—"}`} tip={GLOSSARY.PCR} />
            {expiryDays != null && expiryDays < 7 && (
              <span className="ml-1 font-semibold text-warning"><AutoTip text={`距到期${expiryDays}天·Theta衰减快`} /></span>
            )}
          </span>
          <div className="inline-flex items-center rounded-lg bg-muted p-0.5" role="group" aria-label="列显示模式">
            {[{ dense: false, label: "全部列" }, { dense: true, label: "精简" }].map((o) => (
              <button
                key={o.label}
                type="button"
                onClick={() => setCompact(o.dense)}
                aria-pressed={compact === o.dense}
                className={cn(
                  "rounded-md px-2 py-0.5 text-[11px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  compact === o.dense ? "bg-background shadow-xs" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
          <Tabs tabs={expiries.map((m: number) => ({ key: String(m), label: `${m}月` }))} value={String(month)} onChange={(k) => onMonth(Number(k))} />
        </div>
      </div>
      {best && (callPick || putPick) && (
        <div className="mx-1 mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-md border border-border/60 bg-muted/25 px-2 py-1.5 text-[11px]">
          <span className="text-muted-foreground">
            标的趋势{" "}
            <span className={cn("font-semibold",
              best.trend?.direction === "call" ? "text-up" : best.trend?.direction === "put" ? "text-down" : "text-foreground")}>
              {best.trend?.label ?? "—"}
            </span>
            {best.trend?.strength != null && (
              <span className="ml-1 tnum">强度 {Math.round(best.trend.strength * 100)}%</span>
            )}
          </span>
          {callPick && (
            <button
              type="button"
              onClick={() => pickContract(callPick)}
              title={callPick.reasons?.join(" · ")}
              className="inline-flex items-center gap-1 rounded border border-up/35 bg-up/10 px-1.5 py-0.5 text-up transition-colors hover:bg-up/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Star className="size-3 shrink-0" aria-hidden />
              <span className="text-muted-foreground">多头首选</span>
              <span className="font-semibold">{callPick.name}</span>
              <span className="rounded bg-up/20 px-1 font-semibold tnum">{callPick.score}</span>
            </button>
          )}
          {putPick && (
            <button
              type="button"
              onClick={() => pickContract(putPick)}
              title={putPick.reasons?.join(" · ")}
              className="inline-flex items-center gap-1 rounded border border-down/35 bg-down/10 px-1.5 py-0.5 text-down transition-colors hover:bg-down/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Star className="size-3 shrink-0" aria-hidden />
              <span className="text-muted-foreground">空头首选</span>
              <span className="font-semibold">{putPick.name}</span>
              <span className="rounded bg-down/20 px-1 font-semibold tnum">{putPick.score}</span>
            </button>
          )}
          <span className="ml-auto text-[10px] text-muted-foreground">红=认购首选 · 绿=认沽首选</span>
        </div>
      )}
      <div className="max-h-[62vh] overflow-auto" ref={scrollRef}>
        <Table>
          <THead>
            <TR>
              <TH colSpan={callOrder.length} className="text-center text-up">认购 Call</TH>
              <TH className="text-center">行权价</TH>
              <TH colSpan={putOrder.length} className="text-center text-down">认沽 Put</TH>
            </TR>
            <TR>
              {callOrder.map((k) => (k === "name" ? <TH key={k}>名称</TH> : <HelpTh key={k} col={COL_OF[k]} />))}
              <TH className="text-center">K</TH>
              {putOrder.map((k) => (k === "name"
                ? <TH key={k} className="text-right">名称</TH>
                : <HelpTh key={k} col={COL_OF[k]} />))}
            </TR>
          </THead>
          <TBody>
            {rows.map((row: any) => {
              const c = row.call, p = row.put;
              const isAtm = row.strike === atmStrike;
              // 整行可点：按点击落在认购/认沽哪一侧决定选哪只（行权价列本身不响应）
              const onRowClick = (e: React.MouseEvent<HTMLTableRowElement>) => {
                const td = (e.target as HTMLElement).closest("td");
                if (!td) return;
                const idx = (td as HTMLTableCellElement).cellIndex;
                const callN = callOrder.length;
                if (idx < callN && c) pickContract(c);
                else if (idx > callN && p) pickContract(p);
              };
              return (
                <TR key={row.strike}
                  onClick={onRowClick}
                  className={cn(
                    "cursor-pointer",
                    // 选中不再给整行上色（只框选中合约所在的那半侧，见 ContractCells）
                    isAtm && "bg-warning/15 ring-1 ring-inset ring-warning/40",
                  )}>
                  <ContractCells c={c} order={callOrder} ctx={colCtx} selected={selectedSecid} onSelect={onSelect} align="left" pick={pickOf(c)} />
                  <TD className={cn("text-center font-semibold tnum", isAtm && "bg-warning/20 text-warning-foreground")}>
                    {row.strike.toFixed(3)}
                  </TD>
                  <ContractCells c={p} order={putOrder} ctx={colCtx} selected={selectedSecid} onSelect={onSelect} align="right" pick={pickOf(p)} />
                </TR>
              );
            })}
          </TBody>
        </Table>
      </div>
    </div>
  );
}

function ContractCells({ c, order, ctx, selected, onSelect, align, pick }: {
  c: any; order: string[]; ctx: { rv: any; rf: any };
  selected?: string; onSelect: (c: any) => void; align: "left" | "right";
  pick?: "call" | "put";
}) {
  if (!c) return <TD colSpan={order.length} className="text-center text-muted-foreground">—</TD>;
  const on = c.secid === selected;
  const n = order.length;
  // name 在 call/put/comfort 四种列序里的位置都不同，按实际下标算边框
  const nameIdx = order.indexOf("name");
  // 选中框只框**这一侧**的单元格组（名称…K），中间的行权价列归两侧共用、不框。
  // 用内阴影画 2px 边而不是 border：border 会改变行高，来回切合约时整张表上下跳。
  const selStyle = (i: number) => (on ? {
    boxShadow: [
      i === 0 ? "inset 2px 0 0 0 var(--primary)" : null,
      i === n - 1 ? "inset -2px 0 0 0 var(--primary)" : null,
      "inset 0 2px 0 0 var(--primary)",
      "inset 0 -2px 0 0 var(--primary)",
    ].filter(Boolean).join(", "),
  } : undefined);
  const selCls = on ? "sel-cell" : "";
  // 首选合约：认购用红、认沽用绿，整侧单元格铺底色，与 ATM 的琥珀色区分
  const pickCls = pick === "call" ? "bg-up/10" : pick === "put" ? "bg-down/10" : "";
  const name = (
    <TD key="name" style={selStyle(nameIdx)} className={cn("p-0", selCls, pickCls, align === "right" && "text-right")}>
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
        {pick === "put" && (
          <span className={cn(
            "shrink-0 rounded px-1 text-[9px] font-semibold leading-4",
            "bg-down/20 text-down",
          )}>
            首选
          </span>
        )}
        <span className={cn("truncate", pick === "call" && "text-up", pick === "put" && "text-down")}>{c.name}</span>
        {pick === "call" && (
          <span className={cn(
            "shrink-0 rounded px-1 text-[9px] font-semibold leading-4",
            "bg-up/20 text-up",
          )}>
            首选
          </span>
        )}
      </button>
    </TD>
  );
  return (
    <>
      {order.map((k, i) => {
        if (k === "name") return name;
        const col = COL_OF[k];
        return (
          <TD key={k} style={selStyle(i)}
            className={cn("text-right whitespace-nowrap tnum text-muted-foreground", pickCls, selCls,
              k === "last" && "text-foreground", on && k === "last" && "font-bold")}
            title={col.label}>
            {col.get(c, ctx)}
          </TD>
        );
      })}
    </>
  );
}
