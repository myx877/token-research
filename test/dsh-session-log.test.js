// DSH 官方会话日志(session[.vN].jsonl[.zstd])读取的单元测试。
// 关键口径:只统计 assistant/message 的 data.usage;compaction/summary 也带 usage
// 但必须排除(DSH 自己的 sessionStats 累计值也不含它,两个口径必须相等)。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const {
  readLocalLog,
  listSessionFiles,
  frameBounds,
  resolveSessionsRoot
} = require('../src/main/providers/dsh/session-log');
const dshProvider = require('../src/main/providers/dsh');
const { localDayStr } = require('../src/main/core/beijing-calendar');

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const NOW_MS = Date.UTC(2026, 8, 25, 4, 0, 0);

function beijingMs(year, month, day, hour, minute = 0) {
  return Date.UTC(year, month - 1, day, hour, minute) - BEIJING_OFFSET_MS;
}

function makeStore(initial = {}) {
  const data = JSON.parse(JSON.stringify(initial));
  function setPath(key, value) {
    const parts = key.split('.');
    let current = data;
    while (parts.length > 1) {
      const part = parts.shift();
      if (!current[part] || typeof current[part] !== 'object') current[part] = {};
      current = current[part];
    }
    current[parts[0]] = value;
  }
  return {
    get(key) {
      return key.split('.').reduce((value, part) => (value == null ? undefined : value[part]), data);
    },
    set(key, value) {
      if (typeof key === 'object' && key !== null) {
        Object.keys(key).forEach((k) => setPath(k, key[k]));
        return;
      }
      setPath(key, value);
    }
  };
}

function frame(lines) {
  return zlib.zstdCompressSync(Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8'));
}

function sessionHeader(id, cwd) {
  return { type: 'session', version: 3, id, createdAt: beijingMs(2026, 9, 23, 9, 0), cwd: cwd || 'C:\\proj' };
}

function assistantMessage(seq, time, usage, model) {
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'opc', model: model === undefined ? 'deepseek-v4-flash' : model } },
      usage
    }
  };
}

function compactionSummary(seq, time, usage) {
  return { type: 'compaction/summary', seq, time, data: { compactionId: 'c1', summary: [{ type: 'text', text: 'x' }], usage } };
}

function usage(input, output, cacheRead, cacheWrite) {
  return {
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead === undefined ? 0 : cacheRead,
    cacheWriteTokens: cacheWrite === undefined ? 0 : cacheWrite
  };
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-session-log-'));
}

function writeSession(root, sessionId, fileName, frames) {
  const dir = path.join(root, 'proj', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, fileName);
  fs.writeFileSync(target, Buffer.concat(frames));
  return target;
}

test('frameBounds 覆盖多帧且排除未写完的尾帧', () => {
  const first = frame([sessionHeader('s1')]);
  const second = frame([assistantMessage(1, beijingMs(2026, 9, 23, 10, 0), usage(10, 1, 0, 0))]);
  const third = frame([assistantMessage(2, beijingMs(2026, 9, 23, 10, 1), usage(20, 2, 0, 0))]);
  const complete = Buffer.concat([first, second, third]);
  const truncated = Buffer.concat([first, second, third.subarray(0, third.length - 4)]);

  const whole = frameBounds(complete);
  assert.equal(whole.bounds.length, 3);
  assert.equal(whole.trailingFrom, complete.length);

  const cut = frameBounds(truncated);
  assert.equal(cut.bounds.length, 2, '未写完的尾帧必须被排除');
  assert.equal(cut.trailingFrom, first.length + second.length);
});

test('只统计 assistant/message 四桶,compaction/summary 的 usage 必须排除', async () => {
  const root = tempRoot();
  const t1 = beijingMs(2026, 9, 23, 10, 0);
  const t2 = beijingMs(2026, 9, 24, 10, 0);
  writeSession(root, 'session-a', 'session.v3.jsonl.zstd', [
    frame([sessionHeader('session-a')]),
    frame([assistantMessage(1, t1, usage(100, 20, 7, 0))]),
    frame([compactionSummary(2, t1 + 1000, usage(5000, 5000, 0, 0))]),
    frame([assistantMessage(3, t2, usage(5, 6, 0, 2))])
  ]);
  const store = makeStore({ providers: { dsh: { sessionsRoot: root } }, data: { historyDays: 30 } });

  const batch = await readLocalLog({ store }, { nowMs: NOW_MS });

  assert.equal(batch.records.length, 2, '压缩摘要不是模型回合,不能计入');
  const daily = store.get('usageDaily');
  assert.deepEqual(daily['dsh:' + localDayStr(t1)], { input: 100, cached: 7, output: 20, total: 127 });
  // cacheWrite 记进 input(与 usage-*.jsonl 同一映射)
  assert.deepEqual(daily['dsh:' + localDayStr(t2)], { input: 7, cached: 0, output: 6, total: 13 });
  const cost = store.get('usageDailyCost');
  assert.ok(cost['dsh:' + localDayStr(t1)] > 0, '已知模型必须算出费用');
});

test('会话事件缺模型名时按 unknown 计入并记 unknownModel 诊断', async () => {
  const root = tempRoot();
  const t = beijingMs(2026, 9, 23, 11, 0);
  writeSession(root, 'session-x', 'session.v3.jsonl.zstd', [
    frame([sessionHeader('session-x')]),
    frame([assistantMessage(1, t, usage(10, 1, 0, 0), null)])
  ]);
  const store = makeStore({ providers: { dsh: { sessionsRoot: root } }, data: { historyDays: 30 } });
  const diagnostics = {};

  const batch = await readLocalLog({ store }, { nowMs: NOW_MS, diagnostics });

  assert.equal(batch.records.length, 1);
  assert.equal(batch.records[0].model, 'unknown');
  assert.equal(batch.records[0].cost, 0);
  assert.equal(diagnostics.unknownModel, 1);
  assert.equal(store.get('usageDailyCost')['dsh:' + localDayStr(t)], 0);
});

test('增量:文件未变不重读,追加后只计新帧(不重复计数)', async () => {
  const root = tempRoot();
  const t1 = beijingMs(2026, 9, 23, 10, 0);
  const t2 = beijingMs(2026, 9, 24, 11, 0);
  const file = writeSession(root, 'session-b', 'session.v3.jsonl.zstd', [
    frame([sessionHeader('session-b')]),
    frame([assistantMessage(1, t1, usage(100, 10, 0, 0))])
  ]);
  const store = makeStore({ providers: { dsh: { sessionsRoot: root } }, data: { historyDays: 30 } });

  const first = await readLocalLog({ store }, { nowMs: NOW_MS });
  assert.equal(first.records.length, 1);
  const second = await readLocalLog({ store }, { nowMs: NOW_MS });
  assert.equal(second.records.length, 0, '未变化的文件不应产生记录');
  assert.equal(store.get('usageDaily')['dsh:' + localDayStr(t1)].input, 100);

  fs.appendFileSync(file, frame([assistantMessage(2, t2, usage(50, 5, 0, 0))]));
  const third = await readLocalLog({ store }, { nowMs: NOW_MS });
  assert.equal(third.records.length, 1, '只应计入新追加的事件');
  assert.equal(store.get('usageDaily')['dsh:' + localDayStr(t1)].input, 100, '旧事件不得重复累加');
  assert.equal(store.get('usageDaily')['dsh:' + localDayStr(t2)].input, 50);
});

test('同一会话的 v0/v3 两代文件并存时只读最高世代(防双计)', async () => {
  const root = tempRoot();
  const dir = path.join(root, 'proj', 'session-c');
  const t = beijingMs(2026, 9, 23, 10, 0);
  // 两代文件的 seq 体系不同、内容等价:若都读必然双计。
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.jsonl.zstd'), Buffer.concat([
    frame([{ type: 'session', version: 0, id: 'session-c', createdAt: t }]),
    frame([assistantMessage(1, t, usage(100, 10, 0, 0))])
  ]));
  fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), Buffer.concat([
    frame([sessionHeader('session-c')]),
    frame([assistantMessage(1, t, usage(100, 10, 0, 0))])
  ]));
  const store = makeStore({ providers: { dsh: { sessionsRoot: root } }, data: { historyDays: 30 } });

  const files = await listSessionFiles(root);
  assert.deepEqual(files, [path.join(dir, 'session.v3.jsonl.zstd')]);

  const batch = await readLocalLog({ store }, { nowMs: NOW_MS });
  assert.equal(batch.records.length, 1, '两代文件不能让同一次请求计两遍');
  assert.equal(store.get('usageDaily')['dsh:' + localDayStr(t)].input, 100);
});

test('文件被重写变小时重置游标并记 sessionLogRewritten', async () => {
  const root = tempRoot();
  const t1 = beijingMs(2026, 9, 23, 10, 0);
  const t2 = beijingMs(2026, 9, 23, 12, 0);
  const file = writeSession(root, 'session-d', 'session.v3.jsonl.zstd', [
    frame([sessionHeader('session-d')]),
    frame([assistantMessage(1, t1, usage(100, 10, 0, 0))]),
    frame([assistantMessage(2, t2, usage(200, 20, 0, 0))])
  ]);
  const store = makeStore({ providers: { dsh: { sessionsRoot: root } }, data: { historyDays: 30 } });
  await readLocalLog({ store }, { nowMs: NOW_MS });

  fs.writeFileSync(file, Buffer.concat([
    frame([sessionHeader('session-d')]),
    frame([assistantMessage(1, t2, usage(1, 1, 0, 0))])
  ]));
  const diagnostics = {};
  const batch = await readLocalLog({ store }, { nowMs: NOW_MS, diagnostics });

  assert.equal(diagnostics.sessionLogRewritten, 1);
  assert.equal(batch.records.length, 1);
});

test('单轮预算耗尽时标记未完成,下一轮从未消费的帧继续并收敛', async () => {
  const root = tempRoot();
  const t1 = beijingMs(2026, 9, 23, 10, 0);
  const t2 = beijingMs(2026, 9, 24, 10, 30);
  writeSession(root, 'session-e', 'session.v3.jsonl.zstd', [
    frame([sessionHeader('session-e')]),
    frame([assistantMessage(1, t1, usage(100, 10, 0, 0))]),
    frame([assistantMessage(2, t2, usage(30, 3, 0, 0))])
  ]);
  const store = makeStore({ providers: { dsh: { sessionsRoot: root } }, data: { historyDays: 30 } });

  const first = await readLocalLog({ store }, { nowMs: NOW_MS, maxBytesPerScan: 1 });
  assert.equal(first.complete, false);
  const second = await readLocalLog({ store }, { nowMs: NOW_MS });
  assert.equal(second.complete, true);
  assert.equal(first.records.length + second.records.length, 2);
  const daily = store.get('usageDaily');
  assert.equal(daily['dsh:' + localDayStr(t1)].input, 100);
  assert.equal(daily['dsh:' + localDayStr(t2)].input, 30);
});

test('没有会话日志时返回 empty,由 provider 回退到遥测文件', async () => {
  const missing = path.join(tempRoot(), 'no-such-sessions');
  const store = makeStore({ providers: { dsh: { sessionsRoot: missing } }, data: { historyDays: 30 } });
  const batch = await readLocalLog({ store }, { nowMs: NOW_MS });
  assert.equal(batch.empty, true);
  assert.deepEqual(batch.records, []);
});

test('provider:有会话日志时只读会话日志,没有时回退遥测文件', async () => {
  const sessionsRoot = tempRoot();
  const telemetryRoot = tempRoot();
  const t = beijingMs(2026, 9, 23, 10, 0);
  const day = localDayStr(t);
  fs.writeFileSync(path.join(telemetryRoot, 'usage-' + day + '.jsonl'),
    JSON.stringify({ v: 1, time: t, sessionId: 'legacy', model: 'deepseek-v4-flash', inputTokens: 7, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }) + '\n');

  // 1) 会话日志缺失 ⇒ 遥测文件
  const legacyStore = makeStore({
    providers: { dsh: { sessionsRoot: path.join(sessionsRoot, 'none'), telemetryRoot } },
    data: { historyDays: 30 }
  });
  const legacyBatch = await dshProvider.readLocalLog({ store: legacyStore }, { nowMs: NOW_MS });
  assert.equal(legacyBatch.records.length, 1);
  assert.equal(legacyBatch.records[0].eventFingerprint.length > 0, true);

  // 2) 会话日志存在 ⇒ 只读会话日志,遥测里的同一批不得再计一遍
  writeSession(sessionsRoot, 'session-f', 'session.v3.jsonl.zstd', [
    frame([sessionHeader('session-f')]),
    frame([assistantMessage(1, t, usage(7, 1, 0, 0))])
  ]);
  const bothStore = makeStore({
    providers: { dsh: { sessionsRoot, telemetryRoot } },
    data: { historyDays: 30 }
  });
  const bothBatch = await dshProvider.readLocalLog({ store: bothStore }, { nowMs: NOW_MS });
  assert.equal(bothBatch.records.length, 1);
  assert.equal(bothStore.get('usageDaily')['dsh:' + day].input, 7, '两条来源不能叠加计数');
});

test('resolveSessionsRoot 优先级:设置 > DSH_HOME > ~/.dsh/sessions', () => {
  const nativeHome = path.join(os.homedir(), 'dsh-home');
  const custom = path.join(os.tmpdir(), 'custom-sessions');

  assert.equal(resolveSessionsRoot(null, {}), path.join(os.homedir(), '.dsh', 'sessions'));
  assert.equal(resolveSessionsRoot(null, { DSH_HOME: nativeHome }), path.join(nativeHome, 'sessions'));
  assert.equal(
    resolveSessionsRoot(null, { DSH_HOME: path.join('.', 'relative') }),
    path.resolve(path.join('.', 'relative'), 'sessions')
  );
  assert.equal(
    resolveSessionsRoot({ get: (key) => (key === 'providers.dsh.sessionsRoot' ? custom : undefined) }, {}),
    custom
  );
});

test('解码时按时间让出事件循环(不长时间独占主进程)', async () => {
  const root = tempRoot();
  const t = beijingMs(2026, 9, 23, 10, 0);
  const frames = [frame([sessionHeader('session-g')])];
  for (let i = 1; i <= 12; i += 1) frames.push(frame([assistantMessage(i, t + i * 1000, usage(10, 1, 0, 0))]));
  writeSession(root, 'session-g', 'session.v3.jsonl.zstd', frames);
  const store = makeStore({ providers: { dsh: { sessionsRoot: root } }, data: { historyDays: 30 } });

  let yields = 0;
  const batch = await readLocalLog({ store }, {
    nowMs: NOW_MS,
    yieldIntervalMs: 0,
    yieldToLoop: () => { yields += 1; return Promise.resolve(); }
  });

  assert.equal(batch.records.length, 12);
  assert.ok(yields >= 6, '每帧都必须让出(实测 ' + yields + ' 次)');
});

test('provider.localLogRoot 指向会话日志根(实时监听数据源)', () => {
  const root = dshProvider.localLogRoot({ store: makeStore() });
  assert.ok(path.isAbsolute(root) && root.endsWith(path.join('.dsh', 'sessions')));
});
