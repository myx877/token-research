const MAIN_WINDOW_UNAVAILABLE = 'MAIN_WINDOW_UNAVAILABLE';

function isUsableWindow(win) {
  if (!win) return false;
  if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return false;
  return true;
}

function ensureMainWindow(options) {
  let mainWindow = options.getMainWindow();
  if (!isUsableWindow(mainWindow)) {
    options.createMainWindow();
    mainWindow = options.getMainWindow();
  }

  if (!isUsableWindow(mainWindow)) {
    const error = new Error('Main window was not created');
    error.code = MAIN_WINDOW_UNAVAILABLE;
    throw error;
  }

  return mainWindow;
}

function wakeWindow(win) {
  if (!isUsableWindow(win)) return null;

  if (
    typeof win.isMinimized === 'function'
    && win.isMinimized()
    && typeof win.restore === 'function'
  ) {
    win.restore();
  }
  if (typeof win.show === 'function') win.show();
  if (typeof win.focus === 'function') win.focus();
  return win;
}

function wakeMostRelevantWindow(options) {
  const getters = [
    options.getMainWindow,
    options.getLoginWindow,
    options.getSettingsWindow
  ];

  for (const getWindow of getters) {
    if (typeof getWindow !== 'function') continue;
    const win = getWindow();
    if (isUsableWindow(win)) return wakeWindow(win);
  }
  return null;
}

// 启动开窗决策(纯函数,不依赖 electron,可直测)
//
// 背景:此前启动以「有没有 DeepSeek API Key」作为开窗门槛 —— 没 Key 只弹填 Key 窗,
// 有 Key 但没平台 session 时又自动弹平台登录窗,两道墙把人挡在主界面外。
// 现在:主窗恒开(免凭证启动),凭证一律按需补录。
//   main          主窗是否创建 —— 恒为 true
//   apiKeyWindow  是否把「填 API Key 窗」当启动门槛 —— 恒为 false(降级为按需入口)
//   sessionWindow 是否在启动时自动弹「平台登录窗」 —— 恒为 false(托盘 / session:relogin 按需)
//   balancePoll   有 API Key 才轮询余额(无 Key 不发必然失败的请求)
//   usagePoll     有平台 session 才轮询官方用量
function hasText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

function decideStartupWindows(options) {
  const opts = options || {};
  const hasApiKey = hasText(opts.apiKey);
  const hasSession = hasText(opts.sessionToken);

  return {
    main: true,
    apiKeyWindow: false,
    sessionWindow: false,
    balancePoll: hasApiKey,
    usagePoll: hasSession
  };
}

function skipDeepseekLogin(options) {
  const mainWindow = ensureMainWindow(options);
  if (typeof mainWindow.show === 'function') mainWindow.show();
  if (typeof mainWindow.focus === 'function') mainWindow.focus();

  const loginWindow = options.getLoginWindow();
  if (isUsableWindow(loginWindow) && typeof loginWindow.close === 'function') {
    loginWindow.close();
  }

  return mainWindow;
}

module.exports = {
  MAIN_WINDOW_UNAVAILABLE,
  decideStartupWindows,
  ensureMainWindow,
  isUsableWindow,
  skipDeepseekLogin,
  wakeMostRelevantWindow,
  wakeWindow
};
