import ReactECharts from "echarts-for-react";
import { Maximize2, Minimize2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { alignToAxis, minuteOf, sameDayAs, trimSession } from "@/lib/series";
import { signedMoney, signedYi } from "@/lib/format";
import { cn } from "@/lib/utils";

const AXIS = "#71717a";
const SPLIT = "rgba(0,0,0,0.07)";
const UP = "#ef4444";
const DOWN = "#16a34a";

// 图线开关的色带（与图上的线同色，靠颜色而不是文字记住对应关系）
const SWATCH_LEVELS = { background: "linear-gradient(90deg,#ef4444 50%,#16a34a 50%)" };
const SWATCH_PLAN = { background: "linear-gradient(90deg,#f59e0b,#ef4444,#16a34a)" };
const SWATCH_BREAKEVEN = { background: "#a855f7" };

/** 布尔开关的 localStorage 持久化：合约图三组横线的显隐要跨刷新保留。 */
function useStoredBool(key: string, initial: boolean) {
  const [on, setOn] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(key);
      return v == null ? initial : v === "1";
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, on ? "1" : "0");
    } catch {
      /* 隐私模式忽略 */
    }
  }, [key, on]);
  return [on, setOn] as const;
}

/**
 * 图线开关。**常驻不卸载**：数据没到/被关掉时只置灰（disabled），
 * 不改变布局位置——每来一次数据就多出一排按钮会让整张图上下跳。
 */
export function LineToggle({
  label, title, swatch, active, disabled = false, onToggle,
}: {
  label: string;
  title?: string;
  swatch?: { background: string };
  active: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      disabled={disabled}
      title={disabled ? "等待点位数据" : title ?? (active ? "点击隐藏" : "点击显示")}
      className={cn(
        "flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] leading-tight transition-colors",
        disabled
          ? "cursor-not-allowed border-transparent text-muted-foreground/35"
          : active
            ? "border-border bg-card text-foreground shadow-xs"
            : "border-transparent text-muted-foreground/50",
      )}
    >
      <span className="inline-block h-0.5 w-3.5 rounded-full" style={swatch} aria-hidden />
      {label}
    </button>
  );
}

const base = {
  backgroundColor: "transparent",
  animation: false,
  textStyle: { color: AXIS, fontSize: 11 },
  grid: { left: 48, right: 48, top: 22, bottom: 46 },
  tooltip: {
    trigger: "axis",
    backgroundColor: "rgba(255,255,255,0.98)",
    borderColor: "rgba(0,0,0,0.12)",
    borderWidth: 1,
    textStyle: { color: "#18181b", fontSize: 11 },
    extraCssText: "box-shadow:0 4px 16px rgba(0,0,0,0.12);border-radius:8px;",
    axisPointer: { type: "cross", label: { backgroundColor: "#e4e4e7", color: "#18181b" } },
  },
  xAxisBase: {
    type: "category",
    boundaryGap: false,
    axisLine: { lineStyle: { color: SPLIT } },
    axisLabel: { color: AXIS, hideOverlap: true },
    splitLine: { show: false },
  },
  yAxisBase: {
    type: "value",
    scale: true,
    axisLine: { show: false },
    axisLabel: { color: AXIS },
    splitLine: { lineStyle: { color: SPLIT } },
  },
};

/** ETF 分时：右轴涨跌幅%（标的ETF 与关联指数共用）+ 右轴主力净流入（标的线/指数柱）。 */
export function IntradayChart({
  trends, indexTrends = [], indexName = "", flow, indexFlow = [], height = 240, title, id, signals = [],
  prevClose = null, indexPrevClose = null, name = "标的ETF", support = [], resistance = [],
  plan = null, showLevels = true, showPlan = true,
}: {
  trends: any[];
  indexTrends?: any[];
  indexName?: string;
  flow: any[];
  indexFlow?: any[];
  height?: number;
  title?: string;
  id?: string;
  signals?: any[];
  prevClose?: number | null;
  indexPrevClose?: number | null;
  name?: string;
  support?: number[];
  resistance?: number[];
  plan?: any;
  showLevels?: boolean;
  showPlan?: boolean;
}) {
  const [legendSel, legendEvents] = useLegendSelected();
  const option = useMemo(() => {
    const tt = (t: any) => (t || "").slice(-5);
    // 轴由完整行情序列定义（腾讯分时），并裁掉盘前/午休/15:00 后的脏点。
    const axis = trimSession(trends);
    const times = axis.map((t) => minuteOf(t.time));
    const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

    // 昨收 -> 百分比。缺昨收则该条线整条不画（与 OverlayChart 口径一致）。
    const mapSrc = (arr: any[]) => new Map(sameDayAs(axis, arr).map((t) => [tt(t.time), t.price]));
    const toPctSeries = (m: Map<any, any>, prev: number | null) => {
      if (!prev || !(prev > 0)) return null;
      const out: (number | null)[] = times.map((t) => {
        const p = m.get(t);
        return p != null && isFinite(Number(p)) ? ((Number(p) - prev) / prev) * 100 : null;
      });
      return out.some((v) => v !== null) ? out : null;
    };
    const etfPct = toPctSeries(mapSrc(trends), prevClose ?? null);
    const idxPct = toPctSeries(mapSrc(indexTrends), indexPrevClose ?? null);
    // 标的ETF 与关联指数共用一根 % 轴：两者涨跌幅天然同量纲（今日实测 -1.21% vs -1.23%），
    // 同轴才能真实反映相对强弱；若各占一根轴，同一水平线会代表不同百分比，产生隐性误读。
    // 最小带宽兜底：防横盘把噪声放大成假波动、也防极值为 0 时轴退化。
    const MIN_SPAN = 0.5;
    // 关键位/计划横线是绝对价格，图上画的是百分比：先换算再并入轴域，
    // 否则横线落在视野之外；顺带留 12% 余量，避免横线贴边被裁掉。
    const pctOf = (px: number, prev: number | null) =>
      prev && prev > 0 ? ((px - prev) / prev) * 100 : null;
    const lineOf = (px: any, color: string, label: string, solid = false) => {
      const y = pctOf(Number(px), prevClose ?? null);
      if (y == null || !isFinite(y)) return null;
      return {
        yAxis: y,
        lineStyle: { color, type: solid ? ("solid" as const) : ("dashed" as const), width: solid ? 1.1 : 1 },
        label: {
          show: true, position: solid ? ("insideStartTop" as const) : ("insideEndTop" as const),
          color, fontSize: 10,
          formatter: `${label} ${Number(px) >= 1 ? Number(px).toFixed(3) : Number(px).toFixed(4)}`,
        },
      };
    };
    const levelLines = showLevels
      ? [
        ...(resistance ?? []).filter((v) => isFinite(Number(v)) && Number(v) > 0)
          .slice(0, 2).map((v) => lineOf(v, UP, "压力")),
        ...(support ?? []).filter((v) => isFinite(Number(v)) && Number(v) > 0)
          .slice(0, 2).map((v) => lineOf(v, DOWN, "支撑")),
      ].filter(Boolean)
      : [];
    const planLines = showPlan && plan
      ? ([["入场", plan.entry, "#f59e0b"], ["止盈", plan.target, UP], ["止损", plan.stop, DOWN]] as const)
        .filter(([, v]) => v != null && isFinite(Number(v)) && Number(v) > 0)
        .map(([lbl, v, color]) => lineOf(Number(v), color as string, lbl, true))
        .filter(Boolean)
      : [];
    const extraLines = [...levelLines, ...planLines];
    const symRange = (arrs: ((number | null)[] | null)[]) => {
      const vals: number[] = [];
      arrs.forEach((a) => (a ?? []).forEach((v) => { if (v !== null && isFinite(v)) vals.push(Math.abs(v)); }));
      const lv = extraLines.map((l: any) => Math.abs(l.yAxis)).filter((v) => isFinite(v));
      const m = Math.max(MIN_SPAN, ...vals, ...(lv.length ? [Math.max(...lv) * 1.12] : []));
      return { min: -m, max: m, scale: false as const };
    };
    const range = symRange([etfPct, idxPct]);

    const zeroLine = {
      silent: true, symbol: "none" as const,
      lineStyle: { color: "#a1a1aa", type: "dashed" as const, width: 1 },
      label: { show: false }, data: [{ yAxis: 0 }],
    };

    // 变盘信号三角：系列已换成百分比，坐标 y 必须同步换算，否则所有标记垂直错位。
    const sigSrc: (number | null)[] = etfPct ?? [];
    const sigPts = etfPct
      ? (signals ?? []).map((s: any) => {
        const hm = (s.ts || "").slice(11, 16);
        if (!hm || times.length === 0) return null;
        const target = toMin(hm);
        let best = 0, bestDiff = 1e9;
        times.forEach((t, i) => {
          const d = Math.abs(toMin(t) - target);
          if (d < bestDiff) { bestDiff = d; best = i; }
        });
        if (bestDiff > 10 || sigSrc[best] == null) return null;
        const bull = s.dir === "bull";
        return {
          coord: [times[best], sigSrc[best]],
          value: (bull ? "多" : "空") + Math.round(s.score ?? 0),
          itemStyle: { color: bull ? "#ef4444" : "#16a34a" },
          symbolRotate: bull ? 0 : 180,
        };
      }).filter(Boolean)
      : [];

    // 资金流与行情的时间戳口径不同（首点 09:31/13:01、只到 15:00），
    // 一律按「最近前值」对齐，不能再用 HH:MM 精确相等 join。
    const mains = alignToAxis(axis, flow, (f: any) => f.main);
    const imains = alignToAxis(axis, indexFlow, (f: any) => f.main);
    const hasIdx = !!idxPct;
    const hasIdxFlow = imains.some((v) => v !== null);
    const idxLabel = `关联指数${indexName ? " " + indexName : ""}`;
    return {
      ...base,
      grid: { left: 52, right: 56, top: 24, bottom: 34 },
      legend: {
        top: 0, left: 6, itemWidth: 12, itemHeight: 8, itemGap: 10,
        textStyle: { color: AXIS, fontSize: 10 },
        selected: legendSel,
        data: [...(etfPct ? [name] : []), ...(hasIdx ? [idxLabel] : []), "标的主力净流入", ...(hasIdxFlow ? ["指数主力净流入"] : [])],
      },
      tooltip: {
        ...base.tooltip,
        formatter: (ps: any) => {
          const arr = Array.isArray(ps) ? ps : [ps];
          const head = arr[0]?.axisValueLabel ?? arr[0]?.name ?? "";
          const body = arr.map((p: any) => {
            const n = Number(p.value);
            let val = "—";
            if (p.value !== null && p.value !== undefined && isFinite(n)) {
              // 价格系列已是百分比；资金仍是金额（元），保持「万」口径
              const isFlow = p.seriesName === "标的主力净流入" || p.seriesName === "指数主力净流入";
              val = isFlow ? `${Math.round(n / 1e4)}万` : `${n.toFixed(2)}%`;
            }
            return `${p.marker}${p.seriesName} <b>${val}</b>`;
          }).join("<br/>");
          return `${head}<br/>${body}`;
        },
      },
      xAxis: { ...base.xAxisBase, data: times },
      yAxis: [
        // 0 左：涨跌幅 %（标的ETF 与关联指数共用）。悬浮时轴标签换成价格，
        //    用户关心的是「这条线现在多少钱」，而不是 1.23%。
        { ...base.yAxisBase, position: "left", ...range,
          axisLabel: { color: AXIS, formatter: (v: number) => `${v.toFixed(2)}%` },
          axisPointer: { label: { formatter: (p: any) => {
            const v = Number(p?.value);
            if (!prevClose || !isFinite(v)) return `${v.toFixed(2)}%`;
            return (prevClose * (1 + v / 100)).toFixed(prevClose >= 10 ? 2 : 3);
          } } } },
        // 1 右：标的ETF 价格（与左轴同一像素映射，只是把刻度换成绝对价）
        { ...base.yAxisBase, position: "right", splitLine: { show: false }, scale: false,
          ...(prevClose && prevClose > 0
            ? { min: prevClose * (1 + (range as any).min / 100), max: prevClose * (1 + (range as any).max / 100) }
            : {}),
          axisLabel: { color: AXIS, formatter: (v: number) => v.toFixed(v >= 10 ? 2 : 3) } },
        // 2 右：标的 ETF 主力净流入（线）
        { ...base.yAxisBase, position: "right", splitLine: { show: false }, axisLabel: { show: false },
          axisPointer: { label: { show: false } } },
        // 3 右：关联指数 主力净流入（柱）
        { ...base.yAxisBase, position: "right", splitLine: { show: false }, axisLabel: { show: false },
          axisPointer: { label: { show: false } } },
      ],
      series: [
        { name, type: "line", yAxisIndex: 0, data: etfPct ?? [], showSymbol: false, connectNulls: false,
          lineStyle: { width: 1.4, color: "#60a5fa" }, areaStyle: { color: "rgba(96,165,250,0.08)" },
          ...(etfPct ? { markLine: { ...zeroLine, data: [...zeroLine.data, ...extraLines] } } : {}),
          ...(sigPts.length ? { markPoint: {
            symbol: "triangle", symbolSize: 11,
            label: {
              fontSize: 10, fontWeight: 700, color: "#18181b",
              position: "top", distance: 5,
              backgroundColor: "#ffffff", borderColor: "rgba(0,0,0,0.15)", borderWidth: 1,
              padding: [1, 3], borderRadius: 3,
            },
            data: sigPts,
          } } : {}), },
        { name: idxLabel, type: "line", yAxisIndex: 0, data: idxPct ?? [], showSymbol: false, connectNulls: false,
          lineStyle: { width: 1.3, color: "#d97706", type: "dashed" },
          ...(!etfPct && idxPct ? { markLine: zeroLine } : {}) },
        { name: "标的主力净流入", type: "line", yAxisIndex: 2, data: mains, showSymbol: false,
          lineStyle: { width: 1.3, color: "#7c3aed" } },
        { name: "指数主力净流入", type: "bar", yAxisIndex: 3, data: imains, barWidth: "55%",
          itemStyle: { color: (p: any) => (p.value >= 0 ? "rgba(239,68,68,0.5)" : "rgba(34,197,94,0.5)") } },
      ],
    };
  }, [trends, indexTrends, indexName, flow, indexFlow, signals, prevClose, indexPrevClose, name, support, resistance, plan, showLevels, showPlan, legendSel]);
  return <ReactECharts key={id} option={option} notMerge onEvents={legendEvents} style={{ height }} />;
}

/**
 * 图例选中态。`notMerge` 更新会把 ECharts 内部的 `legend.selected` 重置成"全显示"，
 * 用户点了图例隐藏某条线，下一帧就自己冒回来——所以选中态必须由 React 持有并回灌。
 */
function useLegendSelected() {
  const [sel, setSel] = useState<Record<string, boolean>>({});
  const handlers = useMemo(() => ({
    legendselectchanged: (e: any) => setSel(e.selected || {}),
  }), []);
  return [sel, handlers] as const;
}

/** 通用 K 线 + 量能。 */
export function KlineChart({ bars, height = 260, id }: { bars: any[]; height?: number; id?: string }) {
  const option = useMemo(() => {
    const data = bars ?? [];
    const cat = data.map((b) => (b.date?.length > 12 ? b.date.slice(5) : b.date));
    const k = data.map((b) => [b.open, b.close, b.low, b.high]);
    const vol = data.map((b, i) => ({ value: b.volume, itemStyle: { color: b.close >= b.open ? UP : DOWN } }));
    return {
      ...base,
      // 两套坐标轴必须配两个 grid（数组），否则 gridIndex:1 找不到 coordinateSystem 而报错
      grid: [
        { left: 46, right: 16, top: 14, height: "60%" },
        { left: 46, right: 16, top: "76%", height: "16%" },
      ],
      tooltip: { ...base.tooltip, formatter: undefined },
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      xAxis: [
        { ...base.xAxisBase, data: cat, gridIndex: 0, axisLabel: { color: AXIS, hideOverlap: true } },
        { ...base.xAxisBase, data: cat, gridIndex: 1, axisLabel: { show: false } },
      ],
      yAxis: [
        { ...base.yAxisBase, gridIndex: 0, axisLabel: { color: AXIS, formatter: (v: number) => v.toFixed(3) } },
        { ...base.yAxisBase, gridIndex: 1, splitLine: { show: false }, axisLabel: { color: AXIS, formatter: (v: number) => (v >= 1e4 ? (v / 1e4).toFixed(0) + "万" : v) } },
      ],
      dataZoom: [{ type: "inside", xAxisIndex: [0, 1] }],
      series: [
        { type: "candlestick", data: k, xAxisIndex: 0, yAxisIndex: 0,
          itemStyle: { color: UP, color0: DOWN, borderColor: UP, borderColor0: DOWN } },
        { type: "bar", data: vol, xAxisIndex: 1, yAxisIndex: 1, barWidth: "60%" },
      ],
    };
  }, [bars]);
  return <ReactECharts key={id} option={option} notMerge style={{ height }} />;
}

/** 合约分时叠加：期权涨跌幅（右轴 %）+ 标的ETF涨跌幅（独立右轴 %）+ 主力资金（柱，副轴）。
 *  两条价格线各自按昨收换算为百分比、各自 0 居中对称：若共用一根轴，期权（日内可达数十%）
 *  会把标的线压成一条贴着 0 的直线（实测标的 -1.21% vs 合约 -34.99%~+208.70%）。
 *  左轴已移除，右侧只显示期权 % 一列标签。
 */
export function OverlayChart({
  optTrends, etfTrends, flow, height = 300, id, optPrevClose = null, etfPrevClose = null,
  underName = "标的ETF", levels = null, breakEven = null, optDelta = null, optLast = null,
}: {
  optTrends: any[];
  etfTrends: any[];
  flow: any[];
  height?: number;
  id?: string;
  optPrevClose?: number | null;
  etfPrevClose?: number | null;
  underName?: string;
  levels?: { support?: number[]; resistance?: number[]; plan?: any } | null;
  breakEven?: number | null;
  optDelta?: number | null;
  /** 合约当前价：分时源完全断掉时作为合成走势的锚点 */
  optLast?: number | null;
}) {
  // 三组横线各自可开关；按钮常驻（数据没到就置灰），不会因为刷新而跳动或吞点击。
  // 状态持久化到 localStorage：否则刷新后全部复位，用户会以为「设置了不管用」。
  const [showLevels, setShowLevels] = useStoredBool("board.contract-levels", true);
  const [showPlan, setShowPlan] = useStoredBool("board.contract-plan", true);
  const [showBE, setShowBE] = useStoredBool("board.contract-breakeven", true);
  // 高度扩展：一键 ×2，和主图同一个交互
  const [expanded, setExpanded] = useState(false);
  const [legendSel, legendEvents] = useLegendSelected();
  const option = useMemo(() => {
    const norm = (t: any) => (t || "").slice(-5);
    // 轴优先用完整的 ETF 行情分时：期权/资金流都是本地累积的稀疏序列，
    // 让稀疏序列定义轴会把整张图压成残轴；它们只应被对齐到行情轴。
    const etfAxis = trimSession(etfTrends);
    const optAxis = trimSession(optTrends);
    const axis = etfAxis.length ? etfAxis : (optAxis.length ? optAxis : trimSession(flow));
    const times = axis.map((t: any) => norm(t.time));
    const optMap = new Map(sameDayAs(axis, optTrends).map((t) => [norm(t.time), t.price]));
    const etfMap = new Map(sameDayAs(axis, etfTrends).map((t) => [norm(t.time), t.price]));

    // 价格序列：缺值留 null（connectNulls=false 断开），绝不用 0 补点，避免伪线。
    const seriesFromMap = (m: Map<any, any>) => {
      const arr: (number | null)[] = times.map((t) => {
        const p = m.get(t);
        return p != null && isFinite(Number(p)) && Number(p) > 0 ? Number(p) : null;
      });
      return arr.some((v) => v !== null) ? arr : null;
    };
    // 分钟快照偶发缺几分钟（接口限流 / 翻页漏跑），`connectNulls: false` 会把
    // 合约线断成几段，看起来就是「价格显示不全」。缺口用前值补齐（分时图里没成交
    // 走平是标准画法）；超过 20 分钟的缺口保持断开——那是整段没数据，不该画假线。
    const fillShortGaps = (arr: (number | null)[] | null) => {
      if (!arr) return null;
      const out = [...arr];
      let last: number | null = null;
      let run = 0;
      for (let i = 0; i < out.length; i++) {
        if (out[i] != null) { last = out[i]; run = 0; continue; }
        if (last != null && run < 20) { out[i] = last; run++; } else { run++; }
      }
      return out;
    };
    const optPrice = fillShortGaps(seriesFromMap(optMap));
    const etfPrice = seriesFromMap(etfMap);
    // 期权分时偶尔只回 1 个点（冷门合约/盘前），showSymbol=false 会让它整条不可见，
    // 因此点数 ≤2 时临时露出数据点。
    const sparse = (a: (number | null)[] | null) => !!a && a.filter((v) => v !== null).length <= 2;
    // 资金流时间口径与行情不同（首点晚 1 分钟、只到 15:00），按最近前值对齐。
    const mains = alignToAxis(axis, flow, (f: any) => f.main);
    const hasFlow = mains.some((v) => v !== null);

    const fmtPrice = (v: number) => (Math.abs(v) >= 1 ? v.toFixed(3) : v.toFixed(4));
    const pctOf = (v: number, prev: number | null) =>
      prev && prev > 0 ? ((v - prev) / prev) * 100 : null;
    const fmtPct = (p: number | null) => (p == null ? "" : `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`);

    const zeroLine = {
      silent: true, symbol: "none" as const,
      lineStyle: { color: "#52525b", type: "dashed" as const, width: 1 },
      label: { show: false }, data: [{ yAxis: 0 }],
    };

    // 横线：关键位（虚线）与计划（实线）。价格与图上的价量级一致，不需要换轴。
    const lineAt = (v: number, color: string, label: string, solid = false) => ({
      yAxis: v,
      lineStyle: { color, type: solid ? ("solid" as const) : ("dashed" as const), width: solid ? 1.1 : 1 },
      label: {
        show: true, position: solid ? ("insideStartTop" as const) : ("insideEndTop" as const),
        color, fontSize: 10, formatter: `${label} ${fmtPrice(v)}`,
      },
    });
    const levelLines = showLevels
      ? [...(levels?.resistance ?? []).slice(0, 2).map((v) => lineAt(Number(v), UP, "压力")),
         ...(levels?.support ?? []).slice(0, 2).map((v) => lineAt(Number(v), DOWN, "支撑"))]
      : [];
    const planLines = showPlan && levels?.plan
      ? ([["入场", levels.plan.entry, "#f59e0b"], ["止盈", levels.plan.target, UP], ["止损", levels.plan.stop, DOWN]] as const)
        .filter(([, v]) => v != null && isFinite(Number(v)) && Number(v) > 0)
        .map(([lbl, v, color]) => lineAt(Number(v), color as string, lbl, true))
      : [];
    // 打和点（标的价口径）：只画在标的价轴上；离标的现价太远时剔除，
    // 否则会把标的轴拉到深虚值区间，合约线与资金流一起被压扁。
    const lastEtf = [...(etfPrice ?? [])].reverse().find((v) => v != null) ?? null;
    const beLines = showBE && breakEven != null && Number(breakEven) > 0
      ? [lineAt(Number(breakEven), "#a855f7", "打和点(标的)")]
        .filter((l) => lastEtf == null || Math.abs(l.yAxis / lastEtf - 1) <= 0.15)
      : [];

    // Δ 折算合成走势：期权日内稀疏（或分时源完全断掉）时，用「合约现价 + Δ × 标的变动」
    // 外推一条参考轨迹，让合约图永远有曲线可看（虚线，与真实价格区分）。
    const synth = (() => {
      if (!etfPrice || !optDelta) return null;
      const have = optPrice ? optPrice.filter((v) => v != null).length : 0;
      if (have / Math.max(1, times.length) >= 0.5) return null;
      // 锚点：优先真实分时的最后一点，没有分时时用合约当前价（optLast）
      const lastOpt = [...(optPrice ?? [])].reverse().find((v) => v != null) ?? optLast ?? null;
      const base = [...etfPrice].reverse().find((v) => v != null) ?? null;
      if (lastOpt == null || base == null) return null;
      const out = times.map((_, i) => {
        const e = etfPrice[i];
        return e == null ? null : Number((lastOpt + Number(optDelta) * (e - base)).toFixed(4));
      });
      return out.some((v) => v != null) ? out : null;
    })();

    // 合约价横线（支撑/压力、止盈止损）：**不依赖分时数据是否存在**——
    // 分时源断掉时 optPrice 为空，若把 markLine 挂在「合约价格」series 上，整组线会
    // 跟着消失，用户会以为开关坏了。
    const overLines = [...levelLines, ...planLines];
    // 合约轴跟横线走：计划/关键位落在轴外就看不见了，故并入轴域并留 3% 余量。
    const optAnchors = overLines.map((l) => l.yAxis).filter((v) => isFinite(v) && v > 0);
    const etfAnchors = beLines.map((l) => l.yAxis).filter((v) => isFinite(v));

    const legend = [
      ...(optPrice ? ["合约价格"] : []),
      ...(synth ? ["合成走势（Δ折算）"] : []),
      ...(etfPrice ? [`${underName}价格`] : []),
      ...(hasFlow ? [`${underName}主力净买额`] : []),
    ];
    return {
      ...base,
      grid: { left: 52, right: 56, top: 30, bottom: 40 },
      legend: {
        top: 2, textStyle: { color: AXIS }, itemWidth: 12, itemHeight: 8, itemGap: 10,
        selected: legendSel,
        data: legend,
      },
      tooltip: {
        ...base.tooltip,
        formatter: (ps: any) => {
          const arr = Array.isArray(ps) ? ps : [ps];
          const head = arr[0]?.axisValueLabel ?? arr[0]?.name ?? "";
          const rows: string[] = [];
          for (const p of arr) {
            const n = Number(p.value);
            const ok = p.value !== null && p.value !== undefined && isFinite(n);
            let val = "—";
            if (ok) {
              if (p.seriesName === `${underName}主力净买额`) {
                val = signedMoney(n);
              } else if (p.seriesName === "合约价格") {
                val = `${fmtPrice(n)} <span style="color:#71717a">${fmtPct(pctOf(n, optPrevClose ?? null))}</span>`;
              } else {
                val = `${fmtPrice(n)} <span style="color:#71717a">${fmtPct(pctOf(n, etfPrevClose ?? null))}</span>`;
              }
            }
            rows.push(`${p.marker}${p.seriesName} <b>${val}</b>`);
          }
          return `${head}<br/>${rows.join("<br/>")}`;
        },
      },
      xAxis: { ...base.xAxisBase, data: times },
      yAxis: [
        // 0 左：合约涨跌幅 %（刻度由合约价按昨收换算；悬浮横线显示合约价格本身）
        { ...base.yAxisBase, position: "left",
          axisLabel: { color: "#93c5fd", fontSize: 10,
            formatter: (v: number) => (optPrevClose && optPrevClose > 0
              ? `${((v / optPrevClose - 1) * 100).toFixed(1)}%`
              : fmtPrice(v)) },
          axisPointer: { label: { formatter: (p: any) => fmtPrice(Number(p?.value)) } },
          ...(optAnchors.length
            ? { min: (v: any) => Math.min(v.min, ...optAnchors) * 0.97, max: (v: any) => Math.max(v.max, ...optAnchors) * 1.03 }
            : {}) },
        // 1 右：标的ETF 价格（量级差得远，必须独立轴；现在显式显示刻度）
        { ...base.yAxisBase, position: "right", splitLine: { show: false },
          axisLabel: { color: AXIS, fontSize: 10, formatter: (v: number) => fmtPrice(v) },
          axisPointer: { label: { formatter: (p: any) => fmtPrice(Number(p?.value)) } },
          ...(etfAnchors.length
            ? { min: (v: any) => Math.min(v.min, ...etfAnchors) * 0.998, max: (v: any) => Math.max(v.max, ...etfAnchors) * 1.002 }
            : {}) },
        // 2 右：标的ETF 主力净买额（金额，独立轴；刻度隐藏）。min/max 强制含 0，
        // 否则轴域全为负时线会被裁到图外。axisPointer 标签也关掉——否则悬浮时
        // 右轴会飘出一个「-353,216,469.57」的金额，把真正的价格标签挤掉。
        { ...base.yAxisBase, position: "right", splitLine: { show: false }, axisLabel: { show: false },
          axisPointer: { label: { show: false } },
          min: (v: any) => Math.min(0, v.min), max: (v: any) => Math.max(0, v.max) },
      ],
      series: [
        // 资金流先画、价格线后画：保证两条价格线压在上层，不被资金线遮挡。
        ...(hasFlow ? [{ name: `${underName}主力净买额`, type: "line" as const, yAxisIndex: 2, data: mains,
          showSymbol: false, connectNulls: false, smooth: false, z: 1,
          lineStyle: { width: 1.2, color: "rgba(124,58,237,0.75)" },
          areaStyle: { color: "rgba(124,58,237,0.06)" },
          markLine: zeroLine }] : []),
        ...(etfPrice ? [{ name: `${underName}价格`, type: "line" as const, yAxisIndex: 1, data: etfPrice,
          showSymbol: sparse(etfPrice), symbolSize: 3, connectNulls: false, z: 5,
          lineStyle: { width: 1.3, color: "#9ca3af" },
          ...(beLines.length ? { markLine: { silent: true, symbol: "none" as const, data: beLines } } : {}) }] : []),
        // 合约价格 series 必须始终存在：它同时承载「支撑/压力 + 止盈止损」的 markLine，
        // 分时源断掉时用空 data 占位，横线照样画得出来、开关才真的有效。
        // 颜色比旧的 #2563eb 亮一档、线宽 2.4 + z:10 置顶——深色背景下旧配色几乎看不见。
        ...(optPrice || overLines.length ? [{ name: "合约价格", type: "line" as const, yAxisIndex: 0,
          data: optPrice ?? [],
          showSymbol: optPrice ? sparse(optPrice) : false, symbolSize: 3, connectNulls: false, z: 10,
          lineStyle: { width: 2.4, color: "#3b82f6" },
          ...(optPrice ? { areaStyle: { color: "rgba(59,130,246,0.06)" } } : {}),
          ...(overLines.length
            ? { markLine: { silent: true, symbol: "none" as const, data: overLines } }
            : {}) }] : []),
        ...(synth ? [{ name: "合成走势（Δ折算）", type: "line" as const, yAxisIndex: 0, data: synth,
          showSymbol: false, connectNulls: false, z: 3,
          lineStyle: { width: 1.2, color: "#93c5fd", type: "dashed" as const } }] : []),
      ],
    };
  }, [optTrends, etfTrends, flow, optPrevClose, etfPrevClose, underName, levels, breakEven, optDelta,
      optLast, showLevels, showPlan, showBE, legendSel]);
  const hasLevels = !!((levels?.resistance?.length ?? 0) + (levels?.support?.length ?? 0));
  const hasPlan = !!(levels?.plan && [levels.plan.entry, levels.plan.stop, levels.plan.target]
    .some((v: any) => v != null && isFinite(Number(v)) && Number(v) > 0));
  const hasBE = breakEven != null && Number(breakEven) > 0;
  return (
    <div>
      <div className="flex items-center justify-end gap-1 pb-1">
        <LineToggle label="支撑/压力" title="合约图：显示/隐藏支撑压力线" swatch={SWATCH_LEVELS}
          active={showLevels} disabled={!hasLevels} onToggle={() => setShowLevels((v) => !v)} />
        <LineToggle label="止盈/止损" title="合约图：入场/止盈/止损三条计划横线" swatch={SWATCH_PLAN}
          active={showPlan} disabled={!hasPlan} onToggle={() => setShowPlan((v) => !v)} />
        <LineToggle label="打和点" title="合约图：显示/隐藏打和点（标的价位）" swatch={SWATCH_BREAKEVEN}
          active={showBE} disabled={!hasBE} onToggle={() => setShowBE((v) => !v)} />
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-pressed={expanded}
          title={expanded ? "还原图表高度" : "图表高度 ×2"}
          className="rounded-md border border-border p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? <Minimize2 className="size-3" aria-hidden /> : <Maximize2 className="size-3" aria-hidden />}
        </button>
      </div>
      <ReactECharts key={id} option={option} notMerge onEvents={legendEvents}
        style={{ height: expanded ? height * 2 : height }} />
    </div>
  );
}

/** Kronos 预测：历史收盘 + 预测收盘路径（虚线）+ 预测高低带。 */
export function PredictChart({
  bars, pred, height = 220, id,
}: {
  bars: any[];
  pred: any;
  height?: number;
  id?: string;
}) {
  const option = useMemo(() => {
    const hist = (bars ?? []).slice(-60);
    const cat = hist.map((b) => b.date?.slice(5));
    const histClose = hist.map((b) => b.close);
    const rows = pred?.predictions ?? [];
    const predCat = rows.map((r: any) => r.date?.slice(5));
    const predClose = rows.map((r: any) => r.close);
    const predLow = rows.map((r: any) => r.low);
    const predHigh = rows.map((r: any) => r.high);
    const allCat = [...cat, ...predCat];
    const pad = (arr: number[], n: number) => new Array(n).fill(null).concat(arr);
    return {
      ...base,
      grid: { left: 48, right: 16, top: 24, bottom: 34 },
      legend: { top: 0, textStyle: { color: AXIS }, itemWidth: 12, itemHeight: 8 },
      xAxis: { ...base.xAxisBase, data: allCat },
      // 指数点位是四位数（6161.23），ETF 价是三位小数（4.065）：按数量级选位数，
      // 否则固定小数会把轴标签撑宽，48px 的轴被裁成「50.000」这种假刻度。
      yAxis: { ...base.yAxisBase, axisLabel: { color: AXIS, formatter: (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(3)) } },
      series: [
        { name: "历史", type: "line", data: histClose, showSymbol: false, lineStyle: { color: "#a1a1aa", width: 1.2 } },
        { name: "预测", type: "line", data: pad(predClose, cat.length), showSymbol: false,
          lineStyle: { color: "#a78bfa", width: 1.6, type: "dashed" } },
        { name: "预测上沿", type: "line", data: pad(predHigh, cat.length), showSymbol: false, lineStyle: { color: "rgba(167,139,250,0.35)", width: 1 } },
        { name: "预测下沿", type: "line", data: pad(predLow, cat.length), showSymbol: false, lineStyle: { color: "rgba(167,139,250,0.35)", width: 1 } },
      ],
    };
  }, [bars, pred]);
  return <ReactECharts key={id} option={option} notMerge style={{ height }} />;
}

/** 迷你走势（用于 ETF 列表行）——纯 SVG，无 ECharts 实例，避免列表频繁重绘时的生命周期问题。 */
export function Sparkline({ data, up, height = 24, width = 54 }: { data: number[]; up: boolean; height?: number; width?: number }) {
  const pts = (data || []).filter((v) => typeof v === "number" && isFinite(v));
  if (pts.length < 2) return <svg width={width} height={height} className="shrink-0" aria-hidden />;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const rng = max - min || 1;
  const step = width / (pts.length - 1);
  const color = up ? UP : DOWN;
  const line = pts.map((v, i) => `${(i * step).toFixed(1)},${(height - 2 - ((v - min) / rng) * (height - 4)).toFixed(1)}`).join(" ");
  const area = `0,${height} ${line} ${width},${height}`;
  return (
    <svg width={width} height={height} className="shrink-0" aria-hidden>
      <polygon points={area} fill={up ? "rgba(239,68,68,0.10)" : "rgba(22,163,74,0.10)"} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.3} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/** 板块资金多线图：统一时间轴、前值填充后的累计净流入（元 → 亿/万显示）。 */
export function MoneyLinesChart({
  id, axis, series, height = 320, maxLines = 8, mode = "line", vLines, showEndLabel = false,
}: {
  id: string;
  axis: string[];
  series: { code: string; name: string; values: (number | null)[]; watch?: boolean }[];
  height?: number | string;
  maxLines?: number;
  /** line=分线；stack=堆叠面积（4 维资金用） */
  mode?: "line" | "stack";
  /** 在这些 x 轴刻度上画竖向虚线（多日图用来分隔交易日） */
  vLines?: string[];
  /** 线末显示「名称 + 最新值」标签（多日图用，参考 stock-webui 右侧示例） */
  showEndLabel?: boolean;
}) {
  const colors = ["#ef4444", "#f59e0b", "#a855f7", "#3b82f6", "#14b8a6", "#ec4899", "#84cc16", "#f97316"];
  const shown = (series ?? []).slice(0, maxLines);
  const option = useMemo(() => ({
    animation: false,
    color: colors,
    grid: { left: 54, right: showEndLabel ? 220 : 12, top: 10, bottom: 26 },
    tooltip: {
      trigger: "axis",
      axisPointer: { type: "cross" },
      backgroundColor: "rgba(24,24,27,0.95)",
      borderColor: "rgba(255,255,255,0.12)",
      textStyle: { color: "#e4e4e7", fontSize: 11 },
      formatter: (ps: any[]) => {
        if (!ps?.length) return "";
        const head = `<div style="margin-bottom:4px">${ps[0].axisValue}</div>`;
        const rows = [...ps]
          .filter((p) => p.value != null)
          .sort((a, b) => (b.value as number) - (a.value as number))
          .map((p) => `<div style="display:flex;justify-content:space-between;gap:12px">
            <span>${p.marker}${p.seriesName}</span><span>${signedMoney(p.value)}</span></div>`)
          .join("");
        return head + rows;
      },
    },
    xAxis: {
      type: "category",
      data: axis,
      boundaryGap: false,
      axisLine: { lineStyle: { color: AXIS } },
      axisLabel: {
        color: AXIS, fontSize: 10, hideOverlap: true,
        // 多日模式：底部只按「日」显示（MM-DD），时间刻度交给日分隔虚线
        formatter: vLines?.length
          ? (v: string) => (vLines.includes(v) ? v.slice(0, 5) : "")
          : (v: string) => (["09:30", "10:30", "11:30", "14:00", "15:00"].includes(v) ? v : ""),
      },
    },
    yAxis: {
      type: "value",
      scale: true,
      axisLabel: { color: AXIS, fontSize: 10, formatter: (v: number) => signedMoney(v) },
      splitLine: { lineStyle: { color: "rgba(255,255,255,0.06)" } },
    },
    series: shown.map((s) => ({
      name: s.name,
      type: "line",
      showSymbol: false,
      smooth: false,
      connectNulls: false,
      ...(mode === "stack"
        ? { stack: "total", areaStyle: { opacity: 0.35 }, lineStyle: { width: 1 } }
        : { lineStyle: { width: s.watch ? 2.4 : 1.4 } }),
      data: s.values,
      ...(showEndLabel ? {
        endLabel: {
          show: true,
          distance: 6,
          fontSize: 10,
          fontWeight: "bold" as const,
          color: "#a1a1aa",
          formatter: (pp: any) => {
            const arr = pp.value as any;
            const v = Array.isArray(arr) ? arr[1] : arr;
            return `${s.name} ${signedYi(v)}`;
          },
        },
        labelLayout: { moveOverlap: "shiftY" as const },
      } : {}),
    })),
  }), [axis, shown, mode, vLines, showEndLabel]);

  // 日分隔线：只在第一条 series 上挂 markLine（避免重复绘制）
  const withDays = (opt: any) => {
    if (!vLines?.length || !opt.series?.length) return opt;
    opt.series[0].markLine = {
      symbol: "none",
      silent: true,
      // 日期只由 x 轴刻度显示；markLine 再标一次会在左下角与坐标轴标签重叠
      label: { show: false },
      lineStyle: { color: "rgba(228,228,231,0.55)", type: [5, 4], width: 1.5 },
      data: vLines.map((v) => ({ xAxis: v })),
    };
    return opt;
  };

  if (!axis.length) return null;
  return <ReactECharts key={id} option={withDays(option)} notMerge style={{ height }} />;
}

/** 板块资金详情：累计净流入折线 + 每分钟增量柱（同一时间轴，单位元）。 */
export function FlowDetailChart({
  id, axis, values, height = 220,
}: {
  id: string;
  axis: string[];
  values: (number | null)[];
  height?: number;
}) {
  const deltas = useMemo(() => (values || []).map((v, i) => {
    if (v == null) return null;
    const prev = i > 0 ? values[i - 1] : null;
    return prev == null ? 0 : v - prev;
  }), [values]);

  const option = useMemo(() => ({
    animation: false,
    grid: { left: 54, right: 10, top: 10, bottom: 22 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(24,24,27,0.95)",
      borderColor: "rgba(255,255,255,0.12)",
      textStyle: { color: "#e4e4e7", fontSize: 11 },
      formatter: (ps: any[]) => {
        if (!ps?.length) return "";
        const rows = ps.map((p) => `<div style="display:flex;justify-content:space-between;gap:12px">
          <span>${p.marker}${p.seriesName}</span><span>${signedMoney(p.value)}</span></div>`).join("");
        return `<div style="margin-bottom:4px">${ps[0].axisValue}</div>${rows}`;
      },
    },
    xAxis: {
      type: "category", data: axis, boundaryGap: true,
      axisLine: { lineStyle: { color: AXIS } },
      axisLabel: {
        color: AXIS, fontSize: 10, hideOverlap: true,
        formatter: (v: string) => (["09:30", "10:30", "11:30", "14:00", "15:00"].includes(v) ? v : ""),
      },
    },
    yAxis: {
      type: "value", scale: true,
      axisLabel: { color: AXIS, fontSize: 10, formatter: (v: number) => signedMoney(v) },
      splitLine: { lineStyle: { color: "rgba(255,255,255,0.06)" } },
    },
    series: [
      {
        name: "每分钟增量", type: "bar", data: deltas, barMaxWidth: 8,
        itemStyle: { color: (p: any) => ((p.value ?? 0) >= 0 ? "rgba(239,68,68,0.55)" : "rgba(22,163,74,0.55)") },
      },
      {
        name: "累计净流入", type: "line", data: values, showSymbol: false,
        lineStyle: { width: 1.8, color: UP }, itemStyle: { color: UP },
      },
    ],
  }), [axis, values, deltas]);

  if (!axis.length) return null;
  return <ReactECharts key={id} option={option} notMerge style={{ height }} />;
}

/** 近 N 日资金流柱状图（红=流入、绿=流出）。 */
export function FlowHistoryChart({
  id, dates, values, height = 150,
}: {
  id: string;
  dates: string[];
  values: number[];
  height?: number;
}) {
  const option = useMemo(() => ({
    animation: false,
    grid: { left: 54, right: 8, top: 8, bottom: 20 },
    tooltip: {
      trigger: "axis",
      backgroundColor: "rgba(24,24,27,0.95)",
      borderColor: "rgba(255,255,255,0.12)",
      textStyle: { color: "#e4e4e7", fontSize: 11 },
      formatter: (ps: any[]) => ps?.length
        ? `${ps[0].axisValue}<br/>${signedMoney(ps[0].value)}` : "",
    },
    xAxis: {
      type: "category", data: dates,
      axisLine: { lineStyle: { color: AXIS } },
      axisLabel: { color: AXIS, fontSize: 9, hideOverlap: true, formatter: (v: string) => v?.slice(5) },
    },
    yAxis: {
      type: "value", scale: true,
      axisLabel: { color: AXIS, fontSize: 9, formatter: (v: number) => signedMoney(v) },
      splitLine: { lineStyle: { color: "rgba(255,255,255,0.06)" } },
    },
    series: [{
      type: "bar", data: values, barMaxWidth: 14,
      itemStyle: { color: (p: any) => ((p.value ?? 0) >= 0 ? UP : DOWN) },
    }],
  }), [dates, values]);

  if (!dates.length) return null;
  return <ReactECharts key={id} option={option} notMerge style={{ height }} />;
}

/** 是否整点/半点（用于分时图的刻度与竖向参照线）。 */
const isHalfHour = (v: string) => /^\d{2}:(00|30)$/.test(v || "");

/** 资金分时色板（与 stock-webui 的 DISTINCT_COLORS 同思路：相邻颜色区分度足够）。 */
const FLOW_COLORS = [
  "#ef4444", "#3b82f6", "#f59e0b", "#10b981", "#a855f7", "#ec4899",
  "#14b8a6", "#f97316", "#6366f1", "#84cc16", "#06b6d4", "#e11d48",
  "#8b5cf6", "#22c55e", "#eab308", "#0ea5e9", "#d946ef", "#64748b",
];

export type FlowLine = {
  code: string;
  name: string;
  points: [string, number][];
  pct?: number | null;
  checked?: boolean;
};

/** 板块资金分时：多条线叠加，线末标签显示「名称 + 资金 + 涨跌幅」，悬停时其余线变淡。 */
export function BoardFlowChart({
  id, lines, hoverCode, temp, height = 420, onHoverCode, vLines,
}: {
  id: string;
  lines: FlowLine[];
  hoverCode?: string | null;
  temp?: FlowLine | null;
  height?: number | string;
  /** 鼠标直接落在曲线上时也切换聚焦（红涨绿跌分段） */
  onHoverCode?: (code: string | null) => void;
  /** 多日图：在这些刻度画竖向虚线做日分隔 */
  vLines?: string[];
}) {
  const option = useMemo(() => {
    const timeSet = new Set<string>();
    lines.forEach((l) => l.points.forEach(([t]) => timeSet.add(t)));
    if (temp) temp.points.forEach(([t]) => timeSet.add(t));
    const times = [...timeSet].sort();

    const toValues = (pts: [string, number][]) => {
      const map = new Map(pts);
      let last: number | null = null;
      return times.map((t) => {
        const v = map.get(t);
        if (v !== undefined) last = v;
        return last == null ? null : Math.round((last / 1e8) * 100) / 100;
      });
    };

    const many = lines.length > 40;
    const series: any[] = lines.map((l, i) => {
      const baseColor = FLOW_COLORS[i % FLOW_COLORS.length];
      const dim = hoverCode && hoverCode !== l.code;
      const focus = hoverCode === l.code;
      const last = l.points.length ? l.points[l.points.length - 1][1] : null;
      // 悬停时这条线会被「分段红绿」覆盖（见下方 seg 系列），这里只保留末端标签与底衬
      const color = focus ? ((last ?? 0) >= 0 ? "#ef4444" : "#22c55e") : baseColor;
      const pctStr = typeof l.pct === "number" ? `(${l.pct >= 0 ? "+" : ""}${l.pct.toFixed(2)}%)` : "";
      const label = `${l.name}  ${last == null ? "—" : signedYi(last)}${pctStr}`;
      return {
        id: l.code,
        name: l.name,
        type: "line" as const,
        data: toValues(l.points),
        showSymbol: false,
        smooth: 0.15,
        lineStyle: { width: focus ? 3 : 1.5, color, opacity: dim ? 0.16 : 1 },
        itemStyle: { color },
        emphasis: { focus: "series" as const, lineStyle: { width: 3.4 } },
        blur: { lineStyle: { opacity: 0.08 }, label: { opacity: 0.1 }, endLabel: { opacity: 0.1 } },
        endLabel: {
          show: !many,
          formatter: () => label,
          color,
          fontSize: 10,
          fontWeight: "bold" as const,
          distance: 6,
        },
        labelLayout: { moveOverlap: "shiftY" as const },
        // 悬停线本身退到分段线下面（半透明但保留宽度，保证鼠标还能命中这条线）
        z: focus ? 2 : 3,
        ...(focus ? { lineStyle: { width: 3, color, opacity: 0.25 } } : {}),
      };
    });

    // 悬停的线按「逐分钟资金变化」拆成红涨绿跌的折线（与 stock-webui 一致）。
    // 连续同向的分钟合并成一条折线，方向反转才切段——800+ 个点也不会产生上千个 series。
    const focused = hoverCode ? lines.find((l) => l.code === hoverCode) : null;
    if (focused && focused.points.length > 1) {
      const vals = toValues(focused.points);
      let segStart = 0;
      let segUp: boolean | null = null;
      const flush = (end: number) => {
        if (segUp == null || end <= segStart) return;
        const data: (number | null)[] = new Array(times.length).fill(null);
        let lastIdx = -1;
        for (let i = segStart; i <= end; i++) {
          if (vals[i] != null) {
            data[i] = vals[i];
            lastIdx = i;
          }
        }
        if (lastIdx < 0) return;
        series.push({
          id: `${focused.code}_seg_${segStart}_${end}`,
          name: `${focused.name}_seg${segStart}`,
          type: "line",
          data,
          showSymbol: false,
          silent: true,
          lineStyle: { width: 3.2, color: segUp ? "#ef4444" : "#22c55e", opacity: 1 },
          itemStyle: { color: segUp ? "#ef4444" : "#22c55e" },
          emphasis: { disabled: true },
          z: 10,
        });
      };
      for (let i = 1; i < times.length; i++) {
        const cur = vals[i];
        const prev = vals[i - 1];
        if (cur == null || prev == null) continue;
        const up = cur >= prev;
        if (segUp == null) {
          segUp = up;
          segStart = i - 1;
        } else if (up !== segUp) {
          flush(i - 1);
          segStart = i - 1;
          segUp = up;
        }
      }
      flush(times.length - 1);
    }

    if (temp) {
      const color = "#ff5722";
      series.push({
        id: "_temp_hover",
        name: temp.name,
        type: "line" as const,
        data: toValues(temp.points),
        showSymbol: false,
        smooth: 0.15,
        lineStyle: { width: 2.6, color, type: "dashed" as const, opacity: 1 },
        itemStyle: { color },
        emphasis: { disabled: true as any },
        blur: { lineStyle: { opacity: 1 } },
        endLabel: {
          show: true,
          formatter: () => `${temp.name}  ${signedYi(temp.points.length ? temp.points[temp.points.length - 1][1] : null)}`,
          color, fontSize: 10, fontWeight: "bold" as const, distance: 6,
        },
        z: 6,
      } as any);
    }

    return {
      animation: true,
      animationDuration: 260,
      animationDurationUpdate: 160,
      legend: { show: false },
      tooltip: {
        trigger: "axis",
        axisPointer: {
          type: "cross",
          lineStyle: { color: "rgba(228,228,231,0.55)", type: "dashed", width: 1 },
          crossStyle: { color: "rgba(228,228,231,0.55)", type: "dashed", width: 1 },
          label: { backgroundColor: "#3f3f46", color: "#f4f4f5", fontSize: 10 },
        },
        backgroundColor: "rgba(24,24,27,0.95)",
        borderColor: "rgba(255,255,255,0.12)",
        textStyle: { color: "#e4e4e7", fontSize: 11 },
        formatter: (ps: any[]) => {
          const rows = (ps ?? []).filter((p) => p.value != null && !String(p.seriesId ?? "").includes("_seg_"))
            .sort((a, b) => (b.value as number) - (a.value as number));
          if (!rows.length) return "";
          const hovered = hoverCode ? rows.find((r) => r.seriesId === hoverCode) : null;
          const list = hovered ? [hovered, ...rows.filter((r) => r !== hovered)] : rows;
          const head = `<div style="margin-bottom:4px">${rows[0].axisValue}</div>`;
          return head + list.slice(0, 12).map((p) =>
            `<div style="display:flex;justify-content:space-between;gap:14px;${hovered === p ? "font-weight:700" : ""}">
               <span>${p.marker}${p.seriesName}</span>
               <span style="color:${(p.value as number) >= 0 ? "#f87171" : "#4ade80"}">${(p.value as number) >= 0 ? "+" : ""}${p.value}亿</span>
             </div>`).join("") + (rows.length > 12 ? `<div style="opacity:.6">…共 ${rows.length} 条</div>` : "");
        },
      },
      grid: { top: 30, right: many ? 40 : 190, bottom: 34, left: 56 },
      xAxis: {
        type: "category",
        data: times,
        boundaryGap: false,
        axisLine: { lineStyle: { color: "#52525b" } },
        // 多日模式：只在每天起点显示 MM-DD；单日模式：只显示整点/半点
        axisLabel: {
          color: "#71717a", fontSize: 10, hideOverlap: true,
          formatter: vLines?.length
            ? (v: string) => (vLines.includes(v) ? v.slice(0, 5) : "")
            : undefined,
          interval: vLines?.length ? 0 : (_i: number, v: string) => isHalfHour(v),
        },
        splitLine: {
          show: true,
          interval: (_i: number, v: string) => isHalfHour(v),
          lineStyle: { color: "rgba(255,255,255,0.12)", type: "dashed" },
        },
      },
      yAxis: {
        type: "value",
        scale: true,
        name: "亿元",
        nameTextStyle: { color: "#71717a", fontSize: 10 },
        axisLabel: {
          color: "#71717a", fontSize: 10,
          formatter: (v: number) => `${v >= 0 ? "+" : ""}${Math.round(v)}`,
        },
        splitLine: { lineStyle: { color: "rgba(255,255,255,0.08)", type: "dashed" } },
      },
      series,
    };
  }, [lines, hoverCode, temp, vLines]);

  // 日分隔竖虚线（多日图）：挂在第一条线，避免重复绘制
  if (vLines?.length && option.series.length) {
    (option.series[0] as any).markLine = {
      symbol: "none",
      silent: true,
      label: { show: false },
      lineStyle: { color: "rgba(228,228,231,0.55)", type: [5, 4], width: 1.5 },
      data: vLines.map((v) => ({ xAxis: v })),
    };
  }

  const times = useMemo(() => {
    const s = new Set<string>();
    lines.forEach((l) => l.points.forEach(([t]) => s.add(t)));
    return s.size;
  }, [lines]);

  if (!times) return null;
  return (
    <ReactECharts
      key={id}
      option={option}
      notMerge
      style={{ height }}
      onEvents={{
        mouseover: (p: any) => {
          const id2 = String(p?.seriesId ?? "");
          if (id2.includes("_seg_") || id2 === "_temp_hover") return;
          if (id2 && id2 !== hoverCode) onHoverCode?.(id2);
        },
        globalout: () => onHoverCode?.(null),
      }}
    />
  );
}
