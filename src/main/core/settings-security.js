// 设置安全边界(纯函数,无 electron 依赖,可单测)。
// 凭证等敏感字段绝不允许进渲染进程:get:settings / settings:loaded 一律走净化副本。

const SECRET_SETTING_PATHS = [
  ['providers', 'deepseek', 'apiKey'],
  ['providers', 'deepseek', 'sessionToken'],
  ['mcp', 'token'],
  ['ingest', 'dsh', 'token']
];

// 这几个键是"用量/费用聚合"的大数据键:渲染层经专用 IPC 取,不进 settings 载荷。
// **必须在深拷贝之前就摘掉**:原来的写法是"整库深拷贝完再 delete",而 usageDaily 可能是
// 几十 MB —— 每次广播都要把主进程卡住上百毫秒(实测:切迷你窗口的缓动只跑出第一帧就被卡到终点,
// 用户观感是"切换的一瞬间卡壳")。
const BIG_USAGE_KEYS = ['usageDaily', 'usageDailyCost', 'usageDailyPush', 'usageDailyCostPush'];

function sanitizeSettings(storeData) {
  const source = storeData || {};
  const slim = {};
  Object.keys(source).forEach(function (key) {
    if (BIG_USAGE_KEYS.indexOf(key) < 0) slim[key] = source[key];
  });
  const clone = JSON.parse(JSON.stringify(slim));
  if (clone.ingest && clone.ingest.dsh) {
    delete clone.ingest.dsh.batchRegistry;
    delete clone.ingest.dsh.sources;
    delete clone.ingest.dsh.diagnostics;
  }
  SECRET_SETTING_PATHS.forEach(function (pathParts) {
    let node = clone;
    for (let i = 0; i < pathParts.length - 1; i++) {
      node = node && node[pathParts[i]];
    }
    if (node && Object.prototype.hasOwnProperty.call(node, pathParts[pathParts.length - 1])) {
      delete node[pathParts[pathParts.length - 1]];
    }
  });
  // 非敏感标记:让设置界面能区分"未设置"与"已保存"(不泄露值本身)
  const ds = storeData && storeData.providers && storeData.providers.deepseek;
  if (clone.providers && clone.providers.deepseek) {
    clone.providers.deepseek.apiKeySet = !!(ds && ds.apiKey);
  }
  return clone;
}

// 通用 settings:update/settings:save 的键白名单。凭证只能通过专用验证通道写入。
const WRITABLE_SETTING_KEYS = new Set([
  'layout',
  'componentOrder',
  'providers.proxyUrl',
  'mcp.enabled',
  'providers.dsh.collectionMode'
]);
const WRITABLE_SETTING_PREFIXES = ['window.', 'components.', 'data.'];
const WRITABLE_KEY_ALIASES = Object.freeze({});

function isWritableSettingKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > 100) return false;
  if (key.indexOf('__proto__') !== -1) return false;
  return WRITABLE_SETTING_KEYS.has(key)
    || Object.prototype.hasOwnProperty.call(WRITABLE_KEY_ALIASES, key)
    || WRITABLE_SETTING_PREFIXES.some(function (p) { return key.startsWith(p); });
}

// 将白名单内的别名键解析为规范存储路径;非别名键原样返回
function resolveWritableSettingKey(key) {
  return WRITABLE_KEY_ALIASES[key] || key;
}

module.exports = { sanitizeSettings, isWritableSettingKey, resolveWritableSettingKey };
