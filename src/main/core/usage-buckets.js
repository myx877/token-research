// 用量分桶:自然日 / 自然周(ISO 8601,周一起) / 自然月 × provider 聚合(纯函数可测)。
// 数据源(只读,不改写任何既有键):
//   usageDaily     = { '<provider>:<YYYY-MM-DD>': { input, cached, output, total } }
//   usageDailyCost = { '<provider>:<YYYY-MM-DD>': number }
// 周/月不落新存储键:读取时按日键聚合,零迁移、天然幂等、体积不膨胀。

const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const BUCKETS = ['day', 'week', 'month'];

const {
  beijingDayKey,
  addBeijingDays,
  beijingDayStartMs,
  millisecondsUntilNextBeijingMidnight
} = require('./beijing-calendar');
const { retentionStartDay } = require('./usage-retention');

// 单平台窗口卡的三个窗口名(与用户的「每日 / 每周 / 每月」口径一致)。
const WINDOW_LABELS = Object.freeze({ day: '今日', week: '本周', month: '本月' });

// 金额来源口径:real = 真实计费来源;derived = 按定价表折算;null = 无可用金额。
const COST_SOURCE = Object.freeze({
  deepseek: 'real',
  dsh: 'real',
  opencode: 'real',
  claude: 'derived',
  codex: null,
  kimi: null
});

// 各 provider 金额的计价币种。不同币种**绝不跨币种求和**(DeepSeek 平台账单为 ¥,
// opencode 的 cost 来自 models.dev 定价表为 $),总计按币种分组给出。
// claude 记 CNY:其金额只能由本仓定价表(¥/1000 tokens)折算,币种随定价表。
const CURRENCY = Object.freeze({
  deepseek: 'CNY',
  dsh: 'CNY',
  kimi: 'CNY',
  claude: 'CNY',
  opencode: 'USD',
  codex: 'USD'
});

function pad2(n) {
  return String(n).padStart(2, '0');
}

function readNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function roundTokens(n) {
  return Math.round(n);
}

// 金额保留 6 位小数:定价单位为 ¥/1000 tokens,单日常见量级远小于 1 元,不能四舍五入到分。
function roundMoney(n) {
  return Math.round(n * 1e6) / 1e6;
}

// 'YYYY-MM-DD' → { year, month, day };非法或不存在(如 2026-02-30)返回 null。
function parseDayKey(dayKey) {
  const match = DAY_KEY_PATTERN.exec(typeof dayKey === 'string' ? dayKey : '');
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year
    || probe.getUTCMonth() !== month - 1
    || probe.getUTCDate() !== day
  ) return null;
  return { year, month, day };
}

function monthKeyFromDay(dayKey) {
  const parsed = parseDayKey(dayKey);
  return parsed ? parsed.year + '-' + pad2(parsed.month) : null;
}

// ISO 8601 周键:周一为周首;含该年第一个周四的那一周为 W01(跨年日按 ISO 规则归属)。
// 例:2025-12-29 → 2026-W01;2027-01-01 → 2026-W53。
function isoWeekKey(dayKey) {
  const parsed = parseDayKey(dayKey);
  if (!parsed) return null;
  const thursday = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  thursday.setUTCDate(thursday.getUTCDate() - ((thursday.getUTCDay() + 6) % 7) + 3);
  const isoYear = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  firstThursday.setUTCDate(
    firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3
  );
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / WEEK_MS);
  return isoYear + '-W' + pad2(week);
}

function bucketKeyForDay(dayKey, bucket) {
  if (bucket === 'month') return monthKeyFromDay(dayKey);
  if (bucket === 'week') return isoWeekKey(dayKey);
  return parseDayKey(dayKey) ? dayKey : null;
}

// '<provider>:<YYYY-MM-DD>' → { provider, day };畸形键返回 null。
function splitStoreKey(storeKey) {
  const text = typeof storeKey === 'string' ? storeKey : '';
  const idx = text.indexOf(':');
  if (idx <= 0) return null;
  const provider = text.slice(0, idx);
  const day = text.slice(idx + 1);
  return parseDayKey(day) ? { provider: provider, day: day } : null;
}

// 日粒度基础行。opts: { provider|'all', from, to }(from/to 为 'YYYY-MM-DD',含边界)。
function dayRows(usageDaily, usageDailyCost, options) {
  const opts = options || {};
  const usage = usageDaily && typeof usageDaily === 'object' ? usageDaily : {};
  const cost = usageDailyCost && typeof usageDailyCost === 'object' ? usageDailyCost : {};
  const rows = [];
  Object.keys(usage).forEach((storeKey) => {
    const split = splitStoreKey(storeKey);
    if (!split) return;
    if (opts.provider && opts.provider !== 'all' && split.provider !== opts.provider) return;
    if (opts.from && split.day < opts.from) return;
    if (opts.to && split.day > opts.to) return;
    const entry = usage[storeKey] || {};
    const row = {
      day: split.day,
      provider: split.provider,
      input: readNumber(entry.input),
      cached: readNumber(entry.cached),
      output: readNumber(entry.output),
      total: readNumber(entry.total),
      cost: readNumber(cost[storeKey])
    };
    if (row.total <= 0 && row.cost <= 0) return;
    rows.push(row);
  });
  rows.sort((a, b) => (a.provider === b.provider
    ? (a.day < b.day ? -1 : a.day > b.day ? 1 : 0)
    : (a.provider < b.provider ? -1 : 1)));
  return rows;
}

// 订阅摊薄估算(供「可隐藏的估算列」使用):以自然月为计费周期,
// 某日估算 = 月费 × 该日 token / 该月 token。周期内各日之和恒等于月费。
// monthlyFee 形如 { claude: 140, codex: 0 }:未配置或 ≤0 的 provider 不产生估算。
function estimateSubscriptionDaily(rows, monthlyFee) {
  const fees = monthlyFee && typeof monthlyFee === 'object' ? monthlyFee : {};
  const monthTokens = {};
  (rows || []).forEach((row) => {
    if (readNumber(fees[row.provider]) <= 0 || row.total <= 0) return;
    const month = monthKeyFromDay(row.day);
    if (!month) return;
    monthTokens[row.provider] = monthTokens[row.provider] || {};
    monthTokens[row.provider][month] = (monthTokens[row.provider][month] || 0) + row.total;
  });
  const out = {};
  (rows || []).forEach((row) => {
    const fee = readNumber(fees[row.provider]);
    if (fee <= 0 || row.total <= 0) return;
    const month = monthKeyFromDay(row.day);
    const total = monthTokens[row.provider] && monthTokens[row.provider][month];
    if (!total) return;
    out[row.provider + ':' + row.day] = fee * (row.total / total);
  });
  return out;
}

function rowOrder(a, b) {
  if (a.bucketKey !== b.bucketKey) return a.bucketKey < b.bucketKey ? -1 : 1;
  if (a.provider !== b.provider) return a.provider < b.provider ? -1 : 1;
  return 0;
}

// 主入口:把日聚合按指定粒度汇总成 provider 维度的行 + 总计。
// opts: { bucket:'day'|'week'|'month', provider, from, to, monthlyFee }
function aggregateUsage(usageDaily, usageDailyCost, options) {
  const opts = options || {};
  const bucket = BUCKETS.indexOf(opts.bucket) >= 0 ? opts.bucket : 'day';
  const rows = dayRows(usageDaily, usageDailyCost, opts);
  const estimates = estimateSubscriptionDaily(rows, opts.monthlyFee);
  const grouped = {};
  rows.forEach((row) => {
    const key = bucketKeyForDay(row.day, bucket);
    if (!key) return;
    const id = key + '\u0000' + row.provider;
    const acc = grouped[id] || {
      bucket: bucket,
      bucketKey: key,
      provider: row.provider,
      input: 0,
      cached: 0,
      output: 0,
      total: 0,
      cost: 0,
      estimatedCost: 0
    };
    acc.input += row.input;
    acc.cached += row.cached;
    acc.output += row.output;
    acc.total += row.total;
    acc.cost += row.cost;
    acc.estimatedCost += readNumber(estimates[row.provider + ':' + row.day]);
    grouped[id] = acc;
  });
  const out = Object.keys(grouped).map((id) => {
    const row = grouped[id];
    return {
      bucket: row.bucket,
      bucketKey: row.bucketKey,
      provider: row.provider,
      input: roundTokens(row.input),
      cached: roundTokens(row.cached),
      output: roundTokens(row.output),
      total: roundTokens(row.total),
      cost: roundMoney(row.cost),
      costSource: COST_SOURCE[row.provider] || null,
      currency: CURRENCY[row.provider] || null,
      estimatedCost: roundMoney(row.estimatedCost)
    };
  });
  out.sort(rowOrder);
  const totals = {
    input: 0, cached: 0, output: 0, total: 0, estimatedByCurrency: {}, costByCurrency: {}
  };
  out.forEach((row) => {
    totals.input += row.input;
    totals.cached += row.cached;
    totals.output += row.output;
    totals.total += row.total;
    // 估算同样按币种分开累计:codex($) 与 claude(¥) 的订阅摊薄绝不相加,
    // 否则表尾会给出符号与实际口径都不对的数字。
    if (row.estimatedCost) {
      const currency = row.currency || 'UNKNOWN';
      totals.estimatedByCurrency[currency] = roundMoney((totals.estimatedByCurrency[currency] || 0) + row.estimatedCost);
    }
    if (row.cost) {
      const currency = row.currency || 'UNKNOWN';
      totals.costByCurrency[currency] = roundMoney((totals.costByCurrency[currency] || 0) + row.cost);
    }
  });
  return { bucket: bucket, rows: out, totals: totals };
}

// 出现在数据里的 provider 列表(降序按总量),供展示层动态渲染,不硬编码平台。
function listProviders(usageDaily) {
  const usage = usageDaily && typeof usageDaily === 'object' ? usageDaily : {};
  const totals = {};
  Object.keys(usage).forEach((storeKey) => {
    const split = splitStoreKey(storeKey);
    if (!split) return;
    totals[split.provider] = (totals[split.provider] || 0) + readNumber(usage[storeKey] && usage[storeKey].total);
  });
  return Object.keys(totals)
    .filter((provider) => totals[provider] > 0)
    .sort((a, b) => (totals[b] - totals[a]) || (a < b ? -1 : 1));
}

// 当前窗口(今日 / 本周 / 本月)的起止日键、区间标识与重置时刻。
// 边界一律走北京时间结算日历(固定 UTC+8),与采集侧写日键的口径严格一致——
// 用系统本地时区会让「今日」在跨时区/夏令时下与数据错位。
function currentWindowRange(bucket, nowMs) {
  const bucketName = BUCKETS.indexOf(bucket) >= 0 ? bucket : 'day';
  const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now();
  const today = beijingDayKey(now);
  const parts = parseDayKey(today);
  if (!parts) return null;

  if (bucketName === 'day') {
    return {
      bucket: 'day',
      bucketKey: today,
      from: today,
      to: today,
      // 今日窗口在下一个北京零点重置
      resetsAt: now + millisecondsUntilNextBeijingMidnight(now)
    };
  }

  if (bucketName === 'week') {
    // ISO 周:周一起;下周一同一天零点重置
    const weekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay(); // 0=周日
    const from = addBeijingDays(today, -((weekday + 6) % 7));
    const to = addBeijingDays(from, 6);
    return {
      bucket: 'week',
      bucketKey: isoWeekKey(today),
      from: from,
      to: to,
      resetsAt: beijingDayStartMs(addBeijingDays(to, 1))
    };
  }

  // 自然月:下月 1 日零点重置(Date.UTC 的月份溢出天然处理跨年)
  const monthKey = monthKeyFromDay(today);
  const lastDate = new Date(Date.UTC(parts.year, parts.month, 0)).getUTCDate();
  const to = monthKey + '-' + pad2(lastDate);
  return {
    bucket: 'month',
    bucketKey: monthKey,
    from: monthKey + '-01',
    to: to,
    resetsAt: beijingDayStartMs(addBeijingDays(to, 1))
  };
}

// 预算读取:budgets = { <provider>: { day, week, month } };非正数或缺失一律视为「未设预算」。
function readWindowBudget(budgets, provider, bucket) {
  const table = budgets && typeof budgets === 'object' ? budgets[provider] : null;
  if (!table || typeof table !== 'object') return 0;
  const amount = readNumber(table[bucket]);
  return amount > 0 ? amount : 0;
}

// 单平台窗口卡数据:今日 / 本周 / 本月各自的 token、金额、重置倒计时与预算百分比。
// 百分比只按用户真实配置的预算算;没设预算就返回 percent=null(绝不编分母)。
// opts: { provider, now, budgets(金额预算), tokenBudgets(Token 预算,可选), monthlyFee, historyDays }
// historyDays = 设置里的"历史数据保留"天数。周期起点早于保留起点时**可能**被裁过,
// 但"残缺"是**数据驱动**判定的,详见下面 earliestDay / truncated 的注释。
function usageWindows(usageDaily, usageDailyCost, options) {
  const opts = options || {};
  const provider = typeof opts.provider === 'string' ? opts.provider : '';
  const now = Number.isFinite(Number(opts.now)) ? Number(opts.now) : Date.now();
  const historyDays = Number(opts.historyDays);
  const retentionStart = Number.isInteger(historyDays) && historyDays > 0
    ? retentionStartDay(historyDays, now)
    : null;

  /* ---- 残缺判定必须看"数据实际覆盖到哪天",不能只看设置 ----
     真实需求是"别把残缺值当整月展示",所以判据应该是**这个周期真的缺了一段**,而不是
     "设置的天数恰好比周期短"。只做静态比较(周期起点 < 保留起点)会有一个必然的假阳性:
     用户点过「同步历史」补齐历史之后,库里已经有更早的日桶,数字就是整月,
     而界面会**一直**挂着"仅统计近 N 天" —— 实测用户被这条假提示困扰,要求删掉它。
     正确判据:库里存在早于保留起点的日桶 ⇒ 数据没被裁(补齐过),不算残缺。 */
  const providerRows = provider && provider !== 'all'
    ? dayRows(usageDaily, usageDailyCost, { provider: provider })
    : [];
  const earliestDay = providerRows.length > 0 ? providerRows[0].day : null;

  /* ---- 订阅摊薄估算的**分母必须在整月上行算** ----
     estimateSubscriptionDaily 的公式是「月费 × 当日 token / 当月 token」。如果只把窗口内的
     行喂进去,"今日"窗口的分母就等于分子,算出来的今日估算直接等于整月订阅费(实测踩过:
     订阅 ¥140 的平台,今日条上显示 ≈¥140)。
     所以先用整月的行算出"每日估算",再按窗口范围取和:日=当天那份、周=本周各天之和、
     月=整月各天之和(恰好等于月费)。 */
  const monthRange = currentWindowRange('month', now);
  const estimateRows = monthRange
    ? dayRows(usageDaily, usageDailyCost, { provider: provider, from: monthRange.from, to: monthRange.to })
    : [];
  const dailyEstimates = estimateSubscriptionDaily(estimateRows, opts.monthlyFee);

  const windows = BUCKETS.map((bucket) => {
    const range = currentWindowRange(bucket, now);
    const agg = aggregateUsage(usageDaily, usageDailyCost, {
      bucket: bucket,
      provider: provider,
      from: range.from,
      to: range.to,
      monthlyFee: opts.monthlyFee
    });
    const costByCurrency = agg.totals.costByCurrency || {};
    // 单平台只有一个计价币种;缺失时退回窗口内唯一出现的币种
    const currency = CURRENCY[provider] || Object.keys(costByCurrency)[0] || null;
    const cost = roundMoney(costByCurrency[currency] || 0);

    let estimatedCost = 0;
    Object.keys(dailyEstimates).forEach((key) => {
      const split = splitStoreKey(key);
      if (!split || split.provider !== provider) return;
      if (split.day < range.from || split.day > range.to) return;
      estimatedCost += dailyEstimates[key];
    });

    // 金额预算优先,其次 Token 预算;都没有则不给百分比
    const costBudget = readWindowBudget(opts.budgets, provider, bucket);
    const tokenBudget = readWindowBudget(opts.tokenBudgets, provider, bucket);
    let budgetBasis = null;
    let budget = 0;
    let percent = null;
    if (costBudget > 0) {
      budgetBasis = 'cost';
      budget = costBudget;
      /* 分子优先真实账单;**没有真实计费的平台**(codex/kimi 是订阅制,COST_SOURCE=null)
         只有摊薄估算可用,此时用估算当分子 —— 否则那条预算会永远显示 0%,
         而同一行右下角的费用列却写着 ≈金额,两个数字自相矛盾(审查发现)。 */
      const spent = cost > 0 ? cost : estimatedCost;
      percent = Math.round((spent / costBudget) * 1000) / 10;
    } else if (tokenBudget > 0) {
      budgetBasis = 'tokens';
      budget = tokenBudget;
      percent = Math.round((agg.totals.total / tokenBudget) * 1000) / 10;
    }

    return {
      key: bucket,
      label: WINDOW_LABELS[bucket],
      bucketKey: range.bucketKey,
      from: range.from,
      to: range.to,
      resetsAt: range.resetsAt,
      input: agg.totals.input,
      cached: agg.totals.cached,
      output: agg.totals.output,
      total: agg.totals.total,
      cost: cost,
      estimatedCost: roundMoney(estimatedCost),
      currency: currency,
      budget: budget,
      budgetBasis: budgetBasis,
      percent: percent,
      over: percent !== null && percent > 100,
      // 残缺 = ①设置上可能裁到(周期起点早于保留起点)②这个周期确实有数据 ③库里的日桶
      // 最早也只到保留起点之后(说明保留起点之前那段确实没有数据)。
      // 三条同时成立才算残缺 —— 只凭①会在"同步历史补齐后"一直误报(实测)。
      truncated: !!(
        retentionStart
        && typeof range.from === 'string'
        && range.from < retentionStart
        && agg.rows.length > 0
        && (earliestDay === null || earliestDay >= retentionStart)
      )
    };
  });
  return {
    provider: provider,
    currency: CURRENCY[provider] || null,
    retention: retentionStart ? { historyDays: historyDays, startDay: retentionStart } : null,
    windows: windows
  };
}

module.exports = {
  BUCKETS,
  WINDOW_LABELS,
  COST_SOURCE,
  CURRENCY,
  parseDayKey,
  monthKeyFromDay,
  isoWeekKey,
  bucketKeyForDay,
  splitStoreKey,
  dayRows,
  estimateSubscriptionDaily,
  aggregateUsage,
  listProviders,
  currentWindowRange,
  usageWindows
};
