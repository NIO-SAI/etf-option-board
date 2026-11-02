"""止盈取「结构位」而不是机械 2R（否则盈亏比永远是 2.0:1）。"""
from services.strategy import _struct_target


def test_takes_next_resistance_beyond_1_2r():
    # 入场 100、止损 98（风险 2）→ 1.2R = 102.4；100.5 太近被跳过，取 104
    t = _struct_target(100.0, 98.0, [100.5, 104.0, 120.0], up=True, atr_v=1.0)
    assert t == 104.0
    assert round((t - 100.0) / 2.0, 2) == 2.0


def test_r_multiple_is_not_always_two():
    # 同一套风险参数，结构位不同 → 盈亏比不同（1.5R vs 3.0R）
    a = _struct_target(100.0, 98.0, [103.0], up=True, atr_v=1.0)
    b = _struct_target(100.0, 98.0, [106.0], up=True, atr_v=1.0)
    assert round((a - 100.0) / 2.0, 2) == 1.5
    assert round((b - 100.0) / 2.0, 2) == 3.0


def test_far_level_is_capped_at_3_5r():
    t = _struct_target(100.0, 98.0, [150.0], up=True, atr_v=1.0)
    assert t == 107.0          # 100 + 3.5 × 2


def test_falls_back_to_atr_when_no_structure():
    # ATR 够大时按 2.2×ATR 走（100 + 2.2×3 = 106.6 > 2R）
    t = _struct_target(100.0, 98.0, [], up=True, atr_v=3.0)
    assert t == 106.6


def test_atr_fallback_never_below_2r():
    # ATR 很小（窄幅震荡）时 2.2×ATR < 止损距离，会把盈亏比压到 0.3:1 → 顶到 2R
    t = _struct_target(100.0, 96.0, [], up=True, atr_v=0.5)
    assert t == 108.0          # 100 + max(1.1, 2×4)
    assert round((t - 100.0) / 4.0, 2) == 2.0


def test_put_side_is_mirrored():
    t = _struct_target(100.0, 102.0, [99.5, 96.0], up=False, atr_v=1.0)
    assert t == 96.0
    assert round((100.0 - t) / 2.0, 2) == 2.0
