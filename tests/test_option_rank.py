"""合约优选打分（短期买方口径）：IV 便宜度、Theta、期望收益、流动性绝对锚点、
组合去重与主选/备选、自校准参数、以及看板/告警口径一致。

约束与其它用例一致：不触网、不读系统时钟、不写磁盘。
"""

import pytest

from services import option_service as osvc


def C(code: str, **kw) -> dict:
    """构造一只「合约」字典，默认参数即一只流动性不错的平值认购。"""
    base = {
        "code": code, "secid": f"1.{code}", "name": f"{code}合约",
        "type": "call", "is_call": True, "strike": 4.0, "month": 11, "days": 15,
        "last": 0.05, "pct": 1.0, "volume": 1000, "amount": 1e7, "oi": 10000,
        "bid": 0.049, "ask": 0.051, "spread": 1.0, "moneyness": 0.0,
        "premium_rate": 1.0, "iv": 20.0, "delta": 0.50, "gamma": 0.5,
        "vega": 0.01, "theta": -0.0015, "leverage": 40.0, "break_even": 4.05,
    }
    base.update(kw)
    return base


def chain(contracts, price=4.0, pct=0.5, stats=None) -> dict:
    return {"underlying": {"price": price, "pct": pct},
            "contracts": contracts, "stats": stats or {}}


def one(c, **kw) -> dict:
    """单合约打分结果（不受去重影响）。"""
    ranked = osvc.rank_candidates(chain([c], **kw.get("chain", {})), "call", top=6,
                                  levels=kw.get("levels"), spot=kw.get("spot", 4.0),
                                  calib=kw.get("calib"))
    return ranked[0]


def scored(c, **kw) -> float:
    return one(c, **kw)["score"]


class TestIvCost:
    def test_cheaper_iv_ranks_higher(self):
        # 同侧隐波越便宜，买方付得越少 → 分越高（旧口径是反的）。
        # 两只 Δ 对称（0.55 / 0.45），Delta 得分相同，差异只来自 IV。
        a, b = C("A", delta=0.55, iv=18.0), C("B", delta=0.45, iv=32.0)
        ranked = osvc.rank_candidates(chain([a, b]), "call")
        assert ranked[0]["code"] == "A"

    def test_high_iv_percentile_dampens_score(self):
        c = C("A", iv=22.0)
        cheap = one(c, chain={"stats": {"atm_iv_pctl20": 10}})["score"]
        rich = one(c, chain={"stats": {"atm_iv_pctl20": 90}})["score"]
        assert cheap > rich

    def test_iv_rv_ratio_used_when_percentile_missing(self):
        c = C("A", iv=22.0)
        cheap = one(c, chain={"stats": {}})["score"]
        rich = osvc.rank_candidates(
            chain([c]), "call", trend={"iv_rv_ratio": 1.5})[0]["score"]
        assert cheap > rich

    def test_missing_iv_is_middle(self):
        a, b, m = C("A", delta=0.55, iv=15.0), C("B", delta=0.45, iv=35.0), C("M", iv=None)
        ranked = osvc.rank_candidates(chain([a, b, m]), "call")
        assert [c["code"] for c in ranked] == ["A", "M", "B"]


class TestThetaCost:
    def test_fast_decay_ranks_lower(self):
        calm = C("CALM", theta=-0.0005)      # 1%/日
        burn = C("BURN", theta=-0.004)       # 8%/日
        assert scored(calm) > scored(burn)

    def test_near_expiry_is_penalised(self):
        far = C("FAR", days=15)
        near = C("NEAR", days=2, last=0.01, premium_rate=0.2, iv=18.0)
        assert scored(far) > scored(near)

    def test_calibration_can_tighten_theta(self):
        burn = C("BURN", theta=-0.0025)      # 5%/日：还没被扣满，收紧才看得出来
        plain = scored(burn)
        tight = scored(burn, calib={"theta_gain": 1.25})
        assert tight < plain


class TestExpectancy:
    LEVELS = {"entry_break": 4.0, "stop": 3.98, "target": 4.06}

    def test_favourable_reward_risk_scores_higher(self):
        good = one(C("G"), levels=self.LEVELS)
        bad = one(C("B"), levels={"entry_break": 4.0, "stop": 3.98, "target": 4.005})
        assert good["score"] > bad["score"]
        assert good["rr"]["roi"] > 0 > bad["rr"]["roi"]

    def test_loss_is_capped_by_hard_stop(self):
        # 止损很远（-20%）时，合约层硬止损 -30% 先兜住（与 contract_levels 的 stop 收紧口径一致）
        r = one(C("A", last=0.05, delta=0.5),
                levels={"entry_break": 4.0, "stop": 3.2, "target": 4.2})
        assert r["rr"]["down"] == pytest.approx(0.015)

    def test_roi_uses_entry_cost_not_last(self):
        # 突破入场：现价 0.05，触发价 0.06。期望收益的分母是入场成本 0.06，不是现价。
        r = one(C("A", last=0.05, delta=0.5), levels=self.LEVELS, spot=3.98)
        assert r["rr"]["up"] == pytest.approx(0.03)
        assert r["rr"]["down"] == pytest.approx(0.01)
        assert r["rr"]["roi"] == pytest.approx(round((0.5 * 0.03 - 0.5 * 0.01) / 0.06, 3))

    def test_missing_levels_is_neutral(self):
        r = one(C("A"))
        assert r["rr"] is None
        assert r["_parts"]["ev"] == pytest.approx(0.5)

    def test_expectancy_reason_present(self):
        r = one(C("A"), levels=self.LEVELS)
        assert any("盈亏比" in t for t in r["reasons"])

    def test_put_legs_use_signed_delta(self):
        # put 的 target 在下、stop 在上，Δ<0：盈利腿/亏损腿都必须为正，ROI 不能恒为 0。
        put = C("P", delta=-0.5, last=0.4)
        r = one(put, levels={"entry_break": 4.0, "stop": 4.2, "target": 3.7})
        assert r["rr"]["up"] == pytest.approx(0.15)
        assert r["rr"]["down"] == pytest.approx(0.10)
        assert r["rr"]["roi"] == pytest.approx(0.062)


class TestLiquidity:
    def test_missing_two_sided_quote_is_penalised(self):
        quoted = C("QUOTED", spread=1.0)
        blind = C("BLIND", spread=None, bid=None, ask=None)
        assert scored(quoted) > scored(blind)

    def test_wide_spread_is_dropped(self):
        good = C("GOOD", delta=0.52, spread=1.5)
        wide = C("WIDE", delta=0.46, spread=15.0, amount=5e7, oi=50000, volume=5000)
        codes = [c["code"] for c in osvc.rank_candidates(chain([good, wide]), "call")]
        assert "WIDE" not in codes and "GOOD" in codes

    def test_all_wide_spread_still_returns_rows(self):
        wide = C("WIDE", spread=30.0)
        assert [c["code"] for c in osvc.rank_candidates(chain([wide]), "call")] == ["WIDE"]

    def test_liquidity_uses_absolute_anchors(self):
        # 冷清合约不该因为「池里最大」就拿满分：分数要能跨天/跨标的比较
        busy = one(C("BUSY", amount=1.5e8, oi=40000, volume=20000))["_parts"]["liq"]
        quiet = one(C("QUIET", amount=5e5, oi=800, volume=200))["_parts"]["liq"]
        assert busy > 0.8 and quiet < 0.35


class TestDeltaBand:
    def test_deep_otm_excluded(self):
        atm = C("ATM", delta=0.50)
        dust = C("DUST", delta=0.05, amount=9e7, oi=90000, volume=9000)
        codes = [c["code"] for c in osvc.rank_candidates(chain([atm, dust]), "call")]
        assert "DUST" not in codes

    def test_deep_itm_excluded(self):
        atm = C("ATM", delta=0.50)
        deep = C("DEEP", delta=0.95, amount=9e7, oi=90000, volume=9000)
        codes = [c["code"] for c in osvc.rank_candidates(chain([atm, deep]), "call")]
        assert "DEEP" not in codes

    def test_band_falls_back_when_everything_is_outside(self):
        ranked = osvc.rank_candidates(chain([C("DUST", delta=0.05)]), "call")
        assert [c["code"] for c in ranked] == ["DUST"]

    def test_calibration_shifts_target_delta(self):
        r = one(C("A", delta=0.55), calib={"target_delta_shift": 0.05})
        assert r["target_delta"] == pytest.approx(0.55)
        assert r["_parts"]["delta"] == pytest.approx(1.0)


class TestDedupeAndRole:
    def test_same_delta_same_month_kept_once(self):
        a = C("A", delta=0.50, iv=18.0)
        b = C("B", delta=0.52, iv=17.0)
        c = C("Cc", delta=0.62, iv=19.0)
        ranked = osvc.rank_candidates(chain([a, b, c]), "call")
        assert len(ranked) == 2
        assert ranked[0]["code"] == "B"      # 同档里 IV 更便宜的那只
        assert {x["code"] for x in ranked} == {"B", "Cc"}

    def test_same_delta_different_month_kept(self):
        a = C("A", delta=0.50, month=11, days=15)
        b = C("B", delta=0.50, month=12, days=45)
        ranked = osvc.rank_candidates(chain([a, b]), "call")
        assert {x["code"] for x in ranked} == {"A", "B"}

    def test_roles(self):
        cs = [C("A", delta=0.50, iv=18.0), C("B", delta=0.62, iv=19.0)]
        ranked = osvc.rank_candidates(chain(cs), "call")
        assert ranked[0]["role"] == "主选"
        assert all(c["role"] == "备选" for c in ranked[1:])


class TestDirection:
    def test_only_trend_side_returned(self):
        calls = [C("C1", delta=0.55), C("C2", delta=0.45)]
        puts = [C("P1", type="put", is_call=False, delta=-0.55),
                C("P2", type="put", is_call=False, delta=-0.45)]
        ranked = osvc.rank_candidates(
            chain(calls + puts), "auto", trend={"direction": "call", "score": 60})
        assert {c["code"] for c in ranked} == {"C1", "C2"}

    def test_explicit_direction_overrides_trend(self):
        # 反向备选：明确要 call，即使市场方向是 put 也不能返回认沽
        calls = [C("C1", delta=0.55)]
        puts = [C("P1", type="put", is_call=False, delta=-0.55)]
        ranked = osvc.rank_candidates(chain(calls + puts), "call",
                                      trend={"direction": "put", "score": -60})
        assert [c["code"] for c in ranked] == ["C1"]
        assert ranked[0]["trend_aligned"] is False
        assert any("逆当前方向" in t for t in ranked[0]["reasons"])

    def test_auto_uses_underlying_pct_without_trend(self):
        calls = [C("C1")]
        puts = [C("P1", type="put", is_call=False)]
        ranked = osvc.rank_candidates(chain(calls + puts, pct=-0.8), "auto")
        assert [c["code"] for c in ranked] == ["P1"]

    def test_aligned_side_scores_higher(self):
        calls = [C("C1")]
        puts = [C("P1", type="put", is_call=False, delta=-0.50)]
        best = osvc.best_buys(chain(calls + puts), {"direction": "call", "score": 70})
        assert best["call"]["score"] > best["put"]["score"]
        assert best["recommended"]["side"] == "call"

    def test_neutral_trend_keeps_both_sides_fair(self):
        calls = [C("C1")]
        puts = [C("P1", type="put", is_call=False, delta=-0.50)]
        best = osvc.best_buys(chain(calls + puts), {"direction": "neutral", "score": 0})
        assert best["trend"]["label"] == "震荡/观望"
        assert best["call"]["score"] == pytest.approx(best["put"]["score"])


class TestPool:
    def test_only_nearest_two_months(self):
        june = C("M1", month=6, days=15, delta=0.55)
        july = C("M2", month=7, days=45, delta=0.45)
        far = C("FAR", month=9, days=120, delta=0.50, amount=9e8, oi=9e5, volume=9e5)
        codes = {c["code"] for c in osvc.rank_candidates(chain([june, july, far]), "call")}
        assert codes == {"M1", "M2"}

    def test_no_contracts_returns_empty(self):
        assert osvc.rank_candidates(chain([]), "call") == []

    def test_zero_price_contract_dropped(self):
        assert osvc.rank_candidates(chain([C("DEAD", last=0)]), "call") == []


class TestOutput:
    def test_score_range_and_parts(self):
        r = one(C("A"))
        assert 0 <= r["score"] <= 100
        assert set(r["_parts"]) == set(osvc.SCORE_WEIGHTS)
        assert sum(osvc.SCORE_WEIGHTS.values()) == pytest.approx(1.0)
        assert 1 <= len(r["reasons"]) <= 5

    def test_ranking_is_sorted(self):
        cs = [C("A", delta=0.55, iv=18.0), C("B", delta=0.45, iv=28.0),
              C("Cc", delta=0.65, theta=-0.003)]
        scores = [c["score"] for c in osvc.rank_candidates(chain(cs), "call")]
        assert scores == sorted(scores, reverse=True)

    def test_top_n(self):
        cs = [C(f"A{i}", delta=0.30 + i * 0.06, iv=18.0 + i) for i in range(9)]
        assert len(osvc.rank_candidates(chain(cs), "call", top=3)) == 3


class TestUnifiedScoring:
    def test_best_buys_matches_rank_candidates(self):
        """看板列表与告警/LLM 的 best 必须是同一套分数。"""
        calls = [C("C1", delta=0.52), C("C2", delta=0.42, iv=23.0, theta=-0.002)]
        puts = [C("P1", type="put", is_call=False, delta=-0.48)]
        ch = chain(calls + puts, stats={"atm_iv_pctl20": 40})
        trend = {"direction": "call", "score": 55}
        levels = {"entry_break": 4.0, "stop": 3.98, "target": 4.06}
        ranked = osvc.rank_candidates(ch, "call", top=6, trend=trend,
                                      levels=levels, spot=4.0)
        best = osvc.best_buys(ch, trend, levels=levels, spot=4.0)["call"]
        assert best["code"] == ranked[0]["code"]
        assert best["score"] == pytest.approx(ranked[0]["score"])

    def test_best_buys_ignores_far_month(self):
        ch = chain([C("NEAR", days=10), C("NEXT", days=45),
                    C("FAR", days=120, amount=9e8, oi=9e5, volume=9e5)])
        assert osvc.best_buys(ch, {"direction": "call", "score": 0})["call"]["code"] != "FAR"
