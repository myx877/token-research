const INTERVAL_SECONDS = Object.freeze([10, 20, 30, 60, 180, 300, 3600, 18000]);
// 只允许「渲染端确实能显示」的 provider 进入持久化筛选值(renderer-owned allowlist):
// 后端可以有多于渲染端的 series(dsh/claude/opencode),但它们不能出现在筛选值里,
// 否则渲染端会显示与后端快照不一致的 provider。新增 provider 若要进入筛选值,
// 必须先让渲染端卡片的调色板与渲染逻辑先支持它。
const PROVIDER_FILTERS = Object.freeze(['all', 'deepseek', 'codex', 'kimi']);
const DEFAULT_TOKEN_SPEED_SETTINGS = Object.freeze({
  intervalSeconds: 30,
  providerFilter: 'all'
});

function normalizeIntervalSeconds(value) {
  const number = Number(value);
  return INTERVAL_SECONDS.includes(number)
    ? number
    : DEFAULT_TOKEN_SPEED_SETTINGS.intervalSeconds;
}

function normalizeProviderFilter(value) {
  return PROVIDER_FILTERS.includes(value)
    ? value
    : DEFAULT_TOKEN_SPEED_SETTINGS.providerFilter;
}

function normalizeTokenSpeedSettings(value) {
  const candidate = value && typeof value === 'object' ? value : {};
  return {
    intervalSeconds: normalizeIntervalSeconds(candidate.intervalSeconds),
    providerFilter: normalizeProviderFilter(candidate.providerFilter)
  };
}

module.exports = {
  INTERVAL_SECONDS,
  PROVIDER_FILTERS,
  DEFAULT_TOKEN_SPEED_SETTINGS,
  normalizeIntervalSeconds,
  normalizeProviderFilter,
  normalizeTokenSpeedSettings
};
