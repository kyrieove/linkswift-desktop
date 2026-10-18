# LinkSwift Desktop

粘贴网盘分享链接，程序在后台加载页面并取到直链，推给 aria2、剪贴板或浏览器。aria2 随应用启动，不用自己装。只在登录时打开本机 Chrome。

上游是 [hmjz100/LinkSwift](https://github.com/hmjz100/LinkSwift) 这个油猴脚本。桌面版把脚本注入到内置窗口的页面主世界，并补上它需要的 `GM_*` 接口。

支持夸克网盘、百度网盘、UC 网盘、迅雷云盘。UC 和迅雷的步骤表取自脚本自身的挂载点：自动点不到时窗口会留着让你点一次「下载助手」，直链照样被程序接住。

UC 和夸克的下载直链要求登录态，程序会把应用分区里该域名该带的 Cookie 一起交给 aria2；没登录时会明确说「403…要求登录态」并给「登录网盘」。迅雷的凭证存在页面自己的 localStorage 里，所以「需登录」时会直接把窗口开到 `pan.xunlei.com/login`，登录完自动继续，也可以手动点「我已登录，继续」。


## 运行

```
npm install
npm start
```

首次运行会在 `%APPDATA%\linkswift-desktop` 建立用户数据目录，网盘登录态存在那里。这个目录含多网盘凭证，按密码本对待。

## 怎么用

1. 粘贴分享链接。带提取码的链接直接把完整地址贴进来，程序会自己解析。
2. 需要登录、提取码或授权时，程序会弹出窗口让你处理一次。
3. 直链拿到后按设置推给内置 aria2，开始下载。

任务卡片上的状态分四种：**已拿到链接**、**下载中**（带速度、连接数、剩余时间）、**下载失败**（带错误类型，以及「继续」「重新取链」）、**下载完成**。

下载中可以「暂停」「继续」「取消」。直接关掉软件也不会丢进度：内置 aria2 把会话写在 `%APPDATA%\linkswift-desktop\aria2\session.txt`，下次打开按 GID 找回，没暂停过的任务自动接着下。

## 设置

下载器可选「内置 aria2」（默认，随软件启动，只监听 127.0.0.1）和「外部 aria2 RPC」（填你自己 aria2 / Motrix 的地址与令牌，可测试连接）。下载目录留空即 `下载\LinkSwift`。

「允许自动转存」控制百度超限文件的处理。开启后，超过 50MB 的文件会先在你的百度网盘里存一份，再把窗口切到「我的网盘」让你点一次下载助手取链；这会往你的网盘里写文件。

## 上游脚本

启动时从 GitHub 拉取最新版本，成功就缓存。拉取失败依次退回上次缓存和 `resources/userscript.user.js`。

更新仓库内的固定版本用：

```
npm run fetch-userscript
```

注入前会对脚本打一处最小补丁：迅雷刷新凭证要用的 `config.$xunlei.api.getAccessToken` 上游没有定义，`src/main/userscript.js` 补上它指向的地址。

## 验证

探针都可复跑。

```
npm run check:share-link  # 链接与分享文案解析（四种网盘）
npm run check:aria2       # aria2.addUri 的选项构造
npm run check:job         # 任务状态机：多文件合并、大文件转存、登录过期、链接失效、手动兜底
npm run check:lifecycle   # 真实 aria2：暂停 → 退出 → 重启接着下 → 字节一致（本地慢速 HTTP 服务，不联网）
npm run probe:boot        # 用本地页面跑通整个注入和驱动链路
npm run probe:ui          # 渲染进程 + preload + IPC 的端到端契约
npm run probe:injection   # document-start 注入时机
npm run probe:throttle    # 隐藏窗口的定时器节流，以及关掉节流后的对照
```

`check:lifecycle` 不需要网盘也不需要联网，是「下载一半退出、重开能继续」的回归入口。`probe:boot` 把报告写到 `%TEMP%\linkswift-boot-report.json`，`probe:ui` 写到 `%TEMP%\linkswift-ui-report.json`。

## 许可证

AGPL-3.0-or-later。上游脚本同样是 AGPL-3.0-or-later，署名见 `NOTICE`。

内置的 aria2 是独立程序、以 GPL-2.0-or-later 分发，许可证全文随二进制放在 `resources/aria2/COPYING`。

分发本程序时，`NOTICE` 里列出的上游作者署名与这两份许可证必须一并保留。
