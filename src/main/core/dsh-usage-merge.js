// 本地文件聚合(usageDaily/usageDailyCost)与 push 聚合(usageDailyPush/usageDailyCostPush)
// 的合并纯函数层。展示层、token-speed、MCP 投影统一从这里读 dsh 有效值。
const { filterUsageDaily } = require('./usage-retention');

const PUSH_USAGE_KEY = 'usageDailyPush';
const PUSH_COST_KEY = 'usageDailyCostPush';
const DSH_PREFIX = 'dsh:';

function emptyDailyRow() { return { input: 0, cached: 0, output: 0, total: 0 }; }

function mergeDshKeys(localDaily, pushDaily) {
  const base = localDaily && typeof localDaily === 'object' ? localDaily : {};
  const pushRows = pushDaily && typeof pushDaily === 'object' ? pushDaily : {};
  const pushKeys = Object.keys(pushRows).filter((key) => key.startsWith(DSH_PREFIX));
  // 没有 push 数据(常态)时**直接返回原对象,不深拷贝**:整份 usageDaily 可能几十 MB,
  // 而 get:heatmap 每次广播都被热力图与柱图各调一次(审查发现的主进程同步重活)。
  if (!pushKeys.length) return base;
  const merged = JSON.parse(JSON.stringify(base));
  pushKeys.forEach((key) => {
    const prev = merged[key] || emptyDailyRow();
    const add = pushRows[key] || emptyDailyRow();
    merged[key] = {
      input: (Number(prev.input) || 0) + (Number(add.input) || 0),
      cached: (Number(prev.cached) || 0) + (Number(add.cached) || 0),
      output: (Number(prev.output) || 0) + (Number(add.output) || 0),
      total: (Number(prev.total) || 0) + (Number(add.total) || 0)
    };
  });
  return merged;
}

function mergeDshCosts(localCost, pushCost) {
  const base = localCost && typeof localCost === 'object' ? localCost : {};
  const pushRows = pushCost && typeof pushCost === 'object' ? pushCost : {};
  const pushKeys = Object.keys(pushRows).filter((key) => key.startsWith(DSH_PREFIX));
  if (!pushKeys.length) return base;
  const merged = JSON.parse(JSON.stringify(base));
  pushKeys.forEach((key) => {
    merged[key] = Number(merged[key] || 0) + Number(pushRows[key] || 0);
  });
  return merged;
}

function readStore(store, key) {
  return (store && typeof store.get === 'function') ? store.get(key) : undefined;
}

function effectiveUsageDaily(store, historyDays, nowMs) {
  const merged = mergeDshKeys(readStore(store, 'usageDaily'), readStore(store, PUSH_USAGE_KEY));
  return filterUsageDaily(merged, historyDays, nowMs);
}

function effectiveUsageDailyCost(store, historyDays, nowMs) {
  const merged = mergeDshCosts(readStore(store, 'usageDailyCost'), readStore(store, PUSH_COST_KEY));
  return filterUsageDaily(merged, historyDays, nowMs);
}

function effectiveDshDayTotal(store, dayKey) {
  const local = readStore(store, 'usageDaily') || {};
  const push = readStore(store, PUSH_USAGE_KEY) || {};
  const l = local[DSH_PREFIX + dayKey];
  const p = push[DSH_PREFIX + dayKey];
  return (Number(l && l.total) || 0) + (Number(p && p.total) || 0);
}

module.exports = {
  PUSH_USAGE_KEY, PUSH_COST_KEY,
  mergeDshKeys, mergeDshCosts,
  effectiveUsageDaily, effectiveUsageDailyCost,
  effectiveDshDayTotal
};
