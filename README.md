# LinkSwift Desktop

粘贴网盘分享链接，程序在后台加载页面并取到直链，推给 aria2、剪贴板或浏览器。只在登录时打开本机 Chrome。

上游是 [hmjz100/LinkSwift](https://github.com/hmjz100/LinkSwift) 这个油猴脚本。桌面版把脚本注入到内置窗口的页面主世界，并补上它需要的 `GM_*` 接口。

本期支持夸克网盘和百度网盘。

## 运行

```
npm install
npm start
```

首次运行会在 `%APPDATA%\linkswift-desktop` 建立用户数据目录，网盘登录态存在那里。这个目录含多网盘凭证，按密码本对待。

## 怎么用

1. 粘贴分享链接。带提取码的链接直接把完整地址贴进来，程序会自己解析。
2. 需要登录、提取码或授权时，程序会弹出窗口让你处理一次。
3. 直链拿到后按设置推送。默认推给 aria2。

## 设置

推送目标可选 aria2、剪贴板、浏览器。选 aria2 时填 RPC 地址和密钥，程序会先测试连通性。

「允许自动转存」控制百度的超限文件处理。开启后，超过 50MB 的文件会先保存到你的百度网盘再取直链，这会往你的网盘里写文件。

## 上游脚本

启动时从 GitHub 拉取最新版本，成功就缓存。拉取失败依次退回上次缓存和 `resources/userscript.user.js`。

更新仓库内的固定版本用：

```
npm run fetch-userscript
```

## 验证

探针都可复跑。

```
npm run probe:boot       # 用本地页面跑通整个注入和驱动链路
npm run probe:ui         # 渲染进程 + preload + IPC 的端到端契约
npm run probe:aria2      # 对真实 aria2 验证 RPC 投递（需先启动 aria2）
npm run probe:injection  # document-start 注入时机
npm run probe:throttle   # 隐藏窗口的定时器节流，以及关掉节流后的对照
```

`probe:boot` 把报告写到 `%TEMP%\linkswift-boot-report.json`，`probe:ui` 写到
`%TEMP%\linkswift-ui-report.json`。前者用 host resolver 规则把 `pan.quark.cn`
指到本地页面，后者加载真实的渲染进程和真实 preload，都不是替身。

## 许可证

AGPL-3.0-or-later。上游脚本同样是 AGPL-3.0-or-later，署名见 `NOTICE`。

分发本程序时，`NOTICE` 里列出的上游作者署名必须一并保留。
