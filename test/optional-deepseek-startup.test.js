const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const policyPath = path.join(root, 'src', 'main', 'core', 'startup-windows.js');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function loadPolicy() {
  assert.equal(fs.existsSync(policyPath), true, 'startup window policy module must exist');
  delete require.cache[require.resolve(policyPath)];
  return require(policyPath);
}

function makeWindow() {
  return {
    closed: false,
    destroyed: false,
    focused: false,
    shown: false,
    close() { this.closed = true; },
    focus() { this.focused = true; },
    isDestroyed() { return this.destroyed; },
    show() { this.shown = true; }
  };
}

test('Codex-only, Kimi-only, and no-credential users can skip DeepSeek into a new main window', () => {
  const { skipDeepseekLogin } = loadPolicy();

  for (const scenario of ['Codex-only', 'Kimi-only', 'no credentials']) {
    const login = makeWindow();
    let main = null;
    let creates = 0;

    const result = skipDeepseekLogin({
      getLoginWindow: () => login,
      getMainWindow: () => main,
      createMainWindow() {
        creates += 1;
        main = makeWindow();
      }
    });

    assert.equal(login.closed, true, `${scenario} must close only the optional prompt`);
    assert.equal(creates, 1, `${scenario} must create the main window`);
    assert.equal(main.shown, true, `${scenario} must show the main window`);
    assert.equal(main.focused, true, `${scenario} must focus the main window`);
    assert.equal(result, main);
  }
});

test('skipping DeepSeek reuses an existing main window without creating a duplicate', () => {
  const { skipDeepseekLogin } = loadPolicy();
  const login = makeWindow();
  const main = makeWindow();
  let creates = 0;

  const result = skipDeepseekLogin({
    getLoginWindow: () => login,
    getMainWindow: () => main,
    createMainWindow() { creates += 1; }
  });

  assert.equal(login.closed, true);
  assert.equal(creates, 0);
  assert.equal(main.shown, true);
  assert.equal(main.focused, true);
  assert.equal(result, main);
});

test('skipping DeepSeek replaces a destroyed main window before showing it', () => {
  const { skipDeepseekLogin } = loadPolicy();
  const destroyed = makeWindow();
  destroyed.destroyed = true;
  let main = destroyed;
  let creates = 0;

  const result = skipDeepseekLogin({
    getLoginWindow: () => null,
    getMainWindow: () => main,
    createMainWindow() {
      creates += 1;
      main = makeWindow();
    }
  });

  assert.equal(creates, 1);
  assert.notEqual(result, destroyed);
  assert.equal(result.shown, true);
  assert.equal(result.focused, true);
});

test('a failed main-window creation leaves the optional DeepSeek prompt open', () => {
  const { skipDeepseekLogin } = loadPolicy();
  const login = makeWindow();

  assert.throws(
    () => skipDeepseekLogin({
      getLoginWindow: () => login,
      getMainWindow: () => null,
      createMainWindow() {
        throw Object.assign(new Error('renderer unavailable'), { code: 'CREATE_MAIN_FAILED' });
      }
    }),
    (error) => error && error.code === 'CREATE_MAIN_FAILED'
  );
  assert.equal(login.closed, false);
});

test('login skip uses a dedicated allow-listed IPC path and delegates to the window policy', () => {
  const loginSource = read('src/renderer/js/login.js');
  const preloadSource = read('src/preload/preload.js');
  const ipcSource = read('src/main/ipc.js');

  const skipHandler = loginSource.match(/skipBtn\.addEventListener[\s\S]*?\n\}\);/)?.[0] || '';
  assert.match(skipHandler, /send\('login:skip'\)/);
  assert.doesNotMatch(skipHandler, /window:close/);
  assert.match(preloadSource, /'login:skip'/);
  assert.match(ipcSource, /require\('\.\/core\/startup-windows'\)/);
  assert.match(ipcSource, /ipcMain\.on\('login:skip',[\s\S]*skipDeepseekLogin/);
});

/* ======== 免凭证启动:开窗决策(纯函数) ======== */

// apiKey × sessionToken 四种组合
const STARTUP_COMBOS = [
  {
    name: '有 Key + 有 session',
    input: { apiKey: 'sk-abcdef', sessionToken: 'session-1' },
    expect: { main: true, apiKeyWindow: false, sessionWindow: false, balancePoll: true, usagePoll: true }
  },
  {
    name: '有 Key + 无 session',
    input: { apiKey: 'sk-abcdef', sessionToken: null },
    expect: { main: true, apiKeyWindow: false, sessionWindow: false, balancePoll: true, usagePoll: false }
  },
  {
    name: '无 Key + 有 session',
    input: { apiKey: null, sessionToken: 'session-1' },
    expect: { main: true, apiKeyWindow: false, sessionWindow: false, balancePoll: false, usagePoll: true }
  },
  {
    name: '无 Key + 无 session(完全免凭证)',
    input: { apiKey: null, sessionToken: null },
    expect: { main: true, apiKeyWindow: false, sessionWindow: false, balancePoll: false, usagePoll: false }
  }
];

STARTUP_COMBOS.forEach((combo) => {
  test('启动开窗清单:' + combo.name, () => {
    const { decideStartupWindows } = loadPolicy();
    assert.deepEqual(decideStartupWindows(combo.input), combo.expect);
  });
});

test('无凭证也开主窗:登录窗一律不作为启动门槛', () => {
  const { decideStartupWindows } = loadPolicy();
  STARTUP_COMBOS.forEach((combo) => {
    const plan = decideStartupWindows(combo.input);
    assert.equal(plan.main, true, combo.name + ' 应仍创建主窗');
    assert.equal(plan.apiKeyWindow, false, combo.name + ' 不应把填 Key 窗当启动门槛');
    assert.equal(plan.sessionWindow, false, combo.name + ' 不应在启动时自动弹平台登录窗');
  });
});

test('启动开窗决策:空白串/空串/非字符串/缺省 一律按「无凭证」处理', () => {
  const { decideStartupWindows } = loadPolicy();
  const absent = { main: true, apiKeyWindow: false, sessionWindow: false, balancePoll: false, usagePoll: false };
  [{}, undefined, null, { apiKey: '', sessionToken: '' }, { apiKey: '  ', sessionToken: '\t' },
    { apiKey: 0, sessionToken: 0 }, { apiKey: false, sessionToken: {} }, { apiKey: [], sessionToken: [] }]
    .forEach((input) => {
      assert.deepEqual(decideStartupWindows(input), absent, JSON.stringify(input) + ' 应视为无凭证');
    });
});

test('启动开窗决策:返回键集固定且不修改入参', () => {
  const { decideStartupWindows } = loadPolicy();
  assert.deepEqual(
    Object.keys(decideStartupWindows({ apiKey: 'sk-x' })).sort(),
    ['apiKeyWindow', 'balancePoll', 'main', 'sessionWindow', 'usagePoll']
  );
  const input = { apiKey: 'sk-abcdef', sessionToken: 'session-1' };
  const snapshot = JSON.stringify(input);
  decideStartupWindows(input);
  assert.equal(JSON.stringify(input), snapshot);
});

test('启动开窗策略不依赖 electron(纯 node 可加载)', () => {
  const policySource = read('src/main/core/startup-windows.js');
  assert.doesNotMatch(policySource, /require\(\s*['"]electron['"]\s*\)/);
});

test('启动路径真的用决策结果,且两种登录窗都留了按需入口', () => {
  const indexSource = read('src/main/index.js');

  // 决策函数必须参与启动分支(防"写了纯函数但没人用")
  assert.match(indexSource, /const startupPlan = decideStartupWindows\(/);
  assert.match(indexSource, /if \(startupPlan\.main\) createMainWindow\(\)/);
  assert.match(indexSource, /if \(startupPlan\.balancePoll\) scheduler\.poll\('deepseek', 'balance'\)/);
  assert.match(indexSource, /startupPlan\.usagePoll && getSessionSnapshot\(runtime\)\.loggedIn/);

  // 启动路径不得再直接开登录窗;两者各自保留按需入口
  assert.doesNotMatch(indexSource, /else \{\s*createLoginWindow\(\);/);
  assert.match(indexSource, /label: '设置 DeepSeek API Key…',\s*\n\s*click: \(\) => openApiKeyWindow\(\)/);
  assert.match(indexSource, /function openApiKeyWindow\(\)[\s\S]*createLoginWindow\(\);/);
  assert.match(indexSource, /label: getTraySessionLabel\(getSessionSnapshot\(runtime\)\),\s*\n\s*click: \(\) => createSessionWindow\(\)/);
});
