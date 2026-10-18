# dsh 接续任务：Unidownload 品牌、V3 界面与真实下载验收

核对日期：2026-10-18。工作目录：`D:/2/dev/linkswift`。

本文件供新的 dsh 会话直接实施。用户已批准 Unidownload 名称、第三版视觉和 U+下载箭头概念，无需重新征求命名、原型或开工确认。先核对现场，在现有未提交实现上修复、完成和验收，不从头重写。本次用户选择 dsh 接续，旧任务卡中的 agy/wb 分工只是此前执行记录，不是要求 dsh 再转派给 agy。

## 1. 当前实际状态

下表来自本次 Git、源文件和 runner 最终状态的只读核对；没有在撰写本文时重新运行检查或真实下载。

| 范围 | 事实 | 接续要求 |
|---|---|---|
| Git | HEAD 仍为 `1d42edd`；生产改动尚未提交 | 先保存工作区清单，区分既存文件和自己的改动 |
| V3 渲染 | `src/renderer/index.html`、`styles.css`、`renderer.js` 已有大幅未提交改动 | 已有实现，不等于已通过验收；核对视觉与能力保留 |
| V3 任务卡 | `linkswift-v3-renderer` 的 `stage=done`、`exec.status=done`，但 `outcome=out_of_scope`，范围外路径仅 `HANDOFF.md`；runner 未进入有效 Check/独立审查 | 不把执行器自报 done 当作完成；保留现场，核对 HANDOFF 变化，不擅自回滚 |
| UI 探针 | 当前源码已有 Aria2Daemon、TaskStore 和断言。临时报告 `linkswift-ui-report.json` 为 `ok=true`、19 条断言 | 报告只是历史生成产物，仍有断言与清理缺口；修好后重跑 |
| 检查入口 | `package.json` 新增 `npm run check`，有 `tools/run-checks.js`、`tools/check-runner.js` 和 Windows CI | 改动未提交、未验收，不要再重复创建同类入口 |
| 检查任务卡 | `linkswift-check-guardrails-20261018` 为 `stage=done/outcome=review_fail`，Check exit=0，wb 为 FAIL | 优先修复 `docs/orch/2026-10-18-check-guardrails/review.md` 的真实问题 |
| 品牌 | 仅有概念 PNG 与品牌任务卡；`resources/brand/` 尚不存在，主窗口标题仍为 LinkSwift Desktop | 正式 SVG/PNG/ICO、应用图标和可见更名未做 |
| 真机回归 | 本轮还没有完成百度大文件、迅雷最终取链、UC 49 文件与外部 aria2 验收 | 使用下文真实输入，逐项保留本轮证据 |

根 `HANDOFF.md` 当前是旧的“内置 aria2、任务恢复、UC 与迅雷接入”内容，和本轮开头读取的 UI 交接版本不一致。范围检查证实发生了变化，但本文没有核实具体写入者。其“已验证”列表不得当成本轮新验收结果。不要用 `git restore/reset` 抹掉现场。

既存改动包括 `package.json`、三份 renderer、`tools/probe/probe-ui.js`；未跟踪内容包括设计资料、ADR、实施计划、任务卡、CI 和新检查脚本。`probe-readme.md`、`start-linkswift.bat` 是此前已有的用户文件，不清理、不顺手提交；批处理可能含本机信息，使用前检查，不将密钥写入报告。本次没有授权推送远端。

## 2. 先读资料与代码入口

按需要读取，避免一次加载全部源码或所有历史日志。

| 用途 | 路径 |
|---|---|
| 已批准品牌与 V3 决定 | `docs/adr/0003-unidownload-brand-and-v3-ui.md` |
| 原实施计划与不可丢失能力 | `docs/plans/2026-10-18-unidownload-ui-implementation.md` |
| 最终原型与视觉证据 | `docs/design/gopeed-ui-v3.html`；同前缀 light/dark/detail/xunlei PNG |
| Logo 概念 | `docs/design/unidownload-logo-concept.png` |
| V3 任务要求与自报结果 | `docs/orch/2026-10-18-v3-renderer/card.md`、`reply.md` |
| 检查入口审查结果 | `docs/orch/2026-10-18-check-guardrails/card.md`、`review.md`、`reply.md` |
| 尚未执行的品牌规格 | `docs/orch/2026-10-18-unidownload-brand/card.md` |
| 历史兼容决定与踩坑 | `docs/adr/0001-bundled-aria2-and-recovery.md`、`0002-uc-and-xunlei.md`；`DESIGN.md` 第 11 节；`LESSONS.md` |
| UI/宿主契约 | `src/preload/renderer-preload.js`、`src/shared/protocol.js` |
| 驱动与宿主实现 | `src/shared/providers.js`、`src/main/job.js`、`ipc.js`、`main.js` |
| 检查与 UI 探针 | `package.json`、`tools/run-checks.js`、`tools/check-runner.js`、`tools/probe/probe-ui.js` |

runner 保存的历史状态在 `C:/Users/ASUS/.claude/agent-live/orch-runner/<任务名>.json`。上表两个 LinkSwift 任务已核对为结束态；先按需一次读取结果即可，不重复派发，不让主模型循环 sleep/读日志维持监控。

## 3. 实施顺序与每阶段验收

### 阶段 A：先让检查结论可信

1. `tools/run-checks.js` 当前使用 `args: ['--check', ...srcFiles]`，只会语法检查第一个文件。改成每个文件独立 `node --check FILE`，或等效的逐文件执行。加入便宜的行为回归：第二个临时 JS 文件故意语法错误时，整个语法阶段必须失败。临时文件与输出留在专用 temp 目录。
2. `tools/probe/probe-ui.js` 当前会先设 `report.ok=true`，finally 的 `cleanupErrors` 只写报告而不改变成功结果。清理失败必须使检查返回非零；保留有界退出，不能遗留本次探针启动的 daemon/窗口。不得停止用户其他 aria2 实例。
3. 取消断言当前允许 `cancelText.includes('取消')`，而“失败 / 取消”也包含该字，可能假通过。断言真实 IPC/任务状态和明确的取消标签，不能仅按宽泛字符串判定。
4. 阅读其余 P2/P3 审查意见，按当前代码确认后处理必要问题。保持最小修复，不为了审查建议重构整个检查系统，也不通过删断言或放宽判定获得绿色。
5. 保留结构化 `spawn(command,args,{shell:false})`，Electron 子进程环境删除 `ELECTRON_RUN_AS_NODE`。检查程序、spawn 错误、signal、断言或清理失败均不能被包装成 exit 0。不要再使用 Bash 外层包双引号 PowerShell `$env/$null/$LASTEXITCODE` 的命令。

验收：先证明负例会失败，再修复并跑通 `npm run check`；检查实际 UI JSON 报告和退出码。`check:share-link`、`check:job`、`check:aria2`、`check:lifecycle`、`probe:ui` 已有入口，复用，不另建平行套件。现有 `.github/workflows/check.yml` 使用 Windows、Node 22、npm ci、npm run check；本地通过不等于远端 CI 已运行。

### 阶段 B：补齐并验收现有 V3

以已批准 V3 为准，保留深绿/薄荷、窄主导航、状态与四网盘侧栏、任务区、按需右详情、独立设置、浅深主题。用户明确删除的文件/文件夹类型图标列不能恢复。Gopeed 只是视觉参考，不更换框架，不增加 BT、扩展市场等功能。

核对以下真实行为，不把原型假任务/假速度搬进生产：

- 搜索、排序、状态与来源筛选组合有效；计数来自真实任务；空列表和筛选为空的反馈准确。
- 选择项和批量暂停/继续/取消走现有 IPC；按任务资格执行；部分失败不被整体“成功”提示吞掉。
- 每文件进度、复制直链、请求头、错误诊断、暂停/恢复/重试/取消和重启恢复仍可用。详情打开、滚动、焦点在任务事件重渲染后合理保留。
- 完整分享文案与提取码交给主进程解析，保留粘贴/自动提交。外部文件名、错误、分享 ID 等用 `textContent`，不作为 HTML 拼接。
- 保留 loading、extracting、needs-human、linked、delivering、downloading、paused、done、failed，以及 failed+cancelled；复制/浏览器投递不伪装为本地下载字节完成，历史任务不按当前未保存的设置误标出口。
- 登录、验证码、提取码、转存、页面异常、手动取链各自有真实入口。迅雷应用窗口登录和“我已登录，继续”保留；手动取链只等真实 addUri 回传，不提供模拟成功的“继续”。
- 保留 aria2/剪贴板/浏览器、内置/外部 aria2、完整 RPC 字段、目录选择/打开、测试连接/重启、自动提交；百度与迅雷共用全局自动转存授权，默认 false。

验收：真实 Electron 默认 900×760、最小 720×520，浅/深主题、详情打开、长文件名、多文件、键盘与重渲染；保存截图并实际看图。普通浏览器无 bridge 时应显示宿主不可用，不种演示任务。测试夹具只能在探针内，经真实 PUSH/IPC 使用；夹具覆盖不能声称远程网盘下载成功。现有 19 条断言不自动等于上述能力全覆盖，按行为补关键缺口即可。

### 阶段 C：完成正式品牌资源与可见更名

复用品牌任务卡细则：制作真实 U+向下箭头 SVG 标志、透明 PNG 和 Windows ICO，深绿 `#233c2e`、薄荷 `#d0efb5`；PNG 16/24/32/48/64/128/256/512，ICO 包含适用尺寸；检查小尺寸可辨识。SVG 不嵌概念 PNG 冒充矢量；提供可复建资源的脚本及尺寸/格式检查，避免新装依赖。

接到窗口标题、应用图标、renderer 品牌及 README。保留上游 hmjz100/LinkSwift 归属、LICENSE、NOTICE、aria2 COPYING。名称为 Unidownload，不重新命名、不自行选中文名或口号。

兼容性优先：保持 `package.name=linkswift-desktop`、`window.linkswift`、IPC、`persist:linkswift`、旧 userData、settings/jobs/aria2 会话与下载路径。不要简单添加 `productName` 或调用 `app.setName`：Electron 会优先取 productName 作为应用名，可能改变默认数据目录。当前方案只更换用户可见名称和图标。若确有必要迁移内部标识，必须先说明并证明旧数据兼容，不能擅自搬目录。

验收：真实启动读取旧设置/任务；确认原会话位置不变，图标可见、各尺寸文件正确，并重跑受影响检查。

### 阶段 D：完成真实网盘与外部下载器回归

真实测试输入及来源：

| 场景 | 输入与要求 |
|---|---|
| 百度 >50MB | 用户本轮提供：`https://pan.baidu.com/s/13FxRi_MycbF_n6OL4iWUAg?pwd=kzqr`，分享描述“Window 版…”；大小必须从真实页面确认，不能仅因该链接用于大文件验收就假定确实 >50MB |
| 迅雷 | 用户要求自行找公开分享；已在真实网页确认 `https://pan.xunlei.com/s/VP0pnkEtVNpwvzgezxXBUa4YA1?pwd=s5sp` 可进入 YunX 文件夹，当时 4 项。优先用 8.9KB 的 HTML 文件验收，页面当时还列出 17.2MB/13.4MB APK 和 8.2KB HTML；只下载测试，不执行未知文件 |
| UC 多文件 | 旧 `jobs.json` 中有 UC 49 文件失败任务，记录 id 曾为 `6d0e0380-f60e-4004-84fc-822332634f9f`。从本机 `%APPDATA%/linkswift-desktop/jobs.json` 按实际结构取原分享信息，不将完整直链、headers 或凭证写入仓库 |
| 外部 aria2 | 用本机已授权实例或受控本地实例，走真实 external 配置、测试连接、投递与落盘；不要硬编码 6800 或复制批处理中的密钥到报告 |

百度：确认需要转存的真实触发条件，授权开关有效，转存后切 `/disk/main` 并获取真实直链，直到 aria2 落盘。迅雷：先完成一次应用内登录→授权转存→我的云盘选文件→助手 Aria2 推送→应用接住链接→落盘的真实链路。自动打开文件夹/选择项只能依据实际 DOM 与 `__vue__.info`，不能猜 class；保留可靠手动兜底，不把自动化作为跳过真实人工链路验收的理由。

UC：整批结算须明确完成/失败数，核对文件数与实际落盘；某文件失败不许把其余任务误判为整体成功。外部 aria2 测试结束后恢复原设置，只处理本次创建的任务/进程。

调试应用优先由 agent 自行使用 CDP 驱动，不要求用户代点提交按钮。标准启动前清除 `ELECTRON_RUN_AS_NODE`。账号登录、验证码等确实只能由用户完成时，说明具体卡点，只请求这一步，并继续不依赖它的工作。缺失有效分享、网盘限流等真实阻塞须留下证据，不编造成功。

验收记录至少包含场景、时间、输入来源、最终任务/aria2 状态、完成/失败文件数、源页面大小与落盘字节、必要截图和恢复结果。RPC 返回 complete 或界面显示 done 本身不替代落盘验证。

### 阶段 E：独立复核、文档与交付

1. 对照阶段 A–D 列实际完成项与剩余阻塞，修正检查和真实行为问题后再做一次独立审查。不可把旧 wb FAIL 直接改成 PASS。
2. 更新原实施计划的状态、ADR 实施状态、README 和 HANDOFF；保留历史记录出处，把旧验收与本轮证据分开。
3. 展示最终改动范围与验证结果。只纳入本次相关文件，不夹带个人批处理、上游 README 副本或凭证。
4. 新会话若获授权做本地提交，可在验收后按阶段提交；没有远端推送授权。任何“已完成”都须对应实际结果，阻塞项继续保留为未完成。

## 4. 开工与完成标准

开工第一轮应报告：当前 HEAD/工作区、审查问题是否仍存在、准备先修哪个可验证单元。随后直接实施，不再只给计划，也不重新询问已批准的命名/设计。保持外部工具输出有界，长文件定点读；大段代码用文件编辑工具，不拼进超长 Windows 命令。

完成标准：检查的负例能被抓住；本地完整检查通过；真实 Electron V3 与品牌验收完成；阶段 D 四类场景有实际证据或明确、可复现的外部阻塞；旧设置/任务/会话不丢失；最终报告和工作区一致。

本项目不要混入 `D:/2/dev/token-weather-quota-codex` 的进度面板工作，也不要修改 `D:/2/dev/orch-runner` 来顺手修编排器。若旧 runner 的状态/范围门禁需要处理，说明事实并使用其正规入口，不能直接编辑状态 JSON 伪造验收。
