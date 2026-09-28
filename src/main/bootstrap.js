const { app, dialog, shell } = require('electron');
const storeModule = require('./store');
const { runStoreBootstrap } = require('./core/startup-recovery');
const { pruneUsageDaily, pruneDshPushUsage } = require('./core/usage-retention');
const { assertRendererBuild } = require('./core/renderer-entry');

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  /* 第二份实例:不是崩溃,是本应用**只允许一份**(单实例锁,按 userData 生效)。
     以前这里静默退出 —— 用户视角是"双击图标没反应、闪一下就没了",排查时也会
     把它误判成端口冲突(实测踩过两次:调试实例全部无声消失,日志停在 DevTools 那行)。
     现在:① 打一行日志说明原因;② 由**持锁的那份**把已有窗口唤到前台(见 second-instance)。 */
  console.log('[bootstrap] second instance detected: focusing the existing window and exiting');
  app.isQuitting = true;
  app.quit();
} else {
  // 第二份被拒时,已运行的那份会收到本事件 ⇒ 把窗口唤到前台,双击立刻有反馈
  app.on('second-instance', () => {
    try {
      const { BrowserWindow } = require('electron');
      const win = BrowserWindow.getAllWindows()[0];
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      if (!win.isVisible()) win.show();
      win.focus();
    } catch (_) { /* 聚焦失败不影响主流程 */ }
  });
  app.whenReady()
    .then(() => {
      assertRendererBuild();
      return runStoreBootstrap({
        app,
        dialog,
        shell,
        storeModule,
        afterInitialize: () => {
          pruneUsageDaily(storeModule);
          pruneDshPushUsage(storeModule);
        },
        loadMain: () => require('./index'),
        logger: console
      });
    })
    .catch((error) => {
      const details = error && error.code === 'RENDERER_BUILD_MISSING'
        ? { code: 'RENDERER_BUILD_MISSING', action: 'npm run build:renderer' }
        : { code: 'BOOTSTRAP_FAILED' };
      console.error('[bootstrap]', JSON.stringify(details));
      app.isQuitting = true;
      app.quit();
    });
}
