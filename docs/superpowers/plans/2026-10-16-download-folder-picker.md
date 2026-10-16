# Download Folder Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users choose the aria2 download directory with the native folder picker while keeping the path editable and saving only through the existing Save Settings button.

**Architecture:** Add a narrow `chooseDirectory` IPC action. The main process opens Electron's native directory-only dialog and returns the chosen path or `null` when cancelled. The renderer places a Browse button beside the directory input and copies a chosen path into the input without saving it.

**Tech Stack:** Electron dialog, contextBridge IPC, existing vanilla JavaScript renderer.

---

### Task 1: Add the directory-picker IPC action

**Files:**
- Modify: `src/shared/protocol.js`
- Modify: `src/main/ipc.js`
- Modify: `src/preload/renderer-preload.js`

- [ ] Add `chooseDirectory: 'linkswift:directory:choose'` to `INVOKE`.
- [ ] Import Electron `dialog` in `src/main/ipc.js` and register a handler that opens `dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })`; return `null` if cancelled, otherwise return the first selected path.
- [ ] Expose `chooseDirectory: () => ipcRenderer.invoke(INVOKE.chooseDirectory)` through the preload API.
- [ ] Run `node --check` on all three changed JavaScript files.

### Task 2: Add Browse control and renderer behavior

**Files:**
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/renderer.js`
- Modify: `src/renderer/styles.css`

- [ ] Put the existing `aria2-dir` input and a `浏览…` button in a compact horizontal control row, retaining the current hint below it.
- [ ] Add the button to the renderer DOM map and bind its click handler to `api.chooseDirectory()`.
- [ ] If the dialog returns a nonempty path, set `aria2Dir.value`; if it returns `null` or throws, leave the current value unchanged and show a concise settings error for failures.
- [ ] Add a small flex layout rule so the input takes remaining width and the button stays visible at narrow widths.
- [ ] Run `node --check src/renderer/renderer.js` and `git diff --check`.

### Task 3: Verify the user flow

**Files:**
- Verify: LinkSwift settings UI and existing settings persistence behavior.

- [ ] Open LinkSwift, expand Settings, and click `浏览…`.
- [ ] Choose a directory and confirm the selected path appears in the input without auto-saving.
- [ ] Click `保存设置`, restart or reload the settings view, and confirm the path remains saved.
- [ ] Cancel the directory picker and confirm the current input value remains unchanged.
