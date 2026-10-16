import ReactECharts from "echarts-for-react";
import { useMemo } from "react";

const AXIS = "#71717a";
const SPLIT = "rgba(0,0,0,0.07)";
const UP = "#ef4444";
const DOWN = "#16a34a";

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
  prevClose = null, indexPrevClose = null,
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
}) {
  const option = useMemo(() => {
    const tt = (t: any) => (t || "").slice(-5);
    const times = trends?.map((t) => tt(t.time)) ?? [];
    const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

    // 昨收 -> 百分比。缺昨收则该条线整条不画（与 OverlayChart 口径一致）。
    const mapSrc = (arr: any[]) => new Map((arr ?? []).map((t) => [tt(t.time), t.price]));
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
    const symRange = (arrs: ((number | null)[] | null)[]) => {
      const vals: number[] = [];
      arrs.forEach((a) => (a ?? []).forEach((v) => { if (v !== null && isFinite(v)) vals.push(Math.abs(v)); }));
      const m = Math.max(MIN_SPAN, ...vals);
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

    const flowMap = new Map((flow ?? []).map((f) => [tt(f.time), f.main]));
    const mains = times.map((t) => flowMap.get(t) ?? null);
    const iflowMap = new Map((indexFlow ?? []).map((f) => [tt(f.time), f.main]));
    const imains = times.map((t) => iflowMap.get(t) ?? null);
    const hasIdx = !!idxPct;
    const hasIdxFlow = imains.some((v) => v !== null);
    const idxLabel = `关联指数${indexName ? " " + indexName : ""}`;
    return {
      ...base,
      grid: { left: 14, right: 56, top: 24, bottom: 34 },
      legend: {
        top: 0, left: 6, itemWidth: 12, itemHeight: 8, itemGap: 10,
        textStyle: { color: AXIS, fontSize: 10 },
        data: [...(etfPct ? ["标的ETF"] : []), ...(hasIdx ? [idxLabel] : []), "主力净流入", ...(hasIdxFlow ? ["指数主力净流入"] : [])],
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
              const isFlow = p.seriesName === "主力净流入" || p.seriesName === "指数主力净流入";
              val = isFlow ? `${Math.round(n / 1e4)}万` : `${n.toFixed(2)}%`;
            }
            return `${p.marker}${p.seriesName} <b>${val}</b>`;
          }).join("<br/>");
          return `${head}<br/>${body}`;
        },
      },
      xAxis: { ...base.xAxisBase, data: times },
      yAxis: [
        // 0 右：涨跌幅 %（标的ETF 与关联指数共用）
        { ...base.yAxisBase, position: "right", ...range,
          axisLabel: { color: AXIS, formatter: (v: number) => `${v.toFixed(2)}%` } },
        // 1 右：标的 ETF 主力净流入（线）
        { ...base.yAxisBase, position: "right", splitLine: { show: false }, axisLabel: { show: false } },
        // 2 右：关联指数 主力净流入（柱）
        { ...base.yAxisBase, position: "right", splitLine: { show: false }, axisLabel: { show: false } },
      ],
      series: [
        { name: "标的ETF", type: "line", yAxisIndex: 0, data: etfPct ?? [], showSymbol: false, connectNulls: false,
          lineStyle: { width: 1.4, color: "#60a5fa" }, areaStyle: { color: "rgba(96,165,250,0.08)" },
          ...(etfPct ? { markLine: zeroLine } : {}),
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
        { name: "主力净流入", type: "line", yAxisIndex: 1, data: mains, showSymbol: false,
          lineStyle: { width: 1.3, color: "#7c3aed" } },
        { name: "指数主力净流入", type: "bar", yAxisIndex: 2, data: imains, barWidth: "55%",
          itemStyle: { color: (p: any) => (p.value >= 0 ? "rgba(239,68,68,0.5)" : "rgba(34,197,94,0.5)") } },
      ],
    };
  }, [trends, indexTrends, indexName, flow, indexFlow, signals, prevClose, indexPrevClose]);
  return <ReactECharts key={id} option={option} style={{ height }} />;
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
  return <ReactECharts key={id} option={option} style={{ height }} />;
}

/** 合约分时叠加：期权涨跌幅（右轴 %）+ 标的ETF涨跌幅（独立右轴 %）+ 主力资金（柱，副轴）。
 *  两条价格线各自按昨收换算为百分比、各自 0 居中对称：若共用一根轴，期权（日内可达数十%）
 *  会把标的线压成一条贴着 0 的直线（实测标的 -1.21% vs 合约 -34.99%~+208.70%）。
 *  左轴已移除，右侧只显示期权 % 一列标签。
 */
export function OverlayChart({
  optTrends, etfTrends, flow, height = 300, id, optPrevClose = null, etfPrevClose = null,
}: {
  optTrends: any[];
  etfTrends: any[];
  flow: any[];
  height?: number;
  id?: string;
  optPrevClose?: number | null;
  etfPrevClose?: number | null;
}) {
  const option = useMemo(() => {
    const norm = (t: any) => (t || "").slice(-5);
    const axisSrc: any[] = optTrends?.length ? optTrends : (etfTrends?.length ? etfTrends : flow) ?? [];
    const times = axisSrc.map((t: any) => norm(t.time));
    const optMap = new Map((optTrends ?? []).map((t) => [norm(t.time), t.price]));
    const etfMap = new Map((etfTrends ?? []).map((t) => [norm(t.time), t.price]));
    // 标的ETF 主力净买额（分钟净流入）。用「单条 bar + itemStyle.color 按正负上色」，
    // 不要拆成红/绿两条同名 line 再互相补 0——那样非本方向的补 0 会在轴上留下一根
    // 贯穿全图的假水平线（曾据此误读为参考线）。
    const flowMap = new Map((flow ?? []).map((f) => [norm(f.time), f.main]));
    const mains = times.map((t) => flowMap.get(t) ?? null);
    const hasFlow = mains.some((v) => v !== null);

    // 昨收 -> 百分比。缺昨收（未选合约 / 新上市 / quote 未就绪）则整条线不画。
    const toPctSeries = (src: Map<any, any>, prev: number | null) => {
      if (!prev || !(prev > 0)) return null;
      const arr: (number | null)[] = times.map((t) => {
        const p = src.get(t);
        return p != null && isFinite(Number(p)) ? ((Number(p) - prev) / prev) * 100 : null;
      });
      return arr.some((v) => v !== null) ? arr : null;
    };
    const optPct = toPctSeries(optMap, optPrevClose ?? null);
    const etfPct = toPctSeries(etfMap, etfPrevClose ?? null);
    // 右侧只出一列标签，且必须跟「实际画出来的那条线」匹配：
    // 期权线存在时打期权%（默认诉求）；期权缺失（未选合约/缺昨收）时改打标的%，
    // 否则右侧会留下一列 ±0.50% 的空档刻度，与图上真实画的标的线量程不符。
    const labelOpt = !!optPct;
    const labelEtf = !optPct && !!etfPct;
    // 0 居中对称；最小带宽兜底，避免横盘时把噪声放大成假波动（也防极值=0 时轴退化）
    const MIN_SPAN = 0.5;
    const symRange = (arr: (number | null)[] | null) => {
      const abs = (arr ?? []).filter((v): v is number => v !== null && isFinite(v)).map(Math.abs);
      const m = Math.max(MIN_SPAN, ...abs);
      return { min: -m, max: m, scale: false as const };
    };

    // 0% 基准虚线刻意压暗：标的线改灰后，若基准线同为中性灰会与之混淆
    const zeroLine = {
      silent: true, symbol: "none" as const,
      lineStyle: { color: "#52525b", type: "dashed" as const, width: 1 },
      label: { show: false }, data: [{ yAxis: 0 }],
    };
    return {
      ...base,
      grid: { left: 10, right: 56, top: 30, bottom: 40 },
      legend: {
        top: 2, textStyle: { color: AXIS }, itemWidth: 12, itemHeight: 8, itemGap: 10,
        data: [...(optPct ? ["期权涨跌幅"] : []), ...(etfPct ? ["标的涨跌幅"] : []), ...(hasFlow ? ["标的ETF主力净买额"] : [])],
      },
      tooltip: {
        ...base.tooltip,
        formatter: (ps: any) => {
          const arr = Array.isArray(ps) ? ps : [ps];
          const head = arr[0]?.axisValueLabel ?? arr[0]?.name ?? "";
          const rows: string[] = [];
          for (const p of arr) {
            const n = Number(p.value);
            let val = "—";
            if (p.value !== null && p.value !== undefined && isFinite(n)) {
              val = p.seriesName === "标的ETF主力净买额" ? `${Math.round(n / 1e4)}万` : `${n.toFixed(2)}%`;
            }
            rows.push(`${p.marker}${p.seriesName} <b>${val}</b>`);
          }
          return `${head}<br/>${rows.join("<br/>")}`;
        },
      },
      xAxis: { ...base.xAxisBase, data: times },
      yAxis: [
        // 0 右：期权涨跌幅 %
        { ...base.yAxisBase, position: "right", ...symRange(optPct),
          axisLabel: { show: labelOpt, color: "#60a5fa", formatter: (v: number) => `${v.toFixed(2)}%` } },
        // 1 右：标的ETF 涨跌幅 %（自有量纲；默认隐藏标签，避免两列 % 同一水平线互相误读）
        { ...base.yAxisBase, position: "right", ...symRange(etfPct),
          splitLine: { show: false },
          axisLabel: { show: labelEtf, color: "#a1a1aa", formatter: (v: number) => `${v.toFixed(2)}%` } },
        // 2 右：标的ETF 主力净买额（金额，独立轴；刻度隐藏，柱贴 0 轴长出来）
        // min/max 强制含 0，否则轴域全为负时柱子会被裁掉
        { ...base.yAxisBase, position: "right", offset: 60, name: "主力",
          nameTextStyle: { color: "#7c3aed" }, splitLine: { show: false }, axisLabel: { show: false },
          min: (v: any) => Math.min(0, v.min), max: (v: any) => Math.max(0, v.max) },
      ],
      series: [
        // 柱先画、线后画，保证两条涨跌幅线压在柱上面
        ...(hasFlow ? [{ name: "标的ETF主力净买额", type: "bar" as const, yAxisIndex: 2, data: mains,
          barWidth: "60%", opacity: 0.35,
          itemStyle: { color: (p: any) => (p.value >= 0 ? UP : DOWN) } }] : []),
        { name: "期权涨跌幅", type: "line", data: optPct ?? [], showSymbol: false, connectNulls: false,
          lineStyle: { width: 1.6, color: "#60a5fa" }, areaStyle: { color: "rgba(96,165,250,0.08)" },
          ...(optPct ? { markLine: zeroLine } : {}) },
        { name: "标的涨跌幅", type: "line", yAxisIndex: 1, data: etfPct ?? [], showSymbol: false, connectNulls: false,
          lineStyle: { width: 1.4, color: "#a1a1aa" },
          ...(!optPct && etfPct ? { markLine: zeroLine } : {}) },
      ],
    };
  }, [optTrends, etfTrends, flow, optPrevClose, etfPrevClose]);
  return <ReactECharts key={id} option={option} style={{ height }} />;
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
      yAxis: { ...base.yAxisBase, axisLabel: { color: AXIS, formatter: (v: number) => v.toFixed(3) } },
      series: [
        { name: "历史", type: "line", data: histClose, showSymbol: false, lineStyle: { color: "#a1a1aa", width: 1.2 } },
        { name: "预测", type: "line", data: pad(predClose, cat.length), showSymbol: false,
          lineStyle: { color: "#a78bfa", width: 1.6, type: "dashed" } },
        { name: "预测上沿", type: "line", data: pad(predHigh, cat.length), showSymbol: false, lineStyle: { color: "rgba(167,139,250,0.35)", width: 1 } },
        { name: "预测下沿", type: "line", data: pad(predLow, cat.length), showSymbol: false, lineStyle: { color: "rgba(167,139,250,0.35)", width: 1 } },
      ],
    };
  }, [bars, pred]);
  return <ReactECharts key={id} option={option} style={{ height }} />;
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
