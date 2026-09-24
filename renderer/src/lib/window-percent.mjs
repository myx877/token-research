// 进度条百分比的分母唯一决议点:平台真实额度 > 用户填的预算 > 没有(空轨道,绝不编数)。
//
// 为什么单独成模块:分母来源一旦分散在组件里,迟早会出现"这个平台按额度、那个平台按预算"
// 的静默不一致;而"百分比是怎么来的"直接决定用户信不信这张卡,必须可单测。
//
// 额度窗口 kind 与用量窗口的对应关系:
//   · week  ← 平台的 weekly 额度(codex / kimi 都有真实 limit/remaining,取自官方接口)
//   · day / month ← 平台没有对应粒度的额度接口 ⇒ 明确不映射(拿 5 小时额度冒充"今日"分母
//     会给出一个语义错误的百分比,比不显示更糟)。这两个窗口回落到用户预算。

// 用量窗口 → 平台额度 kind 的映射(不映射的一律 null)
export const QUOTA_KIND_BY_WINDOW = Object.freeze({
  day: null,
  week: 'weekly',
  month: null
});

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// 单个额度窗口的"已用百分比":1 - 剩余/上限。
// 数据不全(缺 limit/remaining、limit<=0)时返回 null —— 调用方据此退回预算或空轨道。
// 只夹下界:剩余为负(超额)时如实给出 >100,渲染方自己去夹进度条宽度。
// 把 >100 夹成 100 会让人看不出"超了多少",而"超没超、超多少"正是这个数字的用途。
export function quotaUsedPercent(win) {
  const limit = finitePositive(win && win.limit);
  if (limit === null) return null;
  // remaining 为 null/undefined/'' 是"剩余未知",**不是 0**:
  // Number(null) === 0 会把"不知道"画成"100% 已用 + 超额标红"(红线第 9 条点名的坑,审查发现)。
  if (!win || win.remaining === null || win.remaining === undefined || win.remaining === '') return null;
  const remaining = Number(win.remaining);
  if (!Number.isFinite(remaining)) return null;
  const used = 1 - remaining / limit;
  return Math.max(0, used * 100);
}

// 取指定 kind 的额度窗口:主额度(name 为空)优先,其次第一个带 name 的附加额度(如 Codex Spark)。
// 与 MiniView 的 windowByKind 同规则,避免两处对"哪个才是主额度"的理解分叉。
export function pickQuotaWindow(quota, kind) {
  if (!kind) return null;
  const windows = quota && Array.isArray(quota.windows) ? quota.windows : [];
  const matches = windows.filter((w) => w && w.kind === kind);
  return matches.find((w) => !w.name) || matches[0] || null;
}

// 预算是"没填"还是"填了 0"必须分清:Number(null)/Number('') 都是 0,
// 直接用会得到"预算 0% ⇒ 0% 已用"这种凭空造出来的百分比(实测踩过)。
export function parseBudgetPercent(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

// 决议:返回 { percent, basis },basis ∈ 'quota' | 'budget' | null。
//   percent 为 null 时渲染方必须画空轨道,不得显示任何数字。
export function resolveWindowPercent(input) {
  const opts = input || {};
  const quotaPercent = quotaUsedPercent(pickQuotaWindow(opts.quota, QUOTA_KIND_BY_WINDOW[opts.windowKey]));
  if (quotaPercent !== null) return { percent: quotaPercent, basis: 'quota' };

  const budgetPercent = parseBudgetPercent(opts.budgetPercent);
  if (budgetPercent !== null) return { percent: budgetPercent, basis: 'budget' };
  return { percent: null, basis: null };
}

// 命中 / 输入 / 输出 明细:窗口数据里的三个 token 桶(cached=命中缓存, input=新输入,
// output=输出)。formatter 由调用方注入(卡片与迷你窗共用同一份数字格式)。
export function breakdownParts(win, formatTokenCount) {
  const fmt = typeof formatTokenCount === 'function' ? formatTokenCount : (v) => String(v);
  const cached = Number(win && win.cached) || 0;
  const input = Number(win && win.input) || 0;
  const output = Number(win && win.output) || 0;
  return [
    { key: 'cached', label: '命中', value: cached, text: fmt(cached) },
    { key: 'input', label: '输入', value: input, text: fmt(input) },
    { key: 'output', label: '输出', value: output, text: fmt(output) }
  ];
}

export function breakdownText(win, formatTokenCount) {
  return breakdownParts(win, formatTokenCount)
    .map((part) => part.label + ' ' + part.text)
    .join(' · ');
}
