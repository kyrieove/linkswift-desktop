'use strict';

const { webFrame } = require('electron');

/**
 * Runs the declarative steps from shared/providers.js against the live page.
 *
 * Every DOM query and every DOM action is evaluated in the page's MAIN world
 * through webFrame, not in the preload's isolated world.
 *
 * That is not a stylistic choice. Measured on a live baidu share page: nodes the
 * page's own JavaScript inserts afterwards are visible to a main-world query and
 * invisible to an isolated-world one, while server-rendered nodes are visible to
 * both. The userscript mounts its button from the page, so an isolated-world
 * driver waits forever for a button that is on screen.
 *
 * The step loop stays here, in the preload, and each primitive crosses the
 * boundary as plain JSON.
 *
 * @typedef {import('../shared/providers').Step} Step
 * @typedef {import('../shared/providers').Provider} Provider
 */

const POLL_INTERVAL_MS = 200;

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {string | string[]} selector */
function candidates(selector) {
  return Array.isArray(selector) ? selector : [selector];
}

/**
 * Evaluate an expression in the page's main world and bring the result back as
 * JSON. Throws when the expression throws, so a broken step is not silently a
 * missing element.
 *
 * @param {string} expression
 * @returns {Promise<any>}
 */
async function runInPage(expression) {
  const source = `(() => {
    try {
      return JSON.stringify({ ok: true, value: (${expression}) });
    } catch (error) {
      return JSON.stringify({ ok: false, error: String((error && error.message) || error) });
    }
  })()`;

  let raw;
  try {
    raw = await webFrame.executeJavaScript(source);
  } catch (error) {
    throw new Error(`主世界执行失败：${error.message}`);
  }

  const parsed = JSON.parse(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

/** @param {string | string[]} selector */
function selectorList(selector) {
  return JSON.stringify(candidates(selector));
}

/**
 * How many elements the first matching candidate selects, and which candidate it
 * was.
 *
 * @param {string | string[]} selector
 * @returns {Promise<{ count: number, matched: string | null }>}
 */
async function countMatches(selector) {
  return runInPage(`(() => {
    for (const candidate of ${selectorList(selector)}) {
      const nodes = document.querySelectorAll(candidate);
      if (nodes.length > 0) return { count: nodes.length, matched: candidate };
    }
    return { count: 0, matched: null };
  })()`);
}

/**
 * @param {string | string[]} selector
 * @param {number} timeoutMs
 */
async function waitFor(selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = await countMatches(selector);
    if (found.count > 0) return found;
    if (Date.now() > deadline) {
      // Carry page state into the failure, or a timeout is indistinguishable from
      // a selector that no longer exists.
      const seen = await runInPage(`({
        url: location.href,
        ready: document.readyState,
        bodyLength: document.body ? document.body.innerHTML.length : -1,
        plButton: document.querySelectorAll('.pl-button').length,
        plButtonMode: document.querySelectorAll('.pl-button-mode').length,
        xButtonBox: document.querySelectorAll('.x-button-box').length,
      })`);
      throw new Error(
        `等待 ${candidates(selector).join(' 或 ')} 超时（${timeoutMs}ms）；${JSON.stringify(seen)}`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * @param {string | string[]} selector
 * @param {string} value
 */
async function fillIn(selector, value) {
  const outcome = await runInPage(`(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return { ok: false };
    // React keeps its own copy of the value, so assigning .value leaves the page's
    // state stale and the submit handler reads the old text.
    const prototype = node instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(node, ${JSON.stringify(value)});
    else node.value = ${JSON.stringify(value)};
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  })()`);
  if (!outcome.ok) throw new Error(`没有匹配到 ${selector}`);
}

/**
 * The file list the page's React state holds, the same way the userscript reads
 * it: walk up from .file-list skipping host-element fibers until a component
 * fiber carries a `list` array.
 *
 * @returns {Promise<Array<{ fid: string, file: boolean | undefined }> | null>}
 */
async function readListItems() {
  try {
    return await runInPage(`(() => {
      const dom = document.getElementsByClassName('file-list')[0];
      if (!dom) return null;
      const key = Object.keys(dom).find(
        (name) => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'),
      );
      if (!key) return null;
      const isHost = (fiber) => fiber && typeof fiber.type === 'string';
      const walkUp = (fiber) => {
        let parent = fiber.return;
        let guard = 0;
        while (parent && isHost(parent) && guard < 60) { parent = parent.return; guard += 1; }
        return parent;
      };
      let fiber = walkUp(dom[key]);
      for (let depth = 0; depth < 10 && fiber; depth += 1) {
        const props = fiber.memoizedProps || {};
        if (Array.isArray(props.list) && props.list.length > 0) {
          return props.list.map((item) => ({ fid: item.fid, file: item.file }));
        }
        fiber = walkUp(fiber);
      }
      return null;
    })()`);
  } catch {
    return null;
  }
}

/**
 * @param {number} timeoutMs
 * @returns {Promise<Array<{ fid: string, file: boolean | undefined }>>}
 */
async function waitForListItems(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const items = await readListItems();
    if (items && items.length > 0) return items;
    if (Date.now() > deadline) throw new Error('读不到文件列表，页面结构可能变了');
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * @param {Step} step
 * @param {string | null} passcode
 */
async function runStep(step, passcode) {
  switch (step.do) {
    case 'sleep':
      await sleep(step.ms);
      return;

    case 'ensure-anchor': {
      await waitFor(step.ancestor, step.timeoutMs ?? 30000);
      const outcome = await runInPage(`(() => {
        const anchor = document.querySelector(${JSON.stringify(step.ancestor)});
        if (!anchor) return { ok: false, reason: 'anchor not found' };
        if (anchor.querySelector('.g-dropdown-button.tools-more')) return { ok: true, created: false };
        anchor.parentElement?.classList.add(${JSON.stringify(step.addClass)});
        anchor.insertAdjacentHTML('beforeend', ${JSON.stringify(step.create)});
        return { ok: true, created: true };
      })()`);
      if (!outcome.ok) throw new Error(`无法恢复页面挂载点：${step.ancestor}`);
      return;
    }

    case 'wait-for':
      await waitFor(step.selector, step.timeoutMs);
      return;

    case 'click': {
      await waitFor(step.selector, 5000);
      const outcome = await runInPage(`(() => {
        for (const candidate of ${selectorList(step.selector)}) {
          const node = document.querySelector(candidate);
          if (node) { node.click(); return { ok: true, matched: candidate }; }
        }
        return { ok: false };
      })()`);
      if (!outcome.ok) throw new Error(`没有匹配到 ${candidates(step.selector).join(' 或 ')}`);
      return;
    }

    case 'click-all': {
      const outcome = await runInPage(`(() => {
        for (const candidate of ${selectorList(step.selector)}) {
          const nodes = document.querySelectorAll(candidate);
          if (nodes.length === 0) continue;
          for (const node of nodes) node.click();
          return { ok: true, count: nodes.length, matched: candidate };
        }
        return { ok: false };
      })()`);
      if (!outcome.ok) throw new Error(`没有匹配到 ${candidates(step.selector).join(' 或 ')}`);
      return;
    }

    case 'fill': {
      if (step.value.includes('{passcode}') && !passcode) {
        throw new Error('这一步需要提取码，但链接里没有');
      }
      const value = step.value.replace('{passcode}', passcode ?? '');
      for (const candidate of candidates(step.selector)) {
        const outcome = await runInPage(`(() => {
          const node = document.querySelector(${JSON.stringify(candidate)});
          if (!node) return { ok: false };
          const prototype = node instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
          if (setter) setter.call(node, ${JSON.stringify(value)});
          else node.value = ${JSON.stringify(value)};
          node.dispatchEvent(new Event('input', { bubbles: true }));
          node.dispatchEvent(new Event('change', { bubbles: true }));
          return { ok: true };
        })()`);
        if (outcome.ok) return;
      }
      throw new Error(`没有匹配到 ${candidates(step.selector).join(' 或 ')}`);
    }

    // A share page usually arrives with its files already selected, so clicking the
    // boxes blindly would deselect them. Only act when nothing is selected.
    case 'ensure-selection': {
      const selected = await countMatches(step.selected);
      if (selected.count > 0) return;

      const outcome = await runInPage(`(() => {
        for (const candidate of ${selectorList(step.unselected)}) {
          const nodes = document.querySelectorAll(candidate);
          if (nodes.length === 0) continue;
          for (const node of nodes) node.click();
          return { ok: true, count: nodes.length, matched: candidate };
        }
        return { ok: false };
      })()`);
      if (!outcome.ok) {
        throw new Error(`没有已选中的文件，也没有匹配到 ${candidates(step.unselected).join(' 或 ')}`);
      }
      return;
    }

    // A share whose top row is a folder cannot be extracted from: the userscript
    // filters the selection down to items with file === true and then complains
    // that nothing is selected. Descend until the list holds a file.
    case 'enter-folders': {
      const maxDepth = step.maxDepth ?? 5;
      for (let depth = 0; depth < maxDepth; depth += 1) {
        const items = await waitForListItems(step.timeoutMs);
        if (items.some((item) => item.file === true)) return;

        const folder = items.find((item) => item.file === false);
        if (!folder) return;

        // The page's own UI opens a folder on a double click, so dispatch the full
        // mouse sequence rather than calling click().
        const outcome = await runInPage(`(() => {
          const rows = Array.from(document.querySelectorAll('.ant-table-row'));
          const row = rows.find((candidate) => candidate.getAttribute('data-row-key') === ${JSON.stringify(folder.fid)}) ?? rows[0];
          if (!row) return { ok: false, reason: 'no row' };
          const named = row.querySelector('.filename-text, [class*="filename-text"]');
          const target = named || row;
          const base = { bubbles: true, cancelable: true, view: window };
          for (const type of ['mousedown', 'mouseup', 'click', 'mousedown', 'mouseup', 'click', 'dblclick']) {
            target.dispatchEvent(new MouseEvent(type, { ...base, detail: type === 'dblclick' ? 2 : 1 }));
          }
          return { ok: true };
        })()`);
        if (!outcome.ok) throw new Error('找不到文件夹所在的行');

        const before = items.map((item) => item.fid).join(',');
        const until = Date.now() + step.timeoutMs;
        for (;;) {
          await sleep(POLL_INTERVAL_MS);
          const next = await readListItems();
          if (next && next.map((item) => item.fid).join(',') !== before) break;
          if (Date.now() > until) throw new Error(`进入「${folder.fid}」超时`);
        }
      }
      throw new Error('文件夹嵌套太深，停下了');
    }

    default:
      throw new Error(`未知的步骤：${JSON.stringify(step)}`);
  }
}

/**
 * @param {Provider} provider
 * @param {string | null} passcode
 * @returns {Promise<{ ok: true } | { ok: false, step: number, verb: string, selector: string | null, detail: string }>}
 */
async function runDriver(provider, passcode) {
  for (let index = 0; index < provider.steps.length; index++) {
    const step = provider.steps[index];
    try {
      await runStep(step, passcode);
    } catch (error) {
      if (step.optional) continue;
      return {
        ok: false,
        step: index,
        verb: step.do,
        selector: step.do === 'sleep' ? null : candidates(step.selector ?? step.selected ?? step.unselected ?? '').join(' 或 '),
        detail: error.message,
      };
    }
  }
  return { ok: true };
}

module.exports = { runDriver };
