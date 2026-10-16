'use strict';

/**
 * Renderer for LinkSwift Desktop.
 *
 * The host injects window.linkswift before this script runs. When it is absent
 * (a plain browser preview, no Electron around it) the mock block at the very
 * bottom stands in, so the page always renders something real.
 */
(function () {
  if (!window.linkswift) installPreviewMock();

  const api = window.linkswift;

  const PROVIDER_LABELS = { quark: '夸克网盘', baidu: '百度网盘' };

  const DELIVERY_LABELS = { aria2: 'aria2', clipboard: '剪贴板', browser: '浏览器' };
  const DELIVERY_HINTS = {
    aria2: '取到直链后直接推给 aria2 RPC，由 aria2 开始下载。',
    clipboard: '取到直链后写入剪贴板，自己决定拿去干什么。',
    browser: '取到直链后交给系统默认浏览器下载。',
  };

  const PHASE_CHIPS = {
    loading: { label: '加载中', tone: 'busy' },
    'needs-human': { label: '需要你处理', tone: 'warn' },
    extracting: { label: '提取中', tone: 'busy' },
    delivering: { label: '推送中', tone: 'busy' },
    done: { label: '已完成', tone: 'ok' },
    failed: { label: '失败', tone: 'bad' },
  };

  const PHASE_TEXTS = {
    loading: '正在后台打开分享页面…',
    extracting: '正在驱动页面取直链…',
  };

  const HUMAN_REASONS = {
    login: {
      chip: '需登录',
      text: '这个网盘需要登录后才能取直链。点「打开窗口」登录一次，登录状态保存在本机，之后免登录。',
    },
    passcode: {
      chip: '需提取码',
      text: '这个分享需要提取码。点「打开窗口」在页面里填入，或把带 ?pwd= 的完整链接重新粘贴一次。',
    },
    captcha: {
      chip: '需验证码',
      text: '网盘弹出了验证码。点「打开窗口」在页面里完成验证，处理完任务会自动继续。',
    },
    'unknown-page': {
      chip: '页面异常',
      text: '页面结构与预期不符，可能是网盘或上游脚本改版。点「打开窗口」看页面实际内容。',
    },
  };

  const FAILURE_LABELS = {
    'upstream-redesigned': '上游改版',
    'unsupported-provider': '不支持的网盘',
    network: '网络错误',
    delivery: '推送失败',
    timeout: '超时',
    cancelled: '已取消',
    'no-files': '没取到文件',
  };

  // Only the host knows the full link grammar; this is just enough to decide
  // whether the clipboard is worth offering as a one-click paste.
  const SHARE_LINK_RE =
    /https?:\/\/[^\s"'<>()（）【】,，;；]*?(?:quark\.cn\/(?:s|share)\/|baidu\.com\/(?:s\/|share\/))[^\s"'<>()（）【】,，;；]*/i;

  const dom = {
    form: document.getElementById('submit-form'),
    input: document.getElementById('link-input'),
    pasteBtn: document.getElementById('paste-btn'),
    submitBtn: document.getElementById('submit-btn'),
    composerError: document.getElementById('composer-error'),
    composerStatus: document.getElementById('composer-status'),
    settings: document.getElementById('settings'),
    settingsSummary: document.getElementById('settings-summary'),
    deliveryHint: document.getElementById('delivery-hint'),
    aria2Domain: document.getElementById('aria2-domain'),
    aria2Port: document.getElementById('aria2-port'),
    aria2Path: document.getElementById('aria2-path'),
    aria2Token: document.getElementById('aria2-token'),
    aria2Dir: document.getElementById('aria2-dir'),
    showToken: document.getElementById('show-token'),
    allowTransfer: document.getElementById('allow-transfer'),
    saveSettings: document.getElementById('save-settings'),
    testAria2: document.getElementById('test-aria2'),
    aria2TestResult: document.getElementById('aria2-test-result'),
    settingsStatus: document.getElementById('settings-status'),
    settingsError: document.getElementById('settings-error'),
    jobList: document.getElementById('job-list'),
    jobsEmpty: document.getElementById('jobs-empty'),
    jobsCount: document.getElementById('jobs-count'),
    live: document.getElementById('live-region'),
  };

  const deliveryRadios = Array.prototype.slice.call(
    document.querySelectorAll('input[name="delivery"]')
  );

  // The job list is the only state kept here, exactly as the contract intends:
  // every event carries a full replacement job.
  const jobs = new Map();
  const jobOrder = [];
  const enteredJobs = new Set();
  let pendingJobId = null;
  let submitting = false;
  let saving = false;
  let testing = false;
  let clipboardProbeTimer = 0;

  /* ------------------------------------------------------------- helpers --- */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function describeError(err) {
    if (err && typeof err.message === 'string' && err.message) return err.message;
    return String(err);
  }

  function providerLabel(job) {
    const id = job.link && job.link.provider;
    return PROVIDER_LABELS[id] || (id ? String(id) : '未知网盘');
  }

  function chipInfo(job) {
    const state = job.state || {};
    if (state.phase === 'needs-human') {
      const reason = HUMAN_REASONS[state.reason];
      if (reason) return { label: reason.chip, tone: 'warn' };
    }
    // A cancel is a failure in the contract but not a fault the user should read
    // as an error.
    if (state.phase === 'failed' && state.code === 'cancelled') {
      return { label: '已取消', tone: 'busy' };
    }
    return (
      PHASE_CHIPS[state.phase] || {
        label: state.phase ? String(state.phase) : '未知状态',
        tone: 'busy',
      }
    );
  }

  function phaseChip(job) {
    const info = chipInfo(job);
    const chip = el('span', 'chip');
    chip.dataset.tone = info.tone;
    chip.append(el('span', 'chip__dot'), el('span', 'chip__label', info.label));
    return chip;
  }

  function announce(job) {
    dom.live.textContent =
      providerLabel(job) + ' ' + String(job.link && job.link.shareId) + '：' + chipInfo(job).label;
  }

  function setNote(node, text, tone) {
    if (tone === 'ok' || tone === 'error') {
      node.classList.toggle('note--ok', tone === 'ok');
      node.classList.toggle('note--error', tone === 'error');
    }
    if (text) {
      node.textContent = text;
      node.hidden = false;
    } else {
      node.textContent = '';
      node.hidden = true;
    }
  }

  function looksLikeShareLink(text) {
    return typeof text === 'string' && SHARE_LINK_RE.test(text);
  }

  async function writeClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission can be denied outright; the link stays on screen to copy by hand.
      return false;
    }
  }

  /* --------------------------------------------------------- job rendering --- */

  function copyFileButton(file) {
    const btn = el('button', 'btn btn--sm file__copy', '复制链接');
    btn.type = 'button';
    btn.dataset.focusKey = 'copy:' + String(file.name);
    btn.addEventListener('click', async () => {
      const ok = await writeClipboard(String(file.url || ''));
      const original = '复制链接';
      btn.textContent = ok ? '已复制' : '复制失败';
      btn.classList.toggle('btn--suggested', ok);
      setTimeout(() => {
        if (!btn.isConnected) return;
        btn.textContent = original;
        btn.classList.remove('btn--suggested');
      }, 1600);
    });
    return btn;
  }

  function fileRow(file, jobId, index) {
    const row = el('li', 'file');
    const main = el('div', 'file__main');
    main.append(el('span', 'file__name', file.name || '（未命名文件）'));

    const url = el('code', 'file__url', file.url || '');
    url.title = String(file.url || '');
    main.append(url);

    row.append(main, copyFileButton(file));

    const headers =
      file.headers && typeof file.headers === 'object' ? Object.entries(file.headers) : [];
    if (headers.length) {
      const details = el('details', 'detail file__headers');
      details.dataset.openKey = 'headers:' + jobId + ':' + index;
      details.append(el('summary', 'detail__summary', '请求头 ' + headers.length + ' 项'));
      const list = el('div', 'detail__list');
      for (const [key, value] of headers) {
        list.append(el('div', 'detail__kv', key + ': ' + value));
      }
      details.append(list);
      row.append(details);
    }

    return row;
  }

  function cancellable(phase) {
    return (
      phase === 'loading' ||
      phase === 'needs-human' ||
      phase === 'extracting' ||
      phase === 'delivering'
    );
  }

  function cancelButton(job) {
    const btn = el('button', 'btn btn--sm btn--quiet job__cancel', '取消');
    btn.type = 'button';
    btn.dataset.focusKey = 'cancel:' + job.id;
    btn.addEventListener('click', async () => {
      btn.setAttribute('aria-busy', 'true');
      btn.textContent = '取消中…';
      try {
        await api.cancel(job.id);
      } catch (err) {
        setNote(rowNote(btn), '取消失败：' + describeError(err));
      } finally {
        // On success the host sends a new state and this node is replaced; a
        // silent success or a failure must not leave the button stuck.
        if (btn.isConnected) {
          btn.removeAttribute('aria-busy');
          btn.textContent = '取消';
        }
      }
    });
    return btn;
  }

  function rowNote(fromNode) {
    const row = fromNode.closest('.job');
    return row ? row.querySelector('.job__note') : dom.composerError;
  }

  function jobBody(job) {
    const state = job.state || {};
    const body = el('div', 'job__body');

    if (state.phase === 'loading') {
      body.append(el('p', 'job__text', PHASE_TEXTS.loading));
    } else if (state.phase === 'extracting') {
      body.append(el('p', 'job__text', PHASE_TEXTS.extracting));
    } else if (state.phase === 'delivering') {
      const target = currentDelivery();
      body.append(
        el('p', 'job__text', '正在推送到' + (DELIVERY_LABELS[target] || target) + '…')
      );
    } else if (state.phase === 'needs-human') {
      const reason = HUMAN_REASONS[state.reason];
      body.append(
        el(
          'p',
          'job__message',
          reason ? reason.text : '需要你介入处理这个任务，原因：' + String(state.reason)
        )
      );
      const reveal = el('button', 'btn btn--sm btn--primary', '打开窗口');
      reveal.type = 'button';
      reveal.dataset.focusKey = 'reveal:' + job.id;
      reveal.addEventListener('click', async () => {
        reveal.setAttribute('aria-busy', 'true');
        try {
          await api.revealWindow(job.id);
        } catch (err) {
          setNote(rowNote(reveal), '打开窗口失败：' + describeError(err));
        } finally {
          if (reveal.isConnected) {
            reveal.removeAttribute('aria-busy');
          }
        }
      });
      const actions = el('div', 'job__actions');
      actions.append(reveal);
      body.append(actions);
    } else if (state.phase === 'done') {
      const files = Array.isArray(state.files) ? state.files : [];
      if (!files.length) {
        body.append(el('p', 'job__text', '任务完成，但没有返回文件。'));
      } else {
        const list = el('ul', 'files');
        files.forEach((file, index) => list.append(fileRow(file, job.id, index)));
        body.append(list);
      }
    } else if (state.phase === 'failed') {
      body.append(el('p', 'job__message', state.message || '任务失败。'));
      if (state.code) {
        const code = el('p', 'job__code', '错误类型：' + (FAILURE_LABELS[state.code] || state.code) + ' ');
        code.append(el('code', 'mono', String(state.code)));
        body.append(code);
      }
      if (state.detail) {
        const details = el('details', 'detail');
        details.dataset.openKey = 'detail:' + job.id;
        details.append(el('summary', 'detail__summary', '技术细节'));
        details.append(el('pre', 'detail__pre', String(state.detail)));
        body.append(details);
      }
    }

    if (state.phase === 'loading' || state.phase === 'extracting' || state.phase === 'delivering') {
      const bar = el('div', 'job__progress');
      bar.setAttribute('role', 'progressbar');
      bar.setAttribute('aria-label', chipInfo(job).label);
      bar.append(el('div', 'job__progress-bar'));
      body.append(bar);
    }

    return body;
  }

  function jobRow(job) {
    const row = el('li', 'job');
    row.dataset.jobId = String(job.id);
    if (!enteredJobs.has(job.id)) {
      enteredJobs.add(job.id);
      row.classList.add('job--enter');
      row.style.setProperty('--stagger', Math.min(jobOrder.indexOf(job.id), 4) * 30 + 'ms');
    }

    const head = el('div', 'job__head');
    head.append(el('span', 'job__provider', providerLabel(job)));

    const shareId = el('code', 'job__id', job.link ? job.link.shareId : '');
    shareId.title = job.link ? String(job.link.shareId) : '';
    head.append(shareId);

    if (job.link && job.link.passcode) {
      head.append(el('span', 'job__pwd', '提取码 ' + job.link.passcode));
    }

    head.append(phaseChip(job));

    const actions = el('div', 'job__actions');
    if (cancellable(job.state && job.state.phase)) actions.append(cancelButton(job));
    if (actions.childNodes.length) head.append(actions);

    row.append(head, jobBody(job), el('p', 'note note--error job__note', ''));
    row.querySelector('.job__note').hidden = true;
    return row;
  }

  /**
   * A job event rebuilds every row, so anything the user opened or focused in
   * the list is restored afterwards instead of snapping shut mid-task.
   */
  function captureListUiState() {
    const active = document.activeElement;
    const keyNode = active && active.closest ? active.closest('[data-focus-key]') : null;
    const open = [];
    for (const node of dom.jobList.querySelectorAll('details[data-open-key][open]')) {
      open.push(node.dataset.openKey);
    }
    return { focusKey: keyNode ? keyNode.dataset.focusKey : null, open: open };
  }

  function restoreListUiState(state) {
    for (const node of dom.jobList.querySelectorAll('details[data-open-key]')) {
      if (state.open.indexOf(node.dataset.openKey) !== -1) node.open = true;
    }
    if (!state.focusKey) return;
    const target = dom.jobList.querySelector(
      '[data-focus-key="' + CSS.escape(state.focusKey) + '"]'
    );
    if (target) target.focus();
  }

  function renderJobs() {
    const ui = captureListUiState();
    dom.jobList.textContent = '';
    for (const id of jobOrder) {
      const job = jobs.get(id);
      if (job) dom.jobList.append(jobRow(job));
    }
    dom.jobsEmpty.hidden = jobOrder.length > 0;
    dom.jobsCount.textContent = jobOrder.length ? jobOrder.length + ' 个任务' : '';
    restoreListUiState(ui);
  }

  function handleJobEvent(job) {
    // The event carries a whole Job, which is also what the preview mock emits.
    if (!job || typeof job !== 'object' || !job.id) return;
    const id = job.id;
    if (!jobs.has(id)) jobOrder.unshift(id);
    jobs.set(id, job);
    if (pendingJobId === id) {
      pendingJobId = null;
      setNote(dom.composerStatus, '');
    }
    renderJobs();
    announce(job);
  }

  /* -------------------------------------------------------------- composer --- */

  function submitBlocked() {
    return submitting;
  }

  async function submitLink() {
    if (submitBlocked()) return;
    const raw = dom.input.value.trim();
    setNote(dom.composerError, '');
    setNote(dom.composerStatus, '');

    if (!raw) {
      setNote(dom.composerError, '请先粘贴分享链接。');
      dom.input.focus();
      return;
    }
    if (!/^https?:\/\//i.test(raw)) {
      setNote(dom.composerError, '链接需要以 http:// 或 https:// 开头。');
      dom.input.focus();
      return;
    }

    submitting = true;
    dom.submitBtn.setAttribute('aria-busy', 'true');
    dom.submitBtn.textContent = '提交中…';
    try {
      const result = await api.submit(raw);
      if (result && result.ok) {
        dom.input.value = '';
        pendingJobId = result.jobId || null;
        setNote(dom.composerStatus, '已提交，正在打开分享页面…');
      } else {
        setNote(dom.composerError, (result && result.message) || '提交失败。');
      }
    } catch (err) {
      setNote(dom.composerError, '提交失败：' + describeError(err));
    } finally {
      submitting = false;
      dom.submitBtn.removeAttribute('aria-busy');
      dom.submitBtn.textContent = '提取直链';
      dom.input.focus();
    }
  }

  async function pasteFromClipboard() {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      setNote(dom.composerError, '读不到剪贴板，请用 Ctrl+V 手动粘贴。');
      dom.input.focus();
      return;
    }

    if (!looksLikeShareLink(text)) {
      setNote(dom.composerError, '剪贴板里不是夸克或百度的分享链接。');
      dom.input.focus();
      return;
    }

    const match = text.match(SHARE_LINK_RE);
    dom.input.value = (match ? match[0] : text).trim();
    setNote(dom.composerError, '');
    setNote(dom.composerStatus, '');
    dom.input.focus();
  }

  /**
   * Probing the clipboard needs no gesture, but permission is often denied
   * without one, so the button is always available and only its emphasis
   * depends on the probe.
   */
  async function probeClipboard() {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      return;
    }
    const suggested = looksLikeShareLink(text);
    dom.pasteBtn.classList.toggle('btn--suggested', suggested);
    dom.pasteBtn.textContent = suggested ? '粘贴剪贴板链接' : '粘贴';
    dom.pasteBtn.title = suggested ? '剪贴板里有分享链接' : '读取剪贴板';
  }

  function scheduleClipboardProbe() {
    clearTimeout(clipboardProbeTimer);
    clipboardProbeTimer = setTimeout(probeClipboard, 250);
  }

  /* -------------------------------------------------------------- settings --- */

  function currentDelivery() {
    const checked = deliveryRadios.find((radio) => radio.checked);
    return checked ? checked.value : 'aria2';
  }

  function reflectDelivery() {
    const target = currentDelivery();
    dom.deliveryHint.textContent = DELIVERY_HINTS[target] || '';
    dom.settingsSummary.textContent = '推送目标：' + (DELIVERY_LABELS[target] || target);
  }

  function setInputValue(input, value) {
    input.value = value === undefined || value === null ? '' : String(value);
  }

  function applySettings(settings) {
    if (!settings || typeof settings !== 'object') return;

    const delivery = DELIVERY_LABELS[settings.delivery] ? settings.delivery : 'aria2';
    for (const radio of deliveryRadios) radio.checked = radio.value === delivery;
    reflectDelivery();

    const aria2 = settings.aria2 && typeof settings.aria2 === 'object' ? settings.aria2 : {};
    setInputValue(dom.aria2Domain, aria2.domain);
    setInputValue(dom.aria2Port, aria2.port);
    setInputValue(dom.aria2Path, aria2.path);
    setInputValue(dom.aria2Token, aria2.token);
    setInputValue(dom.aria2Dir, aria2.dir);
    dom.allowTransfer.checked = Boolean(settings.allowTransfer);
  }

  async function loadSettings() {
    try {
      applySettings(await api.getSettings());
    } catch (err) {
      setNote(dom.settingsError, '读取设置失败：' + describeError(err));
      dom.settings.open = true;
    }
  }

  function readSettingsForm() {
    return {
      delivery: currentDelivery(),
      aria2: {
        domain: dom.aria2Domain.value.trim(),
        port: dom.aria2Port.value.trim(),
        path: dom.aria2Path.value.trim(),
        token: dom.aria2Token.value,
        dir: dom.aria2Dir.value.trim(),
      },
      allowTransfer: dom.allowTransfer.checked,
    };
  }

  async function saveSettings() {
    if (saving) return;
    setNote(dom.settingsError, '');
    setNote(dom.settingsStatus, '');

    const next = readSettingsForm();
    if (next.delivery === 'aria2' && !next.aria2.domain) {
      setNote(dom.settingsError, '推送目标为 aria2 时，地址不能为空。');
      dom.settings.open = true;
      dom.aria2Domain.focus();
      return;
    }

    saving = true;
    dom.saveSettings.setAttribute('aria-busy', 'true');
    dom.saveSettings.textContent = '保存中…';
    try {
      applySettings(await api.setSettings(next));
      setNote(dom.settingsStatus, '已保存');
      setTimeout(() => {
        if (!dom.settingsStatus.isConnected) return;
        setNote(dom.settingsStatus, '');
      }, 2400);
    } catch (err) {
      setNote(dom.settingsError, '保存失败：' + describeError(err));
    } finally {
      saving = false;
      dom.saveSettings.removeAttribute('aria-busy');
      dom.saveSettings.textContent = '保存设置';
    }
  }

  async function testAria2() {
    if (testing) return;
    setNote(dom.aria2TestResult, '');

    const config = readSettingsForm().aria2;
    if (!config.domain) {
      setNote(dom.aria2TestResult, '地址不能为空。', 'error');
      dom.aria2Domain.focus();
      return;
    }

    testing = true;
    dom.testAria2.setAttribute('aria-busy', 'true');
    dom.testAria2.textContent = '测试中…';
    try {
      const result = await api.testAria2(config);
      setNote(dom.aria2TestResult, result.message, result.ok ? 'ok' : 'error');
    } catch (err) {
      setNote(dom.aria2TestResult, '测试失败：' + describeError(err), 'error');
    } finally {
      testing = false;
      dom.testAria2.removeAttribute('aria-busy');
      dom.testAria2.textContent = '测试连接';
    }
  }

  /* ------------------------------------------------------------------ init --- */

  dom.form.addEventListener('submit', (event) => {
    event.preventDefault();
    submitLink();
  });

  dom.pasteBtn.addEventListener('click', pasteFromClipboard);

  for (const radio of deliveryRadios) {
    radio.addEventListener('change', reflectDelivery);
  }

  dom.showToken.addEventListener('change', () => {
    dom.aria2Token.type = dom.showToken.checked ? 'text' : 'password';
  });

  dom.saveSettings.addEventListener('click', saveSettings);
  dom.testAria2.addEventListener('click', testAria2);

  window.addEventListener('focus', scheduleClipboardProbe);

  api.onJobEvent(handleJobEvent);

  renderJobs();
  reflectDelivery();
  loadSettings();
  dom.input.focus();
  probeClipboard();

  /* ======================================================================
   * PREVIEW MOCK — delete this whole block once the host is always present.
   * Installed only when window.linkswift is missing, so the page renders
   * standalone in a browser. Every value below is demo data.
   * ==================================================================== */
  function installPreviewMock() {
    const demoJobs = new Map();
    const listeners = [];
    const cancelled = new Set();
    let seq = 0;

    let demoSettings = {
      delivery: 'aria2',
      aria2: { domain: 'http://localhost', port: '6800', path: '/jsonrpc', token: '', dir: '' },
      allowTransfer: false,
    };

    const demoFiles = [
      {
        name: '示例-讲座录像-2026.mp4',
        url: 'https://d.pcs.baidu.com/file/demo-0001?fid=1001&token=DEMO-TOKEN',
        headers: { 'User-Agent': 'pan.baidu.com', Referer: 'https://pan.baidu.com/' },
      },
      {
        name: '示例-讲义合集.zip',
        url: 'https://d.pcs.baidu.com/file/demo-0002?fid=1002&token=DEMO-TOKEN',
        headers: { 'User-Agent': 'pan.baidu.com' },
      },
    ];

    function emit(job) {
      for (const handler of listeners) handler(job);
    }

    function step(id, ms, state) {
      setTimeout(() => {
        const job = demoJobs.get(id);
        if (!job || cancelled.has(id)) return;
        job.state = state;
        emit(job);
      }, ms);
    }

    const demoNeedsHuman = {
      id: 'demo-needs-human',
      link: {
        raw: 'https://pan.quark.cn/s/demo1a2b3c',
        provider: 'quark',
        shareId: 'demo1a2b3c',
        passcode: null,
      },
      state: { phase: 'needs-human', reason: 'login' },
    };

    const demoDone = {
      id: 'demo-done',
      link: {
        raw: 'https://pan.baidu.com/s/1demoXyZ?pwd=8k2m',
        provider: 'baidu',
        shareId: '1demoXyZ',
        passcode: '8k2m',
      },
      state: { phase: 'done', files: demoFiles },
    };

    demoJobs.set(demoNeedsHuman.id, demoNeedsHuman);
    demoJobs.set(demoDone.id, demoDone);

    window.linkswift = {
      submit(raw) {
        const text = String(raw || '').trim();
        if (!/^https?:\/\//i.test(text)) {
          return Promise.resolve({ ok: false, message: '链接需要以 http:// 或 https:// 开头。' });
        }
        seq += 1;
        const id = 'demo-job-' + seq;
        const job = {
          id: id,
          link: { raw: text, provider: 'quark', shareId: 'demo' + seq + 'x9k2', passcode: null },
          state: { phase: 'loading' },
        };
        demoJobs.set(id, job);
        emit(job);
        step(id, 900, { phase: 'extracting' });
        step(id, 2000, { phase: 'delivering' });
        step(id, 3200, { phase: 'done', files: demoFiles });
        return Promise.resolve({ ok: true, jobId: id });
      },
      cancel(jobId) {
        cancelled.add(jobId);
        const job = demoJobs.get(jobId);
        if (job) {
          job.state = { phase: 'failed', code: 'cancelled', message: '任务已取消。' };
          emit(job);
        }
        return Promise.resolve();
      },
      getSettings() {
        return Promise.resolve(JSON.parse(JSON.stringify(demoSettings)));
      },
      setSettings(settings) {
        demoSettings = JSON.parse(JSON.stringify(settings));
        return Promise.resolve(JSON.parse(JSON.stringify(demoSettings)));
      },
      testAria2(config) {
        if (!config || !config.domain) {
          return Promise.resolve({ ok: false, message: '地址不能为空。' });
        }
        return Promise.resolve({ ok: true, message: '连上了，aria2 1.37.0（预览数据）' });
      },
      revealWindow(jobId) {
        const job = demoJobs.get(jobId);
        if (job && job.state.phase === 'needs-human') {
          job.state = { phase: 'extracting' };
          emit(job);
          step(jobId, 1400, { phase: 'done', files: demoFiles });
        }
        return Promise.resolve();
      },
      onJobEvent(handler) {
        listeners.push(handler);
        setTimeout(() => {
          for (const job of demoJobs.values()) emit(job);
        }, 150);
      },
    };
  }
})();
