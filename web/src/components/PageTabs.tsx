import { PAGES, navigate, type PageKey } from "@/lib/route";
import { cn } from "@/lib/utils";

/** 左上角页面标签：一行扁平标签，选中态用背景+主色文字，窄屏可横向滚动。 */
export function PageTabs({ page, className }: { page: PageKey; className?: string }) {
  return (
    <nav
      aria-label="页面切换"
      className={cn(
        "flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-lg bg-muted/60 p-0.5",
        "[scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {PAGES.map((p) => {
        const active = p.key === page;
        return (
          <button
            key={p.key}
            type="button"
            onClick={() => navigate(p.key)}
            aria-current={active ? "page" : undefined}
            title={p.title}
            className={cn(
              "shrink-0 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {p.label}
          </button>
        );
      })}
    </nav>
  );
}
