// 进度条"主数字"决议点的单测。
//
// 用户口径:进度条是给 token 用的 —— 分母本身就是 token 时,条上先说 token 数。
// 但只有 **Token 预算** 这一种分母才升 token 数:金额预算量的是钱、平台额度量的不是 token,
// 把它们也升成 token 数会把语义写错(「预算花完 25%」变成「25万 Token」)。
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/src/lib/window-headline.mjs');

// 与渲染层 formatTokenCount 同量级的桩(避免测试耦合到实现细节)
const fmt = (n) => String(n);

test('分母是 Token 预算 ⇒ 主数字变成 token 数,百分比退成次要', async () => {
  const m = await load();
  const win = { total: 250000, budgetBasis: 'tokens', percent: 25 };
  const head = m.windowHeadline(win, { percent: 25, basis: 'budget' }, fmt);
  assert.equal(head.mode, m.MODE_TOKENS);
  assert.equal(head.primary, '250000 Token');
  assert.equal(head.secondary, '25%');
  assert.equal(head.basis, 'budget');
});

test('分母是金额预算 ⇒ 保持百分比(它量的是钱,不是 token)', async () => {
  const m = await load();
  const win = { total: 250000, budgetBasis: 'cost', percent: 25 };
  const head = m.windowHeadline(win, { percent: 25, basis: 'budget' }, fmt);
  assert.equal(head.mode, m.MODE_PERCENT);
  assert.equal(head.primary, '25%');
  assert.equal(head.secondary, null);
});

test('分母是平台额度 ⇒ 保持百分比(额度单位不是 token)', async () => {
  const m = await load();
  // 即使这个平台的 token 预算也填了,额度优先 —— 决议在 window-percent.mjs
  const win = { total: 777, budgetBasis: 'tokens', percent: 62.5 };
  const head = m.windowHeadline(win, { percent: 62.5, basis: 'quota' }, fmt);
  assert.equal(head.mode, m.MODE_PERCENT);
  assert.equal(head.primary, '62.5%');
});

test('没有分母 ⇒ 一个数字都不给(红线:没有分母就不要显示百分比)', async () => {
  const m = await load();
  const head = m.windowHeadline({ total: 123, budgetBasis: 'tokens' }, { percent: null, basis: null }, fmt);
  assert.equal(head.mode, m.MODE_NONE);
  assert.equal(head.primary, null, 'percent 为 null 时绝不能用 total 顶上来冒充');
  assert.equal(head.secondary, null);
});

test('Token 预算但值为 0 ⇒ 主数字仍是 0 Token,不是空(真填了 0 是一个明确的值)', async () => {
  const m = await load();
  const head = m.windowHeadline({ total: 0, budgetBasis: 'tokens' }, { percent: 0, basis: 'budget' }, fmt);
  assert.equal(head.mode, m.MODE_TOKENS);
  assert.equal(head.primary, '0 Token');
  assert.equal(head.secondary, '0%');
});

test('百分比展示:整数不拖 .0,其余保留 1 位', async () => {
  const m = await load();
  assert.equal(m.percentText(25), '25%');
  assert.equal(m.percentText(25.04), '25%');
  assert.equal(m.percentText(170.55), '170.6%');
  assert.equal(m.percentText(null), '');
  assert.equal(m.percentText('abc'), '');
});

test('没注入格式化器时不能炸(默认 String)', async () => {
  const m = await load();
  const head = m.windowHeadline({ total: 42, budgetBasis: 'tokens' }, { percent: 1, basis: 'budget' });
  assert.equal(head.primary, '42 Token');
});

test('超额只看真实百分比 >100:刚好 100% 不算超额(条宽封顶不等于超额)', async () => {
  const m = await load();
  const at100 = m.windowHeadline({ total: 10, budgetBasis: 'tokens' }, { percent: 100, basis: 'budget' }, fmt);
  assert.equal(at100.over, false, '刚好用满预算不该标红');
  const over = m.windowHeadline({ total: 10, budgetBasis: 'tokens' }, { percent: 170, basis: 'budget' }, fmt);
  assert.equal(over.over, true, '超了就要如实标红');
  // 没有分母时也不该有"超额"
  assert.equal(m.windowHeadline({ total: 10 }, { percent: null, basis: null }, fmt).over, false);
});

test('预算徽标:Token 预算写 token 数,金额预算才写货币(绝不混用格式化器)', async () => {
  const m = await load();
  const fmtt = (v) => String(v) + 'T';
  const fmtc = (cur, v) => cur + v;
  // 真实缺陷:token 预算被渲染成「预算 ¥500000.00」,把 50 万 token 装成 50 万元
  assert.equal(m.windowBudgetText({ budget: 500000, budgetBasis: 'tokens' }, fmtt, fmtc), '预算 500000T Token');
  assert.equal(m.windowBudgetText({ budget: 10, budgetBasis: 'cost', currency: 'CNY' }, fmtt, fmtc), '预算 CNY10.00');
  // 没设预算(0 / 缺失 / 非法)一律不给徽标,也不编一个 0
  assert.equal(m.windowBudgetText({ budget: 0, budgetBasis: 'cost' }, fmtt, fmtc), null);
  assert.equal(m.windowBudgetText({ budgetBasis: 'tokens' }, fmtt, fmtc), null);
  assert.equal(m.windowBudgetText({ budget: 'abc' }, fmtt, fmtc), null);
  assert.equal(m.windowBudgetText(null, fmtt, fmtc), null);
});
