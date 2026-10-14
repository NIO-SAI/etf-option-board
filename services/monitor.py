"""实时监控：轮询 9 只 ETF（及其近月平值期权），触发量能/资金/暴动/关键时点等告警。"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging

from config import settings
from services import alerts, em, market_service as ms, option_service as osvc, strategy
from services.indicators import pct_change, volume_stats
from services.universe import ETFS

log = logging.getLogger("monitor")

_state: dict = {"running": False, "last_cycle": None, "cycles": 0, "last_error": None}
# 上次关键时点已提醒记录
_key_fired: set[str] = set()


def status() -> dict:
    return dict(_state)


async def _check_etf(etf: dict, key_hm: str | None, nt_score: float) -> None:
    ctx = await ms.etf_context(etf["code"], etf["secid"])
    q = ctx.get("quote") or {}
    if not q:
        return
    k1 = ctx.get("kline_1m") or []
    closes = [b["close"] for b in k1]
    name = etf["name"]

    # 价格突动
    p3 = pct_change(closes, 3)
    if p3 is not None and abs(p3) >= 0.5 and alerts.should_alert(etf["code"], "price_spike", 60):
        await alerts.publish({
            "etf_code": etf["code"], "etf_name": name, "type": "price_spike",
            "level": "critical", "dir": "bull" if p3 > 0 else "bear",
            "title": f"{name} 3分钟急{'拉' if p3>0 else '跌'} {p3:+.2f}%",
            "text": f"现价 {q['price']}（{q['pct']:+.2f}%），3分钟变动 {p3:+.2f}%，注意异动。",
        })

    # 量能骤放
    vs = ctx.get("volume") or {}
    if vs.get("is_surge") and alerts.should_alert(etf["code"], "volume_surge", 120):
        await alerts.publish({
            "etf_code": etf["code"], "etf_name": name, "type": "volume_surge",
            "level": "warn", "dir": "neutral",
            "title": f"{name} 量能放大 {vs['ratio']}x",
            "text": f"近5分钟量能为日内均量 {vs['ratio']} 倍，配合价格方向判断有效性。",
        })

    # 主力资金突入
    d5 = ctx.get("flow_main_delta5m") or 0
    if abs(d5) >= 1.2e8 and alerts.should_alert(etf["code"], "main_inflow", 120):
        await alerts.publish({
            "etf_code": etf["code"], "etf_name": name, "type": "main_inflow",
            "level": "critical", "dir": "bull" if d5 > 0 else "bear",
            "title": f"{name} 主力{'流入' if d5>0 else '流出'} {abs(d5)/1e8:.2f} 亿",
            "text": f"近5分钟主力净{'流入' if d5>0 else '流出'} {abs(d5)/1e8:.2f} 亿元。",
        })

    # MACD 背离
    div = (ctx.get("macd") or {}).get("divergence") or {}
    if div.get("type") in ("bullish", "bearish") and alerts.should_alert(etf["code"], "divergence", 180):
        await alerts.publish({
            "etf_code": etf["code"], "etf_name": name, "type": "divergence",
            "level": "warn", "dir": "bull" if div["type"] == "bullish" else "bear",
            "title": f"{name} 1分钟MACD {'底背离' if div['type']=='bullish' else '顶背离'}",
            "text": "动能与价格背离，留意反转。",
        })

    # 近月平值期权放量/暴动
    try:
        chain = await osvc.chain(etf["code"])
        front = chain.get("front_month")
        s = (chain.get("underlying") or {}).get("price") or 0
        atm = [c for c in chain.get("contracts", []) if c["month"] == front]
        if atm:
            top = sorted(atm, key=lambda c: -(c.get("amount") or 0))[:3]
            for c in top:
                if (c.get("pct") or 0) and abs(c["pct"]) >= 15 and alerts.should_alert(c["code"], "opt_spike", 120):
                    await alerts.publish({
                        "etf_code": etf["code"], "etf_name": name, "type": "opt_spike",
                        "level": "warn", "dir": "bull" if c["pct"] > 0 else "bear",
                        "title": f"{c['name']} {c['pct']:+.1f}%",
                        "text": f"近月活跃合约 {c['code']} 现价 {c['last']}，涨跌 {c['pct']:+.1f}%，成交额 {c['amount']/1e4:.0f} 万。",
                    })
    except Exception as exc:  # noqa: BLE001
        log.debug("期权检查失败 %s: %s", etf["code"], exc)

    # 关键时点（针对关联指数较敏感的标的，只推一次/时点）
    if key_hm:
        kk = f"{etf['code']}:{key_hm}"
        if kk not in _key_fired and alerts.should_alert(etf["code"], "key_time", 300):
            _key_fired.add(kk)
            await alerts.publish({
                "etf_code": etf["code"], "etf_name": name, "type": "key_time",
                "level": "info", "dir": "neutral",
                "title": f"临近变盘时点 {key_hm}",
                "text": f"{name} 处于关键时点窗口，关注方向选择与量能。",
            })

    # 国家队
    if nt_score >= 60 and alerts.should_alert(etf["code"], "national_team", 300):
        await alerts.publish({
            "etf_code": etf["code"], "etf_name": name, "type": "national_team",
            "level": "critical", "dir": "bull",
            "title": "国家队护盘信号增强",
            "text": f"宽基ETF护盘评分 {nt_score}，短期关注反弹。",
        })


def _in_trading_window(now: dt.datetime) -> bool:
    """工作日 09:30–11:30 / 13:00–15:00；非交易时段不发请求（降频防封）。"""
    if now.weekday() >= 5:
        return False
    hm = now.strftime("%H:%M")
    return (settings.session_am[0] <= hm <= settings.session_am[1]) or \
           (settings.session_pm[0] <= hm <= settings.session_pm[1])


async def cycle() -> None:
    now = dt.datetime.now()
    if not _in_trading_window(now):
        _state["last_cycle"] = now.isoformat(timespec="seconds")
        _state["cycles"] += 1
        return
    hm = now.strftime("%H:%M")
    key_hm = strategy.near_key_time(hm, window=2)
    try:
        nt = await strategy.national_team_cached()
        nt_score = nt.get("score", 0)
    except Exception:  # noqa: BLE001
        nt_score = 0
    await asyncio.gather(*[_check_etf(e, key_hm, nt_score) for e in ETFS], return_exceptions=True)
    _state["last_cycle"] = now.isoformat(timespec="seconds")
    _state["cycles"] += 1


async def run_forever() -> None:
    _state["running"] = True
    log.info("监控循环启动，间隔 %ss", settings.poll_interval)
    while True:
        try:
            await cycle()
            _state["last_error"] = None
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            _state["last_error"] = str(exc)
            log.warning("监控轮次异常: %s", exc)
        await asyncio.sleep(settings.poll_interval)
