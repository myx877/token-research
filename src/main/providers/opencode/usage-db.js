// opencode 本地用量数据库(~/.local/share/opencode/opencode.db)读取器。
//
// 实测结构(2026-09-17,见 scripts/probe-opencode-schema.js):
//   message(id, session_id, time_created, data)          —— v1 会话的消息,data 为 JSON
//   session_message(session_id, seq, type, time_created, data) —— session_v2 的消息
//   assistant 行 data 内含:
//     cost                       真实金额(models.dev 定价,USD)
//     tokens.{input,output,reasoning,cache:{read,write}}
//     modelID, providerID, time.created
//   ∑message.cost 与 ∑session.cost 完全吻合,故 cost 可直接作为真实金额落库。
//
// 桶映射沿用 dsh 约定:input = tokens.input + tokens.cache.write、cached = tokens.cache.read、
// output = tokens.output + tokens.reasoning(total 由四者相加,v2 无 tokens.total 字段)。
//
// 增量:按 time_created 游标 + 最近指纹窗口(OVERLAP_MS + RECENT_ID_LIMIT),
// 既不会漏掉同一毫秒的多条消息,也不会因重叠窗口重复计入。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { incrementDiagnostic } = require('../../core/locallog');
const { commitUsageRecords } = require('../../core/usage-commit');

// 游标键必须与 history-sync.rescanLocalLogs 的约定一致('localLogCursors.<providerId>'),
// 否则手动历史同步清空 usageDaily 后清不到游标,增量读取拿不到记录、历史再也建不回来。
const CURSOR_KEY = 'localLogCursors.opencode';
const DEFAULT_DB = path.join(os.homedir(), '.local', 'share', 'opencode', 'opencode.db');
const OVERLAP_MS = 2000;
const RECENT_ID_LIMIT = 400;
// v1 的 message.data.role / v2 的 session_message.type 都是 'assistant'
const SOURCES = [
  { name: 'message', provider: 'opencode', sql: "select id, time_created, data from message where json_extract(data,'$.role')='assistant' and time_created >= ? order by time_created asc limit ?" },
  { name: 'session_message', provider: 'opencode', sql: "select id, time_created, data from session_message where type='assistant' and time_created >= ? order by time_created asc limit ?" }
];
const ROW_LIMIT = 5000;
// 单次同步最多翻这么多页(页 × ROW_LIMIT 行);到顶会记 opencodeBackfillCapped,剩余历史留给下次同步
const MAX_PAGES_PER_SYNC = 8;

function resolveDbPath(store) {
  const configured = store && store.get('providers.opencode.dbPath');
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  return DEFAULT_DB;
}

function loadSqlite() {
  try {
    return require('node:sqlite');
  } catch (e) {
    return null;
  }
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

// assistant 行的 data(JSON 字符串) → 用量记录;无用量返回 null。
function parseOpencodeMessage(data, fallbackTs, diagnostics) {
  let row = data;
  if (typeof row === 'string') {
    try {
      row = JSON.parse(row);
    } catch (e) {
      incrementDiagnostic(diagnostics, 'invalidJson');
      return null;
    }
  }
  const tokens = row && row.tokens;
  if (!tokens || typeof tokens !== 'object') return null;
  const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
  const inputTokens = toCount(tokens.input);
  const cacheWrite = toCount(cache.write);
  const cacheRead = toCount(cache.read);
  const output = toCount(tokens.output) + toCount(tokens.reasoning);
  const total = inputTokens + cacheWrite + cacheRead + output;
  if (total <= 0) {
    incrementDiagnostic(diagnostics, 'zeroUsageRow');
    return null;
  }
  const cost = Number(row.cost);
  const ts = Number(row.time && row.time.created);
  return {
    // provider 必须随记录一起给出:usage-commit 的日聚合键 = '<provider>:<day>'
    provider: 'opencode',
    ts: Number.isFinite(ts) && ts > 0 ? ts : fallbackTs,
    model: typeof row.modelID === 'string' && row.modelID ? row.modelID : 'unknown',
    currency: 'USD',
    usage: { input: inputTokens + cacheWrite, cached: cacheRead, output: output, total: total },
    // 缺失或非有限值即为「无金额」,不做任何折算
    cost: Number.isFinite(cost) ? cost : null
  };
}

function openReadOnly(dbPath) {
  const sqlite = loadSqlite();
  if (!sqlite) return { error: 'node:sqlite 不可用(需要 Node >= 22.5)' };
  try {
    return { db: new sqlite.DatabaseSync(dbPath, { readOnly: true }) };
  } catch (e) {
    return { error: '无法只读打开 opencode.db:' + (e && e.message) };
  }
}

// 读取增量记录(不落库);db 不可用时返回空数组并挂 diagnostic,绝不抛出。
function collectRecords(dbPath, state, diagnostics, limit) {
  const opened = openReadOnly(dbPath);
  if (opened.error) {
    incrementDiagnostic(diagnostics, 'opencodeDbUnavailable');
    return { records: [], state: state, error: opened.error };
  }
  const db = opened.db;
  const records = [];
  const nextState = { sources: Object.assign({}, state && state.sources) };
  const recent = new Set((state && state.recentIds) || []);
  try {
    SOURCES.forEach((source) => {
      const sourceState = (state && state.sources && state.sources[source.name]) || {};
      const from = Math.max(0, (Number(sourceState.cursorMs) || 0) - OVERLAP_MS);
      let rows;
      try {
        rows = db.prepare(source.sql).all(from, limit || ROW_LIMIT);
      } catch (e) {
        incrementDiagnostic(diagnostics, 'opencodeTableMissing');
        return;
      }
      let maxTs = Number(sourceState.cursorMs) || 0;
      rows.forEach((row) => {
        const ts = Number(row.time_created);
        if (Number.isFinite(ts) && ts > maxTs) maxTs = ts;
        const id = source.name + ':' + row.id;
        if (recent.has(id)) {
          incrementDiagnostic(diagnostics, 'duplicateEvent');
          return;
        }
        const record = parseOpencodeMessage(row.data, ts, diagnostics);
        // 无用量行(如 synthetic)不占用指纹,避免下一轮重复解析
        if (!record) return;
        recent.add(id);
        records.push(record);
      });
      nextState.sources[source.name] = { cursorMs: maxTs };
    });
  } finally {
    db.close();
  }
  nextState.recentIds = Array.from(recent).slice(-RECENT_ID_LIMIT);
  return { records: records, state: nextState };
}

async function readLocalLog(ctx, opts) {
  const options = opts || {};
  const store = ctx && ctx.store;
  const diagnostics = options.diagnostics;
  const empty = { records: [], complete: true, bytesRead: 0 };
  if (!store || typeof store.get !== 'function') return empty;
  const dbPath = resolveDbPath(store);
  if (!fs.existsSync(dbPath)) return empty;

  const rowLimit = options.rowLimit || ROW_LIMIT;
  let state = store.get(CURSOR_KEY) || {};
  const all = [];
  // 冷启动时一页只有 ROW_LIMIT 行,只读一页会静默少算大头金额
  // (本机实测:库内合计 $21.18,第一页只拿到 $7.59)。因此一次同步内循环翻页,
  // 直到游标不再前进(读尽)为止,保证首次同步就是全量而非残量。
  let capped = false;
  for (let page = 0; page < MAX_PAGES_PER_SYNC; page += 1) {
    const collected = collectRecords(dbPath, state, diagnostics, rowLimit);
    if (collected.error) return empty;
    const advanced = JSON.stringify(collected.state) !== JSON.stringify(state);
    state = collected.state;
    // 游标不动说明本页只是重叠窗口内的重复行,不能再累加(否则金额会翻倍)
    if (!advanced) break;
    if (collected.records.length) {
      commitUsageRecords(store, collected.records, diagnostics, options.nowMs, {
        retainAll: options.retainAll
      });
      collected.records.forEach((record) => all.push(record));
    }
    if (page === MAX_PAGES_PER_SYNC - 1) capped = true;
  }
  if (capped) incrementDiagnostic(diagnostics, 'opencodeBackfillCapped');
  store.set(CURSOR_KEY, state);
  /* complete 必须如实:它决定调用方(history-sync 的 rescanLocalLogs)要不要继续翻页。
     以前这里恒返回 true,于是"还有更多页可读"的情况被当成读完 —— 库内 assistant 行超过
     8×ROW_LIMIT 时,「同步历史」会**静默**给出不完整的历史(审查发现)。
     现在封顶就报 false,调用方会带着推进后的游标再来一轮,直到真正读完。 */
  return { records: all, complete: !capped, bytesRead: 0 };
}

function opencodeDbAvailable(store) {
  return fs.existsSync(resolveDbPath(store));
}

module.exports = {
  readLocalLog,
  opencodeDbAvailable,
  resolveDbPath,
  collectRecords,
  parseOpencodeMessage,
  DEFAULT_DB,
  CURSOR_KEY
};
