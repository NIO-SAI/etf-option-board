"""全A逐笔分档直方图：通达信 / Wind 两套「资金流向」口径的复刻。

口径要点（2026-11-06 实测，取舍见 `docs/adr/0005-全A逐笔分档直方图.md`）：

- 数据 = 东财 `details/get` 逐笔（每只 1 个请求；全A 约 5200 只、10 并发约 80~100 秒）；
- 方向字段 `p[4]`：`"2"` 才是**主动买**（外盘）、`"1"` 是主动卖（内盘），
  `"4"` 是**集合竞价虚拟撮合**（3 秒一次重复累计，必须剔除，否则茅台会被算成 3 倍成交额）；
- 每笔金额 = 价格 × 手数 × 100；按单笔金额分档，**每笔只记主动方一次**，
  所以各档「买 + 卖」之和 = 全市场成交额；各档净额相加 = 全市场主动净额（外盘 − 内盘），不为 0；
- 与东财 `f62/f140/...` 的「双向记账（四档净额合计恒为 0）」不是同一口径，两套数字不可互相对账；
- 两套口径的差别**只在门槛**：
    通达信  主力 ≥200 万 / 跟风 50–200 万 / 散户 <50 万
    Wind    超大单 ≥2000 万 / 主力 500–2000 万 / 大户 20–500 万 / 散户 <20 万
  （Wind 的「机构」线按账户/席位识别，逐笔里拿不到，本模块只给「超大单」，不复刻机构）

本模块只做「抓取 → 分档 → 落库」与「按任意门槛求和」，不碰 HTTP 层，也不写前端。
"""

from __future__ import annotations

import asyncio
import datetime as dt
import logging
import time
from typing import Iterable

from services import boardflow as bf
from services import em

log = logging.getLogger("tape_flow")

# 沪深 A 股（不含北交所）：与通达信 888881 / Wind 全市场的成交额口径一致
FS = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23"
_LIST_FIELDS = "f12,f13,f14,f6"

# 单笔成交额分档切点（万元，升序）。档位 i 覆盖 (CUTS[i-1], CUTS[i]] 万元，档位 0 = < CUTS[0]
CUTS = [1, 2, 3, 5, 7, 10, 15, 20, 25, 30, 40, 50, 60, 70, 100, 130, 150, 200,
        250, 300, 400, 500, 600, 700, 1000, 1300, 1500, 2000, 2500, 3000, 4000,
        5000, 7000, 10000, 20000]

PRESETS: dict[str, dict] = {
    "tdx": {
        "label": "通达信",
        "buckets": [
            {"key": "main", "name": "主力", "thr": 200},
            {"key": "follow", "name": "跟风", "thr": 50},
            {"key": "retail", "name": "散户", "thr": 0},
        ],
    },
    "wind": {
        "label": "Wind",
        "buckets": [
            {"key": "super", "name": "超大单", "thr": 2000},
            {"key": "main", "name": "主力", "thr": 500},
            {"key": "big", "name": "大户", "thr": 20},
            {"key": "retail", "name": "散户", "thr": 0},
        ],
    },
}

SESSION = (("09:30", "11:30"), ("13:00", "15:00"))
SCAN_INTERVAL = 600.0      # 盘中每 10 分钟重算一次（一次约 80~100 秒）
FINAL_HM = "15:05"         # 收盘后再跑一次定稿
CONCURRENCY = 10
MIN_COVERAGE = 0.90        # 覆盖率不足就不覆盖已有数据
AMOUNT_TOL = 0.03          # 与官方两市成交额的允许偏差

_state: dict = {"cycles": 0, "busy": False, "last_run": None, "last_date": None,
                "stocks_ok": 0, "stocks_total": 0, "last_error": None}
_last_scan_mono: float | None = None


# --------------------------------------------------------------------------
# 纯函数（可单测：不触网、不读时钟、不写盘）
# --------------------------------------------------------------------------
def minute_of(hhmmss: str) -> str | None:
    """逐笔时间 → 交易分钟（越界的并到首/尾，午休与盘后不进图）。"""
    s = str(hhmmss or "").strip()
    if len(s) < 5 or s[2] != ":":
        return None
    hm = s[:5]
    if hm < SESSION[0][0]:
        return SESSION[0][0]
    if hm > SESSION[1][1]:
        return SESSION[1][1]
    # 午休（11:30–13:00）不该有连续竞价成交；真有就并到 11:30
    if SESSION[0][1] < hm < SESSION[1][0]:
        return SESSION[0][1]
    return hm


def bin_of(amount: float) -> int:
    """单笔成交额（元）→ 档位下标。"""
    if amount is None or amount <= 0:
        return 0
    wan = amount / 1e4
    i = 0
    for j, cut in enumerate(CUTS):
        if wan >= cut:
            i = j + 1
    return i


def parse_tick(line: str) -> tuple[str, float, int] | None:
    """解析一行逐笔 → (分钟, 金额元, 方向)。方向 +1 主动买 / −1 主动卖；集合竞价返回 None。

    东财字段：time,price,volume(手),笔数,direction；direction "2"=主动买、"1"=主动卖、"4"=集合竞价。
    """
    p = str(line or "").split(",")
    if len(p) < 5 or p[4] not in ("1", "2"):
        return None
    try:
        price = float(p[1])
        vol = float(p[2])
    except (TypeError, ValueError):
        return None
    if price <= 0 or vol <= 0:
        return None
    minute = minute_of(p[0])
    if minute is None:
        return None
    return minute, price * vol * 100.0, (1 if p[4] == "2" else -1)


def session_axis() -> list[str]:
    """09:30–11:30 + 13:00–15:00，共 241 个分钟点。"""
    out: list[str] = []
    for start, end in SESSION:
        sh, sm = (int(x) for x in start.split(":"))
        eh, em_ = (int(x) for x in end.split(":"))
        cur = sh * 60 + sm
        stop = eh * 60 + em_
        while cur <= stop:
            out.append(f"{cur // 60:02d}:{cur % 60:02d}")
            cur += 1
    return out


def snap_threshold(value: float) -> float:
    """把任意门槛吸附到档位表上最近的不低于它的切点（万元）。

    库里存的是 35 个金额档的直方图，单笔金额落在档里就是档；门槛只能取在档边界上，
    否则该档无法拆分。默认两套口径的 200/50/2000/500/20 都在档边界上，不受影响。
    """
    if value is None or value <= 0:
        return 0.0
    for cut in CUTS:
        if cut >= value:
            return float(cut)
    return float(CUTS[-1])


def norm_thresholds(values: Iterable) -> list[float]:
    """门槛归一：吸附到档位边界、去重、降序、末位必须为 0（最后一档兜底到底）。"""
    out: list[float] = []
    for v in values or []:
        try:
            x = float(v)
        except (TypeError, ValueError):
            continue
        if x > 0:
            out.append(snap_threshold(x))
    out = sorted(set(out), reverse=True)
    out.append(0.0)
    return out


def bucket_of_bin(bin_index: int, thresholds: list[float]) -> int:
    """档位下标 → 口径里的第几档（thresholds 降序、末位 0）。"""
    lo = 0.0 if bin_index <= 0 else float(CUTS[bin_index - 1])
    for k, thr in enumerate(thresholds):
        if lo >= thr:
            return k
    return len(thresholds) - 1


def summarize(rows: Iterable[tuple[str, int, float, float]],
              thresholds: Iterable) -> list[dict]:
    """按门槛汇总各档「当日买 / 当日卖 / 净买额 / 占比」。rows = (分钟, 档位, 买, 卖)。"""
    ths = norm_thresholds(thresholds)
    acc = [{"buy": 0.0, "sell": 0.0} for _ in ths]
    for _t, b, buy, sell in rows or []:
        k = bucket_of_bin(int(b), ths)
        acc[k]["buy"] += float(buy or 0)
        acc[k]["sell"] += float(sell or 0)
    total = sum(x["buy"] + x["sell"] for x in acc) or 0.0
    out = []
    for thr, x in zip(ths, acc):
        out.append({"thr": thr, "buy": x["buy"], "sell": x["sell"],
                    "net": x["buy"] - x["sell"],
                    "share": (x["buy"] + x["sell"]) / total if total else 0.0})
    return out


def cumulative(rows: Iterable[tuple[str, int, float, float]],
               thresholds: Iterable, axis: list[str] | None = None) -> list[list[float]]:
    """各档的分钟累计净额（元），按 axis 对齐、缺分钟用前值填充。"""
    axis = axis or session_axis()
    ths = norm_thresholds(thresholds)
    per_min: dict[str, list[float]] = {}
    for t, b, buy, sell in rows or []:
        k = bucket_of_bin(int(b), ths)
        slot = per_min.setdefault(str(t), [0.0] * len(ths))
        slot[k] += float(buy or 0) - float(sell or 0)

    out = [[0.0] * len(ths) for _ in axis]
    running = [0.0] * len(ths)
    for i, minute in enumerate(axis):
        delta = per_min.get(minute)
        if delta:
            for k in range(len(ths)):
                running[k] += delta[k]
        out[i] = list(running)
    return out


def coverage_ok(ok: int, total: int, minimum: float = MIN_COVERAGE) -> bool:
    return bool(total) and ok / total >= minimum


def amount_ok(ours: float, official: float, tol: float = AMOUNT_TOL) -> bool:
    if not official or not ours:
        return False
    return abs(ours - official) / official <= tol


# --------------------------------------------------------------------------
# 抓取：全A逐笔 → 分钟 × 档位直方图
# --------------------------------------------------------------------------
async def _details(secid: str) -> list[str]:
    d = await em.get_json("https://push2.eastmoney.com/api/qt/stock/details/get",
                          {"secid": secid, "fields1": "f1,f2,f3,f4",
                           "fields2": "f51,f52,f53,f54,f55", "pos": "-100000"}, ttl=0)
    return ((d or {}).get("data") or {}).get("details") or []


async def scan() -> dict:
    """拉一次全A逐笔并聚合。返回 {date, rows, amount, stocks_ok, stocks_total, official}。"""
    rows = await em.clist_all(FS, _LIST_FIELDS, pz=100, max_page=80, ttl=0)
    # 注意 f13=0 是「深市」，不能用 `or ""` 兜（0 是假值，会把深市整片丢掉）
    items = []
    for r in rows:
        market = "" if r.get("f13") is None else str(r.get("f13"))
        code = "" if r.get("f12") is None else str(r.get("f12"))
        if market in ("0", "1") and code:
            items.append(f"{market}.{code}")
    total = len(items)
    if not total:
        raise RuntimeError("全A清单为空（clist 可能被限流）")

    agg: dict[tuple[str, int], list[float]] = {}
    ok = 0
    sem = asyncio.Semaphore(CONCURRENCY)

    async def one(secid: str) -> None:
        nonlocal ok
        async with sem:
            try:
                lines = await _details(secid)
            except Exception:  # noqa: BLE001 — 单只失败不影响整体
                return
            if not lines:
                return
            ok += 1
            for line in lines:
                tick = parse_tick(line)
                if not tick:
                    continue
                minute, amount, side = tick
                slot = agg.setdefault((minute, bin_of(amount)), [0.0, 0.0])
                slot[0 if side > 0 else 1] += amount

    await asyncio.gather(*(one(s) for s in items))

    flat = [(m, b, v[0], v[1]) for (m, b), v in agg.items() if v[0] or v[1]]
    amount = sum(v[0] + v[1] for v in agg.values())
    return {"rows": flat, "amount": amount, "stocks_ok": ok, "stocks_total": total}


async def _trading_day() -> tuple[str, float]:
    """最近一个交易日的日期 + 沪深两市官方成交额。

    日期取上证指数日 K 的最后一根（腾讯 K 线 amount 恒为 0，只能给日期）；
    成交额取 push2 ulist 的 f6（上证指数 + 深证成指 = 两市总额），取不到就返回 0 跳过校验。
    """
    bars = await em.kline("1.000001", 101, 3)
    date = str((bars[-1] or {}).get("date") or "") if bars else ""
    if len(date) != 10:
        raise RuntimeError("取不到交易日（上证日 K 为空）")
    total = 0.0
    try:
        d = await em.get_json("https://push2.eastmoney.com/api/qt/ulist.np/get",
                              {"fltt": "2", "invt": "2", "fields": "f12,f14,f6",
                               "secids": "1.000001,0.399001"}, ttl=0)
        for row in ((d or {}).get("data") or {}).get("diff") or []:
            if row.get("f12") in ("000001", "399001"):
                total += float(row.get("f6") or 0)
    except Exception:  # noqa: BLE001 — 校验是附加项，拿不到就不校验
        total = 0.0
    return date, total


async def run_scan(force: bool = False) -> dict:
    """跑一次全A逐笔并落库（整日覆盖）。force=True 时跳过「刚刚跑过」的节流。"""
    global _state, _last_scan_mono
    if _state.get("busy"):
        return {"ok": False, "error": "上一轮还没跑完"}
    _state["busy"] = True
    t0 = time.time()
    try:
        date, official = await _trading_day()
        got = await scan()
        ours, ok, total = got["amount"], got["stocks_ok"], got["stocks_total"]
        if not coverage_ok(ok, total):
            raise RuntimeError(f"覆盖率不足 {ok}/{total}")
        if official and not amount_ok(ours, official):
            raise RuntimeError(f"成交额对不上：逐笔 {ours/1e8:.0f} 亿 vs 官方 {official/1e8:.0f} 亿")
        await asyncio.to_thread(
            bf.save_tape_day, date, got["rows"],
            {"updated_at": dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
             "stocks_total": total, "stocks_ok": ok, "amount": ours})
        _state.update({"cycles": _state.get("cycles", 0) + 1,
                       "last_run": dt.datetime.now().isoformat(timespec="seconds"),
                       "last_date": date, "stocks_ok": ok, "stocks_total": total,
                       "last_error": None})
        _last_scan_mono = time.monotonic()
        log.info("全A逐笔入库 %s：%d 只 / %d 行 / %.0f 亿 / %.0fs",
                 date, ok, len(got["rows"]), ours / 1e8, time.time() - t0)
        return {"ok": True, "date": date, "rows": len(got["rows"]), "amount": ours,
                "stocks_ok": ok, "stocks_total": total, "seconds": round(time.time() - t0, 1)}
    except Exception as exc:  # noqa: BLE001
        _state["last_error"] = str(exc)
        log.warning("全A逐笔失败：%s", exc)
        return {"ok": False, "error": str(exc)}
    finally:
        _state["busy"] = False


def _after_final(now: dt.datetime) -> bool:
    return now.strftime("%H:%M") >= FINAL_HM


async def run_forever() -> None:
    """盘中每 10 分钟重算一次，收盘后 15:05 定稿；其余时间只睡。"""
    while True:
        try:
            now = dt.datetime.now()
            if bf.in_session(now):
                if _last_scan_mono is None or time.monotonic() - _last_scan_mono >= SCAN_INTERVAL:
                    await run_scan()
            elif now.weekday() < 5 and _after_final(now):
                # 收盘后定稿：每个交易日只做一次
                if _state.get("last_date") != now.strftime("%Y-%m-%d"):
                    await run_scan()
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            _state["last_error"] = str(exc)
            log.warning("逐笔采集循环异常：%s", exc)
        await asyncio.sleep(30)


def state() -> dict:
    return dict(_state)
