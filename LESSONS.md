# LESSONS

这机器上已经踩过的坑。一条一行：坑、怎么认出来、怎么绕。能写成检查的已经写成检查，见每条后面的命令。

- **`npx electron .` 跑成了纯 node**，报 `Cannot read properties of undefined (reading 'whenReady')`。这台机器的 shell 有 `ELECTRON_RUN_AS_NODE=1`。启动前 `$env:ELECTRON_RUN_AS_NODE = $null`。
- **刚 `addUri` 的下载不能立刻暂停**，aria2 回 `GID#… cannot be paused now`。下发 `forcePause` 要重试（现为 4 次 × 300 ms）。
- **从会话恢复的下载在 unpause 之前 `totalLength`/`completedLength` 都是 0**，别据此判失败或判空。`npm run check:lifecycle`。
- **上游的挂载点选择器会漂**：迅雷脚本等 `Share__batchActionBox--`，页面是 `Share__batchActionsBox--`（多一个 s），助手就不挂。用 `ensure-anchor` 补一个壳，并带 `probe` 判断是否需要补。
- **「失效时间：永久有效」长得像分享失效**：迅雷健康分享页上就有这一句。失效正则必须要求「已被取消 / 已失效 / 链接不存在」。`npm run check:job`。
- **UC 直链不带 Cookie 会 403 `require login [auth not found]`**，而它的 UA 怎么换都没用。交 aria2 前按直链 URL 从 `session` 取 Cookie。
- **取消可能与投递竞争**：`deliver` 返回晚于 `cancel` 时，状态会被改回下载中而 aria2 继续下（实测白下了一个 320 MB 文件）。`deliverNow` 在 await 之后要检查 `settled`，并把刚推的 GID `forceRemove`。
- **文件夹里一个文件出错不该判整批失败**：等所有文件都进入 `complete`/`error` 再结算，文案写清「N 个失败 / M 个完成」。`npm run check:job`。
- **重新投递已完成的文件会下成 `.1` 副本**：`resubmit` 只推没完成的。
- **本机 6800 常被另一个 winget 版 aria2 占着**，内置下载器会换端口。调试脚本从 `%APPDATA%\linkswift-desktop\aria2-local.json` 读端口和密钥，别写死。
- **调试这个应用不要靠用户手点**：`npx electron . --remote-debugging-port=9222`，用 CDP 在渲染页填输入框、点按钮；隐藏的网盘窗口也是 CDP target，可以直接读它的 DOM 和 `__vue__`。
- **上游脚本的 `aria2.addUri` 是每文件一次**，驱动要先点「全部推送至下载器」，应用侧再合并投递，否则一个文件夹只下到第一个文件。
