# 新会话接手指引

> 复制下面「提示词正文」整段，粘到新会话的第一条消息即可。

---

## 提示词正文（从这里开始复制）

我要在 `D:\2\dev\linkswift` 继续开发 **LinkSwift 桌面版**。这是一个 Electron 桌面程序：粘贴网盘分享链接 → 程序在后台加载页面、注入 LinkSwift 用户脚本、取到直链 → 推给 aria2 / 剪贴板 / 浏览器，全程不打开外部浏览器。

**第一步：先完整读 `D:\2\dev\linkswift\DESIGN.md`**（225 行）。里面 14 条决策已全部确认并锁定，**不要重新论证或推翻它们**，直接按它执行。读完从第 9 节「开发计划」第 1 步开始动手。

### 已实测确认的事实（不要重复验证，直接采信）

**上游脚本**（要重新下载，本地缓存已随上个会话删除）：
- 地址：`https://raw.githubusercontent.com/hmjz100/LinkSwift/dev/%EF%BC%88%E6%94%B9%EF%BC%89%E7%BD%91%E7%9B%98%E7%9B%B4%E9%93%BE%E4%B8%8B%E8%BD%BD%E5%8A%A9%E6%89%8B.user.js`
- v1.1.4，810,153 字节，9148 行，**AGPL-3.0-or-later**
- **脚本第 121 行自带非油猴兜底**：`if (typeof (unsafeWindow) === "undefined") window.unsafeWindow = window;` → 脚本主体无需改写，只需补 `GM_*` shim
- 需 shim **9 个** `GM_*`：`GM_info`（**被使用于 128-133 行但未在 @grant 声明，必须补**）、`GM_registerMenuCommand`、`GM_getValue`、`GM_setValue`、`GM_deleteValue`、`GM_setClipboard`、`GM_xmlhttpRequest`（跨域核心，932 行）、`GM_getResourceText`、`GM_openInTab`
- 依赖需本地打包：jquery@3.6.0、sweetalert2@11.4.8、js-md5@0.7.3，以及 SwalLigt/SwalDark 两个 CSS

**Electron 注入能力已验证通过**（探针实测结果）：
- `beforePageScript=true` — document-start 注入成功，抢在页面脚本之前
- MainWorld 可读 `unsafeWindow.jsToken` / `currentSekey` / `locals.dump()`
- `localStorage` 凭证可读、cookie 可注入可导出
- 实现方式：preload 里 `webFrame.executeJavaScript()` 注入 + `session.fromPartition('persist:...')` 持久化
- 注意：`session.setPreloads` 在 Electron 44 已弃用，用 `registerPreloadScript`

**网盘支持范围**（逐盘核实过）：
- **本期做：夸克 + 百度**
- 夸克：`pwd_id` 取自 `unsafeWindow.factStat`（8203-8205）；`31001`=需登录，`23018`=超出游客大小限制
- 百度：`getShareData()`（5566-5595）读 `unsafeWindow.locals.dump()` / `jsToken` / `currentSekey` / `BAIDUID` cookie / `localStorage[${surl}_pwd]`；**>50MB 时服务端返回字符串而非数组（6253），脚本只能提示"需保存到网盘"，无法改参数绕过，必须自动转存**
- 百度 AccessToken 走 `GM_openInTab` 打开授权页，原脚本每秒轮询最多 120 次（6294-6317）
- **提取码脚本不自动填**，依赖用户已在页面输过（5573）→ 桌面版必须程序化填入
- **本期不做**：阿里（分享分支直接 throw，6716）、迅雷（`getAccessToken` 未定义却被引用，7507）、移动（`getShareLink` 未定义却被调用，7039）—— 上游缺陷导致分享页静态不可达

### 环境

- Node v24.13.0 / npm 11.6.2 / git 2.51.2 / gh 2.98.0（已认证，**活跃账号 kyrieove**）
- Electron 44.8.0 需在项目内重新 `npm install`（上个会话装在临时目录，已随会话删除）
- C 盘空闲 123.9GB；**未装 7z / NSIS / Inno**（本期不做安装包，暂不需要）

### 约束（别越界）

- 项目路径固定 `D:\2\dev\linkswift`
- **公开仓库 + AGPL-3.0**，必须附 NOTICE 署名上游作者 **hmjz100** 和 **油小猴**
- 脚本更新策略：运行时拉取最新 + 本地缓存兜底 + 仓库内固定版本兜底
- 登录态存 `%APPDATA%`，**不放 exe 同目录**（含多网盘凭证，按密码本对待）
- **先做便携版**，验收通过后再补 NSIS
- 开发顺序：骨架 → 主进程 → preload/shim → **先打通夸克** → 再接百度 → 下载器推送 → 打包 → 建仓库 `kyrieove/linkswift-desktop`

### 验收标准（DESIGN.md 第 6 节）

1. 粘贴夸克分享链接（带提取码）→ 后台加载 → 取到直链 → aria2 开始下载
2. 粘贴百度分享链接，>50MB 文件 → 自动转存 → 取到直链 → aria2 下载
3. 全程不打开外部浏览器
4. 首次引导登录 → 登录态持久化 → 重启免登录

## 提示词正文（复制到这里结束）

---

## 已交付

`DESIGN.md` 是唯一的设计来源，已按实测修正。`README.md` 面向使用者。

代码结构。

| 路径 | 职责 |
|---|---|
| `src/shared/protocol.js` | 三端共用的契约与类型 |
| `src/shared/providers.js` | 网盘解析与声明式驱动步骤表 |
| `src/main/main.js` | 应用入口、窗口、IPC |
| `src/main/job.js` | 任务状态机、HTTP 代理、直链捕获 |
| `src/main/store.js` | 设置与 GM 值持久化 |
| `src/main/userscript.js` | 上游脚本三级来源 |
| `src/main/aria2.js` | aria2 RPC 客户端 |
| `src/preload/netdisk-preload.js` | 隐藏窗口的注入与通道 |
| `src/preload/main-world.js` | `GM_*` shim |
| `src/preload/driver.js` | 步骤表执行器 |
| `src/renderer/` | 界面 |
| `tools/probe/` | 可复跑的验证探针 |

## 早期尚未验证记录

以下列表来自初始开发阶段。当前进度以文末「当前接手状态」为准；其中百度按钮挂载和夸克文件夹 driver 已有后续验证。

- 夸克分享页带提取码时的输入框选择器。步骤表里给的是候选列表，真实页面结构未知。
- 百度 `>50MB` 自动转存要点的「保存到网盘」按钮。
- 百度 AccessToken 的 XHR 自动授权在 2026 年的服务端是否仍然放行。
- 剪贴板和浏览器两种推送目标。
- 便携版打包，以及 GitHub 仓库 `kyrieove/linkswift-desktop` 尚未创建。
## 当前接手状态（2026-10-16）

### 2026-10-16 晚更新（以本节为准，下面「最近已验证」中夸克相关条目已过时）

- 执行方案：`docs/plans/2026-10-16-two-file-acceptance.md`。5 步里完成 1–3，剩 4（百度真机）、5（冷启动回归 + 目录选择器）。
- 已提交：`e2992c3` proxyRequest 带会话 cookie、写回 Set-Cookie、跟随重定向、返回 finalUrl（`tools/probe/check-proxy.js`，`npm run probe:proxy`，卡 `docs/orch/2026-10-16-proxy-cookie-redirect/`）；`6f40ddc` 夸克真机跑通。
- **夸克已真机验证**：`test_download/033-V6.3.97-R1-优化版.zip` = 335,846,630 字节（320.29 MiB，页面 320.3M），无 `.aria2` 残留。
- 夸克真机暴露的三个方案之外的缺口（均已修）：
  1. `src/preload/main-world.js` 垫片：`responseType:'json'` 时 `response` 必须是解析后的对象。否则上游 `base.post` 对含中文的响应走 `escape` 再 `JSON.parse` 失败，报「获取下载地址失败」。
  2. `src/shared/providers.js`：点完「Aria2 下载」后弹窗出现，还要点 `button[action="sendto"][type="aria2"]` 才会发 `aria2.addUri`。夸克和百度步骤表都补了 wait-for + click。
  3. `src/main/aria2.js`：`addUri` 只转发了 UA 和 Referer，丢了 Cookie，aria2 收到 412。现在 Cookie 以 `header` 选项转发。方案里的「根因 3」（HttpOnly cookie 缺失）实测不成立：`document.cookie` 的值足够，故没做 `deliver` 重建 Cookie。
- 方案「根因 1、2」（cookie、重定向）对夸克不是瓶颈；它们是否对百度必要，等第 4 步验证。
- **未验证**：百度、冷启动免登录、目录选择器的浏览/取消/保存。
- 工作树：`probe-readme.md` 保留未跟踪（用户决定）。

### 产品要求：默认开最高速度（用户 2026-10-17 定）

- 软件默认就要按最高速度下载，不让用户自己调。实测夸克：aria2 默认每服务器 1 连接 = 0.10 MiB/s；`split=16`、`max-connection-per-server=16` = 8.6 MiB/s（约 85 倍）。已在 `src/main/aria2.js` 对 `*.quark.cn` 生效（commit `bd3d175`）。
- **百度还没开**：当时担心百度对多连接限制严，只对夸克开。按用户要求，第 4 步百度跑通后要**实测**百度开 16 连接是否可用、速度多少，可用就对百度也默认开；被限制或封（403/限速更差）再回退并记原因。
- 后续可考虑：`--min-split-size`、`--max-overall-download-limit=0`（不限速），以及应用设置页里的连接数项，实测后再定。

### 已知产品缺口（用户 2026-10-17 提出，暂不改，仅记录）

- **应用里看不到下载进度**（已于 2026-10-17 完成，任务 3B）：任务推给 aria2 后进入「下载中」状态，主进程每 1 秒轮询 `aria2.tellStatus` 并通过任务事件将实时进度、速度、剩余时间、连接数推给渲染端；下载完成显示 100% 成功卡片；aria2 报 412/403 等错误时显示中文说明与错误代码。
- 登录体验：关主窗口会退出整个应用；关任务窗口会取消任务（登录到一半也会丢）。游客限制以外的大文件（如 622.8 MB 的分享）必须先在应用分区里登录夸克。

### 调试方法（避免重蹈覆辙）

- 夸克卡住那次，我为抓日志重启应用 5 次、每次让用户重新提交，浪费很多轮。应用本身没有调试出口。
- 正确做法：用 `npx electron . --remote-debugging-port=9222` 启动；`http://127.0.0.1:9222/json` 列出页面；通过 CDP `Runtime.evaluate` 在渲染页（`index.html`）里填输入框、点「提取直链」，在夸克页读 `.swal2-container` 的文字。主进程日志在启动命令的 stdout。不要让用户手动提交。
- 查 aria2 状态用 RPC：`aria2.tellActive` / `tellStopped`（密钥 `linkswift-local-check`）。
- 待做（retro 建议，未实现）：
  1. `job.js` 加 `LINKSWIFT_DEBUG=1` 才打印 observation 与响应摘要，别再临时加日志。
  2. 把 `aria2.addUri` 的选项构造拆成纯函数，加进 assert 脚本：Cookie 丢失本可被拦下。仓库目前没有 lint / test / CI。
  3. 执行方案的「根因」要区分「已验证」和「推断」，真机走通前不下结论。

### 编排（orch）注意

- `run-card.mjs` 派发和 `--commit` 会被 auto 模式分类器拦截，即使用户口头放行。用户需在 settings 里给 `node D:/2/dev/orch-runner/orchestrate/runner/run-card.mjs:*` 加 Bash 权限规则，否则要用户在 PowerShell 里自己跑。
- 卡 `proxy-cookie-redirect` 的 review（luna）有 2 条 P1，均为误报，已在卡的 Acceptance 记录。
- runner 的基线 Check 在 `check-proxy.js` 尚不存在时会弹 Electron 报错框，点「确定」即可。

用户当前目标：让提供的夸克和百度分享文件完整下载到 `D:\2\dev\linkswift\test_download`。只有两个文件完整落盘才算验收成功。用户准备让 Claude 先查看问题并给出计划，之后再由本会话继续执行。

### 最近已验证

- 夸克链接：`https://pan.quark.cn/s/ae8f001eadf6`。真实分享包含约 320.3 MB 的文件。未登录时上游返回游客大小限制提示。用户之后发来截图，显示该提示已消失，推测已在窗口内登录；尚未由 LinkSwift 新任务复测。
- 百度链接：`https://pan.baidu.com/s/1LBO1Kp3yHPYVFxukMC7YFQ?pwd=c81v`。分享页能加载，提取码已包含在 URL 中，文件约 22.8 MB。上游脚本会请求 OAuth AccessToken；应用当前将该路径报告为 `needs-human / login`，仍未完成授权及下载。
- 百度分享页上游按钮挂载选择器已过期：页面存在 `.x-button-box`，但上游配置的嵌套 `.module-share-top-bar .x-button-box .g-dropdown-button.tools-more` 不存在。`src/shared/providers.js` 和 `src/preload/driver.js` 有应用侧锚点恢复改动；真实页面 probe 已观察到按钮数 1、driver `ok: true`，随后停在百度 OAuth 登录状态。
- 夸克文件夹进入路径由 React fixture 验证：driver `ok: true`，能进入子文件夹、识别已选文件并发起夸克 API 请求。fixture 的本地服务器不是网盘，不能验证真实文件下载。
- aria2 1.37.0 已安装。项目根目录 `Start aria2 download.bat` 可双击启动本机 RPC，监听 `127.0.0.1:6800`，RPC 密钥为 `linkswift-local-check`，目标目录为脚本所在目录下的 `test_download`。当前运行检查曾看到端口 6800 正在监听。LinkSwift 设置截图中该配置测试成功，版本显示 aria2 1.37.0。
- `test_download` 最近一次检查为空；尚未满足完整下载验收。

### 最近 UI 改动

- 用户指出下载目录应该能浏览选择。已实现：下载目录仍可手动编辑，旁边增加“浏览…”按钮；Electron 主进程通过 `dialog.showOpenDialog` 只选目录；选中后只填入输入框，不自动保存；取消时原值不变；仍由现有“保存设置”按钮保存。
- 相关文件：`src/shared/protocol.js`、`src/main/ipc.js`、`src/preload/renderer-preload.js`、`src/renderer/index.html`、`src/renderer/renderer.js`、`src/renderer/styles.css`。
- `node --check`（上述改动涉及的 JS 文件）与 `git diff --check` 已通过。尚未通过重启后的应用实际点击新按钮；用户取消了当时的桌面状态读取，当前运行窗口显示旧布局。需要冷启动 LinkSwift 后验证浏览、取消和保存流程。

### 当前工作树与接手建议

- 有未提交改动，切勿覆盖或丢弃。开始时先检查 `git status --short` 和 `git diff`。
- 未提交路径还包括 `tools/probe/probe-boot.js`、`tools/probe/probe-live.js`、`tools/probe/fixture-quark-react.html`、`probe-readme.md`，以及此前任务遗留的 aria2 启动脚本。先审阅它们的用途，再决定是否保留。
- 用户希望 Claude 先读当前状态并提供计划；收到计划后由本会话继续。不要声称下载已成功，也不要重复让用户手动复制 RPC 令牌：令牌已配置且 aria2 测试成功。
- 下一步建议：冷启动 LinkSwift，实际验证目录选择器；提交用户最新确认已登录的夸克链接，检查是否进入真实提取及 aria2 下载；再处理百度授权流程。完成后核对两个文件的大小/完整性及目标路径。
