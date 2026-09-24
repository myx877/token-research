/**
 * 「用量汇总」卡真实渲染校验(可复跑):
 *   1. 用本机 http 服务托管 vite 构建产物 renderer/dist;
 *   2. 在 index.html 注入桩 window.api(固定用量数据),真实 Chromium 加载页面;
 *   3. 断言渲染出的表头/周期/分行币种/估算开关/桶切换,并逐张截图。
 *
 * 两种跑法:
 *   A) npx electron scripts/verify-usage-summary-ui.js      # 断言 + 截图(Electron 自带 Chromium)
 *   B) node scripts/verify-usage-summary-ui.js --serve      # 只起服务,交给系统 Chrome/Edge 无头渲染:
 *      chrome --headless=new --virtual-time-budget=8000 --dump-dom <url>            # DOM 断言
 *      chrome --headless=new --virtual-time-budget=8000 --screenshot=x.png <url>    # 截图
 *      可用 query 驱动初始态: ?bucket=week&estimate=1&theme=dark
 *
 * 产物: docs/verification/usage-summary/*.png(截图供人工复核)+ 控制台 PASS/FAIL 清单
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const DIST = path.resolve(__dirname, '..', 'renderer', 'dist');
const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'verification', 'usage-summary');

function row(bucket, key, provider, total, cost, currency, estimatedCost) {
  return {
    bucket: bucket,
    bucketKey: key,
    provider: provider,
    input: Math.round(total * 0.8),
    cached: Math.round(total * 0.6),
    output: total - Math.round(total * 0.8),
    total: total,
    cost: cost,
    currency: currency,
    costSource: cost > 0 ? 'real' : null,
    estimatedCost: estimatedCost || 0
  };
}

// 单平台窗口卡数据(主进程 get:usage-windows 的返回形状)。
// opencode 带预算 → 出现百分比徽章与进度条,且 month 故意超预算(over → 红色);
// deepseek 不带预算 → percent 全为 null:只显示用量与金额 + 一句提示,绝不显示百分比。
const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;

// 与主进程 usage-buckets CURRENCY 同口径(harness 里只用于生成空白窗口的币种)
const CURRENCY = {
  deepseek: 'CNY', dsh: 'CNY', kimi: 'CNY', claude: 'CNY', opencode: 'USD', codex: 'USD'
};

// 全部受支持平台(与渲染端 providers-meta 一致):每个都要能被选中且是同一套卡片
const ALL_PLATFORMS = [
  ['DeepSeek', 'deepseek'],
  ['Codex', 'codex'],
  ['Kimi', 'kimi'],
  ['DSH', 'dsh'],
  ['Claude Code', 'claude'],
  ['opencode', 'opencode']
];

function win(key, label, bucketKey, total, cost, currency, resetInMs, budget, percent) {
  return {
    key: key,
    label: label,
    bucketKey: bucketKey,
    from: bucketKey,
    to: bucketKey,
    resetsAt: Date.now() + resetInMs,
    input: Math.round(total * 0.8),
    cached: Math.round(total * 0.6),
    output: total - Math.round(total * 0.8),
    total: total,
    cost: cost,
    currency: currency,
    budget: budget || 0,
    budgetBasis: percent === null || percent === undefined ? null : 'cost',
    percent: percent === null || percent === undefined ? null : percent,
    over: typeof percent === 'number' && percent > 100
  };
}

const WINDOWS = {
  opencode: {
    provider: 'opencode',
    currency: 'USD',
    windows: [
      win('day', '今日', '2026-09-17', 1300000, 1.0, 'USD', 10 * HOUR_MS + 30 * 60000, 4, 25),
      win('week', '本周', '2026-W38', 1950000, 1.5, 'USD', 4 * DAY_MS + 21 * HOUR_MS, 5, 30),
      win('month', '本月', '2026-09', 2080000, 1.7, 'USD', 12 * DAY_MS, 1, 170)
    ]
  },
  deepseek: {
    provider: 'deepseek',
    currency: 'CNY',
    windows: [
      win('day', '今日', '2026-09-17', 960000, 8.12, 'CNY', 6 * HOUR_MS, 0, null),
      win('week', '本周', '2026-W38', 3640000, 30.12, 'CNY', 4 * DAY_MS + 21 * HOUR_MS, 0, null),
      win('month', '本月', '2026-09', 5800000, 48.24, 'CNY', 12 * DAY_MS, 0, null)
    ]
  }
};

const ROWS = {  day: [
    row('day', '2026-09-17', 'deepseek', 1500000, 12.34, 'CNY', 0),
    row('day', '2026-09-17', 'codex', 420000, 0, 'USD', 3.22),
    row('day', '2026-09-17', 'opencode', 500000, 1.87, 'USD', 0),
    row('day', '2026-09-16', 'deepseek', 1180000, 9.66, 'CNY', 0),
    row('day', '2026-09-16', 'codex', 380000, 0, 'USD', 2.91),
    row('day', '2026-09-16', 'opencode', 260000, 0.94, 'USD', 0),
    row('day', '2026-09-15', 'deepseek', 960000, 8.12, 'CNY', 0),
    row('day', '2026-09-15', 'opencode', 140000, 0.51, 'USD', 0)
  ],
  week: [
    row('week', '2026-W38', 'deepseek', 3640000, 30.12, 'CNY', 0),
    row('week', '2026-W38', 'codex', 800000, 0, 'USD', 6.13),
    row('week', '2026-W38', 'opencode', 900000, 3.32, 'USD', 0),
    row('week', '2026-W37', 'deepseek', 2980000, 24.5, 'CNY', 0),
    row('week', '2026-W37', 'opencode', 610000, 2.11, 'USD', 0)
  ],
  month: [
    row('month', '2026-09', 'deepseek', 12400000, 102.4, 'CNY', 0),
    row('month', '2026-09', 'codex', 2600000, 0, 'USD', 20),
    row('month', '2026-09', 'opencode', 3100000, 11.4, 'USD', 0)
  ]
};

const TOTALS = {
  day: { input: 4000000, cached: 3000000, output: 900000, total: 5340000, estimatedByCurrency: { USD: 6.13 }, costByCurrency: { CNY: 30.12, USD: 3.32 } },
  week: { input: 6000000, cached: 4000000, output: 1400000, total: 8330000, estimatedByCurrency: { USD: 6.13 }, costByCurrency: { CNY: 54.62, USD: 5.43 } },
  month: { input: 14000000, cached: 9000000, output: 3300000, total: 18100000, estimatedByCurrency: { USD: 20 }, costByCurrency: { CNY: 102.4, USD: 11.4 } }
};

function settingsFor(theme) {
  return {
    components: {
      // 刻意不设 usageSummary:让卡片靠注册表 defaultVisible 自己出现——
      // 这正是"交付后悬浮窗里可见"的端到端证明(设为 true 会把默认值这道门绕过去)
      quotaCodex: false,
      quotaKimi: false,
      balanceCard: false,
      todayCostCard: false,
      cacheRateCard: false,
      modelBar: false,
      providerBar: false,
      tokenSpeed: false,
      tokenLine: false,
      costLine: false,
      tokenHeatmap: false
    },
    data: { historyDays: 30 },
    // 凭证态由 get:settings 里的非敏感标记驱动(apiKeySet:配没配),密钥明文永不进渲染进程
    providers: { deepseek: { apiKeySet: false } },
    window: { followSystemTheme: false, darkMode: theme, miniMode: false }
  };
}

// 桩 window.api:必须在主 bundle 之前执行,故内联进 index.html 的 <head>
function stubScript() {
  return '<script>(function(){\n'
    + '  var DATA = ' + JSON.stringify({ rows: ROWS, totals: TOTALS, windows: WINDOWS, currency: CURRENCY, settings: { light: settingsFor('light'), dark: settingsFor('dark') } }) + ';\n'
    + '  var params = new URLSearchParams(location.search);\n'
    + '  var initial = JSON.parse(JSON.stringify(DATA.settings.light));\n'
    + '  if (params.get("theme") === "dark") initial.window.darkMode = "dark";\n'
    + '  var wantWeek = params.get("bucket") === "week";\n'
    + '  var wantMonth = params.get("bucket") === "month";\n'
    + '  var wantEstimate = params.get("estimate") === "1";\n'
    + '  var wantPlatform = params.get("platform");\n'
    // 凭证态:默认"全缺",便于验证"缺什么就明说";可经 ?key/?session/?codex/?kimi 或 __setCred 切换
    + '  var CRED = { apiKeySet: false, loggedIn: false, codexStatus: "ok", kimiStatus: "ok" };\n'
    // 订阅摊薄估算:codex/kimi 没有真实账单,金额只能来自"设置 → 金额"的月费摊薄。
    // 桩必须能在运行中打开它,才能验证 ≈ 前缀与"不把估算冒充账单"这条。
    + '  var EST = { codex: 0 };\n'
    // Token 预算开关:打开后窗口行的 budgetBasis 变 'tokens' ⇒ 条上主数字该变成 token 数
    + '  var TOKEN_BUDGET = {};\n'
    + '  if (params.get("key") === "1") CRED.apiKeySet = true;\n'
    + '  if (params.get("session") === "1") CRED.loggedIn = true;\n'
    + '  if (params.get("codex")) CRED.codexStatus = params.get("codex");\n'
    + '  if (params.get("kimi")) CRED.kimiStatus = params.get("kimi");\n'
    + '  window.__calls = [];\n'
    // 保留窗口口径:0 = 不披露(默认,和历史行为一致);>0 = 模拟"设置 → 历史数据保留"的 N 天,
    // 主进程会据此把起点早于保留起点的周期标 truncated(真实判定见 test/usage-windows.test.js)
    + '  var RET = { days: 0, startDay: null };\n'
    + '  window.__setRetention = function(days){\n'
    + '    RET.days = Number(days) || 0;\n'
    // startDay 随天数走:≥28 天时保留起点不晚于本月 1 号(= 本月完整),否则落在本月中途(= 残缺)。
    // 桩必须和主进程同语义,否则就是在用假数据"证明"产品误报(真实判定见 test/usage-windows.test.js)。
    + '    RET.startDay = RET.days >= 28 ? "2026-09-01" : (RET.days > 0 ? "2026-09-17" : null);\n'
    + '    if (window.__emit) window.__emit("providers:changed");\n'
    + '  };\n'
    + '  if (params.get("retention")) window.__setRetention(params.get("retention"));\n'
    + '  var listeners = {};\n'
    + '  window.__keyMode = "ok";\n'
    + '  window.__keySubmitted = [];\n'
    + '  window.__setKeyMode = function(mode){ window.__keyMode = mode; };\n'
    + '  window.__pushSettings = function(next){\n'
    + '    (listeners["settings:loaded"] || []).forEach(function(cb){ cb(next); });\n'
    + '  };\n'
    // 迷你模式切换:模拟主进程 settings:loaded 广播(App 据此在小窗/主界面之间切)
    + '  window.__setMini = function(on){\n'
    + '    initial.window.miniMode = !!on;\n'
    + '    window.__pushSettings(initial);\n'
    + '  };\n'
    + '  window.__emit = function(ch, payload){\n'
    + '    (listeners[ch] || []).forEach(function(cb){ cb(payload); });\n'
    + '  };\n'
    + '  window.__setEstCost = function(pid, v){ EST[pid] = Number(v) || 0; window.__emit("providers:changed"); };\n'
    // 打开/关闭某平台的 Token 预算:只改分母来源(budgetBasis),百分比沿用原值 ——
    // 这样才能验证"同一个百分比,分母换成 token 后主数字该变成 token 数"
    + '  window.__setTokenBudget = function(pid, on){ TOKEN_BUDGET[pid] = !!on; window.__emit("providers:changed"); };\n'
    + '  window.__setCred = function(next){\n'
    + '    Object.keys(next || {}).forEach(function(k){ CRED[k] = next[k]; });\n'
    + '    window.__emit("providers:changed");\n'
    + '    window.__emit("session:changed");\n'
    + '    window.__emit("settings:loaded", initial);\n'
    + '  };\n'
    + '  window.api = {\n'
    + '    invoke: function(channel, arg){\n'
    + '      window.__calls.push({ channel: channel, arg: arg || null });\n'
    + '      if (channel === "get:settings") {\n'
    // 非敏感标记:渲染层只该知道"配没配",拿不到密钥本身
    + '        initial.providers = { deepseek: { apiKeySet: CRED.apiKeySet } };\n'
    + '        return Promise.resolve(initial);\n'
    + '      }\n'
    + '      if (channel === "get:session-state") {\n'
    + '        return Promise.resolve({ status: CRED.loggedIn ? "ok" : "idle", loggedIn: CRED.loggedIn, error: null });\n'
    + '      }\n'
    + '      if (channel === "get:usage-summary") {\n'
    + '        var b = (arg && arg.bucket) || "day";\n'
    + '        return Promise.resolve({ bucket: b, rows: DATA.rows[b] || [], totals: DATA.totals[b], providers: ["deepseek", "codex", "opencode"], fetchedAt: Date.now(), retention: RET.days > 0 ? { historyDays: RET.days, startDay: RET.startDay } : null, error: null });\n'
    + '      }\n'
    + '      if (channel === "get:usage-windows") {\n'
    + '        var pid = (arg && arg.provider) || "";\n'
    + '        var payload = DATA.windows[pid];\n'
    // 未预置数据的平台也返回稳定的三窗口(与真实后端契约一致:没数据就给 0,而不是空数组),
    // 这样"每个平台都是同一套卡片"在渲染层可被真正验证。
    + '        if (!payload) {\n'
    + '          var cur = DATA.currency[pid] || null;\n'
    + '          var keys = ["day", "week", "month"];\n'
    + '          var labels = ["今日", "本周", "本月"];\n'
    + '          payload = { provider: pid, currency: cur, windows: keys.map(function(k, i){\n'
    + '            return { key: k, label: labels[i], bucketKey: "", from: "", to: "",\n'
    + '              resetsAt: Date.now() + (i === 0 ? 6 * 3600000 : (i === 1 ? 4 * 86400000 + 21 * 3600000 : 12 * 86400000)),\n'
    + '              input: 0, cached: 0, output: 0, total: 0, cost: 0, estimatedCost: EST[pid] || 0, currency: cur,\n'
    + '              budget: 0, budgetBasis: null, percent: null, over: false };\n'
    + '          }) };\n'
    + '        }\n'
    // 保留窗口口径:与主进程一致 —— 周期起点早于保留起点即标 truncated(此处数据是合成的,
    // 只有 09 月的 month 窗口起点 09-01 会早于 RET.startDay;真实判定由单测覆盖)
    // 注意:主进程的真实判定已改为**数据驱动**(还要"库里确实没有更早的日桶"才算残缺,
    // 见 src/main/core/usage-buckets.js)。桩这里**故意**无条件造出 truncated=true,
    // 为的是让渲染层那条披露横幅始终有东西可测 —— 判定本身在 test/usage-windows.test.js 里钉。
    + '        var withRet = Object.assign({}, payload, { retention: RET.days > 0 ? { historyDays: RET.days, startDay: RET.startDay } : null });\n'
    + '        withRet.windows = (payload.windows || []).map(function(w){\n'
    + '          var tokenBudget = !!TOKEN_BUDGET[pid] && w.percent !== null && w.percent !== undefined;\n'
    + '          return Object.assign({}, w, {\n'
    + '            truncated: RET.days > 0 && RET.days < 28 && w.key === "month",\n'
    + '            budgetBasis: tokenBudget ? "tokens" : w.budgetBasis\n'
    + '          });\n'
    + '        });\n'
    + '        return Promise.resolve(Object.assign({ fetchedAt: Date.now(), error: null }, withRet));\n'
    + '      }\n'
    // 平台清单带 authStatus:卡片据此判"本机 CLI 凭证缺失/过期"
    + '      if (channel === "settings:replace-api-key") {\n'
    // 主进程语义:先 fetchBalance 校验,通过才 set;失败 reject(不写 store)
    + '        var candidate = (arg && arg.apiKey) || "";\n'
    + '        window.__keySubmitted.push(candidate);\n'
    + '        if (window.__keyMode === "invalid") {\n'
    + '          return Promise.reject(new Error("Error invoking remote method \'settings:replace-api-key\': Error: API key verification failed"));\n'
    + '        }\n'
    + '        CRED.apiKeySet = true;\n'
    // 主进程 replaceDeepseekApiKey 成功后一定会广播 settings:loaded(deps.broadcastSettings);
    // 桩少了这一步,"配好 Key 之后卡片/标签栏跟着改口"就永远验证不到 —— 桩在撒谎。
    + '        initial.providers = { deepseek: { apiKeySet: true } };\n'
    + '        window.__emit("settings:loaded", initial);\n'
    + '        return Promise.resolve({ ok: true });\n'
    + '      }\n'
    + '      if (channel === "get:providers") return Promise.resolve([\n'
    + '        { id: "codex", displayName: "Codex", authStatus: CRED.codexStatus },\n'
    + '        { id: "kimi", displayName: "Kimi", authStatus: CRED.kimiStatus },\n'
    + '        { id: "deepseek", displayName: "DeepSeek", authStatus: CRED.loggedIn ? "ok" : "missing" },\n'
    + '        { id: "opencode", displayName: "opencode", authStatus: "ok" },\n'
    + '        { id: "dsh", displayName: "DSH", authStatus: "ok" },\n'
    + '        { id: "claude", displayName: "Claude Code", authStatus: "ok" }\n'
    + '      ]);\n'
    + '      if (channel === "get:heatmap") {\n'
    // 热力图桩:给 2026 年 7~9 月造逐日数据,让「每日/每周/累计」三种模式和悬停浮层
    // 月下钻都有真实格子可断言(以前这里返回空 days,热力图等于没被测过)。
    // 保留窗口与窗口卡同源(RET),所以月初被裁的月份能看到"残"角标与琥珀说明。
    + '        var pid = (arg && arg.provider) || "all";\n'
    + '        var SEED = { deepseek: 3, opencode: 5 };\n'
    + '        var byProvider = {};\n'
    + '        ["deepseek", "opencode"].forEach(function(p){\n'
    + '          var dd = {};\n'
    + '          for (var m = 7; m <= 9; m++) {\n'
    + '            var last = [0, 31, 28, 31][m] || 30;\n'
    + '            for (var d = 1; d <= last; d++) {\n'
    + '              var key = "2026-" + (m < 10 ? "0" : "") + m + "-" + (d < 10 ? "0" : "") + d;\n'
    + '              dd[key] = SEED[p] * ((d % 7) + 1);\n'
    + '            }\n'
    + '          }\n'
    + '          byProvider[p] = dd;\n'
    + '        });\n'
    + '        var merged = {};\n'
    + '        (pid === "all" ? ["deepseek", "opencode"] : [pid]).forEach(function(p){\n'
    + '          Object.keys(byProvider[p] || {}).forEach(function(k){ merged[k] = (merged[k] || 0) + byProvider[p][k]; });\n'
    + '        });\n'
    + '        var maxDaily = 0;\n'
    + '        Object.keys(merged).forEach(function(k){ if (merged[k] > maxDaily) maxDaily = merged[k]; });\n'
    + '        var cost = {};\n'
    + '        Object.keys(merged).forEach(function(k){ cost[k] = 0.42; });\n'
    + '        return Promise.resolve({\n'
    + '          days: merged, maxDaily: maxDaily,\n'
    + '          retention: RET.days > 0 ? { historyDays: RET.days, startDay: RET.startDay } : null,\n'
    + '          details: {\n'
    + '            byProvider: byProvider, cachedByProvider: {},\n'
    + '            costByProvider: { deepseek: cost, opencode: cost },\n'
    + '            currencyByProvider: { deepseek: "CNY", opencode: "USD" },\n'
    + '            deepseekModels: {}\n'
    + '          }\n'
    + '        });\n'
    + '      }\n'
    + '      if (channel === "get:token-speed") return Promise.resolve({ enabled: false, providers: [], series: {} });\n'
    + '      if (channel === "get:dashboard") return Promise.resolve(null);\n'
    + '      return Promise.resolve(null);\n'
    + '    },\n'
    // 记录 send 通道(登录平台 / 重试 等按钮真的发出去了什么,属于可断言证据)
    + '    send: function(ch){ window.__calls.push({ channel: ch, sent: true }); },\n'
    + '    on: function(channel, cb){\n'
    + '      listeners[channel] = listeners[channel] || [];\n'
    + '      listeners[channel].push(cb);\n'
    + '      return function(){ listeners[channel] = (listeners[channel] || []).filter(function(f){ return f !== cb; }); };\n'
    + '    }\n'
    + '  };\n'
    // 无驱动(headless --dump-dom/--screenshot)时按 query 点出目标状态:
    // 点的是真实组件、真实事件处理器,不是伪造渲染。
    + '  function drive(){\n'
    + '    var card = document.querySelector(".usage-summary");\n'
    + '    if (!card) return setTimeout(drive, 100);\n'
    + '    if (wantPlatform && !window.__platformDriven) {\n'
    + '      window.__platformDriven = true;\n'
    + '      var trig = card.querySelector(".themed-select-trigger");\n'
    + '      if (trig) trig.click();\n'
    + '      setTimeout(function(){\n'
    + '        var opts = document.querySelectorAll(".themed-select-option");\n'
    + '        for (var i = 0; i < opts.length; i++) {\n'
    + '          if (opts[i].textContent.trim() === wantPlatform) { opts[i].click(); return; }\n'
    + '        }\n'
    + '      }, 150);\n'
    + '      return;\n'
    + '    }\n'
    + '    if (wantEstimate) {\n'
    + '      var cb = card.querySelector(".usage-summary-toggle input");\n'
    + '      if (cb && !cb.checked) cb.click();\n'
    + '    }\n'
    + '    var index = wantWeek ? 1 : (wantMonth ? 2 : 0);\n'
    + '    if (index > 0) {\n'
    + '      var tabs = card.querySelectorAll(".usage-summary-head .heatmap-tab");\n'
    + '      if (tabs[index]) tabs[index].click();\n'
    + '    }\n'
    + '    if (wantEstimate || index > 0) setTimeout(drive, 100);\n'
    + '  }\n'
    + '  setTimeout(drive, 100);\n'
    + '})();</script>';
}

function startServer(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = (req.url || '/').split('?')[0];
      if (url === '/' || url === '/index.html') {
        let html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
        html = html.replace(/<head([^>]*)>/, '<head$1>' + stubScript());
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
      fs.readFile(path.join(DIST, url), (err, buf) => {
        if (err) {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        const ext = path.extname(url);
        const type = ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type });
        res.end(buf);
      });
    });
    server.on('error', reject);
    server.listen(port || 0, '127.0.0.1', () => resolve({ server: server, port: server.address().port }));
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  // 延迟 require:纯 node 跑 --serve 时不需要(也不该)加载 electron 主进程包
  const { app, BrowserWindow } = require('electron');
  app.disableHardwareAcceleration();
  await app.whenReady();

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const failures = [];
  const check = (name, ok, detail) => {
    console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '  → ' + detail : ''));
    if (!ok) failures.push(name);
  };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // "自发登录通道"的判定:只该拦登录/凭证类通道。鼠标进出窗口触发的 edge-dock:pointer-enter
  // 属于窗口贴边隐藏的正常行为,不是登录(把它算成登录会让这条断言失真)。
  const LOGIN_CHANNEL_RE = /login|auth|oauth|signin|token/i;

  const started = await startServer(0);
  const url = 'http://127.0.0.1:' + started.port + '/';
  console.log('页面地址: ' + url);

  const win = new BrowserWindow({
    width: 900,
    height: 720,
    // 必须真实显示:隐藏窗口在 Windows 上合成不可靠,capturePage 会拿到缺行的陈旧帧
    show: true,
    webPreferences: { contextIsolation: false, nodeIntegration: false, backgroundThrottling: false }
  });

  const run = (code) => win.webContents.executeJavaScript(code);
  // 渲染层报错必须看得见:否则 React 抛错会把整棵树卸载,断言只会看到"元素不见了",
  // 让人误以为是选择/交互逻辑问题(实测踩过)。
  win.webContents.on('console-message', function () {
    const args = Array.prototype.slice.call(arguments);
    const details = args[1] && typeof args[1] === 'object' ? args[1] : { level: args[1], message: args[2] };
    const level = String(details.level);
    if (level === 'error' || level === '3' || level === '2') {
      console.log('RENDERER-ERR  ' + String(details.message).slice(0, 500));
    }
  });
  const waitFor = async (code, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await run(code)) return true;
      await delay(150);
    }
    return false;
  };
  const shot = async (name) => {
    // capturePage 返回"最近一次合成帧":布局刚变过时可能拿到上一布局的陈旧帧
    // (像素断言会因此偶发错位)。先丢弃一帧再取,确保留证图与当前 DOM 同代;
    // 真回归(条没画出来)在两帧里都不存在,仍会失败,不会被掩盖。
    await win.webContents.capturePage();
    const image = await win.webContents.capturePage();
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, image.toPNG());
    console.log('SHOT  ' + file);
    return file;
  };
  // 把指针挪到无行区域,再读"明细是否还亮着"。
  // 必须区分两种"还亮着":
  //   hovered > 0           → 真实 OS 光标正压在这一行上(:hover 为真)⇒ 环境干扰,调用方记 SKIP;
  //   没有 hover 却还亮着    → 残留悬停,是真 bug,必须 FAIL。
  // 踩过的坑:合成 mouseMove 挪不动真实光标,不加这层区分就会出现"跑两次两种结果"——
  // 那种断言比没有断言更糟,因为它会训练人忽略红色。
  const readHoverAfterPark = async (rowSelector, detailSelector) => {
    for (let i = 0; i < 3; i += 1) {
      win.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
      await delay(220);
    }
    await delay(350);
    return run('(function(){'
      + 'var rows = document.querySelectorAll(' + JSON.stringify(rowSelector) + ');'
      + 'var hovered = 0;'
      + 'for (var i = 0; i < rows.length; i++) { if (rows[i].matches(":hover")) hovered += 1; }'
      + 'var ops = Array.prototype.map.call(document.querySelectorAll(' + JSON.stringify(detailSelector) + '), function(e){ return getComputedStyle(e).opacity; });'
      + 'return { hovered: hovered, opacities: ops }; })()');
  };
  // 直接量已落盘 PNG 的像素:这是"真的渲染出来了吗/主题真的是深色吗/有没有画成空白"的客观证据,
  // 不依赖任何模型的图像输入能力。
  const ACCENTS = { deepseek: [0x6E, 0x94, 0xF5], codex: [0xF2, 0xA0, 0x5C], opencode: [0x5B, 0xC8, 0xD8] };
  // 窗口卡的进度条/徽章用 --success 绿、超预算用 --error 红:像素计数用来证明
  // "条真的画出来了"以及"没预算时一根绿条都没有"。
  const SUCCESS = [0x22, 0xC5, 0x5E];
  const ERROR_RED = [0xEF, 0x44, 0x44];
  const analyzePixels = (file) => {
    const img = require('electron').nativeImage.createFromPath(file);
    const size = img.getSize();
    const buf = img.toBitmap ? img.toBitmap() : img.getBitmap();
    let sum = 0, dark = 0, light = 0, count = 0, bandInk = 0, bandBright = 0, bandCount = 0;
    let green = 0, red = 0;
    const hits = { deepseek: 0, codex: 0, opencode: 0 };
    const y0 = Math.floor(size.height * 0.2);
    const y1 = Math.floor(size.height * 0.8);
    for (let y = 0; y < size.height; y += 1) {
      for (let x = 0; x < size.width; x += 1) {
        const i = (y * size.width + x) * 4;
        const c1 = [buf[i], buf[i + 1], buf[i + 2]];
        const c2 = [c1[2], c1[1], c1[0]]; // BGRA/RGBA 两种通道序都试,消除平台差异
        const luma = Math.max(
          0.299 * c1[0] + 0.587 * c1[1] + 0.114 * c1[2],
          0.299 * c2[0] + 0.587 * c2[1] + 0.114 * c2[2]
        );
        sum += luma;
        count += 1;
        if (luma < 96) dark += 1;
        if (luma > 200) light += 1;
        if (y >= y0 && y < y1) {
          bandCount += 1;
          if (luma < 200) bandInk += 1;
          if (luma > 150) bandBright += 1;
        }
        Object.keys(ACCENTS).forEach((k) => {
          const a = ACCENTS[k];
          const d = Math.min(
            Math.abs(c1[0] - a[0]) + Math.abs(c1[1] - a[1]) + Math.abs(c1[2] - a[2]),
            Math.abs(c2[0] - a[0]) + Math.abs(c2[1] - a[1]) + Math.abs(c2[2] - a[2])
          );
          if (d < 90) hits[k] += 1;
        });
        // 绿色/红色容差放宽到 120:进度条与徽章是半透明底上的同色系,取值会有偏移
        const nearGreen = Math.min(
          Math.abs(c1[0] - SUCCESS[0]) + Math.abs(c1[1] - SUCCESS[1]) + Math.abs(c1[2] - SUCCESS[2]),
          Math.abs(c2[0] - SUCCESS[0]) + Math.abs(c2[1] - SUCCESS[1]) + Math.abs(c2[2] - SUCCESS[2])
        );
        if (nearGreen < 120) green += 1;
        const nearRed = Math.min(
          Math.abs(c1[0] - ERROR_RED[0]) + Math.abs(c1[1] - ERROR_RED[1]) + Math.abs(c1[2] - ERROR_RED[2]),
          Math.abs(c2[0] - ERROR_RED[0]) + Math.abs(c2[1] - ERROR_RED[1]) + Math.abs(c2[2] - ERROR_RED[2])
        );
        if (nearRed < 120) red += 1;
      }
    }
    return {
      size: size,
      meanLuma: sum / count,
      darkRatio: dark / count,
      lightRatio: light / count,
      bandInkRatio: bandCount ? bandInk / bandCount : 0,
      bandBrightRatio: bandCount ? bandBright / bandCount : 0,
      green: green,
      red: red,
      hits: hits
    };
  };
  // 只在指定矩形内数颜色:整张截图里还有状态栏/其它组件(带自家的绿点),
  // 要验证的命题是"窗口卡里有没有绿条/红条",所以必须先按卡片矩形裁剪再数。
  const countColorInRect = (file, rect, target, tol) => {
    const img = require('electron').nativeImage.createFromPath(file);
    const size = img.getSize();
    const x = Math.max(0, Math.min(size.width - 1, Math.round(rect.x)));
    const y = Math.max(0, Math.min(size.height - 1, Math.round(rect.y)));
    const w = Math.max(1, Math.min(size.width - x, Math.round(rect.width)));
    const h = Math.max(1, Math.min(size.height - y, Math.round(rect.height)));
    const cropped = img.crop({ x: x, y: y, width: w, height: h });
    const cs = cropped.getSize();
    const buf = cropped.toBitmap ? cropped.toBitmap() : cropped.getBitmap();
    let hits = 0;
    let maxRowHits = 0;
    for (let py = 0; py < cs.height; py += 1) {
      let rowHits = 0;
      for (let px = 0; px < cs.width; px += 1) {
        const i = (py * cs.width + px) * 4;
        const c1 = [buf[i], buf[i + 1], buf[i + 2]];
        const c2 = [c1[2], c1[1], c1[0]];
        const d = Math.min(
          Math.abs(c1[0] - target[0]) + Math.abs(c1[1] - target[1]) + Math.abs(c1[2] - target[2]),
          Math.abs(c2[0] - target[0]) + Math.abs(c2[1] - target[1]) + Math.abs(c2[2] - target[2])
        );
        if (d < tol) { hits += 1; rowHits += 1; }
      }
      if (rowHits > maxRowHits) maxRowHits = rowHits;
    }
    // maxRowHits 用来区分"成片图元"(进度条:一行几十~几百像素)与"文字边缘彩边"
    // (ClearType 亚像素抗锯齿:一行只有个位数像素)。看命中总数会把两者混为一谈。
    return { hits: hits, maxRowHits: maxRowHits, rect: { x: x, y: y, width: w, height: h } };
  };
  // 窗口卡矩形(取三行所在的列表容器)
  const windowListRect = () => run('(function(){'
    + 'var el = document.querySelector(".usage-window-list");'
    + 'if (!el) return null;'
    + 'var r = el.getBoundingClientRect();'
    + 'return { x: r.left, y: r.top, width: r.width, height: r.height };'
    + '})()');
  // '11天23小时后重置' / '10小时29分后重置' / '30分钟后重置' → 小时数(便于带容差断言)
  const countdownHours = (text) => {
    const m = /^(?:(\d+)天)?(?:(\d+)小时)?(?:(\d+)分)?后重置$/.exec(String(text).trim());
    if (!m) return null;
    return (Number(m[1]) || 0) * 24 + (Number(m[2]) || 0) + (Number(m[3]) || 0) / 60;
  };
  // 逐行墨迹扫描:回答"这一条到底被画出来了没有",避免降采样把细字洗掉
  const scanBand = (file, y0, y1, step) => {
    const img = require('electron').nativeImage.createFromPath(file);
    const size = img.getSize();
    const buf = img.toBitmap ? img.toBitmap() : img.getBitmap();
    const rows = [];
    for (let y = Math.max(0, y0); y < Math.min(y1, size.height); y += (step || 4)) {
      let ink = 0, darkest = 255;
      for (let x = 0; x < size.width; x += 1) {
        const i = (y * size.width + x) * 4;
        const a = [buf[i], buf[i + 1], buf[i + 2]];
        const b = [a[2], a[1], a[0]];
        const luma = Math.max(
          0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2],
          0.299 * b[0] + 0.587 * b[1] + 0.114 * b[2]
        );
        if (luma < 200) ink += 1;
        if (luma < darkest) darkest = luma;
      }
      if (ink > 0) rows.push({ y: y, ink: ink, darkest: darkest });
    }
    return rows;
  };

  const checkPixels = (label, file, expected) => {    const m = analyzePixels(file);
    check(label, expected(m), '尺寸 ' + m.size.width + 'x' + m.size.height
      + ' 均亮度 ' + m.meanLuma.toFixed(1)
      + ' 暗像素 ' + (m.darkRatio * 100).toFixed(1) + '%'
      + ' 亮像素 ' + (m.lightRatio * 100).toFixed(1) + '%'
      + ' 表格带墨迹 ' + (m.bandInkRatio * 100).toFixed(1) + '%'
      + ' 表格带亮字 ' + (m.bandBrightRatio * 100).toFixed(1) + '%'
      + ' 平台色点 ' + JSON.stringify(m.hits));
  };
  const SNAP = '(function(){'
    + 'var card = document.querySelector(".usage-summary"); if (!card) return null;'
    + 'var txt = function(el){ return el ? el.textContent.trim() : null; };'
    + 'return {'
    + '  title: txt(document.querySelector(\'[data-component-id="usage-summary"] .component-title\')),'
    + '  tabs: Array.prototype.map.call(card.querySelectorAll(".usage-summary-head .heatmap-tab"), function(b){ return b.textContent.trim(); }),'
    + '  activeTab: txt(card.querySelector(".usage-summary-head .heatmap-tab.active")),'
    + '  headers: Array.prototype.map.call(card.querySelectorAll("thead th"), function(th){ return th.textContent.trim(); }),'
    + '  periods: Array.prototype.map.call(card.querySelectorAll("tbody .usage-summary-period"), function(td){ return td.textContent.trim(); }),'
    + '  firstRow: Array.prototype.map.call(card.querySelectorAll("tbody tr:first-child td"), function(td){ return td.textContent.trim(); }),'
    + '  totals: txt(card.querySelector(".usage-summary-total")),'
    + '  estimates: Array.prototype.map.call(card.querySelectorAll(".usage-summary-est"), function(el){ return el.textContent.trim(); }),'
    + '  estChecked: !!(card.querySelector(".usage-summary-toggle input") || {}).checked,'
    + '  error: txt(card.querySelector(".usage-summary-error")),'
    + '  geom: (function(){'
    + '    var q = function(sel){ var el = document.querySelector(sel); if (!el) return null; var r = el.getBoundingClientRect();'
    + '      return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }; };'
    + '    var surface = document.querySelector(\'[data-component-id="usage-summary"] .component-surface\');'
    + '    return { card: q(\'[data-component-id="usage-summary"]\'), surface: q(\'[data-component-id="usage-summary"] .component-surface\'),'
    + '      table: q(".usage-summary-table"), tbody: q(".usage-summary-table tbody"), tfoot: q(".usage-summary-table tfoot"),'
    + '      totals: q(".usage-summary-total"), scrollH: surface ? surface.scrollHeight : null,'
    + '      clientH: surface ? surface.clientHeight : null, innerH: window.innerHeight };'
    + '  })()'
    + '};})()';

  // 平台下拉的唯一交互入口(定义在最前:多处要用,且它内部会等选择真的生效)。
  // 下拉是自绘组件:若上一次没关干净,再点触发器会变成"关"。所以做成幂等 —— 已在目标平台
  // 就直接返回;否则确保菜单真的打开(没开就 Escape 收起后重试),再点目标项。
  // 此前这里有两份实现(credBootSelect + selectPlatform),不幂等的那份在"菜单没关干净"时
  // 静默失败,把后续断言带进错误状态(实测踩过:停在单平台视图 ⇒ 断言拿不到表格)。
  const openPlatformMenu = async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const opened = await run('(function(){ var t = document.querySelector(".usage-summary .themed-select-trigger"); if (!t) return false; t.click(); return true; })()');
      if (!opened) return false;
      if (await waitFor('document.querySelectorAll(".themed-select-option").length > 0', 1200)) return true;
      await run('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
      await delay(120);
    }
    return false;
  };
  // 从列表点某个平台进详情(总览页/列表页没有卡片选择器,只能走平台行)
  const enterFromList = async (label) => {
    const clicked = await run('(function(){'
      + 'var items = document.querySelectorAll(".provider-gate-item");'
      + 'for (var i = 0; i < items.length; i++) {'
      + '  var n = items[i].querySelector(".provider-gate-name");'
      + '  if (n && n.textContent.trim() === ' + JSON.stringify(label) + ') { items[i].click(); return true; }'
      + '}'
      + 'return false; })()');
    if (!clicked) return false;
    if (await waitFor('!!document.querySelector(".single-provider")', 4000)) return true;
    // 需要 Key 且未配的平台(DeepSeek):点行会停在列表页的就地输入面板,
    // 走「稍后再配,先用本机日志进入」才进详情(与用户路径一致,不伪造状态)
    const later = await run('(function(){ var el = document.querySelector(".provider-gate-link"); if (!el) return false; el.click(); return true; })()');
    if (!later) return false;
    return waitFor('!!document.querySelector(".single-provider")', 8000);
  };

  const selectPlatform = async (label) => {
    // 「全部」现在进的是跨平台总览:那里没有卡片选择器,先退回列表再进目标平台
    const inOverview = await run('!!document.querySelector(".provider-overview")');
    if (inOverview) {
      if (label === '全部') return true;
      await run('(function(){ var el = document.querySelector(".titlebar-back"); if (el) el.click(); return true; })()');
      await waitFor('!!document.querySelector(".provider-gate")', 6000);
      return enterFromList(label);
    }
    const current = await run('(function(){ var el = document.querySelector(".usage-summary .themed-select-label"); return el ? el.textContent.trim() : null; })()');
    if (current === label) return true;
    if (!(await openPlatformMenu())) return false;
    const picked = await run('(function(){ var opts = document.querySelectorAll(".themed-select-option");'
      + 'for (var i = 0; i < opts.length; i++) {'
      + '  if (opts[i].textContent.trim() === ' + JSON.stringify(label) + ') { opts[i].click(); return true; }'
      + '}'
      + 'return false; })()');
    if (!picked) return false;
    if (label === '全部') return waitFor('!!document.querySelector(".provider-overview")', 8000);
    // 等选择真的生效(共享 store 广播 → 卡片重渲染),否则后续断言会读到旧状态
    return waitFor('(function(){ var el = document.querySelector(".usage-summary .themed-select-label");'
      + 'return !!el && el.textContent.trim() === ' + JSON.stringify(label) + '; })()', 3000);
  };

  await win.loadURL(url);
  // 未捕获异常留栈:React 渲染期抛错会卸载整棵树,只留"元素不见了"的表象
  await run('window.__rendererErrors = [];'
    + 'window.addEventListener("error", function(e){'
    + '  window.__rendererErrors.push(String((e.error && e.error.stack) || e.message)); });');

  // ── 首屏「选服务商」:启动即到这里,不要求登录 ──────────────────────────
  const gateAppeared = await waitFor('!!document.querySelector(".provider-gate")', 15000);
  check('首屏:启动先到「选服务商」页(不要求登录)', gateAppeared);
  if (!gateAppeared) {
    console.log('页面文本: ' + await run('document.body.innerText.slice(0, 400)'));
    await shot('provider-gate-failed.png');
    win.destroy();
    started.server.close();
    app.quit();
    process.exitCode = 1;
    return;
  }
  const gate = await run('(function(){'
    + 'var txt = function(el){ return el ? el.textContent.trim() : null; };'
    + 'var g = document.querySelector(".provider-gate");'
    + 'var items = Array.prototype.map.call(g.querySelectorAll(".provider-gate-item"), function(b){ return {'
    + '  name: txt(b.querySelector(".provider-gate-name")),'
    + '  status: txt(b.querySelector(".provider-gate-status")),'
    + '  tone: (b.querySelector(".provider-gate-status") || {}).className || "" }; });'
    + 'return { title: txt(g.querySelector(".provider-gate-title")), items: items,'
    + '  sections: Array.prototype.map.call(g.querySelectorAll(".provider-gate-section-title"), function(e){ return e.textContent.trim(); }),'
    + '  hasAll: !!g.querySelector(".provider-gate-all"),'
    + '  skip: txt(g.querySelector(".provider-gate-skip")),'
    + '  hasKeyInput: !!g.querySelector(".provider-gate-input"),'
    + '  loginLayers: document.querySelectorAll(".login-window, .login-layer, .login-mask").length };'
    + '})()');
  check('主界面就是「选择要看的服务商」这一页(不是登录墙)', gate.title === '选择要看的服务商', String(gate.title));
  check('主界面列出全部 6 个平台', same(gate.items.map((i) => i.name),
    ['DeepSeek', 'Codex', 'Kimi', 'DSH', 'Claude Code', 'opencode']),
    JSON.stringify(gate.items.map((i) => i.name)));
  check('主界面未选平台时不弹 Key 输入(不是登录墙)', gate.hasKeyInput === false && gate.loginLayers === 0,
    JSON.stringify({ hasKeyInput: gate.hasKeyInput, loginLayers: gate.loginLayers }));
  // 主界面已经就是这一页之后,「跳过,直接进入主界面」在逻辑上无处可去 —— 它必须不存在
  check('删掉了「跳过,直接进入主界面」按钮', gate.skip === null, String(gate.skip));
  check('平台分成两大类:模型平台 / 工具平台',
    same(gate.sections, ['模型平台', '工具平台(读本机日志)']), JSON.stringify(gate.sections));
  check('有「全部平台」入口(进跨平台总览)', gate.hasAll === true, String(gate.hasAll));
  const dsItem = gate.items.find((i) => i.name === 'DeepSeek') || {};
  check('DeepSeek 在首屏就说明需要 API Key', /需要 API Key/.test(String(dsItem.status)) && /warn/.test(dsItem.tone),
    JSON.stringify(dsItem));
  const localItem = gate.items.find((i) => i.name === 'opencode') || {};
  check('本机日志类平台在首屏说明无需凭证', /无需凭证/.test(String(localItem.status)), String(localItem.status));
  await shot('electron-provider-gate.png');

  // 点 DeepSeek → 出内联 Key 输入;再按「稍后再配」进入(免登录路径完整走一遍)
  await run('(function(){ var el = document.querySelectorAll(".provider-gate-item")[0]; if (!el) return false; el.click(); return true; })()');
  await delay(200);
  const gateKey = await run('(function(){'
    + 'var g = document.querySelector(".provider-gate");'
    + 'return { input: !!g.querySelector(".provider-gate-input"),'
    + '  title: (function(el){ return el ? el.textContent.trim() : null; })(g.querySelector(".provider-gate-action-title")),'
    + '  later: (function(el){ return el ? el.textContent.trim() : null; })(g.querySelector(".provider-gate-link")),'
    + '  loginLayers: document.querySelectorAll(".login-window, .login-layer, .login-mask").length };'
    + '})()');
  check('选中需要 Key 的平台 → 就地出现 Key 输入(不弹窗、不跳转)',
    gateKey.input === true && /DeepSeek API Key/.test(String(gateKey.title)) && gateKey.loginLayers === 0,
    JSON.stringify(gateKey));
  await shot('electron-provider-gate-key.png');
  await run('(function(){ var el = document.querySelector(".provider-gate-link"); if (!el) return false; el.click(); return true; })()');
  const entered = await waitFor('!!document.querySelector(".usage-summary")', 15000);
  if (!entered) {
    console.log('进入主界面失败,渲染层错误栈: ' + await run('(function(){'
      + 'var e = window.__rendererErrors || []; return JSON.stringify(e.slice(0, 2)); })()'));
  }
  check('「稍后再配」可免 Key 进入主界面(不构成登录墙)', entered);
  // 窗口数据是异步取的:先等三行都落定再读,否则读到"还没取回"的 0 行就是假失败
  // (单平台视图挂载的组件更多,首帧 heavier,之前"读一次就中"是运气好)
  const enteredRows = await waitFor('document.querySelectorAll(".usage-window").length === 3', 15000);
  check('进入后三窗口行取数落定(非空等)', enteredRows);
  // 首屏选谁,主界面就该显示谁:这里选的是 DeepSeek ⇒ 直接看到它的三窗口卡
  const enteredState = await run('(function(){'
    + 'var sel = document.querySelector(".usage-summary .themed-select-label");'
    + 'var title = document.querySelector(".usage-summary-single-title");'
    + 'return { selected: sel ? sel.textContent.trim() : null,'
    + '  marker: title ? title.textContent.trim() : null,'
    + '  rows: document.querySelectorAll(".usage-window").length,'
    + '  hasTable: !!document.querySelector(".usage-summary-table") };'
    + '})()');
  check('首屏所选平台在主界面自动选中(当前服务商标识可见)',
    enteredState.selected === 'DeepSeek' && /DeepSeek/.test(String(enteredState.marker)) && enteredState.hasTable === false,
    JSON.stringify(enteredState));
  check('进入即是该平台的三条进度条(今日/本周/本月)',
    same(await run('Array.prototype.map.call(document.querySelectorAll(".usage-window-label"), function(e){ return e.textContent.trim(); })'),
      ['今日', '本周', '本月']) && enteredState.rows === 3, JSON.stringify(enteredState));
  check('每条进度条都标注 命中/输入/输出 明细',
    await run('(function(){ var rows = document.querySelectorAll(".usage-window-breakdown");'
      + 'if (rows.length !== 3) return false;'
      + 'for (var i = 0; i < rows.length; i++) {'
      + '  var t = rows[i].textContent;'
      + '  if (t.indexOf("命中") < 0 || t.indexOf("输入") < 0 || t.indexOf("输出") < 0) return false; }'
      + 'return true; })()'), '3 行 × 命中/输入/输出');
  await shot('electron-provider-gate-entered.png');

  // 「全部平台」入口已按用户要求移除:详情页只能由平台行进入,不再有跨平台聚合视图

  /* ===== 方案 A 全局跟随:选中单平台时,主界面只显示该平台相关 ===== */
  // 背景:之前选中 opencode 也满屏 DeepSeek 专属卡(余额/今日消耗/命中率),
  // 用户体感就是"选择没生效"。现在单平台切到纵向单视图:grid 销毁、DS 卡隐藏。
  const singleEntered = await selectPlatform('opencode');
  check('卡片下拉切到 opencode', singleEntered === true, String(singleEntered));
  const singleShown = await waitFor('!!document.querySelector(".single-provider")', 15000);
  check('主界面进入单平台视图(.single-provider)', singleShown);
  const singleState = await run('(function(){'
    + 'var txt = function(el){ return el ? el.textContent.trim() : null; };'
    + 'return { hintRow: !!document.querySelector(".single-provider-hint"),'
    + '  backToAllText: document.body.innerText.indexOf("返回全部") >= 0,'
    + '  onlyLabel: document.body.innerText.indexOf("当前只看") >= 0,'
    + '  hasBack: !!document.querySelector(".titlebar-back"),'
    + '  hasGrid: !!document.querySelector(".grid-stack"),'
    + '  hasTable: !!document.querySelector(".usage-summary-table"),'
    + '  rows: document.querySelectorAll(".single-provider .usage-window").length,'
    + '  feeSection: !!document.querySelector(".single-provider-fees"),'
    + '  barTitle: txt(document.querySelector(".single-provider .component-title")),'
    + '  heatLock: txt(document.querySelector(".single-provider .heatmap-locked")) };'
    + '})()');
  check('详情页不再有「当前只看」提示条与「返回全部」按钮',
    singleState.hintRow === false && singleState.backToAllText === false && singleState.onlyLabel === false,
    JSON.stringify({ hintRow: singleState.hintRow, 返回全部: singleState.backToAllText, 当前只看: singleState.onlyLabel }));
  // 标题栏**不放**服务商切换控件:34px 高的条里塞一排标签,在默认 420px 窗口里必然退化成
  // 认不出的色点(用户实测圈出来过两次)。切换统一走卡片里的「展示平台 ▾」。
  check('标题栏不放服务商切换控件(只有退回按钮)', singleState.hasBack === true, JSON.stringify({
    hasBack: singleState.hasBack
  }));
  check('单平台视图下 grid 已销毁、跨平台表格不在', singleState.hasGrid === false && singleState.hasTable === false, JSON.stringify({ hasGrid: singleState.hasGrid, hasTable: singleState.hasTable }));
  check('单平台仍是三条进度条(今日/本周/本月)', singleState.rows === 3, String(singleState.rows));
  check('opencode 视图里没有 DS 专属费用区', singleState.feeSection === false, String(singleState.feeSection));
  check('柱状图标题跟着平台走', singleState.barTitle === 'opencode 每日 Token 消耗', String(singleState.barTitle));
  check('热力图页签锁定为仅看该平台', singleState.heatLock === '仅看 opencode', String(singleState.heatLock));
  await shot('electron-single-opencode.png');
  // 标题栏退回按钮 → 回服务商列表(列表就是「上一级」)
  const railBack = await run('(function(){ var el = document.querySelector(".titlebar-back"); if (!el) return false; el.click(); return true; })()');
  check('标题栏退回按钮可点', railBack === true, String(railBack));
  const backToGate = await waitFor('!!document.querySelector(".provider-gate") && !document.querySelector(".single-provider")', 15000);
  check('退回后回到服务商列表(详情页让位给列表)', backToGate);
  // 首页(列表)没有"上一级",退回按钮必须不出现 —— 必须在**列表页**上断言;
  // 「全部平台」也是详情页(要退回列表),拿它当"列表页"会误判(踩过)
  const noBackOnList = await waitFor('!document.querySelector(".titlebar-back")', 3000);
  check('在服务商列表页不显示退回按钮(那里没有上一级)', noBackOnList === true);
  // 列表里的「全部平台」= 进新的跨平台总览(token / 费用 / 占比),不是第 7 个平台
  const pickAll = await run('(function(){ var el = document.querySelector(".provider-gate-all"); if (!el) return false; el.click(); return true; })()');
  check('列表里的「全部平台」入口可点', pickAll === true, String(pickAll));
  const overviewShown = await waitFor('!!document.querySelector(".provider-overview")', 10000);
  const overviewSnap = await run('(function(){'
    + 'var rows = document.querySelectorAll(".overview-row");'
    + 'var cells = Array.prototype.map.call(document.querySelectorAll(".overview-cell"), function(el){ return el.textContent.trim(); });'
    + 'return { shown: !!document.querySelector(".provider-overview"),'
    + '  segs: document.querySelectorAll(".overview-share-seg").length,'
    + '  rows: rows.length,'
    + '  firstRow: rows.length ? rows[0].textContent.trim() : null,'
    + '  cells: cells, single: !!document.querySelector(".single-provider") };'
    + '})()');
  check('「全部平台」进入跨平台总览(而不是单平台视图)',
    overviewShown && overviewSnap.shown === true && overviewSnap.single === false, JSON.stringify(overviewSnap));
  check('总览顶部有今日/本周/本月三格汇总,每格都给出 Token 数',
    (overviewSnap.cells || []).length === 3 && overviewSnap.cells.every((t) => /Token/.test(t)),
    JSON.stringify(overviewSnap.cells));
  check('总览有「各平台本月占比」条 + 图例(平台行带百分比)',
    overviewSnap.segs >= 1 && overviewSnap.rows >= 6 && /%/.test(String(overviewSnap.firstRow)),
    'segs=' + overviewSnap.segs + ' rows=' + overviewSnap.rows + ' first=' + overviewSnap.firstRow);
  check('总览金额按币种分列(不跨币种合计)', overviewSnap.cells.some((t) => /[¥$]/.test(t)), JSON.stringify(overviewSnap.cells));
  await shot('electron-provider-overview.png');
  // 退回列表(列表是总览的上一级),再从列表点 opencode 进详情
  await run('(function(){ var el = document.querySelector(".titlebar-back"); if (!el) return false; el.click(); return true; })()');
  await waitFor('!!document.querySelector(".provider-gate") && !document.querySelector(".provider-overview")', 10000);

  // 详情页只能由平台行进入:从列表点 opencode(真实交互,不伪造状态)
  const enterOpencode = await run('(function(){'
    + 'var items = document.querySelectorAll(".provider-gate-item");'
    + 'for (var i = 0; i < items.length; i++) {'
    + '  var n = items[i].querySelector(".provider-gate-name");'
    + '  if (n && n.textContent.trim() === "opencode") { items[i].click(); return true; }'
    + '}'
    + 'return false; })()');
  check('列表里的 opencode 行可进入详情', enterOpencode === true, String(enterOpencode));
  const enteredFromList = await waitFor('!!document.querySelector(".single-provider")', 15000);
  check('进入详情后是单平台视图', enteredFromList === true);

  /* 「全部平台」聚合视图已按用户要求移除入口 ⇒ 这一段跨平台表格断言在真实交互下不可达。
     代码与断言保留(便于将来若恢复该视图时直接复用),但 check 不会执行。 */
  const tableAvailable = await waitFor('!!document.querySelector(".usage-summary-table")', 2000);
  if (tableAvailable) {

  const day = await run(SNAP);
  check('卡片标题为「用量汇总」', day.title === '用量汇总', String(day.title));
  check('桶页签为 日/周/月', same(day.tabs, ['日', '周', '月']), JSON.stringify(day.tabs));
  check('默认桶为「日」', day.activeTab === '日', String(day.activeTab));
  check('列为各平台(顺序稳定且含新平台)', same(day.headers, ['日期', 'DeepSeek', 'Codex', 'opencode']), JSON.stringify(day.headers));
  check('行为新→旧日期', same(day.periods, ['2026-09-17', '2026-09-16', '2026-09-15']), JSON.stringify(day.periods));
  check('单元格 token 与金额分行显示', day.firstRow.join(' ').indexOf('150.0万') >= 0 && day.firstRow.join(' ').indexOf('¥12.34') >= 0, JSON.stringify(day.firstRow));
  check('无金额平台显示 —(codex 无按次计费)', day.firstRow[2] === '420K—' || day.firstRow[2].indexOf('—') >= 0, String(day.firstRow[2]));
  check('合计分币种展示 ¥ 与 $(绝不相加)', day.totals.indexOf('¥30.12') >= 0 && day.totals.indexOf('$3.32') >= 0, String(day.totals));
  check('估算列默认隐藏', day.estimates.length === 0 && day.estChecked === false, JSON.stringify(day.estimates));
  check('无错误提示', day.error === null, String(day.error));
  console.log('GEOM  ' + JSON.stringify(day.geom));
  // capturePage 会拿到最近一次合成帧,布局动画未停时可能截到中间态:
  // 截图前先让页面稳定(这也保证证据是"稳定态"而不是抢跑帧)。
  await delay(900);
  const settled = await run(SNAP);          // 稳定后重读几何:与截图同源同时刻
  console.log('GEOM2 ' + JSON.stringify(settled.geom));
  const probe = await run('(function(){'
    + 'var td = document.querySelector(".usage-summary-total");'
    + 'var r = td.getBoundingClientRect(); var cs = getComputedStyle(td);'
    + 'var tds = document.querySelector(".usage-summary-table tbody td");'
    + 'var csBody = tds ? getComputedStyle(tds) : null;'
    + 'var cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);'
    + 'var top = document.elementFromPoint(cx, cy);'
    + 'var surface = document.querySelector(\'[data-component-id="usage-summary"] .component-surface\');'
    + 'return { text: td.textContent.trim(), color: cs.color, opacity: cs.opacity, visibility: cs.visibility,'
    + '  display: cs.display, overflow: cs.overflow, rect: { l: Math.round(r.left), t: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },'
    + '  bodyCellColor: csBody ? csBody.color : null, surfaceBg: surface ? getComputedStyle(surface).backgroundColor : null,'
    + '  surfaceOverflow: surface ? getComputedStyle(surface).overflow : null,'
    + '  point: { x: cx, y: cy }, topEl: top ? top.tagName + "." + top.className : null, topIsTotals: !!(top && (top === td || td.contains(top) || top.contains(td))) };'
    + '})()');
  console.log('PROBE ' + JSON.stringify(probe));
  const lightShot = await shot('electron-day-light.png');
  {
    const g = settled.geom;
    const rows = scanBand(lightShot, 0, 655, 4);
    console.log('INKPROFILE ' + rows.map((r) => r.y + ':' + r.ink + (r.darkest < 120 ? '!' : '')).join(' '));
    const totalsInk = rows.filter((r) => r.y >= g.totals.top - 4 && r.y <= g.totals.bottom).reduce((s, r) => s + r.ink, 0);
    check('合计行确实被画出来(DOM 位置上有像素墨迹,不是只在 DOM 里)', totalsInk > 0, 'ink=' + totalsInk);
    const bodyInk = rows.filter((r) => r.y >= g.tbody.top && r.y <= g.tbody.bottom).reduce((s, r) => s + r.ink, 0);
    check('三行数据确实被画出来(tbody 位置有墨迹)', bodyInk > 0, 'ink=' + bodyInk);
    const gapInk = rows.filter((r) => r.y > g.card.bottom + 4 && r.y < g.card.bottom + 80).reduce((s, r) => s + r.ink, 0);
    check('卡片正下方没有溢出内容', gapInk === 0, 'ink=' + gapInk);
    const spill = await run('(function(){'
      + 'var card = document.querySelector(\'[data-component-id="usage-summary"]\').getBoundingClientRect();'
      + 'var bad = [];'
      + 'Array.prototype.forEach.call(document.querySelectorAll(".usage-summary, .usage-summary *"), function(el){'
      + '  var r = el.getBoundingClientRect(); if (!r.width && !r.height) return;'
      + '  if (r.top < card.top - 1 || r.bottom > card.bottom + 1 || r.left < card.left - 1 || r.right > card.right + 1) {'
      + '    bad.push((el.className || el.tagName) + ":" + Math.round(r.top) + "-" + Math.round(r.bottom)); }'
      + '});'
      + 'var below = document.elementFromPoint(50, 642);'
      + 'return { outside: bad.slice(0, 5), belowCardTop: below ? (below.tagName + "." + below.className).slice(0, 60) : null };'
      + '})()');
    check('卡片的任何元素都没有溢出到卡片之外', spill.outside.length === 0, JSON.stringify(spill.outside) + ' 卡片下方 y642 处的元素=' + spill.belowCardTop);
  }

  /* ===== 免凭证启动:一个凭证都没有时,应用照常可用,且不弹登录墙 ===== */
  // 桩的默认凭证态就是"全缺"(CRED 全 false),正好是"不登录、不配任何凭证就启动"的场景。
  await run('window.__setCred({ apiKeySet: false, loggedIn: false, codexStatus: "missing", kimiStatus: "missing" })');
  await delay(300);
  const boot = await run('(function(){'
    + 'var doc = document;'
    + 'return {'
    + '  登录层: doc.querySelectorAll(".login, .login-window, .login-card, .login-overlay, [data-component-id=\\"login\\"]").length,'
    + '  应用外壳: !!doc.querySelector(".app-content, .app-mini"),'
    + '  汇总卡: !!doc.querySelector(".usage-summary"),'
    + '  平台: ((doc.querySelector(".usage-summary .themed-select-label") || {}).textContent || "").trim(),'
    + '  表格: !!doc.querySelector(".usage-summary-table"),'
    + '  自发通道: window.__calls.filter(function(c){ return !!c.sent; }).map(function(c){ return c.channel; })'
    + '};'
    + '})()');
  check('免凭证启动:渲染的是应用主界面,主窗里没有登录层',
    boot.应用外壳 === true && boot.登录层 === 0, JSON.stringify(boot));
  check('免凭证启动:启动落在服务商列表,不再默认进「全部」聚合视图',
    boot.汇总卡 === false && boot.表格 === false,
    JSON.stringify({ 卡: boot.汇总卡, 表: boot.表格, 平台: boot.平台 }));
  check('免凭证启动:没有自发任何登录通道(不会自动弹平台登录窗)',
    boot.自发通道.filter((c) => LOGIN_CHANNEL_RE.test(c)).length === 0, JSON.stringify(boot.自发通道));
  // 从列表点 DeepSeek:未配 Key ⇒ 停在列表页的就地输入面板(不弹窗、不跳转)
  const bootPicked = await run('(function(){'
    + 'var items = document.querySelectorAll(".provider-gate-item");'
    + 'for (var i = 0; i < items.length; i++) {'
    + '  var n = items[i].querySelector(".provider-gate-name");'
    + '  if (n && n.textContent.trim() === "DeepSeek") { items[i].click(); return true; }'
    + '}'
    + 'return false; })()');
  const bootInput = await waitFor('!!document.querySelector(".provider-gate-input")', 3000);
  const bootRows = await run('(function(){'
    + 'return { rows: document.querySelectorAll(".usage-window").length,'
    + '  labels: Array.prototype.map.call(document.querySelectorAll(".usage-window-label"), function(e){ return e.textContent.trim(); }),'
    + '  figures: Array.prototype.map.call(document.querySelectorAll(".usage-window-figures"), function(e){ return e.textContent.trim(); }),'
    + '  sent: window.__calls.filter(function(c){ return !!c.sent; }).map(function(c){ return c.channel; }) };'
    + '})()');
  check('免凭证启动:选中未配 Key 的 DeepSeek,停在列表页就地给输入(不弹窗、不跳转)',
    bootPicked === true && bootInput === true, 'picked=' + bootPicked + ' input=' + bootInput);
  check('免凭证启动:未进详情前不渲染窗口卡(输入面板优先)',
    bootRows.rows === 0, JSON.stringify(bootRows.labels));
  check('免凭证启动:走完"选平台 + 就地补 Key"仍无自发登录通道',
    bootRows.sent.filter((c) => LOGIN_CHANNEL_RE.test(c)).length === 0, JSON.stringify(bootRows.sent));
  await delay(600);
  await shot('electron-boot-nocred.png');
  // 走「稍后再配」进详情,复位成单平台视图(后续断言的前提)
  await run('(function(){ var el = document.querySelector(".provider-gate-link"); if (!el) return false; el.click(); return true; })()');
  await waitFor('!!document.querySelector(".single-provider")', 5000);
  await selectPlatform('opencode');
  await waitFor('document.querySelectorAll(".usage-window").length === 3', 4000);

  // 打开估算:订阅摊薄估算以 ≈ 灰色列出现(点不到就如实 FAIL,而不是让脚本崩)
  const estToggleClicked = await run('(function(){ var cb = document.querySelector(".usage-summary-toggle input"); if (!cb) return false; cb.click(); return true; })()');
  check('估算开关在单平台视图里不存在(它是跨平台表格的开关)', estToggleClicked === false, String(estToggleClicked));
  const withEst = await waitFor('document.querySelectorAll(".usage-summary-est").length > 0', 4000);
  const est = await run(SNAP);
  check('打开估算后出现估算列', withEst && est.estimates.length > 0, JSON.stringify(est.estimates));
  check('估算值与真实金额区分(≈ 前缀)', est.estimates.every((t) => t.indexOf('≈') === 0), JSON.stringify(est.estimates));
  check('合计行也带估算(按币种分开)', est.totals.indexOf('≈$6.13') >= 0, String(est.totals));
  await delay(900);
  await shot('electron-day-estimate.png');

  // 切到「周」桶:应按 ISO 自然周合并(2026-W38 / W37)
  await run('(function(){ var tabs = document.querySelectorAll(".usage-summary-head .heatmap-tab"); if (!tabs[1]) return false; tabs[1].click(); return true; })()');
  const weekly = await waitFor('document.querySelector("tbody .usage-summary-period").textContent.indexOf("W") > 0', 4000);
  const week = await run(SNAP);
  check('切到周桶后按 ISO 周键展示', weekly && same(week.periods, ['2026-W38', '2026-W37']), JSON.stringify(week.periods));
  const calls = await run('window.__calls.filter(function(c){ return c.channel === "get:usage-summary"; }).map(function(c){ return c.arg.bucket + ":" + c.arg.from + ".." + c.arg.to; })');
  check('每次切换都带 from/to 重新取数', calls.length >= 2 && calls[calls.length - 1].indexOf('week:') === 0, JSON.stringify(calls));

  /* ===== 保留窗口口径披露(表格口径:月份行只覆盖保留窗口)=====
     实测缺陷:默认保留 7 天时「本月」只剩近 7 天(opencode 真机少报 93.9%),
     数字本身没错,错在没挑明口径 —— 残缺值被当整月展示。 */
  await run('(function(){ var tabs = document.querySelectorAll(".usage-summary-head .heatmap-tab"); if (!tabs[2]) return false; tabs[2].click(); return true; })()');
  const monthRow = await waitFor('document.querySelector("tbody .usage-summary-period").textContent.indexOf("-") > 0', 4000);
  await run('window.__setRetention(7)');
  const tableRetOn = await waitFor('!!document.querySelector(".usage-window-hint.retention")', 4000);
  const tableRetText = await run('(function(){ var el = document.querySelector(".usage-window-hint.retention"); return el ? el.textContent.trim() : null; })()');
  check('月桶表格:保留 7 天时挑明月份行只覆盖保留窗口',
    tableRetOn && monthRow && !!tableRetText
      && tableRetText.indexOf('历史只保留 7 天') === 0
      && tableRetText.indexOf('2026-09-17') > 0,
    JSON.stringify(tableRetText));
  await delay(900);
  await shot('electron-retention-table-month.png');
  await run('window.__setRetention(90)');
  const tableRetOff = await waitFor('!document.querySelector(".usage-window-hint.retention")', 4000);
  check('月桶表格:保留 90 天时不再提示(不误报)', tableRetOff === true);
  } // ← 「全部平台」聚合视图的断言段到此为止(该视图已无入口,详见上方说明)

  /* ===== 单平台窗口卡:选中一个平台 → 今日 / 本周 / 本月 三行 ===== */
  const WINDOW_SNAP = '(function(){'
    + 'var rows = Array.prototype.map.call(document.querySelectorAll(".usage-window"), function(el){'
    + '  var badge = el.querySelector(".usage-window-badge");'
    + '  var fill = el.querySelector(".usage-window-fill");'
    + '  var track = el.querySelector(".usage-window-bar");'
    + '  return { label: el.querySelector(".usage-window-label").textContent.trim(),'
    + '    badge: badge ? badge.textContent.trim() : null,'
    + '    badgeTitle: badge ? badge.title : null,'
    + '    badgeOver: badge ? badge.classList.contains("over") : false,'
    + '    reset: el.querySelector(".usage-window-reset").textContent.trim(),'
    + '    figures: el.querySelector(".usage-window-figures").textContent.trim(),'
    + '    fillRatio: (fill && track) ? (fill.getBoundingClientRect().width / track.getBoundingClientRect().width) : null,'
    + '    over: el.classList.contains("usage-window-over") };'
    + '});'
    + 'var sel = document.querySelector(".usage-summary .themed-select-label");'
    + 'var hint = document.querySelector(".usage-window-hint");'
    + 'return { rows: rows, selected: sel ? sel.textContent.trim() : null, hasTable: !!document.querySelector(".usage-summary-table"),'
    + '  hint: hint ? hint.textContent.trim() : null, bars: document.querySelectorAll(".usage-window-bar").length,'
    + '  badges: document.querySelectorAll(".usage-window-badge").length,'
    + '  greenFillW: Array.prototype.reduce.call(document.querySelectorAll(".usage-window-fill"), function(s, el){ return s + el.getBoundingClientRect().width; }, 0),'
    + '  tabs: document.querySelectorAll(".usage-summary-head .heatmap-tab").length };'
    + '})()';

  // 选择器必须列出全部平台(而不是只有当期有数据的那些)
  const menuOpened = await openPlatformMenu();
  const optionLabels = menuOpened
    ? await run('Array.prototype.map.call(document.querySelectorAll(".themed-select-option"), function(o){ return o.textContent.trim(); })')
    : [];
  await run('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  await waitFor('document.querySelectorAll(".themed-select-option").length === 0', 1500);
  check('选择器含「全部」+ 6 个平台',
    optionLabels.length === 7 && ['全部', 'DeepSeek', 'Codex', 'Kimi', 'DSH', 'Claude Code', 'opencode'].every((l) => optionLabels.indexOf(l) >= 0),
    JSON.stringify(optionLabels));

  const pickedOpencode = await selectPlatform('opencode');
  const windowsShown = await waitFor('document.querySelectorAll(".usage-window").length === 3', 4000);
  const wSnap = await run(WINDOW_SNAP);
  check('平台选择器切到 opencode', pickedOpencode && wSnap.selected === 'opencode', String(wSnap.selected));
  check('单平台视图是 今日/本周/本月 三行', windowsShown && same(wSnap.rows.map((r) => r.label), ['今日', '本周', '本月']), JSON.stringify(wSnap.rows.map((r) => r.label)));
  check('单平台视图不再显示跨平台表格与桶页签', wSnap.hasTable === false && wSnap.tabs === 0, 'table=' + wSnap.hasTable + ' 桶页签=' + wSnap.tabs);
  check('已用百分比徽章按预算给出(25% / 30% / 170%)',
    same(wSnap.rows.map((r) => r.badge), ['25%预算', '30%预算', '170%预算']),
    JSON.stringify(wSnap.rows.map((r) => r.badge)));
  check('徽章标注分母来源:预算填的就算「预算」',
    wSnap.rows.every((r) => /预算$/.test(String(r.badge))), JSON.stringify(wSnap.rows.map((r) => r.badge)));
  check('超预算那行标红,其余不标红', wSnap.rows[2].badgeOver === true && wSnap.rows[2].over === true && wSnap.rows[0].badgeOver === false, JSON.stringify(wSnap.rows.map((r) => r.badgeOver)));
  // 倒计时是相对时间:今日 ~10.5h(小时级)、本周 ~4d21h、本月 ~12d(天级)。
  // 容差 ±1.5h:天级倒计时只显示到小时(不显示分钟),且渲染耗时会让数值向下取整。
  const cd = wSnap.rows.map((r) => countdownHours(r.reset));
  check('重置倒计时用相对时间且在合理量级(今日≈10.5h / 本周≈117h / 本月≈288h)',
    cd[0] !== null && Math.abs(cd[0] - 10.5) < 1.5 && Math.abs(cd[1] - 117) < 1.5 && Math.abs(cd[2] - 288) < 1.5,
    JSON.stringify(wSnap.rows.map((r) => r.reset)) + ' → ' + JSON.stringify(cd));
  check('每行都有 token 与金额', wSnap.rows.every((r) => /Token/.test(r.figures) && /\$/.test(r.figures)), JSON.stringify(wSnap.rows.map((r) => r.figures)));
  check('预算数值一起显示(知道分母是多少)', wSnap.rows[0].figures.indexOf('预算 $4.00') >= 0, String(wSnap.rows[0].figures));
  check('进度条长度与百分比一致(25% 行 ≈ 0.25)', Math.abs(wSnap.rows[0].fillRatio - 0.25) < 0.02, String(wSnap.rows[0].fillRatio));
  check('超预算进度条封顶在 100%(不溢出容器)', wSnap.rows[2].fillRatio > 0.99 && wSnap.rows[2].fillRatio <= 1.0001, String(wSnap.rows[2].fillRatio));
  check('没设预算的平台才没有徽章(本平台三行都有)', wSnap.badges === 3 && wSnap.bars === 3 && wSnap.hint === null, 'badges=' + wSnap.badges + ' bars=' + wSnap.bars);
  const windowCalls = await run('window.__calls.filter(function(c){ return c.channel === "get:usage-windows"; }).map(function(c){ return c.arg.provider; })');
  check('切平台时按 provider 重新取窗口数据', windowCalls.length >= 1 && windowCalls[windowCalls.length - 1] === 'opencode', JSON.stringify(windowCalls));
  await delay(900);
  const opencodeRect = await windowListRect();
  await shot('electron-window-opencode.png');

  /* ===== 明细默认不可见、悬停才浮现(用户原话:每个条放上去还能看到 输入/输出/命中)=====
     与"常驻显示"的差别必须可验证:默认 opacity 0、悬停 opacity 1,且槽位常驻占高
     (悬停不引起布局跳动)。:hover 不响应合成事件,所以走 CDP 强制伪类这条确定性通道。
     读基线前先 park 指针,并区分"真实光标压着"(SKIP)与"残留悬停"(真 bug)。 */
  const cardPark = await readHoverAfterPark('.usage-window', '.usage-window-breakdown');
  if (cardPark.hovered > 0) {
    // 真实光标正压在某条上 ⇒ 基线读数在物理上取不到。不当产品缺陷,但也不冒充"验证过":
    // "默认隐藏"这条另有源码守卫(test/provider-groups.test.js 钉 opacity:0 + hover:1)。
    console.log('SKIP 明细基线被真实光标挡住(鼠标正压在进度条行上),该读数仅供参考: '
      + JSON.stringify(cardPark.opacities));
  } else {
    check('进度条明细默认不可见(不悬停时不展示 命中/输入/输出)',
      same(cardPark.opacities, ['0', '0', '0']), JSON.stringify(cardPark.opacities));
  }
  let cardHover = null;
  try {
    const dbg = win.webContents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    await dbg.sendCommand('DOM.enable');
    await dbg.sendCommand('CSS.enable');
    const doc = await dbg.sendCommand('DOM.getDocument');
    const found = await dbg.sendCommand('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.usage-window' });
    await dbg.sendCommand('CSS.forcePseudoState', { nodeId: found.nodeId, forcedPseudoClasses: ['hover'] });
    for (let i = 0; i < 10; i += 1) {
      await delay(150);
      cardHover = await run('Array.prototype.map.call(document.querySelectorAll(".usage-window-breakdown"), function(e){ return getComputedStyle(e).opacity; })');
      if (cardHover && cardHover[0] === '1' && cardHover[1] === '0' && cardHover[2] === '0') break;
    }
    await dbg.sendCommand('CSS.forcePseudoState', { nodeId: found.nodeId, forcedPseudoClasses: [] });
  } catch (e) {
    console.log('WARN 卡片悬停强制通道不可用: ' + (e && e.message));
  }
  check('鼠标悬停在第一条进度条上:该行 命中/输入/输出 浮现,其余行保持隐藏',
    !!cardHover && cardHover[0] === '1' && cardHover[1] === '0' && cardHover[2] === '0', JSON.stringify(cardHover));

  /* 金额钉在条的右下角:与条的右端对齐,且位于条下方。
     注意比的是 .usage-window-bar 的右边缘(内容盒),不是整行的 border-box ——
     行本身有 1px border + 8px padding,拿整行右边缘比会差 9px。 */
  const costGeom = await run('(function(){'
    + 'var row = document.querySelector(".usage-window");'
    + 'var bar = row.querySelector(".usage-window-bar");'
    + 'var cost = row.querySelector(".usage-window-cost");'
    + 'if (!cost) return null;'
    + 'var r = cost.getBoundingClientRect(), b = bar.getBoundingClientRect();'
    + 'return { cost: cost.textContent.trim(), costRight: Math.round(r.right), barRight: Math.round(b.right), costTop: Math.round(r.top), barBottom: Math.round(b.bottom) };'
    + '})()');
  check('金额显示在进度条的右下角(右端对齐、位于条下方)',
    !!costGeom && Math.abs(costGeom.costRight - costGeom.barRight) <= 2 && costGeom.costTop >= costGeom.barBottom - 2,
    JSON.stringify(costGeom));

  // 没有分母的平台(既无额度接口也没预算):**仍画对比条** —— 绿色长度 = 本窗口 token
  // 占三个窗口最大值的比例,让"实际用了多少 token"一眼可见(用户明确要求);
  // 但**绝不显示任何百分比数字**(红线第 9 条),也不挂「无分母」徽章。
  const pickedDeepseek = await selectPlatform('DeepSeek');
  const noDenominatorShown = await waitFor('document.querySelectorAll(".usage-window").length === 3', 4000);
  // 等"确实已经是 DeepSeek 的无分母数据"再读数:只等 3 条会读到上一个平台的残影
  // (opencode 有预算 ⇒ 徽章数 3;DeepSeek 无分母 ⇒ 0),这条时序断言曾时红时绿。
  const noDenominatorReady = await waitFor('(function(){'
    + 'var sel = document.querySelector(".usage-summary .themed-select-label");'
    + 'return !!sel && sel.textContent.trim() === "DeepSeek"'
    + '  && document.querySelectorAll(".usage-window").length === 3'
    + '  && document.querySelectorAll(".usage-window-badge").length === 0; })()', 6000);
  check('切到无分母平台(DeepSeek)后数据已就位:三条在、零徽章', pickedDeepseek && noDenominatorReady === true,
    'picked=' + pickedDeepseek + ' ready=' + noDenominatorReady);
  // 条宽有 300ms 过渡:等它稳定再读,否则量到中间值(AGENTS.md 第 4 条)
  await delay(700);
  const nb = await run(WINDOW_SNAP);
  const nbRect = await windowListRect();
  check('没分母时仍画对比条(三条都在,不是空轨道也不是不画)',
    noDenominatorShown && nb.bars === 3, 'bars=' + nb.bars);
  check('没分母时不给任何百分比徽章(屏幕上不出现"分母/预算"这类字样)',
    nb.badges === 0 && nb.rows.every((r) => r.badge === null), JSON.stringify(nb.rows.map((r) => r.badge)));
  // 桩的 deepseek 三窗口:96万 / 364万 / 580万 ⇒ 对比基准 = 580万(本月满格)
  check('对比条长度 = 本窗口 token / 三个窗口最大值(日 ≈16.5% / 周 ≈62.8% / 月 =100%)',
    Math.abs(nb.rows[0].fillRatio - 960000 / 5800000) < 0.02
      && Math.abs(nb.rows[1].fillRatio - 3640000 / 5800000) < 0.02
      && Math.abs(nb.rows[2].fillRatio - 1) < 0.01,
    '平台=' + nb.selected + ' badges=' + JSON.stringify(nb.rows.map((r) => r.badge))
      + ' ' + JSON.stringify(nb.rows.map((r) => r.fillRatio)));
  check('没分母时命�/输入/输出明细照常标注',
    await run('(function(){ var rows = document.querySelectorAll(".usage-window-breakdown");'
      + 'if (rows.length !== 3) return false;'
      + 'for (var i = 0; i < rows.length; i++) { var t = rows[i].textContent;'
      + '  if (t.indexOf("命中") < 0 || t.indexOf("输入") < 0 || t.indexOf("输出") < 0) return false; }'
      + 'return true; })()'), '3 行明细都在(分母缺失不影响三桶统计)');
  check('没分母时不挂任何常驻提示横幅',
    nb.hint === null, 'hint=' + String(nb.hint));
  check('没分母时用量与金额照常显示(币种为 ¥)', nb.rows.length === 3 && nb.rows.every((r) => /Token/.test(r.figures) && /¥/.test(r.figures)), JSON.stringify(nb.rows.map((r) => r.figures)));
  check('三行的重置倒计时都在', nb.rows.every((r) => /后重置$/.test(r.reset)), JSON.stringify(nb.rows.map((r) => r.reset)));
  await delay(900);
  const nbShot = await shot('electron-window-nobudget.png');

  /* 用户诉求:所有平台都是同一套卡片 —— 逐个平台切过去,结构必须完全一致 */
  const uniform = [];
  for (let i = 0; i < ALL_PLATFORMS.length; i += 1) {
    const label = ALL_PLATFORMS[i][0];
    const id = ALL_PLATFORMS[i][1];
    const ok = await selectPlatform(label);
    await waitFor('document.querySelectorAll(".usage-window").length === 3', 4000);
    const snap = await run('(function(){'
      + 'var sel = document.querySelector(".usage-summary .themed-select-label");'
      + 'var rows = Array.prototype.map.call(document.querySelectorAll(".usage-window"), function(el){'
      + '  return { label: el.querySelector(".usage-window-label").textContent.trim(),'
      + '    reset: el.querySelector(".usage-window-reset").textContent.trim(),'
      + '    figures: el.querySelector(".usage-window-figures").textContent.trim(),'
      + '    hasBadge: !!el.querySelector(".usage-window-badge") };'
      + '});'
      + 'return { picked: sel ? sel.textContent.trim() : null, table: !!document.querySelector(".usage-summary-table"), rows: rows };'
      + '})()');
    uniform.push({
      label: label,
      id: id,
      picked: ok && snap.picked === label,
      threeRows: same(snap.rows.map((r) => r.label), ['今日', '本周', '本月']),
      noTable: snap.table === false,
      resets: snap.rows.every((r) => /后重置$/.test(r.reset)),
      figures: snap.rows.every((r) => /Token/.test(r.figures))
    });
    // 无数据平台(后端给三行 0)也要有留证截图:证明"所有平台都是这套卡"不是只对有数据的成立
    if (id === 'kimi') {
      await delay(900);
      await shot('electron-window-empty-platform.png');
    }
  }
  const bad = uniform.filter((u) => !(u.picked && u.threeRows && u.noTable && u.resets && u.figures));
  console.log('UNIFORM ' + JSON.stringify(uniform));
  check('6 个平台逐个切过去都是同一套卡片(今日/本周/本月 + 倒计时 + token/金额)',
    bad.length === 0, JSON.stringify(bad));
  check('没数据的平台也照样给三行(不是空白/不是空数组)',
    uniform.every((u) => u.threeRows && u.figures), JSON.stringify(uniform.filter((u) => !u.threeRows)));

  /* ===== 金额:0 也要显示;没有真实账单时用订阅摊薄估算并标 ≈ ===== */
  await run('window.__setEstCost("codex", 0)');
  await selectPlatform('Codex');
  await waitFor('document.querySelectorAll(".usage-window-cost").length === 3', 4000);
  const zeroCost = await run('Array.prototype.map.call(document.querySelectorAll(".usage-window-cost"), function(e){ return e.textContent.trim(); })');
  check('没有真实账单的平台也显示金额($0.00),不把 0 藏起来',
    same(zeroCost, ['$0.00', '$0.00', '$0.00']), JSON.stringify(zeroCost));
  // 打开订阅摊薄估算:codex 没有真实账单,金额只能来自「设置 → 金额」的月费摊薄
  await run('window.__setEstCost("codex", 12.5)');
  const estShown = await waitFor('(function(){ var e = document.querySelector(".usage-window-cost"); return !!e && e.textContent.indexOf("≈") === 0; })()', 4000);
  const estCost = await run('Array.prototype.map.call(document.querySelectorAll(".usage-window-cost"), function(e){ return { text: e.textContent.trim(), estimated: e.className.indexOf("estimated") >= 0, title: e.title }; })');
  check('没有真实账单但有订阅摊薄估算:显示 ≈ 前缀 + estimated 标记 + 说明这不是平台账单',
    estShown && estCost.length === 3
      && estCost.every((c) => /^≈\$12\.50$/.test(c.text) && c.estimated && /估算/.test(c.title)),
    JSON.stringify(estCost));
  await delay(600);
  await shot('electron-window-estimated-cost.png');
  await run('window.__setEstCost("codex", 0)');

  /* ===== 保留窗口口径披露(单平台窗口卡)=====
     同一个缺陷在窗口卡上的形态:opencode「本月」显示的是一个残缺值。
     这里选 DeepSeek 取证:它同时带"未设预算"提示,能验证两块提示并存互不吞掉。 */
  await selectPlatform('DeepSeek');
  await waitFor('document.querySelectorAll(".usage-window").length === 3', 4000);
  await run('window.__setRetention(7)');
  const cardRetOn = await waitFor('!!document.querySelector(".usage-window-partial")', 4000);
  const cardRetSnap = await run('(function(){'
    + 'var el = document.querySelector(".usage-window-partial");'
    + 'var banner = document.querySelector(".usage-window-hint");'
    + 'return { text: el ? el.textContent.trim() : null, title: el ? el.title : null,'
    + '  banner: banner ? banner.textContent.trim() : null,'
    + '  rows: document.querySelectorAll(".usage-window").length };'
    + '})()');
  check('窗口卡:保留 7 天时在受影响那一行上标出「仅近 7 天」(行内角标,不是整条横幅)',
    cardRetOn && cardRetSnap.text === '仅近 7 天' && /历史只保留 7 天/.test(String(cardRetSnap.title)),
    JSON.stringify(cardRetSnap));
  check('口径披露不再单开横幅(其余常驻提示也已按用户要求撤掉)',
    cardRetSnap.banner === null && cardRetSnap.rows === 3, JSON.stringify(cardRetSnap));
  await delay(900);
  await shot('electron-retention-window-7d.png');
  await run('window.__setRetention(90)');
  const cardRetOff = await waitFor('!document.querySelector(".usage-window-partial")', 4000);
  check('窗口卡:保留 90 天时不再标残缺(不误报、不制造噪音)', cardRetOff === true);

  // 切回「全部」:回到跨平台总览(不留在单平台视图)
  const backToAll = await selectPlatform('全部');
  const overviewBack = await waitFor('!!document.querySelector(".provider-overview")', 6000);
  check('切回「全部」回到跨平台总览(单平台三行让位)',
    backToAll === true && overviewBack === true
      && (await run('document.querySelectorAll(".usage-window").length')) === 0,
    'backToAll=' + backToAll + ' overview=' + overviewBack);

  /* ===== 卡片内凭证态:缺什么就地补什么(不再用全局登录墙挡路) ===== */
  const CRED_SNAP = '(function(){'
    + 'var box = document.querySelector(".usage-cred");'
    + 'var input = document.querySelector(".usage-cred-input");'
    + 'var btn = box ? box.querySelector(".usage-cred-btn") : null;'
    + 'var sel = document.querySelector(".usage-summary .themed-select-label");'
    + 'return { notice: box ? box.textContent.trim() : null, hasInput: !!input,'
    + '  inputType: input ? input.type : null,'
    + '  btn: btn ? btn.textContent.trim() : null,'
    + '  rows: document.querySelectorAll(".usage-window").length,'
    + '  rowLabels: Array.prototype.map.call(document.querySelectorAll(".usage-window-label"), function(el){ return el.textContent.trim(); }),'
    + '  selected: sel ? sel.textContent.trim() : null };'
    + '})()';
  const sentChannels = () => run('window.__calls.filter(function(c){ return !!c.sent; }).map(function(c){ return c.channel; })');

  // 场景 1:选中未配 Key 的 DeepSeek → 内联输入区出现,本机口径三行仍在
  await run('window.__setCred({ apiKeySet: false, loggedIn: false })');
  const pickDs = await selectPlatform('DeepSeek');
  await waitFor('!!document.querySelector(".usage-cred-input")', 3000);
  const c1 = await run(CRED_SNAP);
  check('未配 Key 的 DeepSeek:卡片内出现 API Key 内联输入区',
    pickDs && c1.selected === 'DeepSeek' && c1.hasInput === true && c1.inputType === 'password', JSON.stringify(c1));
  check('未配 Key 的 DeepSeek:本机口径今日/本周/本月三行照旧在',
    same(c1.rowLabels, ['今日', '本周', '本月']) && c1.rows === 3, JSON.stringify(c1.rowLabels));
  check('未配 Key 的 DeepSeek:文案明说缺什么(API Key)且交代影响范围',
    /API Key/.test(c1.notice || '') && /本机日志/.test(c1.notice || ''), String(c1.notice));
  check('未配 Key 的 DeepSeek:给的是「保存并验证」入口', c1.btn === '保存并验证', String(c1.btn));
  await delay(700);
  await shot('electron-cred-deepseek-nokey.png');

  /* ---- 内联补录:空/明显非法不发请求 → 校验失败不落盘 → 成功才保存并刷新 ---- */
  const credErrorText = () => run('(function(){ var e = document.querySelector(".usage-cred-error"); return e ? e.textContent.trim() : null; })()');
  const keyCallCount = () => run('window.__calls.filter(function(c){ return c.channel === "settings:replace-api-key"; }).length');
  // 受控 input:必须走原生 value setter + input 事件,React 才认这是用户输入。
  // 元素不在时返回 null 而不是抛错:`setter.call(null, …)` 会抛 "Illegal invocation",
  // 一个异常会终结整个脚本、把后面所有断言的结果一起吞掉(AGENTS.md 第 7 条)。
  const setDraft = (value) => run('(function(){'
    + 'var el = document.querySelector(".usage-cred-input");'
    + 'if (!el) return null;'
    + 'var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;'
    + 'setter.call(el, ' + JSON.stringify(value) + ');'
    + 'el.dispatchEvent(new Event("input", { bubbles: true }));'
    + 'return el.value; })()');
  const clickSave = () => run('(function(){ var el = document.querySelector(".usage-cred-btn"); if (!el) return false; el.click(); return true; })()');
  const CRED_AFTER = '(function(){'
    + 'var box = document.querySelector(".usage-cred");'
    + 'var input = document.querySelector(".usage-cred-input");'
    + 'var btn = box ? box.querySelector(".usage-cred-btn") : null;'
    + 'var err = document.querySelector(".usage-cred-error");'
    + 'return { notice: box ? box.textContent.trim() : null,'
    + '  hasInput: !!input, draft: input ? input.value : null,'
    + '  btn: btn ? btn.textContent.trim() : null, btnDisabled: btn ? btn.disabled : null,'
    + '  error: err ? err.textContent.trim() : null,'
    + '  rows: document.querySelectorAll(".usage-window").length };'
    + '})()';

  // 空输入:点按钮不应产生任何校验请求。
  // 断言按"错误文案真的出现"来等(AGENTS.md 第 4 条),而不是固定 delay 后读一次。
  await run('window.__setKeyMode("ok")');
  await selectPlatform('DeepSeek');
  await waitFor('!!document.querySelector(".usage-cred-input")', 3000);
  const keyCallsBefore = await keyCallCount();
  const emptyClicked = await clickSave();
  const emptyErrorShown = await waitFor('(function(){'
    + 'var e = document.querySelector(".usage-cred-error");'
    + 'return !!e && /请先填入/.test(e.textContent); })()', 3000);
  const emptySnap = await run(CRED_AFTER);
  check('空输入:不发校验请求,就地给提示',
    emptyClicked === true && (await keyCallCount()) === keyCallsBefore && emptyErrorShown,
    'clicked=' + emptyClicked + ' calls=' + (await keyCallCount()) + ' err=' + emptySnap.error
      + ' hasInput=' + emptySnap.hasInput + ' notice=' + JSON.stringify(emptySnap.notice));

  // 明显非法(不成形):同样不发请求
  const badDraft = await setDraft('abc');
  await clickSave();
  const badErrorShown = await waitFor('(function(){'
    + 'var e = document.querySelector(".usage-cred-error");'
    + 'return !!e && /格式不像/.test(e.textContent); })()', 3000);
  const badSnap = await run(CRED_AFTER);
  check('明显非法输入:不发校验请求,提示格式问题',
    badDraft === 'abc' && (await keyCallCount()) === keyCallsBefore && badErrorShown,
    'draft=' + badDraft + ' calls=' + (await keyCallCount()) + ' err=' + badSnap.error);

  // 形状合法但服务端拒绝:真的发了请求、显示错误、store 不动
  await run('window.__setKeyMode("invalid")');
  await setDraft('sk-00000000000000000000000000000000');
  await clickSave();
  await waitFor('!!document.querySelector(".usage-cred-error")', 4000);
  const failSnap = await run(CRED_AFTER);
  const stillUnset = await run('window.api.invoke("get:settings").then(function(s){ return s.providers.deepseek.apiKeySet; })');
  check('校验失败:通道确实被调用了一次(带键入值)',
    (await keyCallCount()) === keyCallsBefore + 1
      && (await run('window.__keySubmitted[window.__keySubmitted.length - 1]')) === 'sk-00000000000000000000000000000000',
    'calls=' + (await keyCallCount()));
  check('校验失败:显示错误文案且仍停在"未配置"输入态',
    /校验失败/.test(failSnap.error || '') && failSnap.hasInput === true && failSnap.btn === '保存并验证' && failSnap.btnDisabled === false,
    JSON.stringify(failSnap));
  check('校验失败:apiKeySet 仍为 false(没有写入 store)', stillUnset === false, String(stillUnset));
  await delay(600);
  await shot('electron-cred-key-invalid.png');

  // 校验成功:落盘 + 卡片改口 + 重新拉取设置(刷新)
  await run('window.__setKeyMode("ok")');
  const callsBeforeOk = await run('window.__calls.length');
  await clickSave();
  await waitFor('!document.querySelector(".usage-cred-input")', 4000);
  const okSnap = await run(CRED_AFTER);
  const refetched = await run('window.__calls.slice(' + callsBeforeOk + ').filter(function(c){ return c.channel === "get:settings"; }).length');
  check('校验成功:卡片改口(输入收起 → 转「登录平台」)且重拉设置刷新',
    okSnap.hasInput === false && okSnap.btn === '登录平台' && refetched >= 1 && okSnap.rows === 3,
    JSON.stringify(okSnap) + ' refetched=' + refetched);
  const inputsCleared = await run('document.querySelector(".usage-cred-input") === null');
  check('校验成功后输入框里的草稿被清空(不留明文)', inputsCleared === true, String(inputsCleared));
  // 注:这里以前还断言"配好 Key 后 DeepSeek 进入标题栏标签栏"。标题栏的切换控件已按用户要求
  // 整体删除(见 test/provider-groups.test.js 的源码守卫),白名单逻辑不再有 UI 载体;
  // "配好 Key 之后卡片改口"由上面那条 `okSnap.btn === '登录平台'` 覆盖。
  await delay(600);
  await shot('electron-cred-key-saved.png');

  // 场景 2:有 Key、未登录平台 → 输入框收起,改给「登录平台」;点击真的发出 session:relogin
  await run('window.__setCred({ apiKeySet: true, loggedIn: false })');
  await waitFor('!!document.querySelector(".usage-cred-btn")', 3000);
  const c2 = await run(CRED_SNAP);
  check('有 Key 未登平台:输入框收起、按钮变「登录平台」',
    c2.hasInput === false && c2.btn === '登录平台', JSON.stringify(c2));
  check('有 Key 未登平台:文案区分「余额可读」与「官方用量需登录」',
    /余额/.test(c2.notice || '') && /官方用量/.test(c2.notice || ''), String(c2.notice));
  const beforeRelogin = (await sentChannels()).length;
  await run('(function(){ var el = document.querySelector(".usage-cred-btn"); if (!el) return false; el.click(); return true; })()');
  const afterRelogin = await sentChannels();
  check('点「登录平台」真的走 session:relogin 按需通道',
    afterRelogin.slice(beforeRelogin).indexOf('session:relogin') >= 0, JSON.stringify(afterRelogin));

  // 场景 3:Key 与平台登录都齐 → 不再打扰(三行照常)
  await run('window.__setCred({ apiKeySet: true, loggedIn: true })');
  await waitFor('!document.querySelector(".usage-cred")', 3000);
  const c3 = await run(CRED_SNAP);
  check('Key 与平台登录都齐:零凭证提示,三行照常',
    c3.notice === null && c3.rows === 3, JSON.stringify(c3));

  // 场景 4:无需凭证的平台 → 零提示、三行照常(别的平台凭证全缺也不受牵连)
  // (这里以前还断言"codex/kimi 凭证失效会从标题栏标签栏消失"。标题栏切换控件已删除,
  //  证据改由下一步的"卡片内凭证提示随广播消失/恢复"覆盖。)
  await run('window.__setCred({ codexStatus: "expired", kimiStatus: "missing" })');
  const credClean = [];
  for (const label of ['opencode', 'DSH', 'Claude Code']) {
    const picked = await selectPlatform(label);
    await waitFor('document.querySelectorAll(".usage-window").length === 3', 4000);
    const snap = await run(CRED_SNAP);
    credClean.push({ label: label, picked: !!(picked && snap.selected === label), notice: snap.notice, rows: snap.rows });
  }
  console.log('CRED-CLEAN ' + JSON.stringify(credClean));
  check('无需凭证的平台(opencode / DSH / Claude Code):零凭证提示且三行照常',
    credClean.every((c) => c.picked && c.notice === null && c.rows === 3), JSON.stringify(credClean));

  // 场景 5:本机 CLI 凭证缺失/过期(codex/kimi)→ 原因 + 「立即重试」真的发 refresh:dashboard
  const credLocal = [];
  for (const item of [
    { label: 'Codex', keyword: 'codex CLI', shot: 'electron-cred-codex-expired.png' },
    { label: 'Kimi', keyword: 'Kimi CLI', shot: 'electron-cred-kimi-missing.png' }
  ]) {
    const picked = await selectPlatform(item.label);
    await waitFor('!!document.querySelector(".usage-cred")', 3000);
    const snap = await run(CRED_SNAP);
    const beforeRetry = (await sentChannels()).length;
    await run('(function(){ var el = document.querySelector(".usage-cred-btn"); if (!el) return false; el.click(); return true; })()');
    const afterRetry = await sentChannels();
    credLocal.push({
      label: item.label, picked: !!(picked && snap.selected === item.label),
      btn: snap.btn, hasInput: snap.hasInput,
      hintOk: new RegExp(item.keyword).test(snap.notice || ''),
      retried: afterRetry.slice(beforeRetry).indexOf('refresh:dashboard') >= 0
    });
    // 每个平台各留一张真图(文件名必须与图里选中的平台一致)
    await delay(700);
    await shot(item.shot);
  }
  console.log('CRED-LOCAL ' + JSON.stringify(credLocal));
  check('codex/kimi 缺本机凭证:给出缺失原因 + 「立即重试」入口(不是内联输 Key)',
    credLocal.every((c) => c.picked && c.hasInput === false && c.btn === '立即重试' && c.hintOk), JSON.stringify(credLocal));
  check('点「立即重试」真的走 refresh:dashboard',
    credLocal.every((c) => c.retried), JSON.stringify(credLocal));

  // 凭证态刷新路径:平台状态广播后无须重挂卡片就能改口(当前选中 Kimi,故两个都清)
  await run('window.__setCred({ codexStatus: "ok", kimiStatus: "ok" })');
  const credCleared = await waitFor('!document.querySelector(".usage-cred")', 3000);
  check('平台状态广播后凭证提示随之消失(订阅刷新,不是一次性快照)',
    credCleared && (await run('document.querySelectorAll(".usage-window").length')) === 3,
    'cleared=' + credCleared);

  // 暗色主题:走真实 settings:loaded 广播路径
  await run('window.__pushSettings(' + JSON.stringify(settingsFor('dark')) + ')');
  await waitFor('document.documentElement.dataset.theme === "dark"', 4000);
  const theme = await run('document.documentElement.dataset.theme + "/" + document.documentElement.classList.contains("dark")');
  check('暗色主题经 settings:loaded 生效', theme === 'dark/true', String(theme));
  await delay(900);
  await shot('electron-week-dark.png');

  // 暗色主题下的单平台窗口卡(圆角块 / 徽章 / 进度条在暗底上的对比度)
  const darkPick = await selectPlatform('opencode');
  const darkWindows = await waitFor('document.querySelectorAll(".usage-window").length === 3', 4000);
  check('暗色主题下窗口卡照常渲染', darkPick && darkWindows, 'picked=' + darkPick + ' rows=' + (await run('document.querySelectorAll(".usage-window").length')));
  await delay(900);
  const darkRect = await windowListRect();
  await shot('electron-window-dark.png');

  // 像素级复核(对已落盘证据,而非内存对象)
  const lightFile = path.join(OUT_DIR, 'electron-day-light.png');
  const estFile = path.join(OUT_DIR, 'electron-day-estimate.png');
  const darkFile = path.join(OUT_DIR, 'electron-week-dark.png');
  checkPixels('浅色截图确实是浅底(亮像素占多数)', lightFile,
    (m) => m.lightRatio > 0.8 && m.darkRatio < 0.05);
  checkPixels('浅色截图表格区域确有墨迹(非空白帧)', lightFile,
    (m) => m.bandInkRatio > 0.001);
  checkPixels('三张截图的平台色点都真实渲染出来了', lightFile,
    (m) => Object.keys(m.hits).filter((k) => m.hits[k] > 20).length >= 2);
  checkPixels('深色截图确实是深底(暗像素占多数)', darkFile,
    (m) => m.darkRatio > 0.5 && m.lightRatio < 0.3);
  checkPixels('深色截图表格区域确有亮色文字(暗底白字)', darkFile,
    (m) => m.bandBrightRatio > 0.001);
  checkPixels('估算开启帧与估算关闭帧不是同一张图', estFile,
    (m) => Math.abs(m.meanLuma - analyzePixels(lightFile).meanLuma) > 0.001 || m.bandInkRatio !== analyzePixels(lightFile).bandInkRatio);

  // 窗口卡三张图:在**卡片矩形内**数绿/红像素(整图里还有状态栏等别人的绿点,不能算数)
  const opencodeFile = path.join(OUT_DIR, 'electron-window-opencode.png');
  const noBudgetFile = path.join(OUT_DIR, 'electron-window-nobudget.png');
  const windowDarkFile = path.join(OUT_DIR, 'electron-window-dark.png');
  checkPixels('窗口卡截图(有预算)确有墨迹,不是空白帧', opencodeFile,
    (m) => m.lightRatio > 0.8 && m.bandInkRatio > 0.001);
  const cardGreen = countColorInRect(opencodeFile, opencodeRect, SUCCESS, 120);
  const cardRed = countColorInRect(opencodeFile, opencodeRect, ERROR_RED, 120);
  console.log('CARD-INK 卡片矩形=' + JSON.stringify(cardGreen.rect)
    + ' 绿像素=' + cardGreen.hits + '(单行最多 ' + cardGreen.maxRowHits + ')'
    + ' 红像素=' + cardRed.hits + '(单行最多 ' + cardRed.maxRowHits + ')');
  check('绿色进度条与绿色徽章真的渲染出来了(卡片内成片绿像素)', cardGreen.hits > 100 && cardGreen.maxRowHits > 200,
    '绿=' + cardGreen.hits + ' 单行最多=' + cardGreen.maxRowHits);
  check('超预算那行真的标红(卡片内成片红像素,不是文字彩边)', cardRed.hits > 1000 && cardRed.maxRowHits > 200,
    '红=' + cardRed.hits + ' 单行最多=' + cardRed.maxRowHits);
  const nbGreen = countColorInRect(noBudgetFile, nbRect, SUCCESS, 120);
  const nbRed = countColorInRect(noBudgetFile, nbRect, ERROR_RED, 120);
  console.log('CARD-INK 无预算卡片矩形=' + JSON.stringify(nbGreen.rect)
    + ' 绿像素=' + nbGreen.hits + '(单行最多 ' + nbGreen.maxRowHits + ')'
    + ' 红像素=' + nbRed.hits + '(单行最多 ' + nbRed.maxRowHits + ') —— 红像素已查证为字形边缘彩边,非红色图元');
  // 没分母 ⇒ 条照画(绿 = 本窗口 token ÷ 三个窗口最大值的占比,用户明确要求"绿色代表实际用了多少 token"),
  // 所以这里**不该**再断言"零绿像素" —— 那是"没分母就不画条"的旧口径,已被推翻。
  // "不编百分比"由 DOM 断言钉住:nb.badges === 0 且每行 badge 为 null(见上方「没分母时不给任何百分比徽章」)。
  check('没设预算那张:对比条照画(成片绿色),只是不编百分比',
    nbGreen.hits > 100 && nbGreen.maxRowHits > 100, '绿=' + nbGreen.hits + ' 单行最多=' + nbGreen.maxRowHits);
  check('没设预算那张:也没有任何成片红色元素(无告警条)', nbRed.maxRowHits < 100,
    '红单行最多=' + nbRed.maxRowHits);
  checkPixels('暗色窗口卡:深底且文字可见', windowDarkFile,
    (m) => m.darkRatio > 0.5 && m.lightRatio < 0.3 && m.bandBrightRatio > 0.001);
  const darkGreen = countColorInRect(windowDarkFile, darkRect, SUCCESS, 120);
  console.log('CARD-INK 暗色卡片矩形=' + JSON.stringify(darkGreen.rect) + ' 绿像素=' + darkGreen.hits);
  check('暗色窗口卡的绿条也画出来了', darkGreen.hits > 100, String(darkGreen.hits));

  /* ===== 热力图:三个模式 + 年份切换 + 悬停浮层(带当天金额)=====
     热力图以前是"桩返回空数据 + 0 条断言",等于没被测过。现在桩给了 2026-07~09 的逐日数据。 */
  const heatScope = '.heatmap-widget';
  await selectPlatform('opencode');
  await waitFor('!!document.querySelector(".heatmap-widget")', 4000);

  const heatModes = await run('Array.prototype.map.call(document.querySelectorAll("' + heatScope + ' .heatmap-modes .heatmap-tab"), function(b){ return b.textContent.trim(); })');
  check('热力图有三个模式页签:每日 / 每周 / 累计',
    same(heatModes, ['每日', '每周', '累计']), JSON.stringify(heatModes));

  const heatYear = await run('(function(){'
    + 'var label = document.querySelector("' + heatScope + ' .heatmap-year-label");'
    + 'var btns = document.querySelectorAll("' + heatScope + ' .heatmap-year-btn");'
    + 'return { year: label ? label.textContent.trim() : null,'
    + '  prevDisabled: btns[0] ? btns[0].disabled : null, nextDisabled: btns[1] ? btns[1].disabled : null };'
    + '})()');
  check('热力图有年份切换,且不能翻到未来',
    /^\d{4}$/.test(String(heatYear.year)) && heatYear.prevDisabled === false && heatYear.nextDisabled === true,
    JSON.stringify(heatYear));

  // 三种模式共用同一张年网格:切过去格子还在(不是空白),且"共 N Token"跟着口径变
  const modeSwitch = [];
  for (const label of ['每周', '累计', '每日']) {
    await run('(function(){'
      + 'var tabs = document.querySelectorAll("' + heatScope + ' .heatmap-modes .heatmap-tab");'
      + 'for (var i = 0; i < tabs.length; i++) { if (tabs[i].textContent.trim() === ' + JSON.stringify(label) + ') { tabs[i].click(); return true; } }'
      + 'return false; })()');
    await delay(300);
    const snap = await run('(function(){'
      + 'return { label: (document.querySelector("' + heatScope + ' .heatmap-tab.active") || {}).textContent,'
      + '  grid: !!document.querySelector("' + heatScope + ' .heatmap-grid-daily"),'
      + '  cells: document.querySelectorAll("' + heatScope + ' .heatmap-cell").length,'
      + '  total: (document.querySelector("' + heatScope + ' .heatmap-total") || {}).textContent };'
      + '})()');
    modeSwitch.push(Object.assign({ expect: label }, snap));
  }
  check('三个模式共用同一张年网格(切过去格子还在、都有总量)',
    modeSwitch.every((m) => m.grid && m.cells > 100 && /[0-9]/.test(String(m.total))),
    JSON.stringify(modeSwitch.map((m) => m.label + ':' + m.total)));
  check('点了哪个模式哪个模式就高亮(页签切换真的生效)',
    modeSwitch.every((m) => m.label === m.expect), JSON.stringify(modeSwitch.map((m) => m.label)));
  // 注意别断言"三个模式的总量各不相同":整年都在可视范围内时,「累计到年末」本来就等于「全年之和」,
  // 数字相同是**对的** —— 这种断言只会制造假失败(实测踩过)。

  // 悬停前先把热力图滚进视野:单平台视图内容可以滚动(修复"卡片被压扁裁掉"之后),
  // 不滚过去 getBoundingClientRect 给的坐标在窗口外,sendInputEvent 打不到任何东西。
  await run('(function(){ var el = document.querySelector("' + heatScope + '"); if (!el) return false; el.scrollIntoView({ block: "center" }); return true; })()');
  await delay(400);
  // 悬停:网格格子要出浮层,且带当天金额(不是只有 token)。
  // 从**离今天最近**的格子开始扫(不是文档顺序):一年里大片日期没有数据,按文档顺序扫会
  // 一头扎进"空月份"里,每次都只拿到"无消耗"(实测踩过:倒着扫 24 格全在 12 月)。
  const cellRects = await run('(function(){'
    + 'var pad = function(n){ return n < 10 ? "0" + n : String(n); };'
    + 'var bj = new Date(Date.now() + 8 * 3600000);'
    + 'var todayKey = bj.getUTCFullYear() + "-" + pad(bj.getUTCMonth() + 1) + "-" + pad(bj.getUTCDate());'
    + 'var ms = function(key){ return Date.parse(key + "T00:00:00Z"); };'
    + 'var t = ms(todayKey);'
    + 'return Array.prototype.map.call(document.querySelectorAll("' + heatScope + ' .heatmap-cell[data-date]"), function(el){'
    + '  var key = el.getAttribute("data-date");'
    + '  var r = el.getBoundingClientRect();'
    + '  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),'
    + '    date: key, dist: Math.abs(ms(key) - t) };'
    + '}).sort(function(a, b){ return a.dist - b.dist; }); })()');
  const ordered = cellRects;
  let heatTipText = null;
  let heatTipDate = null;
  let lastTipSeen = null;
  for (let i = 0; i < ordered.length && i < 12; i += 1) {
    const c = ordered[i];
    if (!c.x && !c.y) continue;
    win.webContents.sendInputEvent({ type: 'mouseMove', x: c.x, y: c.y });
    await delay(360);
    const txt = await run('(function(){ var e = document.querySelector(".heatmap-tooltip"); return e ? e.textContent.trim() : null; })()');
    if (txt) lastTipSeen = txt;
    if (txt && /[¥$]/.test(txt)) { heatTipText = txt; heatTipDate = c.date; break; }
  }
  check('热力图格子悬停出浮层,且带当天金额(不是只有 token)',
    !!heatTipText && /Token/.test(heatTipText) && /[¥$]/.test(heatTipText),
    '格子数=' + cellRects.length + ' 最近3格=' + JSON.stringify(ordered.slice(0, 3).map((c) => c.date))
      + ' 悬停格=' + heatTipDate + ' 末次浮层=' + String(lastTipSeen));
  await shot('electron-heatmap-hover.png');

  // 切模式时浮层必须收掉:旧格子被卸载后 onMouseLeave 不会再触发,不主动收就会留一个
  // "贴在屏幕上的幽灵提示"(视觉复核时抓到过,不是靠断言发现的)
  await run('(function(){'
    + 'var tabs = document.querySelectorAll("' + heatScope + ' .heatmap-modes .heatmap-tab");'
    + 'for (var i = 0; i < tabs.length; i++) { if (tabs[i].textContent.trim() === "累计") { tabs[i].click(); return true; } }'
    + 'return false; })()');
  const ghostGone = await waitFor('!document.querySelector(".heatmap-tooltip")', 3000);
  check('切换模式后浮层立刻收掉(不留幽灵提示)', ghostGone === true);
  await run('(function(){'
    + 'var tabs = document.querySelectorAll("' + heatScope + ' .heatmap-modes .heatmap-tab");'
    + 'for (var i = 0; i < tabs.length; i++) { if (tabs[i].textContent.trim() === "每日") { tabs[i].click(); return true; } }'
    + 'return false; })()');
  await delay(250);

  /* Token 预算当分母:条上主数字必须变成 token 数,百分比退成次要 */
  await run('window.__setTokenBudget("opencode", true)');
  const headSwitched = await waitFor('(function(){'
    + 'var b = document.querySelector(".usage-window-badge"); return !!b && b.className.indexOf("tokens") >= 0; })()', 4000);
  const headSnap = await run('(function(){'
    + 'var row = document.querySelector(".usage-window");'
    + 'var badge = row.querySelector(".usage-window-badge");'
    + 'var sub = row.querySelector(".usage-window-percent-sub");'
    + 'return { badge: badge ? badge.textContent.trim() : null,'
    + '  sub: sub ? sub.textContent.trim() : null,'
    + '  badgeTitle: badge ? badge.title : null }; })()');
  check('分母是 Token 预算 ⇒ 条上主数字变成 token 数、百分比退成次要小字',
    headSwitched && /Token/.test(String(headSnap.badge)) && /%$/.test(String(headSnap.sub)),
    JSON.stringify(headSnap));
  check('Token 预算的分母来源在悬停说明里写清(不是含糊的"预算")',
    /Token 预算/.test(String(headSnap.badgeTitle)), String(headSnap.badgeTitle));
  await shot('electron-window-token-budget.png');
  await run('window.__setTokenBudget("opencode", false)');
  await waitFor('!document.querySelector(".usage-window-badge.tokens")', 4000);

  /* ===== 小窗口:当前平台的三条进度条 + 悬停出 命中/输入/输出 =====
     悬停必须用真实鼠标事件(sendInputEvent)驱动:CSS :hover 不响应 dispatchEvent 合成的
     mouseover,只有真实指针移动才会命中,所以这条断言能证明"鼠标停上去真的会亮"。 */
  await selectPlatform('opencode');
  await waitFor('document.querySelectorAll(".usage-window").length === 3', 4000);
  // 把窗口缩到**真实小窗尺寸**再切迷你视图:小窗(250×216)是核心使用场景,
  // 而 900px 的 viewport 里切视图根本测不出"内容放不下被切掉"(实测漏过这个缺陷)。
  // 必须用 setContentSize:真实小窗是无边框窗口(frame:false),内容区就等于 250×216;
  // 用 setSize 会被窗口边框吃掉 16×65,量出来的尺寸偏小、结论跟着错(踩过)。
  win.setContentSize(250, 216);
  await delay(400);
  await run('window.__setMini(true)');
  // 小窗视图是持久化的(用量进度条 / 占比圆环 / 额度圆环三选一):
  // 上一次可能停在别的视图 ⇒ 先点到「用量进度条」为止(≤3 次,与起始状态无关),再断言。
  let miniUp = false;
  for (let i = 0; i < 4 && !miniUp; i += 1) {
    miniUp = await waitFor('!!document.querySelector(".mini-usage")', 1200);
    if (miniUp) break;
    await run('(function(){ var el = document.querySelector(\'.mini-title-btn[aria-label^="切换到"]\'); if (!el) return false; el.click(); return true; })()');
    await delay(400);
  }
  // 小窗第一诉求:三条都要看得见。任何一条的底边超出窗口高度就是"看不全"。
  const miniFit = await run('(function(){'
    + 'var rows = document.querySelectorAll(".mini-usage-row");'
    + 'var usage = document.querySelector(".mini-usage");'
    + 'var out = Array.prototype.map.call(rows, function(el){'
    + '  var r = el.getBoundingClientRect();'
    + '  return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; });'
    + 'return { w: innerWidth, h: innerHeight,'
    + '  usageClientH: usage ? usage.clientHeight : null, usageScrollH: usage ? usage.scrollHeight : null,'
    + '  clipped: !!usage && usage.scrollHeight > usage.clientHeight + 1, rows: out };'
    + '})()');
  check('小窗(250×216)能完整看到三条:没有一条被窗口底部切掉、也不需要滚动',
    miniUp && miniFit.rows.length === 3
      && miniFit.rows.every((r) => r.bottom <= miniFit.h)
      && miniFit.clipped === false,
    JSON.stringify(miniFit));
  const miniSnap = await run('(function(){'
    + 'var txt = function(el){ return el ? el.textContent.trim() : null; };'
    + 'return { up: !!document.querySelector(".mini-view"),'
    + '  labels: Array.prototype.map.call(document.querySelectorAll(".mini-usage-label"), function(e){ return e.textContent.trim(); }),'
    + '  badges: Array.prototype.map.call(document.querySelectorAll(".mini-usage-badge"), function(e){ return e.textContent.trim(); }),'
    + '  details: Array.prototype.map.call(document.querySelectorAll(".mini-usage-detail"), function(e){ return e.textContent.trim(); }),'
    + '  opacities: Array.prototype.map.call(document.querySelectorAll(".mini-usage-detail"), function(e){ return getComputedStyle(e).opacity; }),'
    + '  bars: document.querySelectorAll(".mini-usage-bar").length,'
    + '  fills: Array.prototype.map.call(document.querySelectorAll(".mini-usage-fill"), function(e){ return e.getBoundingClientRect().width; }),'
    + '  tracks: Array.prototype.map.call(document.querySelectorAll(".mini-usage-bar"), function(e){ return e.getBoundingClientRect().width; }),'
    + '  provider: txt(document.querySelector(".mini-usage .themed-select-label")),'
    + '  card: !!document.querySelector(".usage-summary"), table: !!document.querySelector(".usage-summary-table") };'
    + '})()');
  check('小窗口只显示当前服务商的三条进度条(不带大卡/表格)',
    miniUp && miniSnap.up && same(miniSnap.labels, ['今日', '本周', '本月']) && miniSnap.bars === 3
      && miniSnap.card === false && miniSnap.table === false,
    JSON.stringify({ labels: miniSnap.labels, card: miniSnap.card, table: miniSnap.table }));
  check('小窗口显示当前服务商标识', miniSnap.provider === 'opencode', String(miniSnap.provider));
  check('小窗口百分比与大卡同源(25% / 30% / 170%)',
    same(miniSnap.badges, ['25%', '30%', '170%']), JSON.stringify(miniSnap.badges));
  check('小窗口进度条宽度与百分比一致(25% 行 ≈ 0.25)',
    miniSnap.tracks[0] > 0 && Math.abs(miniSnap.fills[0] / miniSnap.tracks[0] - 0.25) < 0.03,
    JSON.stringify({ fill: miniSnap.fills[0], track: miniSnap.tracks[0] }));
  check('小窗口三条明细都带 命中/输入/输出 文字',
    miniSnap.details.length === 3 && miniSnap.details.every((t) => /命中/.test(t) && /输入/.test(t) && /输出/.test(t)),
    JSON.stringify(miniSnap.details));
  // 先把指针停到无行区域(标题栏),等残留 :hover 退掉:
  // 前面的用例发过合成 mouseMove,真机上用户鼠标也可能停在窗口里,不 park 就直接读基线会误判。
  // 若真实光标正压在小窗某行上,park 在物理上不可能生效 ⇒ 记 SKIP(环境),
  // 但"没有 hover 却还亮着"必须失败 —— 那是真正的残留悬停缺陷。
  const miniPark = await readHoverAfterPark('.mini-usage-row', '.mini-usage-detail');
  if (miniPark.hovered > 0) {
    console.log('SKIP 指针 park 被真实光标挡住(鼠标正压在小窗行上),该读数仅供参考: '
      + JSON.stringify(miniPark.opacities));
  } else {
    check('指针 park 到无行区后残留悬停退掉(退不掉就是真 bug,不是时序)',
      miniPark.opacities.every((o) => o === '0'), JSON.stringify(miniPark.opacities));
  }
  await shot('electron-mini-usage.png');

  // 真实指针移到第一条进度条上
  const barRect = await run('(function(){ var r = document.querySelectorAll(".mini-usage-bar")[0].getBoundingClientRect();'
    + 'return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) }; })()');
  win.webContents.sendInputEvent({ type: 'mouseMove', x: barRect.x, y: barRect.y });
  // :hover 淡入淡出要走过渡,读一次可能撞见中间值(0.04/0.95 这种):
  // 轮询到稳态为止,终态必须是精确的 [1,0,0],一秒内 Settled 不了才算真失败
  let hovered = null;
  for (let i = 0; i < 10; i += 1) {
    await delay(200);
    hovered = await run('(function(){'
      + 'return Array.prototype.map.call(document.querySelectorAll(".mini-usage-detail"), function(e){ return getComputedStyle(e).opacity; }); })()');
    if (hovered && hovered[0] === '1' && hovered[1] === '0' && hovered[2] === '0') break;
  }
  // 合成 mouseMove 会被真实 OS 光标位置干扰(鼠标停在窗口别处时 Chromium 的 hover 命中不认合成点),
  // 实测同一条断言两次跑出两种结果。这里补一条确定性通道:CDP 强制 :hover 伪类
  // (DevTools 面板 :hov 的同款机制),直接把 :hover 命中钉死再读样式。
  // 两条路都记录是哪条产出的证据,不把 fallback 说成"真实指针过了"。
  let hoverRoute = '合成 mouseMove';
  if (!(hovered && hovered[0] === '1' && hovered[1] === '0' && hovered[2] === '0')) {
    hoverRoute = 'CDP 强制 :hover(合成指针被干扰)';
    try {
      const dbg = win.webContents.debugger;
      if (!dbg.isAttached()) dbg.attach('1.3');
      await dbg.sendCommand('DOM.enable');
      await dbg.sendCommand('CSS.enable');
      const doc = await dbg.sendCommand('DOM.getDocument');
      const found = await dbg.sendCommand('DOM.querySelector', { nodeId: doc.root.nodeId, selector: '.mini-usage-row' });
      await dbg.sendCommand('CSS.forcePseudoState', { nodeId: found.nodeId, forcedPseudoClasses: ['hover'] });
      for (let i = 0; i < 10; i += 1) {
        await delay(200);
        hovered = await run('(function(){'
          + 'return Array.prototype.map.call(document.querySelectorAll(".mini-usage-detail"), function(e){ return getComputedStyle(e).opacity; }); })()');
        if (hovered && hovered[0] === '1' && hovered[1] === '0' && hovered[2] === '0') break;
      }
      await dbg.sendCommand('CSS.forcePseudoState', { nodeId: found.nodeId, forcedPseudoClasses: [] });
    } catch (e) {
      console.log('WARN 强制 :hover 通道不可用: ' + (e && e.message));
    }
  }
  console.log('HOVER-ROUTE ' + hoverRoute + ' → ' + JSON.stringify(hovered));
  check('鼠标悬停在第一条进度条上:该行明细浮现(其余行保持隐藏)',
    hovered[0] === '1' && hovered[1] === '0' && hovered[2] === '0', JSON.stringify(hovered));
  // 悬停不应该把布局顶开:悬停前后条的位置必须一致
  const afterRect = await run('(function(){ var r = document.querySelectorAll(".mini-usage-bar")[0].getBoundingClientRect();'
    + 'return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) }; })()');
  check('悬停不引起布局跳动(条的位置/宽度不变)',
    same(barRect, afterRect), JSON.stringify({ before: barRect, after: afterRect }));
  await shot('electron-mini-usage-hover.png');

  // 三种小窗视图都要活着:用量进度条 → 占比圆环(新)→ 额度圆环(旧)。
  // 每步"点到出现为止"(视图顺序与起始状态无关),最后再点回用量视图,
  // 否则下一次运行会从别的视图开始(曾经把后面的断言全带偏)。
  const clickToggle = () => run('(function(){ var el = document.querySelector(\'.mini-title-btn[aria-label^="切换到"]\'); if (!el) return false; el.click(); return true; })()');
  const clickUntil = async (probe, maxClicks) => {
    for (let i = 0; i < maxClicks; i += 1) {
      if (await waitFor(probe, 1200)) return true;
      await clickToggle();
      await delay(350);
    }
    return waitFor(probe, 1200);
  };
  const shareUp = await clickUntil('!!document.querySelector(".mini-share")', 3);
  check('小窗新增「占比」视图:命中/输入/输出 圆环 + 三窗口切换', shareUp === true, String(shareUp));
  const shareSnap = await run('(function(){'
    + 'var rows = document.querySelectorAll(".mini-share-row");'
    + 'return { segs: document.querySelectorAll(".mini-share-ring circle").length,'
    + '  rows: rows.length,'
    + '  center: (document.querySelector(".mini-share-center-pct") || {}).textContent || null,'
    + '  buckets: Array.prototype.map.call(rows, function(r){ return r.querySelector(".mini-share-name").textContent.trim(); }),'
    + '  chips: document.querySelectorAll(".mini-share-window").length }; })()');
  check('占比圆环:轨道 + 命中/输入/输出 三段,底部三个窗口可切换',
    shareSnap.segs === 4 && same(shareSnap.buckets, ['命中', '输入', '输出']) && shareSnap.chips === 3,
    JSON.stringify(shareSnap));
  await shot('electron-mini-share-ring.png');
  check('小窗视图切换按钮存在且可点', (await run('!!document.querySelector(\'.mini-title-btn[aria-label^="切换到"]\')')) === true);
  const usageBack = await clickUntil('!!document.querySelector(".mini-usage")', 3);
  check('再切回用量进度条视图(两视图循环可来回切)', usageBack === true);
  check('「额度圆环 + 速度」视图已按用户要求删除(旧值回落用量进度条)',
    (await run('!!document.querySelector(".mini-body")')) === false, 'mini-body 不应再出现');

  // 绿=已用比例这条红线在小窗同样成立:没有分母 → 不画条、不给徽章,屏幕上连绿色都没有。
  // (此前这里钉的是"「无分母」徽章必须是中性灰";用户要求去掉"预算/无分母"那套说辞后,
  //  更强的形态是**根本不渲染** —— 没有分母就不该出现任何比例相关的图元。)
  // 用小窗自己的下拉真实切到没有分母的 DeepSeek,顺手把"小窗内切换平台"也走了一遍。
  await run('(function(){ var t = document.querySelector(".mini-usage .themed-select-trigger"); if (!t) return false; t.click(); return true; })()');
  await delay(250);
  const miniOptionLabels = await run('Array.prototype.map.call(document.querySelectorAll(".themed-select-option"), function(o){ return o.textContent.trim(); })');
  check('小窗下拉同样受白名单约束(只列已就绪的 6 个平台)',
    same(miniOptionLabels, ['DeepSeek', 'Codex', 'Kimi', 'DSH', 'Claude Code', 'opencode']),
    JSON.stringify(miniOptionLabels));
  const miniPickDs = await run('(function(){'
    + 'var opts = document.querySelectorAll(".themed-select-option");'
    + 'for (var i = 0; i < opts.length; i++) { if (opts[i].textContent.trim() === "DeepSeek") { opts[i].click(); return true; } }'
    + 'return false; })()');
  check('小窗内可切换服务商(下拉可选 DeepSeek)', miniPickDs === true, String(miniPickDs));
  const miniNoBar = await waitFor('document.querySelectorAll(".mini-usage-row").length === 3 && document.querySelectorAll(".mini-usage-bar").length === 3', 6000);
  await delay(700);
  const miniNoneSnap = await run('(function(){'
    + 'return { bars: document.querySelectorAll(".mini-usage-bar").length,'
    + '  badges: document.querySelectorAll(".mini-usage-badge").length,'
    + '  fills: Array.prototype.map.call(document.querySelectorAll(".mini-usage-fill"), function(e){ return Math.round(e.getBoundingClientRect().width); }),'
    + '  tracks: Array.prototype.map.call(document.querySelectorAll(".mini-usage-bar"), function(e){ return Math.round(e.getBoundingClientRect().width); }),'
    + '  tokens: Array.prototype.map.call(document.querySelectorAll(".mini-usage-figures"), function(e){ return e.textContent.trim(); }) };'
    + '})()');
  check('小窗没有分母时:仍画对比条(绿色 = 实际用了多少 token),但不给任何百分比徽章',
    miniNoBar && miniNoneSnap.bars === 3 && miniNoneSnap.badges === 0, JSON.stringify(miniNoneSnap));
  check('小窗对比条与大卡同口径:最大窗口满格、其余按比例(本月满格)',
    miniNoneSnap.tracks[2] > 0
      && Math.abs(miniNoneSnap.fills[2] / miniNoneSnap.tracks[2] - 1) < 0.03
      && miniNoneSnap.fills[0] < miniNoneSnap.fills[1],
    JSON.stringify({ fills: miniNoneSnap.fills, tracks: miniNoneSnap.tracks }));
  check('小窗没有分母时仍显示 token 与金额(数据本身照常)',
    miniNoneSnap.tokens.length === 3 && miniNoneSnap.tokens.every((t) => /Token/.test(t)),
    JSON.stringify(miniNoneSnap.tokens));
  await shot('electron-mini-nobudget.png');
  await run('window.__setMini(false)');
  // 还原成完整窗口尺寸(前面为了测真实小窗把内容区缩到了 250×216)
  win.setContentSize(900, 720);
  await delay(400);
  await waitFor('!!document.querySelector(".usage-summary")', 4000);

  /* ===== 小窗退回:退出迷你 + 主窗落回服务商列表(列表就是「上一级」)===== */
  await run('window.__setMini(true)');
  await waitFor('!!document.querySelector(".mini-usage")', 4000);
  const miniBackClicked = await run('(function(){ var el = document.querySelector(".mini-usage-back"); if (!el) return false; el.click(); return true; })()');
  check('小窗有退回按钮(回服务商列表)', miniBackClicked === true, String(miniBackClicked));
  check('小窗退回同时发出退出迷你请求',
    (await sentChannels()).indexOf('window:toggle-mini') >= 0, JSON.stringify(await sentChannels()));
  // 桩的 window:toggle-mini 只记录通道、不真的改窗口尺寸,所以这里手动落回完整窗口态
  await run('window.__setMini(false)');
  const homeAfterBack = await waitFor('!!document.querySelector(".provider-gate")', 4000);
  check('退回后主窗落在服务商列表(不是详情页)', homeAfterBack === true);

  win.destroy();
  started.server.close();
  console.log('');
  console.log(failures.length === 0
    ? '全部断言通过(' + 0 + ' 个失败)'
    : '失败 ' + failures.length + ' 项: ' + failures.join(' | '));
  console.log('截图目录: ' + OUT_DIR);
  app.quit();
  process.exitCode = failures.length === 0 ? 0 : 1;
}

// 在 Electron 里 = 断言 + 截图;在纯 node 里 = 只起服务,交给系统 Chrome/Edge 无头渲染
if (process.versions.electron) {
  main().catch((e) => {
    console.error('校验脚本异常: ' + (e && e.stack ? e.stack : e));
    // 这里必须用 require('electron').app:main() 内的解构赋值不在本作用域,
    // 直接写 app 会再抛 ReferenceError,把"真正的失败原因"淹没掉(实测踩过)。
    try { require('electron').app.quit(); } catch (err) {}
    process.exitCode = 1;
  });
} else {
  startServer(Number(process.env.VERIFY_PORT || 8787)).then((started) => {
    console.log('服务已启动: http://127.0.0.1:' + started.port + '/');
    console.log('可加 query 驱动初始态: ?bucket=week&estimate=1&theme=dark');
  }).catch((e) => {
    console.error('服务启动失败: ' + (e && e.message ? e.message : e));
    process.exitCode = 1;
  });
}