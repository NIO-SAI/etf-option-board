"""按期权简称前缀剔除合约清单里的标的（一次性维护脚本）。

用途：从 `services/universe.py::ETFS` 删掉某只 ETF 后，`data/option_universe.json`
里它的合约还会被 `option_snapshot_batch` 每分钟拉报价、写分钟线。本脚本用 ulist 拉回
每个 secid 的合约简称，按前缀剔除后回写——**不删文件**：clist 在本机被封，删了清单
可能重建不出来。

用法：
    python3 scripts/prune_option_universe.py                    # 用已删标的的默认前缀
    python3 scripts/prune_option_universe.py 科创板50 沪深300ETF 中证500ETF
    python3 scripts/prune_option_universe.py --dry-run          # 只打印将要删多少
"""

from __future__ import annotations

import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from services import em  # noqa: E402

# 2026-11-04 收敛掉的 3 只 ETF 对应的东财期权简称前缀
DEFAULT_PREFIXES = ["科创板50", "沪深300ETF", "中证500ETF"]


async def _names(secids: list[str], chunk: int = 400) -> dict[str, str]:
    """secid → 合约简称（ulist 批量，一次 400 只）。"""
    out: dict[str, str] = {}
    for i in range(0, len(secids), chunk):
        part = secids[i:i + chunk]
        d = await em.get_json(em._ULIST_URL, {
            "secids": ",".join(part), "fltt": 2, "invt": 2, "ut": em._UT,
            "fields": "f12,f14",
        }, ttl=0.0)
        for row in ((d or {}).get("data") or {}).get("diff") or []:
            code, name = row.get("f12"), row.get("f14") or ""
            if not code or not name:
                continue
            # 沪市期权 secid = 10.<code>，深市 = 12.<code>
            market = "10" if code.startswith("100") else "12"
            out[f"{market}.{code}"] = name
    return out


async def main(argv: list[str]) -> int:
    dry = "--dry-run" in argv
    prefixes = [a for a in argv if not a.startswith("-")] or DEFAULT_PREFIXES
    em._opt_universe_load()
    secids = list(em._OPT_UNIVERSE)
    if not secids:
        print("清单为空，无需处理")
        return 1

    names = await _names(secids)
    drop = [s for s in secids if any(names.get(s, "").startswith(p) for p in prefixes)]
    keep = [s for s in secids if s not in set(drop)]
    print(f"清单 {len(secids)} 个，取回简称 {len(names)} 个")
    print(f"前缀 {prefixes} 命中 {len(drop)} 个，保留 {len(keep)} 个")
    for p in prefixes:
        n = sum(1 for s in drop if names.get(s, "").startswith(p))
        print(f"  - {p}: {n}")
    if not drop:
        return 0
    if dry:
        print("dry-run，未回写")
        return 0
    em._opt_universe_save(keep)
    print(f"已回写 {em._OPT_UNIVERSE_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main(sys.argv[1:])))
