"""HTTP API 路由。"""

from __future__ import annotations

import asyncio
import datetime as dt
import json
import os

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse

from services import (alerts, decision, deploy as deploy_svc, em, index_levels, kronos, llm,
                      market_service as ms, monitor, option_playbook as playbook,
                      option_service as osvc, reversal, strategy, user_settings as usv,
                      vol)
from services.universe import ETF_BY_CODE, ETFS, EXTERNAL, INDICES, NATIONAL_TEAM_ETFS

router = APIRouter(prefix="/api")

_SIGNAL_FRESH_SEC = 3600   # 变盘信号在左侧列表角标里的时效（秒）；过期自动消失


def _is_fut_opt(code: str) -> bool:
    """股指期权代码（MO/IO/HO）。三者与 ETF 代码不会冲突，前缀判定足够。"""
    from services.index_option import _BY_CODE
    return code.upper() in _BY_CODE


async def _fut_chain(code: str, month: int | None = None) -> dict:
    """股指期权链，补齐与 ETF 链同构的 t_quote/ranked/best。

    前端复用同一套 T 型报价与优选组件，字段名必须与 `osvc.chain` 完全一致；
    区别只在标的名（`etf` 字段沿用前者位置，值为指数）与乘数。
    """
    from services import index_option as idxo
    ch = await idxo.chain(code.upper())
    if ch.get("error"):
        return ch
    fut = ch.get("fut") or {}
    ch["etf"] = {"code": fut.get("code"), "name": fut.get("name"),
                 "secid": fut.get("underlying"), "track": fut.get("track")}
    ch["t_quote"] = osvc.t_quote(ch, month)
    ch["ranked"] = {
        "call": osvc.rank_candidates(ch, "call", 6),
        "put": osvc.rank_candidates(ch, "put", 6),
    }
    b = await _fut_bias(ch)
    ch["best"] = osvc.best_buys(ch, b)
    return ch


async def _fut_bias(ch: dict) -> dict:
    """股指方向：用现货分时/资金流算 bias（与 index_option.state 同一套纯函数）。

    不直接调 `index_option.state`——它内部会再拉一次整条链（730 条合约），
    期权链接口已经在拉，重复一次等于把响应时间翻倍。
    """
    from services import index_option as idxo
    fut = ch.get("fut") or {}
    secid = fut.get("underlying") or ""
    u = ch.get("underlying") or {}
    try:
        tr, flow = await asyncio.gather(
            em.trends(secid), em.stock_get(secid, "f137", ttl=20.0),
            return_exceptions=True,
        )
        b = idxo.bias(
            tr if isinstance(tr, list) else [],
            [{"price": u.get("price") or 0, "high": u.get("high"), "low": u.get("low")}],
            flow if isinstance(flow, dict) else None,
            {"basis_pct": idxo._basis_pct(ch, u.get("price") or 0)},
        )
        if b.get("direction"):
            return {"direction": b["direction"], "score": b.get("score", 0),
                    "confidence": b.get("confidence", 0)}
    except Exception:  # noqa: BLE001 — 方向不可得不阻断期权链
        pass
    pct = u.get("pct") or 0
    return {"direction": "call" if pct > 0.2 else "put" if pct < -0.2 else "neutral",
            "score": round(pct * 20, 1), "confidence": round(min(abs(pct) / 3, 1), 2)}


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
    # fut_opts：股指期权 IO/MO/HO 与 ETF 并列进左栏（前端按 code 是否在此判定数据源）。
    from services.index_option import FUT_OPTS
    return {"etfs": ETFS, "indices": INDICES, "external": EXTERNAL,
            "national_team_etfs": NATIONAL_TEAM_ETFS, "fut_opts": FUT_OPTS}


@router.get("/indices")
async def indices():
    return {"items": await ms.indices_snapshot()}


@router.get("/index/levels")
async def index_levels_view():
    """上证指数关键位（9 只 ETF 共用一份）+ 分时，供指数弹窗。"""
    snap, tr = await asyncio.gather(
        index_levels.snapshot(), ms.trends("1.000001"))
    day = (tr[-1].get("time") or "")[:10] if tr else None
    return {**snap, "trends": tr, "trends_day": day,
            "trends_prev_close": (em.trend_prev_close("1.000001")
                                  if day and day != dt.date.today().isoformat() else None)}


@router.get("/etfs")
async def etfs_quotes():
    """9 只 ETF + 3 只股指期权标的的轻量快照（供左侧列表快速刷新）。

    股指期权按**标的指数**取价（IO→000300、MO→000852、HO→000016），
    并把 code 改写成 IO/MO/HO——行情接口回的 f57 是纯指数代码，前端按 IO/MO/HO 索引。
    """
    from services.index_option import FUT_OPTS
    res = await asyncio.gather(*[ms.quote(e["secid"]) for e in ETFS],
                               *[ms.quote(f["underlying"]) for f in FUT_OPTS],
                               return_exceptions=True)
    etf_part, fut_part = res[:len(ETFS)], res[len(ETFS):]
    items = [q for q in etf_part if isinstance(q, dict) and q]
    for f, q in zip(FUT_OPTS, fut_part):
        if isinstance(q, dict) and q:
            items.append({**q, "code": f["code"], "name": f["name"],
                          "track": f.get("track")})
    return {"items": items}


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
    """9 只标的 + 底栏两个大盘指数的日内收盘价序列（供列表迷你走势）。

    板块代码（47.800005 A股平均股价）没有腾讯映射、push2 分时又被反爬打空，
    必须走 trends_or_snapshot 的 emdatah5 快照累积，否则永远是空曲线。
    """
    from services.index_option import FUT_OPTS
    targets = [(e["secid"], e["code"]) for e in ETFS] + [
        (f["underlying"], f["code"]) for f in FUT_OPTS
    ] + [
        ("1.000001", "000001"), ("47.800005", "800005"),
    ]

    async def one(secid: str, code: str):
        tr = await em.trends_or_snapshot(secid)
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
    if _is_fut_opt(code):
        return await _fut_context(code)
    etf = next((e for e in ETFS if e["code"] == code), None)
    if not etf:
        return {"error": f"未知标的 {code}"}
    # 串行会是两者耗时相加；并发聚合可减半
    ctx, track = await asyncio.gather(
        ms.etf_context(code, etf["secid"]),
        ms.track_index_state(etf["track"]),
    )
    return {"etf": etf, **ctx, "track": track}


async def _fut_context(code: str) -> dict:
    """股指期权的「标的上下文」，字段与 `/etf/{code}` 同构，前端行情卡才能直接复用。

    现货是**指数**而不是 ETF：`trends/flow` 取指数自己的口径，
    `etf.secid` 给指数 secid，Kronos 预测与详情图都按这个走。
    """
    from services import index_option as idxo
    fut = idxo._BY_CODE.get(code.upper())
    if not fut:
        return {"error": f"未知股指期权品种 {code}"}
    secid = fut["underlying"]
    q, tr, fl = await asyncio.gather(
        em.stock_get(secid, "f43,f44,f45,f46,f47,f48,f57,f58,f60,f169,f170,f171"),
        em.trends(secid),
        ms.flow_series(secid),
        return_exceptions=True,
    )
    q = q if isinstance(q, dict) else {}
    tr = tr if isinstance(tr, list) else []
    flow = fl[0] if isinstance(fl, tuple) and fl and isinstance(fl[0], list) else []
    spot = em.num(q.get("f43")) or 0.0
    prev = em.num(q.get("f60")) or None
    quote = {
        "price": spot, "pct": em.num(q.get("f170")),
        "high": em.num(q.get("f44")), "low": em.num(q.get("f45")),
        "open": em.num(q.get("f46")), "prev_close": prev,
        "volume": em.num(q.get("f47")), "amount": em.num(q.get("f48")),
    }
    kline = await em.kline(secid, klt=1, lmt=240)
    # 日内枢轴支撑/压力：与 ETF 行情卡同一口径（纯本地计算，不额外发请求）
    sr = {}
    if len(kline) >= 10:
        sr = ms.support_resistance(
            [b["close"] for b in kline],
            [b["high"] for b in kline],
            [b["low"] for b in kline],
        )
    return {
        "etf": {"code": fut["code"], "name": fut["name"], "secid": secid,
                "track": fut.get("track"), "kind": "index"},
        "underlying": {"kind": "index", **quote},
        "quote": quote, "trends": tr,
        "trends_prev_close": em.trend_prev_close(secid) if prev is None else prev,
        "flow": flow,
        "support": sr.get("support") or [],
        "resistance": sr.get("resistance") or [],
    }


@router.get("/etf/{code}/kline")
async def etf_kline(code: str, klt: int = 1, lmt: int = 240):
    etf = next((e for e in ETFS if e["code"] == code), None)
    if not etf:
        return {"error": f"未知标的 {code}"}
    return {"bars": await ms.kline(etf["secid"], klt=klt, lmt=lmt)}


@router.get("/option/chain/{code}")
async def option_chain(code: str, month: int | None = None):
    if _is_fut_opt(code):
        return await _fut_chain(code, month)
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


@router.get("/option/surface/{code}")
async def option_surface(code: str, month: int | None = None):
    """波动率曲面：逐月 ATM IV（期限结构）+ 25Δ 偏斜 + 一句话结论。"""
    ch = await osvc.chain(code)
    if ch.get("error"):
        return ch
    s = vol.surface(ch)
    if month and s.get("skew"):
        s["skew"] = vol.skew_25d(ch, month) or s["skew"]
    return {"code": code, "underlying": ch.get("underlying"),
            "stats": ch.get("stats"), **s}


@router.get("/option/playbook/{code}")
async def option_playbook(code: str, direction: str | None = None,
                          iv_pct: float | None = None,
                          month: int | None = None, next: int = 0):
    """多腿策略册：按「方向 × IV 分位」给出带到期损益的组合建议。

    ``direction`` 缺省时复用 ``/directions`` 的实时方向（与推荐卡同源），
    ``iv_pct`` 缺省时取该标的的 20 日 IV 分位。
    """
    ch = await osvc.chain(code)
    if ch.get("error"):
        return ch
    dirn = direction
    if dirn is None:
        try:
            dirn = ((await strategy.directions()).get(code) or {}).get("direction")
        except Exception:  # noqa: BLE001 — 方向不可得时按中性处理，不阻断策略册
            dirn = None
    iv = iv_pct if iv_pct is not None else (ch.get("stats") or {}).get("atm_iv_pctl20")
    out = playbook.suggest(ch, direction=dirn, iv_pct=iv,
                           prefer_next=bool(next), month=month)
    out["surface"] = vol.surface(ch)
    out["stats"] = ch.get("stats")
    out["underlying"] = ch.get("underlying")
    out["front_month"] = ch.get("front_month")
    return out


@router.get("/option/quote")
async def option_quote(secid: str):
    return await osvc.option_quote(secid) or {"error": "无数据"}


@router.get("/index-option/overview")
async def index_option_overview():
    """股指期权 IO/MO/HO 概览（方向评分 + 建议）。"""
    from services import index_option as idxo
    return await idxo.overview()


@router.get("/index-option/{symbol}")
async def index_option_state(symbol: str):
    """单品种完整包（与 /strategy/{code} 同构，前端复用行情卡）。"""
    from services import index_option as idxo
    return await idxo.bundle(symbol.upper())


@router.get("/option/kline")
async def option_kline(secid: str, klt: int = 1, lmt: int = 240):
    return {"bars": await osvc.option_kline(secid, klt=klt, lmt=lmt)}


@router.get("/option/trends")
async def option_trends(secid: str, ndays: int = 1):
    return {"trends": await osvc.option_trends(secid, ndays=ndays)}


@router.get("/calibration")
async def calibration():
    """自校准参数（合约实盘跟踪回算出的 Δ 偏移/Theta 折扣），前端角标展示。"""
    from services import pick_tracker
    return pick_tracker.calibration()


@router.get("/option/levels")
async def option_levels(code: str, secid: str):
    """合约图三组横线的数据：**合约价**买卖点 + 按 |Δ| 折算成合约价的支撑/压力。

    走 `plan_hint` 的 5 分钟缓存，不跑完整 `analyze`——否则每切一次合约就把策略链路
    重算一遍（链+方向+Kronos），既慢又把接口压力放大好几倍。
    方向与主计划不一致时用 `pullback_plan` 换成回踩入场（反向备选不追突破价）。
    """
    fut = _is_fut_opt(code)
    if fut:
        from services import index_option as idxo
        ch = await idxo.chain(code.upper())
    else:
        ch = await osvc.chain(code)
    if ch.get("error"):
        return ch
    contract = next((c for c in (ch.get("contracts") or []) if c.get("secid") == secid), None)
    if not contract:
        return {"error": f"标的不含该合约 {secid}"}

    asset = ETF_BY_CODE.get(code)
    ctx: dict = {}
    if asset:
        try:
            ctx = await ms.etf_context(code, asset["secid"])
        except Exception:  # noqa: BLE001 — 支撑/压力拿不到不影响买卖点
            ctx = {}

    s_now = (ch.get("underlying") or {}).get("price") or 0
    side = "call" if contract.get("is_call") else "put"
    if fut:
        data = await idxo.bundle(code.upper())
        by_side = data.get("levels_by_side") or {}
        levels = by_side.get(side) or data.get("levels") or {}
    else:
        hint = strategy.plan_hint(code) or {}
        if not hint.get("levels"):
            # 首次（服务刚起 / 还没打开过策略卡）：跑一次 analyze 把点位缓存填上，
            # 之后一律走 plan_hint 的 5 分钟缓存。
            data = await strategy.analyze(code)
            hint = {"levels": data.get("levels") or {},
                    "spot": (data.get("underlying") or {}).get("price")}
        levels = hint.get("levels") or {}
        s_now = hint.get("spot") or s_now
        if levels:
            primary = "call" if levels.get("side") == "long" else "put"
            if side != primary:
                levels = strategy.pullback_plan(strategy.plan_levels(ctx, side)) or levels
    if not levels:
        return {"error": "点位缓存未就绪（等待一次策略分析）"}

    plan = strategy.contract_levels(contract, levels, s_now)
    delta = contract.get("delta") or 0
    last = contract.get("last") or 0

    def px(v: float) -> float:
        """标的价位 → 合约价（与 contract_levels 同一折算公式）。"""
        return round(last + delta * (v - s_now), 4)

    ok = bool(delta and s_now and last)
    return {"code": code, "secid": secid, "side": side,
            "contract": contract.get("name"), "spot": s_now,
            "plan": plan,
            "support": [px(v) for v in (ctx.get("support") or [])] if ok else [],
            "resistance": [px(v) for v in (ctx.get("resistance") or [])] if ok else [],
            "levels": levels, "multiplier": contract.get("multiplier") or 10000}


@router.get("/strategy/{code}")
async def strategy_view(code: str, kronos: int = 1, klt: int = 1):
    if _is_fut_opt(code):
        # 股指期权自带一套 bundle（与 strategy.analyze 同构，含 levels_by_side）
        from services import index_option as idxo
        out = await idxo.bundle(code.upper())
        # 前端按 best.recommended 自动选中合约；bundle 只有 candidates，
        # 这里补一份同构的 best，避免详情区一直空白等用户手点。
        if not out.get("error"):
            c0 = (out.get("candidates") or [None])[0]
            out["best"] = {"recommended": c0} if c0 else {}
        return out
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
         "etf_name": "宽基ETF",
         "title": "【测试】国家队护盘信号增强（2/2 只净流入）",
         "text": "第三条测试告警（critical）：宽基ETF近5分钟主力合计净流入 4.40亿，护盘评分 72。",
         "etfs": [
             {"code": "510300", "name": "沪深300ETF华泰柏瑞", "main_inflow": 320000000,
              "main_total": 4.1, "pct": 0.82, "surge": 2.1, "vol_ratio": 2.1},
             {"code": "510050", "name": "上证50ETF华夏", "main_inflow": 120000000,
              "main_total": 1.2, "pct": 0.41, "surge": None, "vol_ratio": 1.4},
         ]},
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


@router.get("/expiry")
async def expiry_view():
    """合约到期日历：当月 / 下月 / 随后两个季月的到期日与倒计时、临期级别。

    零新数据源：月份序列与「到期月第 4 个星期三」均由纯决策模块算出。
    """
    today = dt.date.today()
    rows = decision.expiry_calendar(today)
    for row in rows:
        row["level"] = decision.near_expiry_level(row["days_left"])
    return {"today": today.isoformat(), "items": rows,
            "critical_days": decision.CRITICAL_DAYS,
            "warning_days": decision.WARNING_DAYS}


@router.get("/settings")
async def settings_view():
    """用户设置：总资金与单笔风险%（存 data/settings.json，不进 git 历史）。"""
    return usv.view(usv.load())


@router.put("/settings")
async def settings_update(payload: dict):
    """写入用户设置。非法输入拒绝并给出原因，不落盘。"""
    settings, errors = usv.parse(payload)
    if errors:
        return {"error": "；".join(errors), "errors": errors}
    if not usv.save(settings):
        return {"error": "设置写入失败"}
    return usv.view(settings)
