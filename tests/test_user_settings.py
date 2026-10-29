"""user_settings 纯函数的单元测试（Seam 1：纯决策函数层）。

约束：只喂输入、断言输出 —— 不触网、不读系统时钟、不写磁盘。
文件读写的薄壳（load/save）不在本层测试范围内，由端点冒烟覆盖。
"""

import pytest

from services import user_settings as us


class TestDefaults:
    """未配置时应给出保守默认值，而不是报错或给 None 之外的怪值。"""

    def test_unconfigured_returns_conservative_defaults(self):
        s, errs = us.parse(None)
        assert errs == []
        assert s["risk_pct"] == 1.0           # 保守档
        assert s["total_capital"] is None     # 未设置总资金
        assert s["configured"] is False

    def test_empty_dict_is_unconfigured(self):
        s, errs = us.parse({})
        assert errs == []
        assert s["configured"] is False
        assert s["risk_pct"] == us.DEFAULT_RISK_PCT

    def test_none_and_empty_string_mean_unset(self):
        s, errs = us.parse({"total_capital": None, "risk_pct": ""})
        assert errs == []
        assert s["total_capital"] is None
        assert s["risk_pct"] == us.DEFAULT_RISK_PCT
        assert s["configured"] is False

    @pytest.mark.parametrize("raw", [[], "x", 3, object()])
    def test_non_dict_input_degrades_to_unconfigured(self, raw):
        s, errs = us.parse(raw)
        assert errs == []
        assert s["configured"] is False


class TestValidInput:
    def test_accepts_int_capital_and_risk(self):
        s, errs = us.parse({"total_capital": 500000, "risk_pct": 2})
        assert errs == []
        assert s["total_capital"] == pytest.approx(500000.0)
        assert s["risk_pct"] == 2.0
        assert s["configured"] is True

    def test_accepts_numeric_strings(self):
        s, errs = us.parse({"total_capital": "300000", "risk_pct": "3"})
        assert errs == []
        assert s["total_capital"] == pytest.approx(300000.0)
        assert s["risk_pct"] == 3.0

    def test_accepts_float_capital(self):
        s, errs = us.parse({"total_capital": 123456.78, "risk_pct": 1})
        assert errs == []
        assert s["total_capital"] == pytest.approx(123456.78)

    def test_whitespace_padded_string_accepted(self):
        s, errs = us.parse({"total_capital": " 300000 ", "risk_pct": 2})
        assert errs == []
        assert s["total_capital"] == pytest.approx(300000.0)

    @pytest.mark.parametrize("pct", [1, 2, 3, 1.0, 2.0, 3.0, "1", "2", "3"])
    def test_all_three_risk_choices_accepted(self, pct):
        s, errs = us.parse({"total_capital": 100000, "risk_pct": pct})
        assert errs == []
        assert s["risk_pct"] in us.RISK_PCT_CHOICES

    def test_risk_pct_choices_are_one_two_three(self):
        assert us.RISK_PCT_CHOICES == (1.0, 2.0, 3.0)


class TestInvalidCapital:
    @pytest.mark.parametrize("bad", [0, -1, -0.01, "abc", "  ", [], {}, True])
    def test_rejected_with_reason(self, bad):
        s, errs = us.parse({"total_capital": bad, "risk_pct": 2})
        assert any("总资金" in e for e in errs), f"应在错误里点明总资金：{errs}"
        assert s["total_capital"] is None    # 非法值回落到未设置

    def test_valid_field_survives_invalid_sibling(self):
        s, errs = us.parse({"total_capital": -5, "risk_pct": 3})
        assert any("总资金" in e for e in errs)
        assert s["risk_pct"] == 3.0          # 合法字段不被牵连


class TestInvalidRiskPct:
    @pytest.mark.parametrize("bad", [0, 4, 1.5, 2.5, -1, 100, "abc", True])
    def test_rejected_with_reason(self, bad):
        s, errs = us.parse({"total_capital": 100000, "risk_pct": bad})
        assert any("风险" in e for e in errs), f"应在错误里点明风险档：{errs}"
        assert s["risk_pct"] == us.DEFAULT_RISK_PCT

    def test_capital_survives_invalid_risk(self):
        s, errs = us.parse({"total_capital": 100000, "risk_pct": 9})
        assert any("风险" in e for e in errs)
        assert s["total_capital"] == pytest.approx(100000.0)


class TestRobustness:
    @pytest.mark.parametrize("raw", [
        {"total_capital": object(), "risk_pct": object()},
        {"total_capital": [], "risk_pct": {}},
    ])
    def test_never_raises_on_garbage(self, raw):
        s, errs = us.parse(raw)
        assert errs                         # 报错，但不抛异常
        assert s["configured"] is False

    def test_does_not_mutate_input(self):
        raw = {"total_capital": 500000, "risk_pct": 2}
        us.parse(raw)
        assert raw == {"total_capital": 500000, "risk_pct": 2}

    def test_unknown_keys_are_ignored(self):
        s, errs = us.parse({"total_capital": 100000, "risk_pct": 2, "bogus": 1})
        assert errs == []
        assert "bogus" not in s

    def test_configured_requires_capital(self):
        """只填了风险档而没填总资金，仍算未配置（手数上限无从算起）。"""
        s, errs = us.parse({"risk_pct": 3})
        assert errs == []
        assert s["configured"] is False
        assert s["risk_pct"] == 3.0


class TestExposureTierSettings:
    """敷口档位与档位规模（ticket 03 的设支部分）。"""

    def test_defaults(self):
        s, errs = us.parse({})
        assert errs == []
        assert s["tier"] == "flat" and s["size"] == "mid"

    @pytest.mark.parametrize("tier", ["flat", "etf", "call", "put"])
    def test_all_four_tiers_accepted(self, tier):
        s, errs = us.parse({"tier": tier})
        assert errs == [] and s["tier"] == tier

    @pytest.mark.parametrize("size", ["light", "mid", "heavy"])
    def test_all_three_sizes_accepted(self, size):
        s, errs = us.parse({"size": size})
        assert errs == [] and s["size"] == size

    @pytest.mark.parametrize("bad", ["nope", "FLAT", 1, {}, [], True])
    def test_bad_tier_rejected(self, bad):
        s, errs = us.parse({"tier": bad})
        assert any("敞口档位" in e for e in errs)
        assert s["tier"] == us.DEFAULT_TIER

    @pytest.mark.parametrize("bad", ["nope", "MID", 2, {}, True])
    def test_bad_size_rejected(self, bad):
        s, errs = us.parse({"size": bad})
        assert any("档位规模" in e for e in errs)
        assert s["size"] == us.DEFAULT_SIZE

    def test_empty_string_means_unset_not_error(self):
        s, errs = us.parse({"tier": "", "size": ""})
        assert errs == []
        assert s["tier"] == "flat" and s["size"] == "mid"

    def test_tier_survives_invalid_capital(self):
        s, errs = us.parse({"total_capital": -1, "tier": "etf", "size": "heavy"})
        assert errs
        assert s["tier"] == "etf" and s["size"] == "heavy"

    def test_view_exposes_choices_and_labels(self):
        s, _ = us.parse({"total_capital": 100000, "tier": "call", "size": "light"})
        v = us.view(s)
        assert v["tier_label"] == "持认购" and v["size_label"] == "轻"
        assert [c["key"] for c in v["tier_choices"]] == ["flat", "etf", "call", "put"]
        assert [c["key"] for c in v["size_choices"]] == ["light", "mid", "heavy"]
        assert v["risk_pct_choices"] == [1.0, 2.0, 3.0]

    def test_view_repairs_invalid_tier(self):
        v = us.view({"tier": "junk", "size": "junk"})
        assert v["tier"] == "flat" and v["size"] == "mid"
