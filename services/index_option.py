"""股指期权（IO / MO / HO）：链快照、方向评分、可执行建议。

与 ETF 期权的差异（都在这里消化，上层不用感知）：
- 到期日是**第 3 个星期五**，不是第 4 个星期三；
- 合约代码自带全部信息（MO2611-C-7000），比简称可靠；
- 标的是指数本身，没有独立 ETF 行情，直接取指数实时价；
- 乘数 100 元/点。

纯计算部分（bias / realized_vol / iv_rv / _iv_note）不触网，供测试直接调用。
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging

from config import settings
from services import bs, em, iv_history as ivh
from services import option_service as osvc
from services import strategy, vol

log = logging.getLogger("indexopt")

# 中金所三个品种：东财市场码 221，期权共用同一市场
_INDEX_MARKET = 221
_INDEX_FIELDS = ("f12,f13,f14,f2,f3,f4,f5,f6,f15,f16,f17,f18,f31,f32,f108")

FUT_OPTS = [
    {"code": "MO", "name": "中证1000", "underlying": "1.000852", "track": "中证1000"},
    {"code": "IO", "name": "沪深300", "underlying": "1.000300", "track": "沪深300"},
    {"code": "HO", "name": "上证50", "underlying": "1.000016", "track": "上证50"},
]
_BY_CODE = {f["code"]: f for f in FUT_OPTS}

realized_vol = vol.realized_vol
iv_rv = vol.iv_rv


def expiry(month: int) -> dt.date:
    """到期月（如 2611）→ 该月第 3 个星期五。"""
    return osvc.third_friday(2000 + month // 100, month % 100)


def _days(month: int, today: dt.date | None = None) -> int:
    today = today or dt.date.today()
    return max((expiry(month) - today).days, 0)


def _enrich(row: dict, spot: float, today: dt.date) -> dict | None:
    """东财行 → 归一化合约（含 BS 隐波/希腊字母），与 option_service 同构。"""
    meta = osvc.contract_meta(row, {"kind": "index"})
    if not meta:
        return None
    strike, month, is_call = meta["strike"], meta["month"], meta["is_call"]
    exp = meta["expiry"]
    last = em.num(row.get("f2"))
    bid, ask = em.num(row.get("f31")), em.num(row.get("f32"))
    mid = (bid + ask) / 2 if bid and ask else last
    t = max((exp - today).days, 0) / 365.0
    r = settings.risk_free_rate
    iv = bs.implied_vol(mid, spot, strike, t, r, is_call) if strike and spot else None
    out = {
        "code": row.get("f12"),
        "market": row.get("f13"),
        "secid": f"{row.get('f13')}.{row.get('f12')}",
        "name": row.get("f14"),
        "is_call": is_call,
        "type": "call" if is_call else "put",
        "strike": strike,
        "expiry": exp.isoformat(),
        "month": month,
        "days": max((exp - today).days, 0),
        "last": last,
        "pct": em.num(row.get("f3")),
        "change": em.num(row.get("f4")),
        "volume": em.num(row.get("f5")),
        "amount": em.num(row.get("f6")),
        "high": em.num(row.get("f15")),
        "low": em.num(row.get("f16")),
        "open": em.num(row.get("f17")),
        "prev_close": em.num(row.get("f18")),
        "bid": bid,
        "ask": ask,
        "oi": em.num(row.get("f108")),
        "multiplier": 100,
    }
    out["spread"] = round((ask - bid) / mid * 100, 2) if bid and ask and mid else None
    out["moneyness"] = round((spot - strike) / spot, 4) if spot else 0
    out["itm"] = (spot > strike) if is_call else (spot < strike)
    out["premium_rate"] = (round(bs.premium_rate(mid or last, spot, strike, is_call) * 100, 3)
                           if strike and spot else None)
    out["iv"] = round(iv * 100, 2) if iv else None
    if iv:
        g = bs.greeks(spot, strike, t, r, iv, is_call)
        out.update({"delta": round(g["delta"], 4), "gamma": round(g["gamma"], 4),
                    "vega": round(g["vega"], 4), "theta": round(g["theta"], 5),
                    "leverage": round(bs.leverage(mid or last, spot, g["delta"]), 1),
                    "break_even": round(bs.break_even(strike, mid or last, is_call), 4)})
    else:
        out.update({"delta": None, "gamma": None, "vega": None, "theta": None,
                    "leverage": None, "break_even": None})
    out["atm"] = abs(out["moneyness"]) <= 0.015
    return out


def _raw(symbol: str) -> list[dict]:
    return []


async def _raw_chain(symbol: str) -> list[dict]:
    rows = await em.clist_all(f"m:{_INDEX_MARKET}", _INDEX_FIELDS, pz=100, ttl=45.0)
    codes = [r for r in rows if (r.get("f12") or "").startswith(symbol)]
    if not codes:
        return []
    # 中金所期权（m:221）的 clist 不给最新价（f2/f3/f4 恒为 "-"），
    # 必须用 ulist 批量补齐，否则整条链 last 全空、优选合约也是空的。
    quotes = await em.ulist_quotes([f"{_INDEX_MARKET}.{r['f12']}" for r in codes])
    for r in codes:
        hit = quotes.get(r.get("f12"))
        if not hit:
            continue
        for k in ("f2", "f3", "f4", "f31", "f32"):
            v = hit.get(k)
            if v not in (None, "", "-"):
                r[k] = v
    return codes


async def chain(symbol: str) -> dict:
    fut = _BY_CODE.get(symbol)
    if not fut:
        return {"error": f"未知股指期权品种 {symbol}"}
    today = dt.date.today()
    q, raw = await asyncio.gather(
        em.stock_get(fut["underlying"], "f43,f44,f45,f46,f47,f48,f57,f58,f60,f169,f170,f171"),
        _raw_chain(symbol),
    )
    s = em.num(q.get("f43")) if q else 0.0
    underlying = {
        "code": fut["underlying"], "name": em.f(q.get("f58"), fut["name"]) if q else fut["name"],
        "price": s,
        "pct": em.num(q.get("f170")) if q else 0.0,
        "high": em.num(q.get("f44")) if q else None,
        "low": em.num(q.get("f45")) if q else None,
        "open": em.num(q.get("f46")) if q else None,
        "prev_close": em.num(q.get("f60")) if q else None,
        "volume": em.num(q.get("f47")) if q else 0,
        "amount": em.num(q.get("f48")) if q else 0,
    }
    contracts = [c for c in (_enrich(r, s, today) for r in raw) if c]
    contracts.sort(key=lambda x: (x["days"], x["strike"], not x["is_call"]))
    exp_map: dict[int, dict] = {}
    for c in contracts:
        exp_map.setdefault(c["month"], {"month": c["month"], "expiry": c["expiry"],
                                        "days": c["days"]})
    expiries = sorted(exp_map.values(), key=lambda x: x["days"])
    front = expiries[0]["month"] if expiries else None
    return {
        "symbol": symbol, "fut": fut, "underlying": underlying,
        "expiries": [e["month"] for e in expiries],
        "expiry_list": expiries,
        "front_month": front,
        "count": len(contracts),
        "contracts": contracts,
        "stats": osvc._chain_stats(contracts, s, front, symbol),
    }


# ═══════════════════════════════════════════════════════════════════════════
# 方向评分（纯函数）
# ═══════════════════════════════════════════════════════════════════════════

_BIAS_CALL = 15


def bias(trends: list[dict] | None, contracts: list[dict] | None,
         flow: dict | None, basis: dict | None) -> dict:
    """股指方向评分 [-100, 100]，>0 看多。

    A 股股指期权的方向不来自期权自身，而来自标的现货的日内结构与期现价差：
      1. 现货分时动量（权重 25）——日内趋势是最直接的信号；
      2. 现货在日内区间的位置（权重 15）——顶在最高价附近=买盘强；
      3. 主力资金净额（权重 10）——当日累计口径，方向确认；
      4. 期现基差（每 1% 计 12 分）——贴水（basis<0）说明期货看空/对冲盘重。
    任一因子缺失按 0 计，不足 15 分算中性。
    """
    score = 0.0
    detail: dict[str, float] = {}

    tr = [t for t in (trends or []) if (t or {}).get("price")]
    if len(tr) >= 2:
        p0, p1 = tr[0]["price"], tr[-1]["price"]
        if p0:
            v = max(-25.0, min(25.0, (p1 / p0 - 1) * 100 * 25))
            score += v
            detail["现货动量"] = round(v, 1)

    cs = [c for c in (contracts or []) if (c or {}).get("price")]
    if cs:
        c = cs[0]
        hi, lo, px = c.get("high"), c.get("low"), c.get("price")
        if hi and lo and hi > lo:
            v = max(-15.0, min(15.0, (px - (hi + lo) / 2) / ((hi - lo) / 2) * 15))
            score += v
            detail["区间位置"] = round(v, 1)

    main = em.num((flow or {}).get("f137"))
    if main:
        v = max(-10.0, min(10.0, main / 3e8 * 10))
        score += v
        detail["主力资金"] = round(v, 1)

    bp = (basis or {}).get("basis_pct")
    if bp is not None:
        v = max(-12.0, min(12.0, float(bp) * 12))
        score += v
        detail["期现基差"] = round(v, 1)

    score = round(max(-100.0, min(100.0, score)), 1)
    direction = "call" if score >= _BIAS_CALL else "put" if score <= -_BIAS_CALL else "neutral"
    return {"score": score, "direction": direction,
            "confidence": round(min(abs(score) / 100, 1), 2), "detail": detail}


async def direction(symbol: str) -> dict:
    """单品种方向的**轻量**路径：只取现货分时/资金流/最新价，不拉期权链。

    `state()` 会拉 730 条合约，用在左栏列表的 60s 轮询里等于把链路打满；
    这里刻意省掉链，基差也退化成「现货自身」口径（缺 = 不计该因子）。
    """
    fut = _BY_CODE.get(symbol.upper())
    if not fut:
        return {"direction": "neutral", "score": 0, "confidence": 0}
    secid = fut["underlying"]
    tr, flow, q = await asyncio.gather(
        em.trends(secid), em.stock_get(secid, "f137", ttl=20.0),
        em.stock_get(secid, "f43,f44,f45,f46,f170", ttl=20.0),
        return_exceptions=True,
    )
    tr = tr if isinstance(tr, list) else []
    flow = flow if isinstance(flow, dict) else None
    q = q if isinstance(q, dict) else {}
    price = em.num(q.get("f43"))
    b = bias(tr, [{"price": price, "high": em.num(q.get("f44")),
                   "low": em.num(q.get("f45"))}] if price else [], flow, None)
    return {"direction": b["direction"], "score": b["score"],
            "confidence": b["confidence"]}


def _signals(state: dict, b: dict) -> list[dict]:
    """把评分拆成可读信号（前端信号区/告警正文）。"""
    out = []
    for k, v in (b.get("detail") or {}).items():
        if not v:
            continue
        out.append({"text": f"{k} {'偏多' if v > 0 else '偏空'} {abs(v):.0f} 分",
                    "dir": "call" if v > 0 else "put", "weight": abs(v)})
    ivrv = state.get("iv_rv") or {}
    note = _iv_note(state.get("chain_stats") or {}, ivrv)
    if note:
        out.append({"text": note, "dir": "neutral", "weight": 0})
    out.sort(key=lambda x: -x["weight"])
    return out


def _iv_note(chain: dict, ivrv: dict | None) -> str | None:
    """IV 贵不贵的一句话：分位优先，其次 IV/已实现波动。

    接受完整链（带 ``stats``）或裸 stats——分位在 stats 里，取错层级会永远退到
    IV/RV 口径，看不到「处 20 日多少分位」这句最关键的判断。
    """
    if chain and "stats" not in chain:
        chain = {"stats": chain}
    return vol.iv_note(chain or {}, ivrv)


def _advice(state: dict, b: dict, levels: dict | None, spot: float) -> dict:
    """给出可执行建议：方向 + 价位 + 盈亏比（rr 用价格结构，不用 Δ 折算）。"""
    direction = b.get("direction") or "neutral"
    side = "call" if direction == "call" else "put" if direction == "put" else None
    if not side:
        return {"action": "观望", "side": None, "reason": "方向中性（评分未过 ±15）"}
    best = (state.get("candidates") or [None])[0]
    if not best or not levels:
        return {"action": "观望", "side": side, "reason": "无合适合约或缺少关键位"}

    entry = levels.get("entry_break")
    stop = levels.get("stop")
    target = levels.get("target")
    delta = best.get("delta") or 0
    cur = best.get("last")
    if not (entry and stop and target and delta and cur):
        return {"action": "观望", "side": side, "reason": "合约缺少 Delta/报价，无法折算"}

    def px(x: float) -> float:
        return round(max(cur + delta * (x - spot), 0.0001), 4)

    c_entry, c_stop, c_target = px(entry), px(stop), px(target)
    # 用**合约价结构**算盈亏比：买方实际赚/亏的就是这两个数
    profit = abs(c_target - c_entry)
    loss = abs(c_entry - c_stop)
    hard_stop = round(c_entry * 0.70, 4)
    c_stop = max(c_stop, hard_stop) if side == "call" else min(c_stop, hard_stop)
    loss = abs(c_entry - c_stop)
    rr = round(profit / loss, 2) if loss else None
    return {
        "action": "买入", "side": side,
        "code": best.get("code"), "name": best.get("name"),
        "entry": c_entry, "stop": c_stop, "target": c_target,
        "entry_pct": round((c_entry / cur - 1) * 100, 1) if cur else None,
        "stop_pct": round((c_stop / c_entry - 1) * 100, 1) if c_entry else None,
        "target_pct": round((c_target / c_entry - 1) * 100, 1) if c_entry else None,
        "rr": rr, "multiplier": 100,
        "cost": round(c_entry * 100, 0),
        "profit": round(profit * 100, 0), "loss": round(loss * 100, 0),
        "reason": (f"{'看多' if side == 'call' else '看空'}评分 {b.get('score')}，"
                   f"突破 {entry} 入场、{stop} 止损、看向 {target}"),
    }


async def state(symbol: str) -> dict:
    """单品种快照：链 + 现货分时/资金流 + 方向评分 + 建议。"""
    fut = _BY_CODE.get(symbol)
    if not fut:
        return {"error": f"未知股指期权品种 {symbol}"}
    ch = await chain(symbol)
    if ch.get("error"):
        return ch
    underlying = ch.get("underlying") or {}
    spot = underlying.get("price") or 0.0
    tr, flow, kline = await asyncio.gather(
        em.trends(fut["underlying"]),
        em.stock_get(fut["underlying"], "f137", ttl=20.0),
        em.kline(fut["underlying"], klt=1, lmt=240),
        return_exceptions=True,
    )
    tr = tr if isinstance(tr, list) else []
    flow = flow if isinstance(flow, dict) else None
    kline = kline if isinstance(kline, list) else []
    basis = _basis_info(ch, spot)
    b = bias(tr, [{"price": spot, "high": underlying.get("high"),
                   "low": underlying.get("low")}], flow, basis)
    ivrv = iv_rv(ch, kline)
    st = {**ch, "bias": b, "iv_rv": ivrv, "basis": basis,
          "chain_stats": ch.get("stats")}
    levels = strategy.plan_levels({"kline_1m": kline, "quote": underlying}, b["direction"]) \
        if kline else {}
    st["levels"] = levels
    st["candidates"] = osvc.rank_candidates(
        strategy.chain_for_month(ch, ch.get("front_month")), b["direction"] or "auto",
        top=6, trend={**b, "iv_rv_ratio": (ivrv or {}).get("ratio")},
        levels=levels, spot=spot) if ch.get("contracts") else []
    st["advice"] = _advice(st, b, levels, spot)
    st["signals"] = _signals(st, b)
    return st


def _basis_info(ch: dict, spot: float) -> dict | None:
    """近月平值期权隐含远期 − 现货：返回期指点位 `price` 与基差百分比。

    前端卡片要显示「期指点位（基差%）」，只给百分比会渲染成「—（-0.6%）」，
    看起来像没数据。正基差 = 升水/看多。
    """
    if not spot:
        return None
    front = ch.get("front_month")
    cs = [c for c in (ch.get("contracts") or []) if c.get("month") == front and c.get("atm")]
    if not cs:
        return None
    # 用平值认购+认沽反解隐含远期的近似：C - P + K ≈ F
    call = next((c for c in cs if c["is_call"] and c.get("last")), None)
    put = next((c for c in cs if not c["is_call"] and c.get("last")), None)
    if not call or not put or call["strike"] != put["strike"]:
        return None
    fwd = call["last"] - put["last"] + call["strike"]
    return {"price": round(fwd, 2),
            "basis_pct": round((fwd / spot - 1) * 100, 3),
            "spot": round(spot, 2)}


async def overview() -> dict:
    """三个品种的概览（列表/顶栏用），单品种失败不影响其它。"""
    res = await asyncio.gather(*[state(f["code"]) for f in FUT_OPTS],
                               return_exceptions=True)
    items = []
    for fut, r in zip(FUT_OPTS, res):
        if isinstance(r, Exception) or (isinstance(r, dict) and r.get("error")):
            items.append({"code": fut["code"], "name": fut["name"],
                          "error": str(r)[:120] if isinstance(r, Exception) else r.get("error")})
            continue
        items.append({
            "code": fut["code"], "name": fut["name"],
            "underlying": r.get("underlying"), "front_month": r.get("front_month"),
            "count": r.get("count"), "stats": r.get("chain_stats"),
            "bias": r.get("bias"), "iv_rv": r.get("iv_rv"),
            "advice": r.get("advice"),
        })
    return {"items": items}


async def bundle(symbol: str) -> dict:
    """与 strategy.analyze 同构的完整包（前端可直接复用行情卡组件）。"""
    st = await state(symbol)
    if st.get("error"):
        return st
    fut = _BY_CODE[symbol]
    levels = st.get("levels") or {}
    b = st.get("bias") or {}
    plan_dir = b.get("direction") if b.get("direction") in ("call", "put") else "call"
    reverse_dir = "put" if plan_dir == "call" else "call"
    rev_levels = strategy.pullback_plan(
        strategy.plan_levels({"kline_1m": [], "quote": st.get("underlying")}, reverse_dir)) \
        if levels else {}
    spot = (st.get("underlying") or {}).get("price") or 0.0
    cands = st.get("candidates") or []
    work = strategy.chain_for_month(st, st.get("front_month"))
    rev_cands = osvc.rank_candidates(work, reverse_dir, top=3,
                                     trend={**b, "iv_rv_ratio": (st.get("iv_rv") or {}).get("ratio")},
                                     levels=rev_levels, spot=spot) if work.get("contracts") else []
    return {
        "kind": "index",
        "symbol": symbol,
        "fut": fut,
        "underlying": st.get("underlying"),
        "chain_stats": st.get("chain_stats"),
        "iv_rv": st.get("iv_rv"),
        "front_month": st.get("front_month"),
        "expiry_list": st.get("expiry_list"),
        "bias": b,
        "signals": st.get("signals"),
        "levels": levels,
        "levels_by_side": {
            "call": levels if plan_dir == "call" else rev_levels,
            "put": levels if plan_dir == "put" else rev_levels,
        },
        "advice": st.get("advice"),
        "recommendation": {
            "primary": strategy.recommend_card(cands[0] if cands else None,
                                               levels, spot, plan_dir, "primary"),
            "reverse": strategy.recommend_card(rev_cands[0] if rev_cands else None,
                                               rev_levels, spot, reverse_dir, "reverse"),
            "reverse_note": "逆势方向，只在对冲或明确反转信号时小仓参与",
        },
        "candidates": [{k: v for k, v in c.items() if not k.startswith("_")} for c in cands],
        "basis": st.get("basis"),
    }
