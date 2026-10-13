import { useEffect, useRef, useState } from "react";

/** 轮询 hook：立即取一次，然后按 interval 轮询；返回 data/error/refresh。 */
export function usePolling<T>(fn: () => Promise<T>, intervalMs: number, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    let alive = true;
    let timer: any;
    const run = async () => {
      try {
        const d = await fnRef.current();
        if (alive) {
          setData(d);
          setError(null);
        }
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

  return { data, error, refresh: () => setTick((t) => t + 1) };
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
