import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Frame, FrameHeader, FramePanel, FrameTitle } from "@/components/reui/frame";
import { Badge } from "@/components/reui/badge";
import { Dialog, HoverTip } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { useAlertStream } from "@/lib/usePolling";
import { sound } from "@/lib/sound";
import { clsUpDown } from "@/lib/format";
import { AlertTriangle, BellRing, Volume2 } from "lucide-react";

const TYPE_LABEL: Record<string, string> = {
  price_spike: "价格异动", volume_surge: "量能放大", main_inflow: "主力资金",
  divergence: "MACD背离", key_time: "变盘时点", national_team: "国家队护盘",
  opt_spike: "合约异动", reversal: "变盘开仓",
};

export function AlertCenter() {
  const [items, setItems] = useState<any[]>([]);
  const [popup, setPopup] = useState<any>(null);
  const seen = useRef<Set<number>>(new Set());

  useEffect(() => {
    api.alerts().then((d) => {
      const list = d.items ?? [];
      // 关键：把首屏历史的 id 记入 seen，否则 SSE 连接时的 backfill（重发最近 10 条、
      // 且带相同 id）会被当成新告警再次插入，历史告警在列表里重复 2~3 次。
      list.forEach((a: any) => seen.current.add(a.id));
      setItems(list);
    }).catch(() => {});
  }, []);

  const onAlert = (a: any) => {
    if (seen.current.has(a.id)) return;
    seen.current.add(a.id);
    setItems((prev) => [a, ...prev].slice(0, 80));
    // 重放的历史（连接/刷新时补发）：只进列表，不弹窗不出声
    if (a.backfill) return;
    // info（变盘时点）不打扰，只进列表
    if (a.level !== "info") {
      sound.play(a.level);
      toast(a.title, { description: a.text, duration: 6000 });
    }
    // 主力资金与变盘开仓弹模态框（后者是可执行的交易信号，优先级最高）
    if (a.type === "main_inflow" || a.type === "reversal") setPopup(a);
  };
  useAlertStream(onAlert);

  // 兜底去重：无论如何渲染层都不出现同一 id 的两行
  const rows = useMemo(() => {
    const s = new Set<any>();
    return items.filter((a) => a.id != null && !s.has(a.id) && (s.add(a.id), true));
  }, [items]);

  return (
    <>
      <Frame spacing="sm">
        <FramePanel dense>
          <FrameHeader className="flex-row items-center justify-between">
            <FrameTitle className="flex items-center gap-1.5 text-xs">
              <BellRing className="size-3.5 text-warning" /> 实时告警
            </FrameTitle>
            <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Volume2 className="size-3" /> 声音已开启
            </span>
          </FrameHeader>
          <div className="max-h-[260px] divide-y divide-border/60 overflow-auto">
            {rows.length === 0 && <div className="py-5 text-center text-xs text-muted-foreground">暂无告警</div>}
            {rows.map((a) => (
              <div key={a.id} className="flex items-start gap-2 px-3 py-1.5">
                <span className="mt-0.5">{a.level === "critical" ? <AlertTriangle className="size-3 text-destructive" /> : null}</span>
                {/* 整行悬浮：代码 + 完整标题 + 完整正文（列表里标题 truncate、正文 line-clamp-2 会截断） */}
                <HoverTip label={`${a.etf_code ? a.etf_code + " " : ""}${a.title}\n${a.text}`} className="min-w-[240px]">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className={`truncate text-xs font-medium ${clsUpDown(a.dir === "bull" ? 1 : a.dir === "bear" ? -1 : 0)}`}>{a.title}</span>
                      <Badge variant="outline" size="xs">{TYPE_LABEL[a.type] ?? a.type}</Badge>
                    </div>
                    <div className="line-clamp-2 text-[10px] leading-snug text-muted-foreground">{a.text}</div>
                  </div>
                </HoverTip>
                <span className="text-[10px] text-muted-foreground tnum">{a.ts?.slice(11)}</span>
              </div>
            ))}
          </div>
        </FramePanel>
      </Frame>

      <Dialog open={!!popup} onClose={() => setPopup(null)} className="w-[min(90vw,460px)]"
        title={<span className="flex items-center gap-2"><AlertTriangle className="size-4 text-destructive" />重要提醒</span>}>
        {popup && (
          <div className="flex flex-col gap-2">
            <div className="text-base font-semibold">{popup.title}</div>
            <div className="text-sm text-muted-foreground">{popup.text}</div>
            <div className="flex items-center gap-2 text-xs">
              <Badge variant={popup.dir === "bull" ? "destructive-light" : popup.dir === "bear" ? "success-light" : "secondary"} size="sm">
                {popup.dir === "bull" ? "看多" : popup.dir === "bear" ? "看空" : "观望"}
              </Badge>
              <span className="text-muted-foreground tnum">
                {popup.etf_code && <span className="mr-1 font-medium text-foreground">{popup.etf_code}</span>}
                {popup.etf_name} · {popup.ts?.slice(11)}
              </span>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
