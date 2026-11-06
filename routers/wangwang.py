"""汪汪队 ETF 跟踪器接口（自包含，前缀 /api/wangwang）。

与其它业务路由完全隔离：只读 `services/wangwang.py`，不碰 board_flow.db / 期权链路。
"""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, Query

from services import wangwang as ww

log = logging.getLogger("api.wangwang")

router = APIRouter(prefix="/api/wangwang")


@router.get("/snapshot")
async def snapshot(force: int = Query(0, description="1 = 跳过 5 秒缓存，强制回源")):
    """整页数据：24 只实时 + 20 日均额/日内分布 + 份额历史。

    失败降级返回 `{error}`（绝不 500），页面按「快照不可用」展示。
    """
    try:
        return await ww.snapshot(force=bool(force))
    except Exception as exc:  # noqa: BLE001
        log.warning("汪汪队快照失败: %s", exc)
        return {"error": str(exc), "items": [], "shares_history": {}}


@router.get("/health")
async def health():
    """份额库状态 + 缓存条数（排查「份额图没点」用）。"""
    return await asyncio.to_thread(ww.health)
