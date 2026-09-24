// opencode Provider 适配器:只读本地 SQLite 用量库(~/.local/share/opencode/opencode.db)。
// 无网络请求、无凭证依赖;金额为 opencode 自身记录的真实 cost(USD),见 ./usage-db.js。
const { readLocalLog: scanOpencodeDb, opencodeDbAvailable } = require('./usage-db');

module.exports = {
  id: 'opencode',
  displayName: 'opencode',
  capabilities: { balance: false, webUsage: false, quota: false, localLog: true, realtimeProxy: false },

  authStatus(ctx) {
    return opencodeDbAvailable(ctx && ctx.store) ? 'ok' : 'missing';
  },

  readLocalLog(ctx, opts) {
    return scanOpencodeDb(ctx, opts);
  }
};
