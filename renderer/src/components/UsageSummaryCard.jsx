// 用量汇总卡:两种视图由顶部平台选择器切换。
//   全部  → 跨平台表格:日 / 自然周(ISO 8601,周一起) / 自然月 × provider 的 token 与金额。
//   单平台 → 窗口卡:今日 / 本周 / 本月三行,每行 = 标签 + 已用百分比 + 重置倒计时 + 进度条 + token/金额。
// 百分比只按用户在设置里填的预算算;没填预算就不显示百分比(绝不编分母)。
// 数据来自主进程只读聚合(get:usage-summary / get:usage-windows),日键在读取时归桶,不新增持久化键。
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { getUsageSummary, onProvidersChanged, replaceApiKey, send } from '../api.js';
import { formatCurrencyAmount } from '../fee-card-money.mjs';
import CustomSelect from './CustomSelect.jsx';
import { formatCountdown, formatTokenCount } from '../lib/format.js';
import { addBeijingDays, beijingDayKey } from '../lib/beijing-calendar.js';
import { allProviderIds, orderProviders, providerColor, providerLabel } from '../lib/providers-meta.js';
import { resolveWindowPercent } from '../lib/window-percent.mjs';
import { percentText, windowHeadline, windowBudgetText, MODE_TOKENS } from '../lib/window-headline.mjs';
import { windowCostDisplay, windowCostTitle } from '../lib/window-cost.mjs';
import { credentialNoticeFor } from '../lib/provider-credentials.mjs';
import { apiKeyErrorText, apiKeyProblem } from '../lib/api-key-format.mjs';
import { useSelectedProvider } from '../selection.js';
import { useProviders } from '../store.js';
import useCredentials from '../hooks/useCredentials.js';
import useUsageWindows from '../hooks/useUsageWindows.js';

// days = 回看天数(按北京结算日回退),与桶粒度匹配的紧凑窗口
const BUCKETS = [
  { id: 'day', label: '日', days: 7 },
  { id: 'week', label: '周', days: 8 * 7 },
  { id: 'month', label: '月', days: 6 * 31 }
];

const ALL = 'all';

// 凭证提示的判定已收敛到 lib/provider-credentials.mjs(首屏、卡片、标题栏标签栏共用一份),
// 这里只负责把判定结果渲染出来 —— 三处各写一份判定迟早会出现"选择页说已配置、标签栏里却没有它"。
// DeepSeek API Key 的预检与失败文案见 lib/api-key-format.mjs(首屏共用同一份)。

// 历史保留窗口(设置 → 历史数据保留)短于展示周期时,该周期的数字只覆盖最近 N 天。
// 必须在卡片上挑明口径,否则「本月」看起来像整月、实际是残缺值(实测可差一个量级)。
function retentionHintText(retention, windows) {
  const days = Number(retention && retention.historyDays);
  if (!Number.isInteger(days) || days <= 0) return null;
  const truncated = (windows || []).filter((w) => w && w.truncated);
  if (truncated.length === 0) return null;
  const labels = truncated.map((w) => '「' + w.label + '」').join('');
  return '历史只保留 ' + days + ' 天,' + labels + '仅统计近 ' + days +
    ' 天;在「设置 → 历史数据保留」改为更大值后点「同步历史」即可补齐';
}

function moneyText(row) {
  const cost = Number(row.cost) || 0;
  return cost > 0 ? formatCurrencyAmount(row.currency, cost.toFixed(2)) : '—';
}

function cellTokens(row) {
  return row ? formatTokenCount(row.total) : '';
}

// 百分比展示:保留 1 位小数,整数不拖 .0(50% 而不是 50.0%)—— 实现已挪到 lib/window-headline.mjs

// 单平台窗口行:标签 + 主数字徽章 + 重置倒计时 + 进度条 + 总量/金额 + 命中/输入/输出明细。
// resolved = { percent, basis }:分母可能来自平台真实额度或用户预算(决议见 lib/window-percent.mjs),
// basis 决定徽章旁那句"分母是什么"以及是否显示预算数字 —— 不写清楚来源的百分比是不负责任的。
//
// 主数字由 lib/window-headline.mjs 决议:
//   · 分母是 **Token 预算** ⇒ 条上先说 token 数(百分比退成右边的小字)
//   · 分母是金额预算 / 平台额度 ⇒ 保持百分比(它们量的不是 token)
const BASIS_LABEL = { quota: '额度', budget: '预算' };

function basisTitle(win, basis) {
  if (basis === 'quota') return '分母:平台真实额度';
  return win && win.budgetBasis === 'tokens' ? '分母:你设置的 Token 预算' : '分母:你设置的金额预算';
}

function UsageWindowRow({ win, now, resolved, retention, shareBase }) {
  const percent = resolved ? resolved.percent : null;
  const basis = resolved ? resolved.basis : null;
  const hasDenominator = percent !== null && percent !== undefined;
  /* 两种条:
     · **有分母**(平台额度 / 预算)⇒ 条 = 已用比例,徽章给百分比,红=超额;
     · **没分母** ⇒ 条 = 本窗口 token 占"三个窗口里最大的那个"的比例(用户要的"绿色代表实际用了多少 token"),
       条上**不出现任何百分比数字** —— 红线第 9 条:没有分母就不显示百分比;这里是"对比条",不是百分比条。 */
  const share = shareBase > 0 ? Math.min(100, (Number(win.total) || 0) / shareBase * 100) : 0;
  const hasBar = hasDenominator || share > 0;
  const fill = hasDenominator ? Math.min(100, Math.max(0, percent)) : share;
  const head = windowHeadline(win, resolved, formatTokenCount);
  const budgetText = windowBudgetText(win, formatTokenCount, formatCurrencyAmount);
  // 超额只看**真实的百分比 >100**,不拿封顶后的条宽判断(否则"刚好用满预算"会被误标红)。
  // 判据统一收在 lib/window-headline.mjs 里,卡片与小窗共用同一个 over。
  const over = hasDenominator && head.over;
  const cost = windowCostDisplay(win);
  const shareTitle = '本行 ' + formatTokenCount(Number(win.total) || 0) + ' Token;'
    + '绿色长度 = 占三个窗口最大值的 ' + Math.round(share) + '%(只作横向对比,不是预算、也不是平台额度)';
  return (
    <div className={'usage-window' + (over ? ' usage-window-over' : '')}>
      <div className="usage-window-head">
        <span className="usage-window-label">{win.label}</span>
        {/* 口径残缺(历史被保留窗口裁过)**就写在这一行上**,不再单开一条横幅:
            红线第 10 条要求"在卡片上直接写出限制",行内角标同样满足,而且不吵。
            完整解释(复用 retentionHintText 的同一份措辞)放 title,鼠标停上去能看全。 */}
        {win.truncated && retention && Number(retention.historyDays) > 0 ? (
          <span className="usage-window-partial" title={retentionHintText(retention, [win]) || ''}>
            仅近 {Number(retention.historyDays)} 天
          </span>
        ) : null}
        {/* 徽章只在**真有分母**时出现(它展示的是百分比)。没有分母时条照画(对比条),
            但**绝不显示百分比数字** —— 红线第 9 条。 */}
        {hasDenominator ? (
          <>
            <span
              className={'usage-window-badge' + (over ? ' over' : '') + (head.mode === MODE_TOKENS ? ' tokens' : '')}
              title={basisTitle(win, basis) + ' · 已用 ' + percentText(percent)}
            >
              {head.primary}
              <span className="usage-window-basis">{BASIS_LABEL[basis]}</span>
            </span>
            {/* token 分母时,百分比退到这里 —— 主数字已经是 token 数,两个都留着才判得了"超没超" */}
            {head.secondary ? <span className="usage-window-percent-sub">{head.secondary}</span> : null}
          </>
        ) : null}
        <span className="usage-window-reset">{formatCountdown(win.resetsAt, now)}</span>
      </div>
      {hasBar ? (
        <div className="usage-window-bar" title={hasDenominator ? undefined : shareTitle}>
          <div className={'usage-window-fill' + (over ? ' over' : '')} style={{ width: fill + '%' }} />
        </div>
      ) : null}
      <div className="usage-window-figures">
        <span className="usage-window-tokens">{formatTokenCount(win.total)} Token</span>
        {hasDenominator && basis === 'budget' && budgetText ? (
          <span className="usage-window-budget">{budgetText}</span>
        ) : null}
        {/* 金额钉在条下面那行的最右端(即「条的右下角」):
            真实账单优先;codex/kimi 没有真实账单,回落到订阅费摊薄估算并加 ≈;
            金额为 0 也照样显示 —— 隐藏 0 会被读成"费用功能坏了"而不是"今天没花钱"。 */}
        {cost ? (
          <span
            className={'usage-window-cost' + (cost.estimated ? ' estimated' : '')}
            title={windowCostTitle(win, cost)}
          >
            {cost.text}
          </span>
        ) : null}
      </div>
      <div className="usage-window-breakdown" aria-label={win.label + ' token 明细'}>
        <span className="usage-window-hit">命中 {formatTokenCount(win.cached)}</span>
        <span className="usage-window-in">输入 {formatTokenCount(win.input)}</span>
        <span className="usage-window-out">输出 {formatTokenCount(win.output)}</span>
      </div>
    </div>
  );
}

// 凭证态提示块:选中平台缺什么就在这里就地补什么。
//   api-key   → 内联输入(提交行为见下一小类:校验通过才保存并刷新)
//   session   → 「登录平台」按需触发(会话窗口,不再启动即弹)
//   local-cli → 本机 CLI 凭证缺失/过期的原因 + 立即重试
function CredentialNotice({ notice, providerName, apiKeyDraft, apiKeyError, apiKeySubmitting, onApiKeyDraftChange, onSaveApiKey, onRelogin, onRetry }) {
  if (!notice) return null;
  if (notice.kind === 'api-key') {
    return (
      <div className="usage-cred">
        <div className="usage-cred-text">
          未配置 {providerName} API Key:当前只统计本机日志;填入后可读官方余额与用量
        </div>
        <div className="usage-cred-row">
          <input
            className="usage-cred-input"
            type="password"
            placeholder="sk-..."
            aria-label={providerName + ' API Key'}
            value={apiKeyDraft}
            disabled={apiKeySubmitting}
            onChange={(e) => onApiKeyDraftChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') onSaveApiKey(); }}
          />
          <button className="usage-cred-btn" onClick={onSaveApiKey} disabled={apiKeySubmitting}>
            {apiKeySubmitting ? '校验中…' : '保存并验证'}
          </button>
        </div>
        {apiKeyError ? <div className="usage-cred-error">{apiKeyError}</div> : null}
      </div>
    );
  }
  if (notice.kind === 'session') {
    return (
      <div className="usage-cred">
        <div className="usage-cred-text">
          已配置 API Key(可读余额);官方用量需要登录 {providerName} 平台
        </div>
        <button className="usage-cred-btn" onClick={onRelogin}>登录平台</button>
      </div>
    );
  }
  return (
    <div className="usage-cred">
      <div className="usage-cred-text">{notice.hint}</div>
      <button className="usage-cred-btn" onClick={onRetry}>立即重试</button>
    </div>
  );
}

export default function UsageSummaryCard() {
  const [bucket, setBucket] = useState('day');
  const [showEstimate, setShowEstimate] = useState(false);
  // 选中平台来自会话级共享状态:首屏「选服务商」选完这里自动跟随,
  // 卡片内的选择器也写回同一个 store(null = 「全部」)。
  const [pickedProvider, setPickedProvider] = useSelectedProvider();
  const selected = pickedProvider || ALL;
  const single = selected !== ALL;
  const onSelectPlatform = useCallback(
    (value) => setPickedProvider(value === ALL ? null : value),
    [setPickedProvider]
  );
  const providers = useProviders();
  const [state, setState] = useState({ rows: [], totals: null, providers: [], retention: null, error: null });
  // 倒计时每分钟刷新一次(所有行共用一个 tick,不逐行起定时器)
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  const spec = BUCKETS.find((item) => item.id === bucket) || BUCKETS[0];
  const to = beijingDayKey();
  const from = addBeijingDays(to, -(spec.days - 1));

  const load = useCallback(() => {
    getUsageSummary({ bucket: bucket, from: from, to: to })
      .then((data) => {
        setState({
          rows: (data && data.rows) || [],
          totals: (data && data.totals) || null,
          providers: (data && data.providers) || [],
          retention: (data && data.retention) || null,
          error: (data && data.error) || null
        });
      })
      .catch((e) => {
        setState({ rows: [], totals: null, providers: [], retention: null, error: (e && e.message) || String(e) });
      });
  }, [bucket, from, to]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => onProvidersChanged(load), [load]);

  // 单平台窗口数据(与迷你窗同一份 hook):只在选中平台时取,选「全部」不打扰
  const windowData = useUsageWindows(single ? selected : null);
  const loadWindows = windowData.reload;

  // 凭证态:API Key 是否已配(settings 里的非敏感标记)+ 平台登录态 + 各平台 authStatus。
  // 取数与刷新时机收敛在 hooks/useCredentials.js,渲染层拿不到任何密钥明文。
  const credentialState = useCredentials();
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [apiKeySubmitting, setApiKeySubmitting] = useState(false);
  const [apiKeyError, setApiKeyError] = useState(null);

  // 保存并验证:先本地把关(明显非法一律不发请求)→ 主进程 fetchBalance 校验
  // → 通过才落盘并刷新卡片;失败只显示错误,store 不动。
  const saveApiKey = useCallback(() => {
    const problem = apiKeyProblem(apiKeyDraft);
    if (problem) {
      setApiKeyError(problem);
      return;
    }
    setApiKeySubmitting(true);
    setApiKeyError(null);
    replaceApiKey(apiKeyDraft.trim()).then(
      () => {
        setApiKeyDraft('');
        loadWindows();
        send('refresh:dashboard');
      },
      (error) => setApiKeyError(apiKeyErrorText(error))
    ).then(() => setApiKeySubmitting(false));
  }, [apiKeyDraft, loadWindows]);

  // 平台清单 = 全部受支持平台 ∪ 数据里出现过的平台(顺序按展示元数据,选择器位置稳定),
  // 不因"当期恰好没数据"就把某个平台藏起来——每个平台都能选中并看到同一套窗口卡
  const providerOptions = useMemo(() => {
    const ids = orderProviders(allProviderIds().concat(state.providers || []));
    if (selected !== ALL && ids.indexOf(selected) < 0) ids.push(selected);
    return [[ALL, '全部']].concat(ids.map((id) => [id, providerLabel(id)]));
  }, [state.providers, selected]);

  // 行为周期(最新在前),列为有数据的 provider
  const view = useMemo(() => {
    const periods = [];
    const byPeriod = {};
    const providerIds = [];
    state.rows.forEach((row) => {
      if (!byPeriod[row.bucketKey]) {
        byPeriod[row.bucketKey] = {};
        periods.push(row.bucketKey);
      }
      byPeriod[row.bucketKey][row.provider] = row;
      if (providerIds.indexOf(row.provider) < 0) providerIds.push(row.provider);
    });
    periods.sort().reverse();
    return { periods: periods, byPeriod: byPeriod, providerIds: orderProviders(providerIds) };
  }, [state.rows]);

  const totals = state.totals || null;
  const money = totals
    ? Object.keys(totals.costByCurrency || {}).map((code) => (
      formatCurrencyAmount(code, Number(totals.costByCurrency[code]).toFixed(2))
    )).join(' · ')
    : '';
  // 估算按币种分别展示:每个 provider 的订阅月费币种不同,合计不能相加成一个数
  const estimate = showEstimate && totals
    ? Object.keys(totals.estimatedByCurrency || {}).map((code) => (
      '≈' + formatCurrencyAmount(code, Number(totals.estimatedByCurrency[code]).toFixed(2))
    )).join(' · ')
    : '';

  const windows = windowData.windows || [];
  // 平台额度(codex/kimi 有官方 weekly 额度)→ 本周进度条用真实分母;没有则回落预算。
  const quota = useMemo(() => {
    const hit = (providers || []).find((p) => p && p.id === selected);
    return hit ? hit.quota : null;
  }, [providers, selected]);
  const windowPercent = useCallback(
    (win) => resolveWindowPercent({ windowKey: win.key, quota: quota, budgetPercent: win.percent }),
    [quota]
  );
  // 口径披露不再单开横幅:受影响的行自己带一个角标(见 UsageWindowRow)。
  const retention = windowData.retention;
  // 没有分母时的"token 对比条"基准:三个窗口里最大的那个当满格。
  // 这样"今天用了多少"一眼可见,而且不需要用户填任何预算(用户明确要求过"不要预算、只要 token 统计")。
  const shareBase = windows.reduce((max, w) => Math.max(max, Number(w.total) || 0), 0);
  /* 「全部」视图的口径披露:本桶**最早显示的那一行**的周期起点早于保留起点,
     且库里确实没有更早的数据 ⇒ 那几行只覆盖保留窗口内的用量。
     两个坑都踩过:
       · 判据不能拿"卡片固定的回看起点"比(它是 7/56/186 天,与保留设置无关),否则保留 90 天也会误报;
         要比的是**实际显示出来的最早周期**(旧实现比的就是显示周期,我改错过一次,被 harness 抓住)。
       · 也不能只比设置(还要看 earliestDay):点过「同步历史」补齐历史的用户,数字已是整段,不该再挂提示。
     披露**不只针对月桶**:日桶回看 7 天、周桶 56 天,保留设成 3/7 天时它们同样残缺 ——
     以前只披露月桶,等于让日/周两桶"看起来是整段、实际被裁过"(审查发现,违反红线第 10 条)。 */
  const tableRetentionHint = (() => {
    const retention = state.retention;
    if (!retention || !retention.startDay || view.periods.length === 0) return null;
    if (retention.earliestDay && retention.earliestDay < retention.startDay) return null;
    const oldest = view.periods[0];
    const cut = bucket === 'day'
      ? oldest < retention.startDay
      : bucket === 'week'
        ? (retention.startWeek ? oldest <= retention.startWeek : false)
        : (oldest + '-01') < retention.startDay;
    if (!cut) return null;
    const noun = bucket === 'day' ? '日期' : bucket === 'week' ? '周' : '月份';
    return '历史只保留 ' + retention.historyDays + ' 天,' + retention.startDay +
      ' 之前的' + noun + '行只统计保留窗口内的用量;在「设置 → 历史数据保留」改大后点「同步历史」即可补齐';
  })();
  // 注:这里曾有一条"未设预算 → 只显示用量与金额;在设置 → 预算里填…"的常驻提示。
  // 用户要求删掉这类常驻横幅 —— 「无分母」徽章本身已经说明了状态,
  // "去哪儿填"挪进了徽章的悬停说明(见 UsageWindowRow),信息不丢、界面不吵。

  // 选中平台缺什么凭证:缺就明说。本机口径数据不受影响,照常显示 ——
  // 凭据没就绪只影响"官方额度/余额"这条分母,不影响三条进度条出数,所以这里只提示不拦截。
  const credentialNotice = useMemo(
    () => (selected === ALL ? null : credentialNoticeFor(selected, credentialState)),
    [selected, credentialState]
  );

  return (
    <div className="usage-summary">
      <div className="usage-summary-head">
        <CustomSelect
          ariaLabel="展示平台"
          value={selected}
          options={providerOptions}
          onChange={onSelectPlatform}
        />
        {!single ? (
          <div className="heatmap-modes">
            {BUCKETS.map((item) => (
              <button
                key={item.id}
                className={'heatmap-tab' + (bucket === item.id ? ' active' : '')}
                onClick={() => setBucket(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
        ) : (
          <span className="usage-summary-single-title">
            <span className="usage-summary-dot" style={{ background: providerColor(selected) }} />
            {providerLabel(selected)}
          </span>
        )}
        {!single ? (
          <label className="usage-summary-toggle">
            <input
              type="checkbox"
              checked={showEstimate}
              onChange={(e) => setShowEstimate(e.target.checked)}
            />
            估算
          </label>
        ) : null}
      </div>

      {state.error ? <div className="usage-summary-error">读取失败:{state.error}</div> : null}
      {single && windowData.error ? (
        <div className="usage-summary-error">读取失败:{windowData.error}</div>
      ) : null}

      {single ? (
        <>
          {windows.length === 0 ? (
            <div className="usage-summary-empty">暂无用量数据</div>
          ) : (
            <div className="usage-window-list">
              {/* 口径残缺不再单开横幅,改成受影响那一行上的行内角标(见 UsageWindowRow 的 usage-window-partial) */}
              {windows.map((win) => (
                <UsageWindowRow
                  key={win.key}
                  win={win}
                  now={now}
                  resolved={windowPercent(win)}
                  retention={retention}
                  shareBase={shareBase}
                />
              ))}
            </div>
          )}
          <CredentialNotice
            notice={credentialNotice}
            providerName={providerLabel(selected)}
            apiKeyDraft={apiKeyDraft}
            apiKeyError={apiKeyError}
            apiKeySubmitting={apiKeySubmitting}
            onApiKeyDraftChange={(value) => {
              setApiKeyDraft(value);
              if (apiKeyError) setApiKeyError(null);
            }}
            onSaveApiKey={saveApiKey}
            onRelogin={() => send('session:relogin')}
            onRetry={() => send('refresh:dashboard')}
          />
        </>
      ) : view.periods.length === 0 ? (
        <div className="usage-summary-empty">暂无用量数据</div>
      ) : (
        <>
          {tableRetentionHint ? (
            <div className="usage-window-hint retention">{tableRetentionHint}</div>
          ) : null}
          <table className="usage-summary-table">
          <thead>
            <tr>
              <th>{bucket === 'day' ? '日期' : bucket === 'week' ? '周' : '月份'}</th>
              {view.providerIds.map((id) => (
                <th key={id}>
                  <span className="usage-summary-dot" style={{ background: providerColor(id) }} />
                  {providerLabel(id)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.periods.map((period) => (
              <tr key={period}>
                <td className="usage-summary-period">{period}</td>
                {view.providerIds.map((id) => {
                  const row = view.byPeriod[period][id];
                  if (!row) return <td key={id} className="usage-summary-empty-cell">·</td>;
                  const estimate = Number(row.estimatedCost) || 0;
                  return (
                    <td key={id} className="usage-summary-cell">
                      <span className="usage-summary-tokens">{cellTokens(row)}</span>
                      <span className="usage-summary-money">{moneyText(row)}</span>
                      {showEstimate && estimate > 0 ? (
                        <span className="usage-summary-est">
                          ≈{formatCurrencyAmount(row.currency, estimate.toFixed(2))}
                        </span>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td className="usage-summary-period">合计</td>
              <td className="usage-summary-total" colSpan={Math.max(1, view.providerIds.length)}>
                {formatTokenCount(totals ? totals.total : 0)} Token
                {money ? ' · ' + money : ''}
                {estimate ? ' · ' + estimate : ''}
              </td>
            </tr>
          </tfoot>
        </table>
        </>
      )}
    </div>
  );
}
