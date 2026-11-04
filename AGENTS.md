# AGENTS.md — ETF 期权日内决策看板

> **2026-11-01 源码回滚事故已恢复**（另一个会话把 10-30 之后的所有改动 `git checkout` 掉并删了
> `services/index_option.py`）。恢复过程与规格见 `.scratch/restore-2026-11-01.md`。
> 教训：**同一工作区不要并行开两个会话说改代码**，会互相覆盖；需要并行时用 `enter_worktree` 隔离。

## 项目概览

A 股 9 只可交易期权的宽基 ETF 的**日内决策看板**。后端 FastAPI（Python）聚合东财行情/期权链/
资金流/指数/外围，内置 BS 定价、Kronos 预测桥、大模型决策、实时告警；前端 REUI + React +
Vite + Tailwind v4，深色看板，SSE 弹窗+声音告警。

顶栏是一排页面标签（hash 路由 `#/options` 与 `#/board/*`）：**期权看板**外加从 stock-webui
移植的**板块资金四页**（概念资金分时 / 主力资金多日图 / ETF资金流 / 东财资金分时），
四页共用 `services/boardflow.py` 的本地 SQLite。规格见 `.scratch/board-flow/spec.md`、
取舍见 `docs/adr/0003-板块资金单写路径与本地缓存.md`。

## 关键命令

```bash
bash run.sh           # 启动后端 :6799（含监控循环 + Kronos 预热，托管 web/dist）
bash web/build.sh     # 构建前端到 web/dist
bash web/dev.sh       # 前端开发模式 :5273（/api 代理到 :6799）
/Users/xinxin/.browser-use-env/bin/python3 -m pytest -q   # 单元测试（纯决策函数）
```

- **Python 解释器必须用** `/Users/xinxin/.browser-use-env/bin/python3`（含 fastapi/uvicorn/httpx）。
- 前端 npm 依赖走国内镜像（npmmirror），脚本已设 `npm_config_registry`。
- **测试**：`/Users/xinxin/.browser-use-env/bin/python3 -m pytest -q`（配置 `pytest.ini`，用例在 `tests/`）。
  只测**纯决策函数**：不触网、不读系统时钟、不写磁盘。HTTP 层与前端不做自动化测试，
  仍用 `curl http://127.0.0.1:6799/api/health` 冒烟 + 浏览器核对。
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
- 板块资金排障：`curl /api/board/health` 看采集时间与库里条数；`/api/board/rank?type=all`、
  `/api/etf-flow/rank`、`/api/em-flow/series?target_type=index&code=1.000300` 逐个核。
  库文件 `data/board_flow.db`（gitignore），自选在 `data/board_watch.json`、`data/etf_watch.json`，
  4 维行业配置在 `data/em_flow_config.json`。
- **分时图没数据**（重建库/收盘后接通时的常见情形）：先跑
  `python3 scripts/check_board_series.py`（红的就说明某条分时链路为空），
  再从 stock-webui 已采集的库里回补最近 N 个交易日：
  `python3 scripts/import_stock_webui.py --days 10`（源库只读 ATTACH、幂等、不覆盖本项目的真实采集点）。
  回补后再跑一次探针应变绿。历史数据缺「涨速/指数涨跌幅」时：
  `python3 scripts/backfill_speed_pct.py`（按当前快照回填最新交易日的 speed 与 pct）。
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
- **数据源策略（2026-11-01 实测更新）**：东财 `push2` 的 **`stock/*` 接口在本机被接口级封禁**
  （`trends2` / `kline` / `get`：TCP 443 可连、TLS 握手和证书都正常、请求发出后对端空回包，
  IPv4/IPv6、TLS1.2、跳过证书、换 UA/Cookie、真实 Chrome 全部一样；根路径 404 说明服务器活着）。
  **但 `clist/get` 与 `ulist.np/get` 仍 200**（2026-11-02 复测：**clist 也开始空回包**，
  ulist 稳定 200，所以全市场快照已改走 ulist）—— 所以：
  - 合约分钟线靠 **`em.option_snapshot_batch()`** 每分钟累积，由 `monitor` 后台任务调用
    （不阻塞告警链路）。**主路径是 ulist 批量报价**：合约清单落盘 `data/option_universe.json`
    （1268 个 secid，clist 能翻时建一次），之后每轮 4 个 ulist 请求（400 只/次、并发）
    即可覆盖全市场，实测 **0.8s**；旧版 clist 翻页要 39s，且 clist 被封时直接拿不到。
    clist 只在清单为空（首次冷启动）时兜底一次。
  - 期权链 `option_service._raw_chain` 同理：优先 `em.option_chain_from_universe()`（清单+ulist，
    ulist 返回字段与 clist diff 同构），`len(rows) < 20` 才退回 `clist_all`
    （clist 被封时它要 12s 且只回 1~2 页 → 链不完整、月份缺）。
  - `em._curl_json_v6` 走 IPv6：**先查一次 AAAA 并缓存 10 分钟，再用 `curl -6 --resolve`**
    （fake-IP 下系统 DNS 只给 198.18.x 伪地址，**不能**用裸 `curl -6`）。
    每次请求现场 `--doh-url` 解析要 1.11s（占单请求 1.4s 的 79%），缓存后降到 0.2~0.3s；
    固定 IP 空回包会自动丢缓存并退回 `--doh-url` 重新解析。
    **接口空回包（curl exit 52）不算通道故障**，不触发 `_V6_DEAD`，
    否则 trends2 被封会把 clist/ulist 一起熔断；
  - 行情/期权链主源仍是 **`emdatah5.eastmoney.com`**（`getZJLXData`/`getZDYLBData`），
    K线/分时走**腾讯**（`ifzq.gtimg.cn`：复权 `fqkline` 被 WAF 拦时要退回不复权 `kline/kline`，否则日线/MA/关键位全空）。
  排查"没数据"按这三条链路走，别先怪没开盘。
- **冷启动预热**：`monitor._prewarm()` 启动后台跑一次 `strategy.directions()`（12 个标的要 8s），
  否则用户重启服务后第一次打开看板要干等十几秒。
- 资金流分钟序列：`services/em.py::fflow` 在交易时段内每次调用都用 emdatah5 快照累积
  并落盘 `data/flow_history.jsonl`（push2 fflow 收盘后常返回空 klines，且经代理易被限流）。
  收盘后/进程重启后用本地累积兜底，保证分时资金流图表可复盘；注意累积的是日累计值
  口径（f137 等），与 push2 的分钟增量口径不同。当日已错过的数据无法回补。
  另保留最近一个有数据的昨日序列：9:15 开盘前当日无数据时自动展示昨日（前端打
  「昨日资金流」角标，`etf_context.flow_day` 标识数据日期），界面不空。
- **板块资金（2026-11-04 新增，ADR-0003）**：单写路径 —— 只有 `services/board_collector.py`
  在交易时段写 `data/board_flow.db`（SQLite），`/api/board/*`、`/api/etf-flow/*`、`/api/em-flow/*`
  一律只读，**不要为了让页面有数据去实时抓东财**。采集分频：板块排行 30s（约 11 请求）、
  ETF 30s（69 只）、指数 4 维 30s、行业 4 维 60s（默认 `|净流入|` 前 40，可配置）。
  保留窗口 30/120 天，启动与每日裁剪；页面走 IndexedDB SWR，盘中 30s / 休市 300s。
  纯函数（时段/解析/名次/区间聚合/序列对齐/裁剪）在 `boardflow.py`，单测在 `tests/test_boardflow.py`。
  **两个数据源坑**：emdatah5 的 `fs=m:90+t:3` 必须编码成 `%2B`（raw `+` 被当空格会忽略过滤）；
  板块 4 维 secid 必须是 `90.BKxxxx`。
- `services/universe.py` 维护标的/指数/外围/国家队清单；改标的只改这里。
- 期权链：东财 `fs=m:10`(沪)/`m:12`(深) 全量列表，按简称前缀切分。**注意前缀顺序**
  （`科创50` vs `科创板50`，`300ETF` vs `沪深300ETF`）。
- 隐波/希腊字母由 `services/bs.py` 自算（Eastmoney 不直接给），到期日 = 到期月第 4 个星期三。
- 前端组件：REUI（`web/src/components/reui/*`，Tailwind v4 语法）与自研 shadcn 风格
  `web/src/components/ui/*` 混用；图表用 ECharts（`components/charts`）。
- **中栏布局约定（2026-11-01）**：行情卡（分时图 + 两个横线开关 + 高度×2）→ T 型报价 →
  **合约分时图** → 决策区（策略与仓位 / 今日推荐合约 / 标的点位 / 合约买卖点，都在 `PlanCard`）
  → 优选合约 → 大模型决策。决策类卡片一律放中栏、合约分时图**下面**；右栏只留实时告警、
  日内方向与信号、Kronos、到期日历。
- **合约图三组横线**（支撑/压力、止盈/止损、打和点）：按钮常驻（数据没到只置灰），
  且**线不依赖分时数据存在**——`optPrice` 为空时仍保留一个空 data 的「合约价格」series
  来承载 `markLine`，否则分时源一断，线和开关会一起「消失」（用户会以为开关失效）。
  分时源全断时用 `optLast`（合约现价）+ Δ 合成一条虚线走势兜底。
- **分时缓存**：合约分时/买卖点走 `usePolling` 的 IndexedDB 缓存（kind=`trends`/`levels`），
  切合约先渲染缓存；**缓存比轮询周期新时不发首轮请求**，来回切标的/合约几乎不产生请求。
  盘中 15s、非交易 120s，页面切后台暂停。
- **分时图时间轴约定（2026-10-19 起）**：轴一律由完整行情分时（`trends`，腾讯）定义；
  资金流/期权等稀疏序列必须用 `web/src/lib/series.ts` 的 `trimSession` + `alignToAxis`
  按「最近前值 + 同日校验」对齐。**禁止再用 `HH:MM` 精确相等 join**——东财资金流首点是
  09:31/13:01、只到 15:00，行情轴有 09:30/13:00 且收盘后常有 15:06–15:30 的盘后点，
  两者错位会导致柱状图成段空洞。后端 `_trends_trim` / `_flow_clean` 已统一裁掉
  非连续竞价时段的点。盘前腾讯单日分时只有当日 09:30 占位点时，`trends()` 回退到
  多日接口的上一交易日，并返回 `trends_prev_close` 作为涨跌幅基准（前端优先用它）。
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
- LLM：`~/.local/share/opencode/auth.json` 的 `opencode-go` key（免费模型也用这个 key），
  免费模型（`*-free`）端点 `https://opencode.ai/zen/v1`，Go 付费模型才是 `https://opencode.ai/zen/go/v1`；
  **必须带 `x-opencode-session: <uuid>` 头**。默认模型 `deepseek-v4.1-flash-free`，可用
  `LLM_API_BASE`/`LLM_MODEL`/`LLM_API_KEY` 覆盖。免费额度用尽时返回 429 + `retry-after`，
  约 8 小时（每日 00:00 UTC / 北京时间 08:00）恢复。模型为推理模型，`max_tokens` 需给足。
- **免费模型只能走 opencode 客户端通道（2026-10-30 实测）**：免费额度用尽后，同 key 直连 REST
  （`zen/v1`、`inference/openai/v1`，各种 `x-opencode-*` 头/UA/IPv4/IPv6）一律 429，但
  `opencode run -m opencode/deepseek-v4.1-flash-free` 仍可跑（17–30s/次）。故 `services/llm.py`
  在 REST 失败时自动回落 CLI：`opencode run --pure --format json -m <LLM_CLI_MODEL> --dir <LLM_CLI_DIR>`，
  解析 NDJSON 的 `text` 事件；`LLM_CLI_FALLBACK=0` 关闭，`LLM_CLI_MODEL`/`LLM_CLI_TIMEOUT`(默认 240s)/`LLM_CLI_DIR` 可调。
  决策结果带 `_via: "cli"|"api"` 便于排查。免费额度无公开查询接口，只能看 429 的 `retry-after`。

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

## 协作约定（记忆）

- **对话语言：中文。** 本仓库相关的回复、工单、注释一律用中文。
- **项目定位一览**（供新会话快速上手，不必重复调研）：
  - 是什么：9 只可交易期权宽基 ETF 的日内决策看板 —— 聚合行情/期权链/资金流/指数/外围
    → 信号引擎打分 → 大模型出可执行方案 → SSE 声音+弹窗告警。
  - 规模：后端 `services/` 15 个模块约 5.3k 行；前端 `web/src` 约 3.5k 行 TS/TSX。
  - 文档地图：架构与策略逻辑 → `CONTEXT.md`；部署/命令/数据源策略 → 本文件；
    标的清单 → `README.md`；工作追踪与 triage 结论 → `.scratch/`。
  - 4 个独立 agent skill（策略顾问/链数据/策略报告/长期备兑）**已移出本仓库**，
    现在在 `~/workspace/Skills/疯疯旭SKILL/期权/`，不属于看板运行时；
    本仓库的 `.gitignore` 仍保留 `期权/` 规则，防止误拷回来。
- **易踩的三个点**：行情主源是 `emdatah5` + 腾讯（K线/分时），`push2` 仅兜底，排查「没数据」
  别先怪没开盘；改前端必须 `bash web/build.sh`，否则线上不变；用户设置（总资金/单笔风险%）
  存 `data/settings.json`，靠 `.gitignore` 的 `data/*.json` 规则规避 auto-backup —— **新增长期数据
  文件一律用 `.json` 后缀**；`data/*.jsonl` 已于 2026-11-02 移出跟踪（分钟线累积会持续增长）。
- **动态状态不写进本文件**（会过期），按需现取：追踪器进度看 `.scratch/<feature>/` 与
  `.scratch/triage-*.md`；服务健康 `curl http://127.0.0.1:6799/api/health`；
  最近一次部署结果看 `data/.deploy_status`。
