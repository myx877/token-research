window.App = window.App || {};

var windowDefinitions = [
  // 透明度滑块已移除:整窗 setOpacity 的分层机制导致缩放露黑边,透视感由 DWM acrylic 提供
  { group: '窗口', key: 'window.alwaysOnTop', type: 'toggle', label: '始终置顶', default: true },
  { group: '窗口', key: 'window.autoLaunch', type: 'toggle', label: '开机自启', default: false },
  { group: '窗口', key: 'window.followSystemTheme', type: 'toggle', label: '跟随系统主题', default: true },
  { group: '窗口', key: 'window.darkMode', type: 'select', label: '主题模式', options: [
    { value: 'system', label: '跟随系统' }, { value: 'dark', label: '夜间模式' }, { value: 'light', label: '日间模式' },
    { value: 'acrylic-light', label: '亚克力(亮)' }, { value: 'acrylic-dark', label: '亚克力(暗)' }
  ], default: 'system' },
  { group: '窗口', key: 'window.layoutLocked', type: 'toggle', label: '锁定布局', default: true },
  { group: '窗口', key: 'window.miniStyle', type: 'select', label: '小窗口显示', options: [
    { value: 'usage', label: '用量进度条(今日/本周/本月)' },
    { value: 'share', label: '占比圆环(命中/输入/输出)' }
  ], default: 'usage' },
  { group: '窗口', key: 'window.edgeAutoHide', type: 'toggle', label: '贴边自动隐藏', default: false }
];

var networkDefinitions = [
  {
    group: '网络',
    key: 'providers.proxyUrl',
    type: 'proxy',
    label: '网络代理',
    default: ''
  }
];

var historyDefinitions = [
  { group: '历史数据', key: 'history.sync', type: 'historySync', label: '用量历史同步', default: '' }
];

var diagnosticsDefinitions = [
  { group: '诊断', type: 'diagnostics', label: '诊断中心', channel: 'open:diagnostics' }
];

var componentDefinitions = window.ComponentRegistry.list().map(function (component) {
  return {
    group: '组件',
    key: component.settingsKey,
    type: 'toggle',
    label: component.settingsLabel || component.label,
    default: component.defaultVisible
  };
});

var tokenSpeedDefinitions = [
  {
    group: '数据', key: 'data.tokenSpeed.intervalSeconds', type: 'select',
    label: 'Token 速度统计周期', default: 30,
    visibleWhen: { key: 'components.tokenSpeed', equals: true },
    options: [
      { value: 10, label: '10 秒' }, { value: 20, label: '20 秒' },
      { value: 30, label: '30 秒' }, { value: 60, label: '1 分钟' },
      { value: 180, label: '3 分钟' }, { value: 300, label: '5 分钟' },
      { value: 3600, label: '1 小时' }, { value: 18000, label: '5 小时' }
    ]
  },
  {
    group: '数据', key: 'data.tokenSpeed.providerFilter', type: 'select',
    label: 'Token 速度展示平台', default: 'all',
    visibleWhen: { key: 'components.tokenSpeed', equals: true },
    options: [
      { value: 'all', label: '展示全部' },
      { value: 'deepseek', label: 'DeepSeek' },
      { value: 'codex', label: 'Codex' },
      { value: 'kimi', label: 'Kimi' }
    ]
  }
];

var dshCollectionDefinitions = [
  {
    group: '数据', key: 'providers.dsh.collectionMode', type: 'select',
    label: 'DeepSeek Harness 采集模式', default: 'auto',
    options: [
      { value: 'auto', label: '自动(推送时停止文件轮询)' },
      { value: 'localLog', label: '仅本地文件' },
      { value: 'push', label: '仅推送接收' }
    ]
  }
];

var tailDefinitions = [
  { group: 'MCP 服务', key: 'mcp.enabled', type: 'toggle', label: '启用 MCP 服务', default: true },
  { group: 'MCP 服务', key: 'mcp.serverInfo', type: 'mcpServer', label: '连接信息', default: '' },
  { group: 'DSH 用量接收', key: 'ingest.dsh.serverInfo', type: 'ingestServer', label: '接收连接信息', default: '' },
  { group: '数据', key: 'data.historyDays', type: 'select', label: '历史数据保留', options: [
    { value: 3, label: '3 天' }, { value: 7, label: '7 天' }, { value: 30, label: '30 天' },
    { value: 90, label: '90 天' }, { value: 180, label: '180 天' }, { value: 365, label: '365 天' }
  ], default: 90 },
  { group: '关于', key: 'apiKey', type: 'credential', label: 'API Key', default: '' }
];

// 订阅制平台的月费(用于「用量汇总」的可隐藏估算列):这些平台没有按次计费数据,
// 只能按 自然月内 token 占比 摊薄月费。留空 = 不产生估算。币种与各平台金额币种一致。
var usageFeeDefinitions = [
  {
    group: '金额', key: 'data.subscriptionMonthlyFee.codex', type: 'number',
    label: 'Codex 订阅月费（$）', default: '', placeholder: '留空则不估算',
    // 预算/金额组常显:components.usageSummary 从来没有默认值、也没有写入方,
    // 原来这条 visibleWhen 会把整组(36 个预算字段 + 3 个月费字段)藏掉 —— 真 bug,已删门禁
  },
  {
    group: '金额', key: 'data.subscriptionMonthlyFee.claude', type: 'number',
    label: 'Claude Code 订阅月费（¥）', default: '', placeholder: '留空则不估算',
    // 预算/金额组常显:components.usageSummary 从来没有默认值、也没有写入方,
    // 原来这条 visibleWhen 会把整组(36 个预算字段 + 3 个月费字段)藏掉 —— 真 bug,已删门禁
  },
  {
    group: '金额', key: 'data.subscriptionMonthlyFee.kimi', type: 'number',
    label: 'Kimi 订阅月费（¥）', default: '', placeholder: '留空则不估算',
    // 预算/金额组常显:components.usageSummary 从来没有默认值、也没有写入方,
    // 原来这条 visibleWhen 会把整组(36 个预算字段 + 3 个月费字段)藏掉 —— 真 bug,已删门禁
  }
];

// 用量预算(单平台窗口卡的百分比分母),每个平台每个窗口**两个字段**:
//   data.usageBudget.<平台>.<窗口>       = 金额预算(元/美元):条上主数字是百分比
//   data.usageBudgetTokens.<平台>.<窗口> = Token 预算:填了它,进度条就按 token 走,
//                                          条上主数字直接写 token 数、百分比退成小字
// 为什么两个都要:金额预算回答"钱花了多少",Token 预算回答"用了多少 token" —— 这是两个问题,
// 用户想先看哪个就用哪个填。两者都填时**金额优先**(口径在主进程 usage-buckets.js)。
// 都留空 = 那一行只显示用量与金额、不显示百分比(宁可没有百分比,也不编一个分母)。
var budgetPlatforms = [
  { id: 'deepseek', label: 'DeepSeek', currency: '¥' },
  { id: 'codex', label: 'Codex', currency: '$' },
  { id: 'kimi', label: 'Kimi', currency: '¥' },
  { id: 'dsh', label: 'DSH', currency: '¥' },
  { id: 'claude', label: 'Claude Code', currency: '¥' },
  { id: 'opencode', label: 'opencode', currency: '$' }
];

var budgetWindows = [
  { key: 'day', label: '每日' },
  { key: 'week', label: '每周' },
  { key: 'month', label: '每月' }
];

var usageBudgetDefinitions = [];
budgetPlatforms.forEach(function (platform) {
  budgetWindows.forEach(function (win) {
    usageBudgetDefinitions.push({
      group: '预算',
      key: 'data.usageBudget.' + platform.id + '.' + win.key,
      type: 'number',
      label: platform.label + ' ' + win.label + '预算（' + platform.currency + '）',
      default: '',
      placeholder: '留空则不显示百分比',
      // 预算/金额组常显:components.usageSummary 从来没有默认值、也没有写入方,
    // 原来这条 visibleWhen 会把整组(36 个预算字段 + 3 个月费字段)藏掉 —— 真 bug,已删门禁
    });
    usageBudgetDefinitions.push({
      group: '预算',
      key: 'data.usageBudgetTokens.' + platform.id + '.' + win.key,
      type: 'number',
      label: platform.label + ' ' + win.label + ' Token 预算',
      default: '',
      placeholder: '留空则只用金额预算',
      // 预算/金额组常显:components.usageSummary 从来没有默认值、也没有写入方,
    // 原来这条 visibleWhen 会把整组(36 个预算字段 + 3 个月费字段)藏掉 —— 真 bug,已删门禁
    });
  });
});

window.SettingsDefinitions = windowDefinitions.concat(
  networkDefinitions,
  historyDefinitions,
  diagnosticsDefinitions,
  componentDefinitions,
  dshCollectionDefinitions,
  tokenSpeedDefinitions,
  usageFeeDefinitions,
  usageBudgetDefinitions,
  tailDefinitions
);
