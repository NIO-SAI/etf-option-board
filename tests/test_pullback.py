"""反向备选卡回踩入场：不追突破价，止损保持结构位、目标按新入场重算 2R。"""

import pytest

from services import strategy


def test_bull_uses_pullback_and_keeps_2r():
    lv = {"side": "long", "entry_break": 4.0, "entry_pullback": 3.98,
          "stop": 3.96, "target": 4.08}
    out = strategy.pullback_plan(lv)
    assert out["entry_break"] == pytest.approx(3.98)   # 入场更低（回踩）
    assert out["stop"] == pytest.approx(3.96)          # 止损仍是原结构位
    assert out["target"] == pytest.approx(4.02)        # 2R 重算
    assert (out["target"] - out["entry_break"]) / (out["entry_break"] - out["stop"]) == pytest.approx(2.0)


def test_bear_uses_pullback_and_keeps_2r():
    lv = {"side": "short", "entry_break": 4.0, "entry_pullback": 4.02,
          "stop": 4.04, "target": 3.92}
    out = strategy.pullback_plan(lv)
    assert out["entry_break"] == pytest.approx(4.02)
    assert out["target"] == pytest.approx(3.98)
    assert (out["entry_break"] - out["target"]) / (out["stop"] - out["entry_break"]) == pytest.approx(2.0)


def test_missing_fields_returns_original():
    lv = {"side": "long", "entry_break": 4.0}
    assert strategy.pullback_plan(lv) is lv
    assert strategy.pullback_plan({}) == {}
    assert strategy.pullback_plan(None) is None
