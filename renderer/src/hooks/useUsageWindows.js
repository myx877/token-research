// 单平台「今日 / 本周 / 本月」窗口数据:卡片与迷你窗共用同一份取数与刷新逻辑。
//
// 为什么必须共享:两个视图显示的是同一组数字,若各写一份取数,就会出现
// "卡片刷新了、小窗还是旧值"这类无法解释的不一致,也会让口径(保留窗口披露)漂移。
import { useCallback, useEffect, useState } from 'react';
import { getUsageWindows, onProvidersChanged } from '../api.js';

const EMPTY = { windows: [], retention: null, error: null };

export default function useUsageWindows(provider) {
  const [state, setState] = useState(EMPTY);

  const load = useCallback(() => {
    if (!provider) {
      setState(EMPTY);
      return;
    }
    getUsageWindows({ provider: provider })
      .then((data) => {
        setState({
          windows: (data && data.windows) || [],
          retention: (data && data.retention) || null,
          error: (data && data.error) || null
        });
      })
      .catch((e) => {
        setState({ windows: [], retention: null, error: (e && e.message) || String(e) });
      });
  }, [provider]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => onProvidersChanged(load), [load]);

  return {
    windows: state.windows,
    retention: state.retention,
    error: state.error,
    reload: load
  };
}
