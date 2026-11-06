# syntax=docker/dockerfile:1
# ETF 期权日内决策看板：Vite 构建前端 → FastAPI 托管 web/dist，单容器跑在 :6799。
#
# 本地构建：docker build -t vissong/etf-option-board:latest .
# 多架构构建并推送到自己的仓库，详见 README「Docker 部署」。

# ---- 前端：产物是纯静态文件，固定在构建机原生架构上跑，省掉 QEMU 模拟 ----
FROM --platform=$BUILDPLATFORM node:22-alpine AS web
WORKDIR /web
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV npm_config_registry=$NPM_REGISTRY
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- 运行时 ----
FROM python:3.13-slim
# curl：services/em.py 直连失败时的兜底通道；tzdata + TZ：交易时段判断全用本地 naive 时间，不能是 UTC
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl tzdata \
 && rm -rf /var/lib/apt/lists/*
ENV TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN useradd --create-home --uid 1000 app \
 && mkdir /app && chown app:app /app
WORKDIR /app
COPY requirements.txt ./
RUN pip install -r requirements.txt

# 代码归 app 用户：/api/admin/deploy 的 py_compile 要在 /app 和各子目录写 __pycache__
COPY --chown=app:app app.py config.py ./
COPY --chown=app:app routers ./routers
COPY --chown=app:app services ./services
COPY --chown=app:app scripts ./scripts
COPY --chown=app:app --from=web /web/dist ./web/dist
RUN mkdir -p data && chown app:app data

USER app
EXPOSE 6799
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:6799/api/health >/dev/null || exit 1
CMD ["python", "-m", "uvicorn", "app:app", "--host", "0.0.0.0", "--port", "6799"]
