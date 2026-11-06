import { navigate, type PageKey } from "@/lib/route";
import { BOARD_PAGES, pageLabel } from "@/lib/nav";
import { cn } from "@/lib/utils";

/**
 * 「资金分时」页内的四个子标签。
 *
 * 侧栏只放一级项（期权看板 / 资金分时），子页切换留在这里（水平居中，顶栏不再放页面标签）：
 * 路由仍是原来的 `#/board/*`，所以旧书签、分享链接、浏览器前进后退全部照旧。
 */
export function BoardSubNav({ page }: { page: PageKey }) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-1 px-3 pt-3">
      <nav
        aria-label="资金分时子页"
        className="flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-lg bg-muted/50 p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {BOARD_PAGES.map((key) => {
          const active = key === page;
          return (
            <button
              key={key}
              type="button"
              onClick={() => navigate(key)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "shrink-0 cursor-pointer whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {pageLabel(key)}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
