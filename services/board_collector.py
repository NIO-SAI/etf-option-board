"""板块资金采集器：交易时段把概念/行业的主力净流入写进本地库。

- 约 30 秒一轮（每轮约 7 个东财请求），只在连续竞价时段运行；
- 上一轮未跑完直接跳过，避免堆积；
- 任何异常只记日志，绝不影响期权看板与告警链路。
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging

from services import boardflow as bf
from services import em

log = logging.getLogger("board_collector")

# 概念板块多（约 500 个，5 页），行业约 1 页；一次翻页上限留足余量
_BOARD_FS = (("m:90+t:3", "concept"), ("m:90+t:2", "industry"))
_FIELDS = "f2,f3,f4,f12,f13,f14,f62"
_CYCLE_SEC = 30
_IDLE_SEC = 120

_state: dict = {"cycles": 0, "last_cycle": None, "last_error": None, "boards": 0}
_busy = False
_prev_ranks: dict[str, int] = {}
_prev_date: str | None = None
_pruned_date: str | None = None


def state() -> dict:
    """采集器状态（健康接口用）。"""
    return dict(_state)


async def _fetch_type(fs: str, board_type: str) -> list[dict]:
    rows = await em.clist_all(fs, _FIELDS, pz=100, max_page=8, ttl=20.0)
    return bf.parse_rank_rows(rows, board_type)


async def _cycle() -> None:
    global _busy, _prev_ranks, _prev_date, _pruned_date
    if _busy:
        return
    _busy = True
    now = dt.datetime.now()
    date, hhmm = now.strftime("%Y-%m-%d"), now.strftime("%H:%M")
    try:
        results = await asyncio.gather(
            *(_fetch_type(fs, t) for fs, t in _BOARD_FS), return_exceptions=True)
        rows: list[dict] = []
        errors = []
        for (fs, btype), res in zip(_BOARD_FS, results):
            if isinstance(res, Exception):
                errors.append(f"{btype}: {res}")
                continue
            if not res:
                errors.append(f"{btype}: 空结果")
                continue
            rows.extend(res)
        if not rows:
            _state["last_error"] = "; ".join(errors) or "空结果"
            log.warning("板块采集无数据，跳过本轮: %s", _state["last_error"])
            return

        # 跨日重置名次基准（重启后第一轮从库里恢复）
        if _prev_date != date:
            _prev_ranks = await asyncio.to_thread(bf.load_prev_ranks, date)
            _prev_date = date

        ranked = bf.assign_ranks_by_type(rows, _prev_ranks)
        n = await asyncio.to_thread(bf.save_cycle, date, hhmm, ranked)
        _prev_ranks = {r["code"]: r["rank"] for r in ranked}

        if _pruned_date != date:
            await asyncio.to_thread(bf.prune, now.date())
            _pruned_date = date

        _state.update({"cycles": _state["cycles"] + 1, "last_cycle": f"{date} {hhmm}",
                       "last_error": ("; ".join(errors) or None), "boards": len(ranked)})
        log.debug("板块采集完成 %s %s：%d 个板块", date, hhmm, n)
    except asyncio.CancelledError:
        raise
    except Exception as exc:  # noqa: BLE001 — 采集失败不影响主流程
        _state["last_error"] = str(exc)
        log.warning("板块采集失败: %s", exc)
    finally:
        _busy = False


async def run_forever() -> None:
    """随 FastAPI 启动的后台循环。"""
    log.info("板块资金采集器启动")
    # 启动时先建表/裁剪一次，避免查询报 no such table
    try:
        await asyncio.to_thread(bf.init_db)
        await asyncio.to_thread(bf.prune)
        _pruned_date = dt.date.today().isoformat()
    except Exception as exc:  # noqa: BLE001
        log.warning("板块库初始化失败: %s", exc)

    while True:
        try:
            if bf.in_session(dt.datetime.now()):
                await _cycle()
                await asyncio.sleep(_CYCLE_SEC)
            else:
                await asyncio.sleep(_IDLE_SEC)
        except asyncio.CancelledError:
            log.info("板块资金采集器停止")
            raise
        except Exception as exc:  # noqa: BLE001
            log.warning("板块采集循环异常: %s", exc)
            await asyncio.sleep(_IDLE_SEC)
