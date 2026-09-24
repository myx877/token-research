/**
 * 验证 opencode 采集的"冷启动分页"行为:反复调用 readLocalLog,
 * 看累计金额是否在多轮后收敛到库内真实总额(研究阶段实测 ∑cost = 19.709292852)。
 *
 * 用法: node scripts/probe-opencode-backfill.js [轮数]
 */
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { aggregateUsage } = require(path.join(ROOT, 'src/main/core/usage-buckets.js'));
const { USAGE_KEY, COST_KEY } = require(path.join(ROOT, 'src/main/core/usage-commit.js'));
const opencodeDb = require(path.join(ROOT, 'src/main/providers/opencode/usage-db.js'));

const makeStore = () => {
  const data = {};
  return {
    get(key) { return key in data ? structuredClone(data[key]) : undefined; },
    set(key, value) { data[key] = structuredClone(value); }
  };
};

(async () => {
  const passes = Number(process.argv[2]) || 8;
  const store = makeStore();
  const diagnostics = {};
  let cumulative = 0;
  console.log('轮次  本轮记录  累计记录  累计金额($)  累计日键数');
  for (let i = 1; i <= passes; i += 1) {
    const batch = await opencodeDb.readLocalLog({ store }, { diagnostics: diagnostics });
    cumulative += batch.records.length;
    const usage = store.get(USAGE_KEY) || {};
    const cost = store.get(COST_KEY) || {};
    const res = aggregateUsage(usage, cost, { bucket: 'month' });
    const total = Object.keys(res.totals.costByCurrency || {}).reduce((s, c) => s + res.totals.costByCurrency[c], 0);
    console.log(String(i).padStart(4) + String(batch.records.length).padStart(10)
      + String(cumulative).padStart(10) + total.toFixed(6).padStart(14)
      + String(Object.keys(usage).length).padStart(12));
    if (!batch.records.length) { console.log('(本轮无新记录 → 已到库尾)'); break; }
  }
  const usage = store.get(USAGE_KEY) || {};
  const cost = store.get(COST_KEY) || {};
  const res = aggregateUsage(usage, cost, { bucket: 'month' });
  console.log('\n最终分币种: ' + JSON.stringify(res.totals.costByCurrency));
  console.log('研究阶段实测库内总额基线: $19.709292852');
  console.log('诊断: ' + JSON.stringify(diagnostics));
})().catch((e) => {
  console.error('探针失败: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
