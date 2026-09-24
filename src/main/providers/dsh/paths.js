// DSH 目录解析:两类本机数据源各有一个根目录。
//  1. 会话日志(官方):$DSH_HOME/sessions —— DSH 自己一直在写,无需任何配置或凭证。
//  2. 遥测文件(自建生产者):$DSH_HOME/telemetry/usage-YYYY-MM-DD.jsonl —— 由部署方自己写。
// 解析与 DSH 的 resolveDshHome 对齐:~ / ~/ / ~\ 前缀展开并 resolve 为绝对路径;
// 否则用户按 DSH 文档设 DSH_HOME=~/dsh 或相对路径时,两边指向不同目录、静默无数据。
const os = require('os');
const path = require('path');

const DEFAULT_DSH_DIR = '.dsh';
const SESSIONS_DIR = 'sessions';
const TELEMETRY_DIR = 'telemetry';

function expandHomePath(value) {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function readStringSetting(store, key) {
  const value = store && typeof store.get === 'function' ? store.get(key) : undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

// DSH 主目录:DSH_HOME 环境变量 > ~/.dsh(与 DSH 自身一致)。
function resolveDshHome(env) {
  const dshHome = env && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  if (dshHome) return path.resolve(expandHomePath(dshHome));
  return path.join(os.homedir(), DEFAULT_DSH_DIR);
}

function resolveTelemetryRoot(store, env) {
  const custom = readStringSetting(store, 'providers.dsh.telemetryRoot');
  if (custom) return path.resolve(expandHomePath(custom));
  return path.join(resolveDshHome(env), TELEMETRY_DIR);
}

function resolveSessionsRoot(store, env) {
  const custom = readStringSetting(store, 'providers.dsh.sessionsRoot');
  if (custom) return path.resolve(expandHomePath(custom));
  return path.join(resolveDshHome(env), SESSIONS_DIR);
}

module.exports = {
  expandHomePath,
  resolveDshHome,
  resolveTelemetryRoot,
  resolveSessionsRoot,
  DEFAULT_DSH_DIR,
  SESSIONS_DIR,
  TELEMETRY_DIR
};
