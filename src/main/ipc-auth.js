'use strict';

/**
 * Validates that an IPC event came strictly from the expected UI renderer frame.
 *
 * Requirements:
 * 1. Event sender webContents must match expected UI webContents (and not be destroyed).
 * 2. senderFrame must exist and be top-level (parent === null). Subframes / iframes are denied.
 * 3. senderFrame.url must exactly match the expected renderer URL (normalized, no substring matching).
 *
 * @param {import('electron').IpcMainInvokeEvent | import('electron').IpcMainEvent} event
 * @param {import('electron').WebContents | { id: number, isDestroyed?: () => boolean }} expectedWebContents
 * @param {string} expectedFileUrl
 * @returns {boolean}
 */
function normalizeUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const u = new URL(rawUrl);
    if (u.protocol === 'file:') {
      // Normalize drive letters and slashes on Windows
      return u.href.toLowerCase();
    }
    return u.href;
  } catch {
    return '';
  }
}

function authorizeUiEvent(event, expectedWebContents, expectedFileUrl) {
  if (!event || !event.sender) return false;
  if (!expectedWebContents) return false;
  if (typeof expectedWebContents.isDestroyed === 'function' && expectedWebContents.isDestroyed()) {
    return false;
  }
  if (event.sender.id !== expectedWebContents.id) return false;

  if (!event.senderFrame) return false;
  if (event.senderFrame.parent !== null) return false;

  const frameUrl = event.senderFrame.url;
  if (!frameUrl) return false;

  const normFrameUrl = normalizeUrl(frameUrl);
  const normExpectedUrl = normalizeUrl(expectedFileUrl);

  if (!normFrameUrl || !normExpectedUrl) return false;
  return normFrameUrl === normExpectedUrl;
}

module.exports = {
  authorizeUiEvent,
  normalizeUrl,
};
