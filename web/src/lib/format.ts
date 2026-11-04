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

/** 主力净流入等：以「万」为单位，精确到个位数（整数万）。 */
export const wan = (v: any): string => {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!isFinite(n)) return "—";
  return `${Math.round(n / 1e4)}万`;
};

export const signedWan = (v: any): string => {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!isFinite(n)) return "—";
  const r = Math.round(n / 1e4);
  return `${r > 0 ? "+" : ""}${r}万`;
};

/** 资金（元）→ 万，带千分位；列表列统一用万为单位时用。 */
export const signedWanGrouped = (v: any): string => {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!isFinite(n)) return "—";
  const wan = Math.round(n / 1e4);
  const txt = Math.abs(wan).toLocaleString("en-US");
  return `${wan > 0 ? "+" : wan < 0 ? "-" : ""}${txt}万`;
};

/** 板块/ETF 资金：≥1 亿按「亿」两位小数，否则按「万」整数（板块资金动辄几十亿，万亿单位难读）。 */
export const signedYi = (v: any): string => {
  if (v === null || v === undefined || v === "") return "—";
  const n = Number(v);
  if (!isFinite(n)) return "—";
  if (Math.abs(n) >= 1e8) {
    const yi = Math.round((n / 1e8) * 100) / 100;
    return `${yi > 0 ? "+" : ""}${yi.toFixed(2)}亿`;
  }
  const wan = Math.round(n / 1e4);
  return `${wan > 0 ? "+" : ""}${wan}万`;
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
