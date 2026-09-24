// Claude Code Provider 适配器:只读扫描本地会话日志(~/.claude/projects/**/*.jsonl)。
// 无网络请求、无凭证依赖;金额由定价表折算(日志不含 cost),见 ./locallog.js。
const { readLocalLog: scanClaudeLog, claudeLogAvailable } = require('./locallog');

module.exports = {
  id: 'claude',
  displayName: 'Claude Code',
  capabilities: { balance: false, webUsage: false, quota: false, localLog: true, realtimeProxy: false },

  authStatus(ctx) {
    return claudeLogAvailable(ctx && ctx.store) ? 'ok' : 'missing';
  },

  // quota / fetchBalance / fetchUsage:无(本地日志 provider,只读本机)
  readLocalLog(ctx, opts) {
    return scanClaudeLog(ctx, opts);
  }
};
