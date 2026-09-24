// 诊断工具:枚举运行中 Electron 应用的全部窗口(CDP target),并读取每个窗口的关键 DOM 状态。
// 用法:先 npx electron . --remote-debugging-port=9223,再 node scripts/diag-app-state.js
const PORT = process.env.CDP_PORT || '9223';

function evaluate(wsUrl, expression, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('CDP 超时')); }, timeoutMs);
    const done = (err, data) => { clearTimeout(timer); try { ws.close(); } catch (e) {} err ? reject(err) : resolve(data); };
    ws.onopen = () => ws.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true }
    }));
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.id === 1) done(msg.error ? new Error(JSON.stringify(msg.error)) : null, msg.result && msg.result.result && msg.result.result.value);
    };
    ws.onerror = (e) => done(new Error('WS 错误: ' + (e && (e.message || e.type))));
  });
}

const PROBE = `(function(){
  var q = function(s){ return document.querySelector(s); };
  var body = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').trim();
  var inputs = Array.prototype.slice.call(document.querySelectorAll('input')).map(function(i){
    return { type: i.type, placeholder: i.placeholder || '', 有值: Boolean(i.value) };
  });
  var cred = q('.usage-cred');
  var credBtn = cred ? cred.querySelector('.usage-cred-btn') : null;
  return JSON.stringify({
    title: document.title,
    readyState: document.readyState,
    有用量汇总卡: Boolean(q('.usage-summary')),
    有窗口卡: document.querySelectorAll('.usage-window').length,
    窗口行: Array.prototype.map.call(document.querySelectorAll('.usage-window-label'), function(e){ return e.textContent.trim(); }),
    选择平台: q('.usage-summary .themed-select-label') ? q('.usage-summary .themed-select-label').textContent.trim() : null,
    凭证提示: cred ? cred.textContent.trim() : null,
    凭证输入框: Boolean(q('.usage-cred-input')),
    凭证按钮: credBtn ? credBtn.textContent.trim() : null,
    输入框: inputs,
    正文前160字: body.slice(0, 160)
  });
})()`;

// CDP_SELECT=<平台名> 时:真实交互点开自绘下拉并选中该项(不是伪造渲染状态)
const SELECT_JS = (label) => `(function(){
  var card = document.querySelector('.usage-summary');
  if (!card) return 'no-card';
  var trig = card.querySelector('.themed-select-trigger');
  if (!trig) return 'no-trigger';
  trig.click();
  return new Promise(function(resolve){
    setTimeout(function(){
      var opts = document.querySelectorAll('.themed-select-option');
      for (var i = 0; i < opts.length; i++) {
        if (opts[i].textContent.trim() === ${JSON.stringify(label)}) { opts[i].click(); resolve('picked'); return; }
      }
      resolve('option-not-found:' + opts.length);
    }, 250);
  });
})()`;

(async () => {
  const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
  console.log('CDP target 总数=' + list.length);
  list.forEach((t) => console.log('  - type=' + t.type + ' title=' + JSON.stringify(t.title) + ' url=' + String(t.url).slice(0, 80)));

  const mainPage = list.find((t) => t.type === 'page' && /DeepSeek Monitor/.test(t.title || ''));

  // 选平台探针:CDP_SELECT=<平台名>
  if (process.env.CDP_SELECT) {
    if (!mainPage) { console.log('没有主窗 page 目标'); return; }
    const picked = await evaluate(mainPage.webSocketDebuggerUrl, SELECT_JS(process.env.CDP_SELECT));
    console.log('\n[选平台] ' + process.env.CDP_SELECT + ' → ' + picked);
  }

  // 通用表达式探针:CDP_EVAL_FILE=<文件> 时,把文件内容当表达式在主窗里跑(支持 await)
  if (process.env.CDP_EVAL_FILE) {
    if (!mainPage) { console.log('没有主窗 page 目标'); return; }
    const expr = require('node:fs').readFileSync(process.env.CDP_EVAL_FILE, 'utf8');
    const value = await evaluate(mainPage.webSocketDebuggerUrl, expr, 40000);
    console.log('\n[表达式探针] ' + process.env.CDP_EVAL_FILE + '\n' + value);
  }

  // 通道探针:CDP_SEND=<channel> 时,在主窗渲染层调用 window.api.send(channel, data)
  if (process.env.CDP_SEND) {
    const page = mainPage || list.find((t) => t.type === 'page' && t.title !== '');
    if (!page) { console.log('没有可发送的 page 目标'); return; }
    const dataArg = process.env.CDP_SEND_DATA ? ', ' + process.env.CDP_SEND_DATA : '';
    const expr = "window.api && typeof window.api.send === 'function' ? (window.api.send("
      + JSON.stringify(process.env.CDP_SEND) + dataArg + "), 'sent') : 'no-api'";
    const sent = await evaluate(page.webSocketDebuggerUrl, expr);
    console.log('\n[通道探针] send(' + process.env.CDP_SEND + dataArg + ') → ' + sent);
  }

  const pages = list.filter((t) => t.type === 'page');
  for (const p of pages) {
    console.log('\n===== ' + p.title + ' =====');
    try {
      console.log(await evaluate(p.webSocketDebuggerUrl, PROBE));
    } catch (e) {
      console.log('读取失败: ' + e.message);
    }
  }
})().catch((e) => { console.error('失败: ' + (e && e.message)); process.exitCode = 1; });
