# Phase 0 研究结论

本特性没有 `NEEDS CLARIFICATION`：技术上下文全部来自仓库现状（`src/`、`tools/`、`DESIGN.md`）。
下面记录实现前必须定下的六个设计决策，每条都附仓库内证据。

## D1 失败诊断怎么变成可读状态

**Decision**: 失败时 `JobPhase.failed` 增加可选 `step`（步骤序号）、`verb`（步骤动词）、
`selector`（目标选择器）、`hint`（一句话人话原因）四个字段，由驱动层已有的结构化返回值
直接映射，不改驱动的失败产出。

**Rationale**: `src/preload/driver.js:449-455` 已经返回
`{ ok: false, step, verb, selector, detail }`；现在主进程只取 `detail` 拼进 message，
号码与选择器被丢掉。补字段比重新造诊断便宜。

**Alternatives considered**: ① 在渲染层正则解析 message —— 文案一改就断；
② 让驱动直接产出人话 —— 驱动跑在页面隔离世界，不该管文案与语言。

## D2 「部分完成」怎么表示

**Decision**: 不新增 phase。`done` 继续表示结算完成，界面层由 `progress[]` 统计得出
`failedCount` / `totalCount`，`failedCount > 0` 显示「部分完成 N 失败 / M 完成」。

**Rationale**: `protocol.js:78-79` 的 `done` 已带可选 `progress`；新增 `partial` phase 会让
所有 switch 都要多一个分支，且宪法 V「只做最小改动」不允许为派生值加状态。

**Alternatives considered**: 新增 `phase: 'partial'` —— 状态机分支翻倍，收益只是少一次派生。

## D3 60 秒停滞怎么判定

**Decision**: 在 `JobManager` 现有的进度轮询里维护「最后一次字节增长的时刻」，超过 60000ms
且任务仍处于 `downloading` 时，在 Job 上置 `stalled: true` 并推送一条事件；字节数一增就清掉。

**Rationale**: 进度轮询本来就是唯一知道 `completedLength` 变化的地方，不需要新的定时器；
自动重试被用户否掉（Q6），所以这里只是标志位，重试仍走现有 `retry`。

**Alternatives considered**: 用 aria2 的 `downloadSpeed === 0` —— 队列 `waiting` 的速度天然为 0，
会误报；用独立定时器 —— 多一个生命周期要管。

## D4 500 条上限与归档放在哪

**Decision**: `TaskStore` 的 `MAX_RECORDS` 由 40 改为 500，超出时最旧记录写进同目录
`jobs-archive.jsonl`（一行一条）并从 `jobs.json` 移除；`record.archived` 是用户主动归档标志，
归档项移出主列表但不移出 `jobs.json` 的 500 计数。

**Rationale**: `task-store.js:22` 的 40 条是硬截断，直接丢数据，与 FR-015「不得因归档丢失历史」
冲突；追加式 jsonl 不需要读取整个归档就要能追加，且坏了不拖累主文件。

**Alternatives considered**: 删掉上限 —— 界面与文件都会无限长；SQLite —— 引入依赖。

## D5 批量粘贴与去重

**Decision**: 渲染层提交前不再只取第一条，改为用 `check:share-link` 已有的解析能力切出多条；
主进程 `submit` 前按 `provider + shareId` 查「处理中」集合（`loading` / `extracting` /
`needs-human` / `linked` / `delivering` / `downloading` / `paused`），命中即返回
`{ duplicateOf: jobId }`，不新建任务。

**Rationale**: 用户 Q2 的答复就是这套语义；共享 `providers.js` 的正则即可，不新增解析器。
已完成/失败不受影响，因此也不会踩 `LESSONS.md` 里「重新投递已完成文件下成 `.1` 副本」。

**Alternatives considered**: 在渲染层去重 —— 列表状态可能落后，主进程才是唯一真相。

## D6 能力说明的数据来源

**Decision**: `TaskStore` 每次任务进入终态时，把
`{ provider, at, ok, code?, hint? }` 追加进 `provider-health.json`（每个网盘只留最近一条）；
设置页读它显示「最近一次：成功 / 失败（原因）/ 未验证」，能力等级取自代码里的静态表。

**Rationale**: 用户 Q8 要求只来自本机真实任务；静态等级来自 `DESIGN.md` 2.3 已核实结论，
两者分开显示即可，不混成"看起来新"的结论。

**Alternatives considered**: 启动时主动探活四个网盘 —— 慢、且未登录时的结果无意义。

## D7 重试前强制拉最新脚本

**Decision**: `JobManager.retry(jobId)` 改为先 `await userscript.refresh()`，成功则用新脚本重建任务，
失败则沿用当前版本并在任务 `detail` 里注明「重试使用缓存版本 vX」。

**Rationale**: `userscript.js:36-50` 的 `refresh()` 已经保证「刷新失败不清空当前版本」，正好是
Q7 要的回退语义；`retry` 现在直接 `submit(raw)` 没有刷新，是唯一缺口。

**Alternatives considered**: 让 `refresh` 失败就中止重试 —— 用户明确否掉。

## 检查如何覆盖

| 需求 | 检查 |
| --- | --- |
| FR-002 / FR-007 诊断与失败位置 | 扩展 `check-job`：喂一个第 3 步超时的驱动返回值，断言 Job 带 `step/verb/selector` |
| FR-004 / FR-005 五态与部分完成 | 扩展 `check-job`：`done + progress` 里 1 个 `error` → 派生「部分完成」 |
| FR-008 重试拉新脚本 | 扩展 `check-job`：`refresh` 打桩返回新版本，断言重试后版本变化；失败路径断言注明缓存版本 |
| FR-009 停滞 | 扩展 `check-job`：假时钟推进 61 秒无增长 → `stalled: true` |
| FR-011 / FR-001 批量与去重 | 扩展 `check-share-link`：一段文本切 3 条；重复 submit 返回 `duplicateOf` |
| FR-015 500 上限与归档 | 新增 `check-archive`：写 501 条 → 1 条进 `jobs-archive.jsonl`，读回 500 条 |
| FR-012 / SC-009 能力条目 | 新增 `check-provider-health`：两次任务终态后只留最近一条 |
| FR-004 / FR-006 / FR-016 界面 | 扩展 `probe:ui`：多选、归档筛选、诊断卡片、能力表存在性断言 |

全部新脚本必须登记进 `tools/run-checks.js` 的 `SCRIPT_STEPS`，否则属违反宪法 II。
