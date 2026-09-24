// 进度条右下角金额的展示口径唯一决议点(纯函数,可单测)。
//
// 三条规则,每条都来自一个真实坑:
//   1. 真实计费金额优先;没有真实金额(codex / kimi 的 COST_SOURCE 为 null)但有
//      订阅摊薄估算时,显示估算并加 ≈ 前缀 —— 不标来源的估算和真实账单看起来一模一样,
//      用户会拿它去对账。
//   2. 金额为 0 也要显示(¥0.00)。隐藏 0 会让用户以为"费用功能坏了"而不是"今天没花钱"。
//   3. 币种缺失时整个金额块不显示 —— 没有币种的数字(裸 "0.00")比不显示更糟。
import { formatCurrencyAmount } from '../fee-card-money.mjs';

export const NO_COST_TITLE = '这个平台没有可用金额来源';

export function windowCostDisplay(win) {
  const currency = win && win.currency;
  if (!currency) return null;
  const real = Number(win && win.cost);
  const estimate = Number(win && win.estimatedCost);
  const realValue = Number.isFinite(real) && real > 0 ? real : 0;
  const estimateValue = Number.isFinite(estimate) && estimate > 0 ? estimate : 0;
  const useEstimate = realValue <= 0 && estimateValue > 0;
  const amount = useEstimate ? estimateValue : realValue;
  return {
    amount: amount,
    estimated: useEstimate,
    text: (useEstimate ? '≈' : '') + formatCurrencyAmount(currency, amount.toFixed(2))
  };
}

// 悬停说明:把"这个数字是什么"直接写在 title 里,而不是让用户猜 ≈ 的含义。
export function windowCostTitle(win, display) {
  if (!display) return NO_COST_TITLE;
  if (display.estimated) {
    return '订阅费按当月 token 摊薄估算(设置 → 金额里填月费),≈ 表示不是平台真实账单';
  }
  return '平台真实计费金额';
}
