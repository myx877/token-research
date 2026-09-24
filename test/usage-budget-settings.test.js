// 预算字段(百分比的分母)是整套窗口卡的"地基":
// 字段必须在设置里可见、键必须落在可写白名单内(否则填了存不进去)、每个平台每个窗口都要有。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const settingsRegistry = require('../src/renderer/js/layout/component-registry.js');
const { isWritableSettingKey } = require('../src/main/core/settings-security');
const { CURRENCY } = require('../src/main/core/usage-buckets');

function loadDefinitions() {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../src/renderer/js/settings-definitions.js'),
    'utf8'
  );
  const context = { window: { ComponentRegistry: settingsRegistry } };
  vm.runInNewContext(source, context, { filename: 'settings-definitions.js' });
  return Array.from(context.window.SettingsDefinitions);
}

const definitions = loadDefinitions();
const budgetFields = definitions.filter((d) => d.group === '预算');
const amountFields = budgetFields.filter((d) => d.key.indexOf('data.usageBudget.') === 0);
const tokenFields = budgetFields.filter((d) => d.key.indexOf('data.usageBudgetTokens.') === 0);

const PLATFORMS = ['deepseek', 'codex', 'kimi', 'dsh', 'claude', 'opencode'];
const WINDOWS = ['day', 'week', 'month'];

test('预算字段:6 个平台 × 3 个窗口 × (金额 / Token)= 36 个', () => {
  assert.equal(amountFields.length, PLATFORMS.length * WINDOWS.length, '金额预算应为 18 个');
  assert.equal(tokenFields.length, PLATFORMS.length * WINDOWS.length, 'Token 预算应为 18 个');
  assert.equal(budgetFields.length, PLATFORMS.length * WINDOWS.length * 2);
  const keys = budgetFields.map((d) => d.key).sort();
  const expected = [];
  PLATFORMS.forEach((p) => WINDOWS.forEach((w) => {
    expected.push('data.usageBudget.' + p + '.' + w);
    expected.push('data.usageBudgetTokens.' + p + '.' + w);
  }));
  assert.deepEqual(keys, expected.sort());
});

test('预算字段:都是数字输入、有占位提示、且**常显**(不再挂组件可见性门禁)', () => {
  budgetFields.forEach((d) => {
    assert.equal(d.type, 'number', d.key);
    assert.equal(d.default, '', d.key);
    // 注意:字段对象来自 VM 上下文,不能对它做 deepEqual(跨 realm 原型不同必然不等)
    // 曾经这里是 visibleWhen === components.usageSummary,而那个键从来没有默认值、也没有写入方
    // ⇒ 新装/恢复默认的用户整组预算字段被藏掉(真 bug,已删除门禁,见审查 P0-2)
    assert.equal(d.visibleWhen, undefined, d.key + ' 不应再挂可见性门禁');
    assert.ok(d.label.length > 0, d.key);
  });
  // 两种字段的占位文案必须能区分"只按金额"和"完全没预算",否则用户不知道自己填的是什么
  amountFields.forEach((d) => assert.match(d.placeholder, /留空则不显示百分比/, d.key));
  tokenFields.forEach((d) => assert.match(d.placeholder, /留空则只用金额预算/, d.key));

  const labels = budgetFields.map((d) => d.label);
  ['DeepSeek 每日预算（¥）', 'opencode 每月预算（$）', 'Claude Code 每周预算（¥）', 'DSH 每日预算（¥）'].forEach((l) => {
    assert.ok(labels.indexOf(l) >= 0, '缺少 ' + l + ' → ' + JSON.stringify(labels));
  });
  // Token 预算:标签必须带 "Token 预算" 字样,否则和金额预算卡片在设置页里长得一样
  ['DeepSeek 每日 Token 预算', 'opencode 每月 Token 预算', 'Claude Code 每周 Token 预算'].forEach((l) => {
    assert.ok(labels.indexOf(l) >= 0, '缺少 ' + l + ' → ' + JSON.stringify(labels));
  });
});

test('预算字段的键落在可写白名单内(设置面板填的值能真的存进 store)', () => {
  budgetFields.forEach((d) => {
    assert.equal(isWritableSettingKey(d.key), true, d.key + ' 不在可写白名单内,填了会存不进去');
  });
  // 反向:确保白名单不是"什么都放行"
  assert.equal(isWritableSettingKey('data.usageBudget.__proto__.day'), false);
  assert.equal(isWritableSettingKey('data.usageBudgetTokens.__proto__.day'), false);
  assert.equal(isWritableSettingKey('arbitrary.key'), false);
});

test('金额预算字段的币种口径与用量汇总的 CURRENCY 一致(标签里的币种符号不能写错)', () => {
  const SYMBOL = { CNY: '¥', USD: '$' };
  // 与渲染端 providers-meta.js 的 label 对齐(那边是 ESM,这里显式列出以免测试跟着实现一起漂)
  const LABEL = {
    deepseek: 'DeepSeek', codex: 'Codex', kimi: 'Kimi',
    dsh: 'DSH', claude: 'Claude Code', opencode: 'opencode'
  };
  amountFields.forEach((d) => {
    const parts = d.key.split('.');
    const provider = parts[2];
    const win = parts[3];
    const currency = CURRENCY[provider];
    assert.ok(currency, provider + ' 在 usage-buckets.CURRENCY 里没有币种定义');
    assert.ok(d.label.indexOf(LABEL[provider] + ' ') === 0, d.key + ' 标签平台名不符 → ' + d.label);
    assert.ok(d.label.indexOf(SYMBOL[currency]) >= 0, d.key + ' 标签币种应为 ' + currency + ' → ' + d.label);
    assert.ok(d.label.indexOf(win === 'day' ? '每日' : win === 'week' ? '每周' : '每月') >= 0, d.key);
  });
  // Token 预算与币种无关:标签里**不该**出现货币符号,否则会让人以为要按钱填
  tokenFields.forEach((d) => {
    assert.ok(!/[¥$]/.test(d.label), d.key + ' 是 Token 预算,标签不该带货币符号 → ' + d.label);
  });
});
