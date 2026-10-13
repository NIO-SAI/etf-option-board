import ReactECharts from "echarts-for-react";
import { useMemo } from "react";

const AXIS = "#8b8b96";
const SPLIT = "rgba(255,255,255,0.06)";
const UP = "#ef4444";
const DOWN = "#22c55e";

const base = {
  backgroundColor: "transparent",
  animation: false,
  textStyle: { color: AXIS, fontSize: 11 },
  grid: { left: 48, right: 48, top: 22, bottom: 46 },
  tooltip: {
    trigger: "axis",
    backgroundColor: "rgba(18,18,22,0.96)",
    borderColor: "rgba(255,255,255,0.12)",
    textStyle: { color: "#e5e5e5", fontSize: 11 },
    axisPointer: { type: "cross", label: { backgroundColor: "#3f3f46" } },
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
  trends, flow, height = 240, title,
}: {
  trends: any[];
  flow: any[];
  height?: number;
  title?: string;
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
          axisLabel: { color: "#a78bfa", formatter: (v: number) => (v / 1e8).toFixed(1) + "亿" } },
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
  return <ReactECharts option={option} style={{ height }} notMerge lazyUpdate />;
}

/** 通用 K 线 + 量能。 */
export function KlineChart({ bars, height = 260 }: { bars: any[]; height?: number }) {
  const option = useMemo(() => {
    const data = bars ?? [];
    const cat = data.map((b) => (b.date?.length > 12 ? b.date.slice(5) : b.date));
    const k = data.map((b) => [b.open, b.close, b.low, b.high]);
    const vol = data.map((b, i) => ({ value: b.volume, itemStyle: { color: b.close >= b.open ? UP : DOWN } }));
    return {
      ...base,
      grid: { left: 46, right: 16, top: 16, bottom: 54 },
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
  return <ReactECharts option={option} style={{ height }} notMerge lazyUpdate />;
}

/** 合约分时叠加：期权价（左轴）+ 标的ETF价（右轴）+ 主力资金（柱，副轴）。 */
export function OverlayChart({
  optTrends, etfTrends, flow, height = 300,
}: {
  optTrends: any[];
  etfTrends: any[];
  flow: any[];
  height?: number;
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
  return <ReactECharts option={option} style={{ height }} notMerge lazyUpdate />;
}

/** Kronos 预测：历史收盘 + 预测收盘路径（虚线）+ 预测高低带。 */
export function PredictChart({
  bars, pred, height = 220,
}: {
  bars: any[];
  pred: any;
  height?: number;
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
        { name: "历史", type: "line", data: histClose, showSymbol: false, lineStyle: { color: "#e4e4e7", width: 1.2 } },
        { name: "预测", type: "line", data: pad(predClose, cat.length), showSymbol: false,
          lineStyle: { color: "#a78bfa", width: 1.6, type: "dashed" } },
        { name: "预测上沿", type: "line", data: pad(predHigh, cat.length), showSymbol: false, lineStyle: { color: "rgba(167,139,250,0.35)", width: 1 } },
        { name: "预测下沿", type: "line", data: pad(predLow, cat.length), showSymbol: false, lineStyle: { color: "rgba(167,139,250,0.35)", width: 1 } },
      ],
    };
  }, [bars, pred]);
  return <ReactECharts option={option} style={{ height }} notMerge lazyUpdate />;
}

/** 迷你走势（用于 ETF 列表行）。 */
export function Sparkline({ data, up, height = 28, width = 84 }: { data: number[]; up: boolean; height?: number; width?: number }) {
  const option = useMemo(
    () => ({
      ...base,
      animation: false,
      grid: { left: 0, right: 0, top: 2, bottom: 2 },
      xAxis: { type: "category", show: false, data: data.map((_, i) => i) },
      yAxis: { type: "value", show: false, scale: true },
      series: [{ type: "line", data, showSymbol: false, lineStyle: { width: 1.2, color: up ? UP : DOWN },
        areaStyle: { color: up ? "rgba(239,68,68,0.12)" : "rgba(34,197,94,0.12)" } }],
    }),
    [data, up],
  );
  return <ReactECharts option={option} style={{ height, width }} notMerge lazyUpdate />;
}
