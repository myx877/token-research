// DSH Provider 适配器(localLog 通道)。
// 主数据源 = DSH 官方会话日志($DSH_HOME/sessions,DSH 自己一直在写,无需配置);
// 回退数据源 = 自建生产者写的 usage-*.jsonl($DSH_HOME/telemetry)。
// 注意:官方 dsh-session-telemetry-otel 只在用户提交反馈时导出整段会话内容到 OTLP,
// 且 emit() 为空操作 —— 它不是用量计量通道,不能用来统计 token。
const { readLocalLog: readTelemetryLocalLog, resolveTelemetryRoot } = require('./telemetrylog');
const { readLocalLog: readSessionLocalLog, resolveSessionsRoot } = require('./session-log');
const { shouldPollDshLocalLog } = require('../../core/dsh-collection-mode');

module.exports = {
  id: 'dsh',
  displayName: 'DeepSeek Harness',
  capabilities: { balance: false, webUsage: false, quota: false, localLog: true, realtimeProxy: false },

  authStatus() {
    // 本机会话日志无需凭证。
    return 'ok';
  },

  // 本机数据源根目录(供 fs.watch 实时监听):会话日志根。
  localLogRoot(ctx) {
    return resolveSessionsRoot(ctx && ctx.store, process.env);
  },

  shouldPollLocalLog(ctx) {
    // push 源匹配用的是 DSH 侧上报的遥测根,与会话日志根无关,必须显式传遥测根。
    return shouldPollDshLocalLog(ctx && ctx.store, resolveTelemetryRoot(ctx && ctx.store, process.env));
  },

  async readLocalLog(ctx, opts) {
    const batch = await readSessionLocalLog(ctx, opts);
    // 本机没有会话日志(旧版 DSH / 自定义 DSH_HOME)时才回退到遥测文件,
    // 避免两条来源同时计入同一批请求。
    if (!batch.empty) return batch;
    return readTelemetryLocalLog(ctx, opts);
  }
};
