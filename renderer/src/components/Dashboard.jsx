// 平台视图容器:单平台详情(纯纵向信息流)与「全部」跨平台总览。
//
// 历史:这里曾经是 gridstack 布局编辑器(拖拽 / 缩放 / 布局持久化 + 组件注册表 + 编辑模式)。
// 用户要求移除旧的跨平台聚合视图后,新总览(ProviderOverview)取代了它 ——
// 那套 grid 机制(约 250 行)连同编辑模式一并删除,本文件只剩两条渲染路径。
import React from 'react';
import { send } from '../api.js';
import { useDashboard, useProviders } from '../store.js';
import { providerLabel } from '../lib/providers-meta.js';
import { useSelectedProvider } from '../selection.js';
import FeeCard from './FeeCard.jsx';
import QuotaCard from './QuotaCard.jsx';
import TokenHeatmap from './TokenHeatmap.jsx';
import ProviderBar from './ProviderBar.jsx';
import UsageSummaryCard from './UsageSummaryCard.jsx';
import ProviderOverview from './ProviderOverview.jsx';

// DeepSeek 专属三卡(余额 / 今日消耗 / 缓存命中率):只在选中 DeepSeek 时出现,
// 与其他平台无关 —— 之前它们永远显示,用户选了 opencode 还满屏 DS,体感就是"选择没生效"。
const FEE_IDS = ['balance-card', 'today-cost-card', 'cache-rate-card'];

function FeeWidget({ id }) {
  const dashboard = useDashboard('deepseek');
  return (
    <FeeCard
      id={id}
      balance={dashboard ? dashboard.balance : null}
      stats={dashboard ? dashboard.stats : null}
    />
  );
}

export default function Dashboard() {
  const providers = useProviders();
  // 全局选中平台:null = 「全部」⇒ 跨平台总览(不再是可编辑的聚合网格)
  const [selected] = useSelectedProvider();
  if (!selected) return <ProviderOverview />;

  // 单平台视图:只放该平台相关的东西,不拿别的平台凑数。
  //   · 用量汇总(今日/本周/本月三行,分母规则见 window-percent)
  //   · 该平台每日 Token 柱(ProviderBar 按平台过滤)
  //   · 该平台热力图(页签锁定,不再提供第二套筛选)
  //   · codex/kimi 的额度卡(有数据源才出现)
  //   · 选中 DeepSeek 时附带它的余额三卡(余额/今日消耗/缓存命中率是 DS 专属口径)
  const label = providerLabel(selected);
  const provider = providers.find((p) => p && p.id === selected);
  const showQuota = !!provider && (selected === 'codex' || selected === 'kimi');
  const showFees = selected === 'deepseek';

  return (
    <div className="content single-provider">
      <div className="component-surface single-provider-card">
        <UsageSummaryCard />
      </div>
      {showFees ? (
        <div className="single-provider-fees">
          {FEE_IDS.map((id) => (
            <div key={id} className="component-surface fee-card-surface">
              <FeeWidget id={id} />
            </div>
          ))}
        </div>
      ) : null}
      <div className="component-surface">
        <div className="component-title">{label} 每日 Token 消耗</div>
        <ProviderBar provider={selected} />
      </div>
      <div className="component-surface embed-surface">
        <TokenHeatmap provider={selected} lockProvider />
      </div>
      {showQuota ? (
        <div className="component-surface embed-surface">
          <QuotaCard
            provider={provider}
            quotaState={provider.quota}
            authStatus={provider.authStatus}
            quotaFetchedAt={provider.quotaFetchedAt}
            onRetry={() => send('refresh:dashboard')}
          />
        </div>
      ) : null}
    </div>
  );
}
