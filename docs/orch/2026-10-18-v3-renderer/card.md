# v3-renderer — 将已批准 V3 接到真实 Electron 任务

## Goal
生产 renderer 使用 docs/design/gopeed-ui-v3.html 的深绿薄荷 V3 布局，全部交互来自 window.linkswift 真实接口，保留旧任务和设置能力。900×760 与 720×520 可用。UI 探针以断言失败退出，不能只生成报告便声称成功。

## Risk
medium

## Parameters
- source: docs/adr/0003-unidownload-brand-and-v3-ui.md、docs/plans/2026-10-18-unidownload-ui-implementation.md、src/preload/renderer-preload.js、src/shared/protocol.js。
- window 900×760 / minimum 720×520 (source src/main/main.js); visual reference is approved but production fit is unverified until probe.
- Keep window.linkswift bridge, link parser in host, all 10 phases, failed+cancelled, allowTransfer default false, all three delivery targets and both aria2 modes.
- Four providers: quark, baidu, uc, xunlei; UC/Xunlei stay experimental in shared code. Theme persisted only in renderer localStorage, no settings schema change.
- Internal application identity, storage, partitions, upstream files and dependencies remain unchanged. Visible product name Unidownload; no new Chinese name or slogan.

## Files
may change: `src/renderer/index.html`, `src/renderer/styles.css`, `src/renderer/renderer.js`, `tools/probe/probe-ui.js`
read-only: `src/preload/`, `src/shared/`, `docs/design/`, `docs/adr/`, `docs/plans/`, `src/main/`

## Steps (N = 5)
1. Read the approved V3 HTML and relevant production renderer functions and preload. Apply C:/Users/ASUS/.codex/skills/karpathy-guidelines/SKILL.md. Preserve existing settings functions, submission of complete raw share text, clipboard handling, button factories, safe el/textContent rendering, file/request-header/diagnosis helpers. No framework or dependency. Remove preview auto mock from production renderer: without bridge show host-unavailable, no seeded fake jobs. Read-only reconnaissance commands rg/Get-Content are allowed.
2. index.html/styles.css: implement native rail with tasks/sources/settings navigation, status and four-provider sidebar with counts, task toolbar search/sort/create and batch pause, task list, right detail drawer, footer true aggregate download speed and engine/directory, independent settings page and native dialog composer. Match approved reference spacing, light/dark tokens and border treatment, no file-type icon column. Use compact layout and drawer overlay at minimum width; no horizontal page overflow at 720×520. Keep existing form/settings IDs where possible, including job-list, jobs-empty, jobs-count, submit-form, link-input. Accessible names, keyboard focus, Escape to close, Ctrl+K search, native checkbox selection and visible focus required. No fake titlebar window controls.
3. renderer.js: add local view state {page, phaseFilter, providerFilter, query, sort, selectedIds, detailId, theme}. Job map remains host-owned replacement data. Keep filters composable, counts based on actual jobs, stable newest/oldest/name sorting. Compact task rows show file/task name, provider, real phase and aggregate progress; detailed content from existing jobBody/file helpers goes in drawer with overview/files/diagnosis tabs, preserving open details, focus and scroll across push events. Explicit open-details button and row keyboard access. Batch pause/resume/cancel calls existing APIs only for eligible selected jobs, isolates errors per job and reports partial failures. No delete/clear unsupported API. Human action uses real login/reveal/continueAfterLogin; transfer opens settings and focuses global allow-transfer; manual Xunlei says select files in 我的云盘 and use 下载助手→Aria2下载→推送, never offers fake continue. Done without complete download progress says 已复制链接/已交给浏览器/已投递 and does not imply local completed bytes. Settings retain RPC full fields, directory chooser/open, test/restart, auto-submit and global Baidu/Xunlei transfer authorization. Draft settings must not mislabel historical task delivery; use job state metadata if present, otherwise neutral 已投递. No chart of invented speed. Empty/filter-empty states, long hostile names and errors via textContent. If new task has no per-task settings API, use saved global settings rather than inventing per-task options.
4. tools/probe/probe-ui.js: fix existing missing daemon by creating Aria2Daemon with isolated temporary userData and bundled binary, starting it and passing it to JobManager; shut down jobs/daemon and windows in finally. Use assert for bridge surface, empty real-host list, true settings roundtrip, invalid link rejection, real submit/cancel IPC and DOM event rendering. Add clearly labeled fixture Job events via real PUSH (fixtures only in probe) to exercise all phases/reasons/four providers, aggregate multi-file progress, cancelled label, clipboard/browser done wording, escaped hostile filename/error, search/provider/status composition, sorting, selection partial-failure feedback via real host refusal where possible, drawer state on update, settings controls and global transfer consent not defaulted on, Xunlei login/transfer/manual actions. Assert absence of fake manual continue. Check 900×760 and 720×520 light/dark with drawer open, no horizontal page overflow, keyboard close/focus. Persist report and screenshots only under os.tmpdir(), clearly distinguish fixtures from real network result. Any failed assertion or console error must exit nonzero. Avoid an uncontrolled remote good-share probe lasting beyond existing 2500ms: cancel created job in finally. Existing probe uses a dummy share ID and is not a real download acceptance.
5. Syntax self-check changed JS with node --check. Run the Check in foreground, read the JSON report from temp, and fix failures within allowed files. Report files, assertion count, screenshot paths and unverified real-download scenarios. Do not run other suites; orchestrator will run them.

## Check
`powershell -NoProfile -Command "$env:ELECTRON_RUN_AS_NODE = $null; npm run probe:ui; exit $LASTEXITCODE"`

## Don't
- No commits, no other files, no refactors beyond the steps.
- Run scripts in the foreground and wait; before replying, stop any background task still running.
- Reuse existing functions; don't copy existing logic.
- No rm, no git push, no git checkout . / restore . / reset --hard.
- Preserve existing untracked designs and HANDOFF.md; probe-readme.md and start-linkswift.bat are unrelated user files.
- This is fixed orchestrate-codex mode: implementation by agy and independent read-only review by wb.
