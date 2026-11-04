/* 全局刷新事件：顶栏只有一个「刷新」按钮，但每页要刷的东西不同。
 *
 * 页面挂载时订阅（`onGlobalRefresh`），卸载自动解绑；顶栏只负责广播。
 */

import { api } from "./api";

const EVENT = "board:global-refresh";
export const REFRESH_EVENT = EVENT;

/** 广播一次刷新（顶栏按钮调用）。 */
export function requestRefresh() {
  window.dispatchEvent(new CustomEvent(EVENT));
  // 顺带触发一次服务端监控周期，保持原有「点刷新即跑一轮监控」的行为
  void api.monitorCycle().catch(() => {});
}

/** 订阅全局刷新，返回取消订阅函数（给 useEffect 直接 return）。 */
export function onGlobalRefresh(fn: () => void): () => void {
  const h = () => fn();
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}
