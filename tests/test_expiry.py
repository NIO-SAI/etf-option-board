"""到期日历与临期分级（ticket 05 / 06 的纯函数部分）。

约束：只喂输入、断言输出 —— 不触网、不读系统时钟、不写磁盘（当日日期全部注入）。
期望值由独立实现（`calendar.monthcalendar`）预先核对过。
"""

import datetime as dt

import pytest

from services import decision as dec

D = dt.date


class TestExpiryCalendar:
    def test_front_month_and_days_left(self):
        rows = dec.expiry_calendar(D(2026, 10, 27))
        assert len(rows) == 4
        assert (rows[0]["year"], rows[0]["month"]) == (2026, 10)
        assert rows[0]["expiry"] == "2026-10-28"      # 到期月第 4 个星期三
        assert rows[0]["days_left"] == 1
        assert rows[0]["is_front"] is True
        assert rows[1]["is_next"] is True

    def test_months_are_front_next_then_two_quarters(self):
        rows = dec.expiry_calendar(D(2026, 10, 27))
        assert [r["month"] for r in rows] == [10, 11, 12, 3]
        assert [r["year"] for r in rows] == [2026, 2026, 2026, 2027]
        assert [r["expiry"] for r in rows] == [
            "2026-10-28", "2026-11-25", "2026-12-23", "2027-03-24"]
        assert [r["days_left"] for r in rows] == [1, 29, 57, 148]

    def test_expiry_day_itself_is_still_front_month(self):
        rows = dec.expiry_calendar(D(2026, 10, 28))
        assert rows[0]["month"] == 10
        assert rows[0]["days_left"] == 0

    def test_month_rolls_forward_after_expiry_day(self):
        rows = dec.expiry_calendar(D(2026, 10, 29))
        assert [r["month"] for r in rows] == [11, 12, 3, 6]
        assert [r["expiry"] for r in rows] == [
            "2026-11-25", "2026-12-23", "2027-03-24", "2027-06-23"]
        assert rows[0]["days_left"] == 27

    def test_year_crossing(self):
        rows = dec.expiry_calendar(D(2026, 12, 24))
        assert [(r["year"], r["month"]) for r in rows] == [
            (2027, 1), (2027, 2), (2027, 3), (2027, 6)]
        assert [r["expiry"] for r in rows] == [
            "2027-01-27", "2027-02-24", "2027-03-24", "2027-06-23"]
        assert rows[0]["days_left"] == 34

    def test_labels(self):
        rows = dec.expiry_calendar(D(2026, 10, 27))
        assert rows[0]["label"] == "2026年10月"
        assert rows[0]["short_label"] == "10月"

    def test_quarter_month_as_next_month_is_not_duplicated(self):
        """下月本身是季月时，四个月份仍互不重复。"""
        rows = dec.expiry_calendar(D(2026, 2, 10))
        months = [r["month"] for r in rows]
        assert months == [2, 3, 6, 9]
        assert len(set(months)) == 4

    def test_all_rows_are_not_yet_expired(self):
        rows = dec.expiry_calendar(D(2026, 10, 27))
        assert all(r["days_left"] >= 0 for r in rows)


class TestNearExpiryLevel:
    @pytest.mark.parametrize("days,expected", [
        (-5, None), (-1, None), (0, "critical"), (1, "critical"), (3, "critical"),
        (4, "warning"), (5, "warning"), (7, "warning"), (8, None), (30, None),
    ])
    def test_thresholds(self, days, expected):
        assert dec.near_expiry_level(days) == expected

    def test_none_days(self):
        assert dec.near_expiry_level(None) is None


class TestExpiryAlertKey:
    def test_key_shape(self):
        assert dec.expiry_alert_key(12, "call", D(2026, 10, 27)) == \
            "2026-10-27:expiry:12:call"

    def test_same_day_same_key_is_stable(self):
        """同一天重复计算得到同一个键，去重存储才有意义。"""
        assert dec.expiry_alert_key(12, "call", D(2026, 10, 27)) == \
            dec.expiry_alert_key(12, "call", D(2026, 10, 27))

    def test_key_differs_across_days(self):
        """跨日键失效 → 次日可再次提醒。"""
        assert dec.expiry_alert_key(12, "call", D(2026, 10, 27)) != \
            dec.expiry_alert_key(12, "call", D(2026, 10, 28))

    def test_key_differs_across_tier(self):
        assert dec.expiry_alert_key(12, "call", D(2026, 10, 27)) != \
            dec.expiry_alert_key(12, "put", D(2026, 10, 27))

    def test_key_differs_across_month(self):
        assert dec.expiry_alert_key(12, "call", D(2026, 10, 27)) != \
            dec.expiry_alert_key(11, "call", D(2026, 10, 27))


class TestExpiryAlertText:
    def test_mentions_month_days_and_expiry_date(self):
        t = dec.expiry_alert_text("call", 10, 3, "2026-10-28")
        assert "10 月" in t
        assert "3 天" in t
        assert "2026-10-28" in t

    @pytest.mark.parametrize("tier,label", [
        ("flat", "空仓"), ("etf", "持有ETF"), ("call", "持认购"), ("put", "持认沽"),
    ])
    def test_mentions_tier_relation(self, tier, label):
        assert label in dec.expiry_alert_text(tier, 10, 3, "2026-10-28")

    def test_unknown_tier_does_not_raise(self):
        assert dec.expiry_alert_text("nope", 10, 3, "2026-10-28")
