# AGENTS.md —— 本项目的协作约定与踩坑清单

> 这份文件是**给未来的编码会话(包括 AI)读的**。每条都来自真实踩到的故障,并标注了现象。
> 新增条目请保持一句话可执行,并写清"违反了会怎样"。

## 一、执行纪律(最容易让人以为"卡住了")

1. **重活一次只跑一个。** TokenMonitor 的 harness(`npx electron scripts/verify-usage-summary-ui.js`)
   会起真实 Chromium,单次 50~120 秒;真机走查要另起一个 Electron 应用实例。两者并行会互相拖慢,
   表现为前台长时间无输出(实测踩过两次,用户观感就是"卡住")。**规则:串行执行;要并行只能是互不竞争的轻活。**
2. **长命令一律后台 + 落盘日志**,然后用 `read`/`grep` 读文件,不要让前台干等。
   即使前台等待,也要套 `timeout <秒> <命令>` 兜底,避免无声挂死。
3. **不要用 `python` / `node -e` 做就地改写文件。**
   - Git Bash 里的 `python` 实际是 Windows Store 桩:读 stdin、什么都不打印、退出码 0(改写静默失效)。
   - `node -e` 里的正则批量替换同样出现过静默不生效。
   - **规则:改文件用编辑器工具(edit/write),改完立刻 `grep` 或 `read` 复核改动真的落盘了。**

## 二、测试与取证纪律

4. **断言前先等状态稳定。** 组件里有 CSS 过渡(如进度条 `width 300ms`),切换平台后立刻读取会读到
   过渡中间值 ⇒ 假失败。**规则:先 `waitFor(目标状态)`,再断言。**
5. **桩必须与主进程同语义,否则桩在撒谎。** 曾出现"桩返回的 `startDay` 与主进程规则不一致",把产品
   "证明"成有缺陷。**规则:发现桩与真实语义不一致时,先改桩,再谈产品缺陷。**
6. **用了的符号必须 import,新分支必须有测试。** 真实缺陷:`src/main/ipc.js` 调用了
   `inclusiveBeijingDayCount` 却没 import ⇒ 只有在"存在早于保留窗口的数据"这条分支上才抛
   `ReferenceError`(真机点「同步历史」时暴露),happy-path 测试全绿也照样漏。
   **规则:新增分支写一条走该分支的测试 + 一条源码守卫(见 `test/history-sync-ipc.test.js`)。**
7. **脚本要"点不到就 FAIL",不要崩。** harness 里所有 `.click()` 前先判空并返回 `false`;一个
   `TypeError` 会终结整个脚本,把 100 条断言的结果一起吞掉。异常处理器里也不要引用别的函数作用域里的
   变量(`main().catch()` 里用 `app` 会再抛 ReferenceError,连失败摘要都打不出来)。
   同理:**往受控 input 里写值前也要判空** —— `Object.getOwnPropertyDescriptor(...).set.call(null, …)`
   抛的是 `Illegal invocation`,它的后果和 TypeError 一样(实测踩过:一条断言失败顺带吞掉了后面 30 条)。
8. **`delivery_check` 只认真实证据**:路径要用绝对路径;视觉类证据(截图/页面)必须人眼复核过
   (`reviewed: true`);`external` 类也要给已存在的文件路径。没跑过就不标通过。
9. **别在"真实光标位置"上赌断言。** harness 跑在有人的机器上,用户鼠标可能正压在被测元素上;
   合成 `mouseMove` **挪不动真实 OS 光标**,所以"指针 park 走 → 应该恢复默认态"这类基线读数
   在物理上取不到。**规则:先区分两种情况再决定红还是绿 ——**
   `:hover` 为真 ⇒ 环境干扰,记 `SKIP` 并把读数写进日志;没有 `:hover` 却还亮着 ⇒ 残留悬停,真 bug,必须 FAIL。
   一个时红时绿的断言比没有断言更糟:它会训练人忽略红色。
   实现见 `scripts/verify-usage-summary-ui.js` 的 `readHoverAfterPark()`。
10. **视觉复核不是走过场 —— 它能抓到断言抓不到的东西。** 真实踩过两次,两条都是**看图**发现的:
    (a) 标题栏标签栏因 `container-type: inline-size` 塌成 0 宽(DOM 里 tab 数量完全正常;
        该标签栏后来被整体删除,但"容器盒不按内容算宽度就会塌"这个坑对所有 flex 容器都成立);
    (b) 退出月历后浮层成了"贴在屏幕上的幽灵提示"(旧格子被卸载,`onMouseLeave` 不再触发)。
    **规则:改动视觉组件后至少看一眼落盘截图,不能只看 `PASS` 计数**;看图发现的问题要补成断言。

## 三、产品语义红线(别为了好看破例)

9. **没有分母就不显示百分比 —— 但进度条要画。** 分母优先级:平台真实额度(`quota.windows[].limit/remaining`)
   > 用户填的预算(设置 → 预算)。**两者都没有时:条照画**,长度 = 本窗口 token 占
   "三个窗口里最大的那个"的比例 —— 这是用户明确要的"绿色代表实际用了多少 token",它不需要用户
   提供任何预算;但条上**绝不出现百分比数字**(那才是"编分母"),也不挂「无分母」徽章,
   只留 token 数、金额、倒计时这些真实数字。**绝不编一个数字**(包括 `Number(null) === 0` 这种
   "看起来有值"的坑,已由 `renderer/src/lib/window-percent.mjs` 单测钉住)。
10. **口径残缺必须自己挑明。** 任何"看起来是整月/整周、实际只统计了一部分"的数字,都要在卡片上
    直接写出限制(见 `retentionHintText`),不能只写在设置窗里。
11. **百分比是给用户判"超没超"的,超额要如实显示 >100%**,只有进度条**宽度**封顶。
12. **颜色语义不要稀释。** 本卡里绿色专指"已用比例"(没有分母时 = 本窗口 token 占三个窗口最大值的比例),
    给其它文字(如"命中")也上绿,会让"绿色只表示用量"这条像素级判据失效。
    (旧写法举例"没设预算 ⇒ 一个绿像素都没有"**已作废** —— 用户明确要求没分母也要画条。)
13. **主界面 = 选择页,「跳过,直接进入主界面」已删除。** 详情页由标题栏的 `‹` 退回列表。
    把列表改回"常驻侧栏"、或把跳过按钮加回来,都会让"退回上一级"失去意义
    (文案与类名都有守卫:`test/provider-groups.test.js`,CSS 里也留了说明)。
14. **窗口行的订阅摊薄估算,分母必须是整月。** 只把窗口内的行喂给 `estimateSubscriptionDaily`,
    「今日」会直接等于整月月费 —— 这个错误看起来非常像对的,所以更危险。
    守卫:`test/usage-windows-estimated-cost.test.js`。
15. **凭据没就绪 ≠ 数据不可用,绝不用它拦人。** codex/kimi 的本机日志照常出数,凭据只影响
    "官方额度/余额"这条分母;未就绪的表现是"详情页给原因 + 黄条",不是弹窗、不是跳转、更不是拦截。
    判定唯一决议点:`renderer/src/lib/provider-credentials.mjs`(选择页状态文案 / 卡片凭证提示 / 小窗白名单共用一份)。
16. **服务商分组按"数据从哪来"分,不按"要不要登录"分。** 当前口径:模型平台 = DeepSeek
    (走官方接口、必须配 API Key);工具平台 = Codex / Kimi / DSH / Claude Code / opencode
    (读本机日志 / 本机 DB)。判据是各 provider 的 `capabilities.localLog`,为 `true` 的一律归「工具平台」。
    守卫会拿 `src/main/providers/<id>/index.js` 里的 `localLog` 反查分组,归错立刻红
    (真实踩过:Codex/Kimi 曾被归进「模型平台」,而它们的 `localLog` 一直是 `true`)。
17. **进度条的主数字:只有"分母本身是 token"时才升成 token 数。** 分母是 **Token 预算**
    (`data.usageBudgetTokens`,设置 → 预算里和金额预算并列)⇒ 条上先说 token 数、百分比退成次要小字;
    分母是**金额预算**或**平台额度**⇒ 保持百分比 —— 它们量的不是 token,升上去会把语义写错
    (「预算花完 25%」被写成「25万 Token」)。决议唯一交点:`renderer/src/lib/window-headline.mjs`,
    大卡与小窗共用。守卫 `test/window-headline.test.js`。
18. **时间轴口径全项目统一:周一开头。** 进度条的「本周」是 ISO 周一,热力图的可视列也必须从周一开始
    —— 否则「每周」最右一列的总数和上面「本周」的数字会差一天(真实踩过:热力图跟着 GitHub 走周日)。
    守卫 `test/heatmap-cells.test.js` 会逐列检查首格是不是周一。
19. **单平台视图的卡片必须"按内容撑满",不能被 flex 压扁。** 单平台视图的根节点同时是
    `.content`(滚动容器)**和** `.single-provider`(flex 列);flex 列的子项默认 `flex-shrink: 1`,
    会被压扁去适配容器高度**而不是撑出滚动条**,压扁之后 `.component-surface{overflow:hidden}` 把内容
    直接裁掉 —— 表现是"本月那一行的进度条和数字整个消失,而外层连滚动条都不出现"(真机实测)。
    守卫:`.content.single-provider > * { flex: 0 0 auto }`,由 `test/renderer-static.test.js` 钉住。
20. **小窗(250×216)的内容必须"放得下,或至少能滚",不能撑破窗口。** 两个坑叠在一起:
    (a) `.mini-view { min-height: auto }` 让它**撑破**窗口而不是被压缩,超出部分被 `#app{overflow:hidden}` 切掉;
    (b) `.mini-usage { overflow: hidden }` 让"放不下"直接等于"永远看不到"(实测:第三条被切)。
    修 = `min-height: 0` + `overflow-y: auto`,并把内边距收紧到默认放得下(不出现滚动条)。
    **注意:harness 的迷你视图只切视图、不改窗口尺寸(900×720),所以它天然测不出这类缺陷** ——
    现在 harness 会先 `win.setContentSize(250, 216)` 再断言,真机走查也加了"三条都完整可见"的判定。
21. **标题栏不放服务商切换控件。** 34px 高的标题栏里塞一排标签,在默认 420px 窗口里必然退化成
    "一排认不出的色点"(用户实测圈出来两次);而单平台视图卡片里本来就有个带名字的下拉 ——
    同一个动作放两处只是重复。切换入口只有三处:卡片里的「展示平台 ▾」、列表页、小窗下拉。
    守卫:`test/provider-groups.test.js` 断言 `TitleBar.jsx` 里不许出现 `titlebar-rail-tab`,且 `‹` 退回仍在。
22. **退出迷你模式的尺寸恢复有 Windows 竞态。** `setMaximumSize` 的生效与紧随其后的 `setBounds`
    之间存在竞态:那次 `setBounds` 会被**旧的 250×216 上限**钳住,而此刻 `miniMode` 已是 `false`,
    于是留下"完整视图 + 迷你尺寸"的窗口 —— 用户视角是界面挤成一团、怎么点都回不去,而且状态是持久的。
    修 = 重试到 `getBounds()` 真的等于目标值(最多 6 次、间隔递增,超限打 warn);
    真机走查加了「退出迷你后窗口尺寸真的退回来了」判定(`verdictRestoreSize`)。
    教训:凡是"先改约束、再设尺寸"的 Windows 调用,都要**校验结果**,不能只发一次就当成了。
23. **主进程的同步重活绝不能夹在窗口动画中间。** 窗口缓动是主进程用 `setTimeout` 驱动的一串
    `setBounds`;任何夹在其中的同步重活都会把某一步拖慢上百毫秒 —— `elapsed / animateMs` 一步跳到接近 1,
    **窗口看起来是直接跳过去的**(实测:缩小的中间帧全被跳过)。两个真实元凶:
    ① 速度采样 `tokenSpeedRuntime.applySettings()` + 托盘 `updateTrayMenu()`;② `broadcastSettings()`
    经 `sanitizeSettings`,而它**先整库深拷贝再 delete 大键**(用量库几十 MB,等于每次广播都全量拷一遍)。
    **排查要点:渲染层帧时间线看不出这个问题**(主进程卡住时渲染层照样 60fps)—— 要在主进程侧记迟帧
    (见 `animateBounds` 的 `lateMs > 60` 告警)。规则:副作用一律挪到动画结束后并让出一拍;
    `sanitizeSettings` 必须**先摘大键再深拷贝**。
24. **`store.get/set` 不是内存读,热路径里一次都不许调。** electron-store(底层 conf)的每次 `get`
    都要"全量读盘 + PBKDF2 派生密钥 + JSON.parse",`set` 还要全量序列化 + 加密 + 落盘(配置库里
    带着用量聚合,几十 MB 时代价更吓人)。**规则:**
    ① 热路径(窗口 `move` 事件这种每帧触发的)一律读模块级缓存,设置一变再刷新(见 `refreshHotFlags`);
    ② 提交聚合数据前先判断"真的变了才写"(见 `src/main/providers/codex/locallog.js` 的 cursors 守卫 ——
       它漏了这条,每 60s 无条件整库重写一次)。
25. **桩必须与主进程契约同步演进,否则桩在撒谎。** 这轮又踩一次:主进程给 `get:usage-summary` 的
    `retention` 加了 `earliestDay`,`scripts/verify-*.js` 的桩没加 ⇒ UI 读到 undefined 走了另一条分支,
    报出一条假失败。**规则:改主进程返回的载荷形状时,先搜 `scripts/` 里的同名载荷并同步改桩。**
26. **口径披露要拿"实际显示出来的最早周期"比,不是"卡片固定的回看起点"。** 回看起点是固定的 7/56/186 天,
    与"历史数据保留"设置无关 —— 拿它当判据会在保留 90 天时也误报。这轮我改错过一次,被 harness 的
    「月桶表格:保留 90 天时不再提示」当场抓住。
27. **DSH 的"官方遥测插件"不是用量计量通道,别用它统计 token。** `dsh-session-telemetry-otel` 只有
    `FEEDBACK_ONLY` / `DISABLED` 两种模式(`FULL` 被 `assertNever` 明确拒绝),只在**用户提交反馈**时捕获,
    且捕获的是**整段会话内容**(消息正文、工具参数与结果、系统提示词、cwd);`emit()` 是**空操作**。
    官方另一个 `dsh-session-log-export` 是"浏览器 ZIP 下载",README 自己写着"需要程序化或 Host 侧导出时避免使用"。
    DSH 的 token 用量唯一可用来源 = 它自己写的**规范会话日志**(`$DSH_HOME/sessions/**/session[.vN].jsonl[.zstd]`,
    实现见 `src/main/providers/dsh/session-log.js`)。**判据:任何"官方接口能出 DSH 用量"的方案,先去
    `<DSH_HOME>/profiles/node_modules/@deepseek-ai/**` 读源码,不要按项目文档里的假设办事** ——
    文档里那个 `~/.dsh/telemetry/usage-*.jsonl` 生产者,全 DSH 包搜索零命中(`test/README` 里的说法是错的)。
28. **DSH 会话日志的两条硬约束(违反必错)。** ① 文件是 **zstd 多帧追加**;Node/Electron 的
    `zstdDecompressSync`(含流式)只解**第一帧** —— 实测 8.3MB 文件只出 217 字节,所以要按 RFC 8878
    自己走 magic + frame header + block header 切帧,再逐帧解。② 同一会话目录会**并存 v0/v3 两代文件**,
    两代的 usage 求和**完全相同**、但 `seq` 编号体系**完全不同**(实测 196921 vs 1750)⇒ **只读最高世代**是
    必需规则而非优化:两代都读必然双计,而且**靠 seq 去重救不了**。口径只认 `assistant/message` 的
    `data.usage`(`compaction/summary` 也带 usage,但必须排除 —— DSH 自己的累计值也不含它,已被
    「本项目求和 === DSH 自身累计」的对账证明)。守卫 `test/dsh-session-log.test.js`。
29. **比较"游标有没有动"必须比值,不能比引用。** codex uuid 模式的守卫写成了
    `nextCursors[k] !== storedCursors[k]` —— 两侧都是各自深拷贝出来的新对象,引用永不相等 ⇒
    `moved` 恒为 true ⇒ 每轮轮询(60s)都走全库深拷贝 + 全量重写。**第 24 条点名的就是这件事,
    守卫加了但比错了东西**(审查发现)。规则:用 `JSON.stringify` 做稳定值比较(同 dsh 的 `cursorsChanged`)。
30. **"未知"不许被 `Number()` 变成 0。** `Number(null) === 0` 会把"剩余未知"画成"100% 已用 + 超额标红"
    (红线第 9 条点名的坑,审查时在 `quotaUsedPercent` 里又抓到一次:id 必须显式判空再转换)。
    同族:**没有真实账单的平台(codex/kimi 订阅制)**,金额预算的分子要用摊薄估算 ——
    只认真实账单会让那条预算永远 0%,与同一行的 `≈金额` 自相矛盾。

## 四、常用命令

```bash
npm test                                   # 全量单测(node --test)
npm --prefix renderer run build            # 构建渲染层(改 renderer/ 后必须)
npx electron scripts/verify-usage-summary-ui.js        # 桩跑 UI harness(140 条断言 + 截图;光标干扰时个别基线断言记 SKIP,见第 9 条)
npx electron . --remote-debugging-port=9223            # 真机(CDP 走查的前提)
CDP_PORT=9223 node scripts/verify-real-app-gate.js     # 真机走查(主界面=服务商列表/详情/小窗 + 截图)
CDP_PORT=9223 CDP_SELECT=<平台> CDP_EVAL_FILE=/tmp/x.js node scripts/diag-app-state.js   # 真机读数探针
taskkill //F //IM electron.exe                          # 收尾(别留 Electron 实例)
```
