/**
 * 分钟序列统一对齐工具。
 *
 * 背景：分时图的时间轴来自行情源（腾讯，按分钟「开始时刻」标注、完整），
 * 而资金流/期权分时是另一套序列（东财按分钟「结束时刻」标注、且由本地轮询
 * 累积，可能缺分钟）。过去各图表用 `HH:MM` 精确相等做 join，导致：
 *   - 09:30 / 13:00（资金流首点 09:31 / 13:01）每天固定空洞；
 *   - 收盘后行情仍返回 15:06–15:30 的点，而资金流只到 15:00，尾部整段空洞；
 *   - 跨日兜底（昨日资金流）按 HH:MM 误配到今日轴。
 * 统一规则：轴由完整行情序列定义，稀疏序列一律按「最近前值」对齐；
 * 交易日不一致时整条不画，避免把昨日资金流画成今日。
 */

export type MinutePoint = { time?: string | null };

export const SESSIONS: [string, string][] = [
  ["09:30", "11:30"],
  ["13:00", "15:00"],
];

export const minuteOf = (t?: string | null): string => (t ?? "").slice(-5);
export const dayOf = (t?: string | null): string => (t ?? "").slice(0, 10);

/** 是否落在连续竞价时段（含 11:30 / 15:00 边界）。 */
export function inSession(t?: string | null): boolean {
  const hm = minuteOf(t);
  return SESSIONS.some(([a, b]) => hm >= a && hm <= b);
}

/**
 * 统一分时清洗：丢掉盘前/午休/15:00 后的脏点，只保留最后一个交易日。
 * 图表轴与叠加序列都先过这一层，保证口径一致。
 */
export function trimSession<T extends MinutePoint>(pts: T[] | null | undefined): T[] {
  const list = (pts ?? []).filter((p) => inSession(p.time));
  if (!list.length) return [];
  const day = dayOf(list[list.length - 1].time);
  return list.filter((p) => dayOf(p.time) === day);
}

/**
 * 只保留与轴同一交易日的点（价格类序列用）。
 * 防止「昨日兜底序列」按 HH:MM 误配到今日轴，画出价格错线。
 */
export function sameDayAs<T extends MinutePoint>(axis: MinutePoint[], pts: T[] | null | undefined): T[] {
  const ax = axis ?? [];
  if (!ax.length) return [];
  const day = dayOf(ax[ax.length - 1].time);
  return (pts ?? []).filter((p) => dayOf(p.time) === day);
}

/**
 * 把稀疏分钟序列对齐到主时间轴，返回与 axis 等长的数组。
 * - 时间键统一取 HH:MM；轴与数据不是同一交易日时返回全 null（不跨日错配）；
 * - 「最近前值」填充：第 t 分钟取 <= t 的最后一个数据点；轴早于首个数据点时
 *   用首个点回填（资金流首点通常比行情晚 1 分钟，否则开盘第一根柱固定缺失）。
 */
export function alignToAxis<T extends MinutePoint>(
  axis: MinutePoint[],
  pts: T[] | null | undefined,
  value: (p: T) => number | null | undefined,
): (number | null)[] {
  const ax = axis ?? [];
  if (!ax.length) return [];
  const axDay = dayOf(ax[ax.length - 1].time);
  const src = (pts ?? [])
    .map((p) => ({
      t: minuteOf(p.time),
      d: dayOf(p.time),
      v: value(p),
    }))
    .filter((x) => x.t && x.v !== null && x.v !== undefined && isFinite(Number(x.v)))
    .filter((x) => x.d === axDay)
    .sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  if (!src.length) return ax.map(() => null);
  const out: (number | null)[] = [];
  let i = 0;
  let last: number | null = src[0].v as number;
  for (const p of ax) {
    const t = minuteOf(p.time);
    while (i < src.length && src[i].t <= t) {
      last = src[i].v as number;
      i += 1;
    }
    out.push(last);
  }
  return out;
}
