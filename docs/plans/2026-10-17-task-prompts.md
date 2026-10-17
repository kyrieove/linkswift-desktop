# 下一阶段任务提示词（2026-10-17）

每个任务开一个新会话，把对应「提示词」整段复制成第一条消息。顺序：1 → 2 → 3A →（你看 HTML 稿）→ 3B → 4 → 5。2 和 3A 改的文件不重叠，可以同时开两个会话。

所有任务共用的前提已经写在各自提示词里，不需要额外补充。

---

## 任务 1：推公开仓库

```
在 D:\2\dev\linkswift（LinkSwift 桌面版，Electron，AGPL-3.0）把现有仓库推到 GitHub 公开仓库。

已确认的决定（不要再问）：
- 仓库名 kyrieove/linkswift-desktop，public，gh 已认证活跃账号 kyrieove。
- 保留全部 git 历史直接推，不压缩、不改写。文档里的两条测试分享链接（含百度提取码）允许公开。
- probe-readme.md 是未跟踪文件，不提交、不删除。
- RPC 密钥 linkswift-local-check 只用于本机 127.0.0.1:6800，可以公开。

步骤：
1. git status --short，确认除 probe-readme.md 外没有未提交改动；有的话停下来问我。
2. 检查 LICENSE（AGPL-3.0）和 NOTICE（署名上游作者 hmjz100 与 油小猴）存在且非空。
3. gh repo create kyrieove/linkswift-desktop --public --source . --remote origin --description "粘贴网盘分享链接，后台取直链，推给 aria2" --push
4. 验证：gh repo view kyrieove/linkswift-desktop --json visibility,url，以及 git log origin/main -1 与本地 HEAD 一致。

完成标准：仓库可见性为 PUBLIC，远端 HEAD = 本地 HEAD。汇报仓库 URL。不要做别的改动。
```

---

## 任务 2：调试开关 + addUri 选项纯函数与检查脚本

```
在 D:\2\dev\linkswift（LinkSwift 桌面版，Electron 44，Node 24，无 lint/test/CI）做两个小改动。先读 HANDOFF.md 的「调试方法」一节。

改动 A：调试开关
- src/main/job.js 里现在没有统一的调试输出，过去排查时只能临时加 console.log。
- 加一个开关：环境变量 LINKSWIFT_DEBUG=1 时，打印每条 observation（页面回传的观测）和代理请求的响应摘要（method、url、status、响应前 300 字符）；未设置时完全不打印。
- 实现就一个 const DEBUG = process.env.LINKSWIFT_DEBUG === '1' 加少量 if (DEBUG) console.log(...)，不要引入日志库或日志级别。

改动 B：addUri 选项纯函数
- src/main/aria2.js 的 addUri（约第 81–100 行）里内联构造 aria2 选项：转发 UA / Referer、把 Cookie 放进 header 选项（缺 Cookie 时夸克返回 412）、对 *.quark.cn 设 split=16 和 max-connection-per-server=16。
- 把选项构造抽成导出的纯函数 buildAddUriOptions(file)（输入 {url, headers, ...}，输出 options 对象），addUri 调用它，行为不变。
- 新建 tools/check-aria2-options.js：用 node:assert 断言至少这几条：
  1. 带 Cookie 的 headers → options.header 含 "Cookie: ..."
  2. 夸克域名 → split 和 max-connection-per-server 都是 '16'
  3. 百度域名 → 不设这两项（百度是否开 16 连接留给后续实测）
  4. UA、Referer 被正确转发
- package.json 加 "check:aria2": "node tools/check-aria2-options.js"。

验证：
- npm run check:aria2 通过；故意把 Cookie 转发那行注释掉，确认检查会失败，再恢复。
- node --check src/main/job.js src/main/aria2.js
- 用 $env:LINKSWIFT_DEBUG="1"; npx electron . 启动，主进程 stdout 能看到调试行；不设变量时看不到。启动后关掉即可，不需要提交链接。

完成后按「改动 A」「改动 B」各一个 commit，提交信息用中文、约定式前缀（feat/test）。只提交本任务改的文件，probe-readme.md 不动。不推送。
```

---

## 任务 3A：下载进度 UI 的 HTML 设计稿（只出稿，不接代码）

```
为 D:\2\dev\linkswift（LinkSwift 桌面版）设计任务卡的下载进度 UI，只交一个静态 HTML 稿给我看，不改应用代码。

背景：
- 现在任务推给 aria2 后，任务卡只显示「已完成」（含义只是推送成功），看不到下载进度；aria2 下载失败（例如 412）时面板仍显示「已完成」。
- 现有界面：src/renderer/index.html、src/renderer/styles.css、src/renderer/renderer.js。先读它们，设计稿必须沿用现有配色、字体、间距和任务卡结构，看起来像同一个应用。

任务卡要显示（数据来源是 aria2.tellStatus，每秒刷新一次）：
- 文件名
- 进度条 + 百分比
- 当前速度（如 8.6 MiB/s）
- 已下载 / 总大小（如 120.4 / 320.3 MiB）
- 剩余时间（如 23 秒、4 分 10 秒）
- 连接数（如 16）
- 状态：提取中 → 已推送等待中 → 下载中 → 完成；或失败（显示 aria2 错误码和中文原因，如「412：网盘拒绝请求，可能是登录 Cookie 失效」）

不做：顶部总速度、暂停/继续按钮。

交付：
- 文件 docs/design/progress-mockup.html，单文件、无外部依赖，直接双击能在浏览器打开。
- 页面里并排放 5 张示例卡片，分别是：提取中、等待中、下载中（约 37%）、完成、失败（412）。
- 下载中那张用一小段 JS 模拟进度和速度每秒变化，方便看动态效果。
- 窄窗口（宽 420px）下也不横向滚动。

完成后用浏览器打开截图确认渲染正常，把文件路径告诉我，然后停下等我反馈。不 commit（我看过再定）。
```

---

## 任务 3B：把进度 UI 接到真实数据（等我确认 3A 的稿子后再开）

```
在 D:\2\dev\linkswift（LinkSwift 桌面版）按已确认的设计稿 docs/design/progress-mockup.html 实现任务卡下载进度。先读 HANDOFF.md、该设计稿，以及 src/main/job.js、src/main/aria2.js、src/shared/protocol.js、src/renderer/renderer.js。

现状：
- src/main/job.js 约第 711 行：for (const file of files) await aria2.addUri(settings.aria2, file); —— addUri 返回的 gid 被丢掉了。
- src/main/aria2.js 只有 getVersion / addUri / endpoint，没有查询状态的函数。
- 任务推送成功后状态直接变成完成。

要做：
1. aria2.js 加 tellStatus(config, gid)，取 status、totalLength、completedLength、downloadSpeed、connections、errorCode、errorMessage 这些字段。
2. job.js 保存每个文件的 gid；推送后任务进入「下载中」，主进程每 1 秒轮询一次 tellStatus，把进度通过现有的任务事件推给渲染端；status 为 complete 时标完成，为 error 时标失败并带 errorCode/errorMessage；任务结束后停止轮询。多个文件的任务分别显示，或汇总成一个进度（选简单的那个，并在汇报里说明）。
3. 协议里加进度字段时，改 src/shared/protocol.js，三端保持一致。
4. renderer 按设计稿渲染；外部数据（文件名、错误信息）继续用 textContent，不用 innerHTML。
5. 剪贴板和浏览器两种推送方式不轮询，保持现在的「完成」。
6. 常见 aria2 错误码给中文说明，至少覆盖 412/403（服务器拒绝，多半是 Cookie 或链接过期）和网络错误；未知码显示原文。

验证（自己做，不要让我手动提交链接）：
- 双击项目根 Start aria2 download.bat 启动 aria2（RPC 127.0.0.1:6800，密钥 linkswift-local-check，应用里已配好）。
- npx electron . --remote-debugging-port=9222 启动，通过 CDP 在 index.html 里填入夸克链接 https://pan.quark.cn/s/ae8f001eadf6 并点「提取直链」（tools/probe/cdp-eval.js 可参考）。
- 确认任务卡出现速度、进度，并最终变成完成；test_download 里文件为 335,846,630 字节，无 .aria2 残留。
- 失败路径：用 aria2 RPC 推一个必然 403/404 的 URL 不现实时，至少用一个假 gid 或手工构造 error 状态在渲染端验证失败卡片的显示。

完成后 commit（中文约定式提交信息），更新 HANDOFF.md「已知产品缺口」里关于进度的那条为已完成。不推送。
```

---

## 任务 4：用本机 Chrome 登录 + 百度真机跑通

```
在 D:\2\dev\linkswift（LinkSwift 桌面版，Electron 44）把网盘登录改成用本机 Chrome，并让百度分享文件完整下载。先完整读 HANDOFF.md、DESIGN.md、docs/plans/2026-10-17-baidu-and-regression.md（其中「汇报纪律」「已知事实」「停下来问用户的情况」照做）。

已确认的决定（不要重新论证）：
1. 登录在本机 Chrome 里完成，应用不再在自己的窗口里让用户登录。DESIGN.md 里「全程不打开外部浏览器」改为「只在登录时打开本机 Chrome」，同步修改 DESIGN.md 和 README.md。
2. 不读用户日常 Chrome 的 cookie：Chrome 127+ 的 App-Bound 加密让外部程序解不开 cookie 库，Chrome 136+ 不允许对默认配置文件开远程调试。不要尝试任何绕过手段。
3. 做法：应用用 --user-data-dir=%APPDATA%\linkswift\chrome-profile --remote-debugging-port=<空闲端口> 启动本机 Chrome（路径从注册表 App Paths\chrome.exe 或常见安装路径查找；找不到就在任务卡报错「未找到 Chrome」），打开对应网盘的登录页。用户在这个专用配置文件里登录一次，之后一直保留。
4. 应用每 2 秒通过 CDP（Storage.getCookies 或 Network.getAllCookies，能拿到 HttpOnly）检查关键 cookie：百度 BDUSS，夸克 __puus。出现后把该网盘域名下的全部 cookie 写入 Electron 分区 persist:linkswift（session.fromPartition('persist:linkswift').cookies.set，保留 domain/path/secure/httpOnly/expirationDate），然后关闭这个 Chrome，任务自动继续。5 分钟没检测到就让任务失败，提示「登录未完成，重新提交即可」。
5. 用户关掉 Chrome 不等于取消任务，只是登录没完成（按上一条超时处理）。
6. CDP 用 Node 自带的 WebSocket / fetch 实现，不加新依赖。

百度授权的关键事实：
- 上游脚本 resources/userscript.user.js 第 5528 行起的 getToken：cookie 有效时用 XHR 请求 openapi.baidu.com 静默拿 access_token，不弹窗。只有失败时才走 GM_openInTab 打开授权页（第 6304 行）。
- 现在 src/main/job.js 的 handleOpenTab（约第 559 行）一见到 openapi.baidu.com 就把任务置为 needs-human/login。
- 先实测：导入 Chrome 的百度 cookie 后，静默 getToken 能否成功。不要预先写兜底。
- 静默失败时才加兜底：在应用内开一个可见窗口（同一分区、同样注入上游脚本和 GM_* shim）打开授权 URL，让上游脚本在授权页里通过 GM_setValue 回写 baidu_access_token，原页面轮询拿到后继续。做之前先停下告诉我静默失败的具体响应。

测试链接：
- 百度 https://pan.baidu.com/s/1LBO1Kp3yHPYVFxukMC7YFQ?pwd=c81v，约 22.8 MB（<50MB，不走转存）
- 夸克 https://pan.quark.cn/s/ae8f001eadf6，335,846,630 字节（回归用，确认改登录方式没弄坏夸克）

调试方式（不要让我反复手动提交）：npx electron . --remote-debugging-port=9222，通过 CDP 在 index.html 里填链接、点「提取直链」；主进程日志看 stdout；如果已实现 LINKSWIFT_DEBUG=1 就打开它。Chrome 里的登录只能由我本人操作：需要登录时告诉我「Chrome 已打开，请登录百度」，然后等。

百度跑通后再做一项实测：对百度也开 split=16 / max-connection-per-server=16（改 src/main/aria2.js 的选项构造，若已抽成 buildAddUriOptions 就改那里并补 assert），记录开前和开后的速度；若出现 403、限速更差或下载失败，回退并在 HANDOFF.md 写明原因。

完成标准：test_download 里百度文件大小与网盘页面一致、无 .aria2 残留；夸克回归同样完整；重启应用后再提交百度链接不需要重新登录。按功能拆分 commit（中文约定式），更新 HANDOFF.md 当前状态。不推送。
```

---

## 任务 5：冷启动回归与最终验收

```
在 D:\2\dev\linkswift（LinkSwift 桌面版）做最终回归验收。先读 HANDOFF.md 和 docs/plans/2026-10-17-baidu-and-regression.md 第 2.3 节。

前提：任务 2、3B、4 已完成并提交。开始前 git log --oneline -15 确认；缺哪个就停下告诉我。

验收项（全部自己通过 CDP 驱动，只有需要我本人登录时才找我）：
1. 冷启动：彻底退出应用（确认没有残留 electron 进程），再 npx electron . --remote-debugging-port=9222 启动。
2. 免登录：先清空 test_download，依次提交夸克 https://pan.quark.cn/s/ae8f001eadf6 和百度 https://pan.baidu.com/s/1LBO1Kp3yHPYVFxukMC7YFQ?pwd=c81v，两个都不应弹出 Chrome 登录。
3. 进度：两张任务卡都显示速度和进度，最终显示完成。
4. 落盘：夸克文件 335,846,630 字节；百度文件与页面大小一致；都没有 .aria2 残留。
5. 目录选择器：设置面板里「浏览…」能选目录并填进输入框；取消时原值不变；点「保存设置」后重启应用，值还在。能用 CDP 验证的就用 CDP，原生对话框需要我点的，告诉我点什么。

任何一项失败：记录现象和日志，停下来告诉我，不要自行大改。

全部通过后：更新 HANDOFF.md（标记验收通过、列出剩余缺口：便携版打包、NSIS），commit。问我要不要 push 到 origin（kyrieove/linkswift-desktop），我说推再推。
```
