import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { FrameHeader, FrameTitle } from "@/components/reui/frame";
import { cn } from "@/lib/utils";

/**
 * 可折叠卡片头：默认收起，只留一行标题 + 右侧动作。
 *
 * 决策页信息多，次要卡片（策略与仓位、合约买卖点、优选合约）默认收起，
 * 需要时再展开——比"全都摊开让用户自己滚"更好读。用 state 而不是 <details>，
 * 是为了让标题右侧还能放缓存角标/徽标这类交互元素。
 */
export function Fold({
  title, defaultOpen = false, right, children, hint,
}: {
  title: ReactNode;
  defaultOpen?: boolean;
  right?: ReactNode;
  children: ReactNode;
  hint?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <>
      <FrameHeader className="flex-row items-center justify-between">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          title={open ? "收起" : "展开"}
          className={cn(
            "flex min-w-0 items-center gap-1.5 rounded-md pr-1 text-left",
            "text-muted-foreground transition-colors hover:text-foreground",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        >
          <ChevronRight
            className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-90")}
            aria-hidden
          />
          <FrameTitle className="truncate text-xs">{title}</FrameTitle>
          {hint}
        </button>
        {right}
      </FrameHeader>
      {open && children}
    </>
  );
}
