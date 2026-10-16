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

## 尚未验证

以下都要用真实账号和真实链接才能确认，代码里已按上游源码实现，但没有跑过。

- 夸克分享页带提取码时的输入框选择器。步骤表里给的是候选列表，真实页面结构未知。
- 百度 `>50MB` 自动转存要点的「保存到网盘」按钮。
- 百度 AccessToken 的 XHR 自动授权在 2026 年的服务端是否仍然放行。
- 剪贴板和浏览器两种推送目标。
- 便携版打包，以及 GitHub 仓库 `kyrieove/linkswift-desktop` 尚未创建。
