# 2026-10-18 Unidownload 实施验收记录

本文件记录**本轮**（接续会话）实际执行与观察到的结果。旧 `HANDOFF.md`、旧任务卡里的 2026-10-17/18 早期记录不并入这里，不可当成本轮证据。

## 环境

| 项 | 值 |
|---|---|
| 工作目录 | `D:/2/dev/linkswift` |
| HEAD（本轮开始时） | `1d42edd`，分支 `main`，领先 `origin/main` 13 个提交 |
| Node / Electron | Node 24.13.0 / Electron 44.8.0（devDependency） |
| 真实应用启动 | `electron.exe . --remote-debugging-port=9223`（脚本 `%TEMP%\start-uni-dbg.cmd`，仅本地调试用，不入库） |
| userData | `%APPDATA%\linkswift-desktop`（内部标识未改，见品牌检查） |

## 阶段 A：检查结论可信

| 项 | 结果 | 证据 |
|---|---|---|
| 语法检查逐文件 | 每个 `src/**/*.js` 各一个 `node --check` 步骤 | `tools/run-checks.js` `buildSyntaxSteps`；负例 4 通过 |
| 负例可被抓住 | 非零退出、被信号杀掉、最后一个步骤失败、第二个文件语法错、探针泄漏 daemon 都会让整轮失败 | `npm run check:negative` → `{"passed":5,"failed":0}` |
| 探针清理失败必须非零 | `LINKSWIFT_PROBE_LEAK_DAEMON=1` 时退出码 1，报告 `ok:false`，`daemon still running after cleanup` | 实测 `EXIT=1`；清理后无残留进程 |
| 取消断言不再假通过 | 断言行状态文本严格等于 `已取消`（`失败 / 取消` 筛选文案不含该串） | `tools/probe/probe-ui.js` 第 6 组断言 |
| 完整检查 | `npm run check` → `check:brand OK: 8` / `check:runner OK` / negative 5/5 / `PROBE OK` / `All checks PASSED.`，`EXIT=0` | 本轮实跑 |

未做：GitHub Actions 远端 CI 未运行（本轮未推送，也无远端执行记录）。

## 阶段 B：V3 界面

本轮修复的真实缺陷（均先复现、后修复、再断言）：

| 缺陷 | 根因 | 修复 |
|---|---|---|
| 深色主题只改文案不换配色 | `styles.css` 所有深色令牌挂在 `.dark`（根元素），而 `applyTheme` 把类加到 `body` | `applyTheme` 与切换按钮改用 `document.documentElement`；新增断言比较浅/深两次的 body 背景与 `documentElement.classList` |
| 已完成任务按当前设置误标出口 | `done` 的文案读 `currentSettings.delivery`，历史任务会被当下设置改写成「已复制链接/已交给浏览器」 | 改用任务自身 `state.progress` 判断：有本地进度才是「下载完成/已保存到本地」，否则「已投递」；详情「下载方式」同样只认真实进度 |
| 每次任务事件重渲染丢焦点与滚动 | `render()` 整体 `replaceChildren()` 未保存焦点/滚动位置 | 渲染前记录聚焦行的 `data-job-id` 与列表 `scrollTop`，渲染后恢复；新增断言：PUSH 后焦点仍在原任务行 |
| 生产代码残留测试后门 | `window.__linkswift_dispatch_job__` 暴露给页面 | 删除；探针本就走真实 PUSH |
| 死 CSS | `.filetype*`、`.speedchart*` 已无对应 DOM（用户明确不要类型图标列） | 删除 12 条死规则，花括号平衡已校验 |

探针与截图（本轮实跑，`assertionsPassed: 40`、`PROBE OK`）：

- `%TEMP%\linkswift-probe-900x760-light.png`（浅色 900×760 任务列表）
- `%TEMP%\linkswift-probe-900x760-light-detail.png`（详情抽屉打开）
- `%TEMP%\linkswift-probe-720x520-dark.png`（深色 720×520 抽屉覆盖、无横向溢出）

已看图确认：深色真正生效、标题栏与侧栏为正式 U+箭头标志、长文件名与多文件聚合进度正常、详情行不挤压。
夹具（fixture）只在探针内构造并经真实 IPC/PUSH 送达渲染层，**不构成任何远程网盘下载成功的证据**。

## 阶段 C：品牌与可见更名

| 产出 | 路径 |
|---|---|
| 矢量主标志（U + 向下箭头，`#233c2e`） | `resources/brand/unidownload-mark.svg` |
| 应用图标（深绿方砖 + 薄荷 `#d0efb5` U 与箭头） | `resources/brand/unidownload-icon.svg` |
| 透明 PNG 16/24/32/48/64/128/256/512 | `resources/brand/unidownload-mark-*.png`、`unidownload-icon-*.png` |
| Windows ICO（16/24/32/48/64/128/256 七个尺寸） | `resources/brand/unidownload.ico` |
| 生成器 / 检查器 / 说明 | `tools/generate-brand.js`、`tools/check-brand.js`、`resources/brand/README.md` |

- 生成：`npm run brand`（用已装 Electron 的隐藏窗口把 SVG 画到 canvas，ICO 目录用 Node Buffer 拼装；未新增依赖）。
- 检查：`npm run check:brand` → 8 项通过（SVG 不内嵌位图、每个 PNG 签名与 IHDR 尺寸、ICO 目录项数/偏移/载荷边界、`package.name=linkswift-desktop`、`persist:linkswift` 未变、无 `app.setName`/`setPath`、窗口标题与图标接线、renderer 标题与 favicon）。
- 小尺寸人工看图：16px 仍可辨 U 与箭头（箭头由 28px 轴加宽到 36px 后重出图确认）。
- 兼容：未加 `productName`、未调用 `app.setName`、未改 `persist:linkswift`、未改 data 目录；`main.js` 仅加 `PRODUCT_NAME`、`icon: brandIconPath()`、`backgroundColor: '#233c2e'`。

## 阶段 D：真实下载回归

测试时刻均为 2026-10-18 本地时间（UTC+8）。

### D1 UC 多文件（真实下载完成）

| 项 | 值 |
|---|---|
| 输入来源 | 本机 `%APPDATA%\linkswift-desktop\jobs.json` 中旧任务 `6d0e0380-f60e-4004-84fc-822332634f9f`（分享 `drive.uc.cn/s/4317ff816e3c4`），经界面「重新取链」 |
| 新任务 | `d8c38432-1a35-4d8f-a3cc-79584c90cb8a` |
| 起始状态 | 旧任务 `failed / delivery`，49 文件全部 403（登录态失效） |
| 终态 | `done`，49/49 文件 `complete`，`0` 失败 |
| 源页面大小 / 落盘 | aria2 报告 834,420,240 字节；`tools/probe/verify-files.js` 逐文件对比：`matched 49 / mismatched 0 / missing 0`，`totalBytes 834,420,240`，无 `.aria2` 控制文件残留 |
| 目录 | `D:\2\dev\linkswift\test_download`（用户原有下载目录，未改） |
| 界面 | 真实窗口显示「00Mysql学习路径.mp4 等 49 个文件 · 下载完成 · 795.8 MiB · 已保存到本地」 |
| 截图 | `%TEMP%\linkswift-real-uc49-20261018.png` |

### D2 外部 aria2（真实完成）

| 项 | 值 |
|---|---|
| 受控实例 | `resources\aria2\aria2c.exe --enable-rpc=true --rpc-listen-port=16801 --rpc-secret=...`（本地临时实例，测试后已关闭并删除临时目录） |
| 设置路径 | 界面/桥接 `setSettings` 切到 `aria2Mode=external`、`port=16801`，`testAria2` → `{"ok":true,"message":"连上了，aria2 1.37.0"}` |
| 任务 | `1ec26137-21b6-4cff-811d-173c9ac2fe0e`（`drive.uc.cn/s/38af796e2a8d4`）→ `done` |
| 落盘 | `readme.doc` 18,514 字节，`matched 1 / mismatched 0 / missing 0`，无控制文件残留 |
| 恢复 | 已把设置改回 `builtin / localhost:6800 / /jsonrpc / 原令牌 / 原目录`，`settings.json` 与测试前一致；受控实例进程已停，系统内只剩应用内置的 11040 端口实例 |

### D3 百度 >50MB（外部阻塞，未完成）

| 项 | 值 |
|---|---|
| 输入 | 用户提供 `https://pan.baidu.com/s/13FxRi_MycbF_n6OL4iWUAg?pwd=kzqr` |
| 解析 | `shareId=3FxRi_MycbF_n6OL4iWUAg`、`passcode=kzqr`（解析正确） |
| 结果 | 两次提交（`33229f34…`、`4c282ea3…`）均 `failed / upstream-redesigned`：「页面上没找到该点的东西（第 1 步：ensure-anchor）」 |
| 独立取证 | PowerShell 直接取该分享页：`status=200`、`title= 百度网盘 请输入提取码`、`x-button-box` 不存在，带 `pwd=kzqr` 与不带 `pwd` 结果相同；`share/init?surl=…&pwd=kzqr` 同样停在「请输入提取码」。说明服务端在未带会话的情况下把页面渲染成提取码页，驱动等待的 `.x-button-box` 根本不会出现 |
| 附加 | 通过真实 IPC 触发 `login` 返回 `{"ok":false,"message":"登录未完成，重新提交即可"}`（无已登录百度会话可用） |
| 阻塞 | 需要已登录的百度网盘账号会话（扫码/账号登录只能由用户完成），之后才可能走到「转存 → /disk/main → 取链」 |
| 分享体积 | **未确认**。页面未解锁，无法确认是否 >50MB，本轮不假定其大小 |

### D4 迅雷（转存成功，取链需人工，未完成）

| 项 | 值 |
|---|---|
| 输入 | `https://pan.xunlei.com/s/VP0pnkEtVNpwvzgezxXBUa4YA1?pwd=s5sp` |
| 任务 | `22c092b8-b876-44bc-b696-0833eac1e512`，终态 `needs-human / manual` |
| 真实链路 | 应用内登录态有效 → 转存成功（我的云盘出现「获取(1)」）→ 窗口切到 `pan.xunlei.com` |
| 实际目录内容 | 「获取(1)」内为 `正版影视获取渠道…zip 1.5MB`、`打开压缩包…zip 2.1GB`、`不想解压就点开我👈.mp4 1.5MB`；计划里记录的 8.9KB HTML 已不在 |
| 已尝试 | 用 CDP 打开文件夹（`.SourceListItem__item--XxpOC` 上派发 mouseenter/mousedown/mouseup/click/dblclick 才真正进入）、勾选最小文件（`.FileCheckBox__input--Z7wzZ`，`checked=true`）、再点 `.pl-button-mode` 中的「Aria2 下载」——用合成事件与 CDP 真实鼠标事件两种方式都试过 |
| 阻塞 | 下载助手的下拉菜单没有展开（`.pl-button-mode` 各项 `getBoundingClientRect().height === 0`，父节点高 0），点击落到「下载助手」按钮本体后弹出的是「新建离线链接任务」对话框；助手「Aria2 下载」入口无法被自动触发。任务保持「需手动取链」，程序未收到任何 addUri |
| 未执行 | 未下载、未解压任何文件（未知来源文件只做链路测试，不执行） |

说明：本轮没有猜选择器之外的东西——上述 class 均来自实际 DOM。该阻塞是「应用内网盘助手菜单需真实人工点击」的交互事实，不是程序缺陷断言。

## 阶段 D 收尾状态

- 旧配置：`settings.json` 与测试前一致（`aria2Mode=builtin`、`port=6800`、原目录、`allowTransfer` 原值）。
- 旧任务：重启后 7 条历史任务全部重新载入，`49 文件任务` 仍为「下载完成」，未因新版本被改写或丢失；真实下载新增 2 条完成记录。
- 旧会话：`%APPDATA%\linkswift-desktop\aria2\session.txt`、分区 `persist:linkswift`、`jobs.json` 路径均未改变。
- 失败测试任务：`submit` 侧没有文件列表的任务 `JobManager.persist()` 不会写盘（`if (!files || !files.length) return;`），所以百度/迅雷失败记录只存在于内存，不污染历史。

## 阶段 E：独立复核与收尾

独立复核（只读、按本轮 diff 逐条给证据）共 7 条意见，处理结果：

| 级别 | 意见 | 处理 |
|---|---|---|
| P1 | `unidownload-mark.svg` 的箭头是白色实心填充，只适合白底 | 改为 U 环（evenodd 路径）+ 同色箭头两个独立形状，全平色 `#233c2e`、无白色填充；`check:brand` 新增「mark 无白色镂空」检查 |
| P1 | `check-brand.js` 只用正则读源码断言窗口标题/图标，未验证运行时值 | 新增断言 `icon: brandIconPath()`、图标文件真实存在且开发路径与打包路径指向同一文件、renderer 使用 `class="brandmark"` |
| P2 | 详情文件列表对 done 任务一律写「下载完成」，与任务级修复矛盾 | 按每个文件在 `state.progress` 里的真实状态显示：`complete → 下载完成`、`error → 下载失败`、有长度 → 进度字节、无进度 → `doneDetail()` |
| P3 | PNG 只校验 IHDR，全透明文件也能过 | `check-brand.js` 内置 PNG 解码（zlib + unfilter），统计不透明像素占比：mark > 10%、icon > 50% |
| P3 | `verify-files.js` 用 `path.join` 拼远端文件名，`..` 越界会被误报 missing | 改 `path.resolve` + 前缀校验；越界计入 `mismatched` 并给出示例 |
| P3 | 负例「探针泄漏」只 grep 源码，未真正运行探针 | 改为 `spawnSync(electron, [probe-ui.js])` 且 `LINKSWIFT_PROBE_LEAK_DAEMON=1`，断言退出码非零 |
| P3 | `run-checks.js` 拒绝带 `-` 参数的脚本，`probe:boot` 类暂时无法登记 | `deferred:` 目前 `SCRIPT_STEPS` 全是 `node/electron <file>` 形式的检查，需要时再放开参数白名单 |

复核同时确认已满足：检查出口（子进程失败/信号/清理失败均非零）、取消断言用精确「已取消」、历史任务不按当前设置改标、无 `innerHTML`、品牌与内部标识兼容、无新增依赖。

修正后的完整检查：`check:brand OK: 9` / `check:runner OK` / 负例 5/5（含真实探针泄漏运行）/ `probe:ui` 40 条断言 `PROBE OK` / `All checks PASSED.`，`EXIT=0`。

## 未完成项（如实保留）

1. 百度 >50MB 全链路：缺已登录百度会话。
2. 迅雷「下载助手 → Aria2 下载 → 推送」：助手菜单需人工点击，自动化点不到；且当前目录已无计划中的 8.9KB HTML。
3. 远端 GitHub Actions 未运行（未推送）。
