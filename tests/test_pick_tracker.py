"""优选合约的实盘跟踪与有界自校准（纯函数 + 临时文件，不触网）。"""

import datetime as dt

import pytest

from services import pick_tracker as pt

T = dt.datetime


@pytest.fixture(autouse=True)
def tmp_store(tmp_path, monkeypatch):
    monkeypatch.setattr(pt, "_PATH", str(tmp_path / "pick_history.json"))
    pt._reset_cache()
    yield
    pt._reset_cache()


def rec(**kw) -> dict:
    base = {
        "code": "510300", "date": "2026-11-02", "bucket": "2026-11-02T09:30",
        "entry_ts": "2026-11-02T09:30:00", "entry": 0.05,
        "direction": "call", "secid": "1.10000001", "name": "300ETF购12月4000",
        "strike": 4.0, "month": 12, "days": 20, "delta": 0.50, "score": 78.0,
        "spread": 1.0, "iv_pctl": 40.0, "theta_decay": 0.03,
        "rets": {}, "done": True,
    }
    base.update(kw)
    return base


def pick(**kw) -> dict:
    base = {"last": 0.05, "secid": "1.10000001", "name": "300ETF购12月4000",
            "strike": 4.0, "month": 12, "days": 20, "delta": 0.5,
            "score": 78.0, "spread": 1.0, "theta": -0.0015}
    base.update(kw)
    return base


class TestSession:
    @pytest.mark.parametrize("when,ok", [
        (T(2026, 11, 2, 9, 30), True),    # 周一开盘
        (T(2026, 11, 2, 11, 30), True),
        (T(2026, 11, 2, 12, 0), False),   # 午休
        (T(2026, 11, 2, 14, 59), True),
        (T(2026, 11, 2, 15, 1), False),
        (T(2026, 11, 1, 10, 0), False),   # 周日
    ])
    def test_in_session(self, when, ok):
        assert pt.in_session(when) is ok


class TestRecord:
    def test_records_top_pick(self):
        r = pt.record("510300", "call", pick(), iv_pctl=42.0, now=T(2026, 11, 2, 9, 40))
        assert r and r["entry"] == 0.05
        assert r["delta"] == 0.5 and r["iv_pctl"] == 42.0
        assert r["theta_decay"] == pytest.approx(0.03)
        assert r["rets"] == {} and r["done"] is False

    def test_same_bucket_only_once(self):
        now = T(2026, 11, 2, 9, 40)
        assert pt.record("510300", "call", pick(), now=now)
        # 同一 15 分钟档内（09:30-09:44）再记一次要被吞掉
        assert pt.record("510300", "call", pick(), now=now + dt.timedelta(minutes=3)) is None
        assert len(pt._load()) == 1

    def test_new_bucket_allowed(self):
        pt.record("510300", "call", pick(), now=T(2026, 11, 2, 9, 40))
        assert pt.record("510300", "call", pick(), now=T(2026, 11, 2, 10, 0))
        assert len(pt._load()) == 2

    def test_skips_outside_session(self):
        assert pt.record("510300", "call", pick(), now=T(2026, 11, 2, 12, 10)) is None
        assert pt._load() == []

    def test_skips_bad_pick(self):
        assert pt.record("510300", "call", None, now=T(2026, 11, 2, 9, 40)) is None
        assert pt.record("510300", "call", pick(last=0), now=T(2026, 11, 2, 9, 40)) is None


class TestUpdate:
    def _seed(self, **kw):
        pt._save([rec(**kw)])

    def test_fills_horizons_progressively(self):
        self._seed(done=False)
        chain = {"contracts": [{"secid": "1.10000001", "last": 0.055}]}
        assert pt.update("510300", chain, now=T(2026, 11, 2, 9, 50)) == 2   # 5m + 15m
        rets = pt._load()[0]["rets"]
        assert rets["ret5"] == pytest.approx(10.0) and rets["ret15"] == pytest.approx(10.0)
        assert "ret30" not in rets
        assert pt.update("510300", chain, now=T(2026, 11, 2, 10, 5)) == 1
        assert pt._load()[0]["rets"]["ret30"] == pytest.approx(10.0)
        assert pt._load()[0]["done"] is True

    def test_ignores_other_codes_and_finished(self):
        self._seed(done=True)
        chain = {"contracts": [{"secid": "1.10000001", "last": 0.06}]}
        assert pt.update("510300", chain, now=T(2026, 11, 2, 10, 30)) == 0

    def test_missing_quote_is_skipped(self):
        self._seed()
        assert pt.update("510300", {"contracts": []}, now=T(2026, 11, 2, 10, 30)) == 0


class TestStats:
    def test_hit_rate_and_buckets(self):
        rows = [
            rec(delta=0.52, iv_pctl=20.0, theta_decay=0.01, rets={"ret30": 4.0}),
            rec(delta=0.68, iv_pctl=85.0, theta_decay=0.08, rets={"ret30": -6.0}),
            rec(delta=0.40, iv_pctl=50.0, theta_decay=0.03, rets={"ret5": 1.0}),
        ]
        s = pt.stats(rows)
        assert s["n"] == 3
        assert s["hit"] == pytest.approx(66.7)
        assert s["buckets"]["iv"]["<25 分位"]["n"] == 1
        assert s["buckets"]["theta"][">6%/日"]["avg"] == -6.0

    def test_bench_prefers_longer_horizon(self):
        assert pt.bench_ret({"rets": {"ret5": 1.0, "ret15": 2.0, "ret30": 3.0}}) == 3.0
        assert pt.bench_ret({"rets": {"ret5": 1.0}}) == 1.0
        assert pt.bench_ret({"rets": {}}) is None


class TestCalibration:
    def test_default_when_samples_too_few(self):
        c = pt.calibration([rec(rets={"ret30": 5.0})] * 10)
        assert c["source"] == "default"
        assert c["target_delta_shift"] == 0.0 and c["theta_gain"] == 1.0

    def test_shifts_target_delta_toward_best_bucket(self):
        good = [rec(delta=0.66, rets={"ret30": 6.0}) for _ in range(15)]
        weak = [rec(delta=0.52, rets={"ret30": 0.0}) for _ in range(15)]
        c = pt.calibration(good + weak)
        assert c["source"] == "calibrated"
        assert 0 < c["target_delta_shift"] <= 0.05

    def test_shift_is_bounded(self):
        good = [rec(delta=0.80, rets={"ret30": 30.0}) for _ in range(15)]
        weak = [rec(delta=0.52, rets={"ret30": -30.0}) for _ in range(15)]
        assert pt.calibration(good + weak)["target_delta_shift"] == pytest.approx(0.05)

    def test_tightens_theta_when_fast_decay_loses(self):
        fast = [rec(delta=0.52, theta_decay=0.08, rets={"ret30": -5.0}) for _ in range(12)]
        slow = [rec(delta=0.52, theta_decay=0.01, rets={"ret30": 5.0}) for _ in range(12)]
        mid = [rec(delta=0.68, theta_decay=0.03, rets={"ret30": 0.0}) for _ in range(6)]
        c = pt.calibration(fast + slow + mid)
        assert c["theta_gain"] == 1.25

    def test_loosens_theta_when_fast_decay_wins(self):
        fast = [rec(delta=0.52, theta_decay=0.08, rets={"ret30": 9.0}) for _ in range(12)]
        slow = [rec(delta=0.52, theta_decay=0.01, rets={"ret30": -1.0}) for _ in range(12)]
        mid = [rec(delta=0.68, theta_decay=0.03, rets={"ret30": 0.0}) for _ in range(6)]
        assert pt.calibration(fast + slow + mid)["theta_gain"] == 0.85


class TestSummary:
    def test_summary_shape(self):
        pt._save([rec(rets={"ret30": 2.0})])
        s = pt.summary()
        assert set(s) == {"stats", "calibration", "path", "horizons"}
        assert s["stats"]["n"] == 1

    def test_records_are_capped(self, monkeypatch):
        monkeypatch.setattr(pt, "MAX_RECORDS", 3)
        pt._save([rec(bucket=str(i)) for i in range(5)])
        assert len(pt._load()) == 3
