# 01 — 设置：总资金与单笔风险%（含测试缝骨架）

**What to build:** 你打开设置，填入总资金与单笔风险%（1% / 2% / 3%），保存后立即生效、服务重启后仍在；填错（非正数总资金、不在档位内的百分比）会被拒绝并说明原因；完全不填时看板以保守默认值照常工作。同时建立本项目的测试缝：pytest 可跑且首个纯函数测试通过，`AGENTS.md` 中「无测试框架」的陈述随之修正。

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [x] 设置界面可输入总资金与单笔风险%（1% / 2% / 3% 三档）
- [x] 保存后无需重启服务即生效；服务重启后设置仍保留
- [x] 设置持久化在不会被 auto-backup 提交进 git 历史的位置
- [x] 非法输入（非正数总资金、不在档位内的风险%）被拒绝并给出原因
- [x] 未配置时以保守默认值工作，看板其余功能不受影响
- [x] 设置读写的端点失败均返回 `{error}`，不抛 500
- [x] 校验与归一化为纯函数，时间与 I/O 由调用方注入
- [x] 纯函数有单元测试：非法输入、缺省值、边界值
- [x] `pytest` 可运行且全绿；测试不触网、不读系统时钟、不写磁盘
- [x] `AGENTS.md` 中「无测试框架」及相关描述已更新
- [x] 总资金与风险%的取值不出现在任何会进入 git 历史的文件中

## Comments

### 2026-10-27 — 已实现

**交付**
- 新增 `services/user_settings.py`：纯函数 `parse()`（校验与归一化，字段独立降级）+ `view()`；
  `load()`/`save()` 是文件读写薄壳（先写 `.tmp` 再 `os.replace`，失败只记日志返回 False，绝不抛异常）。
- 新增 `pytest.ini`（`testpaths=tests`、`pythonpath=.` —— `services/` 是隐式命名空间包、无 `__init__.py`）、
  `requirements-dev.txt`、`tests/test_user_settings.py`（44 个用例）。
- 新增 `GET /api/settings`、`PUT /api/settings`；非法输入不落盘，返回 `{error}`。
- 前端新增 `SettingsDialog`（复用现有 `Dialog` + `Tabs`），TopBar 加齿轮入口，App 挂载。
- 存储落在 `data/settings.json`，命中 `.gitignore` 的 `data/*.json`，不进 git 历史。
- `AGENTS.md` 更新「无测试框架」陈述，并记下「新增长期数据文件一律用 `.json` 后缀」的踩坑点。

**验收证据**
- `pytest -q` → 44 passed，退出码 0（红→绿：实现前收集即失败，实现后全绿）。
- TestClient（**不进入 lifespan**，避免启第二个 monitor 去写 `flow_history.jsonl`）：默认值正确；非法总资金/
  风险档被拒且**未落盘**；合法保存后落盘 `{"total_capital": 500000.0, "risk_pct": 2.0}`。
- **跨进程**读取回同值 → 「重启后仍在」成立。
- 线上（部署后 curl）：`GET /api/settings` 返回默认值；`PUT` 非法返回 `{"error":"总资金必须是大于 0 的数字"}`；
  合法 PUT 后复读为 500000/2.0；首页已服务新 bundle `index-JNZpeccm.js`。
- `git check-ignore -v data/settings.json` → `.gitignore:9:data/*.json`。
- 部署令牌经 monitor 消费（约 30 秒），`data/.deploy_status` 为 `ok:true, build_ok:true`（py_compile 全量校验通过）。

**未做 / 限制**
- `npx tsc --noEmit` 仍报 12 个 `dense` 类型错误 —— 已用 HEAD 纯净副本对照证实**数量与内容完全一致**，
  属既有类型债务，非本 ticket 引入，也不在本 ticket 范围。
- 设置界面无自动化测试（前端测试缝按决策不做）；已通过构建 + 线上 bundle 哈希核对。
- 测试数据已清理，`data/settings.json` 不存在，看板初始为「未配置」。
