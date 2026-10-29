"""日内决策的纯规则层：到期日历、临期分级、手数上限、组合 Greeks 敞口、限额与策略选择。

本模块**只做纯计算**：一切外部输入（当日日期、报价、Greeks、IV 分位）由调用方注入，
不读系统时钟、不触网、不碰磁盘。文件 I/O 与网络留在各自的薄壳里。

口径依据 `CONTEXT.md` §8 术语表与 `docs/adr/0001`、`0002`：
- 组合 Greeks 是**估算值**（`docs/adr/0001`：不录持仓明细，用敞口档位近似）；
- 策略只覆盖**买方**四类：买单腿认购 / 买单腿认沽 / 垂直价差 / 观望（`docs/adr/0002`）。
"""

from __future__ import annotations

import datetime as dt
import math

from services.option_service import fourth_wednesday

# ── 合约口径 ────────────────────────────────────────────────────────────────
# 沪深 ETF 期权合约单位：10000 份/张（美股为 100 股/张，切勿混用）。
CONTRACT_MULTIPLIER = 10000

# 合约月份：当月、下月及随后两个季月（季月 = 3/6/9/12 月）。无 LEAPS，故无长周期合约。
QUARTER_MONTHS = (3, 6, 9, 12)

# ── 临期阈值（自然日） ──────────────────────────────────────────────────────
CRITICAL_DAYS = 3
WARNING_DAYS = 7

# ── IV 分位阈值（与既有合约打分口径一致） ────────────────────────────────────
IV_HIGH_PCT = 75.0
IV_LOW_PCT = 25.0

# ── 敞口档位 ────────────────────────────────────────────────────────────────
TIERS = ("flat", "etf", "call", "put")
TIER_LABELS = {"flat": "空仓", "etf": "持有ETF", "call": "持认购", "put": "持认沽"}
SIZES = ("light", "mid", "heavy")
SIZE_LABELS = {"light": "轻", "mid": "中", "heavy": "重"}
SIZE_RATIOS = {"light": 0.10, "mid": 0.30, "heavy": 0.60}

# ── 风险偏好档：与单笔风险% 联动 ────────────────────────────────────────────
PROFILES = ("conservative", "standard", "aggressive")
PROFILE_LABELS = {"conservative": "保守", "standard": "标准", "aggressive": "激进"}
PROFILE_BY_RISK_PCT = {1.0: "conservative", 2.0: "standard", 3.0: "aggressive"}

# 组合 Greeks 限额（占总资金比例）：主显元、副显比例，元值由总资金推导。
# 与 PMCC advisor 的原始绝对金额表同构，但换算成比例以便跨账户规模伸缩。
LIMIT_RATIOS = {
    "conservative": {"delta": 0.10, "theta": 0.001, "vega": 0.004},
    "standard": {"delta": 0.25, "theta": 0.003, "vega": 0.010},
    "aggressive": {"delta": 0.50, "theta": 0.006, "vega": 0.020},
}

# ── 策略类型 ────────────────────────────────────────────────────────────────
STRATEGY_SINGLE_CALL = "single_call"
STRATEGY_SINGLE_PUT = "single_put"
STRATEGY_VERTICAL = "vertical"
STRATEGY_WAIT = "wait"

STRATEGY_LABELS = {
    STRATEGY_SINGLE_CALL: "买单腿认购",
    STRATEGY_SINGLE_PUT: "买单腿认沽",
    STRATEGY_VERTICAL: "垂直价差",
    STRATEGY_WAIT: "观望",
}


# ═══════════════════════════════════════════════════════════════════════════
# 1. 到期日历与临期分级
# ═══════════════════════════════════════════════════════════════════════════

def _next_month(year: int, month: int) -> tuple[int, int]:
    return (year + 1, 1) if month == 12 else (year, month + 1)


def _next_quarter(year: int, month: int) -> tuple[int, int]:
    """严格晚于 (year, month) 的第一个季月。"""
    yy, mm = year, month
    for _ in range(12):
        yy, mm = _next_month(yy, mm)
        if mm in QUARTER_MONTHS:
            return yy, mm
    return yy, mm  # pragma: no cover - 12 步内必有季月


def expiry_calendar(today: dt.date) -> list[dict]:
    """四个合约月份的到期日与倒计时。纯函数（当日日期由调用方注入）。

    当月若已过第 4 个星期三，即视为已到期，序列整体前移一个月 —— 这与交易所
    「到期日之后当月合约摘牌、主力切至下月」的事实一致。
    """
    year, month = today.year, today.month
    if today > fourth_wednesday(year, month):
        year, month = _next_month(year, month)

    front = (year, month)
    second = _next_month(*front)
    q1 = _next_quarter(*second)
    q2 = _next_quarter(*q1)

    rows: list[dict] = []
    for idx, (yy, mm) in enumerate((front, second, q1, q2)):
        exp = fourth_wednesday(yy, mm)
        rows.append({
            "year": yy,
            "month": mm,
            "label": f"{yy}年{mm}月",
            "short_label": f"{mm}月",
            "expiry": exp.isoformat(),
            "days_left": (exp - today).days,
            "is_front": idx == 0,
            "is_next": idx == 1,
        })
    return rows


def near_expiry_level(days_left: int | None) -> str | None:
    """临期级别：≤3 天 critical，4~7 天 warning，其余 None。

    已过期的负天数返回 None（不再提醒已摘牌的合约）。
    """
    if days_left is None or days_left < 0:
        return None
    if days_left <= CRITICAL_DAYS:
        return "critical"
    if days_left <= WARNING_DAYS:
        return "warning"
    return None


def expiry_alert_key(month: int | None, tier: str, today: dt.date) -> str:
    """临期提醒去重键：按「到期月 × 档位」每天一次（当日日期由调用方注入）。

    不能沿用告警总线的 90 秒冷却 —— 那会让 9 只标的每天刷屏；键里带日期，
    跨日自然失效，次日可再提醒。
    """
    return f"{today.isoformat()}:expiry:{month}:{tier}"


def expiry_alert_text(tier: str, month: int, days_left: int, expiry: str) -> str:
    """临期提醒文案：含到期月、到期日、剩余天数，并说明与所选敞口档位的关系。

    档位称谓一律取自 `TIER_LABELS`，不在文案里另写一遍，避免与术语表漂移。
    """
    tier_label = TIER_LABELS.get(tier, "未知档位") if isinstance(tier, str) else "未知档位"
    if tier == "flat":
        tail = f"当前{tier_label}，不涉及持仓到期；若计划新开当月合约请留意 Theta 与 Gamma 加速。"
    elif tier == "etf":
        tail = f"当前{tier_label}，无期权到期风险；若已备兑卖出当月认购，请留意被行权。"
    elif tier in ("call", "put"):
        tail = f"当前{tier_label}，买方受 Theta 侵蚀最快，建议优先兑现或移仓次月。"
    else:
        tail = ""
    return f"{month} 月合约距到期 {days_left} 天（到期日 {expiry}）。{tail}"


# ═══════════════════════════════════════════════════════════════════════════
# 2. 仓位：风险预算 → 手数上限
# ═══════════════════════════════════════════════════════════════════════════

def _finite(value) -> float | None:
    """转为有限浮点数；bool、不可转、非有限值一律返回 None。"""
    if isinstance(value, bool):
        return None
    try:
        num = float(value)
    except (TypeError, ValueError):
        return None
    return num if math.isfinite(num) else None


def _positive(value) -> float | None:
    """转为有限的正数；bool/None/非数字/NaN/Inf/非正数一律返回 None（绝不抛异常）。"""
    num = _finite(value)
    if num is None or num <= 0:
        return None
    return num


def risk_budget(total_capital: float | None, risk_pct: float | None) -> float | None:
    """单笔风险预算 = 总资金 × 单笔风险%。任一项缺失或非法时返回 None。"""
    cap, pct = _positive(total_capital), _positive(risk_pct)
    if cap is None or pct is None:
        return None
    return round(cap * pct / 100.0, 2)


def max_loss_per_contract(kind: str, *, premium: float | None = None,
                          width: float | None = None, net_credit: float = 0.0,
                          multiplier: int = CONTRACT_MULTIPLIER) -> float | None:
    """单张最大亏损（元）。

    - ``single``（买单腿）：权利金全额 —— 期权买方最大亏损即权利金。
    - ``vertical``（垂直价差）：信用价差为「宽度 − 净收权利金」；
      借方价差为「付出的净权利金」（即 net_credit 为负时的绝对値）。
      两种口径不能混用——把借方价差也按「宽度 − 净收」算会把最大亏损高估一个宽度。
    """
    if kind == "single":
        p = _positive(premium)
        return None if p is None else round(p * multiplier, 2)
    if kind == "vertical":
        w = _positive(width)
        if w is None:
            return None
        credit = _finite(net_credit) or 0.0
        if credit >= 0:
            # 信用价差（看涨价差 / 熊市看跌价差）：最大亏损 = 行权价宽度 − 收取的权利金
            per_share = max(w - credit, 0.0)
        else:
            # 借方价差（牛市看涨价差等）：最大亏损 = 付出的净权利金，不会超过宽度
            per_share = min(-credit, w)
        return round(per_share * multiplier, 2)
    return None


def max_contracts(budget: float | None, loss_per_contract: float | None) -> dict:
    """手数上限 = 单笔风险预算 ÷ 单张最大亏损，向下取整。

    任何输入缺失都降级为 ``max_contracts=None`` + 原因，绝不抛异常、不除零。
    算出 0 张时给出明确的「不应开仓」文案，而不是让界面显示「最多 0 张」。
    """
    if _positive(budget) is None:
        return {"max_contracts": None, "reason": "未设置总资金与单笔风险%，无法算出手数上限"}
    loss = _positive(loss_per_contract)
    if loss_per_contract is None:
        return {"max_contracts": None, "reason": "缺少单张最大亏损，无法算出手数上限"}
    if loss is None:
        return {"max_contracts": None, "reason": "单张最大亏损为 0，无法算出手数上限"}

    n = int(budget // loss)
    out = {"budget": budget, "loss_per_contract": loss_per_contract,
           "max_contracts": n}
    if n <= 0:
        out["note"] = "按当前风险预算不应开仓"
    return out


# ═══════════════════════════════════════════════════════════════════════════
# 3. 敞口档位 → 组合 Greeks 敞口（估算）
# ═══════════════════════════════════════════════════════════════════════════

def risk_profile(risk_pct: float | None) -> str:
    """风险偏好档：与单笔风险% 联动（1%→保守 / 2%→标准 / 3%→激进）。未知值一律保守。"""
    pct = _positive(risk_pct)
    return PROFILE_BY_RISK_PCT.get(pct, "conservative")


def exposure_notional(tier: str, size: str, total_capital: float | None,
                      unit: dict | None = None) -> dict:
    """按敞口档位估算组合 Greeks 敞口（**估算值**）。

    - ``flat``：全零。
    - ``etf``：Delta 敞口 = 持有金额（ETF 的 Delta 恒为 1 元/元）。
    - ``call`` / ``put``：用当前优选合约的 Greeks 推张数，再折算标的金额当量。
      ``unit`` 需含 ``premium``（权利金）、``delta``、``price``（标的价）。

    返回值里 ``estimate=True`` 是硬约定：界面必须标注这是估算，不得呈现为真实敞口。
    """
    # 先校验取值合法性：字典标签查找需要可哈希键，非字符串直接短路，避免抛 TypeError
    if not isinstance(tier, str) or tier not in TIERS \
            or not isinstance(size, str) or size not in SIZES:
        return {"ok": False, "estimate": True, "contracts": None,
                "delta_notional": None, "theta_daily": None, "vega_per_pct": None,
                "tier": tier if isinstance(tier, str) else None, "tier_label": None,
                "size": size if isinstance(size, str) else None, "size_label": None,
                "reason": "敞口档位或档位规模取值不合法"}

    base = {"tier": tier, "tier_label": TIER_LABELS.get(tier),
            "size": size, "size_label": SIZE_LABELS.get(size),
            "estimate": True, "contracts": None,
            "delta_notional": None, "theta_daily": None, "vega_per_pct": None}

    cap = _positive(total_capital)
    if cap is None:
        return {**base, "ok": False, "reason": "未设置总资金，无法估算敞口"}

    alloc = round(cap * SIZE_RATIOS[size], 2)
    base["alloc_amount"] = alloc

    if tier == "flat":
        return {**base, "ok": True, "contracts": 0, "delta_notional": 0.0,
                "theta_daily": 0.0, "vega_per_pct": 0.0}

    if tier == "etf":
        return {**base, "ok": True, "contracts": None, "delta_notional": alloc,
                "theta_daily": 0.0, "vega_per_pct": 0.0}

    # 持认购 / 持认沽：用优选合约换算张数与 Greeks
    unit = unit or {}
    premium = _positive(unit.get("premium"))
    s_now = _positive(unit.get("price"))
    try:
        delta = float(unit.get("delta"))
    except (TypeError, ValueError):
        delta = None
    if premium is None or s_now is None or delta is None or not math.isfinite(delta) \
            or delta == 0:
        return {**base, "ok": False,
                "reason": "缺少优选合约的报价或 Greeks，无法估算期权档位敞口"}

    contracts = int(alloc // (premium * CONTRACT_MULTIPLIER))
    # 认沽为空头方向敞口（负 Delta），与认购相加才是组合净敞口
    sign = -1.0 if tier == "put" else 1.0
    per_contract_delta = abs(delta) * s_now * CONTRACT_MULTIPLIER
    return {
        **base, "ok": True, "contracts": contracts,
        "per_contract_delta": round(per_contract_delta, 2),
        "delta_notional": round(sign * contracts * per_contract_delta, 2),
        "theta_daily": round(contracts * (_finite(unit.get("theta")) or 0.0) * CONTRACT_MULTIPLIER, 2),
        "vega_per_pct": round(contracts * (_finite(unit.get("vega")) or 0.0) * CONTRACT_MULTIPLIER, 2),
    }


def portfolio_exposure(holdings: list[dict], total_capital: float | None) -> dict:
    """多档位汇总（当前只用一个档位，但保持可加性）。"""
    ok = [h for h in holdings if h.get("ok")]
    if not ok:
        return {"ok": False, "estimate": True,
                "reason": (holdings[0].get("reason") if holdings else "无有效敞口输入")}
    total = sum((h.get("delta_notional") or 0.0) for h in ok)
    return {"ok": True, "estimate": True,
            "delta_notional": round(total, 2),
            "theta_daily": round(sum((h.get("theta_daily") or 0.0) for h in ok), 2),
            "vega_per_pct": round(sum((h.get("vega_per_pct") or 0.0) for h in ok), 2),
            "contracts": sum((h.get("contracts") or 0) for h in ok) or None,
            "items": ok}


# ═══════════════════════════════════════════════════════════════════════════
# 4. 限额与减仓建议
# ═══════════════════════════════════════════════════════════════════════════

def limits(risk_pct: float | None, total_capital: float | None) -> dict:
    """组合 Greeks 限额：主显元、副显比例；元值由总资金按风险偏好档推导。"""
    prof = risk_profile(risk_pct)
    ratios = LIMIT_RATIOS[prof]
    cap = _positive(total_capital)
    return {
        "profile": prof,
        "profile_label": PROFILE_LABELS[prof],
        "ratios": dict(ratios),
        "amounts": None if cap is None else {k: round(cap * v, 2) for k, v in ratios.items()},
    }


def check_limits(exposure: dict, lim: dict, *,
                 per_contract_delta: float | None = None) -> dict:
    """触限判定与减仓建议。

    判定口径：``|Delta 敞口| > 限额`` 才算触限 —— 恰好相等不触限（与测试一致）。
    触限时给出**可执行的张数建议**（「减到 N 张」），而不是只报数字。
    """
    amounts = (lim or {}).get("amounts")
    if not amounts:
        return {"checked": False, "note": "未设置总资金，无法对比限额"}
    if not exposure or not exposure.get("ok"):
        return {"checked": False, "note": exposure.get("reason") if exposure else "无敞口数据"}

    limit_delta = amounts.get("delta")
    used = abs(exposure.get("delta_notional") or 0.0)
    out = {"checked": True, "used": round(used, 2), "limit": limit_delta,
           "profile": lim.get("profile"), "profile_label": lim.get("profile_label")}
    over = used - limit_delta
    if over <= 0:
        out.update(breached=False, headroom=round(-over, 2))
        return out

    out.update(breached=True, over=round(over, 2), reduce_amount=round(over, 2))
    contracts = exposure.get("contracts")
    if per_contract_delta and contracts:
        need_cut = math.ceil(over / per_contract_delta)
        target = max(int(contracts) - int(need_cut), 0)
        out["reduce_to_contracts"] = target
        out["suggestion"] = f"减到 {target} 张"
    else:
        out["suggestion"] = f"减少约 {round(over, 2)} 元的标的金额当量敞口"
    return out


# ═══════════════════════════════════════════════════════════════════════════
# 5. 策略选择（含临期约束）
# ═══════════════════════════════════════════════════════════════════════════

def select_strategy(direction: str | None, iv_pct: float | None,
                    days_to_expiry: int | None = None,
                    next_month_days: int | None = None,
                    iv_sample_days: int | None = None) -> dict:
    """策略类型判定（纯函数）。

    仅产出买方四类（`docs/adr/0002`）：买单腿认购 / 买单腿认沽 / 垂直价差 / 观望。
    高 IV 分位（≥75）时不裸买 —— 看多改牛市看涨价差、看空改熊市看跌价差、震荡观望；
    低分位（≤25）与中性区间按方向买单腿。

    临期约束：当月距到期 ≤3 天时排除「新开当月」头寸，整体改推次月；
    次月不可用时明确建议观望，并说明当月为何被排除。
    """
    result = {
        "strategy": STRATEGY_WAIT,
        "label": STRATEGY_LABELS[STRATEGY_WAIT],
        "reason": "方向不明确，观望。",
        "month": "front",
        "excluded_front": False,
        "degraded": False,
        "iv_pct": iv_pct,
        "days_to_expiry": days_to_expiry,
    }

    if direction not in ("call", "put"):
        if iv_pct is not None and iv_pct >= IV_HIGH_PCT:
            result["reason"] = f"震荡且 IV 分位 {iv_pct:.0f}% 偏高，权利金贵，宜观望。"
        elif iv_pct is not None and iv_pct <= IV_LOW_PCT:
            result["reason"] = (f"方向不明确，观望（IV 分位 {iv_pct:.0f}% 偏低，"
                                f"可等方向明朗后再入场）。")
        return result

    # ① IV 分位决定「裸买还是用价差」
    degraded = iv_pct is None
    if degraded:
        # 退回中性口径：IV 历史样本不足，不据此改变策略类型，只做标注
        strategy = STRATEGY_SINGLE_CALL if direction == "call" else STRATEGY_SINGLE_PUT
        tail = (f"IV 分位样本不足（仅 {iv_sample_days} 天），未能判断权利金贵贱，"
                f"按中性处理：方向明确时用买单腿，请自行确认权利金是否偏贵。"
                if iv_sample_days else
                "IV 分位样本不足，未能判断权利金贵贱，按中性处理：方向明确时用买单腿。")
    elif iv_pct >= IV_HIGH_PCT:
        if direction == "call":
            strategy = STRATEGY_VERTICAL
            tail = f"IV 分位 {iv_pct:.0f}% 偏高，权利金贵，用牛市看涨价差替代裸买认购以降低成本。"
        else:
            strategy = STRATEGY_VERTICAL
            tail = f"IV 分位 {iv_pct:.0f}% 偏高，权利金贵，用熊市看跌价差替代裸买认沽以降低成本。"
    else:
        strategy = STRATEGY_SINGLE_CALL if direction == "call" else STRATEGY_SINGLE_PUT
        if iv_pct <= IV_LOW_PCT:
            tail = f"IV 分位 {iv_pct:.0f}% 偏低，权利金便宜，宜直接买单腿。"
        else:
            tail = f"IV 分位 {iv_pct:.0f}% 处于中性区间，按方向买单腿。"

    result.update(strategy=strategy, label=STRATEGY_LABELS[strategy], degraded=degraded,
                  reason=tail)
    if strategy == STRATEGY_VERTICAL:
        result["vertical_kind"] = "bull_call" if direction == "call" else "bear_put"
        result["label"] = ("牛市看涨价差" if direction == "call" else "熊市看跌价差")

    # ② 临期约束：当月 ≤3 天时整体改推次月
    if days_to_expiry is not None and days_to_expiry <= CRITICAL_DAYS:
        if next_month_days is None:
            return {**result, "strategy": STRATEGY_WAIT, "label": STRATEGY_LABELS[STRATEGY_WAIT],
                    "reason": (f"当月合约距到期仅 {days_to_expiry} 天已临期，"
                               f"且次月不可用，建议观望。"),
                    "excluded_front": True}
        return {**result, "month": "next", "excluded_front": True,
                "reason": (f"{result['reason']} 当月合约距到期仅 {days_to_expiry} 天已临期，"
                           f"排除新开当月，改推次月（距到期 {next_month_days} 天）。")}

    return result


# ═══════════════════════════════════════════════════════════════════════════
# 6. 大模型输出与规则层对齐
# ═══════════════════════════════════════════════════════════════════════════

# 规则层的策略类型 → 对应的决策动作
_ACTION_OF_STRATEGY = {
    STRATEGY_SINGLE_CALL: "buy_call",
    STRATEGY_SINGLE_PUT: "buy_put",
    STRATEGY_WAIT: "wait",
}


# 决策动作 → 中文（调整提示直接给用户看，不能漏内部枚举名）
ACTION_LABELS = {
    "buy_call": "买入认购",
    "buy_put": "买入认沽",
    "bull_call_spread": "牛市看涨价差",
    "bear_put_spread": "熊市看跌价差",
    "wait": "观望",
}


def _action_label(action) -> str:
    if isinstance(action, str) and action in ACTION_LABELS:
        return ACTION_LABELS[action]
    if action in (None, ""):
        return "未给出"
    return str(action)


def expected_action(strategy: dict | None) -> str | None:
    """规则层策略类型对应的决策动作；无法判定时返回 None（不做约束）。"""
    if not isinstance(strategy, dict):
        return None
    kind = strategy.get("strategy")
    if kind == STRATEGY_VERTICAL:
        return "bull_call_spread" if strategy.get("vertical_kind") == "bull_call" \
            else "bear_put_spread"
    return _ACTION_OF_STRATEGY.get(kind)


def align_llm_decision(parsed: dict | None, strategy: dict | None,
                       position: dict | None) -> dict:
    """把大模型输出与规则层对齐（纯函数）。

    受众是日内期权交易者，两件事不能含糊：
    1) 规则层说「观望」时，模型不得给出买入动作 —— 否则界面上会出现一个与
       方向评分相矛盾的买单；
    2) 模型给的张数不得超过手数上限 —— 否则风险预算形同虚设。

    修订后返回 ``{decision, adjustments}``；被改写前的原值保留在 ``model_action``
    / ``model_contracts`` 里，调整原因逐条列出，不做静默篡改。
    """
    if not isinstance(parsed, dict) or parsed.get("error"):
        return {"decision": parsed, "adjustments": []}

    out = dict(parsed)
    notes: list[str] = []

    want = expected_action(strategy)
    got = out.get("action")
    if want and got != want:
        notes.append(f"模型建议「{_action_label(got)}」与规则层策略「{_action_label(want)}」"
                     f"不一致，已按规则层为准。")
        out["model_action"] = got
        out["action"] = want
        if want == "wait":
            # 观望不该再留合约，否则卡片自相矛盾
            for key in ("contract_code", "contract_name"):
                out[key] = ""

    cap = (position or {}).get("max_contracts")
    qty = out.get("contracts")
    if isinstance(cap, int) and not isinstance(cap, bool) \
            and isinstance(qty, (int, float)) and not isinstance(qty, bool) and qty > cap:
        notes.append(f"模型建议 {qty:g} 张超过手数上限 {cap} 张，已收敛到上限。")
        out["model_contracts"] = qty
        out["contracts"] = cap

    return {"decision": out, "adjustments": notes}
