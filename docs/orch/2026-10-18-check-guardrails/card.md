# check-guardrails — 修正检查出口并接入自动验收

## Goal
LinkSwift 有单一 npm run check 入口；任一检查或 UI 断言失败均非零退出；Windows CI 自动运行现有检查。保留当前未验收 V3 改动，不替其声称通过。

## Risk
medium

## Parameters
- source package.json and tools/probe/probe-ui.js. Existing check:share-link/check:job/check:aria2/check:lifecycle/probe:ui must be reused, no parallel duplicate suite.
- A prior probe omitted daemon/tasks and returned exit 0 for errors. Current uncommitted V3 probe already adds Aria2Daemon, TaskStore and asserts: inspect and preserve, only repair remaining exit/report/cleanup holes.
- Existing V3 runner outcome out_of_scope because HANDOFF.md changed. This card does not approve or undo that change and does not accept the V3 card. Preserve other uncommitted UI/brand/design files.
- No production download, no cloud transfer, no app userData writes. All checks use local fixture/temp state. UI probe fixture events aren't real download evidence.
- Dependencies/lockfile/package name unchanged; remove ELECTRON_RUN_AS_NODE from child environment for Electron UI probe. Use process.execPath and argv, shell:false; do not construct nested shell command strings.

## Files
may change: `tools/run-checks.js`, `tools/probe/probe-ui.js`, `package.json`, `.github/workflows/check.yml`, `tools/check-runner.js`
read-only: `src/`, `HANDOFF.md`, `docs/design/`, `docs/adr/`, `package-lock.json`

## Steps (N = 4)
1. Apply karpathy-guidelines. Inspect package scripts and probe UI setup/finally/result code, not all production source. Add tools/run-checks.js to run syntax checks of src JS and existing share/job/aria2/lifecycle/UI scripts sequentially using child_process spawn argv with shell:false. Run Electron using installed electron executable require('electron') path after deleting ELECTRON_RUN_AS_NODE in child env. Fail fast with child name/exit code; spawn error or signal nonzero. Default npm run check executes all these current checks. No new dependency or package-lock edits. npm scripts reference Node launcher, so no PowerShell/Bash expansion.
2. Inspect current probe report behavior and ensure fatal errors, any failed assertion or renderer console error return nonzero even if report/finally errors happen; shutdown JobManager/daemon/windows in finally with bounded cleanup. Require a positive completion flag to return success, not report existence. Preserve current V3 assertions. Remove any use of a production window.__linkswift_dispatch_job__ test hook from the probe: inject fixture Job events through real PUSH only, without editing renderer. If an unrelated V3 failure is exposed, report exact assertion and don't weaken it or broaden into renderer fixes. Never modify or clear real user data.
3. Add .github/workflows/check.yml on push/pull_request using windows-latest, Node 22, actions/checkout@v4, actions/setup-node@v4, npm ci, npm run check; least contents:read permission and bounded job timeout. Add a focused tools/check-runner.js test proving launcher propagates a deliberately failing child and removes inherited ELECTRON_RUN_AS_NODE for Electron, without adding fake production commands or network calls. Prefer injectable execution helper exported by launcher guarded with require.main, rather than environment-selectable alternate test scripts. Wire this test into check so CI protects it.
4. Syntax-check changed JS. Run Check once and inspect actual JSON report plus child exits. Fix only within card scope; report any pre-existing V3 failures separately. Keep all fixtures identified as test data, and report exact commands/pass count and unavailable checks.

## Check
`node tools/run-checks.js`

## Don't
- No commits, no other files, no refactors beyond the steps.
- Run scripts in the foreground and wait; before replying, stop any background task still running.
- Reuse existing functions; don't copy existing logic.
- No rm, no git push, no git checkout . / restore . / reset --hard.
- Use Write/Edit for file bodies; no giant shell arguments. Read only necessary code and return compact results.

## Acceptance (draft)
- verdict: TODO (accepted / review pending / rejected)
- files: .github/workflows/check.yml, package.json, tools/check-runner.js, tools/probe/probe-ui.js, tools/run-checks.js
- check: `node tools/run-checks.js` → exit 0 (run by run-card)
- tokens:
  - round 1: exec custom-local:antigravity/gemini-3.8-flash: fresh 169k, cached 3711k, out 23k  (agy-linkswift-check-guardrails-20261018.jsonl) · review deepseek-v4.1-flash: fresh 33k, cached 700k, out 29k  (codex-review-linkswift-check-guardrails-20261018.jsonl)
- review findings: TODO N real / M false positive (scope S, card C, wrong W) / K missed (medium, deepseek-v4.1-flash)
