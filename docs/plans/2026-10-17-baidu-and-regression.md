# 百度真机 + 冷启动回归 + 收尾：执行方案（2026-10-17）

给执行者（antigravity 或其他代理）。读完这一份就能开工。前置：`docs/plans/2026-10-16-two-file-acceptance.md`（总方案，第 1–3 步已完成）和 `HANDOFF.md` 的「2026-10-16 晚更新」。DESIGN.md 里锁定的决策不要推翻。

## 唯一验收

两个文件完整落盘到 `D:\2\dev\linkswift\test_download`，大小与页面一致：

| 网盘 | 链接 | 预期 | 状态 |
|---|---|---|---|
| 夸克 | `https://pan.quark.cn/s/ae8f001eadf6` | 335,846,630 字节（320.29 MiB） | **已验证**（2026-10-16，commit 6f40ddc） |
| 百度 | `https://pan.baidu.com/s/1LBO1Kp3yHPYVFxukMC7YFQ?pwd=c81v` | 约 22.8 MB（<50MB，不走转存） | **未验证，本方案第 1 部分** |

## 汇报纪律（硬规则，先读这一节）

执行者容易误报和夸大。以下每条都要遵守：

1. **只报你亲眼看到的。** 说「完成」之前，贴出证据：命令和它的原始输出（字节数、状态、退出码）。没有输出的话不算完成。
2. **「应该可以」「理论上」「预期会」不是结果。** 没跑过就写「未验证」。
3. **区分三种状态并明写：已验证（附证据）/ 已改但未跑 / 没做。** 不许把后两种写成第一种。
4. **失败就如实说失败，** 贴报错原文，不要用「基本通过」「大体正常」带过。
5. **不要自评修复质量。** 写事实：改了哪个文件哪几行、跑了什么、输出了什么。
6. **不要扩大范围。** 方案外的「顺手优化」一律不做，写进汇报末尾的「发现但没做」。
7. **文件大小必须自己量。** 用 `Get-Item <路径> | Select Length` 或 `node tools/probe/aria2-status.js`，不能照抄页面或 aria2 声称的数字。
8. 同一问题连续三次没修好：停手，写出你怀疑错的那个假设，问用户。

## 环境与工具

- 系统 Windows，用户终端 PowerShell。你的 Bash 工具是 Git Bash。给用户的命令写 PowerShell 版。
- 补丁脚本里有反斜杠转义时，先用写文件工具写成文件再运行；不要用 `node -e` / `python -c` 内联（会被 hook 拦）。
- aria2：双击项目根 `Start aria2 download.bat`，RPC `http://127.0.0.1:6800/jsonrpc`，密钥 `linkswift-local-check`。应用里已配好。不要让用户抄令牌。
- 启动应用（**带调试端口**）：`npx electron . --remote-debugging-port=9222`，用后台方式运行。
- 自己驱动应用，**不要让用户手动粘贴链接**：
  - 提交链接：`node tools/probe/cdp-eval.js index.html "(()=>{const i=document.querySelector('input');i.value='<链接>';i.dispatchEvent(new Event('input',{bubbles:true}));[...document.querySelectorAll('button')].find(b=>b.innerText.includes('提取直链')).click();return 'ok'})()"`
  - 读任务面板：`node tools/probe/cdp-eval.js index.html "document.body.innerText.slice(0,600)"`
  - 读分享页（任务窗口默认隐藏，但调试端口能连）：`node tools/probe/cdp-eval.js pan.baidu.com "document.body.innerText.slice(0,800)"`；弹窗文字用 `(document.querySelector('.swal2-container')||{}).innerText`
  - aria2 状态：`node tools/probe/aria2-status.js`
- 主进程日志在启动命令的后台输出里。目前主进程**没有** http 观察日志；需要时按第 2 部分第 1 项加开关，不要临时改代码再撤销。
- 需要用户做的只有：登录（夸克、百度）、验证码、点系统对话框。其他事自己做。
- 杀应用：`taskkill /F /IM electron.exe`。杀完再启动。**每次重启后任务列表清空，要重新提交。**
- 不要 push。提交只含本轮自己改的文件；`probe-readme.md` 保留未跟踪，不提交不删。

## 已知事实（不要重新发现）

- 夸克链路已通。三处修复已提交：垫片 `response` 对 `responseType:'json'` 返回对象（`src/preload/main-world.js`）；步骤表在点「Aria2 下载」后等待并点击 `button[action="sendto"][type="aria2"]`（`src/shared/providers.js`，**百度步骤表也已加**，但百度未验证）；`src/main/aria2.js` 的 `addUri` 把 Cookie 以 `header` 选项转给 aria2。
- `proxyRequest`（`src/main/job.js`）已带会话 cookie、写回 Set-Cookie、跟随重定向、返回 `finalUrl`；`npx electron tools/probe/check-proxy.js` 应输出 `check-proxy OK`。这些对百度是否必要，要看第 1 部分结果。
- 上游百度流程：`getToken()` 用 BDUSS 请求 OAuth（userscript 约 5528 行起），`base.getFinal()`（约 1138 行）跟到 `login_success#access_token=...`。`handleOpenTab`（`job.js` 约 559 行）现在遇到 `openapi.baidu.com` 只把状态设成 `needs-human/login`，**从不打开授权页**。
- 百度分享页的锚点 `.x-button-box` 需要 `ensure-anchor` 步骤恢复挂载点（已在步骤表里）。
- 夸克 412 的教训：直链服务器对没有 Cookie 的请求回 412。百度直链可能要求 `User-Agent: pan.baidu.com`；`aria2.js` 已转发 UA 和 Referer，Cookie 也转发。

## 第 1 部分：百度真机

### 步骤 1.1 前置检查

1. `git status --short`：只应有 `probe-readme.md` 未跟踪。有其他改动，先看 `git diff`，不要覆盖。
2. `git log --oneline -3`：应见 `f76d871` 在最上。
3. `npx electron tools/probe/check-proxy.js`，必须输出 `check-proxy OK`。不是就停下汇报。
4. 启动 aria2（若 `node tools/probe/aria2-status.js` 连不上就双击 bat），再带调试端口启动应用。
5. `test_download` 里已有夸克文件，**不要动**。

### 步骤 1.2 提交百度链接并观察

1. 用上面的 cdp 命令提交百度链接。
2. 每 10 秒读一次任务面板，最多观察 90 秒，记录状态变化（提取中 / needs-human / 完成 / 失败）。
3. 按结果走分支：
   - **任务到 `done`，aria2 收到任务**：去 1.4。
   - **`needs-human/login`**：说明用户的百度分区没登录，或授权页被拒。去 1.3。
   - **失败 / 一直卡在提取中超过 90 秒**：用 cdp 读分享页 body 文字和 `.swal2-container` 文字，贴给用户和汇报；看主进程是否需要第 2 部分第 1 项的日志开关再抓。**先定位，再改代码。**

### 已完成：用户已在应用分区里登录百度（2026-10-16 晚）

用户已在 `persist:linkswift` 分区登录百度，并经 `tools/probe/cdp-quit.js` 优雅退出（cookie 已落盘）。**登录后首次提交**百度任务的结果：任务 `failed`，错误类型 `no-files`（「没取到文件。分享页结构可能变了」）。这是登录后的新现象，**先定位这个**：用 CDP 读百度页面的 `.swal2-container` 文字、`document.body.innerText`，看上游弹窗是否出现、文件列表是否被读到；再对照 `src/main/job.js` 里产出 `no-files` 的位置。不要假设登录态丢失，先用页面上是否显示用户名（`132*****632`）核实。

### 步骤 1.3 登录（需要用户）

**已知缺陷（2026-10-16 晚用户实测，先修这个再让用户登录）**：百度分享页未登录时，点完「Aria2 下载」后上游弹窗不出现，步骤 8 `wait-for button[action="sendto"][type="aria2"]` 等满 60 秒 → `driver-result ok:false` → `job.fail('upstream-redesigned')` → `close()` 销毁窗口。用户正在窗口里登录时窗口被销毁，体验是「点登录没反应」「又超时了」。等人登录不应计时。修法方向（先读代码再定，别照抄）：wait-for 超时时检查页面是否有登录态缺失的证据（`.app-login` 可见、`#passport-login-pop` 出现，或 `getToken` 授权失败），有就 `needsHuman('login')` 并**保持窗口不销毁、不计时**；用户登录完成后提供「重试」（重新加载分享页、重跑步骤）。证据：页面登录入口是 `a.app-login`，弹窗 `#passport-login-pop`（z-index 60001），用 CDP 点 `a.app-login` 可正常弹出。修完要用 CDP 实测：窗口在 60 秒后仍然存在。

1. 任务状态为 `needs-human` 时应用会自己把任务窗口 `show()` 出来。告诉用户：在弹出的百度分享页窗口里登录一次，完成后告知你。**不要代填密码，不碰验证码。**
2. 用户确认后，重新提交（先 `taskkill` 不是必须；直接再提交一条即可），回到 1.2。
3. 若登录后仍 `needs-human`：这就是总方案第 4 步第 3 小项的情形。**只在这时**做下面的授权窗口：
   - 在 `handleOpenTab` 里，对 `openapi.baidu.com` 新开一个**可见** `BrowserWindow`，同 `partition`（`persist:linkswift`），加载该授权 URL。分区上注册的 netdisk preload 会注入上游脚本；上游在 `login_success` 页把 token `GM_setValue` 进 store。
   - 先读 `src/preload/netdisk-preload.js` 的 boot（`sendSync(INTERNAL.boot)`）和 `src/main/job.js` 约 614 行的 `ipcMain.on(INTERNAL.boot, ...)`：对一个**不属于任何 job** 的 webContents 会怎么处理。可能需要让它对授权窗口照常给脚本，但不跑 driver 步骤。
   - 监听 store 里 `baidu_access_token` 出现（或窗口导航到 `login_success`），关掉授权窗口，然后**让原任务重跑一遍**（重新加载分享页、重跑步骤）。上游那段 `setInterval` 轮询里 `throw` 不会传出来，不能指望它自己续上。
   - **不要**放开 `handleOpenTab` 对其他 URL 的拒绝（防 aria2 令牌外泄那条保留）。
   - 这一项做完仍拿不到 token：**停下来问用户**。

### 步骤 1.4 核对落盘

1. 等 aria2 完成：`node tools/probe/aria2-status.js` 里该任务 `status` 为 `complete`，`completedLength == totalLength`。
2. 自己量文件：`Get-Item D:\2\dev\linkswift\test_download\*`。百度文件 `Length` 约 22.8 MB（MB 按 1024²，误差 <0.1 MB）。
3. 目录里没有该文件的 `.aria2` 残留。
4. 若 aria2 报 412/403：先用 node `fetch` 带 `Range: bytes=0-99` 复现：取出推给 aria2 的 url 和 headers，分别去掉 Cookie / UA / Referer 对比，看哪个头决定 412/403。夸克那次就是这样定位的。百度直链常要求特定 `User-Agent`（`pan.baidu.com`）。**先复现再改。**
5. 通过后提交：`fix: 百度真机跑通 ...`，提交信息说明实际改了什么。提交前自审 diff：删掉临时日志、死代码。

## 第 2 部分：收尾（第 1 部分通过后）

### 2.1 调试开关（retro 待办，小改动）

`src/main/job.js` 里加 `process.env.LINKSWIFT_DEBUG` 为真时，才在 `handle()` 打印 `[DBG] <kind> <url|text>`，在 `handleHttp` 打印响应状态和前 300 字符。默认关闭，不影响生产。不要为此加配置项。

### 2.2 纯函数检查（retro 待办，小改动）

把 `src/main/aria2.js` 的选项构造拆成可导出的纯函数 `buildOptions(config, file)`，在 `tools/probe/check-proxy.js` 同类脚本里（新文件 `tools/probe/check-aria2-options.js`，纯 node，只写 `assert`）断言：给定 `headers: {Cookie:'a=b', 'User-Agent':'x', Referer:'r'}`，选项里有 `user-agent`、`referer`、`header: ['Cookie: a=b']`。这条检查能拦住「Cookie 被丢掉」。加 `package.json` 脚本 `probe:aria2opts`。

### 2.3 冷启动回归（需要先问用户）

1. **问用户**：`test_download` 里的两个旧文件要挪走还是删除？没有明确回答不要动。
2. 关掉应用和 aria2（`taskkill /F /IM electron.exe`，aria2 进程名 `aria2c.exe`），重新启动两者（应用仍带调试端口）。
3. 各提交一次两个链接，验证「重启免登录」：不应再出现 `needs-human/login`。记录两个文件的 `Length`。
4. 验证目录选择器（HANDOFF 遗留）：这一项需要真实鼠标点系统对话框，**请用户做**：设置页点「浏览…」→ 选目录 → 输入框变了但未保存；点取消 → 原值不变；点保存 → 重启后仍在。你只负责在用户操作后用 cdp 读输入框的值核对。

### 2.4 更新 HANDOFF.md

在「2026-10-16 晚更新」之后新增一节，写清：已真机验证的（文件名、字节数）、没验证的、已知问题。retro 待办 1、2 标为完成（若做了）。

## 提交前自检清单（每次 commit 前逐项执行并在汇报里贴结果）

1. `git diff --stat`：改动文件是否都在本方案范围内？列出文件。
2. `git diff` 里搜 `console.log('[DBG]`、`writeFileSync`、`scratchpad`、令牌字符串：应零命中（`LINKSWIFT_DEBUG` 开关内的日志除外）。
3. `node --check` 每个改过的 JS 文件。
4. `npx electron tools/probe/check-proxy.js` 输出 `check-proxy OK`。
5. 对「已验证」的每一条，贴出证据行（命令 + 输出）。

## 范围外（不要做）

- 百度 >50MB 自动转存、剪贴板/浏览器推送、打包、建 GitHub 仓库。
- 不重构 driver、步骤表、状态机；不改 DESIGN.md 锁定的决策。
- 不代填密码、不碰验证码、不绕过登录。
- 不 push，不改全局配置。

## 停下来问用户的情况

- 授权窗口（1.3 第 3 点）做完仍拿不到 token。
- 需要删除或移动 `test_download` 里已有文件。
- 同一问题连续三次没修好。
- 发现方案里的事实与实际不符（例如夸克文件现在不在、aria2 起不来）。

## 汇报格式

结尾给一份表，每行：项目 / 状态（已验证·已改未跑·没做）/ 证据（命令+原始输出摘要）。再加「发现但没做」一栏。不要写「全部通过」这类总括，逐项列。
