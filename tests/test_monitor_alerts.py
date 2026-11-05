"""变盘类告警的「按轮合并」纯逻辑。

约束：不触网、不读写磁盘；时间全部注入。告警总线只在内存里，测完清空。
"""

import asyncio
import datetime as dt

import pytest

from services import alerts, monitor

NOW = dt.datetime(2026, 11, 5, 10, 30)


def sig(code: str, name: str, side: str, score: float) -> dict:
    return {
        "etf_code": code, "etf_name": name, "type": "reversal", "level": "critical",
        "dir": side, "score": score,
        "title": f"{name} 看{'多' if side == 'bull' else '空'}变盘信号 {score:.0f}分",
        "text": f"方向{score:.0f}分｜15m确认",
        "factors": ["15m确认"], "contract": None,
        "ts": NOW.isoformat(timespec="seconds"),
    }


@pytest.fixture(autouse=True)
def _clean():
    alerts._history.clear()
    monitor._key_fired.clear()
    yield
    alerts._history.clear()
    monitor._key_fired.clear()


class TestReversalAggregate:
    def test_single_signal_keeps_original_alert(self):
        s = sig("510300", "沪深300ETF华泰柏瑞", "bull", 72.0)
        asyncio.run(monitor._reversal_alert([s]))
        out = alerts.history(5)
        assert len(out) == 1
        assert out[0]["title"] == s["title"]
        assert out[0]["etf_code"] == "510300"
        assert "items" not in out[0]

    def test_multiple_signals_merge_into_one(self):
        sigs = [
            sig("510300", "沪深300ETF华泰柏瑞", "bull", 72.0),
            sig("510500", "中证500ETF南方", "bear", 68.0),
            sig("510050", "上证50ETF华夏", "bull", 70.0),
        ]
        asyncio.run(monitor._reversal_alert(sigs))
        out = alerts.history(10)
        assert len(out) == 1                     # 三条信号只发一条
        a = out[0]
        assert a["type"] == "reversal" and a["level"] == "critical"
        assert a["title"].startswith("3 只标的同步变盘")
        assert a["dir"] == "mixed"               # 多空混杂不给单边方向
        assert [i["code"] for i in a["items"]] == ["510300", "510050", "510500"]  # 按分数降序
        assert "510300" not in a                   # 市场级告警不带单标的代码（列表不可点错标的）

    def test_same_direction_keeps_side(self):
        asyncio.run(monitor._reversal_alert([
            sig("510300", "沪深300ETF华泰柏瑞", "bull", 72.0),
            sig("510050", "上证50ETF华夏", "bull", 66.0),
        ]))
        assert alerts.history(1)[0]["dir"] == "bull"

    def test_empty_is_noop(self):
        asyncio.run(monitor._reversal_alert([]))
        assert alerts.history(5) == []


class TestKeyTimeAlert:
    def test_one_alert_per_key_time(self):
        asyncio.run(monitor._key_time_alert("10:30", now=NOW))
        asyncio.run(monitor._key_time_alert("10:30", now=NOW))   # 同一时点重复调用
        out = alerts.history(10)
        assert len(out) == 1
        assert out[0]["type"] == "key_time"
        assert "10:30" in out[0]["title"]
        assert len(out[0]["items"]) == 6          # 六只标的列在明细里，而不是推六条

    def test_new_key_time_alerts_again(self):
        asyncio.run(monitor._key_time_alert("10:30", now=NOW))
        asyncio.run(monitor._key_time_alert("11:00", now=NOW))
        assert [a["type"] for a in alerts.history(5)] == ["key_time", "key_time"]

    def test_none_key_time_noop(self):
        asyncio.run(monitor._key_time_alert(None, now=NOW))
        assert alerts.history(5) == []
