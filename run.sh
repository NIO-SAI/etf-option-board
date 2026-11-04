#!/bin/bash
# 启动后端（含监控循环与 Kronos 预热），并托管 web/dist 前端。
#
# 解释器：设了 ETF_PY 就只用它；否则依次试 项目 .venv → ~/.browser-use-env → PATH 里的 python3，
# 取第一个装齐依赖的。首次准备环境：
#   uv venv .venv && uv pip install --python .venv/bin/python -r requirements.txt
# 额外参数原样传给 uvicorn（同名参数以后者为准），如仅本机访问：bash run.sh --host 127.0.0.1
set -euo pipefail
cd "$(dirname "$0")"

DEPS="import fastapi, uvicorn, httpx, pypinyin"
if [ -n "${ETF_PY:-}" ]; then
  CANDS=("$ETF_PY")
else
  CANDS=(.venv/bin/python "$HOME/.browser-use-env/bin/python3" python3)
fi
PY=""
for c in "${CANDS[@]}"; do
  if command -v "$c" >/dev/null 2>&1 && "$c" -c "$DEPS" 2>/dev/null; then
    PY=$c
    break
  fi
done
if [ -z "$PY" ]; then
  echo "[error] 没找到装齐依赖（${DEPS}）的 Python，试过：${CANDS[*]}" >&2
  echo "        先执行：uv venv .venv && uv pip install --python .venv/bin/python -r requirements.txt" >&2
  exit 1
fi
echo "[info] Python: $PY"

if [ ! -d web/dist ]; then
  echo "[warn] web/dist 不存在，先构建前端： bash web/build.sh"
fi

# 绑定 0.0.0.0 以便通过局域网 / Tailscale（如 100.x）访问；仅本机可用则加 --host 127.0.0.1
exec "$PY" -m uvicorn app:app --host 0.0.0.0 --port 6799 "$@"
