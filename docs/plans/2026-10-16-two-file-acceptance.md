# 夸克 + 百度两文件落盘验收：执行方案

给执行者（pi）。读完这一份就能开工，不用再读 HANDOFF.md。DESIGN.md 里锁定的决策不要推翻。

## 目标（唯一验收）

下面两个文件经 LinkSwift 新任务 → aria2 → **完整落盘**到 `D:\2\dev\linkswift\test_download`，大小与网盘页面显示一致：

| 网盘 | 链接 | 预期 |
|---|---|---|
| 夸克 | `https://pan.quark.cn/s/ae8f001eadf6` | 约 320.3 MB |
| 百度 | `https://pan.baidu.com/s/1LBO1Kp3yHPYVFxukMC7YFQ?pwd=c81v` | 约 22.8 MB（<50MB，不走转存） |

aria2 已就绪：双击项目根 `Start aria2 download.bat`，RPC `127.0.0.1:6800`，密钥 `linkswift-local-check`，应用设置里已配好并测试通过。不要再让用户抄令牌。

## 根因（已读代码确认，不是猜测）

当前没下载成功，不是选择器问题，是主进程代理请求这一层的三个缺口：

1. **代理请求不带登录 cookie。** 上游脚本所有 API 调用都是 `anonymous: false` / `withCredentials: true`（userscript 934、962、1022、1077 行），即期望浏览器自动带上 cookie。我们的 `proxyRequest`（`src/main/job.js:79` 起）用 Node `https.request`，**完全不读 `persist:linkswift` 会话的 cookie**（全仓 grep `cookie` 在 src 下零命中）。后果：用户在窗口里登录了夸克，API 请求依然是游客 → 仍报 23018 超出游客限制；百度 `getToken()` 拿不到 BDUSS → 自动授权失败 → 回退到 `GM_openInTab` 授权页。
2. **代理请求不跟随重定向，也不返回 `finalUrl`。** 百度自动授权靠 `base.getFinal()`（1138 行）：HEAD/GET 授权 URL，跟到 `login_success#access_token=...`，从 `finalUrl` 里抠 token（5528–5554）。我们的 shim 在 `src/preload/main-world.js:127` 写 `finalUrl: data.finalUrl || option.url`，而 `proxyRequest` 从不返回 `finalUrl` 也不跟 302 → `getFinal` 拿到 3xx 后用同一个 URL 递归，永远拿不到 token。
3. **夸克直链的下载 Cookie 不全。** 上游给 aria2 的 header 是 `Cookie: String(document.cookie)`（8187 行），HttpOnly 的登录 cookie（如 `__puus`）不在 `document.cookie` 里 → aria2 下载大概率 412「需要登录才能下载」。

另外一个次要问题：`handleOpenTab`（`job.js:367`）遇到百度授权页只把状态设成 `needs-human/login` 并显示**分享页**，授权页本身从没被打开，用户无处可点。修完 1、2 后这条路径大概率不会再触发；只有触发了才处理（见第 4 步）。

## 开工前

1. `git status --short`。工作树有未提交改动（目录选择器 + 百度锚点恢复 + probe 改动），**不要丢**。先把它们按现状提交成一个 commit（`feat: 下载目录选择器与百度按钮挂载点恢复`），不含 `probe-readme.md`、`Start aria2 download.bat`、`docs/`。
2. `probe-readme.md` 是上游 LinkSwift 的 README 原文，不是本项目文档。删掉，或问用户；不要提交。
3. `Start aria2 download.bat` 里有本机绝对路径和 RPC 密钥，不提交，加进 `.gitignore`。

## 步骤

每步做完就验证，验证不过不进下一步。

### 第 1 步：代理请求带会话 cookie，并写回 Set-Cookie

改 `src/main/job.js` 的 `proxyRequest`：

- 参数加一个 `session`（Electron `Session`，由 `JobManager` 通过 `session.fromPartition(this.partition)` 拿到后传给 `Job`）。
- 发请求前：`await ses.cookies.get({ url })` → 拼成 `Cookie` 头。**若调用方已经给了 `Cookie` 头（夸克 8187 那种），合并而不是覆盖**：以会话 cookie 为底，调用方给的同名值优先。
- 收到响应后：把 `set-cookie` 逐条写回 `ses.cookies.set({ url, ... })`。最简单的做法是只解析 `name=value` 加 `domain`/`path`/`expires`/`secure`/`httpOnly`；解析失败的条目跳过不报错。
- 保持用原生 `https.request`（Node fetch 会丢 Referer/Origin，见原注释）。不要换 `net.request`，换了要重新验证所有头。

验证：写一个 `tools/probe/check-proxy.js`（纯 node 不行，要 Electron 会话；用 `electron tools/probe/check-proxy.js`）：起一个本地 http server，往测试分区种一个 cookie，调 `proxyRequest`，断言 server 收到了 cookie；server 回 `Set-Cookie`，断言会话里有了。一个文件，`assert` 即可，不引测试框架。

### 第 2 步：代理请求跟随重定向并返回 finalUrl

仍在 `proxyRequest`：

- 3xx 且有 `Location` 时，用 `new URL(location, current)` 解析后继续请求，最多 10 跳；每一跳都重新取 cookie、写回 Set-Cookie（第 1 步的逻辑放进循环）。301/302/303 跟随时改 GET 并丢 body；307/308 保持方法和 body。
- `Location` 里可能带 `#access_token=...`。HTTP 请求不发 fragment，但 **`finalUrl` 必须保留 fragment 原样**，因为上游用 `finalUrl.includes("access_token=")` 抠 token。所以带 fragment 的 Location 不要再请求，或请求时去掉 fragment，但返回值保留。最省事：遇到 `oob`/`login_success` 这类带 fragment 的 Location，直接把它当 `finalUrl` 返回，status 用 200。
- 返回对象加 `finalUrl` 字段。`netdisk-preload.js` 的 http-response 中继要把 `finalUrl` 透传到主世界（核对 `netdisk-preload.js:151` 附近，若是 `...payload` 展开就已透传）。

验证：在 `check-proxy.js` 里加两条：302 → 200 时 `finalUrl` 是终点 URL、status 200；302 到 `http://x/login_success#access_token=abc&` 时 `finalUrl` 含 `access_token=abc`。

### 第 3 步：夸克真机跑通

1. 双击 `Start aria2 download.bat`，`npm start`。
2. 若夸克尚未登录：任务会进 `needs-human/login` 并弹出页面，让用户在窗口里登录一次（登录不由你代填）。登录后重新提交任务。
3. 粘贴夸克链接，看任务是否到 `delivering` → 完成，aria2 是否收到任务。
4. aria2 若报 412/403：说明第 3 个根因成立。修法：在 `JobManager.deliver`（`job.js:504`）推 aria2 前，对每个 `file`，用会话 cookie（`ses.cookies.get({ url: file.url })` 加 `ses.cookies.get({ url: 'https://pan.quark.cn' })`，按名去重）重建 `Cookie` 头替换 `file.headers.Cookie`。只在 header 里本来就有 `Cookie` 时才替换，百度那种不带 cookie 的别加。
5. 下载完成后核对：`Get-Item D:\2\dev\linkswift\test_download\*` 的 `Length` 与页面显示的 320.3 MB 吻合（MB 按 1024² 算，误差 <0.1 MB），且目录里没有残留的 `.aria2` 控制文件。

通过后 commit：`fix(job): 代理请求携带会话 cookie 并跟随重定向`。

### 第 4 步：百度真机跑通

1. 先确认百度在分区里已登录：没登录就同样走 `needs-human/login`，用户在弹出的分享页窗口里登录百度一次。
2. 提交百度链接。预期：修完第 1、2 步后，上游 `getToken()` 能用 BDUSS 自动拿到 access token（5528 起），**不会**调 `GM_openInTab`。看日志确认 `baidu_access_token` 被 `GM_setValue` 写入 store。
3. **只有**当仍然走到 `handleOpenTab`（openapi.baidu.com）时，才做这一项：
   - 在 `handleOpenTab` 里新开一个**可见** `BrowserWindow`，同一个 `partition`，加载该授权 URL。分区上已注册的 netdisk preload 会注入上游脚本；上游 6498–6503 行在 `login_success` 页把 token `GM_setValue` 进 store。
   - 先核对 `netdisk-preload.js` 的 boot（`sendSync(INTERNAL.boot)`）对一个**不属于任何 job** 的 webContents 怎么处理：主进程可能找不到 job 而拒绝注入。需要让它对这个授权窗口照常给脚本，但不跑 driver 步骤。
   - 监听 store 里 `baidu_access_token` 出现（或授权窗口导航到 `login_success`），关掉授权窗口，然后**让原任务重跑一遍**（reload 分享页、重跑步骤）。上游那段 `setInterval` 轮询里 `throw` 不会传出来、`getLink` 已经 `return` 了，所以靠它自己续上不可行，必须重跑。
   - 不要放开 `handleOpenTab` 对其他 URL 的拒绝（防止 aria2 令牌外泄的那条保留）。
4. 下载完成后同样核对大小（约 22.8 MB）。

通过后 commit。

### 第 5 步：冷启动回归 + 收尾

1. 关掉应用和 aria2，重新启动两者，再各跑一次两个链接（文件已在就先挪走或删除 `test_download` 里的旧文件——先问用户）。这一步验收「重启免登录」。
2. 顺带验证 HANDOFF 里遗留的目录选择器：设置页点「浏览…」→ 选目录 → 输入框变了但未保存；点取消 → 原值不变；点保存 → 重启后仍在。
3. 更新 `HANDOFF.md`「当前接手状态」：写清哪些已真机验证（附文件名和字节数），哪些没验证。

## 范围外（不要做）

- 百度 >50MB 自动转存、剪贴板/浏览器推送、打包、建 GitHub 仓库——验收只要这两个文件。
- 不重构 driver、步骤表、状态机。
- 不代填用户密码、不碰验证码；遇到验证码就 `needs-human/captcha` 交给用户。

## 停下来问用户的情况

- 第 1、2 步修完，夸克 API 仍返回 23018 或 31001（说明问题不在 cookie）。
- 百度第 3 小步做完仍拿不到 token。
- 需要删除 `test_download` 里已有文件时。
- 同一问题连续三次没修好：停手，写出你怀疑错的那个假设。
