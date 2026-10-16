"""变盘开仓信号引擎：多因子打分，识别日内明确转折点并给出可执行建议。

设计依据（CONTEXT.md §7）：
- 验真突破 = 放量 + 主力净流入 + 突破前高/跌破前低（§7.10）
- 10:30–11:30、13:00–14:30 变盘概率高；14:45 后不新开仓（§7.6）
- 买方宜在 IV 偏低时进（§7.3）；先定止损再进场（§7.7）

打分（多/空各一套，0~100）：
  1m MACD 金叉/死叉             +25
  1m 动能转强（柱体3连升/降）    +12
  3m MACD 确认（金叉/柱体翻正）  +20
  3m 柱体同向                   +10
  5m 趋势配合                   +10
  突破/跌破近15分钟高低点        +15
  站上/跌破分时均价              +5
  量能放大≥2x                   +10（≥3x +15）
  主力5分钟同向≥0.5亿            +10（≥1.2亿 +15）
  关联指数同向                  +10
  3m 顶/底背离                  +10
  关键时点共振（±6分钟）          +5
55 分触发。过滤：09:40 前 / 14:45 后不触发；同向 20 分钟冷却；
反向 15 分钟内抑制（防震荡反复打脸）。
"""

from __future__ import annotations

import datetime as dt
import logging
from collections import deque

from services import alerts, option_service as osvc, strategy
from services.indicators import macd, macd_state

log = logging.getLogger("reversal")

THRESHOLD = 55          # 触发阈值（噪音场景实测 <30，明确反转约 57~75）
TRACK_FETCH_SCORE = 45  # 达到此分才拉关联指数做确认（省请求）
COOLDOWN_SAME = 1200    # 同标的同方向冷却 20 分钟
COOLDOWN_OPPO = 900     # 反向抑制 15 分钟（防震荡）
TIME_START = "09:40"     # 开盘前 10 分钟噪音，不发信号
TIME_END = "14:45"       # 临近收盘不新开仓

_signals: dict[str, deque] = {}          # code -> deque[signal记录]
_last: dict[str, tuple[str, float]] = {}  # code -> (方向, 时间戳)


def _agg_closes(closes: list[float], n: int) -> list[float]:
    """按 n 分钟聚合收盘价（取每组最后一根，用于算高周期 MACD）。"""
    return [seg[-1] for seg in
            (closes[i:i + n] for i in range(0, len(closes), n)) if seg]


def _recent_cross(closes: list[float], lookback: int) -> str | None:
    """近 lookback 根内是否出现金叉/死叉（监控 30 秒一轮，不能只认当根）。"""
    md = macd(closes)
    dif, dea = md["dif"], md["dea"]
    if len(dif) < lookback + 1:
        return None
    for i in range(len(dif) - 1, len(dif) - 1 - lookback, -1):
        if dif[i] > dea[i] and dif[i - 1] <= dea[i - 1]:
            return "golden"
        if dif[i] < dea[i] and dif[i - 1] >= dea[i - 1]:
            return "dead"
    return None


def _score_side(ctx: dict, track: dict | None, side: str) -> tuple[float, list[str]]:
    """side: 'bull' | 'bear'。返回 (分数, 触发因子描述)。"""
    bull = side == "bull"
    k1 = ctx.get("kline_1m") or []
    closes = [b["close"] for b in k1]
    highs = [b["high"] for b in k1]
    lows = [b["low"] for b in k1]
    m1 = ctx.get("macd") or {}
    m3 = ctx.get("macd3") or {}
    m5 = macd_state(_agg_closes(closes, 5)) if len(closes) >= 60 else {}
    s = 0.0
    hits: list[str] = []

    # 1m MACD：近3根内金叉/死叉，或动能转强
    rc1 = _recent_cross(closes, 3)
    if (bull and rc1 == "golden") or (not bull and rc1 == "dead"):
        s += 25
        hits.append("1m" + ("金叉" if bull else "死叉"))
    elif m1.get("ok") and ((bull and m1.get("hist_rising")) or
                             (not bull and m1.get("hist_falling"))):
        s += 12
        hits.append("1m动能转强")
    # 3m 确认：近2根内金叉/死叉，或柱体翻正/翻负
    closes3 = _agg_closes(closes, 3)
    rc3 = _recent_cross(closes3, 2)
    if (bull and rc3 == "golden") or (not bull and rc3 == "dead"):
        s += 20
        hits.append("3m确认")
    elif m3.get("ok") and ((bull and m3.get("hist_rising") and (m3.get("hist") or 0) > 0) or
                             (not bull and m3.get("hist_falling") and (m3.get("hist") or 0) < 0)):
        s += 20
        hits.append("3m柱体翻正" if bull else "3m柱体翻负")
    elif m3.get("ok") and ((bull and m3.get("hist_rising")) or
                             (not bull and m3.get("hist_falling"))):
        s += 10
        hits.append("3m柱体同向")
    # 5m 趋势配合
    if m5.get("ok") and ((bull and (m5.get("hist_rising") or m5.get("above_zero"))) or
                           (not bull and (m5.get("hist_falling") or not m5.get("above_zero")))):
        s += 10
        hits.append("5m趋势配合")
    # 突破/跌破近15分钟高低点
    if len(closes) >= 16:
        ref = max(highs[-16:-1]) if bull else min(lows[-16:-1])
        last = closes[-1]
        if (bull and last > ref) or (not bull and last < ref):
            s += 15
            hits.append(f"突破15分钟{'高' if bull else '低'}{ref:.3f}")
    # 分时均价
    tr = ctx.get("trends") or []
    if tr and tr[-1].get("avg"):
        px, avg = tr[-1]["price"], tr[-1]["avg"]
        if (bull and px > avg) or (not bull and px < avg):
            s += 5
            hits.append("站上均价" if bull else "跌破均价")
    # 量能
    ratio = (ctx.get("volume") or {}).get("ratio") or 0
    if ratio >= 3.0:
        s += 15
        hits.append(f"放量{ratio:.1f}x")
    elif ratio >= 2.0:
        s += 10
        hits.append(f"放量{ratio:.1f}x")
    # 主力资金
    d5 = ctx.get("flow_main_delta5m") or 0
    if (bull and d5 >= 1.2e8) or (not bull and d5 <= -1.2e8):
        s += 15
        hits.append(f"主力{'流入' if bull else '流出'}{abs(d5) / 1e8:.1f}亿")
    elif (bull and d5 >= 5e7) or (not bull and d5 <= -5e7):
        s += 10
        hits.append(f"主力{'流入' if bull else '流出'}{abs(d5) / 1e8:.1f}亿")
    # 关联指数同向
    if track:
        qp = (track.get("quote") or {}).get("pct")
        tm = (track.get("macd") or {}).get("cross")
        if qp is not None and ((bull and qp > 0.1) or (not bull and qp < -0.1)) \
                and (bull and tm != "dead" or not bull and tm != "golden"):
            s += 10
            hits.append(f"指数同向{qp:+.2f}%")
    # 背离（反转起点加分）
    div = (m3.get("divergence") or {}).get("type")
    if (bull and div == "bullish") or (not bull and div == "bearish"):
        s += 10
        hits.append("3m底背离" if bull else "3m顶背离")
    # 关键时点共振
    if strategy.near_key_time(dt.datetime.now().strftime("%H:%M"), window=6):
        s += 5
        hits.append("关键时点共振")
    return round(s, 1), hits


async def _build_plan(etf: dict, ctx: dict, side: str, score: float,
                      hits: list[str]) -> dict:
    """组装开仓建议：方向 / 标的点位 / 优选合约 / IV 提示。"""
    direction = "call" if side == "bull" else "put"
    cn_dir = "看多" if side == "bull" else "看空"       # 方向（观点）词：全站统一「看多/看空/观望」
    cn_type = "认购" if side == "bull" else "认沽"      # 合约类型：只用于描述合约，勿与方向混用
    q = ctx.get("quote") or {}
    last = q.get("price")
    levels = strategy.plan_levels(ctx, direction)
    entry_s = levels.get("entry_break")
    stop_s = levels.get("stop")
    target_s = levels.get("target")

    contract_txt = "合约：暂无"
    contract = None
    iv_note = ""
    try:
        chain = await osvc.chain(etf["code"])
        cands = osvc.rank_candidates(chain, direction, top=3)
        s_now = (chain.get("underlying") or {}).get("price") or last or 0
        if cands and entry_s and stop_s and target_s:
            cl = strategy.contract_levels(cands[0], levels, s_now)
            if cl:
                contract = cl
                contract_txt = (
                    f"{cn_type}合约{cl['contract']} Δ{cl['delta']:.2f}："
                    f"入场{cl['entry']:.4f} / 止损{cl['stop']:.4f}({cl['stop_pct']:+.0f}%) / "
                    f"目标{cl['target']:.4f}"
                )
        pctl = (chain.get("stats") or {}).get("atm_iv_pctl20")
        if pctl is not None:
            iv_note = (f"IV分位{pctl:.0f}%偏高，权利金贵，降仓位"
                       if pctl >= 80 else f"IV分位{pctl:.0f}%")
    except Exception as exc:  # noqa: BLE001
        log.debug("变盘信号合约优选失败 %s: %s", etf["code"], exc)

    under_txt = "标的：—"
    if last and entry_s and stop_s and target_s:
        under_txt = (f"标的{last:.3f}：突破{entry_s:.3f}入场 / "
                     f"止损{stop_s:.3f} / 目标{target_s:.3f}")
    parts = [f"方向{cn_dir}（{score:.0f}分）", "·".join(hits), under_txt,
             contract_txt]
    if iv_note:
        parts.append(iv_note)
    return {"text": "｜".join(parts), "contract": contract,
            "underlying_price": last}


async def check(etf: dict, ctx: dict) -> dict | None:
    """评估变盘信号；达阈值且通过过滤则返回告警 dict，否则 None。"""
    from services import market_service as ms  # 延迟导入，避免循环
    code, name = etf["code"], etf["name"]
    hm = dt.datetime.now().strftime("%H:%M")
    if not (TIME_START <= hm < TIME_END):
        return None
    k1 = ctx.get("kline_1m") or []
    if len(k1) < 40:
        return None
    # 数据新鲜度：最后一根 1m K 距现在 ≤20 分钟（防用过期缓存误报）
    try:
        last_ts = dt.datetime.strptime(k1[-1]["date"], "%Y-%m-%d %H:%M")
        if (dt.datetime.now() - last_ts).total_seconds() > 1200:
            return None
    except (ValueError, KeyError):
        pass

    sb, hb = _score_side(ctx, None, "bull")
    ss, hs = _score_side(ctx, None, "bear")
    if max(sb, ss) >= TRACK_FETCH_SCORE:
        try:
            track = await ms.track_index_state(etf["track"])
        except Exception:  # noqa: BLE001
            track = None
        sb, hb = _score_side(ctx, track, "bull")
        ss, hs = _score_side(ctx, track, "bear")

    side, score, hits = None, 0.0, []
    if sb >= THRESHOLD and sb >= ss:
        side, score, hits = "bull", sb, hb
    elif ss >= THRESHOLD and ss > sb:
        side, score, hits = "bear", ss, hs
    if not side:
        return None

    # 冷却 / 反向抑制（防震荡反复打脸）
    now_ts = dt.datetime.now().timestamp()
    last = _last.get(code)
    if last:
        ldir, lts = last
        if ldir == side and now_ts - lts < COOLDOWN_SAME:
            return None
        if ldir != side and now_ts - lts < COOLDOWN_OPPO:
            log.debug("%s 反向信号被抑制", code)
            return None
    if not alerts.should_alert(code, f"reversal_{side}", COOLDOWN_SAME):
        return None
    _last[code] = (side, now_ts)

    plan = await _build_plan(etf, ctx, side, score, hits)
    now = dt.datetime.now()
    sig = {
        "etf_code": code, "etf_name": name, "type": "reversal",
        "level": "critical", "dir": side, "score": score,
        "title": f"{name} 看{'多' if side == 'bull' else '空'}变盘信号 {score:.0f}分",
        "text": plan["text"],
        "factors": hits, "contract": plan.get("contract"),
        "ts": now.isoformat(timespec="seconds"),
    }
    _signals.setdefault(code, deque(maxlen=20)).append({
        "day": now.strftime("%Y-%m-%d"), "ts": sig["ts"], "dir": side,
        "score": score, "price": plan.get("underlying_price"),
        "title": sig["title"],
    })
    log.info("变盘信号 %s %s %.0f分：%s", code, side, score, "·".join(hits))
    return sig


def recent(code: str, limit: int = 10) -> list[dict]:
    """当日该标的的变盘信号（供分时图打标记）。"""
    today = dt.datetime.now().strftime("%Y-%m-%d")
    return [s for s in _signals.get(code, {}) if s.get("day") == today][-limit:]
