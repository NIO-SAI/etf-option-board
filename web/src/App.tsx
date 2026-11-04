import { useEffect, useState } from "react";
import { TopBar } from "@/components/TopBar";
import { PageTabs } from "@/components/PageTabs";
import { SettingsDialog } from "@/components/SettingsDialog";
import { usePageRoute, titleOf } from "@/lib/route";
import { requestRefresh, onGlobalRefresh } from "@/lib/refresh";
import { api } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { OptionsBoard } from "@/pages/OptionsBoard";
import { BoardFlowPage, BoardMultiPage, EtfFlowPage, EmFlowPage } from "@/pages/board";

// 当前加载的前端 bundle 哈希（用于判断浏览器是否加载了最新构建）
const BUNDLE_ID = (() => {
  const s = document.querySelector('script[type="module"]') as HTMLScriptElement | null;
  const m = (s?.src || "").match(/index-([A-Za-z0-9_-]+)\.js/);
  return m ? m[1] : "dev";
})();

/**
 * 应用外壳：顶栏 + 页面标签 + 路由分发 + 设置弹窗。
 * 每一页自己拉自己需要的数据（期权页的数据不再在板块页轮询）。
 */
export default function App() {
  const page = usePageRoute();
  const [clock, setClock] = useState(new Date().toLocaleTimeString("zh-CN", { hour12: false }));
  const [settingsOpen, setSettingsOpen] = useState(false);

  // 顶栏全局信息：所有页面都要看（外围市场 / 国家队评分 / 服务健康）
  const { data: health } = usePolling(() => api.health(), 60_000);
  const { data: external } = usePolling(() => api.external(), 30_000);
  const { data: national } = usePolling(() => api.national(), 30_000);

  useEffect(() => {
    const t = setInterval(() => setClock(new Date().toLocaleTimeString("zh-CN", { hour12: false })), 1000);
    return () => clearInterval(t);
  }, []);

  // 页面标题跟着路由走（多设备/多标签时一眼能分清）
  useEffect(() => {
    document.title = titleOf(page);
  }, [page]);

  return (
    <div className="min-h-screen bg-background">
      <TopBar
        external={external?.items ?? []}
        national={national}
        health={health}
        clock={clock}
        nav={<PageTabs page={page} className="max-w-[52vw]" />}
        onRefresh={requestRefresh}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />

      {page === "options" ? (
        <OptionsBoard />
      ) : page === "board-flow" ? (
        <BoardFlowPage />
      ) : page === "board-multi" ? (
        <BoardMultiPage />
      ) : page === "board-etf" ? (
        <EtfFlowPage />
      ) : (
        <EmFlowPage />
      )}

      <footer className="px-4 py-3 text-center text-[10px] text-muted-foreground">
        数据来源：东方财富 · 期权定价 BS · 预测 Kronos · 决策大模型 — 仅供研究，不构成投资建议
        <span className="ml-2">· 构建 {BUNDLE_ID}</span>
      </footer>
    </div>
  );
}
