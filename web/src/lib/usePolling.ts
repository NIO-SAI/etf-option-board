import { useEffect, useRef, useState } from "react";
import { cacheRead, cacheWrite, type CacheKind } from "./cache";

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
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const cacheRef = useRef(cache);
  cacheRef.current = cache;

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
        if (c) void cacheWrite(c.kind, c.code, c.extra, d);
      } catch (e: any) {
        if (alive) setError(String(e?.message || e));
      }
      if (alive) timer = setTimeout(run, intervalMs);
    };
    run();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, tick, ...deps]);

  return { data, error, cacheAt, refresh: () => setTick((t) => t + 1) };
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
