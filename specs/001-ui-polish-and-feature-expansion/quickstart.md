# 快速验证指南

实现完成后按本文件自证，不需要外网也能跑完前四步。每一步都写明预期输出。

契约细节见 [contracts/ipc-and-ui.md](./contracts/ipc-and-ui.md)，字段定义见
[data-model.md](./data-model.md)。

## 前置

```powershell
cd D:\2\dev\linkswift
node --version      # 24.x
npm run check       # 当前基线应为 All checks PASSED.
```

`ELECTRON_RUN_AS_NODE` 必须先清掉，否则 Electron 会当 Node 跑（`LESSONS.md` 第一条）：

```powershell
$env:ELECTRON_RUN_AS_NODE = $null
```

## 步骤 1 — 全量检查

```powershell
npm run check
```

预期：逐项 `OK`，末尾 `All checks PASSED.`，`EXIT=0`。新增的 `check:archive`、
`check:provider-health` 必须在输出里出现——没出现说明忘了登记进 `tools/run-checks.js`
（宪法 II）。

## 步骤 2 — 归档与 500 条上限（不需要网盘）

```powershell
npm run check:archive
```

预期输出包含：

- 写 501 条记录后，`jobs.json` 读回 500 条
- `jobs-archive.jsonl` 恰好 1 行，且该行 `id` 等于最旧那条
- 归档后 `state.files` 与 `progress` 仍在
- 旧格式（无 `archivedAt`）记录读回后 `archivedAt` 为空且不报错

## 步骤 3 — 任务状态与派生值（不需要网盘）

```powershell
npm run check:job
```

预期覆盖四条：

| 用例 | 预期 |
| --- | --- |
| 驱动返回第 3 步超时 | Job 的 `state.step === 3`，`verb` / `selector` 与驱动一致 |
| `done` + 1 个 `error` 进度 | 派生为「部分完成 1 失败 / 2 完成」 |
| 60 秒无字节增长 | `stalled === true`；字节一增立刻清成 `false` |
| `retry` 且上游刷新成功 | 新任务 `scriptOrigin === 'upstream'`，`scriptVersion` 变化 |

## 步骤 4 — 批量粘贴与去重（不需要网盘）

```powershell
npm run check:share-link
```

预期：

- 一段含 3 条链接的中文文本 → 解析出 3 条
- 其中一条带 `?pwd=` → `passcode` 与链接正确配对
- 同一链接连提两次 → 第二次返回 `duplicateOf`，不新建任务
- 已完成后的再次提交 → 返回新 `jobId`，不被去重挡住

## 步骤 5 — 界面断言（Electron 探针）

```powershell
npm run probe:ui
```

预期：断言数在现有 40 条基础上增加，末尾 `PROBE OK`，截图落在 `%TEMP%\linkswift-probe-*.png`。
截图里能看到：五态任务的 `data-phase` 不同、批量操作条、失败任务的诊断块、设置页四行能力表。

## 步骤 6 — 真实下载验收（需要已登录的网盘）

1. `npm start`
2. 粘贴一条夸克或 UC 分享链接（含提取码）
3. 预期：任务入列 → 显示当前阶段 → 落盘，详情里逐文件进度与字节数一致，结束无 `.aria2` 残留
4. 把已完成任务归档 → 主列表消失，归档视图能看到，恢复后回到主列表
5. 制造一次失败（断网或用一个无效分享）→ 详情里出现步骤序号与目标，重试按钮可点；
   点重试后 `scriptVersion` 为本次拉取的版本（拉不到时 detail 注明缓存版本）

## 步骤 7 — 不破坏既有行为（宪法 VII）

```powershell
npm start        # 重启后
```

预期：历史任务全部原样载入，数量与重启前一致（除本轮主动归档的），设置项未变，
网盘登录态仍在，aria2 会话续传可用。

## 通过标准

| 需求 | 覆盖步骤 |
| --- | --- |
| FR-001 / FR-011 批量与去重 | 4 |
| FR-002 / FR-007 诊断 | 3、5、6 |
| FR-004 / FR-005 五态与部分完成 | 3、5 |
| FR-006 / FR-015 归档与上限 | 2、5、6 |
| FR-008 重试拉新脚本 | 3、6 |
| FR-009 停滞 | 3、5 |
| FR-012 / SC-009 能力条目 | 1、5、6 |
| FR-013 / SC-006 兼容 | 2、7 |
| FR-014 / SC-007 / SC-008 检查 | 1 |

任一步骤失败即本轮未完成，不得以「其余检查通过」作结论。
