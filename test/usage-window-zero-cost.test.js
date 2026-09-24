// 进度条右下角金额的展示口径单测。
//
// 三条规则各自对应一个真实坑:
//   隐藏 0          → 用户以为"费用功能坏了",而不是"今天没花钱"
//   估算不标来源    → 用户拿摊薄估算去对账,发现对不上
//   缺币种显示裸数字 → 一个没有单位的 "0.00" 比不显示更糟
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/src/lib/window-cost.mjs');

test('真实账单优先;金额为 0 也照实显示 ¥0.00 / $0.00', async () => {
  const m = await load();
  assert.equal(m.windowCostDisplay({ currency: 'CNY', cost: 8.12 }).text, '¥8.12');
  const zero = m.windowCostDisplay({ currency: 'USD', cost: 0 });
  assert.equal(zero.text, '$0.00');
  assert.equal(zero.amount, 0);
  assert.equal(zero.estimated, false);
  assert.match(m.windowCostTitle({}, zero), /真实计费/);
});

test('没有真实账单但有订阅摊薄估算:用估算并加 ≈,title 说明来源', async () => {
  const m = await load();
  const d = m.windowCostDisplay({ currency: 'USD', cost: 0, estimatedCost: 12.5 });
  assert.equal(d.text, '≈$12.50');
  assert.equal(d.estimated, true);
  assert.match(m.windowCostTitle({}, d), /估算/);
});

test('真实账单存在时绝不用估算覆盖它', async () => {
  const m = await load();
  const d = m.windowCostDisplay({ currency: 'CNY', cost: 1.5, estimatedCost: 140 });
  assert.equal(d.text, '¥1.50');
  assert.equal(d.estimated, false);
});

test('估算值小于等于 0 或不是数字时退回真实账单,不显示 ≈0', async () => {
  const m = await load();
  [0, -5, null, undefined, 'abc', NaN].forEach((estimate) => {
    const d = m.windowCostDisplay({ currency: 'USD', cost: 0, estimatedCost: estimate });
    assert.equal(d.text, '$0.00', 'estimatedCost=' + String(estimate));
    assert.equal(d.estimated, false);
  });
});

test('缺币种时整个金额块不显示(不出现没有单位的裸数字)', async () => {
  const m = await load();
  assert.equal(m.windowCostDisplay({ cost: 1.2 }), null);
  assert.equal(m.windowCostDisplay({ currency: null, cost: 0 }), null);
  assert.equal(m.windowCostDisplay({ currency: '', cost: 3 }), null);
  assert.equal(m.windowCostDisplay(null), null);
  assert.equal(m.windowCostTitle({}, null), m.NO_COST_TITLE);
  assert.match(m.NO_COST_TITLE, /金额来源/);
});
