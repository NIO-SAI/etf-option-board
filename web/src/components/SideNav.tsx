import { CandlestickChart, Coins, Flame, Gauge, Landmark, PanelLeftClose, Pin, Waves, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { navigate, type PageKey } from "@/lib/route";
import { NAV, navOf, navTarget, type NavIcon } from "@/lib/nav";

const ICONS: Record<NavIcon, typeof CandlestickChart> = {
  options: CandlestickChart,
  board: Coins,
  flow: Waves,
  wangwang: Landmark,
  arisk: Gauge,
  limitup: Flame,
};

/**
 * 左侧主导航。
 *
 * 两种形态共用同一份内容：
 * - `inline`：常驻侧栏（占布局、自身 sticky 满屏高），桌面端收起后完全不占位；
 * - `drawer`：收起后点左上角按钮弹的浮层抽屉（带遮罩，选完自动关，不会让内容区重排）。
 *
 * 侧栏只有一级项；「资金分时」内部的四个子页由页内 BoardSubNav 切换（见 lib/nav.ts）。
 */
export function SideNav({
  page,
  mode,
  onNavigate,
  onClose,
  onPin,
}: {
  page: PageKey;
  mode: "inline" | "drawer";
  /** 选中后回调（抽屉形态用来关闭浮层） */
  onNavigate?: () => void;
  onClose?: () => void;
  /** 抽屉底部「固定展开」 */
  onPin?: () => void;
}) {
  const active = navOf(page);
  const drawer = mode === "drawer";
  return (
    <nav
      aria-label="主导航"
      className={cn(
        "flex flex-col border-r border-border bg-card",
        drawer
          ? "h-full w-[224px] shadow-2xl"
          : "sticky top-0 hidden h-screen w-[200px] shrink-0 md:flex",
      )}
    >
      <div className="flex items-center justify-between gap-2 px-3 py-3">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground">导航</span>
        {drawer ? (
          <Button
            variant="ghost"
            size="icon"
            title="关闭导航"
            aria-label="关闭导航"
            onClick={onClose}
          >
            <X aria-hidden />
          </Button>
        ) : null}
      </div>

      <div className="flex flex-col gap-0.5 px-2">
        {NAV.map((item) => {
          const Icon = ICONS[item.icon];
          const on = item.key === active.key;
          const target = navTarget(item);
          return (
            <button
              key={item.key}
              type="button"
              title={item.title}
              aria-current={on ? "page" : undefined}
              onClick={() => {
                navigate(target);
                onNavigate?.();
              }}
              className={cn(
                "group flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] font-medium transition-colors",
                "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                on
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden />
              <span className="truncate">{item.label}</span>
              {on ? <span className="ml-auto size-1.5 shrink-0 rounded-full bg-primary" aria-hidden /> : null}
            </button>
          );
        })}
      </div>

      <div className="mt-auto border-t border-border/60 p-2">
        {drawer ? (
          <Button variant="ghost" size="sm" className="w-full justify-start gap-2" onClick={onPin}>
            <Pin aria-hidden />
            固定展开
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start gap-2 text-muted-foreground"
            title="收起左侧导航"
            onClick={onClose}
          >
            <PanelLeftClose aria-hidden />
            收起导航
          </Button>
        )}
      </div>
    </nav>
  );
}
