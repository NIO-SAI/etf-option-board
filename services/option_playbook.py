"""A 股 ETF 期权策略册：从东财期权链直接构造多腿组合，并给出到期损益与适配理由。

与 ``decision.select_strategy``（买方四类，见 ADR 0002）互补：这里覆盖**卖方与
中性/持有现货**的策略，是原美股期权 skill 的策略清单在 A 股口径下的落地版本。

A 股约束（构造时必须遵守）：

- 合约单位 10000 份/张，卖方按交易所公式收保证金（``payoff.short_margin``）；
- 最长月份约 4 个月，**没有 LEAPS**，故不收 PMCC/对角线（长腿超不过 4 个月，
  与美股「LEAPS 备兑」不是一回事）；日历价差因此只做「同月份选择」，不跨月建仓；
- 美式实物交割：卖方存在被提前指派风险，深度实值认购在除息前尤甚；
- T+0、有涨跌停，到期日 = 到期月第 4 个星期三。

纯函数：只读传入的 chain 字典。
"""

from __future__ import annotations

from services import payoff

MULT = payoff.MULT


def _price(c: dict) -> float | None:
    bid, ask, last = c.get("bid"), c.get("ask"), c.get("last")
    if bid and ask and ask > 0:
        return round((bid + ask) / 2, 4)
    return last if last and last > 0 else None


def _leg(c: dict, qty: int) -> dict:
    return {
        "name": c.get("name"), "code": c.get("code"), "secid": c.get("secid"),
        "type": c.get("type"), "strike": c.get("strike"), "month": c.get("month"),
        "days": c.get("days"), "price": _price(c), "qty": qty,
        "delta": c.get("delta"), "gamma": c.get("gamma"),
        "theta": c.get("theta"), "vega": c.get("vega"), "iv": c.get("iv"),
        "settle": c.get("prev_close"),
    }


def month_contracts(chain: dict, month: int, side: str) -> list[dict]:
    """某月某方向的合约，按行权价升序，且必须有可用价格。"""
    out = [c for c in (chain.get("contracts") or [])
           if c.get("month") == month and c.get("type") == side and _price(c)]
    return sorted(out, key=lambda c: c["strike"] or 0)


def pick_month(chain: dict, prefer_next: bool = False) -> int | None:
    exps = chain.get("expiry_list") or []
    if not exps:
        return chain.get("front_month")
    idx = 1 if prefer_next and len(exps) > 1 else 0
    return exps[idx].get("month")


def pick_by_delta(contracts: list[dict], target: float) -> dict | None:
    """按 |delta| 最接近目标挑合约（卖虚值腿用 0.2~0.3）。"""
    pool = [c for c in contracts if c.get("delta") is not None]
    if not pool:
        return None
    return min(pool, key=lambda c: abs(abs(c["delta"]) - target))


def _beyond(contracts: list[dict], strike: float, direction: str,
            steps: int = 2) -> dict | None:
    """从某行权价向外数 N 档（``direction``="up"/"down"），跳数不足时取最远一档。"""
    if direction == "up":
        pool = [c for c in contracts if (c["strike"] or 0) > strike]
        pool.sort(key=lambda c: c["strike"])
    else:
        pool = [c for c in contracts if (c["strike"] or 0) < strike]
        pool.sort(key=lambda c: c["strike"], reverse=True)
    if not pool:
        return None
    return pool[min(steps, len(pool)) - 1]


def _inside(contracts: list[dict], strike: float, direction: str) -> dict | None:
    """向内一档（贴近现价的腿），用于铁鹰长腿贴近短腿的另一种取法。"""
    return _beyond(contracts, strike, direction, steps=1)


def _proposal(kind: str, label: str, legs: list[dict], spot: float,
              why: str, notes: list[str] | None = None) -> dict:
    legs = [leg for leg in legs if leg.get("price")]
    if not legs:
        return {}
    return {
        "kind": kind, "label": label, "legs": legs,
        "analysis": payoff.analyze(legs, spot),
        "why": why, "notes": notes or [],
    }


# ── 各策略构造 ─────────────────────────────────────────────────────────────


def bull_call_spread(chain: dict, month: int, spot: float) -> dict:
    calls = month_contracts(chain, month, "call")
    long_leg = pick_by_delta(calls, 0.50) or (calls[0] if calls else None)
    if not long_leg:
        return {}
    short_leg = _beyond(calls, long_leg["strike"], "up", 2)
    if not short_leg:
        return {}
    return _proposal(
        "bull_call", "牛市看涨价差",
        [_leg(long_leg, 1), _leg(short_leg, -1)], spot,
        f"看多但 IV 偏高：买 {long_leg['strike']:g} 认购、卖 {short_leg['strike']:g} 认购，"
        f"用卖出腿压掉权利金成本，代价是封顶上方收益。",
        ["价差最大亏损=净支出，卖方腿仍需按交易所公式占用保证金（部分券商按价差组合减免）。"])


def bear_put_spread(chain: dict, month: int, spot: float) -> dict:
    puts = month_contracts(chain, month, "put")
    long_leg = pick_by_delta(puts, -0.50) or (puts[-1] if puts else None)
    if not long_leg:
        return {}
    short_leg = _beyond(puts, long_leg["strike"], "down", 2)
    if not short_leg:
        return {}
    return _proposal(
        "bear_put", "熊市看跌价差",
        [_leg(long_leg, 1), _leg(short_leg, -1)], spot,
        f"看空但 IV 偏高：买 {long_leg['strike']:g} 认沽、卖 {short_leg['strike']:g} 认沽，"
        f"降低成本，代价是下方收益封顶。",
        ["认沽卖方腿在深度实值时可能被提前指派（美式实物交割）。"])


def iron_condor(chain: dict, month: int, spot: float) -> dict:
    puts = month_contracts(chain, month, "put")
    calls = month_contracts(chain, month, "call")
    sp = pick_by_delta([c for c in puts if (c["strike"] or 0) < spot], 0.20)
    sc = pick_by_delta([c for c in calls if (c["strike"] or 0) > spot], 0.20)
    if not sp or not sc:
        return {}
    lp = _beyond(puts, sp["strike"], "down", 2)
    lc = _beyond(calls, sc["strike"], "up", 2)
    if not lp or not lc:
        return {}
    width_p = round(sp["strike"] - lp["strike"], 4)
    width_c = round(lc["strike"] - sc["strike"], 4)
    return _proposal(
        "iron_condor", "卖出铁鹰（区间震荡）",
        [_leg(sp, -1), _leg(lp, 1), _leg(sc, -1), _leg(lc, 1)], spot,
        f"IV 分位偏高且预期震荡：卖 {sp['strike']:g}/{sc['strike']:g}、"
        f"买 {lp['strike']:g}/{lc['strike']:g} 做保护，收取时间价值。",
        [f"两翼宽度不对称（{width_p:g} / {width_c:g}），最大亏损取较宽一侧；"
         f"整组四腿，任一方向被击穿需及时移仓或止损。",
         "卖方保证金按交易所公式逐腿计算，组合优惠需券商支持。"])


def covered_call(chain: dict, month: int, spot: float) -> dict:
    calls = month_contracts(chain, month, "call")
    short_leg = pick_by_delta([c for c in calls if (c["strike"] or 0) > spot], 0.25)
    if not short_leg:
        return {}
    stock = {"name": "ETF 现货", "type": "stock", "price": spot,
             "qty": MULT, "strike": None}
    return _proposal(
        "covered_call", "备兑认购（持有 ETF 收租）",
        [stock, _leg(short_leg, -1)], spot,
        f"持有 1 万份 ETF，卖出 {short_leg['strike']:g} 认购收权利金；"
        f"上方收益被封顶，下方风险与直接持股相同（权利金提供缓冲）。",
        ["A 股 ETF 期权为实物交割：到期实值时需交付 10000 份 ETF，"
         "账户须有足额现货，否则按违约处理。",
         "除息日前深度实值认购易被提前行权，需提前移仓。"])


def protective_put(chain: dict, month: int, spot: float) -> dict:
    puts = month_contracts(chain, month, "put")
    long_leg = pick_by_delta([c for c in puts if (c["strike"] or 0) < spot], -0.30)
    if not long_leg:
        return {}
    stock = {"name": "ETF 现货", "type": "stock", "price": spot,
             "qty": MULT, "strike": None}
    cost = long_leg.get("iv")
    return _proposal(
        "protective_put", "保护性认沽（给持仓买保险）",
        [stock, _leg(long_leg, 1)], spot,
        f"持有 1 万份 ETF，买 {long_leg['strike']:g} 认沽锁定下方；"
        f"最大亏损=权利金+行权价下方差额，上方收益不受限。",
        [f"保险费率约 {((_price(long_leg) or 0) / spot * 100):.2f}% 的标的市值"
         f"（IV {cost}%），持有期间每日时间价值损耗。",
         "替代止损：不会像止损单那样被日内插针打掉，但成本确定性地付出去。"])


def collar(chain: dict, month: int, spot: float) -> dict:
    calls = month_contracts(chain, month, "call")
    puts = month_contracts(chain, month, "put")
    short_call = pick_by_delta([c for c in calls if (c["strike"] or 0) > spot], 0.25)
    long_put = pick_by_delta([c for c in puts if (c["strike"] or 0) < spot], -0.25)
    if not short_call or not long_put:
        return {}
    stock = {"name": "ETF 现货", "type": "stock", "price": spot,
             "qty": MULT, "strike": None}
    return _proposal(
        "collar", "领口（持股+买沽+卖购）",
        [stock, _leg(long_put, 1), _leg(short_call, -1)], spot,
        f"买 {long_put['strike']:g} 认沽护下方、卖 {short_call['strike']:g} 认购融资，"
        f"用上方收益换取近乎免费的保险；适合事件前（如宏观数据、隔夜美股大跌）。",
        ["A 股无财报事件，触发事件换成：宏观数据日、政策会议、外围隔夜暴跌。",
         "上下都被锁死，行情单边大涨时只能拿到封顶收益。"])


def long_straddle(chain: dict, month: int, spot: float) -> dict:
    calls = month_contracts(chain, month, "call")
    puts = month_contracts(chain, month, "put")
    atm_c = pick_by_delta(calls, 0.50)
    atm_p = pick_by_delta(puts, -0.50)
    if not atm_c or not atm_p:
        return {}
    return _proposal(
        "long_straddle", "买入跨式（赌大波动）",
        [_leg(atm_c, 1), _leg(atm_p, 1)], spot,
        f"同时买 {atm_c['strike']:g} 认购与认沽，方向不重要、只要波动足够大；"
        f"需标的走出权利金总和的距离才保本。",
        ["IV 偏高时买方为波动率溢价付钱，跨式最容易「方向对了仍亏」。",
         "A 股 ETF 期权无财报事件，纯波动率事件驱动（政策/数据）时适用。"])


def long_strangle(chain: dict, month: int, spot: float) -> dict:
    calls = month_contracts(chain, month, "call")
    puts = month_contracts(chain, month, "put")
    otm_c = pick_by_delta([c for c in calls if (c["strike"] or 0) > spot], 0.25)
    otm_p = pick_by_delta([c for c in puts if (c["strike"] or 0) < spot], -0.25)
    if not otm_c or not otm_p:
        return {}
    return _proposal(
        "long_strangle", "买入宽跨式（更便宜的波动赌注）",
        [_leg(otm_c, 1), _leg(otm_p, 1)], spot,
        f"买虚值 {otm_c['strike']:g} 认购 + {otm_p['strike']:g} 认沽，成本低于跨式，"
        f"但需要更大的波动才盈利。",
        ["虚值腿 theta 衰减更快，不适合长时间持有。"])


def short_strangle(chain: dict, month: int, spot: float) -> dict:
    calls = month_contracts(chain, month, "call")
    puts = month_contracts(chain, month, "put")
    sc = pick_by_delta([c for c in calls if (c["strike"] or 0) > spot], 0.20)
    sp = pick_by_delta([c for c in puts if (c["strike"] or 0) < spot], -0.20)
    if not sc or not sp:
        return {}
    return _proposal(
        "short_strangle", "卖出宽跨式（收权利金，无保护）",
        [_leg(sp, -1), _leg(sc, -1)], spot,
        f"卖 {sp['strike']:g} 认沽与 {sc['strike']:g} 认购，IV 高位收租；"
        f"两侧均无保护，单边大行情下亏损无上限。",
        ["无翼卖出风险极高，A 股有涨跌停但连续单边仍会造成大额浮亏；"
         "保证金按交易所公式逐腿占用，行情反向时还会被追保。",
         "若要做卖方，优先用带翼的 iron_condor（有限风险）。"])


_BUILDERS = {
    "bull_call": bull_call_spread,
    "bear_put": bear_put_spread,
    "iron_condor": iron_condor,
    "covered_call": covered_call,
    "protective_put": protective_put,
    "collar": collar,
    "long_straddle": long_straddle,
    "long_strangle": long_strangle,
    "short_strangle": short_strangle,
}

# 适配矩阵：方向 × IV 分位 → 推荐顺序（IV 分位来源同 decision：≥75 高、≤25 低）
_PLAYBOOK = {
    ("call", "high"): ["bull_call", "covered_call"],
    ("call", "low"): ["long_strangle", "bull_call"],
    ("call", "mid"): ["bull_call", "covered_call"],
    ("put", "high"): ["bear_put", "collar"],
    ("put", "low"): ["bear_put", "protective_put"],
    ("put", "mid"): ["bear_put", "protective_put"],
    ("neutral", "high"): ["iron_condor", "short_strangle", "covered_call"],
    ("neutral", "low"): ["long_straddle", "long_strangle"],
    ("neutral", "mid"): ["iron_condor", "covered_call"],
}


def _iv_bucket(iv_pct: float | None) -> str:
    if iv_pct is None:
        return "mid"
    if iv_pct >= 75:
        return "high"
    if iv_pct <= 25:
        return "low"
    return "mid"


def suggest(chain: dict, direction: str | None = None,
            iv_pct: float | None = None, prefer_next: bool = False,
            limit: int = 4, month: int | None = None) -> dict:
    """按「方向 × IV 分位」给出策略候选（含完整到期损益）。

    ``direction`` 取 ``call``/``put``/``neutral``；为空时按中性处理。
    返回 ``{month, iv_pct, iv_bucket, items:[...]}``，每条已算好 max profit/loss、
    保本点、组合希腊字母与保证金。
    """
    spot = (chain.get("underlying") or {}).get("price") or 0
    if spot <= 0:
        return {"error": "标的价格缺失", "items": []}
    month = month or pick_month(chain, prefer_next)
    if not month:
        return {"error": "无可用到期月", "items": []}
    d = direction if direction in ("call", "put", "neutral") else "neutral"
    bucket = _iv_bucket(iv_pct)
    kinds = _PLAYBOOK.get((d, bucket), [])[:limit]

    items, seen = [], set()
    for kind in kinds:
        p = _BUILDERS[kind](chain, month, spot)
        if p and p["kind"] not in seen:
            p["fit"] = {"direction": d, "iv_bucket": bucket}
            items.append(p)
            seen.add(p["kind"])

    # 矩阵没覆盖到时（如当月链太稀）兜底给一条最稳的
    if not items:
        for kind in ("iron_condor", "bull_call"):
            p = _BUILDERS[kind](chain, month, spot)
            if p:
                p["fit"] = {"direction": d, "iv_bucket": bucket, "fallback": True}
                items.append(p)
                break
    return {"month": month, "spot": round(spot, 4), "iv_pct": iv_pct,
            "iv_bucket": bucket, "direction": d, "items": items}
