"""波动率口径（vol.py）：已实现波动、IV/RV 比、买方隐波便宜度。"""

import pytest

from services import index_option as idx
from services import vol


def daily(closes):
    return [{"close": c} for c in closes]


class TestRealizedVol:
    def test_matches_index_option_alias(self):
        closes = [100.0, 101.0, 100.5, 102.0, 101.5, 103.0]
        assert idx.realized_vol(closes, n=5) == vol.realized_vol(closes, n=5)

    def test_flat_series_is_zero(self):
        assert vol.realized_vol([100.0] * 21) == 0.0

    def test_insufficient_samples(self):
        assert vol.realized_vol([100.0, 101.0]) is None


class TestIvRv:
    def test_ratio_from_chain_and_daily(self):
        chain = {"stats": {"atm_iv": 24.0}}
        closes = [100.0]
        for i in range(20):
            closes.append(closes[-1] * (1.01 if i % 2 == 0 else 0.99))
        out = vol.iv_rv(chain, daily(closes))
        assert out["atm_iv"] == 24.0 and out["ratio"] > 0

    def test_zero_vol_returns_none(self):
        assert vol.iv_rv({"stats": {"atm_iv": 20.0}}, daily([100.0] * 21)) is None

    def test_missing_iv_returns_none(self):
        assert vol.iv_rv({"stats": {}}, daily([100.0] * 21)) is None


class TestIvCheapness:
    @pytest.mark.parametrize("pctl,expected", [(10, 1.0), (90, 0.0), (50, 0.5)])
    def test_percentile_mapping(self, pctl, expected):
        assert vol.iv_cheapness(pctl, None) == pytest.approx(expected)

    @pytest.mark.parametrize("ratio,expected", [(0.7, 1.0), (1.5, 0.0)])
    def test_ratio_mapping(self, ratio, expected):
        assert vol.iv_cheapness(None, ratio) == pytest.approx(expected)

    def test_blends_percentile_and_ratio(self):
        # 分位便宜但 IV/RV 贵：不能直接给满分，要打折
        assert vol.iv_cheapness(10, 2.0) == pytest.approx(0.7)
        assert vol.iv_cheapness(10, 0.7) == pytest.approx(1.0)

    def test_unknown_is_none(self):
        assert vol.iv_cheapness(None, None) is None


class TestBuyerNote:
    def test_expensive_by_percentile(self):
        assert "贵" in vol.buyer_note(85, None)

    def test_cheap_by_percentile(self):
        assert "便宜" in vol.buyer_note(20, None)

    def test_middle_says_nothing(self):
        assert vol.buyer_note(50, None) is None

    def test_middle_percentile_still_flags_iv_rv_premium(self):
        # IV 在自己历史的中段，但高于已实现波动 → 买方仍在不占优的一侧
        assert "溢价" in vol.buyer_note(50, 1.4)

    def test_falls_back_to_ratio(self):
        assert "溢价" in vol.buyer_note(None, 1.4)
        assert "便宜" in vol.buyer_note(None, 0.8)
        assert vol.buyer_note(None, None) is None
