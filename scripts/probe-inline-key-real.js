// 真机端到端探针(表达式,由 scripts/diag-app-state.js 经 CDP 注入主窗执行):
// 选中 DeepSeek → 在卡片内联输入框填入"形状合法但无效"的 key → 点「保存并验证」
// → 等真实 fetchBalance 返回 → 读错误文案 + 直接问主进程 get:settings 的 apiKeySet。
// 期望:显示校验失败文案,apiKeySet 仍为 false(没有写入 store)。
(async function () {
  var sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var card = function () { return document.querySelector('.usage-summary'); };
  var label = function () { var el = card() && card().querySelector('.themed-select-label'); return el ? el.textContent.trim() : null; };

  // 0) 若实例处于迷你模式(全新 profile 的窗口尺寸可能触发),先点"放大至完整窗口"
  var expandedFromMini = false;
  if (document.querySelector('.mini-view')) {
    var expand = document.querySelector('.mini-title-btn');
    if (expand) expand.click();
    expandedFromMini = true;
    for (var m = 0; m < 40 && !card(); m += 1) await sleep(200);
  }
  if (!card()) return JSON.stringify({ error: 'no-usage-summary', expandedFromMini: expandedFromMini, mini: !!document.querySelector('.mini-view') });

  // 1) 真实交互选中 DeepSeek
  var trig = card() && card().querySelector('.themed-select-trigger');
  if (!trig) return JSON.stringify({ error: 'no-select-trigger' });
  trig.click();
  await sleep(300);
  var opts = document.querySelectorAll('.themed-select-option');
  for (var i = 0; i < opts.length; i++) {
    if (opts[i].textContent.trim() === 'DeepSeek') { opts[i].click(); break; }
  }
  for (var w = 0; w < 30 && !document.querySelector('.usage-cred-input'); w += 1) await sleep(200);
  var input = document.querySelector('.usage-cred-input');
  if (!input) return JSON.stringify({ error: 'no-inline-input', selected: label() });

  // 2) 原生 setter + input 事件:让 React 认这是用户输入
  var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, 'sk-00000000000000000000000000000000');
  input.dispatchEvent(new Event('input', { bubbles: true }));
  var typed = input.value;

  // 3) 点「保存并验证」,等真实网络校验回来
  var btn = card().querySelector('.usage-cred-btn');
  var btnLabel = btn ? btn.textContent.trim() : null;
  btn.click();
  var err = null;
  for (var t = 0; t < 60; t += 1) {
    await sleep(250);
    var e = document.querySelector('.usage-cred-error');
    if (e && e.textContent.trim()) { err = e.textContent.trim(); break; }
  }
  await sleep(500);

  // 4) 直接问主进程:Key 到底写没写
  var settings = await window.api.invoke('get:settings');
  var apiKeySet = !!(settings && settings.providers && settings.providers.deepseek && settings.providers.deepseek.apiKeySet);
  var inputAfter = document.querySelector('.usage-cred-input');
  var btnAfter = card().querySelector('.usage-cred-btn');

  return JSON.stringify({
    expandedFromMini: expandedFromMini,
    selected: label(),
    typed: typed,
    btnLabel: btnLabel,
    errorText: err,
    inputStillThere: !!inputAfter,
    draftKept: inputAfter ? inputAfter.value === typed : null,
    btnAfter: btnAfter ? btnAfter.textContent.trim() : null,
    apiKeySet: apiKeySet,
    rows: document.querySelectorAll('.usage-window').length
  });
})()
