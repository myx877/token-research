const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const {
  readLocalLog,
  parseOpencodeMessage,
  opencodeDbAvailable
} = require('../src/main/providers/opencode/usage-db');
const { localDayStr } = require('../src/main/core/locallog');

const TS1 = Date.parse('2026-09-16T02:00:00.000Z');
const TS2 = Date.parse('2026-09-17T02:00:00.000Z');

// ---- store 双:与 electron-store 的点路径语义一致 ----
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
    }
  };
}

// v1 message.data / v2 session_message.data 的 assistant 行形状
function assistantData(cost, tokens, created) {
  return JSON.stringify({
    role: 'assistant',
    modelID: 'deepseek-v4-flash',
    providerID: 'deepseek',
    cost: cost,
    tokens: tokens,
    time: { created: created === undefined ? TS1 : created }
  });
}

const TOKENS_V1 = { total: 1170, input: 100, output: 50, reasoning: 10, cache: { read: 1000, write: 20 } };
// v2 的 tokens 没有 total 字段(实测),必须由分量相加
const TOKENS_V2 = { input: 7, output: 3, reasoning: 5, cache: { read: 11, write: 2 } };

function makeDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-db-'));
  const dbPath = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec('create table message (id text primary key, session_id text, time_created integer,'
    + ' time_updated integer, data text)');
  db.exec('create table session_message (id text, session_id text, seq integer, type text,'
    + ' time_created integer, data text)');
  const insertV1 = db.prepare('insert into message values (?, ?, ?, ?, ?)');
  insertV1.run('m1', 's1', TS1, TS1, assistantData(0.5, TOKENS_V1));
  // 非 assistant 行必须被过滤
  insertV1.run('m2', 's1', TS1, TS1, JSON.stringify({ role: 'user', content: 'hi' }));
  // assistant 但无 tokens(如 synthetic)→ 不产生记录
  insertV1.run('m3', 's1', TS1, TS1, JSON.stringify({ role: 'assistant', cost: 0 }));
  const insertV2 = db.prepare('insert into session_message values (?, ?, ?, ?, ?, ?)');
  insertV2.run('n1', 'v2s', 1, 'assistant', TS2, JSON.stringify({
    type: 'assistant',
    model: 'deepseek-v4-flash',
    cost: 0.25,
    tokens: TOKENS_V2,
    time: { created: TS2 }
  }));
  insertV2.run('n2', 'v2s', 2, 'user', TS2, JSON.stringify({ type: 'user', content: 'hello' }));
  db.close();
  return dbPath;
}

test('parseOpencodeMessage:v2 无 tokens.total 时由分量相加,金额非有限值按无金额处理', () => {
  const diagnostics = {};
  const record = parseOpencodeMessage({ cost: 0.25, tokens: TOKENS_V2, modelID: 'deepseek-v4-flash', time: { created: TS2 } }, TS2, diagnostics);
  assert.deepEqual(record.usage, { input: 9, cached: 11, output: 8, total: 28 });
  assert.equal(record.cost, 0.25);
  assert.equal(record.currency, 'USD');
  assert.equal(record.model, 'deepseek-v4-flash');

  const noCost = parseOpencodeMessage({ tokens: TOKENS_V2, time: { created: TS2 } }, TS2, diagnostics);
  assert.equal(noCost.cost, null);

  assert.equal(parseOpencodeMessage({ role: 'user' }, TS2, diagnostics), null);
  assert.equal(parseOpencodeMessage({ tokens: { input: 0, output: 0 } }, TS2, diagnostics), null);
  assert.equal(diagnostics.zeroUsageRow, 1);
});

test('readLocalLog 同时读 v1 message 与 v2 session_message,只取 assistant 行', async () => {
  const dbPath = makeDb();
  const store = makeStore({ 'providers.opencode.dbPath': dbPath });
  const diagnostics = {};
  const batch = await readLocalLog({ store }, { diagnostics, nowMs: TS2 + 1000 });

  assert.equal(batch.records.length, 2);
  const day1 = localDayStr(TS1);
  const day2 = localDayStr(TS2);
  // v1:input=100+20、cached=1000、output=50+10
  assert.deepEqual(store.get('usageDaily')['opencode:' + day1], {
    input: 120, cached: 1000, output: 60, total: 1180
  });
  // v2:input=7+2、cached=11、output=3+5
  assert.deepEqual(store.get('usageDaily')['opencode:' + day2], {
    input: 9, cached: 11, output: 8, total: 28
  });
  // 金额为 opencode 自身记录的真实 cost
  assert.equal(store.get('usageDailyCost')['opencode:' + day1], 0.5);
  assert.equal(store.get('usageDailyCost')['opencode:' + day2], 0.25);
  assert.equal(opencodeDbAvailable(store), true);
});

test('readLocalLog 幂等:二次扫描无新增且不重复累加', async () => {
  const dbPath = makeDb();
  const store = makeStore({ 'providers.opencode.dbPath': dbPath });
  await readLocalLog({ store }, { diagnostics: {}, nowMs: TS2 + 1000 });
  const day2 = localDayStr(TS2);
  const before = store.get('usageDaily')['opencode:' + day2].total;

  const second = await readLocalLog({ store }, { diagnostics: {}, nowMs: TS2 + 2000 });
  assert.equal(second.records.length, 0);
  assert.equal(store.get('usageDaily')['opencode:' + day2].total, before);
});

test('readLocalLog 增量:新增的更新消息被并入一次', async () => {
  const dbPath = makeDb();
  const store = makeStore({ 'providers.opencode.dbPath': dbPath });
  await readLocalLog({ store }, { diagnostics: {}, nowMs: TS2 + 1000 });

  const later = TS2 + 60000;
  const db = new DatabaseSync(dbPath);
  db.prepare('insert into message values (?, ?, ?, ?, ?)')
    .run('m9', 's1', later, later, assistantData(1, TOKENS_V1, later));
  db.close();

  const batch = await readLocalLog({ store }, { diagnostics: {}, nowMs: later + 1000 });
  assert.equal(batch.records.length, 1);
  const day = localDayStr(later);
  // 同一天已有 v2 行的 0.25,合并语义是累加 → 0.25 + 1
  assert.equal(store.get('usageDailyCost')['opencode:' + day], 1.25);
});

test('冷启动一次同步翻页读尽历史:不会只算第一页的金额(本机实测第一页只有 36%)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-page-'));
  const dbPath = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec('create table message (id text primary key, session_id text, time_created integer,'
    + ' time_updated integer, data text)');
  db.exec('create table session_message (id text, session_id text, seq integer, type text,'
    + ' time_created integer, data text)');
  const insert = db.prepare('insert into message values (?, ?, ?, ?, ?)');
  for (let i = 0; i < 5; i += 1) {
    const ts = TS1 + i * 60000;
    insert.run('p' + i, 's1', ts, ts, assistantData(1, TOKENS_V1, ts));
  }
  db.close();

  const store = makeStore({ 'providers.opencode.dbPath': dbPath });
  // rowLimit=2 时,只读一页只能拿到 2 行;正确实现应翻页读全 5 行
  const batch = await readLocalLog({ store }, { diagnostics: {}, rowLimit: 2 });
  assert.equal(batch.records.length, 5);
  const cost = store.get('usageDailyCost') || {};
  const sum = Object.keys(cost).reduce((s, k) => s + cost[k], 0);
  assert.equal(sum, 5);

  // 第二次数值必须不变(翻页不能把重叠窗口内的行重复累加)
  const again = await readLocalLog({ store }, { diagnostics: {}, rowLimit: 2 });
  assert.equal(again.records.length, 0);
  const sum2 = Object.keys(store.get('usageDailyCost') || {}).reduce((s, k) => s + store.get('usageDailyCost')[k], 0);
  assert.equal(sum2, 5);
});

test('数据库缺失时返回空批次、不抛错也不写键', async () => {
  const store = makeStore({ 'providers.opencode.dbPath': path.join(os.tmpdir(), 'opencode-missing-' + Date.now(), 'opencode.db') });
  const batch = await readLocalLog({ store }, { diagnostics: {}, nowMs: TS2 });
  assert.deepEqual(batch, { records: [], complete: true, bytesRead: 0 });
  assert.equal(store.get('usageDaily'), undefined);
  assert.equal(opencodeDbAvailable(store), false);
});

test('翻页被封顶时必须如实报 complete:false(否则「同步历史」会静默给出不完整的历史)', async () => {
  // 造 30 条记录、rowLimit=3:每页能推进 ~2 条(2000ms 重叠窗会重读 1 条),
  // 8 页远读不完 30 条 ⇒ 必须报 complete:false,调用方才会带着推进后的游标再来一轮。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-capped-'));
  const dbPath = path.join(dir, 'opencode.db');
  const db = new DatabaseSync(dbPath);
  db.exec('create table message (id text primary key, session_id text, time_created integer,'
    + ' time_updated integer, data text)');
  db.exec('create table session_message (id text, session_id text, seq integer, type text,'
    + ' time_created integer, data text)');
  const insert = db.prepare('insert into message values (?, ?, ?, ?, ?)');
  for (let i = 0; i < 30; i += 1) {
    const ts = TS1 + i * 60000;
    insert.run('c' + i, 's1', ts, ts, assistantData(1, TOKENS_V1, ts));
  }
  db.close();

  const store = makeStore({ 'providers.opencode.dbPath': dbPath });
  const diagnostics = {};
  const first = await readLocalLog({ store }, { diagnostics, rowLimit: 3 });
  assert.equal(first.complete, false, '还有页可读就不能说读完了');
  assert.ok(first.records.length < 30, '第一次不该读满 30 条:' + first.records.length);
  assert.ok(diagnostics.opencodeBackfillCapped >= 1, '封顶要留有诊断,不能静默');

  // 调用方(history-sync 的 rescanLocalLogs)看到 complete:false 会再来一轮 —— 这里模拟到读完为止
  let batch = first;
  let guard = 0;
  while (!batch.complete && guard < 60) {
    batch = await readLocalLog({ store }, { diagnostics, rowLimit: 3 });
    guard += 1;
  }
  assert.equal(batch.complete, true, '最终必须能报读完(实际跑了 ' + guard + ' 轮)');
  const cost = store.get('usageDailyCost') || {};
  const sum = Object.keys(cost).reduce((s, k) => s + cost[k], 0);
  assert.equal(sum, 30, '多轮合起来要把 30 条都算上(不丢、不重)');
});
