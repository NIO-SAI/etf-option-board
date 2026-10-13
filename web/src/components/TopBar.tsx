import { Badge } from "@/components/reui/badge";
import { Button } from "@/components/ui/button";
import { clsUpDown, nf, pct } from "@/lib/format";
import { sound } from "@/lib/sound";
import { Activity, Bell, BellOff, RefreshCw, ShieldCheck } from "lucide-react";
import { useState } from "react";

export function TopBar({
  indices, external, national, health, clock, onRefresh,
}: {
  indices: any[];
  external: any[];
  national: any;
  health: any;
  clock: string;
  onRefresh: () => void;
}) {
  const [muted, setMuted] = useState(!sound.enabled);
  const nt = national?.score ?? 0;
  const ntVariant = nt >= 65 ? "success" : nt >= 40 ? "warning" : "secondary";
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-card/85 backdrop-blur">
      <div className="flex items-center gap-3 px-3 py-1.5">
        <div className="flex items-center gap-2 pr-2">
          <Activity className="size-4 text-primary" />
          <span className="text-sm font-semibold whitespace-nowrap">ETF 期权日内决策看板</span>
        </div>
        <div className="flex flex-1 items-center gap-4 overflow-x-auto">
          {(indices ?? []).map((i) => (
            <div key={i.secid} className="flex items-baseline gap-1.5 whitespace-nowrap">
              <span className="text-xs text-muted-foreground">{i.short}</span>
              <span className="text-xs font-semibold tnum">{nf(i.price, 2)}</span>
              <span className={`text-xs tnum ${clsUpDown(i.pct)}`}>{pct(i.pct)}</span>
            </div>
          ))}
        </div>
        <div className="hidden items-center gap-2 xl:flex">
          {(external ?? []).slice(0, 5).map((e) => (
            <div key={e.key} className="flex items-baseline gap-1 whitespace-nowrap">
              <span className="text-[11px] text-muted-foreground">{e.name_cn}</span>
              <span className={`text-[11px] tnum ${clsUpDown(e.pct)}`}>{pct(e.pct, 2)}</span>
            </div>
          ))}
        </div>
        <Badge variant={ntVariant as any} size="sm" className="whitespace-nowrap">
          <ShieldCheck className="size-3" /> 国家队 {nt}
        </Badge>
        <span className="text-xs text-muted-foreground tnum whitespace-nowrap">{clock}</span>
        {health?.kronos_available ? (
          <Badge variant="info-light" size="xs">Kronos</Badge>
        ) : (
          <Badge variant="secondary" size="xs">Kronos离线</Badge>
        )}
        <Button variant="ghost" size="icon" title="刷新" onClick={onRefresh}>
          <RefreshCw className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          title={muted ? "开启声音" : "关闭声音"}
          onClick={() => {
            sound.enabled = muted;
            setMuted(!muted);
            if (muted) sound.ding();
          }}
        >
          {muted ? <BellOff className="size-3.5" /> : <Bell className="size-3.5" />}
        </Button>
      </div>
    </header>
  );
}
