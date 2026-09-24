// Token 活动热力图的纯函数(node 可测)。
//
// 列口径:**周一开头**(ISO 口径),与进度条的「本周」严格同源 —— 否则「每周」模式最右边
// 那一列的总数和上面「本周」的数字会差一天(曾经就是这样:热力图跟着 GitHub 走周日,
// 进度条跟着 ISO 走周一,同一屏两个"周")。

const DATE_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const pad = (n) => String(n).padStart(2, '0');
const DAY_MS = 24 * 60 * 60 * 1000;
const dayKey = (date) => date.getUTCFullYear() + '-' + pad(date.getUTCMonth() + 1) + '-' + pad(date.getUTCDate());

function parseCalendarDay(value) {
  const match = typeof value === 'string' ? DATE_KEY_PATTERN.exec(value) : null;
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(0);
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return date;
}

// 周一=0 … 周日=6(与 Date#getUTCDay 的周日=0 相反,这里显式换算,避免两套下标混用)
function mondayIndex(date) {
  return (date.getUTCDay() + 6) % 7;
}

// 构造某年 53 列 × 7 行网格:每列 = 一周(周一起),每行 = 星期几(0=周一)。
// 首列为该年 1 月 1 日所在周的周一(可能落在前一年);最后一列补足到 7 天。
export function buildWeeks(year) {
  const start = new Date(Date.UTC(year, 0, 1, 12));
  start.setUTCDate(start.getUTCDate() - mondayIndex(start));
  const end = new Date(Date.UTC(year, 11, 31, 12));
  const totalDays = Math.floor((end.getTime() - start.getTime()) / DAY_MS) + 1;

  const weeks = [];
  let d = 0;
  while (d < totalDays) {
    const date = new Date(start.getTime() + d * DAY_MS);
    const col = Math.floor(d / 7);
    const row = d % 7;
    if (!weeks[col]) weeks[col] = new Array(7);
    weeks[col][row] = {
      date: dayKey(date),
      inYear: date.getUTCFullYear() === year
    };
    d += 1;
  }
  // 最后一列补足到 7 天(溢出到次年 1 月),保持 53 列满
  const lastCol = weeks.length - 1;
  while (weeks[lastCol].some((cell) => !cell)) {
    const date = new Date(start.getTime() + d * DAY_MS);
    const row = d % 7;
    weeks[lastCol][row] = {
      date: dayKey(date),
      inYear: date.getUTCFullYear() === year
    };
    d += 1;
  }
  return weeks;
}

// 返回日期所在可视列的**周一**起始日。与 buildWeeks 的周一至周日列一致。
export function weekStartKey(value) {
  let calendarKey = value;
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    calendarKey = value.getFullYear() + '-' + pad(value.getMonth() + 1) + '-' + pad(value.getDate());
  }
  const day = parseCalendarDay(calendarKey);
  if (!day) return null;
  day.setUTCDate(day.getUTCDate() - mondayIndex(day));
  return dayKey(day);
}

// 将每日用量按可视列(周一至周日)聚合。跨年首列以真实周一为键,
// 但只会累加调用方传入的数据(所选年份的 API 快照不会自动引入上一年数据)。
export function buildWeekTotals(days) {
  const totals = {};
  Object.keys(days || {}).forEach((dateKey) => {
    const total = Number(days[dateKey]) || 0;
    if (total <= 0) return;
    const key = weekStartKey(dateKey);
    if (!key) return;
    totals[key] = (totals[key] || 0) + total;
  });
  return totals;
}

// 0 = 无消耗;1..4 按 value/max 四档均分(0.25 / 0.5 / 0.75)。
// 日视图传 maxDaily,月视图传 maxMonthly —— 两者量级差 ~30 倍,绝不能共用一把尺。
export function colorLevel(value, max) {
  const v = Number(value) || 0;
  if (v <= 0) return 0;
  const m = Number(max) || 0;
  if (m <= 0) return 0;
  const ratio = v / m;
  if (ratio > 0.75) return 4;
  if (ratio > 0.5) return 3;
  if (ratio > 0.25) return 2;
  return 1;
}

// token 数量显示:≥1e8 用亿(1 位小数),≥1e4 用万(千分位),否则千分位。
export function formatToken(n) {
  const value = Number(n) || 0;
  if (value >= 100000000) return (value / 100000000).toFixed(1) + '亿';
  if (value >= 10000) return (value / 10000).toLocaleString('en-US') + '万';
  return value.toLocaleString('en-US');
}

// 方块堆积列(每周/累计模式):列内方块数 ∝ 值,scale = 列最大值 / MAX_HEATMAP_BLOCKS
export const MAX_HEATMAP_BLOCKS = 10;

export function blockCount(value, scale) {
  const v = Number(value) || 0;
  const s = Number(scale) || 0;
  if (v <= 0 || s <= 0) return 0;
  return Math.max(1, Math.min(MAX_HEATMAP_BLOCKS, Math.round(v / s)));
}
