// DeepSeek Provider 适配器:组装 usage/balance/session/proxy,对外暴露统一 ProviderAdapter 接口。
const { UsageFetcher } = require('./usage');
const { fetchBalance } = require('./balance');
const { isRetainedDay } = require('../../core/usage-retention');

const fetcher = new UsageFetcher();

// 平台用量只能按月查询,为让热力图/日聚合显示历史月份,每次轮询时向前回填这些月份。
const BACKFILL_MONTHS = 6;
// 已尝试抓取过的月份标记(含无数据月份,避免每轮轮询重复请求空月)。
const FETCHED_MONTHS_KEY = 'providers.deepseek.fetchedMonths';

function monthKey(y, m) {
  return y + '-' + String(m).padStart(2, '0');
}

function requestOptionsFor(ctx) {
  // ProviderContext supplies both functions in production. Keep direct-mode callers and
  // focused adapter tests compatible when they provide only the store boundary.
  if (!ctx || typeof ctx.getProxyUrl !== 'function') {
    return {
      httpGet: ctx && ctx.httpGet,
      proxyUrl: null
    };
  }
  return {
    httpGet: ctx.httpGet,
    proxyUrl: ctx.getProxyUrl()
  };
}

// 把 amount.dailyData 按日持久化到 store 键 'usageDaily'('deepseek:<date>'),
// 形状与 codex/kimi 本地日志聚合一致(input/cached/output/total),并附加 models 供热力图悬停明细。
// input 取 cacheMiss、output 取 completion(cached 单独成桶),与本地日志 provider 同口径,
// 否则日/周/月视图里 DeepSeek 的输入输出桶会恒为 0。
function persistDaily(store, dailyData) {
  if (!Array.isArray(dailyData) || !dailyData.length) return;
  const usageDaily = store.get('usageDaily') || {};
  let changed = false;
  dailyData.forEach((d) => {
    if (!d || !d.date) return;
    if (!isRetainedDay(d.date, store.get('data.historyDays'))) return;
    const total = Math.round(Number(d.total) || 0);
    if (total <= 0) return;
    usageDaily['deepseek:' + d.date] = {
      input: Math.round(Number(d.cacheMiss) || 0),
      cached: Math.round(Number(d.cacheHit) || 0),
      output: Math.round(Number(d.completion) || 0),
      total: total,
      models: (d.models || []).map((m) => ({ model: m.model, tokens: m.tokens }))
    };
    changed = true;
  });
  if (changed) store.set('usageDaily', usageDaily);
}

// 把 cost.dailyData(平台账单金额)按日持久化到 store 键 'usageDailyCost'
// ('deepseek:<date>' → 金额),供日/周/月金额视图使用。与 DSH 共用同一键与形状。
function persistDailyCost(store, costDailyData) {
  if (!Array.isArray(costDailyData) || !costDailyData.length) return;
  const usageDailyCost = store.get('usageDailyCost') || {};
  let changed = false;
  costDailyData.forEach((d) => {
    if (!d || !d.date) return;
    if (!isRetainedDay(d.date, store.get('data.historyDays'))) return;
    const cost = Number(d.total);
    if (!Number.isFinite(cost) || cost < 0) return;
    usageDailyCost['deepseek:' + d.date] = cost;
    changed = true;
  });
  if (changed) store.set('usageDailyCost', usageDailyCost);
}

// 回填当前月之前的 BACKFILL_MONTHS 个月:token 与金额都回填(日/周/月金额视图需要历史)。
// 已抓取过的月份(含空月)记录在 FETCHED_MONTHS_KEY,跳过;失败即停,下轮轮询重试。
// 金额回填单独兜异常:tokens 是热力图主口径,不能因金额接口失败而中断。
async function backfillMonths(store, token, month, year, requestOptions) {
  const done = new Set(store.get(FETCHED_MONTHS_KEY) || []);
  for (let i = 1; i <= BACKFILL_MONTHS; i++) {
    const d = new Date(year, month - 1 - i, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const key = monthKey(y, m);
    if (done.has(key)) continue;
    try {
      const amount = await fetcher.fetchUsageAmount(token, m, y, requestOptions);
      persistDaily(store, amount.dailyData);
      try {
        const cost = await fetcher.fetchUsageCost(token, m, y, requestOptions);
        persistDailyCost(store, cost.dailyData);
      } catch (_) {
        // 金额回填失败不影响 token 回填与后续月份。
      }
      done.add(key);
      store.set(FETCHED_MONTHS_KEY, Array.from(done));
    } catch (e) {
      break;
    }
  }
}

module.exports = {
  id: 'deepseek',
  displayName: 'DeepSeek',
  capabilities: { balance: true, webUsage: true, quota: false, localLog: false, realtimeProxy: true },

  authStatus(ctx) {
    return ctx.store.get('providers.deepseek.sessionToken') ? 'ok' : 'missing';
  },

  // 可选:余额(预付制)。
  fetchBalance(ctx) {
    const apiKey = ctx.store.get('providers.deepseek.apiKey');
    if (!apiKey) return Promise.resolve(null);
    return fetchBalance(apiKey, requestOptionsFor(ctx));
  },

  // 可选:web 用量(保持 DeepSeek 现有返回形状 { cost, amount, month, year, fellBack })。
  // 抓取成功后把日数据持久化进 store(热力图跨月显示),并回填历史月份。
  fetchUsage(ctx, { month, year }) {
    const token = ctx.store.get('providers.deepseek.sessionToken');
    if (!token) return Promise.resolve(null);
    const requestOptions = requestOptionsFor(ctx);
    return fetcher.fetchUsageWithFallback(
      token,
      month,
      year,
      requestOptions
    ).then((usage) => {
      if (usage && usage.amount) persistDaily(ctx.store, usage.amount.dailyData);
      if (usage && usage.cost) persistDailyCost(ctx.store, usage.cost.dailyData);
      return backfillMonths(
        ctx.store,
        token,
        month,
        year,
        requestOptions
      ).then(() => usage);
    });
  }

  // quota: 无(预付制,额度即余额)
  // readLocalLog: 无(平台侧日志不落本机)
};
