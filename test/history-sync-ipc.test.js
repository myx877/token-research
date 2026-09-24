const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// 纯 node 环境 mock electron(ipcMain + BrowserWindow),使 src/main/ipc.js 可被加载与调用。
function createFakeIpcMain() {
  const on = new Map();
  const handle = new Map();
  return {
    on(channel, callback) {
      on.set(channel, callback);
    },
    handle(channel, callback) {
      handle.set(channel, callback);
    },
    removeListener(channel, callback) {
      if (on.get(channel) === callback) on.delete(channel);
    },
    removeHandler(channel) {
      handle.delete(channel);
    },
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

const preloadSource = fs.readFileSync(path.resolve(__dirname, '../src/preload/preload.js'), 'utf8');

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

function makeFakeStore(initial) {
  const data = JSON.parse(JSON.stringify(initial || {}));
  return {
    data,
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

function makeProvider(id, readLocalLog) {
  return { id, displayName: id, capabilities: { localLog: true }, readLocalLog };
}

let pollAllCalls = 0;
let rebaselineCalls = 0;
let kimiReadCalls = 0;
let codexProvider;
let kimiProvider;
let codexRuntime;

function buildDeps(overrides) {
  return Object.assign({
    store: makeFakeStore({}),
    registry: {
      get(id) {
        if (id === 'codex') return codexProvider;
        if (id === 'kimi') return kimiProvider;
        return null;
      }
    },
    scheduler: {
      pollAll: async () => { pollAllCalls += 1; },
      getState: () => ({}),
      getSnapshot: () => []
    },
    tokenSpeedRuntime: { rebaselineAll: () => { rebaselineCalls += 1; } },
    codexUsageRuntime: codexRuntime,
    diagnostics: { start() {}, copy() {}, openGuide() {} },
    getDiagnosticsWindow: () => null,
    createDiagnosticsWindow: () => {},
    getDiagnosticsTheme: () => ({}),
    getMainWindow: () => null,
    getSettingsWindow: () => null,
    getLoginWindow: () => null,
    getEdgeDock: () => null,
    createMainWindow() {},
    createLoginWindow() {},
    createSessionWindow() {},
    createSettingsWindow() {},
    getMcpRuntime: () => null,
    runtime: {},
    resizeState: {},
    broadcastSettings() {},
    broadcastSessionState() {},
    applySetting() {},
    persistMainWindowBounds() {},
    normalizeMainBounds() {},
    sendMainWindowBounds() {},
    buildCurvePoints() { return { token: [], cost: [] }; }
  }, overrides);
}

function freshHarness() {
  pollAllCalls = 0;
  rebaselineCalls = 0;
  kimiReadCalls = 0;
  codexRuntime = {
    rebuildCalls: [],
    rebuild(opts) {
      this.rebuildCalls.push(opts);
      if (opts && typeof opts.onProgress === 'function') {
        opts.onProgress({ stage: 'codex', detail: 'shadow-rebuild' });
      }
      return Promise.resolve({
        daysRebuilt: 2,
        earliestDate: '2026-07-01',
        passes: 3,
        records: 100,
        bytesRead: 5000
      });
    }
  };
  codexProvider = makeProvider('codex', async () => ({ records: [], complete: true, bytesRead: 0 }));
  kimiProvider = makeProvider('kimi', async () => {
    kimiReadCalls += 1;
    return { records: [], complete: true, bytesRead: 0 };
  });
}

test('sync:history 经运行时重建 Codex、经通用重扫重建 Kimi,并刷新仪表盘', async () => {
  freshHarness();
  const deps = buildDeps();
  setupIPC(deps);

  const progress = [];
  const handler = fakeIpc.handleMap.get('sync:history');
  assert.ok(handler, 'sync:history handler registered');

  const summary = await handler({
    sender: {
      send: (channel, payload) => {
        if (channel === 'sync:progress') progress.push(payload);
      }
    }
  });

  // Codex 走运行时,而不是通用 rescanLocalLogs
  assert.equal(codexRuntime.rebuildCalls.length, 1);
  assert.equal(typeof codexRuntime.rebuildCalls[0].onProgress, 'function');
  assert.deepEqual(summary.codex, {
    daysRebuilt: 2,
    earliestDate: '2026-07-01',
    passes: 3,
    records: 100,
    bytesRead: 5000
  });

  // Kimi 走通用 rescanLocalLogs(provider.readLocalLog 被调用)
  assert.equal(kimiReadCalls, 1);
  assert.ok(summary.kimi && typeof summary.kimi.daysRebuilt === 'number');

  // 进度回调到达 sync:progress
  assert.ok(progress.some((p) => p.stage === 'codex'));
  assert.ok(progress.some((p) => p.stage === 'kimi'));

  // 两者完成后运行 pollAll,并保留 token-speed rebaseline
  assert.equal(pollAllCalls, 1);
  assert.equal(rebaselineCalls, 1);
});

test('sync:history 未注入 Codex 运行时回退到通用重扫', async () => {
  freshHarness();
  let codexReadCalls = 0;
  codexProvider = makeProvider('codex', async () => {
    codexReadCalls += 1;
    return { records: [], complete: true, bytesRead: 0 };
  });
  const deps = buildDeps();
  delete deps.codexUsageRuntime;

  setupIPC(deps);
  const handler = fakeIpc.handleMap.get('sync:history');
  const summary = await handler({ sender: { send: () => {} } });

  assert.equal(codexReadCalls, 1);
  assert.ok(summary.codex && typeof summary.codex.daysRebuilt === 'number');
  assert.ok(summary.kimi && typeof summary.kimi.daysRebuilt === 'number');
});

test('sync:history:库里有早于保留窗口的数据时给出「建议保留多少天」(实测曾抛 ReferenceError)', async () => {
  freshHarness();
  // 真机缺陷:ipc.js 用了 inclusiveBeijingDayCount 却没 import,于是这个分支一进就抛
  // ReferenceError —— 而它只在"存在更早数据"时才走,恰好是提示唯一该出现的场景。
  // 复现条件:重建得到的最早日期早于 retentionStartDay(historyDays)。
  codexRuntime = {
    rebuildCalls: [],
    rebuild(opts) {
      this.rebuildCalls.push(opts);
      return Promise.resolve({ daysRebuilt: 60, earliestDate: '2026-01-05', passes: 1, records: 9, bytesRead: 9 });
    }
  };
  const deps = buildDeps({ store: makeFakeStore({ data: { historyDays: 7 } }) });
  setupIPC(deps);
  const handler = fakeIpc.handleMap.get('sync:history');
  const summary = await handler({ sender: { send: () => {} } });

  assert.ok(summary.retentionHint, '应给出保留窗口提示: ' + JSON.stringify(summary));
  assert.equal(summary.retentionHint.historyDays, 7);
  assert.equal(summary.retentionHint.earliestDate, '2026-01-05');
  // 建议天数 = 从最早数据到今天的天数(含首尾),必须是个正数且大于当前保留天数
  assert.ok(Number.isInteger(summary.retentionHint.suggestedDays), 'suggestedDays 必须是整数');
  assert.ok(summary.retentionHint.suggestedDays > 7, String(summary.retentionHint.suggestedDays));
});

test('sync:history 处理器编排三路同步并刷新仪表盘(源代码守卫)', () => {
  const ipcSource = fs.readFileSync(path.resolve(__dirname, '../src/main/ipc.js'), 'utf8');
  // 用了就必须 import:这条守卫专门盯"符号未导入"这类只在特定分支炸的缺陷
  if (/inclusiveBeijingDayCount\(/.test(ipcSource)) {
    assert.match(ipcSource, /require\('\.\/core\/beijing-calendar'\)[\s\S]*inclusiveBeijingDayCount|inclusiveBeijingDayCount[\s\S]*require\('\.\/core\/beijing-calendar'\)/);
  }
  assert.match(ipcSource, /ipcMain\.handle\('sync:history'/);
  assert.match(ipcSource, /require\('\.\/core\/history-sync'\)/);
  assert.match(ipcSource, /syncDeepSeekHistory\(/);
  assert.match(ipcSource, /rescanLocalLogs\(/);
  assert.match(ipcSource, /codexUsageRuntime/);
  assert.match(ipcSource, /providers\.deepseek\.sessionToken/);
  assert.match(ipcSource, /sync:progress/);
  assert.match(ipcSource, /retentionHint/);
  assert.match(ipcSource, /pollAll\(\)/);
  assert.match(ipcSource, /retainAll: true/);
  assert.match(ipcSource, /deleteStore/);
});

test('preload 白名单放行 sync:history 与 sync:progress', () => {
  assert.match(preloadSource, /'sync:history'/);
  assert.match(preloadSource, /'sync:progress'/);
});
