# Docker 部署指南

本文说明怎样用 Docker 部署看板：拉取 GHCR 镜像、配置私有镜像凭据，以及用 Compose 或 1Panel 启动。

- 镜像：`ghcr.io/nio-sai/etf-option-board`，支持 `linux/amd64` 与 `linux/arm64`
- 标签：`latest`，以及北京时间版本 `YYYYMMDD-HHmmss`（例如 `20261106-143419`）
- 容器端口 `6799`；数据目录 `/app/data`（命名卷 `etf-data`）

> 仓库已从 `xiwen0217/etf-option-board` 转到 `NIO-SAI/etf-option-board`，镜像路径随之变为
> `ghcr.io/nio-sai/...`（GHCR 路径一律小写）。旧路径 `ghcr.io/xiwen0217/...` 不再更新。

## 1. 镜像从哪来

`.github/workflows/publish-image.yml` 自动构建并发布镜像：

- 默认分支收到 push（包括 PR 合并）或在 Actions 页面手动运行时，构建并推送 `latest` 和时间版本
  两个标签，二者指向同一个 digest。时间取构建开始时的北京时间。
- PR 只构建验证，不推送。其他分支跳过发布。
- 镜像路径由运行仓库的 `github.repository` 生成，使用该仓库的 `GITHUB_TOKEN` 登录 GHCR，
  不需要 Docker Hub 账号。fork 启用 Actions 后会发布到 fork 自己的路径。
- 镜像的 OCI version 标签是时间版本，revision 标签是源码提交哈希。

找最新版本：打开仓库的 Actions 页面查看「构建与发布 GHCR 镜像」最近一次成功运行，
或者看 GitHub 仓库主页右侧 Packages 里的 tag 列表。

## 2. 私有镜像的拉取凭据

GHCR 包首次发布时**默认是私有的**，与仓库是否公开无关。未登录时拉取会报：

```
Error response from daemon: error from registry: unauthorized
```

NIO-SAI 组织目前禁止公开包（包设置里 Public 选项灰掉，提示
"Setting is disabled by organization administrators"），所以部署机必须先登录。
想改成免登录拉取，需要组织 **Owner**（仓库 Admin 不够）在
`Organization Settings → Packages → Package creation` 里允许 Public，
再到包设置的 Danger Zone 把可见性改成 Public。

### 2.1 创建只读 token（classic PAT）

部署机专用，只给拉镜像的最小权限：

1. 打开 <https://github.com/settings/tokens/new?scopes=read:packages&description=ghcr-pull-etf-option-board>
   （已预选 `read:packages` 并填好备注）。
2. 只保留 `read:packages`，有效期建议 90 天。
3. 生成后立刻复制 `ghp_` 开头的 token（页面关闭后无法再查看），保存到权限为 600 的文件，
   例如 `~/.config/ghcr-pull-token`。

前提：token 所属账号是 NIO-SAI 组织成员，且对 `etf-option-board` 包有读权限
（默认从源仓库继承访问权限）。

**不要**把自己日常用的 `gh` token（带 `repo`/`workflow` 等权限）放到服务器上。
token 泄露时到 <https://github.com/settings/tokens> 删除即可。

### 2.2 登录 GHCR

```bash
cat ~/.config/ghcr-pull-token | docker login ghcr.io -u <GitHub用户名> --password-stdin
docker pull ghcr.io/nio-sai/etf-option-board:latest
```

只想验证 token、不影响本机现有登录时，可以用临时配置目录：

```bash
T=$(mktemp -d)
cat ~/.config/ghcr-pull-token | docker --config "$T" login ghcr.io -u <GitHub用户名> --password-stdin
docker --config "$T" manifest inspect ghcr.io/nio-sai/etf-option-board:latest >/dev/null && echo OK
rm -rf "$T"
```

本机已经装了 `gh` 时，也可以给 `gh` 的 token 加上读包权限后直接用它登录（仅限个人电脑）：

```bash
gh auth refresh -h github.com -s read:packages
gh auth token | docker login ghcr.io -u <GitHub用户名> --password-stdin
```

## 3. 方式一：在源码仓库里用 Compose

适合部署机上有完整克隆的情况。`scripts/compose.sh` 会从 `GITHUB_REPOSITORY` 环境变量或
Git 的 `origin` 推出镜像路径（HTTPS、SSH 地址都支持，自动转小写），不修改 `.env`：

```bash
bash scripts/compose.sh pull
bash scripts/compose.sh up -d --no-build   # 打开 http://<主机IP>:6799
bash scripts/compose.sh logs -f
```

可选配置写在 `docker-compose.yml` 同目录的 `.env`（已 gitignore）：

```bash
ETF_IMAGE=ghcr.io/nio-sai/etf-option-board:20261106-143419   # 固定版本；不填则用 :latest
ETF_PORT=6799                                                # 宿主机端口
LLM_API_KEY=...                                              # 大模型决策用的 opencode key
```

部署端只有 `docker-compose.yml`、没有 Git 信息时，Compose 自己推不出仓库，需要在 `.env` 里写
`GITHUB_REPOSITORY=nio-sai/etf-option-board` 或完整的 `ETF_IMAGE`，再执行
`docker compose pull && docker compose up -d --no-build`。两者都没配置时会明确报错。

从当前源码本地构建：`bash scripts/compose.sh up -d --build`。前端在镜像构建阶段生成，
无需提交 `web/dist/`；本地构建不会推送到 GHCR。

## 4. 方式二：1Panel

### 4.1 添加 GHCR 仓库

**容器 → 仓库 → 创建仓库**：

| 字段 | 值 |
|---|---|
| 名称 | `ghcr`（随意） |
| 下载地址 | `ghcr.io`（不带 `https://`） |
| 协议 | `https` |
| 认证 | 开启 |
| 用户名 | GitHub 用户名 |
| 密码 | 2.1 生成的 `ghp_` token |

保存后 1Panel 会在宿主机执行 `docker login ghcr.io`，之后拉 `ghcr.io/nio-sai/...` 都会带上凭据。

### 4.2 创建编排

**容器 → 编排 → 创建编排**，选「编辑」，名称 `etf-option-board`，粘贴下面的内容。
它由仓库里的 `docker-compose.yml` 简化而来：1Panel 上没有源码，所以去掉了 `build` 段，镜像写死。

```yaml
services:
  etf-option-board:
    image: ghcr.io/nio-sai/etf-option-board:latest   # 或固定版本，如 :20261106-143419
    container_name: etf-option-board
    restart: unless-stopped
    ports:
      # /api/admin/* 没有鉴权；走反向代理时改成 "127.0.0.1:6799:6799"
      - "6799:6799"
    environment:
      TZ: Asia/Shanghai
      LLM_API_KEY: ""        # 大模型决策用的 opencode key，不填则该功能显示不可用
    volumes:
      - etf-data:/app/data   # 设置、自选、板块库、分钟线累积，重建容器不丢

volumes:
  etf-data:
```

确认后 1Panel 会拉取镜像并启动。用 `curl http://<服务器IP>:6799/api/health` 检查服务。

### 4.3 对外访问

建议端口只绑 `127.0.0.1`，再用 **网站 → 创建网站 → 反向代理** 代理到
`http://127.0.0.1:6799` 并申请 HTTPS 证书。浏览器系统通知只在 HTTPS（安全上下文）下可用；
告警走 SSE，反向代理不要开响应缓冲。

### 4.4 升级与续期

- 升级：在编排里改 tag 后点「重建」；用 `:latest` 时先在编排页拉取镜像再重建。数据卷不受影响。
- token 到期后拉取会再报 `unauthorized`：生成新 token，在 **容器 → 仓库** 编辑 `ghcr` 这条记录，
  把密码换掉即可。

## 5. 运行约定

- 数据（设置、自选、板块库、分钟线累积）在命名卷 `etf-data`，挂载到容器内 `/app/data`。
  重建容器会复用该卷；`docker compose down -v` 会**删除卷及其中数据**。
- Dockerfile 与 Compose 都设置 `TZ=Asia/Shanghai`：交易时段判断依赖本地时间，不要改成 UTC。
- 大模型决策需要 `LLM_API_KEY`。容器里没有 opencode CLI，免费额度用尽后不会回落 CLI 通道。
- Kronos 预测在容器内不可用（依赖宿主机的 facecat-kronos 环境），预测区显示离线。
- `/api/admin/restart` 会关闭后台资源后退出主进程，由 `restart: unless-stopped` 自动拉起。
  手动 `docker compose stop` 后不会自动拉起，需要 `up -d` 恢复。
  `/api/admin/deploy` 不支持容器内重建前端，改代码后请重新发布镜像。
- `/api/admin/*` 没有鉴权，默认端口对所有网卡开放；只想本机访问就把端口改成 `127.0.0.1:6799:6799`。
- 容器自带健康检查（`curl /api/health`），`docker ps` 的 STATUS 列可看到 healthy/unhealthy。

## 6. 排障

| 现象 | 原因与处理 |
|---|---|
| `pull` 报 `unauthorized` | 包是私有的且未登录，或 token 过期、缺 `read:packages`。按第 2 节重新登录。 |
| `pull` 报 `manifest unknown` | tag 写错，或那次构建没成功推送。到 Actions 页面核对运行日志里的标签。 |
| `pull` 报 `denied` | 账号已登录但对包没有读权限。请仓库 Admin 在包设置的 Manage access 里添加。 |
| Compose 报「请用 bash scripts/compose.sh 执行…」 | 没有 Git 信息也没设置 `GITHUB_REPOSITORY`/`ETF_IMAGE`，见第 3 节。 |
| 页面能开但没数据 | 先 `curl /api/health`，再按 `AGENTS.md`「数据源策略」排查数据链路，别先怪没开盘。 |
| 重启后设置/自选丢了 | 数据卷没挂上或执行过 `down -v`，检查 `volumes` 配置。 |
