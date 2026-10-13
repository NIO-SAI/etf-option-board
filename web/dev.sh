#!/bin/bash
# 前端开发模式（Vite，端口 5273，/api 代理到 6799）。
set -euo pipefail
cd "$(dirname "$0")"
export npm_config_registry="${npm_config_registry:-https://registry.npmmirror.com}"
[ -d node_modules ] || npm install --no-audit --no-fund
exec npm run dev
