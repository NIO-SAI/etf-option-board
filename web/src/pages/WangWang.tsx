/* 汪汪队 ETF 跟踪器（#/wangwang）
 *
 * 复刻 https://etf-turnover-tracker.app.workbuddy.host/ 的「今日国家队上班了吗」页面：
 * 24 只宽基 ETF 的成交额放大倍数 + 主动净买入 → 一句结论 + 两张份额图 + 明细表。
 *
 * - 数据全部来自本仓库后端 `/api/wangwang/snapshot`（服务端聚合腾讯/新浪）；
 * - 样式是目标页的原版 CSS，全部选择器收在 `.ww-page` 下，不影响看板其它页面；
 * - 判定逻辑（同时点对齐、1.8×/1.3× 阈值、份额未日更自检）移植自目标页，未改口径。
 */

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./wangwang/wangwang.css";
import { api } from "@/lib/api";
import {
  calcAdj, cls, dAxis, dShort, fmt, fmtDate, isStale, marketState, seriesData,
  sharesSuspect, signed, sparkBars, verdict,
  type SeriesData, type WwItem, type WwSnapshot,
} from "./wangwang/logic";

// ---------------------------------------------------------------- 尺寸 hook
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return { ref, width: w };
}

type Tip = { x: number; y: number; node: React.ReactNode } | null;

const RANGES = [
  { n: 60, label: "近3月" },
  { n: 120, label: "近6月" },
  { n: 242, label: "近1年" },
];

const NOT_ENOUGH = (
  <>份额快照还在积累<br />需要至少两个交易日的份额数据</>
);

// ---------------------------------------------------------------- 柱状图
function ShareDeltaChart({ data }: { data: SeriesData | null }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip>(null);
  if (!data) {
    return <div className="chartbox" ref={ref}><div className="chart-empty">{NOT_ENOUGH}</div></div>;
  }
  const mob = width > 0 && width < 430;
  const W = mob ? 390 : 560;
  const H = mob ? 200 : 232;
  const pl = mob ? 40 : 48;
  const pr = 10;
  const pt = 16;
  const pb = 26;
  const fs = mob ? 11 : 10;
  const pw = W - pl - pr;
  const ph = H - pt - pb;
  const first = data.deltas[0].date;
  const lastD = data.deltas[data.deltas.length - 1].date;
  const big = first.slice(0, 4) !== lastD.slice(0, 4);
  const vals = data.deltas.map((x) => x.d);
  const peak = Math.max(...vals.map(Math.abs), 1);
  const p10 = Math.pow(10, Math.floor(Math.log(peak) / Math.LN10));
  const m = [1, 2, 2.5, 5, 10].map((k) => k * p10).find((v) => v >= peak) ?? 10 * p10;
  const y0 = pt + ph / 2;
  const sx = pw / data.deltas.length;
  const bw = Math.max(1, Math.min(34, sx * 0.62));
  const axisY = (v: number) => (v === 0 ? "0" : v >= 1000 ? `${fmt(v / 1000, 1)}k`
    : fmt(v, Math.abs(v) < 1 ? 2 : Math.abs(v) < 10 ? 1 : 0));
  const step = Math.ceil(data.deltas.length / (mob ? 4 : 7));

  return (
    <div className="chartbox" ref={ref}>
      <svg viewBox={`0 0 ${W} ${H}`} aria-label="每日份额变化">
        <text x={6} y={10} fontSize={fs} fill="#8a8a8a">亿份</text>
        {[m, m / 2, 0, -m / 2, -m].map((v) => {
          const y = y0 - (v / m) * (ph / 2);
          return (
            <g key={v}>
              <line x1={pl} y1={y} x2={W - pr} y2={y} stroke={v === 0 ? "#d0d0d0" : "#efefef"} strokeWidth={1} />
              <text x={pl - 6} y={y + 3.5} textAnchor="end" fontSize={fs} fill="#8a8a8a">{axisY(v)}</text>
            </g>
          );
        })}
        {data.deltas.map((x, i) =>
          i % step !== 0 && i !== data.deltas.length - 1 ? null : (
            <text key={`x${x.date}`} x={pl + sx * (i + 0.5)} y={H - 8}
              textAnchor="middle" fontSize={fs} fill="#8a8a8a">{dAxis(x.date, big)}</text>
          ))}
        {data.deltas.map((x, i) => {
          const h = Math.max(bw >= 3 ? 1.5 : 0.8, (Math.abs(x.d) / m) * (ph / 2));
          const cx = pl + sx * (i + 0.5);
          return (
            <rect key={`b${x.date}`} x={cx - bw / 2} y={x.d >= 0 ? y0 - h : y0}
              width={bw} height={h} rx={bw >= 3 ? 1.5 : 0}
              fill={x.d >= 0 ? "#ff4713" : "#00875a"} />
          );
        })}
        {data.deltas.map((x, i) => (
          <rect key={`h${x.date}`} x={pl + sx * i} y={pt} width={sx} height={ph}
            fill="transparent" style={{ cursor: "crosshair" }}
            onMouseMove={(e) => {
              const box = (e.currentTarget.ownerSVGElement?.parentElement as HTMLElement)?.getBoundingClientRect();
              if (!box) return;
              setTip({
                x: e.clientX - box.left,
                y: e.clientY - box.top,
                node: <><b>{x.date.slice(0, 4)}-{dShort(x.date)}</b><br />份额变化{" "}
                  <span className={x.d >= 0 ? "tu" : "td"}>{signed(x.d)} 亿份</span></>,
              });
            }}
            onMouseLeave={() => setTip(null)} />
        ))}
      </svg>
      {tip ? <div className="chart-tip" style={{ display: "block", left: Math.max(4, tip.x - 60), top: Math.max(0, tip.y - 52) }}>{tip.node}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------- 折线图
function IndexChart({ data }: { data: SeriesData | null }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip>(null);
  if (!data) {
    return <div className="chartbox" ref={ref}><div className="chart-empty">至少需要两个交易日的份额快照</div></div>;
  }
  const mob = width > 0 && width < 430;
  const W = mob ? 390 : 560;
  const H = mob ? 200 : 232;
  const pl = mob ? 40 : 48;
  const pr = mob ? 10 : 12;
  const pt = 16;
  const pb = 26;
  const fs = mob ? 11 : 10;
  const pw = W - pl - pr;
  const ph = H - pt - pb;
  const big = data.idx[0].date.slice(0, 4) !== data.idx[data.idx.length - 1].date.slice(0, 4);
  const vs = data.idx.map((x) => x.v);
  let lo = Math.min(100, ...vs);
  let hi = Math.max(100, ...vs);
  const pad = Math.max(0.6, (hi - lo) * 0.18);
  lo -= pad; hi += pad;
  const Y = (v: number) => pt + ((hi - v) / (hi - lo)) * ph;
  const n = data.idx.length;
  const X = (i: number) => pl + (n === 1 ? pw / 2 : (pw * i) / (n - 1));
  const step = Math.ceil(n / (mob ? 4 : 7));
  const pts = data.idx.map((x, i) => `${X(i).toFixed(1)},${Y(x.v).toFixed(1)}`).join(" ");
  const area = `M${pl},${Y(lo).toFixed(1)} L${pts.replace(/ /g, " L")} L${X(n - 1).toFixed(1)},${Y(lo).toFixed(1)} Z`;
  const dots = n <= 70 ? data.idx.map((_, i) => i) : [n - 1];

  return (
    <div className="chartbox" ref={ref}>
      <svg viewBox={`0 0 ${W} ${H}`} aria-label="加仓指数">
        <text x={6} y={10} fontSize={fs} fill="#8a8a8a">指数</text>
        {[0, 1, 2, 3, 4].map((k) => {
          const v = lo + ((hi - lo) * k) / 4;
          const y = Y(v);
          return (
            <g key={k}>
              <line x1={pl} y1={y} x2={W - pr} y2={y} stroke="#efefef" />
              <text x={pl - 6} y={y + 3.5} textAnchor="end" fontSize={fs} fill="#8a8a8a">{fmt(v, 1)}</text>
            </g>
          );
        })}
        <line x1={pl} y1={Y(100)} x2={W - pr} y2={Y(100)} stroke="#b0b0b0" strokeDasharray="4 4" />
        <text x={W - pr} y={Y(100) - 5} textAnchor="end" fontSize={fs} fill="#8a8a8a">基期 100</text>
        {data.idx.map((x, i) =>
          i % step !== 0 && i !== n - 1 ? null : (
            <text key={`x${x.date}`} x={X(i)} y={H - 8} textAnchor="middle" fontSize={fs} fill="#8a8a8a">
              {dAxis(x.date, big)}
            </text>
          ))}
        <path d={area} fill="rgba(0,94,184,.08)" />
        <polyline points={pts} fill="none" stroke="#005eb8" strokeWidth={2}
          strokeLinejoin="round" strokeLinecap="round" />
        {dots.map((i) => (
          <circle key={`d${i}`} cx={X(i)} cy={Y(data.idx[i].v)} r={3}
            fill="#005eb8" stroke="#fff" strokeWidth={1.5} />
        ))}
        {data.idx.map((x, i) => (
          <rect key={`h${x.date}`} x={pl + (pw * i) / n} y={pt} width={pw / n} height={ph}
            fill="transparent" style={{ cursor: "crosshair" }}
            onMouseMove={(e) => {
              const box = (e.currentTarget.ownerSVGElement?.parentElement as HTMLElement)?.getBoundingClientRect();
              if (!box) return;
              const prev = i > 0 ? data.idx[i - 1].v : null;
              const diff = prev === null ? "" : (x.v - prev >= 0 ? " +" : " ") + fmt(x.v - prev, 2);
              setTip({
                x: e.clientX - box.left,
                y: e.clientY - box.top,
                node: <><b>{x.date.slice(0, 4)}-{dShort(x.date)}</b><br />加仓指数{" "}
                  <b style={{ color: "#005eb8" }}>{fmt(x.v, 2)}</b>
                  {diff ? <><br />较前日 <span className={x.v - (prev ?? 0) >= 0 ? "tu" : "td"}>{diff}</span></> : null}</>,
              });
            }}
            onMouseLeave={() => setTip(null)} />
        ))}
      </svg>
      {tip ? <div className="chart-tip" style={{ display: "block", left: Math.max(4, tip.x - 60), top: Math.max(0, tip.y - 58) }}>{tip.node}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------- 迷你柱
function Spark({ hist }: { hist: WwItem["hist"] }) {
  if (!hist?.length) return null;
  return (
    <svg className="spark" width={96} height={26} viewBox="0 0 96 26" aria-label="近30日成交额">
      {sparkBars(hist).map((b, i) => (
        <rect key={i} x={b.x.toFixed(1)} y={b.y.toFixed(1)} width={b.w.toFixed(1)}
          height={b.h.toFixed(1)} fill={b.last ? "#ff4713" : "#e0e0e0"} />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------- 页面
export function WangWangPage() {
  const [snap, setSnap] = useState<WwSnapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [sort, setSort] = useState("huijin");
  const [scope, setScope] = useState("all");
  const [q, setQ] = useState("");
  const [auto, setAuto] = useState(true);
  const [busy, setBusy] = useState(false);
  const [range, setRange] = useState({ delta: 242, index: 242 });

  const load = useCallback(async (force: boolean) => {
    setBusy(true);
    try {
      const d = await api.wangwangSnapshot(force) as WwSnapshot;
      if (d?.items?.length) {
        setSnap(d);
        setErr(null);
      } else {
        setErr(d?.error || "快照为空");
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  // 首屏 + 时钟
  useEffect(() => { void load(true); }, [load]);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  // 自动刷新：盘中 20 秒回源，非盘中 5 分钟一次（只为跨日切换复盘数据）
  useEffect(() => {
    if (!auto) return;
    const t1 = setInterval(() => { if (marketState().trading) void load(true); }, 20_000);
    const t2 = setInterval(() => { if (!marketState().trading) void load(true); }, 300_000);
    return () => { clearInterval(t1); clearInterval(t2); };
  }, [auto, load]);

  const v = useMemo(() => verdict(snap, now), [snap, now]);
  const st = useMemo(() => marketState(now), [now]);
  const stale = snap ? isStale(snap, st) : false;
  const suspect = useMemo(() => (snap ? sharesSuspect(snap.items) : {}), [snap]);
  const coreCodes = useMemo(
    () => (snap?.items || []).filter((i) => i.group === "core").map((i) => i.code),
    [snap],
  );
  const deltaSeries = useMemo(
    () => (snap ? seriesData(snap.shares_history, coreCodes, range.delta) : null),
    [snap, coreCodes, range.delta],
  );
  const indexSeries = useMemo(
    () => (snap ? seriesData(snap.shares_history, coreCodes, range.index) : null),
    [snap, coreCodes, range.index],
  );

  // 表格数据
  const rows = useMemo(() => {
    if (!snap) return [];
    const effSt = stale ? { ...st, trading: false, lunch: false } : st;
    const cmp: Record<string, (a: WwItem, b: WwItem) => number> = {
      huijin: (a, b) => (b.huijin_yi - a.huijin_yi) || (b.mktcap_yi - a.mktcap_yi),
      amount: (a, b) => b.amount_yi - a.amount_yi,
      ratio: (a, b) => calcAdj(b, effSt).ratio - calcAdj(a, effSt).ratio,
      net: (a, b) => calcAdj(b, effSt).net - calcAdj(a, effSt).net,
      mktcap: (a, b) => b.mktcap_yi - a.mktcap_yi,
    };
    const kw = q.trim().toLowerCase();
    return snap.items
      .filter((it) => scope === "all" || it.group === scope)
      .filter((it) => !kw || `${it.code}${it.name}${it.index}`.toLowerCase().includes(kw))
      .sort((a, b) => (a.group !== b.group ? (a.group === "core" ? -1 : 1) : cmp[sort](a, b)));
  }, [snap, sort, scope, q, st, stale]);

  const effSt = stale ? { ...st, trading: false, lunch: false } : st;
  const total = useMemo(() => {
    if (!snap) return null;
    const core = snap.items.filter((i) => i.group === "core");
    let sa = 0, sb = 0, sn = 0;
    core.forEach((it) => { const c = calcAdj(it, st); sa += it.amount_yi; sb += (it.avg20_yi || 0) * c.done; sn += c.net; });
    return { count: core.length, sa, sb, sn };
  }, [snap, st]);

  const badge = (() => {
    if (st.lunch) return { cls: "badge live", text: "午间休市 · 数据锁定 11:30" };
    if (st.trading) return busy
      ? { cls: "badge live", text: "实时 · 每20秒" }
      : { cls: "badge live", text: "实时 · 每20秒" };
    if (st.preopen) return { cls: "badge", text: "等待开盘 · 9:30" };
    if (st.after) return { cls: "badge", text: "已收盘 · 今日复盘数据" };
    return { cls: "badge", text: "休市 · 最近交易日收盘数据" };
  })();

  const vlabel = !v ? "今日结论"
    : st.lunch ? "今日结论 · 午间半场"
      : st.trading ? "今日结论 · 实时跟踪"
        : st.after ? "今日收盘复盘"
          : `最近交易日复盘 · ${fmtDate(snap?.trade_date)}`;

  const lastHist = snap?.share_days ?? 0;

  return (
    <div className="ww-page">
      <div className="wrap">
        <header>
          <div className="brand">
            <h1><span className="dot" />汪汪队ETF跟踪器</h1>
            <div className="sub">宽基 ETF 成交额与资金动向 · 用来判断今日国家队是否上班</div>
          </div>
          <div className="status">
            <span className={badge.cls}><i />{badge.text}</span>
            <span className="stamp num">
              快照 {fmtDate(snap?.trade_date)} · 生成 {snap?.generated_at ?? "—"}
            </span>
          </div>
        </header>

        <section className={"verdict" + (v?.level === "hot" ? " hot" : v?.level === "mid" ? " mid" : "")}>
          <div className="vhead">
            <div>
              <div className="vlabel">{vlabel}</div>
              <div className={"vtitle" + (v?.level === "cool" ? " cool" : "")}>
                {err ? "数据加载失败" : v ? v.title : "正在计算…"}
              </div>
              <div className="vreason">
                {err ? `接口错误：${err}` : v ? v.reason : "—"}
              </div>
            </div>
            <div className="vstamp">
              <b className={"num" + (v && v.ratio >= 1.8 ? " hl" : "")}>{v ? `${fmt(v.ratio, 2)}×` : "—"}</b>
              <span>{st.trading ? "较同时点历史均值" : "较20日均额"}</span>
            </div>
          </div>

          {v ? (
            <div className="mgrid">
              <div>
                <div className="k">汪汪队合计成交额</div>
                <div className="v num">{fmt(v.sumAmt, 1)} 亿</div>
                <div className="n">
                  {st.trading
                    ? `截至 ${st.effHHMM} · 已达成全天日均 ${fmt(v.rawRatio, 2)}×`
                    : `20日均额 ${fmt(v.sumBase, 1)} 亿`}
                </div>
              </div>
              <div>
                <div className="k">成交额放大倍数</div>
                <div className={"v num" + (v.ratio >= 1.8 ? " hl" : "")}>{fmt(v.ratio, 2)}×</div>
                <div className="n">
                  {st.trading
                    ? `基准 ${fmt(v.sumBaseAdj, 1)} 亿 = 20日均额 × 同时点进度 ${fmt(v.done * 100, 1)}%`
                    : "阈值 1.8× 为强信号"}
                </div>
                <div className="bar"><span style={{ width: `${Math.min(100, (v.ratio / 2.5) * 100).toFixed(1)}%` }} /></div>
              </div>
              <div>
                <div className="k">合计主动净买入</div>
                <div className={"v num " + cls(v.sumNet)}>{signed(v.sumNet)} 亿</div>
                <div className="n">主动买卖口径推算</div>
              </div>
              <div>
                <div className="k">池内加权涨跌</div>
                <div className={"v num " + cls(v.wpct)}>{fmt(v.wpct, 2)}%</div>
                <div className="n">规模加权 · {fmtDate(snap?.trade_date)}</div>
              </div>
            </div>
          ) : null}

          <div className="caveat">
            名单为 2025 年报历史标签，非当前持仓；所有结论均为量价推测。<a href="#notes">完整口径与合规说明 ↓</a>
          </div>
        </section>

        <section className="charts">
          <div className="chartcard">
            <div className="chead">
              <div>
                <h3>汪汪队每日份额变化估算</h3>
                <div className="csub">单位：亿份 · 正数净申购，负数净赎回 · 参考口径：日度份额变化均视为汪汪队操作</div>
              </div>
              <div className="rng">
                {RANGES.map((r) => (
                  <button key={r.n} className={range.delta === r.n ? "on" : ""}
                    onClick={() => setRange((s) => ({ ...s, delta: r.n }))}>{r.label}</button>
                ))}
              </div>
            </div>
            <ShareDeltaChart data={deltaSeries} />
            <div className="chart-note">
              {deltaSeries ? (
                <>
                  <b>估算方法：</b>池内 20 只 ETF「当日场内份额 − 上一交易日份额」加总，正数计申购、负数计赎回；
                  区间 {deltaSeries.dates[0]} ~ {deltaSeries.dates[deltaSeries.dates.length - 1]}（{deltaSeries.bars} 个交易日）。
                  参考常见口径，日度份额变化均视为汪汪队操作，<b>实际也可能来自其他机构或个人投资者</b>；
                  沪市行情商份额存在未按日更新的情况（见表格脚注②），缺数期间本图偏低。此为近似推算，非官方披露数据。
                </>
              ) : null}
            </div>
          </div>

          <div className="chartcard">
            <div className="chead">
              <div>
                <h3>汪汪队加仓指数估算</h3>
                <div className="csub">区间首日 = 100 · 高于 100 为估算净加仓，低于 100 为估算净减仓</div>
              </div>
              <div className="rng">
                {RANGES.map((r) => (
                  <button key={r.n} className={range.index === r.n ? "on" : ""}
                    onClick={() => setRange((s) => ({ ...s, index: r.n }))}>{r.label}</button>
                ))}
              </div>
            </div>
            <IndexChart data={indexSeries} />
            <div className="chart-note">
              {indexSeries ? (
                <>
                  <b>估算方法：</b>加仓指数 = 100 × 当日池内总份额 ÷ 区间首日（{indexSeries.dates[0]}）总份额，
                  区间 {indexSeries.dates[0]} ~ {indexSeries.dates[indexSeries.dates.length - 1]}。
                  高于 100 = 这段区间估算净加仓，低于 100 = 净减仓。<b>不等于真实持仓比例</b>：
                  定期报告已停止披露前十大持有人，期初持仓不可验证，比例锚定会失真，故用指数刻画变化方向与幅度。
                  份额源未日更的交易日按前值顺延（不产生假跳变）。此为近似推算，非官方披露数据。
                </>
              ) : null}
            </div>
          </div>
        </section>

        <div className="controls">
          <div className="grp">
            <span className="muted" style={{ fontSize: 12 }}>排序</span>
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="huijin">汇金历史持仓 → 规模优先</option>
              <option value="amount">今日成交额</option>
              <option value="ratio">放量倍数</option>
              <option value="net">主动净买入</option>
              <option value="mktcap">最新规模</option>
            </select>
          </div>
          <div className="grp">
            <span className="muted" style={{ fontSize: 12 }}>范围</span>
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="all">全部</option>
              <option value="core">仅汪汪队重点关注</option>
              <option value="watch">仅扩展观察</option>
            </select>
          </div>
          <input type="text" placeholder="搜代码 / 名称 / 指数" value={q}
            onChange={(e) => setQ(e.target.value)} />
          <button className="primary" disabled={busy}
            onClick={() => void load(true)}>
            {busy ? "更新中…" : "立即刷新"}
          </button>
          <label className="toggle">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />自动刷新
          </label>
          <div className="meta">
            数据时间 {snap?.items?.[0]?.ts
              ? snap.items[0].ts.replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, "$1-$2-$3 $4:$5:$6")
              : "—"}
            {stale ? <span style={{ color: "var(--orange)" }}> · 基准快照非今日</span> : null}
          </div>
        </div>

        <div className="tablewrap">
          <table>
            <thead>
              <tr>
                <th>ETF</th><th>跟踪指数</th><th>规模(亿)</th><th>成交额(亿)</th>
                <th>{st.trading ? "同时点倍数" : "较20日均"}</th>
                <th title="外盘−内盘 逐笔主动买卖推算，非资金流向、非申赎、不含大宗">主动净买入<sup>①</sup></th>
                <th>涨跌</th>
                <th title="腾讯行情场内份额，下方为与上一份快照的份额变化估值">份额(亿份)<sup>②</sup></th>
                <th>近30日成交额</th><th>汇金持仓(25年报·亿份)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((it, idx) => {
                const c = calcAdj(it, effSt);
                const prev = rows[idx - 1];
                const showHead = !prev || prev.group !== it.group;
                const cnt = rows.filter((x) => x.group === it.group).length;
                const rCls = c.ratio >= 1.8 ? "hl" : c.ratio >= 1.3 ? "" : "muted";
                const m = (it.tcode || "").slice(0, 2);
                const pd = snap?.prev_share_date || "";
                const tag = pd.length === 8 ? `${pd.slice(4, 6)}-${pd.slice(6, 8)}` : "上日";
                return (
                  <Fragment key={it.code}>
                    {showHead ? (
                      <tr className="grouphead">
                        <td colSpan={10}>
                          {it.group === "core"
                            ? "汪汪队重点关注 · 2025年报最后一次实名披露（此后停止披露）"
                            : "扩展观察 · 2025年报未见汇金持仓（名单已停止更新）"}
                          <span className="cnt">{cnt} 只</span>
                        </td>
                      </tr>
                    ) : null}
                    <tr>
                      <td>
                        <div className="name">
                          {it.name}
                          <span className={"chip " + it.group}>{it.group === "core" ? "汪汪队" : "观察"}</span>
                        </div>
                        <div className="code num">{it.code}</div>
                      </td>
                      <td className="muted">{it.index}</td>
                      <td className="num">{fmt(it.mktcap_yi, 1)}</td>
                      <td className="num" style={{ fontWeight: 700 }}>
                        {fmt(it.amount_yi, 2)}
                        {st.trading ? <div className="sub muted">截至 {st.effHHMM}</div> : null}
                      </td>
                      <td>
                        <div className={"ratio num " + rCls}>{fmt(c.ratio, 2)}<b>×</b></div>
                        {st.trading ? <div className="sub muted">已达成日均 {fmt(c.raw, 2)}×</div> : null}
                        <div className="mini"><span style={{ width: `${Math.min(100, (c.ratio / 3) * 100).toFixed(1)}%` }} /></div>
                      </td>
                      <td className={"num " + cls(c.net)} style={{ fontWeight: 700 }}>{signed(c.net)}</td>
                      <td className={"num " + cls(it.pct)} style={{ fontWeight: 700 }}>{signed(it.pct)}%</td>
                      <td>
                        <div className="num">{fmt(it.shares_yi, 1)}</div>
                        {it.subscr_net_yi === null || it.subscr_net_yi === undefined
                          ? <div className="sub muted">申赎 待积累</div>
                          : suspect[m]
                            ? <div className="sub muted" title="同市场绝大多数标的份额与昨日完全相同，判断为行情商份额字段未按日更新，不代表当日没有申赎">份额源未日更</div>
                            : Math.abs(it.subscr_net_yi) < 0.005
                              ? <div className="sub muted">较{tag} 持平</div>
                              : <div className={"sub num " + cls(it.subscr_net_yi)}>较{tag} {signed(it.subscr_net_yi)}亿</div>}
                      </td>
                      <td><Spark hist={it.hist} /></td>
                      <td className={"num " + (it.huijin_yi ? "" : "muted")}>
                        {it.huijin_yi ? fmt(it.huijin_yi, 1) : "—"}
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
              {total ? (
                <tr className="total">
                  <td>汪汪队合计</td>
                  <td className="muted">{total.count} 只</td>
                  <td className="muted">—</td>
                  <td className="num">
                    {fmt(total.sa, 2)}
                    {st.trading ? <div className="sub muted">截至 {st.effHHMM}</div> : null}
                  </td>
                  <td className="num hl">{fmt(total.sb > 0 ? total.sa / total.sb : 0, 2)}×</td>
                  <td className={"num " + cls(total.sn)}>{signed(total.sn)}</td>
                  <td colSpan={4} className="muted" style={{ textAlign: "right" }}>合计口径与上方判断一致</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="tnote">
          <div>
            <b>① 主动净买入</b> = (外盘 − 内盘) ÷ (外盘 + 内盘) × 成交额。外盘是主动买（成交在卖价）、
            内盘是主动卖（成交在买价），所以这只是<b>逐笔成交方向的推算</b>：
            <b>不是资金净流入，不是基金申赎净流入，也不含大宗交易与协议转让</b>。ETF 有一二级市场套利对冲，
            同一笔申赎会在二级市场产生反向成交，会稀释该信号；机构调仓、做市双边报价同样会干扰。
            别把它当「国家队买了多少钱」。
          </div>
          <div>
            <b>② 份额 / 申赎</b> = 腾讯行情披露的场内份额；下方申赎 = (本次快照份额 − 上一份快照份额) × 现价，
            <b>是份额变化的市值估算，不是基金公司公布的申赎数据</b>，需要连续两个交易日各有一次快照才有值。<br />
            <b>为什么有的是 0：</b>2026-11-03 实测，沪市 15 只 ETF 份额全部与上一快照一模一样，深市 9 只里 8 只有变化——
            这种「整片市场同时不动」不可能反映真实申赎，是行情商的份额字段对沪市未按日更新。页面因此加了自检：
            <b>同一市场 ≥70% 标的两日份额完全相同时，该市场一律标「份额源未日更」而不给数字</b>，
            避免把数据源滞后说成「没有申赎」。只有差异化的市场才显示具体申赎值。任何情况下都以基金公司公告为准。
          </div>
        </div>

        <footer>
          <div className="lead" id="notes">
            <h3>重要说明 · 名单与口径</h3>
            <p>
              <b>名单是绝版数据，不是当前持仓。</b>汇金持仓依据 Wind 统计的 2025 年报前十大持有人口径（2026-03 披露），
              这是最后一次公开实名披露。证监会 2026-03-13 发布《公开募集证券投资基金信息披露内容与格式准则第2号—定期报告的内容与格式》，
              2026-05-01 起施行，删除了上市基金列示前十名持有人的强制条款；2026 年中报、三季报均已不再披露，
              仅保留匿名的「单一投资者≥20%」风险提示，而 2026 上半年汇金大幅减持后，多数宽基 ETF 已跌破该门槛。
              此后公开渠道无法验证汇金当前持有哪些 ETF、持多少，本页名单只是「历史上买过」的静态标签。
            </p>
            <p>
              本页「主动净买入」是二级市场买卖口径的实时净流入替代指标；基金申赎净流入只有 T+1 份额数据，
              没有公开实时源。所有结论均为量价推测，不构成对任何机构当日交易的确认。
            </p>
          </div>
          <div className="cols">
            <div>
              <h3>数据口径</h3>
              <p>
                <b>日内成交额分布</b>：新浪 5 分钟 K 线（<code>quotes.sina.cn</code>）近 20 个完整交易日，
                按日算出「累计成交额占全天比例」曲线，48 个时点取均值。这是把盘中不完整数据对齐到全天基准的关键。
              </p>
              <p>
                <b>成交额 / 涨跌 / 规模 / 份额</b>：腾讯行情公开接口 <code>qt.gtimg.cn</code>，
                交易时段每 20 秒刷新。规模为行情口径的「价格 × 份额」，非基金净值口径。
              </p>
              <p>
                <b>20 日均额</b>：由同一份新浪 5 分钟 K 按日累加成交额，取快照交易日之前 20 个交易日。
                已与实时成交额交叉验证。
              </p>
              <p>
                <b>盘中怎么比才可比</b>：上午 11:30 的成交额是「半天」，直接除「全天 20 日均额」得到的倍数没有意义。
                本页改为<b>同时点对齐</b>：分母 = 20 日均额 × 该标的在此时点历史上平均已走完的比例（如 11:30 约 47%–55%），
                分子是当前累计成交额，两者都代表「到此刻为止」，可以直接比。表格里的「同时点倍数」是这个可比值，
                「已达成日均」是原始进度（半天就干了全天均额的多少倍），后者只作参考、不可直接下结论。
              </p>
              <p>
                <b>尾盘占比</b>：当日 14:30—15:00 成交额占全天比例，与 20 日均值（同为 14:30—15:00）比较。
                只有收盘后才计算，盘中不触发。
              </p>
              <p>
                <b>主动净买入 / 份额申赎</b>：这两列的逐笔口径、局限与「为什么有的是 0」见表格下方脚注 ①②。
                信披新规后，份额变化是少数仍公开可验证的资金进出线索，比已停止披露的持有人名单更适合做当下判断。
              </p>
              <p>
                <b>每日份额变化 / 加仓指数（图表）</b>：份额监测首日 {fmtDate(snap?.shares_history && Object.keys(snap.shares_history).sort()[0])}，
                之后每个交易日收盘后（15:02 起）自动累积，目前累计 {lastHist} 个交易日。
                日度份额变化全部记为汪汪队操作是参考口径，实际申赎可能来自任何投资者；加仓指数用「首日=100」刻画净申赎的方向与幅度，
                <b>不做持仓比例锚定</b>——期初持仓已不可验证。沪市份额源未日更期间，两张图都会偏低。均为近似推算，非官方披露数据。
              </p>
            </div>
            <div>
              <h3>名单补充依据</h3>
              <p>
                <b>汪汪队重点关注</b>：Wind 统计「2025 年报中央汇金投资 / 汇金资管进入前十大持有人」的宽基 ETF，
                按持仓份额（亿份）排序，数据经国信证券《中国机构配置手册(2026版)之ETF篇》整理、2026 年 3 月披露。
                财联社、南都湾财社对 510300「735.13 亿份、占 82.76%」的报道可交叉验证。
              </p>
              <p>
                <b>新规细节</b>：修订后的准则整合原年报 / 半年报 / 季报三份准则，第三十一条仅要求披露持有人户数、户均份额、
                机构与个人投资者占比、管理人从业人员持有情况，不再点名。2026 年中报（8 月底）与三季报（10 月底）已全面不再披露前十大持有人。
              </p>
              <p>
                <b>关于流传的规模数字</b>：券商与 Wind 口径的 1.3–1.4 万亿均为交叉测算，非官方披露，不可当作当前持仓规模引用。
              </p>
              <p><b>扩展观察</b>：规模或成交活跃，但 2025 年报未见汇金前十大持仓，仅作对照，不计入「上班」判断。</p>
              <h3 style={{ marginTop: 14 }}>怎么保持最新</h3>
              <p>
                本页数据由看板服务端聚合：实时行情每 20 秒按需回源，20 日均额与日内分布每 15 分钟重算一次，
                份额在收盘后（15:02 起）自动定稿入库（<code>data/wangwang.db</code>），无需手工跑脚本。
                抓取失败时沿用上一份缓存基准，不会把均额写成 0。
              </p>
            </div>
          </div>
          <div className="disc">
            「国家队 / 汪汪队」为市场俗称，非官方表述。本页结论基于公开行情的量价特征推测，不能证明任何机构当日是否交易。
            <b>需要特别说明：ETF 定期报告停止披露前十大持有人的政策导向之一，正是减少把平准类资金进出解读为「救市 / 利好」信号的噪音交易；
            本页所做的事与该导向相悖，仅适合投顾内部研究，不建议作为对客内容或投资建议对外发布。</b>
            数据来自第三方公开接口，可能存在延迟、缺失或口径差异，请以基金公司公告与交易所披露为准。投资有风险。
          </div>
          <div className="sign">
            数据来源：腾讯行情 + 新浪 5 分钟 K 线（日内分布）· 汇金名单：Wind 2025年报前十大持有人口径（2026-05-01 起停止披露，此后不可验证）
            · 快照生成 {snap?.generated_at ?? "—"} · 仅供内部研究，不构成投资建议
          </div>
        </footer>
      </div>
    </div>
  );
}

export default WangWangPage;
