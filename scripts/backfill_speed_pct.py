#!/usr/bin/env python3
"""回填「涨速」与指数涨跌幅（历史数据没有这两列时用）。

背景：板块排行早期只采了 f3(涨跌幅)/f62(资金)，没有 f22(涨速)；指数排行的涨跌幅来自
4 维接口的 f170，也是后加的。老数据因此 speed=0、pct=0，排序和展示会缺项。

本脚本按「当前行情快照」回填指定日期的 speed/pct（仅对当日收盘后的静态值有意义），
默认处理库内最新有数据的那一天。

用法：
    python3 scripts/backfill_speed_pct.py            # 最新日期
    python3 scripts/backfill_speed_pct.py --date 2026-11-04
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from services import boardflow as bf  # noqa: E402
from services import em  # noqa: E402

_FIELDS = "f2,f3,f4,f12,f13,f14,f22,f62"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--date", default="", help="YYYY-MM-DD，默认库内最新日期")
    return p.parse_args()


async def main() -> int:
    args = parse_args()
    bf.init_db()
    date = args.date or (bf.available_dates(1) or [""])[0]
    if not date:
        print("[ERR] 库里没有任何排行数据")
        return 1
    print(f"回填日期 {date}")

    updated = 0
    for fs, btype in (("m:90+t:3", "concept"), ("m:90+t:2", "industry")):
        rows = await em.clist_all(fs, _FIELDS, pz=100, max_page=8, ttl=5.0)
        parsed = bf.parse_rank_rows(rows, btype)
        if not parsed:
            print(f"  {btype}: 接口无数据，跳过")
            continue
        with bf._db() as conn:  # noqa: SLF001 — 一次性的运维回填
            conn.executemany(
                "UPDATE rank_snapshots SET pct=?, speed=? WHERE date=? AND code=?",
                [(float(r["pct"]), float(r["speed"]), date, r["code"]) for r in parsed])
        updated += len(parsed)
        print(f"  {btype}: 更新 {len(parsed)} 行（pct/涨速）")

    # 指数涨跌幅：4 维表里每个非 BK 代码取一次 f170
    with bf._db() as conn:  # noqa: SLF001
        codes = [r[0] for r in conn.execute(
            "SELECT DISTINCT code FROM em_flow_points WHERE date=? AND code NOT LIKE 'BK%'",
            (date,)).fetchall()]
    idx_updated = 0
    for code in codes:
        q = await em.stock_get(code, "f170", ttl=5.0)
        if not isinstance(q, dict) or q.get("f170") in (None, "", "-"):
            continue
        try:
            pct = float(q["f170"])
        except (TypeError, ValueError):
            continue
        with bf._db() as conn:  # noqa: SLF001
            conn.execute("UPDATE em_flow_points SET pct=? WHERE date=? AND code=?", (pct, date, code))
        idx_updated += 1
    print(f"  指数: 更新 {idx_updated}/{len(codes)} 个涨跌幅")

    print(f"完成：板块 {updated} 行、指数 {idx_updated} 个")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
