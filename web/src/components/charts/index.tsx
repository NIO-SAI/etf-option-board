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

/** ETF 分时：价格线 + 均价线 + 主力资金柱（右轴）。 */
export function IntradayChart({
  trends, flow, height = 240, title, id,
}: {
  trends: any[];
  flow: any[];
  height?: number;
  title?: string;
  id?: string;
}) {
  const option = useMemo(() => {
    const times = trends?.map((t) => t.time?.slice(11)) ?? [];
    const prices = trends?.map((t) => t.price) ?? [];
    const avg = trends?.map((t) => t.avg) ?? [];
    const flowMap = new Map((flow ?? []).map((f) => [f.time?.slice(11), f.main]));
    const mains = times.map((t) => flowMap.get(t) ?? null);
    return {
      ...base,
      legend: undefined,
      xAxis: { ...base.xAxisBase, data: times },
      yAxis: [
        { ...base.yAxisBase, position: "left", axisLabel: { color: AXIS, formatter: (v: number) => v.toFixed(3) } },
        { ...base.yAxisBase, position: "right", splitLine: { show: false },
          axisLabel: { color: "#7c3aed", formatter: (v: number) => (v / 1e8).toFixed(1) + "亿" } },
      ],
      series: [
        { name: "价格", type: "line", data: prices, showSymbol: false, lineStyle: { width: 1.4, color: "#60a5fa" },
          areaStyle: { color: "rgba(96,165,250,0.08)" } },
        { name: "均价", type: "line", data: avg, showSymbol: false, lineStyle: { width: 1, color: "#f59e0b", type: "dashed" } },
        { name: "主力净流入", type: "bar", yAxisIndex: 1, data: mains, barWidth: "60%",
          itemStyle: { color: (p: any) => (p.value >= 0 ? "rgba(239,68,68,0.55)" : "rgba(34,197,94,0.55)") } },
      ],
    };
  }, [trends, flow]);
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
    const times = optTrends?.map((t) => t.time?.slice(11)) ?? [];
    const optPx = optTrends?.map((t) => t.price) ?? [];
    const etfMap = new Map((etfTrends ?? []).map((t) => [t.time?.slice(11), t.price]));
    const etfPx = times.map((t) => etfMap.get(t) ?? null);
    const flowMap = new Map((flow ?? []).map((f) => [f.time?.slice(11), f.main]));
    const mains = times.map((t) => flowMap.get(t) ?? null);
    return {
      ...base,
      grid: { left: 52, right: 58, top: 30, bottom: 40 },
      legend: { top: 2, textStyle: { color: AXIS }, itemWidth: 12, itemHeight: 8 },
      xAxis: { ...base.xAxisBase, data: times },
      yAxis: [
        { ...base.yAxisBase, position: "left", name: "期权", nameTextStyle: { color: "#60a5fa" },
          axisLabel: { color: "#60a5fa", formatter: (v: number) => v.toFixed(4) } },
        { ...base.yAxisBase, position: "right", name: "标的ETF", nameTextStyle: { color: "#fbbf24" },
          splitLine: { show: false }, axisLabel: { color: "#fbbf24", formatter: (v: number) => v.toFixed(3) } },
      ],
      series: [
        { name: "期权价", type: "line", data: optPx, showSymbol: false, lineStyle: { width: 1.6, color: "#60a5fa" },
          areaStyle: { color: "rgba(96,165,250,0.10)" } },
        { name: "标的ETF", type: "line", yAxisIndex: 1, data: etfPx, showSymbol: false, lineStyle: { width: 1.4, color: "#fbbf24" } },
        { name: "主力净流入", type: "bar", yAxisIndex: 1, data: mains, barWidth: "50%", opacity: 0.25,
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
