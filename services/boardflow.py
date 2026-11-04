"""板块资金本地库（SQLite）：采集器唯一写入，读接口只读。

设计取舍见 `.scratch/board-flow/spec.md` 与 `docs/adr/0003`：
- 单写路径：交易时段由后台采集器写库，页面读库，打开页面不再触发批量抓取；
- 纯函数与存储层分离：时段判定、解析归一、名次、裁剪计划都可离线单测；
- 连接每次加锁打开、显式 close（`with sqlite3.connect()` 只提交不关闭，会泄漏 fd）。
"""

from __future__ import annotations

import datetime as dt
import json
import logging
import os
import sqlite3
import threading
from contextlib import contextmanager
from typing import Iterable

log = logging.getLogger("boardflow")

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_DATA_DIR = os.path.join(_ROOT, "data")
_DB_FILE = os.path.join(_DATA_DIR, "board_flow.db")
_WATCH_FILE = os.path.join(_DATA_DIR, "board_watch.json")

# 保留窗口（交易日）
KEEP_POINT_DAYS = 30
KEEP_RANK_DAYS = 120

_SESSION_AM = ("09:30", "11:30")
_SESSION_PM = ("13:00", "15:00")

_LOCK = threading.Lock()

_SCHEMA = """
CREATE TABLE IF NOT EXISTS boards (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'concept'
);
CREATE TABLE IF NOT EXISTS rank_snapshots (
    date TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    flow REAL NOT NULL,
    pct REAL NOT NULL DEFAULT 0,
    rank INTEGER,
    prev_rank INTEGER,
    ts TEXT,
    PRIMARY KEY (date, code)
);
CREATE INDEX IF NOT EXISTS idx_rank_date ON rank_snapshots(date, type, rank);
CREATE TABLE IF NOT EXISTS flow_points (
    date TEXT NOT NULL,
    code TEXT NOT NULL,
    time TEXT NOT NULL,
    flow REAL NOT NULL,
    PRIMARY KEY (date, code, time)
);
CREATE INDEX IF NOT EXISTS idx_points_date ON flow_points(date, code, time);
"""


# --------------------------------------------------------------------------
# 纯函数（可单测：不触网、不读时钟、不写盘）
# --------------------------------------------------------------------------
def _hm(t: dt.time) -> int:
    return t.hour * 60 + t.minute


def _window(hm: int, se: tuple[str, str]) -> bool:
    a, b = se
    start = int(a[:2]) * 60 + int(a[3:])
    end = int(b[:2]) * 60 + int(b[3:])
    return start <= hm <= end


def in_session(now: dt.datetime) -> bool:
    """是否处于 A 股连续竞价时段（工作日 09:30–11:30 / 13:00–15:00，含边界）。"""
    if now.weekday() >= 5:
        return False
    hm = _hm(now.time())
    return _window(hm, _SESSION_AM) or _window(hm, _SESSION_PM)


def _fnum(value) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def parse_rank_rows(rows: Iterable[dict], board_type: str) -> list[dict]:
    """把东财 clist 行归一成内部结构；坏行丢弃而不是抛异常。

    f12=板块代码、f14=名称、f62=主力净流入（元）、f3=涨跌幅（%）。
    非 BK 代码、缺名称、资金不可解析的行一律跳过；同代码重复时保留首行。
    """
    out: list[dict] = []
    seen: set[str] = set()
    for it in rows or []:
        if not isinstance(it, dict):
            continue
        code = str(it.get("f12") or "").strip()
        name = str(it.get("f14") or "").strip()
        if not code.startswith("BK") or not name or code in seen:
            continue
        flow = _fnum(it.get("f62"))
        if flow is None:
            continue
        pct = _fnum(it.get("f3"))
        seen.add(code)
        out.append({"code": code, "name": name, "flow": flow,
                    "pct": 0.0 if pct is None else pct, "type": board_type})
    return out


def assign_ranks(rows: Iterable[dict], prev: dict[str, int] | None = None) -> list[dict]:
    """按主力净流入降序编号，并带上与上一轮的名次差（正数=名次上升）。

    prev 缺省或某板块上一轮不在榜上时 prev_rank 为 None，前端显示「新」而不是伪造数字。
    """
    prev = prev or {}
    ordered = sorted(rows or [], key=lambda r: (-float(r.get("flow") or 0), str(r.get("code") or "")))
    out = []
    for i, r in enumerate(ordered, start=1):
        item = dict(r)
        item["rank"] = i
        before = prev.get(str(r.get("code")))
        item["prev_rank"] = before if isinstance(before, int) else None
        out.append(item)
    return out


def assign_ranks_by_type(rows: Iterable[dict], prev: dict[str, int] | None = None) -> list[dict]:
    """分类型各自编号（概念与行业互不干扰），再合并返回。"""
    groups: dict[str, list[dict]] = {}
    for r in rows or []:
        groups.setdefault(str(r.get("type") or "concept"), []).append(r)
    out: list[dict] = []
    for key in sorted(groups):
        out.extend(assign_ranks(groups[key], prev))
    return out


def prune_plan(today: dt.date, point_dates: Iterable[str], rank_dates: Iterable[str],
               keep_points: int = KEEP_POINT_DAYS, keep_rank: int = KEEP_RANK_DAYS) -> dict:
    """算出应删除的日期列表（纯函数，只返回计划，不删数据）。

    日期为 `YYYY-MM-DD`；按「今天往前保留 N 个自然日」近似交易日窗口 —— 窗口只是
    防止库无限增长，宽松几天不影响查询正确性。无法解析的日期一律保留（不误删）。
    """

    def stale(dates: Iterable[str], keep: int) -> list[str]:
        out = []
        for d in dates or []:
            try:
                day = dt.date.fromisoformat(str(d))
            except (TypeError, ValueError):
                continue
            if (today - day).days > keep:
                out.append(str(d))
        return sorted(set(out))

    return {"flow_points": stale(point_dates, keep_points),
            "rank_snapshots": stale(rank_dates, keep_rank)}


# --------------------------------------------------------------------------
# 存储层
# --------------------------------------------------------------------------
def _conn() -> sqlite3.Connection:
    os.makedirs(_DATA_DIR, exist_ok=True)
    conn = sqlite3.connect(_DB_FILE, timeout=10)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


@contextmanager
def _db():
    with _LOCK:
        conn = _conn()
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()


def init_db() -> None:
    with _db() as conn:
        conn.executescript(_SCHEMA)


def save_cycle(date: str, hhmm: str, rows: list[dict]) -> int:
    """写入一轮采集：板块元数据 + 排行快照 + 该分钟资金点（全部幂等 upsert）。"""
    if not rows:
        return 0
    ts = f"{date} {hhmm}"
    with _db() as conn:
        conn.executemany(
            "INSERT INTO boards(code,name,type) VALUES(?,?,?) "
            "ON CONFLICT(code) DO UPDATE SET name=excluded.name, type=excluded.type",
            [(r["code"], r["name"], r["type"]) for r in rows])
        conn.executemany(
            "INSERT INTO rank_snapshots(date,code,name,type,flow,pct,rank,prev_rank,ts) "
            "VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(date,code) DO UPDATE SET "
            "name=excluded.name, type=excluded.type, flow=excluded.flow, pct=excluded.pct, "
            "rank=excluded.rank, prev_rank=excluded.prev_rank, ts=excluded.ts",
            [(date, r["code"], r["name"], r["type"], float(r["flow"]), float(r.get("pct") or 0),
              r.get("rank"), r.get("prev_rank"), ts) for r in rows])
        conn.executemany(
            "INSERT INTO flow_points(date,code,time,flow) VALUES(?,?,?,?) "
            "ON CONFLICT(date,code,time) DO UPDATE SET flow=excluded.flow",
            [(date, r["code"], hhmm, float(r["flow"])) for r in rows])
    return len(rows)


def load_prev_ranks(date: str) -> dict[str, int]:
    """上一轮名次（重启后从库恢复，避免第一轮全部显示「新」）。"""
    with _db() as conn:
        cur = conn.execute("SELECT code, rank FROM rank_snapshots WHERE date=? AND rank IS NOT NULL", (date,))
        return {str(c): int(r) for c, r in cur.fetchall()}


def read_rank(date: str, board_type: str | None = None) -> list[dict]:
    sql = ("SELECT code,name,type,flow,pct,rank,prev_rank,ts FROM rank_snapshots WHERE date=?")
    args: list = [date]
    if board_type:
        sql += " AND type=?"
        args.append(board_type)
    sql += " ORDER BY flow DESC"
    with _db() as conn:
        cur = conn.execute(sql, args)
        cols = [c[0] for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def available_dates(limit: int = 60) -> list[str]:
    with _db() as conn:
        cur = conn.execute("SELECT DISTINCT date FROM rank_snapshots ORDER BY date DESC LIMIT ?", (int(limit),))
        return [row[0] for row in cur.fetchall()]


def last_cycle() -> dict | None:
    with _db() as conn:
        cur = conn.execute("SELECT date, MAX(ts) FROM rank_snapshots GROUP BY date ORDER BY date DESC LIMIT 1")
        row = cur.fetchone()
        if not row:
            return None
        date, ts = row
        cnt = conn.execute("SELECT COUNT(*) FROM rank_snapshots WHERE date=?", (date,)).fetchone()[0]
        pts = conn.execute("SELECT COUNT(*) FROM flow_points WHERE date=?", (date,)).fetchone()[0]
        return {"date": date, "last_ts": ts, "boards": int(cnt), "points": int(pts)}


def counts() -> dict:
    with _db() as conn:
        boards = conn.execute("SELECT COUNT(*) FROM boards").fetchone()[0]
        days = conn.execute("SELECT COUNT(DISTINCT date) FROM rank_snapshots").fetchone()[0]
    return {"boards": int(boards), "days": int(days)}


def prune(today: dt.date | None = None) -> dict:
    """按保留窗口清理旧数据，返回删除的行数。"""
    today = today or dt.date.today()
    with _db() as conn:
        p_dates = [r[0] for r in conn.execute("SELECT DISTINCT date FROM flow_points").fetchall()]
        r_dates = [r[0] for r in conn.execute("SELECT DISTINCT date FROM rank_snapshots").fetchall()]
    plan = prune_plan(today, p_dates, r_dates)
    removed = {"flow_points": 0, "rank_snapshots": 0}
    with _db() as conn:
        for table, dates in plan.items():
            for d in dates:
                cur = conn.execute(f"DELETE FROM {table} WHERE date=?", (d,))
                removed[table] += cur.rowcount or 0
    if any(removed.values()):
        log.info("板块库裁剪完成: %s", removed)
    return removed


# --------------------------------------------------------------------------
# 自选板块（JSON，命中 .gitignore 的 data/*.json）
# --------------------------------------------------------------------------
def load_watch() -> list[dict]:
    try:
        with open(_WATCH_FILE, encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as exc:
        log.warning("读取自选板块失败，按空处理: %s", exc)
        return []
    out = []
    for it in raw if isinstance(raw, list) else []:
        code = str((it or {}).get("code") or "").strip()
        if code.startswith("BK"):
            out.append({"code": code, "name": str((it or {}).get("name") or code).strip()})
    return out


def save_watch(items: list[dict]) -> bool:
    tmp = _WATCH_FILE + ".tmp"
    try:
        os.makedirs(_DATA_DIR, exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, indent=2)
        os.replace(tmp, _WATCH_FILE)
        return True
    except OSError as exc:
        log.warning("写入自选板块失败: %s", exc)
        return False
