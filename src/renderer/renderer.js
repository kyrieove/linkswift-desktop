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
    downloading: { label: '下载中', tone: 'busy' },
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
      text: '这个网盘需要登录后才能取直链。已打开本机 Chrome 浏览器，请在 Chrome 中登录网盘，登录完成后任务会自动继续。',
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
    'chrome-not-found': '未找到 Chrome',
    'link-invalid': '分享已失效',
    'file-missing': '文件不存在',
    'passcode-wrong': '提取码不对',
    'needs-transfer': '需要先转存',
    'rate-limited': '账号被限流',
    'extract-failed': '取链没弹出',
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
    autoSubmit: document.getElementById('auto-submit'),
    saveSettings: document.getElementById('save-settings'),
    testAria2: document.getElementById('test-aria2'),
    browseAria2Dir: document.getElementById('browse-aria2-dir'),
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
  let autoSubmit = false;

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
    if (state.phase === 'downloading') {
      const isWaiting =
        Array.isArray(state.progress) &&
        state.progress.length > 0 &&
        state.progress.every((p) => p.status === 'waiting');
      return isWaiting ? { label: '等待中', tone: 'busy' } : { label: '下载中', tone: 'busy' };
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
      // A file:// page without focus is refused the async API, so fall back to
      // the selection-based copy before telling the user it did not work.
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.top = '-1000px';
        area.style.opacity = '0';
        document.body.append(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return ok;
      } catch {
        return false;
      }
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
      phase === 'delivering' ||
      phase === 'downloading'
    );
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB'];
    let idx = 0;
    let val = bytes;
    while (val >= 1024 && idx < units.length - 1) {
      val /= 1024;
      idx++;
    }
    return (idx === 0 ? Math.round(val) : val.toFixed(1)) + ' ' + units[idx];
  }

  function formatSpeed(bytes) {
    return formatBytes(bytes) + '/s';
  }

  function formatEta(remaining, speed) {
    if (!speed || speed <= 0 || !remaining || remaining <= 0) return '--';
    const seconds = Math.round(remaining / speed);
    if (seconds < 60) return seconds + ' 秒';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return mins + ' 分 ' + (secs < 10 ? '0' : '') + secs + ' 秒';
  }

  function downloadCard(p) {
    const card = el('div', 'download-card');
    const row = el('div', 'download-card__row');
    const name = el('span', 'download-card__name', p.name || '（未命名文件）');
    name.title = p.name || '';
    const size = el(
      'span',
      'download-card__size mono',
      formatBytes(p.completedLength) + ' / ' + formatBytes(p.totalLength)
    );
    row.append(name, size);

    const pct =
      p.totalLength > 0 ? Math.min(100, (p.completedLength / p.totalLength) * 100) : 0;
    const track = el('div', 'track');
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-valuenow', pct.toFixed(1));
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');

    const fill = el('div', 'track__fill');
    fill.style.width = pct.toFixed(1) + '%';
    if (p.status === 'complete') fill.classList.add('track__fill--ok');
    if (p.status === 'error') fill.classList.add('track__fill--bad');
    track.append(fill);

    const metrics = el('div', 'download-card__metrics');
    const mPct = el('span', 'metric');
    const pctStrong = el('strong', 'mono metric__pct', pct.toFixed(1) + '%');
    if (p.status === 'complete') pctStrong.style.color = 'var(--tone-ok)';
    mPct.append(pctStrong);

    const divider1 = el('span', 'metric-divider', '·');

    const mSpeed = el('span', 'metric');
    mSpeed.append(
      el('span', 'metric__label', p.status === 'complete' ? '平均速度' : '速度'),
      el('span', 'mono metric__val', formatSpeed(p.downloadSpeed))
    );

    const divider2 = el('span', 'metric-divider', '·');

    const mEta = el('span', 'metric');
    const remaining = Math.max(0, p.totalLength - p.completedLength);
    mEta.append(
      el('span', 'metric__label', '剩余'),
      el(
        'span',
        'mono metric__val',
        p.status === 'complete' ? '已完成' : formatEta(remaining, p.downloadSpeed)
      )
    );

    const divider3 = el('span', 'metric-divider', '·');

    const mConn = el('span', 'metric');
    mConn.append(
      el('span', 'metric__label', '连接'),
      el('span', 'mono metric__val', String(p.connections || 0))
    );

    metrics.append(mPct, divider1, mSpeed, divider2, mEta, divider3, mConn);

    if (p.status === 'waiting') {
      const divider4 = el('span', 'metric-divider', '·');
      const mWait = el('span', 'metric');
      mWait.append(el('span', 'metric__label', '已推送 aria2，排队等待…'));
      metrics.append(divider4, mWait);
    } else if (p.status === 'complete') {
      const divider4 = el('span', 'metric-divider', '·');
      const mDone = el('span', 'metric');
      const mDoneText = el('span', 'metric__label', '下载完成');
      mDoneText.style.color = 'var(--tone-ok)';
      mDone.append(mDoneText);
      metrics.append(divider4, mDone);
    }

    card.append(row, track, metrics);
    return card;
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

  function diagnosisText(job) {
    const state = job.state || {};
    const link = job.link || {};
    return [
      'LinkSwift 诊断信息',
      '时间: ' + new Date().toISOString(),
      '任务: ' + job.id,
      '网盘: ' + (link.provider || '?') + ' / ' + (link.shareId || '?'),
      '提取码: ' + (link.passcode || '无'),
      '阶段: ' + (state.phase || '?'),
      '错误: ' + (state.code || '无') + ' ' + (state.message || ''),
      '',
      String(state.detail || '（没有技术细节）'),
    ].join('\n');
  }

  function diagnosisButton(job) {
    const btn = el('button', 'btn btn--sm btn--quiet', '复制诊断信息');
    btn.type = 'button';
    btn.dataset.focusKey = 'diagnosis:' + job.id;
    btn.addEventListener('click', async () => {
      const ok = await writeClipboard(diagnosisText(job));
      setNote(
        rowNote(btn),
        ok ? '诊断信息已复制。' : '复制失败，请展开技术细节手动复制。',
        ok ? 'ok' : 'error'
      );
    });
    return btn;
  }

  /**
   * The cap is on the account, not on the downloader. Say it in the card so a
   * slow baidu job reads as "this is the ceiling" instead of "the app broke".
   */
  function accountSpeedHint(job) {
    if (!job.link || job.link.provider !== 'baidu') return null;
    return el(
      'p',
      'job__hint',
      '百度按账号限速：免费账号实测 130 到 230 KiB/s，会员账号另有档位。同一个文件在夸克能到 4 MiB/s 级。'
    );
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
    } else if (state.phase === 'downloading') {
      const list = Array.isArray(state.progress) ? state.progress : [];
      if (!list.length) {
        body.append(el('p', 'job__text', '正在下载…'));
      } else {
        list.forEach((p) => body.append(downloadCard(p)));
      }
      const hint = accountSpeedHint(job);
      if (hint) body.append(hint);
    } else if (state.phase === 'needs-human') {
      const reason = HUMAN_REASONS[state.reason];
      body.append(
        el(
          'p',
          'job__message',
          reason ? reason.text : '需要你介入处理这个任务，原因：' + String(state.reason)
        )
      );
      if (state.reason !== 'login') {
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
      }
    } else if (state.phase === 'done') {
      if (Array.isArray(state.progress) && state.progress.length) {
        state.progress.forEach((p) => body.append(downloadCard(p)));
      }
      const files = Array.isArray(state.files) ? state.files : [];
      if (!files.length && (!state.progress || !state.progress.length)) {
        body.append(el('p', 'job__text', '任务完成，但没有返回文件。'));
      } else if (files.length) {
        const list = el('ul', 'files');
        files.forEach((file, index) => list.append(fileRow(file, job.id, index)));
        body.append(list);
      }
      const doneHint = accountSpeedHint(job);
      if (doneHint) body.append(doneHint);
    } else if (state.phase === 'failed') {
      if (Array.isArray(state.progress) && state.progress.length) {
        state.progress.forEach((p) => body.append(downloadCard(p)));
      }
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
      const actions = el('div', 'job__actions');
      actions.append(diagnosisButton(job));
      body.append(actions);
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

    // The host reads the link and the passcode out of the text, so hand it the
    // whole clipboard rather than a fragment that would drop the passcode.
    dom.input.value = text.trim();
    setNote(dom.composerError, '');
    setNote(dom.composerStatus, '');
    dom.input.focus();
    if (autoSubmit) submitLink();
  }

  /**
   * A paste is already an intent to submit, so the setting can skip the button.
   * The value lands after the event, hence the deferral.
   */
  function maybeAutoSubmitAfterPaste() {
    if (!autoSubmit) return;
    setTimeout(() => {
      if (dom.input.value.trim()) submitLink();
    }, 0);
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
    autoSubmit = Boolean(settings.autoSubmit);
    if (dom.autoSubmit) dom.autoSubmit.checked = autoSubmit;
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
      autoSubmit: dom.autoSubmit ? dom.autoSubmit.checked : false,
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
  dom.input.addEventListener('paste', maybeAutoSubmitAfterPaste);

  for (const radio of deliveryRadios) {
    radio.addEventListener('change', reflectDelivery);
  }

  dom.showToken.addEventListener('change', () => {
    dom.aria2Token.type = dom.showToken.checked ? 'text' : 'password';
  });

  dom.browseAria2Dir.addEventListener('click', async () => {
    setNote(dom.settingsError, '');
    dom.browseAria2Dir.disabled = true;
    dom.browseAria2Dir.textContent = '选择中…';
    try {
      const selected = await api.chooseDirectory();
      if (typeof selected === 'string' && selected) {
        dom.aria2Dir.value = selected;
        dom.aria2Dir.focus();
      }
    } catch (error) {
      setNote(dom.settingsError, '选择下载目录失败：' + describeError(error));
    } finally {
      dom.browseAria2Dir.disabled = false;
      dom.browseAria2Dir.textContent = '浏览…';
    }
  });
  dom.saveSettings.addEventListener('click', saveSettings);
  dom.testAria2.addEventListener('click', testAria2);

  window.addEventListener('focus', scheduleClipboardProbe);

  api.onJobEvent(handleJobEvent);
  window.__linkswift_dispatch_job__ = handleJobEvent;

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
