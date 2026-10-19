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
- **`node` 下的 `require('electron')` 不是对象，而是那个二进制的路径字符串**（没有 `versions.electron`）。所以 `tools/check-job.js` 这类纯 node 检查不能构造 `JobManager` 去真建窗口，只能在构造后把 `buildJob` 换成不建窗口的桩。`npm run check:job`。
- **重试不能沿用旧脚本**：「上游改版」正是旧脚本造成的，`retry` 必须先 `await userscript.refresh()` 再重建任务；拉不到时用缓存版本并在 detail 写「重试使用缓存版本 vX」。`npm run check:job`。
- **`submit(raw, { script })` 的 script 要渗到 `buildJob`**：只在 submit 里拿到没用，窗口 boot 时读的还是 `userscript.get()`，两边版本号会不一致。`buildJob` 接 `script`、`submit` 透传、`retry` 传刷新结果。`npm run check:job`。
- **详情面板里写 `job.scriptVersion` 会在运行时报 `job is not defined`**：那个函数的作用域里变量叫 `j`。它不报错退出，只让抽屉渲染到一半停住、后半截（诊断块、按钮）凭空消失。`npm run probe:ui`。排查靠 `window.addEventListener('error')` 抓，不要只看面板「看起来少了几块」。
- **`probe:ui` 的 `JobManager` 曾经没接 `health`**，设置页每次读能力表都在主进程抛 `Cannot read properties of undefined (reading 'view')`，而探针读到的是 `{}`、照样绿。新探针改为断言四行且无 console 错误后才暴露。`npm run probe:ui`。
- **`render()` 末尾的 `$('#selected-resume')?.remove()` 只跑一次**（`render` 里没有重复创建按钮），删掉第一个元素的监听后按钮就再也不响应。按视图切换的按钮用 `hidden`，不要用 `remove`。
- **500 条上限的自动归档要保留原记录**：`jobs-archive.jsonl` 写入失败时不能把记录从主文件里删掉（丢用户数据），保持原样并记日志；读归档时一行坏 JSON 不能拖垮整份归档。`npm run check:archive`。
- **`jobs-archive.jsonl` 的失败路径会在临时目录删掉后才写**，出现 `ENOENT ... jobs.json.tmp` 的日志是检查脚手架在收尾，不是缺陷；判断归档缺陷看 `check:archive` 的 `ok` 行，不要看 stderr。
