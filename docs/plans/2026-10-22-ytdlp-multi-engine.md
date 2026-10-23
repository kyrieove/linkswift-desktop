# 实施计划：多来源多引擎（接入 yt-dlp）

日期：2026-10-22
决策依据：`docs/adr/0004-multi-engine-and-yt-dlp.md`
状态：已实施。来源联合类型、引擎抽象、yt-dlp 引擎、媒体与直链分支、注册表驱动的界面、媒体设置页都已落地。
还没做的：ffmpeg 打包、媒体用 aria2 加速、每条任务单独选画质、播放列表的部分失败。

---

## 分期原则

每一期结束时 `npm run check` 必须全绿，且行为只增不减。拆期的依据是**风险从高到低**：先把纯重构做完（第二期），再接外部进程（第三期），最后才动界面（第五期）。这样一旦外部进程方案出问题，回滚成本只有一期。

## 第 0 期：定协议（不写实现）

产出：`src/shared/protocol.js` 里新增类型，改动只涉及 typedef 与常量。

- `SourceKind` = `'netdisk' | 'media' | 'direct'`
- `Source` 联合类型（ADR 第 1 节）
- `EngineId` = `'aria2' | 'yt-dlp'`
- `DownloadProgress` 加 `engine` 字段，`gid` 变可选
- `JobPhase` 不动。现有九个阶段对媒体同样成立：`loading`（进程已起）→ `extracting`（yt-dlp 正在解析）→ `linked`（`before_dl` 到了，拿到文件名与目标）→ `downloading`（进度行到了）→ `done` / `failed`；`needs-human` 用于登录与验证码。
- 新增 `FailureCode`：`media-unsupported`（yt-dlp 报 Unsupported URL）、`media-auth`（需要登录）、`media-geo`（地域限制）、`media-merge`（ffmpeg 缺失导致合并失败）、`media-tool-missing`（找不到 yt-dlp 或 ffmpeg）。

验收：`node --check src/shared/protocol.js` 通过；旧 `jobs.json` 仍能读。

## 第 1 期：来源注册表

产出：`src/shared/sources.js`，`src/shared/providers.js` 退成网盘配方表。

- `sources.js` 导出 `SOURCES`（网盘四家 + `media` + `direct`），每条含 `id` / `label` / `kind` / `matches(url)` / `parse(url)` / `capability` / `experimental` / `color`。
- `media` 的 `matches` 判定：URL 有 `http(s)` 协议，且不在四个网盘域名里，且看起来像页面地址（无扩展名，或扩展名不是常见媒体/压缩/文档类型）。**判定宁可宽不可窄**，判错的代价是 yt-dlp 自己报 Unsupported URL，比我们提前拒绝更可诊断。
- `direct` 的 `matches`：URL 有 http(s) 协议且路径有常见文件扩展名。
- 两者都排在网盘之后判定，网盘优先。
- `parse` 对 `media` / `direct` 返回 `{target: url}`。
- `providers.js` 保留 `steps` / `transferSteps` / `driveUrl` / `loginKind` / `authenticatedHosts` 等网盘专属字段，`sources.js` 通过 `netdisk:` 字段挂上去。
- `parseShareLinks` 改成遍历 `SOURCES`，逐条匹配，返回带 `kind` 的 `Source`。

新增检查 `tools/check-source-parse.js`：

- 夸克 / 百度 / UC / 迅雷分享链接仍解析出网盘来源。
- `https://www.youtube.com/watch?v=xxx` 解析成 `media`。
- `https://example.com/a/b.zip` 解析成 `direct`。
- 一段混合粘贴里三条分别落成三种来源，且坏的一条只影响自己。
- 四种网盘的老用例一条不能退化（现在 `check:share-link` 的断言全部保留）。

## 第 2 期：引擎抽象（纯重构）

产出：`src/main/engines/aria2-engine.js`、`src/main/engines/index.js`，`src/main/job.js` 里的 `aria2.*` 调用全部换成 `engine.*`。

这一期不引入 yt-dlp，只把现有 aria2 调用包起来，让 `Job` 不再直接知道 aria2。

- `Engine` 接口按 ADR 第 2 节。aria2 实现把现有的 `addUri` / `tellStatus` / `pause` / `unpause` / `remove` / `findGid` 一对一搬过去，不改行为。
- `Job.startPolling` 改成问 `engine.progress(run)`，拿到的仍是 `DownloadProgress[]`。
- `Job.pause` / `resume` / `cancel` 改成调 `engine.pause(run)` 等。
- `JobManager.deliver` 继续按 `settings.delivery` 分派，`aria2` 分支改成调 aria2 引擎。
- 持久化：`gids` 改 `runs`，元素 `{file, runId, engine}`。`src/main/task-store.js` 读的时候兼容老 `gids`，映射成 `{runId: gid, engine:'aria2'}`。`JobManager.restore` 按 `engine` 走对应引擎重新挂接。

验收：`npm run check` 全绿，`check:lifecycle` 仍然能跑完「暂停 → 退出 → 重启接着下 → 字节一致」。这是本期唯一真正的验收，其他都靠现有检查兜住。

## 第 3 期：yt-dlp 引擎

产出：`src/main/engines/ytdlp-engine.js`、`src/main/media-format.js`、`src/main/ytdlp-source.js`。

### 3a. 二进管理（`ytdlp-source.js`）

照抄 `src/main/userscript.js` 的结构：

- 查找顺序：`resources/ytdlp/yt-dlp.exe` → 设置里的自定义路径 → PATH 里的 `yt-dlp`。
- 启动时调 `--version` 记下版本号，缓存到 `ytdlp-local.json`。
- 自更新：调发行版 API 比版本 → 下载 `yt-dlp.exe` → 校验 `SHA2-256SUMS` → 换文件。**不调 `-U`**。频道 `stable` / `nightly` / `master`，默认 `stable`，设置页可改。
- 找不到二进制时不算「任务失败」，而是引擎 `status()` 报 `missing`，界面显示「未找到 yt-dlp，请在设置里指定路径」。

### 3b. 参数拼装（`buildArgs`）

照 `src/main/aria2.js` 的 `buildAddUriOptions` 写法，做成纯函数便于检查。

固定参数：

```
--ignore-config          用户机器上的 yt-dlp 配置文件不参与，保证行为确定
--no-color
--no-update               压掉 90 天过期提醒
--newline
--no-progress             进度只走 --progress-template
--no-warnings
--continue                .part 续传
--no-simulate             --print 的隐含 simulate 要显式关掉
--print "before_dl:..."   解析完成信号
--print "after_move:..."  最终文件路径
--progress-template "download:PROGRESS\t..."
-o "<dir>/%(title)s [%(id)s].%(ext)s"
```

条件参数：`--cookies <file>`（有 session cookie 时）、`--ffmpeg-location <path>`、`--format`、`--extract-audio` / `--audio-format`、`--embed-thumbnail` / `--embed-metadata`、`--write-subs` / `--sub-langs`、`--merge-output-format`、`--playlist-items`、`--no-playlist`。

**永远不加**：`--exec`、`--compat-options allow-unsafe-ext`、`--compat-options allow-unsafe-exec-expansion`、`--downloader aria2c`。

新增检查 `tools/check-ytdlp-args.js`：

- 断言固定参数齐全。
- 断言 `--exec` 与两个 unsafe compat 选项在任何输入下都不出现。
- 断言 `-o` 永远是显式绝对路径模板，不含 `%(id)s` 作为唯一名字（通用解析器会把签名 URL 当 id）。
- 断言含空格与中文的标题不会拼出裸命令（参数以数组传递，不走 shell）。
- 断言媒体选项关闭时后处理参数不出现，打开时对应参数出现。

### 3c. 进度解析

按 ADR 第 4 节的制表符方案。

- 一行以 `PROGRESS\t` 开头，其余按 `\t` 切分。
- 字段顺序固定：`status` / `downloaded_bytes` / `total_bytes` / `total_bytes_estimate` / `speed` / `eta` / `filename`。
- 值为 `NA` 一律转 null；空串转 null。
- `status` 为 `finished` 时置完成；`error` 时取 stderr 里的错误文本。
- `filename` 是 yt-dlp 写出的绝对路径，用它当进度行的身份标识（`runId`）。

新增检查 `tools/check-ytdlp-progress.js`：把本次实测抓到的真实 stdout 行喂进去，断言解析出的字节数、速度、eta、状态、路径都对。路径断言要覆盖带空格与中文的目录。

### 3d. 错误分类

按 stderr 文本映射到 `FailureCode` 与 `needs-human`：

| stderr 特征 | 结果 |
| --- | --- |
| `Sign in to confirm you're not a bot` / `Private video` / `members-only` / `This live event will begin` | `needs-human`，reason `login` |
| `geo-restricted` / `not available in your country` | `failed`，`media-geo`，提示要代理 |
| `Unsupported URL` | `failed`，`media-unsupported` |
| `Requested format is not available` | `failed`，`media-unsupported`，提示换画质 |
| `HTTP Error 429` | `failed`，`rate-limited` |
| `ffmpeg` 相关（`ffprobe` / `Unable to merge`） | `failed`，`media-merge`，提示装 ffmpeg |
| 找不到 yt-dlp | 引擎 `status()` 报 `missing`，不进入任务 |

新增检查 `tools/check-ytdlp-errors.js`：每条特征一句断言。

### 3e. 端到端（`tools/probe/check-ytdlp-lifecycle.js`）

照 `tools/probe/check-aria2-lifecycle.js` 的写法：起一个本机慢速 HTTP 服务，用它提供的字节做媒体文件，**不联网**，断言：

- 进度行被正确解析，字节数单调递增到总长。
- 暂停（杀进程）后 `.part` 留在原地。
- 续传（带 `--continue` 重启）最终字节与源文件逐字节一致。
- 取消后 `.part` 被清理。

这一步是本期的真正验收。它证明的是「媒体这一路能像网盘那一路一样暂停、续传、取消」，而不是「yt-dlp 能下载」。

## 第 4 期：媒体来源进主流程

- `JobManager.submit` 接到 `kind:'media'` 的 `Source` 时不起隐藏窗口，直接进 `Job.startMedia()`。
- `Job` 的媒体分支：`loading` → 起 yt-dlp 进程 → `extracting` → 收到 `before_dl` → `linked` → 收到第一行进度 → `downloading` → 进程退出码 0 → `done`。
- `needs-human` 复用现成机制：`revealWindow` 在应用自己的窗口打开媒体页让用户过验证，用户确认后把 session cookie 导出成 Netscape 文件重跑。
- `direct` 来源走 aria2 引擎，文件名从 URL 取，必须过 `aria2.validateExtractedFile` 那道文件名闸（现在这个闸在 `src/main/aria2.js:86`，要提到 `src/shared/filename.js` 给两条路共用）。
- 播放列表：`media` 来源默认 `--no-playlist`；用户显式要整个列表时才放开，并按条目建多条子任务。

## 第 5 期：界面去硬编码

- 新增 `INVOKE.sources` 通道，返回注册表的可序列化视图。
- 渲染进程删掉 `PROVIDER_LABELS`、`PROVIDER_LOGIN`、`PROVIDER_CAPABILITY` 三张表，改从注册表取。
- 侧栏来源按钮（`index.html:17`）、侧栏计数（`renderer.js:614`）、来源页（`renderer.js:1748`）、能力表（`renderer.js:537`）全部改成数据驱动。
- `renderer.js:775` 那个「缺省落回 quark」的写法必须删掉，缺省要显示成「未知来源」。
- 色点颜色改成注册表里的 `color` 字段驱动，不再靠 `.quark` / `.baidu` 这类硬编码 class。
- 设置页加「媒体」标签页：格式、画质、后处理开关、ffmpeg 路径、yt-dlp 路径、更新频道。
- 任务卡新增媒体专属信息：标题、时长、来源站点、最终文件名。

验收：`probe:ui` 增加断言，来源清单来自注册表而非硬编码。

## 第 6 期：分发与文档

- `resources/ytdlp/yt-dlp.exe`（17,880,111 字节，sha256 `33121d192d706e62f684a06f80918e3f3a8ba52ac3a65213b6951c39c7d9f555`，取 2026.10.21）+ `resources/ytdlp/THIRD_PARTY_LICENSES.txt` 入库。
- `NOTICE` 追加 yt-dlp 上游署名、Unlicense 说明、以及 PyInstaller 二进制为 GPLv3+ 的说明，与 aria2 那条同格式。
- `README.md` 加「媒体下载」一节，写清 ffmpeg 依赖与「未检测到 ffmpeg 时哪些功能不可用」。
- `DESIGN.md` 加第 12 节，把来源联合类型、引擎接口、进度通道三件事写进去。

## 不在本期范围

- 媒体走 aria2 加速（先 `-J` 探测单条渐进式直链再交给 aria2）。
- ffmpeg 打包进发行版。
- 格式选择的图形界面（先做设置里的默认值 + 任务级的覆盖）。
- 字幕翻译、章节切分、SponsorBlock。

---

## 每期都要跑的检查

```
npm run check
```

新增的检查脚本必须同时加进 `package.json` 的 `scripts` 和 `tools/run-checks.js` 的 `SCRIPT_STEPS`，否则 `npm run check` 不会执行它，而 `tools/run-checks.js` 的注释写明了这一点是有意为之。
