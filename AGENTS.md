# AGENTS.md — ETF 期权日内决策看板

## 项目概览

A 股 9 只可交易期权的宽基 ETF 的**日内决策看板**。后端 FastAPI（Python）聚合东财行情/期权链/
资金流/指数/外围，内置 BS 定价、Kronos 预测桥、大模型决策、实时告警；前端 REUI + React +
Vite + Tailwind v4，深色看板，SSE 弹窗+声音告警。

## 关键命令

```bash
bash run.sh           # 启动后端 :6799（含监控循环 + Kronos 预热，托管 web/dist）
bash web/build.sh     # 构建前端到 web/dist
bash web/dev.sh       # 前端开发模式 :5273（/api 代理到 :6799）
```

- **Python 解释器必须用** `/Users/xinxin/.browser-use-env/bin/python3`（含 fastapi/uvicorn/httpx）。
- 前端 npm 依赖走国内镜像（npmmirror），脚本已设 `npm_config_registry`。
- 无测试框架；用 `curl http://127.0.0.1:6799/api/health` 做冒烟。
- 后端托管 `web/dist`（生产模式）：**改前端后必须 `bash web/build.sh`**，否则页面不变。
  HTML 响应带 `no-store`，页脚有「构建 <bundle-hash>」戳可用于核对已加载的构建。
- 已装 LaunchAgent `com.etf-option-board` 常驻 `:6799`（崩溃自动拉起）。手动起服务前先确认
  端口未被它占用（`launchctl print gui/$(id -u)/com.etf-option-board`），日志 `/tmp/etf-option-board.log`。

## 架构与约定

- `services/em.py` 是唯一网络出口：手拼 query（`safe=",:"`，否则 `fs=m:10` 变 `%3A` 返回空），
  直连失败自动退 `curl` 并记忆路径，统一 TTL 缓存；`get_json` 失败**返回上次成功缓存**
  （stale-while-error，绝不抛异常）。新接口都加在这里。
- 加一个接口：后端路由写 `routers/api.py`（前缀 `/api`），业务逻辑放 `services/`；
  前端在 `web/src/lib/api.ts` 加方法，轮询用 `web/src/lib/usePolling.ts`。K 线 `klt∈{1,5,15,30,60,101}`（3 分钟本地由 1 分钟聚合）。
- **数据源策略（重要，2026-10 起）**：本机出口经代理（境外 IP），东财 `push2/push2his` 常被反爬
  限流（空回包）。故行情/期权链主源改用 **`emdatah5.eastmoney.com`**（`getZJLXData`＝个股/指数/
  外围/期权行情+资金流，`getZDYLBData`＝clist 同参同构），K线/分时走**腾讯**（`ifzq.gtimg.cn`），
  `push2/push2his` 仅兜底。排查"没数据"先看这三条链路，别急着怪"没开盘"。
- `services/universe.py` 维护标的/指数/外围/国家队清单；改标的只改这里。
- 期权链：东财 `fs=m:10`(沪)/`m:12`(深) 全量列表，按简称前缀切分。**注意前缀顺序**
  （`科创50` vs `科创板50`，`300ETF` vs `沪深300ETF`）。
- 隐波/希腊字母由 `services/bs.py` 自算（Eastmoney 不直接给），到期日 = 到期月第 4 个星期三。
- 前端组件：REUI（`web/src/components/reui/*`，Tailwind v4 语法）与自研 shadcn 风格
  `web/src/components/ui/*` 混用；图表用 ECharts（`components/charts`）。
- 所有 API 失败**降级返回 `{error}`，不抛 500**。

## 依赖的外部资产

- Kronos：`/Users/xinxin/workspace/facecat-kronos`（`.venv` + `model/hf-cache`）。缺则预测区显示离线。
- LLM：`~/.local/share/opencode/auth.json` 的 `opencode-go` key，端点 `https://opencode.ai/zen/go/v1`，
  **必须带 `x-opencode-session: <uuid>` 头**。模型为推理模型，`max_tokens` 需给足。

## 风险/合规

- 数据为公开接口快照，非交易级；仅供研究，不构成投资建议。
- 不提交 `.env`/密钥；`web/node_modules`、`__pycache__` 已 gitignore。
