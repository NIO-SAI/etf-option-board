import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Frame, FrameHeader, FramePanel, FrameTitle } from "@/components/reui/frame";
import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, EmptyState, HoverTip } from "@/components/ui/misc";
import { api } from "@/lib/api";
import { useAlertStream } from "@/lib/usePolling";
import { notifyPermission, requestNotifyPermission, showNotification, autoPromptPermissionOnce, reportNotifyState } from "@/lib/notify";
import { sound } from "@/lib/sound";
import { clsUpDown } from "@/lib/format";
import { AlertTriangle, BellRing, Volume2 } from "lucide-react";

const TYPE_LABEL: Record<string, string> = {
  price_spike: "价格异动", volume_surge: "量能放大", main_inflow: "主力资金",
  divergence: "MACD背离", key_time: "变盘时点", national_team: "国家队护盘",
  opt_spike: "合约异动", reversal: "变盘开仓",
};

export function AlertCenter({ onSelect }: { onSelect?: (code: string) => void }) {
  const [items, setItems] = useState<any[]>([]);
  const [popup, setPopup] = useState<any>(null);
  const [perm, setPerm] = useState(notifyPermission());
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

  // 通知授权：任意首次点击自动弹权限框（免去找按钮）；并上报诊断信标。
  useEffect(() => {
    reportNotifyState("mount");
    autoPromptPermissionOnce();
    const t = setInterval(() => {
      const p = notifyPermission();
      setPerm((prev) => (prev === p ? prev : p));
    }, 3000);
    return () => clearInterval(t);
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
      // 优先 Chrome 浏览器通知；不可用/未授权时降级为页面内 toast
      const shown = showNotification(a);
      if (!shown) toast(a.title, { description: a.text, duration: 6000 });
    }
    // 主力资金与变盘开仓弹模态框（后者是可执行的交易信号，优先级最高）
    if (a.type === "main_inflow" || a.type === "reversal") setPopup(a);
  };
  useAlertStream(onAlert);

  const onEnable = async () => {
    const p = await requestNotifyPermission();
    setPerm(p);
    reportNotifyState("enable");
    if (p === "granted") toast("浏览器通知已开启", { description: "盘中告警将以 Chrome 系统通知弹出。" });
    else if (p === "denied") toast("浏览器通知被拒绝", { description: "请在地址栏左侧站点设置里重新允许通知。" });
  };

  // 切到告警对应标的：关闭弹窗；窄屏（单列）时右栏在下方，顺带滚到行情图
  const jump = (code?: string) => {
    if (!code || !onSelect) return;
    onSelect(code);
    setPopup(null);
    if (window.matchMedia("(max-width: 1023px)").matches) {
      requestAnimationFrame(() => document.getElementById("main-chart")?.scrollIntoView({ behavior: "smooth", block: "center" }));
    }
  };

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
            <span className="flex items-center gap-1.5">
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <Volume2 className="size-3" /> 声音已开启
              </span>
              {perm === "granted" ? (
                <Badge variant="success-light" title="告警将以 Chrome 系统通知弹出">浏览器通知</Badge>
              ) : perm === "default" ? (
                <Button variant="outline" size="xs" onClick={onEnable}>开启浏览器通知</Button>
              ) : perm === "denied" ? (
                <Badge variant="warning-light" title="浏览器通知被拒绝，请在地址栏站点设置里重新允许">通知已拒绝</Badge>
              ) : (
                <Badge variant="outline" title="当前为非 HTTPS 地址，浏览器通知不可用；跨设备请用 HTTPS 入口">通知不可用</Badge>
              )}
            </span>
          </FrameHeader>
          {/* 列表自身限高滚动是刻意的：本卡位于随页面滚动的右栏，没有定高父链可依赖 */}
          <div className="max-h-[260px] min-h-0 divide-y divide-border/60 overflow-auto" role="status" aria-live="polite">
            {rows.length === 0 && <EmptyState title="暂无告警" hint="量能、资金异动与变盘信号会在此推送" />}
            {rows.map((a) => (
              // 点击整行切到该告警对应的标的（无 etf_code 的全局告警不可点）
              <button
                key={a.id}
                type="button"
                disabled={!a.etf_code}
                onClick={() => jump(a.etf_code)}
                title={a.etf_code ? `点击切换到 ${a.etf_name ?? a.etf_code}（${a.etf_code}）` : undefined}
                className="flex w-full cursor-pointer items-start gap-2 px-3 py-1.5 text-left transition-colors hover:bg-muted/40 disabled:cursor-default disabled:hover:bg-transparent"
              >
                <span className="mt-0.5">{a.level === "critical" ? <AlertTriangle className="size-3 text-destructive" /> : null}</span>
                {/* 整行悬浮：代码 + 完整标题 + 完整正文（列表里标题 truncate、正文 line-clamp-2 会截断） */}
                <HoverTip label={`${a.etf_code ? a.etf_code + " " : ""}${a.title}\n${a.text}`} className="min-w-[240px]">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className={`truncate text-xs font-medium ${clsUpDown(a.dir === "bull" ? 1 : a.dir === "bear" ? -1 : 0)}`}>{a.title}</span>
                      <Badge variant="outline" className="shrink-0">{TYPE_LABEL[a.type] ?? a.type}</Badge>
                    </div>
                    <div className="line-clamp-2 text-[10px] leading-snug text-muted-foreground">{a.text}</div>
                  </div>
                </HoverTip>
                <span className="text-[10px] text-muted-foreground tnum">{a.ts?.slice(11)}</span>
              </button>
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
              <Badge variant={popup.dir === "bull" ? "destructive-light" : popup.dir === "bear" ? "success-light" : "outline"}>
                {popup.dir === "bull" ? "看多" : popup.dir === "bear" ? "看空" : "观望"}
              </Badge>
              <span className="text-muted-foreground tnum">
                {popup.etf_code && <span className="mr-1 font-medium text-foreground">{popup.etf_code}</span>}
                {popup.etf_name} · {popup.ts?.slice(11)}
              </span>
            </div>
            {popup.etf_code && (
              <div className="flex justify-end">
                <Button size="xs" onClick={() => jump(popup.etf_code)}>查看该标的</Button>
              </div>
            )}
          </div>
        )}
      </Dialog>
    </>
  );
}
