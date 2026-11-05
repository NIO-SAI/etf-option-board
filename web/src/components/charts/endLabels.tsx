import { useEffect, useMemo, useState } from "react";

/**
 * 分时图右侧「虚线 + 彩色标签」图层。
 *
 * 为什么不用 ECharts 的 endLabel：它不会画引导线，条数一多就整批叠在一起或被隐藏。
 * 这里在图表之上盖一层绝对定位的 SVG：每条线的末端 → 右侧标签画一条虚线，
 * 标签按 y 排序后做「最小行距」避让；行数超过可用高度时，按 |值| 从大到小占位
 * （大资金/大涨幅优先看得见），悬停/高亮的那条始终保留。
 *
 * 注意：ECharts 实例（`chart`）在 `key`/`id` 变化时会被销毁重建，销毁后调用
 * `getWidth()` 会抛 `Cannot read properties of null (reading 'getWidth')`。
 * 所以**渲染期间一律不碰实例**，像素坐标与留白都只在 effect 里算好放进 state。
 */

export type EndLabelItem = {
  id: string;
  text: string;
  color: string;
  /** 数据坐标 [x 轴索引, y 轴数值] */
  coord: [number, number];
  /** 空间不足时按 |weight| 优先占位 */
  weight: number;
  /** 悬停/高亮：一定显示 */
  active?: boolean;
  dashed?: boolean;
};

type Row = EndLabelItem & { x: number; y: number; ly: number };
type Layout = { rows: Row[]; labelX: number };

const MIN_GAP = 12.5;
/** 分时线末端到标签文字的横向留白：虚线要肉眼可辨，至少 50px */
const LEAD = 54;
/** 虚线末端与文字的间隔 */
const DASH_END_GAP = 4;

export function FlowEndLabels({
  chart, items, version, gridTop = 30, gridRight = 240, gridBottom = 34,
}: {
  chart: any;
  items: EndLabelItem[];
  /** 数据签名：变化时重算像素坐标 */
  version: string;
  gridTop?: number;
  gridRight?: number;
  gridBottom?: number;
}) {
  const [layout, setLayout] = useState<Layout>({ rows: [], labelX: 0 });
  const [tick, setTick] = useState(0);
  const itemKey = useMemo(
    () => items.map((i) => `${i.id}:${i.coord[0]}:${i.coord[1]}:${i.text}:${i.active ? 1 : 0}`).join("|"),
    [items],
  );

  // 容器尺寸变化（窗口缩放/布局切换）时重算像素坐标
  useEffect(() => {
    if (!chart) return;
    let ro: ResizeObserver | null = null;
    try {
      const dom = chart.getDom?.();
      if (dom && typeof ResizeObserver !== "undefined") {
        ro = new ResizeObserver(() => setTick((t) => t + 1));
        ro.observe(dom);
      }
    } catch {
      /* 实例已销毁：交给下一次 onChartReady */
    }
    return () => ro?.disconnect();
  }, [chart]);

  useEffect(() => {
    const size = (() => {
      try {
        if (!chart || chart.isDisposed?.()) return null;
        const w = chart.getWidth?.() ?? 0;
        const h = chart.getHeight?.() ?? 0;
        return w > 0 && h > 0 ? { w, h } : null;
      } catch {
        return null;
      }
    })();
    if (!size || !items.length) {
      setLayout({ rows: [], labelX: 0 });
      return;
    }
    const top = gridTop + 2;
    const bottom = size.h - gridBottom - 2;
    if (bottom <= top) {
      setLayout({ rows: [], labelX: 0 });
      return;
    }
    const px: (EndLabelItem & { x: number; y: number })[] = [];
    for (const it of items) {
      let p: number[] | null = null;
      try {
        p = chart.convertToPixel({ xAxisIndex: 0, yAxisIndex: 0 }, it.coord);
      } catch {
        p = null;
      }
      if (!p || !isFinite(p[0]) || !isFinite(p[1])) continue;
      // 线末端最多画到网格右边界：留白区里的 54px 才是清晰可见的引导虚线
      px.push({ ...it, x: Math.min(p[0], size.w - gridRight), y: p[1] });
    }
    if (!px.length) {
      setLayout({ rows: [], labelX: 0 });
      return;
    }

    // 空间不足时按 |weight| 优先，保证标签之间始终有最小行距
    const capacity = Math.max(1, Math.floor((bottom - top) / MIN_GAP));
    let keep = px;
    if (px.length > capacity) {
      const ranked = [...px].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
      const chosen = new Set(ranked.slice(0, capacity).map((r) => r.id));
      px.forEach((p) => { if (p.active) chosen.add(p.id); });
      keep = px.filter((p) => chosen.has(p.id));
    }

    const sorted = [...keep].sort((a, b) => a.y - b.y);
    let cursor = top;
    const laid: Row[] = sorted.map((p) => {
      const ly = Math.max(p.y, cursor);
      cursor = ly + MIN_GAP;
      return { ...p, ly };
    });
    // 底部溢出：整体上推，再夹回顶部边界
    const overflow = laid.length ? laid[laid.length - 1].ly - (bottom - MIN_GAP) : 0;
    if (overflow > 0) laid.forEach((l) => (l.ly -= overflow));
    if (laid.length && laid[0].ly < top) {
      const up = top - laid[0].ly;
      laid.forEach((l) => (l.ly += up));
    }
    setLayout({
      rows: laid.map((l) => ({ ...l, ly: Math.min(Math.max(l.ly, top), bottom) })),
      labelX: size.w - gridRight + LEAD,
    });
  }, [chart, items, itemKey, version, tick, gridTop, gridRight, gridBottom]);

  const { rows, labelX } = layout;
  if (!rows.length) return null;
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <svg className="absolute inset-0 h-full w-full" aria-hidden>
        {rows.map((r) => (
          <line key={`l-${r.id}`} x1={r.x} y1={r.y} x2={labelX - DASH_END_GAP} y2={r.ly}
            stroke={r.color} strokeWidth={1} strokeDasharray={r.dashed ? "2 3" : "3 3"} opacity={0.75} />
        ))}
      </svg>
      {rows.map((r) => (
        <span
          key={`t-${r.id}`}
          className="absolute overflow-hidden text-ellipsis whitespace-nowrap text-[10px] font-semibold leading-none"
          style={{
            left: labelX, top: r.ly, transform: "translateY(-50%)", color: r.color,
            // 超长板块名兜底：绝不越过留白区右边界
            maxWidth: Math.max(40, gridRight - LEAD - 6),
          }}
        >
          {r.text}
        </span>
      ))}
    </div>
  );
}
