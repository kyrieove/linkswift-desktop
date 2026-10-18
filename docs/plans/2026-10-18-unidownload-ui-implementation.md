# Unidownload UI 与品牌实施交接

日期：2026-10-18。用户要求新会话开始实施，不再从命名与视觉探索重来。

状态（2026-10-18 接续会话更新）：执行顺序 1–3 已完成，第 4 项中真实 Electron 界面、品牌与检查已完成，真实网盘回归部分完成。逐项结果、命令与阻塞见 `docs/plans/2026-10-18-unidownload-acceptance.md`。

## 参考与实际状态

- 决定见 ADR 0003。最终视觉为 `docs/design/gopeed-ui-v3.html`，配套 `gopeed-ui-v3-light.png`、`gopeed-ui-v3-dark.png`、`gopeed-ui-v3-detail.png`、`gopeed-ui-v3-xunlei.png`。V1 包含早期路线，V2 为中间方案。
- 用户明确去掉文件类型图标列，四网盘全部出现在侧栏。保留搜索、排序、筛选、批量操作、按需详情、独立设置和主题。
- Logo 概念副本：`docs/design/unidownload-logo-concept.png`。原图仍在 `C:/Users/ASUS/.codex/generated_images/01a14dfe-8a51-7b00-b94c-17621601f8de/exec-54ea8550-fc2d-4713-a6e3-79159fa6eebe.png`。仅生成 PNG，尚无 SVG/透明 PNG/ICO。
- 本会话未改生产代码；当前包名仍为 linkswift-desktop。交接前 HEAD 为 1d42edd。设计 HTML、截图和新增文档尚未提交；接手重新核对 Git 状态。
- V3 浏览器原型 13 项断言通过：四网盘筛选、去掉图标、UC 暂停继续、迅雷三种状态、转存设置跳转、统一授权文案、手动说明、无假继续按钮、登录继续及新迅雷任务授权检查。390px 下检查无页面横向溢出。这不是实际下载验收。

## 执行顺序与验收

1. 先核对现有 renderer、preload、protocol、providers，建立旧能力到新 UI 的映射，运行适用的现有检查取得生产基线。复杂实现遵守项目 orchestration 规范，避免多个写入代理同时编辑 renderer。
2. 在 renderer HTML/CSS/JS 落地 V3，复用 preload。筛选、搜索、排序、选择项与详情属于 UI 状态；批量操作逐条调用现有接口，处理部分失败。不要复制原型假任务、假速度或内存通知当成生产逻辑。
3. 接齐真实任务/设置，再接入 Unidownload 名称与图标。制作 SVG 标志、透明 PNG、Windows ICO 和所需尺寸；检查 16/24/32px，遵循已认可 U+箭头、深绿/薄荷色。概念 PNG 不冒充 SVG。保留上游 LinkSwift 来源、LICENSE、NOTICE。中文名/口号未选，不自行定案。
4. 用真实 Electron 验证默认 900×760、最小 720×520、主题、键盘、空列表、长文件名、多文件与重渲染。运行适用的 check:share-link、check:job、check:aria2、check:lifecycle、probe:ui，并做真机回归。更新证据与交接，不把旧记录当本轮通过。

## 不得丢失的能力

- 完整分享文案/提取码、粘贴/自动提交仍由原有主进程解析。不要用原型里简化 URL 正则代替。
- 保留 loading/extracting/needs-human/linked/delivering/downloading/paused/done/failed，以及 failed+cancelled。复制直链或浏览器下载不伪造本地下载完成。
- 暂停、继续、重试、取消、重启恢复，每文件进度、复制直链、请求头查看、错误诊断。外部文件名、链接、错误文本用 textContent。
- 人工处理区分登录、验证码、提取码、转存、页面异常、手动取链。迅雷走应用窗口登录并保留「我已登录，继续」；手动取链不能点一个模拟继续就视作成功。
- 三出口 aria2/剪贴板/浏览器，内置/外部 aria2，RPC 地址/端口/路径/令牌，目录选择/打开、测试连接/重启、自动提交，以及适用于百度和迅雷的全局自动转存授权。授权不可默认开启。
- 内部包名、app 标识、userData、session partition、aria2 配置、jobs 与下载会话路径的改名需验证兼容；不要因品牌变化丢失旧配置与续传记录。

## 旧交接记录与遗留待办

以下来自旧 HANDOFF，**本轮未重新执行**，不作为当前实时成功结论：

- 旧记录报告 check:share-link/check:aria2/check:job/check:lifecycle 曾过；生命周期覆盖暂停/下载中退出、重启续传、字节一致、无 .aria2 残留。
- 旧记录报告百度 23,909,266 字节分享完成暂停/继续/退出/恢复，UC readme.doc 18,514 字节完成，夸克 320.3 MiB 回归；迅雷登录、转存及自己网盘首页助手可用。
- 待做：迅雷最后一步仍需在自己的网盘选文件并通过助手推送。先完成一次真实手动链路，再依据实际 DOM/__vue__.info 评估自动打开文件夹和选择；不能猜选择器。
- 待做：百度 >50MB 转存后切 /disk/main 再取链的真机验收；UC 49 文件目录整批完成；外部 aria2 模式连接与下载回归。
- 内置 aria2/恢复与四网盘决定已在 ADR 0001/0002；踩坑看 LESSONS.md。不要因本轮 UI 删除原有兼容处理。

## 工作区边界

probe-readme.md、start-linkswift.bat 是既存未跟踪文件，不是本次 UI 交付，不顺手清理或提交；批处理可能含本机环境信息，使用前检查。本次未授权推送远端。早期 20–30 小时仅规划估算，不是承诺或已消耗工时。
