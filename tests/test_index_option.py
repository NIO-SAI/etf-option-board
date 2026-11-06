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
        )
        assert b["score"] > 15 and b["direction"] == "call"
        assert 0 < b["confidence"] <= 1

    def test_bearish_pile_up(self):
        b = idx.bias(
            _trends((101, 100.8, 100.6, 100.4, 100.2, 100)),
            [{"price": 100, "high": 101, "low": 100}],
            {"f137": -3000000000.0},
        )
        assert b["score"] < -15 and b["direction"] == "put"

    def test_no_data_is_neutral(self):
        b = idx.bias([], [{"price": 100, "high": 100, "low": 100}], None)
        assert b["score"] == 0 and b["direction"] == "neutral"

    def test_afternoon_weakness_is_not_opening_rebound(self):
        # 收盘仍高于低开点，但近 15 分钟已转弱：旧算法动量会给 +25。
        tr = [{"time": "2026-11-06 09:30", "price": 6413.94},
              {"time": "2026-11-06 13:00", "price": 6542.30},
              {"time": "2026-11-06 14:45", "price": 6511.70},
              {"time": "2026-11-06 15:00", "price": 6505.35}]
        b = idx.bias(tr, [{"price": 6505.35, "high": 6597.06, "low": 6413.94}],
                     {"f137": -12254082304.0})
        assert b["direction"] == "neutral"
        assert b["score"] == -12.5
        assert b["detail"]["现货15分钟动量"] < 0

    @pytest.mark.parametrize("sign", [1, -1])
    def test_rounding_must_not_trigger_direction(self, sign):
        # 仅区间位置产生 ±14.975：显示 ±15.0，仍未达到方向阈值。
        b = idx.bias([], [{"price": 100 + sign * 14.975 / 15, "high": 101, "low": 99}], None)
        assert b["score"] == sign * 15
        assert b["direction"] == "neutral"

    def test_recent_rebound_is_not_morning_selloff(self):
        tr = [{"time": "2026-11-06 09:30", "price": 103},
              {"time": "2026-11-06 14:45", "price": 100},
              {"time": "2026-11-06 15:00", "price": 101}]
        b = idx.bias(tr, [{"price": 101, "high": 103, "low": 99}], {"f137": 3e8})
        assert b["direction"] == "call"
        assert b["detail"]["现货15分钟动量"] == 25


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


class TestUniverse:
    """中证500 没有中金所股指期权，只有 IC 股指期货（2026-11-05 补入）。"""

    def test_ic_present_without_option_chain(self):
        fut = idx.FUT_OPTS and next((f for f in idx.FUT_OPTS if f["code"] == "IC"), None)
        assert fut is not None
        assert fut["underlying"] == "1.000905"          # 中证500 现货
        assert fut["options"] is False                  # 没有期权链
        assert fut["futures"] == "8.060130"             # IC 主力合约（算期现基差用）

    def test_option_products_still_have_chains(self):
        opt = [f for f in idx.FUT_OPTS if f.get("options", True)]
        assert {f["code"] for f in opt} == {"IO", "HO", "MO"}

    def test_by_code_covers_every_listed_product(self):
        assert set(idx._BY_CODE) == {f["code"] for f in idx.FUT_OPTS}


class TestFuturesContracts:
    """中证500(IC) 的期权链位置改列全部真实期货合约。"""

    ROWS = [
        {"f12": "061111", "f14": "IC2611", "f2": 6736.0, "f3": 1.93, "f5": 38706,
         "f108": 52401, "f6": 5.2e10},
        {"f12": "061112", "f14": "IC2612", "f2": 6700.6, "f3": 1.8, "f5": 146657,
         "f108": 183038, "f6": 1.96e11},
        {"f12": "060130", "f14": "IC主力合约", "f2": 6700.6, "f108": 183038},
        {"f12": "060121", "f14": "IC下月连续", "f2": 6700.6},
        {"f12": "061103", "f14": "IC2703", "f2": 6563.6, "f108": 62919},
        {"f12": "151112", "f14": "IM2612", "f2": 6567.0, "f108": 999999},
    ]

    def test_keeps_only_real_contracts_sorted_by_month(self):
        out = idx.parse_futures(self.ROWS, "IC", 6736.9)
        assert [c["code"] for c in out] == ["IC2611", "IC2612", "IC2703"]
        assert [c["month"] for c in out] == [2611, 2612, 2703]

    def test_main_is_largest_open_interest(self):
        out = idx.parse_futures(self.ROWS, "IC", 6736.9)
        main = [c["code"] for c in out if c["is_main"]]
        assert main == ["IC2612"]

    def test_basis_vs_spot(self):
        out = {c["code"]: c for c in idx.parse_futures(self.ROWS, "IC", 6700.6)}
        assert out["IC2612"]["basis_pct"] == 0.0          # 与现货持平
        assert out["IC2703"]["basis_pct"] < 0             # 远月贴水

    def test_expiry_is_third_friday(self):
        out = idx.parse_futures(self.ROWS, "IC", None)
        assert out[0]["expiry"] == "2026-11-20"
        assert out[0]["basis_pct"] is None                # 缺现货时不编造基差

    def test_no_prefix_no_rows(self):
        assert idx.parse_futures(self.ROWS, "XX", 6700.0) == []
