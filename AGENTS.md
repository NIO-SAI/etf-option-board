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
- **跨设备 HTTPS 入口（浏览器通知必需）**：Chrome 系统通知（Web Notifications）只在安全上下文
  可用，`http://100.x.x.x:6799`（Tailscale IP，明文）会被浏览器拒绝。已配
  `tailscale serve --bg --https=8443 http://127.0.0.1:6799`，跨设备访问用
  **https://xinxin-mac-mini.tail407c31.ts.net:8443**（Let's Encrypt 有效证书），
  在告警卡头部点「开启浏览器通知」授权即可。`tailscale serve status` 查看入口。
  测试通知：`curl -X POST http://127.0.0.1:6799/api/admin/test-alert`（发 3 条【测试】告警走真实 SSE）。
- 已装 LaunchAgent `com.etf-option-board` 常驻 `:6799`（崩溃自动拉起）。手动起服务前先确认
  端口未被它占用（`launchctl print gui/$(id -u)/com.etf-option-board`），日志 `/tmp/etf-option-board.log`。
- 后端代码更新后重启生效：`curl -s -X POST http://127.0.0.1:6799/api/admin/restart`
  （先优雅关闭 Kronos 子进程再以非零码退出，LaunchAgent 约 5 秒自动拉起；curl 报连接重置属正常）。
  首次上线该接口前需手动重启一次：`launchctl kickstart -k gui/$(id -u)/com.etf-option-board`。
- **Agent 自部署（2026-10-15 起）**：Agent 改完代码后写 `data/.deploy_token`
  （JSON，如 `{"build_frontend": true, "reason": "..."}`），monitor 主循环 30 秒内自动消费
  并执行：`py_compile` 全量校验 → 可选 `bash web/build.sh` 重建前端 → `os._exit(42)`
  由 LaunchAgent 拉起。校验/构建失败则不重启，结果见 `data/.deploy_status`。
  用户也可手动触发：`curl -s -X POST http://127.0.0.1:6799/api/admin/deploy \
  -H 'Content-Type: application/json' -d '{"build_frontend": true}'`（立即返回，后台执行）。
  部署期间服务中断约 1-2 分钟（含前端构建），尽量避开交易时段。

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
- 资金流分钟序列：`services/em.py::fflow` 在交易时段内每次调用都用 emdatah5 快照累积
  并落盘 `data/flow_history.jsonl`（push2 fflow 收盘后常返回空 klines，且经代理易被限流）。
  收盘后/进程重启后用本地累积兜底，保证分时资金流图表可复盘；注意累积的是日累计值
  口径（f137 等），与 push2 的分钟增量口径不同。当日已错过的数据无法回补。
  另保留最近一个有数据的昨日序列：9:15 开盘前当日无数据时自动展示昨日（前端打
  「昨日资金流」角标，`etf_context.flow_day` 标识数据日期），界面不空。
- `services/universe.py` 维护标的/指数/外围/国家队清单；改标的只改这里。
- 期权链：东财 `fs=m:10`(沪)/`m:12`(深) 全量列表，按简称前缀切分。**注意前缀顺序**
  （`科创50` vs `科创板50`，`300ETF` vs `沪深300ETF`）。
- 隐波/希腊字母由 `services/bs.py` 自算（Eastmoney 不直接给），到期日 = 到期月第 4 个星期三。
- 前端组件：REUI（`web/src/components/reui/*`，Tailwind v4 语法）与自研 shadcn 风格
  `web/src/components/ui/*` 混用；图表用 ECharts（`components/charts`）。
- **左侧面板布局约定**：`EtfList` 里「期权标的」列表是唯一的滚动区（`flex-1 overflow-auto`），
  「大盘指数」是**面板固定底栏**（不随列表滚动、矮窗口时内部滚动）——保证 4 个指数行
  始终完整可见。别再把它塞回滚动列表，那正是"看不到某一行"类投诉的根源。
- **排查"用户设备上页面不对"的标准手法**（用户常经 Tailscale 从另一台设备访问，本地无法复现）：
  前端加临时信标，把 bundle 哈希/UA/视口/滚动状态/目标元素 `getBoundingClientRect`+
  `getComputedStyle` 编码进一次 `fetch('/api/health?dbg=...')` 的 query，uvicorn 访问日志
  （`/tmp/etf-option-board.log`）会原样记录，无需重启后端、无需用户操作（用户刷新即可）。
  用 `/tmp/etf-option-board.log` 按客户端 IP 区分设备。**定位后必须删信标并重建。**
- 所有 API 失败**降级返回 `{error}`，不抛 500**。
- **变盘开仓信号**（`services/reversal.py`，2026-10-15 新增）：多/空各一套 0~100 打分
  （1m近3根金叉/死叉+25、3m确认+20、突破近15分钟高低+15、放量+10/+15、主力同向+10/+15、
  指数同向+10、背离+10、时点共振+5），**55 分触发**，critical 级告警带开仓建议
  （方向/因子/标的点位/优选合约/IV分位）。仅 09:40–14:45；同向 20 分钟冷却；
  反向 15 分钟抑制。`GET /api/reversal/signals?code=` 供分时图打标记。

## 依赖的外部资产

- Kronos：`/Users/xinxin/workspace/facecat-kronos`（`.venv` + `model/hf-cache`）。缺则预测区显示离线。
- LLM：`~/.local/share/opencode/auth.json` 的 `opencode-go` key，端点 `https://opencode.ai/zen/go/v1`，
  **必须带 `x-opencode-session: <uuid>` 头**。模型为推理模型，`max_tokens` 需给足。

## 风险/合规

- 数据为公开接口快照，非交易级；仅供研究，不构成投资建议。
- 不提交 `.env`/密钥；`web/node_modules`、`__pycache__` 已 gitignore。

## Agent skills

### Issue tracker

Issues and specs live as markdown files under `.scratch/<feature>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
