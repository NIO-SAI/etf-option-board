"""涨停棱镜的纯函数单测（不触网、不读系统时钟、不写磁盘）。

覆盖：主题等级分档、扩张/高潮/三共振判定、周期表矩阵、概念噪音过滤、
按概念聚合涨停数（含连板/首板/炸板/烂板）。
"""

from __future__ import annotations

from services import limitup as lu


def test_tier_of_boundaries():
    assert lu.tier_of(0) == "0~3"
    assert lu.tier_of(2) == "0~3"
    assert lu.tier_of(3) == "3~5"
    assert lu.tier_of(5) == "5~10"
    assert lu.tier_of(10) == "10~15"
    assert lu.tier_of(15) == "15以上"
    assert lu.tier_of(99) == "15以上"


def test_is_noise_filters_geo_and_financial():
    assert lu._is_noise("福建板块")
    assert lu._is_noise("题材股")
    assert lu._is_noise("2026中报首亏")
    assert lu._is_noise("信托重仓")
    assert lu._is_noise("昨日涨停")
    # 真正的概念要留下
    assert not lu._is_noise("光伏概念")
    assert not lu._is_noise("人形机器人")
    assert not lu._is_noise("次新股")


def test_classify_theme():
    assert lu.classify_theme("高股息精选") == "风格性"
    assert lu.classify_theme("业绩预增") == "事件性"
    assert lu.classify_theme("光伏概念") == "产业链"


def test_is_expanding():
    # 前 5 日均值 2，当日 4 > 2*1.5=3 → 扩张
    assert lu.is_expanding([2, 2, 2, 2, 2, 4])
    # 当日 3 不大于 3 → 不算
    assert not lu.is_expanding([2, 2, 2, 2, 2, 3])
    # 没有历史可比 → 不判定为扩张
    assert not lu.is_expanding([1])
    assert not lu.is_expanding([])


def test_is_climax():
    assert lu.is_climax([1, 2, 3, 4, 5])
    assert not lu.is_climax([1, 5, 3, 4, 2])
    assert not lu.is_climax([1, 2])              # 不足 3 家
    assert lu.is_climax([2, 2, 3])


def test_is_resonance():
    # 三项都高于各自前 5 日均值
    assert lu.is_resonance([1, 1, 1, 2], [1, 1, 1, 2], [1, 1, 1, 2])
    # 炸板没放大 → 不算
    assert not lu.is_resonance([1, 1, 1, 2], [1, 1, 1, 2], [3, 3, 3, 1])
    # 单项为 0 → 不算
    assert not lu.is_resonance([1, 1, 1, 2], [0, 0, 0, 0], [1, 1, 1, 2])


def test_build_matrix_pads_and_ranks():
    per_day = [
        {"date": "20261105", "themes": [
            {"board": "A", "name": "甲", "zt": 2, "max_lbc": 1},
            {"board": "B", "name": "乙", "zt": 5, "max_lbc": 2},
        ]},
        {"date": "20261106", "themes": []},
    ]
    cols = lu.build_matrix(per_day, top=3)
    assert len(cols) == 2
    assert [c["name"] if c else None for c in cols[0]] == ["乙", "甲", None]
    assert cols[1] == [None, None, None]


def test_aggregate_themes_counts():
    pool = [
        {"code": "000001", "name": "甲", "lbc": 3},
        {"code": "000002", "name": "乙", "lbc": 1},
        {"code": "000003", "name": "丙", "lbc": 2},
    ]
    concepts = {
        "000001": [{"name": "光伏概念", "rank": 1}],
        "000002": [{"name": "光伏概念", "rank": 2}],
        "000003": [{"name": "光伏概念", "rank": 3}, {"name": "机器人", "rank": 4}],
    }
    broken = [{"code": "000003", "name": "丙", "zbc": 3}]
    boards = {"光伏概念": {"code": "BK1031", "pct": 1.2, "main": 1e8},
              "机器人": {"code": "BK0800", "pct": -0.5, "main": -2e7}}

    out = lu.aggregate_themes(pool, concepts, broken, boards)
    pv = next(t for t in out if t["name"] == "光伏概念")
    assert pv["zt"] == 3
    assert pv["max_lbc"] == 3
    assert pv["lianban"] == 2      # lbc>=2 的两只
    assert pv["first_board"] == 1
    assert pv["zb"] == 1 and pv["lan"] == 1
    assert pv["board"] == "BK1031"
    assert pv["pct"] == 1.2 and pv["main"] == 1e8
    # 排序：涨停数多的在前
    assert out[0]["name"] == "光伏概念"


def test_aggregate_themes_keeps_zt_only_theme():
    """只有涨停没有炸板的主题也要出现在榜里（zb/lan 为 0）。"""
    out = lu.aggregate_themes(
        [{"code": "1", "name": "甲", "lbc": 1}],
        {"1": [{"name": "冷门概念", "rank": 1}]},
        [],
        {},
    )
    assert out[0]["name"] == "冷门概念"
    assert out[0]["zt"] == 1 and out[0]["zb"] == 0 and out[0]["lan"] == 0
    assert out[0]["board"] is None      # 名单里没有的板块，代码缺失也能落库
