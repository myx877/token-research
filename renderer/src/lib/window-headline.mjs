// 进度条"主数字"的决议点(纯函数,可单测)。
//
// 用户口径:进度条是给 token 用的 —— 当**分母本身就是 token** 时,条上该先说 token 数,
// 百分比退成次要徽章。
//
// 但**只有 token 分母才升 token 数**,另外两种分母必须保持百分比:
//   · 分母 = Token 预算  ⇒ 百分比本来就是 token 比例 ⇒ 主数字 = token 数
//   · 分母 = 金额预算    ⇒ 百分比是"钱花了多少"的比例 ⇒ 升 token 会把语义写错
//                          (「预算花完 25%」被写成「25万 Token」)
//   · 分母 = 平台额度    ⇒ 额度单位不是 token(是平台自己的计数单位)⇒ 保持百分比
//   · 没有分母          ⇒ 一个数字都不显示,只有「无分母」(红线第 9 条)
//
// 分母判定不在本模块:它来自 lib/window-percent.mjs 的 resolveWindowPercent(quota > budget > null),
// 本模块只回答"给定分母,条上先说哪个数"。

export const MODE_TOKENS = 'tokens';
export const MODE_PERCENT = 'percent';
export const MODE_NONE = 'none';

// 百分比展示:保留 1 位小数,整数不拖 .0(50% 而不是 50.0%)。
// 空值一律返回空串 —— **不能** 直接 Number():`Number(null) === 0` 会把"没有百分比"
// 画成"0%"(红线第 9 条点名的那个坑)。
export function percentText(percent) {
  if (percent === null || percent === undefined || percent === '') return '';
  const value = Number(percent);
  if (!Number.isFinite(value)) return '';
  return (Math.round(value * 10) / 10) + '%';
}

// win        = usageWindows() 的窗口行(需要 total / budgetBasis)
// resolved   = resolveWindowPercent() 的结果 { percent, basis }
// formatter  = token 格式化器(由调用方注入,卡片与小窗共用同一份数字格式)
export function windowHeadline(win, resolved, formatter) {
  const fmt = typeof formatter === 'function' ? formatter : (v) => String(v);
  const percent = resolved ? resolved.percent : null;
  const basis = resolved ? resolved.basis : null;
  if (percent === null || percent === undefined) {
    return { mode: MODE_NONE, primary: null, secondary: null, basis: null, over: false };
  }
  // 超额只看**真实百分比 >100**(红线第 11 条:超额如实显示)。
  // 不能拿封顶后的条宽判断 —— 条宽封顶到 100 之后,`fill >= 100` 会把"刚好用满预算"也判成超额标红。
  const over = percent > 100;
  const tokenDenominator = basis === 'budget' && !!(win && win.budgetBasis === 'tokens');
  if (!tokenDenominator) {
    return { mode: MODE_PERCENT, primary: percentText(percent), secondary: null, basis: basis, over: over };
  }
  return {
    mode: MODE_TOKENS,
    primary: fmt(Number(win && win.total) || 0) + ' Token',
    secondary: percentText(percent),
    basis: basis,
    over: over
  };
}

// 预算徽标的文案:分母可能是**金额**(¥/$),也可能是 **Token 个数** ——
// 两者绝不能用同一个格式化器。真实缺陷(审查发现):token 预算被渲染成「预算 ¥500000.00」,
// 把 50 万 token 装成了 50 万元,而且悬停说明与主数字都按 token 处理,只有这一处口径写错。
// amount<=0 返回 null(没设预算就不显示徽标)。
export function windowBudgetText(win, formatTokenCount, formatCurrencyAmount) {
  const amount = Number(win && win.budget);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (win && win.budgetBasis === 'tokens') {
    const fmt = typeof formatTokenCount === 'function' ? formatTokenCount : (v) => String(v);
    return '预算 ' + fmt(amount) + ' Token';
  }
  const money = typeof formatCurrencyAmount === 'function' ? formatCurrencyAmount : () => String(amount);
  return '预算 ' + money(win && win.currency, amount.toFixed(2));
}
