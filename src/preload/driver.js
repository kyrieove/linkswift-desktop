'use strict';

/**
 * Runs the declarative steps from shared/providers.js against the live page.
 *
 * This lives in the preload's isolated world. The DOM is shared with the page,
 * so querySelector and click reach the real elements, but the page cannot see
 * or call any of this.
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
 * @param {string | string[]} selector
 * @returns {{ el: Element, matched: string } | null}
 */
function findFirst(selector) {
  for (const candidate of candidates(selector)) {
    const el = document.querySelector(candidate);
    if (el) return { el, matched: candidate };
  }
  return null;
}

/**
 * @param {string | string[]} selector
 * @returns {{ els: Element[], matched: string } | null}
 */
function findAll(selector) {
  for (const candidate of candidates(selector)) {
    const els = Array.from(document.querySelectorAll(candidate));
    if (els.length > 0) return { els, matched: candidate };
  }
  return null;
}

/**
 * @param {string | string[]} selector
 * @param {number} timeoutMs
 */
async function waitFor(selector, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = findFirst(selector);
    if (found) return found;
    if (Date.now() > deadline) {
      throw new Error(`等待 ${candidates(selector).join(' 或 ')} 超时（${timeoutMs}ms）`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * React keeps its own copy of an input's value, so assigning `.value` leaves the
 * page's state stale and the submit handler reads the old text. Go through the
 * native setter and fire the events React listens for.
 *
 * @param {Element} el
 * @param {string} value
 */
function fill(el, value) {
  const prototype =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  if (setter) setter.call(el, value);
  else /** @type {HTMLInputElement} */ (el).value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
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

    case 'wait-for':
      await waitFor(step.selector, step.timeoutMs);
      return;

    case 'click': {
      const found = await waitFor(step.selector, 5000);
      /** @type {HTMLElement} */ (found.el).click();
      return;
    }

    case 'click-all': {
      const found = findAll(step.selector);
      if (!found) throw new Error(`没有匹配到 ${candidates(step.selector).join(' 或 ')}`);
      for (const el of found.els) /** @type {HTMLElement} */ (el).click();
      return;
    }

    case 'fill': {
      const found = findFirst(step.selector);
      if (!found) throw new Error(`没有匹配到 ${candidates(step.selector).join(' 或 ')}`);
      const value = step.value.replace('{passcode}', passcode ?? '');
      if (step.value.includes('{passcode}') && !passcode) {
        throw new Error('这一步需要提取码，但链接里没有');
      }
      fill(found.el, value);
      return;
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
        selector: step.do === 'sleep' ? null : candidates(step.selector).join(' 或 '),
        detail: error.message,
      };
    }
  }
  return { ok: true };
}

module.exports = { runDriver };
