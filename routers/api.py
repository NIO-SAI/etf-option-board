"""HTTP API 路由。"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import os

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from services import (alerts, deploy as deploy_svc, em, kronos, llm,
                      market_service as ms, monitor, option_service as osvc,
                      reversal, strategy)
from services.universe import ETFS, EXTERNAL, INDICES, NATIONAL_TEAM_ETFS

router = APIRouter(prefix="/api")

_SIGNAL_FRESH_SEC = 3600   # 变盘信号在左侧列表角标里的时效（秒）；过期自动消失


@router.get("/health")
async def health():
    return {
        "ok": True,
        "kronos_available": kronos.available(),
        "llm_available": llm.available(),
        "monitor": monitor.status(),
    }


@router.get("/universe")
async def universe():
    return {"etfs": ETFS, "indices": INDICES, "external": EXTERNAL,
            "national_team_etfs": NATIONAL_TEAM_ETFS}


@router.get("/indices")
async def indices():
    return {"items": await ms.indices_snapshot()}


@router.get("/etfs")
async def etfs_quotes():
    """9 只标的的轻量快照（供左侧列表快速刷新）。"""
    res = await asyncio.gather(*[ms.quote(e["secid"]) for e in ETFS])
    return {"items": [q for q in res if q]}


@router.get("/directions")
async def directions():
    """9 只标的的实时综合方向（看多/看空/观望）+ 当日最新变盘点，供左侧列表标签。

    注意：综合方向（strategy.bias_score 多因子合力，阈值 ±15）已把「变盘点」作为加分
    因子并入（reversal.factor，±15，60 分钟衰减），二者同源；此处另返回当日最新变盘点，
    由前端**另打**一个「变盘·看多/看空」角标，标注方向结论的高周期转折依据。
    变盘点为 5m/15m 结构转向（reversal 阈值 65），日内通常仅 1~2 次。
    只回新鲜信号（60 分钟内），避免早盘的信号一直挂到收盘。
    """
    items = await strategy.directions()
    now = dt.datetime.now()
    for code, v in items.items():
        sig = reversal.recent(code, limit=1)
        if not sig:
            continue
        s = sig[-1]
        try:
            ts = dt.datetime.fromisoformat(s["ts"])
        except (KeyError, ValueError, TypeError):
            continue
        if (now - ts).total_seconds() > _SIGNAL_FRESH_SEC:
            continue
        v["signal"] = {"dir": s.get("dir"), "score": s.get("score"), "ts": s.get("ts")}
    return {"items": items}


@router.get("/etfs/spark")
async def etfs_spark():
    """9 只标的 + 2 个大盘指数(上证指数/中证全指)的日内收盘价序列（供列表迷你走势）。"""
    targets = [(e["secid"], e["code"]) for e in ETFS] + [
        ("1.000001", "000001"), ("1.000985", "000985"),
        ("47.800000", "800000"), ("47.800005", "800005"),
    ]

    async def one(secid: str, code: str):
        tr = await ms.trends(secid)
        return code, [x["price"] for x in tr][::3]

    res = await asyncio.gather(*[one(s, c) for s, c in targets], return_exceptions=True)
    out: dict[str, list] = {}
    for r in res:
        if isinstance(r, tuple) and r[1]:
            out[r[0]] = r[1]
    return {"items": out}


@router.get("/external")
async def external():
    return {"items": await ms.external_snapshot()}


@router.get("/national")
async def national():
    return await ms.national_team_signal()


@router.get("/etf/{code}")
async def etf_context(code: str, klt: int = 1):
    etf = next((e for e in ETFS if e["code"] == code), None)
    if not etf:
        return {"error": f"未知标的 {code}"}
    # 串行会是两者耗时相加；并发聚合可减半
    ctx, track = await asyncio.gather(
        ms.etf_context(code, etf["secid"]),
        ms.track_index_state(etf["track"]),
    )
    return {"etf": etf, **ctx, "track": track}


@router.get("/etf/{code}/kline")
async def etf_kline(code: str, klt: int = 1, lmt: int = 240):
    etf = next((e for e in ETFS if e["code"] == code), None)
    if not etf:
        return {"error": f"未知标的 {code}"}
    return {"bars": await ms.kline(etf["secid"], klt=klt, lmt=lmt)}


@router.get("/option/chain/{code}")
async def option_chain(code: str, month: int | None = None):
    ch = await osvc.chain(code)
    if ch.get("error"):
        return ch
    ch["t_quote"] = osvc.t_quote(ch, month)
    ch["ranked"] = {
        "call": osvc.rank_candidates(ch, "call", 6),
        "put": osvc.rank_candidates(ch, "put", 6),
    }
    # 结合标的实时趋势（strategy.directions 有 60s 缓存），多/空各选一只首选合约
    trend = None
    try:
        d = (await strategy.directions()).get(code)
        if d:
            trend = {"direction": d.get("direction"), "score": d.get("score"),
                     "confidence": d.get("confidence")}
    except Exception:  # noqa: BLE001 — 降级到标的涨跌幅，不阻断期权链
        pass
    if trend is None:
        pct = (ch.get("underlying") or {}).get("pct") or 0
        trend = {"direction": "call" if pct > 0.2 else "put" if pct < -0.2 else "neutral",
                 "score": round(pct * 20, 1), "confidence": round(min(abs(pct) / 3, 1), 2)}
    ch["best"] = osvc.best_buys(ch, trend)
    return ch


@router.get("/option/quote")
async def option_quote(secid: str):
    return await osvc.option_quote(secid) or {"error": "无数据"}


@router.get("/option/kline")
async def option_kline(secid: str, klt: int = 1, lmt: int = 240):
    return {"bars": await osvc.option_kline(secid, klt=klt, lmt=lmt)}


@router.get("/option/trends")
async def option_trends(secid: str, ndays: int = 1):
    return {"trends": await osvc.option_trends(secid, ndays=ndays)}


@router.get("/strategy/{code}")
async def strategy_view(code: str, kronos: int = 1, klt: int = 1):
    return await strategy.analyze(code, with_kronos=bool(kronos), klt=klt)


@router.get("/predict")
async def predict(secid: str, klt: int = 5, lookback: int = 120, pred_len: int = 20,
                  temperature: float = 1.0, top_p: float = 0.9):
    bars = await ms.kline(secid, klt=klt, lmt=max(lookback + 5, 200))
    if len(bars) < 30:
        return {"error": f"K线不足：{len(bars)} 根"}
    freq = {1: "1m", 3: "3m", 5: "5m", 15: "15m", 30: "30m", 101: "1d"}.get(klt, "5m")
    pred = await kronos.predict(bars, lookback=lookback, pred_len=pred_len,
                                temperature=temperature, top_p=top_p, frequency=freq)
    pred["bars"] = bars[-60:]
    if "predictions" in pred:
        pred["summary"] = kronos.summarize(pred, bars[-1]["close"])
    return pred


@router.post("/llm/{code}")
async def llm_decision(code: str, klt: int = 1):
    bundle = await strategy.analyze(code, with_kronos=True, klt=klt)
    if bundle.get("error"):
        return bundle
    decision = await llm.decide(bundle)
    return {"bundle_bias": bundle.get("bias"), "signals": bundle.get("signals"),
            "decision": decision, "ts": bundle.get("ts")}


@router.get("/alerts")
async def alerts_history(limit: int = 50):
    return {"items": alerts.history(limit)}


@router.post("/admin/test-alert")
async def admin_test_alert():
    """发 3 条【测试】告警走真实 SSE 通道，用于验证浏览器通知/声音/弹窗。

    会进告警历史与列表（标题带【测试】前缀便于区分）。"""
    now = dt.datetime.now().isoformat(timespec="seconds")
    samples = [
        {"type": "volume_surge", "level": "warn", "dir": "neutral",
         "etf_code": "510300", "etf_name": "沪深300ETF华泰柏瑞",
         "title": "【测试】量能放大 5.6x · 510300",
         "text": "这是一条测试告警：若已授权，应弹出 Chrome 系统通知并提示音。"},
        {"type": "divergence", "level": "warn", "dir": "bear",
         "etf_code": "588000", "etf_name": "科创50ETF华夏",
         "title": "【测试】15分钟MACD 顶背离 · 588000",
         "text": "第二条测试告警：15 分钟 K 线动能与价格背离（方向看空示例）。"},
        {"type": "national_team", "level": "critical", "dir": "bull",
         "etf_code": "510300", "etf_name": "宽基ETF",
         "title": "【测试】国家队护盘信号增强",
         "text": "第三条测试告警（critical）：需要手动关闭的常驻通知。"},
    ]
    for s in samples:
        await alerts.publish({**s, "test": True, "ts": now})
    return {"ok": True, "count": len(samples)}


@router.post("/monitor/cycle")
async def monitor_once():
    await monitor.cycle()
    return {"ok": True, "status": monitor.status()}


@router.post("/admin/restart")
async def admin_restart():
    """热重启后端（代码更新后生效）：先优雅关闭 Kronos 子进程与网络客户端，
    再以非零码退出，由 LaunchAgent KeepAlive 自动拉起（约 5 秒）。

    仅内网/Tailscale 可达；调用方会看到连接重置，属正常。注意：若服务是手动
    `bash run.sh` 起的（非 launchd），退出后不会自动拉起，需手动再起。"""
    await kronos.shutdown()
    await em.close()
    os._exit(42)  # noqa: unreachable，launchd 视非零退出为崩溃并拉起


@router.post("/admin/deploy")
async def admin_deploy(payload: dict | None = None):
    """手动触发自部署（与 Agent 写 data/.deploy_token 等价）：先做 py_compile
    校验，可选重建前端，然后热重启。立即返回，部署在后台进行，约 1-2 分钟后生效。
    body 可选 {"build_frontend": bool}。"""
    build = bool((payload or {}).get("build_frontend", False))

    async def _bg():
        await asyncio.sleep(2)  # 先让响应发出
        await deploy_svc.deploy_now(build_frontend=build, reason="api手动触发")

    asyncio.create_task(_bg())
    return {"ok": True, "msg": "部署已触发，稍后生效（前端构建约需 1 分钟）"}


@router.get("/reversal/signals")
async def reversal_signals(code: str = Query(...)):
    """当日该标的的变盘信号（供分时图打标记）。"""
    return {"items": reversal.recent(code)}


@router.get("/alerts/stream")
async def alerts_stream():
    q = alerts.subscribe()

    async def gen():
        try:
            # 先补发最近若干条（标记 backfill，前端只入列表、不弹窗不出声）
            for a in reversed(alerts.history(10)):
                yield f"data: {json.dumps({**a, 'backfill': True}, ensure_ascii=False)}\n\n"
            while True:
                try:
                    item = await asyncio.wait_for(q.get(), timeout=15)
                    yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
        finally:
            alerts.unsubscribe(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})
