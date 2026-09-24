// 当前选中平台的会话级共享状态:首屏「选服务商」选完 → 主界面卡片与迷你窗自动跟随。
//
// 为什么不用设置项持久化:需求是"启动先到首屏再选",每次启动都重新问一遍;
// 若把选择写进 settings,就会出现"首屏问一次、下次又拿旧值覆盖"的两套真相。
// 所以只活在本次运行内,null = 未选(卡片按「全部」视图)。
import { useEffect, useState } from 'react';

let current = null;
const listeners = new Set();

export function getSelectedProvider() {
  return current;
}

// 未知平台(id 不在集合内)一律当未选,避免首屏把脏值写进来导致卡片空白
export function setSelectedProvider(id) {
  const next = id ? String(id) : null;
  if (next === current) return next;
  current = next;
  listeners.forEach((listener) => {
    try {
      listener(current);
    } catch (e) {
      // 单个订阅者抛错不能连累其他订阅者(与项目内其他广播一致)
    }
  });
  return current;
}

export function subscribeSelection(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// 仅测试用:把会话状态清回未选
export function __resetSelection() {
  current = null;
  listeners.clear();
}

export function useSelectedProvider() {
  const [value, setValue] = useState(current);
  useEffect(() => subscribeSelection(setValue), []);
  return [value, setSelectedProvider];
}
