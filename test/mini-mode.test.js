const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMiniMode,
  MINI_WIDTH,
  MINI_HEIGHT,
  NORMAL_MIN_WIDTH,
  NORMAL_MIN_HEIGHT
} = require('../src/main/core/mini-mode');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function makeStore(initial) {
  const data = Object.assign({}, initial);
  return {
    get: (k) => data[k],
    set: (k, v) => { data[k] = v; },
    delete: (k) => { delete data[k]; },
    _data: data
  };
}

function makeWindow(bounds) {
  return {
    bounds: Object.assign({}, bounds),
    minSize: null,
    destroyed: false,
    setBoundsCalls: [],
    getBounds() { return Object.assign({}, this.bounds); },
    setBounds(b) { this.bounds = Object.assign({}, b); this.setBoundsCalls.push(Object.assign({}, b)); },
    setMinimumSize(w, h) { this.minSize = [w, h]; },
    maxSize: null,
    setMaximumSize(w, h) { this.maxSize = [w, h]; },
    resizable: true,
    setResizable(v) { this.resizable = v; },
    webContents: {
      zoom: 1,
      getZoomFactor() { return this.zoom; },
      setZoomFactor(v) { this.zoom = v; }
    },
    isDestroyed() { return this.destroyed; }
  };
}

function makeHarness(options) {
  const opts = options || {};
  const store = makeStore(opts.storeInitial || { 'window.miniMode': false, 'window.miniBounds': null });
  const win = makeWindow(opts.bounds || { x: 100, y: 100, width: 420, height: 680 });
  const calls = { applySettings: 0, broadcast: 0, persist: 0, dockDisable: 0, toggled: 0 };
  const mini = createMiniMode({
    store,
    getMainWindow: () => win,
    getEdgeDock: () => opts.edgeDock || null,
    // 尺寸缓动:默认关掉(同步生效),让既有断言不受时序影响;
    // 专门测"动画真的插了中间帧"的那条用例自己传 animateMs。
    animateMs: opts.animateMs === undefined ? 0 : opts.animateMs,
    tokenSpeedRuntime: { applySettings: () => { calls.applySettings += 1; } },
    broadcastSettings: () => { calls.broadcast += 1; },
    onToggled: () => { calls.toggled += 1; },
    persistBounds: () => {
      calls.persist += 1;
      const b = win.getBounds();
      store.set('window.x', b.x);
      store.set('window.y', b.y);
      store.set('window.width', b.width);
      store.set('window.height', b.height);
    }
  });
  return { store, win, calls, mini };
}

test('enter persists normal bounds, shrinks window, enables speed sampling', async () => {
  const { store, win, calls, mini } = makeHarness();
  const result = mini.enter();
  assert.equal(result, true);
  assert.equal(mini.isActive(), true);
  // 正常 bounds 已落盘
  assert.deepEqual(
    [store.get('window.x'), store.get('window.y'), store.get('window.width'), store.get('window.height')],
    [100, 100, 420, 680]
  );
  assert.deepEqual(win.minSize, [MINI_WIDTH, MINI_HEIGHT]);
  assert.deepEqual(win.maxSize, [MINI_WIDTH, MINI_HEIGHT]);
  assert.equal(win.resizable, false);
  assert.deepEqual(win.bounds, { x: 100, y: 100, width: MINI_WIDTH, height: MINI_HEIGHT });
  assert.equal(calls.persist, 1);
  // 速度采样与托盘菜单被推迟到**动画之后的一拍**(它们会阻塞主进程,夹在动画中间会让缓动卡住 ——
  // 实测缩小的中间帧全被跳过)。所以这里必须等一拍再断言,不能立刻读。
  await delay(10);
  assert.equal(calls.applySettings, 1);
  assert.equal(calls.broadcast, 1);
  assert.equal(calls.toggled, 1);
});

test('进入/退出迷你都是缓动,不是一次硬跳变(Windows 上 setBounds(bounds, animate) 不生效)', async () => {
  const { win, mini, calls } = makeHarness({ animateMs: 40 });
  // 用户滚轮缩放过:小窗强制 zoom=1,但这必须在**动画结束后**才生效,
  // 否则内容会在动画起点先重排一次(那就又是"两段式"了)
  win.webContents.zoom = 0.8;
  const startedWidth = win.bounds.width;
  win.setBoundsCalls.length = 0;
  mini.enter();
  // 动画途中:内容还没换(广播要等窗口到位)、缩放还没改
  assert.equal(calls.broadcast, 0, '窗口还没收拢,不该先把内容换掉');
  assert.equal(win.webContents.zoom, 0.8, '窗口还没收拢,不该先改缩放');
  await delay(400);
  const widths = win.setBoundsCalls.map((b) => b.width);
  assert.ok(widths.length >= 3, '必须插出多帧,实际只有 ' + JSON.stringify(widths));
  assert.ok(
    widths.some((w) => w > MINI_WIDTH && w < startedWidth),
    '必须出现中间尺寸(否则还是一次硬跳变):' + JSON.stringify(widths)
  );
  assert.deepEqual(win.bounds, { x: 100, y: 100, width: MINI_WIDTH, height: MINI_HEIGHT });
  // 上限在动画结束后才收紧 —— 动画期间先收紧会让 setMaximumSize 立刻把窗口压扁,动画就没了
  assert.deepEqual(win.maxSize, [MINI_WIDTH, MINI_HEIGHT]);
  assert.equal(calls.broadcast, 1, '窗口到位后才通知渲染层切视图');
  assert.equal(win.webContents.zoom, 1, '窗口到位后才把缩放压到 1');

  win.setBoundsCalls.length = 0;
  mini.exit();
  assert.equal(win.webContents.zoom, 1, '退出途中缩放还没恢复');
  await delay(400);
  const backWidths = win.setBoundsCalls.map((b) => b.width);
  assert.ok(
    backWidths.some((w) => w > MINI_WIDTH && w < 420),
    '退出也要有中间帧:' + JSON.stringify(backWidths)
  );
  assert.deepEqual(win.bounds, { x: 100, y: 100, width: 420, height: 680 });
  // 下限同理:动画结束后才恢复,否则 setMinimumSize 会立刻把窗口撑大
  assert.deepEqual(win.minSize, [380, 200]);
  assert.equal(win.webContents.zoom, 0.8, '窗口撑回原尺寸后才恢复用户缩放');
  assert.equal(calls.broadcast, 2);
});

test('exit disables edge dock when docked in mini mode', () => {
  const dock = {
    meta: { edge: 'right', expandedBounds: { x: 0, y: 0, width: 200, height: 172 } },
    disabled: false,
    getDockMeta() { return this.meta; },
    disable() { this.disabled = true; this.meta = null; }
  };
  const { mini } = makeHarness({ edgeDock: dock });
  mini.enter();
  mini.exit();
  assert.equal(dock.disabled, true);
});

test('enter uses remembered mini position but current mini size', () => {
  const { win, mini } = makeHarness({
    storeInitial: {
      'window.miniMode': false,
      'window.miniBounds': { x: 500, y: 300, width: 320, height: 228 }
    }
  });
  mini.enter();
  assert.deepEqual(win.bounds, { x: 500, y: 300, width: MINI_WIDTH, height: MINI_HEIGHT });
});

test('exit restores normal bounds and min size', async () => {
  const { store, win, mini } = makeHarness();
  mini.enter();
  // 迷你期间用户拖动了窗口
  win.setBounds({ x: 700, y: 50, width: MINI_WIDTH, height: MINI_HEIGHT });
  const result = mini.exit();
  // setBounds 在退出时推迟一拍(Windows 尺寸钳制竞态),等它落地
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(result, true);
  assert.equal(mini.isActive(), false);
  assert.deepEqual(win.minSize, [NORMAL_MIN_WIDTH, NORMAL_MIN_HEIGHT]);
  assert.deepEqual(win.maxSize, [2400, 1600]);
  assert.equal(win.resizable, true);
  assert.deepEqual(win.bounds, { x: 100, y: 100, width: 420, height: 680 });
  assert.equal(store.get('window.miniMode'), false);
});

test('toggle flips state', () => {
  const { mini } = makeHarness();
  assert.equal(mini.toggle(), true);
  assert.equal(mini.toggle(), false);
});

test('enter disables edge dock when docked', () => {
  const dock = {
    meta: { edge: 'right', expandedBounds: { x: 0, y: 0, width: 420, height: 680 } },
    disabled: false,
    getDockMeta() { return this.meta; },
    disable() { this.disabled = true; this.meta = null; }
  };
  const { mini } = makeHarness({ edgeDock: dock });
  mini.enter();
  assert.equal(dock.disabled, true);
});

test('applyOnCreate only applies when persisted mini mode is on', () => {
  const off = makeHarness();
  assert.equal(off.mini.applyOnCreate(off.win), false);
  assert.equal(off.win.minSize, null);

  const on = makeHarness({
    storeInitial: {
      'window.miniMode': true,
      'window.miniBounds': { x: 10, y: 20, width: 320, height: 228 }
    }
  });
  assert.equal(on.mini.applyOnCreate(on.win), true);
  assert.deepEqual(on.win.minSize, [MINI_WIDTH, MINI_HEIGHT]);
  assert.deepEqual(on.win.bounds, { x: 10, y: 20, width: MINI_WIDTH, height: MINI_HEIGHT });
});

test('mini mode forces zoom 1 and restores it on exit', () => {
  const { win, mini } = makeHarness();
  win.webContents.setZoomFactor(0.7);
  mini.enter();
  assert.equal(win.webContents.getZoomFactor(), 1);
  mini.exit();
  assert.equal(win.webContents.getZoomFactor(), 0.7);
});

test('enter/exit are no-ops without a live window', () => {
  const store = makeStore({ 'window.miniMode': false });
  const mini = createMiniMode({ store, getMainWindow: () => null });
  assert.equal(mini.enter(), false);
  assert.equal(mini.isActive(), false);
});
