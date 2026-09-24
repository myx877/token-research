// 凭据快照(是否配了 API Key / 平台登录态 / 各平台 authStatus)的唯一取数处。
//
// 之前选择页、用量卡各写了一份一模一样的 Promise.all;标题栏标签栏再加一份就是三份。
// 三份的刷新时机迟早会漂移,表现为"卡片已经说已配置,标签栏里还是灰的"。
// 全部走既有只读通道,渲染层拿不到任何密钥明文(get:settings 只给 apiKeySet 标记)。
import { useCallback, useEffect, useState } from 'react';
import { getProviders, getSessionState, getSettings, on, onProvidersChanged } from '../api.js';

const EMPTY = { apiKeySet: false, loggedIn: false, statusById: {} };

export default function useCredentials() {
  const [state, setState] = useState(EMPTY);

  const load = useCallback(() => {
    Promise.all([
      getSettings().catch(() => null),
      getSessionState().catch(() => null),
      getProviders().catch(() => [])
    ]).then((results) => {
      const settings = results[0];
      const session = results[1];
      const providers = results[2];
      const ds = settings && settings.providers && settings.providers.deepseek;
      const statusById = {};
      (providers || []).forEach((p) => {
        if (p && p.id) statusById[p.id] = p.authStatus;
      });
      setState({
        apiKeySet: !!(ds && ds.apiKeySet),
        loggedIn: !!(session && session.loggedIn),
        statusById: statusById
      });
    });
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => onProvidersChanged(load), [load]);
  useEffect(() => on('session:changed', load), [load]);
  useEffect(() => on('settings:loaded', load), [load]);

  return state;
}
