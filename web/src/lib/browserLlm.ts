import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export type LlmProtocol = "openai" | "anthropic";
export interface LlmConfig {
  protocol: LlmProtocol;
  baseUrl: string;
  model: string;
  apiKey: string;
}

const STORAGE_KEY = "etf-board.llm-config.v1";
const CHANGE_EVENT = "etf:llm-config-changed";
const REQUEST_TIMEOUT = 180_000;
export const EMPTY_LLM_CONFIG: LlmConfig = { protocol: "openai", baseUrl: "", model: "", apiKey: "" };
export const protocolLabel = (p: LlmProtocol) => p === "anthropic" ? "Anthropic" : "OpenAI Chat";

export function llmEndpoint(config: LlmConfig): string {
  let url: URL;
  try { url = new URL(config.baseUrl.trim()); }
  catch { throw new Error("Base URL 需填写完整的 http:// 或 https:// 地址"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Base URL 只支持 HTTP/HTTPS，不能包含账号、密码、查询参数或锚点");
  }
  if (url.origin === location.origin) throw new Error("请填写模型服务地址，不能使用看板自身的地址");
  const path = url.pathname.replace(/\/+$/, "");
  const suffix = config.protocol === "anthropic" ? "/messages" : "/chat/completions";
  if ((path.endsWith("/messages") || path.endsWith("/chat/completions")) && !path.endsWith(suffix)) {
    throw new Error("接口路径与所选兼容协议不一致");
  }
  url.pathname = path.endsWith(suffix) ? path : `${path || "/v1"}${suffix}`;
  return url.href;
}

export function validateLlmConfig(config: LlmConfig): LlmConfig {
  if (!["openai", "anthropic"].includes(config.protocol)) throw new Error("请选择兼容协议");
  const out = { protocol: config.protocol, baseUrl: config.baseUrl.trim(), model: config.model.trim(), apiKey: config.apiKey.trim() };
  llmEndpoint(out);
  if (!out.model) throw new Error("请填写模型 ID");
  if (/[\r\n]/.test(out.apiKey)) throw new Error("API Key 不能包含换行");
  return out;
}

export function loadLlmConfig(): LlmConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? validateLlmConfig(JSON.parse(raw)) : null;
  } catch { return null; }
}

/** 这两个写入口只操作当前浏览器，从不调用 /api/settings。 */
export function saveLlmConfig(config: LlmConfig): void {
  const value = validateLlmConfig(config);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); }
  catch { throw new Error("浏览器不允许保存本地配置，请检查站点存储权限"); }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function clearLlmConfig(): void {
  try { localStorage.removeItem(STORAGE_KEY); }
  catch { throw new Error("浏览器不允许清除本地配置，请检查站点存储权限"); }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function useLlmConfig(): LlmConfig | null {
  const [config, setConfig] = useState(loadLlmConfig);
  useEffect(() => {
    const sync = () => setConfig(loadLlmConfig());
    const onStorage = (e: StorageEvent) => { if (e.key === STORAGE_KEY || e.key === null) sync(); };
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return config;
}

export function openLlmSettings(): void {
  window.dispatchEvent(new Event("etf:open-llm-settings"));
}

interface ModelRequest { url: string; headers: Record<string, string>; body: string }
interface ModelReply { status?: number; text?: string; error?: string }

function modelRequest(config: LlmConfig, system: string, user: string, test: boolean): ModelRequest {
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  const body: Record<string, unknown> = { model: config.model, max_tokens: test ? 1024 : 4096, stream: false };
  if (config.protocol === "anthropic") {
    if (config.apiKey) headers["x-api-key"] = config.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
    body.system = system;
    body.messages = [{ role: "user", content: user }];
  } else {
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    body.messages = [{ role: "system", content: system }, { role: "user", content: user }];
  }
  return { url: llmEndpoint(config), headers, body: JSON.stringify(body) };
}

// 激活与握手都发生在发送模型请求之前；旧 SW / 非安全上下文只回退到页面直接 fetch。
// 已经发出的模型请求绝不自动重试，避免重复计费。
async function modelWorker(): Promise<ServiceWorker | null> {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" });
    const pending = reg.installing || reg.waiting;
    if (pending && pending.state !== "activated") {
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); pending.removeEventListener("statechange", check); resolve(); };
        const check = () => { if (["activated", "redundant"].includes(pending.state)) done(); };
        const timer = setTimeout(done, 4000);
        pending.addEventListener("statechange", check);
        check();
      });
    }
    const worker = reg.active;
    if (!worker) return null;
    return await new Promise<ServiceWorker | null>((resolve) => {
      const channel = new MessageChannel();
      const done = (value: ServiceWorker | null) => { clearTimeout(timer); channel.port1.close(); resolve(value); };
      const timer = setTimeout(() => done(null), 1000);
      channel.port1.onmessage = (e) => done(e.data?.version === 1 ? worker : null);
      worker.postMessage({ type: "etf:llm:ping" }, [channel.port2]);
    });
  } catch { return null; }
}

async function sendFromBrowser(request: ModelRequest, signal: AbortSignal): Promise<ModelReply> {
  const worker = await modelWorker();
  signal.throwIfAborted();
  if (!worker) {
    const r = await fetch(request.url, {
      method: "POST", headers: request.headers, body: request.body, signal,
      mode: "cors", credentials: "omit", cache: "no-store", redirect: "error",
      referrer: "", referrerPolicy: "no-referrer",
    });
    return { status: r.status, text: await r.text() };
  }
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const clean = () => { channel.port1.close(); signal.removeEventListener("abort", abort); };
    const abort = () => { channel.port1.postMessage({ type: "abort" }); clean(); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    channel.port1.onmessage = (e) => { clean(); resolve(e.data); };
    channel.port1.onmessageerror = () => { clean(); reject(new Error("浏览器模型通道响应无效，请重试")); };
    try { worker.postMessage({ type: "etf:llm:request", request }, [channel.port2]); }
    catch { clean(); reject(new Error("浏览器模型通道已更新，请重试")); }
  });
}

async function modelText(config: LlmConfig, system: string, user: string, signal: AbortSignal, test = false): Promise<string> {
  let reply: ModelReply;
  try { reply = await sendFromBrowser(modelRequest(config, system, user, test), signal); }
  catch (e) {
    if (signal.aborted) throw signal.reason;
    if (e instanceof TypeError) throw new Error("浏览器直连失败：请检查地址、网络、HTTPS 和服务端 CORS 配置（仍需允许 Origin 与鉴权请求头）。请求未转交看板后端。");
    throw e;
  }
  if (reply.error) throw new Error(reply.error);
  const status = reply.status || 0;
  // 不回显供应商原始错误正文，避免网关把请求头或密钥反射到界面。
  if (status < 200 || status >= 300) {
    const hint = status === 401 || status === 403 ? "请检查 API Key、模型权限及浏览器直连权限" :
      status === 429 ? "额度或速率受限，请稍后重试" : status === 404 ? "请检查 Base URL 和模型 ID" : "请检查协议、模型参数及供应商服务状态";
    throw new Error(`模型服务返回 HTTP ${status}：${hint}`);
  }
  let data: any;
  try { data = JSON.parse(reply.text || ""); }
  catch { throw new Error("模型服务返回的不是 JSON，请检查接口地址与兼容协议"); }
  const content = config.protocol === "anthropic" ? data.content : data.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ?
    content.filter((p) => p?.type === "text" && typeof p.text === "string").map((p) => p.text).join("\n") : "";
  if (!text.trim()) throw new Error("模型未返回可用文本，请确认模型支持所选协议或稍后重试");
  return text;
}

/** 与后端规则一致：动作与手数由上下文约束，模型结果留在浏览器校正、展示。 */
function parseDecision(text: string, guardrails: any): any {
  const cleaned = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  let parsed: any;
  try { parsed = JSON.parse(cleaned); }
  catch {
    try { parsed = JSON.parse(cleaned.slice(cleaned.indexOf("{"), cleaned.lastIndexOf("}") + 1)); }
    catch { throw new Error("模型决策无法解析为 JSON，请重试或更换模型"); }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("模型决策必须是 JSON 对象");
  const labels = guardrails?.action_labels || {};
  if (!Object.prototype.hasOwnProperty.call(labels, parsed.action)) throw new Error("模型未返回有效的决策动作，请重试");
  const string = (v: unknown) => typeof v === "string" ? v : "";
  const number = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : null;
  const list = (v: unknown) => Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  const leg = (v: any) => v && typeof v === "object" ? { code: string(v.code), name: string(v.name), strike: number(v.strike) } : null;
  // 显式选取可展示字段，防止供应商返回对象/数组导致 React 渲染崩溃。
  const out: any = { action: parsed.action, confidence: Math.min(100, Math.max(0, number(parsed.confidence) || 0)),
    contracts: number(parsed.contracts), legs: { long: leg(parsed.legs?.long), short: leg(parsed.legs?.short) },
    reasons: list(parsed.reasons), risks: list(parsed.risks), adjustments: [] };
  for (const field of ["contract_code", "contract_name", "hold_window", "summary"]) out[field] = string(parsed[field]);
  for (const field of ["entry", "stop", "target", "stop_pct", "target_pct"]) out[field] = number(parsed[field]);
  const want = guardrails?.action;
  if (want && want !== out.action) {
    out.model_action = out.action;
    out.adjustments.push(`模型建议「${labels[out.action]}」与规则层策略「${labels[want]}」不一致，已按规则层为准。`);
    out.action = want;
    // 换方向/策略后旧合约和点位不可沿用，避免展示自相矛盾的买单。
    out.contract_code = out.contract_name = "";
    out.legs = null;
    for (const field of ["entry", "stop", "target", "stop_pct", "target_pct"]) out[field] = null;
  }
  const cap = guardrails?.max_contracts;
  if (Number.isInteger(cap) && cap >= 0 && out.contracts != null && out.contracts > cap) {
    out.model_contracts = out.contracts;
    out.adjustments.push(`模型建议 ${out.contracts} 张超过手数上限 ${cap} 张，已收敛到上限。`);
    out.contracts = cap;
  }
  if (out.contracts != null) out.contracts = Math.max(0, Math.floor(out.contracts));
  out.direction = out.action === "wait" ? "neutral" : ["buy_call", "bull_call_spread"].includes(out.action) ? "call" : "put";
  if (out.action === "wait") {
    out.contract_code = out.contract_name = "";
    out.legs = null;
    out.contracts = 0;
    for (const field of ["entry", "stop", "target", "stop_pct", "target_pct"]) out[field] = null;
  }
  return out;
}

async function withTimeout<T>(signal: AbortSignal, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(() => controller.abort(new Error("模型请求超过 180 秒，请稍后重试")), REQUEST_TIMEOUT);
  try { controller.signal.throwIfAborted(); return await task(controller.signal); }
  finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}

export async function testLlmConnection(config: LlmConfig, signal: AbortSignal): Promise<void> {
  const valid = validateLlmConfig(config);
  await withTimeout(signal, (s) => modelText(valid, "你是连接测试助手。", "请只回复 OK。", s, true));
}

export async function browserDecision(code: string, config: LlmConfig, signal: AbortSignal): Promise<any> {
  const valid = validateLlmConfig(config);
  return withTimeout(signal, async (s) => {
    const context = await api.llmContext(code, s);
    if (context.error) throw new Error(context.error);
    if (!context.system || !context.user) throw new Error("行情上下文不完整，请稍后重试");
    const text = await modelText(valid, context.system, context.user, s);
    return { decision: { ...parseDecision(text, context.guardrails), _model: valid.model, _via: "browser" }, ts: context.ts };
  });
}
