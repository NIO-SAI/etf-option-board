import { useEffect } from "react";
import { api } from "./api";
import { cacheWrite, dayKey } from "./cache";

/** 北京时间是否在预取窗口（09:15–15:05，周一至周五）。 */
function inWindow(d = new Date()): boolean {
  const bj = new Date(d.getTime() + (d.getTimezoneOffset() + 480) * 60_000);
  const wd = bj.getUTCDay();
  if (wd === 0 || wd === 6) return false;
  const min = bj.getUTCHours() * 60 + bj.getUTCMinutes();
  return min >= 9 * 60 + 15 && min <= 15 * 60 + 5;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 上次预取结束时间：页面切走再切回会重新挂载，若不设门槛会立刻把 12 只标的再拉一遍
let lastRunAt = 0;
const RERUN_AFTER_MS = 5 * 60_000;

/** 顺序预取：左栏顺序、跳过当前标的与 60s 内已取过的标的，每只之间间隔 2.5s。
 *  页面隐藏 / 切标的 / 卸载即停；同一时刻只有一个预取请求在途。 */
export function usePrefetch(current: string, codes: string[], ready: boolean) {
  const joined = codes.join(",");
  useEffect(() => {
    if (!ready || !codes.length) return;
    if (document.visibilityState !== "visible" || !inWindow()) return;
    if (Date.now() - lastRunAt < RERUN_AFTER_MS) return;
    lastRunAt = Date.now();
    let cancelled = false;
    let timer: any;
    const fetched = new Map<string, number>();
    const today = dayKey();

    const stop = () => {
      cancelled = true;
      clearTimeout(timer);
    };
    const onVis = () => {
      if (document.visibilityState !== "visible") stop();
    };
    document.addEventListener("visibilitychange", onVis);

    const loop = async () => {
      for (const code of codes) {
        if (cancelled) return;
        if (document.visibilityState !== "visible" || !inWindow()) return;
        if (code === current) continue;
        const at = fetched.get(code) ?? 0;
        if (Date.now() - at < 60_000) continue;
        try {
          const ctx = await api.etf(code, 1);
          if (cancelled) return;
          await cacheWrite("ctx", code, null, ctx);
          // dayKey 变化（跨零点/跨日）则放弃后续队列
          if (dayKey() !== today) return;
          const chain = await api.chain(code);
          if (cancelled) return;
          await cacheWrite("chain", code, null, chain);
          const plan = await api.strategy(code, 0, 1);
          if (cancelled) return;
          await cacheWrite("plan", code, null, plan);
          const sig = await api.reversalSignals(code);
          if (cancelled) return;
          await cacheWrite("sig", code, null, sig);
        } catch {
          /* 预取失败静默，不影响页面 */
        }
        fetched.set(code, Date.now());
        await sleep(2500);
      }
    };

    timer = setTimeout(loop, 5000);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, ready, joined]);
}
