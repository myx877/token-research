# TokenMonitor 用量总览(日 / 周 / 月 × 金额)实施计划

- **日期**：2026-09-17 ｜ **状态**：待用户批准执行 ｜ **预估**：约 1 周(精简路径 A+B+C+D)
- **目标(用户原话)**：通过本程序看到 codex、claude、ds(DeepSeek)、opencode 的**每日 / 每周 / 每月** token 消耗,以及**对应的花费金额**。
- **相对** `C:\Users\hst\Desktop\TokenMonitor-SDD\TokenMonitor-SDD.md` **的关系**：复用其工程纪律与数据层方法(新键隔离、纯函数 rollup、Test-First、幂等回填、Codex 有状态解析器、证据落档),但重写其范围与口径(补齐 claude/opencode、时间维度改为自然日/周/月、金额口径改为真实+可隐藏估算)。SDD 的 001/002/003/005/006 降级为可选。

## 0. 已锁定的决策(用户 2026-09-17 确认)

| # | 决策点 | 结论 |
|---|--------|------|
| D1 | 金额口径 | **真实金额 + 可隐藏的估算列**。真实来源照实显示;订阅制按「月费 ÷ 计费天数 × 当日 token 占比」摊薄,标灰注明「估算」,可一键隐藏 |
| D2 | 周/月定义 | **自然周(周一起,ISO 周)+ 自然月**;显示本周/上周/本月/上月合计,并支持周/月历史趋势 |
| D3 | 按模型下钻 | **本轮不做**。数据层预留 `model` 字段与扩展点,以后加不返工 |
| D4 | 执行范围 | **精简路径 A+B+C+D**;不做 index.js 300 行拆分、不做配置导出导入、不做静态测试行为化专项 |

## 1. 现状事实(实测核对,非推断)

- 日用量统一键：`usageDaily = { '<provider>:<YYYY-MM-DD>': { input, cached, output, total, models? } }`;金额键 `usageDailyCost`,**目前仅 dsh 写入**。
- `src/main/core/locallog.js:389` `rollupDaily()` **丢弃 `model` 与 `cost`**。
- 展示层 provider 列表**硬编码**：`renderer/src/components/ProviderBar.jsx:13` 的 `STACK` 仅 codex/kimi/deepseek。
- 全仓 grep `claude|opencode` **零命中**,两个 provider 完全未支持。
- 本机数据源实测：

| 工具 | 位置 | Token | 金额 |
|---|---|---|---|
| DeepSeek | 平台 API(需登录会话) | ✅ 日+模型级 | ✅ 平台账单,日粒度金额尚未落库 |
| Codex | `~/.codex/sessions`、`archived_sessions` | ✅ 已有 | ❌ 订阅制 |
| Kimi | CLI wire.jsonl | ✅ 已有 | ❌ 订阅制 |
| DSH | `~/.dsh/telemetry/` ⚠️ **本机不存在** | 取决于该目录 | 定价表可算 |
| Claude Code | `~/.claude/projects/<编码cwd>/<sessionId>.jsonl` ✅ | ✅ `usage.{input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens}` + `message.model` + `timestamp` | ⚠️ 行内无 cost → R6 |
| opencode | ⚠️ 已迁 **SQLite** `~/.local/share/opencode/opencode.db`(+`-wal/-shm`) | ✅ 需读 db | ✅ 通常带 `cost` → R7 |

- 可复用既有能力：`src/main/core/beijing-calendar.js`(`localDayStr`、DST 测试齐备)、`renderer/src/lib/heatmap.js` 的 `sundayWeekKey` / `buildSundayWeekTotals`、`renderer/src/grid/components.js` 组件注册表、`components.*` 开关、`node --test` 139 个测试文件。

## 2. 研究门禁(阻塞对应实现,先做)

| 编号 | 问题 | 判定方法 | 决策点 |
|------|------|---------|--------|
| R6 | Claude Code jsonl 行内是否已有 cost 字段 | grep 已落盘 jsonl 的 `costUSD`/`cost` 键 | ✅ **已判定(2026-09-17)**:`~/.claude/projects/**/*.jsonl` 中 **无 `costUSD`、无 `"cost"`、无 `requestId`** → 必须走价格表折算 `derived` + 订阅月费摊薄 `subscription`;**去重只能依赖 `message.id`** |
| R7 | opencode `opencode.db` 表名与 `tokens`/`cost` 字段 | 只读探测 schema(`scripts/probe-opencode-schema.js`) | ✅ **已判定(2026-09-17,实测)**。opencode **直接提供真实金额与四桶**,无需价格表折算:`message` 表 12,859 条 assistant 行,`data` JSON 含 `cost` + `tokens.{total,input,output,reasoning,cache.{read,write}}` + `modelID`/`providerID` + `time.created`(ms epoch);`∑message.cost = 19.709292852` 与 `∑session.cost = 19.709292852` **完全吻合**。另存在 `session_v2`(16 行,`cost` 合计 1.533,消息在 `session_message`)→ provider 必须**两张 session 表都读**。读取用内置 `node:sqlite`(`DatabaseSync` + `readOnly:true`),**零新依赖**,符合 SDD 宪法 IV。注意 `web_search` 本会话不可用(HTTP 402),一律以真库探测为准 |
| R6b | Claude Code 多行同请求去重键 | 按 `message.id` 分组,组内 usage 取一次 | 若同 `message.id` 的 usage 不一致,取首行并计入诊断(不求和) |
| R8 | `~/.dsh/telemetry/` 缺失原因 | 检查 DSH usage-telemetry 组件是否启用 | 未启用 → DSH 行显示空态并给出启用指引,不报错 |

**R7 是一处真实的路径分歧**:SDD 的"游标 + 逐行 JSON 扫描"对 opencode 完全不适用,必须换读取器。

## 3. 数据契约(新增,遵循"新键隔离、写入方只增不改")

```js
// 金额:沿用既有键 usageDailyCost = { '<provider>:<YYYY-MM-DD>': number }
// 本轮补齐 deepseek / claude / opencode 的日粒度写入

// 每个 provider 的金额口径声明(代码常量,非存储)
// costMode: 'real' | 'derived' | 'subscription' | 'none'
// 数据行附带 costSource 与 estimated:boolean,供展示层切换

// 周/月不新增存储键 —— 由日键在读取时用纯函数聚合:
//   bucketByWeek(dateKey)  -> '2026-W38'   (ISO 周,周一起)
//   bucketByMonth(dateKey) -> '2026-09'
```

**为何不新增周/月键**：零迁移、天然幂等、体积不膨胀;比 SDD"再加键"更省,且不触碰热力图 / MCP 投影 / 保留清理 / dsh 合并等现有消费方。

## 4. 分阶段任务

### Phase A 统一数据底座(2-3 天)

- [ ] A1 补齐金额落库：`usageDailyCost` 扩展到 deepseek(平台账单日粒度)、claude、opencode;保留窗口与 `data.historyDays` 对齐
- [ ] A2 新增 `bucketByWeek`(ISO 周一起)/ `bucketByMonth` 纯函数 + 单测(含跨年周、闰月、DST 边界)
- [ ] A3 抽统一 `rollup(records)`:provider + 本地日 + 四桶(input/cached/output/total)+ cost + currency + 可选 model;纯函数可单测
- [ ] A4 定义 `costMode` 表与订阅摊薄算法(月费 ÷ 计费天数 × 当日占比),摊薄值与真实值**分列**不混算

### Phase B 新接口 + 新卡片(2-3 天)

- [ ] B1 IPC `get:usage-summary({ provider, bucket:'day'|'week'|'month', from, to })` → `{ rows:[{ bucketKey, provider, input, cached, output, total, cost, costMode, estimated }], totals, fetchedAt }`;store 读失败返回 `{ rows: [], error }` 不抛异常
- [ ] B2 `src/preload/preload.js` invoke 白名单同步(实测白名单在 55-79 行)+ 契约测试守护
- [ ] B3 `renderer/src/api.js` 封装 + `useUsageSummary` hook(订阅 `providers:changed`,300ms 去抖)
- [ ] B4 新卡片 `UsageSummaryCard`:日/周/月三档切换 + 按 provider 分列(Claude / Codex / DeepSeek / opencode / Kimi / DSH)+ token 与金额 + 期间合计 + 估算列开关 + 空态/加载态;类名空间 `usage-summary-*`
- [ ] B5 组件注册(`renderer/src/grid/components.js`)与开关(`components.usageSummary`,默认 `false`);不改造 model-bar、不开新窗口
- [ ] B6 `ProviderBar` / 热力图 provider 列表**动态化**,去除硬编码三平台

### Phase C 接入 Claude Code 与 opencode(3-5 天)

- [ ] C1 新增 `src/main/providers/claude/`(`id:'claude'`, `capabilities.localLog:true`, `authStatus:'ok'`),扫 `~/.claude/projects/**/*.jsonl`
  - **按 `message.id` 去重**(一条 API 请求写多行,按行累加会成倍虚高)
  - 跳过 `<synthetic>` 与全 0 用量行;`isSidechain` 子代理是真实用量,计入
  - 桶映射：`input_tokens→input`、`cache_creation_input_tokens→cacheWrite`、`cache_read_input_tokens→cached`、`output_tokens→output`;`timestamp` 为 UTC ISO → 转本地自然日
  - 接入 A3 rollup / A4 金额
- [ ] C2 新增 `src/main/providers/opencode/`,读取 `~/.local/share/opencode/opencode.db`(R7 结论决定实现),按 `time_created` 增量 + 指纹去重
- [ ] C3 新 provider 全链路接线：provider 列表、热力图页签、动态堆叠图、`usage-retention.js` 保留清理覆盖新键、设置开关与 `settings-reset.js` 保留

### Phase D 验收(1 天)

- [ ] D1 手算抽查对账：≥2 个 provider × ≥3 天,误差 0;记录到验证档
- [ ] D2 边界：跨日 / 跨周(含跨年周)/ 跨月 / DST 切换
- [ ] D3 回归：`npm test` 全绿;热力图 / 额度卡 / 托盘 / 设置项无回退;重启后历史仍在
- [ ] D4 `delivery_check`(file + evidence)

## 5. 明确不做(本轮)

- 按 `provider × model` 下钻视图(D3 决议;数据层预留字段)
- SDD 的 003 `index.js` 1057→300 行拆分、005 配置导出/导入、006 NSIS 打包、002 静态测试行为化专项
- 代码签名、自动更新、macOS 适配、跨机数据同步
- 对订阅制做"仅供展示的等效 API 花费"混算(会误导,已否决)

## 6. 风险

| 风险 | 影响 | 处置 |
|------|------|------|
| opencode SQLite 无内置驱动可用 | Phase C2 阻塞 | R7 先行判定;最坏情况降级为"提示用户导出"并在计划中登记新依赖决策 |
| Claude jsonl 格式随版本变动 | 解析失效 | 解析器对未知字段宽容、缺失桶按 0;把版本号写入诊断信息 |
| `~/.dsh/telemetry/` 缺失 | DSH 无数据 | R8 排查;空态 + 启用指引,不报错 |
| 日粒度金额口径不一致(DeepSeek 账单 vs 本地折算) | 对账误差 | 真实/估算分列,行内带 `costMode`,禁止混算 |
| 触碰 `usageDaily` 引发回归 | 热力图/看板回退 | 只读不改 `usageDaily` 结构;金额与周月分桶全部新增路径 |
