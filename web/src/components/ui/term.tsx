import { useState } from "react";
import { cn } from "@/lib/utils";

/**
 * 名词解释词典。卡片字段用 `<Tip label="盈亏比"/>`（自动查词），
 * 自由文本（如后端给的推荐理由）用 `<AutoTip text="..."/>` 自动把命中的词包成 Tip。
 * 一处定义，口径不会分叉。
 */
export const GLOSSARY: Record<string, string> = {
  "突破入场": "标的突破近 15 分钟高点时买入；合约价按 Δ 折算到该点位。",
  "回踩买点": "不追突破，等价格回踩到这里再买：成本更低，但可能等不到。",
  "止损": "结构止损（最近支撑下方 / 最近压力上方）；合约另有 −30% 硬止损兜底。",
  "止盈": "入场方向上最近的一道结构位（压力/支撑）；太近（<1.2 倍止损距离）会自动跳到下一档。",
  "ATR": "平均真实波幅：日内正常波动幅度，用来给止损/目标兜底。",
  "日内区间": "当日已经出现的最低价 ~ 最高价。",
  "盈亏比": "(止盈价 − 入场价) ÷ (入场价 − 止损价)，只看价格结构，不含胜率。",
  "现价": "合约最新成交价。",
  "入场": "触发买点：标的走到该点位时的合约价（按 Δ 折算）。",
  "买入": "按计划成交的合约价（= 入场价）。",
  "触发买入": "标的突破/跌破某点位后才买，这一列是该点位对应的合约价。",
  "止盈价": "计划卖出的合约价。",
  "止损价": "计划认亏的合约价。",
  "权利金": "买入期权付出的现金 = 合约价 × 合约乘数。",
  "期望收益": "按 |Δ| 当胜率的加权结果：p×赚 −(1−p)×亏，再除以权利金成本。正数才有正期望。",
  "期望": "按 |Δ| 当胜率估算的单张期望收益 ÷ 权利金成本。",
  "Delta": "标的每变动 1 元，合约价变动多少；也可粗看为到期时价内的概率。",
  "Gamma": "Delta 的变化速度：越大越「涨得快、跌得也快」，平值附近最大。",
  "Vega": "隐波每变动 1 个百分点，合约价变动多少。",
  "Theta": "每过一天因时间价值衰减而损失的权利金（买方为负）。",
  "IV": "隐含波动率：市场对未来波动的定价，越高说明期权越「贵」。",
  "溢价": "合约价相对平值理论价的偏离，越高说明越贵。",
  "打和点": "到期时刚好不赚不亏的标的价（认购=行权价+权利金，认沽=行权价−权利金）。",
  "成交额": "当日累计成交金额；越大说明越容易进出。",
  "流动性": "能不能顺利买卖：成交额大、买卖价差窄 = 流动性好。",
  "买卖价差": "最优买价与最优卖价之差占合约价的比例；越大滑点越贵，>5% 直接不建议。",
  "主力净流入": "大单净买入金额（买 − 卖）；正数表示主力净买。",
  "支撑": "价格下方承接的位置：跌到这里容易止跌。",
  "压力": "价格上方的卖压关口：涨到这里容易受阻。",
  "评分": "综合打分（−100~100）：正数偏多、负数偏空，±15 以内算观望。",
  "置信度": "打分与因子的一致性，越高越值得按这个方向做。",
  "仓位": "按总资金与单笔风险%算出的建议张数。",
  "杠杆": "合约对标的的价格弹性 = Δ × 标的价 ÷ 合约价。",
  "平值": "行权价 ≈ 标的价格（价内程度 |m|<1.5%）：Gamma 最大、Theta 也最贵。",
  "实值": "已经价内（认购行权价 < 标的价）：Delta 大、时间价值少。",
  "虚值": "还没价内：权利金便宜但 Delta 小，到期归零概率高。",
  "胜率": "这里用 |Δ| 粗代：Delta 越大，越接近「到期价内」。",
  "弹性": "标的小动一下，合约价被 Δ/杠杆放大多少。",
  "离到期": "剩余自然日；越接近到期 Theta 衰减越快。",
  "时间价值": "权利金中超出内在价值的部分，随时间流逝而衰减。",
  "内在价值": "立即行权能拿到的价值：认购 max(标的−行权价, 0)，认沽反之。",
  "PCR": "认沽/认购成交量比：>1 偏空、<1 偏多（情绪指标）。",
  "ATM IV": "平值期权（最靠近现价那一档）的隐含波动率：市场对未来一段波动的定价，也是所有合约 IV 的锚。",
  "偏斜": "虚值认沽与虚值认购的隐波差：负值说明市场更怕跌。",
  "IV 分位": "当前隐波在过去 20/60 日中的位置，越高越贵。",
  "量能": "成交量相对均量的倍数。",
  "背离": "价格与资金/指标方向相反，常预示动能衰竭。",
  "变盘": "关键时点附近的方向选择，配合打分给出开仓提示。",
};

/** 自由文本里的关键词（长的在前，避免「期望收益」被「期望」截断）。 */
const AUTO_TERMS = [
  "买卖价差", "期望收益", "主力净流入", "流动性", "成交额", "权利金", "盈亏比",
  "打和点", "平值", "实值", "虚值", "胜率", "弹性", "离到期", "时间价值", "内在价值",
  "Gamma", "Delta", "Theta", "Vega", "IV", "溢价",
];
const AUTO_RE = new RegExp(AUTO_TERMS.map((t) => `(${t})`).join("|"), "g");

/** 带虚线下划线 + 悬浮解释的名词。词典里没有的词原样渲染。 */
export function Tip({ label, className, tip }: { label: string; className?: string; tip?: string }) {
  const text = tip ?? GLOSSARY[label];
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  if (!text) return <span className={className}>{label}</span>;
  return (
    <span
      className={cn("cursor-help border-b border-dotted border-muted-foreground/40", className)}
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setPos({ x: r.left + r.width / 2, y: r.bottom });
      }}
      onMouseLeave={() => setPos(null)}
      onFocus={() => setPos(null)}
      tabIndex={0}
    >
      {label}
      {pos && (
        <span
          role="tooltip"
          className="pointer-events-none fixed z-50 w-60 whitespace-normal rounded-md border border-border bg-card px-2 py-1.5 text-left text-[11px] font-normal leading-snug text-foreground shadow-lg"
          style={{ left: Math.max(120, pos.x), top: pos.y + 6, transform: "translateX(-50%)" }}
        >
          <b className="mb-0.5 block text-[10px] text-muted-foreground">{label}</b>
          {text}
        </span>
      )}
    </span>
  );
}

/** 把一段自由文本里命中的名词自动包成 Tip（后端理由、指标串都用它）。 */
export function AutoTip({ text, className }: { text: string; className?: string }) {
  if (!text) return null;
  const out: React.ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(AUTO_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const word = m[0];
    out.push(<Tip key={`t${key++}`} label={word} tip={GLOSSARY[word]} />);
    last = idx + word.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <span className={className}>{out}</span>;
}
