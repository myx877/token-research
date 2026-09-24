// 「凭据就绪」白名单的纯函数单测。
//
// 这是标题栏标签栏、选择页状态文案、卡片凭证提示三处共用的一份判定。
// 它一旦有分叉,表现就是"选择页说已配置、标签栏里却没有它"这类无法解释的不一致。
const test = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../renderer/src/lib/provider-credentials.mjs');

test('DeepSeek 白名单只看 apiKeySet:填了 Key 还没登录平台也算就绪', async () => {
  const m = await load();
  // 需求原话是"只有我输入过 api_key 的选项可以相互切换"。
  // 若这里改成要求 sessionToken,"刚填完 Key 就被告知不能切换"就会立刻复现。
  assert.equal(m.STATE_READY, 'ready');
  assert.equal(m.STATE_MISSING, 'missing');
  assert.equal(m.STATE_EXPIRED, 'expired');
  assert.equal(m.credentialStateFor('deepseek', { apiKeySet: true, loggedIn: false }), m.STATE_READY);
  assert.equal(m.isCredentialReady('deepseek', { apiKeySet: true, loggedIn: false }), true);
  assert.equal(m.credentialStateFor('deepseek', { apiKeySet: true, loggedIn: true }), m.STATE_READY);
  assert.equal(m.credentialStateFor('deepseek', { apiKeySet: false, loggedIn: true }), m.STATE_MISSING);
});

test('codex/kimi 看主进程 authStatus:ok 就绪;过期/缺失/未知一律不就绪', async () => {
  const m = await load();
  assert.equal(m.credentialStateFor('codex', { statusById: { codex: 'ok' } }), m.STATE_READY);
  assert.equal(m.credentialStateFor('codex', { statusById: { codex: 'expired' } }), m.STATE_EXPIRED);
  assert.equal(m.credentialStateFor('kimi', { statusById: { kimi: 'missing' } }), m.STATE_MISSING);
  // 快照还没到(undefined)按 missing:宁可晚一帧出现,也不把"未知"当成"可用"
  assert.equal(m.credentialStateFor('kimi', { statusById: {} }), m.STATE_MISSING);
  assert.equal(m.credentialStateFor('codex', null), m.STATE_MISSING);
});

test('读本机日志的三个平台恒就绪(零凭证)', async () => {
  const m = await load();
  ['dsh', 'claude', 'opencode'].forEach((id) => {
    assert.equal(m.credentialStateFor(id, {}), m.STATE_READY, id + ' 应该零凭证就绪');
    assert.equal(m.credentialStateFor(id, null), m.STATE_READY, id + ' 在快照缺失时也应就绪');
  });
});

test('readyProviderIds 只做过滤:保持传入顺序,不重排、不丢失', async () => {
  const m = await load();
  const ids = ['deepseek', 'codex', 'kimi', 'dsh', 'claude', 'opencode'];
  assert.deepEqual(
    m.readyProviderIds(ids, { apiKeySet: false, statusById: { codex: 'ok', kimi: 'missing' } }),
    ['codex', 'dsh', 'claude', 'opencode']
  );
  assert.deepEqual(m.readyProviderIds([], {}), []);
  assert.deepEqual(m.readyProviderIds(null, {}), []);
});

test('状态文案不漂移(harness 与真机走查都在断言这几条原文)', async () => {
  const m = await load();
  assert.match(m.providerStatusText('deepseek', { apiKeySet: false }).text, /需要 API Key/);
  assert.match(m.providerStatusText('opencode', {}).text, /无需凭证/);
  assert.equal(m.providerStatusText('codex', { statusById: { codex: 'expired' } }).text, '本机 CLI 凭证已过期');
  assert.equal(m.providerStatusText('kimi', { statusById: { kimi: 'missing' } }).text, '本机 CLI 凭证缺失');
  assert.equal(m.providerStatusText('codex', { statusById: { codex: 'ok' } }).tone, 'ok');
  assert.equal(m.providerStatusText('codex', { statusById: { codex: 'expired' } }).tone, 'warn');
  assert.equal(m.providerStatusText('deepseek', { apiKeySet: false }).tone, 'warn');
});

test('凭据提示块:缺什么给什么,但绝不产出"拦截"(数据照常出)', async () => {
  const m = await load();
  assert.deepEqual(m.credentialNoticeFor('deepseek', { apiKeySet: false }), { kind: 'api-key' });
  assert.deepEqual(m.credentialNoticeFor('deepseek', { apiKeySet: true, loggedIn: false }), { kind: 'session' });
  assert.equal(m.credentialNoticeFor('deepseek', { apiKeySet: true, loggedIn: true }), null);
  const codex = m.credentialNoticeFor('codex', { statusById: { codex: 'expired' } });
  assert.equal(codex.kind, 'local-cli');
  assert.match(codex.hint, /codex CLI/);
  const kimi = m.credentialNoticeFor('kimi', { statusById: { kimi: 'missing' } });
  assert.match(kimi.hint, /Kimi CLI/);
  // 零凭证的平台任何情况下都不提示
  ['dsh', 'claude', 'opencode'].forEach((id) => {
    const snapshot = { statusById: {} };
    snapshot.statusById[id] = 'missing';
    assert.equal(m.credentialNoticeFor(id, snapshot), null, id + ' 不该有任何凭证提示');
  });
});
