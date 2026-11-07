import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import { Dialog } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { pct, signedFlow } from "@/lib/format";
import { cn } from "@/lib/utils";

type BriefStock = {
  name: string; code: string; lbc: number;
  main_net?: number | null; reason?: string; reason_detail?: string;
};
type BriefTheme = {
  board: string; name: string; zt: number;
  pct?: number | null; main?: number | null;
  reason_text?: string; reason_src?: string;
  stocks: BriefStock[];
};
type Brief = {
  date?: string; total?: number; headline?: string; summary?: string;
  themes?: BriefTheme[]; src?: string; generated_at?: string;
  cached_at?: string; from_cache?: boolean; error?: string;
};

/** 标题里的时间戳（大模型生成时间优先，其次缓存时间） */
function stampOf(b: Brief | null): string {
  const s = b?.generated_at || b?.cached_at || "";
  return s.replace("T", " ");
}

/**
 * 「主题猎手-涨停分析」弹窗。
 *
 * 复刻经传那个点开按钮：一句话解读（红字）+ 概述（灰字）+ 每个热门板块的**炒作原因**
 * + 该板块涨停个股的**详细涨停原因**（同花顺 reason_info 长文本）。
 *
 * 炒作原因由后端 `brief()` 生成：整份解读一次大模型调用、按「日期 + 口径」缓存；
 * 大模型不可用/超时时自动降级为规则拼接（把涨停股的原因标签去重）。
 */
export function BriefDialog({
  open, onClose, date, mode, sort, level,
}: {
  open: boolean;
  onClose: () => void;
  date?: string;
  mode: string;
  sort: string;
  level: string;
}) {
  const [data, setData] = useState<Brief | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const load = useCallback(async (refresh = false) => {
    setLoading(true);
    setErr("");
    try {
      const r = await api.limitupBrief(date, mode, sort, level, refresh) as Brief;
      if (r?.error) setErr(r.error);
      setData(r);
    } catch (e: any) {
      setErr(e?.message ?? "加载失败");
    } finally {
      setLoading(false);
    }
  }, [date, mode, sort, level]);

  useEffect(() => {
    if (!open) return;
    setData(null);
    load(false);
  }, [open, load]);

  const themes = data?.themes ?? [];

  return (
    <Dialog open={open} onClose={onClose} title={null} className="w-[min(94vw,720px)] p-0">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-rose-600" />
          <span className="text-sm font-semibold">主题猎手-涨停分析</span>
          <span className="text-[10px] text-muted-foreground">{data?.date || date || ""}</span>
        </div>
        <div className="flex items-center gap-2 pr-6">
          <span className="text-[10px] text-muted-foreground">{stampOf(data)}</span>
          <button
            onClick={() => load(true)}
            disabled={loading}
            title="重新生成解读（会再调一次大模型）"
            className="flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] hover:bg-accent disabled:opacity-50"
          >
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} /> 重解读
          </button>
        </div>
      </div>

      <div className="max-h-[78vh] overflow-auto px-4 py-3">
        {loading && !themes.length && (
          <div className="py-16 text-center text-xs text-muted-foreground">
            正在生成解读…（首次会调用大模型，约 10~30 秒）
          </div>
        )}

        {err && !themes.length && (
          <div className="py-10 text-center text-xs text-destructive">解读失败：{err}</div>
        )}

        {themes.length > 0 && (
          <>
            <div className="text-center">
              <div className="text-sm text-muted-foreground">—— 主题猎手-涨停分析 ——</div>
              <div className="mt-1 text-[11px] text-muted-foreground">{stampOf(data)}</div>
            </div>

            <p className="mt-3 text-[15px] font-semibold leading-6 text-rose-600">
              涨停解读：{data?.headline}
            </p>
            <p className="mt-2 text-[12px] leading-5 text-muted-foreground">{data?.summary}</p>
            {data?.src === "rule" && (
              <p className="mt-1 text-[10px] text-muted-foreground">
                （大模型不可用，当前为规则拼接文案）
              </p>
            )}

            <div className="mt-3 flex flex-col gap-3">
              {themes.map((t) => (
                <section key={t.board} className="border-t pt-3 first:border-t-0 first:pt-0">
                  <div className="flex items-center gap-2 rounded bg-amber-50/70 px-2 py-1.5">
                    <span className="text-[13px] font-semibold">{t.name}</span>
                    <span className="text-[11px] text-muted-foreground">涨停 {t.zt} 家</span>
                    <span className={cn("ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium",
                      (t.pct ?? 0) >= 0 ? "bg-rose-600 text-white" : "bg-emerald-600 text-white")}>
                      涨幅 {t.pct == null ? "-" : pct(t.pct)}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[12px] leading-5 text-slate-700">
                    <span className="text-muted-foreground">炒作原因：</span>
                    {t.reason_text || "—"}
                    {t.reason_src === "rule" && (
                      <span className="ml-1 text-[10px] text-muted-foreground">（规则拼接）</span>
                    )}
                  </p>

                  <table className="mt-1.5 w-full text-[11px]">
                    <thead>
                      <tr className="text-muted-foreground">
                        <th className="py-1 text-left font-normal">名称</th>
                        <th className="w-16 py-1 text-left font-normal">类型</th>
                        <th className="w-24 py-1 text-right font-normal">主力净买额</th>
                      </tr>
                    </thead>
                    <tbody>
                      {t.stocks.map((s) => (
                        <tr key={s.code} className="border-t">
                          <td className="py-1.5 align-top">
                            <div className="font-medium">{s.name}</div>
                            <div className="text-[10px] text-muted-foreground">
                              {s.code.startsWith("6") ? "SH" : "SZ"}{s.code}
                            </div>
                            <div className="mt-0.5 text-[11px] leading-5 text-slate-600">
                              <span className="text-muted-foreground">原因：</span>
                              {s.reason_detail || s.reason || "—"}
                            </div>
                          </td>
                          <td className="py-1.5 align-top">
                            <span className={cn("rounded px-1 text-[10px]",
                              s.lbc >= 3 ? "bg-rose-600 text-white"
                                : s.lbc === 2 ? "bg-rose-100 text-rose-700"
                                  : "bg-muted text-muted-foreground")}>
                              {s.lbc >= 2 ? `${s.lbc}连板` : "首板"}
                            </span>
                          </td>
                          <td className={cn("py-1.5 text-right align-top",
                            (s.main_net ?? 0) >= 0 ? "text-rose-600" : "text-emerald-600")}>
                            {s.main_net == null ? "-" : signedFlow(s.main_net)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
