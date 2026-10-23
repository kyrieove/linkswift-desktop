# 0004 多来源多引擎：把 yt-dlp 接进来

日期：2026-10-22
状态：已采纳（设计阶段，尚未开工）
相关：`docs/adr/0001-bundled-aria2-and-recovery.md`、`DESIGN.md` 第 11 节

---

## 背景

现在的 Unidownload 是「网盘分享链接 → 直链 → aria2」这一条通路。三个地方把它焊死成了网盘专用：

1. **来源**。`src/shared/providers.js` 里的 `Provider` 条目同时承担两件事：来源身份（`id` / `label` / `matches(url)` / `parseShareId(url)`）和网盘取链配方（`steps[]` / `transferSteps` / `driveUrl` / `loginKind` / `authenticatedHosts`）。`parseShareLinks` 要求某个网盘同时命中 `matches()` 和 `parseShareId()`，否则整条粘贴被拒（`src/main/job.js:1966`）。一个 YouTube 链接既没有 `shareId` 也没有提取码，走不进去。
2. **引擎**。`Job` 直接调 `aria2.*`：投递用 `addUri`（`src/main/job.js:2278`）、进度用 `findGid` + `tellStatus`（`job.js:1656`）、暂停续传取消用 `pause` / `unpause` / `remove`（`job.js:1735`、`1750`、`1779`）、重推用 `addUri`（`job.js:1577`）。进度行 `DownloadProgress` 的 `gid` 字段就是 aria2 的 GID。
3. **界面**。渲染进程从不 import 注册表（`src/shared/providers.js`），网盘清单在 32 处硬编码，详见本 ADR 末尾的清单。

要把工具变成「多功能下载器」，得先回答一个问题：**yt-dlp 到底扮演什么角色？**

### yt-dlp 能给什么

yt-dlp 是「解析器 + 下载器 + 后处理器」三位一体。上游 README 明确说它应当被这样嵌入：

> Your program should avoid parsing the normal stdout since they may change in future versions. Instead, they should use options such as `-J`, `--print`, `--progress-template`, `--exec` etc to create console output that you can reliably reproduce and parse.

它带来三样现在完全没有的东西：上千站点的解析、格式选择（`bv*+ba/b` 默认策略）、ffmpeg 后处理（音视频合并、提取音频、嵌入封面与元数据、字幕）。第三样是「多功能」这个词的实际内容。

### 本机实测（2026-10-22，yt-dlp 2026.08.19，Windows x64）

以下都是在这台机器上跑出来的，不是读文档推断的。

| 测项 | 结果 |
| --- | --- |
| `--progress-template` 输出 | 每行一次更新，字段在 `progress.*` 与 `info.*` 下。`status` 取值 `downloading` / `finished` / `error`。缺失值渲染成字面量 `NA` |
| `%(...)j` 能否直接产出合法 JSON | **不能**。`%(progress.total_bytes_estimate)j` 在值为 None 时输出裸的 `NA`，`JSON.parse` 直接抛错。`%(progress.filename)j` 自带引号，外层再包引号就成双引号。Windows 路径里的 `\` 被转义成 `\\` |
| 制表符分隔的模板 | 可用。实测输出 `PROGRESS\tdownloading\t1024\t1595\tNA\tNA\tNA\tC:\Users\...\b.unknown_video`，路径无转义，Windows 上按 `\t` 切分即可，`NA` 当 null 处理 |
| `--downloader aria2c` 有没有实时进度 | **没有**。13 MB 文件跑完只输出一行 `status=finished`。源码 `yt_dlp/downloader/external.py` 的 `ExternalFD.real_download` 只在结束时调一次 `_hook_progress`，aria2c 的 stderr 被 `ExternalFD._CAPTURE_STDERR = True` 吞掉。`--downloader-args "aria2c:--summary-interval=1"` 也救不回来 |
| `--downloader aria2c` 能不能复用本应用的内置 aria2 守护进程 | **不能**。`Aria2cFD._make_cmd` 起的是一次性 `aria2c` 子进程（`--no-conf --console-log-level=warn --summary-interval=0 -x16 -j16 -s16 --dir --out -- URL`），全程没有 RPC |
| `-J` 的字段 | `id` `title` `ext` `format_id` `url` `http_headers` `filesize_approx` `protocol` `direct` `requested_downloads` `requested_subtitles` `playlist_index` `duration` `thumbnail` `extractor` `webpage_url` `webpage_url_domain` `timestamp` 等 |
| `--print` 的阶段 | WHEN 取值与 `--use-postprocessor` 相同：`pre_process` / `video` / `before_dl` / `post_process` / `after_move` / `after_video` / `after_audio` / `after_subtitles` / `after_infojson`。注意 `--print` **隐含 `--quiet` 与 `--simulate`** |
| YouTube 解析 | 通。`id=aqz-KE-bpKQ title=Big Buck Bunny 60fps 4K dur=635 uploader=Blender`，缩略图也拿到了 |
| B 站解析 | 在本机网络下报 `This video may be deleted or geo-restricted`，属于网络条件，不是 yt-dlp 的问题 |
| 通用解析器（generic）的坑 | URL 带签名 query 时 `%(id)s` 会变成整条签名 URL，文件名不可用。必须显式给 `-o` |

上游发行版 `2026.10.21` 的 `yt-dlp.exe` 是 17,880,111 字节，sha256 `33121d192d706e62f684a06f80918e3f3a8ba52ac3a65213b6951c39c7d9f555`。这台机器上 `~/.local/bin/yt-dlp.exe` 只有 46,080 字节，是 uv tool 的启动壳，**依赖外部 Python**，不是自包含二进制，不能直接打包。

---

## 决定

### 1. `Source` 联合类型，`link` 字段就地拓宽

`link` 的语义本来就是「用户贴进来的东西」，对三种来源都成立。不新增字段、不做数据迁移，把 `ShareLink` 换成 `Source`：

```js
/** @typedef {'netdisk'|'media'|'direct'} SourceKind */
Source =
  | { kind:'netdisk', provider:ProviderId, shareId:string, passcode?:string, raw:string }
  | { kind:'media',   url:string, raw:string }
  | { kind:'direct',  url:string, raw:string }
```

`src/shared/providers.js` 保留为网盘取链配方表。新增 `src/shared/sources.js` 作为来源注册表，把四个网盘配方和新的 `media` / `direct` 条目收在一处，每条给出：

```js
{ id, label, kind, matches(url), parse(url), capability:{grade,note}, experimental, color }
```

`parse(url)` 对网盘返回 `{target:shareId, passcode}`，对媒体与直链返回 `{target:url}`。解析失败按条报错，不影响整段粘贴（现在的行为不变）。

### 2. 引擎抽象，aria2 与 yt-dlp 是两个实现

`Job` 里所有直接调 `aria2.*` 的地方换成 `this.engine.*`。引擎接口需要四件事（这是实际需要的，不是预想的抽象）：

```js
Engine = {
  id: 'aria2' | 'yt-dlp',
  status(): Promise<{running:boolean, version?:string, error?:string}>,
  start(items, opts): Promise<Run>,
  progress(run): Promise<DownloadProgress[]>,
  pause(run): Promise<void>,
  resume(run): Promise<void>,
  cancel(run): Promise<void>,
}
```

`DownloadProgress` 加 `engine` 字段，`gid` 保留给 aria2（aria2 行的 `gid` 照旧，yt-dlp 行为 `null`）。持久化里的 `gids` 换名 `runs`，读的时候在 `src/main/task-store.js` 一处做兼容：`gids` 映射成 `runs`，`engine:'aria2'`。

### 3. 媒体下载由 yt-dlp 自己完成，aria2 继续管网盘与直链

分工表：

| 来源 | 解析 | 传输 | 后处理 |
| --- | --- | --- | --- |
| `netdisk` | 网盘脚本（浏览器里驱动） | aria2 | 无 |
| `direct` | 无，URL 即目标 | aria2 | 无 |
| `media` | yt-dlp | yt-dlp | ffmpeg（合并 / 提音频 / 封面 / 字幕） |

理由是后处理。音视频合并、提取音频、嵌入封面这些能力只在 yt-dlp 的进程里成立，让它下载才有。aria2 只在 http/https/ftp 上工作，`ExternalFD.supports()` 也明确拒绝 `+` 合并格式，所以「yt-dlp 解析、aria2 传字节」这条路走到底，合并还得自己做，等于重写 yt-dlp 的后半段。

代价要说清楚：**媒体这一路是单连接的**，吃不到 aria2 的 16 线程分片。后续可以做一个受限的加速开关（先用 `-J` 探测，只有单条渐进式 http 直链时才交给 aria2），本期不做。

### 4. 进度通道用制表符分隔，不追求 JSON

```js
--progress-template "download:PROGRESS\t%(progress.status)s\t%(progress.downloaded_bytes)s\t%(progress.total_bytes)s\t%(progress.total_bytes_estimate)s\t%(progress.speed)s\t%(progress.eta)s\t%(progress.filename)s"
```

解析规则：按 `\t` 切分，值为 `NA` 一律当 null。理由是实测：`j` 转换在 None 时产出裸 `NA`，整行不是合法 JSON；字符串字段自带引号会和外层引号打架；Windows 路径会被转义。制表符方案实测路径原样输出，无转义。

### 5. 媒体来源复用现有的浏览器登录与 cookie 机制

yt-dlp 读不到 Electron 的 session。两个已有零件正好接上：

- `src/main/chrome-login.js` 已经能把真实 Chrome 的登录态导进应用 session。
- `src/main/job.js` 的 `withCookies`（`job.js:1480`）已经会按直链 URL 从 session 取 cookie。

做法：把 session 里对应站点的 cookie 导出成 Netscape 格式文件，交给 `--cookies <file>`。遇到「Sign in to confirm you're not a bot」「Private video」「members-only」这类错误，复用现成的 `needs-human` 状态与 `revealWindow`，在应用自己的隐藏窗口里让用户过验证，cookie 有了再重跑。**现在为网盘准备的那套浏览器能力，顺手变成媒体的登录能力。**

### 6. yt-dlp 的更新由应用管，不调 `-U`

2026.10.21 发行说明第一条就是安全提醒：旧版 yt-dlp 可执行文件存在中间人攻击风险，明确建议不要用 `-U` / `--update` / `--update-to`，改成手动下载替换。

本仓库已经有这个问题的现成解法：`src/main/userscript.js` 的「拉取最新 → 缓存 → 回退内置」三段式。yt-dlp 照抄即可：调发行版 API 比版本号 → 下载 `yt-dlp.exe` → 用发行版附带的 `SHA2-256SUMS` 校验 → 换文件 → 记录版本到任务记录。频道可选 `stable` / `nightly` / `master`，上游自己说日常用户推荐 nightly。

### 7. 许可证：打包 `yt-dlp.exe`，并入 AGPL 义务

仓库 LICENSE 是 AGPL-3.0-or-later。上游 README 的 Licensing 一节写得很清楚：

> While yt-dlp is licensed under the Unlicense, many of the release files contain code from other projects with different licenses. Most notably, the PyInstaller-bundled executables include GPLv3+ licensed code, and as such the combined work is licensed under GPLv3+.

AGPL-3.0-or-later 与 GPLv3+ 兼容，所以打包 Windows 自包含的 `yt-dlp.exe` 不冲突。义务是：

- `resources/ytdlp/yt-dlp.exe` 与 `resources/ytdlp/THIRD_PARTY_LICENSES.txt` 一起随二进制分发。
- `NOTICE` 追加 yt-dlp 上游署名与许可证说明，格式照 aria2 那条（`resources/aria2/COPYING`）。
- 纯 Python 包（PyPI wheel）才是 Unlicense，但那条路要用户机器上有 Python，不采纳。

`--compat-options allow-unsafe-ext` 与 `allow-unsafe-exec-expansion` 是明确标了「可以导致远程代码执行」的开关，任何时候不得打开。`--exec` 也不使用。

### 8. ffmpeg 先用系统版，不打包

ffmpeg 与 ffprobe 是合并和提音频的硬依赖，本机有 winget 装的 9.0.1，但仓库里没有。本期按「检测系统 ffmpeg，找不到就在设置页显示未检测到」处理，行为对齐现有的「未验证」口径。打包 ffmpeg 留到后面（yt-dlp/FFmpeg-Builds 的构建是 GPLv3+，与本仓库兼容）。

---

## 否掉的方案

- **`--downloader aria2c`（yt-dlp 内部调用 aria2）**。实测没有实时进度，13 MB 文件只出一行 `finished`。而且它起的是一次性 `aria2c` 子进程，复用不了本应用的内置守护进程，aria2 的会话、端口、密钥那套全部白做。直接否。
- **yt-dlp 只解析、aria2 只传字节**。合并格式在 aria2c 上根本不可用（`ExternalFD.supports()` 拒绝 `+` 协议），合并要自己做，等于重写 yt-dlp 的后半段。而且要跑两遍 yt-dlp。否。
- **Python API 侧车进程**。用户机器上要有 Python 3.11+。Windows 上唯一自包含的选择就是 PyInstaller 的 exe，那就退回 CLI 了。侧车的额外收益（`progress_hooks` 拿到结构化 dict）在制表符方案下已经拿到。否。
- **npm 包装器**。`yt-dlp-wrap` 在 npm 上已标 "Package no longer supported"，GitHub 仓库 404，它的「进度」事件靠正则刮人读格式 `[download] 12.3% of 45.6MiB at 1.2MiB/s`，格式一变就废。`youtube-dl-exec` 还在维护，但只是薄封装。自己 spawn exe 更可控。否。
- **让 yt-dlp 自更新**。上游自己警告过中间人风险，而且 `-U` 要安装目录可写。应用自己管更新，逻辑跟 `userscript.js` 一样。否。
- **只在 `providers.js` 里加一条 `media` 记录，不抽 `Source` 联合类型**。那样 `Provider` 条目会同时承载「来源身份」与「网盘取链配方」两种语义，而媒体源根本没有配方、也没有 `shareId`。之后每加一种来源都要往同一张表里塞条件分支。否。
- **媒体也走 aria2 + ffmpeg 自己合并**。合并逻辑（容器兼容、`--merge-output-format`、remux 还是重编码）不是小工程，做出来也一定比 yt-dlp 的差。否。

---

## 后果

### 要新增的文件

| 文件 | 作用 |
| --- | --- |
| `src/shared/sources.js` | 来源注册表，串起网盘配方与媒体/直链条目 |
| `src/main/engines/index.js` | 引擎注册表 |
| `src/main/engines/aria2-engine.js` | 现有 aria2 调用包一层 |
| `src/main/engines/ytdlp-engine.js` | spawn yt-dlp、拼参数、解析进度、分类错误 |
| `src/main/ytdlp-source.js` | 拉取、缓存、校验、切换 yt-dlp 二进制（照抄 `userscript.js` 的结构） |
| `src/main/media-format.js` | 媒体选项到 yt-dlp 参数的映射（格式、画质、后处理开关） |
| `tools/check-ytdlp-args.js` | 断言拼出来的 argv |
| `tools/check-ytdlp-progress.js` | 喂真实 stdout 行，断言解析结果 |
| `tools/check-ytdlp-errors.js` | 断言 stderr 到失败码/需人工的映射 |
| `tools/probe/check-ytdlp-lifecycle.js` | 本地慢速 HTTP 服务跑完 yt-dlp 全流程，不联网 |

新检查项必须登记进 `tools/run-checks.js` 的 `SCRIPT_STEPS`，否则 `npm run check` 不会跑它。

### 要改的文件

`src/shared/protocol.js`（`Source` 联合类型、`EngineId`、`DownloadProgress.engine`）、`src/shared/providers.js`（拆出配方）、`src/main/job.js`（`aria2.*` 换 `engine.*`、`link` 换 `source`、媒体分支）、`src/main/task-store.js`（`gids` → `runs` 兼容）、`src/main/store.js`（媒体设置）、`src/main/ipc.js` + `src/shared/protocol.js`（新增 `INVOKE.sources`）、`src/preload/renderer-preload.js`（暴露新方法）、`src/renderer/renderer.js`（来源清单改数据驱动）、`src/renderer/index.html`、`src/renderer/styles.css`、`NOTICE`、`README.md`、`DESIGN.md`。

### 体积

`yt-dlp.exe` 约 17.9 MB，仓库从约 5.6 MB 的二进制涨到约 23.5 MB。Electron 本体约 368 MB，不受影响。

### 已知限制

1. 媒体单连接，慢于 aria2 的 16 线程。
2. yt-dlp 没有真正的暂停。暂停 = 杀进程，续传 = 带 `--continue` 重启，靠 `.part` 文件接着下。续传要重新解析一次，界面这段时间显示「继续中」。
3. yt-dlp 的 `-J` 里 `filesize` 对分片格式常常是空的，`filesize_approx` 也有历史坑（2023 年被移除）。进度条在总量未知时按已下载量显示，不显示百分比。
4. YouTube 的完整支持还需要一个 JavaScript 运行时（上游说 `yt-dlp-ejs` 已在 exe 内，但 JS runtime 要另外配，Node 需 22 以上）。Electron 自带的 Node 版本够，但 `ELECTRON_RUN_AS_NODE=1` 得显式设置，而这台机器的 shell 本来就全局设着这个变量（见 `LESSONS.md` 第 1 条）。这条要单独验证，不能想当然。
5. 站点解析器会失效，这是 yt-dlp 的常态。缓解手段是上面的自更新机制加上 nightly 频道。

### 渲染进程的硬编码清单（接来源注册表时要一起清）

`renderer.js:32` `PROVIDER_LABELS`、`renderer.js:56` `PROVIDER_LOGIN`、`renderer.js:279` `getJobName`、`renderer.js:287` 窗口登录措辞、`renderer.js:455` 与 `:485` 来源筛选、`renderer.js:462` 与 `:489` 搜索、`renderer.js:519` `PROVIDER_CAPABILITY`、`renderer.js:537` 能力表行、`renderer.js:614` 侧栏计数、`renderer.js:775` 来源色点（**缺省会落回 `quark`**）、`:776`、`:952`、`:1001` 诊断文案、`:1042` 与 `:1319` 抽屉标题、`:1068`「网盘来源」行、`:1202`、`:1379`、`:1409`、`:1748` 来源页硬编码数组、`:1760` 实验性徽标、`:1761`、`:1874`、`index.html:17` 侧栏硬编码按钮、`index.html:18` 与 `:27` 占位文案、`index.html:22` 来源页文案、`styles.css:333` 四个色点颜色、`protocol.js:13` `ProviderId` 封闭联合类型。

其中 `PROVIDER_LOGIN` 与 `PROVIDER_CAPABILITY` 是注册表里已有事实的重复（`loginKind`、`experimental`、`transferOnly`），接数据源时直接删掉，不要再维护第二份。

---

## 落地补记（2026-10-22）

这一节是开工之后补的。两条来自使用者的定案，和三条实测出来、改了实现的事实。

### 定案

**内置 yt-dlp。** `resources/ytdlp/yt-dlp.exe`（2026.10.21，17,880,111 字节，sha256 `33121d192d706e62f684a06f80918e3f3a8ba52ac3a65213b6951c39c7d9f555`）随仓库走，下载后按发行版附带的 `SHA2-256SUMS` 校验过。

**不必经 aria2。** 来源自己声明默认引擎，用户可以按来源覆盖。aria2 从架构前提降成一个实现。

顺带一条：aria2 不能删。网盘的直链经常没有扩展名，yt-dlp 的通用解析器会直接报 `Unsupported URL`（本机实测 `README.md` 就是这样被拒的），而且网盘要靠 16 线程分片和 aria2 的会话文件续传。所以正确形态是「aria2 变成可选实现」，不是「去掉 aria2」。

### 三条改了实现的事实

**`--print` 和 `--progress-template` 只能活下来一个。** `--print` 隐含 `--quiet`，`--quiet` 会把 `--progress-template` 一起关掉。实测矩阵：基线 3 行进度 0 行阶段信号；加 `--print` 变成 0 行进度 1 行阶段信号；加 `--print-to-file` 又是 3 行进度。阶段信号改走 `--print-to-file`，写进文件，两个都能用。

**PyInstaller 单文件 exe 会再起一个子进程。** `child.kill()` 只杀掉引导进程，真正的 Python 还在下载，输出还在往管道里写。实测：暂停后下载继续跑完，`.part` 被改名成成品文件，看起来像「暂停没生效」。Windows 上要用 `taskkill /pid <pid> /T /F` 把整棵树收掉。

**被杀掉的那个进程的收尾报告属于上一轮。** 它的 `close` 事件在下一轮开始之后才到，会把新一次运行的 `finished`、`exitCode`、`error` 全覆盖掉，于是「续传」刚起步就被判成失败。每一次 spawn 带一个 token，收尾报告的 token 对不上就丢掉。

### 已经落地的部分

| 文件 | 做了什么 |
| --- | --- |
| `src/shared/protocol.js` | `SourceKind` / `Source` 联合类型 / `EngineId` / 新的 `FailureCode` / `DownloadProgress` 加 `engine` 与 `runId` / `INVOKE.sources` 与 `INVOKE.ytdlpStatus` |
| `src/shared/sources.js` | 来源注册表。网盘配方来自 `providers.js`，另加 `media` 与 `direct` 两条。`parseSources` 认链接，`normalizeSource` 读旧记录，`sourceViews` 给渲染进程 |
| `src/shared/providers.js` | 退成网盘配方表，导出 `extractShareUrls` 供注册表用 |
| `src/main/engines/aria2-transfer.js` | aria2 包成引擎 |
| `src/main/engines/ytdlp-transfer.js` | yt-dlp 包成引擎。参数拼装、制表符进度解析、错误分类、暂停续传取消、进程树收掉 |
| `src/main/engines/index.js` | 引擎注册表与按来源选引擎 |
| `src/main/ytdlp-binary.js` | 二进制定位、版本、更新（下载、校验、换文件、回滚） |
| `src/main/job.js` | `Job` 不再直接调 `aria2.*`，改成问引擎。`gids` 换 `runs`。新增媒体与直链两条分支。`needs-human` 与 `loginNow` 对媒体走应用自己的窗口 |
| `src/main/store.js` | `media` 选项、`ytdlpPath`、`engineOverrides` |
| `src/main/ipc.js`、`src/preload/renderer-preload.js` | 暴露来源清单与 yt-dlp 状态 |
| `src/renderer/renderer.js` | `sourceLabel` 与 `sourceId`。认不出来的来源显示成「未知」，不再假装是夸克 |
| `src/renderer/styles.css` | 媒体与直链的色点 |
| `tools/check-source-parse.js` | 来源判定 |
| `tools/check-ytdlp-args.js` | 命令行契约 |
| `tools/check-ytdlp-progress.js` | 进度解析 |
| `tools/check-ytdlp-errors.js` | 报错分类 |
| `tools/probe/check-ytdlp-lifecycle.js` | 端到端：下载 → 暂停 → 续传 → 字节一致 |

### 还没做的

- ffmpeg 没有打包。现在能在设置页指路径，也能读出 PATH 上那份的版本。
- 媒体是单连接。yt-dlp 的原生下载器就这个性质。
- 「媒体用 aria2 加速」没做：先用 `-J` 探测，只有单条渐进式直链时才交给 aria2。
- 播放列表、字幕、提取音频这些开关只在设置页有默认值，没有做每条任务单独调。
- 播放列表的一条失败仍然会记成整个任务失败。yt-dlp 默认继续下一条，但应用只看进程退出码。

### 第二轮补记：界面接上注册表，设置页补上媒体

| 文件 | 做了什么 |
| --- | --- |
| `src/shared/providers.js` | 每个网盘条目带上 `capability`、`color`、`desc`、`badges`。这些是网盘自己的知识，放在这里 |
| `src/shared/sources.js` | `sourceViews()` 补上 `loginKind`、`badges`。颜色变成十六进制值，不再是 CSS 类名 |
| `src/shared/media-options.js` | 媒体设置到 yt-dlp 参数的映射，纯函数，主进程与检查脚本共用 |
| `src/main/ffmpeg.js` | ffmpeg 在哪、有没有、什么版本、ffprobe 在不在 |
| `src/main/ytdlp-binary.js` | 补上按发行版更新：下载、校验 SHA2-256SUMS、换文件、换坏了回滚 |
| `src/main/job.js` | 新增 `ffmpegStatus()` 与 `updateYtDlp()` |
| `src/main/ipc.js`、`src/shared/protocol.js`、`src/preload/renderer-preload.js` | 新增 `chooseFile`、`ffmpegStatus`、`ytdlpUpdate` 三个通道 |
| `src/renderer/renderer.js` | 删掉 `PROVIDER_LABELS`、`PROVIDER_LOGIN`、`PROVIDER_CAPABILITY` 三张写死的表。侧栏来源清单、能力表、来源页、计数、筛选全部从注册表画 |
| `src/renderer/index.html` | 侧栏四个写死的按钮换成 `#source-filters` 容器。新增「媒体」设置标签 |
| `src/renderer/styles.css` | 删掉按来源写死的颜色规则，颜色由注册表内联给出 |
| `tools/check-media-settings.js` | 媒体设置存盘再读回来，以及它变成 yt-dlp 参数 |

颜色从 CSS 类名改成注册表里的十六进制值，是为了让注册表成为唯一的一处。加一种来源不用再动样式表。

老任务的 `link` 没有 `kind` 字段，渲染进程的 `sourceId()` 认这种形状，按网盘算。

### 第三轮：媒体遇到登录问题不当失败

yt-dlp 报「Sign in to confirm you're not a bot」「Private video」这类错误时，之前是直接判失败。那不对，因为用户能解决。

现在这一类错误走 `needs-human`：任务停在「需登录」，卡片上给一个「打开站点窗口」按钮，程序在自己的窗口里打开那个站点；用户在窗口里登录完，cookie 留在应用会话里，点「继续」任务重跑一次。网盘那一套浏览器能力，这一路才算真正用上。

`Job.resume()` 多了一条 `needs-human` 分支。网盘的登录走的是「重新打开分享页」，所以这条分支只服务媒体。

顺带修了一个真缺陷：进度行还空着的任务，`every()` 在空数组上返回 true，于是被判成「已暂停」。现在改成 `length > 0 && every(...)`。
