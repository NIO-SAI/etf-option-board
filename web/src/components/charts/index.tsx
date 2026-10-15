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

/** ETF 分时：左轴价（标的/关联指数），右轴主力净流入（标的线/指数柱）。 */
export function IntradayChart({
  trends, indexTrends = [], indexName = "", flow, indexFlow = [], height = 240, title, id,
}: {
  trends: any[];
  indexTrends?: any[];
  indexName?: string;
  flow: any[];
  indexFlow?: any[];
  height?: number;
  title?: string;
  id?: string;
}) {
  const option = useMemo(() => {
    const tt = (t: any) => (t || "").slice(-5);
    const times = trends?.map((t) => tt(t.time)) ?? [];
    const prices = trends?.map((t) => t.price) ?? [];
    const idxMap = new Map((indexTrends ?? []).map((t) => [tt(t.time), t.price]));
    const idxPx = times.map((t) => idxMap.get(t) ?? null);
    const flowMap = new Map((flow ?? []).map((f) => [tt(f.time), f.main]));
    const mains = times.map((t) => flowMap.get(t) ?? null);
    const iflowMap = new Map((indexFlow ?? []).map((f) => [tt(f.time), f.main]));
    const imains = times.map((t) => iflowMap.get(t) ?? null);
    const hasIdx = idxPx.some((v) => v !== null);
    const hasIdxFlow = imains.some((v) => v !== null);
    const idxLabel = `关联指数${indexName ? " " + indexName : ""}`;
    return {
      ...base,
      grid: { left: 14, right: 14, top: 24, bottom: 34 },
      legend: {
        top: 0, left: 6, itemWidth: 12, itemHeight: 8, itemGap: 10,
        textStyle: { color: AXIS, fontSize: 10 },
        data: ["标的ETF", ...(hasIdx ? [idxLabel] : []), "主力净流入", ...(hasIdxFlow ? ["指数主力净流入"] : [])],
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
              if (p.seriesName === "标的ETF") val = n.toFixed(3);
              else if (String(p.seriesName).startsWith("关联指数")) val = n.toFixed(0);
              else val = `${Math.round(n / 1e4)}万`;   // 主力净流入：万·整数
            }
            return `${p.marker}${p.seriesName} <b>${val}</b>`;
          }).join("<br/>");
          return `${head}<br/>${body}`;
        },
      },
      xAxis: { ...base.xAxisBase, data: times },
      yAxis: [
        // 0 左：标的 ETF 价（数值标注隐藏）
        { ...base.yAxisBase, position: "left", axisLabel: { show: false } },
        // 1 左：关联指数 点位
        { ...base.yAxisBase, position: "left", splitLine: { show: false }, axisLabel: { show: false } },
        // 2 右：标的 ETF 主力净流入（线）
        { ...base.yAxisBase, position: "right", splitLine: { show: false }, axisLabel: { show: false } },
        // 3 右：关联指数 主力净流入（柱）
        { ...base.yAxisBase, position: "right", splitLine: { show: false }, axisLabel: { show: false } },
      ],
      series: [
        { name: "标的ETF", type: "line", data: prices, showSymbol: false, lineStyle: { width: 1.4, color: "#60a5fa" },
          areaStyle: { color: "rgba(96,165,250,0.08)" } },
        { name: idxLabel, type: "line", yAxisIndex: 1, data: idxPx, showSymbol: false,
          lineStyle: { width: 1.3, color: "#d97706", type: "dashed" } },
        { name: "主力净流入", type: "line", yAxisIndex: 2, data: mains, showSymbol: false,
          lineStyle: { width: 1.3, color: "#7c3aed" } },
        { name: "指数主力净流入", type: "bar", yAxisIndex: 3, data: imains, barWidth: "55%",
          itemStyle: { color: (p: any) => (p.value >= 0 ? "rgba(239,68,68,0.5)" : "rgba(34,197,94,0.5)") } },
      ],
    };
  }, [trends, indexTrends, indexName, flow, indexFlow]);
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

/** 合约分时叠加：期权价（左轴）+ 标的ETF价（右轴）+ 主力资金（柱，副轴）。 */
export function OverlayChart({
  optTrends, etfTrends, flow, height = 300, id,
}: {
  optTrends: any[];
  etfTrends: any[];
  flow: any[];
  height?: number;
  id?: string;
}) {
  const option = useMemo(() => {
    const norm = (t: any) => (t || "").slice(-5);
    const axisSrc: any[] = optTrends?.length ? optTrends : (etfTrends?.length ? etfTrends : flow) ?? [];
    const times = axisSrc.map((t: any) => norm(t.time));
    const optMap = new Map((optTrends ?? []).map((t) => [norm(t.time), t.price]));
    const etfMap = new Map((etfTrends ?? []).map((t) => [norm(t.time), t.price]));
    const flowMap = new Map((flow ?? []).map((f) => [norm(f.time), f.main]));
    const optPx = times.map((t) => optMap.get(t) ?? null);
    const etfPx = times.map((t) => etfMap.get(t) ?? null);
    const mains = times.map((t) => flowMap.get(t) ?? null);
    return {
      ...base,
      grid: { left: 56, right: 40, top: 30, bottom: 40 },
      legend: { top: 2, textStyle: { color: AXIS }, itemWidth: 12, itemHeight: 8 },
      xAxis: { ...base.xAxisBase, data: times },
      yAxis: [
        { ...base.yAxisBase, position: "left", name: "期权", nameTextStyle: { color: "#60a5fa" },
          axisLabel: { color: "#60a5fa", formatter: (v: number) => v.toFixed(4) } },
        { ...base.yAxisBase, position: "right", name: "标的ETF", nameTextStyle: { color: "#fbbf24" },
          splitLine: { show: false }, axisLabel: { show: false } },
        // 主力净流入单独一根轴，避免与标的ETF价共用轴导致价格被压成直线
        { ...base.yAxisBase, position: "right", offset: 60, name: "主力", nameTextStyle: { color: "#7c3aed" },
          splitLine: { show: false }, axisLabel: { show: false } },
      ],
      series: [
        { name: "期权价", type: "line", data: optPx, showSymbol: false, lineStyle: { width: 1.6, color: "#60a5fa" },
          areaStyle: { color: "rgba(96,165,250,0.10)" } },
        { name: "标的ETF", type: "line", yAxisIndex: 1, data: etfPx, showSymbol: false, lineStyle: { width: 1.4, color: "#fbbf24" } },
        { name: "主力净流入", type: "bar", yAxisIndex: 2, data: mains, barWidth: "50%", opacity: 0.25,
          itemStyle: { color: (p: any) => (p.value >= 0 ? UP : DOWN) } },
      ],
    };
  }, [optTrends, etfTrends, flow]);
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
