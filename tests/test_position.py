"""仓位：单笔风险预算 → 手数上限（ticket 02）。"""

import pytest

from services import decision as dec


class TestRiskBudget:
    def test_basic(self):
        assert dec.risk_budget(500000, 2) == 10000.0

    def test_accepts_numeric_strings(self):
        assert dec.risk_budget("500000", "3") == 15000.0

    @pytest.mark.parametrize("cap", [None, 0, -1, "x", float("nan"), float("inf"), True, {}])
    def test_invalid_capital_returns_none(self, cap):
        assert dec.risk_budget(cap, 2) is None

    @pytest.mark.parametrize("pct", [None, 0, -1, "x", float("nan")])
    def test_invalid_risk_returns_none(self, pct):
        assert dec.risk_budget(500000, pct) is None


class TestMaxLossPerContract:
    def test_single_leg_is_full_premium(self):
        # 0.05 元/份 × 10000 份/张 = 500 元/张
        assert dec.max_loss_per_contract("single", premium=0.05) == 500.0

    def test_vertical_is_width_minus_net_credit(self):
        # (0.05 − 0.01) × 10000 = 400 元/张
        assert dec.max_loss_per_contract("vertical", width=0.05, net_credit=0.01) == 400.0

    def test_vertical_without_credit(self):
        assert dec.max_loss_per_contract("vertical", width=0.05) == 500.0

    def test_vertical_credit_wider_than_width_is_zero_not_negative(self):
        assert dec.max_loss_per_contract("vertical", width=0.05, net_credit=0.06) == 0.0

    @pytest.mark.parametrize("kw", [{}, {"premium": None}, {"premium": 0}, {"premium": -1}])
    def test_single_without_valid_premium(self, kw):
        assert dec.max_loss_per_contract("single", **kw) is None

    @pytest.mark.parametrize("kw", [{}, {"width": None}, {"width": 0}])
    def test_vertical_without_valid_width(self, kw):
        assert dec.max_loss_per_contract("vertical", **kw) is None

    def test_unknown_kind(self):
        assert dec.max_loss_per_contract("straddle", premium=1.0) is None

    def test_custom_multiplier(self):
        """合约单位可注入，便于按交易所规格核对。"""
        assert dec.max_loss_per_contract("single", premium=0.05, multiplier=100) == 5.0


class TestMaxContracts:
    def test_floors_down(self):
        assert dec.max_contracts(10000.0, 3000.0)["max_contracts"] == 3

    def test_exact_division_boundary(self):
        assert dec.max_contracts(9000.0, 3000.0)["max_contracts"] == 3

    def test_budget_below_one_contract_yields_zero_with_clear_note(self):
        r = dec.max_contracts(500.0, 3000.0)
        assert r["max_contracts"] == 0
        assert r["note"] == "按当前风险预算不应开仓"

    def test_echoes_its_inputs_for_display(self):
        r = dec.max_contracts(10000.0, 3000.0)
        assert r["budget"] == 10000.0 and r["loss_per_contract"] == 3000.0

    @pytest.mark.parametrize("budget,loss", [
        (None, 3000.0), (0, 3000.0), (-1, 3000.0), (float("nan"), 3000.0),
        (10000.0, None), (10000.0, 0), (10000.0, -5), (10000.0, float("inf")),
    ])
    def test_missing_or_invalid_inputs_degrade_with_reason(self, budget, loss):
        r = dec.max_contracts(budget, loss)
        assert r["max_contracts"] is None
        assert r["reason"]

    def test_never_raises_on_garbage(self):
        for bad in (True, {}, "x", float("inf"), float("nan")):
            assert "max_contracts" in dec.max_contracts(bad, 100.0)
            assert "max_contracts" in dec.max_contracts(1000.0, bad)
