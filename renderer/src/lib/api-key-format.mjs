// DeepSeek API Key 的本地预检与失败文案:首屏「选服务商」与卡片内补录共用同一份,
// 避免两处对"什么样的 Key 才值得发一次校验请求"给出不同答案。
//
// 预检只挡"空 / 明显不成形",不做过度校验:真正能不能用由主进程 fetchBalance 说了算。
const API_KEY_MIN_LENGTH = 12;

export function apiKeyProblem(text) {
  const value = (text || '').trim();
  if (!value) return '请先填入 API Key';
  if (!/^sk-/.test(value) || /\s/.test(value) || value.length < API_KEY_MIN_LENGTH) {
    return '格式不像 DeepSeek API Key(形如 sk-...),未发送校验请求';
  }
  return null;
}

// 主进程校验失败会 reject:剥掉 Electron 的调用包装,只留一句人话。
// 真实失败有两种形态:fetchBalance 返回空(API_KEY_INVALID)或直接抛(如 Unauthorized/HTTP 401),
// 两种都归到"校验失败,未保存"。
export function apiKeyErrorText(error) {
  const raw = (error && (error.message || String(error))) || '';
  if (/API key verification failed|API_KEY_INVALID|Unauthorized|invalid api key|401/i.test(raw)) {
    return 'API Key 校验失败:请确认复制完整、未过期(未保存)';
  }
  if (/API_KEY_REQUIRED/i.test(raw)) return '请先填入 API Key';
  return '保存失败:' + raw.replace(/^Error invoking remote method '[^']*':\s*/, '').replace(/^Error:\s*/, '');
}
