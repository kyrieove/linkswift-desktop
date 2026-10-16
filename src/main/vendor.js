'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * The userscript declares jQuery, SweetAlert2 and js-md5 as @require and two CSS
 * files as @resource, all from unpkg. They are read from node_modules and
 * injected from disk instead, so the app needs no network to boot the page.
 */
const VENDOR_FILES = {
  jquery: 'jquery/dist/jquery.min.js',
  sweetalert2: 'sweetalert2/dist/sweetalert2.min.js',
  md5: 'js-md5/build/md5.min.js',
};

const RESOURCE_FILES = {
  SwalLigt: 'sweetalert2/dist/sweetalert2.min.css',
  SwalDark: '@sweetalert2/theme-dark/dark.min.css',
};

/**
 * @param {string} rootDir  the directory that contains node_modules
 * @returns {{ vendor: Record<string, string>, resources: Record<string, string> }}
 */
function loadVendor(rootDir) {
  /** @type {Record<string, string>} */
  const vendor = {};
  /** @type {Record<string, string>} */
  const resources = {};

  for (const [name, relative] of Object.entries(VENDOR_FILES)) {
    vendor[name] = readAsset(rootDir, relative, name);
  }
  for (const [name, relative] of Object.entries(RESOURCE_FILES)) {
    resources[name] = readAsset(rootDir, relative, name);
  }

  return { vendor, resources };
}

/**
 * @param {string} rootDir
 * @param {string} relative
 * @param {string} label
 * @returns {string}
 */
function readAsset(rootDir, relative, label) {
  const file = path.join(rootDir, 'node_modules', ...relative.split('/'));
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`缺少运行依赖 ${label}（${file}）。先运行 npm install。`);
  }
}

module.exports = { loadVendor, VENDOR_FILES, RESOURCE_FILES };
