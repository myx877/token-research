// 小窗「占比」视图:当前平台 命中 / 输入 / 输出 三桶占比(圆环)+ 三个窗口的 token。
//
// 口径与详情页完全一致(同一个 useUsageWindows 数据源,不新增取数):
//   命中 = 缓存读取(cached)、输入 = 未命中输入、输出 = 生成;三者之和 = 该窗口 total。
// **只画当前平台**:从总览或列表选了哪个平台,这里就是哪个 —— 不混任何其它平台。
//
// 颜色:绿色在本项目专指"已用比例"(AGENTS.md 第 12 条),所以三桶一律不上绿。
import React, { useMemo, useState } from 'react';
import { formatTokenCount } from '../lib/format.js';

const BUCKETS = [
  { key: 'cached', label: '命中', color: '#74b8fc' },
  { key: 'input', label: '输入', color: '#9aa4b2' },
  { key: 'output', label: '输出', color: '#e0a165' }
];

const RING_R = 26;
const RING_C = 2 * Math.PI * RING_R;

export default function MiniShareRing({ windows }) {
  const list = Array.isArray(windows) ? windows : [];
  // 默认看「本月」(最稳定、最完整);点底部三个窗口可切换
  const [windowKey, setWindowKey] = useState('month');
  const win = list.find((w) => w && w.key === windowKey) || list[0] || null;

  const segments = useMemo(() => {
    const parts = BUCKETS.map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      color: bucket.color,
      value: Number(win && win[bucket.key]) || 0
    }));
    const sum = parts.reduce((acc, part) => acc + part.value, 0);
    let offset = 0;
    return {
      sum: sum,
      parts: parts.map((part) => {
        const fraction = sum > 0 ? part.value / sum : 0;
        const length = fraction * RING_C;
        const segment = Object.assign({}, part, {
          percent: fraction * 100,
          dash: length + ' ' + (RING_C - length),
          offset: -offset
        });
        offset += length;
        return segment;
      })
    };
  }, [win]);

  if (!win) {
    return <div className="mini-usage"><div className="mini-usage-empty">暂无用量数据</div></div>;
  }

  const dominant = segments.parts[0];

  return (
    <div className="mini-share">
      <div className="mini-share-ring">
        <svg viewBox="0 0 64 64" role="img"
          aria-label={'命中 ' + dominant.percent.toFixed(1) + '%,输入 ' + segments.parts[1].percent.toFixed(1)
            + '%,输出 ' + segments.parts[2].percent.toFixed(1) + '%'}>
          <circle className="mini-share-track" cx="32" cy="32" r={RING_R} />
          {segments.parts.map((segment) => (
            <circle
              key={segment.key}
              cx="32"
              cy="32"
              r={RING_R}
              fill="none"
              stroke={segment.color}
              strokeWidth="9"
              strokeDasharray={segment.dash}
              strokeDashoffset={segment.offset}
              transform="rotate(-90 32 32)"
            />
          ))}
        </svg>
        <div className="mini-share-center">
          <div className="mini-share-center-pct">{dominant.percent.toFixed(0)}%</div>
          <div className="mini-share-center-label">{dominant.label}</div>
        </div>
      </div>
      <div className="mini-share-legend">
        {segments.parts.map((segment) => (
          <div className="mini-share-row" key={segment.key}>
            <span className="mini-share-dot" style={{ background: segment.color }} />
            <span className="mini-share-name">{segment.label}</span>
            <span className="mini-share-pct">{segment.percent.toFixed(1)}%</span>
            <span className="mini-share-tokens">{formatTokenCount(segment.value)}</span>
          </div>
        ))}
      </div>
      <div className="mini-share-windows">
        {list.map((item) => (
          <button
            key={item.key}
            type="button"
            className={'mini-share-window' + (item.key === windowKey ? ' active' : '')}
            title={'看' + item.label + '的命中/输入/输出占比'}
            onClick={() => setWindowKey(item.key)}
          >
            {item.label} {formatTokenCount(item.total)}
          </button>
        ))}
      </div>
    </div>
  );
}
