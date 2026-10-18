# 契约：IPC 与界面状态

三处契约共同定义本特性。三者都以 `src/shared/protocol.js` 为唯一真源，文档只描述增量部分。

## 一、渲染层 → 主进程（`ipcRenderer.invoke`）

现有通道名与语义不变；下表只列本特性新增或语义变化的通道。

### 新增

| 通道 | 参数 | 返回 | 说明 |
| --- | --- | --- | --- |
| `linkswift:jobs:archive` | `{ ids: string[] }` | `{ ok: boolean, archived: number }` | 归档指定任务（只接受 `done` / `failed`） |
| `linkswift:jobs:unarchive` | `{ ids: string[] }` | `{ ok: boolean, restored: number }` | 从归档恢复 |
| `linkswift:jobs:purge` | `{ ids: string[] }` | `{ ok: boolean, removed: number }` | 批量删除（只接受 `done` / `failed`） |
| `linkswift:provider:health` | 无 | `{ ok: true, entries: ProviderHealth[] }` | 四网盘能力条目（含「未验证」占位） |

### 语义变化

| 通道 | 变化 |
| --- | --- |
| `linkswift:submit` | `{ raw }` 支持整段文本，返回由 `{ ok, jobId }` 变为 `{ ok, jobs: Array<{ raw, jobId?, duplicateOf?, error? }> }`；调用方必须逐条判断 |
| `linkswift:retry` | 先强制刷新上游脚本；返回增加 `scriptVersion`、`scriptOrigin` |

**错误形状**（沿用现状）：`{ ok: false, message: string }`，message 是可直接显示的中文。

## 二、主进程 → 渲染层（`webContents.send`）

只有 `linkswift:job:event` 一条，参数仍是一整条 `Job`。

新增字段：`stalled`、`scriptVersion`、`scriptOrigin`、`archivedAt`，以及 `state.step` /
`state.verb` / `state.selector` / `state.hint`（仅 `failed`）。

渲染层**不得**自行推断任务状态，派生值只在渲染时计算一次：

| 派生值 | 规则 |
| --- | --- |
| 状态标签 | `downloading` → 下载中；`paused` → 已暂停；`needs-human` → 需你操作一步；`failed` → 已失败；`done` 且存在 `status === 'error'` 的进度 → 部分完成；其余 `done` → 已完成 |
| 停滞角标 | `stalled === true` 时在下载中任务上显示「可能已停滞」 |
| 主列表 | `archivedAt` 有值的任务不显示 |

## 三、界面契约（`renderer/index.html`）

新增能力全部落在现有三处，不新增页面（FR-016）。可断言的元素与数据属性：

| 区域 | 要求 | 断言（`probe:ui`） |
| --- | --- | --- |
| 任务列表 | 每条任务行有 `data-job-id` 与 `data-phase`，可区分五种状态 | 造五种状态，断言五行 `data-phase` 各不相同且标签文字正确 |
| 任务列表 | 多选：行内复选框 `.job-select`，选中后出现批量操作条 `.bulk-bar` | 选中两条后断言操作条出现且按钮为「归档」「删除」 |
| 任务列表 | 归档筛选：`.filter-archive` 开关 | 打开后只显示 `archivedAt` 有值的任务 |
| 详情面板 | 失败时显示诊断块 `.diagnostic`，含步骤序号、目标、可复制按钮 | 造一条带 `step/verb/selector` 的失败任务，断言块存在且文本含步骤序号 |
| 详情面板 | 停滞提示 `.stall-notice` 带「重试」按钮 | 造 `stalled: true`，断言提示存在且按钮可点 |
| 设置页 | 网盘能力表 `.provider-health`，四行 | 断言四行存在，未验证网盘的单元格文本为「未验证」 |
| 设置页 | 归档管理：`.archive-count` 与「清空归档」按钮 | 断言计数文本与按钮存在 |

**不可变的界面约束**（来自 ADR 0003）

- 不在任务前加文件/文件夹类型图标列。
- 不把「已投递」显示成「已完成」。
- 深浅主题仍按根元素类切换。

## 四、文件契约

| 文件 | 写入方 | 读方 | 兼容要求 |
| --- | --- | --- | --- |
| `jobs.json` | `TaskStore` | `TaskStore` | 最多 500 条；未知字段忽略；旧记录不含新字段时按缺省值 |
| `jobs-archive.jsonl` | `TaskStore` | `TaskStore` | 追加式，一行一条 JSON；文件缺失视为空归档 |
| `provider-health.json` | `TaskStore` | `ipc` | 每网盘最多一条；文件损坏时视为全「未验证」并记日志 |
| `settings.json` | `Store` | `Store` | `archiveLimit` 缺省 500 |

以上文件都位于 `%APPDATA%\linkswift-desktop`，从不写进仓库或可执行文件旁（宪法 IV）。
