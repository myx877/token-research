// Claude Code 本地会话日志(~/.claude/projects/<编码 cwd>/<sessionId>.jsonl)的解析与增量扫描。
//
// 桶映射沿用 dsh 约定(见 providers/dsh/usage-records.js):
//   input  = message.usage.input_tokens + cache_creation_input_tokens(缓存写入按输入计价)
//   cached = message.usage.cache_read_input_tokens
//   output = message.usage.output_tokens
//   total  = input + cached + output
//
// 金额:实测本机日志**不含任何 cost 字段**(无 costUSD、无 requestId),因此只能由模型串
// 在定价表内折算;模型串未收录时 cost = null(不落库),绝不回落到默认档位凭空造金额。
//
// 去重:同一条 API 响应会写成多行(多 content block),这些行的 message.id 与 usage 完全相同,
// 按行累加会成倍虚高 → 以 message.id 为指纹,每个文件保留最近 SEEN_LIMIT 个已计入指纹。
// 已知边界:跨文件复制历史(如 fork 会话)不在此去重范围内,会记 duplicateEvent 诊断。
const fsp = require('node:fs/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findModelPrice } = require('../../pricing');
const {
  walkFiles,
  scanCandidateBatch,
  normalizeTimestampMs,
  incrementDiagnostic
} = require('../../core/locallog');
const { commitUsageRecords } = require('../../core/usage-commit');

// 游标键必须与 history-sync.rescanLocalLogs 的约定一致('localLogCursors.<providerId>'),
// 否则手动历史同步清空 usageDaily 后清不到游标,增量扫描拿不到记录、历史再也建不回来。
const CURSOR_KEY = 'localLogCursors.claude';
const SEEN_LIMIT = 64;
const MATCH = /\.jsonl$/i;
const DEFAULT_ROOT = path.join(os.homedir(), '.claude', 'projects');
const SYNTHETIC_MODEL = '<synthetic>';

function resolveClaudeLogRoot(store) {
  const configured = store && store.get('providers.claude.logRoot');
  if (typeof configured === 'string' && configured.trim()) return configured.trim();
  return DEFAULT_ROOT;
}

function toCount(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

// 只知道价格才折算:返回 null 表示「无可用金额」,由展示层显示占位符。
function deriveCost(model, inputTokens, cacheWrite, cacheRead, output) {
  const price = findModelPrice(model);
  if (!price) return null;
  return (inputTokens + cacheWrite) / 1000 * price.input
    + output / 1000 * price.output
    + cacheRead / 1000 * price.cache_hit;
}

function parseClaudeLine(line, diagnostics, nowMs) {
  if (!line) return null;
  let row;
  try {
    row = JSON.parse(line);
  } catch (e) {
    incrementDiagnostic(diagnostics, 'invalidJson');
    return null;
  }
  const message = row && row.message;
  const usage = message && message.usage;
  if (!usage || typeof usage !== 'object') return null;
  const model = typeof message.model === 'string' ? message.model : '';
  if (model === SYNTHETIC_MODEL) {
    incrementDiagnostic(diagnostics, 'syntheticRow');
    return null;
  }
  const inputTokens = toCount(usage.input_tokens);
  const cacheWrite = toCount(usage.cache_creation_input_tokens);
  const cacheRead = toCount(usage.cache_read_input_tokens);
  const output = toCount(usage.output_tokens);
  const total = inputTokens + cacheWrite + cacheRead + output;
  if (total <= 0) {
    incrementDiagnostic(diagnostics, 'zeroUsageRow');
    return null;
  }
  const messageId = typeof message.id === 'string' && message.id ? message.id : null;
  if (!messageId) {
    incrementDiagnostic(diagnostics, 'missingMessageId');
    return null;
  }
  const ts = normalizeTimestampMs(Date.parse(row.timestamp), nowMs);
  if (ts === null) {
    incrementDiagnostic(diagnostics, 'invalidTimestamp');
    return null;
  }
  if (!findModelPrice(model)) incrementDiagnostic(diagnostics, 'unknownModel');
  return {
    ts: ts,
    model: model || 'unknown',
    currency: 'CNY',
    usage: {
      input: inputTokens + cacheWrite,
      cached: cacheRead,
      output: output,
      total: total
    },
    cost: deriveCost(model, inputTokens, cacheWrite, cacheRead, output),
    eventFingerprint: 'claude:' + messageId
  };
}

async function directoryExists(dir) {
  try {
    return (await fsp.stat(dir)).isDirectory();
  } catch (e) {
    return false;
  }
}

// 扫描增量并把本次新增记录并入 usageDaily / usageDailyCost,返回 ScanBatch。
async function readLocalLog(ctx, opts) {
  const options = opts || {};
  const store = ctx && ctx.store;
  const diagnostics = options.diagnostics;
  const nowMs = options.nowMs;
  const empty = { records: [], complete: true, bytesRead: 0 };
  if (!store || typeof store.get !== 'function') return empty;
  const root = resolveClaudeLogRoot(store);
  if (!(await directoryExists(root))) return empty;

  const canAccessPath = ctx && ctx.canAccessPath;
  const cursors = JSON.parse(JSON.stringify(store.get(CURSOR_KEY) || {}));
  const files = await walkFiles(root, MATCH, canAccessPath);
  const candidates = files.map((filePath) => ({
    identity: filePath,
    filePath: filePath,
    cursor: cursors[filePath] || { offset: 0, mtimeMs: 0, seen: [] }
  }));

  const result = await scanCandidateBatch({
    candidates: candidates,
    canAccessPath: canAccessPath,
    parseLine: parseClaudeLine,
    onRecord({ record, cursor, records }) {
      if (record) {
        const seen = Array.isArray(cursor.seen) ? cursor.seen : [];
        if (seen.indexOf(record.eventFingerprint) >= 0) {
          incrementDiagnostic(diagnostics, 'duplicateEvent');
        } else {
          records.push(Object.assign({ provider: 'claude' }, record));
          cursor.seen = seen.concat([record.eventFingerprint]).slice(-SEEN_LIMIT);
        }
      }
      return cursor;
    },
    resetCursor(cursor, stat) {
      return { offset: 0, mtimeMs: stat.mtimeMs, seen: [] };
    },
    setCursor(candidate, cursor) {
      cursors[candidate.identity] = cursor;
    },
    diagnostics: diagnostics,
    nowMs: nowMs,
    chunkBytes: options.chunkBytes,
    maxBytesPerScan: options.maxBytesPerScan,
    yieldToLoop: options.yieldToLoop
  });

  store.set(CURSOR_KEY, cursors);
  const batch = {
    records: result.records,
    complete: result.complete !== false,
    bytesRead: Number(result.bytesRead) || 0
  };
  if (batch.records.length) {
    commitUsageRecords(store, batch.records, diagnostics, nowMs, { retainAll: options.retainAll });
  }
  return batch;
}

function claudeLogAvailable(store) {
  try {
    return fs.statSync(resolveClaudeLogRoot(store)).isDirectory();
  } catch (e) {
    return false;
  }
}

module.exports = {
  parseClaudeLine,
  readLocalLog,
  claudeLogAvailable,
  resolveClaudeLogRoot,
  deriveCost,
  DEFAULT_ROOT,
  CURSOR_KEY,
  MATCH
};
