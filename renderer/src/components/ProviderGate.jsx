// 首页「选服务商」:主界面就是这一页,不是登录墙。
//
// 设计要点:
//   · 主界面 = 这一页。启动落在这里,点哪个平台就进哪个平台的详情(不再有"跳过"按钮:
//     既然主界面就是选择页,"跳过,直接进入主界面"这件事在逻辑上就不存在了)。
//   · 分组是用户可见的两大类:模型平台 / 本机日志 harness(分组口径见 lib/providers-meta.js)。
//   · 点行即进:需要 Key 的(deepseek)就地输入、校验通过才落盘;其余平台点一次就进。
//     凭证缺失只提示,不拦截 —— codex/kimi 的本机日志数据照常出数,拦住他们等于把
//     "拿不到官方额度"错当成"没数据"。
//   · 凭证状态文案与卡片、标题栏标签栏共用 lib/provider-credentials.mjs 一份判定。
import React, { useCallback, useState } from 'react';
import { replaceApiKey, send } from '../api.js';
import { allProviderIds, providerGroups, providerColor, providerLabel } from '../lib/providers-meta.js';
import {
  credentialKind,
  credentialStateFor,
  providerStatusText,
  STATE_READY
} from '../lib/provider-credentials.mjs';
import { apiKeyErrorText, apiKeyProblem } from '../lib/api-key-format.mjs';
import useCredentials from '../hooks/useCredentials.js';

export default function ProviderGate({ selected, onPick }) {
  const credential = useCredentials();
  const [picked, setPicked] = useState(null);
  const [apiKeyDraft, setApiKeyDraft] = useState('');
  const [apiKeyError, setApiKeyError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  // 保存并验证:先本地预检 → 主进程 fetchBalance 校验 → 通过才落盘,失败只显示错误
  const submitApiKey = useCallback((providerId) => {
    const problem = apiKeyProblem(apiKeyDraft);
    if (problem) {
      setApiKeyError(problem);
      return;
    }
    setSubmitting(true);
    setApiKeyError(null);
    replaceApiKey(apiKeyDraft.trim()).then(
      () => {
        setApiKeyDraft('');
        setSubmitting(false);
        send('refresh:dashboard');
        onPick(providerId);
      },
      (error) => {
        setApiKeyError(apiKeyErrorText(error));
        setSubmitting(false);
      }
    );
  }, [apiKeyDraft, onPick]);

  // 点行即进:免凭证/本机凭证的平台不需要第二步确认,点一次就进详情。
  // 只有"需要 Key 且还没配"的平台才停下来要 Key(不填也能「稍后再配」先看本机日志)。
  const onPickRow = (id) => {
    setApiKeyError(null);
    if (credentialKind(id) === 'api-key' && credentialStateFor(id, credential) !== STATE_READY) {
      setPicked(id);
      return;
    }
    onPick(id);
  };

  const groups = providerGroups(allProviderIds());

  return (
    <div className="provider-gate">
      <div className="provider-gate-head">
        <div className="provider-gate-title">选择要看的服务商</div>
        <div className="provider-gate-sub">不登录也能用:每个平台都读它自己的本机日志 / 官方接口</div>
      </div>

      {/* 「全部」不放在 .provider-gate-item 里:它进的是跨平台总览,不是第 7 个平台。
          类名分开也让"六个平台"这件事在 DOM 上仍然可数。 */}
      <button
        type="button"
        className={'provider-gate-all' + (selected ? '' : ' active')}
        aria-pressed={!selected}
        onClick={() => onPick(null)}
      >
        <span className="provider-gate-all-main">
          <span className="provider-gate-name">全部平台</span>
          <span className="provider-gate-status ok">所有平台的 token 与费用总览</span>
        </span>
        <span className="provider-gate-arrow" aria-hidden="true">›</span>
      </button>

      {groups.map((group) => (
        <div key={group.id} className="provider-gate-section">
          <div className="provider-gate-section-title">{group.label}</div>
          <div className="provider-gate-list">
            {group.entries.map((entry) => {
              const id = entry.id;
              const status = providerStatusText(id, credential);
              const active = picked === id || selected === id;
              // 凭据缺失的模型平台保持可点:点进去只提示、不拦截,状态行是黄字
              return (
                <button
                  key={id}
                  type="button"
                  className={'provider-gate-item' + (active ? ' active' : '')}
                  aria-pressed={active}
                  onClick={() => onPickRow(id)}
                >
                  <span className="provider-gate-dot" style={{ background: providerColor(id) }} />
                  <span className="provider-gate-main">
                    <span className="provider-gate-name">{providerLabel(id)}</span>
                    <span className={'provider-gate-status ' + status.tone}>{status.text}</span>
                  </span>
                  <span className="provider-gate-arrow" aria-hidden="true">›</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}

      {/* 只有"需要 Key 且还没配"的平台会停在这里(目前仅 DeepSeek);
          其余平台点行已直接进入,不会走到这块面板 */}
      {picked && credentialKind(picked) === 'api-key'
        && credentialStateFor(picked, credential) !== STATE_READY ? (
        <div className="provider-gate-action">
          <div className="provider-gate-action-title">填入 {providerLabel(picked)} API Key</div>
          <div className="provider-gate-key-row">
            <input
              className="provider-gate-input"
              type="password"
              value={apiKeyDraft}
              placeholder="sk-..."
              aria-label={providerLabel(picked) + ' API Key'}
              onChange={(e) => { setApiKeyDraft(e.target.value); setApiKeyError(null); }}
              onKeyDown={(e) => { if (e.key === 'Enter') submitApiKey(picked); }}
            />
            <button
              className="provider-gate-primary"
              disabled={submitting}
              onClick={() => submitApiKey(picked)}
            >
              {submitting ? '校验中…' : '保存并验证'}
            </button>
          </div>
          {apiKeyError ? <div className="provider-gate-error">{apiKeyError}</div> : null}
          <button className="provider-gate-link" onClick={() => onPick(picked)}>
            稍后再配,先用本机日志进入
          </button>
        </div>
      ) : null}

      <div className="provider-gate-foot">
        {/* 首屏就告诉用户"百分比从哪来":真机上多数平台没有官方额度接口,
            不填预算就只会看到「无分母」——这句话把下一步直接指到设置里。 */}
        <div className="provider-gate-note">
          想让进度条显示百分比,在「设置 → 预算」里填该平台的日 / 周 / 月预算即可;
          进入某个平台后,可用卡片里的「展示平台 ▾」直接换到别的平台
        </div>
      </div>
    </div>
  );
}
