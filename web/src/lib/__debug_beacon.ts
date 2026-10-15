// [DEBUG-7f3a] 临时客户端诊断信标 —— 定位「左侧大盘指数缺少上证指数」用，定位后整文件删除。
// 原理：页面加载后把客户端真实 DOM 状态编码进一次 GET 的 query，uvicorn 访问日志会原样记录。
export function debugBeacon() {
  try {
    const boxes = [...document.querySelectorAll("div.overflow-auto")];
    const c = boxes[0];
    const kids = c ? [...c.children] : [];
    const hdr = kids.findIndex((k) => (k.textContent || "").startsWith("大盘指数"));
    const rows = hdr >= 0
      ? kids.slice(hdr + 1).map((r) => {
          const cs = getComputedStyle(r);
          const b = r.getBoundingClientRect();
          return `${(r.textContent || "").slice(0, 4)}[h=${Math.round(b.height)},${cs.display},${cs.visibility},op=${cs.opacity}]`;
        })
      : ["NO_HEADER"];
    const sz = kids.find((k) => (k.textContent || "").startsWith("上证"));
    const szInfo = sz
      ? (() => {
          const cs = getComputedStyle(sz);
          const b = sz.getBoundingClientRect();
          return `h=${Math.round(b.height)},top=${Math.round(b.top)},${cs.display},${cs.visibility},op=${cs.opacity},pos=${cs.position}`;
        })()
      : "ABSENT_FROM_DOM";
    const info = [
      `b=${BUNDLE_ID_SAFE()}`,
      `ua=${(navigator.userAgent || "").slice(0, 70)}`,
      `vp=${window.innerWidth}x${window.innerHeight}`,
      `dpr=${window.devicePixelRatio}`,
      `box=${c ? `${c.clientHeight}/${c.scrollHeight}@${Math.round(c.scrollTop)}` : "none"}`,
      `sz=${szInfo}`,
      `rows=${rows.join(" ; ")}`,
    ].join(" | ");
    fetch(`/api/health?dbg=${encodeURIComponent(info)}`, { cache: "no-store" }).catch(() => {});
  } catch {
    /* 诊断失败不影响主流程 */
  }
}

function BUNDLE_ID_SAFE() {
  const s = document.querySelector('script[type="module"]') as HTMLScriptElement | null;
  const m = (s?.src || "").match(/index-([A-Za-z0-9_-]+)\.js/);
  return m ? m[1] : "dev";
}
