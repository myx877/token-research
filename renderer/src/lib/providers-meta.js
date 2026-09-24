// provider 展示元数据唯一来源:标签、品牌色与所属分组。
// 新增 provider 时只改这里,ProviderGate / 标题栏标签栏 / 热力图筛选 / 用量汇总卡自动跟随。
//
// 分组口径(用户可见的两大类,不是内部实现细节):
//   分组依据 = **数据从哪来**,不是"要不要登录":
//   model = 模型平台:用量/余额走官方接口,必须配 API Key(目前只有 DeepSeek)
//   tool  = 工具平台:用量读本机日志 / 本机 DB,不需要账号就能出数
//           —— Codex / Kimi 也属于这一类:它们的 token 明细来自
//              ~/.codex/sessions、~/.kimi-code/sessions 的本机日志
//              (官方额度 API 只是额外的分母来源,凭证过期不影响"有数据")
export const PROVIDER_GROUPS = Object.freeze([
  { id: 'model', label: '模型平台' },
  { id: 'tool', label: '工具平台(读本机日志)' }
]);

export const PROVIDER_META = Object.freeze([
  { id: 'deepseek', label: 'DeepSeek', color: '#6E94F5', group: 'model' },
  { id: 'codex', label: 'Codex', color: '#F2A05C', group: 'tool' },
  { id: 'kimi', label: 'Kimi', color: '#4ECB94', group: 'tool' },
  { id: 'dsh', label: 'DSH', color: '#A78BFA', group: 'tool' },
  { id: 'claude', label: 'Claude Code', color: '#E8865A', group: 'tool' },
  { id: 'opencode', label: 'opencode', color: '#5BC8D8', group: 'tool' }
]);

// 兜底色(仅模块内部用:未收录的 id 走它)
const FALLBACK_COLOR = '#8A8FA3';

// 未收录进 PROVIDER_META 的 id 归入这一组(绝不丢数据:新平台冒出来时仍能显示)。
const FALLBACK_GROUP = Object.freeze({ id: 'other', label: '其它' });

function metaFor(id) {
  return PROVIDER_META.find((entry) => entry.id === id) || null;
}

export function providerLabel(id) {
  const meta = metaFor(id);
  return meta ? meta.label : String(id || '');
}

export function providerColor(id) {
  const meta = metaFor(id);
  return meta ? meta.color : FALLBACK_COLOR;
}

// 按元数据顺序排列给定的 provider id,未收录的追加在末尾(保持稳定、不丢数据)。
export function orderProviders(ids) {
  const unique = Array.from(new Set((ids || []).filter(Boolean)));
  const known = PROVIDER_META.map((m) => m.id).filter((id) => unique.indexOf(id) >= 0);
  const rest = unique.filter((id) => !metaFor(id)).sort();
  return known.concat(rest);
}

// 全部受支持的平台 id(不受"当期有没有数据"影响):用量汇总的平台选择器用它,
// 保证每个平台都能选中并看到同一套「今日 / 本周 / 本月」窗口卡。
export function allProviderIds() {
  return PROVIDER_META.map((entry) => entry.id);
}

// 按分组切分给定的 id 列表(已收录的按元数据顺序,未收录的归入末尾「其它」)。
// 顺序与分组都来自 PROVIDER_META 这一份真相,调用方不再自己写死平台清单 ——
// 清单一旦分散,迟早出现"选择页里有、标签栏里没有"的静默不一致。
export function providerGroups(ids) {
  const wanted = new Set((ids || []).filter(Boolean));
  const groups = PROVIDER_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    entries: PROVIDER_META.filter((entry) => entry.group === group.id && wanted.has(entry.id))
  }));
  const rest = Array.from(wanted).filter((id) => !metaFor(id)).sort();
  if (rest.length > 0) {
    groups.push({
      id: FALLBACK_GROUP.id,
      label: FALLBACK_GROUP.label,
      entries: rest.map((id) => ({ id: id, label: providerLabel(id), color: FALLBACK_COLOR, group: FALLBACK_GROUP.id }))
    });
  }
  return groups.filter((group) => group.entries.length > 0);
}
