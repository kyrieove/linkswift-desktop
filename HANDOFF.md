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
