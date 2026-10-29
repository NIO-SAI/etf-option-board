"""大模型输出与规则层的一致性校验（ticket 09 的可测部分）。

约束：纯函数，只喂输入、断言输出 —— 不触网、不读密钥、不调 LLM。
覆盖用户故事里最要命的一种冲突：规则层说「观望」，模型却给了买单。
"""

import pytest

from services import decision as dec


def _strat(kind, **kw):
    s = {"strategy": kind, "label": dec.STRATEGY_LABELS.get(kind, ""), "reason": "测试"}
    s.update(kw)
    return s


class TestExpectedAction:
    def test_single_legs(self):
        assert dec.expected_action(_strat(dec.STRATEGY_SINGLE_CALL)) == "buy_call"
        assert dec.expected_action(_strat(dec.STRATEGY_SINGLE_PUT)) == "buy_put"

    def test_wait(self):
        assert dec.expected_action(_strat(dec.STRATEGY_WAIT)) == "wait"

    def test_vertical_kind_picks_the_spread(self):
        assert dec.expected_action(
            _strat(dec.STRATEGY_VERTICAL, vertical_kind="bull_call")) == "bull_call_spread"
        assert dec.expected_action(
            _strat(dec.STRATEGY_VERTICAL, vertical_kind="bear_put")) == "bear_put_spread"

    def test_unknown_or_missing_means_no_constraint(self):
        assert dec.expected_action(None) is None
        assert dec.expected_action("不是字典") is None
        assert dec.expected_action({}) is None
        assert dec.expected_action({"strategy": "some_future_kind"}) is None


class TestRuleLayerWaitWins:
    """规则层观望时，模型不得给出买入动作。"""

    def test_buy_call_is_forced_to_wait(self):
        parsed = {"action": "buy_call", "contract_code": "10008888",
                  "contract_name": "50ETF购10月2900", "entry": 0.05, "confidence": 70}
        res = dec.align_llm_decision(parsed, _strat(dec.STRATEGY_WAIT), {"max_contracts": 3})
        assert res["decision"]["action"] == "wait"
        assert res["decision"]["model_action"] == "buy_call"     # 原值留痕，不静默篡改
        assert res["decision"]["contract_code"] == ""            # 观望不留合约
        assert res["decision"]["contract_name"] == ""
        assert res["decision"]["confidence"] == 70               # 其他字段不动
        assert res["adjustments"] and "观望" in res["adjustments"][0]

    @pytest.mark.parametrize("action", ["buy_put", "bull_call_spread", "bear_put_spread"])
    def test_other_buy_actions_also_forced(self, action):
        res = dec.align_llm_decision({"action": action}, _strat(dec.STRATEGY_WAIT), None)
        assert res["decision"]["action"] == "wait"
        assert res["decision"]["model_action"] == action

    def test_missing_action_is_filled_with_wait(self):
        res = dec.align_llm_decision({"summary": "看不清"}, _strat(dec.STRATEGY_WAIT), None)
        assert res["decision"]["action"] == "wait"
        assert res["decision"]["model_action"] is None
        assert res["adjustments"]


class TestOtherMismatchesFollowRuleLayer:
    def test_model_wait_but_rules_say_buy_call(self):
        res = dec.align_llm_decision({"action": "wait"}, _strat(dec.STRATEGY_SINGLE_CALL), None)
        assert res["decision"]["action"] == "buy_call"
        assert res["decision"]["model_action"] == "wait"
        assert res["adjustments"]

    def test_single_leg_model_action_overridden_by_vertical(self):
        res = dec.align_llm_decision({"action": "buy_call"}, 
                                     _strat(dec.STRATEGY_VERTICAL, vertical_kind="bull_call"), None)
        assert res["decision"]["action"] == "bull_call_spread"
        assert res["decision"]["model_action"] == "buy_call"

    def test_direction_conflict_is_corrected_by_rules(self):
        res = dec.align_llm_decision({"action": "buy_put"}, _strat(dec.STRATEGY_SINGLE_CALL), None)
        assert res["decision"]["action"] == "buy_call"

    def test_consistent_output_is_left_alone(self):
        res = dec.align_llm_decision({"action": "buy_call", "contracts": 2},
                                     _strat(dec.STRATEGY_SINGLE_CALL), {"max_contracts": 5})
        assert res["decision"]["action"] == "buy_call"
        assert res["adjustments"] == []
        assert "model_action" not in res["decision"]


class TestContractCap:
    def test_over_cap_is_clamped_and_recorded(self):
        res = dec.align_llm_decision({"action": "buy_call", "contracts": 12},
                                     _strat(dec.STRATEGY_SINGLE_CALL), {"max_contracts": 3})
        assert res["decision"]["contracts"] == 3
        assert res["decision"]["model_contracts"] == 12
        assert "手数上限" in res["adjustments"][0]

    def test_at_or_below_cap_untouched(self):
        for qty in (3, 1, 0):
            res = dec.align_llm_decision({"action": "buy_call", "contracts": qty},
                                         _strat(dec.STRATEGY_SINGLE_CALL), {"max_contracts": 3})
            assert res["decision"]["contracts"] == qty
            assert res["adjustments"] == []

    def test_float_quantity_near_cap(self):
        res = dec.align_llm_decision({"action": "buy_call", "contracts": 3.5},
                                     _strat(dec.STRATEGY_SINGLE_CALL), {"max_contracts": 3})
        assert res["decision"]["contracts"] == 3

    def test_no_cap_means_no_clamp(self):
        res = dec.align_llm_decision({"action": "buy_call", "contracts": 99},
                                     _strat(dec.STRATEGY_SINGLE_CALL), {})
        assert res["decision"]["contracts"] == 99
        assert res["adjustments"] == []

    def test_bad_types_do_not_raise(self):
        """模型偶尔把张数写成字符串/布尔，对齐逻辑必须活下来（约定：绝不抛）。"""
        res = dec.align_llm_decision({"action": "buy_call", "contracts": "很多"},
                                     _strat(dec.STRATEGY_SINGLE_CALL), {"max_contracts": 3})
        assert res["decision"]["contracts"] == "很多"
        res = dec.align_llm_decision({"action": "buy_call", "contracts": True},
                                     _strat(dec.STRATEGY_SINGLE_CALL), {"max_contracts": 3})
        assert res["decision"]["contracts"] is True


class TestPassthroughAndPurity:
    def test_error_payload_passes_through(self):
        err = {"error": "LLM HTTP 500: boom"}
        res = dec.align_llm_decision(err, _strat(dec.STRATEGY_WAIT), {"max_contracts": 1})
        assert res["decision"] == err
        assert res["adjustments"] == []

    def test_none_and_non_dict(self):
        assert dec.align_llm_decision(None, _strat(dec.STRATEGY_WAIT), None) == {
            "decision": None, "adjustments": []}
        assert dec.align_llm_decision(["不是字典"], _strat(dec.STRATEGY_WAIT), None) == {
            "decision": ["不是字典"], "adjustments": []}

    def test_input_is_not_mutated(self):
        parsed = {"action": "buy_call", "contracts": 9}
        dec.align_llm_decision(parsed, _strat(dec.STRATEGY_WAIT), {"max_contracts": 2})
        assert parsed == {"action": "buy_call", "contracts": 9}

    def test_no_strategy_layer_means_no_interference(self):
        parsed = {"action": "buy_put", "contracts": 4}
        res = dec.align_llm_decision(parsed, None, {"max_contracts": 8})
        assert res["decision"]["action"] == "buy_put"
        assert res["adjustments"] == []

    def test_both_conflicts_reported_in_one_pass(self):
        res = dec.align_llm_decision({"action": "buy_put", "contracts": 20},
                                     _strat(dec.STRATEGY_SINGLE_CALL), {"max_contracts": 4})
        assert res["decision"]["action"] == "buy_call"
        assert res["decision"]["contracts"] == 4
        assert len(res["adjustments"]) == 2


class TestExpiryFearBothDirections:
    """临期分级的两端：≤3 天 critical、4~7 天 warning、其余不提醒。"""

    def test_boundaries(self):
        assert dec.near_expiry_level(0) == "critical"
        assert dec.near_expiry_level(dec.CRITICAL_DAYS) == "critical"
        assert dec.near_expiry_level(dec.CRITICAL_DAYS + 1) == "warning"
        assert dec.near_expiry_level(dec.WARNING_DAYS) == "warning"
        assert dec.near_expiry_level(dec.WARNING_DAYS + 1) is None

    def test_no_alert_for_missing_or_past(self):
        assert dec.near_expiry_level(None) is None
        assert dec.near_expiry_level(-1) is None

    def test_alert_key_is_per_month_per_tier_per_day(self):
        import datetime as dt

        d1, d2 = dt.date(2026, 10, 27), dt.date(2026, 10, 28)
        k = dec.expiry_alert_key
        assert k(10, "call", d1) == k(10, "call", d1)
        assert k(10, "call", d1) != k(10, "put", d1)
        assert k(10, "call", d1) != k(11, "call", d1)
        assert k(10, "call", d1) != k(10, "call", d2)      # 跨日可再提醒
