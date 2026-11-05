"""资金金额统一口径：达到 1 亿按「亿」，不足 1 亿按「万」。

只用于**资金流/成交额**这类金额（元）。持仓敞口、合约张数等不需要跨量级压缩的
数字不要用它，避免把几百元显示成「0.05 万」。
"""

from __future__ import annotations


def money(v: float | int | None, sign: bool = False) -> str:
    """金额（元）格式化。

    ≥1 亿 → 两位小数的「亿」；不足 1 亿 → 「万」，万的小数位随量级收减
    （≥100 万取整、≥1 万留 1 位、更小留 2 位），避免小额被抹成 0 万。
    sign=True 时正数带「+」、负数带「-」；否则只输出绝对值（配「流入/流出」等词用）。
    """
    if v is None:
        return "—"
    try:
        n = float(v)
    except (TypeError, ValueError):
        return "—"
    if n != n or n in (float("inf"), float("-inf")):  # NaN / inf
        return "—"
    a = abs(n)
    if a >= 1e8:
        txt = f"{a / 1e8:.2f}亿"
    else:
        w = a / 1e4
        txt = f"{w:.0f}万" if w >= 100 else f"{w:.1f}万" if w >= 1 else f"{w:.2f}万"
        # 四舍五入后跨过 1 亿（9999.5 万 → 10000 万）时仍按「亿」显示
        if float(txt.rstrip("万")) >= 10000:
            txt = f"{a / 1e8:.2f}亿"
    if sign:
        return f"{'+' if n > 0 else '-' if n < 0 else ''}{txt}"
    return txt
