'use strict';

// Measure the layout fixes in the live renderer: drawer overlap, sidebar speed
// block reachability, dialog footer reachability, empty-state duplication.
//   node tools/probe/cdp-layout.js [port]

const port = process.argv[2] || process.env.CDP_PORT || '9223';

(async () => {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = pages.find((entry) => entry.url.includes('index.html'));
  if (!page) {
    console.error('renderer page not found');
    process.exit(2);
  }

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      id += 1;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data);
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    if (data.error) entry.reject(new Error(data.error.message));
    else entry.resolve(data.result);
  };

  const measure = `(() => {
    const q = (sel) => document.querySelector(sel);
    const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) }; };
    const drawer = q('#drawer');
    const row = q('.taskrow');
    const main = q('.taskmain');
    const speed = q('.speedbox');
    const sidebar = q('.sidebar');
    const emptyNodes = document.querySelectorAll('.empty, #jobs-empty').length;
    const visibleEmpty = Array.from(document.querySelectorAll('.empty, #jobs-empty')).filter((n) => n.offsetParent !== null && !n.hidden).length;
    if (sidebar) sidebar.scrollTop = 9999;
    const speedBox = box(speed);
    const sidebarBox = box(sidebar);
    const speedPinned = Boolean(speedBox && sidebarBox && speedBox.bottom <= sidebarBox.bottom + 1 && speedBox.h <= sidebarBox.h);
    return JSON.stringify({
      viewport: { w: innerWidth, h: innerHeight },
      docOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      drawerOpen: drawer ? !drawer.hidden : false,
      drawerBox: box(drawer),
      rowBox: box(row),
      mainBox: box(main),
      rowClippedByDrawer: Boolean(drawer && !drawer.hidden && row && box(row).x + box(row).w > box(drawer).x + 1),
      speedPinnedWithoutScroll: speedPinned,
      speedBox,
      sidebarBox,
      emptyNodes,
      visibleEmpty,
    });
  })()`;

  socket.onopen = async () => {
    try {
      const before = await send('Runtime.evaluate', { expression: measure, returnByValue: true });
      // Open the drawer, then measure again.
      await send('Runtime.evaluate', { expression: `document.querySelector('.taskrow') && document.querySelector('.taskrow').click(), 1`, returnByValue: true });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const after = await send('Runtime.evaluate', { expression: measure, returnByValue: true });
      // Dialog: open, measure footer against the dialog box, close.
      await send('Runtime.evaluate', { expression: `document.getElementById('new-task') && document.getElementById('new-task').click(), 1`, returnByValue: true });
      await new Promise((resolve) => setTimeout(resolve, 400));
      const dialog = await send('Runtime.evaluate', {
        expression: `(() => { const d = document.querySelector('dialog[open]'); if (!d) return JSON.stringify({ open: false }); const foot = d.querySelector('.dialogfoot'); const dr = d.getBoundingClientRect(); const fr = foot.getBoundingClientRect(); return JSON.stringify({ open: true, dialogBottom: Math.round(dr.bottom), footBottom: Math.round(fr.bottom), footInsideDialog: fr.bottom <= dr.bottom + 1, canReach: d.scrollHeight <= d.clientHeight + 1 || fr.bottom <= innerHeight }); })()`,
        returnByValue: true,
      });
      await send('Runtime.evaluate', { expression: `(() => { const d = document.querySelector('dialog[open]'); if (d) d.close(); return 1; })()`, returnByValue: true });

      console.log(JSON.stringify({
        closedDrawer: JSON.parse(before.result.value),
        openDrawer: JSON.parse(after.result.value),
        dialog: JSON.parse(dialog.result.value),
      }, null, 2));
      process.exit(0);
    } catch (err) {
      console.error('layout probe failed:', err.message);
      process.exit(1);
    }
  };
})();
