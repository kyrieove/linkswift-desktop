# 数据模型

本特性不新增存储引擎，只扩展现有的三个 JSON 文件与 `Job` 结构。所有新字段都是可选的，
旧文件缺字段时按缺省值解释，保证升级后历史任务原样可用（FR-013 / SC-006）。

## 一、Job（`src/shared/protocol.js`，内存 + 推送契约）

现有字段不变：`id`、`link: ShareLink`、`state: JobPhase`、`createdAt`、`restored?`。

新增：

| 字段 | 类型 | 缺省 | 含义 | 来源需求 |
| --- | --- | --- | --- | --- |
| `state.step` | number | 无 | 失败的步骤序号（0 起） | FR-007 |
| `state.verb` | string | 无 | 失败的步骤动词（`click` / `wait-for` / `fill` …） | FR-007 |
| `state.selector` | string | 无 | 失败时定位不到的目标 | FR-007 |
| `state.hint` | string | 无 | 一句话人话原因（「页面结构变了，先重试」） | FR-002 |
| `stalled` | boolean | `false` | 下载中连续 60 秒无字节增长 | FR-009 |
| `scriptVersion` | string | 无 | 本次取链实际使用的上游脚本版本 | FR-008 |
| `scriptOrigin` | `'upstream' \| 'cache' \| 'bundled'` | 无 | 版本来自哪里 | FR-008 |
| `archivedAt` | number | 无 | 用户归档时间；有值则不在主列表 | FR-006 |

**校验规则**

- `step` / `verb` / `selector` 只在 `state.phase === 'failed'` 时允许出现。
- `stalled` 只在 `downloading` / `paused` 上有意义，其余 phase 必须为 `false`。
- `archivedAt` 只能出现在 `done` / `failed` 的任务上。

**状态迁移（在现有状态机上叠加，不加新 phase）**

```text
loading → extracting → linked → delivering → downloading ⇄ paused → done
   │           │                                 │
   └───────────┴──────────► needs-human ─────────┤
                                │                └──► failed（带 step/verb/selector/hint）
                                └──► extracting（登录或补一步后继续）

done / failed ──(用户归档)──► 仍在 jobs.json，但 archivedAt 有值，主列表不显示
超过 500 条 ──(自动)──► jobs-archive.jsonl，从 jobs.json 移除
```

派生值（不落盘、不新增 phase）：

- **部分完成**：`phase === 'done'` 且 `progress` 中 `status === 'error'` 的数量 > 0。

## 二、DownloadProgress（不变）

`gid`、`name`、`status`、`totalLength`、`completedLength`、`downloadSpeed`、`connections`、
`errorCode?`、`errorMessage?`。逐文件进度与部分完成的判定都用它，不新增字段。

## 三、TaskRecord（`jobs.json` 一行）

现有字段保持（`id`、`link`、`state`、`createdAt`、`updatedAt`、`gid`、`files` 等），新增：

| 字段 | 类型 | 缺省 | 含义 |
| --- | --- | --- | --- |
| `archivedAt` | number | 无 | 用户归档 |
| `scriptVersion` | string | 无 | 便于复现当时的取链环境 |

**容量规则**：`jobs.json` 最多 500 条（`TaskStore.MAX_RECORDS`，原为 40）。超出时把
`createdAt` 最旧的一条追加到 `jobs-archive.jsonl` 并从主文件移出。归档记录不删字段。

## 四、ProviderHealth（`provider-health.json`，本次新增文件）

每个网盘只留最近一条真实任务结果。

| 字段 | 类型 | 含义 |
| --- | --- | --- |
| `provider` | `'quark' \| 'baidu' \| 'uc' \| 'xunlei'` | 网盘 |
| `at` | number | 该结果的时间戳 |
| `ok` | boolean | 是否成功取到链接并投递 |
| `code` | FailureCode | 失败时的失败码（成功时无） |
| `hint` | string | 失败时的一句话原因（成功时无） |

**校验规则**：一个 `provider` 只允许一条；没有记录时界面显示「未验证」（FR-012 / SC-009）。
不存任何 Cookie、token 或直链（宪法 IV）。

## 五、Settings（`settings.json`，字段追加）

| 字段 | 类型 | 缺省 | 含义 |
| --- | --- | --- | --- |
| `archiveLimit` | number | `500` | 主列表保留条数，允许 100–2000 |

其余字段（`delivery`、`aria2Mode`、`aria2`、`allowTransfer`、`autoSubmit`）不变。

## 六、实体关系

```text
ShareLink 1 ── * Job         一次粘贴一条链接对应一条任务
Job 1 ── * DownloadProgress  一条任务下每个文件一条进度
Job * ── 1 ProviderHealth    任务终态时更新所属网盘的最近一条记录
TaskRecord ≡ Job 的落盘形态  两者字段一一对应（TaskRecord 不含 progress 的实时值）
```

## 七、不变量

1. `done` 的任务不能因为重新投递被改回 `downloading`（沿用 `LESSONS.md` 的 `.1` 副本教训）。
2. 归档与自动归档都不得删除 `state.files` / `progress` 记录，只改变可见性。
3. 处理中去重只看 `loading` / `extracting` / `needs-human` / `linked` / `delivering` /
   `downloading` / `paused` 七种 phase；`done` / `failed` 不参与去重。
4. 任何新增字段写盘后，旧版本读回时忽略未知字段，不报错。
