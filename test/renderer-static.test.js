const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const titleBar = fs.readFileSync(path.join(root, 'renderer/src/components/TitleBar.jsx'), 'utf8');
const stylesCss = fs.readFileSync(path.join(root, 'renderer/src/styles.css'), 'utf8');
const apiJs = fs.readFileSync(path.join(root, 'renderer/src/api.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/preload/preload.js'), 'utf8');
const mainIndex = fs.readFileSync(path.join(root, 'src/main/index.js'), 'utf8');
const appJsx = fs.readFileSync(path.join(root, 'renderer/src/App.jsx'), 'utf8');

test('renderer api wraps get:providers / get:dashboard / get:heatmap and providers:changed', () => {
  assert.match(apiJs, /get:providers/);
  assert.match(apiJs, /get:dashboard/);
  assert.match(apiJs, /get:heatmap/);
  assert.match(apiJs, /providers:changed/);
});

/* 窗口缩放的机制守卫。
   历史:主窗曾经由应用层 ResizeHandles(8 个 .resize-handle)驱动 window:set-bounds。
   现在缩放走系统原生(resizable: true),那个组件已经没有任何引用,已删除 ——
   但"窗口可缩放"这件事必须继续被守住,否则删掉之后没人盯着它。
   注意:main 进程的 resize:start/move/end 通道**不是**死代码,设置窗还在用
   (src/renderer/js/settings-window.js),别一起删。 */
test('主窗走系统原生缩放:resizable 为 true,且不再渲染应用层缩放手柄', () => {
  assert.match(mainIndex, /function createMainWindow\(\)[\s\S]*?resizable:\s*true/);
  // 只看"有没有 import / 有没有渲染",不排斥注释里提到它的名字(说明为什么要删也是有用的)
  assert.doesNotMatch(appJsx, /import\s+ResizeHandles/);
  assert.doesNotMatch(appJsx, /<ResizeHandles/);
  assert.doesNotMatch(appJsx, /['"]resize-layer['"]/);
});

test('设置窗的缩放通道仍然存在(它才是 resize:start/move/end 的使用方)', () => {
  assert.match(preload, /'resize:start'/);
  assert.match(preload, /'resize:move'/);
  assert.match(preload, /'resize:end'/);
  const settingsJs = fs.readFileSync(path.join(root, 'src/renderer/js/settings-window.js'), 'utf8');
  assert.match(settingsJs, /send\('resize:start'/);
  assert.match(settingsJs, /send\('resize:move'/);
  assert.match(settingsJs, /send\('resize:end'/);
});

test('styles.css has no square-corner rules for drag resize', () => {
  assert.doesNotMatch(stylesCss, /html\.is-window-resizing/);
});

test('单平台视图的卡片不被 flex 压扁(压扁后内容会被 overflow:hidden 裁掉)', () => {
  // 单平台视图的根节点同时是 .content(overflow:auto 的滚动容器)和 .single-provider(flex 列)。
  // flex 列的子项默认 flex-shrink:1 ⇒ 它们会被压扁去适配容器高度,**而不是撑出滚动条**;
  // 压扁之后 .component-surface{overflow:hidden} 就把内容直接裁掉 ——
  // 表现是"本月那一行的进度条和数字整个消失,而外层因为没溢出连滚动条都不出现"(真机实测)。
  assert.match(stylesCss, /\.content\.single-provider\s*>\s*\*\s*\{[^}]*flex:\s*0\s+0\s+auto/);
});

test('TitleBar wires refresh / settings / minimize buttons to their IPC channels', () => {
  assert.match(titleBar, /refresh:dashboard/);
  assert.match(titleBar, /open:settings/);
  assert.match(titleBar, /window:minimize/);
});

test('preload exposes get:heatmap for the heatmap api', () => {
  assert.match(preload, /'get:heatmap'/);
});

test('Dashboard 只有两条渲染路径:单平台详情与「全部」总览', () => {
  const dashboard = fs.readFileSync(path.join(root, 'renderer/src/components/Dashboard.jsx'), 'utf8');
  // 布局网格与编辑模式已按用户要求删除(见 VERIFICATION §20.3):这里改为钉住新契约
  assert.match(dashboard, /import ProviderOverview/);
  assert.match(dashboard, /if \(!selected\) return <ProviderOverview \/>;/);
  assert.doesNotMatch(dashboard, /GridStack\.init|grid-stack-item/);
});
