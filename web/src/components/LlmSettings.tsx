import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/misc";
import {
  clearLlmConfig, EMPTY_LLM_CONFIG, llmEndpoint, loadLlmConfig, saveLlmConfig,
  testLlmConnection, type LlmConfig, type LlmProtocol,
} from "@/lib/browserLlm";

const INPUT = "h-8 w-full rounded-md border border-input bg-transparent px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function LlmSettings() {
  const [config, setConfig] = useState<LlmConfig>(() => loadLlmConfig() || { ...EMPTY_LLM_CONFIG });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const change = (field: keyof LlmConfig, value: string) => {
    request.current?.abort();
    request.current = null;
    setBusy(false);
    setStatus(""); setError("");
    setConfig((old) => ({ ...old, [field]: value }));
  };
  let endpoint = "";
  try { if (config.baseUrl.trim()) endpoint = llmEndpoint(config); } catch { /* 保存或测试时显示校验错误 */ }
  const save = () => {
    setStatus(""); setError("");
    try { saveLlmConfig(config); setStatus("已保存到当前浏览器"); }
    catch (e: any) { setError(e.message); }
  };
  const clear = () => {
    setStatus(""); setError("");
    try {
      clearLlmConfig(); request.current?.abort(); request.current = null; setBusy(false);
      setConfig({ ...EMPTY_LLM_CONFIG }); setStatus("已清除当前浏览器的模型配置");
    } catch (e: any) { setError(e.message); }
  };
  const test = async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setStatus(""); setError("");
    try {
      await testLlmConnection(config, controller.signal);
      if (!controller.signal.aborted) setStatus("连接成功，模型已返回文本；点击保存后用于决策");
    } catch (e: any) {
      if (!controller.signal.aborted) setError(e.message || "连接测试失败");
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  };

  return <div className="space-y-4 text-xs">
    <div className="rounded-md bg-muted/40 px-3 py-2 leading-relaxed text-muted-foreground">
      配置和 API Key 仅保存在当前浏览器的本地存储中。行情快照由看板提供，模型请求由浏览器直接发送给你配置的服务。
    </div>
    <div className="space-y-1.5">
      <div className="font-medium">兼容协议</div>
      <Tabs tabs={[{ key: "openai", label: "OpenAI Chat" }, { key: "anthropic", label: "Anthropic" }]}
        value={config.protocol} onChange={(v) => change("protocol", v as LlmProtocol)} />
    </div>
    <label className="block space-y-1.5">
      <span className="font-medium">Base URL</span>
      <input className={INPUT} aria-label="模型 Base URL" autoComplete="off" spellCheck={false}
        value={config.baseUrl} onChange={(e) => change("baseUrl", e.target.value)} placeholder="https://你的模型服务/v1" />
      <span className="block leading-relaxed text-muted-foreground">填写 API 根路径（如 /v1），也支持完整接口地址；仅填域名时自动补 /v1。</span>
      {endpoint && <span className="block break-all text-[11px] text-muted-foreground">请求地址：{endpoint}</span>}
    </label>
    <label className="block space-y-1.5">
      <span className="font-medium">模型 ID</span>
      <input className={INPUT} aria-label="模型 ID" autoComplete="off" spellCheck={false}
        value={config.model} onChange={(e) => change("model", e.target.value)} placeholder="服务提供的模型 ID" />
    </label>
    <label className="block space-y-1.5">
      <span className="font-medium">API Key</span>
      <input className={INPUT} aria-label="模型 API Key" type="password" autoComplete="new-password" spellCheck={false}
        value={config.apiKey} onChange={(e) => change("apiKey", e.target.value)} placeholder="服务无需鉴权时可留空" />
    </label>
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" onClick={save}>保存模型配置</Button>
      <Button size="sm" variant="outline" onClick={test} disabled={busy}>{busy ? "测试中…" : "测试连接"}</Button>
      {busy && <Button size="sm" variant="ghost" onClick={() => {
        request.current?.abort(); request.current = null; setBusy(false); setStatus("已取消测试");
      }}>取消测试</Button>}
      <Button size="sm" variant="ghost" onClick={clear}>清除配置</Button>
    </div>
    {status && <div role="status" className="text-success-foreground dark:text-success">{status}</div>}
    {error && <div role="alert" className="break-words leading-relaxed text-destructive">{error}</div>}
    <div className="border-t border-border pt-2 leading-relaxed text-muted-foreground">
      请求不携带 Referer 或 Cookie。服务端仍需允许浏览器跨域请求（CORS）；Service Worker 无法绕过跨域限制。
      <div className="mt-1">测试连接仅发送简短测试提示。清除站点数据会删除配置，不同设备或访问地址需分别配置。</div>
    </div>
  </div>;
}
