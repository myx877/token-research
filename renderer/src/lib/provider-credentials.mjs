// 服务商「凭据就绪」判定的唯一决议点(纯函数,可单测)。
//
// 为什么必须收敛到一处:同一个概念被三处各写一份(选择页状态文案、卡片凭证提示、
// 标题栏标签栏白名单)时,迟早出现"选择页说已配置、标签栏里却没有它"的分叉。
//
// 三类凭据模型(与 src/main/providers/<id>/index.js 的 authStatus 一一对应):
//   api-key   = 用户手输,主进程 fetchBalance 校验通过才落盘(目前只有 deepseek)
//   local-cli = 本机 CLI 凭证只读,应用从不回写(codex / kimi)
//   none      = 零凭证本机日志,只要日志目录/DB 在就能出数(dsh / claude / opencode)

// 三类凭据模型的名单(模块内部用:对外只暴露判定函数,调用方不该自己拼名单)
const NEEDS_API_KEY = ['deepseek'];
const CLI_CREDENTIAL_IDS = ['codex', 'kimi'];

export const STATE_READY = 'ready';
export const STATE_MISSING = 'missing';
export const STATE_EXPIRED = 'expired';

const LOCAL_CLI_HINT = Object.freeze({
  codex: '本机 codex CLI 凭证缺失或过期:先在终端运行一次 codex,再点「立即重试」',
  kimi: '本机 Kimi 凭证缺失或过期:先登录一次 Kimi CLI,再点「立即重试」'
});

const EMPTY_SNAPSHOT = Object.freeze({ apiKeySet: false, loggedIn: false, statusById: {} });

export function credentialKind(id) {
  if (NEEDS_API_KEY.indexOf(id) >= 0) return 'api-key';
  if (CLI_CREDENTIAL_IDS.indexOf(id) >= 0) return 'local-cli';
  return 'none';
}

function localCliHint(id) {
  return LOCAL_CLI_HINT[id] || null;
}

// 单个平台的凭据状态。
//   api-key   → 只看 apiKeySet:用户刚填完 Key 还没点「登录平台」也算就绪,
//               否则会出现"填完 Key 立刻被告知不能切换"这种自相矛盾的体验。
//   local-cli → 看主进程 authStatus(ok / expired / missing);快照还没到(undefined)按 missing,
//               宁可晚一帧出现,也不把"未知"当成"可用"。
//   none      → 恒 ready(读本机日志不需要任何凭证)。
export function credentialStateFor(id, snapshot) {
  const state = snapshot || EMPTY_SNAPSHOT;
  const kind = credentialKind(id);
  if (kind === 'api-key') return state.apiKeySet ? STATE_READY : STATE_MISSING;
  if (kind === 'local-cli') {
    const auth = state.statusById ? state.statusById[id] : null;
    if (auth === 'ok') return STATE_READY;
    return auth === 'expired' ? STATE_EXPIRED : STATE_MISSING;
  }
  return STATE_READY;
}

export function isCredentialReady(id, snapshot) {
  return credentialStateFor(id, snapshot) === STATE_READY;
}

// 标题栏标签栏的白名单:只有就绪的服务商才渲染成可点标签。
// 没就绪的"不渲染"而不是"点了报错"—— 排除的语义是"它现在出不了数",不是惩罚用户。
export function readyProviderIds(ids, snapshot) {
  return (ids || []).filter((id) => !!id && isCredentialReady(id, snapshot));
}

// 卡片/选择页共用的状态文案(tone 决定颜色:ok 中性、warn 黄色)。
export function providerStatusText(id, snapshot) {
  const kind = credentialKind(id);
  const state = snapshot || EMPTY_SNAPSHOT;
  if (kind === 'api-key') {
    return state.apiKeySet
      ? { tone: 'ok', text: state.loggedIn ? 'API Key 已配置' : 'API Key 已配置(可读余额;官方用量需登录平台)' }
      : { tone: 'warn', text: '需要 API Key(填了才能读官方余额与用量;不填只统计本机日志)' };
  }
  if (kind === 'local-cli') {
    const status = credentialStateFor(id, state);
    if (status === STATE_EXPIRED) return { tone: 'warn', text: '本机 CLI 凭证已过期' };
    if (status === STATE_MISSING) return { tone: 'warn', text: '本机 CLI 凭证缺失' };
  }
  return { tone: 'ok', text: '读本机日志,无需凭证' };
}

// 卡片内凭证提示块的内容(渲染细节留在组件里,判定留在这里)。
//   返回 null        → 什么都不提示
//   { kind: 'api-key' }  → 内联 API Key 输入
//   { kind: 'session' }  → 「登录平台」
//   { kind: 'local-cli' } → 原因 + 「立即重试」
//
// 注意:凭据没就绪**不代表数据不可用** —— codex/kimi 的本机日志照常出数,
// 所以这里只产出"提示",绝不产出"拦截"。
export function credentialNoticeFor(id, snapshot) {
  const kind = credentialKind(id);
  if (kind === 'api-key') {
    const state = snapshot || EMPTY_SNAPSHOT;
    if (!state.apiKeySet) return { kind: 'api-key' };
    if (!state.loggedIn) return { kind: 'session' };
    return null;
  }
  if (kind === 'local-cli') {
    const status = credentialStateFor(id, snapshot);
    if (status === STATE_MISSING || status === STATE_EXPIRED) {
      return { kind: 'local-cli', state: status, hint: localCliHint(id) };
    }
  }
  return null;
}
