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
  optLevels: (code: string, secid: string) =>
    get(`/option/levels?code=${code}&secid=${secid}`),
  topPicks: (n = 6) => get(`/picks/top?n=${n}`),
  calibration: () => get("/calibration"),
  indexOptionOverview: () => get("/index-option/overview"),
  indexOption: (symbol: string) => get(`/index-option/${symbol}`),
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

  // 板块资金（读本地库，采集由后端定时进行）
  boardHealth: () => get("/board/health"),
  boardRank: (type = "concept", date?: string) =>
    get(`/board/rank?type=${type}${date ? `&date=${date}` : ""}`),
  boardIndexRank: (date?: string) =>
    get(`/board/index-rank${date ? `?date=${date}` : ""}`),
  boardSeries: (codes: string, date?: string, type = "concept") =>
    get(`/board/series?codes=${encodeURIComponent(codes)}&type=${type}${date ? `&date=${date}` : ""}`),
  boardDates: (limit = 60) => get(`/board/dates?limit=${limit}`),
  boardDetail: (code: string, date?: string) =>
    get(`/board/detail?code=${encodeURIComponent(code)}${date ? `&date=${date}` : ""}`),
  boardMulti: (start?: string, end?: string, type = "concept") =>
    get(`/board/multi?type=${type}${start ? `&start=${start}` : ""}${end ? `&end=${end}` : ""}`),
  boardWatch: () => get("/board/watch"),

  // ETF 资金流
  etfFlowRank: (scope = "all", date?: string) =>
    get(`/etf-flow/rank?scope=${scope}${date ? `&date=${date}` : ""}`),
  etfFlowSeries: (codes: string, date?: string) =>
    get(`/etf-flow/series?codes=${encodeURIComponent(codes)}${date ? `&date=${date}` : ""}`),
  etfFlow4dim: (code: string, date?: string) =>
    get(`/etf-flow/4dim?code=${encodeURIComponent(code)}${date ? `&date=${date}` : ""}`),
  etfFlowWatchAdd: async (code: string, name: string) =>
    (await fetch(`${BASE}/etf-flow/watch?code=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}`,
      { method: "POST" })).json(),
  etfFlowWatchRemove: async (code: string) =>
    (await fetch(`${BASE}/etf-flow/watch?code=${encodeURIComponent(code)}`, { method: "DELETE" })).json(),

  // 东财 4 维资金
  emFlowTargets: () => get("/em-flow/targets"),
  emFlowIndustries: () => get("/em-flow/industries"),
  emFlowSeries: (kind: string, code: string) =>
    get(`/em-flow/series?target_type=${kind}&code=${encodeURIComponent(code)}`),
  emFlowConfigAdd: async (code: string, name: string) =>
    (await fetch(`${BASE}/em-flow/config/add?code=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}`,
      { method: "POST" })).json(),
  emFlowConfigRemove: async (code: string) =>
    (await fetch(`${BASE}/em-flow/config?code=${encodeURIComponent(code)}`, { method: "DELETE" })).json(),
  emFlowConfigReset: async () => (await fetch(`${BASE}/em-flow/config/reset`, { method: "POST" })).json(),
  boardWatchAdd: async (code: string, name: string) =>
    (await fetch(`${BASE}/board/watch?code=${encodeURIComponent(code)}&name=${encodeURIComponent(name)}`,
      { method: "POST" })).json(),
  boardWatchRemove: async (code: string) =>
    (await fetch(`${BASE}/board/watch?code=${encodeURIComponent(code)}`, { method: "DELETE" })).json(),
};
