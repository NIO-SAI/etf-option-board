import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Eye, Loader2, Plus, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { Frame, FramePanel, FrameHeader, FrameTitle } from "@/components/reui/frame";
import { Badge } from "@/components/reui/badge";
import { Drawer, EmptyState, Skeleton } from "@/components/ui/misc";
import { BoardFlowChart, FlowDetailChart, FlowHistoryChart, MoneyLinesChart, type FlowLine } from "@/components/charts";
import { api } from "@/lib/api";
import { usePolling } from "@/lib/usePolling";
import { onGlobalRefresh } from "@/lib/refresh";
import { clsUpDown, pct as fmtPct, signedWanGrouped, signedYi } from "@/lib/format";
import { cn } from "@/lib/utils";

/** 与 stock-webui 一致的五个口径 */
const TYPES = [
  { key: "concept", label: "概念" },
  { key: "industry", label: "行业" },
  { key: "index", label: "指数" },
  { key: "hot", label: "热门" },
  { key: "custom", label: "自定义" },
];
type SortKey = "flow" | "pct" | "speed";
const SERIES_TTL = 90_000;

type Bar = {
  code: string; name: string; type: string;
  flow: number; pct: number | null; speed?: number; watch?: boolean;
  /** 名称的拼音首字母（后端给），用于拼音搜索 */
  py?: string;
};
type CacheEntry = { points: [string, number][]; pct: number | null; name: string; at: number };

/** 板块资金分时：复刻 stock-webui /board-flow 的列表 + 叠加曲线交互。 */
export function BoardFlowPage() {
  const [type, setType] = useState("concept");
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("flow");
  const [sortDir, setSortDir] = useState(-1);
  const [date, setDate] = useState("");
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [hoverCode, setHoverCode] = useState<string | null>(null);
  const [detailCode, setDetailCode] = useState<{ code: string; name: string } | null>(null);
  const [cacheVer, setCacheVer] = useState(0);
  // 手动刷新时递增：清空分时缓存后要让拉取 effect 重新跑（deps 里没有缓存内容）
  const [refreshTick, setRefreshTick] = useState(0);
  const cache = useRef<Record<string, CacheEntry>>({});
  const inflight = useRef<Set<string>>(new Set());
  // 用户在哪些口径上手动改过勾选（决定是否还套用默认 Top10+Bottom5）
  const touched = useRef<Record<string, boolean>>({});

  const { data: health } = usePolling(() => api.boardHealth(), 60_000, [], { kind: "ctx", code: "board-health" });
  const trading = !!health?.trading;
  const interval = trading ? 30_000 : 300_000;

  const { data: datesView } = usePolling(() => api.boardDates(60), 600_000, [], { kind: "ctx", code: "board-dates" });
  const dates: string[] = datesView?.dates ?? [];

  const { data: rankView, refresh: refreshRank } = usePolling(
    () => api.boardRank("all", date || undefined),
    interval,
    [interval, date],
    { kind: "brank", code: `all:${date || "latest"}` },
  );
  const { data: indexView, refresh: refreshIndex } = usePolling(
    () => api.boardIndexRank(date || undefined),
    interval,
    [interval, date],
    { kind: "brank", code: `index:${date || "latest"}` },
  );
  const { data: watchView, refresh: refreshWatch } = usePolling(
    () => api.boardWatch(), 300_000, [], { kind: "ctx", code: "board-watch" });
  // 自选的本地真实来源：点击 + 立即翻转（乐观更新），服务端返回后以 watchView 对齐
  const [watchItems, setWatchItems] = useState<{ code: string; name: string }[]>([]);
  const [watchBusy, setWatchBusy] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (Array.isArray(watchView?.items)) setWatchItems(watchView.items);
  }, [watchView]);
  const watchSet = useMemo(() => new Set(watchItems.map((i) => i.code)), [watchItems]);

  const refresh = useCallback(() => {
    cache.current = {};
    void refreshRank();
    void refreshIndex();
    setRefreshTick((t) => t + 1);
  }, [refreshRank, refreshIndex]);

  useEffect(() => onGlobalRefresh(() => refresh()), [refresh]);

  const allBoards: Bar[] = useMemo(
    () => (rankView?.items ?? []).map((r: any) => ({
      code: r.code, name: r.name, type: r.type, flow: r.flow ?? 0, pct: r.pct ?? null,
      speed: r.speed ?? 0, watch: watchSet.has(r.code), py: r.py,
    })),
    [rankView, watchSet],
  );
  const indexRows: Bar[] = useMemo(
    () => (indexView?.items ?? []).map((r: any) => ({
      code: r.code, name: r.name, type: "index", flow: r.flow ?? 0, pct: r.pct ?? null,
      speed: 0, py: r.py, watch: watchSet.has(r.code),
    })),
    [indexView, watchSet],
  );

  /** 当前口径的原始列表（未搜索、未排序之外的过滤） */
  const baseRows: Bar[] = useMemo(() => {
    if (type === "index") return indexRows;
    if (type === "hot") {
      return [...allBoards].sort((a, b) => Math.abs(b.flow) - Math.abs(a.flow)).slice(0, 100);
    }
    if (type === "custom") {
      const byCode = new Map([...allBoards, ...indexRows].map((b) => [b.code, b] as const));
      return watchItems
        .map((w) => byCode.get(w.code) ?? { code: w.code, name: w.name, type: "concept", flow: 0, pct: null, watch: true })
        .map((b: any) => ({ ...b, watch: true }));
    }
    return allBoards.filter((b) => b.type === type);
  }, [type, allBoards, indexRows, watchItems]);

  /** 搜索 + 排序后的可见列表 */
  const rows: Bar[] = useMemo(() => {
    const kw = search.trim();
    let list = baseRows;
    if (kw) {
      const k = kw.toLowerCase();
      list = list.filter((b) =>
        b.name.includes(kw)
        || b.code.toLowerCase().includes(k)
        || (b.py ?? "").includes(k));
    }
    const dir = sortDir;
    return [...list].sort((a, b) => {
      const va = sortKey === "pct" ? (a.pct ?? 0) : sortKey === "speed" ? (a.speed ?? 0) : a.flow;
      const vb = sortKey === "pct" ? (b.pct ?? 0) : sortKey === "speed" ? (b.speed ?? 0) : b.flow;
      return (va - vb) * dir;
    });
  }, [baseRows, search, sortKey, sortDir]);

  const rowsKey = rows.map((r) => r.code).join(",");
  const baseKey = useMemo(() => baseRows.map((r) => r.code).sort().join(","), [baseRows]);

  // 默认勾选：概念/行业 = 流入 Top10 + 流出末 5；指数/热门/自定义 = 全选。
  // 只在「集合本身」变化时重置（排序/搜索不算），且手动改过就只做存在性过滤。
  useEffect(() => {
    if (!rows.length) return;
    const codes = new Set(rows.map((r) => r.code));
    if (touched.current[type]) {
      setSelected((prev) => Object.fromEntries(
        Object.keys(prev).filter((c) => codes.has(c)).map((c) => [c, true])));
      return;
    }
    let saved: string[] = [];
    try {
      saved = JSON.parse(localStorage.getItem(`board.flow.sel.${type}`) || "[]");
    } catch {
      saved = [];
    }
    const kept = (saved || []).filter((c) => codes.has(c));
    if (kept.length) {
      setSelected(Object.fromEntries(kept.map((c) => [c, true])));
      return;
    }
    if (type === "index" || type === "hot" || type === "custom") {
      setSelected(Object.fromEntries(rows.map((r) => [r.code, true])));
      return;
    }
    const pos = rows.filter((r) => r.flow >= 0).slice(0, 10);
    const neg = rows.filter((r) => r.flow < 0).slice(-5);
    setSelected(Object.fromEntries([...pos, ...neg].map((r) => [r.code, true])));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseKey, type]);

  const selectedCodes = useMemo(
    () => rows.filter((r) => selected[r.code]).map((r) => r.code),
    [rows, selected],
  );
  const selectedKey = selectedCodes.join(",");

  const persist = (next: Record<string, boolean>) => {
    touched.current[type] = true;
    setSelected(next);
    try {
      localStorage.setItem(`board.flow.sel.${type}`, JSON.stringify(
        Object.keys(next).filter((c) => next[c])));
    } catch { /* 隐私模式忽略 */ }
  };

  const toggle = (code: string) => {
    const next = { ...selected };
    if (next[code]) delete next[code];
    else next[code] = true;
    persist(next);
  };

  const batch = (mode: "pos10" | "neg10" | "all" | "none" | "invert") => {
    const cur = sortedBase();
    let next: Record<string, boolean> = {};
    if (mode === "all") cur.forEach((b) => (next[b.code] = true));
    else if (mode === "pos10") cur.filter((b) => b.flow >= 0).slice(0, 10).forEach((b) => (next[b.code] = true));
    else if (mode === "neg10") cur.filter((b) => b.flow < 0).slice(-10).forEach((b) => (next[b.code] = true));
    else if (mode === "invert") cur.forEach((b) => { if (!selected[b.code]) next[b.code] = true; });
    persist(next);
  };

  /** 批量操作按「资金流降序」的口径取前 N（与 stock-webui 一致） */
  const sortedBase = () => [...baseRows].sort((a, b) => b.flow - a.flow);

  // 分时缓存键带日期：切日期必须重新拉（旧日期数据不能复用）
  const keyOf = useCallback((code: string) => `${date}|${code}`, [date]);

  // 分时数据：按缺失/过期分块拉取（最多 60 个一批），命中缓存直接渲染
  useEffect(() => {
    if (!selectedCodes.length) return;
    const now = Date.now();
    const missing = selectedCodes.filter((c) => {
      const e = cache.current[keyOf(c)];
      return !e || now - e.at > SERIES_TTL;
    }).filter((c) => !inflight.current.has(keyOf(c)));
    if (!missing.length) return;

    (async () => {
      for (let i = 0; i < missing.length; i += 60) {
        const chunk = missing.slice(i, i + 60);
        chunk.forEach((c) => inflight.current.add(keyOf(c)));
        try {
          const d = await api.boardSeries(chunk.join(","), date || undefined, type === "index" ? "index" : "concept");
          const byCode = new Map((d?.series ?? []).map((s: any) => [s.code, s]));
          chunk.forEach((c) => {
            const s: any = byCode.get(c);
            // 即使没有该板块也写一条空记录：区分「没拉到」和「当日无点」，避免一直转圈
            const pts: [string, number][] = [];
            (s?.values ?? []).forEach((v: number | null, idx: number) => {
              if (v != null) pts.push([d.axis[idx], v]);
            });
            cache.current[keyOf(c)] = {
              points: pts, pct: s?.pct ?? null, name: s?.name ?? c, at: Date.now(),
            };
          });
        } catch {
          /* 单块失败静默，下一轮再试 */
        } finally {
          chunk.forEach((c) => inflight.current.delete(keyOf(c)));
        }
      }
      // 即便本次 effect 已被新的日期/标的替换，缓存写入是按日期隔离的，仍要触发一次重渲染
      setCacheVer((v) => v + 1);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, date, refreshTick, keyOf]);

  // 悬停未勾选的板块：临时拉它的分时，画一条橙色虚线（不改变勾选）
  const [tempLine, setTempLine] = useState<FlowLine | null>(null);
  const ensureTemp = async (b: Bar) => {
    const hit = cache.current[keyOf(b.code)];
    if (hit && Date.now() - hit.at < SERIES_TTL) {
      setTempLine({ code: b.code, name: b.name, points: hit.points });
      return;
    }
    try {
      const d = await api.boardSeries(b.code, date || undefined, type === "index" ? "index" : "concept");
      const s: any = (d?.series ?? [])[0];
      if (!s) return;
      const pts: [string, number][] = [];
      (s.values ?? []).forEach((v: number | null, idx: number) => {
        if (v != null) pts.push([d.axis[idx], v]);
      });
      cache.current[keyOf(b.code)] = { points: pts, pct: s.pct ?? null, name: s.name ?? b.code, at: Date.now() };
      setTempLine({ code: b.code, name: b.name, points: pts });
    } catch {
      /* 忽略 */
    }
  };

  const lines: FlowLine[] = useMemo(() => {
    void cacheVer;
    return selectedCodes
      .map((code) => {
        const e = cache.current[`${date}|${code}`];
        if (!e || !e.points.length) return null;
        const row = rows.find((r) => r.code === code);
        return { code, name: e.name || row?.name || code, points: e.points, pct: row?.pct ?? e.pct };
      })
      .filter(Boolean) as FlowLine[];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, cacheVer, rowsKey]);

  // 底部标注：优先显示悬停中的那条线，否则显示当前条数
  const activeLine = useMemo(
    () => lines.find((l) => l.code === hoverCode) ?? lines[0] ?? null,
    [lines, hoverCode],
  );
  const activeLast = activeLine?.points.length
    ? activeLine.points[activeLine.points.length - 1][1] : null;

  const toggleCustom = async (b: Bar) => {
    if (watchBusy[b.code]) return;
    const isWatched = watchSet.has(b.code);
    setWatchBusy((m) => ({ ...m, [b.code]: true }));
    // 乐观更新：按钮/「自定义」列表立刻变化，失败再回滚
    setWatchItems((prev) => (isWatched
      ? prev.filter((i) => i.code !== b.code)
      : [...prev, { code: b.code, name: b.name }]));
    try {
      const res = isWatched ? await api.boardWatchRemove(b.code) : await api.boardWatchAdd(b.code, b.name);
      if (res?.error) throw new Error(res.error);
      toast(isWatched ? `已从自定义移除：${b.name}` : `已添加到自定义：${b.name}`);
      void refreshWatch();
    } catch (e: any) {
      setWatchItems((prev) => (isWatched
        ? [...prev, { code: b.code, name: b.name }]
        : prev.filter((i) => i.code !== b.code)));
      toast("自定义操作失败", { description: String(e?.message ?? e) });
    } finally {
      setWatchBusy((m) => ({ ...m, [b.code]: false }));
    }
  };

  const last = health?.last;
  const updatedAt = date ? `${date} 历史数据` : `更新于 ${last?.last_ts?.slice(11) ?? "—"}`;

  return (
    <main className="grid gap-3 p-3 xl:grid-cols-[320px_minmax(0,1fr)]">
      {/* 左：板块列表 + 批量控制 */}
      <Frame spacing="sm" className="self-start xl:sticky xl:top-[52px]">
        <FramePanel dense>
          <FrameHeader className="flex-row items-center justify-between py-1.5">
            <FrameTitle className="text-sm">板块列表</FrameTitle>
            <span className="text-[11px] text-muted-foreground tnum">
              共 {rows.length} 个 · 已选 {selectedCodes.length}
            </span>
          </FrameHeader>

          <div className="flex flex-col gap-2 px-2 pb-2">
            <label className="relative block">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <input
                id="board-flow-search"
                name="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索..."
                aria-label="搜索板块"
                className="w-full rounded-md border border-border bg-card py-1 pl-7 pr-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </label>

            <div className="flex items-center gap-1 text-[11px]">
              <span className="text-muted-foreground">排序</span>
              <div className="flex items-center gap-0.5 rounded-md border border-border bg-muted/40 p-0.5">
                {(["pct", "speed", "flow"] as SortKey[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => {
                      if (sortKey === k) setSortDir((d) => -d);
                      else { setSortKey(k); setSortDir(-1); }
                    }}
                    aria-pressed={sortKey === k}
                    title={k === "pct" ? "按涨跌幅排序（再点切换升/降序）"
                      : k === "speed" ? "按涨速排序（不显示列，再点切换升/降序）"
                        : "按主力净流入排序（再点切换升/降序）"}
                    className={cn("rounded px-2 py-0.5 font-medium transition-colors",
                      sortKey === k
                        ? "bg-primary text-primary-foreground shadow-xs"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground")}
                  >
                    {k === "pct" ? "涨幅" : k === "speed" ? "涨速" : "资金"}{sortKey === k ? (sortDir === -1 ? "↓" : "↑") : ""}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap gap-1 text-[11px]">
              {([["pos10", "流入Top10"], ["neg10", "流出Top10"], ["all", "全选"], ["none", "清空"], ["invert", "反选"]] as const).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => batch(k)}
                  className="rounded border border-border px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  {label}
                </button>
              ))}
            </div>

            <div className="max-h-[calc(100vh-19rem)] min-h-[240px] overflow-auto border-t border-border/60">
              {!rankView ? (
                <div className="flex flex-col gap-1 p-2">
                  {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}
                </div>
              ) : rows.length === 0 ? (
                <EmptyState title={type === "custom" ? "还没有自定义板块" : "无匹配板块"}
                  hint={type === "custom" ? "在其他列表点行尾的 ＋ 图标即可加入自定义" : undefined} />
              ) : (
                rows.map((b) => {
                  const on = !!selected[b.code];
                  return (
                    <div
                      key={b.code}
                      role="button"
                      tabIndex={0}
                      onClick={() => toggle(b.code)}
                      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(b.code); } }}
                      onMouseEnter={() => { setHoverCode(on ? b.code : null); if (!on) void ensureTemp(b); }}
                      onMouseLeave={() => { setHoverCode(null); setTempLine(null); }}
                      className={cn(
                        "flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[11px] transition-colors",
                        "hover:bg-muted/60",
                        on && "bg-primary/5",
                      )}
                      title="单击勾选 / 取消"
                    >
                      <input type="checkbox" checked={on} readOnly aria-label={`勾选${b.name}`}
                        className="size-3 shrink-0 accent-primary" />
                      <span className={cn("min-w-0 flex-1 truncate", on ? "font-medium text-foreground" : "text-foreground/80")}>
                        {b.name}
                        {type === "index" && !b.code.startsWith("47.") && (
                          <span className="ml-1 text-[10px] text-muted-foreground">({b.code.split(".")[1]})</span>
                        )}
                      </span>
                      <span className={cn("w-[3.6em] shrink-0 text-right text-[10px] tnum", clsUpDown(b.pct))}>
                        {b.pct == null ? "--" : fmtPct(b.pct, 2)}
                      </span>
                      <span className={cn("shrink-0 whitespace-nowrap text-right text-[10px] tnum", b.flow >= 0 ? "text-up" : "text-down")}>
                        {signedWanGrouped(b.flow)}
                      </span>
                      {b.code.startsWith("BK") && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setDetailCode({ code: b.code, name: b.name }); }}
                          title="查看板块详情"
                          aria-label={`查看${b.name}详情`}
                          className="inline-flex size-5 shrink-0 items-center justify-center rounded border border-border bg-card text-muted-foreground transition-colors hover:border-primary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <Eye className="size-3" aria-hidden />
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); void toggleCustom(b); }}
                        disabled={!!watchBusy[b.code]}
                        title={b.watch ? "已加入自定义，点击移除" : "加入自定义"}
                        aria-label={b.watch ? "移除自定义" : "添加自定义"}
                        aria-pressed={!!b.watch}
                        className={cn(
                          "inline-flex size-5 shrink-0 items-center justify-center rounded border transition-colors",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                          b.watch
                            ? "border-warning/60 bg-warning/15 text-warning hover:border-destructive hover:text-destructive"
                            : "border-border bg-card text-muted-foreground hover:border-primary hover:bg-primary/10 hover:text-primary",
                          watchBusy[b.code] && "cursor-wait opacity-60",
                        )}
                      >
                        {watchBusy[b.code]
                          ? <Loader2 className="size-3 animate-spin" aria-hidden />
                          : b.watch ? <Check className="size-3" aria-hidden /> : <Plus className="size-3" aria-hidden />}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </FramePanel>
      </Frame>

      {/* 右：分时图 */}
      <Frame spacing="sm" className="flex min-h-0 flex-col xl:sticky xl:top-[52px] xl:h-[calc(100vh-104px)]">
        <FramePanel dense className="flex min-h-0 flex-1 flex-col">
          <FrameHeader className="flex-row flex-wrap items-center justify-between gap-2 py-1.5">
            <div className="flex items-center gap-2">
              <FrameTitle className="text-sm">板块资金分时</FrameTitle>
              {date && date !== health?.last?.date && <Badge variant="warning-light">历史</Badge>}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
              <div className="flex items-center gap-0.5 rounded-md bg-muted/60 p-0.5">
                {TYPES.map((t) => (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => { setType(t.key); setSearch(""); }}
                    aria-pressed={type === t.key}
                    className={cn("rounded px-2 py-0.5 transition-colors",
                      type === t.key ? "bg-background text-foreground shadow-xs" : "text-muted-foreground hover:text-foreground")}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              <select
                id="board-flow-date" name="date" aria-label="选择日期"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="rounded border border-border bg-card px-1.5 py-0.5 text-[11px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="">最新（{rankView?.date ?? "—"}）</option>
                {dates.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
              <button
                type="button"
                onClick={() => setDate("")}
                className="rounded border border-border px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                今日
              </button>
              <span className="hidden text-muted-foreground tnum sm:inline">{updatedAt}</span>
              <button
                type="button"
                onClick={() => refresh()}
                title="刷新"
                aria-label="刷新"
                className="rounded-md border border-border p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <RefreshCw className="size-3" aria-hidden />
              </button>
            </div>
          </FrameHeader>

          <div className="flex min-h-0 flex-1 flex-col px-1 pb-1">
            {!selectedCodes.length ? (
              <EmptyState title="未选择板块" hint="请在左侧勾选，或点「流入Top10」批量激活"
                className="flex-1" />
            ) : !lines.length ? (
              selectedCodes.every((c) => cache.current[`${date}|${c}`]) ? (
                <EmptyState title="所选板块暂无分时数据" hint="换一天或换一批板块试试" className="flex-1" />
              ) : (
                <div className="flex flex-1 items-center justify-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden /> 加载分时数据…
                </div>
              )
            ) : (
              <div className="min-h-0 flex-1">
                <BoardFlowChart id="board-flow-lines" lines={lines} hoverCode={hoverCode}
                  temp={tempLine} height="100%" onHoverCode={setHoverCode} />
              </div>
            )}
            <div className="mt-1 flex items-center justify-between px-2 text-[10px] text-muted-foreground">
              <span>{lines.length}/{selectedCodes.length} 条线 · 悬停左侧名称预览，行尾按钮看详情</span>
              <span>
                主力净流入（累计，亿元）
                {activeLine && (
                  <> · <span className="text-foreground/80">{activeLine.name}</span>{" "}
                    <span className={cn("tnum", (activeLast ?? 0) >= 0 ? "text-up" : "text-down")}>
                      {signedYi(activeLast)}
                    </span>
                  </>
                )}
              </span>
            </div>
          </div>
        </FramePanel>
      </Frame>

      <BoardDetailDrawer
        selected={detailCode}
        date={date || rankView?.date || ""}
        onClose={() => setDetailCode(null)}
      />
    </main>
  );
}

/* ------------------------------------------------------------------ */
/* 详情抽屉（双击板块打开）：六块内容各自降级                          */
/* ------------------------------------------------------------------ */
function BoardDetailDrawer({
  selected, date, onClose,
}: {
  selected: { code: string; name: string } | null;
  date: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!selected) { setData(null); return; }
    let alive = true;
    setLoading(true);
    api.boardDetail(selected.code, date || undefined).then((d) => {
      if (alive) setData(d);
    }).catch(() => {
      if (alive) setData({ error: "详情加载失败" });
    }).finally(() => {
      if (alive) setLoading(false);
    });
    return () => { alive = false; };
  }, [selected?.code, date]);

  const d = data;
  const errors = d?.errors ?? {};
  const series = d?.series;
  const vs = d?.vs_index;
  const history = d?.history ?? [];
  const stocks = d?.stocks ?? [];
  const heat = d?.report_heat;

  return (
    <Drawer
      open={!!selected}
      onClose={onClose}
      widthClass="w-[50vw] min-w-[420px] max-w-[1000px]"
      title={selected ? `${selected.name} ${selected.code}` : ""}
      subtitle={d && !loading
        ? `${date} · ${d.type === "industry" ? "行业" : d.type === "index" ? "指数" : "概念"} · 主力净流入 ${signedYi(d.flow)}${d.pct != null ? ` · 涨跌幅 ${fmtPct(d.pct)}` : ""}`
        : `${date} · 加载中…`}
    >
      {!d || loading ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Section title="当日资金分时" hint={errors.series ?? (series?.axis?.length ? "累计折线 + 每分钟增量柱" : undefined)}>
            {series?.axis?.length ? (
              <FlowDetailChart id={`bd-${d.code}`} axis={series.axis} values={series.values} />
            ) : (
              <EmptyState title="暂无分时数据" hint={errors.series ?? "该板块当日还没有累积到分时点"} />
            )}
          </Section>

          <Section title={`成分股主力净流入（Top ${Math.min(stocks.length, 12)}）`} hint={errors.stocks}>
            {stocks.length ? (
              <table className="w-full border-collapse text-[11px]">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="px-1 py-1 font-normal">股票</th>
                    <th className="px-1 py-1 text-right font-normal">最新价</th>
                    <th className="px-1 py-1 text-right font-normal">涨跌幅</th>
                    <th className="px-1 py-1 text-right font-normal">主力净流入</th>
                  </tr>
                </thead>
                <tbody>
                  {stocks.slice(0, 12).map((s: any) => (
                    <tr key={s.code} className="border-t border-border/40">
                      <td className="px-1 py-0.5">
                        <span className="font-medium">{s.name}</span>
                        <span className="ml-1 text-[10px] text-muted-foreground">{s.code}</span>
                      </td>
                      <td className="px-1 py-0.5 text-right tnum">{s.price ? s.price.toFixed(2) : "—"}</td>
                      <td className={cn("px-1 py-0.5 text-right tnum", clsUpDown(s.pct))}>{s.pct == null ? "—" : fmtPct(s.pct)}</td>
                      <td className={cn("px-1 py-0.5 text-right tnum", (s.flow ?? 0) >= 0 ? "text-up" : "text-down")}>
                        {signedYi(s.flow)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <EmptyState title="暂无成分股数据" hint={errors.stocks} />
            )}
          </Section>

          <Section title="近 20 个交易日资金流" hint={errors.history ?? `覆盖 ${history.length} 个交易日`}>
            {history.length ? (
              <FlowHistoryChart id={`bh-${d.code}`} dates={history.map((h: any) => h.date)}
                values={history.map((h: any) => h.flow)} />
            ) : (
              <EmptyState title="暂无历史数据" hint="库里还没有该板块的每日快照" />
            )}
          </Section>

          <Section title="与上证指数资金走势对比" hint={errors.vs_index ?? vs?.index_day}>
            {vs?.axis?.length ? (
              <MoneyLinesChart id={`bv-${d.code}`} axis={vs.axis} maxLines={2}
                series={[
                  { code: d.code, name: d.name ?? "板块", values: vs.board },
                  { code: "1.000001", name: "上证指数", values: vs.index },
                ]} height={200} />
            ) : (
              <EmptyState title="暂无可对比数据" hint={errors.vs_index ?? "指数分时暂无数据"} />
            )}
          </Section>

          <Section title={`研报热度（近 ${heat?.days ?? 90} 天）`} hint={errors.report_heat}>
            {heat ? (
              <>
                <div className="mb-1 text-xs text-muted-foreground">
                  合计 <span className="font-semibold text-foreground">{heat.count}</span> 篇（成分股前 3 名聚合）
                </div>
                <div className="flex flex-wrap gap-2 text-[11px]">
                  {(heat.top ?? []).map((t: any) => (
                    <span key={t.code} className="rounded bg-muted/50 px-1.5 py-0.5">
                      {t.name} <span className="tnum text-foreground/80">{t.hits}</span>
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <EmptyState title="暂无研报数据" hint={errors.report_heat} />
            )}
          </Section>
        </div>
      )}
    </Drawer>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border/60 bg-background/40">
      <header className="flex items-baseline justify-between gap-2 border-b border-border/40 px-2.5 py-1.5">
        <h4 className="text-xs font-medium">{title}</h4>
        {hint && <span className="truncate text-[10px] text-muted-foreground">{hint}</span>}
      </header>
      <div className="p-2">{children}</div>
    </section>
  );
}
