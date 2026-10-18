# unidownload-brand — 正式品牌资源与兼容的可见更名

## Goal
Unidownload 正式 U+下载箭头 SVG、透明 PNG、多尺寸 Windows ICO 可重建并用于应用和 renderer。保留旧数据、会话、上游归属和许可证。

## Risk
medium

## Parameters
- source docs/adr/0003-unidownload-brand-and-v3-ui.md and docs/design/unidownload-logo-concept.png: name Unidownload, deep green/mint U with negative space and downward arrow, no new slogan/Chinese name.
- SVG viewBox 0 0 256 256; transparent mark, app icon deep green rounded square and mint mark. PNG sizes 16,24,32,48,64,128,256,512. ICO PNG entries 16,24,32,48,64,128,256.
- Keep package name linkswift-desktop, app.getPath('userData'), persist:linkswift, IPC names, settings/jobs/aria2 paths, default download directory and lockfile identity unchanged. DO NOT add productName to package.json: node_modules/electron/electron.d.ts documents productName takes precedence as app name, which can change default userData. Change visible window/renderer/docs names only; no app.setName or setPath.
- Existing startup window remains 900×760/min720×520. Existing README and NOTICE retain hmjz100/LinkSwift attribution.

## Files
may change: `resources/brand/`, `tools/generate-brand.js`, `tools/check-brand.js`, `src/main/main.js`, `src/renderer/index.html`, `src/renderer/styles.css`, `README.md`
read-only: `package.json`, `src/main/store.js`, `src/main/task-store.js`, `src/main/aria2-daemon.js`, `src/shared/`, `src/preload/`, `LICENSE`, `NOTICE`, `docs/design/`

## Steps (N = 4)
1. Read concept image (available file inspection), ADR, final renderer and main.js/package.json. Author a real SVG U/arrow mark and app-icon SVG under resources/brand/, accurately preserving approved silhouette (two rounded U arms joined around downward arrow with negative-space channel) with flat deep green #233c2e and mint #d0efb5. Do not embed raster in SVG or use the old lightning bolt. Create tools/generate-brand.js that uses installed Electron hidden isolated BrowserWindow to rasterize SVG to transparent exact-size PNG files and builds Windows ICO directory and PNG image payloads with Node Buffer. No new dependency, no downloads. Keep all generator outputs in resources/brand/. Mark-only PNG and square app icon variants should have transparent corners/background as appropriate. Supply a simple brand README within resources/brand/ describing usage and regeneration command. Generator errors must fail, windows close in finally.
2. src/main/main.js sets BrowserWindow title Unidownload, local icon resources/brand/unidownload.ico and matching background color. package.json stays untouched to preserve default userData identity. Renderer index references mark SVG and favicon, title/accessible brand labels use Unidownload, CSS only minimal sizing if needed. Keep all renderer behavior unchanged. README title/user instructions use Unidownload and describe V3 task filters/details/settings/themes while keeping exact legacy path examples and explaining preservation for compatibility. Transfer authorization wording covers Baidu and Xunlei, experimental boundaries explicit. Preserve upstream script names/links and LICENSE/NOTICE untouched.
3. tools/check-brand.js verifies real SVG without raster embedding, all PNG signatures and IHDR dimensions, ICO directory sizes/offsets/payload bounds and expected entry count, visible name and main icon path, package.name remains linkswift-desktop, persistent partition and no app.setName or setPath userData changes. Using an Electron subprocess is allowed for generator; checker itself Node only, exits nonzero on failure. Run generator with Electron after clearing ELECTRON_RUN_AS_NODE using PowerShell or env -u. Inspect generated 16/24/32/256 PNGs visually if tool available; final visual acceptance is orchestrator's responsibility.
4. Syntax-check changed JS with node --check, run Check. Report resources and exact re-generation command. Do not run downloads or unrelated suites.

## Check
`node tools/check-brand.js`

## Don't
- No commits, no other files, no refactors beyond the steps.
- Run scripts in the foreground and wait; before replying, stop any background task still running.
- Reuse existing functions; don't copy existing logic.
- No rm, no git push, no git checkout . / restore . / reset --hard.
- No identity migration, storage move, package lock change, installer configuration or dependency addition.
- Use Write/Edit for file contents instead of large shell commands (Windows ENAMETOOLONG). Keep source readable with normal line breaks; do not minify.
