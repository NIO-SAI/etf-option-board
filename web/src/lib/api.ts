const BASE = "/api";

async function get<T = any>(path: string): Promise<T> {
  const r = await fetch(BASE + path, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status} ${path}`);
  return r.json();
}

export const api = {
  health: () => get("/health"),
  universe: () => get("/universe"),
  indices: () => get("/indices"),
  indexLevels: () => get("/index/levels"),
  external: () => get("/external"),
  national: () => get("/national"),
  etfs: () => get("/etfs"),
  directions: () => get("/directions"),
  etfs_spark: () => get("/etfs/spark"),
  etf: (code: string, klt = 1) => get(`/etf/${code}?klt=${klt}`),
  etfKline: (code: string, klt = 1, lmt = 240) => get(`/etf/${code}/kline?klt=${klt}&lmt=${lmt}`),
  chain: (code: string, month?: number) =>
    get(`/option/chain/${code}${month ? `?month=${month}` : ""}`),
  optQuote: (secid: string) => get(`/option/quote?secid=${secid}`),
  optKline: (secid: string, klt = 1, lmt = 240) =>
    get(`/option/kline?secid=${secid}&klt=${klt}&lmt=${lmt}`),
  optTrends: (secid: string) => get(`/option/trends?secid=${secid}`),
  strategy: (code: string, kronos = 0, klt = 1) =>
    get(`/strategy/${code}?kronos=${kronos ? 1 : 0}&klt=${klt}`),
  predict: (secid: string, klt = 5, lookback = 120, pred_len = 20) =>
    get(`/predict?secid=${secid}&klt=${klt}&lookback=${lookback}&pred_len=${pred_len}`),
  llm: async (code: string, klt = 1) => {
    const r = await fetch(`${BASE}/llm/${code}?klt=${klt}`, { method: "POST" });
    return r.json();
  },
  expiry: () => get("/expiry"),
  settings: () => get("/settings"),
  saveSettings: async (body: {
    total_capital: number | string | null;
    risk_pct: number;
    tier: string;
    size: string;
  }) => {
    const r = await fetch(`${BASE}/settings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    return r.json();
  },
  alerts: () => get("/alerts?limit=60"),
  reversalSignals: (code: string) => get(`/reversal/signals?code=${code}`),
  monitorCycle: async () => (await fetch(`${BASE}/monitor/cycle`, { method: "POST" })).json(),
};
