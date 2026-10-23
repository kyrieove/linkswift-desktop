# LinkSwift 桌面版 · 设计方案（已确认）

> 状态：**方案已固定**，待开工
> 日期：2026-10-16
> 上游项目：[hmjz100/LinkSwift](https://github.com/hmjz100/LinkSwift) v1.1.4（AGPL-3.0-or-later）

---

## 1. 一句话定义

一个 Electron 桌面程序：粘贴网盘分享链接 → 程序在后台加载页面、注入 LinkSwift 脚本、取到直链 → 推给 aria2 / 剪贴板 / 浏览器。只在登录时打开本机 Chrome。

---

## 2. 上游项目事实（已实测核实）

| 项 | 事实 | 证据 |
|---|---|---|
| 形态 | 单个油猴用户脚本，810,153 字节 / 9148 行 | `（改）网盘直链下载助手.user.js` |
| 许可证 | AGPL-3.0-or-later | 脚本头部 `@license`；仓库 LICENSE 34,523 字节 |
| 版本 | v1.1.4（默认分支 `dev`） | `@version` |
| 工作原理 | 在**已登录网盘的浏览器页面**注入 UI，借该会话调网盘 API 取直链 | `unsafeWindow` 19 处、`localStorage` 16 处、`XMLHttpRequest` 21 处 |
| 依赖 | `@require` jquery@3.6.0、sweetalert2@11.4.8、js-md5@0.7.3（unpkg）；`@resource` SwalLigt/SwalDark CSS | 脚本头部 18-22 行 |
| 运行时网络依赖 | 正文唯一 `fetch` 是抓当前页面样式表（1818 行），**无隐藏 CDN / Worker / WebSocket** | 全文检索 |
| jQuery 用量 | `$(` 144 次、`$doc` 97 次 —— **必须本地打包** | 全文计数 |

### 2.1 关键有利事实

**脚本第 121 行自带非油猴环境兜底：**

```js
if (typeof (unsafeWindow) === "undefined") window.unsafeWindow = window;
```

这意味着在 Electron 主世界注入时 `unsafeWindow` 自动成立，**脚本主体无需任何改写**。

### 2.2 需要 shim 的 API（共 9 个 `GM_*`）

`@grant` 声明 10 项：`GM_deleteValue`、`GM_getResourceText`、`GM_getValue`、`GM_openInTab`、`GM_registerMenuCommand`、`GM_setClipboard`、`GM_setValue`、`GM_xmlhttpRequest`、`unsafeWindow`、`window.close`。

实际调用点：

| API | 调用行 | 备注 |
|---|---|---|
| `GM_info` | 128-133 | **被使用但未声明**，shim 必须补 |
| `GM_registerMenuCommand` | 480, 483, 486, 489 | 菜单项 |
| `GM_getValue` | 515 | |
| `GM_setValue` | 526, 538 | |
| `GM_deleteValue` | 547 | |
| `GM_setClipboard` | 598, 600 | 有 `typeof` 守卫，可选 |
| `GM_xmlhttpRequest` | 932 | 跨域请求核心，**必须实现** |
| `GM_getResourceText` | 3652, 3653 | 取 sweetalert2 CSS |
| `GM_openInTab` | 4981, 4986, 6304 | 百度授权页 |
| `unsafeWindow` | 121 | 脚本自适配，无需处理 |
| `window.close` | — | 浏览器原生 |

### 2.3 各网盘分享链接能力（逐盘核实）

| 网盘 | 分享页取直链 | 条件与证据 |
|---|---|---|
| **夸克** | ✅ | `pwd_id` 取自 `unsafeWindow.factStat`（8203-8205）；游客可下小文件，`31001`=需登录，`23018`=超出游客大小限制（8226-8230） |
| UC | ✅ | 同夸克但不传 token（8499） |
| 123 | ✅ | 需 `localStorage["authorToken"]`（8753）；`5112`=需登录，`5113`=本月免费流量不足（8901-8902） |
| 光鸭 | ✅ | **唯一有提取码交互**：`getShareToken(shareId, code)`，监听 `input.ant-input[type=text]`（7792-7821） |
| **百度** | ⚠️ | 分享页取链走 `getShareData()`（5566-5595）读 `unsafeWindow.locals.dump()` / `jsToken` / `currentSekey` / `BAIDUID` cookie / `localStorage[${surl}_pwd]`。**>50MB 时 `res.list` 返回字符串，脚本只能提示"需要保存到网盘后于网盘中下载"（6253）** |
| 天翼 | ⚠️ | 分享页常返回 `ShareNotFoundFlatDir` → 提示"请[转存]文件"（7254-7255） |
| 阿里 | ❌ | `getLink()` 分享分支直接 `throw "页面错误~"`（6716-6717）。配置中的 `get_share_link_download_url`（335）**全文仅出现 1 次、从未被调用** |
| 迅雷 | ❌ | 分享页只提示"因网盘限制，请保存到自己网盘后再去下载"（7360）；且 `getAccessToken` **未定义却被 7507 引用** |
| 移动 | ❌ | `getShareLink` **未定义却被 7039 调用**；仅定义了 `getLink`（353）→ 分享页取链**静态不可达** |

> **结论**：真正"输入分享链接即出直链"的只有 **夸克 / UC / 123 / 光鸭**；**百度**需转存绕过 50MB 限制；阿里 / 迅雷 / 移动因上游缺陷本期不可用。

### 2.4 百度 50MB 限制的准确性质

脚本中**没有**硬编码 50MB 阈值。限制来自服务端：`res.list` 在超限时变为字符串而非数组（6253）。因此**无法通过改参数绕过**，只能转存。

### 2.5 提取码的准确性质

脚本**不自动填提取码**。百度依赖 `localStorage[${surl}_pwd]` 或 URL `?pwd=`（5573），即**假设用户已在网盘页面手动输入过**。光鸭监听用户手输（7805-7812）。→ 桌面版必须自己把提取码程序化填入页面。

### 2.6 脚本没有对外接口

脚本是单个 IIFE，从 117 行到 9148 行。除一个重入守卫和一个 `console.clear` 覆盖外，它没有向 `window` 挂任何东西，外部无法调用取链逻辑。

`getLink()` 在 8138 行，第一件事是 `getSelectedList()`，选择为空就抛错。它挂在 click 处理器上，页面加载时不会自动执行。**直链不会自己流出来**，桌面版必须替用户完成「勾选文件 → 点亮脚本 → 点推送」这三步。

两条运行期约束：

| 约束 | 位置 | 后果 |
|---|---|---|
| 重入守卫 | 123 | `window[encodeURIComponent("LinkSwift:主代码")]` 已存在时静默返回，重复注入会失效 |
| jQuery 加载顺序 | 9148 | `})($ ?? jQuery);` 要求 jQuery 在同一主世界、且在此之前就绪，否则整脚本静默死掉 |

### 2.7 直链出口

脚本自带两个出口，都在需要 shim 的 API 里。

| 出口 | 位置 | 拿到什么 |
|---|---|---|
| `GM_xmlhttpRequest` | 5388-5410 | `aria2.addUri` 完整请求体，含直链、文件名、请求头 |
| `GM_setClipboard` | 598-600 | 复制按钮写入的文本，含直链或 `aria2c` 命令行 |

脚本会自己发 `aria2.addUri` 到 `GM_getValue("setting_aria2_rpc")` 配置的服务器（5396，默认值在 2132）。桌面版可预置这份配置指向本地 aria2，由脚本直接推送。

---

## 3. 决策记录

| # | 决策项 | 结论 | 理由 |
|---|---|---|---|
| Q1 | 产品形态 | **内嵌浏览器内核，独立界面** | 用户明确要求独立软件 |
| Q2 | 首发网盘 | **百度 + 夸克** | 用户指定的两大主力 |
| Q3 | 链接类型 | 网盘**分享链接**（`pan.baidu.com/s/*`、`pan.quark.cn/s/*`） | 诉求原点 |
| Q4/Q16 | 分发方式 | **公开仓库 + AGPL-3.0**，附 NOTICE 署名 hmjz100、油小猴 | 推 GitHub 公开 = AGPL 意义上的分发，必须整仓开源 |
| Q5/Q12 | 下载方式 | **aria2 RPC + 复制剪贴板 + 浏览器下载** | aria2 最可控（HTTP RPC、无 GUI 依赖），剪贴板为万能兜底 |
| Q6 | 百度大文件 | **自动转存**（>50MB 时点"保存到网盘"→ 轮询 → 再从我的网盘取链），界面明确告知并给开关 | 转存是百度可用的前提；自控内核使此操作可行 |
| Q7 | 交互形态 | **极简输入框为主 + 需登录/提取码/授权时弹出浏览器窗口** | 纯后台会在登录/提取码/授权/验证码四处卡死 |
| Q8/Q19 | 脚本更新 | **运行时拉取最新 + 本地缓存兜底 + 仓库内固定版本兜底** | 网盘直链工具最大死因是上游改版失效 |
| Q9 | 登录态存储 | **固定用户数据目录**（`%APPDATA%`，**非** exe 同目录），可切临时会话 | 该目录含多网盘登录凭证，须按密码本对待 |
| Q11 | 技术栈 | **Electron 44.8.0** | 用户指定；注入能力实测全通过 |
| Q13 | 项目路径 | `D:\2\dev\linkswift` | 实际 workspace |
| Q17 | GitHub 账号 | **kyrieove** | 当前 gh 活跃账号 |
| Q18 | 打包形态 | **先便携版**，验收后补 NSIS 安装包 | 自用场景够用，省去装 NSIS |

---

## 4. 架构设计

```
主进程 (main)
  ├─ 窗口管理 / 应用生命周期
  ├─ session (persist:linkswift)     持久化 profile，登录态存于此
  ├─ 脚本管理                         运行时拉取 + 缓存 + 内置兜底版本
  ├─ aria2 RPC 客户端                 JSON-RPC over HTTP
  └─ IPC 总线                         渲染进程 ↔ 注入脚本 ↔ 下载器

preload
  ├─ GM_* shim (9 个)                 注入到页面主世界
  └─ LinkSwift 注入                   document-start 时机

渲染进程 (renderer)
  └─ 极简 UI                          输入框 + 任务列表 + 进度 + 设置

注入的 LinkSwift（页面主世界运行）
  └─ 产出直链 ──IPC──> 主进程 ──> aria2 / 剪贴板 / 浏览器
```

### 4.1 数据流

```
用户粘贴分享链接
   ↓
主进程创建隐藏 BrowserWindow（持久化 session）
   ↓
preload 在 document-start 注入 GM_* shim + LinkSwift
   ↓
页面加载完成 → 注入脚本采集凭证并调用网盘 API
   ↓
直链经 IPC 回传主进程
   ↓
按用户设置分发：aria2 RPC / 剪贴板 / 浏览器
```

### 4.2 何时弹出可见窗口（Q7 丙）

以下四类情况必须让用户介入，程序需自动弹出可见浏览器窗口：

1. **首次登录**某个网盘
2. **提取码**需要输入
3. **百度 AccessToken 授权**（`openapi.baidu.com`，脚本 `@match` 已含此域）
4. **验证码** / 异常页面


### 4.3 隐藏窗口的定时器节流

实测：窗口 `show()` 之后再 `hide()`，页面定时器被 Chromium 钳到约 1 Hz。窗口从未显示过则不受影响。

这踩在 4.2 上。用户处理完登录或提取码，窗口回后台，脚本的加载轮询、转存轮询、进度刷新都会慢十倍。

修法：隐藏窗口的 `webPreferences` 加 `backgroundThrottling: false`。

### 4.4 主世界与 preload 的通信通道

脚本必须跑在页面主世界（它读 `unsafeWindow`），preload 跑在隔离世界（它要 `ipcRenderer`）。两个世界不共享 JS 全局，只能靠 DOM 通信。

实测：`window.postMessage` 的 `message` 事件双向穿过隔离边界。主世界发的消息 preload 收得到，preload 发的消息主世界也收得到。隔离性同时成立，preload 看不到页面全局，页面也看不到 preload 全局。

实现要点：消息带方向字段，避免回环。preload 收到主世界消息后经 `ipcRenderer` 转给主进程。
---

## 5. 关键实现点

### 5.1 GM_* shim（9 个）

`GM_info` 虽未声明但被使用，必须补。`GM_xmlhttpRequest` 是跨域请求核心（932 行），需实现为支持 `onload`/`onerror`/`withCredentials` 的完整对象。

### 5.2 依赖本地化

jquery / sweetalert2 / js-md5 / 两个 CSS 必须**打包进应用**并从本地注入（`GM_getResourceText` 返回本地内容），保证离线可用。

### 5.3 百度 AccessToken 授权流程

主路径是纯 XHR，不开标签页。脚本自动抓授权页表单、自动 POST 确认授权、再从重定向里取 token（5524-5565）。不要按弹窗实现。

自动确认授权按钮的代码在 6437-6510，需要脚本跑在 `openapi.baidu.com` 上。注入范围要按网盘定，只加载 `pan.baidu.com` 会让这条路径失效。

`GM_openInTab` 打开授权页加每秒轮询最多 120 次（6294-6317），只是 `getToken()` 返回空之后的兜底。

### 5.4 百度自动转存（Q6）

流程：检测到 `res.list` 为字符串（超限）→ 定位页面"保存到网盘"按钮并点击 → 轮询转存完成 → 跳转"我的网盘"→ 取直链。

**必须在 UI 上明确告知将写入用户网盘，并提供开关。**

### 5.5 提取码程序化填入

桌面版不能依赖「用户已在页面输过」。需实现：从输入解析提取码（URL `?pwd=` 或用户输入）→ 填入页面输入框 → 提交。

上游对夸克没有提取码先例，夸克分支只从 `factStat` 取 `pwd_id`（8203-8205），这是纯新增实现点。有先例的是光鸭 `getShareToken(shareId, code)`（7792-7821）。

### 5.6 脚本更新策略（Q8c）

启动时尝试从 GitHub 拉取最新脚本 → 成功则缓存 → 失败则用上次缓存 → 再失败则用仓库内置固定版本。

### 5.7 页面驱动层（原方案缺的那一层）

直链不会自己流出来（见 2.6），必须由程序驱动页面点击。这一层原方案没有，是最大的实现空白。

**先预置设置，省掉一半步骤。** 脚本拿 `config.base.num`（`"865746"`，220 行）和 `config.base.license`（`"AGPL3"`，221 行）比对 `GM_getValue("setting_init")`，在 12 处门控决定注入「点我点亮」还是直接注入功能按钮（夸克 8306，百度 6415）。预置 `setting_init = { code: "865746", license: "AGPL3", version: <当前版本> }` 后直接走 `addButton()`，「点我点亮」永不出现，也就绕开了它末尾的 `location.reload()`（4650）。

`version` 必须填当前脚本版本。9066 行拿它比对，缺失或落后会弹出阻塞式更新日志弹窗。

**点击序列用声明式步骤表，按网盘分驱动。** 步骤词表固定 5 个：

| 步骤 | 作用 |
|---|---|
| `wait-for` | 等选择器出现，超时即判上游改版 |
| `click` | 点单个元素 |
| `click-all` | 点全部匹配元素 |
| `fill` | 填输入框，支持提取码占位符 |
| `sleep` | 固定等待 |

失败时抛出失败的选择器与步骤序号，正好是「上游改版」需要的诊断信息。

**勾选文件要点页面自己的复选框。** 脚本不读 DOM。夸克从 React fiber 读 `props.selectedRowKeys`（8279-8297），百度从 Vue `__vue__` 或 `unsafeWindow.require(...)` 读选中项（6384-6404）。两处的 `catch` 都 `return []`，选不到和没选中无法区分。所以只能点页面复选框让框架自己更新状态，不能直接写状态。

夸克功能按钮的入口是 `.pl-button-mode[data-mode="aria2"]`（8084 行标记），通用处理器在 3619 行调 `getLink()`。

### 5.8 直链捕获

捕获点是 `GM_xmlhttpRequest` shim。脚本所有网络请求都汇到 932 行的 `base.xmlHttpRequest`。`sendTo.aria2` 在 5388-5423 组装 JSON-RPC 体，5420 行经 `base.post` 发出去。

从请求体里取：

| 字段 | 位置 | 内容 |
|---|---|---|
| 直链 | `params[0][0]` | 下载地址 |
| 文件名 | `params[1].out` | 文件名 |
| 请求头 | `params[1].header` | `Key: Value` 字符串数组 |

判别方式：JSON-RPC 体里 `method === "aria2.addUri"`。

另一个出口是 `GM_setClipboard`（598-600），拿到复制文本。aria2 未配置或用户选了「复制」时用它。

**`GM_openInTab` 要拦截。** 4981、4986 两处会把 aria2 RPC 地址和 token 拼进第三方 URL（`d.youxiaohou.com`、`ariang.mayswind.net`）再打开。桌面版不照做，改为在主进程内展示，不把 token 交给第三方。6304 的百度授权 URL 是正常用途。

**预置 aria2 配置。** `setting_aria2_rpc` 的默认端口是 `16800`（Motrix，2132-2142），不是 aria2 默认的 `6800`。桌面版启动时写入自己的配置，指向用户设置里的 aria2。

---

## 6. 验收标准（端到端，可复现）

1. 启动程序，粘贴**夸克**分享链接（带提取码）→ 后台加载 → 取到直链 → **aria2 开始下载**
2. 粘贴**百度**分享链接，对 **>50MB** 文件 → 自动转存 → 取到直链 → aria2 下载
3. 只在登录时打开本机 Chrome
4. 首次运行引导登录 → 登录态持久化 → 重启后免登录

---

## 7. 已知风险与限制

| 风险 | 说明 | 缓解 |
|---|---|---|
| 百度转存写入用户网盘 | 自动转存会往用户网盘写文件 | UI 明确告知 + 开关 |
| 转存依赖 DOM 点击 | 上游改版即失效 | 更新策略（Q8c） |
| 提取码需程序化填入 | 原脚本依赖用户手输，属新增实现点 | 独立实现 + 测试 |
| 上游改版是最大死因 | 网盘直链工具通病 | 运行时拉取最新 |
| 杀软误报 | Electron 便携版常见 | 自用加白名单 |
| 体积 ~200MB | Electron 固有 | 自用可接受 |
| AGPL 义务 | 公开分发须整仓 AGPL + 附源码 | 已选公开 + AGPL，天然兼容 |

---

## 8. 本期不做（范围边界）

- **阿里云盘 / 迅雷云盘 / 中国移动云盘**：上游存在 3 处缺陷（阿里分享分支 throw、移动 `getShareLink` 未定义、迅雷 `getAccessToken` 未定义），分享页静态不可达
- **UC / 123 / 光鸭 / 天翼**：架构上预留，本期不实现
- **内建多线程下载器**：分片/断点续传/限速是独立大工程
- **NSIS 安装包**：验收通过后再补
- **IDM 推送**：自研内核下「捕获下载请求」机制不可靠（脚本自述在 233、327-328 行），放第二批

---

## 9. 开发计划

1. 建项目骨架 + AGPL LICENSE + NOTICE（署名 hmjz100、油小猴）
2. 主进程：窗口 + 持久化 session + 脚本拉取/缓存
3. preload：`GM_*` shim（9 个）+ 依赖本地化 + LinkSwift 注入
4. **先打通夸克**（路径最短）→ 验证端到端
5. 再接百度（AccessToken 授权 + 自动转存 + 提取码填入）
6. aria2 / 剪贴板 / 浏览器推送
7. 打包便携版 → 建 GitHub 仓库 `kyrieove/linkswift-desktop` 并推送

---

## 10. 附录：环境与实测证据

### 10.1 本机工具链（实测）

| 工具 | 版本/状态 |
|---|---|
| Node.js | v24.13.0 |
| npm | 11.6.2 |
| git | 2.51.2.windows.1 |
| gh CLI | 2.98.0（已认证：kyrieove 活跃、xburner23412） |
| Rust | rustc 1.98.1 / cargo 1.98.1 |
| VS2022 BuildTools | 含 MSVC + Windows SDK 10.0.26100 |
| Python | 3.10.11（含 PyQt6 6.10.2） |
| Electron | 44.8.0，npm 上当前最新；dist 实测 368.4 MB。需在项目内 `npm install`，上个会话装在临时目录已删 |
| aria2 | 1.37.0，`winget install aria2.aria2` 装好，`aria2c.exe` 在 WinGet 包目录下 |
| C 盘空闲 | 121.8 GiB（实测，会变） |
| 缺失 | 7z / NSIS / Inno（打安装包时需补） |

### 10.2 Electron 注入能力探针（关键验证，全部通过）

实测输出：

```json
{
  "beforePageScript": "true",          // document-start 注入成功，抢在页面脚本前
  "injectionRan": "true",
  "pageScriptRan": "true",
  "probe": {
    "unsafeWindow_jsToken": "PAGE_JS_TOKEN",     // MainWorld 可读
    "unsafeWindow_sekey": "PAGE_SEKEY",
    "locals_dump": "{\"share_uk\":{\"value\":\"12345\"},\"shareid\":{\"value\":\"67890\"},\"bdstoken\":{\"value\":\"BDSTOKEN_X\"}}",
    "ls_TOKEN": "{\"access_token\":\"ALI_TOKEN\"}",   // 凭证可读
    "ls_pwd": "pwd42",
    "isMainWorld": true
  },
  "cookies_from_main": ["__pugs=FAKE_COOKIE"]   // 登录态可注入/导出
}
```

验证方法：preload 中 `webFrame.executeJavaScript()` 注入主世界，`session.registerPreloadScript()` 注册（`setPreloads` 在 44.8.0 已标弃用），`persist:` 分区持久化。

`beforePageScript` 是探针自己的字段名，不是 Electron API。

### 10.3 备选方案对比（实测）

| 方案 | 体积 | 注入能力 | 判定 |
|---|---|---|---|
| **Electron** | ~250MB | ✅ 实测通过 | **已选定** |
| PyQt6-WebEngine | ~180MB | ✅ 实测通过（document-start + MainWorld） | 备选 |
| Tauri | ~15MB | ⚠️ WebView2 注入时机控制不足，难满足 `document-start` | 不推荐 |
| Playwright + msedge | ~50MB | ✅ | 备选 |

> 注：Qt6 中 `QWebEngineProfile.setProfile()` 与 `scriptCollection()` 已改名为构造传参和 `profile.scripts()`；Electron 中 `session.setPreloads` 已弃用，应用 `registerPreloadScript`。

### 10.4 注入与节流复测（可复跑）

Electron 44.8.0 实测。探针脚本在 `tools/probe/`，开发时随仓库走。

| 项 | 结果 |
|---|---|
| document-start 时机 | 注入时 `document.readyState` 为 `loading`，页面首个内联脚本未执行，页面全局变量全为 `undefined` |
| 主世界可达 | `unsafeWindow === window` 为真 |
| 凭证可读 | `localStorage` 可读，`document.cookie` 可读，`session.cookies.get()` 可导出 |
| 定时器节流 | 窗口显示后再隐藏，100ms 定时器 6 秒只跑 6 次；`backgroundThrottling: false` 下跑满 60 次 |

## 11. 增补（2026-10-18）：下载器内置化与任务恢复

第 5 节把 aria2 当成「用户已经跑着的 RPC 服务」，需要用户自己装、自己填地址和密钥。实测下来这是首次使用最难的一步，因此改成：

1. **内置 aria2 随应用启动**。`resources/aria2/aria2c.exe`（1.37.0，GPL-2.0-or-later，见 `NOTICE`）由主进程 `src/main/aria2-daemon.js` 拉起，只监听回环地址，RPC 密钥随机生成并存在 `%APPDATA%\linkswift-desktop\aria2-local.json`。端口默认 6800，被占用就另选一个并记住。设置里保留「外部 aria2 RPC」选项，第 5 节的推送目标没有变。
2. **会话与进度落在 aria2 自己手上**。`--continue=true`、`--save-session`、`--save-session-interval=5`，加上每个文件的 `.aria2` 控制文件：退出时用 `aria2.shutdown` 让 aria2 自己写会话，重开后按 GID 找回，没暂停过的任务自动接着下。
3. **应用侧再存一份**。`jobs.json` 记 id、分享链接、直链、GID 与状态；重启后先按 GID 问 aria2，问不到就把直链重推一次，仍失败才判「直链已过期」并给「重新取链」。
4. **暂停 / 继续 / 取消**。`aria2.forcePause` / `aria2.unpause` / `aria2.forceRemove`；任务状态机新增 `linked`（已拿到链接）与 `paused`（已暂停），与「下载中」「下载失败」「下载完成」并列。
5. **文件夹多文件**。上游脚本按文件逐个发 `aria2.addUri`，因此驱动先点它的「全部推送至下载器」，应用侧再把短时间内的多个 `addUri` 合并成一次投递，否则一个文件夹只会下到第一个文件。
6. **UC 网盘与迅雷云盘**。`src/shared/providers.js` 增加两条声明式步骤表。两家的选择器来自脚本自身的挂载点表、未在真实分享页上验证，所以标了 `experimental`：驱动点不到时不停在「上游改版」，而是留着窗口让用户点一次「下载助手」，`addUri` 照样被应用接住。迅雷的凭证在 localStorage 而不是 Cookie，登录因此走应用自己的窗口；上游缺失的 `getAccessToken` 在注入前补一行补丁。

## 12. 增补（2026-10-22）：多来源多引擎，接入 yt-dlp

第 11 节把「取链」和「下载」分成了两件事，但两件事都还锁在网盘上：来源只有四个网盘，下载器只有 aria2。这一节把它们都变成可插拔的。完整决策见 `docs/adr/0004-multi-engine-and-yt-dlp.md`。

### 12.1 来源是联合类型

`src/shared/protocol.js`：

```
Source = { kind:'netdisk', provider, shareId, passcode?, raw }
       | { kind:'media',   url, raw }
       | { kind:'direct',  url, raw }
```

`src/shared/providers.js` 退成网盘取链配方表（步骤表、登录方式、哪些域名带 cookie）。`src/shared/sources.js` 是来源注册表，把配方和新的 `media` / `direct` 收在一处，每条给出 `id` / `label` / `kind` / `matches` / `parse` / `capability` / `engine`。

判定顺序：网盘最具体先判，媒体次之（判定最宽），直链最后（按文件扩展名）。

### 12.2 引擎是可插拔的

`src/main/engines/` 下每个引擎实现同一组方法：

```
status()          引擎在不在、什么版本
start(target)     开始搬，产出一次运行
progress(run)     当前进度行
pause(run)        暂停
resume(run)       继续
retry(run)        失败后重新投递
cancel(run)       取消
```

`Job` 不再直接调 `aria2.*`。原来那几处（投递、轮询、暂停、续传、取消、重推）现在问的是引擎，形状一样。

来源声明自己的默认引擎：网盘与直链用 aria2，媒体用 yt-dlp。用户可以在设置里按来源覆盖，所以 aria2 是实现而不是前提。

持久化里的 `gids` 换 `runs`，元素是 `{file, runId}`，`runId` 是引擎自己的句柄（aria2 是 GID，yt-dlp 是目标路径）。旧记录在 `JobManager.restore` 一处兼容。

### 12.3 进度通道

yt-dlp 的进度用制表符分隔，不用 JSON。实测：`%(progress.total_bytes_estimate)j` 在值为空时渲染成裸的 `NA`，整行不是合法 JSON，`JSON.parse` 直接抛错；字符串字段自带引号会和外层引号打架；Windows 路径会被转义成双反斜杠。制表符方案实测路径原样输出。

阶段信号（解析完了、文件落位了）走 `--print-to-file` 写文件，不走 stdout。原因：`--print` 隐含 `--quiet`，`--quiet` 会把 `--progress-template` 一起关掉。

### 12.4 三个 Windows 上必须记住的坑

- **PyInstaller 单文件 exe 会再起一个子进程。** 只杀引导进程，真正的 Python 还在跑。要用 `taskkill /pid <pid> /T /F` 收整棵树。
- **被杀的进程的收尾报告属于上一轮。** 每一次 spawn 带一个 token，对不上的收尾报告丢掉，否则续传刚起步就被上一轮的死讯判成失败。
- **别用 yt-dlp 自己的 `-U`。** 上游发行说明明确说过旧版可执行文件有中间人攻击风险。应用自己更新：拉发行版、按 `SHA2-256SUMS` 校验、换文件。

### 12.5 界面从注册表画

渲染进程不再有写死的网盘表。`INVOKE.sources` 把注册表推过去，侧栏来源清单、能力表、来源页、筛选和计数都从它画。加一种来源改一处，不改十几个地方。

来源的颜色是注册表里的十六进制值，不是 CSS 类名。样式表里按来源写死的颜色规则删掉了。

`PROVIDER_LABELS`、`PROVIDER_LOGIN`、`PROVIDER_CAPABILITY` 三张表删掉，它们的内容注册表里已经有了，留在渲染进程就是两份会漂移的事实。

老任务的 `link` 没有 `kind` 字段，渲染进程的 `sourceId()` 认这种形状。

**侧栏按类别给入口，不按来源给。** 四家网盘是四个来源，但属于同一个类别 `netdisk`。侧栏只排「网盘 / 媒体 / 直链」三个按钮，每家网盘的能力、徽章与最近一次真实结果放在来源页的卡片上。注册表里的 `kindLabel` 与 `kindIcon` 就是给这三个按钮用的。

筛选因此是三形态的联合：`{scope:'all'}`、`{scope:'kind', kind}`、`{scope:'provider', id}`。判断只有 `matchesSourceScope()` 一处。以前按 `link.provider` 筛，媒体与直链的记录没有这个字段，一筛就空。

**能力与真实结果只写一处。** 「能力等级」是注册表里的固定结论，「本机上次成功」才是这台机器上的结果。这两句话挨在一起必须说得不一样，否则「已验证」紧挨「未验证」读起来像自相矛盾。设置页那张按网盘逐行列的表删掉了，来源页的卡片接管这件事。

### 12.6 设置页的媒体

画质、后处理开关、字幕、播放列表、ffmpeg 路径、yt-dlp 路径与更新频道、每个来源用哪个引擎，都在「设置 → 媒体」。同一页显示 yt-dlp 与 ffmpeg 的实际状态：版本、路径、ffprobe 在不在。找不到就写找不到，不写猜测。

「每个来源用哪个引擎」默认是来源自己声明的那个。改掉之后 aria2 就不再是前提，这是这一节要留的口子。

**但下拉只给真的跑得动的组合。** 注册表里的 `engines` 写明这一类来源真正能用的引擎：网盘只有 aria2（yt-dlp 不会解析分享页），媒体只有 yt-dlp（aria2 不会解析页面），直链两个都吃得下。一个类别只有一种引擎时不排下拉，写一句「网盘 aria2 / 媒体 yt-dlp」。`resolveEngineId()` 也做同样的校验：覆盖的引擎来源不支持时退回来源自己的默认，手改过的设置文件也不能配出一个跑不动的组合。

### 12.7 许可证

`resources/ytdlp/yt-dlp.exe` 是 PyInstaller 打的，含 GPLv3+ 代码，按 GPLv3+ 分发。本仓库 AGPL-3.0-or-later，与之兼容。义务是随二进制分发 `resources/ytdlp/THIRD_PARTY_LICENSES.txt`，并在 `NOTICE` 写署名。详见 `NOTICE`。
