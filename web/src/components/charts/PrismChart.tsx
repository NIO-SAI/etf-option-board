import ReactECharts from "echarts-for-react";
import { useMemo } from "react";

const YELLOW = "#f0a020";
const RED = "#e11d48";

/** 20261106 → 11-06 */
const md = (d: string) => (d && d.length === 8 ? `${d.slice(4, 6)}-${d.slice(6)}` : d);

/**
 * 涨停棱镜图：黄线 = 沪深 A 股涨停总数，红色面积 = 所选主题涨停数。
 *
 * 复刻经传「涨停棱镜」的读法——**红色面积越大代表该主题涨停个股越多**，
 * 黄线回落而红面积仍在高位，说明大盘退潮但主题还在延续。
 * 竖虚线由 xAxis 的 splitLine 提供（每个交易日一根），不额外画 markLine。
 */
export function PrismChart({
  dates, total, theme, themeName, height = 268,
}: {
  dates: string[];
  total: number[];
  theme: number[];
  themeName?: string | null;
  height?: number;
}) {
  const option = useMemo(() => {
    const maxTheme = Math.max(1, ...theme);
    return {
      animation: false,
      grid: { left: 46, right: 18, top: 28, bottom: 28 },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "line", lineStyle: { color: "rgba(0,0,0,.25)", type: "dashed" } },
        formatter: (ps: any[]) => {
          if (!ps?.length) return "";
          const i = ps[0].dataIndex;
          return [
            `<b>${dates[i] ?? ""}</b>`,
            `沪深涨停：<b>${total[i] ?? 0}</b> 家`,
            `${themeName || "该主题"}：<b>${theme[i] ?? 0}</b> 家`,
          ].join("<br/>");
        },
      },
      legend: {
        top: 0, right: 6, itemWidth: 12, itemHeight: 8,
        textStyle: { fontSize: 11, color: "#52525b" },
        data: ["沪深涨停", themeName || "主题涨停"],
      },
      xAxis: {
        type: "category",
        data: dates.map(md),
        boundaryGap: false,
        axisLine: { lineStyle: { color: "rgba(0,0,0,.15)" } },
        axisTick: { show: false },
        axisLabel: { fontSize: 10, color: "#71717a", interval: 0, rotate: dates.length > 16 ? 40 : 0 },
        splitLine: { show: true, lineStyle: { color: "rgba(0,0,0,.07)", type: "dashed" } },
      },
      yAxis: {
        type: "value",
        minInterval: 1,
        axisLabel: { fontSize: 10, color: "#71717a" },
        splitLine: { lineStyle: { color: "rgba(0,0,0,.06)" } },
      },
      series: [
        {
          name: themeName || "主题涨停",
          type: "line",
          data: theme,
          symbol: "none",
          lineStyle: { width: 0 },
          areaStyle: {
            color: {
              type: "linear", x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [
                { offset: 0, color: "rgba(225,29,72,.42)" },
                { offset: 1, color: "rgba(225,29,72,.06)" },
              ],
            },
          },
          z: 1,
        },
        {
          name: "沪深涨停",
          type: "line",
          data: total,
          symbol: "circle",
          symbolSize: 4,
          itemStyle: { color: YELLOW },
          lineStyle: { width: 1.6, color: YELLOW },
          z: 3,
        },
      ],
      // 主题面积按最大值配一条右侧刻度，避免主题家数被黄线的量级压平
      visualMap: [],
      _maxTheme: maxTheme,
    };
  }, [dates, total, theme, themeName]);

  if (!dates.length) {
    return (
      <div className="flex h-[268px] items-center justify-center text-xs text-muted-foreground">
        暂无棱镜数据
      </div>
    );
  }

  return (
    <ReactECharts
      style={{ height }}
      option={option}
      notMerge
      lazyUpdate
      opts={{ renderer: "canvas" }}
    />
  );
}
