import { Badge } from "@/components/reui/badge";
import { afterPreOpen, todayStr } from "@/lib/format";

/** 所选日期是否就是库里最新交易日（今天的盘中数据也算实时）。 */
export function isLiveDay(date?: string | null, latest?: string | null): boolean {
  if (!date) return false;
  if (!latest) return true;
  if (date === latest) return true;
  // 09:15 之后看「今天」、而库里最新还停在昨天：当天盘前，仍算实时
  return date === todayStr() && afterPreOpen();
}

/**
 * 「实时 / 历史」标签：四个资金页统一口径。
 * 盘中看今天 → 实时；翻到别的交易日 → 历史。没有日期（还没取到数据）时不显示。
 */
export function DayTag({ date, latest }: { date?: string | null; latest?: string | null }) {
  if (!date) return null;
  return isLiveDay(date, latest)
    ? <Badge variant="success-light">实时</Badge>
    : <Badge variant="warning-light">历史</Badge>;
}
