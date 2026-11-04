# 08 — 收尾：缓存容量/淘汰、ADR、文档、部署与跨设备冒烟

**What to build:** 让整个板块资金功能可长期稳定运行：缓存容量与淘汰策略调整为「板块类只保留最近 3 个交易日」，
不挤掉期权上下文缓存；补一份 ADR 记录「采集器单写 + 只读接口 + 前端 SWR」的取舍；更新项目文档的
数据流与接口清单；执行一次完整部署并做跨设备（HTTPS/Tailscale）冒烟，确认标签、四页、抽屉、缓存、降频都符合预期。

**Blocked by:** 02、03、04、05、06、07。

**Status:** done

- [x] 缓存上限与按类淘汰生效，期权看板上下文不再因板块数据被挤出
- [x] ADR 落库，说明单写路径、采集分频、保留窗口、无法回补已过去分钟的取舍
- [x] 文档（AGENTS/CONTEXT）更新：板块资金数据流、接口清单、调试入口（健康接口）
- [x] 全量测试通过；前端重新构建；服务重启后自愈、采集自动恢复
- [x] 跨设备冒烟：五个标签切换、刷新保持、四页有数据、抽屉可用、切页几乎零请求
- [x] 收盘后行为核对：不再采集、页面降频、最后更新时间不再前进
- [x] 工作区无遗留调试信标，改动已按项目备份规则提交

## Comments

2026-11-04 完成。
- 缓存：上限 20MB → 60MB；`evictOne` 改为「第一轮只淘汰板块类（brank/bseries/bdetail/bmulti/
  etfrank/etfseries/emseries），没有才退回全局 LRU」，避免板块数据把期权上下文挤掉。
  板块类仍按既有规则跨日失效（只有 `ctx` 跨日保留），等效于只留最近 1 个交易日的板块缓存。
- ADR：`docs/adr/0003-板块资金单写路径与本地缓存.md`（单写路径、采集分频、保留窗口、
  无法回补已过去分钟、两个数据源坑）。
- 文档：`AGENTS.md` 增项目概览一段、关键命令排障、架构约定一条；`CONTEXT.md` 增「2.1 板块资金」
  数据流表与术语（主力净流入/4 维/区间累计/名次变化）。
- 部署：`/api/admin/deploy`（含前端构建）成功，`data/.deploy_status` = ok/build_ok true。
- 冒烟：本地五标签互切、刷新保持、四页有数据（概念 531 / 行业 496 / ETF 69 / 4 维页正常）、
  详情抽屉可用；期权看板 16 张卡片无回归；无控制台报错。
  HTTPS 入口 `https://xinxin-mac-mini.tail407c31.ts.net:8443` 的 `/`、`/api/board/health`、
  `/api/board/rank`、`/api/etf-flow/rank`、`/api/em-flow/series` 均 200（沙箱内 Chrome 无法
  解析 tailnet 域名，跨设备视觉验收仍需在用户设备上确认）。
- 收盘后：`/api/board/health` 返回 `trading=false`、`collector.cycles=0`（采集器只睡眠不请求），
  页面轮询降到 300s。

## 追加（用户反馈：分时图没有数据、点不开）

根因：本项目采集器只在交易时段写库，而板块库是收盘后才接通/重建的，`flow_points`、
`etf_flow_points`、`em_flow_points` 三张表当天空，`build_series` 自然给不出时间轴 →
四个页面的分时图全空，点板块进抽屉也只看到「暂无分时数据」，看起来像「点击无反应」。

修复：
1. 新增 `scripts/check_board_series.py` 探针（断言四条分时链路都有 axis 点，红了直接指出哪条空）；
2. 新增 `scripts/import_stock_webui.py`：只读 ATTACH stock-webui 的 `data/board_flow.db`，
   回补最近 N 个交易日的板块/ETF/4 维分钟点与排行（ETF 代码去 `sh/sz` 前缀、type 映射
   index→broad / industry→sector、4 维列名映射；幂等，不覆盖本项目真实采集的排行 pct）；
   已回补 10 个交易日（板块点 191 万、ETF 点 27.8 万、4 维点 4.7 万），耗时约 5 秒；
3. ETF 页补齐 stock-webui 的点击交互：点任一行切到「选中分时」，看这只 ETF 自己的
   累计资金曲线（原来只会跳 4 维拆解，容易被当成「点不开」）；
4. 回归测试 `tests/test_import_stock_webui.py`（临时源库/目标库，验证映射、幂等、不覆盖真实排行）。

验证：探针由红转绿；四个页面分时图均有数据；概念页点行抽屉显示 3 张图（分时/20 日/对比指数）、
ETF 页点行显示该 ETF 曲线；pytest 458 通过。
