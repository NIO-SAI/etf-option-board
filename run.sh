#!/bin/bash
# 启动后端（含监控循环与 Kronos 预热），并托管 web/dist 前端。
set -euo pipefail
cd "$(dirname "$0")"
PY=/Users/xinxin/.browser-use-env/bin/python3

if [ ! -d web/dist ]; then
  echo "[warn] web/dist 不存在，先构建前端： bash web/build.sh"
fi

# 绑定 0.0.0.0 以便通过局域网 / Tailscale（如 100.x）访问；仅本机可用则改回 127.0.0.1
exec "$PY" -m uvicorn app:app --host 0.0.0.0 --port 6799 "$@"
