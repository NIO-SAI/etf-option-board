#!/usr/bin/env python3
"""板块资金分时可用性探针（调试/回归用）。

断言用户看到的症状：打开四个板块页时，当日/最近交易日的分时图有数据。
只要任一接口返回的 axis 点数为空，就以非零码退出并打印是哪一条。

用法：
    python3 scripts/check_board_series.py            # 打本地 6799
    BOARD_BASE=... python3 scripts/check_board_series.py
"""

import json
import os
import sys
import urllib.parse
import urllib.request

BASE = os.getenv("BOARD_BASE", "http://127.0.0.1:6799")


def get(path: str):
    with urllib.request.urlopen(BASE + path, timeout=15) as r:
        return json.loads(r.read().decode())


def latest_date(table: str) -> str:
    return (get(f"/api/board/dates?limit=1")["dates"] or [""])[0]


def main() -> int:
    failures = []

    dates = get("/api/board/dates?limit=5").get("dates") or []
    if not dates:
        print("[FAIL] /api/board/dates 为空：板块库没有任何排行快照")
        return 1
    date = dates[0]

    # 1) 板块分时
    s = get(f"/api/board/series?type=concept&date={date}")
    if len(s.get("axis") or []) < 2:
        failures.append(f"board/series axis={len(s.get('axis') or [])} err={s.get('error')}")

    # 2) ETF 分时
    e = get(f"/api/etf-flow/series?date={date}")
    if len(e.get("axis") or []) < 2:
        failures.append(f"etf-flow/series axis={len(e.get('axis') or [])} err={e.get('error')}")

    # 3) 4 维分时（指数）
    m = get(f"/api/em-flow/series?target_type=index&code=1.000300&date={date}")
    if len(m.get("axis") or []) < 2:
        failures.append(f"em-flow/series axis={len(m.get('axis') or [])} err={m.get('error')}")

    # 4) 详情抽屉的当日分时
    rank = get(f"/api/board/rank?type=concept&date={date}")
    code = (rank.get("items") or [{}])[0].get("code")
    if code:
        d = get(f"/api/board/detail?code={code}&date={date}")
        if len((d.get("series") or {}).get("axis") or []) < 2:
            failures.append(f"board/detail({code}) axis={len((d.get('series') or {}).get('axis') or [])}")

    if failures:
        print(f"[FAIL] {date} 分时图无数据：")
        for f in failures:
            print("  -", f)
        return 1
    print(f"[OK] {date} 四条分时链路均有数据")
    return 0


if __name__ == "__main__":
    sys.exit(main())
