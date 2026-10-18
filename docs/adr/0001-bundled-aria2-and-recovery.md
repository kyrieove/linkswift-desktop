# 0001 内置 aria2，任务可暂停、可恢复

日期：2026-10-18
状态：已采纳

## 背景

用户要的是「打开软件、粘贴链接就能下」。原来的实现把 aria2 当成用户已经跑着的 RPC 服务，要自己装、自己填地址和密钥，这是首次使用最难的一步。任务也没有暂停/继续，软件一退出，下载就无从找回。

## 决定

1. `resources/aria2/aria2c.exe`（1.37.0，GPL-2.0-or-later）随仓库走，`src/main/aria2-daemon.js` 在 `app.whenReady` 里拉起。只监听 127.0.0.1，RPC 密钥随机生成并存进 `aria2-local.json`，端口默认 6800，被占用就换一个并记住。
2. 启动前先探活：同端口 + 同密钥有 aria2 就接管，不再拉起第二个（崩溃后留下的孤儿进程还能继续用它自己的会话）。
3. 断点续传交给 aria2 自己：`--continue=true`、`--save-session`、`--save-session-interval=5`，退出时先 `aria2.saveSession` 再 `aria2.shutdown`，让 aria2 自己写会话。
4. 应用侧再存一份：`jobs.json` 记 id、分享链接、直链、GID、状态。重启恢复阶梯是 GID → 问 aria2；问不到就把直链重推一次；仍失败才判「直链已过期」并给「重新取链」。
5. 暂停 / 继续 / 取消走 `aria2.forcePause` / `aria2.unpause` / `aria2.forceRemove` + `removeDownloadResult`。「继续」同时覆盖两种情况：暂停态就 unpause，出错态就重推 URI（aria2 按 `.aria2` 控制文件接着下）。
6. 任务状态机新增 `linked`（已拿到链接）与 `paused`（已暂停），和「下载中」「下载失败」「下载完成」并列，界面按这四个状态显示。
7. 文件夹多文件：驱动先点脚本的「全部推送至下载器」，应用侧把 1.5 秒内的多个 `aria2.addUri` 合并成一次投递。

## 否掉的方案

- **只支持外部 aria2**：用户明确说「当前还要单独准备 aria2、配置连接」，这就是要解决的痛点。
- **Electron 自己记进度、重下**：aria2 的 `.aria2` 控制文件本来就是干这个的，重造一遍只会更差。
- **退出时直接 kill aria2**：会丢最多一个 `--save-session-interval` 的会话，也让下次分不清孤儿进程是谁的。

## 后果

- 仓库多 5.6 MB 二进制，GPL 许可证必须随二进制分发（`NOTICE`、`resources/aria2/COPYING`）。
- 6800 常常被别的 aria2 占着（本机就有一个 winget 装的），所以端口不固定，调试脚本不能写死 6800。
- 退出要走「`before-quit` 里 preventDefault → 异步收尾 → 再 `app.quit()`」的路子。
- 已完成文件不能被重新投递，否则会下成 `.1` 副本；`resubmit` 跳过 `complete` 的文件。
