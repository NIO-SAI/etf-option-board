# 浏览器配置与直连大模型

用户要求：在页面配置 Base URL、模型 ID、OpenAI Chat / Anthropic 协议；配置只保存在前端，模型调用不得经过看板后端。API Key 同样只存当前浏览器。

## 实现约束

- 设置分交易设置与大模型两个页签；大模型独立保存、清除和测试连接，不调用服务器设置写接口。
- 页面决策只向后端读取行情提示词和规则约束，模型请求与响应都留在浏览器与供应商之间。
- 优先使用 Service Worker 的 MessageChannel；不支持或旧 SW 未就绪时使用页面 fetch。两条路径都设置 `no-referrer`、`credentials: omit`、`mode: cors`，禁止重定向与自动重试。
- Service Worker 不持久化密钥、提示词或响应，不代理到看板后台。CORS 失败明确显示原因；没有 `no-cors` 或服务器回退。
- 动作、手数约束由后端纯函数下发，浏览器执行校正；切标的、改配置、关闭组件时取消旧请求，超时 180 秒。
- 既有服务端 LLM API 保持兼容，页面不再使用。

## 协议与地址

- 仅填域名时补 `/v1`，自定义路径保留；也接受完整 `/chat/completions` 或 `/messages` 地址。
- OpenAI Chat：Bearer Key，system/user messages，非流式响应。
- Anthropic：x-api-key、anthropic-version 2023-06-01、anthropic-dangerous-direct-browser-access，顶层 system、user messages，读取 text blocks。
- Key 可为空，便于无需鉴权的本地服务。不得配置为看板本身的 origin，不接受 URL 内嵌密码、query 或 fragment。

## 参考

- [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [Anthropic Messages](https://platform.claude.com/docs/en/api/messages/create)
- [Anthropic 官方 SDK 请求头](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/client.ts)
- [Worker fetch 与 CORS](https://developer.mozilla.org/en-US/docs/Web/API/WorkerGlobalScope/fetch)
- [RequestInit：referrerPolicy / credentials](https://developer.mozilla.org/en-US/docs/Web/API/RequestInit)

## 验收

纯函数单测与前端构建；本地启动后用浏览器操作设置、刷新恢复、清除、两协议连接与决策；通过临时本地模型服务核对请求没有 Referer/Cookie，保留 Origin，后端无模型调用或配置写入。真实供应商仍需配置可用凭据及 CORS。

### 2026-11-06 验收结果

- `.venv/bin/python -m pytest -q`：552 项通过；新增上下文、规则与股指建议映射的纯函数用例。
- `bash web/build.sh`：通过；`py_compile` 与 `/api/health` 冒烟通过。
- `tsc --noEmit`：仍有 21 处已有的 `FramePanel dense` 类型错误；在临时目录解包基线 HEAD 复核，数量与原因一致，本次未新增。
- ego-browser 页面核对：OpenAI Chat / Anthropic 连接与决策成功，MO 观望校正与 510300 动作校正成功；刷新恢复、清除配置、401 提示、CORS 拒绝、无效 JSON、取消测试与切标的取消均符合预期。
- 本地模拟服务核对：两种协议的 POST 均无 Referer/Cookie，Origin 为看板地址，鉴权头与消息结构正确；CORS 拒绝时只有 OPTIONS、没有 POST。已观察到页面直接 fetch 与 SW MessageChannel 两条浏览器路径。
- 后端访问日志无 `POST /api/llm` 或设置写入；新上下文响应只有 system/user/guardrails/bundle_bias/signals/ts。测试配置已清除。
- 未使用真实供应商凭据；真实模型可在设置页测试连接。
