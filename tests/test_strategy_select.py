"""策略选择与临期约束（ticket 07 / 08）。

仅买方四类：买单腿认购 / 买单腿认沽 / 垂直价差 / 观望（docs/adr/0002）。
"""

import pytest

from services import decision as dec

ALLOWED = {"single_call", "single_put", "vertical", "wait"}


class TestDirectionGate:
    @pytest.mark.parametrize("direction", ["neutral", None, "auto", "", "CALL", 123])
    def test_unclear_direction_waits(self, direction):
        r = dec.select_strategy(direction, 50.0, days_to_expiry=30)
        assert r["strategy"] == "wait"
        assert r["label"] == "观望"

    def test_range_bound_with_high_iv_explains_itself(self):
        r = dec.select_strategy("neutral", 80.0, days_to_expiry=30)
        assert r["strategy"] == "wait"
        assert "80%" in r["reason"]


class TestIvMapping:
    def test_high_iv_bull_becomes_bull_call_vertical(self):
        r = dec.select_strategy("call", 80.0, days_to_expiry=30)
        assert r["strategy"] == "vertical"
        assert r["vertical_kind"] == "bull_call"
        assert r["label"] == "牛市看涨价差"

    def test_high_iv_bear_becomes_bear_put_vertical(self):
        r = dec.select_strategy("put", 80.0, days_to_expiry=30)
        assert r["strategy"] == "vertical"
        assert r["vertical_kind"] == "bear_put"
        assert r["label"] == "熊市看跌价差"

    @pytest.mark.parametrize("pct", [0.0, 10.0, 24.9, 25.0])
    def test_low_iv_keeps_single_leg(self, pct):
        assert dec.select_strategy("call", pct, days_to_expiry=30)["strategy"] == "single_call"
        assert dec.select_strategy("put", pct, days_to_expiry=30)["strategy"] == "single_put"

    @pytest.mark.parametrize("pct", [25.01, 50.0, 74.9, 74.99])
    def test_mid_iv_keeps_single_leg(self, pct):
        assert dec.select_strategy("call", pct, days_to_expiry=30)["strategy"] == "single_call"

    @pytest.mark.parametrize("pct,expected", [
        (74.99, "single_call"), (75.0, "vertical"), (100.0, "vertical")])
    def test_75_threshold_boundary(self, pct, expected):
        assert dec.select_strategy("call", pct, days_to_expiry=30)["strategy"] == expected

    def test_reason_names_the_iv_percentile(self):
        assert "80%" in dec.select_strategy("call", 80.0, days_to_expiry=30)["reason"]
        assert "18%" in dec.select_strategy("call", 18.0, days_to_expiry=30)["reason"]

    def test_only_buy_side_strategies_are_ever_produced(self):
        for direction in ("call", "put", "neutral"):
            for pct in (None, 0.0, 25.0, 50.0, 75.0, 100.0):
                for days in (None, 0, 3, 4, 30):
                    for nxt in (None, 29):
                        got = dec.select_strategy(direction, pct, days_to_expiry=days,
                                                  next_month_days=nxt)["strategy"]
                        assert got in ALLOWED


class TestIvMissing:
    def test_degrades_to_neutral_instead_of_fabricating(self):
        r = dec.select_strategy("call", None, days_to_expiry=30)
        assert r["degraded"] is True
        assert r["strategy"] == "single_call"       # 不因缺 IV 而改变策略类型
        assert "样本不足" in r["reason"]

    def test_mentions_sample_days_when_known(self):
        r = dec.select_strategy("call", None, days_to_expiry=30, iv_sample_days=3)
        assert "3 天" in r["reason"]

    def test_not_flagged_degraded_when_iv_present(self):
        assert dec.select_strategy("call", 50.0, days_to_expiry=30)["degraded"] is False


class TestNearExpiryConstraint:
    def test_three_days_blocks_front_month_and_moves_to_next(self):
        r = dec.select_strategy("call", 50.0, days_to_expiry=3, next_month_days=31)
        assert r["month"] == "next"
        assert r["excluded_front"] is True
        assert "排除新开当月" in r["reason"]
        assert "3 天" in r["reason"]
        assert "31 天" in r["reason"]

    def test_zero_days_also_blocks(self):
        r = dec.select_strategy("call", 50.0, days_to_expiry=0, next_month_days=28)
        assert r["month"] == "next" and r["excluded_front"] is True

    def test_four_days_is_not_blocked(self):
        r = dec.select_strategy("call", 50.0, days_to_expiry=4, next_month_days=32)
        assert r["month"] == "front"
        assert r["excluded_front"] is False

    def test_waits_when_next_month_unavailable(self):
        r = dec.select_strategy("call", 50.0, days_to_expiry=2)
        assert r["strategy"] == "wait"
        assert r["excluded_front"] is True
        assert "次月不可用" in r["reason"]

    def test_vertical_also_moves_to_next_month(self):
        r = dec.select_strategy("call", 80.0, days_to_expiry=1, next_month_days=29)
        assert r["strategy"] == "vertical"
        assert r["month"] == "next"

    def test_missing_expiry_info_leaves_strategy_untouched(self):
        r = dec.select_strategy("call", 80.0, days_to_expiry=None)
        assert r["strategy"] == "vertical"
        assert r["month"] == "front"
        assert r["excluded_front"] is False

    def test_constraint_does_not_change_strategy_kind_when_next_month_exists(self):
        """临期只换月份，不该把价差改回单腿或反之。"""
        r = dec.select_strategy("put", 80.0, days_to_expiry=3, next_month_days=30)
        assert r["strategy"] == "vertical" and r["vertical_kind"] == "bear_put"
