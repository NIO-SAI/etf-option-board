/**
 * A股风险监控（A-RISK/MONITOR）—— 外部项目 `~/workspace/arisk` 的嵌入页。
 *
 * 面板本体是一个 1966 行的单文件 HTML（Chart.js），上游每天 22:10 由
 * `update_arisk_data.py` 重算一次数据。这里**不重写它的图表**，而是用 iframe 原样承载：
 * 后端 `routers/arisk.py` 已把 HTML、日更 JSON、实时接口全部收成同源
 * （`/arisk/page`、`/arisk/data.json`、`/arisk/live/*`），所以跨设备 / HTTPS 入口都能用。
 *
 * 高度与资金流向页一致：视口减去顶栏与页脚（92px），面板自己内部滚动。
 */
export function AriskPage() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <iframe
        title="A股风险监控面板（A-RISK）"
        src="/arisk/page"
        className="h-[calc(100vh-92px)] min-h-[600px] w-full border-0 bg-background"
      />
    </div>
  );
}
