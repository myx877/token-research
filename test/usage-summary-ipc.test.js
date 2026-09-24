const test = require('node:test');
const assert = require('node:assert/strict');

// 纯 node 环境 mock electron(与 dsh-dashboard-ipc.test.js 同一模式),使 src/main/ipc.js 可加载。
function createFakeIpcMain() {
  const on = new Map();
  const handle = new Map();
  return {
    on(channel, callback) { on.set(channel, callback); },
    handle(channel, callback) { handle.set(channel, callback); },
    removeListener(channel, callback) { if (on.get(channel) === callback) on.delete(channel); },
    removeHandler(channel) { handle.delete(channel); },
    get handleMap() { return handle; },
    get onMap() { return on; }
  };
}

const fakeIpc = createFakeIpcMain();
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath,
  filename: electronPath,
  loaded: true,
  exports: {
    ipcMain: fakeIpc,
    BrowserWindow: { fromWebContents: () => null }
  }
};

const setupIPC = require('../src/main/ipc');
const { beijingDayKey, addBeijingDays } = require('../src/main/core/beijing-calendar');
const { isoWeekKey } = require('../src/main/core/usage-buckets');

function getPath(obj, key) {
  return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function setPath(obj, key, value) {
  const parts = key.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}
function makeStore(initial) {
  const data = {};
  Object.keys(initial || {}).forEach((key) => setPath(data, key, JSON.parse(JSON.stringify(initial[key]))));
  return {
    get(k) { return getPath(data, k); },
    set(k, v) { setPath(data, k, v); },
    delete(k) {
      const parts = k.split('.');
      let cur = data;
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (cur[parts[i]] == null) return;
        cur = cur[parts[i]];
      }
      delete cur[parts[parts.length - 1]];
    }
  };
}

// 2026-09-14(周一)/15/16 同一 ISO 周 2026-W38;17 日用于跨周断言不需要
const USAGE = {
  'deepseek:2026-09-14': { input: 100, cached: 10, output: 20, total: 130 },
  'deepseek:2026-09-15': { input: 200, cached: 20, output: 40, total: 260 },
  'opencode:2026-09-15': { input: 5, cached: 0, output: 5, total: 10 },
  'opencode:2026-09-16': { input: 50, cached: 0, output: 50, total: 100 },
  'codex:2026-09-16': { input: 1, cached: 0, output: 1, total: 2 }
};
const COST = {
  'deepseek:2026-09-14': 1.5,
  'deepseek:2026-09-15': 2.5,
  'opencode:2026-09-15': 0.25,
  'opencode:2026-09-16': 0.75
};

function buildDeps(overrides) {
  const store = overrides && overrides.store ? overrides.store : makeStore({
    usageDaily: USAGE,
    usageDailyCost: COST,
    'data.subscriptionMonthlyFee': { codex: 100 }
  });
  return Object.assign({
    store: store,
    registry: { get: () => null, list: () => [] },
    scheduler: { getState: () => ({}), getSnapshot: () => [] },
    tokenSpeedRuntime: null,
    codexUsageRuntime: null,
    diagnostics: { start() {}, copy() {}, openGuide() {} },
    getDiagnosticsWindow: () => null,
    createDiagnosticsWindow: () => {},
    getDiagnosticsTheme: () => ({}),
    getMainWindow: () => null,
    getSettingsWindow: () => null
  }, overrides || {});
}

const deps = buildDeps();
setupIPC(deps);
const handler = fakeIpc.handleMap.get('get:usage-summary');

test('get:usage-summary 已注册且返回日聚合行、分币种总计、抓取时间', () => {
  assert.equal(typeof handler, 'function');
  const result = handler(null, { bucket: 'day' });
  assert.equal(result.error, null);
  assert.equal(typeof result.fetchedAt, 'number');

  const deepseek = result.rows.find((r) => r.provider === 'deepseek' && r.bucketKey === '2026-09-14');
  assert.deepEqual(
    { ...deepseek, cost: deepseek.cost },
    {
      bucket: 'day',
      bucketKey: '2026-09-14',
      provider: 'deepseek',
      input: 100,
      cached: 10,
      output: 20,
      total: 130,
      cost: 1.5,
      currency: 'CNY',
      costSource: 'real',
      estimatedCost: 0
    }
  );

  // ¥ 与 $ 必须分币种汇总,绝不相加
  assert.deepEqual(result.totals.costByCurrency, { CNY: 4, USD: 1 });
  assert.equal(result.totals.cost, undefined);
  assert.equal(result.totals.total, 130 + 260 + 10 + 100 + 2);
});

test('get:usage-summary 日键在读取时归入 ISO 自然周与自然月', () => {
  const week = handler(null, { bucket: 'week' });
  assert.deepEqual(week.rows.map((r) => r.bucketKey), ['2026-W38', '2026-W38', '2026-W38']);
  // 同周多天合并:deepseek 130+260、opencode 10+100、codex 2
  const byProvider = {};
  week.rows.forEach((r) => { byProvider[r.provider] = r; });
  assert.equal(byProvider.deepseek.total, 390);
  assert.equal(byProvider.opencode.total, 110);
  assert.equal(byProvider.codex.total, 2);
  assert.deepEqual(week.totals.costByCurrency, { CNY: 4, USD: 1 });

  const month = handler(null, { bucket: 'month' });
  assert.deepEqual(month.rows.map((r) => r.bucketKey), ['2026-09', '2026-09', '2026-09']);
  assert.equal(month.totals.total, week.totals.total);
});

test('get:usage-summary 支持 provider 过滤与日期区间', () => {
  const only = handler(null, { bucket: 'day', provider: 'opencode' });
  assert.deepEqual(only.rows.map((r) => r.bucketKey), ['2026-09-15', '2026-09-16']);
  assert.deepEqual(only.totals.costByCurrency, { USD: 1 });

  const ranged = handler(null, { bucket: 'day', from: '2026-09-15', to: '2026-09-15' });
  assert.deepEqual(ranged.rows.map((r) => r.provider + ':' + r.bucketKey), ['deepseek:2026-09-15', 'opencode:2026-09-15']);
});

test('get:usage-summary 用订阅月费摊薄估算:自然月内各日估算之和 = 月费', () => {
  const month = handler(null, { bucket: 'month', provider: 'codex' });
  assert.equal(month.rows.length, 1);
  // codex 只有 2026-09-16 一天有量,该日即占满整月 → 估算 = 全额月费
  assert.equal(month.rows[0].estimatedCost, 100);
  assert.equal(month.rows[0].currency, 'USD');
  assert.equal(month.rows[0].cost, 0);
  assert.deepEqual(month.totals.estimatedByCurrency, { USD: 100 });
});

test('get:usage-summary 在 store 读取异常时返回空结果与错误文本,不抛出', () => {
  assert.equal(handler(null, { bucket: 'month' }).error, null);

  const storeRef = deps.store;
  deps.store = {
    get(key) {
      if (key === 'usageDaily') throw new Error('store corrupted');
      return undefined;
    },
    set() {},
    delete() {}
  };
  const failed = handler(null, { bucket: 'day' });
  deps.store = storeRef;

  assert.deepEqual(failed.rows, []);
  assert.equal(failed.bucket, 'day');
  assert.match(failed.error, /store corrupted/);
});

/* ======== 单平台窗口卡(get:usage-windows)======== */

const windowsHandler = fakeIpc.handleMap.get('get:usage-windows');

// 夹具的日键相对"今天(北京)"生成,测试不依赖跑测试的日历日;
// 上个月最后一天用来证明"上月的量绝不进本月窗口"。
function relativeUsageFixture() {
  const today = beijingDayKey();
  const yesterday = addBeijingDays(today, -1);
  const lastMonthDay = addBeijingDays(today.slice(0, 7) + '-01', -1);
  return {
    today: today,
    yesterday: yesterday,
    lastMonthDay: lastMonthDay,
    sameWeek: isoWeekKey(yesterday) === isoWeekKey(today),
    sameMonth: yesterday.slice(0, 7) === today.slice(0, 7),
    store: makeStore({
      usageDaily: {
        ['opencode:' + today]: { input: 400, cached: 100, output: 500, total: 1000 },
        ['opencode:' + yesterday]: { input: 200, cached: 0, output: 300, total: 500 },
        ['opencode:' + lastMonthDay]: { input: 4000, cached: 0, output: 5000, total: 9999 },
        ['deepseek:' + today]: { input: 10, cached: 0, output: 10, total: 77 }
      },
      usageDailyCost: {
        ['opencode:' + today]: 2,
        ['opencode:' + yesterday]: 1,
        ['opencode:' + lastMonthDay]: 99,
        ['deepseek:' + today]: 5
      },
      'data.usageBudget': { opencode: { day: 4 } },
      'data.usageBudgetTokens': { opencode: { week: 10000 } }
    })
  };
}

test('get:usage-windows 已注册:返回今日/本周/本月三窗口,含金额、重置时刻与预算百分比', () => {
  assert.equal(typeof windowsHandler, 'function');
  const fx = relativeUsageFixture();
  const storeRef = deps.store;
  deps.store = fx.store;
  let result;
  try {
    result = windowsHandler(null, { provider: 'opencode' });
  } finally {
    deps.store = storeRef;
  }

  assert.equal(result.error, null);
  assert.equal(result.provider, 'opencode');
  assert.equal(result.currency, 'USD');
  assert.deepEqual(result.windows.map((w) => w.key), ['day', 'week', 'month']);
  assert.deepEqual(result.windows.map((w) => w.label), ['今日', '本周', '本月']);
  const [day, week, month] = result.windows;

  // 今日只算今天:上月的 9999 与昨天的量都不进来
  assert.equal(day.total, 1000);
  assert.equal(day.cost, 2);
  assert.equal(day.bucketKey, fx.today);
  assert.equal(day.currency, 'USD');
  assert.ok(day.resetsAt > Date.now());

  // 本周 = 今天 + (昨天若同 ISO 周);上月最后一天永远不进任何窗口
  assert.equal(week.total, fx.sameWeek ? 1500 : 1000);
  assert.equal(week.cost, fx.sameWeek ? 3 : 2);
  // 本月 = 今天 + (昨天若同月)
  assert.equal(month.total, fx.sameMonth ? 1500 : 1000);
  assert.equal(month.bucketKey, fx.today.slice(0, 7));
  assert.equal(month.to, fx.today.slice(0, 7) + '-' + String(new Date(Date.UTC(
    Number(fx.today.slice(0, 4)), Number(fx.today.slice(5, 7)), 0
  )).getUTCDate()).padStart(2, '0'));

  // 金额预算驱动今日百分比:2/4 = 50%;本周改用 Token 预算兜底:1500(或 1000)/10000
  assert.equal(day.budgetBasis, 'cost');
  assert.equal(day.budget, 4);
  assert.equal(day.percent, 50);
  assert.equal(week.budgetBasis, 'tokens');
  assert.equal(week.budget, 10000);
  assert.equal(week.percent, Math.round(((fx.sameWeek ? 1500 : 1000) / 10000) * 1000) / 10);
  // 本月没给任何预算 → 没有百分比,绝不编一个分母
  assert.equal(month.percent, null);
  assert.equal(month.budget, 0);
  assert.equal(month.budgetBasis, null);
});

test('get:usage-windows 只算该平台:别家的量不混进窗口', () => {
  const fx = relativeUsageFixture();
  const storeRef = deps.store;
  deps.store = fx.store;
  let opencode;
  let deepseek;
  try {
    opencode = windowsHandler(null, { provider: 'opencode' });
    deepseek = windowsHandler(null, { provider: 'deepseek' });
  } finally {
    deps.store = storeRef;
  }
  // deepseek 今天 77:既不进 opencode 的今日,也不吃 opencode 的预算
  assert.equal(opencode.windows[0].total, 1000);
  assert.equal(deepseek.windows[0].total, 77);
  assert.equal(deepseek.windows[0].currency, 'CNY');
  assert.equal(deepseek.windows[0].percent, null);
  assert.equal(deepseek.windows[0].resetsAt, opencode.windows[0].resetsAt);
});

test('get:usage-windows 未设任何预算时三窗口都没有百分比', () => {
  const fx = relativeUsageFixture();
  const storeRef = deps.store;
  deps.store = makeStore({
    usageDaily: fx.store.get('usageDaily'),
    usageDailyCost: fx.store.get('usageDailyCost')
  });
  let result;
  try {
    result = windowsHandler(null, { provider: 'opencode' });
  } finally {
    deps.store = storeRef;
  }
  result.windows.forEach((w) => {
    assert.equal(w.percent, null, w.key);
    assert.equal(w.budget, 0, w.key);
  });
});

test('get:usage-windows 在 store 读取异常时返回空窗口与错误文本,不抛出', () => {
  const storeRef = deps.store;
  deps.store = {
    get(key) {
      if (key === 'usageDaily') throw new Error('store corrupted');
      return undefined;
    },
    set() {},
    delete() {}
  };
  const failed = windowsHandler(null, { provider: 'opencode' });
  deps.store = storeRef;

  assert.deepEqual(failed.windows, []);
  assert.equal(failed.provider, 'opencode');
  assert.match(failed.error, /store corrupted/);
});

test('get:usage-summary 一并返回平台清单(供渲染端的选择器,不硬编码平台)', () => {
  const result = handler(null, { bucket: 'day' });
  // 按总量降序:deepseek 390 > opencode 110 > codex 2
  assert.deepEqual(result.providers, ['deepseek', 'opencode', 'codex']);
});
