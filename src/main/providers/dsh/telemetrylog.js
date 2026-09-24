// DSH usage 遥测文件解析 + 根目录解析。
// 遥测文件是**自建生产者**通道:$DSH_HOME/telemetry/usage-YYYY-MM-DD.jsonl
// (DSH 官方组件只往远端 OTLP 推、不落本地文件,所以本机默认不会有这些文件)。
// 没有遥测文件时,DSH 的数据来自官方会话日志,见 ./session-log.js。
const path = require('path');
const os = require('os');
const {
  scanCandidateBatch,
  walkFiles,
  incrementDiagnostic
} = require('../../core/locallog');
const { parseTelemetryLine } = require('./usage-records');
const { expandHomePath, resolveTelemetryRoot, TELEMETRY_DIR } = require('./paths');
const {
  CURSOR_KEY,
  cloneStoreValue,
  cursorsChanged,
  commitDshScanState,
  applyDshRecordsToStore
} = require('./scan-state');

const DEFAULT_ROOT = () => path.join(os.homedir(), '.dsh', TELEMETRY_DIR);
// 校验月(01-12)与日(01-31),拒绝 usage-2026-13-99.jsonl 之类非法日期名。
const MATCH = /^usage-\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\.jsonl$/;

// 扫描单根目录下的 usage-*.jsonl:稳定身份 = 完整路径。
// 增量路径不做内容指纹去重:usageDaily/usageDailyCost 与游标随单次原子提交
// 同单元落盘,"游标落后于数据"的重放态不可达;而 attempt 级行可能字节完全相同
// (同毫秒、同会话、同模型、同四桶的双 attempt),按 lastEventFingerprint 去重会
// 误杀真实的第二行导致漏计。seenFingerprints 分支仅供显式重建(全量去重)使用。
async function scanTelemetryBatch({ store, root, parseLine, diagnostics, nowMs, chunkBytes, maxBytesPerScan, yieldToLoop, seenFingerprints }) {
  const cursors = cloneStoreValue((store && store.get(CURSOR_KEY)) || {});
  const files = await walkFiles(root, MATCH);
  const candidates = files.map((filePath) => ({
    identity: filePath,
    filePath: filePath,
    cursor: cursors[filePath] || { offset: 0, mtimeMs: 0 }
  }));

  const result = await scanCandidateBatch({
    candidates,
    parseLine,
    onRecord({ record, cursor, records }) {
      if (record && record.eventFingerprint) {
        let emit = true;
        if (seenFingerprints) {
          if (seenFingerprints.has(record.eventFingerprint)) {
            incrementDiagnostic(diagnostics, 'duplicateEvent');
            emit = false;
          } else {
            seenFingerprints.add(record.eventFingerprint);
          }
        }
        if (emit) records.push(Object.assign({ provider: 'dsh' }, record));
      }
      return cursor;
    },
    resetCursor(cursor, stat) {
      return { offset: 0, mtimeMs: stat.mtimeMs };
    },
    setCursor(candidate, cursor) {
      cursors[candidate.identity] = cursor;
    },
    diagnostics,
    nowMs,
    chunkBytes,
    maxBytesPerScan,
    yieldToLoop
  });

  return Object.assign({}, result, { cursors });
}

// 异步增量扫描遥测文件:返回 ScanBatch({ records, complete, bytesRead });
// 并按日聚合增量合并进 store 键 'usageDaily' 与 'usageDailyCost'(仅 dsh 前缀)。
async function readLocalLog(ctx, opts) {
  const store = ctx && ctx.store;
  const diagnostics = opts && opts.diagnostics;
  const requestedNowMs = opts && opts.nowMs;
  const parsedNowMs = Number(requestedNowMs);
  const nowMs = requestedNowMs !== null
    && requestedNowMs !== undefined
    && Number.isFinite(parsedNowMs)
    ? parsedNowMs
    : Date.now();
  const root = resolveTelemetryRoot(store, process.env);
  // Persist only new records or cursor advancement; empty scans do not rewrite the store.
  const storedCursors = (store && store.get(CURSOR_KEY)) || {};
  const batch = await scanTelemetryBatch({
    store,
    root,
    parseLine: parseTelemetryLine,
    diagnostics,
    nowMs,
    chunkBytes: opts && opts.chunkBytes,
    maxBytesPerScan: opts && opts.maxBytesPerScan,
    yieldToLoop: opts && opts.yieldToLoop,
    seenFingerprints: opts && opts.seenFingerprints
  });
  const records = batch.records;
  applyDshRecordsToStore({
    store,
    records,
    cursors: batch.cursors || {},
    storedCursors,
    diagnostics,
    nowMs,
    retainAll: opts && opts.retainAll
  });
  return batch;
}

module.exports = {
  parseTelemetryLine,
  resolveTelemetryRoot,
  readLocalLog,
  scanTelemetryBatch,
  expandHomePath,
  DEFAULT_ROOT,
  MATCH,
  CURSOR_KEY
};
