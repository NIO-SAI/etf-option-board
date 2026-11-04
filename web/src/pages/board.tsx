import type { ReactNode } from "react";
import { Activity, Wallet } from "lucide-react";
import { Frame, FrameHeader, FramePanel, FrameTitle } from "@/components/reui/frame";
import { Badge } from "@/components/reui/badge";
import { EmptyState } from "@/components/ui/misc";

/** 板块资金页面的占位外壳：正式内容由工单 02–07 逐页接入，先保证导航可达、不空屏。 */
function BoardPlaceholder({
  title, subtitle, icon,
}: {
  title: string;
  subtitle: string;
  icon: ReactNode;
}) {
  return (
    <main className="grid gap-3 p-3">
      <Frame spacing="sm">
        <FramePanel dense>
          <FrameHeader className="flex-row items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground" aria-hidden>{icon}</span>
              <FrameTitle className="text-sm">{title}</FrameTitle>
            </div>
            <Badge variant="outline" title="本页正在按工单分批接入数据与图表">建设中</Badge>
          </FrameHeader>
          <div className="flex flex-col gap-3 p-6">
            <EmptyState title={subtitle} hint="数据接口与图表会在后续工单接入，此处先保留页面骨架。" />
          </div>
        </FramePanel>
      </Frame>
    </main>
  );
}

export function EtfFlowPage() {
  return (
    <BoardPlaceholder
      title="ETF资金流"
      subtitle="ETF 资金流排行、分时与 4 维资金拆解"
      icon={<Wallet className="size-4" />}
    />
  );
}

export function EmFlowPage() {
  return (
    <BoardPlaceholder
      title="东财资金分时"
      subtitle="行业 / 指数 / 全 A 的机构、大单、中户、散户 4 维资金分时"
      icon={<Activity className="size-4" />}
    />
  );
}
