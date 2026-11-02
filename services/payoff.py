"""多腿期权组合：到期损益（payoff）、保本点、组合希腊字母与 A 股卖方保证金。

A 股 ETF 期权口径（与美股 skill 的差异，全部落在这里）：

- 合约单位 10000 份/张（美股 100），乘数一律 ``MULT``；
- 美式、实物交割，但到期损益仍按内在价值结算（与欧式一致），提前行权只影响
  卖方被指派风险，不影响到期 payoff 形状；
- 卖方保证金按交易所公式计算（见 ``short_margin``），不是美股 4 倍规则。

纯函数：不触网、不读系统时钟、不写磁盘，可直接单测。
"""

from __future__ import annotations

MULT = 10000


def _intrinsic(leg: dict, spot: float) -> float:
    k = leg.get("strike") or 0.0
    if leg.get("type") == "call":
        return max(spot - k, 0.0)
    return max(k - spot, 0.0)


def leg_pnl(leg: dict, spot: float, mult: int = MULT) -> float:
    """单腿在标的价格 ``spot`` 处的到期盈亏（元）。

    ``qty``>0 为买入、<0 为卖出；``type=="stock"`` 表示持有 ETF 现货，
    此时 ``price`` 是成本价、``qty`` 按份计（不做乘数）。
    """
    qty = leg.get("qty") or 0
    px = leg.get("price") or 0.0
    if leg.get("type") == "stock":
        return (spot - px) * qty
    return (_intrinsic(leg, spot) - px) * qty * mult


def legs_pnl(legs: list[dict], spot: float, mult: int = MULT) -> float:
    return sum(leg_pnl(leg, spot, mult) for leg in legs)


def net_premium(legs: list[dict], mult: int = MULT) -> float:
    """净权利金（元）：正数=净收入，负数=净支出。"""
    total = 0.0
    for leg in legs:
        if leg.get("type") == "stock":
            continue
        total -= (leg.get("qty") or 0) * (leg.get("price") or 0.0) * mult
    return round(total, 2)


def leg_greeks(leg: dict, mult: int = MULT) -> dict:
    """单腿希腊字母（已乘合约单位，与账户盈亏同口径）。"""
    qty = leg.get("qty") or 0
    if leg.get("type") == "stock":
        return {"delta": qty, "gamma": 0.0, "theta": 0.0, "vega": 0.0}
    scale = qty * mult
    return {
        "delta": (leg.get("delta") or 0.0) * scale,
        "gamma": (leg.get("gamma") or 0.0) * scale,
        "theta": (leg.get("theta") or 0.0) * scale,
        "vega": (leg.get("vega") or 0.0) * scale,
    }


def position_greeks(legs: list[dict], mult: int = MULT) -> dict:
    out = {"delta": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0}
    for leg in legs:
        g = leg_greeks(leg, mult)
        for k in out:
            out[k] += g[k]
    return {k: round(v, 4) for k, v in out.items()}


def short_margin(leg: dict, prev_close: float, mult: int = MULT) -> float:
    """单腿卖方开仓保证金（交易所公式，元）。

    认购：``[前结算价 + max(12%×标的前收 - 虚值, 7%×标的前收)] × 合约单位``
    认沽：``min([前结算价 + max(12%×标的前收 - 虚值, 7%×行权价), 行权价) × 合约单位``
    虚值：认购 ``max(0, K - S)``，认沽 ``max(0, S - K)``。
    """
    k = leg.get("strike") or 0.0
    px = leg.get("settle") or leg.get("price") or 0.0
    if prev_close <= 0 or k <= 0:
        return 0.0
    if leg.get("type") == "call":
        otm = max(0.0, k - prev_close)
        return round((px + max(0.12 * prev_close - otm, 0.07 * prev_close)) * mult, 2)
    otm = max(0.0, prev_close - k)
    raw = (px + max(0.12 * prev_close - otm, 0.07 * k)) * mult
    return round(min(raw, k * mult), 2)


def margin_total(legs: list[dict], prev_close: float, mult: int = MULT) -> dict:
    """组合保证金（简化：逐腿累加，不套用交易所组合保证金优惠）。

    返回 ``{total, legs:[...], note}``；不含买方权利金支出（那是已付成本）。
    """
    rows = []
    total = 0.0
    for leg in legs:
        if leg.get("type") == "stock" or (leg.get("qty") or 0) >= 0:
            continue
        m = short_margin(leg, prev_close, mult)
        total += m
        rows.append({"name": leg.get("name"), "code": leg.get("code"),
                     "strike": leg.get("strike"), "type": leg.get("type"),
                     "margin": m})
    note = ("逐腿累加，未计交易所组合保证金优惠；垂直/铁鹰价差的实际占用"
            "通常低于此值（价差组合按对边差价的规则可减免）。") if rows else None
    return {"total": round(total, 2), "legs": rows, "note": note}


def _breakevens(spots: list[float], pnls: list[float]) -> list[float]:
    out = []
    for i in range(1, len(spots)):
        a, b = pnls[i - 1], pnls[i]
        if a == 0:
            out.append(spots[i - 1])
        elif a * b < 0:
            x = spots[i - 1] + (0 - a) * (spots[i] - spots[i - 1]) / (b - a)
            out.append(x)
    return [round(x, 4) for x in out]


def _slope_at_high(legs: list[dict], mult: int) -> float:
    """S→∞ 时的损益斜率：现货份数 + 全部认购腿的净份数（到期时认购恒为实值）。"""
    slope = 0.0
    for leg in legs:
        qty = leg.get("qty") or 0
        if leg.get("type") == "stock":
            slope += qty
        elif leg.get("type") == "call":
            slope += qty * mult
    return slope


def analyze(legs: list[dict], spot: float, mult: int = MULT,
            pct: float = 0.2, points: int = 41) -> dict:
    """到期损益分析：最大盈亏、保本点、损益曲线、组合希腊字母、保证金。

    极值在完整定义域上取（S∈[0, 3×现价] ∪ 全部行权价），因为期权的下跌端损失
    天然有界（标的跌到 0 为止）；只有 S→∞ 方向可能无限，用到期斜率解析判定：

    - 斜率为正 → 上方盈利无限（如买入认购），``max_profit=None``；
    - 斜率为负 → 上方亏损无限（如裸卖认购），``max_loss=None``。

    ``curve`` 仍只画现价 ±``pct``，便于前端展示。
    """
    if spot <= 0:
        return {"error": "标的价格无效"}
    strikes = sorted({round(float(leg.get("strike") or 0), 6) for leg in legs
                      if leg.get("type") in ("call", "put") and leg.get("strike")})
    hi_domain = max(spot * 3, (strikes[-1] * 1.5) if strikes else 0)

    def grid(lo: float, hi: float, n: int) -> list[float]:
        pts = {round(lo + (hi - lo) * i / (n - 1), 6) for i in range(n)}
        pts.update(k for k in strikes if lo <= k <= hi)
        pts.add(round(spot, 6))
        return sorted(x for x in pts if x >= 0)

    domain = grid(0.0, hi_domain, points)
    pnls = [round(legs_pnl(legs, s, mult), 2) for s in domain]

    slope_high = _slope_at_high(legs, mult)
    unbounded_profit = slope_high > 1e-6
    unbounded_loss = slope_high < -1e-6
    max_profit = None if unbounded_profit else round(max(pnls), 2)
    max_loss = None if unbounded_loss else round(min(pnls), 2)
    # 下跌端极值严格落在 S→0（持有现货/卖沽）而非行权价平台：不是有界价差，
    # 盈亏比意义不大（价差的最小值在行权价平台上，与 S=0 打平，不算）。
    min_at_zero = pnls[0] < min(pnls[1:]) - 1.0

    curve_spots = grid(spot * (1 - pct), spot * (1 + pct), points)
    curve = [{"spot": round(s, 4), "pnl": round(legs_pnl(legs, s, mult), 2)}
             for s in curve_spots]
    prem = net_premium(legs, mult)
    return {
        "max_profit": max_profit,
        "max_loss": max_loss,
        "unbounded": {"up": unbounded_profit, "down": unbounded_loss},
        "breakevens": _breakevens(domain, pnls),
        "net_premium": prem,
        "net_premium_label": "净收入" if prem > 0 else "净支出" if prem < 0 else "无",
        "profit_range": _profit_range(domain, pnls),
        "greeks": position_greeks(legs, mult),
        "margin": margin_total(legs, spot, mult),
        "curve": curve,
        "spot": round(spot, 4),
        "multiplier": mult,
        "rr": None if unbounded_profit or unbounded_loss or min_at_zero
              else _rr(max_profit, max_loss),
    }


def _profit_range(spots: list[float], pnls: list[float]) -> list[list[float]] | None:
    """盈利区间（连续段），闭区间端点；全区间盈利/亏损返回 None。"""
    segs: list[list[float]] = []
    start = None
    for i, p in enumerate(pnls):
        if p > 0 and start is None:
            start = spots[i]
        elif p <= 0 and start is not None:
            segs.append([round(start, 4), round(spots[i], 4)])
            start = None
    if start is not None:
        segs.append([round(start, 4), round(spots[-1], 4)])
    if not segs or len(segs) == 1 and segs[0][0] == round(spots[0], 4) \
            and segs[0][1] == round(spots[-1], 4):
        return None
    return segs


def _rr(max_profit: float | None, max_loss: float | None) -> float | None:
    if max_profit is None or max_loss is None or max_loss >= 0 or max_profit <= 0:
        return None
    return round(max_profit / abs(max_loss), 2)
