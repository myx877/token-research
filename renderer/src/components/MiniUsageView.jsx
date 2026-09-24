// 小窗口的「用量进度条」视图:只显示当前所选平台的 今日 / 本周 / 本月。
//
// 需求要点:
//   · 简洁:只有平台标识 + 三条进度条,不带任何别的卡片内容。
//   · 悬停出明细:鼠标停在某条进度条上,这一行原地展开 命中 / 输入 / 输出。
//     明细槽位常驻占高(hover 只切透明度),所以悬停不会引起布局跳动 —— 小窗口里
//     任何跳动都会让人以为窗口在抖。
//   · 分母与卡片完全同源:平台真实额度优先、其次预算、都没有就不显示百分比。
//   · 换平台受**凭据就绪白名单**约束(与标题栏标签栏同一份判定):
//     正在看的平台即便跌出白名单也留在下拉里(不能把用户的选择吞掉),
//     但下拉里能主动切过去的只有在白名单内的。
import React, { useEffect, useState } from 'react';
import CustomSelect from './CustomSelect.jsx';
import { useProviders } from '../store.js';
import { useSelectedProvider } from '../selection.js';
import useCredentials from '../hooks/useCredentials.js';
import useUsageWindows from '../hooks/useUsageWindows.js';
import { allProviderIds, orderProviders, providerColor, providerLabel } from '../lib/providers-meta.js';
import { readyProviderIds } from '../lib/provider-credentials.mjs';
import { resolveWindowPercent, breakdownText } from '../lib/window-percent.mjs';
import { percentText, windowHeadline, MODE_TOKENS } from '../lib/window-headline.mjs';
import { windowCostDisplay, windowCostTitle } from '../lib/window-cost.mjs';
import { formatCountdown, formatTokenCount } from '../lib/format.js';
import { formatCurrencyAmount } from '../fee-card-money.mjs';

function MiniUsageRow({ win, now, quota, shareBase }) {
  const resolved = resolveWindowPercent({ windowKey: win.key, quota: quota, budgetPercent: win.percent });
  const percent = resolved.percent;
  const hasDenominator = percent !== null;
  /* 与大卡同一套两种条:有分母 ⇒ 已用比例(带百分比徽章);没分母 ⇒ token 对比条(不显示任何百分比)。
     用户要求小窗也能看到"绿色代表实际用了多少 token",所以这里不能因为没分母就不画。 */
  const share = shareBase > 0 ? Math.min(100, (Number(win.total) || 0) / shareBase * 100) : 0;
  const hasBar = hasDenominator || share > 0;
  const fill = hasDenominator ? Math.min(100, Math.max(0, percent)) : share;
  // 主数字与大卡同一决议点(lib/window-headline.mjs):token 分母时先说 token 数
  const head = windowHeadline(win, resolved, formatTokenCount);
  // 超额同一判据:看真实百分比 >100,不拿封顶后的条宽比
  const over = hasDenominator && head.over;
  // 明细文案复用 lib/window-percent.mjs 的 breakdownText —— 原来这里自己又 join 了一遍,
  // 两处一旦格式分叉,小窗和大卡的"命中/输入/输出"就会长得不一样(审查发现)。
  const detail = breakdownText(win, formatTokenCount);
  const basis = resolved.basis === 'quota' ? '平台额度' : '预算';
  const cost = windowCostDisplay(win);
  return (
    <div className={'mini-usage-row' + (over ? ' over' : '')}>
      <div className="mini-usage-head">
        <span className="mini-usage-label">{win.label}</span>
        {/* 徽章展示的是百分比 ⇒ 只在**真有分母**时出现;没有分母时条照画,但不给任何数字 */}
        {hasDenominator ? (
          <>
            <span className={'mini-usage-badge' + (over ? ' over' : '') + (head.mode === MODE_TOKENS ? ' tokens' : '')}>
              {head.primary}
            </span>
            {head.secondary ? <span className="mini-usage-percent-sub">{head.secondary}</span> : null}
          </>
        ) : null}
        <span className="mini-usage-reset">{formatCountdown(win.resetsAt, now)}</span>
      </div>
      {hasBar ? (
        <div
          className="mini-usage-bar"
          title={hasDenominator
            ? percentText(percent) + '(' + basis + ')' + ' · ' + detail + ' · ' + formatTokenCount(win.total) + ' Token'
            : '绿色长度 = 占三个窗口最大值的 ' + Math.round(share) + '%(只作对比,不是预算/额度) · ' + detail}
          aria-label={win.label + ' ' + detail}
        >
          <div className={'mini-usage-fill' + (over ? ' over' : '')} style={{ width: fill + '%' }} />
        </div>
      ) : null}
      <div className="mini-usage-detail">{detail}</div>
      <div className="mini-usage-figures">
        <span>{formatTokenCount(win.total)} Token</span>
        {cost ? (
          <span className={'mini-usage-cost' + (cost.estimated ? ' estimated' : '')} title={windowCostTitle(win, cost)}>
            {cost.text}
          </span>
        ) : null}
      </div>
    </div>
  );
}

export default function MiniUsageView({ onBackToHome }) {
  const providers = useProviders();
  const credential = useCredentials();
  const [globalPick, setGlobalPick] = useSelectedProvider();
  // 全局未选时(只可能出现在"没记过上次平台"的极早期),小窗口自己挑一个显示,
  // 但不改全局状态 —— 否则"开一下小窗"会把主界面从「全部」悄悄切走。
  const [localPick, setLocalPick] = useState(null);
  const readyIds = readyProviderIds(allProviderIds(), credential);
  const fallbackIds = orderProviders(allProviderIds().concat((providers || []).map((p) => p && p.id)));
  const active = globalPick || localPick || readyIds[0] || fallbackIds[0];
  const windowData = useUsageWindows(active);
  const [now, setNow] = useState(() => Date.now());

  // 倒计时每分钟刷新(与卡片同一节奏,但迷你窗只需要一个 tick)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  const quotaProvider = (providers || []).find((p) => p && p.id === active);
  const quota = quotaProvider ? quotaProvider.quota : null;
  const windows = windowData.windows || [];
  // 没有分母时的对比基准:三个窗口里最大的那个当满格(与大卡同口径)
  const shareBase = windows.reduce((max, w) => Math.max(max, Number(w.total) || 0), 0);
  const onPick = (value) => { setLocalPick(value); setGlobalPick(value); };
  // 正在看的平台即使跌出白名单也要留在下拉里,否则下拉会显示一个"不在列表里的值"
  const optionIds = !active || readyIds.indexOf(active) >= 0 ? readyIds : [active].concat(readyIds);

  return (
    <div className="mini-usage">
      <div className="mini-usage-top">
        <button
          type="button"
          className="mini-usage-back"
          title="回到服务商列表"
          aria-label="回到服务商列表"
          onClick={onBackToHome}
        >
          ‹
        </button>
        <span className="mini-usage-dot" style={{ background: providerColor(active) }} />
        <CustomSelect
          ariaLabel="当前服务商"
          value={active}
          options={optionIds.map((id) => [id, providerLabel(id)])}
          onChange={onPick}
        />
      </div>
      {windowData.error ? (
        <div className="mini-usage-empty">读取失败:{windowData.error}</div>
      ) : windows.length === 0 ? (
        <div className="mini-usage-empty">暂无用量数据</div>
      ) : (
        windows.map((win) => (
          <MiniUsageRow key={win.key} win={win} now={now} quota={quota} shareBase={shareBase} />
        ))
      )}
    </div>
  );
}
