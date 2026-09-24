// 标题栏:退回按钮 + 刷新/设置/最小化/关闭。
// 关闭按钮行为与旧版一致(隐藏到托盘 = window:minimize)。
//
// **这里刻意不做服务商切换控件**:标题栏只有 34px 高,放一排标签在默认的 420px 窗口里
// 必然挤成一串认不出的色点;而单平台视图卡片里本来就有个带名字的下拉(展示平台)——
// 同一个动作放两处,除了重复没有任何好处。切换入口统一收敛到:
//   · 卡片里的「展示平台 ▾」(当前平台、全部平台都在里面)
//   · 左下角这个 ‹ 退回服务商列表,列表就是"上一级"
import React, { useState } from 'react';
import { send, toggleMini } from '../api.js';

export default function TitleBar({
  // 布局编辑已按用户要求移除(聚合网格删除后编辑模式没有作用对象)
  listOpen, onBack
}) {
  const [spinning, setSpinning] = useState(false);
  const [gearTap, setGearTap] = useState(false);

  const onRefresh = () => {
    send('refresh:dashboard');
    setSpinning(true);
  };
  const onSettings = () => {
    send('open:settings');
    setGearTap(true);
  };

  return (
    <div className="titlebar">
      <div className="titlebar-left">
        <span className="titlebar-logo" aria-hidden="true">
          <svg viewBox="0 0 108 120" width="100%" height="100%">
            <rect x="0" y="0" width="32" height="32" rx="7" fill="#C3E2F9" />
            <rect x="38" y="0" width="32" height="32" rx="7" fill="#8FC6F3" />
            <rect x="76" y="0" width="32" height="32" rx="7" fill="#61ABEC" />
            <rect x="38" y="38" width="32" height="38" rx="7" fill="#79B9F0" />
            <rect x="38" y="82" width="32" height="38" rx="7" fill="#6DB3EE" />
          </svg>
        </span>
        <span className="titlebar-text">Token Monitor</span>
        {/* 退回上一级:只在详情页出现(首页就是列表,没有可退的地方) */}
        {!listOpen ? (
          <button
            type="button"
            className="titlebar-back"
            title="返回服务商列表"
            aria-label="返回服务商列表"
            onClick={onBack}
          >
            ‹
          </button>
        ) : null}
      </div>
      <div className="titlebar-actions">
        <button
          className={'titlebar-btn' + (spinning ? ' spin-refresh' : '')}
          title="立即刷新"
          onClick={onRefresh}
          onAnimationEnd={() => setSpinning(false)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" /></svg>
        </button>
        <button
          className={'titlebar-btn' + (gearTap ? ' spin-gear' : '')}
          title="设置"
          onClick={onSettings}
          onAnimationEnd={() => setGearTap(false)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
        </button>
        <button
          className="titlebar-btn"
          title="迷你模式"
          aria-label="迷你模式"
          onClick={toggleMini}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 14 10 14 10 20" /><polyline points="20 10 14 10 14 4" /><line x1="14" y1="10" x2="21" y2="3" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
        </button>
        <button className="titlebar-btn" title="最小化" onClick={() => send('window:minimize')}>
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M3 8.5a.75.75 0 0 1 .75-.75h8.5a.75.75 0 0 1 0 1.5h-8.5A.75.75 0 0 1 3 8.5z" /></svg>
        </button>
        <button className="titlebar-btn" title="关闭" onClick={() => send('window:minimize')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </button>
      </div>
    </div>
  );
}
