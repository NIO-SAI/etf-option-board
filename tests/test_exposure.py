"""敞口档位 → 组合 Greeks 敞口 → 限额与减仓（ticket 03 / 04）。"""

import pytest

from services import decision as dec

# 一张平值认购：权利金 0.05 元/份、Delta 0.5、标的 4.0 元
UNIT_CALL = {"premium": 0.05, "delta": 0.5, "price": 4.0,
             "theta": -0.0005, "vega": 0.002}
UNIT_PUT = {"premium": 0.05, "delta": -0.5, "price": 4.0,
            "theta": -0.0005, "vega": 0.002}


class TestRiskProfile:
    @pytest.mark.parametrize("pct,prof", [
        (1, "conservative"), (2, "standard"), (3, "aggressive"),
        (1.0, "conservative"), (2.0, "standard"), (3.0, "aggressive"),
    ])
    def test_linked_to_risk_pct(self, pct, prof):
        assert dec.risk_profile(pct) == prof

    @pytest.mark.parametrize("pct", [None, 0, 9, "x", float("nan"), True])
    def test_unknown_falls_back_to_conservative(self, pct):
        assert dec.risk_profile(pct) == "conservative"


class TestExposureNotional:
    def test_flat_tier_is_zero(self):
        r = dec.exposure_notional("flat", "mid", 500000)
        assert r["ok"] is True
        assert r["contracts"] == 0
        assert r["delta_notional"] == 0.0

    def test_etf_delta_equals_holdings_amount(self):
        """ETF 的 Delta 恒为 1 元/元 → 敞口等于持有金额。"""
        r = dec.exposure_notional("etf", "mid", 500000)
        assert r["ok"] is True
        assert r["delta_notional"] == 150000.0        # 30%

    @pytest.mark.parametrize("size,expected", [
        ("light", 50000.0), ("mid", 150000.0), ("heavy", 300000.0)])
    def test_three_size_tiers(self, size, expected):
        assert dec.exposure_notional("etf", size, 500000)["delta_notional"] == expected

    def test_always_marked_as_estimate(self):
        for tier in dec.TIERS:
            r = dec.exposure_notional(tier, "mid", 500000, unit=UNIT_CALL)
            assert r["estimate"] is True

    def test_call_uses_preferred_contract(self):
        r = dec.exposure_notional("call", "mid", 500000, unit=UNIT_CALL)
        # 可买张数 = 150000 / (0.05 × 10000) = 300
        assert r["contracts"] == 300
        # 每张 Delta 敞口 = 0.5 × 4.0 × 10000 = 20000 → 合计 600 万
        assert r["per_contract_delta"] == 20000.0
        assert r["delta_notional"] == 300 * 20000.0

    def test_put_exposure_is_negative(self):
        r = dec.exposure_notional("put", "mid", 500000, unit=UNIT_PUT)
        assert r["ok"] is True
        assert r["delta_notional"] < 0

    def test_call_and_put_offset_each_other(self):
        c = dec.exposure_notional("call", "mid", 500000, unit=UNIT_CALL)
        p = dec.exposure_notional("put", "mid", 500000, unit=UNIT_PUT)
        assert c["delta_notional"] == -p["delta_notional"]

    def test_theta_and_vega_scaled_by_contracts(self):
        r = dec.exposure_notional("call", "mid", 500000, unit=UNIT_CALL)
        assert r["theta_daily"] == round(300 * -0.0005 * 10000, 2)   # -1500 元/日
        assert r["vega_per_pct"] == round(300 * 0.002 * 10000, 2)    # 6000 元/1%IV

    @pytest.mark.parametrize("cap", [None, 0, -1, "x", float("nan"), float("inf")])
    def test_invalid_capital_degrades(self, cap):
        r = dec.exposure_notional("etf", "mid", cap)
        assert r["ok"] is False and r["reason"]

    def test_option_tier_without_unit_degrades(self):
        r = dec.exposure_notional("call", "mid", 500000, unit=None)
        assert r["ok"] is False
        assert "优选合约" in r["reason"]

    @pytest.mark.parametrize("unit", [
        {"premium": 0, "delta": 0.5, "price": 4.0},
        {"premium": 0.05, "delta": None, "price": 4.0},
        {"premium": 0.05, "delta": 0.5, "price": 0},
        {"premium": "x", "delta": "y", "price": "z"},
    ])
    def test_option_tier_with_bad_unit_degrades(self, unit):
        assert dec.exposure_notional("call", "mid", 500000, unit=unit)["ok"] is False

    @pytest.mark.parametrize("tier,size", [
        ("nope", "mid"), ("call", "huge"), ("", ""), (None, None)])
    def test_bad_tier_or_size(self, tier, size):
        assert dec.exposure_notional(tier, size, 500000)["ok"] is False

    def test_never_raises_on_garbage(self):
        for bad in (True, {}, [], float("inf")):
            assert "ok" in dec.exposure_notional("etf", "mid", bad)
            assert "ok" in dec.exposure_notional(bad, "mid", 500000)


class TestPortfolioExposure:
    def test_sums_across_holdings(self):
        a = dec.exposure_notional("etf", "light", 100000)          # +10000
        b = dec.exposure_notional("put", "light", 100000, unit=UNIT_PUT)
        tot = dec.portfolio_exposure([a, b], 100000)
        assert tot["ok"] is True
        assert tot["delta_notional"] == round(10000 + b["delta_notional"], 2)

    def test_empty_holdings(self):
        assert dec.portfolio_exposure([], 100000)["ok"] is False

    def test_all_invalid_holdings_report_first_reason(self):
        bad = dec.exposure_notional("etf", "mid", None)
        out = dec.portfolio_exposure([bad], None)
        assert out["ok"] is False and out["reason"]


class TestLimits:
    def test_amounts_derived_from_capital_and_profile(self):
        L = dec.limits(2, 500000)
        assert L["profile"] == "standard"
        assert L["profile_label"] == "标准"
        assert L["ratios"]["delta"] == 0.25
        assert L["amounts"]["delta"] == 125000.0          # 主显元

    def test_three_profiles_scale_with_capital(self):
        assert dec.limits(1, 100000)["amounts"]["delta"] == 10000.0    # 保守 10%
        assert dec.limits(2, 100000)["amounts"]["delta"] == 25000.0    # 标准 25%
        assert dec.limits(3, 100000)["amounts"]["delta"] == 50000.0    # 激进 50%

    def test_without_capital_only_ratios(self):
        L = dec.limits(2, None)
        assert L["amounts"] is None
        assert L["ratios"]["delta"] == 0.25

    @pytest.mark.parametrize("pct", [None, 9, "x", float("nan")])
    def test_unknown_risk_pct_is_conservative(self, pct):
        assert dec.limits(pct, 100000)["profile"] == "conservative"


class TestCheckLimits:
    @staticmethod
    def _exp(delta_notional, contracts=None):
        return {"ok": True, "delta_notional": delta_notional, "contracts": contracts}

    def test_breach_gives_executable_contract_suggestion(self):
        L = dec.limits(2, 500000)                          # Delta 限额 125000
        r = dec.check_limits(self._exp(200000.0, 10), L, per_contract_delta=20000.0)
        assert r["checked"] is True and r["breached"] is True
        assert r["over"] == 75000.0
        assert r["reduce_to_contracts"] == 6               # 10 − ceil(75000/20000)
        assert r["suggestion"] == "减到 6 张"

    def test_exact_equal_is_not_a_breach_and_is_consistent(self):
        L = dec.limits(2, 500000)
        r = dec.check_limits(self._exp(125000.0, 5), L, per_contract_delta=25000.0)
        assert r["breached"] is False
        assert r["headroom"] == 0.0

    def test_headroom_when_within_limit(self):
        L = dec.limits(2, 500000)
        r = dec.check_limits(self._exp(100000.0, 5), L)
        assert r["breached"] is False
        assert r["headroom"] == 25000.0
        assert "suggestion" not in r                       # 未触限不给多余提示

    def test_negative_exposure_compared_by_absolute_value(self):
        L = dec.limits(2, 500000)
        r = dec.check_limits(self._exp(-200000.0, 10), L, per_contract_delta=20000.0)
        assert r["breached"] is True
        assert r["used"] == 200000.0

    def test_cutting_to_zero_contracts_is_allowed(self):
        L = dec.limits(2, 500000)
        r = dec.check_limits(self._exp(2000000.0, 2), L, per_contract_delta=20000.0)
        assert r["reduce_to_contracts"] == 0
        assert r["suggestion"] == "减到 0 张"

    def test_amount_suggestion_without_per_contract_delta(self):
        L = dec.limits(2, 500000)
        r = dec.check_limits(self._exp(200000.0, None), L)
        assert r["breached"] is True
        assert "元" in r["suggestion"]
        assert "reduce_to_contracts" not in r

    def test_without_capital_is_not_checked(self):
        r = dec.check_limits(self._exp(1.0, None), dec.limits(2, None))
        assert r["checked"] is False and r["note"]

    def test_invalid_exposure_is_not_checked(self):
        r = dec.check_limits({"ok": False, "reason": "未设置总资金"}, dec.limits(2, 500000))
        assert r["checked"] is False
        assert r["note"] == "未设置总资金"

    def test_empty_inputs_do_not_raise(self):
        assert dec.check_limits({}, {})["checked"] is False
        assert dec.check_limits(None, None)["checked"] is False
