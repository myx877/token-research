// 主进程 IPC 模块:全部 ipcMain 处理器 + 缩放状态机。
// 依赖由 index.js 注入(deps),窗口创建/生命周期仍留在 index.js。
const { ipcMain, BrowserWindow } = require('electron');
const { buildHeatmap } = require('./core/heatmap');
const { sanitizeSettings, isWritableSettingKey, resolveWritableSettingKey } = require('./core/settings-security');
const { resetSettingsStore } = require('./core/settings-reset');
const { saveSetting } = require('./core/settings-write');
const { replaceDeepseekApiKey } = require('./core/api-key-replacement');
const { retentionStartDay } = require('./core/usage-retention');
// inclusiveBeijingDayCount:算「建议保留多少天」用(见 sync:history 的 retentionHint)。
// 缺了这行 import,sync:history 在"存在早于保留窗口的数据"时会抛 ReferenceError ——
// 而这正是那句提示唯一会出现的场景(真机点击「同步历史」时实测踩到)。
const { inclusiveBeijingDayCount } = require('./core/beijing-calendar');
const { getSessionSnapshot } = require('./core/session-state');
const { skipDeepseekLogin } = require('./core/startup-windows');
const { syncDeepSeekHistory, rescanLocalLogs } = require('./core/history-sync');
const { UsageFetcher } = require('./providers/deepseek/usage');
const { httpGet } = require('./core/http');
const { SYSTEM_PROXY_VALUE, resolveElectronSystemProxy } = require('./core/proxy-settings');
const { registerDiagnosticsIpc } = require('./core/diagnostics/ipc-registration');
const { detectProxyPort } = require('./core/proxy-detect');
const { buildDshDashboard } = require('./core/dsh-dashboard');
const { MINI_WIDTH, MINI_HEIGHT } = require('./core/mini-mode');
const {
  PUSH_USAGE_KEY,
  PUSH_COST_KEY,
  effectiveUsageDaily,
  effectiveUsageDailyCost
} = require('./core/dsh-usage-merge');
const { aggregateUsage, usageWindows, listProviders, isoWeekKey, CURRENCY } = require('./core/usage-buckets');

function deepseekApiKeyCtx(deps, apiKey) {
  return {
    store: {
      get: (k) => (k === 'providers.deepseek.apiKey' ? apiKey : deps.store.get(k)),
      set: (k, v) => deps.store.set(k, v),
      delete: (k) => deps.store.delete(k)
    },
    logger: console,
    getProxyUrl: () => deps.store.get('providers.proxyUrl') || null
  };
}

module.exports = function setupIPC(deps) {
  let mainResizeState = null;
  let settingsResizeState = null;

  registerDiagnosticsIpc({
    ipcMain,
    diagnostics: deps.diagnostics,
    getDiagnosticsWindow: deps.getDiagnosticsWindow,
    createDiagnosticsWindow: deps.createDiagnosticsWindow,
    getDiagnosticsTheme: deps.getDiagnosticsTheme
  });

  function getMain() {
    return deps.getMainWindow();
  }

  function getSettings() {
    return deps.getSettingsWindow();
  }

  function buildDashboardPayload(providerId) {
    const pid = providerId || 'deepseek';
    const st = deps.scheduler.getState(pid) || {};
    const payload = { providerId: pid, balance: st.balance || null };
    if (pid === 'deepseek' && st.usage) {
      const stats = {
        cost: st.usage.cost.aggregate,
        token: st.usage.amount.aggregate,
        costDaily: st.usage.cost.dailyData,
        tokenDaily: st.usage.amount.dailyData
      };
      payload.stats = stats;
      const curves = deps.buildCurvePoints(stats);
      payload.curveToken = curves.token;
      payload.curveCost = curves.cost;
    }
    if (pid === 'dsh') {
      // DSH 平台数据源是本地遥测文件聚合 + push 聚合(dsh: 前缀日行),
      // 与 deepseek stats 同构后复用同一套 buildCurvePoints 生成曲线。
      const stats = buildDshDashboard(
        deps.store.get('usageDaily') || {},
        deps.store.get('usageDailyCost') || {},
        deps.store.get(PUSH_USAGE_KEY) || {},
        deps.store.get(PUSH_COST_KEY) || {}
      );
      payload.stats = stats;
      const curves = deps.buildCurvePoints(stats);
      payload.curveToken = curves.token;
      payload.curveCost = curves.cost;
    }
    return payload;
  }

  /* ======== 登录 ======== */

  ipcMain.on('login:submit', async (event, { apiKey } = {}) => {
    const main = getMain();
    try {
      const deepseek = deps.registry.get('deepseek');
      const info = await deepseek.fetchBalance(deepseekApiKeyCtx(deps, apiKey));
      if (!info) throw new Error('API Key 验证失败');
      deps.store.set('providers.deepseek.apiKey', apiKey);
      if (deps.getLoginWindow()) deps.getLoginWindow().close();
      if (!main) deps.createMainWindow();
      else main.show();
      const win = getMain();
      if (win && !win.webContents.isDestroyed()) {
        win.webContents.on('did-finish-load', () => {
          win.webContents.send('settings:loaded', sanitizeSettings(deps.store.store));
          deps.scheduler.poll('deepseek', 'balance');
          deps.createSessionWindow();
        });
      }
    } catch (e) {
      if (deps.getLoginWindow() && !deps.getLoginWindow().isDestroyed()) {
        event.sender.send('login:error', 'API Key 验证失败: ' + e.message);
      }
    }
  });

  /* ======== Dashboard / Providers ======== */

  ipcMain.handle('get:dashboard', (event, providerId) => {
    return buildDashboardPayload(providerId);
  });

  ipcMain.handle('get:providers', () => {
    return deps.scheduler.getSnapshot();
  });

  ipcMain.handle('get:token-speed', () => {
    return deps.tokenSpeedRuntime
      ? deps.tokenSpeedRuntime.getSnapshot()
      : { enabled: false, providers: [], series: {} };
  });

  /* ======== Heatmap ======== */

  ipcMain.handle('get:heatmap', (event, arg) => {
    const { provider, year } = arg || {};
    // 全部 provider 的日数据统一来自 store 键 'usageDaily' { '<provider>:<date>': { total, cached, models? } }:
    // codex/kimi 由本地日志增量聚合;deepseek 由 fetchUsage 按月抓取时持久化(含历史回填)。
    // 显示层不套用保留窗口:已同步的历史应全部可见,清理交给 data.historyDays/prune。
    // 不传 historyDays 时 filterUsageDaily 只做畸形键过滤(无限保留)。
    // dsh 使用有效聚合(本地 usageDaily + usageDailyPush),其余 provider 行为不变。
    const usageDaily = effectiveUsageDaily(deps.store);
    const byProvider = {};
    const cachedByProvider = {};
    const costByProvider = {};
    const deepseekModels = {};
    Object.keys(usageDaily).forEach((key) => {
      const idx = key.indexOf(':');
      if (idx <= 0) return;
      const pid = key.slice(0, idx);
      const date = key.slice(idx + 1);
      const total = Number(usageDaily[key] && usageDaily[key].total) || 0;
      if (total <= 0) return;
      byProvider[pid] = byProvider[pid] || {};
      byProvider[pid][date] = (byProvider[pid][date] || 0) + total;
      const cached = Number(usageDaily[key] && usageDaily[key].cached) || 0;
      if (cached > 0) {
        cachedByProvider[pid] = cachedByProvider[pid] || {};
        cachedByProvider[pid][date] = (cachedByProvider[pid][date] || 0) + cached;
      }
      // deepseek 悬停明细:当日模型分布(fetchUsage 持久化时写入)
      const models = usageDaily[key] && usageDaily[key].models;
      if (pid === 'deepseek' && Array.isArray(models) && models.length) {
        deepseekModels[date] = models.map((m) => ({ model: m.model, tokens: m.tokens }));
      }
    });
    // 当天金额(悬停用):与 token 同源,按平台分开给 —— 跨币种绝不相加
    const usageDailyCost = effectiveUsageDailyCost(deps.store);
    Object.keys(usageDailyCost).forEach((key) => {
      const idx = key.indexOf(':');
      if (idx <= 0) return;
      const pid = key.slice(0, idx);
      const date = key.slice(idx + 1);
      const cost = Number(usageDailyCost[key]) || 0;
      if (cost <= 0) return;
      costByProvider[pid] = costByProvider[pid] || {};
      costByProvider[pid][date] = (costByProvider[pid][date] || 0) + cost;
    });
    // 年份口径 = **北京时间**(与全项目日键一致;本地时区在跨年那几小时会取到上一年)
    const bjYear = (require('./core/beijing-calendar').beijingDateParts(Date.now()) || {}).year;
    const result = buildHeatmap(byProvider, provider || 'all', year || bjYear || new Date().getFullYear());
    result.details = {
      byProvider: byProvider,
      cachedByProvider: cachedByProvider,
      costByProvider: costByProvider,
      currencyByProvider: CURRENCY,
      deepseekModels: deepseekModels
    };
    return result;
  });

  /* ======== Usage Summary(日 / 自然周 / 自然月 × provider) ======== */

  // 只读聚合:日键在读取时归入自然周(ISO 8601,周一起)/ 自然月,不新增持久化键、无需迁移。
  // 金额与 token 同源:usageDaily + usageDailyCost(经 dsh push 有效聚合),跨币种不求和。
  ipcMain.handle('get:usage-summary', (event, arg) => {
    const { provider, bucket, from, to } = arg || {};
    try {
      const usageDaily = effectiveUsageDaily(deps.store);
      const result = aggregateUsage(
        usageDaily,
        effectiveUsageDailyCost(deps.store),
        {
          bucket: bucket,
          provider: provider,
          from: from,
          to: to,
          monthlyFee: deps.store.get('data.subscriptionMonthlyFee') || {}
        }
      );
      // 平台选择器用:出现在数据里的平台(降序按总量),渲染端不硬编码平台清单
      // retention:本地保留窗口(设置 → 历史数据保留);周期起点早于它 = 该周期数字残缺,
      // 渲染端据此挑明口径(如保留 7 天却看「本月」)。
      const historyDays = Number(deps.store.get('data.historyDays'));
      const retentionStart = Number.isInteger(historyDays) && historyDays > 0
        ? retentionStartDay(historyDays)
        : null;
      // 最早有数据的日键 + 保留起点所在的 ISO 周:渲染层要用与主进程**同一套数据驱动判据**
      // 决定要不要披露口径残缺(只比"周期起点 < 保留起点"会把补过历史的用户一直误报,
      // 见 usage-buckets 里 truncated 的注释)。startWeek 放在主进程算,避免渲染层再写一份 ISO 周换算。
      const earliestDay = Object.keys(usageDaily)
        .map((key) => {
          const idx = key.indexOf(':');
          return idx > 0 ? key.slice(idx + 1) : null;
        })
        .filter((day) => /^\d{4}-\d{2}-\d{2}$/.test(day || ''))
        .sort()[0] || null;
      return Object.assign({
        fetchedAt: Date.now(),
        error: null,
        providers: listProviders(usageDaily),
        retention: retentionStart
          ? {
            historyDays: historyDays,
            startDay: retentionStart,
            startWeek: isoWeekKey(retentionStart),
            earliestDay: earliestDay
          }
          : null
      }, result);
    } catch (e) {
      // 读取失败(如 store 损坏)不能把渲染端一起带崩:返回空结果 + 错误文本。
      return {
        bucket: bucket || 'day',
        rows: [],
        totals: { input: 0, cached: 0, output: 0, total: 0, estimatedCost: 0, costByCurrency: {} },
        providers: [],
        fetchedAt: Date.now(),
        error: e && e.message ? e.message : String(e)
      };
    }
  });

  // 单平台窗口卡:今日 / 本周 / 本月(北京时间结算口径,与采集侧日键一致)。
  // 百分比 = 已用 / 用户配置的预算(金额预算优先,Token 预算兜底);
  // 未设预算时 percent 返回 null —— 宁可没有百分比,也不编一个分母。
  ipcMain.handle('get:usage-windows', (event, arg) => {
    const provider = arg && typeof arg.provider === 'string' ? arg.provider : '';
    try {
      const result = usageWindows(
        effectiveUsageDaily(deps.store),
        effectiveUsageDailyCost(deps.store),
        {
          provider: provider,
          budgets: deps.store.get('data.usageBudget') || {},
          tokenBudgets: deps.store.get('data.usageBudgetTokens') || {},
          monthlyFee: deps.store.get('data.subscriptionMonthlyFee') || {},
          historyDays: deps.store.get('data.historyDays')
        }
      );
      return Object.assign({ fetchedAt: Date.now(), error: null }, result);
    } catch (e) {
      return {
        provider: provider,
        currency: null,
        retention: null,
        windows: [],
        fetchedAt: Date.now(),
        error: e && e.message ? e.message : String(e)
      };
    }
  });

  /* ======== History Sync ======== */

  ipcMain.handle('sync:history', async (event) => {
    const sendProgress = (p) => {
      try {
        event.sender.send('sync:progress', p);
      } catch (e) { /* 设置窗口已关闭,进度丢弃 */ }
    };
    const readStore = (k) => deps.store.get(k);
    const writeStore = (k, v) => deps.store.set(k, v);
    const deleteStore = (k) => deps.store.delete(k);
    const runLocalLogExclusive = (providerId, operation) =>
      deps.scheduler && typeof deps.scheduler.runExclusive === 'function'
        ? deps.scheduler.runExclusive(providerId, 'localLog', operation)
        : operation();
    const summary = {};

    const token = deps.store.get('providers.deepseek.sessionToken');
    if (token) {
      const storedProxy = deps.store.get('providers.proxyUrl') || null;
      const proxyUrl = storedProxy === SYSTEM_PROXY_VALUE ? resolveElectronSystemProxy : storedProxy;
      const fetcher = new UsageFetcher();
      summary.deepseek = await syncDeepSeekHistory({
        fetchMonth: (year, month) =>
          fetcher.fetchUsageAmount(token, month, year, { httpGet, proxyUrl }).then((r) => r.dailyData),
        readStore,
        writeStore,
        onProgress: sendProgress
      });
    } else {
      summary.deepseek = { skipped: true, reason: 'not-logged-in' };
    }

    // Codex 手动历史同步走运行时安全影子重建(全局事件去重 + 单次快照提交);
    // Kimi 保持通用事务性重扫。未注入 Codex 运行时(兼容测试夹具)时回退到通用重扫。
    const codexProvider = deps.registry.get('codex');
    if (codexProvider && typeof codexProvider.readLocalLog === 'function') {
      summary.codex = deps.codexUsageRuntime
        ? await deps.codexUsageRuntime.rebuild({ onProgress: sendProgress })
        : await runLocalLogExclusive('codex', () => rescanLocalLogs({
          providerId: 'codex',
          readLocalLog: () => codexProvider.readLocalLog({ store: deps.store }, { retainAll: true }),
          readStore,
          writeStore,
          deleteStore,
          onProgress: sendProgress
        }));
    } else {
      summary.codex = { daysRebuilt: 0, earliestDate: null, skipped: true };
    }

    // Kimi / DSH / Claude Code / opencode 共用同一套事务性全量重扫;
    // Codex 因走运行时影子重建而单独处理(见上)。rescanLocalLogs 会按
    // 'localLogCursors.<providerId>' 约定同时清空 usageDaily / usageDailyCost 与游标。
    for (const providerId of ['kimi', 'dsh', 'claude', 'opencode']) {
      const provider = deps.registry.get(providerId);
      if (!provider || typeof provider.readLocalLog !== 'function') {
        summary[providerId] = { daysRebuilt: 0, earliestDate: null, skipped: true };
        continue;
      }
      // 手动同步前刷新一次系统扫描,新出现的 WSL 发行版也能纳入
      if (providerId === 'kimi' && typeof deps.refreshKimiAutoRoots === 'function') {
        await deps.refreshKimiAutoRoots();
      }
      summary[providerId] = await runLocalLogExclusive(providerId, () => rescanLocalLogs({
        providerId: providerId,
        readLocalLog: () => provider.readLocalLog({ store: deps.store }, { retainAll: true }),
        readStore: readStore,
        writeStore: writeStore,
        deleteStore: deleteStore,
        onProgress: sendProgress
      }));
    }

    // 历史保留提示:最早日期落在保留窗口外时给出建议天数(只提示不擅改)
    const historyDays = deps.store.get('data.historyDays');
    const earliest = [summary.deepseek, summary.codex, summary.kimi, summary.dsh,
      summary.claude, summary.opencode]
      .map((r) => r && r.earliestDate)
      .filter(Boolean)
      .sort()[0] || null;
    if (earliest && Number.isInteger(historyDays) && historyDays > 0 && earliest < retentionStartDay(historyDays)) {
      summary.retentionHint = {
        historyDays,
        earliestDate: earliest,
        suggestedDays: inclusiveBeijingDayCount(earliest)
      };
    }

    if (deps.tokenSpeedRuntime && typeof deps.tokenSpeedRuntime.rebaselineAll === 'function') {
      deps.tokenSpeedRuntime.rebaselineAll();
    }

    // 广播 providers:changed,渲染端 TokenHeatmap/ProviderBar 已订阅,会自动重取 get:heatmap
    if (deps.scheduler && typeof deps.scheduler.pollAll === 'function') {
      await deps.scheduler.pollAll();
    }
    return summary;
  });

  /* ======== MCP 服务 ======== */

  ipcMain.handle('mcp:getConnectionInfo', () => {
    const rt = typeof deps.getMcpRuntime === 'function' ? deps.getMcpRuntime() : null;
    return rt ? rt.getConnectionInfo() : { enabled: false, running: false, port: null, url: null, token: null };
  });

  ipcMain.handle('mcp:rotateToken', async () => {
    const rt = typeof deps.getMcpRuntime === 'function' ? deps.getMcpRuntime() : null;
    if (!rt) throw new Error('MCP 服务未初始化');
    await rt.rotateToken();
    return rt.getConnectionInfo();
  });

  ipcMain.handle('ingest:getConnectionInfo', () => {
    const rt = typeof deps.getIngestRuntime === 'function' ? deps.getIngestRuntime() : null;
    return rt ? rt.getConnectionInfo() : {
      enabled: false,
      running: false,
      listenHost: null,
      port: null,
      url: null,
      token: null,
      diagnostics: {}
    };
  });

  ipcMain.handle('ingest:rotateToken', async () => {
    const rt = typeof deps.getIngestRuntime === 'function' ? deps.getIngestRuntime() : null;
    if (!rt) throw new Error('DSH ingest 服务未初始化');
    await rt.rotateToken();
    return rt.getConnectionInfo();
  });

  /* ======== Settings ======== */

  ipcMain.on('settings:update', (event, { key: rawKey, value } = {}) => {
    if (!isWritableSettingKey(rawKey)) {
      console.warn('[settings] rejected non-whitelisted settings:update key:', rawKey);
      return;
    }
    const key = resolveWritableSettingKey(rawKey);
    saveSetting(deps, { key, value });
  });

  ipcMain.handle('settings:save', (event, payload) => {
    return saveSetting(deps, payload);
  });

  ipcMain.handle('settings:replace-api-key', async (event, payload) => {
    const deepseek = deps.registry.get('deepseek');
    return replaceDeepseekApiKey({
      store: deps.store,
      verifyApiKey: (apiKey) => deepseek.fetchBalance(deepseekApiKeyCtx(deps, apiKey)),
      broadcastSettings: deps.broadcastSettings
    }, payload);
  });

  ipcMain.handle('get:settings', () => {
    return sanitizeSettings(deps.store.store);
  });

  // 设置页"自定义 HTTP 代理"预填:探测本机常见代理端口是否在监听
  ipcMain.handle('detect:proxy-port', async () => {
    return { port: await detectProxyPort() };
  });

  ipcMain.on('settings:reset', () => {
    resetSettingsStore(deps.store);
    /* 重置会把 window.miniMode / window.edgeAutoHide 打回默认 false,但**物理窗口的状态不会跟着回去**:
       窗口仍是 250×216 且 setResizable(false)、停靠状态机也还在跑。结果就是"设置说不是迷你模式、
       窗口却是迷你尺寸" —— 点「迷你模式」会走 enter() 而不是 exit(),要按两次才出得来(审查发现)。
       所以这里把运行时窗口状态一并收回去,让物理状态与设置一致。 */
    if (deps.miniMode && typeof deps.miniMode.isActive === 'function' && deps.miniMode.isActive()) {
      try { deps.miniMode.exit(); } catch (_) { /* 忽略:重置不该因为窗口操作失败而中断 */ }
    }
    const dock = deps.getEdgeDock && deps.getEdgeDock();
    if (dock && typeof dock.getDockMeta === 'function' && dock.getDockMeta()) {
      try { dock.disable(); } catch (_) { /* 同上 */ }
    }
    if (deps.tokenSpeedRuntime && typeof deps.tokenSpeedRuntime.applySettings === 'function') {
      deps.tokenSpeedRuntime.applySettings();
    }
    console.log('[settings] reset done (credentials and usage state preserved)');
    if (getMain()) {
      getMain().setAlwaysOnTop(true);
    }
    deps.broadcastSettings();
  });

  /* ======== Window geometry ======== */

  ipcMain.handle('get:bounds', () => {
    if (!getMain()) return null;
    return getMain().getBounds();
  });

  ipcMain.handle('window:commit', (event, bounds) => {
    if (!getMain()) return null;
    var next = deps.normalizeMainBounds(bounds);
    var current = getMain().getBounds();
    var sameSize = current.width === next.width && current.height === next.height;

    if (sameSize) {
      return deps.persistMainWindowBounds();
    }

    getMain().setBounds(next);
    return deps.persistMainWindowBounds();
  });

  ipcMain.on('window:set-bounds', (event, bounds) => {
    var win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win !== getMain() || win.isDestroyed()) return;
    var current = win.getBounds();
    var next;
    if (deps.miniMode && deps.miniMode.isActive()) {
      // 迷你模式:只移动位置。尺寸强制回迷你规格——这台机器(250% DPI)上
      // setBounds/getBounds 每往返一次 DWM 会给窗口加 1px 隐形边框,沿用
      // current 尺寸会每帧涨 1px,拖一圈窗口就肉眼可见地变大
      var mx = Number(bounds && bounds.x);
      var my = Number(bounds && bounds.y);
      next = {
        x: Number.isFinite(mx) ? Math.round(mx) : current.x,
        y: Number.isFinite(my) ? Math.round(my) : current.y,
        width: MINI_WIDTH,
        height: MINI_HEIGHT
      };
    } else {
      next = deps.normalizeMainBounds(bounds);
    }
    if (current.x === next.x && current.y === next.y
        && current.width === next.width && current.height === next.height) {
      return;
    }
    win.setBounds(next, false);
  });

  ipcMain.on('window:minimize', () => {
    if (getMain()) getMain().hide();
  });

  // 迷你模式切换:窗口几何/采样开关/广播都在 miniMode 模块内完成
  ipcMain.on('window:toggle-mini', () => {
    if (deps.miniMode) deps.miniMode.toggle();
  });

  ipcMain.on('zoom:change', (event, { delta } = {}) => {
    if (!getMain() || getMain().isDestroyed()) return;
    // 迷你模式锁定 zoom=1,禁止 Ctrl+滚轮缩放(窗口始终以最小尺寸展示)
    if (deps.miniMode && deps.miniMode.isActive()) return;
    var current = getMain().webContents.getZoomFactor();
    var next = Math.min(1.6, Math.max(0.7, Math.round((current + delta) * 100) / 100));
    getMain().webContents.setZoomFactor(next);
    deps.store.set('window.zoomFactor', next);
  });

  ipcMain.on('session:relogin', () => {
    deps.createSessionWindow();
  });

  ipcMain.handle('get:session-state', () => {
    const snapshot = getSessionSnapshot(deps.runtime);
    return {
      status: snapshot.status,
      loggedIn: snapshot.loggedIn,
      error: snapshot.error
    };
  });

  ipcMain.on('window:close', () => {
    if (deps.getLoginWindow()) deps.getLoginWindow().close();
  });

  ipcMain.on('login:skip', () => {
    try {
      skipDeepseekLogin({
        getLoginWindow: deps.getLoginWindow,
        getMainWindow: deps.getMainWindow,
        createMainWindow: deps.createMainWindow
      });
    } catch (error) {
      console.error('[login:skip]', JSON.stringify({
        code: error && error.code ? error.code : 'MAIN_WINDOW_UNAVAILABLE'
      }));
    }
  });

  ipcMain.on('window:close-settings', () => {
    const win = getSettings();
    if (win && !win.isDestroyed()) win.close();
  });

  ipcMain.on('refresh:dashboard', async () => {
    await deps.scheduler.pollAll();
  });

  ipcMain.on('open:settings', (event) => {
    deps.createSettingsWindow();
  });

  /* ======== 缩放状态机(resize IPC 原样搬入,逻辑零改动) ======== */

  function getResizeState(win) {
    if (win === getMain()) return mainResizeState;
    if (win === getSettings()) return settingsResizeState;
    return null;
  }

  function setResizeState(win, state) {
    if (win === getMain()) {
      mainResizeState = state;
      deps.resizeState.main = !!state;
    } else if (win === getSettings()) {
      settingsResizeState = state;
      deps.resizeState.settings = !!state;
    }
  }

  function applyResizeBounds(win, state) {
    if (!state || !state.pendingBounds || !win || win.isDestroyed()) return;
    var next = state.pendingBounds;
    state.pendingBounds = null;
    var current = win.getBounds();
    if (current.x !== next.x || current.y !== next.y
        || current.width !== next.width || current.height !== next.height) {
      win.setBounds(next, false);
    }
  }

  function scheduleResizeFrame(win, state) {
    if (state.timer) return;
    state.timer = setTimeout(function () {
      state.timer = null;
      if (getResizeState(win) !== state) return;
      applyResizeBounds(win, state);
    }, 16);
  }

  function flushResizeFrame(win, state) {
    if (!state) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    applyResizeBounds(win, state);
  }

  ipcMain.on('resize:start', (event, { edge, screenX, screenY } = {}) => {
    var win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    var bounds = win.getBounds();
    setResizeState(win, {
      edge: edge,
      startBounds: bounds,
      startScreenX: screenX,
      startScreenY: screenY,
      pendingBounds: null,
      timer: null
    });
  });

  ipcMain.on('resize:move', (event, { screenX, screenY } = {}) => {
    var win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    var state = getResizeState(win);
    if (!state) return;

    var dx = screenX - state.startScreenX;
    var dy = screenY - state.startScreenY;
    var newBounds = { x: state.startBounds.x, y: state.startBounds.y, width: state.startBounds.width, height: state.startBounds.height };
    var edge = state.edge;
    var isSettings = win === getSettings();
    var minW = isSettings ? 340 : 380;
    var minH = isSettings ? 440 : 200;
    var maxW = isSettings ? 1600 : 2400;
    var maxH = isSettings ? 1200 : 1600;

    if (edge.indexOf('e') !== -1) {
      newBounds.width = Math.min(maxW, Math.max(minW, state.startBounds.width + dx));
    }
    if (edge.indexOf('w') !== -1) {
      var proposedW = Math.min(maxW, Math.max(minW, state.startBounds.width - dx));
      newBounds.x = state.startBounds.x + state.startBounds.width - proposedW;
      newBounds.width = proposedW;
    }
    if (edge.indexOf('s') !== -1) {
      newBounds.height = Math.min(maxH, Math.max(minH, state.startBounds.height + dy));
    }
    if (edge.indexOf('n') !== -1) {
      var proposedH = Math.min(maxH, Math.max(minH, state.startBounds.height - dy));
      newBounds.y = state.startBounds.y + state.startBounds.height - proposedH;
      newBounds.height = proposedH;
    }

    state.pendingBounds = newBounds;
    scheduleResizeFrame(win, state);
  });

  ipcMain.on('resize:end', (event) => {
    var win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    var state = getResizeState(win);
    flushResizeFrame(win, state);
    setResizeState(win, null);

    if (win === getMain()) {
      deps.persistMainWindowBounds();
      deps.sendMainWindowBounds();
    }
  });
  /* ======== 贴边自动隐藏(issue #170):渲染端指针事件驱动展开/收起 ======== */

  ipcMain.on('edge-dock:pointer-enter', (event) => {
    if (BrowserWindow.fromWebContents(event.sender) !== getMain()) return;
    var dock = deps.getEdgeDock && deps.getEdgeDock();
    if (dock) dock.pointerEnter();
  });

  ipcMain.on('edge-dock:pointer-leave', (event) => {
    if (BrowserWindow.fromWebContents(event.sender) !== getMain()) return;
    var dock = deps.getEdgeDock && deps.getEdgeDock();
    if (dock) dock.pointerLeave();
  });

  // 渲染层主动拉取当前停靠状态(广播只覆盖状态变化,挂载时需要一次快照)
  ipcMain.handle('get:edge-dock-state', () => {
    var dock = deps.getEdgeDock && deps.getEdgeDock();
    if (!dock) return null;
    var meta = dock.getDockMeta();
    return { state: dock.getState(), edge: meta ? meta.edge : null };
  });
};
