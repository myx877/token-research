// 「全部」总览:所有平台一屏对比(今日 / 本周 / 本月 的 token 与费用)。
//
// 设计取舍(默认 420px 窗口):
//   · **不用饼图**:6 个平台的名字塞不进饼图图例,小窗口里扇形也比长度更难比 ——
//     改成一条**水平占比条 + 图例**,同样回答"谁占大头",还能顺带带出 token 与金额;
//   · 金额**不跨币种相加**(全项目口径):按币种分别列出,绝不合成一个数;
//   · 这里的百分比是"占当期全部平台的比重",分母恒存在 ⇒ 不会踩"编分母"那条红线,
//     它也**不冒充预算进度**(预算进度在单平台页,那里才有分母决议)。
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getUsageWindows, onProvidersChanged } from '../api.js';
import { formatCurrencyAmount } from '../fee-card-money.mjs';
import { formatTokenCount } from '../lib/format.js';
import { allProviderIds, orderProviders, providerColor, providerLabel } from '../lib/providers-meta.js';
import { setSelectedProvider } from '../selection.js';
import CustomSelect from './CustomSelect.jsx';

const WINDOW_KEYS = ['day', 'week', 'month'];
const WINDOW_LABELS = { day: '今日', week: '本周', month: '本月' };

function costOf(row) {
  if (!row || !row.currency) return '';
  return formatCurrencyAmount(row.currency, (Number(row.cost) || 0).toFixed(2));
}

// 多平台、可能多币种:每币种一段,绝不合并成一个数
function costLines(rows) {
  const byCurrency = {};
  (rows || []).forEach((row) => {
    if (!row || !row.currency) return;
    byCurrency[row.currency] = (byCurrency[row.currency] || 0) + (Number(row.cost) || 0);
  });
  return Object.keys(byCurrency)
    .map((code) => formatCurrencyAmount(code, byCurrency[code].toFixed(2)))
    .join(' · ');
}

export default function ProviderOverview() {
  const [rows, setRows] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    const ids = orderProviders(allProviderIds());
    Promise.all(ids.map((id) => getUsageWindows({ provider: id })
      .then((data) => ({ id: id, windows: (data && data.windows) || [], failed: false }))
      .catch(() => ({ id: id, windows: [], failed: true }))))
      .then((list) => {
        const failed = list.filter((entry) => entry.failed).length;
        setRows(list.map((entry) => {
          const byKey = {};
          entry.windows.forEach((win) => { byKey[win.key] = win; });
          return {
            id: entry.id,
            label: providerLabel(entry.id),
            color: providerColor(entry.id),
            day: byKey.day || null,
            week: byKey.week || null,
            month: byKey.month || null
          };
        }));
        setError(failed ? failed + ' 个平台读取失败(其余平台照常显示)' : null);
      })
      .catch((e) => setError((e && e.message) || String(e)));
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => onProvidersChanged(load), [load]);

  const totals = useMemo(() => {
    const out = {};
    WINDOW_KEYS.forEach((key) => {
      out[key] = rows.reduce((sum, row) => sum + (Number(row[key] && row[key].total) || 0), 0);
    });
    return out;
  }, [rows]);

  // 按本月 token 排名(这是"谁占大头"的视图,排名比固定顺序更好读)
  const ranked = useMemo(() => rows.slice().sort((a, b) => (
    (Number(b.month && b.month.total) || 0) - (Number(a.month && a.month.total) || 0)
  )), [rows]);

  const hasData = WINDOW_KEYS.some((key) => totals[key] > 0);

  // 总览也能直接换平台(与详情页卡片同一套下拉):选中某个平台 ⇒ 视图切到它的详情,
  // 之后再缩成悬浮窗看的就是那个平台的图(满足"小窗只看对应服务商"的要求)。
  const platformOptions = useMemo(
    () => [['all', '全部']].concat(orderProviders(allProviderIds()).map((id) => [id, providerLabel(id)])),
    []
  );
  const onPickPlatform = useCallback((value) => {
    setSelectedProvider(value === 'all' ? null : value);
  }, []);

  return (
    <div className="content provider-overview">
      <div className="overview-head">
        <span className="overview-title">所有平台总览</span>
        <CustomSelect
          ariaLabel="展示平台"
          value="all"
          options={platformOptions}
          onChange={onPickPlatform}
        />
      </div>
      <div className="component-surface overview-summary">
        {WINDOW_KEYS.map((key) => (
          <div className="overview-cell" key={key}>
            <div className="overview-cell-label">{WINDOW_LABELS[key]}</div>
            <div className="overview-cell-total">
              {formatTokenCount(totals[key])} <span className="overview-unit">Token</span>
            </div>
            <div className="overview-cell-cost">
              {costLines(rows.map((row) => row[key])) || '—'}
            </div>
          </div>
        ))}
      </div>

      <div className="component-surface overview-breakdown">
        <div className="component-title">各平台本月占比</div>
        {error ? <div className="overview-warn">部分平台读取失败:{error}</div> : null}
        {!hasData ? <div className="overview-empty">暂无用量数据</div> : null}
        {hasData ? (
          <>
            <div className="overview-share-bar">
              {ranked.map((row) => {
                const total = Number(row.month && row.month.total) || 0;
                if (!total) return null;
                const percent = totals.month > 0 ? (total / totals.month) * 100 : 0;
                return (
                  <span
                    key={row.id}
                    className="overview-share-seg"
                    style={{ width: percent + '%', background: row.color }}
                    title={row.label + ' ' + formatTokenCount(total) + ' Token(' + percent.toFixed(1) + '%)'}
                  />
                );
              })}
            </div>
            <div className="overview-legend">
              {ranked.map((row) => {
                const month = Number(row.month && row.month.total) || 0;
                const day = Number(row.day && row.day.total) || 0;
                const percent = totals.month > 0 ? (month / totals.month) * 100 : 0;
                return (
                  <div className="overview-row" key={row.id}>
                    <span className="overview-dot" style={{ background: row.color }} />
                    <span className="overview-name">{row.label}</span>
                    <span className="overview-share">{percent.toFixed(1)}%</span>
                    <span className="overview-tokens" title={'今日 ' + formatTokenCount(day) + ' Token'}>
                      {formatTokenCount(month)}
                    </span>
                    <span className="overview-cost">{costOf(row.month) || '—'}</span>
                  </div>
                );
              })}
            </div>
            <div className="overview-note">「本月」为排名与占比口径;金额按各自币种分列,不做跨币种合计。</div>
          </>
        ) : null}
      </div>
    </div>
  );
}
