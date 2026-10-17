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
- **百度 16 连接实测完成**：对百度网盘也开启 `split=16` 与 `max-connection-per-server=16`。实测 Baidu PCS 直链支持并发 Range 请求且不报 403。实测 1 连接速度约 80-105 KiB/s，开启多连接后实测峰值达到 124.7 KiB/s（受限于百度非会员服务端单 IP 整体带宽封顶）。没有出现 403 或下载失败，保留 16 连接配置。

### 百度真机与本机 Chrome 登录实测（2026-10-17 完成，任务 4）

- **登录模式**：改为使用独立专用 profile 唤起本机 Chrome（`--user-data-dir=%APPDATA%\linkswift\chrome-profile`），通过 CDP 监听关键 cookie（`BDUSS`、`__puus`）并同步至 Electron `persist:linkswift` 分区，完成后自动优雅关闭 Chrome。
- **单文件页兼容**：百度单文件分享页新版为 Vite 架构，无 Vue2 实例且无 RequireJS。在 `src/preload/main-world.js` 补齐了 `require('system-core:context/context.js')` 兼容垫片，返回 `window.locals.file_list`，解决了 userscript 弹出「请先勾选要下载的文件哦~」的问题。
- **真实下载落盘与大小**：
  - 百度文件：`支持v1.15.7.rar`，大小 23,909,266 字节，无 `.aria2` 残留。
  - 夸克回归文件：`033-V6.3.97-R1-优化版.zip`，大小 335,846,630 字节，下载速度 7.2 MiB/s（16 连接），无 `.aria2` 残留。
- **免登录验证**：重启 Electron 应用后直接提交百度链接，自动识别持久化 `BDUSS`，静默获取 OAuth AccessToken 跑通下载，无需重新登录。

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

### 任务 5 最终验收实测（2026-10-17 完成）

- **冷启动与免登录回归**：
  - 清空 `test_download` 目录，彻底关闭所有 `electron.exe` 进程。
  - 冷启动应用（`npx electron . --remote-debugging-port=9222`），依次提交夸克（`https://pan.quark.cn/s/ae8f001eadf6`）和百度（`https://pan.baidu.com/s/1LBO1Kp3yHPYVFxukMC7YFQ?pwd=c81v`）分享链接。
  - 两个任务均无需用户重新登录 Chrome，自动读取持久化登录态并完成直链解析与推送。
- **实时进度卡片**：
  - 界面卡片实时展示两个任务的连接数、瞬时下载速度、已下载/总大小、百分比进度条与剩余时间。
  - 下载完成后两张卡片均平稳进入「已完成（100.0%）」状态，展示直链与请求头项数。
- **落盘文件精确大小与 0 残留**：
  - 夸克文件：`033-V6.3.97-R1-优化版.zip`，335,846,630 字节（精确一致），0 `.aria2` 残留。
  - 百度文件：`支持v1.15.7.rar`，23,909,266 字节（精确一致），0 `.aria2` 残留。
- **超时健壮性优化**：
  - 在 `src/preload/driver.js` 与 `src/shared/providers.js` 中将 `ensure-anchor` 超时由硬编码 15 秒改为支持 `step.timeoutMs ?? 30000`，解决了夸克 16 连接满速占满带宽时百度页面加载超时的偶发问题。
- **下载目录选择器验收**：
  - 点击「浏览…」调起 Electron 原生目录选择器；
  - 取消选择时输入框维持原路径不变；
  - 修改路径后点击「保存设置」即时写入 `%APPDATA%\linkswift-desktop\settings.json`，冷启动重启后路径维持。

### 粘贴整段分享文案与限速实测（2026-10-17 修复）

- **症状**：粘贴百度分享文案（`通过网盘分享的文件：… 链接: … 提取码: c81v`）要么被「链接需要以 http:// 开头」挡下，要么整段被当成链接，`提取码: c81v` 跟着进路径（`%20…`/`%0A…`），页面取不到分享数据，第 8 步 wait-for 超时并被报成「上游改版」。
- **根因**：`parseShareLink` 直接 `new URL(raw.trim())`，把整段文字当链接；渲染端还先做了一次 `^https?://` 校验，把整段文案挡在提交之前。
- **修复**：`src/shared/providers.js` 按 RFC 3986 字符集从文字里切出链接，从「提取码/密码」标签读提取码；百度把提取码写进 `?pwd=`（唯一验证过能跳过提取码输入框的路径）；渲染端不再自己校验，整段交给主进程。断言：`npm run check:share-link`。
- **顺手修**：`job.load()` 在窗口被 accept 销毁后收到的迟到 `ERR_FAILED` 会把已在下载的任务判成网络错误（表现为卡在「等待中」0 B/0 B）。现在只有仍在 `loading` 阶段的任务才会因导航失败结束。
- **验收实测**：粘贴原文 → 页面自动解锁 → aria2 下完 `支持v1.15.7.rar`，23,909,266 字节，SHA256 与旧文件一致，0 个 `.aria2` 残留；连提两次都进「已完成」。夸克 189.6 MiB 文件同样走通。
- **限速实测（2026-10-17，`tools/probe/probe-speed.js`）**：
  - 百度同一账号/IP：1 连接 127 KiB/s，16 连接 132 KiB/s，两条任务同时跑合计 110 KiB/s → 服务端按账号封顶约 130 KiB/s，加连接数无用。OpenSpeedy 是游戏变速器（Hook `Sleep`/`GetTickCount`/`QueryPerformanceCounter` 等时间函数），作用于进程本地，改不了服务端封顶，对本项目的 aria2 直链无效。
  - 夸克同一文件：1 连接 1.3 MiB/s，4 连接 3.6 MiB/s，16 连接 4.3 MiB/s。
  - `src/main/aria2.js` 补 `min-split-size=1M`：aria2 默认分片下限 20M，189.6 MiB 的夸克文件只开到 8 连接（3.1 MiB/s），加上后 16 连接（4.3 MiB/s）；24 MiB 的百度文件从 1 连接变 16 连接。

### 未完成事项（后续版本规划）

1. **便携版与安装包打包**：引入 `electron-builder` 打包免安装便携版 exe 与 NSIS 安装包。
2. **自动化测试与 CI**：将 `check:aria2`、RPC 选项断言与 driver 模拟测试集成进 GitHub Actions。
3. **其余网盘支持**：修复上游用户脚本中阿里、迅雷、移动等网盘分享分支的未定义符号与断言缺陷。

