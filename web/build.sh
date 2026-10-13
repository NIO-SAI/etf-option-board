#!/bin/bash
# 构建前端到 web/dist（后端会托管该目录）。
set -euo pipefail
cd "$(dirname "$0")"
export npm_config_registry="${npm_config_registry:-https://registry.npmmirror.com}"
if [ ! -d node_modules ]; then
  npm install --no-audit --no-fund
fi
npm run build
echo "[ok] 已构建到 web/dist"
