#!/bin/bash
# 给 Compose 补齐仓库身份；不写 .env，保留其中的 ETF_IMAGE、端口和密钥配置。
set -euo pipefail
cd "$(dirname "$0")/.."

repository=${GITHUB_REPOSITORY:-}
if [ -z "$repository" ]; then
  remote=$(git remote get-url origin 2>/dev/null || true)
  case "$remote" in
    https://github.com/*) repository=${remote#https://github.com/} ;;
    git@github.com:*) repository=${remote#git@github.com:} ;;
    ssh://git@github.com/*) repository=${remote#ssh://git@github.com/} ;;
  esac
  repository=${repository%/}
  repository=${repository%.git}
fi

if [ -n "$repository" ]; then
  # GHCR 镜像路径必须小写；不把 remote 的凭据或任意 URL 带进镜像名。
  repository=$(printf '%s' "$repository" | tr '[:upper:]' '[:lower:]')
  if [[ ! "$repository" =~ ^[a-z0-9][a-z0-9-]*/[a-z0-9][a-z0-9._-]*$ ]]; then
    echo "[error] GITHUB_REPOSITORY 必须是 GitHub 的 owner/repo 格式。" >&2
    exit 1
  fi
  export GITHUB_REPOSITORY="$repository"
fi

# 无 Git 信息时仍允许通过 .env 的 GITHUB_REPOSITORY / ETF_IMAGE 使用 Compose。
export VCS_REF="${VCS_REF:-$(git rev-parse --verify HEAD 2>/dev/null || true)}"
exec docker compose "$@"
