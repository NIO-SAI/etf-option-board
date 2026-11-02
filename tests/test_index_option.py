"""股指期权（IO/MO/HO）纯函数：到期日、合约解析、方向评分、已实现波动。

约束与其它用例一致：不触网、不读系统时钟、不写磁盘（日期/序列全部注入）。
"""

import datetime as dt

import pytest

from services import index_option as idx
from services import option_service as osvc

D = dt.date


class TestThirdFriday:
    @pytest.mark.parametrize("year,month,expected", [
        (2026, 11, "2026-11-20"),
        (2026, 12, "2026-12-18"),
        (2027, 1, "2027-01-15"),
        (2027, 3, "2027-03-19"),
    ])
    def test_third_friday(self, year, month, expected):
        assert osvc.third_friday(year, month).isoformat() == expected

    def test_etf_rule_is_different(self):
        assert osvc.third_friday(2026, 11) != osvc.fourth_wednesday(2026, 11)


INDEX = {"kind": "index"}
ETF = {"kind": "etf"}


class TestContractMeta:
    def test_code_wins_for_index(self):
        m = osvc.contract_meta({"f12": "MO2611-C-7000", "f14": "中证1000购26年11月7000"}, INDEX)
        assert m["is_call"] is True
        assert m["strike"] == 7000
        assert m["month"] == 2611
        assert m["expiry"].isoformat() == "2026-11-20"

    def test_put_side(self):
        m = osvc.contract_meta({"f12": "HO2703-P-2750", "f14": "上证50沽27年03月2750"}, INDEX)
        assert m["is_call"] is False
        assert m["strike"] == 2750
        assert m["month"] == 2703
        assert m["expiry"].isoformat() == "2027-03-19"

    def test_falls_back_to_name_when_code_odd(self):
        m = osvc.contract_meta({"f12": "XX?", "f14": "中证1000购26年12月6200"}, INDEX)
        assert (m["month"], m["strike"], m["is_call"]) == (2612, 6200, True)

    def test_index_unparsable_returns_none(self):
        assert osvc.contract_meta({"f12": "?", "f14": "??"}, INDEX) is None

    def test_etf_uses_strike_field(self):
        m = osvc.contract_meta({"f12": "10012802", "f14": "科创板50沽6月1050", "f161": 1.05}, ETF)
        assert m["is_call"] is False
        assert m["strike"] == pytest.approx(1.05)
        assert m["month"] == 6


def _trends(prices):
    return [{"price": p} for p in prices]


class TestBias:
    def test_bullish_pile_up(self):
        b = idx.bias(
            _trends((100, 100.2, 100.4, 100.6, 100.8, 101.0)),
            [{"price": 101, "high": 101, "low": 100}],
            {"f137": 3000000000.0},
            {"basis_pct": 0.5},
        )
        assert b["score"] > 15 and b["direction"] == "call"
        assert 0 < b["confidence"] <= 1

    def test_bearish_pile_up(self):
        b = idx.bias(
            _trends((101, 100.8, 100.6, 100.4, 100.2, 100)),
            [{"price": 100, "high": 101, "low": 100}],
            {"f137": -3000000000.0},
            {"basis_pct": -0.5},
        )
        assert b["score"] < -15 and b["direction"] == "put"

    def test_no_data_is_neutral(self):
        b = idx.bias([], [{"price": 100, "high": 100, "low": 100}], None, None)
        assert b["score"] == 0 and b["direction"] == "neutral"

    def test_basis_discount_leans_bearish(self):
        base = idx.bias(_trends([]), [{"price": 100, "high": 100, "low": 100}], None, None)
        disc = idx.bias(_trends([]), [{"price": 100, "high": 100, "low": 100}], None,
                        {"basis_pct": -1.0})
        assert disc["score"] < base["score"] == 0
        assert disc["score"] == -12


class TestRealizedVol:
    def test_flat_series_has_zero_vol(self):
        assert idx.realized_vol([100.0] * 21) == 0.0

    def test_insufficient_samples(self):
        assert idx.realized_vol([100.0, 101.0]) is None

    def test_annualizes_to_percent(self):
        closes = [100.0]
        for i in range(20):
            closes.append(closes[-1] * (1.01 if i % 2 == 0 else 0.99))
        rv = idx.realized_vol(closes)
        assert 14 < rv < 18


class TestIvRvNote:
    def test_ratio_from_chain_and_daily(self):
        chain = {"stats": {"atm_iv": 20.0}}
        daily = [{"close": 100.0} for _ in range(21)]
        assert idx.iv_rv(chain, daily) is None

    def test_prefers_history_percentile(self):
        chain = {"stats": {"atm_iv": 20.0, "atm_iv_pctl20": 90}}
        note = idx._iv_note(chain, {"atm_iv": 20.0, "rv20": 10.0, "ratio": 2.0})
        assert "90% 分位" in note and "偏贵" in note
