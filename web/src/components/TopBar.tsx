import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/ui/button";
import { clsUpDown, pct } from "@/lib/format";
import { sound } from "@/lib/sound";
import { Activity, Bell, BellOff, RefreshCw, Settings, ShieldCheck } from "lucide-react";
import { useState, type ReactNode } from "react";

export function TopBar({
  external, national, health, clock, onRefresh, onOpenSettings, nav,
}: {
  external: any[];
  national: any;
  health: any;
  clock: string;
  onRefresh: () => void;
  onOpenSettings: () => void;
  /** 左上角页面切换标签（由外壳传入，页面本身不关心路由） */
  nav?: ReactNode;
}) {
  const [muted, setMuted] = useState(!sound.enabled);
  const nt = national?.score ?? 0;
  // 状态徽标一律 <tone>-light（禁止 solid 填充）；评分 < 40 视为中性 → outline
  const ntVariant = nt >= 65 ? "success-light" : nt >= 40 ? "warning-light" : "outline";
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-card/85 backdrop-blur">
      <div className="flex items-center gap-3 px-3 py-1.5">
        <div className="flex items-center gap-2 pr-2">
          <Activity className="size-4 shrink-0 text-primary" aria-hidden />
          <span className="hidden text-sm font-semibold whitespace-nowrap sm:inline">ETF 期权日内决策看板</span>
        </div>
        {nav}
        <div className="flex-1" />
        <div className="hidden items-center gap-2 xl:flex">
          {(external ?? []).slice(0, 5).map((e) => (
            <div key={e.key} className="flex items-baseline gap-1 whitespace-nowrap">
              <span className="text-[11px] text-muted-foreground">{e.name_cn}</span>
              <span className={`text-[11px] tnum ${clsUpDown(e.pct)}`}>{pct(e.pct, 2)}</span>
            </div>
          ))}
        </div>
        <Badge
          variant={ntVariant as any}
          className="whitespace-nowrap"
          title={`国家队护盘评分 ${nt}（放量标的数 ${national?.surge_count ?? 0}，≥40 提示护盘，≥65 强护盘）`}
        >
          <ShieldCheck aria-hidden /> 国家队 {nt}
        </Badge>
        <span className="text-xs text-muted-foreground tnum whitespace-nowrap">{clock}</span>
        {health?.kronos_available ? (
          <Badge variant="info-light" title="Kronos 量化预测服务在线">Kronos</Badge>
        ) : (
          <Badge variant="outline" title="Kronos 量化预测服务离线，预测区不可用">Kronos 离线</Badge>
        )}
        <Button variant="ghost" size="icon" title="刷新数据" aria-label="刷新数据" onClick={onRefresh}>
          <RefreshCw aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title="设置：总资金与单笔风险%"
          aria-label="设置"
          onClick={onOpenSettings}
        >
          <Settings aria-hidden />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title={muted ? "开启告警声音" : "关闭告警声音"}
          aria-label={muted ? "开启告警声音" : "关闭告警声音"}
          aria-pressed={!muted}
          onClick={() => {
            sound.enabled = muted;
            setMuted(!muted);
            if (muted) sound.ding();
          }}
        >
          {muted ? <BellOff aria-hidden /> : <Bell aria-hidden />}
        </Button>
      </div>
    </header>
  );
}
