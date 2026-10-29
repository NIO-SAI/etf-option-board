"""日内信号引擎与交易计划：方向判定、关键时点、量能/资金异动、MACD 背离、买卖点与止盈止损。"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import time

from services import (decision, index_levels, kronos, market_service as ms, market_turnover,
                      option_service as osvc, user_settings as usv)
from services.indicators import atr, macd_state, pct_change, support_resistance, volume_stats
from services.universe import ETF_BY_CODE, ETFS, TRACK_INDEX

log = logging.getLogger("strategy")

_NT_CACHE: tuple[float, dict] | None = None
_NT_TTL = 30

_DIR_CACHE: tuple[float, dict] | None = None
_DIR_TTL = 60


async def national_team_cached() -> dict:
    global _NT_CACHE
    now = time.time()
    if _NT_CACHE and now - _NT_CACHE[0] < _NT_TTL:
        return _NT_CACHE[1]
    data = await ms.national_team_signal()
    _NT_CACHE = (now, data)
    return data


async def directions() -> dict:
    """全部标的的实时方向（看多/看空/观望）。轻量：不含 Kronos，带 60s 缓存。"""
    global _DIR_CACHE
    now = time.time()
    if _DIR_CACHE and now - _DIR_CACHE[0] < _DIR_TTL:
        return _DIR_CACHE[1]
    national, ext, idx_lv, turnover = await asyncio.gather(
        national_team_cached(), ms.external_snapshot(), index_levels.snapshot(),
        market_turnover.snapshot())

    async def one(etf: dict) -> tuple[str, dict]:
        try:
            ctx, track = await asyncio.gather(
                ms.etf_context(etf["code"], etf["secid"]),
                ms.track_index_state(etf["track"]),
            )
            b = bias_score(ctx, track, national, ext, None, idx_lv, turnover)
            return etf["code"], {"direction": b["direction"], "score": b["score"],
                                 "confidence": b["confidence"]}
        except Exception as exc:  # noqa: BLE001
            log.debug("direction 计算失败 %s: %s", etf.get("code"), exc)
            return etf["code"], {"direction": "neutral", "score": 0, "confidence": 0}

    out = dict(await asyncio.gather(*[one(e) for e in ETFS]))
    _DIR_CACHE = (now, out)
    return out


def _now_hm() -> str:
    return dt.datetime.now().strftime("%H:%M")


def near_key_time(now_hm: str, window: int = 6) -> str | None:
    """是否临近关键变盘时点（分钟窗口）。"""
    h, m = map(int, now_hm.split(":"))
    cur = h * 60 + m
    for kt in ("10:30", "11:30", "13:00", "14:30"):
        kh, km = map(int, kt.split(":"))
        if abs(cur - (kh * 60 + km)) <= window:
            return kt
    return None


def detect_signals(etf_ctx: dict, track: dict, national: dict, ext: list[dict],
                   kronos_sum: dict | None, idx_levels: dict | None = None,
                   turnover: dict | None = None) -> list[dict]:
    """产出带类型/方向/强度的信号列表。"""
    sig: list[dict] = []
    q = etf_ctx.get("quote") or {}
    if not q:
        return sig
    k1 = etf_ctx.get("kline_1m") or []
    closes = [b["close"] for b in k1]
    vols = [b["volume"] for b in k1]

    # 量能异动
    vs = etf_ctx.get("volume") or {}
    if vs.get("confirmed"):
        mv = vs.get("move_pct") or 0.0
        by_price = vs.get("confirmed_by") == "price"
        sig.append({"type": "volume_surge", "level": "warn",
                    "dir": ("bull" if mv > 0 else "bear") if by_price else "neutral",
                    "text": f"标的量价配合，量能放大 {vs['ratio']}x（近1分钟 vs 近60分钟均量）"})

    # 主力资金突入
    d5 = etf_ctx.get("flow_main_delta5m") or 0
    if abs(d5) > 8e7:
        sig.append({"type": "main_inflow", "level": "warn",
                    "dir": "bull" if d5 > 0 else "bear",
                    "text": f"主力资金近5分钟净{'流入' if d5>0 else '流出'} {abs(d5)/1e8:.2f} 亿"})

    # 价格突动
    p3 = pct_change(closes, 3)
    if p3 is not None and abs(p3) > 0.6:
        sig.append({"type": "price_spike", "level": "warn",
                    "dir": "bull" if p3 > 0 else "bear",
                    "text": f"标的3分钟急{'拉' if p3>0 else '跌'} {p3:+.2f}%"})

    # MACD（金叉/死叉看 1 分钟；背离看 15 分钟 K 线）
    mm = etf_ctx.get("macd") or {}
    if mm.get("cross") == "golden":
        sig.append({"type": "macd", "level": "info", "dir": "bull", "text": "1分钟 MACD 金叉"})
    elif mm.get("cross") == "dead":
        sig.append({"type": "macd", "level": "info", "dir": "bear", "text": "1分钟 MACD 死叉"})
    md15 = (etf_ctx.get("macd15") or {}).get("divergence") or {}
    if md15.get("type") == "bearish":
        sig.append({"type": "divergence", "level": "warn", "dir": "bear", "text": "15分钟 MACD 顶背离，上涨动能不足"})
    elif md15.get("type") == "bullish":
        sig.append({"type": "divergence", "level": "warn", "dir": "bull", "text": "15分钟 MACD 底背离，下跌动能衰竭"})

    # 关键时点
    kt = near_key_time(_now_hm())
    if kt:
        sig.append({"type": "key_time", "level": "info", "dir": "neutral", "text": f"临近变盘时点 {kt}"})

    # 国家队护盘
    if national.get("score", 0) >= 40:
        sig.append({"type": "national_team", "level": "warn", "dir": "bull",
                    "text": f"国家队护盘信号：{national['level']}（{national['score']}分，放量{national['surge_count']}只）"})

    # 指数支撑
    sup = (track.get("support") or {})
    if sup.get("at_support"):
        sig.append({"type": "index_support", "level": "info", "dir": "bull",
                    "text": f"关联指数 {track.get('quote',{}).get('name','')} 逼近支撑（距MA20 {sup.get('dist_ma20_pct')}%）"})

    # 上证关键位（≥8 分或突破/跌破才点名具体位；状态型信号，不做时间去重）
    idx_text = index_levels.factor_text(idx_levels or {})
    if idx_text:
        lv = idx_levels or {}
        direction = "bear" if lv.get("breakdown") or (lv.get("total") or 0) < 0 else "bull"
        sig.append({"type": "index_levels", "level": "warn", "dir": direction,
                    "text": idx_text})

    # 两市成交额放量/缩量（市场级量能，与前一日全天对比）
    tt = market_turnover.factor_text(turnover or {})
    if tt:
        tv = (turnover or {}).get("factor") or 0
        sig.append({"type": "market_turnover", "level": "info",
                    "dir": "bull" if tv > 0 else "bear" if tv < 0 else "neutral",
                    "text": tt})

    # 外围
    for e in ext:
        if e.get("pct") is not None and abs(e["pct"]) >= 1.5:
            sig.append({"type": "external", "level": "info",
                        "dir": "bull" if e["pct"] > 0 else "bear",
                        "text": f"{e['name_cn']} {e['pct']:+.2f}%（外围扰动）"})

    # Kronos
    if kronos_sum and kronos_sum.get("ok"):
        sig.append({"type": "kronos", "level": "info",
                    "dir": "bull" if kronos_sum["bias"] == "up" else "bear" if kronos_sum["bias"] == "down" else "neutral",
                    "text": f"Kronos 预测未来 {len(kronos_sum['path'])} 根：{kronos_sum['pred_pct']:+.2f}%（看{'涨' if kronos_sum['bias']=='up' else '跌' if kronos_sum['bias']=='down' else '平'}）"})
    return sig


def bias_score(etf_ctx, track, national, ext, kronos_sum, idx_levels=None,
               turnover=None) -> dict:
    """多因子方向评分 [-100,100]，>0 看多。

    含「变盘点」加分（reversal.factor，±15，60 分钟衰减）：5m/15m 高周期转折点作为
    条件并入方向合力，而非单独提醒。
    """
    score = 0.0
    detail = {}
    q = etf_ctx.get("quote") or {}
    closes = [b["close"] for b in (etf_ctx.get("kline_1m") or [])]

    # 标的日内动量（权重 25）
    mom = pct_change(closes, 5)
    if mom is not None:
        v = max(-25, min(25, mom * 25))
        score += v
        detail["标的5分钟动量"] = round(v, 1)
    # 收盘 vs 均价（权重 10）
    tr = etf_ctx.get("trends") or []
    if tr and tr[-1].get("avg"):
        v = max(-10, min(10, (tr[-1]["price"] / tr[-1]["avg"] - 1) * 100 * 3))
        score += v
        detail["价格vs均价"] = round(v, 1)
    # 关联指数动量（权重 20）
    qi = (track.get("quote") or {})
    if qi.get("pct") is not None:
        v = max(-20, min(20, qi["pct"] * 12))
        score += v
        detail["关联指数"] = round(v, 1)
    # 指数 MACD（权重 10）
    tm = track.get("macd") or {}
    if tm.get("cross") == "golden":
        score += 10; detail["指数MACD金叉"] = 10
    elif tm.get("cross") == "dead":
        score -= 10; detail["指数MACD死叉"] = -10
    # 国家队（权重 15，护盘看多）
    nt = national.get("score", 0)
    if nt >= 40:
        v = 15 * min(nt / 100, 1)
        score += v; detail["国家队护盘"] = round(v, 1)
    # Kronos（权重 20）
    if kronos_sum and kronos_sum.get("ok") and kronos_sum.get("pred_pct") is not None:
        v = max(-20, min(20, kronos_sum["pred_pct"] * 20))
        score += v; detail["Kronos预测"] = round(v, 1)
    # 指数关键位（上证 20 日高低/整百关口/均线排列，内部求和后 clamp ±15）
    lv_total = (idx_levels or {}).get("total") or 0
    if lv_total:
        score += lv_total
        detail["指数关键位"] = round(lv_total, 1)
    # 外围（权重 10）
    ext_score = 0.0
    for e in ext:
        if e.get("key") in ("ndx", "spx", "dji", "hsi") and e.get("pct") is not None:
            ext_score += e["pct"]
    if ext_score:
        v = max(-10, min(10, ext_score * 3))
        score += v; detail["外围市场"] = round(v, 1)
    # 市场总成交额（两市成交额折算全天 vs 前一日，量价配合 ±10）
    tv = (turnover or {}).get("factor") or 0
    if tv:
        score += tv
        detail["市场总成交额"] = round(tv, 1)
    # 变盘点（5m/15m 高周期转折，权重 15）：当日已确认转折点并入方向合力，60 分钟内衰减。
    # 这是「变盘时间点作为条件参与趋势方向分析」的落点——不再单独刷屏，而是加权到方向结论。
    from services import reversal  # 延迟导入，避免与 reversal→strategy 循环依赖
    rev_v, rev_label = reversal.factor(etf_ctx.get("code"))
    if rev_v:
        score += rev_v
        detail[f"变盘点·{rev_label}"] = round(rev_v, 1)

    score = round(max(-100, min(100, score)), 1)
    direction = "call" if score >= 15 else "put" if score <= -15 else "neutral"
    conf = min(abs(score) / 100, 1)
    return {"score": score, "direction": direction, "confidence": round(conf, 2), "detail": detail}


def plan_levels(etf_ctx, direction: str) -> dict:
    """基于标的日内结构给出入场/止损/止盈（标的层面），再折算到合约。"""
    k1 = etf_ctx.get("kline_1m") or []
    if not k1:
        return {}
    closes = [b["close"] for b in k1]
    highs = [b["high"] for b in k1]
    lows = [b["low"] for b in k1]
    a = atr(k1, 14) or (max(highs) - min(lows)) * 0.02
    sr = support_resistance(closes, highs, lows)
    last = closes[-1]
    # 近 15 分钟高低
    h15 = max(highs[-15:]) if len(highs) >= 15 else max(highs)
    l15 = min(lows[-15:]) if len(lows) >= 15 else min(lows)

    if direction == "call":
        entry = round(h15, 4)                 # 突破近端高点入场
        pullback = round(max(last - 0.5 * a, l15 + 0.3 * a), 4)
        stop = round(min(l15 - 0.5 * a, last - 1.5 * a), 4)
        target = round(entry + 2 * (entry - stop), 4)
        return {"side": "long", "entry_break": entry, "entry_pullback": pullback,
                "stop": stop, "target": target, "atr": round(a, 4),
                "day_high": sr.get("day_high"), "day_low": sr.get("day_low")}
    if direction == "put":
        entry = round(l15, 4)                 # 跌破近端低点入场
        pullback = round(min(last + 0.5 * a, h15 - 0.3 * a), 4)
        stop = round(max(h15 + 0.5 * a, last + 1.5 * a), 4)
        target = round(entry - 2 * (stop - entry), 4)
        return {"side": "short", "entry_break": entry, "entry_pullback": pullback,
                "stop": stop, "target": target, "atr": round(a, 4),
                "day_high": sr.get("day_high"), "day_low": sr.get("day_low")}
    return {"side": "flat", "note": "方向不明，观望"}


def chain_for_month(chain_data: dict, month: int | None) -> dict:
    """按合约月份过滤链（``osvc.chain()`` 返回全部月份，月份筛选在调用方做）。"""
    if not month:
        return chain_data
    return {**chain_data,
            "contracts": [c for c in (chain_data.get("contracts") or [])
                          if c.get("month") == month]}


def mid_or_last(contract: dict | None) -> float | None:
    """合约参考价：能拿到买一卖一时取中值，否则退回最新价。"""
    if not contract:
        return None
    bid, ask, last = contract.get("bid"), contract.get("ask"), contract.get("last")
    if bid and ask:
        return round((bid + ask) / 2, 4)
    return last or None


def vertical_short_leg(long_leg: dict | None, chain_data: dict, direction: str) -> dict | None:
    """垂直价差的对腿：同一到期月、同一方向、更虚值一档。

    看多 -> 卖出更高行权价的认购；看空 -> 卖出更低行权价的认沽。
    都对腿不可得时返回 None，由调用方降级处理。
    """
    if not long_leg or direction not in ("call", "put"):
        return None
    side = long_leg.get("type")
    month = long_leg.get("month")
    strike = long_leg.get("strike") or 0
    pool = [c for c in (chain_data.get("contracts") or [])
            if c.get("type") == side and c.get("month") == month
            and c.get("strike") and mid_or_last(c) is not None]
    if direction == "call":
        further = sorted((c for c in pool if c["strike"] > strike),
                         key=lambda c: c["strike"])
    else:
        further = sorted((c for c in pool if c["strike"] < strike),
                         key=lambda c: c["strike"], reverse=True)
    return further[0] if further else None


def contract_levels(contract: dict, und_levels: dict, s_now: float) -> dict:
    """把标的点位用 delta 折算为合约买卖点与止盈止损。"""
    if not contract or not und_levels:
        return {}
    if und_levels.get("entry_break") is None or und_levels.get("stop") is None \
            or und_levels.get("target") is None:
        return {}
    delta = contract.get("delta") or 0
    cur = contract.get("last")
    if not cur or not delta:
        return {}
    def px(s_target):
        return round(max(cur + delta * (s_target - s_now), 0.0001), 4)
    entry = px(und_levels.get("entry_break"))
    stop = px(und_levels.get("stop"))
    target = px(und_levels.get("target"))
    # 合约层硬止损：相对入场价 -30%，认购/认沽双向生效
    # （标的触及止损位时合约价恒低于入场价，故 stop 取两者较高者即收紧到 -30%）
    hard_stop = round(entry * 0.70, 4)
    stop = max(stop, hard_stop)
    return {
        "contract": contract.get("name"), "code": contract.get("code"),
        "current": cur, "delta": delta,
        "entry": entry, "stop": stop, "target": target,
        "entry_pct": round((entry / cur - 1) * 100, 1) if entry else None,
        "stop_pct": round((stop / cur - 1) * 100, 1) if stop else None,
        "target_pct": round((target / cur - 1) * 100, 1) if target else None,
    }


async def analyze(etf_code: str, with_kronos: bool = True, klt: int = 1) -> dict:
    etf = ETF_BY_CODE.get(etf_code)
    if not etf:
        return {"error": f"未知标的 {etf_code}"}
    chain, etf_ctx, national, ext, idx_lv, turnover = await asyncio.gather(
        osvc.chain(etf_code),
        ms.etf_context(etf_code, etf["secid"]),
        national_team_cached(),
        ms.external_snapshot(),
        index_levels.snapshot(),
        market_turnover.snapshot(),
    )
    track = await ms.track_index_state(etf["track"])

    kronos_sum = None
    if with_kronos:
        freq = {1: "1m", 3: "3m", 5: "5m"}.get(klt, "1m")
        bars = etf_ctx.get("kline_1m") or []
        if len(bars) >= 60:
            pred = await kronos.predict(bars, lookback=min(len(bars), 120),
                                        pred_len=20, frequency=freq)
            kronos_sum = kronos.summarize(pred, bars[-1]["close"])

    signals = detect_signals(etf_ctx, track, national, ext, kronos_sum, idx_lv, turnover)
    bias = bias_score(etf_ctx, track, national, ext, kronos_sum, idx_lv, turnover)
    plan_dir = bias["direction"] if bias["direction"] != "neutral" else (
        "call" if bias["score"] >= 0 else "put")
    levels = plan_levels(etf_ctx, plan_dir)

    s_now = (chain.get("underlying") or {}).get("price") or 0

    # ── 决策层：到期约束 → 策略类型 → 手数上限 → 撜口与限额 ─────────────
    us = usv.load()
    today = dt.date.today()
    calendar_rows = decision.expiry_calendar(today)
    front_days = calendar_rows[0]["days_left"] if calendar_rows else None
    next_days = calendar_rows[1]["days_left"] if len(calendar_rows) > 1 else None
    iv_pct = (chain.get("stats") or {}).get("atm_iv_pctl20")

    strat = decision.select_strategy(bias["direction"], iv_pct,
                                     days_to_expiry=front_days, next_month_days=next_days)

    # 临期时整体改推次月（ticket 08）：只影响「新开仓」建议
    target_month = None
    if strat.get("month") == "next" and len(calendar_rows) > 1:
        target_month = calendar_rows[1]["month"]
    work_chain = chain_for_month(chain, target_month)
    rank_dir = bias["direction"] if bias["direction"] != "neutral" else "auto"
    candidates = osvc.rank_candidates(work_chain, rank_dir, top=6)

    if strat.get("month") == "next" and not candidates:
        strat = {**strat, "strategy": decision.STRATEGY_WAIT,
                 "label": decision.STRATEGY_LABELS[decision.STRATEGY_WAIT],
                 "no_alternative": True,
                 "reason": f"{strat['reason']} 次月无可用合约，建议观望。"}

    best = candidates[0] if candidates else None
    vertical_dir = {"bull_call": "call", "bear_put": "put"}.get(strat.get("vertical_kind"))

    # 垂直价差：找对腿，算行权价宽度与净权利金（正=收到，负=付出）
    short_leg = vertical_short_leg(best, work_chain, vertical_dir) if vertical_dir else None
    width = credit = None
    if short_leg and best:
        width = round(abs((short_leg.get("strike") or 0) - (best.get("strike") or 0)), 4)
        long_px, short_px = mid_or_last(best), mid_or_last(short_leg)
        if long_px and short_px:
            credit = round(short_px - long_px, 4)

    if strat["strategy"] == decision.STRATEGY_VERTICAL and short_leg is None:
        # 对腿不可用则退回单腿，保证手数仍可算（不要因缺一条腿而丢掉风控）
        single = (decision.STRATEGY_SINGLE_CALL if bias["direction"] == "call"
                  else decision.STRATEGY_SINGLE_PUT)
        strat = {**strat, "strategy": single, "label": decision.STRATEGY_LABELS[single],
                 "vertical_kind": None, "degraded_vertical": True,
                 "reason": f"{strat['reason']} 同月份对腿不可用，退回单腿买入。"}

    # 手数上限：单腿按权利金全额，价差按宽度与净权利金
    if strat["strategy"] == decision.STRATEGY_VERTICAL:
        loss_per = decision.max_loss_per_contract("vertical", width=width, net_credit=credit)
    elif best:
        loss_per = decision.max_loss_per_contract("single", premium=mid_or_last(best))
    else:
        loss_per = None
    budget = decision.risk_budget(us.get("total_capital"), us.get("risk_pct"))
    position = decision.max_contracts(budget, loss_per)

    # 撜口与限额（撜口是估算值，见 docs/adr/0001）
    unit = None
    if best:
        unit = {"premium": mid_or_last(best), "delta": best.get("delta"),
                "price": s_now, "theta": best.get("theta"), "vega": best.get("vega")}
    exposure = decision.exposure_notional(us.get("tier"), us.get("size"),
                                         us.get("total_capital"), unit=unit)
    lim = decision.limits(us.get("risk_pct"), us.get("total_capital"))
    limit_check = decision.check_limits(exposure, lim,
                                        per_contract_delta=exposure.get("per_contract_delta"))

    plans = [contract_levels(c, levels, s_now) for c in candidates[:3]]

    return {
        "etf": etf,
        "underlying": chain.get("underlying"),
        "chain_stats": chain.get("stats"),
        "front_month": chain.get("front_month"),
        "bias": bias,
        "signals": signals,
        "levels": levels,
        "plans": [p for p in plans if p],
        "candidates": [{k: v for k, v in c.items() if not k.startswith("_")} for c in candidates],
        "kronos": kronos_sum,
        "track": {"quote": track.get("quote"), "support": track.get("support"), "macd": track.get("macd")},
        "index_levels": idx_lv,
        "market_turnover": turnover,
        "national_team": national,
        "external": ext,
        "volume": etf_ctx.get("volume"),
        "macd": etf_ctx.get("macd"),
        "macd15": etf_ctx.get("macd15"),
        "flow_main_delta5m": etf_ctx.get("flow_main_delta5m"),
        # ── 本次新增的决策层输出 ──
        "strategy": strat,
        "expiry": {
            "today": today.isoformat(),
            "rows": calendar_rows,
            "front_days": front_days,
            "next_days": next_days,
            "level": decision.near_expiry_level(front_days),
            "target_month": target_month,
            "excluded_front": bool(strat.get("excluded_front")),
        },
        "position": position,
        "exposure": exposure,
        "limits": lim,
        "limit_check": limit_check,
        "settings": us,
        "vertical": ({"short_leg": {"name": short_leg.get("name"),
                                    "code": short_leg.get("code"),
                                    "strike": short_leg.get("strike"),
                                    "month": short_leg.get("month")},
                      "width": width, "net_credit": credit} if short_leg else None),
        "ts": dt.datetime.now().isoformat(timespec="seconds"),
    }
