// 每日 Token 消耗(全平台堆叠柱):数据与热力图同源(get:heatmap 的 details.byProvider),
// 最近 31 天零填充;堆叠自下而上 Codex → Kimi → DeepSeek;悬浮窗仿 model-bar(加粗日期 + 圆点行 + 缓存后缀 + 合计)。
import React, { useEffect, useRef, useState } from 'react';
import useECharts from '../hooks/useECharts.js';
import { getHeatmap, onProvidersChanged } from '../api.js';
import { getBarTheme } from '../lib/chartTheme.js';
import { formatToken as formatWan } from '../lib/heatmap.js';
import { addBeijingDays, beijingDateParts, beijingDayKey } from '../lib/beijing-calendar.js';
import { barDensity, isCardMode, formatToken, windowClampedPosition } from './ChartWidget.jsx';
import { orderProviders, providerColor, providerLabel } from '../lib/providers-meta.js';

const DAYS = 31;
// 无数据时的兜底序列(保持原视觉:底部 Codex → Kimi → DeepSeek 顶部)
const FALLBACK_IDS = ['codex', 'kimi', 'deepseek'];

// 堆叠序列由数据决定:只画窗口期内真有 token 的 provider,新增平台无需改代码。
// PROVIDER_META 的顺序是「自上而下」,反转后即为堆叠顺序(数组末位在最上层,带圆角)。
// onlyId 锁定单平台时只画它(单平台视图用;没数据就画空轴,不拿别的平台凑数)。
function stackFor(details, onlyId) {
  if (onlyId && onlyId !== 'all') {
    return [{ id: onlyId, label: providerLabel(onlyId), color: providerColor(onlyId) }];
  }
  const byProvider = (details && details.byProvider) || {};
  const ids = Object.keys(byProvider).filter((id) => {
    const series = byProvider[id] || {};
    return Object.keys(series).some((date) => Number(series[date]) > 0);
  });
  const ordered = orderProviders(ids);
  const stackIds = ordered.length ? ordered.slice().reverse() : FALLBACK_IDS;
  return stackIds.map((id) => ({ id: id, label: providerLabel(id), color: providerColor(id) }));
}

function lastDays(count) {
  const today = beijingDayKey();
  const days = [];
  for (let i = count - 1; i >= 0; i--) {
    days.push(addBeijingDays(today, -i));
  }
  return days;
}

function buildOption(dom, details, dates, onlyId) {
  const isDark = document.body.classList.contains('dark');
  const t = getBarTheme(isDark);
  const byProvider = (details && details.byProvider) || {};
  const cachedByProvider = (details && details.cachedByProvider) || {};
  const density = barDensity(t, dom, isCardMode(dom));
  const stack = stackFor(details, onlyId);
  return {
    color: stack.map((p) => p.color),
    backgroundColor: 'transparent',
    textStyle: { color: t.textColor, fontSize: 10 },
    grid: density.grid,
    tooltip: {
      trigger: 'axis',
      // 挂 body 避免被模块 overflow 裁切;位置钳制在窗口内,被遮挡时向中间靠拢
      appendToBody: true,
      position: windowClampedPosition(dom),
      axisPointer: { type: 'shadow' },
      textStyle: { fontSize: 11 },
      formatter: (params) => {
        const date = params && params[0] ? dates[params[0].dataIndex] : '';
        let total = 0;
        const lookup = {};
        (params || []).forEach((p) => { total += p.value || 0; lookup[p.seriesName] = p; });
        const cachedSuffix = (pid) => {
          const c = cachedByProvider[pid] && Number(cachedByProvider[pid][date]);
          return c > 0 ? '（缓存 ' + formatWan(c) + '）' : '';
        };
        // 显示顺序与堆叠视觉一致:自上而下 DeepSeek → Kimi → Codex
        const parts = stack.slice().reverse().map((provider) => {
          const p = lookup[provider.label];
          if (!p) return '';
          return '<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + p.color + '"></span> ' + provider.label + ': ' + formatWan(p.value) + ' Token' + cachedSuffix(provider.id);
        });
        return '<b>' + (params[0] ? params[0].axisValue : '') + '</b><br/>' + parts.join('<br/>') + '<br/><b>合计: ' + formatWan(total) + ' Token</b>';
      }
    },
    xAxis: Object.assign({ type: 'category', data: dates.map((d) => d.slice(5)) }, density.xAxis),
    // density.yAxis.axisLabel 只含 show/fontSize,必须显式合并,否则 formatter 被整体覆盖丢千分位缩写
    yAxis: Object.assign({ type: 'value' }, density.yAxis, {
      axisLabel: Object.assign({ color: t.textColor, fontSize: 9, formatter: (v) => formatToken(v) }, density.yAxis.axisLabel)
    }),
    animation: true,
    series: stack.map((provider, i) => Object.assign({
      name: provider.label,
      type: 'bar',
      stack: 'total',
      // 只有堆叠顶层带圆角
      itemStyle: { borderRadius: i === stack.length - 1 ? [3, 3, 0, 0] : [0, 0, 0, 0] },
      data: dates.map((date) => (byProvider[provider.id] && Number(byProvider[provider.id][date])) || 0)
    }, density.series && density.series[i]))
  };
}

export default function ProviderBar({ provider = 'all' }) {
  const domRef = useRef(null);
  const [details, setDetails] = useState(null);
  const nowParts = beijingDateParts();
  const year = nowParts ? nowParts.year : new Date().getFullYear();
  const dates = lastDays(DAYS);

  useEffect(() => {
    getHeatmap({ provider: 'all', year: year })
      .then((data) => setDetails(data ? data.details : null))
      .catch(() => {});
  }, [year]);

  // 手动刷新/定时轮询成功后重取,与热力图保持同源同步
  useEffect(() => {
    return onProvidersChanged(() => {
      getHeatmap({ provider: 'all', year: year })
        .then((data) => setDetails(data ? data.details : null))
        .catch(() => {});
    });
  }, [year]);

  useECharts(domRef, () => buildOption(domRef.current, details, dates, provider), [details, provider]);

  return <div className="chart-container" ref={domRef} />;
}
