# 0002 UC 网盘与迅雷云盘的接入方式

日期：2026-10-18
状态：已采纳

## 背景

上游脚本声明支持九家网盘，但 UC 和迅雷的分支并不完整：迅雷刷新凭证要用的 `config.$xunlei.api.getAccessToken` 从未定义，UC 的直链请求不带 Cookie。客户端这边能改的只有「注入前后做什么」，改不了网盘。

## 决定

1. **一条网盘一行声明式步骤表**（`src/shared/providers.js`），不往任务执行器里加分支。新增的步骤原语：`click-text`（按按钮文字点）、`enter-folder`（读 Vue 的 `__vue__.info` 往下钻文件夹）、`ensure-anchor`（补脚本期待的挂载点，带 `probe`/`addClass`）。
2. **未在真实分享页验证过的网盘标 `experimental`**：驱动点不到时不停在「上游改版」，而是留窗口进「需手动一步」，`aria2.addUri` 照样被应用接住。
3. **UC 可以直取**（分享页有 Aria2 下载）。交 aria2 之前，用 `session.cookies.get({ url })` 问 Chromium 要这个地址该带的 Cookie，合并进 `Cookie` 头。域名匹配由 Chromium 做，不会外发别处的 Cookie。
4. **迅雷分享页只能转存**。实测脚本给迅雷分享页挂的助手只有「转存后下载」，没有 API / cURL / aria2 入口，所以标 `transferOnly`：注入后直接点「转存后下载」，再把窗口切到 `https://pan.xunlei.com/`（那里的助手有完整的 Aria2 下载），任务进「需手动一步」，最后一步是用户选文件。
5. **迅雷登录走应用自己的窗口**。凭证在页面的 localStorage，Chrome 的 Cookie 导入带不过来。所以「需登录」时窗口直接开到 `pan.xunlei.com/login/`，同时每 2 秒查一次 `credentials_` 前缀自动继续，卡片上另给「我已登录，继续」。
6. **上游缺陷在注入前补一行**：`patchSource` 补 `getAccessToken: https://xluser-ssl.xunlei.com/v1/auth/token`，只补一次，锚点不存在就原样返回。

## 否掉的方案

- **改上游脚本的 provider 分支**：脚本每次启动都会拉新版，改动会被覆盖，除非维护一份长期 fork。
- **用 Chrome 登录迅雷**：它的会话不在 Cookie 里，导入进来也没有用。
- **猜测迅雷首页的文件选择语义去自动选文件**：没把握的选择器宁可不写，留一次手动点击。

## 后果

- 迅雷链路仍需一次手动点击才算完成，这是上游脚本的能力边界，不是应用的 bug。
- UC、夸克的下载直链要求登录态；未登录时会看到 403 和「登录网盘」按钮。
- `experimental` 的网盘，页面文字误判要格外小心，比如「失效时间：永久有效」不能被当成分享失效。
