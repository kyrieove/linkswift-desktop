const { webFrame, ipcRenderer } = require('electron');

const injectionSource = `(() => {
  const r = {
    injectionRan: true,
    readyStateAtInject: document.readyState,
    pageOrderAtInject: (window.__order || []).slice(),
    typeofPageTokenBefore: typeof window.__PAGE_TOKEN,
    typeofUnsafeWindowBefore: typeof unsafeWindow,
    hasDocumentStartFlag: window.__documentStart === true,
  };
  if (typeof (unsafeWindow) === "undefined") window.unsafeWindow = window;
  r.unsafeWindowIsWindow = (unsafeWindow === window);
  r.factStatPwdId = unsafeWindow.factStat?.ut?.baseParams?.pwd_id;
  window.__probe = r;
  window.__order = window.__order || [];
  window.__order.push('injection');
  return r;
})()`;

webFrame.executeJavaScript(injectionSource).then(
  (result) => ipcRenderer.send('injection-result', { ok: true, result }),
  (error) => ipcRenderer.send('injection-result', { ok: false, error: String(error) })
);
