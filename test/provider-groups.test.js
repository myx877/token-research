// 服务商分组的常量守卫。
//
// 为什么需要守卫:分组是用户可见的两大类(模型平台 / 本机日志 harness),
// 新增一个平台时最容易漏掉的就是"分组归属"—— 漏了它,这个平台会从选择页和
// 标题栏标签栏里静默消失,而且不会有任何报错。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const load = () => import('../renderer/src/lib/providers-meta.js');

test('每个平台恰好属于一个分组:无遗漏、无重复、每组非空', async () => {
  const m = await load();
  const ids = m.allProviderIds();
  assert.equal(ids.length, m.PROVIDER_META.length, 'allProviderIds 必须来自 PROVIDER_META 这一份真相');

  const seen = {};
  let counted = 0;
  m.PROVIDER_GROUPS.forEach((group) => {
    const members = m.PROVIDER_META.filter((entry) => entry.group === group.id);
    assert.ok(members.length > 0, '分组 ' + group.id + ' 不能是空的');
    members.forEach((entry) => {
      assert.equal(seen[entry.id], undefined, '平台 ' + entry.id + ' 被分进了多个组');
      seen[entry.id] = group.id;
      counted += 1;
    });
  });
  assert.equal(counted, ids.length, '有平台没被任何分组收下(会从界面上静默消失)');
  ids.forEach((id) => {
    assert.ok(seen[id], '平台 ' + id + ' 缺少 group 字段');
    assert.ok(
      m.PROVIDER_GROUPS.some((g) => g.id === seen[id]),
      '平台 ' + id + ' 的 group=' + seen[id] + ' 不在 PROVIDER_GROUPS 里'
    );
  });
});

test('两类分组的成员口径:按"数据从哪来"分,不是按"要不要登录"分', async () => {
  const m = await load();
  const byId = {};
  m.PROVIDER_META.forEach((entry) => { byId[entry.id] = entry.group; });
  // 唯一走官方接口、必须配 API Key 的
  assert.equal(byId.deepseek, 'model');
  // 其余全部读本机日志 / 本机 DB。Codex / Kimi 也在这里:
  // 它们的 token 明细来自 ~/.codex/sessions、~/.kimi-code/sessions,
  // 官方额度 API 只是额外的分母来源,凭证过期不影响"有数据"。
  assert.deepEqual(
    ['codex', 'kimi', 'dsh', 'claude', 'opencode'].map((id) => byId[id]),
    ['tool', 'tool', 'tool', 'tool', 'tool']
  );
});

test('分组口径必须与各 provider 真实的 localLog 能力一致', async () => {
  // 这条守卫防的是"分类和真实数据来源脱钩":一旦读本机日志的平台被归进模型平台,
  // 用户就会看到"本地明明有日志、却被要求先配 API Key"这种错位
  // (真实踩过:Codex / Kimi 曾被归进「模型平台」,而它们的 localLog 一直是 true)。
  const m = await load();
  m.PROVIDER_META.forEach((entry) => {
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/main/providers', entry.id, 'index.js'),
      'utf8'
    );
    const localLog = /localLog:\s*true/.test(source);
    assert.equal(
      entry.group,
      localLog ? 'tool' : 'model',
      entry.id + ' 的 localLog=' + localLog + ',分组却是 ' + entry.group
    );
  });
});

test('providerGroups 保留元数据顺序,未收录的 id 归入「其它」而不是被丢掉', async () => {
  const m = await load();
  const groups = m.providerGroups(['opencode', 'deepseek', 'brand-new-cli']);
  assert.deepEqual(groups.map((g) => g.id), ['model', 'tool', 'other']);
  assert.deepEqual(groups[0].entries.map((e) => e.id), ['deepseek']);
  assert.deepEqual(groups[1].entries.map((e) => e.id), ['opencode']);
  assert.deepEqual(groups[2].entries.map((e) => e.id), ['brand-new-cli']);
  // 空列表不留空壳分组
  assert.deepEqual(m.providerGroups([]), []);
});

test('源码守卫:「跳过,直接进入主界面」不许复活', async () => {
  // 主界面已经就是选择页,那个按钮在逻辑上不再成立。
  // 一旦有人把它加回来,选择页会重新出现"进入主界面"这个无处可去的动作。
  //
  // 注意:守卫必须**剥掉注释再找**,否则"解释它为什么被删掉"的那段注释本身
  // 就会被当成复活证据(实测踩过,守卫当场把自己的说明判成违规)。
  const root = path.resolve(__dirname, '../renderer/src');
  const stripComments = (source) => source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const hits = [];
  const walk = (dir) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      if (!/\.(jsx?|mjs|css)$/.test(entry.name)) return;
      const body = stripComments(fs.readFileSync(full, 'utf8'));
      if (body.indexOf('provider-gate-skip') >= 0) hits.push(path.relative(root, full) + ' (类名)');
      if (body.indexOf('跳过,直接进入主界面') >= 0) hits.push(path.relative(root, full) + ' (文案)');
    });
  };
  walk(root);
  assert.deepEqual(hits, [], '「跳过」按钮或它的类名又出现了:' + hits.join(', '));
});

test('源码守卫:标题栏不放服务商切换控件(切换统一走卡片里的「展示平台 ▾」)', () => {
  // 用户要求过两遍:先指出"窄窗降级成一排色点"很奇怪,再说"最上方不要搞各种小的切换"。
  // 标题栏只有 34px 高,塞一排标签在默认 420px 窗口里必然退化成认不出的色点;
  // 而单平台视图卡片里本来就有个带名字的下拉 —— 同一个动作放两处,除了重复没有任何好处。
  const titleBar = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/components/TitleBar.jsx'),
    'utf8'
  );
  assert.doesNotMatch(titleBar, /titlebar-rail-tab/, '标题栏不许再加回服务商标签页');
  assert.doesNotMatch(titleBar, /providerGroups|readyProviderIds|useCredentials/, '标题栏不该再算白名单');
  // 但「退回上一级」必须留着 —— 那是用户明确要的
  assert.match(titleBar, /titlebar-back/);
  assert.match(titleBar, /返回服务商列表/);

  const css = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/styles.css'),
    'utf8'
  );
  assert.doesNotMatch(css, /\.titlebar-rail/, 'styles.css 里不该再有标签栏样式');
});

test('源码守卫:取"主额度窗口"只有一份实现(pickQuotaWindow 是唯一决议点)', () => {
  // MiniView 曾经自己写了一份 windowByKind;两处一旦对"主额度(带 name 的附加额度 vs 主额度)"
  // 的理解分叉,小窗圆环与大卡进度条会指向不同的窗口。
  // 现在小窗的额度圆环视图已按用户要求删除 ⇒ 小窗不再需要 pickQuotaWindow,
  // 守卫改为:任何组件都不许再自建一份"取主额度"的实现(唯一决议点仍是 window-percent.mjs)。
  const mini = fs.readFileSync(path.resolve(__dirname, '../renderer/src/components/MiniView.jsx'), 'utf8');
  const card = fs.readFileSync(path.resolve(__dirname, '../renderer/src/components/UsageSummaryCard.jsx'), 'utf8');
  assert.doesNotMatch(mini, /function windowByKind/, '不允许再出现第二份取主额度的实现');
  assert.doesNotMatch(mini, /function quotaWindowOf/, '不允许再出现第二份取主额度的实现');
  assert.doesNotMatch(card, /function windowByKind|function quotaWindowOf/, '不允许再出现第二份取主额度的实现');
  const decisionPoint = fs.readFileSync(path.resolve(__dirname, '../renderer/src/lib/window-percent.mjs'), 'utf8');
  assert.match(decisionPoint, /export function pickQuotaWindow/, '唯一决议点必须仍在 window-percent.mjs');
});

test('源码守卫:命中/输入/输出明细默认不可见、悬停才浮现', async () => {
  // 需求原话是"每个条放上去还能看到输入,输出,命中的详细情况"。
  // 常驻显示会让三条进度条看起来像信息面板;但如果只删 opacity 而不留槽位,
  // 悬停会引起布局跳动。这里同时钉住"默认 0"和"悬停 1"两半。
  const css = fs.readFileSync(
    path.resolve(__dirname, '../renderer/src/styles.css'),
    'utf8'
  );
  const block = css.match(/\.usage-window-breakdown\s*\{[^}]*\}/);
  assert.ok(block, 'styles.css 里找不到 .usage-window-breakdown');
  assert.match(block[0], /opacity:\s*0/, '明细必须默认不可见');
  assert.match(
    css,
    /\.usage-window:hover\s+\.usage-window-breakdown\s*\{[^}]*opacity:\s*1/,
    '悬停时必须浮现'
  );
});
