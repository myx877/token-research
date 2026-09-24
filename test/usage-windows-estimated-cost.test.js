// 窗口行的订阅摊薄估算(estimatedCost)单测。
//
// 为什么单独测:codex/kimi 没有真实账单来源(COST_SOURCE 为 null),
// "每个条的右下角都能看到费用"只能靠订阅费摊薄。而摊薄的分母是**当月 token**,
// 一旦在窗口内自成一个月,分母就等于分子 —— 「今日」会直接显示整月月费。
// 这个错误在界面上看起来"很像对的",必须由断言挡住。
const test = require('node:test');
const assert = require('node:assert/strict');

const { usageWindows, estimateSubscriptionDaily } = require('../src/main/core/usage-buckets');

// 2026-09-24 12:00 北京(周四):本周 = 09-21 ~ 09-27,本月 = 09-01 ~ 09-30
const NOW = Date.UTC(2026, 8, 24, 4, 0, 0);

const usageDaily = {
  'codex:2026-09-24': { input: 60, cached: 30, output: 10, total: 100 },
  'codex:2026-09-22': { input: 200, cached: 80, output: 20, total: 300 },
  'codex:2026-09-01': { input: 400, cached: 150, output: 50, total: 600 }
};

function windowsByKey(usage, cost, options) {
  const result = usageWindows(usage, cost, options);
  const byKey = {};
  result.windows.forEach((w) => { byKey[w.key] = w; });
  return byKey;
}

test('金额预算:平台没有真实账单时用摊薄估算当分子(而不是永远 0%)', () => {
  // codex/kimi 是订阅制(COST_SOURCE=null),若分子只认真实账单,那条预算会永远显示 0%,
  // 而同一行的费用列却写着 ≈金额 —— 两个数字自相矛盾(审查发现)。
  const byKey = windowsByKey(usageDaily, {}, {
    provider: 'codex',
    now: NOW,
    monthlyFee: { codex: 140 },
    budgets: { codex: { day: 28, week: 280, month: 140 } }
  });
  assert.equal(byKey.day.budgetBasis, 'cost');
  assert.equal(byKey.day.percent, 50); // 估算 14 / 预算 28
  assert.equal(byKey.week.percent, 20); // 估算 56 / 预算 280
  assert.equal(byKey.month.percent, 100); // 估算 140 / 预算 140
});

test('估算是"整月分摊后按窗口取和":月=整月月费、周=本周那几天、日=今天那份', () => {
  const byKey = windowsByKey(usageDaily, {}, {
    provider: 'codex', now: NOW, monthlyFee: { codex: 140 }
  });
  // 整月 1000 token → 摊满 140
  assert.equal(byKey.month.estimatedCost, 140);
  // 本周 100 + 300 = 400 → 140 × 400/1000
  assert.equal(byKey.week.estimatedCost, 56);
  // 今日 100 → 140 × 100/1000
  assert.equal(byKey.day.estimatedCost, 14);
  // 真实账单一个子儿都没有(codex 的 COST_SOURCE 是 null),币种仍然要有
  assert.equal(byKey.day.cost, 0);
  assert.equal(byKey.day.currency, 'USD');
});

test('回归:分母必须是整月,不能是窗口自身', () => {
  // 错误实现的样子:只把窗口内的行喂给 estimateSubscriptionDaily。
  // 这里先把"错的算法"显式算一遍,证明它确实会把今日算成整月月费。
  const wrong = estimateSubscriptionDaily(
    [{ day: '2026-09-24', provider: 'codex', total: 100 }],
    { codex: 140 }
  );
  assert.equal(wrong['codex:2026-09-24'], 140, '前提:错误算法确实会给出整月月费');

  const byKey = windowsByKey(usageDaily, {}, {
    provider: 'codex', now: NOW, monthlyFee: { codex: 140 }
  });
  assert.notEqual(byKey.day.estimatedCost, 140, '今日估算绝不能等于整月月费');
  assert.equal(byKey.day.estimatedCost, 14);
});

test('没配月费的平台:estimatedCost 恒为 0(不凭空造估算)', () => {
  const byKey = windowsByKey(usageDaily, {}, { provider: 'codex', now: NOW, monthlyFee: {} });
  ['day', 'week', 'month'].forEach((key) => assert.equal(byKey[key].estimatedCost, 0, key));
  // 连 monthlyFee 都不传时同样不能炸
  const bare = windowsByKey(usageDaily, {}, { provider: 'codex', now: NOW });
  ['day', 'week', 'month'].forEach((key) => assert.equal(bare[key].estimatedCost, 0, key));
});

test('真实账单与估算并存时两者都保留,由渲染层决定显示哪个', () => {
  const byKey = windowsByKey(
    { 'deepseek:2026-09-24': { input: 1, cached: 0, output: 1, total: 2 } },
    { 'deepseek:2026-09-24': 3.5 },
    { provider: 'deepseek', now: NOW, monthlyFee: { deepseek: 140 } }
  );
  assert.equal(byKey.day.cost, 3.5);
  assert.ok(byKey.day.estimatedCost > 0, '估算照算,但渲染层会优先用真实账单');
});
