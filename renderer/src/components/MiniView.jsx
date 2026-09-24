// 迷你模式视图:顶部为当前平台下拉 + 两种视图(用量进度条 / 占比圆环),
// 贴边吸附收起后切换为竖条速度柱(柱子越高速度越快),竖条上双击恢复完整模式。
import React, { useEffect, useRef, useState } from 'react';
import { useProviders } from '../store.js';
import useTokenSpeed from '../hooks/useTokenSpeed.js';
import { on, send, toggleMini, getEdgeDockState, getSettings, saveSetting } from '../api.js';
import MiniUsageView from './MiniUsageView.jsx';
import MiniShareRing from './MiniShareRing.jsx';
import useUsageWindows from '../hooks/useUsageWindows.js';
import useCredentials from '../hooks/useCredentials.js';
import { readyProviderIds } from '../lib/provider-credentials.mjs';
import { useSelectedProvider } from '../selection.js';
import { allProviderIds, orderProviders } from '../lib/providers-meta.js';
import { PROVIDER_META } from '../lib/token-speed-chart.js';
import { formatCurrencyAmount } from '../fee-card-money.mjs';

const MINI_STYLE_USAGE = 'usage';
const MINI_STYLE_SHARE = 'share';
const MINI_STYLE_ORDER = [MINI_STYLE_USAGE, MINI_STYLE_SHARE];
// 视图切换按钮的"下一个视图"提示(两种视图循环)
const NEXT_STYLE_LABEL = {
  [MINI_STYLE_USAGE]: '切换到占比圆环视图',
  [MINI_STYLE_SHARE]: '切换到用量进度条视图'
};

function readMiniStyle(settings) {
  const raw = settings && settings.window && settings.window.miniStyle;
  // 「额度圆环 + 速度」视图已按用户要求删除:旧值(rings)一律回落到用量进度条
  return raw === MINI_STYLE_SHARE ? MINI_STYLE_SHARE : MINI_STYLE_USAGE;
}

// (旧的 readMiniStyle 已合并到上方:小窗只剩「用量进度条」与「占比圆环」两种视图)


// 额度圆环视图已按用户要求删除:相关常量(RING_*/INNER_*/KIMI_INNER_COLOR)一并移除

// 额度圆环视图已删除:quotaWindowOf / fracOf 不再需要
// (环形的"剩余比例"曾在这里算过一次;现在小窗只有用量进度条与占比圆环两种视图)

// 额度圆环视图已删除:Arc / Ring / RowInfo 三个辅助组件一并移除
// (它们引用的 RING_*/INNER_*/KIMI_INNER_COLOR 常量也已删除)

// 贴边收起后的竖条:每个平台一条胶囊形轨道(上下半圆端,透明底透出亚克力),
// 底部彩色填充高度 ∝ 当前速度;固定刻度 1000.0K/min = 100%,超出按满格计。
// 注意可见区在窗口的"靠屏内侧":右缘停靠时窗口向右滑出,屏上露出的是窗口的
// 左 12px,竖条必须画在窗口左侧;左缘停靠反之;顶缘收起露出窗口底部。
function SpeedStrip({ edge, rates, onRestore }) {
  const FULL_SCALE = 1000000; // 1000.0K/min = 100%
  const values = ['deepseek', 'codex', 'kimi'].map((pid) => Number(rates[pid]) || 0);
  const horizontal = edge === 'top';
  const side = edge === 'right' ? 'left' : edge === 'left' ? 'right' : 'top';
  return (
    <div className={'mini-strip mini-strip-' + side} onClick={onRestore}>
      {['deepseek', 'codex', 'kimi'].map((pid, i) => {
        const pct = Math.min(100, Math.round((values[i] / FULL_SCALE) * 100)) + '%';
        return (
          <div key={pid} className="mini-strip-bar">
            <div
              className="mini-strip-fill"
              style={horizontal
                ? { background: PROVIDER_META[pid].color, width: pct }
                : { background: PROVIDER_META[pid].color, height: pct }}
            />
          </div>
        );
      })}
    </div>
  );
}

export default function MiniView({ onBackToHome }) {
  const providers = useProviders();
  // 额度圆环视图删除后,小窗不再需要 DeepSeek 余额(这里曾每轮白拉一次 dashboard)
  const speed = useTokenSpeed();
  const [dock, setDock] = useState(null);
  // 小窗口内容:默认「用量进度条」(当前平台 今日/本周/本月),可切回旧的「额度圆环」。
  // 设置项 window.miniStyle 落盘,重启保持;切换即刻生效(本地 state + 广播)。
  const [style, setStyle] = useState(MINI_STYLE_USAGE);
  const lastClickAt = useRef(0);

  // 「占比」视图的当前平台:与 MiniUsageView 同一规则(全局选择 > 已就绪 > 兜底第一项)。
  // MiniUsageView 的下拉每次选择都会写回全局,所以这里读全局就够 —— 两个视图不会各看一个平台。
  const credential = useCredentials();
  const [globalPick] = useSelectedProvider();
  const readyIds = readyProviderIds(allProviderIds(), credential);
  const fallbackIds = orderProviders(allProviderIds().concat((providers || []).map((p) => p && p.id)));
  const shareProvider = globalPick || readyIds[0] || fallbackIds[0];
  const shareData = useUsageWindows(shareProvider);

  useEffect(() => {
    let active = true;
    getSettings().then((s) => {
      if (active) setStyle(readMiniStyle(s));
    }).catch(() => {});
    const off = on('settings:loaded', (s) => setStyle(readMiniStyle(s)));
    return () => {
      active = false;
      if (typeof off === 'function') off();
    };
  }, []);

  const toggleStyle = () => {
    const index = MINI_STYLE_ORDER.indexOf(style);
    const next = MINI_STYLE_ORDER[(index + 1) % MINI_STYLE_ORDER.length];
    setStyle(next);
    saveSetting('window.miniStyle', next).catch(() => {});
  };

  // 挂载时拉一次停靠快照(广播只在状态变化时推送),之后跟随变化
  useEffect(() => {
    let active = true;
    getEdgeDockState().then((s) => {
      if (active && s) setDock(s);
    }).catch(() => {});
    const off = on('edge-dock:state', (s) => setDock(s || null));
    return () => {
      active = false;
      if (typeof off === 'function') off();
    };
  }, []);

  // 收起竖条上的双击恢复(竖条无拖拽区,点击事件可达)
  const onClickRestore = () => {
    const now = Date.now();
    if (now - lastClickAt.current < 350) {
      lastClickAt.current = 0;
      toggleMini();
    } else {
      lastClickAt.current = now;
    }
  };

  const rawRates = {};
  (speed && Array.isArray(speed.providers) ? speed.providers : []).forEach((p) => {
    if (p && p.providerId) rawRates[p.providerId] = p.tokensPerMinute;
  });
  // 逐平台速率文案(旧圆环视图用)已删除:贴边竖条直接用 rawRates

  // 吸附收起:整窗只留竖条速度柱
  if (dock && dock.state === 'collapsed') {
    return <SpeedStrip edge={dock.edge} rates={rawRates} onRestore={onClickRestore} />;
  }

  const byId = {};
  (Array.isArray(providers) ? providers : []).forEach((p) => {
    if (p && p.id) byId[p.id] = p;
  });
  // 余额展示随圆环视图一起删除

  return (
    <div className="mini-view">
      <div className="mini-titlebar">
        <span className="mini-titlebar-text">Token Monitor</span>
        <div className="mini-titlebar-actions">
          <button
            className="mini-title-btn"
            title={NEXT_STYLE_LABEL[style] || '切换视图'}
            aria-label={NEXT_STYLE_LABEL[style] || '切换视图'}
            onClick={toggleStyle}
          >
            {style === MINI_STYLE_USAGE ? (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="8" /><path d="M12 12 L12 4 A8 8 0 0 1 19 16" /></svg>
            ) : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="4" y1="7" x2="20" y2="7" /><line x1="4" y1="12" x2="20" y2="12" /><line x1="4" y1="17" x2="20" y2="17" /></svg>
            )}
          </button>
          <button className="mini-title-btn" title="放大至完整窗口" aria-label="放大至完整窗口" onClick={toggleMini}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" /><line x1="21" y1="3" x2="14" y2="10" /><line x1="3" y1="21" x2="10" y2="14" /></svg>
          </button>
          <button className="mini-title-btn" title="最小化" aria-label="最小化" onClick={() => send('window:minimize')}>
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M3 8.5a.75.75 0 0 1 .75-.75h8.5a.75.75 0 0 1 0 1.5h-8.5A.75.75 0 0 1 3 8.5z" /></svg>
          </button>
          <button className="mini-title-btn" title="关闭(退至托盘)" aria-label="关闭" onClick={() => send('window:minimize')}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
          </button>
        </div>
      </div>
      {style === MINI_STYLE_USAGE ? <MiniUsageView onBackToHome={onBackToHome} /> : null}
      {style === MINI_STYLE_SHARE ? <MiniShareRing windows={shareData.windows} /> : null}
      {/* 「额度圆环 + 速度」视图已按用户要求删除(余额/Codex 周额度/Kimi 双环 + 速度) */}
    </div>
  );
}
