export const nf = (v: any, d = 2): string =>
  v === null || v === undefined || isNaN(Number(v))
    ? "—"
    : Number(v).toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });

/** Gamma 量级随标的价格差异大（0.00x~5+），按数量级自适应小数位。 */
export const gamma = (v: any): string => {
  if (v === null || v === undefined || isNaN(Number(v))) return "—";
  const n = Number(v);
  const a = Math.abs(n);
  const d = a >= 1 ? 2 : a >= 0.1 ? 3 : 4;
  return n.toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });
};

const WEEK_CN = ["日", "一", "二", "三", "四", "五", "六"];

/** 日期加星期：`2026-11-05` → `2026-11-05（四）`，用于下拉菜单。非 YYYY-MM-DD 原样返回。 */
export const dateWithWeek = (d?: string | null): string => {
  const s = String(d ?? "");
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s;
  // 用 UTC 构造，避免本地时区把日期推前/推后一天导致星期错位
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!isFinite(t)) return s;
  return `${s}（${WEEK_CN[new Date(t).getUTCDay()]}）`;
};

export const pct = (v: any, d = 2): string =>
  v === null || v === undefined || isNaN(Number(v))
    ? "—"
    : `${Number(v) > 0 ? "+" : ""}${Number(v).toFixed(d)}%`;

export const money = (v: any): string => {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  if (a >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return n.toFixed(0);
};

export const signedMoney = (v: any): string => {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${money(n)}`;
};

/** 资金流统一口径：≥1 亿用「亿」（2 位小数），不足 1 亿一律用「万」。
 *  万的小数位随量级收减（≥100 万取整、≥1 万 1 位、更小 2 位），避免小额被抹成 0 万。
 *  只给资金流/成交额用；敞口、张数等元级数字仍用 money()，免得几百元变成 0.05 万。 */
export const flowMoney = (v: any): string => {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!isFinite(n)) return "—";
  const a = Math.abs(n);
  if (a >= 1e8) return `${(n / 1e8).toFixed(2)}亿`;
  const w = n / 1e4;
  const aw = Math.abs(w);
  const d = aw >= 100 ? 0 : aw >= 1 ? 1 : 2;
  const txt = w.toFixed(d);
  // 四舍五入后跨过 1 亿（9999.5 万 → 10000 万）时仍按「亿」显示
  if (Math.abs(Number(txt)) >= 10000) return `${(n / 1e8).toFixed(2)}亿`;
  return `${txt}万`;
};

export const signedFlow = (v: any): string => {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${flowMoney(n)}`;
};

export const upDown = (v: any): "up" | "down" | "flat" => {
  const n = Number(v);
  if (!isFinite(n) || n === 0) return "flat";
  return n > 0 ? "up" : "down";
};

export const clsUpDown = (v: any): string => {
  const u = upDown(v);
  return u === "up" ? "text-up" : u === "down" ? "text-down" : "text-muted-foreground";
};

export const hhmmss = (d = new Date()): string =>
  d.toLocaleTimeString("zh-CN", { hour12: false });
