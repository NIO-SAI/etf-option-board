"""涨停棱镜接口（自包含，前缀 /api/limitup）。

与其它业务路由隔离：只读 `services/limitup.py` 与其本地 `data/limitup.db`，
不碰 board_flow.db、不参与期权链路。所有失败降级为 `{error}`，绝不 500。
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging

from fastapi import APIRouter, Query

from services import limitup as lu

log = logging.getLogger("api.limitup")

router = APIRouter(prefix="/api/limitup")


@router.get("/overview")
async def overview(date: str | None = Query(None, description="YYYYMMDD，默认库内最新交易日"),
                   days: int = Query(11, ge=3, le=60, description="周期表展示的交易日数"),
                   top: int = Query(15, ge=3, le=30, description="每天取前 N 个主题"),
                   mode: str = Query("zt", description="zt=东财涨停池 / ext=扩充涨停（涨幅>9.9%）")):
    """周期表矩阵 + 当日主题榜（含等级/扩张/高潮/三共振/资金四列/综合排名热度）。"""
    try:
        return await asyncio.to_thread(lu.overview, date, days=days, top=top, mode=mode)
    except Exception as exc:  # noqa: BLE001
        log.warning("涨停棱镜 overview 失败: %s", exc)
        return {"error": str(exc), "matrix": [], "themes": [], "dates": [], "tiers": lu.TIERS}


@router.get("/prism")
async def prism(theme: str | None = Query(None, description="主题板块代码（BKxxxx）"),
                date: str | None = Query(None),
                days: int = Query(25, ge=10, le=90),
                mode: str = Query("zt", description="zt=东财涨停池 / ext=扩充涨停")):
    """棱镜图：全市场涨停数（黄线）+ 该主题涨停数（红面积）。"""
    try:
        return await asyncio.to_thread(lu.prism, theme, date, days, mode)
    except Exception as exc:  # noqa: BLE001
        log.warning("涨停棱镜 prism 失败: %s", exc)
        return {"error": str(exc), "dates": [], "total": [], "theme": []}


@router.get("/pool")
async def pool(date: str | None = Query(None),
               theme: str | None = Query(None, description="按主题过滤（板块代码）"),
               kind: str = Query("all", description="all=全市场涨停 / zt=主题涨停 / broken=炸板 / lan=烂板"),
               mode: str = Query("zt", description="zt=东财涨停池 / ext=扩充涨停")):
    """个股池：涨停（含原因/连板/封单额）、炸板、烂板。"""
    try:
        return await asyncio.to_thread(lu.pool, date, theme=theme, kind=kind, mode=mode)
    except Exception as exc:  # noqa: BLE001
        log.warning("涨停棱镜 pool 失败: %s", exc)
        return {"error": str(exc), "items": []}


@router.get("/health")
async def health():
    """库内日期数 / 主题数 / 池子条数 / 最近采集时间。"""
    return await asyncio.to_thread(lu.health)


@router.post("/refresh")
async def refresh(date: str | None = Query(None, description="YYYYMMDD，默认今天")):
    """立即重采某日（调试/补数用），返回采集结果。"""
    d = date or dt.datetime.now().strftime("%Y%m%d")
    try:
        return await lu.collect(d, with_funds=d == dt.datetime.now().strftime("%Y%m%d"))
    except Exception as exc:  # noqa: BLE001
        log.warning("涨停棱镜 refresh 失败: %s", exc)
        return {"error": str(exc), "date": d}
