/* 页面级状态 ↔ URL：刷新/分享后仍停留在同一状态。
 *
 * 约定：状态写在 hash 的查询串里，例如
 *   `#/board/flow?type=industry&date=2026-11-04&codes=BK1036,BK1201`
 * 只在 `replaceState` 里写，不产生额外历史记录（前进/后退仍按页面走）。
 */

export function readHashParams(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const hash = window.location.hash || "";
  const q = hash.split("?")[1] ?? "";
  const out: Record<string, string> = {};
  new URLSearchParams(q).forEach((v, k) => {
    if (v !== "") out[k] = v;
  });
  return out;
}

export function writeHashParams(params: Record<string, string | undefined | null>) {
  if (typeof window === "undefined") return;
  const hash = window.location.hash || "#/options";
  const [path] = hash.split("?");
  const search = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (v != null && v !== "") search.set(k, String(v));
  });
  const qs = search.toString();
  const next = qs ? `${path}?${qs}` : path;
  if (next !== hash) window.history.replaceState(null, "", next);
}

/** 逗号分隔的代码列表 ↔ 数组 */
export const parseCodes = (v: string | null | undefined): string[] =>
  (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);

export const joinCodes = (codes: string[]): string | undefined =>
  codes.length ? codes.join(",") : undefined;
