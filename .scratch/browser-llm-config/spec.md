# 浏览器配置与两种模型请求方式

用户要求：在页面配置 Base URL、模型 ID、OpenAI Chat / Anthropic 协议；配置与 API Key 只保存在当前浏览器。
最新要求允许显式选择「看板后端代理」或「浏览器直连」：无法修改供应商 CORS 时选代理，能够修改时展示配置方法后使用直连。

## 实现约束

- 设置分交易设置与大模型两个页签；大模型独立保存、清除和测试连接，不调用服务器设置写接口。
- 直连方式只向后端读取行情提示词与规则，模型请求由 Service Worker / 页面 fetch 发给供应商，设置 `no-referrer`、`credentials: omit`、`mode: cors`，禁止重定向与自动重试。
- 代理方式向 `/api/llm/proxy` 的 JSON 正文传入配置与提示词。后端只在请求内存中构造协议，`em.llm_post` 独立客户端单次转发；不落盘、不缓存、不使用服务器旧 Key 或 CLI 通道。
- 手动解析代理请求并限制体积，校验只返回固定错误，不回显输入；上游非成功响应只返回状态码，不读取可能反射密钥的原始错误正文；不打印请求、响应或异常对象。
- 切换方式必须由用户显式选择；旧配置缺少 transport 时仍为直连，失败后不自动切代理。代理支持前端取消与断开时中止上游请求。
- 直连选项附当前 Origin 与协议对应的 CORS 示例：OPTIONS 无鉴权、POST/OPTIONS 放行、显式列出 Authorization 或 Anthropic 请求头、网关与应用不要重复添加 Allow-Origin。
- 动作、手数约束由后端纯函数下发，浏览器执行校正；切标的、改配置、关闭组件时取消旧请求，页面超时 300 秒、代理上游超时 280 秒。
- 最大输出 Token 也只存在浏览器配置：OpenAI Chat 默认 16384、Anthropic 默认 4096，允许 1024–65536 的整数。两种请求方式和连接测试统一使用配置值，推理与正文共用额度。
- 响应先判断结束原因：length / max_tokens 提示截断，不展示不完整决策；只有 reasoning_content / thinking 时提示缺少最终正文，不能将推理过程当作决策。过滤、拒答与空正文分别提示，不回显原始错误。
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
- [DeepSeek 推理与最终正文](https://api-docs.deepseek.com/guides/thinking_mode)
- [DeepSeek max_tokens 与 finish_reason](https://api-docs.deepseek.com/api/create-chat-completion)

## 验收

纯函数单测与前端构建；本地启动后用浏览器核对两种请求方式和两协议。使用不带 CORS 的本地模拟模型验证代理成功而直连失败，并核对代理请求敏感信息没有出现在服务器日志和数据文件。真实供应商仍需配置可用凭据，直连还需 CORS。

### 2026-11-06 第一版（仅直连）验收结果

- `.venv/bin/python -m pytest -q`：552 项通过；新增上下文、规则与股指建议映射的纯函数用例。
- `bash web/build.sh`：通过；`py_compile` 与 `/api/health` 冒烟通过。
- `tsc --noEmit`：仍有 21 处已有的 `FramePanel dense` 类型错误；在临时目录解包基线 HEAD 复核，数量与原因一致，本次未新增。
- ego-browser 页面核对：OpenAI Chat / Anthropic 连接与决策成功，MO 观望校正与 510300 动作校正成功；刷新恢复、清除配置、401 提示、CORS 拒绝、无效 JSON、取消测试与切标的取消均符合预期。
- 本地模拟服务核对：两种协议的 POST 均无 Referer/Cookie，Origin 为看板地址，鉴权头与消息结构正确；CORS 拒绝时只有 OPTIONS、没有 POST。已观察到页面直接 fetch 与 SW MessageChannel 两条浏览器路径。
- 后端访问日志无 `POST /api/llm` 或设置写入；新上下文响应只有 system/user/guardrails/bundle_bias/signals/ts。测试配置已清除。
- 未使用真实供应商凭据；真实模型可在设置页测试连接。

### 2026-11-06 两种请求方式验收结果

- 574 项纯函数单测、前端构建、Python 编译与健康检查通过；类型检查仍仅有基线的 21 处 `FramePanel dense` 错误。
- 使用无 CORS 的本地模拟服务：浏览器直连失败且没有调用代理；手动选择代理后，OpenAI Chat / Anthropic 连接及决策展示成功。开启 CORS 的模拟服务仍可浏览器直连。
- CORS 帮助按当前看板 Origin 和所选协议展示；旧配置读取后仍为 direct，保存新方式后本地恢复正常。
- 使用合成敏感标记检查：参数错误、畸形 JSON 和上游 401 原样反射 Key 时，代理均未向客户端回显 Key；应用日志及 data 文件中未发现合成 Key / 提示词。
- 代理上游请求不带 Origin / Referer / Cookie。客户端取消后，上游模拟服务确认收到连接断开；监听直接使用 ASGI disconnect 事件，避免 BaseHTTPMiddleware 下零等待轮询漏报。
- 通过设置页现有 qproxy 配置做真实简短连接测试成功；密钥未读出到工具或日志。当前浏览器的该配置切为代理，其余配置字段保持原值。

### 2026-11-06 空正文报错排查

- 原实现把决策 `max_tokens` 固定为 4096、连接测试固定为 1024，且忽略结束原因；输出耗尽、仅返回推理和协议不兼容都会落到同一条空正文提示。
- 原预算下实际调用同一 qproxy DeepSeek 模型：沪深300两次、中证1000一次均成功，没有复现用户那次原始失败。其中沪深300一次完成用量 3627、推理用量 3245，已接近原上限。没有保存原始请求、密钥或模型正文。
- 为核对失败机制，仅在浏览器内对一笔沪深300请求临时设 1024 上限（不改用户配置）：HTTP 200，finish_reason=length，completion_tokens=reasoning_tokens=1024，content 长度 0。确认推理耗尽输出额度时确实会返回原实现报错的响应形态；用户那次是否同因仍需失败响应的结束原因确认。
- 新默认 16384 预算的中证1000真实决策成功，结束原因 stop，正文长度 481；两种传输和连接测试统一使用可配置预算。页面保留原协议、地址、模型和密钥。
- 浏览器合成响应核对：OpenAI length、Anthropic max_tokens、仅推理、服务方过滤均显示对应提示；即使截断正文碰巧为完整 JSON 也不展示为决策，正常 text 分块仍能展示。设置页已核对旧配置自动使用 16384，临时测试配置已恢复。
- 587 项纯函数测试、前端构建、Python 编译与健康检查通过；类型检查仍为已有的 21 处 dense 错误。
