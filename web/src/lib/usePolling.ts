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
    const run = async () => {
      const c = cacheRef.current;
      // 只在首次（含切标的）读缓存：之后每轮轮询都已有内存数据，再读会造成角标闪动
      if (c && first) {
        const hit = await cacheRead<T>(c.kind, c.code, c.extra);
        if (!alive) return;
        if (hit) {
          setData(hit.data);
          setCacheAt({ ts: hit.ts, day: hit.day });
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
        if (c) void cacheWrite(c.kind, c.code, c.extra, d);
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
    return () => {
      alive = false;
      clearTimeout(timer);
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

/** SSE 订阅告警流。 */
export function useAlertStream(onAlert: (a: any) => void) {
  const cb = useRef(onAlert);
  cb.current = onAlert;
  useEffect(() => {
    const es = new EventSource("/api/alerts/stream");
    es.onmessage = (ev) => {
      try {
        cb.current(JSON.parse(ev.data));
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {/* 浏览器会自动重连 */};
    return () => es.close();
  }, []);
}
