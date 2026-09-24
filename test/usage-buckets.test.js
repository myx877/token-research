// 用量分桶(自然日/ISO 自然周/自然月 × provider)与订阅摊薄的纯函数测试。
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseDayKey,
  monthKeyFromDay,
  isoWeekKey,
  bucketKeyForDay,
  splitStoreKey,
  dayRows,
  estimateSubscriptionDaily,
  aggregateUsage,
  listProviders,
  COST_SOURCE
} = require('../src/main/core/usage-buckets');

test('parseDayKey 只接受真实存在的 YYYY-MM-DD', () => {
  assert.deepEqual(parseDayKey('2026-09-17'), { year: 2026, month: 9, day: 17 });
  assert.equal(parseDayKey('2026-02-30'), null);
  assert.equal(parseDayKey('2026-13-01'), null);
  assert.equal(parseDayKey('2026-9-17'), null);
  assert.equal(parseDayKey(''), null);
  assert.equal(parseDayKey(null), null);
  assert.equal(parseDayKey('claude:2026-09-17'), null);
});

test('monthKeyFromDay 生成 YYYY-MM', () => {
  assert.equal(monthKeyFromDay('2026-09-17'), '2026-09');
  assert.equal(monthKeyFromDay('2026-12-31'), '2026-12');
  assert.equal(monthKeyFromDay('2026-01-01'), '2026-01');
  assert.equal(monthKeyFromDay('nope'), null);
});

test('isoWeekKey 按 ISO 8601 归属(周一起、第一个周四所在周为 W01)', () => {
  assert.equal(isoWeekKey('2026-01-01'), '2026-W01');
  // 2025-12-29(周一)按 ISO 属于 2026-W01
  assert.equal(isoWeekKey('2025-12-29'), '2026-W01');
  // 2027-01-01(周五)按 ISO 属于 2026-W53
  assert.equal(isoWeekKey('2027-01-01'), '2026-W53');
  assert.equal(isoWeekKey('2026-09-17'), '2026-W38');
  assert.equal(isoWeekKey('bad'), null);
});

test('同一自然周(周一至周日)落在同一个周键', () => {
  ['2026-09-14', '2026-09-15', '2026-09-19', '2026-09-20'].forEach((day) => {
    assert.equal(isoWeekKey(day), '2026-W38', day);
  });
  assert.equal(isoWeekKey('2026-09-21'), '2026-W39');
  assert.equal(bucketKeyForDay('2026-09-21', 'week'), '2026-W39');
  assert.equal(bucketKeyForDay('2026-09-21', 'month'), '2026-09');
  assert.equal(bucketKeyForDay('2026-09-21', 'day'), '2026-09-21');
  assert.equal(bucketKeyForDay('bad', 'week'), null);
});

test('splitStoreKey 解析 <provider>:<YYYY-MM-DD>', () => {
  assert.deepEqual(splitStoreKey('claude:2026-09-17'), { provider: 'claude', day: '2026-09-17' });
  assert.equal(splitStoreKey('no-colon'), null);
  assert.equal(splitStoreKey(':2026-09-17'), null);
  assert.equal(splitStoreKey('claude:2026-9-17'), null);
  assert.equal(splitStoreKey(undefined), null);
});

// kimi:2026-09-16 是刻意的全零行,用于验证「总量与金额均为 0 的行被跳过」。
const DAILY = {
  'claude:2026-09-14': { input: 10, cached: 5, output: 2, total: 17 },
  'codex:2026-09-14': { input: 1, cached: 0, output: 1, total: 2 },
  'claude:2026-09-15': { input: 20, cached: 0, output: 0, total: 20 },
  'kimi:2026-09-16': { input: 0, cached: 0, output: 0, total: 0 }
};
const DAILY_COST = { 'claude:2026-09-14': 0.5, 'deepseek:2026-09-14': 0 };

test('dayRows 过滤 provider/日期区间并连接金额,跳过全零行', () => {
  const all = dayRows(DAILY, DAILY_COST, {});
  assert.deepEqual(all.map((r) => r.provider + ':' + r.day), [
    'claude:2026-09-14',
    'claude:2026-09-15',
    'codex:2026-09-14'
  ]);
  assert.equal(all[0].cost, 0.5);
  assert.equal(dayRows(DAILY, DAILY_COST, { provider: 'claude' }).length, 2);
  assert.equal(dayRows(DAILY, DAILY_COST, { provider: 'all' }).length, 3);
  assert.deepEqual(
    dayRows(DAILY, DAILY_COST, { from: '2026-09-15' }).map((r) => r.day),
    ['2026-09-15']
  );
  assert.deepEqual(
    dayRows(DAILY, DAILY_COST, { to: '2026-09-14' }).map((r) => r.day),
    ['2026-09-14', '2026-09-14']
  );
  // 总量与金额均为 0 的行不计入
  assert.equal(dayRows({ 'kimi:2026-09-16': { total: 0 } }, {}, {}).length, 0);
  // 畸形键被忽略,不抛异常
  assert.equal(dayRows({ 'garbage': { total: 10 }, 'x:bad': { total: 10 } }, {}, {}).length, 0);
});

test('aggregateUsage 默认按日、按 provider 分行并给出总计', () => {
  const result = aggregateUsage(DAILY, DAILY_COST, {});
  assert.equal(result.bucket, 'day');
  assert.deepEqual(result.rows.map((r) => r.bucketKey + '/' + r.provider), [
    '2026-09-14/claude',
    '2026-09-14/codex',
    '2026-09-15/claude'
  ]);
  // 跨币种不求和:claude 记 CNY(定价表为 ¥),codex 记 USD,总计按币种分组
  assert.deepEqual(result.totals, {
    input: 31,
    cached: 5,
    output: 3,
    total: 39,
    estimatedByCurrency: {},
    costByCurrency: { CNY: 0.5 }
  });
  // 非法 bucket 回落到 day
  assert.equal(aggregateUsage(DAILY, DAILY_COST, { bucket: 'quarter' }).bucket, 'day');
});

test('aggregateUsage 按自然周(ISO)合并同一周的多天', () => {
  const result = aggregateUsage(DAILY, DAILY_COST, { bucket: 'week' });
  const claudeWeek = result.rows.find((r) => r.provider === 'claude' && r.bucketKey === '2026-W38');
  assert.ok(claudeWeek);
  assert.equal(claudeWeek.total, 37);
  assert.equal(claudeWeek.input, 30);
  assert.equal(claudeWeek.cached, 5);
  assert.equal(claudeWeek.cost, 0.5);
});

test('aggregateUsage 按自然月合并', () => {
  const result = aggregateUsage(DAILY, DAILY_COST, { bucket: 'month' });
  const claudeMonth = result.rows.find((r) => r.provider === 'claude');
  assert.equal(claudeMonth.bucketKey, '2026-09');
  assert.equal(claudeMonth.total, 37);
  // 2026-09 只应有两个 provider 行:claude 与 codex(kimi 全零行被跳过)
  assert.equal(result.rows.filter((r) => r.bucketKey === '2026-09').length, 2);
});

test('金额来源口径按 provider 表声明', () => {
  assert.equal(COST_SOURCE.deepseek, 'real');
  assert.equal(COST_SOURCE.dsh, 'real');
  assert.equal(COST_SOURCE.opencode, 'real');
  assert.equal(COST_SOURCE.claude, 'derived');
  assert.equal(COST_SOURCE.codex, null);
  assert.equal(aggregateUsage(DAILY, DAILY_COST, {}).rows
    .find((r) => r.provider === 'claude').costSource, 'derived');
});

test('金额求和不受浮点噪声影响(0.1 + 0.2 = 0.3)', () => {
  const daily = {
    'claude:2026-09-14': { total: 1 },
    'claude:2026-09-15': { total: 1 }
  };
  const cost = { 'claude:2026-09-14': 0.1, 'claude:2026-09-15': 0.2 };
  const result = aggregateUsage(daily, cost, { bucket: 'month' });
  assert.equal(result.rows[0].cost, 0.3);
  assert.equal(result.rows[0].currency, 'CNY');
  assert.equal(result.totals.costByCurrency.CNY, 0.3);
});

test('订阅摊薄:自然月内各日估算之和等于月费', () => {
  const rows = [
    { provider: 'claude', day: '2026-09-14', total: 25 },
    { provider: 'claude', day: '2026-09-15', total: 75 },
    { provider: 'codex', day: '2026-09-14', total: 1000 }
  ];
  const estimates = estimateSubscriptionDaily(rows, { claude: 100 });
  assert.equal(estimates['claude:2026-09-14'], 25);
  assert.equal(estimates['claude:2026-09-15'], 75);
  // 未配置月费的 provider 不产生估算
  assert.equal(estimates['codex:2026-09-14'], undefined);
  assert.equal(
    Object.keys(estimates).reduce((sum, key) => sum + estimates[key], 0),
    100
  );
  // 月费为 0 / 负数 / 缺失 → 无估算
  assert.deepEqual(estimateSubscriptionDaily(rows, { claude: 0 }), {});
  assert.deepEqual(estimateSubscriptionDaily(rows, {}), {});
  assert.deepEqual(estimateSubscriptionDaily(rows, null), {});
});

test('订阅摊薄接入 aggregateUsage:日/周/月桶都能带上可隐藏的估算值', () => {
  const daily = {
    'claude:2026-09-14': { total: 25 },
    'claude:2026-09-15': { total: 75 }
  };
  const day = aggregateUsage(daily, {}, { bucket: 'day', monthlyFee: { claude: 100 } });
  assert.equal(day.rows[0].estimatedCost, 25);
  assert.equal(day.rows[1].estimatedCost, 75);
  const week = aggregateUsage(daily, {}, { bucket: 'week', monthlyFee: { claude: 100 } });
  assert.equal(week.rows[0].bucketKey, '2026-W38');
  assert.equal(week.rows[0].estimatedCost, 100);
  const month = aggregateUsage(daily, {}, { bucket: 'month', monthlyFee: { claude: 100 } });
  assert.equal(month.rows[0].estimatedCost, 100);
  assert.equal(month.totals.estimatedByCurrency.CNY, 100);
});

test('订阅摊薄估算按币种分开累计:¥ 与 $ 的估算绝不相加成一个数', () => {
  const daily = {
    'claude:2026-09-14': { total: 50 },
    'codex:2026-09-14': { total: 50 }
  };
  const month = aggregateUsage(daily, {}, {
    bucket: 'month',
    monthlyFee: { claude: 140, codex: 100 }
  });
  // 两个 provider 各只有一天有量 → 各占满整月,金额是各自月费;币种不同必须分开列出
  assert.deepEqual(month.totals.estimatedByCurrency, { CNY: 140, USD: 100 });
  assert.equal(month.totals.estimatedCost, undefined);
});

test('订阅摊薄跨月:周桶跨越两个月时分别按各自月份摊薄', () => {
  const daily = {
    'claude:2026-08-31': { total: 10 },
    'claude:2026-09-01': { total: 30 }
  };
  const monthFee = { claude: 100 };
  const rows = dayRows(daily, {}, {});
  const estimates = estimateSubscriptionDaily(rows, monthFee);
  assert.equal(estimates['claude:2026-08-31'], 100);
  assert.equal(estimates['claude:2026-09-01'], 100);
  const week = aggregateUsage(daily, {}, { bucket: 'week', monthlyFee: monthFee });
  // 2026-08-31(周一)与 2026-09-01(周二)属于同一 ISO 周
  assert.equal(week.rows.length, 1);
  assert.equal(week.rows[0].bucketKey, isoWeekKey('2026-08-31'));
  assert.equal(week.rows[0].estimatedCost, 200);
});

test('listProviders 按总量降序返回有数据的 provider', () => {
  assert.deepEqual(listProviders(DAILY), ['claude', 'codex']);
  assert.deepEqual(listProviders({}), []);
  assert.deepEqual(listProviders({ 'claude:2026-09-14': { total: 1 }, 'garbage': { total: 9 } }), ['claude']);
});
