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


def third_friday(year: int, month: int) -> dt.date:
    """股指期权到期日 = 到期月第 3 个星期五（与 ETF 的第四星期三不同）。"""
    cal = calendar.monthcalendar(year, month)
    fri = [w[calendar.FRIDAY] for w in cal if w[calendar.FRIDAY] != 0]
    return dt.date(year, month, fri[2])


# 股指期权合约代码：品种 + YYMM + C/P + 行权价，如 MO2611-C-7000
_INDEX_CODE_RE = re.compile(r"^(?P<prod>[A-Z]{2})(?P<ym>\d{4})-([CP])-(?P<strike>\d+(?:\.\d+)?)$")
# 股指期权简称：中证1000购26年11月7000（与 ETF 的「购11月」不同，年份在前）
_INDEX_NAME_RE = re.compile(
    r"^(?P<prefix>.+?)(?P<cp>购|沽)(?P<yy>\d{2})年(?P<mon>\d{1,2})月(?P<strike>\d+(?:\.\d+)?)$")


def contract_meta(row: dict, meta: dict | None = None) -> dict | None:
    """合约静态信息：month / strike / is_call / expiry。

    股指期权的代码（MO2611-C-7000）比简称更可靠，优先按代码解析，简称兜底；
    ETF 期权的代码是纯数字，只能走简称，且行权价要用 f161 的原始字段
    （简称里的「1050」是 1.050，除权调整后两者可能不一致）。
    """
    meta = meta or {}
    code = (row.get("f12") or "").strip()
    name = row.get("f14") or ""
    today = dt.date.today()

    def _expiry(month: int) -> dt.date:
        if meta.get("kind") == "index":
            # 股指期权的月份是 YYMM（2611 = 2026-11），要补世纪
            return third_friday(2000 + month // 100, month % 100)
        return expiry_date(month, today)

    if meta.get("kind") == "index":
        m = _INDEX_CODE_RE.match(code)
        if m:
            ym = m["ym"]
            month = int(ym)
            return {"month": month, "strike": float(m["strike"]),
                    "is_call": m.group(3) == "C", "expiry": _expiry(month)}
        m = _INDEX_NAME_RE.match(name)
        if m:
            month = int(m["yy"]) * 100 + int(m["mon"])
            return {"month": month, "strike": float(m["strike"]),
                    "is_call": m["cp"] == "购", "expiry": _expiry(month)}
        return None

    p = parse_name(name)
    if not p:
        return None
    strike = em.num(row.get("f161")) or p["strike"]
    month = p["month"]
    return {"month": month, "strike": strike, "is_call": p["is_call"],
            "expiry": _expiry(month)}


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
    # clist 在本机已被接口级封禁（每页空回包各等 1.5s，整链 12s 且只回 1~2 页 → 链不完整）。
    # 先走「落盘合约清单 + ulist 批量」（0.5s 覆盖全量）；清单为空时才退回 clist 翻页。
    rows = await em.option_chain_from_universe(etf["opt_market"], fields)
    if len(rows) < 20:
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

    **2026-11 实测：push2 的 stock/trends2 已被接口级封禁（两族都空回包），探测一次要
    6s 超时、两层就是 12s——切合约时图表十几秒不动，用户会以为「价格线没变化」。
    本地 clist 累积已是分钟级完整曲线，所以先看累积，够用就直接返回。**
    """
    local = await em.opt_trends(secid)
    if len(local) >= 2:
        return local
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
#
# 口径（2026-11 重建）：短期买方视角，八个维度加权，全部 0~1 归一后 × 100。
#   liq .26   流动性——用**绝对锚点**对数映射（成交额/持仓/成交量），不跟池内最大值比，
#             否则冷清标的全是"池里最大"也能拿满分，分数跨天/跨标的不可比；
#   ev  .18   期望收益——标的点位结构（突破/止损/止盈）按 Δ 折算到合约后的 ROI；
#   delta .14 Delta 弹性——越接近目标 Δ 越好（默认 0.50，顺强趋势略偏虚值）；
#   theta .12 时间损耗——按"每日衰减 ÷ 权利金"惩罚，自校准可收紧；
#   atm .08   平值度——贴近平值 Gamma 弹性大；
#   iv  .08   隐波便宜度——买方付隐波，越便宜越好（旧口径是反的）；
#   prem .04  溢价率——到期要涨/跌多少才覆盖权利金；
#   align .06 方向一致性——逆势只作反向备选并降分；
#   dte .04   剩余天数——临期/远月都扣分。
# --------------------------------------------------------------------------
SCORE_WEIGHTS = {"liq": 0.26, "ev": 0.18, "delta": 0.14, "theta": 0.12,
                 "atm": 0.08, "iv": 0.08, "prem": 0.04, "align": 0.06,
                 "dte": 0.04}

DELTA_BAND = (0.15, 0.85)     # 可交易 Delta 带：再虚/再实都不是日内买方标的
SPREAD_GATE = 5.0             # 买卖价差 >5% 直接剔除（滑点吃光利润）
SPREAD_UNKNOWN = 0.35         # 无两侧报价时的中性分（能挂但不知道能不能撮合）
MAX_PREM = 20.0               # 溢价率百分数：超过即视为"纯赌方向"
EV_TARGET = 0.30              # ROI 0.30 记为满分期望
DELTA_DUP = 0.03              # 同月同侧 |Δ| 相差 <0.03 视为同一档，只留一只

# 流动性绝对锚点（成交额元 / 持仓张 / 成交量张），对数线性映射到 0~1
_LIQ_ANCHORS = {
    "amount": (3e5, 3e8),
    "oi": (500.0, 5e4),
    "volume": (100.0, 3e4),
}


def _clip(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


def _lognorm(v: float, lo: float, hi: float) -> float:
    """对数映射到 0~1：v<=lo → 0，v>=hi → 1（量级差异大的指标用）。"""
    import math
    v = max(float(v or 0.0), 0.0)
    if v <= lo:
        return 0.0
    if v >= hi:
        return 1.0
    return _clip(math.log(v / lo) / math.log(hi / lo))


def _liquidity(c: dict) -> float:
    """流动性 0~1：成交额为主，持仓/成交量为辅，盘口价差单独一项。

    三个量都用绝对锚点（对数映射），不跟池内最大值比——否则冷清标的全是「池里
    最大」也能拿满分，分数跨天/跨标的不可比。
    """
    amount = _lognorm(c.get("amount") or 0, *_LIQ_ANCHORS["amount"])
    oi = _lognorm(c.get("oi") or 0, *_LIQ_ANCHORS["oi"])
    volume = _lognorm(c.get("volume") or 0, *_LIQ_ANCHORS["volume"])
    spread = c.get("spread")
    spread_score = SPREAD_UNKNOWN if spread is None else 1.0 - _clip(spread / SPREAD_GATE)
    return (0.50 * amount + 0.22 * oi + 0.18 * volume + 0.10 * spread_score)


def _expectancy(c: dict, levels: dict | None, spot: float | None) -> dict | None:
    """把标的点位按 Δ 折算成合约价，算一张合约的期望 ROI。

    分子分母都用**入场成本**口径：
      cost = 现价 + Δ×(entry_break − spot)        ← 触发买入价对应的权利金
      up   = Δ × (target − entry_break)            ← 到止盈标的位的权利金增量
      down = −Δ × (stop − entry_break)             ← 到止损标的位的权利金缩水，
                                                    再被合约层硬止损 30% 兜住
      roi  = (p×up − (1−p)×down) / cost，p = |Δ|
    用带符号的 Δ 乘价差，call 与 put 共用一套公式（put 的 Δ<0、target 在下）。
    """
    if not levels:
        return None
    entry_break = levels.get("entry_break")
    stop = levels.get("stop")
    target = levels.get("target")
    if entry_break is None or stop is None or target is None:
        return None
    delta = c.get("delta") or 0.0
    last = c.get("last") or 0.0
    if not delta or not last:
        return None
    spot = spot or entry_break
    p = abs(delta)
    cost = last + delta * (entry_break - spot)
    if cost <= 0:
        return None
    to_target = delta * (target - entry_break)
    to_stop = delta * (stop - entry_break)
    up = max(to_target, 0.0)         # 方向与计划相反时不构成可交易期望
    down = min(max(-to_stop, 0.0), 0.30 * cost)
    roi = (p * up - (1 - p) * down) / cost
    return {"ev": round(p * up - (1 - p) * down, 4), "roi": round(roi, 3),
            "up": round(up, 4), "down": round(down, 4), "p": round(p, 3),
            "reversed": bool(delta * (target - entry_break) < 0)}


def _iv_score(c: dict, stats: dict, trend: dict,
              iv_range: tuple[float, float] | None = None) -> float:
    """隐波便宜度 0~1，两个口径各占一半：

    - 绝对：IV 20 日分位 / IV-RV 比（vol.iv_cheapness），衡量"贵不贵"；
    - 相对：同侧合约里的 IV 高低，衡量"这只比同链其他档贵不贵"。
    两者都缺时给 0.5，不奖不罚（缺 IV 的合约排在同侧最便宜与最贵之间）。
    """
    from services import vol as volsvc
    pctl = (stats or {}).get("atm_iv_pctl20")
    ratio = (trend or {}).get("iv_rv_ratio")
    cheap = volsvc.iv_cheapness(pctl, ratio)
    iv = c.get("iv")
    rel = None
    if iv and iv_range:
        lo, hi = iv_range
        if hi > lo:
            rel = _clip((hi - iv) / (hi - lo))
    if cheap is None and rel is None:
        return 0.5
    if cheap is None:
        return _clip(rel)
    if rel is None:
        return _clip(cheap)
    return _clip(0.5 * cheap + 0.5 * rel)


def _dte_score(days: int) -> float:
    """日内买方：近月最优；临期 Theta 风险大，远月流动性/弹性差。"""
    if days <= 2:
        return 0.25
    if days <= 30:
        return 1.0
    if days <= 60:
        return 0.75
    return 0.45


POOL_MAX_DAYS = 75             # 池上限：只保留剩余 75 天内的近端合约


def _pool(chain_data: dict) -> list[dict]:
    """可交易池：最近两个到期月里的近端合约（日内不用远月，流动性/弹性都差）。

    按「月份」筛会漏掉 month=0（简称解析失败）或跨年同月的合约，再按天数兜一道；
    远月（>POOL_MAX_DAYS）即使月份相邻也不进池。
    """
    contracts = [c for c in (chain_data.get("contracts") or [])
                 if (c.get("last") or 0) > 0]
    if not contracts:
        return []
    days_of: dict[int, int] = {}
    for c in contracts:
        m = c.get("month") or 0
        days_of[m] = min(days_of.get(m, 10 ** 6), int(c.get("days") or 0))
    keep = {m for m, _ in sorted(days_of.items(), key=lambda kv: kv[1])[:2]}
    return [c for c in contracts
            if (c.get("month") or 0) in keep
            and int(c.get("days") or 0) <= POOL_MAX_DAYS]


def _target_delta(trend: dict, side: str, calib: dict | None) -> float:
    t_dir = (trend or {}).get("direction") or "neutral"
    strength = _clip(abs(float((trend or {}).get("score") or 0)) / 100.0)
    target = 0.50 - 0.05 * strength if t_dir == side else 0.50
    shift = float((calib or {}).get("target_delta_shift") or 0.0)
    if shift:
        # 自校准：历史命中最好的 Δ 档偏高就整体上移（<=0.05）
        target = _clip(target + shift, 0.20, 0.85)
    return target


def _score_contract(c: dict, side: str, spot: float, stats: dict, trend: dict,
                    levels: dict | None, calib: dict | None,
                    iv_range: tuple[float, float] | None = None) -> dict:
    """单只合约打分（看板列表 / best_buys / 告警共用同一套）。"""
    t_dir = (trend or {}).get("direction") or "neutral"
    strength = _clip(abs(float((trend or {}).get("score") or 0)) / 100.0)
    raw_delta = c.get("delta") or 0.0
    d = abs(raw_delta)
    target_delta = _target_delta(trend, side, calib)

    liq = _liquidity(c)
    delta_score = _clip(1 - abs(d - target_delta) / 0.30)
    atm_score = _clip(1 - abs(c.get("moneyness") or 0) / 0.07)
    iv_score = _iv_score(c, stats, trend, iv_range)

    last = c.get("last") or 0.0
    theta = abs(c.get("theta") or 0.0)
    daily_decay = (theta / last) if last else 0.0
    theta_gain = float((calib or {}).get("theta_gain") or 1.0)
    if c.get("theta") is None or not last:
        theta_score = 0.5          # 缺 Theta 数据：中性分，不奖不罚
    else:
        theta_score = _clip(1 - daily_decay * theta_gain / 0.08)

    prem = c.get("premium_rate")
    prem_score = 0.5 if prem is None else _clip(1 - abs(prem) / MAX_PREM)

    dte_score = _dte_score(int(c.get("days") or 0))

    if t_dir == "neutral":
        align = 0.5
    elif t_dir == side:
        align = 0.65 + 0.35 * strength
    else:
        align = _clip(0.40 - 0.30 * strength, 0.0, 0.40)

    rr = _expectancy(c, levels, spot)
    ev_score = _clip(rr["roi"] / EV_TARGET) if rr else 0.5

    parts = {"liq": liq, "ev": ev_score, "delta": delta_score, "theta": theta_score,
             "atm": atm_score, "iv": iv_score, "prem": prem_score, "align": align,
             "dte": dte_score}
    score = sum(SCORE_WEIGHTS[k] * v for k, v in parts.items()) * 100

    reasons = _reasons(c, side, trend, strength, liq, raw_delta, d, target_delta,
                       iv_score, daily_decay, rr, parts)
    out = {k: v for k, v in c.items() if not k.startswith("_")}
    out.update({
        "score": round(score, 1),
        "trend_aligned": bool(t_dir == side and strength >= 0.15),
        "target_delta": round(target_delta, 2),
        "rr": rr,
        "_parts": {k: round(v, 3) for k, v in parts.items()},
        "reasons": reasons[:5],
    })
    return out


def _reasons(c: dict, side: str, trend: dict, strength: float, liq: float,
             raw_delta: float, d: float, target_delta: float, iv_score: float,
             daily_decay: float, rr: dict | None, parts: dict) -> list[str]:
    t_dir = (trend or {}).get("direction") or "neutral"
    out: list[str] = []
    if t_dir == side and strength >= 0.15:
        out.append("与当前标的趋势同向")
    elif t_dir in ("call", "put") and t_dir != side:
        out.append("逆当前方向，仅作反向备选")
    amount = c.get("amount") or 0
    if liq >= 0.65:
        amt_txt = f"{amount / 1e8:.2f}亿" if amount >= 1e8 else f"{amount / 1e4:.0f}万"
        out.append(f"流动性好（成交额 {amt_txt}）")
    spread = c.get("spread")
    if spread is not None and spread <= 2 and liq >= 0.3:
        out.append(f"买卖价差 {spread:.2f}% 偏窄")
    if rr:
        out.append(f"盈亏比：期望收益 {rr['roi'] * 100:+.0f}% 权利金"
                   f"（p≈{rr['p']}，赚 {rr['up']} / 亏 {rr['down']}）")
    out.append(f"Δ{raw_delta:+.2f}（目标 {target_delta:.2f}），日内弹性/胜率平衡")
    if abs(c.get("moneyness") or 0) <= 0.02:
        out.append("贴近平值，Gamma 弹性大")
    iv = c.get("iv")
    if iv and iv_score >= 0.6:
        out.append(f"IV {iv:.1f}% 偏低，买方付得便宜")
    elif iv and iv_score <= 0.25:
        out.append(f"IV {iv:.1f}% 偏贵，买方成本高")
    days = int(c.get("days") or 0)
    if daily_decay <= 0.03:
        out.append(f"剩余 {days} 天，Theta 衰减可控")
    elif daily_decay >= 0.06:
        out.append(f"Theta {daily_decay * 100:.1f}%/日，注意时间损耗")
    return out


def _dedupe(rows: list[dict]) -> list[dict]:
    """同月同侧 |Δ| 相差 <DELTA_DUP 的合约只留评分最高的一只（行权价挨太近）。"""
    kept: list[dict] = []
    for r in rows:
        dup = next((k for k in kept
                    if k.get("month") == r.get("month")
                    and k.get("type") == r.get("type")
                    and abs(abs(k.get("delta") or 0) - abs(r.get("delta") or 0)) < DELTA_DUP),
                   None)
        if dup is None:
            kept.append(r)
    return kept


def _label(rows: list[dict]) -> list[dict]:
    for i, r in enumerate(rows):
        r["role"] = "主选" if i == 0 else "备选"
    return rows


def rank_candidates(chain_data: dict, direction: str = "auto", top: int = 6,
                    trend: dict | None = None, levels: dict | None = None,
                    spot: float | None = None, calib: dict | None = None) -> list[dict]:
    """按日内买方性价比为合约打分，返回主选在前的列表。

    ``direction`` 为明确方向（call/put）时只返回该侧合约——即使与市场方向相反，
    也照常返回并标 ``trend_aligned=False``（反向备选卡需要它）；``auto`` 时按趋势/
    标的涨跌幅择边。池固定为最近两个月，先按 Delta 带与价差闸过滤。
    """
    t_dir = (trend or {}).get("direction") or "neutral"
    if direction == "auto":
        if t_dir in ("call", "put"):
            side = t_dir
        else:
            pct = ((chain_data.get("underlying") or {}).get("pct") or 0)
            side = "call" if pct >= 0 else "put"
    elif direction in ("call", "put"):
        side = direction
    else:
        side = "call"

    pool = _pool(chain_data)
    if not pool:
        return []
    spot = spot or (chain_data.get("underlying") or {}).get("price") or 0.0
    stats = chain_data.get("stats") or {}

    sided = [c for c in pool if c.get("type") == side]
    if not sided:
        return []
    # Delta 带：全在外面时退化为不过滤（否则整块推荐消失）
    band = [c for c in sided
            if DELTA_BAND[0] <= abs(c.get("delta") or 0) <= DELTA_BAND[1]]
    if band:
        sided = band
    # 价差闸：全被剔除时同样退化，保证表格有行可看
    tight = [c for c in sided
             if c.get("spread") is None or c["spread"] <= SPREAD_GATE]
    if tight:
        sided = tight

    ivs = [c["iv"] for c in sided if c.get("iv")]
    iv_range = (min(ivs), max(ivs)) if len(ivs) >= 2 else None
    scored = [_score_contract(c, side, spot, stats, trend, levels, calib, iv_range)
              for c in sided]
    scored.sort(key=lambda x: -x["score"])
    return _label(_dedupe(scored))[:top]


def best_buys(chain_data: dict, trend: dict | None = None, levels: dict | None = None,
              spot: float | None = None, calib: dict | None = None) -> dict:
    """多/空各选一只最优（与 rank_candidates 同一套打分），并给出主推方向。"""
    trend = dict(trend or {})
    t_dir = trend.get("direction") or "neutral"
    t_score = float(trend.get("score") or 0)
    trend["direction"] = t_dir
    trend["strength"] = round(_clip(abs(t_score) / 100.0), 2)
    trend["label"] = {"call": "看多", "put": "看空"}.get(t_dir, "震荡/观望")
    trend["atm_iv_pctl20"] = (chain_data.get("stats") or {}).get("atm_iv_pctl20")

    call = rank_candidates(chain_data, "call", top=1, trend=trend,
                           levels=levels, spot=spot, calib=calib)
    put = rank_candidates(chain_data, "put", top=1, trend=trend,
                          levels=levels, spot=spot, calib=calib)
    call_c = call[0] if call else None
    put_c = put[0] if put else None
    if not call_c and not put_c:
        return {"trend": trend, "call": None, "put": None, "recommended": None}

    if t_dir in ("call", "put") and trend["strength"] >= 0.15:
        rec_side = t_dir
    else:
        rec_side = ("call" if (call_c and (not put_c or call_c["score"] >= put_c["score"]))
                    else "put")
    rec = call_c if rec_side == "call" else put_c
    recommended = None
    if rec:
        recommended = {"side": rec_side, "code": rec["code"], "secid": rec["secid"],
                       "name": rec["name"], "score": rec["score"],
                       "month": rec["month"], "trend_aligned": rec["trend_aligned"]}
    return {"trend": trend, "call": call_c, "put": put_c, "recommended": recommended}


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
