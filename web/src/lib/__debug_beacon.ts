// [DEBUG-7f3a] 临时客户端诊断信标（持续遥测版）—— 定位「左侧大盘指数缺少上证指数」用，定位后整文件删除。
// 原理：页面加载后周期性把客户端真实 DOM 状态编码进一次 GET 的 query，uvicorn 访问日志原样记录。
const TAG = "dbg7f3a";

function rowDesc(r: HTMLElement, clip?: { top: number; bottom: number }) {
  const b = r.getBoundingClientRect();
  const cs = getComputedStyle(r);
  const name = r.querySelector("span.truncate") as HTMLElement | null;
  const ncs = name ? getComputedStyle(name) : null;
  const svg = r.querySelector("svg");
  const clipState = clip
    ? b.bottom <= clip.top || b.top >= clip.bottom
      ? "OUTSIDE_CLIP"
      : b.top < clip.top || b.bottom > clip.bottom
        ? "PARTIAL"
        : "INSIDE"
    : "-";
  return `${(r.textContent || "").slice(0, 4)}[y${Math.round(b.top)}-${Math.round(b.bottom)} h${Math.round(b.height)} kids${r.children.length} col${ncs?.color ?? "?"} svg${svg ? 1 : 0} ${cs.display}/${cs.visibility} ${clipState}]`;
}

function report(phase: string) {
  try {
    const c = document.querySelector("div.overflow-auto") as HTMLElement | null;
    if (!c) {
      void fetch(`/api/health?${TAG}=${encodeURIComponent(`${phase}|NO_BOX`)}`, { cache: "no-store" }).catch(() => {});
      return;
    }
    const cr = c.getBoundingClientRect();
    const kids = [...c.children] as HTMLElement[];
    const hdrIdx = kids.findIndex((k) => (k.textContent || "").startsWith("大盘指数"));
    const header = hdrIdx >= 0 ? kids[hdrIdx] : null;
    const etfRows = hdrIdx >= 1 ? kids.slice(1, hdrIdx) : [];
    const idxRows = hdrIdx >= 0 ? kids.slice(hdrIdx + 1) : [];
    const lines = [
      `${phase}`,
      `vp=${window.innerWidth}x${window.innerHeight}@${window.devicePixelRatio}`,
      `pageY=${Math.round(window.scrollY)}`,
      `box=${c.clientHeight}/${c.scrollHeight}@${Math.round(c.scrollTop)} vis${Math.round(cr.top)}-${Math.round(cr.bottom)}`,
      `hdr=${header ? rowDesc(header, { top: cr.top, bottom: cr.bottom }) : "NO_HEADER"}`,
      `etfs=${etfRows.length} ${etfRows.slice(0, 1).map((r) => rowDesc(r)).join("")} ${etfRows.slice(-1).map((r) => rowDesc(r)).join("")}`,
      `idx=${idxRows.map((r) => rowDesc(r, { top: cr.top, bottom: cr.bottom })).join(" ; ")}`,
    ];
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
