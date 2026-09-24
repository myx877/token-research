// window.api 的 React 侧封装(IPC 白名单见 src/preload/preload.js)。
const api = window.api;

export function getProviders() {
  return api.invoke('get:providers');
}

export function getDashboard(providerId) {
  return api.invoke('get:dashboard', providerId);
}

export function getHeatmap(arg) {
  return api.invoke('get:heatmap', arg);
}

// arg: { provider?: 'all'|id, bucket: 'day'|'week'|'month', from?: 'YYYY-MM-DD', to?: 'YYYY-MM-DD' }
export function getUsageSummary(arg) {
  return api.invoke('get:usage-summary', arg);
}

// 单平台窗口卡:arg = { provider } → 今日/本周/本月的用量、金额、重置倒计时与预算百分比
export function getUsageWindows(arg) {
  return api.invoke('get:usage-windows', arg);
}

export function getTokenSpeed() {
  return api.invoke('get:token-speed');
}

export function getEdgeDockState() {
  return api.invoke('get:edge-dock-state');
}

export function getBounds() {
  return api.invoke('get:bounds');
}

export function getSettings() {
  return api.invoke('get:settings');
}

// DeepSeek 平台登录态:{ status, loggedIn, error } —— 官方用量需要它,API Key 只够读余额
export function getSessionState() {
  return api.invoke('get:session-state');
}

// 内联补录 DeepSeek API Key:主进程先 fetchBalance 校验,通过才落盘;校验失败会 reject(不写 store)
export function replaceApiKey(apiKey) {
  return api.invoke('settings:replace-api-key', { apiKey });
}

export function onProvidersChanged(cb) {
  return api.on('providers:changed', cb);
}

export function onTokenSpeedChanged(cb) {
  return api.on('token-speed:changed', cb);
}

export function saveSetting(key, value) {
  return api.invoke('settings:save', { key, value });
}

export function onBoundsChanged(cb) {
  return api.on('window:bounds-changed', cb);
}

export function on(channel, cb) {
  return api.on(channel, cb);
}

export function send(channel, data) {
  return api.send(channel, data);
}

export function toggleMini() {
  return api.send('window:toggle-mini');
}

export default api;
