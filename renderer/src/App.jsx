import React, { useCallback, useEffect, useRef, useState } from 'react';
import TitleBar from './components/TitleBar.jsx';
import StatusBar from './components/StatusBar.jsx';
import Dashboard from './components/Dashboard.jsx';
import MiniView from './components/MiniView.jsx';
import ProviderGate from './components/ProviderGate.jsx';
import { setSelectedProvider, useSelectedProvider } from './selection.js';
import { initProviders } from './store.js';
import { getSettings, on, send, toggleMini } from './api.js';
import { allProviderIds } from './lib/providers-meta.js';
import { installSettingsOpenBridge } from './settings-bridge.js';
import { installThemeSync } from './theme-sync.js';
import { installLayoutResetSync } from './layout-reset-sync.js';

initProviders();

// 上次看的平台落盘键。放在 data.* 下(settings:update 白名单里 data. 前缀本就允许),
// 不新增专用 IPC;值 '' = 上次看的是「全部」。
const LAST_PROVIDER_KEY = 'data.lastProvider';

function readMiniMode(settings) {
  return !!(settings && settings.window && settings.window.miniMode === true);
}

export default function App() {
  // 布局编辑 / 布局锁定已移除(聚合网格删除后没有作用对象)
  const [dashboardGeneration, setDashboardGeneration] = useState(0);
  const [miniMode, setMiniMode] = useState(false);
  // 首页(服务商列表) / 详情 两态。主界面就是首页,所以启动默认落在列表上;
  // 记住上次平台时直接进详情(见下面的恢复逻辑)。
  const [listOpen, setListOpen] = useState(true);
  // 全局选中平台:列表、标签栏、卡片下拉读写同一份;null = 「全部」。
  const [selected] = useSelectedProvider();

  // 进详情:选中平台 + 关掉列表,+ 记住这次选择(下次启动直接落回这里)。
  // 凭证没就绪的平台**不在这里拦截** —— 它的本机日志数据照常出数,
  // 详情页顶部会给黄条说明;把用户赶回列表是把"官方额度不可用"错当成"没数据"。
  const openProvider = useCallback((providerId) => {
    setSelectedProvider(providerId);
    setListOpen(false);
    send('settings:update', { key: LAST_PROVIDER_KEY, value: providerId || '' });
  }, []);

  const backToList = useCallback(() => setListOpen(true), []);

  // 小窗里的退回:先回首页,再退出迷你模式 —— 否则"退回"会退到一个 250×216 的列表上
  const backToHomeFromMini = useCallback(() => {
    setListOpen(true);
    toggleMini();
  }, []);

  // 启动恢复"上次看的平台"。只认受支持的平台 id(脏值/远古值一律当作没记过),
  // 但**不校验凭据**:凭据失效只影响官方额度,详情页会自己说明。
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    getSettings().then((settings) => {
      const last = settings && settings.data && settings.data.lastProvider;
      if (!last || allProviderIds().indexOf(last) < 0) return;
      setSelectedProvider(last);
      setListOpen(false);
    }).catch(() => {});
  }, []);

  // 迷你模式状态:启动读一次,之后跟随设置广播(主进程切换后推送 settings:loaded)
  useEffect(() => {
    let active = true;
    getSettings().then((s) => {
      if (active) setMiniMode(readMiniMode(s));
    }).catch(() => {});
    const off = on('settings:loaded', (s) => setMiniMode(readMiniMode(s)));
    return () => {
      active = false;
      if (typeof off === 'function') off();
    };
  }, []);

  useEffect(() => installSettingsOpenBridge(on, send), []);

  useEffect(() => installThemeSync({
    getSettings,
    on,
    mediaQuery: window.matchMedia('(prefers-color-scheme: dark)'),
    root: document.documentElement,
    body: document.body,
    onWindowFocusState: (cb) => on('window:focus-state', cb),
    dispatchThemeApplied: (theme) => window.dispatchEvent(
      new CustomEvent('tokenmonitor:theme-applied', { detail: { theme } })
    )
  }), []);

  // 布局锁定已移除;重置通道保留(设置重置后重建 Dashboard)
  useEffect(() => installLayoutResetSync({
    getSettings,
    on,
    onReset: () => setDashboardGeneration((generation) => generation + 1)
  }), []);

  // ctrl + 滚轮缩放(与旧版 app.js 行为一致):走主进程 zoom factor
  // 迷你模式禁用(主进程侧同样有守卫)
  useEffect(() => {
    const onWheel = (e) => {
      if (e.ctrlKey && !miniMode) {
        e.preventDefault();
        send('zoom:change', { delta: e.deltaY < 0 ? 0.1 : -0.1 });
      }
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, [miniMode]);

  // 布局编辑已移除(见上)

  // 缩放已由系统原生处理(resizable: true),不再渲染应用层 ResizeHandles
  // 迷你模式无标题栏(双击微缩窗口或托盘菜单恢复);key 切换触发淡入过渡,
  // 遮住窗口缩放与内容重排之间的一帧闪烁
  return (
    <div id="app" className={miniMode ? 'app-mini' : ''}>
      {!miniMode ? (
        <TitleBar
          listOpen={listOpen}
          onBack={backToList}
        />
      ) : null}
      <div className="app-content" key={miniMode ? 'mini' : (listOpen ? 'list' : 'full')}>
        {miniMode ? (
          <MiniView onBackToHome={backToHomeFromMini} />
        ) : listOpen ? (
          <ProviderGate selected={selected} onPick={openProvider} />
        ) : (
          <>
            <Dashboard key={dashboardGeneration} />
            <StatusBar />
          </>
        )}
      </div>
    </div>
  );
}
