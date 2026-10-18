# HANDOFF · 2026-10-18 · Unidownload 品牌、V3 界面与真实下载验收

## 现在

本轮把 LinkSwift 桌面版改名为 **Unidownload**（仅可见名称），接上第三版界面与正式品牌资源，并把检查变成可信的单入口。**未提交、未推送**。

- 已验证（本轮实跑，可复跑）
  - `npm run check` 全绿：13 个源文件逐文件语法检查 → `check:share-link` → `check:job` → `check:aria2` → `check:lifecycle` → `check:brand` → `check:runner` → `check:negative` → `probe:ui`，末尾打印 `All checks PASSED.`。
  - `npm run probe:ui`：40 条断言通过，`PROBE OK`；截图在 `%TEMP%\linkswift-probe-900x760-light.png`、`-light-detail.png`、`720x520-dark.png`。
  - `npm run check:negative`：5 条负例（非零退出 / 信号 / 最后一个步骤失败 / 第二个文件语法错 / 探针泄漏 daemon）全部能抓住。
  - 真实 UC 49 文件：旧任务 `6d0e0380…` 重取链 → `done`，49/49 文件落盘共 834,420,240 字节，逐文件字节一致、无 `.aria2` 残留。
  - 真实外部 aria2：受控 16801 实例，`testAria2` 连上 1.37.0，`readme.doc` 18,514 字节落盘；随后设置已恢复 `builtin / 6800`。
  - 品牌：`resources/brand/` 下 SVG、18 个 PNG（16–512）、ICO（16–256）；`npm run check:brand` 8 项通过；16px 看图仍可辨 U 与箭头。
  - 兼容：`package.name=linkswift-desktop`、`persist:linkswift`、`%APPDATA%\linkswift-desktop`、`window.linkswift`、IPC 名、aria2 会话与下载目录全部未变；重启后 7 条旧任务原样载入。
- 本轮修掉的真缺陷
  - 深色主题从未生效（`.dark` 挂在根元素，却加到 `body`）。
  - 「已完成」任务按当前设置误标出口，历史任务会被改写。
  - 每次任务事件重渲染丢焦点与滚动位置。
  - 生产代码里的 `window.__linkswift_dispatch_job__` 测试后门。
- 未验证 / 阻塞
  - 百度 >50MB：分享页在未登录时始终渲染「请输入提取码」，`.x-button-box` 不存在，两条任务均 `upstream-redesigned`；需要已登录的百度账号会话。该分享大小仍未确认。
  - 迅雷：能走到 `needs-human / manual`（转存成功、窗口切到我的云盘），但「下载助手 → Aria2 下载」菜单在自动化下不展开（项高度为 0），需人工点一次；当前「获取(1)」内是 1.5MB/2.1GB 两个 zip 与 1.5MB mp4，计划里的 8.9KB HTML 已不在。
  - 远端 CI 未跑（未推送）。

## 下一步

1. 百度：先在本机接受一次账号登录，再重跑 `4c282ea3…` 那条分享；确认页面上出现 `.x-button-box` 后再验证「转存 → /disk/main → 取链 → 落盘」，并顺便量出真实文件大小。
2. 迅雷：人工在「获取(1)」里选中一个文件，点「下载助手」→「Aria2 下载」，看程序是否接住 addUri；若能接住，再把「打开刚转存的文件夹并勾选」写成 provider 的 drive 步骤（行信息取 `SourceListItem__item--XxpOC` / `FileCheckBox__input--Z7wzZ` 与 `__vue__.info`，不要猜 class）。
3. 提交与推送：本轮改动尚未 commit；用户未授权推送远端。

## 先读

- `docs/plans/2026-10-18-unidownload-acceptance.md`（本轮 A–D 逐项结果、命令、截图、阻塞）
- `docs/adr/0003-unidownload-brand-and-v3-ui.md`、`docs/plans/2026-10-18-unidownload-ui-implementation.md`
- `resources/brand/README.md`（重建：`npm run brand`；检查：`npm run check:brand`）
- `DESIGN.md` 第 11 节、`LESSONS.md`、`docs/adr/0001`、`0002`
