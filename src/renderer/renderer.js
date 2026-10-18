'use strict';

/**
 * Production Renderer for Unidownload (V3 layout).
 * Driven entirely by window.linkswift.
 */
(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  const api = window.linkswift;

  if (!api) {
    document.addEventListener('DOMContentLoaded', () => {
      const rows = $('#rows');
      if (rows) {
        rows.replaceChildren();
        const empty = el('div', 'empty');
        empty.append(
          icon('alert'),
          el('h3', '', '主进程未连接'),
          el('p', '', '未检测到应用接口桥（window.linkswift），请在应用内运行。')
        );
        rows.append(empty);
      }
      const emptyNode = $('#jobs-empty');
      if (emptyNode) emptyNode.hidden = true;
    });
    return;
  }

  const PROVIDER_LABELS = {
    quark: '夸克网盘',
    baidu: '百度网盘',
    uc: 'UC 网盘',
    xunlei: '迅雷云盘',
  };

  const DELIVERY_LABELS = {
    aria2: 'aria2 下载',
    clipboard: '复制直链',
    browser: '浏览器下载',
  };

  const DELIVERY_HINTS = {
    aria2: '取到直链后直接推给 aria2 RPC，由 aria2 开始下载。',
    clipboard: '取到直链后写入剪贴板，自己决定拿去干什么。',
    browser: '取到直链后交给系统默认浏览器下载。',
  };

  const MODE_HINTS = {
    builtin: '软件自带 aria2，打开就启动，下载目录可改。退出时会记住进度，下次打开接着下。',
    external: '用你自己跑着的 aria2 / Motrix / AriaNg，填它的 RPC 地址与令牌。',
  };

  const PROVIDER_LOGIN = { quark: 'cookie', baidu: 'cookie', uc: 'cookie', xunlei: 'window' };

  const STATES = {
    loading: ['解析中', 'refresh'],
    extracting: ['解析中', 'refresh'],
    'needs-human': ['需处理', 'shield'],
    linked: ['已拿到直链', 'link'],
    delivering: ['推送到下载器', 'refresh'],
    downloading: ['下载中', 'download'],
    paused: ['已暂停', 'pause'],
    done: ['已完成', 'check'],
    failed: ['下载失败', 'alert'],
  };

  const FILTER_DEFS = [
    ['all', '全部任务', 'grid'],
    ['active', '进行中', 'download'],
    ['paused', '已暂停', 'pause'],
    ['human', '待处理', 'clock'],
    ['done', '已完成', 'check'],
    ['failed', '失败 / 取消', 'alert'],
  ];

  const FAILURE_LABELS = {
    'upstream-redesigned': '上游改版',
    'unsupported-provider': '不支持的网盘',
    network: '网络中断',
    delivery: '下载失败',
    timeout: '超时',
    cancelled: '已取消',
    'no-files': '没取到文件',
    'chrome-not-found': '未找到 Chrome',
    'link-invalid': '分享已失效',
    'link-expired': '直链已过期',
    'file-missing': '文件不存在',
    'passcode-wrong': '提取码不对',
    'needs-transfer': '需要先转存',
    'rate-limited': '账号被限流',
    'extract-failed': '取链没弹出',
    'aria2-down': '下载器没启动',
  };

  // Local view state
  const viewState = {
    page: 'tasks',
    phaseFilter: 'all',
    providerFilter: null,
    query: '',
    sort: 'new', // 'new' | 'old' | 'name'
    selectedIds: new Set(),
    detailId: null,
    detailTab: 'overview', // 'overview' | 'files' | 'logs'
    archiveView: false, // footer toggle: show archived rows instead of the live list
    theme: localStorage.getItem('unidownload_theme') || 'light',
  };

  // Host-owned replacement data
  const jobs = new Map();
  const jobOrder = [];
  let lastListKey = null;
  let toastTimer = null;
  let submitting = false;
  let saving = false;
  let testing = false;
  /** Set when the last submit came back with duplicates only, so the toast can say so. */
  let providerHealth = [];
  let currentSettings = {
    delivery: 'aria2',
    aria2Mode: 'builtin',
    aria2: { domain: 'http://127.0.0.1', port: '6800', path: '/jsonrpc', token: '', dir: '' },
    allowTransfer: false,
    autoSubmit: false,
    archiveLimit: 500,
  };

  /* ---------------------------------------------------------------- Status vocabulary --- */

  /**
   * One row per state the user has to tell apart, so a label and its sentence can
   * never drift apart. `tone` picks the colour token styles.css defines.
   */
  const STATUS_TEXT = {
    downloading: { label: '下载中', tone: 'downloading' },
    paused: { label: '已暂停', tone: 'idle' },
    'needs-human': { label: '需你操作一步', tone: 'human' },
    failed: { label: '已失败', tone: 'failed' },
    done: { label: '已完成', tone: 'done' },
    partial: { label: '部分完成', tone: 'failed' },
    archived: { label: '已归档', tone: 'idle' },
  };

  /** A partial download is a `done` job whose per-file progress still holds an error. */
  function isPartial(job) {
    const state = (job && job.state) || {};
    if (state.phase !== 'done' || !Array.isArray(state.progress)) return false;
    return state.progress.some((item) => item.status === 'error');
  }

  function partialCounts(job) {
    const progress = (job && job.state && job.state.progress) || [];
    const failed = progress.filter((item) => item.status === 'error').length;
    return { failed, completed: progress.length - failed, total: progress.length };
  }

  function statusKey(job) {
    const phase = (job && job.state && job.state.phase) || 'loading';
    if (phase === 'done') return isPartial(job) ? 'partial' : 'done';
    if (!STATUS_TEXT[phase]) return 'paused';
    return phase;
  }

  function isArchived(job) {
    return Boolean(job && job.archivedAt);
  }

  /* ---------------------------------------------------------------- DOM & Icons --- */

  function icon(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '#i-' + name);
    svg.append(use);
    return svg;
  }

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function btn(label, name, handler, cls = 'iconbtn') {
    const b = el('button', cls);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    if (name) b.append(icon(name));
    if (cls.includes('button')) b.append(document.createTextNode(label));
    if (handler) b.onclick = handler;
    return b;
  }

  function notify(msg) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.textContent = '';
    }, 3600);
  }

  function describeError(err) {
    if (err && typeof err.message === 'string' && err.message) return err.message;
    return String(err);
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

  async function writeClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
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

  /* ---------------------------------------------------------------- Job Info Helpers --- */

  function getJobName(j) {
    const state = j.state || {};
    if (Array.isArray(state.files) && state.files.length > 0 && state.files[0] && state.files[0].name) {
      return state.files.length > 1 ? `${state.files[0].name} 等 ${state.files.length} 个文件` : state.files[0].name;
    }
    if (Array.isArray(state.progress) && state.progress.length > 0 && state.progress[0] && state.progress[0].name) {
      return state.progress.length > 1 ? `${state.progress[0].name} 等 ${state.progress.length} 个文件` : state.progress[0].name;
    }
    if (j.link && j.link.shareId) {
      return `${PROVIDER_LABELS[j.link.provider] || '分享'} · ${j.link.shareId}`;
    }
    return '（未命名任务）';
  }

  function humanInfo(j) {
    const reason = j.state && j.state.reason;
    const provider = j.link && j.link.provider;
    const isWindowLogin = reason === 'login' && PROVIDER_LOGIN[provider] === 'window';

    if (reason === 'transfer') {
      return {
        label: '需先转存',
        action: '前往转存设置',
        text: '该分享不能直接取链，需要先授权转存到你自己的网盘。请在设置中开启「允许自动转存到我的网盘」，再重新提交原分享链接。',
      };
    }
    if (reason === 'manual') {
      return {
        label: '需手动取链',
        action: '打开我的云盘',
        text: '文件已转存。请在「我的云盘」中打开对应文件夹，选中文件，再点「下载助手」→「Aria2 下载」推送。程序收到直链后继续下载。',
      };
    }
    if (reason === 'login' || reason === 'login-window') {
      return {
        label: '需登录',
        action: isWindowLogin ? '打开登录窗口' : '登录网盘',
        text: isWindowLogin
          ? '请在应用打开的网盘窗口内登录。该网盘的登录凭证不能通过浏览器 Cookie 导入。登录后自动继续，也可点击「我已登录，继续」。'
          : '请完成浏览器登录。UC 与夸克的直链下载需要有效登录态；登录后可重新取链。',
      };
    }
    if (reason === 'captcha') {
      return {
        label: '需要验证码',
        action: '打开验证窗口',
        text: '网盘弹出了验证码。请在弹出的网盘窗口中完成验证，处理完后任务会自动继续。',
      };
    }
    if (reason === 'passcode') {
      return {
        label: '需提取码',
        action: '打开窗口填提取码',
        text: '这个分享需要提取码。请在窗口内填入，或带提取码重新提交。',
      };
    }
    return {
      label: '需处理',
      action: '打开网盘窗口',
      text: (j.state && j.state.message) || '需要你介入处理这个任务。',
    };
  }

  /** Phase `done` means two different things. Only real aria2 progress proves
   *  local bytes; a job without progress was handed to the clipboard or the
   *  browser, and the saved setting must not relabel it. */
  function doneOutcome(j) {
    const hasProgress = Array.isArray(j.state && j.state.progress) && j.state.progress.length > 0;
    if (hasProgress) return 'aria2';
    return null;
  }

  function doneLabel(j) {
    const outcome = doneOutcome(j);
    if (outcome === 'aria2') return '下载完成';
    // Legacy clipboard/browser jobs carry no delivery metadata: stay neutral.
    return '已投递';
  }

  function doneDetail(j) {
    const outcome = doneOutcome(j);
    if (outcome === 'aria2') return '已保存到本地';
    return '已交给剪贴板或浏览器';
  }

  /** Map a job phase onto the colour token styles.css defines. */
  function statusTone(job) {
    return STATUS_TEXT[statusKey(job)].tone;
  }

  function getJobStatusLabel(j) {
    const phase = j.state && j.state.phase;
    if (phase === 'failed' && j.state.code === 'cancelled') return '已取消';
    if (statusKey(j) === 'partial') {
      const counts = partialCounts(j);
      return `部分完成 ${counts.failed} 失败 / ${counts.completed} 完成`;
    }
    if (phase === 'done' && !isPartial(j)) return doneLabel(j);
    return STATUS_TEXT[statusKey(j)].label;
  }

  function getJobStatusIcon(j) {
    const phase = j.state && j.state.phase;
    if (phase === 'needs-human') return 'shield';
    if (phase === 'failed' && j.state && j.state.code === 'cancelled') return 'close';
    return (STATES[phase] && STATES[phase][1]) || 'refresh';
  }

  function getJobSizeOrStatusText(j) {
    const state = j.state || {};
    const phase = state.phase;
    if (phase === 'loading') return '正在后台打开分享页面…';
    if (phase === 'extracting') return '正在驱动页面取直链…';
    if (phase === 'linked') return '直链已就绪';
    if (phase === 'delivering') return '正在推送到下载器…';
    if (phase === 'needs-human') {
      // The list itself has to say what to do, without opening the drawer.
      return `${humanInfo(j).action}：${humanInfo(j).text}`;
    }
    if (phase === 'paused') {
      const prog = aggregateProgress(state.progress);
      return prog.total > 0 ? `${formatBytes(prog.completed)} / ${formatBytes(prog.total)} · 已暂停` : '已暂停';
    }
    if (phase === 'downloading') {
      if (j.stalled) return '可能已停滞：60 秒没有新数据';
      const prog = aggregateProgress(state.progress);
      if (prog.total > 0) return `${formatBytes(prog.completed)} / ${formatBytes(prog.total)}`;
      return '下载中…';
    }
    if (phase === 'done') {
      if (isPartial(j)) {
        const counts = partialCounts(j);
        return `${counts.completed} 个完成 · ${counts.failed} 个失败`;
      }
      const prog = aggregateProgress(state.progress);
      if (prog.total > 0) return formatBytes(prog.completed || prog.total);
      return doneDetail(j);
    }
    if (phase === 'failed') {
      if (state.code === 'cancelled') return '任务已取消';
      return state.message || FAILURE_LABELS[state.code] || '下载失败';
    }
    return '';
  }

  function aggregateProgress(progressList) {
    if (!Array.isArray(progressList) || !progressList.length) {
      return { total: 0, completed: 0, speed: 0, percent: 0 };
    }
    let total = 0;
    let completed = 0;
    let speed = 0;
    for (const p of progressList) {
      total += p.totalLength || 0;
      completed += p.completedLength || 0;
      speed += p.downloadSpeed || 0;
    }
    const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
    return { total, completed, speed, percent };
  }

  /* ---------------------------------------------------------------- Filtering & Sorting --- */

  function matchesFilter(j, filter) {
    const phase = j.state && j.state.phase;
    // Archived rows only appear in the archive view; live rows never do.
    if (isArchived(j) !== viewState.archiveView) return false;
    if (filter === 'all') return true;
    if (filter === 'active') return ['downloading', 'extracting', 'linked', 'loading', 'delivering'].includes(phase);
    if (filter === 'paused') return phase === 'paused';
    if (filter === 'human') return phase === 'needs-human';
    if (filter === 'done') return phase === 'done';
    if (filter === 'failed') return phase === 'failed';
    return false;
  }

  function visibleJobs() {
    const q = viewState.query.toLowerCase().trim();
    let list = Array.from(jobs.values());

    // Filter by phase
    list = list.filter((j) => matchesFilter(j, viewState.phaseFilter));

    // Filter by provider if selected
    if (viewState.providerFilter) {
      list = list.filter((j) => j.link && j.link.provider === viewState.providerFilter);
    }

    // Filter by search query
    if (q) {
      list = list.filter((j) => {
        const name = getJobName(j).toLowerCase();
        const prov = (PROVIDER_LABELS[j.link && j.link.provider] || '').toLowerCase();
        const shareId = (j.link && j.link.shareId || '').toLowerCase();
        return name.includes(q) || prov.includes(q) || shareId.includes(q);
      });
    }

    // Sort: stable newest / oldest / name
    list.sort((a, b) => {
      if (viewState.sort === 'name') {
        return getJobName(a).localeCompare(getJobName(b), 'zh-CN');
      }
      if (viewState.sort === 'old') {
        return (a.createdAt || 0) - (b.createdAt || 0);
      }
      return (b.createdAt || 0) - (a.createdAt || 0);
    });

    return list;
  }

  function setPhaseFilter(filter) {
    viewState.phaseFilter = filter;
    viewState.providerFilter = null;
    showPage('tasks');
    render();
  }

  function setProviderFilter(prov) {
    viewState.providerFilter = prov;
    viewState.phaseFilter = 'all';
    showPage('tasks');
    render();
  }

  /* ---------------------------------------------------------------- Provider health --- */

  /**
   * What the settings page may claim about a netdisk: the capability grade (a
   * fixed, verified conclusion) next to the last outcome that actually happened
   * on this machine. A provider nothing has run on says 未验证, not a guess.
   */
  const PROVIDER_CAPABILITY = {
    quark: { grade: '一键取链', note: '已验证' },
    baidu: { grade: '一键取链 · 大文件需转存', note: '已验证' },
    uc: { grade: '一键取链', note: '已验证' },
    xunlei: { grade: '仅转存 · 需手动推送', note: '实验性' },
  };

  function formatHealthTime(at) {
    if (!at) return '';
    const date = new Date(at);
    const sameDay = new Date().toDateString() === date.toDateString();
    return sameDay ? date.toLocaleTimeString() : date.toLocaleString();
  }

  function renderProviderHealth() {
    const body = $('#provider-health-body');
    if (!body) return;
    body.replaceChildren();
    for (const provider of ['quark', 'baidu', 'uc', 'xunlei']) {
      const entry = providerHealth.find((item) => item.provider === provider);
      const capability = PROVIDER_CAPABILITY[provider] || { grade: '未记录', note: '' };
      const row = el('tr');
      row.dataset.provider = provider;
      row.append(
        el('td', '', (PROVIDER_LABELS[provider] || provider) + (capability.note ? `（${capability.note}）` : '')),
        el('td', '', capability.grade),
      );
      let statusText = '未验证';
      if (entry && entry.verified) {
        const when = formatHealthTime(entry.at);
        statusText = entry.ok ? `成功 · ${when}` : `失败（${FAILURE_LABELS[entry.code] || entry.code || '未知'}）· ${when}`;
      }
      const statusCell = el('td', entry && entry.verified && !entry.ok ? 'health-failed' : '');
      statusCell.textContent = statusText;
      if (entry && entry.hint) statusCell.title = entry.hint;
      row.append(statusCell);
      body.append(row);
    }
  }

  async function loadProviderHealth() {
    try {
      const entries = await api.providerHealth();
      providerHealth = Array.isArray(entries) ? entries : [];
    } catch {
      providerHealth = [];
    }
    renderProviderHealth();
  }

  /** How many records have been archived to disk, for the settings note. */
  async function refreshArchiveCount() {
    try {
      const archived = Array.from(jobs.values()).filter((j) => isArchived(j)).length;
      if ($('#archive-count')) $('#archive-count').textContent = String(archived);
    } catch {
      // The count is a hint, never a reason to fail the page.
    }
  }

  /* ---------------------------------------------------------------- Rendering --- */

  function renderFilters() {
    const allJobs = Array.from(jobs.values());
    // Filter counts describe the list the user is looking at: live or archived.
    const counted = allJobs.filter((j) => isArchived(j) === viewState.archiveView);
    for (const container of [$('#filters'), $('#mobile-filters')]) {
      if (!container) continue;
      container.replaceChildren();
      for (const [key, label, ico] of FILTER_DEFS) {
        const b = el('button', container.id === 'filters' ? 'sideitem' : '');
        b.type = 'button';
        const isActive = viewState.phaseFilter === key && !viewState.providerFilter;
        if (isActive) {
          b.classList.add('active');
          b.setAttribute('aria-current', 'page');
        }
        if (container.id === 'filters') b.append(icon(ico));
        b.append(document.createTextNode(label));
        if (container.id === 'filters') {
          const count = counted.filter((j) => matchesFilter(j, key)).length;
          b.append(el('span', 'counter', String(count)));
        }
        b.onclick = () => setPhaseFilter(key);
        container.append(b);
      }
    }

    $$('[data-source]').forEach((b) => {
      const p = b.dataset.source;
      const isActive = viewState.providerFilter === p;
      b.classList.toggle('active', isActive);
      b.setAttribute('aria-pressed', String(isActive));
    });

    for (const p of ['quark', 'baidu', 'uc', 'xunlei']) {
      const countNode = $('#' + p + '-count');
      if (countNode) {
        countNode.textContent = String(counted.filter((j) => j.link && j.link.provider === p).length);
      }
    }

    const archiveToggle = $('#archive-toggle');
    if (archiveToggle) {
      archiveToggle.setAttribute('aria-pressed', String(viewState.archiveView));
      archiveToggle.classList.toggle('active', viewState.archiveView);
    }
    if ($('#archive-toggle-label')) {
      const archivedCount = allJobs.filter((j) => isArchived(j)).length;
      $('#archive-toggle-label').textContent = archivedCount ? `归档 ${archivedCount}` : '归档';
    }
  }

  /** Archive or purge whatever is selected, then drop the selection. */
  async function runBatch(action, onlyIds) {
    const ids = Array.isArray(onlyIds) ? onlyIds : Array.from(viewState.selectedIds);
    if (!ids.length) return;
    try {
      if (action === 'archive') {
        const res = await api.archiveJobs(ids);
        notify(res && res.archived ? `已归档 ${res.archived} 个任务` : '勾选的任务里没有可归档的');
      } else if (action === 'unarchive') {
        const res = await api.unarchiveJobs(ids);
        notify(res && res.restored ? `已恢复 ${res.restored} 个任务` : '勾选的任务里没有可恢复的');
      } else if (action === 'purge') {
        const res = await api.purgeJobs(ids);
        notify(res && res.removed ? `已删除 ${res.removed} 个任务记录` : '勾选的任务里没有可删除的');
      }
      viewState.selectedIds.clear();
      await refreshJobs();
      render();
    } catch (err) {
      notify('操作失败：' + describeError(err));
    }
  }

  function render() {
    renderFilters();
    const filtered = visibleJobs();
    const allJobs = Array.from(jobs.values());
    const rows = $('#rows');
    const jobListContainer = $('#job-list') || rows;
    // Every push event replaces the whole list, so a refresh listener would
    // otherwise drop the user's focus and scroll position once a second.
    const focusedId = document.activeElement && document.activeElement.dataset
      ? document.activeElement.dataset.jobId || null
      : null;
    // A changed result set (filter, search, sort) is a different list: keeping the
    // old offset there leaves row 0 clipped above the viewport.
    const listKey = JSON.stringify({
      phase: viewState.phaseFilter,
      provider: viewState.providerFilter,
      query: viewState.query,
      sort: viewState.sort,
      archive: viewState.archiveView,
    });
    const listChanged = listKey !== lastListKey;
    lastListKey = listKey;
    const scrollTop = listChanged || !rows ? 0 : rows.scrollTop;
    jobListContainer.replaceChildren();

    for (const j of filtered) {
      const state = j.state || {};
      const phase = state.phase;
      const name = getJobName(j);
      const isSelected = viewState.selectedIds.has(j.id);

      const row = el('article', 'taskrow' + (isSelected ? ' selected' : ''));
      row.dataset.jobId = String(j.id);
      row.dataset.state = phase;
      // What the user has to tell apart; `data-state` stays the raw phase.
      row.dataset.phase = statusKey(j);
      row.tabIndex = 0;
      row.setAttribute('aria-label', `${name}，${getJobStatusLabel(j)}，查看详情`);

      row.onclick = () => openDetails(j.id);
      row.onkeydown = (e) => {
        if (e.target === row && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          openDetails(j.id);
        }
      };

      // Selection Checkbox
      const check = el('input', 'rowcheck');
      check.type = 'checkbox';
      check.checked = isSelected;
      check.setAttribute('aria-label', '选择 ' + name);
      check.onclick = (e) => e.stopPropagation();
      check.onchange = () => {
        if (check.checked) viewState.selectedIds.add(j.id);
        else viewState.selectedIds.delete(j.id);
        render();
      };

      // Main Column
      const main = el('div');
      main.style.minWidth = '0';

      const top = el('div', 'filetop');
      const title = el('div', 'filename', name);
      title.title = name;

      // The stylesheet colours the row by a short token, not by the raw phase
      // name (`needs-human` would need an escaped class and never matched).
      const status = el('span', 'status ' + statusTone(j));
      status.append(icon(getJobStatusIcon(j)), document.createTextNode(getJobStatusLabel(j)));
      const statusSvg = status.querySelector('svg');
      if (statusSvg) statusSvg.style.cssText = 'width:11px;height:11px';
      top.append(title, status);
      main.append(top);

      // Progress bar for downloading / paused
      const prog = aggregateProgress(state.progress);
      if (['downloading', 'paused'].includes(phase) && prog.total > 0) {
        const progress = el('div', 'progress');
        progress.setAttribute('role', 'progressbar');
        progress.setAttribute('aria-label', name + '下载进度');
        progress.setAttribute('aria-valuenow', String(prog.percent));
        progress.setAttribute('aria-valuemin', '0');
        progress.setAttribute('aria-valuemax', '100');
        const fill = el('span');
        fill.style.width = prog.percent + '%';
        progress.append(fill);
        main.append(progress);
      }

      // Metadata line
      const meta = el('div', 'rowmeta');
      const source = el('span', 'source');
      const providerId = (j.link && j.link.provider) || 'quark';
      source.append(el('span', 'providerdot ' + providerId), document.createTextNode((PROVIDER_LABELS[providerId] || '网盘') + '　·　' + getJobSizeOrStatusText(j)));

      const metrics = el('span', 'metrics');
      if (phase === 'downloading' && prog.speed > 0) {
        metrics.textContent = `${formatSpeed(prog.speed)}　·　${formatEta(prog.total - prog.completed, prog.speed)}`;
      } else if (phase === 'paused' && prog.total > 0) {
        metrics.textContent = `${prog.percent}% · 等待继续`;
      } else if (phase === 'done') {
        metrics.textContent = doneDetail(j);
      } else if (phase === 'failed' && state.code !== 'cancelled') {
        metrics.textContent = '可重新取链';
      }
      meta.append(source, metrics);
      main.append(meta);

      // A stall is a flag, not a phase: the download is still running, it just
      // stopped moving, and the user decides whether waiting is still worth it.
      if (j.stalled) {
        const stall = el('div', 'stall-notice');
        stall.append(
          icon('alert'),
          document.createTextNode('可能已停滞：60 秒没有新数据'),
          btn('重试 ' + name, 'refresh', (e) => { e.stopPropagation(); actJob(j.id, 'retry'); }, 'button secondary small'),
        );
        main.append(stall);
      }

      // Why it failed, on the row: the step number is the one thing that says
      // whether this was a page change or a bad link.
      if (phase === 'failed' && state.code !== 'cancelled' && (state.step !== undefined || state.hint)) {
        const diagnostic = el('div', 'diagnostic');
        if (state.step !== undefined) {
          diagnostic.append(el('span', 'diagnostic-step', `第 ${state.step + 1} 步：${state.verb || '?'}`));
        }
        if (state.selector) diagnostic.append(el('span', 'diagnostic-selector', String(state.selector)));
        if (state.hint) diagnostic.append(el('span', 'diagnostic-hint', state.hint));
        main.append(diagnostic);
      }

      // Actions Column
      const actions = el('div', 'rowactions');
      if (phase === 'downloading') {
        actions.append(btn('暂停 ' + name, 'pause', (e) => { e.stopPropagation(); actJob(j.id, 'pause'); }));
      } else if (phase === 'paused') {
        actions.append(btn('继续 ' + name, 'play', (e) => { e.stopPropagation(); actJob(j.id, 'resume'); }));
      } else if (phase === 'failed') {
        actions.append(btn('重新取链 ' + name, 'refresh', (e) => { e.stopPropagation(); actJob(j.id, 'retry'); }));
      } else if (phase === 'needs-human') {
        actions.append(btn(humanInfo(j).action + ' ' + name, 'open', (e) => { e.stopPropagation(); actJob(j.id, 'human'); }));
      }

      actions.append(btn('查看 ' + name + ' 的详情', 'more', (e) => { e.stopPropagation(); openDetails(j.id); }));

      row.append(check, main, actions);
      jobListContainer.append(row);
    }

    // Empty state. The static #jobs-empty element is kept hidden: this block is
    // the only empty message, so two of them can never show at once.
    const emptyNode = $('#jobs-empty');
    if (emptyNode) emptyNode.hidden = true;
    if (!filtered.length) {
      const filtering = Boolean(viewState.query) || viewState.providerFilter !== null || viewState.phaseFilter !== 'all';
      const emptyDiv = el('div', 'empty');
      // An empty archive is not "no tasks yet", and an empty filter is not an
      // empty list. Each one gets its own words and its own way out.
      const heading = viewState.archiveView
        ? filtering ? '归档里没有符合筛选的任务' : '归档里还没有任务'
        : filtering ? '这个筛选下没有任务' : '这里还没有任务';
      emptyDiv.append(
        icon('search'),
        el('h3', '', heading),
        el(
          'p',
          '',
          filtering
            ? '换一个状态或网盘来源，或者清空筛选。'
            : viewState.archiveView
              ? '把已完成的任务归档，它们会从这里消失，需要时再恢复。'
              : '添加一个分享链接，开始你的第一个下载。'
        )
      );
      if (filtering) {
        emptyDiv.append(
          btn('清空筛选', null, () => {
            if ($('#search')) $('#search').value = '';
            viewState.query = '';
            viewState.providerFilter = null;
            viewState.phaseFilter = 'all';
            render();
          }, 'button secondary')
        );
      } else if (viewState.archiveView) {
        emptyDiv.append(
          btn('回到任务列表', null, () => {
            viewState.archiveView = false;
            render();
          }, 'button secondary')
        );
      } else {
        emptyDiv.append(btn('新建任务', null, openCreate, 'button secondary'));
      }
      jobListContainer.append(emptyDiv);
    }

    // Selection bar & summary
    const count = viewState.selectedIds.size;
    if ($('#selection-label')) $('#selection-label').textContent = count ? '已选择 ' + count + ' 个任务' : viewState.archiveView ? '归档任务' : '文件 / 任务';
    if ($('#selection-actions')) $('#selection-actions').hidden = !count;
    if ($('#selected-archive')) $('#selected-archive').textContent = viewState.archiveView ? '恢复' : '归档';
    if ($('#selected-purge')) $('#selected-purge').hidden = false;
    if ($('#visible-count')) $('#visible-count').hidden = !!count;
    if ($('#jobs-count')) $('#jobs-count').textContent = filtered.length + ' 个任务';
    if ($('#select-all')) {
      $('#select-all').checked = !!filtered.length && filtered.every((j) => viewState.selectedIds.has(j.id));
      $('#select-all').indeterminate = filtered.some((j) => viewState.selectedIds.has(j.id)) && !$('#select-all').checked;
    }

    // Attention banner
    const humanJobs = allJobs.filter((j) => j.state && j.state.phase === 'needs-human');
    const attention = $('#attention');
    if (attention) {
      attention.hidden = !humanJobs.length;
      if ($('#attention-text')) {
        $('#attention-text').textContent = `${humanJobs.length} 个任务待处理 · 登录、转存或手动取链，不影响其他下载。`;
      }
    }

    // Aggregate download speed across all downloading jobs
    const activeDownloads = allJobs.filter((j) => j.state && j.state.phase === 'downloading');
    let totalSpeed = 0;
    for (const j of activeDownloads) {
      const p = aggregateProgress(j.state && j.state.progress);
      totalSpeed += p.speed;
    }
    const speedFormatted = formatBytes(totalSpeed);
    const speedParts = speedFormatted.split(' ');
    if ($('#total-speed')) {
      $('#total-speed').textContent = speedParts[0];
      const unitNode = $('#total-speed').nextElementSibling;
      if (unitNode) unitNode.textContent = (speedParts[1] || 'B') + '/s';
    }

    // Task summary. "已完成" must only count jobs with local bytes; a job that was
    // handed to the clipboard or the browser is 已投递, not 已完成.
    const doneCount = allJobs.filter((j) => j.state && j.state.phase === 'done' && doneOutcome(j) === 'aria2').length;
    const deliveredCount = allJobs.filter((j) => j.state && j.state.phase === 'done' && !doneOutcome(j)).length;
    if ($('#task-summary')) {
      $('#task-summary').textContent =
        `${allJobs.length} 个任务 · ${activeDownloads.length} 个下载中 · ${doneCount} 个已完成` +
        (deliveredCount > 0 ? ` · ${deliveredCount} 个已投递` : '');
    }

    if (viewState.page === 'tasks' && $('#page-title')) {
      if (viewState.providerFilter) {
        $('#page-title').textContent = PROVIDER_LABELS[viewState.providerFilter] || '网盘任务';
      } else {
        const found = FILTER_DEFS.find((f) => f[0] === viewState.phaseFilter);
        $('#page-title').textContent = (found && found[1]) || '全部任务';
      }
    }

    if (viewState.detailId !== null) renderDetails();

    if (rows) {
      rows.scrollTop = scrollTop;
      if (focusedId) {
        const sameRow = jobListContainer.querySelector(`.taskrow[data-job-id="${focusedId}"]`);
        if (sameRow) sameRow.focus({ preventScroll: true });
      }
    }
  }

  /* ---------------------------------------------------------------- Drawer Details --- */

  function openDetails(id) {
    viewState.detailId = id;
    viewState.detailTab = 'overview';
    const drawer = $('#drawer');
    if (drawer) drawer.hidden = false;
    renderDetails();
    // Move focus into the panel so a keyboard user lands in what just opened;
    // Escape then returns focus to the row they came from.
    if (drawer) {
      const first = drawer.querySelector('button') || drawer;
      if (first) first.focus({ preventScroll: true });
    }
  }

  function closeDetails() {
    const drawer = $('#drawer');
    if (drawer) drawer.hidden = true;
    viewState.detailId = null;
    const firstRow = $('.taskrow');
    if (firstRow) firstRow.focus();
  }

  function diagnosisText(job) {
    const state = job.state || {};
    const link = job.link || {};
    return [
      'Unidownload 诊断信息',
      '时间: ' + new Date().toISOString(),
      '任务: ' + job.id,
      '网盘: ' + (link.provider || '?') + ' / ' + (link.shareId || '?'),
      '提取码: ' + (link.passcode || '无'),
      '阶段: ' + (state.phase || '?'),
      state.step !== undefined ? `失败步骤: 第 ${state.step + 1} 步（${state.verb || '?'}）` : null,
      state.selector ? '目标: ' + state.selector : null,
      '脚本版本: ' + (job.scriptVersion || '未记录') + (job.scriptOrigin ? '（' + job.scriptOrigin + '）' : ''),
      '错误: ' + (state.code || '无') + ' ' + (state.message || ''),
      '',
      String(state.detail || '（没有技术细节）'),
    ]
      .filter((line) => line !== null)
      .join('\n');
  }

  function renderDetails() {
    const j = jobs.get(viewState.detailId);
    const drawer = $('#drawer');
    if (!drawer) return;
    if (!j) {
      drawer.hidden = true;
      viewState.detailId = null;
      return;
    }

    drawer.replaceChildren();
    const state = j.state || {};
    const phase = state.phase;
    const name = getJobName(j);
    const files = Array.isArray(state.files) ? state.files : [];

    const head = el('div', 'drawerheader', '任务详情');
    head.append(btn('关闭任务详情', 'close', closeDetails));

    const hero = el('div', 'drawerhero');
    hero.append(
      el('h3', '', name),
      el('p', '', (PROVIDER_LABELS[j.link && j.link.provider] || '未知网盘') + ' · ' + getJobStatusLabel(j))
    );

    const tabs = el('nav', 'tabs');
    tabs.setAttribute('aria-label', '详情分类');
    for (const [key, label] of [
      ['overview', '概览'],
      ['files', '文件 ' + files.length],
      ['logs', '活动 / 诊断'],
    ]) {
      const b = el('button', 'tab' + (viewState.detailTab === key ? ' active' : ''), label);
      b.setAttribute('aria-pressed', String(viewState.detailTab === key));
      b.onclick = () => {
        viewState.detailTab = key;
        renderDetails();
      };
      tabs.append(b);
    }
    drawer.append(head, hero, tabs);

    if (viewState.detailTab === 'overview') {
    const prog = aggregateProgress(state.progress);
    const hasProgress = Array.isArray(state.progress) && state.progress.length > 0;
    const sizeText = prog.total > 0 ? `${formatBytes(prog.completed)} / ${formatBytes(prog.total)}` : getJobSizeOrStatusText(j);
    const items = [
      ['当前状态', getJobStatusLabel(j)],
      ['网盘来源', (j.link && PROVIDER_LABELS[j.link.provider]) || '未知'],
      ['文件大小 / 状态', sizeText],
      ['保存位置', (currentSettings.aria2 && currentSettings.aria2.dir) || '默认下载目录'],
      // Historical jobs carry no delivery metadata, so only real aria2 progress
      // names a delivery method; everything else stays neutral.
      ['下载方式', hasProgress ? 'aria2 下载' : '已投递（未在本机下载）'],
    ];
      for (const [k, v] of items) {
        const kv = el('div', 'detailkv');
        kv.append(el('span', '', k), el('span', '', v));
        drawer.append(kv);
      }

      if (phase === 'needs-human') {
        drawer.append(el('div', 'detailnote', humanInfo(j).text));
      }

      if (phase === 'failed') {
        const note = el('div', 'detailnote');
        // Which step broke is the difference between "the page changed" and
        // "this link is bad", so it leads the failure block.
        if (state.step !== undefined) {
          const diagnostic = el('div', 'diagnostic');
          diagnostic.append(el('span', 'diagnostic-step', `第 ${state.step + 1} 步：${state.verb || '?'}`));
          if (state.selector) diagnostic.append(el('span', 'diagnostic-selector', String(state.selector)));
          note.append(diagnostic);
        }
        if (state.hint) {
          const hint = el('p', 'diagnostic-hint', state.hint);
          hint.style.marginTop = '8px';
          note.append(hint);
        }
        note.append(el('p', '', state.message || '任务失败。'));
        if (job.scriptVersion) {
          note.append(
            el('p', 'help', `本次使用脚本 ${job.scriptVersion}${job.scriptOrigin ? '（' + job.scriptOrigin + '）' : ''}`),
          );
        }
        if (state.code) {
          const p = el('p', 'help', '错误代码：' + (FAILURE_LABELS[state.code] || state.code) + ' (' + state.code + ')');
          note.append(p);
        }
        drawer.append(note);
      }

      if (j.stalled) {
        const stall = el('div', 'stall-notice');
        stall.append(icon('alert'), document.createTextNode('可能已停滞：60 秒没有新数据。要不要继续等由你决定。'));
        drawer.append(stall);
      }

      const tools = el('div', 'drawertools');
      if (phase === 'downloading') {
        tools.append(btn('暂停下载', 'pause', () => actJob(j.id, 'pause'), 'button secondary small'));
      } else if (phase === 'paused') {
        tools.append(btn('继续下载', 'play', () => actJob(j.id, 'resume'), 'button secondary small'));
      } else if (phase === 'failed') {
        tools.append(btn('重新获取直链', 'refresh', () => actJob(j.id, 'retry'), 'button secondary small'));
        tools.append(btn('复制诊断', 'copy', async () => {
          const ok = await writeClipboard(diagnosisText(j));
          notify(ok ? '诊断信息已复制' : '复制失败');
        }, 'button secondary small'));
      } else if (phase === 'needs-human') {
        tools.append(btn(humanInfo(j).action, 'open', () => actJob(j.id, 'human'), 'button secondary small'));
        if (humanInfo(j).label === '需先转存') {
          tools.append(btn('前往转存设置', 'settings', () => {
            showPage('settings');
            const behTab = document.querySelector('[data-settingtab=behavior]');
            if (behTab) behTab.click();
            const transferInput = $('#allow-transfer');
            if (transferInput) transferInput.focus();
          }, 'button primary small'));
        }
      }

      // Archiving is the user's own call, and only settled jobs can take it.
      if (['done', 'failed'].includes(phase)) {
        if (isArchived(j)) {
          tools.append(btn('从归档恢复', 'folder', () => runBatch('unarchive', [j.id]), 'button secondary small'));
        } else {
          tools.append(btn('归档', 'folder', () => runBatch('archive', [j.id]), 'button secondary small'));
        }
      }

      if (phase === 'needs-human' && state.reason === 'login' && PROVIDER_LOGIN[j.link && j.link.provider] === 'window') {
        tools.append(btn('我已登录，继续', 'play', async () => {
          try {
            const res = await api.continueAfterLogin(j.id);
            if (res && res.message) notify(res.message);
          } catch (err) {
            notify('继续失败：' + describeError(err));
          }
        }, 'button primary small'));
      }

      // Cancel button if cancellable
      if (!['done', 'failed'].includes(phase) || (phase === 'failed' && state.code !== 'cancelled')) {
        tools.append(btn('取消任务', 'close', async () => {
          try {
            await api.cancel(j.id);
            viewState.selectedIds.delete(j.id);
            notify('已发送取消请求');
          } catch (err) {
            notify('取消失败：' + describeError(err));
          }
        }, 'button quiet small danger'));
      }

      drawer.append(tools);
    } else if (viewState.detailTab === 'files') {
      if (!files.length) {
        drawer.append(el('div', 'detailnote', '尚未获得文件列表，解析完成后会显示文件与直链。'));
      } else {
        // Per-file progress is the only proof a file reached the disk; a done
        // job handed to the clipboard or the browser has none for any file.
        const progress = Array.isArray(state.progress) ? state.progress : [];
        for (const file of files) {
          const item = el('div', 'fileitem');
          const fileName = el('div', 'fileitem-name', file.name || '未命名文件');
          const entry = progress.find((p) => p.name === file.name);
          let fileStatusText = '直链已就绪';
          if (entry && entry.status === 'complete') fileStatusText = '下载完成';
          else if (entry && entry.status === 'error') fileStatusText = '下载失败';
          else if (entry && entry.totalLength > 0) {
            fileStatusText = `${formatBytes(entry.completedLength || 0)} / ${formatBytes(entry.totalLength)}`;
          } else if (phase === 'done') {
            fileStatusText = doneDetail(j);
          }
          const fileStatus = el('small', '', fileStatusText);
          item.append(fileName, fileStatus);

          const copyBtn = btn('复制直链', 'copy', async () => {
            const ok = await writeClipboard(file.url || '');
            notify(ok ? '已复制直链到剪贴板' : '复制直链失败');
          }, 'button secondary small');
          item.append(copyBtn);

          const headers = file.headers && typeof file.headers === 'object' ? Object.entries(file.headers) : [];
          if (headers.length) {
            const detail = el('details');
            detail.style.marginTop = '10px';
            detail.append(el('summary', 'help', '请求头 (' + headers.length + ' 项)'));
            for (const [k, v] of headers) {
              const kv = el('p', 'help', `${k}: ${v}`);
              kv.style.wordBreak = 'break-all';
              detail.append(kv);
            }
            item.append(detail);
          }
          drawer.append(item);
        }
      }
    } else {
      // Logs / Activity / Diagnosis
      const logs = [
        ['当前状态', getJobStatusLabel(j)],
        ['创建时间', j.createdAt ? new Date(j.createdAt).toLocaleTimeString() : '刚刚'],
      ];
      for (const [time, text] of logs) {
        const entry = el('div', 'logitem');
        entry.append(el('time', '', time), document.createTextNode(' · ' + text));
        drawer.append(entry);
      }

      if (state.detail) {
        const pre = el('pre', 'detailnote');
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.wordBreak = 'break-all';
        pre.textContent = String(state.detail);
        drawer.append(pre);
      }

      const copyDiag = btn('复制诊断信息', 'copy', async () => {
        const ok = await writeClipboard(diagnosisText(j));
        notify(ok ? '诊断信息已复制到剪贴板' : '复制失败');
      }, 'button secondary small');
      copyDiag.style.marginTop = '14px';
      drawer.append(copyDiag);
    }
  }

  /* ---------------------------------------------------------------- Job Actions --- */

  async function actJob(id, action) {
    const j = jobs.get(id);
    if (!j) return;
    try {
      if (action === 'pause') {
        const res = await api.pause(id);
        if (res && res.ok === false) notify(res.message || '暂停未生效');
      } else if (action === 'resume') {
        const res = await api.resume(id);
        if (res && res.ok === false) notify(res.message || '继续未生效');
      } else if (action === 'retry') {
        const res = await api.retry(id);
        if (res && res.ok === false) notify(res.message || '重试未生效');
      } else if (action === 'human') {
        const reason = j.state && j.state.reason;
        if (reason === 'transfer') {
          showPage('settings');
          const behTab = document.querySelector('[data-settingtab=behavior]');
          if (behTab) behTab.click();
          const transferInput = $('#allow-transfer');
          if (transferInput) transferInput.focus();
        } else if (reason === 'login' && PROVIDER_LOGIN[j.link && j.link.provider] === 'cookie') {
          const res = await api.login(id);
          notify((res && res.message) || '已触发登录');
        } else {
          await api.revealWindow(id);
        }
      }
    } catch (err) {
      notify('操作失败：' + describeError(err));
    }
  }

  /* ---------------------------------------------------------------- Navigation & Theme --- */

  function showPage(next) {
    viewState.page = next;
    for (const name of ['tasks', 'sources', 'settings']) {
      const pageNode = $('#' + name + '-page');
      if (pageNode) pageNode.hidden = name !== next;
    }
    $$('.rail [data-page]').forEach((b) => {
      const active = b.dataset.page === next;
      b.classList.toggle('active', active);
      // `aria-current="false"` is not a valid token; the attribute is removed.
      if (active) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });

    const copy = {
      tasks: ['全部任务', '文件在哪里，下载到哪一步，一眼看清。'],
      sources: ['网盘来源', '百度、夸克、UC、迅雷统一管理，按任务显示登录、转存和手动处理入口。'],
      settings: ['设置', '把下载器调整成你习惯的样子。'],
    };
    if (copy[next]) {
      if ($('#page-title')) $('#page-title').textContent = copy[next][0];
      if ($('#page-subtitle')) $('#page-subtitle').textContent = copy[next][1];
    }
    if (next === 'tasks') render();
    if (next === 'settings') {
      syncSettingsUi();
      loadProviderHealth();
      refreshArchiveCount();
    }
  }

  function applyTheme(mode) {
    viewState.theme = mode;
    localStorage.setItem('unidownload_theme', mode);
    // styles.css scopes every dark token to `.dark` on the root element.
    document.documentElement.classList.toggle('dark', mode === 'dark');
    if ($('#appearance-mode')) $('#appearance-mode').value = mode;
    if ($('#theme')) $('#theme').setAttribute('aria-label', mode === 'dark' ? '切换浅色主题' : '切换深色主题');
  }

  /* ---------------------------------------------------------------- Settings --- */

  function syncSettingsUi() {
    const s = currentSettings;
    if ($('#delivery')) $('#delivery').value = s.delivery || 'aria2';
    if ($('#engine-mode')) $('#engine-mode').value = s.aria2Mode || 'builtin';
    if ($('#save-dir')) $('#save-dir').value = (s.aria2 && s.aria2.dir) || '';
    if ($('#auto-submit')) $('#auto-submit').checked = Boolean(s.autoSubmit);
    if ($('#allow-transfer')) $('#allow-transfer').checked = Boolean(s.allowTransfer);

    const aria2 = s.aria2 || {};
    if ($('#rpc-host')) $('#rpc-host').value = aria2.domain || 'http://127.0.0.1';
    if ($('#rpc-port')) $('#rpc-port').value = aria2.port || '6800';
    if ($('#rpc-path')) $('#rpc-path').value = aria2.path || '/jsonrpc';
    if ($('#rpc-token')) $('#rpc-token').value = aria2.token || '';

    updateEngineView();
    refreshAria2Status();
  }

  function updateEngineView() {
    const delivery = ($('#delivery') && $('#delivery').value) || 'aria2';
    const isAria2 = delivery === 'aria2';
    const mode = ($('#engine-mode') && $('#engine-mode').value) || 'builtin';

    if ($('#engine-setting')) $('#engine-setting').hidden = !isAria2;
    if ($('#engine-tools')) $('#engine-tools').hidden = !isAria2;
    if ($('#rpc-fields')) $('#rpc-fields').hidden = !isAria2 || mode !== 'external';
    if ($('#delivery-hint')) $('#delivery-hint').textContent = DELIVERY_HINTS[delivery] || '';
    if ($('#mode-hint')) $('#mode-hint').textContent = MODE_HINTS[mode] || '';
  }

  async function refreshAria2Status() {
    try {
      const status = await api.aria2Status();
      if (!status) return;
      const statusText = $('#engine-status-text');
      const statusSub = $('#engine-status-sub');
      const aria2StatusLabel = $('#aria2-status');

      if (status.mode === 'builtin') {
        if (status.running) {
          const msg = `内置 aria2 ${status.version || ''} 运行中 · 127.0.0.1:${status.port}${status.adopted ? '（接管已有进程）' : ''}`;
          if (aria2StatusLabel) aria2StatusLabel.textContent = msg;
          if (statusText) statusText.textContent = '内置 aria2';
          if (statusSub) statusSub.textContent = '运行中';
        } else {
          const msg = '内置 aria2 没在运行：' + (status.error || '未启动');
          if (aria2StatusLabel) aria2StatusLabel.textContent = msg;
          if (statusSub) statusSub.textContent = '未运行';
        }
      } else {
        if (aria2StatusLabel) aria2StatusLabel.textContent = '外部 aria2：使用配置的 RPC 地址连接。';
        if (statusText) statusText.textContent = '外部 aria2';
        if (statusSub) statusSub.textContent = '外部 RPC';
      }
    } catch {
      // ignore
    }
  }

  async function loadSettings() {
    try {
      const s = await api.getSettings();
      if (s && typeof s === 'object') {
        currentSettings = s;
        if ($('#footer-directory')) {
          $('#footer-directory').textContent = (s.aria2 && s.aria2.dir) || '下载目录';
        }
        syncSettingsUi();
      }
    } catch {
      // ignore
    }
  }

  async function saveSettings(e) {
    if (e) e.preventDefault();
    if (saving) return;

    const next = {
      delivery: ($('#delivery') && $('#delivery').value) || 'aria2',
      aria2Mode: ($('#engine-mode') && $('#engine-mode').value) || 'builtin',
      aria2: {
        domain: ($('#rpc-host') && $('#rpc-host').value.trim()) || 'http://127.0.0.1',
        port: ($('#rpc-port') && $('#rpc-port').value.trim()) || '6800',
        path: ($('#rpc-path') && $('#rpc-path').value.trim()) || '/jsonrpc',
        token: ($('#rpc-token') && $('#rpc-token').value) || '',
        dir: ($('#save-dir') && $('#save-dir').value.trim()) || '',
      },
      allowTransfer: Boolean($('#allow-transfer') && $('#allow-transfer').checked),
      autoSubmit: Boolean($('#auto-submit') && $('#auto-submit').checked),
    };

    if (next.delivery === 'aria2' && next.aria2Mode === 'external' && !next.aria2.domain) {
      notify('用外部 aria2 时，RPC 地址不能为空');
      if ($('#rpc-host')) $('#rpc-host').focus();
      return;
    }

    saving = true;
    const saveBtn = $('#save-settings');
    if (saveBtn) {
      saveBtn.setAttribute('aria-busy', 'true');
      saveBtn.textContent = '保存中…';
    }

    try {
      currentSettings = await api.setSettings(next);
      if ($('#footer-directory')) {
        $('#footer-directory').textContent = (currentSettings.aria2 && currentSettings.aria2.dir) || '下载目录';
      }
      // A later successful save must clear the banner left by an earlier failure.
      const errorNode = $('#settings-error');
      if (errorNode) errorNode.hidden = true;
      notify('设置已保存');
      const statusNode = $('#settings-status');
      if (statusNode) {
        statusNode.textContent = '已保存';
        statusNode.hidden = false;
        setTimeout(() => { statusNode.hidden = true; }, 2400);
      }
    } catch (err) {
      notify('保存失败：' + describeError(err));
      const errNode = $('#settings-error');
      if (errNode) {
        errNode.textContent = '保存失败：' + describeError(err);
        errNode.hidden = false;
      }
    } finally {
      saving = false;
      if (saveBtn) {
        saveBtn.removeAttribute('aria-busy');
        saveBtn.textContent = '保存设置';
      }
    }
  }

  /* ---------------------------------------------------------------- Creation Dialog --- */

  function openCreate() {
    const dialog = $('#create-dialog');
    if (!dialog) return;
    const err = $('#create-error');
    if (err) err.hidden = true;

    if ($('#new-dir')) $('#new-dir').value = (currentSettings.aria2 && currentSettings.aria2.dir) || '下载目录';
    const choice = $(`input[name="new-delivery"][value="${currentSettings.delivery}"]`);
    if (choice) choice.checked = true;

    dialog.showModal();
    const input = $('#link-input') || $('#share');
    if (input) input.focus();
  }

  /** @returns {string | null} the delivery picked in the new-task dialog */
  function selectedDelivery() {
    const picked = document.querySelector('input[name="new-delivery"]:checked');
    return picked && picked.value ? picked.value : null;
  }

  async function submitTask(raw) {
    if (submitting) return;
    const text = String(raw || '').trim();
    const errNode = $('#create-error');
    if (!text) {
      if (errNode) {
        errNode.textContent = '请先粘贴分享链接或文案。';
        errNode.hidden = false;
      }
      return;
    }

    submitting = true;
    const submitBtn = $('#submit-btn');
    if (submitBtn) {
      submitBtn.setAttribute('aria-busy', 'true');
      submitBtn.textContent = '提交中…';
    }

    try {
      // The dialog's delivery choice is real: it becomes the saved global setting
      // before the job is submitted, because that is what the host reads.
      const picked = selectedDelivery();
      if (picked && picked !== currentSettings.delivery) {
        currentSettings = await api.setSettings(Object.assign({}, currentSettings, { delivery: picked }));
      }
      const result = await api.submit(text);
      // One paste can be several links; each one answers for itself so a bad
      // entry cannot block the others.
      const entries = (result && Array.isArray(result.jobs)) ? result.jobs : [];
      const created = entries.filter((entry) => entry.jobId).length;
      const duplicates = entries.filter((entry) => entry.duplicateOf).length;
      const rejected = entries.filter((entry) => entry.error);
      if (created || duplicates) {
        const input = $('#link-input') || $('#share');
        if (input) input.value = '';
        const dialog = $('#create-dialog');
        if (dialog) dialog.close();
        const parts = [];
        if (created) parts.push(`新建 ${created} 个任务`);
        if (duplicates) parts.push(`${duplicates} 条已在处理中`);
        notify(parts.join('，') + (rejected.length ? `，${rejected.length} 条没认出来` : ''));
      }
      if (rejected.length && !created) {
        const message = rejected[0].error || '提交失败。';
        if (errNode) {
          errNode.textContent = message;
          errNode.hidden = false;
        } else {
          notify(message);
        }
      } else if (rejected.length) {
        notify(`${rejected.length} 条没认出来：${rejected[0].error || ''}`);
      }
    } catch (err) {
      if (errNode) {
        errNode.textContent = '提交失败：' + describeError(err);
        errNode.hidden = false;
      } else {
        notify('提交失败：' + describeError(err));
      }
    } finally {
      submitting = false;
      if (submitBtn) {
        submitBtn.removeAttribute('aria-busy');
        submitBtn.textContent = '开始提取';
      }
    }
  }

  /* ---------------------------------------------------------------- Batch Operations --- */

  /** The bridge answers pause/resume with a bare boolean (ipc.js passes
   *  JobManager.pause/resume straight through), so only `true` counts as done. */
  function succeeded(res) {
    if (res === false) return false;
    if (res && typeof res === 'object' && res.ok === false) return false;
    return true;
  }

  async function batchPause() {
    // Only what the user can see: a provider or status filter must not make the
    // button pause rows that are not on screen.
    const activeJobs = visibleJobs().filter((j) => j.state && j.state.phase === 'downloading');
    if (!activeJobs.length) {
      notify('当前列表里没有正在下载的任务');
      return;
    }
    let success = 0;
    let failed = 0;
    for (const j of activeJobs) {
      try {
        if (succeeded(await api.pause(j.id))) success++;
        else failed++;
      } catch {
        failed++;
      }
    }
    notify(failed > 0 ? `已暂停 ${success} 个任务，${failed} 个失败` : `已暂停 ${success} 个下载任务`);
  }

  async function batchSelected(action) {
    const ids = Array.from(viewState.selectedIds);
    if (!ids.length) return;

    let targetJobs = [];
    if (action === 'pause') {
      targetJobs = ids.map((id) => jobs.get(id)).filter((j) => j && j.state && j.state.phase === 'downloading');
    } else if (action === 'resume') {
      targetJobs = ids.map((id) => jobs.get(id)).filter((j) => j && j.state && j.state.phase === 'paused');
    } else if (action === 'cancel') {
      // A settled job (done/failed/cancelled) refuses cancel in the host, so it
      // must not be offered here either.
      targetJobs = ids
        .map((id) => jobs.get(id))
        .filter((j) => j && j.state && !['done', 'failed'].includes(j.state.phase));
    }

    if (!targetJobs.length) {
      notify(action === 'pause' ? '所选任务中没有正在下载的任务' : action === 'resume' ? '所选任务中没有可继续的任务' : '所选任务无法取消');
      return;
    }

    let success = 0;
    let failed = 0;
    for (const j of targetJobs) {
      try {
        let res;
        if (action === 'pause') res = await api.pause(j.id);
        else if (action === 'resume') res = await api.resume(j.id);
        else if (action === 'cancel') res = await api.cancel(j.id);

        if (succeeded(res)) success++;
        else failed++;
      } catch {
        failed++;
      }
    }

    if (action === 'cancel') {
      for (const j of targetJobs) viewState.selectedIds.delete(j.id);
    }

    const actionText = action === 'pause' ? '暂停' : action === 'resume' ? '继续' : '取消';
    notify(failed > 0 ? `已${actionText} ${success} 个任务，${failed} 个失败` : `已${actionText} ${success} 个任务`);
    render();
  }

  /* ---------------------------------------------------------------- Sources Page Init --- */

  function renderSourcesPage() {
    const list = $('#source-list');
    if (!list) return;
    list.replaceChildren();

    const sources = [
      ['quark', '夸克网盘', '分享文案与提取码识别 · 浏览器登录'],
      ['baidu', '百度网盘', '支持登录处理 · 超过 50MB 转存需要开启授权'],
      ['uc', 'UC 网盘', '分享页直接取链 · 下载携带会话登录态 · 403 时可登录后重新取链'],
      ['xunlei', '迅雷云盘', '应用窗口登录 → 授权转存 → 我的云盘选文件 → Aria2 取链'],
    ];

    for (const [key, title, desc] of sources) {
      const row = el('article', 'sourceentry');
      const logo = el('div', 'providerlogo ' + key, title.slice(0, 1));
      const content = el('div');
      const heading = el('h3', '', title);
      if (['uc', 'xunlei'].includes(key)) heading.append(el('span', 'badge', '实验性驱动'));
      if (key === 'xunlei') heading.append(el('span', 'badge', '需转存 / 手动取链'));
      content.append(heading, el('p', '', desc));

      row.append(
        logo,
        content,
        btn('查看相关任务', 'arrow', () => setProviderFilter(key), 'button secondary small')
      );
      list.append(row);
    }
  }

  /* ---------------------------------------------------------------- Event Handlers --- */

  function handleJobEvent(job) {
    if (!job || typeof job !== 'object' || !job.id) return;
    const id = job.id;
    if (!jobs.has(id)) jobOrder.unshift(id);
    const previousPhase = jobs.has(id) ? jobs.get(id).state && jobs.get(id).state.phase : null;
    jobs.set(id, job);

    render();
    // A retried job comes back with a new id, so drop the drawer instead of
    // leaving it pointed at a job that no longer exists.
    if (viewState.detailId === id) renderDetails();
    else if (viewState.detailId !== null && !jobs.has(viewState.detailId)) closeDetails();

    // Announce a phase change only. A downloading job pushes progress every
    // second, and announcing that would flood a screen reader.
    const live = $('#live-region');
    if (live && previousPhase !== job.state.phase) {
      const pLabel = (job.link && PROVIDER_LABELS[job.link.provider]) || '任务';
      const sId = (job.link && job.link.shareId) || '';
      live.textContent = `${pLabel} ${sId}：${getJobStatusLabel(job)}`;
    }
  }

  async function loadExistingJobs() {
    await refreshJobs();
    render();
  }

  /** Re-read the whole list, so an archive flag set by the host lands here too. */
  async function refreshJobs() {
    try {
      const existing = await api.listJobs();
      if (Array.isArray(existing)) {
        for (const j of existing) {
          if (!j || !j.id) continue;
          jobs.set(j.id, j);
          if (!jobOrder.includes(j.id)) jobOrder.push(j.id);
        }
      }
    } catch {
      // ignore
    }
  }

  /* ---------------------------------------------------------------- Wiring & Listeners --- */

  function initListeners() {
    // Navigation rail
    $$('[data-page]').forEach((b) => (b.onclick = () => showPage(b.dataset.page)));
    $$('[data-source]').forEach((b) => (b.onclick = () => setProviderFilter(b.dataset.source)));

    // Header buttons
    const newTaskBtn = $('#new-task');
    if (newTaskBtn) newTaskBtn.addEventListener('click', openCreate);

    // Search and Sort
    const searchInput = $('#search');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        viewState.query = e.target.value;
        render();
      });
    }

    const sortSelect = $('#sort');
    if (sortSelect) {
      sortSelect.addEventListener('change', (e) => {
        viewState.sort = e.target.value;
        render();
      });
    }

    // Batch buttons
    const batchPauseBtn = $('#batch-pause');
    if (batchPauseBtn) batchPauseBtn.addEventListener('click', batchPause);

    const selPause = $('#selected-pause');
    if (selPause) selPause.addEventListener('click', () => batchSelected('pause'));

    const selResume = $('#selected-resume');
    if (selResume) selResume.addEventListener('click', () => batchSelected('resume'));

    const selCancel = $('#selected-cancel');
    if (selCancel) selCancel.addEventListener('click', () => batchSelected('cancel'));

    const selArchive = $('#selected-archive');
    if (selArchive) {
      selArchive.addEventListener('click', () => runBatch(viewState.archiveView ? 'unarchive' : 'archive'));
    }

    const selPurge = $('#selected-purge');
    if (selPurge) selPurge.addEventListener('click', () => runBatch('purge'));

    const archiveToggle = $('#archive-toggle');
    if (archiveToggle) {
      archiveToggle.addEventListener('click', () => {
        viewState.archiveView = !viewState.archiveView;
        viewState.selectedIds.clear();
        viewState.detailId = null;
        const drawer = $('#drawer');
        if (drawer) drawer.hidden = true;
        render();
      });
    }

    const selectAllCheck = $('#select-all');
    if (selectAllCheck) {
      selectAllCheck.addEventListener('change', (e) => {
        const filtered = visibleJobs();
        for (const j of filtered) {
          if (e.target.checked) viewState.selectedIds.add(j.id);
          else viewState.selectedIds.delete(j.id);
        }
        render();
      });
    }

    // Human attention review
    const reviewHumanBtn = $('#review-human');
    if (reviewHumanBtn) {
      reviewHumanBtn.addEventListener('click', () => {
        setPhaseFilter('human');
        const firstHuman = Array.from(jobs.values()).find((j) => j.state && j.state.phase === 'needs-human');
        if (firstHuman) openDetails(firstHuman.id);
      });
    }

    // Theme toggles
    const themeBtn = $('#theme');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => {
        applyTheme(document.documentElement.classList.contains('dark') ? 'light' : 'dark');
      });
    }

    const appearMode = $('#appearance-mode');
    if (appearMode) {
      appearMode.addEventListener('change', (e) => {
        applyTheme(e.target.value);
      });
    }

    // About dialog
    const aboutBtn = $('#about');
    if (aboutBtn) aboutBtn.addEventListener('click', () => { const d = $('#info-dialog'); if (d) d.showModal(); });
    const closeInfoBtn = $('#close-info');
    if (closeInfoBtn) closeInfoBtn.addEventListener('click', () => { const d = $('#info-dialog'); if (d) d.close(); });

    // Create dialog
    const closeCreateBtn = $('#close-create');
    if (closeCreateBtn) closeCreateBtn.addEventListener('click', () => { const d = $('#create-dialog'); if (d) d.close(); });
    const cancelCreateBtn = $('#cancel-create');
    if (cancelCreateBtn) cancelCreateBtn.addEventListener('click', () => { const d = $('#create-dialog'); if (d) d.close(); });

    const pasteBtn = $('#paste');
    if (pasteBtn) {
      pasteBtn.addEventListener('click', async () => {
        try {
          const text = await navigator.clipboard.readText();
          const input = $('#link-input') || $('#share');
          if (input) {
            input.value = text;
            input.focus();
            if (currentSettings.autoSubmit) submitTask(text);
          }
        } catch {
          const errNode = $('#create-error');
          if (errNode) {
            errNode.textContent = '浏览器未允许读取剪贴板，请按 Ctrl+V 粘贴。';
            errNode.hidden = false;
          }
        }
      });
    }

    // Create form submit
    const createForm = $('#submit-form') || $('#create-form');
    if (createForm) {
      createForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = $('#link-input') || $('#share');
        submitTask(input ? input.value : '');
      });
    }

    // Settings page
    $$('[data-settingtab]').forEach((b) => {
      b.onclick = () => {
        $$('[data-settingtab]').forEach((x) => x.classList.toggle('active', x === b));
        $$('[data-settings]').forEach((s) => (s.hidden = s.dataset.settings !== b.dataset.settingtab));
        if (b.dataset.settingtab === 'providers') {
          loadProviderHealth();
          refreshArchiveCount();
        }
      };
    });

    const deliverySelect = $('#delivery');
    if (deliverySelect) deliverySelect.addEventListener('change', updateEngineView);

    const engineModeSelect = $('#engine-mode');
    if (engineModeSelect) engineModeSelect.addEventListener('change', updateEngineView);

    const showTokenCheck = $('#show-token');
    if (showTokenCheck) {
      showTokenCheck.addEventListener('change', (e) => {
        const tokenInput = $('#rpc-token');
        if (tokenInput) tokenInput.type = e.target.checked ? 'text' : 'password';
      });
    }

    const testConnBtn = $('#test-connection');
    if (testConnBtn) {
      testConnBtn.addEventListener('click', async () => {
        if (testing) return;
        const testResult = $('#aria2-test-result');
        if (testResult) testResult.hidden = true;

        const config = {
          domain: ($('#rpc-host') && $('#rpc-host').value.trim()) || 'http://127.0.0.1',
          port: ($('#rpc-port') && $('#rpc-port').value.trim()) || '6800',
          path: ($('#rpc-path') && $('#rpc-path').value.trim()) || '/jsonrpc',
          token: ($('#rpc-token') && $('#rpc-token').value) || '',
          dir: ($('#save-dir') && $('#save-dir').value.trim()) || '',
        };

        testing = true;
        testConnBtn.setAttribute('aria-busy', 'true');
        testConnBtn.textContent = '测试中…';

        try {
          const res = await api.testAria2(config);
          notify((res && res.message) || (res && res.ok ? '连接成功' : '连接失败'));
          if (testResult) {
            testResult.textContent = (res && res.message) || '';
            testResult.hidden = false;
          }
        } catch (err) {
          notify('测试失败：' + describeError(err));
        } finally {
          testing = false;
          testConnBtn.removeAttribute('aria-busy');
          testConnBtn.textContent = '测试连接';
        }
      });
    }

    const restartEngineBtn = $('#restart-engine');
    if (restartEngineBtn) {
      restartEngineBtn.addEventListener('click', async () => {
        try {
          await api.restartAria2();
          await refreshAria2Status();
          notify('已重启内置 aria2');
        } catch (err) {
          notify('重启失败：' + describeError(err));
        }
      });
    }

    const openDownloadDirBtn = $('#open-download-dir');
    if (openDownloadDirBtn) {
      openDownloadDirBtn.addEventListener('click', async () => {
        try {
          const err = await api.openDownloadDir();
          if (err) notify('打不开下载目录：' + err);
        } catch (err) {
          notify('打不开下载目录：' + describeError(err));
        }
      });
    }

    const openFolderBtn = $('#open-folder');
    if (openFolderBtn) {
      openFolderBtn.addEventListener('click', async () => {
        try {
          const err = await api.openDownloadDir();
          if (err) notify('打不开下载目录：' + err);
        } catch (err) {
          notify('打不开下载目录：' + describeError(err));
        }
      });
    }

    // Clearing the archive list only forgets records; downloaded files stay.
    const clearArchiveBtn = $('#clear-archive');
    if (clearArchiveBtn) {
      clearArchiveBtn.addEventListener('click', async () => {
        const ids = Array.from(jobs.values()).filter((j) => isArchived(j)).map((j) => j.id);
        const status = $('#archive-status');
        try {
          const res = ids.length ? await api.purgeJobs(ids) : { removed: 0 };
          if (status) {
            status.hidden = false;
            status.textContent = `已清空 ${res.removed || 0} 条归档记录`;
          }
          await refreshJobs();
          refreshArchiveCount();
          render();
        } catch (err) {
          if (status) {
            status.hidden = false;
            status.textContent = '清空失败：' + describeError(err);
          }
        }
      });
    }

    const browseDirBtn = $('#browse-dir');    if (browseDirBtn) {
      browseDirBtn.addEventListener('click', async () => {
        try {
          const selected = await api.chooseDirectory();
          if (typeof selected === 'string' && selected) {
            if ($('#save-dir')) $('#save-dir').value = selected;
          }
        } catch (err) {
          notify('选择目录失败：' + describeError(err));
        }
      });
    }

    const settingsForm = $('#settings-form');
    if (settingsForm) settingsForm.addEventListener('submit', saveSettings);

    const saveSettingsBtn = $('#save-settings');
    if (saveSettingsBtn) saveSettingsBtn.addEventListener('click', saveSettings);

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement && document.activeElement.tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !$('dialog[open]')) {
        e.preventDefault();
        showPage('tasks');
        const s = $('#search');
        if (s) s.focus();
      }
      if (e.key.toLowerCase() === 'n' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey && !$('dialog[open]')) {
        e.preventDefault();
        openCreate();
      }
      if (e.key === 'Escape') {
        if ($('dialog[open]')) {
          // Native dialog escape
        } else if (viewState.detailId !== null) {
          closeDetails();
        }
      }
    });

    // Listen to push events
    api.onJobEvent(handleJobEvent);
  }

  // Initialization
  applyTheme(viewState.theme);
  renderSourcesPage();
  initListeners();
  loadSettings();
  loadExistingJobs();
})();
