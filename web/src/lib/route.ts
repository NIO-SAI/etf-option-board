/* 页面路由：用 hash 记录当前页，零依赖、刷新保持、链接可分享。
 *
 * 约定：`#/options`（期权看板，默认）与四个板块资金页 `#/board/*`。
 * 未知 hash 一律回落期权看板，绝不白屏。
 */

import { useEffect, useState } from "react";

export type PageKey = "options" | "board-flow" | "board-multi" | "board-etf" | "board-em";

export type PageDef = { key: PageKey; hash: string; label: string; title: string };

export const PAGES: PageDef[] = [
  { key: "options", hash: "#/options", label: "期权看板", title: "ETF 期权日内决策看板" },
  { key: "board-flow", hash: "#/board/flow", label: "概念资金分时", title: "板块资金 · 概念资金分时" },
  { key: "board-multi", hash: "#/board/multi", label: "主力资金多日图", title: "板块资金 · 主力资金多日图" },
  { key: "board-etf", hash: "#/board/etf", label: "ETF资金流", title: "板块资金 · ETF资金流" },
  { key: "board-em", hash: "#/board/em", label: "东财资金分时", title: "板块资金 · 东财资金分时" },
];

const BY_HASH = new Map(PAGES.map((p) => [p.hash, p.key]));
const BY_KEY = new Map(PAGES.map((p) => [p.key, p]));

/** hash 字符串 → 页面 key（容忍尾部斜杠与查询串，未知回落期权看板）。 */
export function pageFromHash(hash: string): PageKey {
  const clean = (hash || "").trim().split("?")[0].replace(/\/+$/, "");
  return BY_HASH.get(clean) ?? "options";
}

export function hashOf(key: PageKey): string {
  return (BY_KEY.get(key) ?? PAGES[0]).hash;
}

export function titleOf(key: PageKey): string {
  return (BY_KEY.get(key) ?? PAGES[0]).title;
}

/** 跳到指定页面（写 hash 会触发 hashchange，浏览器前进/后退同样可用）。 */
export function navigate(key: PageKey) {
  const h = hashOf(key);
  if (window.location.hash === h) return;
  window.location.hash = h;
}

/** 订阅当前页面。首帧就按现有 hash 解析，避免闪一下默认页。 */
export function usePageRoute(): PageKey {
  const [key, setKey] = useState<PageKey>(() =>
    typeof window === "undefined" ? "options" : pageFromHash(window.location.hash),
  );
  useEffect(() => {
    const onHash = () => {
      const raw = window.location.hash;
      const k = pageFromHash(raw);
      const canon = hashOf(k);
      // 只在「认不出」或「只差尾斜杠」时规范化；`#/board/em?date=…` 这类参数要保留
      if (raw !== canon && !raw.startsWith(canon + "?")) {
        window.history.replaceState(null, "", canon);
      }
      setKey(k);
    };
    window.addEventListener("hashchange", onHash);
    // 首次进入没有 hash 时补一个默认值（用 replace 不污染历史）
    if (!window.location.hash) {
      window.history.replaceState(null, "", hashOf("options"));
    } else {
      onHash();
    }
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return key;
}
