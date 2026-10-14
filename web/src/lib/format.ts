export const nf = (v: any, d = 2): string =>
  v === null || v === undefined || isNaN(Number(v))
    ? "—"
    : Number(v).toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });

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
