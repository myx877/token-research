// 进度条分母决议与 命中/输入/输出 明细:纯函数层单测。
// 这是"用户信不信这张卡"的关键点 —— 分母来源必须可验证,不能只在组件里口口相传。
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/src/lib/window-percent.mjs');
const loadSelection = () => import('../renderer/src/selection.js');

// 额度百分比是 1 - remaining/limit 的浮点结果,断言按容差而非位相等
function assertClose(actual, expected, note) {
  assert.ok(Math.abs(Number(actual) - expected) < 1e-9,
    (note || '') + ' 实际=' + actual + ' 期望=' + expected);
}

test('真实额度优先:本周窗口取平台 weekly 额度算已用百分比', async () => {
  const m = await load();
  const quota = { windows: [{ kind: 'weekly', limit: 1000, remaining: 250, name: null }] };
  const r = m.resolveWindowPercent({ windowKey: 'week', quota: quota, budgetPercent: 10 });
  assert.equal(r.basis, 'quota');
  assertClose(r.percent, 75);
});

test('平台没有对应粒度的额度:今日/本月不拿 5 小时额度冒充,回落到预算', async () => {
  const m = await load();
  assert.equal(m.QUOTA_KIND_BY_WINDOW.day, null);
  assert.equal(m.QUOTA_KIND_BY_WINDOW.month, null);
  // 即使给了 5h 额度,今日窗口也不该用它
  const quota = { windows: [{ kind: '5h', limit: 100, remaining: 1, name: null }] };
  const day = m.resolveWindowPercent({ windowKey: 'day', quota: quota, budgetPercent: 42 });
  assert.deepEqual(day, { percent: 42, basis: 'budget' });
});

test('额度数据不全:不编数,退回预算;预算也没有就是空轨道', async () => {
  const m = await load();
  const broken = { windows: [{ kind: 'weekly', limit: 0, remaining: 10, name: null }] };
  assert.deepEqual(m.resolveWindowPercent({ windowKey: 'week', quota: broken, budgetPercent: 5 }),
    { percent: 5, basis: 'budget' });
  assert.deepEqual(m.resolveWindowPercent({ windowKey: 'week', quota: broken }), null2Null());
  assert.deepEqual(m.resolveWindowPercent({}), null2Null());
});

// 实测缺陷:Number(null) === 0,于是"没设预算"被算成"预算 0% ⇒ 已用 0%",
// 界面上凭空多出一个 0% 徽章 —— 需求明令"没有分母就不要编数字"。
test('没设预算(percent 为 null/undefined/空串)⇒ 空轨道,绝不编成 0%', async () => {
  const m = await load();
  [null, undefined, ''].forEach((budget) => {
    assert.deepEqual(m.resolveWindowPercent({ windowKey: 'day', quota: null, budgetPercent: budget }), null2Null(),
      'budget=' + JSON.stringify(budget));
  });
  assert.deepEqual(m.resolveWindowPercent({ windowKey: 'month', quota: null }), null2Null());
  assert.equal(m.parseBudgetPercent(null), null);
  assert.equal(m.parseBudgetPercent(''), null);
  // 但"真的填了 0"是一个明确的值:显示 0% 是对的,不能和"没填"混为一谈
  assert.deepEqual(m.resolveWindowPercent({ windowKey: 'day', quota: null, budgetPercent: 0 }),
    { percent: 0, basis: 'budget' });
  assert.deepEqual(m.resolveWindowPercent({ windowKey: 'day', quota: null, budgetPercent: '25' }),
    { percent: 25, basis: 'budget' });
});

// 小工具:期望值 { percent: null, basis: null }
function null2Null() {
  return { percent: null, basis: null };
}

// 超额必须如实显示(如 170%),只有进度条宽度封顶:夹成 100% 就看不出超了多少
test('超额如实给出 >100,只有渲染宽度封顶', async () => {
  const m = await load();
  assert.equal(m.quotaUsedPercent({ limit: 100, remaining: -50 }), 150);
  assert.equal(m.quotaUsedPercent({ limit: 100, remaining: 500 }), 0);
  assert.equal(m.quotaUsedPercent(null), null);
  // 「剩余未知」不是 0:Number(null) === 0 会把"不知道"画成 100% 已用 + 超额标红(审查发现)
  assert.equal(m.quotaUsedPercent({ limit: 100, remaining: null }), null);
  assert.equal(m.quotaUsedPercent({ limit: 100, remaining: undefined }), null);
  assert.equal(m.quotaUsedPercent({ limit: 100, remaining: '' }), null);
  assert.equal(m.resolveWindowPercent({ windowKey: 'week', quota: { windows: [{ kind: 'weekly', limit: 100, remaining: null }] }, budgetPercent: 40 }).percent, 40);
  const r = m.resolveWindowPercent({ windowKey: 'week', quota: null, budgetPercent: 250 });
  assert.equal(r.percent, 250);
  // 负预算(脏数据)夹到 0,不产生负宽度
  assert.equal(m.resolveWindowPercent({ windowKey: 'week', quota: null, budgetPercent: -5 }).percent, 0);
});

test('主额度优先于附加额度(Codex Spark 不会抢走主额度)', async () => {
  const m = await load();
  const quota = {
    windows: [
      { kind: 'weekly', limit: 100, remaining: 20, name: 'spark' },
      { kind: 'weekly', limit: 100, remaining: 90, name: null }
    ]
  };
  assertClose(m.resolveWindowPercent({ windowKey: 'week', quota: quota }).percent, 10);
  // 只有附加额度时也不丢:仍按它给百分比
  const onlySpark = { windows: [{ kind: 'weekly', limit: 100, remaining: 20, name: 'spark' }] };
  assertClose(m.resolveWindowPercent({ windowKey: 'week', quota: onlySpark }).percent, 80);
});

test('命中/输入/输出明细:三桶齐全且用注入的格式化器', async () => {
  const m = await load();
  const win = { cached: 1200, input: 3400, output: 56 };
  const text = m.breakdownText(win, (v) => v + 'T');
  assert.equal(text, '命中 1200T · 输入 3400T · 输出 56T');
  // 缺字段不抛错,按 0 处理
  assert.equal(m.breakdownText({}, (v) => String(v)), '命中 0 · 输入 0 · 输出 0');
  assert.equal(m.breakdownText(null, (v) => String(v)), '命中 0 · 输入 0 · 输出 0');
});

test('选中平台:广播订阅、重复设置不重复通知、未知值可清空', async () => {
  const sel = await loadSelection();
  sel.__resetSelection();
  const seen = [];
  const off = sel.subscribeSelection((v) => seen.push(v));
  sel.setSelectedProvider('opencode');
  sel.setSelectedProvider('opencode'); // 同值不重复广播
  sel.setSelectedProvider('claude');
  assert.deepEqual(seen, ['opencode', 'claude']);
  assert.equal(sel.getSelectedProvider(), 'claude');
  sel.setSelectedProvider(null);
  assert.equal(sel.getSelectedProvider(), null);
  assert.deepEqual(seen, ['opencode', 'claude', null]);
  off();
  sel.setSelectedProvider('codex');
  assert.deepEqual(seen, ['opencode', 'claude', null], '退订后不再收到通知');
  sel.__resetSelection();
});
