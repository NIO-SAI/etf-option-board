"""名称 → 拼音首字母（搜索用）。

板块名以中文为主，前端搜索支持「拼音首字母」需要后端提供索引：
例如「半导体」→ `bdt`，「沪深300」→ `hs300`。纯函数 + LRU 缓存，可离线单测。
"""

from __future__ import annotations

from functools import lru_cache

from pypinyin import Style, lazy_pinyin


@lru_cache(maxsize=4096)
def initials(text: str) -> str:
    """返回小写拼音首字母串；非中文字符原样保留（字母转小写、数字保留）。

    - 「半导体」→ "bdt"
    - 「沪深300ETF」→ "hs300etf"
    - 空/None → ""
    """
    if not text:
        return ""
    try:
        # errors="default"：中文取首字母，数字/字母原样保留（"沪深300" → h s 300）
        parts = lazy_pinyin(str(text), style=Style.FIRST_LETTER, errors="default")
    except Exception:  # noqa: BLE001 — 生僻字符等异常一律降级为空
        return ""
    return "".join(parts).lower()
