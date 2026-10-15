"""日内技术指标：EMA / MACD / 量能 / 背离 / 支撑压力。纯 Python，无第三方依赖。"""

from __future__ import annotations

# 量能放大「提示」阈值：近5分钟均量 ÷ 近端均量 ≥ 该倍数才提示。
# 告警（monitor）、信号流（strategy）、国家队护盘评分里的放量计数、前端量能高亮统一用此口径。
SURGE_RATIO = 3.0


def ema(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    k = 2 / (period + 1)
    out = [values[0]]
    for v in values[1:]:
        out.append(v * k + out[-1] * (1 - k))
    return out


def macd(closes: list[float], fast: int = 12, slow: int = 26, signal: int = 9) -> dict:
    if len(closes) < slow + signal:
        return {"dif": [], "dea": [], "hist": []}
    ef, es = ema(closes, fast), ema(closes, slow)
    dif = [a - b for a, b in zip(ef, es)]
    dea = ema(dif, signal)
    hist = [(d - e) * 2 for d, e in zip(dif, dea)]
    return {"dif": dif, "dea": dea, "hist": hist}


def macd_state(closes: list[float]) -> dict:
    """返回当前 MACD 动能状态 + 顶/底背离。"""
    m = macd(closes)
    dif, dea, hist = m["dif"], m["dea"], m["hist"]
    if len(hist) < 30:
        return {"ok": False}
    cur = {"dif": dif[-1], "dea": dea[-1], "hist": hist[-1]}
    cur["cross"] = "golden" if dif[-1] > dea[-1] and dif[-2] <= dea[-2] else (
        "dead" if dif[-1] < dea[-1] and dif[-2] >= dea[-2] else "none")
    # 动能强弱：hist 连续同向
    cur["hist_rising"] = hist[-1] > hist[-2] > hist[-3]
    cur["hist_falling"] = hist[-1] < hist[-2] < hist[-3]
    cur["above_zero"] = dif[-1] > 0
    cur["divergence"] = _divergence(closes, hist)
    return {"ok": True, **cur}


def _pivots(series: list[float], win: int = 3) -> tuple[list[int], list[int]]:
    highs, lows = [], []
    for i in range(win, len(series) - win):
        seg = series[i - win:i + win + 1]
        if series[i] == max(seg):
            highs.append(i)
        if series[i] == min(seg):
            lows.append(i)
    return highs, lows


def _divergence(closes: list[float], hist: list[float], look: int = 60) -> dict:
    """价格创新高而 hist 未创新高 → 顶背离；反之为底背离。"""
    if len(closes) < look + 5:
        return {"type": "none"}
    p = closes[-look:]
    h = hist[-len(p):]
    ph, pl = _pivots(p, 2)
    if len(ph) >= 2 and ph[-1] == len(p) - 1 or (ph and ph[-1] >= len(p) - 3):
        i2, i1 = ph[-1], ph[-2]
        if p[i2] > p[i1] and h[i2] < h[i1]:
            return {"type": "bearish", "strength": round((h[i1] - h[i2]) / (abs(h[i1]) + 1e-9), 3)}
    if (pl and pl[-1] >= len(p) - 3) and len(pl) >= 2:
        i2, i1 = pl[-1], pl[-2]
        if p[i2] < p[i1] and h[i2] > h[i1]:
            return {"type": "bullish", "strength": round((h[i2] - h[i1]) / (abs(h[i1]) + 1e-9), 3)}
    return {"type": "none"}


def volume_stats(vols: list[float]) -> dict:
    """当日分钟量能 vs 近端均量的放大倍数。"""
    if len(vols) < 10:
        return {"ok": False}
    recent = vols[-5:]
    base = vols[-60:-5] if len(vols) > 65 else vols[:-5]
    avg = sum(base) / len(base) if base else 0
    cur = sum(recent) / len(recent)
    ratio = (cur / avg) if avg else 0
    peak = max(vols)
    return {
        "ok": True, "ratio": round(ratio, 2),
        "is_surge": ratio >= SURGE_RATIO,
        "peak_ratio": round(vols[-1] / peak, 2) if peak else 0,
        "last": vols[-1],
    }


def support_resistance(closes: list[float], highs: list[float], lows: list[float]) -> dict:
    """用日内枢轴/前高前低估算支撑与压力。"""
    if not closes:
        return {}
    hi, lo = max(highs), min(lows)
    last = closes[-1]
    ph, pl = _pivots(closes, 3)
    highs_px = sorted({closes[i] for i in ph}, reverse=True)
    lows_px = sorted({closes[i] for i in pl})
    res = [x for x in highs_px if x > last][:2]
    sup = [x for x in lows_px if x < last][-2:]
    return {
        "day_high": hi, "day_low": lo, "last": last,
        "resistance": res, "support": sup,
        "pivot_high": round((hi + lo + last) / 3, 4),
    }


def atr(bars: list[dict], period: int = 14) -> float:
    """真实波幅均值（用 bars 的 high/low/close）。"""
    if len(bars) < 2:
        return 0.0
    trs = []
    for i in range(1, len(bars)):
        h, l, pc = bars[i]["high"], bars[i]["low"], bars[i - 1]["close"]
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    seg = trs[-period:] if len(trs) >= period else trs
    return sum(seg) / len(seg) if seg else 0.0


def pct_change(values: list[float], n: int) -> float | None:
    if len(values) <= n or values[-1 - n] == 0:
        return None
    return (values[-1] / values[-1 - n] - 1) * 100
