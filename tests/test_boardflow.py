"""板块资金纯函数（ticket 02）。

约束：只喂输入、断言输出 —— 不触网、不读系统时钟、不写磁盘（日期时间全部注入）。
"""

import datetime as dt

import pytest

from services import boardflow as bf

# 2026-11-04 是星期三
WED = dt.date(2026, 11, 4)


def at(hh: int, mm: int, day: dt.date = WED) -> dt.datetime:
    return dt.datetime(day.year, day.month, day.day, hh, mm)


class TestInSession:
    @pytest.mark.parametrize("hh,mm,expected", [
        (9, 29, False), (9, 30, True), (10, 0, True),
        (11, 29, True), (11, 30, True), (11, 31, False),
        (12, 0, False), (12, 59, False),
        (13, 0, True), (14, 59, True), (15, 0, True), (15, 1, False),
        (0, 0, False), (20, 0, False),
    ])
    def test_weekday_windows(self, hh, mm, expected):
        assert bf.in_session(at(hh, mm)) is expected

    @pytest.mark.parametrize("day", [dt.date(2026, 11, 7), dt.date(2026, 11, 8)])
    def test_weekend_closed(self, day):
        assert bf.in_session(at(10, 0, day)) is False


class TestParseRankRows:
    def test_keeps_valid_rows_and_normalizes(self):
        rows = [
            {"f12": "BK0475", "f14": "半导体", "f62": 1.2e8, "f3": 3.5},
            {"f12": "BK0476", "f14": "证券", "f62": "-2.5e7", "f3": -1.2},
        ]
        out = bf.parse_rank_rows(rows, "industry")
        assert [r["code"] for r in out] == ["BK0475", "BK0476"]
        assert out[0] == {"code": "BK0475", "name": "半导体", "flow": 1.2e8,
                          "pct": 3.5, "type": "industry"}
        assert out[1]["flow"] == -2.5e7 and out[1]["type"] == "industry"

    @pytest.mark.parametrize("row", [
        {"f12": "600519", "f14": "贵州茅台", "f62": 1.0},        # 非板块
        {"f12": "BK0001", "f14": "", "f62": 1.0},                # 缺名称
        {"f12": "BK0002", "f14": "无资金", "f62": "-"},           # 资金不可解析
        {"f12": "BK0003", "f14": "坏值", "f62": None},            # 资金缺失
        "not-a-dict",
        None,
    ])
    def test_drops_bad_rows(self, row):
        assert bf.parse_rank_rows([row], "concept") == []

    def test_pct_defaults_and_dedupes(self):
        rows = [
            {"f12": "BK0001", "f14": "甲", "f62": 1.0},
            {"f12": "BK0001", "f14": "甲-重复", "f62": 9.0},
            {"f12": "BK0002", "f14": "乙", "f62": 2.0, "f3": "坏"},
        ]
        out = bf.parse_rank_rows(rows, "concept")
        assert len(out) == 2
        assert out[0]["name"] == "甲" and out[0]["flow"] == 1.0
        assert out[1]["pct"] == 0.0


class TestAssignRanks:
    def test_orders_by_flow_desc(self):
        rows = [
            {"code": "BK1", "name": "一", "flow": 1.0},
            {"code": "BK2", "name": "二", "flow": 5.0},
            {"code": "BK3", "name": "三", "flow": -3.0},
        ]
        out = bf.assign_ranks(rows)
        assert [r["code"] for r in out] == ["BK2", "BK1", "BK3"]
        assert [r["rank"] for r in out] == [1, 2, 3]
        assert all(r["prev_rank"] is None for r in out)

    def test_prev_rank_delta_and_new_entries(self):
        rows = [{"code": "BK1", "flow": 9.0}, {"code": "BK2", "flow": 5.0}]
        out = bf.assign_ranks(rows, {"BK1": 2, "BK9": 1})
        by_code = {r["code"]: r for r in out}
        assert by_code["BK1"]["rank"] == 1 and by_code["BK1"]["prev_rank"] == 2
        assert by_code["BK2"]["prev_rank"] is None      # 新上榜不伪造数字

    def test_tie_broken_by_code(self):
        rows = [{"code": "BK9", "flow": 1.0}, {"code": "BK3", "flow": 1.0}]
        assert [r["code"] for r in bf.assign_ranks(rows)] == ["BK3", "BK9"]


class TestPrunePlan:
    def test_keeps_recent_and_returns_plan_only(self):
        dates = [(WED - dt.timedelta(days=d)).isoformat() for d in (0, 10, 31, 200)]
        plan = bf.prune_plan(WED, dates, dates, keep_points=30, keep_rank=120)
        assert plan["flow_points"] == [(WED - dt.timedelta(days=200)).isoformat(),
                                       (WED - dt.timedelta(days=31)).isoformat()]
        assert plan["rank_snapshots"] == [(WED - dt.timedelta(days=200)).isoformat()]

    def test_bad_dates_are_kept(self):
        plan = bf.prune_plan(WED, ["", "not-a-date", "2026-13-40"], ["2026-01-01"])
        assert plan["flow_points"] == []
        assert plan["rank_snapshots"] == ["2026-01-01"]

    def test_boundary_day_kept(self):
        d30 = (WED - dt.timedelta(days=30)).isoformat()
        assert bf.prune_plan(WED, [d30], [])["flow_points"] == []


class TestAssignRanksByType:
    def test_each_type_ranked_separately(self):
        rows = [
            {"code": "BK1", "type": "concept", "flow": 1.0},
            {"code": "BK2", "type": "concept", "flow": 9.0},
            {"code": "BK3", "type": "industry", "flow": 5.0},
            {"code": "BK4", "type": "industry", "flow": 7.0},
        ]
        out = {r["code"]: r for r in bf.assign_ranks_by_type(rows)}
        assert out["BK2"]["rank"] == 1 and out["BK1"]["rank"] == 2
        assert out["BK4"]["rank"] == 1 and out["BK3"]["rank"] == 2

    def test_missing_type_defaults_to_concept(self):
        out = bf.assign_ranks_by_type([{"code": "BK1", "flow": 1.0}])
        assert out[0]["rank"] == 1


class TestBuildSeries:
    def test_aligns_on_union_axis_with_forward_fill(self):
        pts = {
            "BK1": [("09:31", 1.0), ("09:33", 3.0)],
            "BK2": [("09:32", -2.0)],
        }
        out = bf.build_series(pts)
        assert out["axis"] == ["09:31", "09:32", "09:33"]
        s1 = next(s for s in out["series"] if s["code"] == "BK1")
        s2 = next(s for s in out["series"] if s["code"] == "BK2")
        assert s1["values"] == [1.0, 1.0, 3.0]
        assert s2["values"] == [None, -2.0, -2.0]
        assert s1["last"] == 3.0 and s2["last"] == -2.0

    def test_same_minute_last_point_wins(self):
        out = bf.build_series({"BK1": [("09:31", 1.0), ("09:31", 2.0)]})
        assert out["axis"] == ["09:31"]
        assert out["series"][0]["values"] == [2.0]

    def test_empty_input(self):
        assert bf.build_series({}) == {"axis": [], "series": []}
        assert bf.build_series({"BK1": []})["series"][0]["values"] == []
