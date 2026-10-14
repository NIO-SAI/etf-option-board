"""东方财富行情接口客户端（异步 httpx，直连 + curl 兜底 + 短 TTL 缓存）。

所有请求手拼 query（safe=",:"），否则 fs=m:10+t:10 等会被编码成 %3A 而返回空数据。
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from urllib.parse import urlencode

import httpx

from config import settings

log = logging.getLogger("em")

_UA = settings.user_agent
_UT = settings.em_token
_REFERER = "https://quote.eastmoney.com/"

_CLIENT: httpx.AsyncClient | None = None
_CACHE: dict[str, tuple[float, float, object]] = {}
# 传输路径记忆：(host|path) -> (mode, ts)；mode: "direct" | "curl"
_MEMO: dict[str, tuple[str, float]] = {}
_MEMO_TTL = 300
# 东财 push2 限流抖动：失败重试（重试会放大请求量，3 次为折中）
_RETRY_TRIES = 3
_RETRY_DELAY = 0.25
# 全局并发闸：东财对同 IP 并发突发很敏感，超出即整批被拒；限流后串行通过更稳。
_SEM = asyncio.Semaphore(4)


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


async def _curl_json(url: str, params: dict | None = None) -> object:
    p = dict(params or {})
    p["_"] = int(time.time() * 1000)
    full = _build(url, p)
    proc = await asyncio.create_subprocess_exec(
        "curl", "-s", "-m", "8", "-A", _UA, "-e", _REFERER,
        "-H", "Accept: application/json, text/plain, */*",
        full,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    out, _ = await proc.communicate()
    return json.loads(out.decode("utf-8", "replace"))


async def get_json(url: str, params: dict | None = None, ttl: float = 3.0,
                   force: bool = False) -> object | None:
    """带缓存与传输兜底的 GET JSON。失败返回 None（绝不抛给上层）。"""
    params = params or {}
    key = _build(url, params)
    now = time.time()
    if not force:
        hit = _CACHE.get(key)
        if hit and now - hit[0] < hit[1]:
            return hit[2]

    hostkey = url.split("//", 1)[-1].split("/", 1)[0]
    memo = _MEMO.get(hostkey)
    prefer = memo[0] if memo and now - memo[1] < _MEMO_TTL else None

    async def _direct():
        r = await _client().get(_build(url, params))
        r.raise_for_status()
        return r.json()

    async def _curl():
        return await _curl_json(url, params)

    transports = [("curl", _curl), ("direct", _direct)]
    if prefer != "curl":
        transports.reverse()

    data = None
    used = None
    # 东财限流：单次成功率约 30~50%，失败即重试（direct 被 WAF 拒绝时很快失败）
    for attempt in range(_RETRY_TRIES):
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
        if attempt < _RETRY_TRIES - 1:
            await asyncio.sleep(_RETRY_DELAY)

    if data is None:
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
# 行情
# --------------------------------------------------------------------------
async def clist(fs: str, fields: str, pn: int = 1, pz: int = 100, fid: str = "f12",
                po: int = 1, ttl: float = 8.0) -> list[dict]:
    url = "https://push2.eastmoney.com/api/qt/clist/get"
    params = {
        "pn": pn, "pz": pz, "po": po, "np": 1, "fltt": 2, "invt": 2,
        "fid": fid, "fs": fs, "fields": fields, "ut": _UT,
    }
    d = await get_json(url, params, ttl=ttl)
    if not d or not d.get("data"):
        return []
    return d["data"].get("diff") or []


async def clist_all(fs: str, fields: str, pz: int = 100, max_page: int = 8,
                    ttl: float = 15.0) -> list[dict]:
    out: list[dict] = []
    for pn in range(1, max_page + 1):
        rows = await clist(fs, fields, pn=pn, pz=pz, ttl=ttl)
        if not rows:
            break
        out.extend(rows)
        if len(rows) < pz:
            break
    return out


async def stock_get(secid: str, fields: str, ttl: float = 6.0) -> dict | None:
    url = "https://push2.eastmoney.com/api/qt/stock/get"
    d = await get_json(url, {"secid": secid, "fltt": 2, "invt": 2, "fields": fields, "ut": _UT}, ttl=ttl)
    if not d or not d.get("data"):
        return None
    return d["data"]


async def kline(secid: str, klt: int = 1, lmt: int = 240, fqt: int = 1, ttl: float = 20.0) -> dict | None:
    url = "https://push2his.eastmoney.com/api/qt/stock/kline/get"
    params = {
        "secid": secid, "fields1": _fields1(), "fields2": _fields2(),
        "klt": klt, "fqt": fqt, "end": "20500101", "lmt": lmt, "ut": _UT,
    }
    d = await get_json(url, params, ttl=ttl)
    return d.get("data") if d else None


async def trends(secid: str, ndays: int = 1, ttl: float = 10.0) -> dict | None:
    url = "https://push2.eastmoney.com/api/qt/stock/trends2/get"
    params = {
        "secid": secid, "fields1": "f1,f2,f3,f4,f5,f6,f7,f8",
        "fields2": "f51,f52,f53,f54,f55,f56,f57,f58", "iscr": 0, "ndays": ndays, "ut": _UT,
    }
    d = await get_json(url, params, ttl=ttl)
    return d.get("data") if d else None


async def fflow(secid: str, klt: int = 1, lmt: int = 0, ttl: float = 15.0) -> dict | None:
    """分钟级资金流（主力/超大/大/中/小）。"""
    url = "https://push2.eastmoney.com/api/qt/stock/fflow/kline/get"
    params = {
        "secid": secid, "klt": klt, "lmt": lmt,
        "fields1": "f1,f2,f3,f7",
        "fields2": "f51,f52,f53,f54,f55,f56", "ut": _UT,
    }
    d = await get_json(url, params, ttl=ttl)
    return d.get("data") if d else None


# --------------------------------------------------------------------------
# 解析
# --------------------------------------------------------------------------
def parse_klines(data: dict | None) -> list[dict]:
    """kline 接口 klines: "date,open,close,high,low,vol,amount,amp,pct,chg,turn" """
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
    """trends2: "time,close,high,low,vol,amount,avg" """
    if not data:
        return []
    out = []
    for line in data.get("trends") or []:
        p = line.split(",")
        if len(p) < 4:
            continue
        out.append({
            "time": p[0], "price": float(p[1]),
            "high": float(p[2]), "low": float(p[3]),
            "volume": float(p[4]) if len(p) > 4 else 0.0,
            "amount": float(p[5]) if len(p) > 5 else 0.0,
            "avg": float(p[6]) if len(p) > 6 else None,
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
