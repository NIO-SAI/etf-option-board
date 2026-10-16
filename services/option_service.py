"""ETF 期权链服务：T 型报价、合约详情、K 线/分时，并附带 BS 隐波/希腊字母/溢价率。"""

from __future__ import annotations

import asyncio
import calendar
import datetime as dt
import logging
import re

from config import settings
from services import bs, em, iv_history as ivh
from services.universe import ETF_BY_CODE, ETFS

log = logging.getLogger("option")

# clist 期权列表字段
OPT_LIST_FIELDS = "f12,f13,f14,f2,f3,f4,f5,f6,f15,f16,f17,f18,f31,f32,f108,f161,f162,f152"

# 期权简称：前缀 + 购/沽 + N月 + 行权价（×1000 的整数）。
# 末尾可能带调整合约后缀字母（如「500ETF沽12月6876A」，除权调整合约）——
# 不匹配会把 month 解析成 0，进而把该标的的 front_month 判成 0、T 型报价整表错月。
_NAME_RE = re.compile(
    r"^(?P<prefix>.+?)(?P<cp>购|沽)(?P<month>\d{1,2})月(?P<strike>\d+)(?P<adj>[A-Za-z]*)$")


def parse_name(name: str) -> dict | None:
    m = _NAME_RE.match(name or "")
    if not m:
        return None
    return {
        "prefix": m["prefix"],
        "is_call": m["cp"] == "购",
        "month": int(m["month"]),
        "strike": int(m["strike"]) / 1000.0,
    }


def fourth_wednesday(year: int, month: int) -> dt.date:
    """ETF 期权到期日 = 到期月第 4 个星期三。"""
    cal = calendar.monthcalendar(year, month)
    wed = [w[calendar.WEDNESDAY] for w in cal if w[calendar.WEDNESDAY] != 0]
    return dt.date(year, month, wed[3])


def expiry_date(month: int, today: dt.date | None = None) -> dt.date:
    today = today or dt.date.today()
    year = today.year
    d = fourth_wednesday(year, month)
    if d < today:  # 跨年
        d = fourth_wednesday(year + 1, month)
    return d


def days_to_expiry(month: int) -> int:
    return (expiry_date(month) - dt.date.today()).days


def _enrich(row: dict, s: float, today: dt.date) -> dict:
    name = row.get("f14", "")
    p = parse_name(name)
    strike = em.num(row.get("f161"))
    is_call = p["is_call"] if p else True
    month = p["month"] if p else 0
    last = em.num(row.get("f2"))
    exp = expiry_date(month, today) if month else today
    t = max((exp - today).days, 0) / 365.0
    r = settings.risk_free_rate

    out = {
        "code": row.get("f12"),
        "market": row.get("f13"),
        "secid": f"{row.get('f13')}.{row.get('f12')}",
        "name": name,
        "is_call": is_call,
        "type": "call" if is_call else "put",
        "strike": strike,
        "expiry": exp.isoformat(),
        "month": month,
        "days": max((exp - today).days, 0),
        "last": last,
        "pct": em.num(row.get("f3")),
        "change": em.num(row.get("f4")),
        "volume": em.num(row.get("f5")),
        "amount": em.num(row.get("f6")),
        "high": em.num(row.get("f15")),
        "low": em.num(row.get("f16")),
        "open": em.num(row.get("f17")),
        "prev_close": em.num(row.get("f18")),
        "bid": em.num(row.get("f31")),
        "ask": em.num(row.get("f32")),
        "oi": em.num(row.get("f108")),
    }
    # 盘口价差
    if out["bid"] and out["ask"]:
        mid = (out["bid"] + out["ask"]) / 2
        out["spread"] = round((out["ask"] - out["bid"]) / mid * 100, 2) if mid else None
    else:
        mid = last
        out["spread"] = None

    # 定价指标
    moneyness = (s - strike) / s if s else 0
    out["moneyness"] = round(moneyness, 4)
    out["itm"] = (s > strike) if is_call else (s < strike)
    if strike and s:
        out["premium_rate"] = round(bs.premium_rate(mid or last, s, strike, is_call) * 100, 3)
    else:
        out["premium_rate"] = None
    iv = bs.implied_vol(mid or last, s, strike, t, r, is_call)
    out["iv"] = round(iv * 100, 2) if iv else None
    # 理论价（用当前 IV 反推一致；用于“偏离”判断）
    if iv:
        g = bs.greeks(s, strike, t, r, iv, is_call)
        out["delta"] = round(g["delta"], 4)
        out["gamma"] = round(g["gamma"], 4)
        out["vega"] = round(g["vega"], 4)
        out["theta"] = round(g["theta"], 5)
        out["leverage"] = round(bs.leverage(mid or last, s, g["delta"]), 1)
        out["break_even"] = round(bs.break_even(strike, mid or last, is_call), 4)
    else:
        out.update({"delta": None, "gamma": None, "vega": None, "theta": None,
                    "leverage": None, "break_even": None})
    out["atm"] = abs(moneyness) <= 0.015
    return out


async def _raw_chain(etf: dict) -> list[dict]:
    # 期权列表按行权价归并后是全量列表（612/468 条），单标的链取其前缀
    fields = OPT_LIST_FIELDS
    rows = await em.clist_all(f"m:{etf['opt_market']}", fields, pz=100, ttl=45.0)
    prefix = etf["prefix"]
    out = []
    for r in rows:
        nm = r.get("f14", "")
        if not nm.startswith(prefix):
            continue
        # 排除相邻前缀（如 科创50 vs 科创板50）
        rest = nm[len(prefix):]
        if rest and rest[0] not in ("购", "沽"):
            continue
        out.append(r)
    return out


async def chain(etf_code: str) -> dict:
    etf = ETF_BY_CODE.get(etf_code)
    if not etf:
        return {"error": f"未知标的 {etf_code}"}
    today = dt.date.today()
    q, raw = await asyncio.gather(
        em.stock_get(etf["secid"], "f43,f44,f45,f46,f47,f48,f57,f58,f60,f169,f170,f171"),
        _raw_chain(etf),
    )
    s = em.num(q.get("f43")) if q else 0.0
    underlying = {
        "code": etf["code"], "name": em.f(q.get("f58"), etf["name"]) if q else etf["name"],
        "price": s,
        "pct": em.num(q.get("f170")) if q else 0.0,
        "high": em.num(q.get("f44")) if q else None,
        "low": em.num(q.get("f45")) if q else None,
        "open": em.num(q.get("f46")) if q else None,
        "prev_close": em.num(q.get("f60")) if q else None,
        "volume": em.num(q.get("f47")) if q else 0,
        "amount": em.num(q.get("f48")) if q else 0,
    }
    contracts = [_enrich(r, s, today) for r in raw]
    contracts.sort(key=lambda x: (x["days"], x["strike"], not x["is_call"]))
    # 到期序列按剩余天数升序（近月在前）
    exp_map: dict[int, dict] = {}
    for c in contracts:
        if not c["month"]:            # 解析失败的合约不参与到期序列，避免 front_month=0
            continue
        exp_map.setdefault(c["month"], {"month": c["month"], "expiry": c["expiry"], "days": c["days"]})
    expiries = sorted(exp_map.values(), key=lambda x: x["days"])
    front = expiries[0]["month"] if expiries else None
    return {
        "etf": etf, "underlying": underlying,
        "expiries": [e["month"] for e in expiries],
        "expiry_list": expiries,
        "front_month": front,
        "count": len(contracts),
        "contracts": contracts,
        "stats": _chain_stats(contracts, s, front, etf["code"]),
    }


def _chain_stats(contracts: list[dict], s: float, front: int | None = None,
                 code: str | None = None) -> dict:
    """ATM 隐波、隐波偏斜、认沽认购比（PCR）、平价套利偏离。"""
    if not contracts:
        return {}
    near = front if front is not None else min(c["days"] for c in contracts)
    near_cs = [c for c in contracts if c["month"] == near and c["iv"]]
    if not near_cs:
        return {}
    atm = min(near_cs, key=lambda c: abs(c["strike"] - s))
    calls = [c for c in near_cs if c["is_call"]]
    puts = [c for c in near_cs if not c["is_call"]]
    atm_iv_call = min(calls, key=lambda c: abs(c["strike"] - s))["iv"] if calls else None
    atm_iv_put = min(puts, key=lambda c: abs(c["strike"] - s))["iv"] if puts else None
    # 偏斜：虚值认沽 IV - 虚值认购 IV（>0 恐慌，<0 追涨）
    otm_put = [c for c in puts if c["strike"] < s * 0.98]
    otm_call = [c for c in calls if c["strike"] > s * 1.02]
    skew = None
    if otm_put and otm_call:
        skew = round(
            sum(c["iv"] for c in otm_put) / len(otm_put)
            - sum(c["iv"] for c in otm_call) / len(otm_call), 2)
    pcr = None
    tot_c_oi = sum(c["oi"] for c in contracts if c["is_call"])
    tot_p_oi = sum(c["oi"] for c in contracts if not c["is_call"])
    pcr = round(tot_p_oi / tot_c_oi, 3) if tot_c_oi else None
    # 平价：认购-认沽 同 strike 差 vs 标的-行权价
    parity_gaps = []
    by = {}
    for c in near_cs:
        by.setdefault(c["strike"], {})[c["type"]] = c
    for k, d in by.items():
        if "call" in d and "put" in d:
            c_, p_ = d["call"], d["put"]
            if c_.get("last") and p_.get("last"):
                synthetic = c_["last"] - p_["last"] + k
                parity_gaps.append(round(synthetic - s, 4))
    # 记入 IV 历史并算 20 日分位（买方择时用；失败/样本不足则为 None）
    if code:
        ivh.record(code, atm["iv"])
    pctl20 = ivh.percentile(code, atm["iv"]) if code else None
    return {
        "near_month": near,
        "atm_iv": atm["iv"],
        "atm_iv_pctl20": pctl20,
        "atm_iv_call": atm_iv_call,
        "atm_iv_put": atm_iv_put,
        "skew": skew,
        "pcr": pcr,
        "parity_gap": round(sum(parity_gaps) / len(parity_gaps), 4) if parity_gaps else None,
    }


def t_quote(chain_data: dict, month: int | None = None) -> dict:
    """把链整理成 T 型：按行权价一行为一组，左认购右认沽。"""
    contracts = chain_data.get("contracts") or []
    if not contracts:
        return {"strikes": [], "month": month}
    month = month or chain_data.get("front_month")
    exps = chain_data.get("expiries") or []
    if not month:
        month = exps[0] if exps else None
    if not month:
        return {"month": month, "rows": []}
    rows: dict[float, dict] = {}
    for c in contracts:
        if c["month"] != month:
            continue
        rows.setdefault(c["strike"], {})[c["type"]] = c
    s = chain_data["underlying"]["price"]
    out = []
    for k in sorted(rows):
        r = rows[k]
        out.append({"strike": k, "atm": abs(k - s) < 1e-9 or (
            abs(k - s) <= (min(abs(x - s) for x in rows) if rows else 0) + 1e-9),
            "call": r.get("call"), "put": r.get("put")})
    return {"month": month, "underlying_price": s, "rows": out}


async def option_quote(secid: str) -> dict | None:
    q = await em.stock_get(secid, "f43,f44,f45,f46,f47,f48,f57,f58,f60,f169,f170,f171,f31,f32,f108,f161,f162")
    if not q:
        return None
    return {
        "secid": secid, "code": em.f(q.get("f57")), "name": em.f(q.get("f58")),
        "last": em.num(q.get("f43")), "high": em.num(q.get("f44")), "low": em.num(q.get("f45")),
        "open": em.num(q.get("f46")), "prev_close": em.num(q.get("f60")),
        "volume": em.num(q.get("f47")), "amount": em.num(q.get("f48")),
        "change": em.num(q.get("f169")), "pct": em.num(q.get("f170")),
        "amplitude": em.num(q.get("f171")), "bid": em.num(q.get("f31")), "ask": em.num(q.get("f32")),
        "oi": em.num(q.get("f108")), "strike": em.num(q.get("f161")),
    }


async def option_kline(secid: str, klt: int = 1, lmt: int = 240) -> list[dict]:
    if klt == 3:  # 东财无 3 分钟，用 1 分钟聚合
        bars = em.parse_klines(await em.kline(secid, klt=1, lmt=lmt * 3))
        return _aggregate(bars, 3)
    data = await em.kline(secid, klt=klt, lmt=lmt)
    return em.parse_klines(data)


async def option_trends(secid: str, ndays: int = 1) -> list[dict]:
    """合约分时（单日视图）。取数优先级：

      1) 真实分钟源（em.trends → 腾讯 / 东财 push2 trends2）。先按单日取——em 里的
         _trends_trim 已保证「盘中却拿到非当日数据则丢弃」，盘中即得当日分钟序列；
      2) 单日为空（盘前 / 收盘后 / 当日无数据）时，再按两日取并只保留**最近一个有
         数据的交易日**：这就是"补上前一日历史"，界面不再空；
      3) 真实源都取不到时，退回本地快照累积 em.opt_trends（emdatah5 逐分钟累积）。

    注意：本机出口是境外 IP 时，东财 push2 整族被反爬（返空），(1)(2) 必然落空、只能
    走 (3)。让 *.eastmoney.com 直连（绕过境外代理）即可让 (1)(2) 立即生效、无需再改码。
    """
    real = em.parse_trends(await em.trends(secid, ndays=1))
    if len(real) >= 2:
        return real
    multi = em.parse_trends(await em.trends(secid, ndays=max(ndays, 2)))
    if len(multi) >= 2:
        days = [str(t.get("time", ""))[:10] for t in multi if t.get("time")]
        last_day = max(days) if days else ""
        same = [t for t in multi if str(t.get("time", ""))[:10] == last_day]
        if len(same) >= 2:
            return same
    return await em.opt_trends(secid)


def _aggregate(bars: list[dict], n: int) -> list[dict]:
    out = []
    for i in range(0, len(bars), n):
        grp = bars[i:i + n]
        if not grp:
            continue
        out.append({
            "date": grp[-1]["date"], "open": grp[0]["open"],
            "close": grp[-1]["close"], "high": max(b["high"] for b in grp),
            "low": min(b["low"] for b in grp),
            "volume": sum(b["volume"] for b in grp),
            "amount": sum(b["amount"] for b in grp),
            "pct": grp[-1].get("pct"),
        })
    return out


# --------------------------------------------------------------------------
# 日内合约优选
# --------------------------------------------------------------------------
def rank_candidates(chain_data: dict, direction: str = "auto",
                    top: int = 6) -> list[dict]:
    """按日内交易性价比为合约打分。

    评分维度（专业日内期权选合约）：
     1) 流动性：成交额、持仓量、买卖价差（权重最高，避免滑点/无法平仓）
     2) Delta 适宜度：日内方向交易取 |delta| 0.35~0.65（弹性与胜率平衡）
     3) 隐波水平：高 IV 溢价贵（买方不利），但高波动标的仍可选；用 IV 分位近似
     4) 溢价率：低溢价（时间价值/标的小）→ 更“实”
     5) 平值度：越接近平值，gamma 越大，日内弹性越好
    direction: call / put / auto（auto 结合标的日内涨跌与动量）
    """
    contracts = [c for c in chain_data.get("contracts", []) if c.get("last")]
    if not contracts:
        return []
    s = chain_data["underlying"]["price"]
    front = chain_data.get("front_month")
    # 池 = 近月 + 次月（日内交易只用近端合约，远月流动性差）
    months = sorted({c["days"] for c in contracts})[:2]
    pool = [c for c in contracts if c["days"] in months]
    if not pool:
        pool = contracts

    # 方向判定
    if direction == "auto":
        direction = "call" if chain_data["underlying"].get("pct", 0) >= 0 else "put"
    pool = [c for c in pool if c["type"] == direction] or pool

    max_amt = max((c["amount"] for c in pool), default=1) or 1
    max_oi = max((c["oi"] for c in pool), default=1) or 1
    ivs = [c["iv"] for c in pool if c["iv"]]
    iv_min, iv_max = (min(ivs), max(ivs)) if ivs else (0, 1)

    scored = []
    for c in pool:
        liq = 0.45 * (c["amount"] / max_amt) + 0.25 * (c["oi"] / max_oi)
        spread_pen = 0.0
        if c.get("spread") is not None:
            spread_pen = min(c["spread"], 20) / 20  # 价差越大越差
        liq *= (1 - 0.4 * spread_pen)
        d = abs(c.get("delta") or 0)
        delta_score = max(0.0, 1 - abs(d - 0.5) / 0.35) if d else 0
        iv_score = (c["iv"] - iv_min) / (iv_max - iv_min) if c["iv"] and iv_max > iv_min else 0.5
        prem = c.get("premium_rate")
        prem_score = max(0.0, 1 - min(abs(prem or 0), 15) / 15)
        atm_score = max(0.0, 1 - abs(c["moneyness"]) / 0.06)
        score = (0.40 * liq + 0.18 * delta_score + 0.14 * iv_score
                 + 0.14 * prem_score + 0.14 * atm_score)
        c2 = dict(c)
        c2["score"] = round(score * 100, 1)
        c2["_parts"] = {"liq": round(liq, 3), "delta": round(delta_score, 3),
                        "iv": round(iv_score, 3), "prem": round(prem_score, 3),
                        "atm": round(atm_score, 3)}
        scored.append(c2)
    scored.sort(key=lambda x: -x["score"])
    return scored[:top]


def summarize_for_llm(chain_data: dict, direction: str = "auto") -> dict:
    """压缩成给大模型的精简结构。"""
    return {
        "标的": chain_data["underlying"],
        "链统计": chain_data.get("stats"),
        "推荐方向": direction,
        "候选合约": [
            {k: v for k, v in c.items() if not k.startswith("_") and k != "etf"}
            for c in rank_candidates(chain_data, direction, top=6)
        ],
    }
