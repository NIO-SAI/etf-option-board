"""期权定价：Black-Scholes 隐含波动率 + 希腊字母 + 溢价率。

A 股 ETF 期权为美式实物交割，但业界通用的 IV/希腊字母口径即 BS 欧式近似，
东财/交易所展示的隐波亦按此口径，故此处与之对齐。
"""

from __future__ import annotations

import math

SQRT2PI = math.sqrt(2 * math.pi)


def _norm_cdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / math.sqrt(2)))


def _norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / SQRT2PI


def d1d2(s: float, k: float, t: float, r: float, sigma: float) -> tuple[float, float]:
    if t <= 0 or sigma <= 0 or s <= 0 or k <= 0:
        return 0.0, 0.0
    v = sigma * math.sqrt(t)
    d1 = (math.log(s / k) + (r + 0.5 * sigma * sigma) * t) / v
    return d1, d1 - v


def price(s: float, k: float, t: float, r: float, sigma: float, is_call: bool) -> float:
    if t <= 0:
        intrinsic = max(s - k, 0.0) if is_call else max(k - s, 0.0)
        return intrinsic
    d1, d2 = d1d2(s, k, t, r, sigma)
    disc = math.exp(-r * t)
    if is_call:
        return s * _norm_cdf(d1) - k * disc * _norm_cdf(d2)
    return k * disc * _norm_cdf(-d2) - s * _norm_cdf(-d1)


def greeks(s: float, k: float, t: float, r: float, sigma: float, is_call: bool) -> dict:
    if t <= 0 or sigma <= 0:
        return {"delta": 0.0, "gamma": 0.0, "vega": 0.0, "theta": 0.0, "rho": 0.0}
    d1, d2 = d1d2(s, k, t, r, sigma)
    disc = math.exp(-r * t)
    nd1 = _norm_cdf(d1)
    delta = nd1 if is_call else nd1 - 1
    gamma = _norm_pdf(d1) / (s * sigma * math.sqrt(t))
    vega = s * _norm_pdf(d1) * math.sqrt(t) / 100  # 每 1% 波动率
    common = -(s * _norm_pdf(d1) * sigma) / (2 * math.sqrt(t))
    if is_call:
        theta = (common - r * k * disc * _norm_cdf(d2)) / 365
        rho = k * t * disc * _norm_cdf(d2) / 100
    else:
        theta = (common + r * k * disc * _norm_cdf(-d2)) / 365
        rho = -k * t * disc * _norm_cdf(-d2) / 100
    return {"delta": delta, "gamma": gamma, "vega": vega, "theta": theta, "rho": rho}


def implied_vol(market_price: float, s: float, k: float, t: float, r: float,
                is_call: bool, lo: float = 0.001, hi: float = 5.0) -> float | None:
    """Newton-Raphson + 二分兜底。返回年化 IV（小数，如 0.35=35%）。"""
    if market_price is None or market_price <= 0 or s <= 0 or k <= 0 or t <= 0:
        return None
    intrinsic = max(s - k, 0.0) if is_call else max(k - s, 0.0)
    if market_price < intrinsic - 1e-9:
        return None
    if market_price == intrinsic:
        return lo

    sigma = 0.5
    for _ in range(60):
        p = price(s, k, t, r, sigma, is_call)
        d1, _ = d1d2(s, k, t, r, sigma)
        vega = s * _norm_pdf(d1) * math.sqrt(t)
        if vega < 1e-8:
            break
        diff = p - market_price
        if abs(diff) < 1e-7:
            return sigma if lo <= sigma <= hi else None
        sigma -= diff / vega
        if sigma <= lo or sigma >= hi:
            break

    # 二分兜底
    a, b = lo, hi
    for _ in range(80):
        m = (a + b) / 2
        pm = price(s, k, t, r, m, is_call)
        if abs(pm - market_price) < 1e-7:
            return m
        if pm > market_price:
            b = m
        else:
            a = m
    return (a + b) / 2


def premium_rate(market_price: float, s: float, k: float, is_call: bool) -> float:
    """溢价率（相对标的）：认购 = (权利金 - 内在价值)/标的；卖出方视角衡量贵不贵。"""
    if s <= 0:
        return 0.0
    intrinsic = max(s - k, 0.0) if is_call else max(k - s, 0.0)
    return (market_price - intrinsic) / s


def leverage(market_price: float, s: float, delta: float) -> float:
    """实际杠杆 = |delta| * S / 权利金。"""
    if market_price <= 0:
        return 0.0
    return abs(delta) * s / market_price


def break_even(k: float, market_price: float, is_call: bool) -> float:
    return k + market_price if is_call else k - market_price
