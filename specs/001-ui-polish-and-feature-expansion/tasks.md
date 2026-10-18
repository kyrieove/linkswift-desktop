# Tasks: 界面打磨与能力扩展

**Input**: Design documents from `specs/001-ui-polish-and-feature-expansion/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/ipc-and-ui.md, quickstart.md

**Tests**: 本特性要求「新行为必须有新检查覆盖」（FR-014 / SC-008），因此每个故事都带检查任务；
检查先写、先看它失败（宪法 II）。仓库没有测试框架，检查脚本即测试，统一走 `npm run check`。

**Organization**: 按用户故事分组，每个故事可独立实现与验证。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 不同文件、互不依赖，可并行
- **[Story]**: 对应 spec.md 里的用户故事
- 每条任务都写了确切文件路径

## Phase 1: Setup（共享准备）

**Purpose**: 契约先行。三方契约与注册表是本轮所有故事的公共底座。

- [ ] T001 在 `src/shared/protocol.js` 里为 `failed` 增加可选 `step` / `verb` / `selector` / `hint`，为 `Job` 增加 `stalled`、`scriptVersion`、`scriptOrigin`、`archivedAt`；四个新字段全部可选，旧记录缺字段按缺省值
- [ ] T002 [P] 在 `src/shared/protocol.js` 定义 `ProviderHealth` 并新增 IPC 名 `archive` / `unarchive` / `purge` / `providerHealth`（`contracts/ipc-and-ui.md` 第一节）
- [ ] T003 [P] 在 `src/main/store.js` 的 `DEFAULT_SETTINGS` 增加 `archiveLimit: 500`，读取时校验范围 100–2000，越界回落 500
- [ ] T004 在 `tools/run-checks.js` 登记即将新增的 `check:archive` 与 `check:provider-health`（先登记会让 `npm run check` 失败，这是预期的红灯）

**Checkpoint**: 契约与注册表就位，`npm run check` 因缺脚本而红——后续每个故事把它逐步变绿。

---

## Phase 2: Foundational（阻塞所有故事）

**Purpose**: 任务存储容量与归档基础，多个故事都要读它。

**⚠️ CRITICAL**: 本阶段完成前，任何用户故事都不要动 `TaskStore`

- [ ] T005 在 `src/main/task-store.js` 把 `MAX_RECORDS` 从 40 改为从设置读取（缺省 500），超出时把最旧的整条记录追加到 `jobs-archive.jsonl` 再移出主文件，追加失败时保留原记录并记日志
- [ ] T006 在 `src/main/task-store.js` 实现 `archive(ids)` / `unarchive(ids)` / `removeMany(ids)`，只接受 `done` 与 `failed`，其余返回跳过数；归档只写 `archivedAt`，不删任何字段
- [ ] T007 [P] 新建 `tools/check-archive.js`：造 501 条记录断言主文件 500 条、归档文件恰 1 行且 `id` 为最旧；再断言归档后 `state.files` 与 `progress` 仍在、旧格式记录读回不报错
- [ ] T008 在 `tools/run-checks.js` 确认 `check:archive` 已被调用且失败时整体非零退出

**Checkpoint**: 存储层可承载 500 条并归档，`npm run check:archive` 绿。

---

## Phase 3: User Story 1 - 打开即用的下载主流程（Priority: P1）🎯 MVP

**Goal**: 取链的每个阶段都能说清当前在做什么、失败在哪一步，并且一条任务等待人工时其他任务照常跑。

**Independent Test**: 用一段含 3 条链接的文本提交，其中 1 条需要登录：其余 2 条照常完成，需要登录的那条单独停在「需你操作一步」并给出下一步。

### Implementation for User Story 1

- [ ] T009 [US1] 在 `src/main/job.js` 把驱动返回的 `{ step, verb, selector, detail }` 映射进 `state.step` / `state.verb` / `state.selector`，并按失败码生成一句中文 `hint`（`upstream-redesigned` → 「页面结构变了，先点重试拉最新脚本」）
- [ ] T010 [US1] 在 `src/renderer/renderer.js` 为任务行加 `data-job-id` 与 `data-phase`，状态标签函数区分五种状态（下载中 / 已暂停 / 需你操作一步 / 已失败 / 已完成含部分完成），并给需要人工的任务加直达按钮
- [ ] T011 [US1] 在 `src/renderer/index.html` 与 `src/renderer/styles.css` 增加诊断块 `.diagnostic`（步骤序号、目标、复制按钮）与停滞提示 `.stall-notice`
- [ ] T012 [US1] 在 `src/main/job.js` 保证一条任务进入 `needs-human` 不阻塞其他任务的提交与推进：提交入口不做全局串行，只有同一分享链接的处理中去重
- [ ] T013 [US1] 扩展 `tools/check-job.js`：驱动返回第 3 步超时 → 断言 `state.step === 3` 且 `verb` / `selector` 与驱动一致；断言 `hint` 非空
- [ ] T014 [P] [US1] 在 `tools/probe/probe-ui.js` 增加断言：五行任务的 `data-phase` 各不相同、状态标签文字正确、诊断块在失败任务上存在

**Checkpoint**: US1 独立可验——失败原因是人话，五种状态一眼可辨。

---

## Phase 4: User Story 2 - 界面信息一眼可读（Priority: P1）

**Goal**: 不点开详情就能判断一条任务是否需要自己动手；空结果能区分「筛选为空」与「还没有任务」。

**Independent Test**: 造五种状态各一条任务，不展开任何详情，能正确说出每条在做什么、要不要自己动手。

### Implementation for User Story 2

- [ ] T015 [P] [US2] 在 `src/renderer/renderer.js` 把状态标签与说明文案抽成单处映射表，五种状态各一行，避免标签与文案不同步
- [ ] T016 [US2] 在 `src/renderer/renderer.js` 为「需你操作一步」的任务在列表行上直接显示要做什么（如「请在弹出的窗口中选择文件」）并提供直达入口按钮
- [ ] T017 [US2] 在 `src/renderer/renderer.js` 区分空态：筛选后为空显示「筛选为空」与「清除筛选」按钮；无任何任务显示「还没有任务」与粘贴引导
- [ ] T018 [P] [US2] 在 `tools/probe/probe-ui.js` 断言两种空态文案不同、清除筛选按钮存在且点击后恢复列表

**Checkpoint**: US1 与 US2 都能独立工作，界面信息层级成立。

---

## Phase 5: User Story 3 - 多任务批量处理（Priority: P2）

**Goal**: 一次粘贴多条链接、批量清理与归档已完成任务。

**Independent Test**: 粘贴含 3 条链接的文本，3 条任务全部创建；其中 1 条不可识别时其余 2 条不受影响；批量归档后主列表只剩未完成项。

### Implementation for User Story 3

- [ ] T019 [US3] 在 `src/main/job.js` 的 `submit` 支持整段文本：复用 `src/shared/providers.js` 逐条解析，返回 `{ ok, jobs: [{ raw, jobId?, duplicateOf?, error? }] }`（契约第一节）
- [ ] T020 [US3] 在 `src/main/job.js` 实现处理中去重：只对 `loading` / `extracting` / `needs-human` / `linked` / `delivering` / `downloading` / `paused` 七种 phase 按 `provider + shareId` 去重，`done` / `failed` 不参与
- [ ] T021 [US3] 在 `src/renderer/renderer.js` 提交后逐条提示结果：新建几条、重复几条、无法识别几条，互不阻塞
- [ ] T022 [US3] 在 `src/renderer/index.html` 与 `src/renderer/styles.css` 增加行内多选复选框 `.job-select`、批量操作条 `.bulk-bar`（归档 / 删除）与归档筛选开关 `.filter-archive`
- [ ] T023 [US3] 在 `src/main/ipc.js` 接入 `linkswift:jobs:archive` / `unarchive` / `purge` 三个通道，转发到 `TaskStore` 的对应方法
- [ ] T024 [US3] 扩展 `tools/check-share-link.js`：一段中文文本切 3 条、`?pwd=` 与链接正确配对、重复提交返回 `duplicateOf`、已完成后再提交返回新 `jobId`
- [ ] T025 [P] [US3] 在 `tools/probe/probe-ui.js` 断言多选后批量操作条出现、归档筛选只显示已归档任务

**Checkpoint**: 批量入口与归档链路可独立验证。

---

## Phase 6: User Story 4 - 从「拿到直链」到「真正下完」可追（Priority: P2）

**Goal**: 整体与逐文件进度、部分完成、60 秒停滞提示。

**Independent Test**: 一条多文件任务里 1 个失败其余成功 → 显示「部分完成 1 失败 / 2 完成」；下载中速度归零 60 秒 → 出现「可能已停滞」与重试入口且不自动重试。

### Implementation for User Story 4

- [ ] T026 [US4] 在 `src/main/job.js` 的进度轮询里记录最后一次字节增长时刻，超过 60000ms 且仍在 `downloading` 时置 `stalled: true` 并推送一次事件，字节一增立刻清成 `false`
- [ ] T027 [US4] 在 `src/renderer/renderer.js` 由 `progress[]` 派生部分完成文案「部分完成 N 失败 / M 完成」，不新增 phase
- [ ] T028 [US4] 在 `src/renderer/renderer.js` 详情面板逐文件显示状态：`complete → 下载完成`、`error → 下载失败（带 errorMessage）`、有长度 → 字节进度、无进度 → 沿用现有 `doneDetail()`
- [ ] T029 [US4] 扩展 `tools/check-job.js`：`done` + 1 个 `error` 进度派生部分完成；假时钟推进 61 秒无增长出现 `stalled`，字节增加后清除
- [ ] T030 [P] [US4] 在 `tools/probe/probe-ui.js` 断言停滞提示与重试按钮存在且按钮可点

**Checkpoint**: 进度与结算可独立验证。

---

## Phase 7: User Story 5 - 取链失败可自愈（Priority: P2）

**Goal**: 失败给出具体步骤位置与可复制诊断；重试强制拉取最新上游脚本，拉不到则退回缓存并说明版本。

**Independent Test**: 人为破坏一个页面选择器 → 界面显示「第 3 步：等待 xxx 超时」并可复制；点重试后 `scriptVersion` 变为本次拉取的版本；断网重试时 detail 注明缓存版本。

### Implementation for User Story 5

- [ ] T031 [US5] 在 `src/main/job.js` 的 `retry` 改为先 `await userscript.refresh()` 再重建任务：成功用新脚本、失败沿用当前版本，并在任务 `detail` 注明「重试使用缓存版本 vX」
- [ ] T032 [US5] 在 `src/main/job.js` 任务上记录 `scriptVersion` 与 `scriptOrigin`（`upstream` / `cache` / `bundled`），随 Job 推送
- [ ] T033 [US5] 在 `src/renderer/renderer.js` 诊断块提供「复制诊断」按钮与「重试」按钮，复制内容含步骤序号、目标、脚本版本与时间
- [ ] T034 [US5] 扩展 `tools/check-job.js`：`refresh` 打桩返回新版本时重试后 `scriptOrigin === 'upstream'` 且版本变化；打桩失败时版本不变且 detail 含「缓存版本」
- [ ] T035 [P] [US5] 在 `tools/probe/probe-ui.js` 断言诊断块含步骤序号文本、复制与重试按钮存在

**Checkpoint**: 失败可定位、可自愈，且不无限重试。

---

## Phase 8: User Story 6 - 网盘能力在界面里说得清（Priority: P3）

**Goal**: 设置页列出四网盘能力等级与本机最近一次真实结果，不支持的链接在建任务前就挡住。

**Independent Test**: 打开设置页，四个网盘各一行；无记录的显示「未验证」；提交一条不支持网盘的链接，直接提示且不创建任务。

### Implementation for User Story 6

- [ ] T036 [US6] 在 `src/main/task-store.js` 增加 `provider-health.json` 读写：每个网盘只留最近一条 `{ provider, at, ok, code?, hint? }`，文件损坏时视为全「未验证」并记日志
- [ ] T037 [US6] 在 `src/main/job.js` 任务进入 `done` / `failed` 终态时更新所属网盘的 `ProviderHealth` 记录
- [ ] T038 [US6] 在 `src/main/ipc.js` 接入 `linkswift:provider:health`，返回四条（含无记录网盘的「未验证」占位）
- [ ] T039 [US6] 在 `src/renderer/index.html` 与 `src/renderer/renderer.js` 增加设置页能力表 `.provider-health`（能力等级取 `DESIGN.md` 2.3 已核实结论，状态取本机记录）与归档管理 `.archive-count` + 清空归档按钮
- [ ] T040 [US6] 在 `src/main/job.js` 对不支持网盘的链接在创建任务前返回 `unsupported-provider` 说明，不建任务
- [ ] T041 [P] [US6] 新建 `tools/check-provider-health.js`：两次终态后只留最近一条；文件损坏时返回全「未验证」
- [ ] T042 [P] [US6] 在 `tools/probe/probe-ui.js` 断言能力表四行存在、未验证单元格文本为「未验证」

**Checkpoint**: 六类故事各自可独立验证。

---

## Phase 9: Polish（收尾与横切）

- [ ] T043 [P] 更新 `README.md`：批量粘贴、归档、诊断与重试、能力表四处说明，保持与实现一致
- [ ] T044 [P] 更新 `LESSONS.md`：本轮新增的坑（如 500 上限与归档文件的损坏处理）一行一条
- [ ] T045 跑 `quickstart.md` 全部 7 步并记录真实输出，未完成项如实列入报告
- [ ] T046 跑 `npm run check` 全绿，确认输出里出现 `tools/check-archive.js` 与 `tools/check-provider-health.js` 两项
- [ ] T047 自审本轮 diff 涉及 `src/` 全部改动：删死代码、只有单一取值的循环、重复逻辑；确认 `package.json`、`src/main/main.js` 中的内部标识未变

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup（Phase 1）**：无依赖，可立即开始
- **Foundational（Phase 2）**：依赖 Setup，阻塞所有故事对 `TaskStore` 的改动
- **User Stories（Phase 3–8）**：均依赖 Foundational；同一批文件（`job.js`、`renderer.js`）被多个故事改动，实际按优先级串行推进，仅标 [P] 的检查任务可并行
- **Polish（Phase 9）**：依赖所需故事完成

### User Story Dependencies

- **US1（P1）**：依赖 Phase 2，无其他故事依赖
- **US2（P1）**：依赖 US1 的 `data-phase` 基础（T010），其余独立
- **US3（P2）**：独立，但归档 UI 复用 US2 的空态
- **US4（P2）**：独立，部分完成派生不依赖 US3
- **US5（P2）**：依赖 US1 的诊断字段（T009）
- **US6（P3）**：独立，只要终态事件存在

### Within Each User Story

检查任务先写并确认失败 → 再写实现 → 最后跑 `npm run check` 变绿。同一故事里标 [P] 的检查任务可与实现并行准备。

### Parallel Opportunities

- T002、T003 与 T001 不同文件，可并行
- T007 与 T005/T006 可并行编写（先红后绿）
- 每个故事末尾的 `probe:ui` / `check-*` 扩展任务互相独立，可并行

---

## Parallel Example: User Story 1

```text
Task: "T013 扩展 tools/check-job.js：断言 state.step / verb / selector"
Task: "T014 在 tools/probe/probe-ui.js 增加五种 data-phase 与诊断块断言"
```

---

## Implementation Strategy

### MVP First（US1 单独交付）

1. Phase 1 Setup → Phase 2 Foundational
2. Phase 3 US1
3. 停下验证：三种链接里只有登录那条卡住，其余照常；失败文案是人话
4. 此时已是可用增量，可先提交

### Incremental Delivery

1. Setup + Foundational → 存储与契约就位
2. US1 → 验证 → 提交
3. US2 → 验证 → 提交
4. US3 → US4 → US5 → US6 逐个验证、逐个提交
5. 每轮都跑 `npm run check`，任何一步非零都不进下一步

---

## Notes

- [P] = 不同文件、无依赖
- 每个故事结束时必须有一次可复跑的绿，不允许「其余检查通过」作结论
- 未完成项写进报告而不是勾掉
- 提交按故事分组，commit 前跑一次 `npm run check`
