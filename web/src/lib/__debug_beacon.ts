// [DEBUG-7f3a] 临时客户端诊断信标（持续遥测版）—— 定位「左侧大盘指数缺少上证指数」用，定位后整文件删除。
// 原理：页面加载后周期性把客户端真实 DOM 状态编码进一次 GET 的 query，uvicorn 访问日志原样记录。
const TAG = "dbg7f3a";

function box(r: HTMLElement) {
  const b = r.getBoundingClientRect();
  return `y${Math.round(b.top)}-${Math.round(b.bottom)} h${Math.round(b.height)}`;
}

function clipState(r: HTMLElement, clip?: { top: number; bottom: number }) {
  if (!clip) return "-";
  const b = r.getBoundingClientRect();
  if (b.bottom <= clip.top || b.top >= clip.bottom) return "OUTSIDE_CLIP";
  if (b.top < clip.top || b.bottom > clip.bottom) return "PARTIAL";
  return "INSIDE";
}

function rowDesc(r: HTMLElement, clip?: { top: number; bottom: number }) {
  const cs = getComputedStyle(r);
  const name = r.querySelector("span.truncate") as HTMLElement | null;
  const ncs = name ? getComputedStyle(name) : null;
  const svg = r.querySelector("svg");
  return `${(r.textContent || "").slice(0, 4)}[${box(r)} kids${r.children.length} col${ncs?.color ?? "?"} svg${svg ? 1 : 0} ${cs.display}/${cs.visibility} ${clipState(r, clip)}]`;
}

function report(phase: string) {
  try {
    // 大盘指数分区标题（可能在滚动容器内，也可能是固定底栏）
    const hdr = [...document.querySelectorAll("div")].find(
      (d) => (d.textContent || "").trim().startsWith("大盘指数（"),
    ) as HTMLElement | undefined;
    const scroller = document.querySelector("div.overflow-auto") as HTMLElement | null;
    const view = { top: 0, bottom: window.innerHeight };
    const lines = [
      phase,
      `vp=${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}`,
      `pageY=${Math.round(window.scrollY)}`,
      `scroller=${scroller ? `${scroller.clientHeight}/${scroller.scrollHeight}@${Math.round(scroller.scrollTop)} vis${Math.round(scroller.getBoundingClientRect().top)}-${Math.round(scroller.getBoundingClientRect().bottom)}` : "none"}`,
    ];
    if (!hdr) {
      lines.push("hdr=NOT_FOUND");
    } else {
      const footer = hdr.parentElement as HTMLElement;
      const fb = footer.getBoundingClientRect();
      const rows = [...footer.children]
        .filter((c) => c !== hdr)
        .flatMap((c) => [...(c as HTMLElement).children])
        .concat([...footer.children].filter((c) => c !== hdr && (c as HTMLElement).children.length === 0 ? false : true))
        .filter((c) => (c as HTMLElement).tagName === "DIV" && (c.textContent || "").length > 4);
      lines.push(
        `footer=${box(footer)} bottomGapToScreen=${Math.round(window.innerHeight - fb.bottom)}`,
        `hdr=${rowDesc(hdr, view)}`,
        `idx=${rows.map((r) => rowDesc(r as HTMLElement, view)).join(" ; ")}`,
      );
    }
    void fetch(`/api/health?${TAG}=${encodeURIComponent(lines.join(" | "))}`, { cache: "no-store" }).catch(() => {});
  } catch {
    /* 诊断失败不影响主流程 */
  }
}

export function debugBeacon() {
  report("t0");
  setTimeout(() => report("t3s"), 3000);
  setTimeout(() => report("t8s"), 8000);
  setInterval(() => report("tick"), 20000);
}
