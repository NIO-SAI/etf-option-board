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
_ETF_WATCH_FILE = os.path.join(_DATA_DIR, "etf_watch.json")
_EM_CONFIG_FILE = os.path.join(_DATA_DIR, "em_flow_config.json")

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
    speed REAL NOT NULL DEFAULT 0,
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
CREATE TABLE IF NOT EXISTS etf_boards (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'sector'
);
CREATE TABLE IF NOT EXISTS etf_rank_snapshots (
    date TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    flow REAL NOT NULL,
    pct REAL NOT NULL DEFAULT 0,
    rank INTEGER,
    ts TEXT,
    PRIMARY KEY (date, code)
);
CREATE TABLE IF NOT EXISTS etf_flow_points (
    date TEXT NOT NULL,
    code TEXT NOT NULL,
    time TEXT NOT NULL,
    main REAL NOT NULL,
    super_ REAL NOT NULL DEFAULT 0,
    large REAL NOT NULL DEFAULT 0,
    medium REAL NOT NULL DEFAULT 0,
    small REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (date, code, time)
);
CREATE INDEX IF NOT EXISTS idx_etf_points_date ON etf_flow_points(date, code, time);
CREATE TABLE IF NOT EXISTS em_flow_points (
    date TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'industry',
    time TEXT NOT NULL,
    inst REAL NOT NULL DEFAULT 0,
    large REAL NOT NULL DEFAULT 0,
    medium REAL NOT NULL DEFAULT 0,
    retail REAL NOT NULL DEFAULT 0,
    pct REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (date, code, time)
);
CREATE INDEX IF NOT EXISTS idx_em_points_date ON em_flow_points(date, code, time);
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

    f12=板块代码、f14=名称、f62=主力净流入（元）、f3=涨跌幅（%）、f22=涨速（%）。
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
        speed = _fnum(it.get("f22"))
        seen.add(code)
        out.append({"code": code, "name": name, "flow": flow,
                    "pct": 0.0 if pct is None else pct,
                    "speed": 0.0 if speed is None else speed,
                    "type": board_type})
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


def _in_auction_time(t: str) -> bool:
    """HH:MM 是否落在连续竞价时段（过滤盘后 15:0x、跨午夜 00:00 之类脏点）。"""
    try:
        hm = int(t[:2]) * 60 + int(t[3:5])
    except (TypeError, ValueError):
        return False
    return _window(hm, _SESSION_AM) or _window(hm, _SESSION_PM)


def build_series(points_by_code: dict[str, list[tuple[str, float]]]) -> dict:
    """把各板块的 (时间, 累计净流入) 点拼成同一条时间轴（前值填充 + 缺失留空）。

    纯函数：入参是已按日期取出的点，不做同日校验以外的任何 I/O。
    某板块在轴上出现前的时点为 None（前端断线而不是画到 0）。
    """
    pts = {code: sorted([(str(t), float(v)) for t, v in (rows or []) if _in_auction_time(str(t))],
                        key=lambda x: x[0])
           for code, rows in (points_by_code or {}).items()}
    axis = sorted({str(t) for rows in pts.values() for t, _ in rows})
    series = []
    for code, rows in pts.items():
        lookup = {str(t): float(v) for t, v in rows}
        vals: list[float | None] = []
        last: float | None = None
        for t in axis:
            if t in lookup:
                last = lookup[t]
            vals.append(last)
        series.append({"code": code, "values": vals, "last": last})
    return {"axis": axis, "series": series}


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


def _migrate(conn: sqlite3.Connection) -> None:
    """老库补列（SQLite 没有 ADD COLUMN IF NOT EXISTS，只能先查 PRAGMA）。"""
    cols = {r[1] for r in conn.execute("PRAGMA table_info(rank_snapshots)").fetchall()}
    if "speed" not in cols:
        conn.execute("ALTER TABLE rank_snapshots ADD COLUMN speed REAL NOT NULL DEFAULT 0")
    cols = {r[1] for r in conn.execute("PRAGMA table_info(em_flow_points)").fetchall()}
    if "pct" not in cols:
        conn.execute("ALTER TABLE em_flow_points ADD COLUMN pct REAL NOT NULL DEFAULT 0")


def init_db() -> None:
    with _db() as conn:
        conn.executescript(_SCHEMA)
        _migrate(conn)


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
            "INSERT INTO rank_snapshots(date,code,name,type,flow,pct,rank,prev_rank,speed,ts) "
            "VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(date,code) DO UPDATE SET "
            "name=excluded.name, type=excluded.type, flow=excluded.flow, pct=excluded.pct, "
            "rank=excluded.rank, prev_rank=excluded.prev_rank, speed=excluded.speed, ts=excluded.ts",
            [(date, r["code"], r["name"], r["type"], float(r["flow"]), float(r.get("pct") or 0),
              r.get("rank"), r.get("prev_rank"), float(r.get("speed") or 0), ts) for r in rows])
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
    sql = ("SELECT code,name,type,flow,pct,rank,prev_rank,speed,ts FROM rank_snapshots WHERE date=?")
    args: list = [date]
    if board_type:
        sql += " AND type=?"
        args.append(board_type)
    sql += " ORDER BY flow DESC"
    with _db() as conn:
        cur = conn.execute(sql, args)
        cols = [c[0] for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def read_points(date: str, codes: list[str]) -> dict[str, list[tuple[str, float]]]:
    """按日期 + 板块代码取资金分时点；空入参直接返回空。"""
    codes = [c for c in (codes or []) if c]
    if not codes:
        return {}
    marks = ",".join("?" for _ in codes)
    with _db() as conn:
        cur = conn.execute(
            f"SELECT code, time, flow FROM flow_points WHERE date=? AND code IN ({marks}) ORDER BY time",
            [date, *codes])
        out: dict[str, list[tuple[str, float]]] = {c: [] for c in codes}
        for code, t, flow in cur.fetchall():
            out.setdefault(str(code), []).append((str(t), float(flow)))
    return out


_DATE_TABLES = {"board": "rank_snapshots", "etf": "etf_rank_snapshots", "em": "em_flow_points"}


def available_dates(limit: int = 60, table: str = "board") -> list[str]:
    """有数据的日期（table: board / etf / em）。表名走白名单，不接受外部任意值。"""
    name = _DATE_TABLES.get(table, "rank_snapshots")
    with _db() as conn:
        cur = conn.execute(f"SELECT DISTINCT date FROM {name} ORDER BY date DESC LIMIT ?", (int(limit),))
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
        etf_p = [r[0] for r in conn.execute("SELECT DISTINCT date FROM etf_flow_points").fetchall()]
        etf_r = [r[0] for r in conn.execute("SELECT DISTINCT date FROM etf_rank_snapshots").fetchall()]
        em_p = [r[0] for r in conn.execute("SELECT DISTINCT date FROM em_flow_points").fetchall()]
    plan = prune_plan(today, p_dates, r_dates)
    # ETF / 4 维 与板块同口径：分时 30 天、排行 120 天
    plan["etf_flow_points"] = prune_plan(today, etf_p, etf_p)["flow_points"]
    plan["em_flow_points"] = prune_plan(today, em_p, em_p)["flow_points"]
    plan["etf_rank_snapshots"] = prune_plan(today, etf_r, etf_r)["rank_snapshots"]
    removed = {"flow_points": 0, "rank_snapshots": 0, "etf_flow_points": 0,
               "etf_rank_snapshots": 0, "em_flow_points": 0}
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
def _is_index_code(code: str) -> bool:
    """指数 / 全 A 的 secid（1.000300、47.800000）。"""
    head, _, tail = str(code or "").partition(".")
    return head.isdigit() and tail.isdigit()


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
        # 板块 BKxxxx 与指数 secid（1.000300 / 47.800000）都允许进自定义
        if code.upper().startswith("BK") or _is_index_code(code):
            out.append({"code": code, "name": str((it or {}).get("name") or code).strip()})
    return out


def update_watch(add: dict | None = None, remove: str | None = None) -> tuple[list[dict], bool]:
    """一次性完成「读—改—写」（加锁 + 原子替换），返回 (列表, 是否写盘成功)。"""
    with _LOCK:
        items = load_watch()
        if remove:
            items = [it for it in items if it["code"] != remove]
        if add and add.get("code"):
            code = str(add["code"])
            if not any(it["code"] == code for it in items):
                items.append({"code": code, "name": str(add.get("name") or code)})
        ok = save_watch(items)
        return items, ok


def save_watch(items: list[dict]) -> bool:
    # 唯一临时名：多进程/并发写不会互相覆盖半截文件
    tmp = f"{_WATCH_FILE}.{os.getpid()}.{threading.get_ident()}.tmp"
    try:
        os.makedirs(_DATA_DIR, exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(items, f, ensure_ascii=False, indent=2)
        os.replace(tmp, _WATCH_FILE)
        return True
    except OSError as exc:
        log.warning("写入自选板块失败: %s", exc)
        return False


def read_history(code: str, days: int = 20) -> list[dict]:
    """某板块近 N 个交易日的资金流（来自每日最后一轮排行快照）。"""
    with _db() as conn:
        cur = conn.execute(
            "SELECT date, flow, pct, rank FROM rank_snapshots WHERE code=? ORDER BY date DESC LIMIT ?",
            (code, max(1, int(days))))
        rows = [{"date": d, "flow": float(f), "pct": float(p or 0), "rank": r}
                for d, f, p, r in cur.fetchall()]
    return list(reversed(rows))


def align_against(axis: list[str], mapping: dict[str, float]) -> list[float | None]:
    """把另一条序列（时间→值）对齐到给定时间轴，缺失点补 None。纯函数。"""
    return [mapping.get(t) for t in (axis or [])]


def read_rank_range(start: str, end: str, board_type: str | None = None) -> list[dict]:
    """区间内每个交易日的排行快照（一日一行/板块）。"""
    sql = ("SELECT date, code, name, type, flow, pct FROM rank_snapshots "
           "WHERE date BETWEEN ? AND ?")
    args: list = [start, end]
    if board_type:
        sql += " AND type=?"
        args.append(board_type)
    sql += " ORDER BY date, code"
    with _db() as conn:
        cur = conn.execute(sql, args)
        cols = [c[0] for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def aggregate_daily(rows: Iterable[dict], dates: list[str]) -> list[dict]:
    """把区间快照按板块聚合成「区间累计 + 每日序列」（缺失日留 None）。纯函数。

    金额口径：每个交易日的资金流是**当日净流入**，区间累计 = 各日相加（不是末值相减）。
    """
    dates = list(dates or [])
    idx = {d: i for i, d in enumerate(dates)}
    acc: dict[str, dict] = {}
    for r in rows or []:
        code = str(r.get("code") or "")
        if not code:
            continue
        item = acc.get(code)
        if item is None:
            item = acc[code] = {"code": code, "name": r.get("name") or code,
                                "type": r.get("type"), "total": 0.0, "days": 0,
                                "values": [None] * len(dates)}
        flow = r.get("flow")
        try:
            flow = float(flow)
        except (TypeError, ValueError):
            continue
        item["total"] += flow
        item["days"] += 1
        i = idx.get(str(r.get("date")))
        if i is not None:
            item["values"][i] = flow
    return sorted(acc.values(), key=lambda x: (-x["total"], x["code"]))


# --------------------------------------------------------------------------
# ETF 资金流：口径分类 + 存储（与板块共用同一个 SQLite，仍由采集器单写）
# --------------------------------------------------------------------------
_ETF_EXCLUDE = ("债", "货币", "现金", "短融", "添益", "日利", "快线", "国债", "政金",
                "恒生", "港股", "纳指", "标普", "日经", "中概", "跨境", "黄金", "原油",
                "商品", "REIT", "证金", "标普", "美国", "德国", "法国", "亚太")
_ETF_BROAD = ("沪深300", "上证50", "中证500", "中证1000", "中证2000", "中证A500", "中证A50",
              "中证800", "中证100", "创业板", "科创50", "科创板50", "科创100", "上证180",
              "深证100", "双创", "北证50", "上证综指", "中证全指")
_ETF_SECTOR = ("半导体", "芯片", "医药", "医疗", "生物", "证券", "银行", "保险", "军工", "国防",
               "新能源", "光伏", "电池", "锂", "汽车", "有色", "稀土", "煤炭", "钢铁", "化工",
               "消费", "食品", "酒", "家电", "地产", "农业", "养殖", "传媒", "游戏", "通信",
               "计算机", "软件", "人工智能", "机器人", "电子", "电力", "环保", "基建", "旅游",
               "教育", "科技", "信息", "机械", "建材", "运输", "物流", "零售", "纺织")


def classify_etf(name: str) -> str | None:
    """ETF 口径分类：broad（宽基）/ sector（行业）/ None（不采）。

    纯函数、按关键词判定；跨境与固收类一律排除（与看板的「境内股票 ETF」定位一致）。
    """
    n = str(name or "")
    if not n or any(k in n for k in _ETF_EXCLUDE):
        return None
    if any(k in n for k in _ETF_BROAD):
        return "broad"
    if any(k in n for k in _ETF_SECTOR):
        return "sector"
    return None


def select_etf_universe(rows: Iterable[dict], core_codes: Iterable[str] = (),
                        broad_n: int = 30, sector_n: int = 30) -> list[dict]:
    """从「按成交额降序」的 ETF 列表里挑采集范围：必采核心 + 宽基 Top N + 行业 Top N。

    返回 [{code, secid, name, type, amount}]；核心标的即使不在 Top 里也一定保留。
    """
    cores = {str(c) for c in core_codes or ()}
    out: list[dict] = []
    seen: set[str] = set()
    broad = sector = 0
    for r in rows or []:
        code = str(r.get("code") or "")
        name = str(r.get("name") or "")
        secid = str(r.get("secid") or "")
        if not code or not name or not secid or code in seen:
            continue
        kind = classify_etf(name)
        take = code in cores
        if not take and kind == "broad" and broad < broad_n:
            take, broad = True, broad + 1
        elif not take and kind == "sector" and sector < sector_n:
            take, sector = True, sector + 1
        if not take:
            continue
        seen.add(code)
        out.append({"code": code, "secid": secid, "name": name,
                    "type": kind or ("broad" if code in cores else "sector"),
                    "amount": float(r.get("amount") or 0)})
    # 核心标的若没出现在列表里（接口没翻到），由调用方另行补齐
    return out


def parse_etf_quote(code: str, data: dict | None) -> dict | None:
    """把 getZJLXData 的快照归一成内部结构；缺主字段直接丢弃（避免写入全 0 假数据）。"""
    if not isinstance(data, dict):
        return None
    def num(key):
        v = data.get(key)
        if isinstance(v, bool) or v in (None, "", "-"):
            return 0.0
        try:
            return float(v)
        except (TypeError, ValueError):
            return 0.0
    if data.get("f137") in (None, "", "-"):
        return None
    return {"code": code, "name": str(data.get("f58") or code),
            "flow": num("f137"), "pct": num("f170"),
            "super": num("f140"), "large": num("f143"),
            "medium": num("f146"), "small": num("f149")}


def save_etf_cycle(date: str, hhmm: str, rows: list[dict]) -> int:
    """写入一轮 ETF 资金流（幂等 upsert）。"""
    if not rows:
        return 0
    ts = f"{date} {hhmm}"
    ranked = sorted(rows, key=lambda r: -float(r.get("flow") or 0))
    with _db() as conn:
        conn.executemany(
            "INSERT INTO etf_boards(code,name,type) VALUES(?,?,?) "
            "ON CONFLICT(code) DO UPDATE SET name=excluded.name, type=excluded.type",
            [(r["code"], r["name"], r["type"]) for r in ranked])
        conn.executemany(
            "INSERT INTO etf_rank_snapshots(date,code,name,type,flow,pct,rank,ts) "
            "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(date,code) DO UPDATE SET "
            "name=excluded.name, type=excluded.type, flow=excluded.flow, "
            "pct=excluded.pct, rank=excluded.rank, ts=excluded.ts",
            [(date, r["code"], r["name"], r["type"], float(r["flow"]), float(r["pct"]),
              i, ts) for i, r in enumerate(ranked, start=1)])
        conn.executemany(
            "INSERT INTO etf_flow_points(date,code,time,main,super_,large,medium,small) "
            "VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(date,code,time) DO UPDATE SET "
            "main=excluded.main, super_=excluded.super_, large=excluded.large, "
            "medium=excluded.medium, small=excluded.small",
            [(date, r["code"], hhmm, float(r["flow"]), float(r.get("super") or 0),
              float(r.get("large") or 0), float(r.get("medium") or 0),
              float(r.get("small") or 0)) for r in ranked])
    return len(ranked)


def read_etf_rank(date: str) -> list[dict]:
    with _db() as conn:
        cur = conn.execute(
            "SELECT code,name,type,flow,pct,rank,ts FROM etf_rank_snapshots WHERE date=? ORDER BY flow DESC",
            (date,))
        cols = [c[0] for c in cur.description]
        return [dict(zip(cols, row)) for row in cur.fetchall()]


def read_etf_points(date: str, codes: list[str]) -> dict[str, list[tuple[str, float, dict]]]:
    """取 ETF 资金分时点：{code: [(time, main, 四维dict)]}。"""
    codes = [c for c in (codes or []) if c]
    if not codes:
        return {}
    marks = ",".join("?" for _ in codes)
    with _db() as conn:
        cur = conn.execute(
            f"SELECT code,time,main,super_,large,medium,small FROM etf_flow_points "
            f"WHERE date=? AND code IN ({marks}) ORDER BY time", [date, *codes])
        out: dict[str, list] = {c: [] for c in codes}
        for code, t, main, sup, large, medium, small in cur.fetchall():
            out.setdefault(str(code), []).append(
                (str(t), float(main), {"super": float(sup), "large": float(large),
                                       "medium": float(medium), "small": float(small)}))
    return out


# --------------------------------------------------------------------------
# ETF 自选
# --------------------------------------------------------------------------
def load_etf_watch() -> list[dict]:
    try:
        with open(_ETF_WATCH_FILE, encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as exc:
        log.warning("读取自选 ETF 失败，按空处理: %s", exc)
        return []
    out = []
    for it in raw if isinstance(raw, list) else []:
        code = str((it or {}).get("code") or "").strip()
        if code.isdigit() and len(code) == 6:
            out.append({"code": code, "name": str((it or {}).get("name") or code).strip()})
    return out


def update_etf_watch(add: dict | None = None, remove: str | None = None) -> tuple[list[dict], bool]:
    with _LOCK:
        items = load_etf_watch()
        if remove:
            items = [it for it in items if it["code"] != remove]
        if add and add.get("code"):
            code = str(add["code"])
            if not any(it["code"] == code for it in items):
                items.append({"code": code, "name": str(add.get("name") or code)})
        tmp = f"{_ETF_WATCH_FILE}.{os.getpid()}.{threading.get_ident()}.tmp"
        ok = True
        try:
            os.makedirs(_DATA_DIR, exist_ok=True)
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(items, f, ensure_ascii=False, indent=2)
            os.replace(tmp, _ETF_WATCH_FILE)
        except OSError as exc:
            ok = False
            log.warning("写入自选 ETF 失败: %s", exc)
        return items, ok


# --------------------------------------------------------------------------
# 东财 4 维资金（机构/大单/中户/散户）：指数 + 行业 + 全 A
# --------------------------------------------------------------------------
EM_DEFAULT_INDUSTRIES = 40

EM_MARKET_CODE = "47.800000"
EM_MARKET_NAME = "东方财富全A"


def parse_em_flow(code: str, kind: str, data: dict | None,
                  name: str = "") -> dict | None:
    """归一东财 4 维快照：f140 机构(超大单)、f143 大单、f146 中户、f149 散户。

    主字段缺失时返回 None（不写全 0 假数据）。
    """
    if not isinstance(data, dict) or data.get("f140") in (None, "", "-"):
        return None

    def num(key):
        v = data.get(key)
        if isinstance(v, bool) or v in (None, "", "-"):
            return 0.0
        try:
            return float(v)
        except (TypeError, ValueError):
            return 0.0

    return {"code": code, "kind": kind, "name": str(data.get("f58") or name or code),
            "inst": num("f140"), "large": num("f143"),
            "medium": num("f146"), "retail": num("f149"),
            "pct": num("f170")}


def save_em_cycle(date: str, hhmm: str, rows: list[dict]) -> int:
    if not rows:
        return 0
    with _db() as conn:
        conn.executemany(
            "INSERT INTO em_flow_points(date,code,name,kind,time,inst,large,medium,retail,pct) "
            "VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(date,code,time) DO UPDATE SET "
            "name=excluded.name, kind=excluded.kind, inst=excluded.inst, "
            "large=excluded.large, medium=excluded.medium, retail=excluded.retail, pct=excluded.pct",
            [(date, r["code"], r["name"], r["kind"], hhmm,
              float(r["inst"]), float(r["large"]), float(r["medium"]), float(r["retail"]),
              float(r.get("pct") or 0))
             for r in rows])
    return len(rows)


def read_em_points(date: str, code: str) -> list[tuple[str, float, float, float, float]]:
    with _db() as conn:
        cur = conn.execute(
            "SELECT time,inst,large,medium,retail FROM em_flow_points "
            "WHERE date=? AND code=? ORDER BY time", (date, code))
        return [(str(t), float(a), float(b), float(c), float(d)) for t, a, b, c, d in cur.fetchall()]


def latest_em_flows(date: str) -> list[dict]:
    """每个目标在当日最后一刻的 4 维快照（指数/全A 排行用）。"""
    with _db() as conn:
        cur = conn.execute(
            "SELECT p.code, p.name, p.kind, p.inst, p.large, p.medium, p.retail, p.pct "
            "FROM em_flow_points p JOIN ("
            "  SELECT code, MAX(time) AS t FROM em_flow_points WHERE date=? GROUP BY code"
            ") m ON p.code=m.code AND p.time=m.t"
            " WHERE p.date=?", (date, date))
        return [{"code": c, "name": n, "kind": k, "inst": float(i), "large": float(l),
                 "medium": float(md), "retail": float(r), "pct": float(pc or 0)}
                for c, n, k, i, l, md, r, pc in cur.fetchall()]


def read_em_meta(date: str, code: str) -> dict:
    """4 维目标的名称与口径（供详情标题用）。"""
    with _db() as conn:
        row = conn.execute(
            "SELECT name, kind FROM em_flow_points WHERE date=? AND code=? LIMIT 1",
            (date, code)).fetchone()
    return {"name": row[0], "kind": row[1]} if row else {}


def pick_em_industries(rank: list[dict], limit: int = EM_DEFAULT_INDUSTRIES) -> list[dict]:
    """按 |主力净流入| 取前 N 个行业作为 4 维采集/展示目标（纯函数）。"""
    rows = [r for r in rank or [] if str(r.get("code", "")).startswith("BK")]
    rows.sort(key=lambda r: -abs(float(r.get("flow") or 0)))
    return [{"code": r["code"], "name": r.get("name") or r["code"]} for r in rows[:max(1, limit)]]


def load_em_config() -> dict:
    """行业展示配置：{customized: bool, codes: [{code,name}]}；文件缺失即默认。"""
    try:
        with open(_EM_CONFIG_FILE, encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        return {"customized": False, "items": []}
    except (OSError, ValueError) as exc:
        log.warning("读取 4 维行业配置失败，按默认处理: %s", exc)
        return {"customized": False, "items": []}
    items = []
    for it in (raw or {}).get("items") or []:
        code = str((it or {}).get("code") or "").strip()
        if code.startswith("BK"):
            items.append({"code": code, "name": str((it or {}).get("name") or code)})
    return {"customized": bool((raw or {}).get("customized")), "items": items}


def save_em_config(config: dict) -> bool:
    tmp = f"{_EM_CONFIG_FILE}.{os.getpid()}.{threading.get_ident()}.tmp"
    try:
        os.makedirs(_DATA_DIR, exist_ok=True)
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(config, f, ensure_ascii=False, indent=2)
        os.replace(tmp, _EM_CONFIG_FILE)
        return True
    except OSError as exc:
        log.warning("写入 4 维行业配置失败: %s", exc)
        return False
