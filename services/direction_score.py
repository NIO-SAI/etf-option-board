"""方向评分的纯计算：先判阈值再格式化，分钟动量不跨日或午休。"""

from __future__ import annotations

import datetime as dt
import math


def score_result(score: float, *, threshold: float = 15, scale: float = 100,
                 detail: dict | None = None, model: str = "etf") -> dict:
    """方向使用未取整值；展示分数保留一位，原始分数保留供核对。"""
    raw = max(-100.0, min(100.0, score)) if math.isfinite(score) else 0.0
    direction = "call" if raw >= threshold else "put" if raw <= -threshold else "neutral"
    return {"score": round(raw, 1), "raw_score": raw, "direction": direction,
            "confidence": round(min(abs(raw) / scale, 1), 2),
            "detail": detail or {}, "threshold": threshold, "model": model}


def price_points(rows: list[dict] | None, *, price_key: str = "price",
                 time_key: str = "time") -> list[tuple[dt.datetime, float]]:
    """清洗、排序、去重，只留输入中最新交易日的连续竞价点，不读取时钟。"""
    points = {}
    for row in rows or []:
        try:
            stamp = dt.datetime.fromisoformat(str(row.get(time_key, "")))
            price = float(row.get(price_key))
        except (TypeError, ValueError):
            continue
        if stamp.tzinfo is not None or not math.isfinite(price) or price <= 0:
            continue
        hm = stamp.time()
        if dt.time(9, 30) <= hm <= dt.time(11, 30) or dt.time(13) <= hm <= dt.time(15):
            points[stamp] = price
    if not points:
        return []
    day = max(points).date()
    return sorted((stamp, price) for stamp, price in points.items() if stamp.date() == day)


def recent_change(rows: list[dict] | None, minutes: int, *, price_key: str = "price",
                  time_key: str = "time") -> float | None:
    """完整分钟窗口的涨跌幅；开盘/午后不足窗口时缺省，不把早盘或昨日当近端。"""
    points = price_points(rows, price_key=price_key, time_key=time_key)
    if not points:
        return None
    end, last = points[-1]
    start = end - dt.timedelta(minutes=minutes)
    session_start = end.replace(hour=13 if end.hour >= 13 else 9,
                                minute=0 if end.hour >= 13 else 30, second=0, microsecond=0)
    if start < session_start:
        return None
    # 允许源缺一条分钟点，沿用最近前值；更大的缺口不冒充完整窗口。
    anchors = [(stamp, price) for stamp, price in points if session_start <= stamp <= start]
    if not anchors or start - anchors[-1][0] > dt.timedelta(minutes=1):
        return None
    return (last / anchors[-1][1] - 1) * 100


def index_bias(trends: list[dict] | None) -> dict:
    """底部大盘指数：近 30/15 分钟动量 + 价格相对当日分时均值。"""
    points = price_points(trends)
    detail = {}
    score = 0.0
    if len(points) >= 6:
        for minutes, weight, full_pct in ((30, 45, 1.2), (15, 35, 0.5)):
            change = recent_change(trends, minutes)
            if change is not None:
                value = max(-weight, min(weight, change / full_pct * weight))
                score += value
                detail[f"近{minutes}分钟动量"] = round(value, 1)
        mean = sum(price for _, price in points) / len(points)
        # 偏离程度线性计分；完全横盘为 0，不能因为 last >= mean 就凭空给 +20。
        value = max(-20, min(20, (points[-1][1] / mean - 1) * 100 / 0.5 * 20))
        score += value
        detail["价格vs分时均值"] = round(value, 1)
    return score_result(score, threshold=20, scale=60, detail=detail, model="index")
