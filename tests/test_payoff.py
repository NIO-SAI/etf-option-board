"""多腿组合到期损益、保证金与策略册的纯函数测试。"""

import pytest

from services import option_playbook as pb
from services import payoff


def _call(strike, price, qty, delta=None, month=202612):
    return {"type": "call", "strike": strike, "price": price, "qty": qty,
            "delta": delta, "month": month, "name": f"购{strike:g}"}


def _put(strike, price, qty, delta=None, month=202612):
    return {"type": "put", "strike": strike, "price": price, "qty": qty,
            "delta": delta, "month": month, "name": f"沽{strike:g}"}


# ── 基础 ──────────────────────────────────────────────────────────────

def test_long_call_pnl():
    leg = _call(4.0, 0.08, 1)
    assert payoff.leg_pnl(leg, 4.0) == pytest.approx(-800)
    assert payoff.leg_pnl(leg, 4.2) == pytest.approx(1200)


def test_short_put_pnl():
    leg = _put(3.9, 0.03, -1)
    # 标的 3.9 时卖方赚满权利金
    assert payoff.leg_pnl(leg, 3.9) == pytest.approx(300)
    # 跌到 3.8：内在 0.1，亏 (0.1-0.03)*10000
    assert payoff.leg_pnl(leg, 3.8) == pytest.approx(-700)


def test_stock_leg_uses_shares_not_multiplier():
    leg = {"type": "stock", "price": 4.0, "qty": 10000}
    assert payoff.leg_pnl(leg, 4.1) == pytest.approx(1000)


def test_net_premium_sign():
    legs = [_call(4.0, 0.08, 1), _call(4.1, 0.04, -1)]
    assert payoff.net_premium(legs) == pytest.approx(-400)  # 净支出
    legs = [_put(3.9, 0.03, -1), _put(3.8, 0.015, 1)]
    assert payoff.net_premium(legs) == pytest.approx(150)   # 净收入


# ── 组合形态 ──────────────────────────────────────────────────────────

def test_bull_call_spread_is_bounded():
    a = payoff.analyze([_call(4.0, 0.08, 1), _call(4.1, 0.04, -1)], 4.0)
    assert a["max_loss"] == pytest.approx(-400)
    assert a["max_profit"] == pytest.approx(600)
    assert a["unbounded"] == {"up": False, "down": False}
    assert a["breakevens"] == pytest.approx([4.04], abs=0.005)
    assert a["rr"] == pytest.approx(1.5)


def test_long_call_unbounded_up():
    a = payoff.analyze([_call(4.0, 0.08, 1)], 4.0)
    assert a["max_profit"] is None
    assert a["unbounded"]["up"] is True
    assert a["max_loss"] == pytest.approx(-800)


def test_iron_condor_shape():
    legs = [_put(3.9, 0.03, -1), _put(3.8, 0.015, 1),
            _call(4.1, 0.03, -1), _call(4.2, 0.015, 1)]
    a = payoff.analyze(legs, 4.0)
    assert a["max_profit"] == pytest.approx(300)
    assert a["max_loss"] == pytest.approx(-700)
    assert a["breakevens"] == pytest.approx([3.87, 4.13], abs=0.005)


def test_covered_call_shape():
    stock = {"type": "stock", "price": 4.0, "qty": 10000}
    a = payoff.analyze([stock, _call(4.1, 0.05, -1)], 4.0)
    assert a["max_profit"] == pytest.approx(1500)   # 涨到 4.1：1000 + 500
    # 理论最大亏损 = 标的跌到 0：(0-4.0+0.05)×10000，与直接持股同源
    assert a["max_loss"] == pytest.approx(-39500)
    assert a["rr"] is None                          # 现货端极值不报盈亏比


def test_position_greeks_scale_by_multiplier():
    leg = _call(4.0, 0.08, 1, delta=0.5)
    g = payoff.leg_greeks(leg)
    assert g["delta"] == pytest.approx(0.5 * 10000)
    stock = {"type": "stock", "qty": 10000, "price": 4.0}
    assert payoff.position_greeks([stock, leg])["delta"] == pytest.approx(15000)


# ── A 股卖方保证金 ────────────────────────────────────────────────────

def test_call_short_margin_exchange_formula():
    leg = {"type": "call", "strike": 4.2, "price": 0.05}
    # 虚值 0.2；12%*4.0-0.2=0.28 与 7%*4.0=0.28 取大；合计 (0.05+0.28)*10000
    assert payoff.short_margin(leg, 4.0) == pytest.approx(3300)


def test_put_short_margin_capped_by_strike():
    leg = {"type": "put", "strike": 3.8, "price": 0.04}
    # 虚值 0.2；max(0.48-0.2, 0.07*3.8=0.266)=0.28；(0.04+0.28)*10000=3200
    assert payoff.short_margin(leg, 4.0) == pytest.approx(3200)


def test_margin_total_ignores_long_legs():
    legs = [_call(4.0, 0.08, 1), _call(4.1, 0.04, -1)]
    m = payoff.margin_total(legs, 4.0)
    assert len(m["legs"]) == 1
    assert m["total"] == pytest.approx(4200)  # 虚值 0.1 → max(0.48-0.1, 0.28)=0.38；(0.04+0.38)×10000
    assert m["note"]


# ── 策略册 ────────────────────────────────────────────────────────────

def _chain(spot=4.0):
    strikes = [3.7, 3.8, 3.9, 4.0, 4.1, 4.2, 4.3]
    contracts = []
    for k in strikes:
        for side in ("call", "put"):
            delta = (0.5 + (spot - k) * 2.5) if side == "call" else (-0.5 - (spot - k) * 2.5)
            delta = max(-0.99, min(0.99, delta))
            contracts.append({
                "type": side, "strike": k, "bid": 0.03, "ask": 0.05, "last": 0.04,
                "delta": round(delta, 3), "gamma": 2.0, "theta": -0.002,
                "vega": 0.01, "iv": 22.0, "month": 202612, "days": 30,
                "name": f"{side}{k}", "code": f"{side}{k}", "prev_close": 0.04,
            })
    return {
        "underlying": {"price": spot},
        "front_month": 202612,
        "expiry_list": [{"month": 202612, "days": 30}],
        "contracts": contracts,
        "stats": {"atm_iv": 22.0, "atm_iv_pctl20": 82.0, "skew": 3.0},
    }


def test_suggest_high_iv_neutral_prefers_seller():
    out = pb.suggest(_chain(), direction="neutral", iv_pct=82)
    kinds = [i["kind"] for i in out["items"]]
    assert kinds[0] == "iron_condor"
    assert out["iv_bucket"] == "high"
    for item in out["items"]:
        assert item["analysis"]["curve"], "每条策略都要有损益曲线"


def test_suggest_low_iv_neutral_is_buyer():
    out = pb.suggest(_chain(), direction="neutral", iv_pct=12)
    assert [i["kind"] for i in out["items"]][0] == "long_straddle"


def test_suggest_call_high_iv_uses_spread():
    out = pb.suggest(_chain(), direction="call", iv_pct=80)
    assert [i["kind"] for i in out["items"]][0] == "bull_call"


def test_covered_call_legs_include_stock():
    out = pb.suggest(_chain(), direction="call", iv_pct=80, limit=4)
    cc = next((i for i in out["items"] if i["kind"] == "covered_call"), None)
    assert cc is not None
    assert {leg["type"] for leg in cc["legs"]} == {"stock", "call"}


def test_proposals_carry_margin_only_for_short_legs():
    out = pb.suggest(_chain(), direction="neutral", iv_pct=80)
    ic = next(i for i in out["items"] if i["kind"] == "iron_condor")
    assert ic["analysis"]["margin"]["total"] > 0
    assert len(ic["analysis"]["margin"]["legs"]) == 2  # 两条卖出腿
