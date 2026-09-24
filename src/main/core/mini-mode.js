// 迷你模式:缩小主窗口,默认显示当前平台的 今日/本周/本月 用量进度条
// (可切回旧的额度圆环 + Token 速度视图,见 window.miniStyle)。
// 进入前先把正常 bounds 落盘(persistBounds 注入),迷你期间 persistMainWindowBounds
// 改写 window.miniBounds(见 index.js),退出时从 window.x/y/width/height 恢复。
// 尺寸按"三条进度条 + 悬停明细槽位"重新量过:195×156 塞不下三行(第三行会被截断)。
const MINI_WIDTH = 250;
const MINI_HEIGHT = 216;
const NORMAL_MIN_WIDTH = 380;
const NORMAL_MIN_HEIGHT = 200;

function finiteInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function sanitizeBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') return null;
  const x = finiteInt(bounds.x);
  const y = finiteInt(bounds.y);
  const width = finiteInt(bounds.width);
  const height = finiteInt(bounds.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (width < MINI_WIDTH || height < MINI_HEIGHT) return null;
  return { x, y, width, height };
}

function createMiniMode(options) {
  const opts = options || {};
  const store = opts.store;
  const getMainWindow = opts.getMainWindow || (() => null);
  const getEdgeDock = opts.getEdgeDock || (() => null);
  const tokenSpeedRuntime = opts.tokenSpeedRuntime || null;
  const broadcastSettings = opts.broadcastSettings || (() => {});
  const persistBounds = opts.persistBounds || (() => {});
  const onToggled = opts.onToggled || (() => {});

  let savedZoom = null;
  // 窗口尺寸的缓动时长。为什么自己插值:Electron 的 `setBounds(bounds, animate)` 只在 macOS 生效,
  // Windows 上仍是一次硬跳变 —— 用户体感就是"缩小成悬浮窗很僵硬"(实测反馈)。
  // 260ms:200ms 反馈"有点太快",再长就拖沓。
  // 测试传 0 让它同步生效,保持断言确定性。
  const animateMs = Number.isFinite(Number(opts.animateMs)) && Number(opts.animateMs) >= 0
    ? Number(opts.animateMs)
    : 260;
  let tweenToken = 0;

  // 把窗口从当前 bounds 缓动到 target(ease-out cubic),结束再跑 onDone。
  // Windows 上"改约束"与"设尺寸"存在竞态,所以末帧之后要**校验**尺寸是否真的到位。
  function animateBounds(win, target, onDone) {
    const token = ++tweenToken;
    const from = win.getBounds();
    const startedAt = Date.now();
    const easeOut = (k) => 1 - Math.pow(1 - k, 3);
    let lastStepAt = startedAt;
    const step = () => {
      if (token !== tweenToken) return;   // 被新的动画取代(连点缩小/放大)
      const w = liveWindow();
      if (!w) return;
      const stepAt = Date.now();
      const lateMs = stepAt - lastStepAt - 16;
      lastStepAt = stepAt;
      // 主进程的迟帧不会体现在渲染层的帧时间线里(渲染层可能仍然 60fps),
      // 但用户看到的是**窗口在卡**。所以要在这里自己留证据:哪一步被拖慢了多少。
      if (lateMs > 60) console.warn('[mini] 窗口缓动被拖慢 ' + lateMs + 'ms(第 ' + (stepAt - startedAt) + 'ms 处)');
      const elapsed = stepAt - startedAt;
      const t = animateMs <= 0 ? 1 : Math.min(1, elapsed / animateMs);
      const k = easeOut(t);
      const box = {
        x: Math.round(from.x + (target.x - from.x) * k),
        y: Math.round(from.y + (target.y - from.y) * k),
        width: Math.round(from.width + (target.width - from.width) * k),
        height: Math.round(from.height + (target.height - from.height) * k)
      };
      w.setBounds(box);
      if (t < 1) {
        setTimeout(step, 16);
        return;
      }
      const now = w.getBounds();
      if (now.width !== target.width || now.height !== target.height) {
        w.setBounds(target);
        setTimeout(() => {
          const late = liveWindow();
          if (late) late.setBounds(target);
        }, 32);
      }
      if (typeof onDone === 'function') onDone(w);
    };
    step();
  }

  // 迷你模式强制 zoom=1:用户 Ctrl+滚轮缩放会被 Chromium 按站点持久化,
  // 0.7 的缩放逐字会让 180×134 的窗口塞进 257px 视口,内容缩成一团显得"窗口太大"。
  // 退出时恢复原缩放。
  function applyMiniZoom(win) {
    try {
      const wc = win.webContents;
      if (!wc) return;
      if (savedZoom === null) savedZoom = wc.getZoomFactor();
      if (savedZoom !== 1) wc.setZoomFactor(1);
    } catch (_) { /* webContents 未就绪等,忽略 */ }
  }

  function restoreZoom(win) {
    try {
      const wc = win.webContents;
      if (wc && savedZoom !== null) wc.setZoomFactor(savedZoom);
      savedZoom = null;
    } catch (_) { /* 忽略 */ }
  }

  function isActive() {
    return !!store && store.get('window.miniMode') === true;
  }

  function liveWindow() {
    const win = getMainWindow();
    return win && !win.isDestroyed() ? win : null;
  }

  /* 副作用分两段,这是"丝滑"的关键:
     · applySideEffects():速度采样、托盘菜单 —— 立刻生效,和视觉无关;
     · notifyRenderer():settings 广播 → 渲染层切换视图 —— **必须等窗口缓动结束**(见 animateBounds 的 onDone)。
       否则窗口还在缩、内容已经换成小窗的,观感是"先换内容、再缩窗口"的两段式(用户反馈:还是不够丝滑)。 */
  function applySideEffects() {
    if (tokenSpeedRuntime && typeof tokenSpeedRuntime.applySettings === 'function') {
      tokenSpeedRuntime.applySettings();
    }
    onToggled();
  }

  function notifyRenderer() {
    broadcastSettings();
  }

  function enter() {
    const win = liveWindow();
    if (!win) return false;
    // 贴边停靠状态下直接缩窗会把隐藏坐标卷进来,先解除停靠
    const dock = getEdgeDock();
    if (dock && typeof dock.getDockMeta === 'function' && dock.getDockMeta()) {
      try { dock.disable(); } catch (_) { /* 忽略,继续进入迷你模式 */ }
    }
    // 正常模式 bounds 先落盘,退出时原样恢复
    persistBounds();
    store.set('window.miniMode', true);
    win.setMinimumSize(MINI_WIDTH, MINI_HEIGHT);
    // 窗口太小,原生缩放的边缘热区很容易被抓到:迷你模式禁用缩放,防止误拖把窗口撑大
    win.setResizable(false);
    const current = win.getBounds();
    // 位置记忆、尺寸始终取当前 MINI 规格(旧版本留下的大尺寸记忆不再沿用)
    const remembered = sanitizeBounds(store.get('window.miniBounds'));
    const target = {
      x: remembered ? remembered.x : current.x,
      y: remembered ? remembered.y : current.y,
      width: MINI_WIDTH,
      height: MINI_HEIGHT
    };
    /* 上限必须**动画结束后**才收紧到 MINI 规格:setMaximumSize 会立刻把超限的窗口压到上限,
       先收紧就等于取消了动画(窗口在动画开始前就被压成迷你尺寸)。
       动画期间把上限放到"当前尺寸",结束时再锁成 MINI,才能既动得起来、又保证任何路径都撑不大。

       缩放(zoom)与视图切换也一起放到结束时:它们是"小窗形态"的一部分,
       提前生效会在动画起点就把内容重排一次,等于又引入一次跳变。 */
    win.setMaximumSize(Math.max(current.width, MINI_WIDTH), Math.max(current.height, MINI_HEIGHT));
    animateBounds(win, target, () => {
      const w = liveWindow();
      if (!w) return;
      w.setMaximumSize(MINI_WIDTH, MINI_HEIGHT);
      applyMiniZoom(w);
      notifyRenderer();
      // 速度采样 + 托盘菜单放到动画之后,而且再让出一拍:
      // 它们会阻塞主进程(实测 >120ms),夹在动画中间会让缓动**只跑出第一帧就跳到终点**
      // —— 用户看到的就是"切换的一瞬间卡壳"。
      setTimeout(applySideEffects, 0);
    });
    return true;
  }

  function exit() {
    const win = liveWindow();
    if (!win) return false;
    // 迷你模式也可能处于停靠收起状态:恢复正常 bounds 前先解除
    const dock = getEdgeDock();
    if (dock && typeof dock.getDockMeta === 'function' && dock.getDockMeta()) {
      try { dock.disable(); } catch (_) { /* 忽略,继续退出 */ }
    }
    store.set('window.miniMode', false);
    win.setResizable(true);
    // 上限先放开(往大处长,放开上限不会触发任何强制尺寸)
    win.setMaximumSize(2400, 1600);
    const current = win.getBounds();
    const target = {
      x: finiteInt(store.get('window.x')) ?? current.x,
      y: finiteInt(store.get('window.y')) ?? current.y,
      width: finiteInt(store.get('window.width')) || NORMAL_MIN_WIDTH,
      height: finiteInt(store.get('window.height')) || NORMAL_MIN_HEIGHT
    };
    /* 两件事都必须在动画**结束后**做:
       (a) setMinimumSize(380,200) 会立刻把小于下限的窗口撑大 ⇒ 先设就等于取消动画;
       (b) 尺寸竞态(见 animateBounds 末帧的校验)。
       注意别在这里"先设一次再修正":Windows 上 setMaximumSize 的生效与随后的 setBounds 有竞态,
       实测会把窗口钳在旧的 250×216 上限上,留下"完整视图 + 迷你尺寸"的死局(踩过)。 */
    animateBounds(win, target, () => {
      const w = liveWindow();
      if (!w) return;
      w.setMinimumSize(NORMAL_MIN_WIDTH, NORMAL_MIN_HEIGHT);
      // 缩放与视图切换同理放到最后(见 enter 的说明)
      restoreZoom(w);
      notifyRenderer();
      setTimeout(applySideEffects, 0);
    });
    return true;
  }

  function toggle() {
    return isActive() ? !exit() : enter();
  }

  // 启动时迷你模式被持久化:窗口按迷你尺寸/位置创建
  function applyOnCreate(win) {
    if (!win || !isActive()) return false;
    win.setMinimumSize(MINI_WIDTH, MINI_HEIGHT);
    win.setMaximumSize(MINI_WIDTH, MINI_HEIGHT);
    win.setResizable(false);
    const remembered = sanitizeBounds(store.get('window.miniBounds'));
    const current = win.getBounds();
    win.setBounds({
      x: remembered ? remembered.x : current.x,
      y: remembered ? remembered.y : current.y,
      width: MINI_WIDTH,
      height: MINI_HEIGHT
    });
    return true;
  }

  return { isActive, toggle, enter, exit, applyOnCreate, applyMiniZoom, restoreZoom };
}

module.exports = {
  createMiniMode,
  MINI_WIDTH,
  MINI_HEIGHT,
  NORMAL_MIN_WIDTH,
  NORMAL_MIN_HEIGHT
};
