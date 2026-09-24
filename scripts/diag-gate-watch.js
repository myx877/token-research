// 诊断:reload 之后按时间采样「首屏是否出现」,判断是"从没渲染"还是"渲染后被关掉"。
// 用法:CDP_PORT=9223 node /tmp/gate-watch.js
const PORT = process.env.CDP_PORT || '9223';

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = require('node:http').get(url, { timeout: 5000 }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

function ev(wsUrl, expression, id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => { try { ws.close(); } catch (e) {} reject(new Error('CDP 超时')); }, 6000);
    ws.onopen = () => ws.send(JSON.stringify({
      id: id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true }
    }));
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch (err) { return; }
      if (m.id !== id) return;
      clearTimeout(timer);
      try { ws.close(); } catch (err) {}
      resolve(m.result && m.result.result ? m.result.result.value : undefined);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('WS 错误')); };
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PROBE = "JSON.stringify({ gate: !!document.querySelector('.provider-gate'), card: !!document.querySelector('.usage-summary'), kids: (document.querySelector('.app-content')||{children:[]}).children.length, title: document.title })";

(async () => {
  let list = await httpGetJson('http://127.0.0.1:' + PORT + '/json/list');
  const page = list.filter((t) => t.type === 'page')[0];
  console.log('目标: ' + page.title + ' ' + String(page.url).slice(0, 70));
  await ev(page.webSocketDebuggerUrl, 'location.reload(); "reloading"', 1).catch((e) => console.log('reload 调用: ' + e.message));
  await sleep(300);
  for (let i = 0; i < 16; i += 1) {
    try {
      list = await httpGetJson('http://127.0.0.1:' + PORT + '/json/list');
      const p = list.filter((t) => t.type === 'page')[0];
      const out = await ev(p.webSocketDebuggerUrl, PROBE, 100 + i);
      console.log('t+' + ((i + 1) * 450) + 'ms → ' + out);
    } catch (e) {
      console.log('t+' + ((i + 1) * 450) + 'ms → 读取失败: ' + e.message);
    }
    await sleep(450);
  }
})();
