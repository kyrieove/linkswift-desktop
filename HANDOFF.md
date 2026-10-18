# HANDOFF · 2026-10-18 · 内置 aria2、任务恢复、UC 与迅雷接入

## 现在

- 已验证（都能自己复跑）
  - `npm run check:share-link` / `check:aria2` / `check:job` 全过。
  - `npm run check:lifecycle` 过：本地慢速 HTTP，暂停 → 退出 → 重启接着下 → 字节一致、无 `.aria2`；另一条是下载中直接退出 → 重启自动续。
  - 真机：百度 23,909,266 字节分享走完 解析 → 拿到链接 → 下载 → 暂停 → 继续 → 退出 → 重开自动续 → 完成；UC `readme.doc` 18,514 字节解析到完成；夸克 320.3 MiB 回归一次。
  - 内置 aria2 1.37.0 随应用启动，6800 被占用时自动换端口；设置里保留外部 RPC 选项。
  - 迅雷：登录、转存进「我的云盘」、网盘首页的助手可用（含 Aria2 下载）。
- 未验证
  - 迅雷最后一步（打开「获取」文件夹、选中文件、点助手推送）没做成自动，留一次手动点击。
  - 百度 >50MB 转存后半段（切到 `/disk/main` 后取链）没在真机走完。
  - 设置里的「外部 aria2」模式没有回归。
  - UC 49 文件的文件夹只验证到投递与失败计数，没有整批下完。

## 下一步

1. 迅雷收尾：`npm start`，粘贴一个迅雷分享，按卡片提示在网盘首页选中文件完成一次取链。成了就把「打开刚转存的文件夹并勾选」写成 provider 的 drive 步骤，行信息从 `__vue__.info` 读，不要猜 class。
2. 百度 >50MB：勾上「允许自动转存」，用一个大文件分享确认 `afterTransfer` 切到 `/disk/main` 后助手能取链。
3. 外部 aria2：设置里切到 external，用 `Start aria2 download.bat` 那个实例测连接与下载。

## 先读

- `DESIGN.md` 第 11 节（本轮增补，含内置下载器与恢复的设计）
- `docs/adr/0001-bundled-aria2-and-recovery.md`、`docs/adr/0002-uc-and-xunlei.md`
- `LESSONS.md`（调试与踩坑清单）
- 上游脚本事实（版本、GM_* 清单、各家分支缺陷）：`DESIGN.md` 第 2-4 节
- 限速与并发实测：`git show 2508b2d`、`git show b89cfd2`，脚本 `tools/probe/probe-speed.js`、`tools/probe/probe-chunk.js`
