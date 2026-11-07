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
                   mode: str = Query("zt", description="zt=东财涨停池 / ext=扩充涨停（涨幅>9.9%）"),
                   sort: str = Query("hot", description="hot=按炒作涨停 / board=按板块涨停 / pct=按涨幅"),
                   level: str = Query("all", description="all=全部主题 / primary=一级主题 / secondary=二级主题")):
    """周期表矩阵 + 当日主题榜（含等级/扩张/高潮/三共振/资金四列/综合排名热度）。"""
    try:
        return await asyncio.to_thread(lu.overview, date, days=days, top=top, mode=mode,
                                       sort=sort, level=level)
    except Exception as exc:  # noqa: BLE001
        log.warning("涨停棱镜 overview 失败: %s", exc)
        return {"error": str(exc), "matrix": [], "themes": [], "dates": [], "tiers": lu.TIERS}


@router.get("/themes")
async def themes(date: str | None = Query(None, description="YYYYMMDD，默认库内最新交易日"),
                 mode: str = Query("zt", description="zt=东财涨停池 / ext=扩充涨停"),
                 sort: str = Query("hot", description="hot=炒作涨停 / board=板块涨停 / pct=涨幅"),
                 level: str = Query("all", description="all / primary / secondary")):
    """某一天的主题榜（点周期表单元格时，右侧切到那一天用）。"""
    try:
        return await asyncio.to_thread(lu.themes_of, date, mode, sort, level)
    except Exception as exc:  # noqa: BLE001
        log.warning("涨停棱镜 themes 失败: %s", exc)
        return {"error": str(exc), "themes": []}


@router.get("/prism")
async def prism(theme: str | None = Query(None, description="主题板块代码（BKxxxx）"),
                date: str | None = Query(None),
                days: int = Query(25, ge=10, le=90),
                mode: str = Query("zt", description="zt=东财涨停池 / ext=扩充涨停"),
                sort: str = Query("hot", description="hot=炒作涨停 / board=板块涨停")):
    """棱镜图：全市场涨停数（黄线）+ 该主题涨停数（红面积）。"""
    try:
        return await asyncio.to_thread(lu.prism, theme, date, days, mode, sort)
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


@router.get("/brief")
async def brief(date: str | None = Query(None, description="YYYYMMDD，默认库内最新交易日"),
                mode: str = Query("zt", description="zt / ext"),
                sort: str = Query("hot", description="hot / board / pct"),
                level: str = Query("all", description="all / primary / secondary"),
                refresh: int = Query(0, description="1 = 忽略缓存，重新让大模型写解读")):
    """「主题猎手-涨停分析」弹窗：一句话解读 + 各板块炒作原因 + 个股详细涨停原因。"""
    try:
        return await lu.brief(date, mode, sort, level, bool(refresh))
    except Exception as exc:  # noqa: BLE001
        log.warning("涨停复盘 brief 失败: %s", exc)
        return {"error": str(exc), "themes": []}


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
