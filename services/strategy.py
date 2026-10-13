"""日内信号引擎与交易计划：方向判定、关键时点、量能/资金异动、MACD 背离、买卖点与止盈止损。"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import time

from services import kronos, market_service as ms, option_service as osvc
from services.indicators import atr, macd_state, pct_change, support_resistance, volume_stats
from services.universe import ETF_BY_CODE, TRACK_INDEX

log = logging.getLogger("strategy")

_NT_CACHE: tuple[float, dict] | None = None
_NT_TTL = 20


async def national_team_cached() -> dict:
    global _NT_CACHE
    now = time.time()
    if _NT_CACHE and now - _NT_CACHE[0] < _NT_TTL:
        return _NT_CACHE[1]
    data = await ms.national_team_signal()
    _NT_CACHE = (now, data)
    return data


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
                   kronos_sum: dict | None) -> list[dict]:
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
    if vs.get("is_surge"):
        sig.append({"type": "volume_surge", "level": "warn", "dir": "neutral",
                    "text": f"标的量能放大 {vs['ratio']}x（近5分钟 vs 日内均量）"})

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

    # MACD
    mm = etf_ctx.get("macd") or {}
    if mm.get("cross") == "golden":
        sig.append({"type": "macd", "level": "info", "dir": "bull", "text": "1分钟 MACD 金叉"})
    elif mm.get("cross") == "dead":
        sig.append({"type": "macd", "level": "info", "dir": "bear", "text": "1分钟 MACD 死叉"})
    if (mm.get("divergence") or {}).get("type") == "bearish":
        sig.append({"type": "divergence", "level": "warn", "dir": "bear", "text": "1分钟 MACD 顶背离，上涨动能不足"})
    elif (mm.get("divergence") or {}).get("type") == "bullish":
        sig.append({"type": "divergence", "level": "warn", "dir": "bull", "text": "1分钟 MACD 底背离，下跌动能衰竭"})

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


def bias_score(etf_ctx, track, national, ext, kronos_sum) -> dict:
    """多因子方向评分 [-100,100]，>0 偏多。"""
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
    # 国家队（权重 15，护盘偏多）
    nt = national.get("score", 0)
    if nt >= 40:
        v = 15 * min(nt / 100, 1)
        score += v; detail["国家队护盘"] = round(v, 1)
    # Kronos（权重 20）
    if kronos_sum and kronos_sum.get("ok") and kronos_sum.get("pred_pct") is not None:
        v = max(-20, min(20, kronos_sum["pred_pct"] * 20))
        score += v; detail["Kronos预测"] = round(v, 1)
    # 外围（权重 10）
    ext_score = 0.0
    for e in ext:
        if e.get("key") in ("ndx", "spx", "dji", "hsi") and e.get("pct") is not None:
            ext_score += e["pct"]
    if ext_score:
        v = max(-10, min(10, ext_score * 3))
        score += v; detail["外围市场"] = round(v, 1)

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
    # 合约层硬止损：-30%
    hard_stop = round(cur * 0.70, 4)
    stop = max(stop, hard_stop) if und_levels["side"] == "long" else stop
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
    chain, etf_ctx, national, ext = await asyncio.gather(
        osvc.chain(etf_code),
        ms.etf_context(etf_code, etf["secid"]),
        national_team_cached(),
        ms.external_snapshot(),
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

    signals = detect_signals(etf_ctx, track, national, ext, kronos_sum)
    bias = bias_score(etf_ctx, track, national, ext, kronos_sum)
    plan_dir = bias["direction"] if bias["direction"] != "neutral" else (
        "call" if bias["score"] >= 0 else "put")
    levels = plan_levels(etf_ctx, plan_dir)

    s_now = (chain.get("underlying") or {}).get("price") or 0
    candidates = osvc.rank_candidates(chain, bias["direction"] if bias["direction"] != "neutral" else "auto", top=6)
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
        "national_team": national,
        "external": ext,
        "volume": etf_ctx.get("volume"),
        "macd": etf_ctx.get("macd"),
        "flow_main_delta5m": etf_ctx.get("flow_main_delta5m"),
        "ts": dt.datetime.now().isoformat(timespec="seconds"),
    }
