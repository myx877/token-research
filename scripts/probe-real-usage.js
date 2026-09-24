/**
 * 真实数据端到端探针:用本机真实的 claude 本地日志 + opencode.db 走一遍
 * 采集 → 写入 store → 按日/周/月聚合 的完整链路,并打印每个平台、每个币种的数字。
 * 只读:不改动用户任何文件,只在内存里建一个 electron-store 形状的假 store。
 *
 * 用法: node scripts/probe-real-usage.js
 */
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { aggregateUsage, listProviders, usageWindows } = require(path.join(ROOT, 'src/main/core/usage-buckets.js'));
const { commitUsageRecords, USAGE_KEY, COST_KEY } = require(path.join(ROOT, 'src/main/core/usage-commit.js'));
const claudeLog = require(path.join(ROOT, 'src/main/providers/claude/locallog.js'));
const opencodeDb = require(path.join(ROOT, 'src/main/providers/opencode/usage-db.js'));

// electron-store 形状的内存替身(get 返回副本,避免探针掩盖引用共享问题)
const makeStore = () => {
  const data = {};
  return {
    get(key) { return key in data ? structuredClone(data[key]) : undefined; },
    set(key, value) { data[key] = structuredClone(value); },
    get raw() { return data; }
  };
};

const yen = (n) => (Number(n) || 0).toFixed(2);

(async () => {
  const store = makeStore();
  const diagnostics = {};
  const nowMs = Date.now();

  console.log('=== 采集(真实本机数据,只读) ===');
  console.log('claude 日志根目录存在: ' + (await claudeLog.claudeLogAvailable(store)));
  console.log('opencode 数据库存在:   ' + opencodeDb.opencodeDbAvailable(store));

  const claudeBatch = await claudeLog.readLocalLog(
    { store, canAccessPath: () => true },
    { diagnostics, nowMs }
  );
  const opencodeBatch = await opencodeDb.readLocalLog({ store }, { diagnostics, nowMs, nowMs: nowMs });

  console.log('claude 记录数:   ' + claudeBatch.records.length);
  console.log('opencode 记录数: ' + opencodeBatch.records.length);

  const usage = store.get(USAGE_KEY) || {};
  const cost = store.get(COST_KEY) || {};
  const dayKeys = Object.keys(usage);
  console.log('store 日键数:    ' + dayKeys.length + '(' + USAGE_KEY + ')');
  console.log('store 金额键数:  ' + Object.keys(cost).length + '(' + COST_KEY + ')');
  const bad = dayKeys.filter((k) => k.indexOf('undefined') === 0 || k.indexOf('NaN') === 0);
  console.log('坏键(undefined:/NaN:): ' + bad.length + (bad.length ? ' → ' + bad.slice(0, 3).join(',') : ' ✓'));
  console.log('诊断: ' + JSON.stringify(diagnostics));
  console.log('provider 列表(按总量降序): ' + JSON.stringify(listProviders(usage)));

  ['day', 'week', 'month'].forEach((bucket) => {
    const res = aggregateUsage(usage, cost, { bucket: bucket });
    console.log('\n=== 桶=' + bucket + ' ===');
    console.log('区间数: ' + new Set(res.rows.map((r) => r.bucketKey)).size + '  行数: ' + res.rows.length);
    const byProvider = {};
    res.rows.forEach((r) => {
      const p = byProvider[r.provider] || (byProvider[r.provider] = {
        total: 0, input: 0, cached: 0, output: 0, cost: 0, currency: r.currency, costSource: r.costSource, keys: []
      });
      p.total += r.total; p.input += r.input; p.cached += r.cached; p.output += r.output; p.cost += r.cost;
      p.keys.push(r.bucketKey);
    });
    Object.keys(byProvider).forEach((p) => {
      const v = byProvider[p];
      console.log('  ' + p.padEnd(9)
        + ' token=' + String(v.total).padStart(12)
        + ' (in=' + v.input + ' cached=' + v.cached + ' out=' + v.output + ')'
        + '  金额=' + (v.currency === 'CNY' ? '¥' : v.currency === 'USD' ? '$' : '?') + yen(v.cost)
        + '  口径=' + String(v.costSource)
        + '  区间=' + v.keys.length);
    });
    const cur = res.totals.costByCurrency || {};
    console.log('  分币种合计: ' + (Object.keys(cur).length
      ? Object.keys(cur).map((c) => (c === 'CNY' ? '¥' : c === 'USD' ? '$' : c + ' ') + yen(cur[c])).join(' + ')
      : '(无真实金额)')
      + '   token 合计=' + res.totals.total);
    const keysNewest = Array.from(new Set(res.rows.map((r) => r.bucketKey))).sort().reverse().slice(0, 3);
    console.log('  最近区间: ' + keysNewest.join(', '));
  });

  // 单平台窗口卡:今日 / 本周 / 本月(真实数据;预算用演示值,只为展示百分比算术)
  console.log('\n=== 单平台窗口卡(今日 / 本周 / 本月;真实数据) ===');
  const sym = (c) => (c === 'CNY' ? '¥' : c === 'USD' ? '$' : String(c || '?'));
  listProviders(usage).forEach((p) => {
    const noBudget = usageWindows(usage, cost, { provider: p });
    const demoBudget = { [p]: { day: 5, week: 20, month: 50 } };
    const withBudget = usageWindows(usage, cost, { provider: p, budgets: demoBudget });
    console.log('  ' + p + '(' + sym(noBudget.currency) + ')');
    noBudget.windows.forEach((w, i) => {
      const b = withBudget.windows[i];
      console.log('    ' + w.label
        + '  ' + w.bucketKey
        + '  token=' + String(w.total).padStart(11)
        + '  金额=' + sym(w.currency) + yen(w.cost)
        + '  | 未设预算 → 百分比=' + (w.percent === null ? 'null(不显示)' : w.percent + '%')
        + '  | 演示预算 ' + sym(w.currency) + b.budget + ' → ' + b.percent + '%'
        + (b.over ? ' [超预算]' : '')
        + '  重置时刻=' + new Date(w.resetsAt).toISOString());
    });
  });

  // 交叉核对:研究阶段实测 opencode 库内 ∑cost = 19.709292852(库会增长,故这里应 >=)
  const opencodeRows = aggregateUsage(usage, cost, { bucket: 'month' }).rows.filter((r) => r.provider === 'opencode');
  const opencodeCost = opencodeRows.reduce((s, r) => s + r.cost, 0);
  console.log('\n=== 交叉核对 ===');
  console.log('opencode 累计金额 = $' + yen(opencodeCost) + '(研究阶段实测基线 $19.71,库增长后应 >= 该值)');
  console.log('claude 是否有真实金额: ' + (cost && Object.keys(cost).some((k) => k.indexOf('claude:') === 0) ? '有' : '无(需定价表或订阅摊薄)'));
})().catch((e) => {
  console.error('探针失败: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
