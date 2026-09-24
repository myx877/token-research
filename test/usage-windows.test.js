// 单平台窗口卡数据层:今日 / 本周 / 本月 的取值区间、重置时刻与预算百分比。
// 边界一律按北京时间结算日历(固定 UTC+8),与采集侧写日键的口径一致。
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  currentWindowRange,
  usageWindows,
  WINDOW_LABELS
} = require('../src/main/core/usage-buckets');
const { beijingDayStartMs } = require('../src/main/core/beijing-calendar');

// 北京时间某个时刻的 epoch ms(便于把"北京某日几点"写成断言输入)
function beijingMs(dayKey, hour, minute) {
  return beijingDayStartMs(dayKey) + ((hour || 0) * 60 + (minute || 0)) * 60000;
}

test('今日窗口:区间就是北京当天,重置时刻是下一个北京零点', () => {
  const now = beijingMs('2026-09-17', 13, 30);
  const range = currentWindowRange('day', now);

  assert.equal(range.from, '2026-09-17');
  assert.equal(range.to, '2026-09-17');
  assert.equal(range.bucketKey, '2026-09-17');
  // 13:30 → 距次日 00:00 还有 10.5 小时
  assert.equal(range.resetsAt - now, 10.5 * 3600 * 1000);
  assert.equal(range.resetsAt, beijingDayStartMs('2026-09-18'));
});

test('今日窗口:北京时间跨日边界不会跟着系统时区跑', () => {
  // 北京时间 2026-09-18 00:00 整 —— 已进入新的一天,重置应指向 09-19
  const justAfterMidnight = beijingMs('2026-09-18', 0, 0);
  assert.equal(currentWindowRange('day', justAfterMidnight).from, '2026-09-18');
  assert.equal(currentWindowRange('day', justAfterMidnight).resetsAt, beijingDayStartMs('2026-09-19'));

  // 北京 2026-09-17 23:59 —— 仍是 09-17
  const justBeforeMidnight = beijingMs('2026-09-17', 23, 59);
  assert.equal(currentWindowRange('day', justBeforeMidnight).from, '2026-09-17');
  assert.equal(currentWindowRange('day', justBeforeMidnight).resetsAt, beijingDayStartMs('2026-09-18'));
});

test('本周窗口:周一起算到下周日,重置在下周一零点(ISO 自然周)', () => {
  // 2026-09-17 是周四
  const range = currentWindowRange('week', beijingMs('2026-09-17', 10, 0));
  assert.equal(range.from, '2026-09-14'); // 周一
  assert.equal(range.to, '2026-09-20'); // 周日
  assert.equal(range.bucketKey, '2026-W38');
  assert.equal(range.resetsAt, beijingDayStartMs('2026-09-21'));

  // 周日当天仍属同一周;周一当天换新周
  const sunday = currentWindowRange('week', beijingMs('2026-09-20', 23, 0));
  assert.equal(sunday.from, '2026-09-14');
  assert.equal(sunday.resetsAt, beijingDayStartMs('2026-09-21'));

  const monday = currentWindowRange('week', beijingMs('2026-09-21', 0, 1));
  assert.equal(monday.from, '2026-09-21');
  assert.equal(monday.to, '2026-09-27');
  assert.equal(monday.bucketKey, '2026-W39');
});

test('本周窗口:跨年那一周归属 ISO 周(2025-12-29 属 2026-W01)', () => {
  const range = currentWindowRange('week', beijingMs('2025-12-31', 12, 0));
  assert.equal(range.from, '2025-12-29');
  assert.equal(range.to, '2026-01-04');
  assert.equal(range.bucketKey, '2026-W01');
  assert.equal(range.resetsAt, beijingDayStartMs('2026-01-05'));
});

test('本月窗口:1 号到月末,重置在下月 1 号零点(含跨年)', () => {
  const september = currentWindowRange('month', beijingMs('2026-09-17', 12, 0));
  assert.equal(september.from, '2026-09-01');
  assert.equal(september.to, '2026-09-30');
  assert.equal(september.bucketKey, '2026-09');
  assert.equal(september.resetsAt, beijingDayStartMs('2026-10-01'));

  // 12 月 → 次年 1 月
  const december = currentWindowRange('month', beijingMs('2026-12-31', 23, 0));
  assert.equal(december.from, '2026-12-01');
  assert.equal(december.to, '2026-12-31');
  assert.equal(december.resetsAt, beijingDayStartMs('2027-01-01'));

  // 闰年 2 月
  const february = currentWindowRange('month', beijingMs('2028-02-10', 12, 0));
  assert.equal(february.to, '2028-02-29');
  assert.equal(february.resetsAt, beijingDayStartMs('2028-03-01'));
});

test('month 窗口:31 天与 30 天月份的末日均正确', () => {
  assert.equal(currentWindowRange('month', beijingMs('2026-01-15', 1, 0)).to, '2026-01-31');
  assert.equal(currentWindowRange('month', beijingMs('2026-04-15', 1, 0)).to, '2026-04-30');
  assert.equal(currentWindowRange('month', beijingMs('2026-02-15', 1, 0)).to, '2026-02-28');
});

test('窗口标签就是用户口径的每日/每周/每月', () => {
  assert.deepEqual(WINDOW_LABELS, { day: '今日', week: '本周', month: '本月' });
});

function fixture() {
  return {
    usageDaily: {
      // 今日(opencode 有数据)
      'opencode:2026-09-17': { input: 100, cached: 1000, output: 200, total: 1300 },
      // 本周内的前一天
      'opencode:2026-09-16': { input: 50, cached: 500, output: 100, total: 650 },
      // 本月内但本周之外
      'opencode:2026-09-02': { input: 10, cached: 100, output: 20, total: 130 },
      // 上个月:任何窗口都不该算进来
      'opencode:2026-08-31': { input: 999, cached: 999, output: 999, total: 2997 },
      // 别的平台:被 provider 过滤掉
      'deepseek:2026-09-17': { input: 777, cached: 0, output: 777, total: 1554 }
    },
    usageDailyCost: {
      'opencode:2026-09-17': 1.0,
      'opencode:2026-09-16': 0.5,
      'opencode:2026-09-02': 0.2,
      'opencode:2026-08-31': 9.9,
      'deepseek:2026-09-17': 12.34
    }
  };
}

test('窗口汇总:今日/本周/本月各自只算自己区间内的日,且只算该平台', () => {
  const data = fixture();
  const result = usageWindows(data.usageDaily, data.usageDailyCost, {
    provider: 'opencode',
    now: beijingMs('2026-09-17', 12, 0)
  });

  assert.equal(result.provider, 'opencode');
  assert.equal(result.currency, 'USD');
  const byKey = Object.fromEntries(result.windows.map((w) => [w.key, w]));

  // 今日只有 09-17
  assert.equal(byKey.day.total, 1300);
  assert.equal(byKey.day.cost, 1.0);
  assert.equal(byKey.day.cached, 1000);
  // 本周 = 09-14..09-20 → 09-17 + 09-16
  assert.equal(byKey.week.total, 1950);
  assert.equal(byKey.week.cost, 1.5);
  assert.equal(byKey.week.bucketKey, '2026-W38');
  // 本月 = 09-01..09-30 → 09-17 + 09-16 + 09-02(上月的 2997 绝不进来)
  assert.equal(byKey.month.total, 2080);
  assert.equal(byKey.month.cost, 1.7);
  // deepseek 的 1554 不混进来
  assert.equal(byKey.day.total + byKey.week.total + byKey.month.total, 1300 + 1950 + 2080);
});

test('没设预算:percent 为 null,绝不编一个分母出来', () => {
  const data = fixture();
  const result = usageWindows(data.usageDaily, data.usageDailyCost, {
    provider: 'opencode',
    now: beijingMs('2026-09-17', 12, 0)
  });

  result.windows.forEach((w) => {
    assert.equal(w.percent, null, w.key);
    assert.equal(w.budget, 0, w.key);
    assert.equal(w.budgetBasis, null, w.key);
    assert.equal(w.over, false, w.key);
  });
});

test('金额预算驱动百分比:已用/预算,超预算标记 over 但百分比照实给', () => {
  const data = fixture();
  const result = usageWindows(data.usageDaily, data.usageDailyCost, {
    provider: 'opencode',
    now: beijingMs('2026-09-17', 12, 0),
    budgets: { opencode: { day: 2, week: 3, month: 1 } }
  });
  const byKey = Object.fromEntries(result.windows.map((w) => [w.key, w]));

  assert.equal(byKey.day.budgetBasis, 'cost');
  assert.equal(byKey.day.percent, 50); // 1.0 / 2
  assert.equal(byKey.week.percent, 50); // 1.5 / 3
  assert.equal(byKey.month.percent, 170); // 1.7 / 1 → 超预算
  assert.equal(byKey.month.over, true);
  assert.equal(byKey.day.over, false);
});

test('未设金额预算时可用 Token 预算兜底', () => {
  const data = fixture();
  const result = usageWindows(data.usageDaily, data.usageDailyCost, {
    provider: 'opencode',
    now: beijingMs('2026-09-17', 12, 0),
    tokenBudgets: { opencode: { day: 2600 } }
  });
  const byKey = Object.fromEntries(result.windows.map((w) => [w.key, w]));

  assert.equal(byKey.day.budgetBasis, 'tokens');
  assert.equal(byKey.day.budget, 2600);
  assert.equal(byKey.day.percent, 50); // 1300 / 2600
  // 没给 token 预算的窗口仍然没有百分比
  assert.equal(byKey.week.percent, null);
});

test('金额预算优先于 Token 预算(两者都设时以金额为准)', () => {
  const data = fixture();
  const result = usageWindows(data.usageDaily, data.usageDailyCost, {
    provider: 'opencode',
    now: beijingMs('2026-09-17', 12, 0),
    budgets: { opencode: { day: 4 } },
    tokenBudgets: { opencode: { day: 2600 } }
  });
  const day = result.windows.find((w) => w.key === 'day');
  assert.equal(day.budgetBasis, 'cost');
  assert.equal(day.percent, 25); // 1.0 / 4
});

test('别家预算不会串到本平台:只按 provider 取自己的预算表', () => {
  const data = fixture();
  const result = usageWindows(data.usageDaily, data.usageDailyCost, {
    provider: 'opencode',
    now: beijingMs('2026-09-17', 12, 0),
    budgets: { deepseek: { day: 100 }, opencode: { day: 2 } }
  });
  const day = result.windows.find((w) => w.key === 'day');
  assert.equal(day.budget, 2);
  assert.equal(day.percent, 50);
});

test('无数据平台:三个窗口全 0,币种仍按平台口径给出,不抛错', () => {
  const result = usageWindows({}, {}, {
    provider: 'opencode',
    now: beijingMs('2026-09-17', 12, 0)
  });
  result.windows.forEach((w) => {
    assert.equal(w.total, 0, w.key);
    assert.equal(w.cost, 0, w.key);
    assert.equal(w.currency, 'USD', w.key);
    assert.ok(w.resetsAt > 0, w.key);
  });
});

test('非法输入不抛错(store 损坏时渲染端不能跟着崩)', () => {
  assert.doesNotThrow(() => usageWindows(null, null, {}));
  assert.doesNotThrow(() => usageWindows(undefined, undefined, { provider: null }));
  const result = usageWindows(null, null, { provider: 'opencode', now: NaN });
  assert.equal(result.windows.length, 3);
  assert.equal(currentWindowRange('bogus-bucket', NaN).bucket, 'day');
});

// —— 保留窗口口径披露(本轮新增)——
// 本地数据被"设置 → 历史数据保留"裁到 N 天内,周期起点早于保留起点时该周期是残缺的:
// 必须显式标 truncated,否则渲染层会把残缺值当整月展示(实测 opencode 本月差一个量级)。

// 周期"残缺"是**数据驱动**判定的:只有库里最早也只有保留起点之后的日桶,才算被裁过。
// (旧实现只比"周期起点 < 保留起点",用户点过「同步历史」补齐后界面会一直误报"仅统计近 N 天"。)

function dailyFixture(entries) {
  const usage = {};
  const cost = {};
  entries.forEach((e) => {
    usage['opencode:' + e.day] = { input: e.total, cached: 0, output: 0, total: e.total };
    if (e.cost) cost['opencode:' + e.day] = e.cost;
  });
  return { usageDaily: usage, usageDailyCost: cost };
}

test('保留 7 天且数据确实被裁过:本月残缺被标记,今日/本周不受影响', () => {
  // now = 北京 2026-09-23 12:00 → 保留起点 09-17;库里最早的日桶是 09-18(09-17 之前没有)
  const now = beijingMs('2026-09-23', 12, 0);
  const data = dailyFixture([
    { day: '2026-09-18', total: 130 },
    { day: '2026-09-22', total: 650 },
    { day: '2026-09-23', total: 1300 }
  ]);
  const result = usageWindows(data.usageDaily, data.usageDailyCost, {
    provider: 'opencode', now: now, historyDays: 7
  });

  assert.deepEqual(result.retention, { historyDays: 7, startDay: '2026-09-17' });
  const byKey = {};
  result.windows.forEach((w) => { byKey[w.key] = w; });
  assert.equal(byKey.month.from, '2026-09-01');
  assert.equal(byKey.month.truncated, true, '本月起点 09-01 早于保留起点 09-17,且库里没有更早的日桶');
  assert.equal(byKey.week.from, '2026-09-21');
  assert.equal(byKey.week.truncated, false, '本周起点 09-21 晚于保留起点,不受影响');
  assert.equal(byKey.day.truncated, false);
});

test('保留 7 天但历史已补齐(或保留起点之前本就有数据):不再误报残缺', () => {
  // 这是用户的真实场景:historyDays=7,但库里最早的数据是 08-10(早于保留起点 09-17),
  // 数字其实是整月 —— 旧实现会一直挂着"仅统计近 7 天"的假提示。
  const now = beijingMs('2026-09-23', 12, 0);
  const data = dailyFixture([
    { day: '2026-08-10', total: 999 },
    { day: '2026-09-02', total: 130 },
    { day: '2026-09-23', total: 1300 }
  ]);
  const result = usageWindows(data.usageDaily, data.usageDailyCost, {
    provider: 'opencode', now: now, historyDays: 7
  });

  assert.deepEqual(result.retention, { historyDays: 7, startDay: '2026-09-17' });
  result.windows.forEach((w) => {
    assert.equal(w.truncated, false, w.key + ' 不该标残缺:库里有早于保留起点的日桶');
  });
});

test('保留 7 天但该周期一格数据都没有:不标残缺(空就是空,别再加一条提示)', () => {
  const now = beijingMs('2026-09-23', 12, 0);
  const result = usageWindows({}, {}, { provider: 'opencode', now: now, historyDays: 7 });
  result.windows.forEach((w) => assert.equal(w.truncated, false, w.key));
});

test('保留 90 天:三个周期都完整,不带任何残缺标记', () => {
  const data = dailyFixture([{ day: '2026-09-23', total: 1300 }]);
  const result = usageWindows(data.usageDaily, data.usageDailyCost, {
    provider: 'opencode', now: beijingMs('2026-09-23', 12, 0), historyDays: 90
  });
  assert.deepEqual(result.retention, { historyDays: 90, startDay: '2026-06-26' });
  result.windows.forEach((w) => assert.equal(w.truncated, false, w.key));
});

test('保留 3 天:本周起点恰好等于保留起点,判为完整(边界取闭区间)', () => {
  const data = dailyFixture([{ day: '2026-09-23', total: 1300 }]);
  const result = usageWindows(data.usageDaily, data.usageDailyCost, {
    provider: 'opencode', now: beijingMs('2026-09-23', 12, 0), historyDays: 3
  });
  const week = result.windows.find((w) => w.key === 'week');
  assert.equal(result.retention.startDay, '2026-09-21');
  assert.equal(week.from, '2026-09-21');
  assert.equal(week.truncated, false, '起点恰好等于保留起点 = 完整');
  const day = result.windows.find((w) => w.key === 'day');
  assert.equal(day.truncated, false);
});

test('缺省/非法保留天数:不返回 retention,也不标记残缺(不编口径)', () => {
  [undefined, null, 0, -1, 'x'].forEach((historyDays) => {
    const result = usageWindows({}, {}, { provider: 'opencode', historyDays: historyDays });
    assert.equal(result.retention, null, String(historyDays));
    result.windows.forEach((w) => assert.equal(w.truncated, false, String(historyDays)));
  });
});
