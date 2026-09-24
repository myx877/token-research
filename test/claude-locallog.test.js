const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseClaudeLine,
  readLocalLog,
  claudeLogAvailable
} = require('../src/main/providers/claude/locallog');
const { localDayStr } = require('../src/main/core/locallog');

// 与主进程 store 同语义的点路径读写(独立于 electron)
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
  // 必须按点路径展开初始键(与 electron-store 的 get/set 语义一致):
  // 直接把 'providers.claude.logRoot' 当扁平键存,provider 读不到设置会回落到真实 ~/.claude。
  const data = {};
  Object.keys(initial || {}).forEach((key) => {
    setPath(data, key, JSON.parse(JSON.stringify(initial[key])));
  });
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
    },
    raw: data
  };
}

const TS = Date.parse('2026-09-17T03:00:00.000Z');
const DAY = localDayStr(TS);

function line(overrides) {
  return JSON.stringify(Object.assign({
    type: 'assistant',
    timestamp: new Date(TS).toISOString(),
    sessionId: 'sess-1',
    message: {
      id: 'msg-1',
      model: 'deepseek-v4-flash',
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 1000,
        output_tokens: 50
      }
    }
  }, overrides));
}

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'claude-log-'));
}

test('parseClaudeLine 按 dsh 约定映射四桶:input=输入+缓存写入、cached=缓存读取', () => {
  const diagnostics = {};
  const record = parseClaudeLine(line(), diagnostics, TS + 1000);
  assert.equal(record.ts, TS);
  assert.equal(record.model, 'deepseek-v4-flash');
  assert.equal(record.currency, 'CNY');
  assert.deepEqual(record.usage, { input: 120, cached: 1000, output: 50, total: 1170 });
  assert.equal(record.eventFingerprint, 'claude:msg-1');
});

test('parseClaudeLine 跳过 synthetic 与全零行,并拒绝缺 id / 坏时间戳', () => {
  const diagnostics = {};
  assert.equal(parseClaudeLine(line({ message: { id: 'm', model: '<synthetic>', usage: { input_tokens: 5 } } }), diagnostics, TS), null);
  assert.equal(parseClaudeLine(line({ message: { id: 'm', model: 'x', usage: {} } }), diagnostics, TS), null);
  assert.equal(parseClaudeLine(line({ message: { model: 'x', usage: { input_tokens: 5 } } }), diagnostics, TS), null);
  assert.equal(parseClaudeLine(line({ timestamp: 'not-a-date' }), diagnostics, TS), null);
  assert.equal(parseClaudeLine('{not json', diagnostics, TS), null);
  assert.equal(diagnostics.syntheticRow, 1);
  assert.equal(diagnostics.zeroUsageRow, 1);
  assert.equal(diagnostics.missingMessageId, 1);
  assert.equal(diagnostics.invalidTimestamp, 1);
  assert.equal(diagnostics.invalidJson, 1);
});

test('已知模型按定价表折算金额,未知模型一律无金额(不回落默认档)', () => {
  const diagnostics = {};
  const known = parseClaudeLine(line(), diagnostics, TS);
  // deepseek-v4-flash: input 0.0005 / output 0.002 / cache_hit 0.00005(¥ 每 1000 token)
  const expected = (120 / 1000) * 0.0005 + (50 / 1000) * 0.002 + (1000 / 1000) * 0.00005;
  assert.ok(Math.abs(known.cost - expected) < 1e-12);

  const unknown = parseClaudeLine(
    line({ message: { id: 'm2', model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 10 } } }),
    diagnostics,
    TS
  );
  assert.equal(unknown.cost, null);
  assert.equal(diagnostics.unknownModel, 1);
});

test('readLocalLog 去重同一 message.id(一次响应写多行),只计一次', async () => {
  const root = tmpRoot();
  const file = path.join(root, 'sess.jsonl');
  // 同一条 API 响应的两行:message.id 与 usage 完全相同
  fs.writeFileSync(file, line() + '\n' + line() + '\n', 'utf8');

  const store = makeStore({ 'providers.claude.logRoot': root, data: { historyDays: 30 } });
  const diagnostics = {};
  const batch = await readLocalLog({ store }, { diagnostics, nowMs: TS + 1000 });

  assert.equal(batch.records.length, 1);
  assert.equal(diagnostics.duplicateEvent, 1);
  assert.deepEqual(store.get('usageDaily')['claude:' + DAY], {
    input: 120, cached: 1000, output: 50, total: 1170
  });
  const expectedCost = (120 / 1000) * 0.0005 + (50 / 1000) * 0.002 + (1000 / 1000) * 0.00005;
  assert.ok(Math.abs(store.get('usageDailyCost')['claude:' + DAY] - expectedCost) < 1e-12);
});

test('readLocalLog 增量:重复扫描不重复累加,新增行只并入一次', async () => {
  const root = tmpRoot();
  const file = path.join(root, 'sess.jsonl');
  fs.writeFileSync(file, line() + '\n', 'utf8');
  const store = makeStore({ 'providers.claude.logRoot': root, data: { historyDays: 30 } });

  await readLocalLog({ store }, { diagnostics: {}, nowMs: TS + 1000 });
  const first = store.get('usageDaily')['claude:' + DAY].total;
  assert.equal(first, 1170);

  // 二次扫描:游标已到文件末尾,无新增
  const second = await readLocalLog({ store }, { diagnostics: {}, nowMs: TS + 2000 });
  assert.equal(second.records.length, 0);
  assert.equal(store.get('usageDaily')['claude:' + DAY].total, 1170);

  // 追加一条新消息(不同 id)
  const next = JSON.parse(line());
  next.message.id = 'msg-2';
  fs.appendFileSync(file, JSON.stringify(next) + '\n', 'utf8');
  const third = await readLocalLog({ store }, { diagnostics: {}, nowMs: TS + 3000 });
  assert.equal(third.records.length, 1);
  assert.equal(store.get('usageDaily')['claude:' + DAY].total, 2340);
});

test('readLocalLog 在根目录缺失时返回空批次且不写入任何键', async () => {
  const store = makeStore({ 'providers.claude.logRoot': path.join(os.tmpdir(), 'claude-missing-' + Date.now()) });
  const batch = await readLocalLog({ store }, { diagnostics: {}, nowMs: TS });
  assert.deepEqual(batch, { records: [], complete: true, bytesRead: 0 });
  assert.equal(store.get('usageDaily'), undefined);
  assert.equal(claudeLogAvailable(store), false);
});
