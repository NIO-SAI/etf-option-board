/* 汪汪队 ETF 跟踪器：判定与图表所需的纯函数。
 *
 * 1:1 移植自目标页的内联 JS（`bootSnapshot`），只做了类型化与模块化，逻辑未改：
 * - 交易状态按北京时间判（浏览器可能在别的时区）
 * - 盘中成交额只走完一部分 → 用「历史日内累计成交额分布」把分母同比例缩小（同时点对齐）
 * - 判断阈值 1.8× / 1.3×，主动净买入需同向
 */

export type WwItem = {
  code: string;
  tcode: string;
  name: string;
  index: string;
  group: "core" | "watch";
  huijin_yi: number;
  price: number;
  prev_close: number;
  pct: number;
  amount_wan: number;
  amount_yi: number;
  mktcap_yi: number;
  shares_yi: number;
  turnover: number;
  outer_lots: number;
  inner_lots: number;
  ts: string;
  date: string;
  avg20_yi: number;
  shape: Array<[string, number]>;
  tail_ratio: number | null;
  tail_ratio_base: number | null;
  hist: Array<{ date: string; amount_yi: number; volume_lots: number }>;
  prev_shares: number | null;
  subscr_net_yi: number | null;
};

export type WwSnapshot = {
  generated_at: string;
  trade_date: string;
  prev_share_date: string;
  share_days: number;
  items: WwItem[];
  shares_history: Record<string, Record<string, number>>;
  source: string;
  huijin_basis: string;
  error?: string;
};

export type MarketState = {
  weekend: boolean;
  trading: boolean;
  lunch: boolean;
  preopen: boolean;
  after: boolean;
  before: boolean;
  offhours: boolean;
  progress: number;
  date: string;
  hhmm: string;
  effHHMM: string;
};

/** 北京时间 + 交易时段（与原页 marketState 完全一致）。 */
export function marketState(now = new Date()): MarketState {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23",
  }).formatToParts(now);
  const p: Record<string, string> = {};
  parts.forEach((x) => { p[x.type] = x.value; });
  const weekend = p.weekday === "Sat" || p.weekday === "Sun";
  const h = parseInt(p.hour, 10);
  const m = parseInt(p.minute, 10);
  const t = h * 60 + m;
  const lunch = !weekend && t >= 690 && t < 780;      // 11:30–13:00 午间休市
  const trading = !weekend && t >= 570 && t < 900;
  const preopen = !weekend && t >= 540 && t < 570;    // 9:00–9:30
  const after = !weekend && t >= 900;
  const before = !weekend && t < 540;
  let prog: number;
  if (t < 570) prog = 0;
  else if (t <= 690) prog = (t - 570) / 240;
  else if (t < 780) prog = 120 / 240;
  else if (t < 900) prog = (120 + (t - 780)) / 240;
  else prog = 1;
  const hhmm = `${p.hour}:${p.minute}`;
  return {
    weekend, trading, lunch, preopen, after, before,
    offhours: weekend || before || preopen,
    progress: Math.max(0.12, Math.min(1, prog)),
    date: p.year + p.month + p.day,
    hhmm,
    effHHMM: lunch ? "11:30" : hhmm,
  };
}

const hhmm2min = (s: string) => {
  const [a, b] = String(s).split(":");
  return (parseInt(a, 10) || 0) * 60 + (parseInt(b, 10) || 0);
};

/** 历史日内累计成交额分布上的插值：这个时点平均已走完全天的百分之几。 */
export function shapeAt(shape: Array<[string, number]>, hhmm: string): number | null {
  if (!shape?.length) return null;
  const n = shape.length;
  const tx = hhmm2min(hhmm);
  if (tx <= hhmm2min(shape[0][0])) return shape[0][1];
  if (tx >= hhmm2min(shape[n - 1][0])) return shape[n - 1][1];
  for (let i = 1; i < n; i++) {
    const t1 = hhmm2min(shape[i][0]);
    if (tx <= t1) {
      const t0 = hhmm2min(shape[i - 1][0]);
      if (t1 <= t0) return shape[i][1];
      return shape[i - 1][1] + (shape[i][1] - shape[i - 1][1]) * (tx - t0) / (t1 - t0);
    }
  }
  return shape[n - 1][1];
}

/** 该标的「已走完全天成交额的比例」；收盘/复盘为 1。 */
export function dayProgress(it: WwItem, st?: MarketState | null): number {
  if (!st || !st.trading) return 1;
  const s = shapeAt(it.shape, st.effHHMM);
  if (s !== null && s > 0.02) return Math.min(1, s);
  return st.progress || 0.5;
}

export type Adj = { ratio: number; raw: number; done: number; net: number };

export function calcAdj(it: WwItem, st?: MarketState | null): Adj {
  const base = it.avg20_yi || 0;
  const amt = it.amount_yi || 0;
  const p = dayProgress(it, st);
  const oi = (it.outer_lots || 0) + (it.inner_lots || 0);
  return {
    ratio: base > 0 && p > 0 ? amt / (base * p) : 0,
    raw: base > 0 ? amt / base : 0,
    done: p,
    net: oi > 0 ? ((it.outer_lots - it.inner_lots) / oi) * amt : 0,
  };
}

/** 盘中但快照不是今天 = 实时通道没拿到今日数据，退回全天对全天（否则倍数凭空翻倍）。 */
export function isStale(snap: WwSnapshot, st: MarketState): boolean {
  const d = snap.items[0]?.date;
  return !!st.trading && !!d && d !== st.date;
}

export type Verdict = {
  st: MarketState;
  stale: boolean;
  core: WwItem[];
  sumAmt: number;
  sumBase: number;
  sumBaseAdj: number;
  sumNet: number;
  ratio: number;
  rawRatio: number;
  done: number;
  wpct: number;
  tail: number;
  tailB: number;
  level: "hot" | "mid" | "cool";
  title: string;
  reason: string;
};

export function verdict(snap: WwSnapshot | null, now = new Date()): Verdict | null {
  if (!snap?.items?.length) return null;
  const st = marketState(now);
  const stale = isStale(snap, st);
  const effSt: MarketState = stale ? { ...st, trading: false, lunch: false } : st;
  const core = snap.items.filter((i) => i.group === "core");
  let sumAmt = 0, sumBase = 0, sumBaseAdj = 0, sumNet = 0, capW = 0, pctW = 0;
  let tailCur = 0, tailBase = 0, tailAmt = 0;
  core.forEach((it) => {
    const c = calcAdj(it, effSt);
    sumAmt += it.amount_yi || 0;
    sumBase += it.avg20_yi || 0;
    sumBaseAdj += (it.avg20_yi || 0) * c.done;
    sumNet += c.net;
    const w = it.mktcap_yi || 0;
    capW += w;
    pctW += (it.pct || 0) * w;
    if (it.tail_ratio != null && it.tail_ratio_base != null) {
      tailCur += (it.amount_yi || 0) * it.tail_ratio;
      tailBase += (it.amount_yi || 0) * it.tail_ratio_base;
      tailAmt += it.amount_yi || 0;
    }
  });
  const ratio = sumBaseAdj > 0 ? sumAmt / sumBaseAdj : 0;
  const rawRatio = sumBase > 0 ? sumAmt / sumBase : 0;
  const done = sumBase > 0 ? sumBaseAdj / sumBase : 1;
  const wpct = capW > 0 ? pctW / capW : 0;
  const tail = tailAmt > 0 ? tailCur / tailAmt : 0;
  const tailB = tailAmt > 0 ? tailBase / tailAmt : 0;

  let level: Verdict["level"] = "cool";
  let title = "";
  let reason = "";
  if (ratio >= 1.8 && sumNet > 0) {
    level = "hot"; title = "大概率上班了";
    reason = `汪汪队池成交额达到历史同时点均值的 ${fmt(ratio, 2)} 倍，且主动净买入 ${fmt(sumNet, 1)} 亿元。放量 + 净买入同向，是典型的护盘量价特征。`;
  } else if (ratio >= 1.3 && sumNet > 0) {
    level = "mid"; title = "有护盘迹象";
    reason = `成交额放大到历史同时点均值的 ${fmt(ratio, 2)} 倍，主动净买入 ${fmt(sumNet, 1)} 亿元，方向偏买，但力度还不构成强信号。`;
  } else if (ratio >= 1.8 && sumNet <= 0) {
    level = "mid"; title = "放量了，方向不对";
    reason = `成交额放大到历史同时点均值的 ${fmt(ratio, 2)} 倍，但主动净买入 ${fmt(sumNet, 1)} 亿元。大额成交未必是买盘，更像换手或出货，不能直接算上班。`;
  } else if (ratio >= 1.3) {
    level = "mid"; title = "成交活跃，证据不够";
    reason = `成交额达到历史同时点均值的 ${fmt(ratio, 2)} 倍，但主动净买入 ${fmt(sumNet, 1)} 亿元，方向不清晰。`;
  } else {
    level = "cool"; title = "没看出上班迹象";
    reason = `成交额只有历史同时点均值的 ${fmt(ratio, 2)} 倍，主动净买入 ${fmt(sumNet, 1)} 亿元，量价都平静。`;
  }
  if (tail > 0 && tailB > 0 && tail > tailB * 1.25 && (level === "hot" || level === "mid")) {
    reason += ` 尾盘半小时成交占全天 ${fmt(tail * 100, 1)}%，明显高于 20 日均值 ${fmt(tailB * 100, 1)}%。`;
  }
  if (wpct < -0.5 && (level === "hot" || level === "mid")) {
    reason += ` 池内规模加权涨跌 ${fmt(wpct, 2)}%，下跌日放量更符合护盘场景。`;
  }
  if (stale) {
    reason += `（实时通道未连上，当前显示 ${fmtDate(snap.items[0].date)} 全天收盘数据，与全天基准直接对比；连上后自动切换同时点对齐）`;
  } else if (st.lunch) {
    reason += `（午间休市，成交额锁定 11:30；对比基准 = 20 日均额 × 历史同时点进度 ${fmt(done * 100, 1)}%）`;
  } else if (st.trading) {
    reason += `（${st.hhmm} 历史平均已走完全天 ${fmt(done * 100, 1)}%，分母已同比例缩小，与昨日同时刻对比）`;
  } else if (st.offhours) {
    reason += `（非交易时段，以上为 ${fmtDate(snap.trade_date)} 收盘复盘，开盘后自动切换实时）`;
  }

  return {
    st, stale, core, sumAmt, sumBase, sumBaseAdj, sumNet,
    ratio, rawRatio, done, wpct, tail, tailB, level, title, reason,
  };
}

// ---- 格式化 --------------------------------------------------------------------
export function fmt(n: number | null | undefined, d = 2): string {
  return (n || 0).toLocaleString("zh-CN", {
    minimumFractionDigits: d, maximumFractionDigits: d,
  });
}

export const signed = (n: number) => (n > 0 ? "+" : "") + fmt(n, 2);
export const cls = (n: number) => (n > 0 ? "up" : n < 0 ? "down" : "muted");

const WK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function fmtDate(d?: string | null): string {
  if (!d || d.length !== 8) return d || "—";
  const dt = new Date(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8));
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${WK[dt.getDay()]}`;
}

export const dShort = (d: string) => (d?.length === 8 ? `${d.slice(4, 6)}-${d.slice(6, 8)}` : d);
export const dAxis = (d: string, big: boolean) =>
  !d || d.length !== 8 ? d : big ? `${d.slice(2, 4)}/${d.slice(4, 6)}` : dShort(d);

// ---- 份额序列 ------------------------------------------------------------------
export type SeriesData = {
  dates: string[];
  deltas: Array<{ date: string; d: number }>;
  idx: Array<{ date: string; v: number }>;
  bars: number;
};

/** 每日份额变化 + 加仓指数（首日=100）。缺数日按前值顺延，不制造假跳变。 */
export function seriesData(
  history: Record<string, Record<string, number>>,
  coreCodes: string[],
  n: number,
): SeriesData | null {
  const dates = Object.keys(history || {}).sort();
  if (dates.length < 2) return null;
  const codes = coreCodes.length ? coreCodes : Object.keys(history[dates[dates.length - 1]] || {});
  const win = Math.max(8, Math.min(n || 242, dates.length - 1));
  const wd = dates.slice(Math.max(0, dates.length - 1 - win));
  const last: Record<string, number> = {};
  const tot: number[] = [];
  wd.forEach((d) => {
    const row = history[d] || {};
    codes.forEach((c) => {
      if (row[c] !== undefined && row[c] !== null) last[c] = row[c];
    });
    let s = 0;
    codes.forEach((c) => { if (last[c] !== undefined) s += last[c]; });
    tot.push(s);
  });
  const deltas: SeriesData["deltas"] = [];
  for (let i = 1; i < wd.length; i++) deltas.push({ date: wd[i], d: tot[i] - tot[i - 1] });
  const base = tot[0] || 1;
  const idx = wd.map((d, i) => ({ date: d, v: (100 * tot[i]) / base }));
  return { dates: wd, deltas, idx, bars: deltas.length };
}

/** 同一市场 ≥70% 标的两日份额完全相同时，判定该市场「份额源未日更」。 */
export function sharesSuspect(items: WwItem[]): Record<string, boolean> {
  const by: Record<string, WwItem[]> = {};
  items.forEach((it) => {
    const m = (it.tcode || "").slice(0, 2);
    (by[m] = by[m] || []).push(it);
  });
  const out: Record<string, boolean> = {};
  Object.keys(by).forEach((m) => {
    const known = by[m].filter((x) => x.subscr_net_yi !== null && x.subscr_net_yi !== undefined);
    if (known.length < 3) return;
    const same = known.filter((x) => Math.abs(x.subscr_net_yi as number) < 0.005).length;
    out[m] = same / known.length >= 0.7;
  });
  return out;
}

/** 近 30 日成交额迷你柱（末端一根橙色），返回 SVG 几何。 */
export function sparkBars(hist: WwItem["hist"], w = 96, h = 26) {
  const vals = hist.map((x) => x.amount_yi);
  const mx = Math.max(...vals, 1);
  const bw = w / Math.max(vals.length, 1);
  return vals.map((v, i) => {
    const bh = Math.max(1.2, (v / mx) * h);
    return {
      x: i * bw,
      y: h - bh,
      w: Math.max(1.2, bw - 1),
      h: bh,
      last: i === vals.length - 1,
    };
  });
}
