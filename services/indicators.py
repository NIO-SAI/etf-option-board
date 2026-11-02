"""日内技术指标：EMA / MACD / 量能 / 背离 / 支撑压力。纯 Python，无第三方依赖。"""

from __future__ import annotations

# 量能放大「提示」阈值：近1分钟量能 ÷ 近60分钟均量 ≥ 该倍数才提示。
# 告警（monitor）、信号流（strategy）另需量价配合（见 SURGE_PRICE_MOVE）才推送；
# 国家队护盘评分里的放量计数、前端量能高亮用原始倍数口径。
SURGE_RATIO = 5.0
# 量价配合阈值：放量那一分钟的价格波动绝对值 ≥ 0.15%，
# 或连续 2 分钟都 ≥ SURGE_RATIO 倍，才算有效放量。
SURGE_PRICE_MOVE = 0.0015


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


def volume_stats(vols: list[float], closes: list[float] | None = None) -> dict:
    """近1分钟量能 vs 近60分钟均量的放大倍数（均量只取有成交的分钟）。

    `confirmed` 为量价配合后的有效放量（告警/信号流用它），需传入等长的收盘价序列：
    该分钟价格波动 ≥ SURGE_PRICE_MOVE，或前一分种同样 ≥ SURGE_RATIO 倍（连续放量）。
    """
    if len(vols) < 10:
        return {"ok": False}
    cur = vols[-1]
    # 基准均量：当前分钟之前、有成交的分钟（近 60 根）。剔除 0 量分钟很关键——
    # 停牌/无成交分钟（如 14:58 集合竞价前后）会把均值拉低，导致 ratio 虚高（曾见 45x）。
    base = [v for v in vols[:-1][-60:] if v > 0]
    avg = sum(base) / len(base) if base else 0
    ratio = (cur / avg) if avg else 0
    peak = max(vols)
    is_surge = ratio >= SURGE_RATIO and cur > 0

    # 前一分种相对它自己前 60 分钟的倍数（用于「连续两分钟放量」判定）
    prev_ratio = None
    if len(vols) >= 11:
        prev_base = [v for v in vols[:-2][-60:] if v > 0]
        if prev_base and sum(prev_base) > 0:
            prev_ratio = vols[-2] / (sum(prev_base) / len(prev_base))

    move_pct = None
    if closes and len(closes) == len(vols) and closes[-2]:
        move_pct = (closes[-1] - closes[-2]) / closes[-2]

    confirmed_by = None
    if is_surge:
        if move_pct is not None and abs(move_pct) >= SURGE_PRICE_MOVE:
            confirmed_by = "price"
        elif prev_ratio is not None and prev_ratio >= SURGE_RATIO:
            confirmed_by = "streak"

    return {
        "ok": True, "ratio": round(ratio, 2),
        "is_surge": is_surge,
        "confirmed": confirmed_by is not None,
        "confirmed_by": confirmed_by,
        "move_pct": round(move_pct, 5) if move_pct is not None else None,
        "prev_ratio": round(prev_ratio, 2) if prev_ratio is not None else None,
        "peak_ratio": round(cur / peak, 2) if peak else 0,
        "last": cur,
    }


def merge_levels(vals: list[float], tol: float = 0.003) -> list[float]:
    """把相对距离小于 ``tol``（默认 0.3%）的价位合并成一档。

    枢轴点常常扎堆：ETF 报价到 0.001，4.061 与 4.064 其实是同一道关口，
    画成两条横线只会让图面变糊。保留先出现的那一档，顺序不变。
    """
    out: list[float] = []
    for v in vals or []:
        try:
            v = float(v)
        except (TypeError, ValueError):
            continue
        if all(abs(v - x) / max(abs(x), 1e-9) > tol for x in out):
            out.append(v)
    return out


def support_resistance(closes: list[float], highs: list[float], lows: list[float]) -> dict:
    """用日内枢轴/前高前低估算支撑与压力（相邻档位先合并，避免重复横线）。"""
    if not closes:
        return {}
    hi, lo = max(highs), min(lows)
    last = closes[-1]
    ph, pl = _pivots(closes, 3)
    highs_px = sorted({closes[i] for i in ph}, reverse=True)
    lows_px = sorted({closes[i] for i in pl})
    # 取「离现价最近」的一档：日内真正有用的是最近那道关口，而不是全天最高/最低那两个点。
    # 只留一条——图上多画一条只会让人分不清哪条是要用的。
    res_cands = sorted((x for x in highs_px if x > last), key=lambda x: x - last)[:1]
    sup_cands = sorted((x for x in lows_px if x < last), key=lambda x: last - x)[:1]
    res = sorted(merge_levels(res_cands))
    sup = sorted(merge_levels(sup_cands))
    # 全量档位（近→远）：出「止盈位」时要往上/下找下一道结构位，只有最近一档不够用。
    res_all = sorted(merge_levels([x for x in highs_px if x > last]))
    sup_all = sorted(merge_levels([x for x in lows_px if x < last]), reverse=True)
    # 跨侧去重：现价在一条窄幅里来回磨时，最近的支撑与压力会贴在一起（如 4.064 / 4.066），
    # 画出来是两根几乎重叠的线。此时只保留离现价更远的那条，另一侧不再画。
    if res and sup:
        near_res, near_sup = res[0], sup[-1]
        if abs(near_res - near_sup) / max(abs(last), 1e-9) < 0.003:
            if abs(near_res - last) >= abs(last - near_sup):
                sup = sup[:-1]
            else:
                res = res[1:]
    return {
        "day_high": hi, "day_low": lo, "last": last,
        "resistance": res, "support": sup,
        "resistances": res_all, "supports": sup_all,
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
