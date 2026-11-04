import { useEffect, useRef, useState } from "react";
import { cacheRead, cacheWrite, dayKey, type CacheKind } from "./cache";

export type CacheMeta = { ts: number; day: string };
export type CacheOpt = { kind: CacheKind; code: string; extra?: string | number | null };

/** 轮询 hook：立即渲染本地缓存（SWR），同时发真实请求；返回 data/error/refresh。
 *  cacheAt 仅在「当前展示的是缓存」时非空，数据刷新成功后清空。 */
export function usePolling<T>(
  fn: () => Promise<T>,
  intervalMs: number,
  deps: any[] = [],
  cache?: CacheOpt,
) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cacheAt, setCacheAt] = useState<CacheMeta | null>(null);
  const [tick, setTick] = useState(0);
  const lastOkAt = useRef(0);
  // 手动刷新时把「下一次请求结束」回调排进队列，refresh() 返回的 Promise 在其后 resolve
  const waiters = useRef<Array<() => void>>([]);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const cacheRef = useRef(cache);
  cacheRef.current = cache;

  // 仅真正卸载时放行等待中的刷新 promise；deps 变化触发的重建不算
  useEffect(() => () => {
    const rs = waiters.current;
    waiters.current = [];
    rs.forEach((f) => f());
  }, []);

  useEffect(() => {
    let alive = true;
    let first = true;
    let timer: any;
    // 缓存键在 effect 生命周期内固定：切合约时旧 effect 的在途请求可能后返回，
    // 若在 run() 里读 cacheRef.current 就会拿到**新**合约的键，把旧数据写进新
    // 合约的缓存（污染后切回去一直是错的）。同理旧请求也不能再 setData。
    const c = cacheRef.current;
    const run = async () => {
      // 页面切到后台时不发请求（浏览器会节流定时器，这里直接跳过）；
      // 切回前台由 visibilitychange 立即补一次。
      if (typeof document !== "undefined" && document.hidden) {
        timer = setTimeout(run, 20_000);
        return;
      }
      // 只在首次（含切标的）读缓存：之后每轮轮询都已有内存数据，再读会造成角标闪动
      if (c && first) {
        const hit = await cacheRead<T>(c.kind, c.code, c.extra);
        if (!alive) return;
        if (hit) {
          setData(hit.data);
          setCacheAt({ ts: hit.ts, day: hit.day });
          // 缓存还新鲜（不到一个轮询周期）：本轮先不请求，等下一次再拉。
          // 切换标的/合约时靠它省掉大量回切请求。
          if (Date.now() - hit.ts < intervalMs) {
            first = false;
            timer = setTimeout(run, intervalMs);
            return;
          }
        }
      }
      first = false;
      try {
        const d = await fnRef.current();
        if (alive) {
          setData(d);
          setError(null);
          setCacheAt(null);
        }
        lastOkAt.current = Date.now();
        // 已切走（旧 effect）的迟到响应不写缓存：否则会把旧合约数据记到新合约名下。
        if (alive && c) void cacheWrite(c.kind, c.code, c.extra, d);
      } catch (e: any) {
        if (alive) {
          setError(String(e?.message || e));
          // 本轮刷新失败：已有数据仍展示上一次成功结果，标记为缓存并给出它的时间
          if (lastOkAt.current) {
            setCacheAt({ ts: lastOkAt.current, day: dayKey(new Date(lastOkAt.current)) });
          }
        }
      }
      if (alive) {
        const rs = waiters.current;
        waiters.current = [];
        rs.forEach((f) => f());
        timer = setTimeout(run, intervalMs);
      }
    };
    run();
    const onVis = () => {
      if (document.hidden) return;
      clearTimeout(timer);
      void run();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVis);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, tick, ...deps]);

  const refresh = () =>
    new Promise<void>((resolve) => {
      waiters.current.push(resolve);
      setTick((t) => t + 1);
    });
  return { data, error, cacheAt, refresh };
}

