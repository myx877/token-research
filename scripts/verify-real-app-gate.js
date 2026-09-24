// 真机复核(第五轮:免登录首屏 → 选服务商 → 主界面进度条 → 小窗口进度条 + 悬停明细)
//
// 与桩跑的 harness 互补:这里面对的是**真实应用进程**(真实主进程设置广播、真实窗口缩放、
// 真实 IPC),所以能证明"改完在成品里真的能用",而不只是"在桩里能渲染"。
//
// 前置:应用已带 --remote-debugging-port 启动。
// 用法:CDP_PORT=9224 node scripts/verify-real-app-gate.js
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.CDP_PORT || '9224';
const OUT_DIR = path.join(__dirname, '..', 'docs', 'verification', 'usage-summary');
const OUT_NAME = process.env.OUT_NAME || 'real-app-gate';

function send(ws, id, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(method + ' 超时(' + timeoutMs + 'ms)')), timeoutMs);
    const onMessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMessage);
      msg.error ? reject(new Error(method + ' 失败:' + JSON.stringify(msg.error))) : resolve(msg.result);
    };
    ws.addEventListener('message', onMessage);
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = (e) => reject(new Error('WS 错误: ' + (e && (e.type || e.message))));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 用 node:http 直接取 CDP 端点:内置 fetch(undici)在这个环境里出现过 "fetch failed"
// 而 curl 同一时刻可用 —— 取证脚本不该因为 HTTP 客户端的小脾气而失败。
function httpGetJson(url, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const req = require('node:http').get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(new Error('响应不是 JSON: ' + body.slice(0, 120))); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('HTTP 超时(' + timeoutMs + 'ms): ' + url)); });
    req.on('error', reject);
  });
}

const READ_GATE = `(function(){
  var txt = function(el){ return el ? el.textContent.trim() : null; };
  var g = document.querySelector('.provider-gate');
  return JSON.stringify({
    有首屏: !!g,
    标题: txt(g && g.querySelector('.provider-gate-title')),
    平台: Array.prototype.map.call(document.querySelectorAll('.provider-gate-item'), function(b){ return {
      名: txt(b.querySelector('.provider-gate-name')), 状态: txt(b.querySelector('.provider-gate-status')) }; }),
    分组: Array.prototype.map.call(document.querySelectorAll('.provider-gate-section-title'), function(e){ return e.textContent.trim(); }),
    有全部平台入口: !!document.querySelector('.provider-gate-all'),
    有跳过按钮: !!document.querySelector('.provider-gate-skip'),
    有详情页: !!document.querySelector('.usage-summary'),
    登录层数: document.querySelectorAll('.login, .login-window, .login-card, .login-overlay').length
  });
})()`;

// 选一个不需要 Key 的平台(默认 opencode)并进入主界面:单点直达,点行即进,
// 不需要第二步确认(两步确认曾让用户"点了以为选上,实际还停在原平台")
const ENTER_FROM_GATE = (label) => `(async function(){
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  var items = document.querySelectorAll('.provider-gate-item');
  for (var i = 0; i < items.length; i++) {
    var n = (items[i].querySelector('.provider-gate-name') || {}).textContent;
    if (n && n.trim() === ${JSON.stringify(label)}) {
      items[i].click();
      await sleep(600);
      // 单点直达:点完行就该进主界面,不该再要第二步确认
      if (document.querySelector('.usage-summary')) return 'entered-single-click';
      var go = document.querySelector('.provider-gate-primary');
      if (!go) return 'stayed-on-gate';
      go.click();
      return 'entered-two-clicks';
    }
  }
  return 'platform-not-found:' + items.length;
})()`;

const READ_MAIN = `(function(){
  var txt = function(el){ return el ? el.textContent.trim() : null; };
  var rows = Array.prototype.map.call(document.querySelectorAll('.usage-window'), function(el){
    return {
      标签: txt(el.querySelector('.usage-window-label')),
      百分比: txt(el.querySelector('.usage-window-badge')),
      明细: txt(el.querySelector('.usage-window-breakdown')),
      数值: txt(el.querySelector('.usage-window-figures')),
      条宽: (function(){ var f = el.querySelector('.usage-window-fill'); return f ? Math.round(f.getBoundingClientRect().width) : null; })()
    };
  });
  return JSON.stringify({
    应用外壳: !!document.querySelector('.app-content, .app-mini'),
    选择平台: txt(document.querySelector('.usage-summary .themed-select-label')),
    当前服务商标识: txt(document.querySelector('.usage-summary-single-title')),
    有退回按钮: !!document.querySelector('.titlebar-back'),
    切换标签页数: document.querySelectorAll('.titlebar-rail-tab').length,
    单平台视图: !!document.querySelector('.single-provider'),
    有提示条: !!document.querySelector('.single-provider-hint'),
    有返回全部: document.body.innerText.indexOf('返回全部') >= 0,
    柱标题: txt(document.querySelector('.single-provider .component-title')),
    热力图锁定: txt(document.querySelector('.single-provider .heatmap-locked')),
    热力图模式: Array.prototype.map.call(document.querySelectorAll('.heatmap-widget .heatmap-modes .heatmap-tab'), function(e){ return e.textContent.trim(); }),
    热力图年份: txt(document.querySelector('.heatmap-widget .heatmap-year-label')),
    有费用区: !!document.querySelector('.single-provider-fees'),
    行数: rows.length, 行: rows,
    有表格: !!document.querySelector('.usage-summary-table'),
    币种行数: Array.prototype.filter.call(document.querySelectorAll('.usage-window-figures'), function(e){ return /[¥$]/.test(e.textContent); }).length,
    正文前160字: (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 160)
  });
})()`;

const READ_MINI = `(function(){
  var txt = function(el){ return el ? el.textContent.trim() : null; };
  var details = document.querySelectorAll('.mini-usage-detail');
  return JSON.stringify({
    有小窗视图: !!document.querySelector('.mini-view'),
    有进度条视图: !!document.querySelector('.mini-usage'),
    平台标识: txt(document.querySelector('.mini-usage .themed-select-label')),
    有退回按钮: !!document.querySelector('.mini-usage-back'),
    标签: Array.prototype.map.call(document.querySelectorAll('.mini-usage-label'), function(e){ return e.textContent.trim(); }),
    百分比: Array.prototype.map.call(document.querySelectorAll('.mini-usage-badge'), function(e){ return e.textContent.trim(); }),
    倒计时: Array.prototype.map.call(document.querySelectorAll('.mini-usage-reset'), function(e){ return e.textContent.trim(); }),
    明细文字: Array.prototype.map.call(details, function(e){ return e.textContent.trim(); }),
    明细透明度: Array.prototype.map.call(details, function(e){ return getComputedStyle(e).opacity; }),
    条数: document.querySelectorAll('.mini-usage-bar').length,
    行底边: Array.prototype.map.call(document.querySelectorAll('.mini-usage-row'), function(e){ return Math.round(e.getBoundingClientRect().bottom); }),
    窗口高: window.innerHeight,
    内容需高: (function(){ var el = document.querySelector('.mini-usage'); return el ? el.scrollHeight : null; })(),
    可视高: (function(){ var el = document.querySelector('.mini-usage'); return el ? el.clientHeight : null; })(),
    窗口尺寸: { w: window.innerWidth, h: window.innerHeight },
    大卡是否还在: !!document.querySelector('.usage-summary')
  });
})()`;

(async () => {
  const started = new Date().toISOString();
  const lines = [];
  const log = (text) => { lines.push(text); console.log(text); };

  const list = await httpGetJson('http://127.0.0.1:' + PORT + '/json/list');
  const pageTargets = list.filter((t) => t.type === 'page');
  log('# 真机复核:免登录首屏 → 选服务商 → 主界面 → 小窗口');
  log('时间: ' + started + '  CDP 端口: ' + PORT);
  log('');
  log('## 1. 窗口清单');
  pageTargets.forEach((t, i) => log('  [' + i + '] title=' + JSON.stringify(t.title) + ' url=' + String(t.url).slice(0, 90)));
  const loginLike = pageTargets.filter((t) => /登录|login|开放平台|platform/i.test(String(t.title) + ' ' + String(t.url)));
  log('疑似平台登录窗: ' + loginLike.length);

  const main = pageTargets.find((t) => /DeepSeek Monitor|Token Monitor/.test(t.title || '')) || pageTargets[0];
  if (!main) {
    log('❌ 未找到主窗,无法继续');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, OUT_NAME + '.txt'), lines.join('\n') + '\n');
    process.exitCode = 1;
    return;
  }

  const ws = await connect(main.webSocketDebuggerUrl);
  let id = 1;
  let verdictSync = false;
  let verdictRestoreSize = false;
  let verdictMiniAnimated = false;
  const evaluate = async (expression, timeoutMs) => {
    const res = await send(ws, id++, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs || 30000);
    if (res && res.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(res.exceptionDetails).slice(0, 300));
    return res && res.result ? res.result.value : undefined;
  };

  /* 贴边自动隐藏(用户设置)可能在启动时就把窗口收成屏幕边的竖条 —— 那是它的**正常行为**,
     但走查的每一步都会落空(实测踩过两次:整轮判定成片 false,看起来像应用坏了)。
     处理:临时关掉该设置(会立刻解除停靠),整轮跑完再恢复原值。 */
  const edgeHideWasOn = await evaluate(
    "window.api.invoke('get:settings').then(function(s){ return !!(s && s.window && s.window.edgeAutoHide); })"
  );
  if (edgeHideWasOn) {
    log('检测到「贴边自动隐藏」为开:临时关闭并解除停靠(跑完恢复)');
    await evaluate("window.api.invoke('settings:save', { key: 'window.edgeAutoHide', value: false })");
    await sleep(1500);
  }
  const shot = async (name) => {
    await send(ws, id++, 'Page.enable', {}, 5000);
    await sleep(250); // 合成帧稳定
    // 真机上截图偶发超时(页面正在画 ECharts/热力图时合成帧慢),超时不该终结整轮走查:
    // 加长超时 + 重试一次,把"真的拍不到"和"这一帧慢"区分开
    let res = null;
    for (let attempt = 0; attempt < 2 && !res; attempt += 1) {
      try {
        res = await send(ws, id++, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 30000);
      } catch (e) {
        log('  截图重试(' + (attempt + 1) + '):' + name + ' → ' + (e && e.message));
        await sleep(1200);
      }
    }
    if (!res) {
      log('  ⚠ 截图失败(跳过,不影响其余判定): ' + name);
      return null;
    }
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, name);
    fs.writeFileSync(file, Buffer.from(res.data, 'base64'));
    log('  截图已落盘: ' + file);
    return file;
  };

  // ── 首屏 ──────────────────────────────────────────────────────────────
  log('');
  log('## 2. 首屏「选服务商」(免登录)');
  // 窗口状态是持久化的:上次用完停在小窗,这次启动就是小窗 —— 先退回完整窗口,否则既没有
  // 标题栏也没有列表,"退回上一级"根本无从点起(实测踩过:整轮判定成片 false)。
  if (await evaluate('!!document.querySelector(".mini-view")')) {
    log('  应用处于迷你模式(上次使用的持久化状态),先退出迷你窗口');
    await evaluate("window.api.send('window:toggle-mini')");
    await sleep(1500);
  }
  let gate = JSON.parse(await evaluate(READ_GATE));
  if (!gate.有首屏) {
    // 主界面 = 服务商列表,退回上一级靠标题栏的 ‹。
    // 注意**不能**再用 location.reload() 兜底:启动已改为"记住上次平台",
    // 刷新会直接落回那个平台的详情页,永远回不到列表(第六轮踩过)。
    log('  当前不在服务商列表(可能已进入过详情),点标题栏 ‹ 退回一次');
    await evaluate('(function(){ var el = document.querySelector(".titlebar-back"); if (!el) return false; el.click(); return true; })()').catch(() => {});
    await sleep(1000);
    gate = JSON.parse(await evaluate(READ_GATE));
    if (!gate.有首屏) {
      log('  ⚠ 退回后仍未看到服务商列表');
    }
  }
  Object.keys(gate).forEach((k) => log('  ' + k + ': ' + JSON.stringify(gate[k])));
  await shot('real-app-gate.png');

  // ── 选平台进入 ────────────────────────────────────────────────────────
  const platform = process.env.GATE_PLATFORM || 'opencode';
  log('');
  log('## 3. 在首屏选「' + platform + '」并进入(真实点击)');
  const enterResult = await evaluate(ENTER_FROM_GATE(platform));
  log('  进入结果: ' + enterResult);
  for (let i = 0; i < 40; i += 1) {
    if (await evaluate('!!document.querySelector(".usage-summary")')) break;
    await sleep(250);
  }
  await sleep(1200);
  const mainState = JSON.parse(await evaluate(READ_MAIN));
  Object.keys(mainState).forEach((k) => log('  ' + k + ': ' + JSON.stringify(mainState[k])));
  // 关键改动在折叠线下(640px 窗口里排在第 4 块):不滚进视野,截图就拍不到本次改的东西
  const cardScrolled = await evaluate("(function(){ var el = document.querySelector('.usage-summary'); if (!el) return false; el.scrollIntoView({ block: 'start' }); return true; })()");
  log('  用量卡滚入视野: ' + cardScrolled);
  await sleep(700);
  await shot('real-app-main-windows.png');

  // ── 小窗口 ────────────────────────────────────────────────────────────
  log('');
  log('## 4. 切到小窗口(真实主进程 window:toggle-mini)');
  /* 这一跳必须是**缓动**的:Enter 时代 setBounds 一次到位是硬跳变,用户体感"很僵硬"。
     Electron 的 setBounds(bounds, animate) 在 Windows 上不生效,动画是主进程自己插的值 ——
     证据 = 从发出 toggle 到窗口真的落到 250×216 之间**耗掉了可测量的时间**,且采样到中间尺寸。 */
  const miniFromWidth = JSON.parse(await evaluate('JSON.stringify({ w: window.innerWidth })')).w;
  const miniToggleAt = Date.now();
  const midSizes = [];
  await evaluate("window.api.send('window:toggle-mini')");
  // 密集采样窗口宽度:动画只有 ~200ms,粗采样(250ms 一次)会把中间帧整段错过去。
  // 诚实说明:**这里基本采不到中间值** —— 切迷你时渲染层正在重渲染整棵树,`Runtime.evaluate`
  // 会排队等它,所以每次采样都落在动画结束之后。真正"插了中间帧"的直接证据在主进程侧:
  // `test/mini-mode.test.js` 的「进入/退出迷你都是缓动」用假窗口记录了每一帧的宽度。
  // 真机这边退而求其次,用**耗时**证明不是硬跳变(硬跳变 ~30ms,缓动 ~360ms)。
  for (let i = 0; i < 12; i += 1) {
    try {
      const w = JSON.parse(await evaluate('JSON.stringify({ w: window.innerWidth })')).w;
      if (w < miniFromWidth && w > 250) midSizes.push(w);
    } catch (e) { /* 过渡中页面短暂不可读,继续采 */ }
  }
  let miniState = null;
  for (let i = 0; i < 40; i += 1) {
    miniState = JSON.parse(await evaluate(READ_MINI));
    // 等到**三条都渲染出来**再取快照:小窗视图出现 ≠ 数据行已挂载,
    // 早读会拿到「条数 0 / 标签空」的中间态(实测踩过:两条断言假失败)。
    if (miniState.有进度条视图 && miniState.条数 === 3) break;
    // 小窗有两种视图(用量进度条 / 额度圆环),选择是持久化的:上次停在圆环时,
    // 光等是等不到进度条视图的 —— 主动切过去,再继续等(实测踩过:整段 mini 断言全 false)
    if (i > 0 && i % 8 === 0 && miniState.有小窗视图) {
      log('  小窗当前不是「用量进度条」视图(持久化选择),点视图切换按钮循环(三视图)');
      await evaluate('(function(){ var el = document.querySelector(".mini-title-btn[aria-label^=\\"切换到\\"]"); if (!el) return false; el.click(); return true; })()');
    }
    await sleep(250);
  }
  const miniElapsed = Date.now() - miniToggleAt;
  verdictMiniAnimated = midSizes.length > 0 || miniElapsed >= 120;
  log('  进入小窗耗时 ' + miniElapsed + 'ms;采样到的中间宽度: ' + JSON.stringify(midSizes)
    + (verdictMiniAnimated ? '' : '  ⚠ 像是一次硬跳变(没有任何中间尺寸、且几乎瞬间到位)'));
  Object.keys(miniState).forEach((k) => log('  ' + k + ': ' + JSON.stringify(miniState[k])));
  await shot('real-app-mini-usage.png');

  // 真实鼠标悬停(CDP Input.dispatchMouseEvent 才会触发 CSS :hover)
  // 小窗视图在数据到达/广播刷新时可能短暂重挂:先等条稳定出现,取不到就记 FAIL 继续走,
  // 绝不让一次探针异常吞掉后半截(恢复窗口 + 判定 + 落盘)
  let box = null;
  for (let i = 0; i < 20; i += 1) {
    try {
      const raw = await evaluate(`(function(){
        var bars = document.querySelectorAll('.mini-usage-bar');
        if (!bars.length) return null;
        var r = bars[0].getBoundingClientRect();
        if (!r.width && !r.height) return null;
        return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) });
      })()`);
      if (raw) { box = JSON.parse(raw); break; }
    } catch (e) { /* 视图抖动中,下一轮再取 */ }
    await sleep(500);
  }
  log('  悬停目标条: ' + JSON.stringify(box));
  let hoverState = { 明细透明度: [] };
  if (box) {
    await send(ws, id++, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y, button: 'none', clickCount: 0 }, 8000);
    // 过渡要走完:轮询到稳态(终态必须是首行 1 其余 0),撞过渡中间值不算数
    for (let i = 0; i < 10; i += 1) {
      await sleep(250);
      try { hoverState = JSON.parse(await evaluate(READ_MINI)); } catch (e) { continue; }
      const op = hoverState.明细透明度 || [];
      if (op[0] === '1' && op[1] === '0' && op[2] === '0') break;
    }
  } else {
    log('  悬停探针未取到目标条(记 FAIL,不中断后半截)');
  }
  log('  悬停后明细透明度: ' + JSON.stringify(hoverState.明细透明度));
  await shot('real-app-mini-usage-hover.png');

  // ── 恢复原状:取证结束后把窗口切回完整界面(miniMode 是持久化设置,不能留给用户)──
  log('');
  log('## 5. 恢复原状(切回完整窗口)');
  if (edgeHideWasOn) {
    await evaluate("window.api.invoke('settings:save', { key: 'window.edgeAutoHide', value: true })");
    log('  已恢复「贴边自动隐藏」为开');
  }
  await evaluate("window.api.send('window:toggle-mini')");
  let restored = false;
  for (let i = 0; i < 40; i += 1) {
    restored = await evaluate('!!document.querySelector(".usage-summary") && !document.querySelector(".mini-view")');
    if (restored) break;
    await sleep(250);
  }
  log('  已切回完整界面: ' + restored);
  /* 尺寸也必须退回来。踩过的真 bug:Windows 上 setMaximumSize 与紧随其后的 setBounds 存在竞态,
     退出迷你时那次 setBounds 会被旧的 250×216 上限钳住 ⇒ 留下"完整视图 + 迷你尺寸"的窗口,
     用户视角是界面挤成一团、怎么点都回不去(而且是持久的:window.width 没被改,但窗口卡在小尺寸)。 */
  await sleep(700);
  const restoreSize = await evaluate('JSON.stringify({ w: window.innerWidth, h: window.innerHeight })');
  const sizeParsed = JSON.parse(restoreSize);
  const sizeBack = sizeParsed.w > 300 && sizeParsed.h > 300;
  log('  切回后的窗口尺寸: ' + restoreSize + (sizeBack ? '' : '  ⚠ 仍停在迷你尺寸!'));
  verdictRestoreSize = sizeBack;

  // ── 真机验收刚修的缺陷:sync:history 曾经抛 ReferenceError(inclusiveBeijingDayCount 未 import)──
  log('');
  log('## 6. 真机 IPC 往返:sync:history(修复验证)');
  const syncResult = await evaluate(`window.api.invoke('sync:history').then(function(r){
    return JSON.stringify({ ok: true, keys: Object.keys(r || {}), retentionHint: (r && r.retentionHint) || null });
  }).catch(function(e){ return JSON.stringify({ ok: false, error: String(e && e.message || e) }); })`, 120000);
  log('  结果: ' + syncResult);
  let syncParsed = {};
  try { syncParsed = JSON.parse(syncResult); } catch (e) {}
  verdictSync = syncParsed.ok === true && !/ReferenceError/.test(syncResult);

  // ── 判定(放在最后:要等 sync:history 的真机往返结果)──
  const verdict = {
    主界面即服务商列表且免登录: gate.有首屏 === true && gate.登录层数 === 0
      && gate.有跳过按钮 === false && gate.有全部平台入口 === true && (gate.分组 || []).length === 2,
    首屏列出六个平台: (gate.平台 || []).length === 6,
    无平台登录窗: loginLike.length === 0,
    进入后自动选中该平台: mainState.选择平台 === platform,
    '点行一次即进主界面(无第二步确认)': enterResult === 'entered-single-click',
    '单平台视图只看该平台': mainState.单平台视图 === true && mainState.选择平台 === platform && mainState.有表格 === false
      && mainState.有提示条 === false && mainState.有返回全部 === false,
    '标题栏有退回按钮': mainState.有退回按钮 === true,
    // 标题栏不再放任何服务商切换控件(用户要求:34px 的条里塞一排标签只会退化成认不出的色点)
    '标题栏没有服务商切换标签页': mainState.切换标签页数 === 0,
    '柱标题与热力图跟着平台走': mainState.柱标题 === 'opencode 每日 Token 消耗' && mainState.热力图锁定 === '仅看 opencode',
    '热力图有三个模式页签(每日/每周/累计)且带年份':
      (mainState.热力图模式 || []).length === 3
        && ['每日', '每周', '累计'].every((l) => (mainState.热力图模式 || []).indexOf(l) >= 0)
        && /^\d{4}$/.test(String(mainState.热力图年份)),
    'opencode 视图无 DS 费用区': mainState.有费用区 === false,
    主界面三条进度条带明细: mainState.行数 === 3 && (mainState.行 || []).every((r) => /命中/.test(String(r.明细)) && /输入/.test(String(r.明细)) && /输出/.test(String(r.明细))),
    小窗口只有该平台进度条: miniState.有进度条视图 === true && miniState.条数 === 3 && miniState.大卡是否还在 === false,
    '小窗三条都完整可见(没被 216px 的窗口底部切掉、也不需要滚动)':
      (miniState.行底边 || []).length === 3
        && (miniState.行底边 || []).every((b) => b <= (miniState.窗口高 || 0))
        && miniState.内容需高 <= miniState.可视高 + 1,
    '小窗口有退回按钮': miniState.有退回按钮 === true,
    '退出迷你后窗口尺寸真的退回来了(不是卡在 250×216)': verdictRestoreSize === true,
    '进入迷你窗口是缓动而不是硬跳变(采样到中间尺寸或耗时≥120ms)': verdictMiniAnimated === true,
    悬停后首行明细可见: (hoverState.明细透明度 || [])[0] === '1',
    悬停不影响其余行: (hoverState.明细透明度 || []).slice(1).every((o) => o === '0'),
    'sync:history 真机不抛错(缺陷已修)': verdictSync === true
  };
  log('');
  log('');
  log('## 7. 判定');
  Object.keys(verdict).forEach((k) => log('  ' + k + ': ' + verdict[k]));

  try { ws.close(); } catch (e) {}
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, OUT_NAME + '.txt'), lines.join('\n') + '\n');
  console.log('\n读数已落盘: ' + path.join(OUT_DIR, OUT_NAME + '.txt'));
})().catch((e) => {
  console.error('复核失败: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
