"""方向边界与分钟窗口回归：输入固定，不触网、不读时钟、不写盘。"""

import datetime as dt

import pytest

from services.direction_score import index_bias, price_points, recent_change, score_result
from services.strategy import bias_score


def points(start, prices):
    begin = dt.datetime.fromisoformat(start)
    return [{"time": (begin + dt.timedelta(minutes=i)).isoformat(" "), "price": p}
            for i, p in enumerate(prices)]


@pytest.mark.parametrize("threshold", [15, 20])
@pytest.mark.parametrize("sign", [-1, 1])
def test_raw_threshold_before_display_rounding(threshold, sign):
    result = score_result(sign * (threshold - 0.025), threshold=threshold)
    assert result["score"] == sign * threshold
    assert result["direction"] == "neutral"
    exact = score_result(sign * threshold, threshold=threshold)
    assert exact["direction"] == ("call" if sign > 0 else "put")


@pytest.mark.parametrize("sign", [-1, 1])
def test_etf_uses_raw_score_at_boundary(sign):
    result = bias_score({}, {}, {}, [], None, {"total": sign * 14.975})
    assert result["score"] == sign * 15
    assert result["direction"] == "neutral"


def test_window_is_minutes_not_number_of_points():
    rows = points("2026-11-06 14:30", [100] * 31)
    # 14:45 到 15:00 为 +1%，即便中间丢点也不能把“15 条”误作 15 分钟。
    rows[-1]["price"] = 101
    sparse = [p for i, p in enumerate(rows) if i % 5 == 0]
    assert recent_change(sparse, 15) == pytest.approx(1)


def test_window_does_not_cross_lunch_or_day():
    rows = points("2026-11-05 14:45", [90] * 16)
    rows += points("2026-11-06 11:15", [100] * 16)
    rows += points("2026-11-06 13:00", [101, 102, 103])
    assert recent_change(rows, 5) is None
    assert recent_change(rows, 15) is None
    morning = points("2026-11-06 09:30", [101, 102])
    assert recent_change(rows[:16] + morning, 5) is None


def test_missing_anchor_is_not_replaced_by_open():
    rows = points("2026-11-06 09:30", [90]) + points("2026-11-06 15:00", [100])
    assert recent_change(rows, 15) is None


def test_one_missing_minute_uses_previous_point():
    rows = points("2026-11-06 14:44", [100]) + points("2026-11-06 15:00", [101])
    assert recent_change(rows, 15) == pytest.approx(1)


def test_cleaning_keeps_latest_day_and_ignores_after_hours():
    rows = points("2026-11-05 14:45", [90]) + points("2026-11-06 14:45", [100])
    rows += points("2026-11-06 15:00", [101]) + points("2026-11-06 15:06", [120])
    rows += [{"time": "bad", "price": 100}, {"time": "2026-11-06 14:50", "price": float("nan")}]
    assert len(price_points(list(reversed(rows)))) == 2
    assert recent_change(rows, 15) == pytest.approx(1)


def test_etf_recent_momentum_ignores_open_and_can_use_trends():
    rows = points("2026-11-06 09:30", [90]) + points("2026-11-06 14:55", [101, 100.8, 100.6, 100.4, 100.2, 100])
    result = bias_score({"trends": rows}, {}, {}, [], None)
    assert result["direction"] == "put"
    assert result["detail"]["标的5分钟动量"] < 0


def test_etf_early_afternoon_does_not_use_morning_bars():
    rows = points("2026-11-06 11:25", [90] * 6) + points("2026-11-06 13:00", [100, 101])
    bars = [{"date": p["time"], "close": p["price"]} for p in rows]
    result = bias_score({"kline_1m": bars}, {}, {}, [], None)
    assert result["direction"] == "neutral"
    assert "标的5分钟动量" not in result["detail"]


def test_flat_index_does_not_get_bullish_mean_bonus():
    result = index_bias(points("2026-11-06 14:00", [100] * 61))
    assert result["score"] == 0
    assert result["direction"] == "neutral"


def test_index_afternoon_decline_outweighs_low_open():
    rows = points("2026-11-06 09:30", [95])
    rows += points("2026-11-06 14:30", [102 - i / 30 for i in range(31)])
    result = index_bias(rows)
    assert result["direction"] == "put"
    assert result["detail"]["近30分钟动量"] < 0
    assert result["detail"]["近15分钟动量"] < 0
