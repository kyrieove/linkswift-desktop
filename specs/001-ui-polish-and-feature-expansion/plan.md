# Implementation Plan: 界面打磨与能力扩展

**Branch**: `001-ui-polish-and-feature-expansion` | **Date**: 2026-10-19 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-ui-polish-and-feature-expansion/spec.md`

## Summary

在现有 Electron 应用上做三组改动，不换技术栈、不动内部标识：

1. **状态与文案**：把取链失败的结构化诊断（驱动层已有 `{ step, verb, selector, detail }`）、
   60 秒停滞、部分完成这三种情况，从「只有技术错误」变成列表上可读、可操作的状态。
2. **任务管理**：任务记录上限从 40 提到 500，超出自动归档；新增归档视图、批量清理、
   处理中去重、一次粘贴多条链接。
3. **能力说明与重试**：设置页展示四网盘「能力等级 + 本机最近一次真实结果」，重试前强制拉取
   最新上游脚本。

技术路径沿用现有分层：主进程 `TaskStore` / `JobManager` 管状态与持久化，`src/shared/protocol.js`
是三方契约，渲染层只渲染整条 Job，预加载驱动负责页面步骤。

## Technical Context

**Language/Version**: JavaScript（Node.js 24.13.0，CommonJS，`'use strict'`）

**Primary Dependencies**: Electron 44.8.0、内置 aria2 1.37.0、jQuery 3.6.0、SweetAlert2 11.4.8、
js-md5 0.7.3（后三者本地打包）

**Storage**: 文本 JSON 落 `%APPDATA%\linkswift-desktop`：`jobs.json`（任务）、`settings.json`、
`gm-values.json`、aria2 `session.txt`

**Testing**: `npm run check`（唯一入口，`tools/run-checks.js` 依次跑语法检查、`check:share-link`、
`check:job`、`check:aria2`、`check:lifecycle`、`check:brand`、`check:runner`、`check:negative`、
`probe:ui`）

**Target Platform**: Windows 桌面（便携版，Electron 窗口）

**Project Type**: desktop-app（单仓库，无前后端分离）

**Performance Goals**: 任务列表 500 条时可流畅滚动与筛选；一次粘贴 5 条链接在 1 秒内全部入列；
状态事件仍按整条 Job 推送，不引入逐字节增量协议

**Constraints**: 不新增依赖；不动 `package.name`、`persist:linkswift`、`userData`、
`window.linkswift`、IPC 名；渲染层不用 `innerHTML`；单入口检查全绿才算完成

**Scale/Scope**: 单用户自用，任务记录上限 500 条，四网盘（夸克 / 百度 / UC / 迅雷）

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原则 | 本方案如何满足 | 结论 |
| --- | --- | --- |
| I. 上游事实先核实 | 诊断信息直接复用驱动层已实测的 `{ step, verb, selector, detail }`；能力等级取自 `DESIGN.md` 2.3 已核实表与 `docs/plans/2026-10-18-unidownload-acceptance.md` | 通过 |
| II. 单入口可复跑检查 | 每项改动都新增/扩展一个检查脚本并登记进 `SCRIPT_STEPS`；`probe:ui` 断言扩到新界面 | 通过 |
| III. 真实下载才算完成 | 部分完成只由文件级真实状态得出；归档与清理不触碰 `done` 的字节记录 | 通过 |
| IV. 登录态按密码本对待 | 不新增凭证字段；能力条目只存时间与失败码，不存 Cookie/token | 通过 |
| V. 只做最小改动 | 差异仍集中在 `providers.js` 表 + `protocol.js` 契约 + `TaskStore`；不新增页面、不新增框架 | 通过 |
| VI. 许可与署名不可回退 | 本次不碰 `NOTICE` 与打包资源 | 通过 |
| VII. 兼容优先于改名 | 存档层新增字段全部可选，旧记录按缺省值迁移（`archivedAt` 缺省 false，`MAX_RECORDS` 从 40 升到 500 不改变旧记录内容） | 通过 |

**Gate 结果：无违规，Phase 0 可开始。** 无 `NEEDS CLARIFICATION`（技术上下文全部由仓库现状确定）。

### 设计后复检（Phase 1 完成后）

重新对照七条原则，设计产物没有引入新违规：

| 关注点 | 复检结论 |
| --- | --- |
| 是否新增 phase 或新的状态机分支 | 否。部分完成、停滞都做成派生值与标志位（`research.md` D2/D3），状态机分支数不变 |
| 是否新增依赖或存储引擎 | 否。只多两个文本文件，均为同目录 JSON / JSONL |
| 是否引入新的上游猜测 | 否。诊断字段与能力等级都有仓库内证据，未新增对网盘页面的假设 |
| 是否泄露凭据 | 否。`provider-health.json` 只含 provider / 时间 / 成功与否 / 失败码 / 一句话原因 |
| 是否破坏内部标识兼容 | 否。`jobs.json` 与 `settings.json` 只增可选字段，旧版本读回忽略未知字段 |
| 检查是否可被绕过 | 否。新增检查必须登记进 `SCRIPT_STEPS`，`check:runner` 会校验脚本存在 |

**复检结果：通过，可进入 `/speckit-tasks`。**

## Project Structure

### Documentation (this feature)

```text
specs/001-ui-polish-and-feature-expansion/
├── plan.md              # 本文件
├── research.md          # Phase 0 输出
├── data-model.md        # Phase 1 输出
├── quickstart.md        # Phase 1 输出
├── contracts/           # Phase 1 输出（IPC 契约与 UI 状态契约）
└── tasks.md             # Phase 2 输出（/speckit-tasks 生成）
```

### Source Code (repository root)

```text
src/
├── main/
│   ├── main.js            窗口与生命周期
│   ├── ipc.js             IPC 注册（新增通道在此登记）
│   ├── job.js             任务状态机与投递
│   ├── task-store.js       jobs.json 读写与上限（本次改 500 + 归档）
│   ├── store.js            settings.json / gm-values.json
│   ├── userscript.js      上游脚本拉取、缓存、兜底（本次加重试前强制刷新）
│   ├── aria2.js           RPC 客户端
│   └── aria2-daemon.js    内置 aria2 进程
├── preload/
│   ├── driver.js          声明式步骤执行（诊断已产出）
│   ├── main-world.js      主世界注入
│   └── netdisk-preload.js 隔离世界与主世界中转
├── renderer/
│   ├── index.html         三处界面：列表 / 详情 / 设置
│   ├── renderer.js        渲染与交互
│   └── styles.css
└── shared/
    ├── protocol.js        三方契约（本次扩 Job 与 Settings）
    └── providers.js       四网盘声明式步骤表

tools/
├── run-checks.js          唯一检查入口（新增脚本必须登记）
├── check-job.js           任务状态与部分完成
├── check-share-link.js    链接解析与批量、去重
├── probe/probe-ui.js      界面断言
└── check-archive.js       本次新增：归档、500 上限、迁移
```

**Structure Decision**: 沿用现有单仓库 Electron 分层（main / preload / renderer / shared），
不新增目录层级；新检查脚本放在 `tools/` 与现有脚本同级，并登记进 `tools/run-checks.js`。

## Complexity Tracking

> 无宪法违规，本节留空。
