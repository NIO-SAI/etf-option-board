"""支撑/压力位：扎堆档位合并 + 取最近的一档（避免分时图上出现重复横线）。"""

import pytest

from services.indicators import merge_levels, support_resistance


class TestMergeLevels:
    def test_merges_within_tolerance(self):
        # 4.061 / 4.064 相差 0.07%，是同一道关口
        assert merge_levels([4.061, 4.064]) == [4.061]

    def test_keeps_levels_far_apart(self):
        assert merge_levels([4.06, 4.12]) == [4.06, 4.12]

    def test_preserves_order(self):
        assert merge_levels([4.12, 4.06, 4.121]) == [4.12, 4.06]

    def test_ignores_bad_values(self):
        assert merge_levels([None, "x", 4.06]) == [4.06]

    def test_custom_tolerance(self):
        assert merge_levels([4.06, 4.10], tol=0.02) == [4.06]


# 两个相距 0.05% 的相邻高点（4.012/4.010）+ 一个低点 3.990
DUP_PEAKS = [4.000, 4.002, 4.000, 4.001, 4.012, 4.005, 4.003, 4.000,
             4.002, 4.004, 4.010, 4.004, 4.001, 3.990, 3.994, 4.000,
             4.002, 4.001, 4.000]
# 三个高点 4.030 / 4.020 / 4.010：只取最近两档，且这两档合并成一档
THREE_PEAKS = [4.000, 4.002, 4.000, 4.001, 4.030, 4.005, 4.003, 4.000,
               4.020, 4.005, 4.003, 4.000, 4.010, 4.005, 4.003, 4.000,
               3.990, 3.994, 4.000, 4.002, 4.001, 4.000]


class TestSupportResistance:
    def test_collapsed_pivots_drawn_once(self):
        sr = support_resistance(DUP_PEAKS, DUP_PEAKS, DUP_PEAKS)
        assert len(sr["resistance"]) == 1      # 4.012 与 4.010 合并
        assert sr["resistance"][0] == pytest.approx(4.010)
        assert sr["support"] == pytest.approx([3.990])

    def test_picks_nearest_not_extreme(self):
        sr = support_resistance(THREE_PEAKS, THREE_PEAKS, THREE_PEAKS)
        # 4.030 是全天最高点，但离现价最远，不该成为那条压力线
        assert sr["resistance"] == pytest.approx([4.010])
        assert max(sr["resistance"]) < 4.03

    def test_empty_input(self):
        assert support_resistance([], [], []) == {}

    def test_cross_side_duplicate_drawn_once(self):
        # 现价夹在 4.064 / 4.066 之间：两侧线条几乎重合，只保留离现价更远的一条
        s = [4.060, 4.062, 4.061, 4.062, 4.066, 4.063, 4.062, 4.061,
             4.062, 4.063, 4.064, 4.062, 4.061, 4.062, 4.061, 4.065,
             4.062, 4.061, 4.062]
        sr = support_resistance(s, s, s)
        assert len(sr["support"]) + len(sr["resistance"]) == 1
