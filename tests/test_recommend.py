"""推荐卡（主推/反向）：买入·止损·止盈全部由 contract_levels 折算，前端不重算。"""

import pytest

from services import strategy

# 看空计划：跌破 4.00 入场，涨回 4.02 止损，看向 3.94
LEVELS_BEAR = {"entry_break": 4.0, "stop": 4.02, "target": 3.94}
# 看多计划：突破 4.00 入场，跌回 3.98 止损，看向 4.06
LEVELS_BULL = {"entry_break": 4.0, "stop": 3.98, "target": 4.06}


def cand(**kw) -> dict:
    base = {
        "name": "300ETF沽11月4100", "code": "10012530", "secid": "10.10012530",
        "last": 0.10, "delta": -0.5, "month": 11, "days": 15, "score": 72.0,
        "rr": {"roi": 0.05, "p": 0.5, "up": 0.02, "down": 0.01},
        "reasons": ["与当前方向评分同向", "流动性好（成交额 7636 万）"],
    }
    base.update(kw)
    return base


def test_put_card_prices():
    card = strategy.recommend_card(cand(), LEVELS_BEAR, 4.0, "put")
    assert card["kind"] == "primary" and card["side"] == "put"
    assert card["entry"] == pytest.approx(0.10)
    assert card["stop"] == pytest.approx(0.09)
    assert card["target"] == pytest.approx(0.13)
    assert card["stop_pct"] == pytest.approx(-10.0)
    assert card["target_pct"] == pytest.approx(30.0)


def test_call_card_prices():
    c = cand(name="300ETF购11月4100", delta=0.5, last=0.08,
             reasons=["与当前方向评分同向"])
    card = strategy.recommend_card(c, LEVELS_BULL, 4.0, "call")
    assert card["entry"] == pytest.approx(0.08)
    assert card["stop"] == pytest.approx(0.07)
    assert card["target"] == pytest.approx(0.11)


def test_reasons_carry_cost_and_expectancy():
    card = strategy.recommend_card(cand(), LEVELS_BEAR, 4.0, "put")
    joined = " ".join(card["reasons"])
    assert "止损" in joined and "止盈" in joined
    assert "期望收益" in joined
    assert len(card["reasons"]) <= 5


def test_missing_candidate_returns_none():
    assert strategy.recommend_card(None, LEVELS_BEAR, 4.0, "put") is None


def test_missing_levels_keeps_contract_without_prices():
    card = strategy.recommend_card(cand(), None, 4.0, "put")
    assert card["code"] == "10012530"
    assert card["entry"] is None and card["stop"] is None
    assert card["rr"]["roi"] == 0.05


def test_pct_basis_is_entry_relative():
    # 触发买入价 0.11 高于现价 0.10（+10%）：止损/止盈幅度按**入场价**算，
    # 不是按现价——否则盈亏比会把触发偏离混进去（旧口径显示 2.8:1，实际 2.0:1）。
    card = strategy.recommend_card(cand(), LEVELS_BEAR, 4.02, "put")
    assert card["entry"] == pytest.approx(0.11)
    assert card["stop"] == pytest.approx(0.10)
    assert card["target"] == pytest.approx(0.14)
    assert card["entry_pct"] == pytest.approx(10.0)    # 触发偏离现价
    assert card["stop_pct"] == pytest.approx(-9.1)     # 相对入场
    assert card["target_pct"] == pytest.approx(27.3)   # 相对入场
    # 盈亏比与卡上价格结构一致：(0.14−0.11)/(0.11−0.10) = 3.0
    assert card["profit"] / card["loss"] == pytest.approx(3.0)


def test_one_lot_pnl_amounts_etf():
    # ETF 期权：1 张 = 10000 份。买 0.10、平价 0.13、止损 0.09
    card = strategy.recommend_card(cand(multiplier=10000), LEVELS_BEAR, 4.0, "put")
    assert card["cost"] == pytest.approx(1000)
    assert card["profit"] == pytest.approx(300)
    assert card["loss"] == pytest.approx(100)


def test_one_lot_pnl_amounts_index():
    # 股指期权：乘数 100 元/点，同样的价位 → 金额是 ETF 的 1/100
    card = strategy.recommend_card(cand(multiplier=100), LEVELS_BEAR, 4.0, "put")
    assert card["cost"] == pytest.approx(10)
    assert card["profit"] == pytest.approx(3)
    assert card["loss"] == pytest.approx(1)
