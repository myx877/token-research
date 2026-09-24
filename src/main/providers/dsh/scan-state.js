// DSH 扫描结果提交:usageDaily / usageDailyCost / localLogCursors.dsh 的归并与原子提交。
// 会话日志(官方)与遥测文件(自建生产者)两条来源共用本模块 —— 禁止两处实现不同口径。
const { rollupDshRecords } = require('./usage-records');

const CURSOR_KEY = 'localLogCursors.dsh';

function cloneStoreValue(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

// Deep-compare cursor maps (file identity keys, stable JSON serialization).
// This identifies cursor advancement that must be persisted after a scan.
function cursorsChanged(stored, next) {
  return JSON.stringify(stored || {}) !== JSON.stringify(next || {});
}

// 快照式原子提交:usageDaily、usageDailyCost 与游标同属一份持久单元
// (仿 codex commitUuidScanState;electron-store 的 store 快照替换失败时退化为逐键提交)。
function commitDshScanState(store, usageDaily, usageDailyCost, cursors) {
  const snapshot = store && store.store;
  if (snapshot && typeof snapshot === 'object') {
    const copy = cloneStoreValue(snapshot);
    copy.usageDaily = usageDaily;
    copy.usageDailyCost = usageDailyCost;
    copy.localLogCursors = Object.assign(
      copy.localLogCursors && typeof copy.localLogCursors === 'object' ? copy.localLogCursors : {},
      { dsh: cursors }
    );
    store.store = copy;
    return;
  }
  // 回退路径(electron-store 无 store.store 快照时):单次多键 set 一次落盘
  // (conf.set(object) 逐个应用键后整体 _write);dot 键 localLogCursors.dsh
  // 写入嵌套路径且保留其他 provider 游标。失败时同样单次多键 set 还原三键
  // (含游标),消除三次独立 set 之间的崩溃窗口。
  const previous = {
    'usageDaily': cloneStoreValue(store.get('usageDaily')) || {},
    'usageDailyCost': cloneStoreValue(store.get('usageDailyCost')) || {},
    [CURSOR_KEY]: cloneStoreValue(store.get(CURSOR_KEY)) || {}
  };
  try {
    store.set({
      'usageDaily': usageDaily,
      'usageDailyCost': usageDailyCost,
      [CURSOR_KEY]: cursors
    });
  } catch (error) {
    try {
      store.set(previous);
    } catch (_) { /* 保留原始提交失败 */ }
    throw error;
  }
}

// 把一次扫描的记录按日归并进 store。有记录时合并并提交;只有游标前进时也提交
// (否则下次扫描会重放已处理区间)。records 为空且游标未动 = 什么都不写。
function applyDshRecordsToStore({ store, records, cursors, storedCursors, diagnostics, nowMs, retainAll }) {
  const list = records || [];
  let usageDaily = cloneStoreValue((store && store.get('usageDaily')) || {});
  let usageDailyCost = cloneStoreValue((store && store.get('usageDailyCost')) || {});
  if (list.length && store) {
    const { filterUsageDaily } = require('../../core/usage-retention');
    const rolledAll = rollupDshRecords(list, diagnostics, nowMs);
    const daily = retainAll
      ? rolledAll.usageDaily
      : filterUsageDaily(rolledAll.usageDaily, store.get('data.historyDays'), nowMs);
    Object.keys(daily).forEach((key) => {
      const prev = usageDaily[key] || { input: 0, cached: 0, output: 0, total: 0 };
      const add = daily[key];
      usageDaily[key] = {
        input: prev.input + add.input,
        cached: prev.cached + add.cached,
        output: prev.output + add.output,
        total: prev.total + add.total
      };
    });

    const costDaily = retainAll
      ? rolledAll.usageDailyCost
      : filterUsageDaily(rolledAll.usageDailyCost, store.get('data.historyDays'), nowMs);
    Object.keys(costDaily).forEach((key) => {
      usageDailyCost[key] = Number(usageDailyCost[key] || 0) + Number(costDaily[key]);
    });
    commitDshScanState(store, usageDaily, usageDailyCost, cursors || {});
  } else if (store && cursorsChanged(storedCursors, cursors)) {
    // Persist cursor advancement even when a scan emits no records.
    commitDshScanState(store, usageDaily, usageDailyCost, cursors || {});
  }
}

module.exports = {
  CURSOR_KEY,
  cloneStoreValue,
  cursorsChanged,
  commitDshScanState,
  applyDshRecordsToStore
};
