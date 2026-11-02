"""波动率口径：20 日已实现波动（RV）、IV/RV 比与「买方隐波贵不贵」的统一打分。

买方付的是隐波、赚的是实际波动：IV 明显高于近 20 日已实现波动时，权利金里含了
波动率溢价，同样的方向判断更难赚钱。IV 20 日分位需要攒够 5 个交易日样本，
RV 是即时可用的替代口径（两者都有时以分位为准，它更贴近该标的自身的历史区间）。

纯函数，供 option_service（合约打分）/ strategy（ETF）/ index_option（股指期权）共用。
"""

from __future__ import annotations

import math


def realized_vol(closes: list[float], n: int = 20) -> float | None:
    """近 n 日日收益率年化波动率（%）。样本不足或全零波动时返回 None。"""
    if len(closes) < n + 1:
        return None
    seg = closes[-(n + 1):]
    rets = [math.log(seg[i] / seg[i - 1]) for i in range(1, len(seg)) if seg[i - 1] > 0]
    if len(rets) < 5:
        return None
    mean = sum(rets) / len(rets)
    var = sum((r - mean) ** 2 for r in rets) / (len(rets) - 1)
    return round(math.sqrt(var) * math.sqrt(242) * 100, 2)


def iv_rv(chain: dict, daily: list[dict]) -> dict | None:
    """ATM 隐波 vs 20 日已实现波动：>1 说明买方付了波动率溢价。"""
    atm_iv = (chain.get("stats") or {}).get("atm_iv")
    rv = realized_vol([b["close"] for b in (daily or [])])
    if not atm_iv or not rv:
        return None
    return {"atm_iv": atm_iv, "rv20": rv, "ratio": round(atm_iv / rv, 2)}


def iv_note(chain: dict, ivrv: dict | None) -> str | None:
    """给人看的一句话：分位优先，其次 IV/RV。"""
    pctl = (chain.get("stats") or {}).get("atm_iv_pctl20")
    if pctl is not None:
        return (f"IV 处 20 日 {pctl:.0f}% 分位，权利金偏贵，建议减半仓"
                if pctl >= 80 else
                f"IV 处 20 日 {pctl:.0f}% 分位，权利金偏便宜"
                if pctl <= 25 else f"IV 处 20 日 {pctl:.0f}% 分位")
    if not ivrv:
        return None
    r = ivrv["ratio"]
    if r >= 1.3:
        return f"IV 隐含年化 {ivrv['atm_iv']}%，高于 20 日已实现 {ivrv['rv20']}%，买方偏贵"
    if r <= 0.9:
        return f"IV 隐含年化 {ivrv['atm_iv']}%，低于 20 日已实现 {ivrv['rv20']}%，买方相对便宜"
    return f"IV 隐含年化 {ivrv['atm_iv']}%，与 20 日已实现 {ivrv['rv20']}% 相当"


def iv_cheapness(pctl: float | None, ratio: float | None) -> float | None:
    """隐波便宜度 0~1（越高越适合买方），两种口径互补。

    - 分位：≤10% 记 1，≥90% 记 0，中间线性（衡量该标的自身的 IV 区间位置）；
    - IV/RV：≤0.75 记 1（隐波比实际波动还便宜），≥1.35 记 0（溢价三成以上）；
    - 两者都有时 7:3 混合：分位更贴近该标的的历史，RV 反映当下的波动率风险溢价。
    """
    p = r = None
    if pctl is not None:
        p = max(0.0, min(1.0, 1 - (float(pctl) - 10) / 80))
    if ratio:
        r = max(0.0, min(1.0, 1 - (float(ratio) - 0.75) / 0.6))
    if p is not None and r is not None:
        return 0.7 * p + 0.3 * r
    return p if p is not None else r


def buyer_note(pctl: float | None, ratio: float | None) -> str | None:
    """买方一句话结论（信号区/告警用），比 iv_note 更短。

    分位处在中段时仍要看 IV/RV：IV 在自己历史上不算贵，但若明显高于近 20 日
    已实现波动，买方依然在为不会发生的波动付钱。
    """
    if pctl is not None:
        if pctl >= 80:
            return f"IV 20日分位 {pctl:.0f}%，买方付得贵，减仓或等回落"
        if pctl <= 25:
            return f"IV 20日分位 {pctl:.0f}%，权利金便宜，利于买方"
    if ratio is None:
        return None
    if ratio >= 1.3:
        return f"IV/已实现波动 {ratio:.2f}，隐波溢价明显，买方不占优"
    if ratio <= 0.9:
        return f"IV/已实现波动 {ratio:.2f}，隐波便宜，利于买方"
    return None


# ═══════════════════════════════════════════════════════════════════════════
# 波动率曲面：期限结构 + 25Δ 偏斜
# ═══════════════════════════════════════════════════════════════════════════
#
# 单看 ATM IV 分位只能回答「贵不贵」，回答不了「贵在哪一段、哪个方向」：
# - 期限结构（近月 vs 远月 ATM IV）说明时间维度上的风险定价，倒挂=近端恐慌；
# - 25Δ 偏斜（虚值认沽 IV - 虚值认购 IV）说明方向维度上的定价，正偏=下行保护贵。
# 卖方挑哪个月、买方挑哪个方向，靠的就是这两个维度。

def _atm_iv(cs: list[dict], spot: float) -> float | None:
    """该月最接近现价的行权价（认购/认沽各取一条）的 IV 均值。"""
    rows = [c for c in cs if c.get("iv") and c.get("strike")]
    if not rows:
        return None
    k = min(rows, key=lambda c: abs(c["strike"] - spot))["strike"]
    at_k = [c["iv"] for c in rows if abs(c["strike"] - k) < 1e-9]
    return round(sum(at_k) / len(at_k), 2) if at_k else None


def term_structure(chain: dict) -> list[dict]:
    """逐月 ATM 隐波（近月在前），用于判断期限结构陡峭/倒挂。"""
    spot = (chain.get("underlying") or {}).get("price") or 0
    if spot <= 0:
        return []
    rows = []
    for exp in (chain.get("expiry_list") or []):
        month = exp.get("month")
        cs = [c for c in (chain.get("contracts") or []) if c.get("month") == month]
        iv = _atm_iv(cs, spot)
        if iv is None:
            continue
        rows.append({"month": month, "days": exp.get("days"),
                     "expiry": exp.get("expiry"), "atm_iv": iv})
    return rows


def _by_delta(cs: list[dict], target: float) -> dict | None:
    pool = [c for c in cs if c.get("delta") is not None and c.get("iv")]
    if not pool:
        return None
    return min(pool, key=lambda c: abs(abs(c["delta"]) - target))


def skew_25d(chain: dict, month: int | None = None) -> dict | None:
    """25Δ 偏斜：虚值认沽 IV - 虚值认购 IV（百分点）。

    优先按 |delta|≈0.25 取腿；链上没有 delta 时退化为「虚值 2%~15% 区间均值」。
    正值越大，说明市场为下跌保护付的钱越多（恐慌/避险）。
    """
    spot = (chain.get("underlying") or {}).get("price") or 0
    if spot <= 0:
        return None
    month = month or chain.get("front_month")
    cs = [c for c in (chain.get("contracts") or [])
          if c.get("month") == month and c.get("iv")]
    if not cs:
        return None

    put = _by_delta([c for c in cs if c.get("type") == "put" and c["strike"] < spot], 0.25)
    call = _by_delta([c for c in cs if c.get("type") == "call" and c["strike"] > spot], 0.25)
    method = "delta25"
    if not put or not call:
        method = "otm_band"
        puts = [c for c in cs if c.get("type") == "put" and spot * 0.85 < c["strike"] < spot * 0.98]
        calls = [c for c in cs if c.get("type") == "call" and spot * 1.02 < c["strike"] < spot * 1.15]
        if not puts or not calls:
            return None
        put = {"strike": sum(c["strike"] for c in puts) / len(puts), "iv": sum(c["iv"] for c in puts) / len(puts)}
        call = {"strike": sum(c["strike"] for c in calls) / len(calls), "iv": sum(c["iv"] for c in calls) / len(calls)}
    skew = round(put["iv"] - call["iv"], 2)
    return {"month": month, "skew": skew, "method": method,
            "put": {"strike": round(put["strike"], 4), "iv": round(put["iv"], 2)},
            "call": {"strike": round(call["strike"], 4), "iv": round(call["iv"], 2)},
            "label": ("下行保护明显偏贵，市场在买保险" if skew >= 5 else
                      "下行保护略贵" if skew >= 2 else
                      "上行预期偏强（认购更贵）" if skew <= -2 else "两侧定价接近")}


def surface(chain: dict) -> dict:
    """波动率曲面摘要：期限结构 + 偏斜 + 一句话结论。"""
    term = term_structure(chain)
    skew = skew_25d(chain)
    slope = None
    if len(term) >= 2:
        slope = round(term[-1]["atm_iv"] - term[0]["atm_iv"], 2)
    notes = []
    if slope is not None:
        notes.append(f"期限结构{'倒挂' if slope < -1 else '陡峭' if slope > 1 else '平坦'}"
                     f"（远月-近月 {slope:+.2f}pt）")
        if slope < -1:
            notes.append("近端恐慌，卖方在近月收权利金需防事件冲击")
    if skew:
        notes.append(f"25Δ 偏斜 {skew['skew']:+.2f}pt，{skew['label']}")
    return {"term": term, "slope": slope, "skew": skew, "note": "；".join(notes)}
