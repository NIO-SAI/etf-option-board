"""财联社「热门板块」聚合：热门行业/概念板块 + 盘面异动播报 → 模糊匹配本地板块。

数据源（财联社公开接口，按 CLS 规则签名 ``sign = md5(sha1(sorted_query))``）：
- ``x-quote.cls.cn/web_quote/plate/hot_plate?type=industry,concept,area&way=change&rever=1``
  → 热门行业板块 / 热门概念板块（各 6 个）
- ``www.cls.cn/v3/transaction/articles`` → 当日盘面直播，**每条带 ``plate_name`` 的都是
  一次板块异动播报**（如「中字头」「智能电网」「锂矿」），不能只挑标题含「异动」的，
  否则一天只能拿到 1~2 条。

CLS 名称与东财板块名不完全一致（「半导体」vs「半导体概念」、「短剧」vs「短剧互动游戏」），
所以用「别名 → 去括号/后缀 → 精确 → 包含 → difflib 相似度」五步匹配。
接口失败时返回上一份缓存，再不行返回空列表，绝不抛异常（页面走回退逻辑）。
"""

from __future__ import annotations

import difflib
import hashlib
import re
import time
import urllib.parse

from services import em

CLS_REFERER = "https://www.cls.cn/"
_HOT_URL = "https://x-quote.cls.cn/web_quote/plate/hot_plate"
_ARTICLE_URL = "https://www.cls.cn/v3/transaction/articles"
_CLS_BASE = {"app": "CailianpressWeb", "os": "web", "sv": "8.4.6"}
_TTL = 300.0

# 板块名后缀：去掉后「半导体概念」与「半导体」才能对齐
_SUFFIXES = ("概念板块", "行业板块", "板块", "概念", "行业", "指数")

# CLS 的叫法与东财板块名不同、且没有公共子串，只能显式列别名（值为东财板块名）
_ALIASES = {
    "异质结电池": "HJT电池",
    "文生视频": "AI视频",
    "存储器": "存储芯片",
    "短剧": "短剧互动游戏",
    "豆包大模型": "抖音概念",
    "高股息": "红利股",
    "盐湖提锂": "锂矿概念",
    "AI玩具": "谷子经济",
    "有色·镍": "镍",
}

_cache: dict = {"at": 0.0, "data": None}


def sign_params(params: dict) -> str:
    """CLS 签名：md5(sha1(urlencode(sorted(params))))。纯函数，便于单测。"""
    qs = urllib.parse.urlencode(sorted(params.items()))
    return hashlib.md5(hashlib.sha1(qs.encode()).hexdigest().encode()).hexdigest()


def normalize_name(name: str) -> str:
    """匹配用归一：去括号注释、去空白、去「概念/板块/行业/指数」后缀。纯函数。"""
    # 「抖音概念(字节概念)」「AI制药（医疗）」→ 去掉括号里的别名
    s = re.sub(r"[（(][^）)]*[）)]", "", str(name or ""))
    s = re.sub(r"\s+", "", s)
    for suf in _SUFFIXES:
        if s.endswith(suf) and len(s) > len(suf):
            s = s[: -len(suf)]
            break
    return s


def match_name(name: str, boards: list[dict]) -> dict | None:
    """把一个 CLS 板块名模糊匹配到本地板块行（code/name/kind）。纯函数。

    匹配顺序：归一后精确 → 包含（长度 ≥2，取更长公共部分）→ difflib 相似度 ≥ 0.78。
    """
    raw = str(name or "").strip()
    target = normalize_name(_ALIASES.get(raw, raw))
    if not target:
        return None
    norm = [(normalize_name(b.get("name")), b) for b in boards or []]
    for nb, b in norm:
        if nb and nb == target:
            return b
    contains = [(nb, b) for nb, b in norm
                if nb and len(nb) >= 2 and (nb in target or target in nb)
                # 「异质结电池」不该因为含「电池」就匹配到「电池」板块：
                # 公共部分至少占较长名字的一半，才算同一板块。
                and min(len(nb), len(target)) / max(len(nb), len(target)) >= 0.5]
    if contains:
        contains.sort(key=lambda x: (-len(x[0]), 0 if x[1].get("kind") == "concept" else 1))
        return contains[0][1]
    best, best_ratio = None, 0.0
    for nb, b in norm:
        if not nb:
            continue
        r = difflib.SequenceMatcher(None, nb, target).ratio()
        if r > best_ratio:
            best, best_ratio = b, r
    return best if best_ratio >= 0.78 else None


async def _get_json(url: str, params: dict) -> object | None:
    full = {**params, "sign": sign_params(params)}
    return await em.get_json(url, full, ttl=_TTL, referer=CLS_REFERER, tries=1)


async def fetch_hot_plates() -> list[tuple[str, str]]:
    """热门行业板块 + 热门概念板块：[(名称, 来源)]。"""
    d = await _get_json(_HOT_URL, {**_CLS_BASE, "type": "industry,concept", "way": "change", "rever": 1})
    data = (d or {}).get("data") if isinstance(d, dict) else None
    out: list[tuple[str, str]] = []
    if not isinstance(data, dict):
        return out
    for key, label in (("concept", "热门概念"), ("industry", "热门行业")):
        for row in data.get(key) or []:
            nm = str((row or {}).get("secu_name") or "").strip()
            if nm:
                out.append((nm, label))
    return out


async def fetch_abnormal() -> list[str]:
    """当日盘面直播里所有带 ``plate_name`` 的条目（每条都是一次板块异动播报）。

    以前只取标题含「异动」的，2026-11-05 实测一天只有 2 条，漏掉 20 多个板块；
    ``plate_name`` 本身就是财联社给这条播报打的板块标签，不需要再靠标题判断。
    """
    d = await _get_json(_ARTICLE_URL, dict(_CLS_BASE))
    arts = (d or {}).get("data") if isinstance(d, dict) else None
    out: list[str] = []
    for a in arts or []:
        if not isinstance(a, dict):
            continue
        nm = str(a.get("plate_name") or "").strip()
        if nm:
            out.append(nm)
    return out


async def hot_board_names() -> dict:
    """聚合 CLS 热门/异动板块名（去重，异动优先）。返回 {'names': [(名, 来源)], 'error': str|None}。"""
    errors: list[str] = []
    abnormal: list[str] = []
    hot: list[tuple[str, str]] = []
    try:
        abnormal = await fetch_abnormal()
    except Exception as exc:  # noqa: BLE001
        errors.append(f"异动: {exc}")
    try:
        hot = await fetch_hot_plates()
    except Exception as exc:  # noqa: BLE001
        errors.append(f"热门: {exc}")

    seen: set[str] = set()
    names: list[tuple[str, str]] = []
    for nm, src in [(n, "异动") for n in abnormal] + hot:
        key = normalize_name(nm)
        if not key or key in seen:
            continue
        seen.add(key)
        names.append((nm, src))
    return {"names": names, "error": "; ".join(errors) or None}


def match_all(names: list[tuple[str, str]], boards: list[dict]) -> list[dict]:
    """把 CLS 板块名逐个匹配到本地板块，按来源顺序去重。纯函数。"""
    out: list[dict] = []
    seen: set[str] = set()
    for nm, src in names or []:
        row = match_name(nm, boards)
        if not row:
            continue
        code = str(row.get("code") or "")
        if not code or code in seen:
            continue
        seen.add(code)
        out.append({**row, "cls_name": nm, "source": src})
    return out


async def _cached_names() -> tuple[dict, float]:
    """缓存 CLS 板块名（与日期无关）：5 分钟内直接复用；失败/空时回退上一份。"""
    now = time.time()
    if _cache["data"] is not None and now - _cache["at"] < _TTL:
        return _cache["data"], _cache["at"]
    try:
        data = await hot_board_names()
    except Exception as exc:  # noqa: BLE001
        data = {"names": [], "error": str(exc)}
    if data.get("names"):
        _cache.update(at=now, data=data)
        return data, now
    if _cache["data"] is not None:
        return _cache["data"], _cache["at"]
    return data, now


async def hot_boards(boards: list[dict]) -> dict:
    """「热门板块」匹配：只缓存 CLS 名称，资金/涨幅等按本次 `boards`（可指定日期）现算。

    缓存整份匹配结果会让「切到历史日期」显示出别的日期的资金值，所以必须分开。
    """
    data, at = await _cached_names()
    return {"items": match_all(data.get("names") or [], boards),
            "error": data.get("error"), "at": at}
