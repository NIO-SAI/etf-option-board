"""提示词侧的规则层注入（ticket 09）。

真实调用大模型需要外部订阅，跑不了 CI；但「规则层结论有没有进提示词」是纯函数，
可以在这里钉死。提示词是模型与规则层之间唯一的接口，缺了字段就等于没注入。
"""

from services import llm


class TestCompactCarriesRuleLayer:
    def _bundle(self):
        return {
            "underlying": {"code": "510300", "price": 4.03},
            "strategy": {"strategy": "vertical", "label": "熊市看跌价差",
                         "reason": "IV 分位 89% 偏高", "month": "next",
                         "vertical_kind": "bear_put", "excluded_front": True},
            "expiry": {"today": "2026-10-27", "front_days": 1, "next_days": 29,
                       "level": "critical", "target_month": 11},
            "position": {"budget": 10000.0, "loss_per_contract": 542.0, "max_contracts": 18},
            "exposure": {"delta_notional": 2429271.6, "estimate": True},
            "limits": {"profile": "standard", "amounts": {"delta": 125000.0}},
            "limit_check": {"checked": True, "breached": True, "suggestion": "减到 5 张"},
        }

    def test_strategy_expiry_position_are_present(self):
        out = llm._compact(self._bundle())
        assert out["规则层策略"]["strategy"] == "vertical"
        assert out["到期日历"]["front_days"] == 1
        assert out["风险预算与手数上限"]["max_contracts"] == 18

    def test_exposure_and_limits_are_present(self):
        out = llm._compact(self._bundle())
        assert out["敞口与限额"]["敞口"]["estimate"] is True
        assert out["敞口与限额"]["限额"]["amounts"]["delta"] == 125000.0
        assert out["敞口与限额"]["超限"]["suggestion"] == "减到 5 张"

    def test_missing_rule_layer_does_not_raise(self):
        """老快照或降级路径没有这些字段时，_compact 不能抛。"""
        out = llm._compact({"underlying": {"code": "510300"}})
        assert out["规则层策略"] is None
        assert out["风险预算与手数上限"] is None


class TestSystemPromptDeclaresTheContract:
    def test_action_enum_includes_spreads(self):
        for action in ("buy_call", "buy_put", "bull_call_spread", "bear_put_spread", "wait"):
            assert action in llm._SYSTEM

    def test_contracts_and_legs_are_requested(self):
        assert '"contracts"' in llm._SYSTEM
        assert '"legs"' in llm._SYSTEM

    def test_rule_layer_is_declared_authoritative(self):
        assert "规则层" in llm._SYSTEM
        assert "不得超过" in llm._SYSTEM


class TestJsonExtraction:
    def test_plain(self):
        assert llm._extract_json('{"action": "wait"}') == {"action": "wait"}

    def test_fenced(self):
        assert llm._extract_json('```json\n{"action": "wait"}\n```') == {"action": "wait"}

    def test_embedded_in_prose(self):
        txt = '好的，结论如下：\n{"action": "buy_call", "contracts": 2}\n以上。'
        assert llm._extract_json(txt) == {"action": "buy_call", "contracts": 2}

    def test_garbage(self):
        assert llm._extract_json("") is None
        assert llm._extract_json("没有 JSON") is None
