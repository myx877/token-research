// 本地日志 / 数据库类 provider 的公共落库步骤:
// 记录 → 日聚合(token + 金额) → 保留窗口过滤 → 增量并入 store。
// 幂等前提:传入的 records 只包含本次真正新增的记录(游标 + 指纹去重由各 provider 保证)。
const {
  rollupDaily,
  normalizeTimestampMs,
  localDayStr,
  incrementDiagnostic
} = require('./locallog');
const { filterUsageDaily } = require('./usage-retention');

const USAGE_KEY = 'usageDaily';
const COST_KEY = 'usageDailyCost';

// 金额日聚合:与 rollupDaily 共用同一套时间归一化与本地自然日,保证金额与 token 落在同一天。
// 只有真实金额来源(平台账单 / 会话自带 cost)才写入;折算金额一律不落库,避免与真实账单混淆。
function rollupDailyCost(records, diagnostics, nowMs) {
  const out = {};
  (records || []).forEach((rec) => {
    const cost = Number(rec && rec.cost);
    if (!Number.isFinite(cost) || cost === 0) return;
    const provider = rec && rec.provider;
    if (!provider) return;
    const ts = normalizeTimestampMs(rec && rec.ts, nowMs);
    if (ts === null) {
      incrementDiagnostic(diagnostics, 'invalidTimestamp');
      return;
    }
    const key = provider + ':' + localDayStr(ts);
    out[key] = (out[key] || 0) + cost;
  });
  return out;
}

// 加法并入:token 行为对象(input/cached/output/total),金额行为数字。
function mergeAdditive(target, addition) {
  Object.keys(addition).forEach((key) => {
    const add = addition[key];
    if (add && typeof add === 'object') {
      const prev = target[key] || { input: 0, cached: 0, output: 0, total: 0 };
      target[key] = {
        input: (Number(prev.input) || 0) + (Number(add.input) || 0),
        cached: (Number(prev.cached) || 0) + (Number(add.cached) || 0),
        output: (Number(prev.output) || 0) + (Number(add.output) || 0),
        total: (Number(prev.total) || 0) + (Number(add.total) || 0)
      };
    } else {
      target[key] = (Number(target[key]) || 0) + (Number(add) || 0);
    }
  });
  return target;
}

// 落库并返回本次并入的规模,供 scheduler 判断是否需要刷新界面。
// options: { retainAll } —— retainAll 表示全量重扫(历史同步),绕过保留窗口过滤。
function commitUsageRecords(store, records, diagnostics, nowMs, options) {
  const opts = options || {};
  const list = Array.isArray(records) ? records : [];
  const stats = { records: 0, days: 0, costDays: 0, tokens: 0, cost: 0 };
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function' || !list.length) {
    return stats;
  }
  // 缺 provider 的记录会聚合成 'undefined:<day>' 这种坏键并污染汇总:直接丢弃并记诊断,
  // 不让任何 provider 的字段遗漏变成静默的数据损坏。
  const usable = list.filter((rec) => {
    if (rec && rec.provider) return true;
    incrementDiagnostic(diagnostics, 'missingProvider');
    return false;
  });
  if (!usable.length) return stats;
  const historyDays = store.get('data.historyDays');
  const applyRetention = !opts.retainAll;
  const dailySource = rollupDaily(usable, diagnostics, nowMs);
  const costSource = rollupDailyCost(usable, diagnostics, nowMs);
  const daily = applyRetention ? filterUsageDaily(dailySource, historyDays, nowMs) : dailySource;
  const dailyCost = applyRetention ? filterUsageDaily(costSource, historyDays, nowMs) : costSource;

  if (Object.keys(daily).length) {
    store.set(USAGE_KEY, mergeAdditive(store.get(USAGE_KEY) || {}, daily));
  }
  if (Object.keys(dailyCost).length) {
    store.set(COST_KEY, mergeAdditive(store.get(COST_KEY) || {}, dailyCost));
  }

  stats.records = usable.length;
  stats.days = Object.keys(daily).length;
  stats.costDays = Object.keys(dailyCost).length;
  stats.tokens = usable.reduce(
    (sum, rec) => sum + (Number(rec && rec.usage && rec.usage.total) || 0), 0);
  stats.cost = usable.reduce((sum, rec) => sum + (Number(rec && rec.cost) || 0), 0);
  return stats;
}

module.exports = { commitUsageRecords, rollupDailyCost, mergeAdditive, USAGE_KEY, COST_KEY };
