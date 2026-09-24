// 真机复核:对运行中的应用(需 --remote-debugging-port)取证并落盘。
//   · 窗口清单(CDP target 列表)—— 证明"启动无平台登录窗"
//   · 主窗读数:是否主界面 / 汇总卡是否挂载 / 选中 DeepSeek 后是否有内联输入
//   · 尽力截图(CDP Page.captureScreenshot;失败则如实记录,不假装成功)
// 用法:CDP_PORT=9224 OUT_NAME=real-app-credentials node scripts/verify-real-app-credentials.js
const fs = require('node:fs');
const path = require('node:path');

const PORT = process.env.CDP_PORT || '9224';
const OUT_DIR = path.join(__dirname, '..', 'docs', 'verification', 'usage-summary');
const OUT_NAME = process.env.OUT_NAME || 'real-app-credentials';
const SHOT_NAME = process.env.SHOT_NAME || (OUT_NAME + '.png');

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

const READ_MAIN = `(function(){
  var doc = document;
  var sel = doc.querySelector('.usage-summary .themed-select-label');
  var input = doc.querySelector('.usage-cred-input');
  var cred = doc.querySelector('.usage-cred');
  return JSON.stringify({
    已从迷你模式展开: !!window.__expandedFromMini,
    title: doc.title,
    渲染应用外壳: !!doc.querySelector('.app-content, .app-mini'),
    主窗内登录层: doc.querySelectorAll('.login, .login-window, .login-card, .login-overlay').length,
    有用量汇总卡: !!doc.querySelector('.usage-summary'),
    选择平台: sel ? sel.textContent.trim() : null,
    卡片含内联输入: !!input,
    内联输入类型: input ? input.type : null,
    凭证提示: cred ? cred.textContent.trim() : null,
    窗口卡行数: doc.querySelectorAll('.usage-window').length,
    窗口卡行: Array.prototype.map.call(doc.querySelectorAll('.usage-window-label'), function(e){ return e.textContent.trim(); }),
    正文前120字: (doc.body && doc.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120)
  });
})()`;

// 选平台 + 若在迷你模式先展开(真实交互:点触发器 → 点选项)
const SELECT_MAIN = (label) => `(async function(){
  var sleep = function(ms){ return new Promise(function(r){ setTimeout(r, ms); }); };
  if (document.querySelector('.mini-view')) {
    var ex = document.querySelector('.mini-title-btn');
    if (ex) ex.click();
    window.__expandedFromMini = true;
    for (var m = 0; m < 40 && !document.querySelector('.usage-summary'); m += 1) await sleep(200);
  }
  var card = document.querySelector('.usage-summary');
  if (!card) return 'no-usage-summary';
  var trig = card.querySelector('.themed-select-trigger');
  if (!trig) return 'no-trigger';
  var current = (card.querySelector('.themed-select-label') || {}).textContent;
  if (current && current.trim() === ${JSON.stringify(label)}) return 'already';
  trig.click();
  await sleep(300);
  var opts = document.querySelectorAll('.themed-select-option');
  for (var i = 0; i < opts.length; i++) {
    if (opts[i].textContent.trim() === ${JSON.stringify(label)}) { opts[i].click(); await sleep(500); return 'picked'; }
  }
  return 'option-not-found:' + opts.length;
})()`;

const READ_SETTINGS = "window.api.invoke('get:settings').then(function(s){ return JSON.stringify({ apiKeySet: !!(s && s.providers && s.providers.deepseek && s.providers.deepseek.apiKeySet) }); })";

(async () => {
  const started = new Date().toISOString();
  const lines = [];
  const log = (text) => { lines.push(text); console.log(text); };

  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  log('# 真机复核读数');
  log('时间: ' + started);
  log('CDP 端口: ' + PORT);
  log('');
  log('## 1. 窗口清单(CDP target)—— 平台登录窗是否存在');
  log('target 总数: ' + list.length);
  list.forEach((t, i) => log('  [' + i + '] type=' + t.type + ' title=' + JSON.stringify(t.title) + ' url=' + String(t.url).slice(0, 90)));
  const pageTargets = list.filter((t) => t.type === 'page');
  const titles = pageTargets.map((t) => t.title);
  const loginLike = pageTargets.filter((t) => /登录|login|开放平台|platform/i.test(String(t.title) + ' ' + String(t.url)));
  log('页面类 target 数: ' + pageTargets.length + ' → ' + JSON.stringify(titles));
  log('疑似平台登录窗的 target: ' + loginLike.length + ' ' + JSON.stringify(loginLike.map((t) => t.title)));

  const main = pageTargets.find((t) => /DeepSeek Monitor/.test(t.title || ''));
  if (!main) {
    log('');
    log('❌ 未找到主窗(DeepSeek Monitor)——无法继续复核');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, OUT_NAME + '.txt'), lines.join('\n') + '\n');
    process.exitCode = 1;
    return;
  }

  const ws = await connect(main.webSocketDebuggerUrl);
  let id = 1;
  const evaluate = async (expression, timeoutMs) => {
    const res = await send(ws, id++, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs || 30000);
    if (res && res.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(res.exceptionDetails).slice(0, 200));
    return res && res.result ? res.result.value : undefined;
  };

  const target = process.env.CDP_PLATFORM || 'DeepSeek';
  const pickResult = await evaluate(SELECT_MAIN(target));
  log('');
  log('## 2. 选平台(真实交互:点下拉 → 点「' + target + '」)');
  log('选择结果: ' + pickResult);

  const readMain = JSON.parse(await evaluate(READ_MAIN));
  log('');
  log('## 3. 主窗读数');
  Object.keys(readMain).forEach((k) => log('  ' + k + ': ' + JSON.stringify(readMain[k])));

  const settings = JSON.parse(await evaluate(READ_SETTINGS));
  log('  DeepSeek apiKeySet(主进程侧读数): ' + settings.apiKeySet);

  // 截图:尽力而为,失败如实记录
  log('');
  log('## 4. 截图');
  // 先把要取证的"卡/凭证块"滚进视野,否则截图只有页面顶部(读数在凭证块上,图也得看得见它)
  const scrolled = await evaluate("(function(){ var t = document.querySelector('.usage-cred') || document.querySelector('.usage-summary'); if (!t) return false; t.scrollIntoView({ block: 'center' }); return true; })()");
  log('  取证目标滚入视野: ' + scrolled);
  await new Promise((r) => setTimeout(r, 700));
  let shotNote;
  try {
    await send(ws, id++, 'Page.enable', {}, 5000);
    const shot = await send(ws, id++, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, 15000);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const file = path.join(OUT_DIR, SHOT_NAME);
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    shotNote = '已落盘: ' + file;
  } catch (e) {
    shotNote = '未取得(如实记录): ' + e.message;
  }
  log('  ' + shotNote);
  try { ws.close(); } catch (e) {}

  // 结论性判定(便于人眼复核)
  const verdict = {
    窗口清单无平台登录窗: loginLike.length === 0,
    主窗有汇总卡: readMain['有用量汇总卡'] === true,
    卡片含内联输入: readMain['卡片含内联输入'] === true
  };
  log('');
  log('## 5. 判定');
  Object.keys(verdict).forEach((k) => log('  ' + k + ': ' + verdict[k]));

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, OUT_NAME + '.txt'), lines.join('\n') + '\n');
  console.log('\n读数已落盘: ' + path.join(OUT_DIR, OUT_NAME + '.txt'));
})().catch((e) => {
  console.error('复核失败: ' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
});
