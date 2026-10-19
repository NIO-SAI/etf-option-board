"""东方财富行情接口客户端（异步 httpx，直连 + curl 兜底 + 短 TTL 缓存）。

所有请求手拼 query（safe=",:"），否则 fs=m:10+t:10 等会被编码成 %3A 而返回空数据。
"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import logging
import os
import time
from urllib.parse import urlencode

import httpx

from config import settings

log = logging.getLogger("em")

_UA = settings.user_agent
_UT = settings.em_token
_REFERER = "https://quote.eastmoney.com/"

# H5 快照主源：emdatah5 直连稳定（push2 被代理/限流时仍可用）。
#   getZJLXData  = push2 stock/get 等价（个股/指数/外围/期权行情 + 资金流）
#   getZDYLBData = push2 clist 等价（列表：期权链/板块/成分股）
_H5_URL = "https://emdatah5.eastmoney.com/dc/ZJLX"
_H5_UT = "fa5fd1943c7b386f172d6893dbfba10b"
_H5_REF = "https://data.eastmoney.com/"
# 腾讯行情：K 线/分时兜底（push2his / push2 trends 不可用时）
# 注意：一律用 ifzq.gtimg.cn（不带 web. 前缀）。web.ifzq.gtimg.cn 会触发腾讯 WAF，
# 间歇性返回 JS 挑战页 → json 解析失败 → 回落 push2（多为空），造成"没数据/旧数据"。
_TX_DAY = "https://ifzq.gtimg.cn/appstock/app/fqkline/get"
_TX_MIN = "https://ifzq.gtimg.cn/appstock/app/kline/mkline"
_TX_TREND = "https://ifzq.gtimg.cn/appstock/app/minute/query"


_CLIENT: httpx.AsyncClient | None = None
_CACHE: dict[str, tuple[float, float, object]] = {}
# 传输路径记忆：(host|path) -> (mode, ts)；mode: "direct" | "curl"
_MEMO: dict[str, tuple[str, float]] = {}
_MEMO_TTL = 300
# 死主机熔断：push2/push2his 的行情类端点已确认"对普通 GET 一律空回包"（curl、真实
# Chrome、国内 5G 关闭代理均为 0 字节），但它们在兜底路径上会被反复尝试，每次白等
# connect 超时（实测 /api/option/trends 因此要 2.8s）。这里按主机记一次失败，60s 内
# 直接跳过；到期自动重试，上游若恢复即刻生效。
_PUSH2_DEAD: dict[str, float] = {}
_PUSH2_DEAD_TTL = 60.0


def _push2_dead(host: str) -> bool:
    return time.time() < _PUSH2_DEAD.get(host, 0.0)


def _push2_mark_dead(host: str) -> None:
    _PUSH2_DEAD[host] = time.time() + _PUSH2_DEAD_TTL
    log.info("em push2 兜底主机 %s 空回包，%ds 内跳过", host, int(_PUSH2_DEAD_TTL))
# 东财/腾讯抖动重试：重试会放大请求量（触发反爬），配合"过期缓存兜底"改为 2 轮
_RETRY_TRIES = 2
_RETRY_DELAY = 0.3
# 全局并发闸：东财对同 IP 并发突发很敏感；主源已切 H5/腾讯，放宽到 8 提升吞吐
_SEM = asyncio.Semaphore(8)


def _client() -> httpx.AsyncClient:
    global _CLIENT
    if _CLIENT is None:
        _CLIENT = httpx.AsyncClient(
            timeout=httpx.Timeout(settings.http_timeout, connect=2.5),
            headers={"User-Agent": _UA, "Referer": _REFERER},
            limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
        )
    return _CLIENT


async def close() -> None:
    global _CLIENT
    if _CLIENT is not None:
        await _CLIENT.aclose()
        _CLIENT = None


def _build(url: str, params: dict) -> str:
    if not params:
        return url
    return f"{url}?{urlencode(params, safe=',:+')}"


async def _curl_json(url: str, params: dict | None = None,
                     referer: str | None = None) -> object:
    p = dict(params or {})
    p["_"] = int(time.time() * 1000)
    full = _build(url, p)
    proc = await asyncio.create_subprocess_exec(
        "curl", "-s", "-m", "8", "-A", _UA, "-e", referer or _REFERER,
        "-H", "Accept: application/json, text/plain, */*",
        full,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    out, _ = await proc.communicate()
    return json.loads(out.decode("utf-8", "replace"))


async def get_json(url: str, params: dict | None = None, ttl: float = 3.0,
                   force: bool = False, referer: str | None = None,
                   tries: int | None = None) -> object | None:
    """带缓存与传输兜底的 GET JSON。失败返回 None（绝不抛给上层）。

    tries 可覆盖重试轮数（默认 _RETRY_TRIES）；对"已确定死掉且非关键"的兜底主机
    传 tries=1 以快速失败。
    """
    params = params or {}
    key = _build(url, params)
    now = time.time()
    if not force:
        hit = _CACHE.get(key)
        if hit and now - hit[0] < hit[1]:
            return hit[2]

    n_tries = _RETRY_TRIES if tries is None else max(1, tries)
    hostkey = url.split("//", 1)[-1].split("/", 1)[0]
    memo = _MEMO.get(hostkey)
    prefer = memo[0] if memo and now - memo[1] < _MEMO_TTL else None

    async def _direct():
        r = await _client().get(_build(url, params),
                                headers={"Referer": referer} if referer else None)
        r.raise_for_status()
        return r.json()

    async def _curl():
        return await _curl_json(url, params, referer)

    transports = [("curl", _curl), ("direct", _direct)]
    if prefer != "curl":
        transports.reverse()

    data = None
    used = None
    # 东财限流：单次成功率约 30~50%，失败即重试（direct 被 WAF 拒绝时很快失败）
    for attempt in range(n_tries):
        for name, fn in transports:
            try:
                async with _SEM:
                    data = await fn()
            except Exception as exc:  # noqa: BLE001
                log.debug("em fetch %s via %s 失败: %s", hostkey, name, exc)
                data = None
            if data is not None:
                used = name
                break
        if data is not None:
            break
        if attempt < n_tries - 1:
            await asyncio.sleep(_RETRY_DELAY)

    if data is None:
        # 全部尝试失败 → 退回上次成功值（忽略 TTL），避免上游瞬时抖动导致页面缺数据
        stale = _CACHE.get(key)
        if stale and stale[2] is not None:
            log.debug("em 使用过期缓存 url=%s", key)
            return stale[2]
        return None
    _MEMO[hostkey] = (used, now)

    if isinstance(data, dict) and data.get("rc") not in (None, 0):
        log.debug("em rc=%s url=%s", data.get("rc"), key)

    _CACHE[key] = (now, ttl, data)
    return data


def _fields1():
    return "f1,f2,f3,f4,f5,f6"


def _fields2():
    return "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61"


# --------------------------------------------------------------------------
# 行情（主源 emdatah5，兜底 push2）
# --------------------------------------------------------------------------
async def clist(fs: str, fields: str, pn: int = 1, pz: int = 100, fid: str = "f12",
                po: int = 1, ttl: float = 15.0) -> list[dict]:
    # 主源：emdatah5 getZDYLBData（与 push2 clist 同参同构，稳定直连）
    d = await get_json(f"{_H5_URL}/getZDYLBData",
                       {"fields": fields, "pn": pn, "pz": pz, "fid": fid,
                        "po": po, "fs": fs, "ut": _H5_UT},
                       ttl=ttl, referer=_H5_REF)
    data = (d or {}).get("data") if isinstance(d, dict) else None
    if data and data.get("diff"):
        return data["diff"]
    # 兜底：push2 clist
    d = await get_json("https://push2.eastmoney.com/api/qt/clist/get",
                       {"pn": pn, "pz": pz, "po": po, "np": 1, "fltt": 2, "invt": 2,
                        "fid": fid, "fs": fs, "fields": fields, "ut": _UT}, ttl=ttl)
    if not d or not d.get("data"):
        return []
    return d["data"].get("diff") or []


async def clist_all(fs: str, fields: str, pz: int = 100, max_page: int = 8,
                    ttl: float = 20.0) -> list[dict]:
    out: list[dict] = []
    for pn in range(1, max_page + 1):
        rows = await clist(fs, fields, pn=pn, pz=pz, ttl=ttl)
        if not rows:
            break
        out.extend(rows)
        if len(rows) < pz:
            break
    return out


async def stock_get(secid: str, fields: str, ttl: float = 12.0) -> dict | None:
    # 主源：emdatah5 getZJLXData（个股/指数/外围/期权行情）
    d = await get_json(f"{_H5_URL}/getZJLXData",
                       {"secid": secid, "fields": fields, "ut": _H5_UT},
                       ttl=ttl, referer=_H5_REF)
    data = (d or {}).get("data") if isinstance(d, dict) else None
    if data:
        return data
    # 兜底：push2 stock/get
    d = await get_json("https://push2.eastmoney.com/api/qt/stock/get",
                       {"secid": secid, "fltt": 2, "invt": 2, "fields": fields, "ut": _UT}, ttl=ttl)
    if not d or not d.get("data"):
        return None
    return d["data"]


def _tx_code(secid: str) -> str | None:
    """东财 secid -> 腾讯行情代码（沪 1./深 0.）；期权(10./12.)与外围(100.)不支持。"""
    mk, _, code = secid.partition(".")
    if mk == "1":
        return "sh" + code
    if mk == "0":
        return "sz" + code
    return None


def _numf(v, default: float = 0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


async def _tx_kline(secid: str, klt: int, lmt: int, ttl: float) -> list[dict]:
    code = _tx_code(secid)
    if not code:
        return []
    if klt >= 100:  # 日/周/月线
        period = {101: "day", 102: "week", 103: "month"}.get(klt, "day")
        d = await get_json(_TX_DAY, {"param": f"{code},{period},,,{lmt},qfq"}, ttl=ttl)
        node = ((d or {}).get("data") or {}).get(code) or {}
        rows = node.get(f"qfq{period}") or node.get(period) or []
        # row: [date, open, close, high, low, volume, ...]
        return [{"date": r[0], "open": _numf(r[1]), "close": _numf(r[2]),
                 "high": _numf(r[3]), "low": _numf(r[4]),
                 "volume": _numf(r[5]), "amount": 0.0, "pct": None}
                for r in rows if len(r) >= 6]
    m = {3: "m1", 5: "m5", 15: "m15", 30: "m30", 60: "m60"}.get(klt, "m1")
    d = await get_json(_TX_MIN, {"param": f"{code},{m},,{lmt}"}, ttl=ttl)
    node = ((d or {}).get("data") or {}).get(code) or {}
    out = []
    for r in node.get(m) or []:
        # row: [datetime, open, close, high, low, volume, {}, amount]
        if len(r) < 6:
            continue
        t = str(r[0])
        if len(t) == 12:  # "202610141102" -> "2026-10-14 11:02"
            t = f"{t[0:4]}-{t[4:6]}-{t[6:8]} {t[8:10]}:{t[10:12]}"
        out.append({"date": t, "open": _numf(r[1]), "close": _numf(r[2]),
                    "high": _numf(r[3]), "low": _numf(r[4]),
                    "volume": _numf(r[5]), "amount": 0.0, "pct": None})
    return out


async def kline(secid: str, klt: int = 1, lmt: int = 240, fqt: int = 1,
                ttl: float = 45.0) -> list[dict]:
    """历史 K 线（归一化 bars）。腾讯优先（稳定），push2his 兜底（期权只剩这条路）。"""
    bars = await _tx_kline(secid, klt, lmt, ttl)
    if bars:
        return bars
    if _push2_dead("push2his.eastmoney.com"):
        return []
    d = await get_json("https://push2his.eastmoney.com/api/qt/stock/kline/get",
                       {"secid": secid, "fields1": _fields1(), "fields2": _fields2(),
                        "klt": klt, "fqt": fqt, "end": "20500101", "lmt": lmt, "ut": _UT},
                       ttl=ttl, tries=1)
    if d is None:
        _push2_mark_dead("push2his.eastmoney.com")
        return []
    return parse_klines(d.get("data"))


def _trends_trim(out: list[dict], ndays: int) -> list[dict]:
    """分时清洗：单日视图只保留最后一个交易日；盘中若拿到的是旧日数据则丢弃。

    典型故障：腾讯/push2 拉取失败 → get_json 回退"上次成功缓存"（可能是上一交易日的
    全天分时）→ 若用墙上时钟重新贴日期，就会把整日旧数据渲染成"今天"，图上出现一条
    延伸到收盘时间的错线。这里以数据源自身日期为准做校验。

    另统一裁掉非连续竞价时段（09:30–11:30 / 13:00–15:00）的点：腾讯分时在收盘后
    仍返回 15:06–15:30 的盘后成交/残余快照，而资金流只到 15:00；两套轴不一致会让
    叠加柱状图尾部整段空洞。
    """
    out = [p for p in (out or []) if _hm_in_session((p.get("time") or "")[-5:])]
    if not out or ndays > 1:
        return out
    last_day = (out[-1].get("time") or "")[:10]
    if _now_in_session() and last_day != time.strftime("%Y-%m-%d"):
        return []                      # 盘中却拿到非今日数据 → 宁可空，不误导
    return [p for p in out if (p.get("time") or "")[:10] == last_day]


async def trends(secid: str, ndays: int = 1, ttl: float = 30.0) -> list[dict]:
    """分时（归一化）。腾讯优先（稳定），push2 trends2 兜底。

    时间戳取自数据源本身（腾讯 node.data.date / push2 行首），不再用"今天"重贴。
    """
    code = _tx_code(secid)
    if code:
        d = await get_json(_TX_TREND, {"code": code}, ttl=ttl)
        node = ((d or {}).get("data") or {}).get(code) or {}
        tdata = node.get("data") or {}
        raw = tdata.get("data") or []
        day = str(tdata.get("date") or "")          # "20261015"
        day_fmt = (f"{day[0:4]}-{day[4:6]}-{day[6:8]}"
                   if len(day) == 8 else time.strftime("%Y-%m-%d"))
        out = []
        for line in raw:
            p = line.split()
            if len(p) < 2:
                continue
            t = p[0]
            hhmm = f"{t[0:2]}:{t[2:4]}" if len(t) == 4 else t
            out.append({"time": f"{day_fmt} {hhmm}", "price": _numf(p[1]),
                        "high": _numf(p[1]), "low": _numf(p[1]),
                        "volume": _numf(p[2]), "amount": _numf(p[3]), "avg": None})
        out = _trends_trim(out, ndays)
        if out:
            return out
    if _push2_dead("push2.eastmoney.com"):
        return []
    d = await get_json("https://push2.eastmoney.com/api/qt/stock/trends2/get",
                       {"secid": secid, "fields1": "f1,f2,f3,f4,f5,f6,f7,f8",
                        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58", "iscr": 0,
                        "ndays": ndays, "ut": _UT}, ttl=ttl, tries=1)
    if d is None:
        _push2_mark_dead("push2.eastmoney.com")
        return []
    return _trends_trim(parse_trends(d.get("data")), ndays)


# 资金流快照累积：交易时段内每次调用都用 emdatah5 快照累积一分钟点（内存+磁盘），
# push2 fflow 不可用/收盘后返回空 klines 时，用本地累积序列兜底，保证分时资金流
# 图表在收盘后、进程重启后仍可画出当日完整序列（复盘用）。
# 另保留最近一个有数据的昨日序列：9:15 开盘前当日无数据时展示昨日，界面不空。
_FLOW_HIST: dict[str, list[str]] = {}   # 当日累积
_FLOW_PREV: dict[str, list[str]] = {}   # 最近一个有数据的昨日
_FLOW_DAY: str | None = None            # _FLOW_HIST 对应的日期
_FLOW_MAX = 240
_FLOW_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data", "flow_history.jsonl")
_FLOW_LOADED = False
_FLOW_FLUSHED: dict[str, str] = {}  # secid -> 已落盘的最后分钟 "YYYY-MM-DD HH:MM"


def _flow_load() -> None:
    """进程首次使用时从磁盘恢复（幂等）：当日 → _FLOW_HIST，最近一个有数据的
    昨日 → _FLOW_PREV（9:15 前展示用）；磁盘只保留近 7 天的行。"""
    global _FLOW_LOADED, _FLOW_DAY
    if _FLOW_LOADED:
        return
    _FLOW_LOADED = True
    today = time.strftime("%Y-%m-%d")
    _FLOW_DAY = today
    if not os.path.exists(_FLOW_PATH):
        return

    def _feed(bucket: dict[str, list[str]], secid: str, fline: str) -> None:
        hist = bucket.setdefault(secid, [])
        minute = fline.split(",", 1)[0]
        if hist and hist[-1].split(",", 1)[0] == minute:
            hist[-1] = fline
        else:
            hist.append(fline)
            if len(hist) > _FLOW_MAX:
                del hist[:len(hist) - _FLOW_MAX]

    try:
        by_day: dict[str, list[tuple[str, str]]] = {}
        kept: list[str] = []
        cutoff = (dt.datetime.now() - dt.timedelta(days=7)).strftime("%Y-%m-%d")
        with open(_FLOW_PATH, encoding="utf-8") as f:
            for raw in f:
                line = raw.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                d = r.get("date")
                if not d or d < cutoff or d > today:
                    continue
                kept.append(line)
                secid, fline = r.get("secid"), r.get("line")
                if secid and fline:
                    by_day.setdefault(d, []).append((secid, fline))
        with open(_FLOW_PATH, "w", encoding="utf-8") as f:
            for line in kept:
                f.write(line + "\n")
        for secid, fline in by_day.get(today, []):
            _feed(_FLOW_HIST, secid, fline)
            _FLOW_FLUSHED[secid] = fline.split(",", 1)[0]
        prev_days = sorted(d for d in by_day if d < today)
        if prev_days:
            for secid, fline in by_day[prev_days[-1]]:
                _feed(_FLOW_PREV, secid, fline)
    except OSError as exc:
        log.debug("资金流历史加载失败: %s", exc)


def _flow_persist(secid: str, line: str) -> None:
    """新分钟定稿时追加落盘；同一分钟内多次调用只落一次。"""
    minute = line.split(",", 1)[0]
    if _FLOW_FLUSHED.get(secid) == minute:
        return
    _FLOW_FLUSHED[secid] = minute
    try:
        os.makedirs(os.path.dirname(_FLOW_PATH), exist_ok=True)
        with open(_FLOW_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(
                {"date": minute.split(" ", 1)[0], "secid": secid, "line": line},
                ensure_ascii=False) + "\n")
    except OSError as exc:
        log.debug("资金流历史落盘失败: %s", exc)


def _hm_in_session(hm: str) -> bool:
    """HH:MM 是否落在交易时段内（用于过滤掉非交易时段累积的脏点）。"""
    return (settings.session_am[0] <= hm <= settings.session_am[1]) or \
           (settings.session_pm[0] <= hm <= settings.session_pm[1])


def _now_in_session(now: dt.datetime | None = None) -> bool:
    now = now or dt.datetime.now()
    return now.weekday() < 5 and _hm_in_session(now.strftime("%H:%M"))


def _flow_clean(klines: list[str] | None) -> list[str]:
    """资金流分钟序列清洗：只留连续竞价时段、去重，口径与分时轴一致。

    push2 收盘后可能带回 15:00 之后的点，盘前还可能整段返回上一交易日；
    调用方据首/末点日期回填 day，避免把昨日序列标成今日。
    """
    out: list[str] = []
    last_minute = ""
    for line in klines or []:
        p = line.split(",")
        if len(p) < 6 or not _hm_in_session((p[0] or "")[-5:]):
            continue
        if p[0] == last_minute:
            continue
        last_minute = p[0]
        out.append(line)
    return out


async def fflow(secid: str, klt: int = 1, lmt: int = 0, ttl: float = 20.0) -> dict | None:
    """分钟级资金流序列。

    1) 交易时段内：每次调用都用 emdatah5 getZJLXData 快照累积一分钟点
       （内存+磁盘落盘），无论 push2 是否可用——保证收盘后/进程重启后
       仍有当日完整序列；
    2) push2 fflow（真·分钟序列，时间戳=行情时间）优先——tries=1 快速失败；
    3) push2 无数据（收盘后常返回空 klines）时，用本地累积序列兜底；
    4) 当日累积不足 2 点时（如 9:15 开盘前），用最近一个有数据的昨日序列
       兜底，保证界面不空。

    返回 {"klines": [...], "day": "YYYY-MM-DD"}（day 供前端判断是否昨日数据）。
    注意累积的是快照的日累计值（f137 等为当日累计净流入），与 push2 的分钟增量
    口径不同；下游的 flow_main_delta5m 等按累计口径计算（尾减首）。
    """
    global _FLOW_DAY, _FLOW_HIST, _FLOW_PREV
    _flow_load()
    today = time.strftime("%Y-%m-%d")
    if _FLOW_DAY != today:
        # 跨天：昨日 ← 旧今日（若有数据；周末/节假日保持上一个交易日），今日清空
        if _FLOW_HIST:
            _FLOW_PREV = _FLOW_HIST
        _FLOW_HIST = {}
        _FLOW_FLUSHED.clear()
        _FLOW_DAY = today
    hist = _FLOW_HIST.setdefault(secid, [])
    if _now_in_session():
        # **只在交易时段累积**，否则墙上时钟点(如午休 12:xx)会落在行情时间轴之外、
        # 图上一根柱都画不出。
        q = await get_json(f"{_H5_URL}/getZJLXData",
                           {"secid": secid, "fields": "f57,f58,f137,f140,f143,f146,f149",
                            "ut": _H5_UT}, ttl=ttl, referer=_H5_REF)
        row = (q or {}).get("data") if isinstance(q, dict) else None
        if row:
            ts = time.strftime("%Y-%m-%d %H:%M")
            line = ",".join(str(x) for x in (
                ts, _numf(row.get("f137")), _numf(row.get("f149")),
                _numf(row.get("f146")), _numf(row.get("f143")), _numf(row.get("f140"))))
            if hist and hist[-1].split(",", 1)[0] == ts:  # 同一分钟 → 覆盖
                hist[-1] = line
            else:
                hist.append(line)
                if len(hist) > _FLOW_MAX:
                    del hist[:len(hist) - _FLOW_MAX]
                _flow_persist(secid, line)
    data = None
    if not _push2_dead("push2.eastmoney.com"):
        d = await get_json("https://push2.eastmoney.com/api/qt/stock/fflow/kline/get",
                           {"secid": secid, "klt": klt, "lmt": lmt, "fields1": "f1,f2,f3,f7",
                            "fields2": "f51,f52,f53,f54,f55,f56", "ut": _UT},
                           ttl=ttl, tries=1)
        if d is None:
            _push2_mark_dead("push2.eastmoney.com")
        data = d.get("data") if d else None
    klines = _flow_clean((data or {}).get("klines"))
    if len(klines) >= 2:
        # day 取序列自身日期：盘前 push2 常整段返回上一交易日，不能硬贴 today。
        day = (klines[-1].split(",", 1)[0] or "")[:10] or today
        return {"klines": klines, "day": day}
    # 只回交易时段内的点（清掉任何历史脏点）
    kept_today = [l for l in hist if _hm_in_session(l.split(",", 1)[0][-5:])]
    if len(kept_today) >= 2:
        return {"klines": kept_today, "day": today}
    # 今日不足 2 点（9:15 前 / 首日无数据 / 收盘后首日）：用最近有数据的昨日兜底
    prev = _FLOW_PREV.get(secid, [])
    kept_prev = [l for l in prev if _hm_in_session(l.split(",", 1)[0][-5:])]
    if kept_prev:
        return {"klines": kept_prev, "day": kept_prev[-1].split(" ", 1)[0]}
    return None


# --------------------------------------------------------------------------
# 期权分时快照累积（与资金流 fflow 同一策略）
#
# 期权 secid 形如 10.xxx / 12.xxx：_tx_code 无腾讯映射（不支持期权），push2 分时
# 又常被代理/反爬打空 -> 期权历来取不到任何分时数据。改用 emdatah5 getZJLXData
# 快照在交易时段内逐分钟累积一份当日序列（已实测该接口对期权返回最新价/昨收）。
# 与 fflow 一样，只能累积自此刻起的分钟点，已经过去的分钟无法回补；非交易时段
# 不累积（否则墙上时钟点落在行情时间轴之外，图上画不出来）。
# --------------------------------------------------------------------------
_OPT_HIST: dict[str, list[str]] = {}   # 当日累积
_OPT_PREV: dict[str, list[str]] = {}   # 最近一个有数据的昨日
_OPT_DAY: str | None = None
_OPT_MAX = 240
_OPT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data", "opt_history.jsonl")
_OPT_LOADED = False
_OPT_FLUSHED: dict[str, str] = {}      # secid -> 已落盘的最后分钟


def _opt_load() -> None:
    """进程首次使用时从磁盘恢复（幂等）：当日 -> _OPT_HIST，最近一个有数据的
    昨日 -> _OPT_PREV；磁盘只保留近 7 天的行。"""
    global _OPT_LOADED, _OPT_DAY
    if _OPT_LOADED:
        return
    _OPT_LOADED = True
    today = time.strftime("%Y-%m-%d")
    _OPT_DAY = today
    if not os.path.exists(_OPT_PATH):
        return

    def _feed(bucket: dict[str, list[str]], secid: str, fline: str) -> None:
        hist = bucket.setdefault(secid, [])
        minute = fline.split(",", 1)[0]
        if hist and hist[-1].split(",", 1)[0] == minute:
            hist[-1] = fline
        else:
            hist.append(fline)
            if len(hist) > _OPT_MAX:
                del hist[:len(hist) - _OPT_MAX]

    try:
        by_day: dict[str, list[tuple[str, str]]] = {}
        kept: list[str] = []
        cutoff = (dt.datetime.now() - dt.timedelta(days=7)).strftime("%Y-%m-%d")
        with open(_OPT_PATH, encoding="utf-8") as f:
            for raw in f:
                line = raw.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                d = r.get("date")
                if not d or d < cutoff or d > today:
                    continue
                kept.append(line)
                secid, fline = r.get("secid"), r.get("line")
                if secid and fline:
                    by_day.setdefault(d, []).append((secid, fline))
        with open(_OPT_PATH, "w", encoding="utf-8") as f:
            for line in kept:
                f.write(line + "\n")
        for secid, fline in by_day.get(today, []):
            _feed(_OPT_HIST, secid, fline)
            _OPT_FLUSHED[secid] = fline.split(",", 1)[0]
        prev_days = sorted(d for d in by_day if d < today)
        if prev_days:
            for secid, fline in by_day[prev_days[-1]]:
                _feed(_OPT_PREV, secid, fline)
    except OSError as exc:
        log.debug("期权分时历史加载失败: %s", exc)


def _opt_persist(secid: str, line: str) -> None:
    """新分钟定稿时追加落盘；同一分钟内多次调用只落一次。"""
    minute = line.split(",", 1)[0]
    if _OPT_FLUSHED.get(secid) == minute:
        return
    _OPT_FLUSHED[secid] = minute
    try:
        os.makedirs(os.path.dirname(_OPT_PATH), exist_ok=True)
        with open(_OPT_PATH, "a", encoding="utf-8") as f:
            f.write(json.dumps(
                {"date": minute.split(" ", 1)[0], "secid": secid, "line": line},
                ensure_ascii=False) + "\n")
    except OSError as exc:
        log.warning("期权分时落盘失败 %s %s: %s", secid, minute, exc)


async def opt_trends(secid: str, ttl: float = 12.0) -> list[dict]:
    """合约当日分时：交易时段内用 emdatah5 快照逐分钟累积。

    返回 [{"time": "YYYY-MM-DD HH:MM", "price": ...}]，与 trends() 输出同构，
    OverlayChart 按 time 末 5 位（HH:MM）对齐。
    当日累积不足 2 点时（开盘前/刚切换合约），用最近一个有数据的昨日序列兜底，
    保证界面不空——但那是昨日数据。
    """
    global _OPT_DAY, _OPT_HIST, _OPT_PREV
    _opt_load()
    today = time.strftime("%Y-%m-%d")
    if _OPT_DAY != today:
        if _OPT_HIST:
            _OPT_PREV = _OPT_HIST
        _OPT_HIST = {}
        _OPT_FLUSHED.clear()
        _OPT_DAY = today
    hist = _OPT_HIST.setdefault(secid, [])
    if _now_in_session():
        q = await get_json(f"{_H5_URL}/getZJLXData",
                           {"secid": secid, "fields": "f43,f57,f58",
                            "ut": _H5_UT}, ttl=ttl, referer=_H5_REF)
        row = (q or {}).get("data") if isinstance(q, dict) else None
        px = _numf(row.get("f43")) if row else 0.0
        if row and px > 0:
            ts = time.strftime("%Y-%m-%d %H:%M")
            line = f"{ts},{px}"
            if hist and hist[-1].split(",", 1)[0] == ts:   # 同一分钟 -> 覆盖
                hist[-1] = line
            else:
                hist.append(line)
                if len(hist) > _OPT_MAX:
                    del hist[:len(hist) - _OPT_MAX]
                _opt_persist(secid, line)
    kept = [l for l in hist if _hm_in_session(l.split(",", 1)[0][-5:])]
    if len(kept) < 2:
        kept = [l for l in _OPT_PREV.get(secid, [])
                if _hm_in_session(l.split(",", 1)[0][-5:])]
    out: list[dict] = []
    for l in kept:
        ts, _, sp = l.partition(",")
        p = float(sp) if sp else 0.0
        out.append({"time": ts, "price": p, "high": p, "low": p,
                    "volume": None, "amount": None, "avg": None})
    return out


# --------------------------------------------------------------------------
# 解析
# --------------------------------------------------------------------------
def parse_klines(data: dict | None) -> list[dict]:
    """kline 接口 klines: "date,open,close,high,low,vol,amount,amp,pct,chg,turn"

    兼容已归一化的 bars 列表（kline() 直接返回 list 时原样透传）。
    """
    if isinstance(data, list):
        return data
    if not data:
        return []
    out = []
    for line in data.get("klines") or []:
        p = line.split(",")
        if len(p) < 7:
            continue
        out.append({
            "date": p[0], "open": float(p[1]), "close": float(p[2]),
            "high": float(p[3]), "low": float(p[4]), "volume": float(p[5]),
            "amount": float(p[6]),
            "pct": float(p[8]) if len(p) > 8 and p[8] not in ("", "-") else None,
        })
    return out


def parse_trends(data: dict | None) -> list[dict]:
    """trends2 行，兼容 8 列与 7 列两种布局。

    8 列（当前 push2 fields2=f51..f58）：time,open,close,high,low,vol,amount,avg
    7 列（旧版）：time,close,high,low,vol,amount,avg
    旧实现固定按 7 列读、且把 open 当成了 price，导致 push2 兜底时分时价整体错位
    （价=开盘、量=价、额=量、均价=额）。
    兼容已归一化的 list（trends() 直接返回时原样透传）。
    """
    if isinstance(data, list):
        return data
    if not data:
        return []
    out = []
    for line in data.get("trends") or []:
        p = line.split(",")
        if len(p) < 5:
            continue
        i = 1 if len(p) >= 8 else 0          # 8 列时跳过开盘点

        def g(k: int, default=None):
            j = i + k
            if j >= len(p) or p[j] in ("", "-"):
                return default
            try:
                return float(p[j])
            except ValueError:
                return default

        out.append({
            "time": p[0], "price": g(1, 0.0),
            "high": g(2, 0.0), "low": g(3, 0.0),
            "volume": g(4, 0.0), "amount": g(5, 0.0), "avg": g(6),
        })
    return out


def parse_fflow(data: dict | None) -> list[dict]:
    """fflow kline: "time,主力净,小单净,中单净,大单净,超大单净" """
    if not data:
        return []
    out = []
    for line in data.get("klines") or []:
        p = line.split(",")
        if len(p) < 6:
            continue
        out.append({
            "time": p[0],
            "main": float(p[1]), "small": float(p[2]), "mid": float(p[3]),
            "big": float(p[4]), "super": float(p[5]),
        })
    return out


def f(x, default=None):
    """安全取数：东财空值为 '-' 或 None。"""
    if x in (None, "-", ""):
        return default
    return x


def num(x, default=0.0) -> float:
    v = f(x)
    if v is None:
        return default
    try:
        return float(v)
    except (TypeError, ValueError):
        return default
