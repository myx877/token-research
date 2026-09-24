// DSH 官方会话日志读取:$DSH_HOME/sessions/<项目>/<会话>/session[.vN].jsonl[.zstd]。
// 这是 DSH 自己一直在写的规范会话日志(每批事件一个独立 zstd frame、追加写),
// 因此不需要 DSH 侧装任何插件、不需要凭证、也不会新增任何文件。
//
// 口径与 DSH 自身累计值一致:只统计 assistant/message 的 data.usage 四桶
// (compaction/summary 同样带 usage,但它是压缩摘要调用、不是模型回合,
//  DSH 自己的 sessionStats 也不计它 —— 两个来源求和必须相等,已被单测钉住)。
//
// 增量语义:游标 = { frameIndex, seq, sessionId, size, mtimeMs }。
//   frameIndex —— 已消费到第几帧(帧是追加的,下标稳定,因此活跃会话只需解新帧);
//   seq        —— 该会话已计入的最大事件序号,防止游标提交失败后的重放重复计数。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { walkFiles, incrementDiagnostic } = require('../../core/locallog');
const { mapRowObjectToRecord } = require('./usage-records');
const { resolveSessionsRoot } = require('./paths');
const { CURSOR_KEY, cloneStoreValue, applyDshRecordsToStore } = require('./scan-state');

const fsp = fs.promises;
const SESSION_FILE_MATCH = /^session(?:\.v(\d+))?\.jsonl(?:\.zstd)?$/;
// 单轮扫描预算(压缩字节)。超出则本轮标记未完成,下轮从下一帧继续。
const DEFAULT_SCAN_BUDGET_BYTES = 32 * 1024 * 1024;
// 让出事件循环的粒度按**时间**而不是帧数:单帧解压(实测最大 73KB 压缩帧)可能几毫秒,
// "每 256 帧让一拍"在某些文件上会积累成数百毫秒的主进程卡顿 ——
// 恰好撞上窗口缓动就是 AGENTS.md 第 23 条的迟帧。8ms 保证动画帧能插进来。
const YIELD_INTERVAL_MS = 8;
// 文件级时间窗余量:mtime 必然不早于文件内最后一个事件,窗口外文件不可能贡献窗口内数据;
// 多留两天只为容忍时钟偏差,真正按日的保留过滤在 applyDshRecordsToStore 里做。
const FILE_WINDOW_MARGIN_DAYS = 2;

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function defaultYieldToLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

// zstd 帧边界(RFC 8878):走 magic + frame header + block header,不需要解压。
// 返回 bounds = [[start, end), ...];trailingFrom = 首个未被完整帧覆盖的字节位置
// (DSH 正在追加时的半帧、或不可识别的数据)。半帧会被排除,下一轮补齐后再读。
function frameBounds(buffer) {
  const bounds = [];
  const size = buffer.length;
  let offset = 0;
  while (offset + 5 <= size) {
    const magic = buffer.readUInt32LE(offset);
    if (magic === 0xFD2FB528) {
      let p = offset + 4;
      const descriptor = buffer[p];
      p += 1;
      const fcsId = descriptor >> 6;
      const singleSegment = (descriptor >> 5) & 1;
      const dictId = descriptor & 3;
      const checksum = (descriptor >> 2) & 1;
      if (!singleSegment) p += 1;
      p += dictId === 1 ? 1 : dictId === 2 ? 2 : dictId === 3 ? 4 : 0;
      p += fcsId === 0 && singleSegment ? 1 : [0, 2, 4, 8][fcsId];
      if (p > size) break;
      let incomplete = false;
      for (;;) {
        if (p + 3 > size) { incomplete = true; break; }
        const header = buffer[p] | (buffer[p + 1] << 8) | (buffer[p + 2] << 16);
        p += 3;
        const lastBlock = header & 1;
        const blockType = (header >> 1) & 3;
        const blockSize = (header >> 3) & 0x1FFFFF;
        if (blockType === 3) { incomplete = true; break; }
        const advance = blockType === 1 ? 1 : blockSize;
        if (p + advance > size) { incomplete = true; break; }
        p += advance;
        if (lastBlock) break;
      }
      if (incomplete) break;
      if (checksum) p += 4;
      if (p > size) break;
      bounds.push([offset, p]);
      offset = p;
      continue;
    }
    if ((magic & 0xFFFFFFF0) === 0x184D2A50) {
      // Skippable frame:magic + 4 字节长度 + 载荷。
      if (offset + 8 > size) break;
      const payload = buffer.readUInt32LE(offset + 4);
      if (offset + 8 + payload > size) break;
      offset = offset + 8 + payload;
      continue;
    }
    break;
  }
  return { bounds, trailingFrom: offset };
}

// 每个会话目录只取最高世代的规范日志。同一会话的 v0/v3 两代文件会被 DSH 并存,
// 但它们的 seq 编号体系不同、usage 求和相同 —— 两代都读必然双计,所以这里是必需规则。
async function listSessionFiles(root) {
  const files = await walkFiles(root, SESSION_FILE_MATCH);
  const byDir = new Map();
  for (const filePath of files) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    const matched = SESSION_FILE_MATCH.exec(base);
    const version = matched && matched[1] ? Number(matched[1]) : 0;
    const compressed = base.endsWith('.zstd') ? 1 : 0;
    const previous = byDir.get(dir);
    if (!previous || version > previous.version
        || (version === previous.version && compressed > previous.compressed)) {
      byDir.set(dir, { filePath, version, compressed });
    }
  }
  return Array.from(byDir.values(), (entry) => entry.filePath);
}

// assistant/message 事件 → 遥测行契约(与 usage-*.jsonl / HTTP ingest 同一形状),
// 复用 mapRowObjectToRecord 的计价、四桶映射与指纹,避免第二套口径。
function sessionEventToRow(event, sessionId) {
  const usage = event && event.data && event.data.usage;
  if (!usage || typeof usage !== 'object') return null;
  if (!Number.isSafeInteger(event.time)) return null;
  const source = event.data.message && event.data.message.source;
  const model = source && typeof source.model === 'string' && source.model ? source.model : 'unknown';
  return {
    v: 1,
    time: event.time,
    sessionId: sessionId,
    model: model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens
  };
}

// 消费一帧文本:更新 state.sessionId / state.seq,返回本帧新计入的记录。
function consumeFrame(text, state, diagnostics, nowMs) {
  const records = [];
  const lines = text.split('\n');
  for (const line of lines) {
    if (!line) continue;
    let event = null;
    try {
      event = JSON.parse(line);
    } catch (_) {
      incrementDiagnostic(diagnostics, 'malformedLine');
      continue;
    }
    if (!event || typeof event !== 'object') {
      incrementDiagnostic(diagnostics, 'malformedLine');
      continue;
    }
    if (event.type === 'session') {
      if (typeof event.id === 'string' && event.id) state.sessionId = event.id;
      continue;
    }
    // 唯一口径:只认 assistant/message(compaction/summary 也带 usage,必须排除)。
    if (event.type !== 'assistant/message') continue;
    const seq = event.seq;
    if (Number.isSafeInteger(seq) && seq <= state.seq) continue;
    const row = sessionEventToRow(event, state.sessionId);
    if (!row) continue;
    const record = mapRowObjectToRecord(row, diagnostics, nowMs);
    if (record) records.push(Object.assign({ provider: 'dsh' }, record));
    if (Number.isSafeInteger(seq)) state.seq = Math.max(state.seq, seq);
  }
  return records;
}

// 扫描单个会话日志文件:从游标的 frameIndex 继续,逐帧解压并累计。
async function scanSessionFile(options) {
  const filePath = options.filePath;
  const diagnostics = options.diagnostics;
  const nowMs = options.nowMs;
  const sessionDirId = options.sessionDirId;
  const mtimeMs = Number(options.mtimeMs) || 0;
  const maxBytes = positiveInteger(options.maxBytes, DEFAULT_SCAN_BUDGET_BYTES);
  const yieldToLoop = typeof options.yieldToLoop === 'function' ? options.yieldToLoop : defaultYieldToLoop;
  const requestedYieldInterval = Number(options.yieldIntervalMs);
  const yieldIntervalMs = Number.isFinite(requestedYieldInterval) && requestedYieldInterval >= 0
    ? requestedYieldInterval
    : YIELD_INTERVAL_MS;
  const previous = options.cursor && typeof options.cursor === 'object' ? options.cursor : null;

  let buffer;
  try {
    buffer = await fsp.readFile(filePath);
  } catch (_) {
    return { records: [], complete: true, bytesRead: 0, cursor: previous };
  }
  const totalBytes = buffer.length;
  const { bounds, trailingFrom } = frameBounds(buffer);

  const storedFrame = previous && Number.isSafeInteger(previous.frameIndex) ? previous.frameIndex : 0;
  // 文件被重写(变小)或游标指向不存在的帧 ⇒ 退回从头读。日志的世代切换会新建文件名
  // (另一路径的独立游标),所以这里只可能是真被重写。
  const rewritten = previous !== null
    && (totalBytes < (Number(previous.size) || 0) || storedFrame > bounds.length);
  if (rewritten) incrementDiagnostic(diagnostics, 'sessionLogRewritten');

  const state = {
    seq: !rewritten && previous && Number.isSafeInteger(previous.seq) ? previous.seq : -1,
    sessionId: !rewritten && previous && typeof previous.sessionId === 'string' && previous.sessionId
      ? previous.sessionId
      : (sessionDirId || 'unknown')
  };

  const records = [];
  let bytesRead = 0;
  let index = rewritten ? 0 : Math.max(0, Math.min(storedFrame, bounds.length));
  let lastYieldAt = Date.now();
  for (; index < bounds.length; index += 1) {
    const start = bounds[index][0];
    const end = bounds[index][1];
    let text = null;
    try {
      text = zlib.zstdDecompressSync(buffer.subarray(start, end)).toString('utf8');
    } catch (_) {
      // 解不开的帧:不前进,下轮重试;已计入的记录不受影响。
      incrementDiagnostic(diagnostics, 'corruptFrame');
      break;
    }
    const added = consumeFrame(text, state, diagnostics, nowMs);
    for (const record of added) records.push(record);
    bytesRead += end - start;
    if (bytesRead >= maxBytes && index + 1 < bounds.length) {
      index += 1;
      break;
    }
    if (Date.now() - lastYieldAt >= yieldIntervalMs) {
      await yieldToLoop();
      lastYieldAt = Date.now();
    }
  }

  if (trailingFrom < totalBytes) incrementDiagnostic(diagnostics, 'sessionLogTailPartial');
  // 只有完整消费到文件末尾才算读完:预算中断或坏帧时 done=false,
  // 否则下一轮会把"其实还没读完"的同一文件当成未变化而跳过。
  const complete = index >= bounds.length;
  return {
    records,
    complete,
    bytesRead,
    cursor: {
      frameIndex: index,
      seq: state.seq,
      sessionId: state.sessionId,
      size: totalBytes,
      mtimeMs,
      done: complete
    }
  };
}

function retentionWindowDays(store) {
  const days = Number(store && typeof store.get === 'function' ? store.get('data.historyDays') : undefined);
  return Number.isFinite(days) && days > 0 ? days : 90;
}

// 读取 DSH 会话日志并合并进 usageDaily/usageDailyCost。
// 返回 { records, cursors, complete, bytesRead, empty };empty=true 表示本机没有会话日志,
// 调用方应回退到遥测文件读取(见 providers/dsh/index.js)。
async function readLocalLog(ctx, opts) {
  const store = ctx && ctx.store;
  const diagnostics = opts && opts.diagnostics;
  const requestedNowMs = opts && opts.nowMs;
  const parsedNowMs = Number(requestedNowMs);
  const nowMs = requestedNowMs !== null && requestedNowMs !== undefined && Number.isFinite(parsedNowMs)
    ? parsedNowMs
    : Date.now();
  const retainAll = !!(opts && opts.retainAll);
  const root = resolveSessionsRoot(store, process.env);
  const storedCursors = cloneStoreValue((store && store.get(CURSOR_KEY)) || {}) || {};
  const cursors = cloneStoreValue(storedCursors) || {};

  const candidates = [];
  for (const filePath of await listSessionFiles(root)) {
    let stat = null;
    try {
      stat = await fsp.stat(filePath);
    } catch (_) {
      continue;
    }
    candidates.push({ filePath, stat });
  }
  if (!candidates.length) {
    return { records: [], cursors, complete: true, bytesRead: 0, empty: true };
  }

  // 最近改动优先:活跃会话在本轮就出数,历史回溯在后续轮次补齐。
  candidates.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  const windowStart = nowMs - (retentionWindowDays(store) + FILE_WINDOW_MARGIN_DAYS) * 86400000;
  let remainingBudget = positiveInteger(opts && opts.maxBytesPerScan, DEFAULT_SCAN_BUDGET_BYTES);
  const records = [];
  let complete = true;
  let bytesRead = 0;

  for (const candidate of candidates) {
    const filePath = candidate.filePath;
    const stat = candidate.stat;
    const previous = cursors[filePath];
    const unchanged = previous
      && Number(previous.mtimeMs) === stat.mtimeMs
      && Number(previous.size) === stat.size
      && previous.done === true;
    if (unchanged) continue;
    if (stat.mtimeMs < windowStart) continue;
    if (remainingBudget <= 0 && records.length) {
      complete = false;
      break;
    }
    const scan = await scanSessionFile({
      filePath,
      sessionDirId: path.basename(path.dirname(filePath)),
      cursor: previous,
      mtimeMs: stat.mtimeMs,
      diagnostics,
      nowMs,
      maxBytes: remainingBudget,
      yieldToLoop: opts && opts.yieldToLoop,
      yieldIntervalMs: opts && opts.yieldIntervalMs
    });
    remainingBudget = Math.max(0, remainingBudget - scan.bytesRead);
    bytesRead += scan.bytesRead;
    if (scan.cursor) cursors[filePath] = scan.cursor;
    for (const record of scan.records) records.push(record);
    if (!scan.complete) {
      complete = false;
      break;
    }
  }

  applyDshRecordsToStore({
    store,
    records,
    cursors,
    storedCursors,
    diagnostics,
    nowMs,
    retainAll
  });
  return { records, cursors, complete, bytesRead, empty: false };
}

module.exports = {
  readLocalLog,
  listSessionFiles,
  scanSessionFile,
  frameBounds,
  sessionEventToRow,
  resolveSessionsRoot,
  SESSION_FILE_MATCH,
  DEFAULT_SCAN_BUDGET_BYTES
};
