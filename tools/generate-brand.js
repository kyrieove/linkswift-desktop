'use strict';

/**
 * Render the Unidownload brand assets from the two SVG sources.
 *
 *   npm run brand
 *
 * Rasterising goes through the Electron that is already a devDependency (a
 * hidden, sandboxed-less offscreen window drawing the SVG on a transparent
 * canvas), and the ICO container is assembled here with plain Buffers. No new
 * dependency, no download. Outputs stay in resources/brand/.
 */

const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const BRAND_DIR = path.join(__dirname, '..', 'resources', 'brand');
const MARK_SVG = path.join(BRAND_DIR, 'unidownload-mark.svg');
const ICON_SVG = path.join(BRAND_DIR, 'unidownload-icon.svg');

/** Mark sizes (transparent PNG) and app-icon sizes (also transparent outside the rounded square). */
const MARK_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
/** A Windows ICO carries 16/24/32/48/64/128/256; 512 is PNG-only. */
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

const PNGS = [
  ...MARK_SIZES.map((size) => ({ svg: MARK_SVG, out: `unidownload-mark-${size}.png`, size, background: null })),
  ...ICON_SIZES.map((size) => ({ svg: ICON_SVG, out: `unidownload-icon-${size}.png`, size, background: null })),
];

function readSvg(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (!/<svg[\s>]/.test(text)) throw new Error(`${file} is not an SVG document`);
  if (/<image[\s>]/.test(text) || /data:image\//.test(text)) {
    throw new Error(`${file} embeds a raster image; the brand must stay vector`);
  }
  return text;
}

/** ICO: a 6-byte header, one 16-byte directory entry per image, then the PNG payloads. */
function buildIco(pngs) {
  if (!pngs.length) throw new Error('ICO needs at least one image');
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(pngs.length, 4);

  const directory = Buffer.alloc(16 * pngs.length);
  let offset = header.length + directory.length;
  pngs.forEach(({ size, data }, index) => {
    const entry = index * 16;
    directory.writeUInt8(size >= 256 ? 0 : size, entry); // 0 means 256
    directory.writeUInt8(size >= 256 ? 0 : size, entry + 1);
    directory.writeUInt8(0, entry + 2); // palette colours
    directory.writeUInt8(0, entry + 3); // reserved
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(data.length, entry + 8); // payload size
    directory.writeUInt32LE(offset, entry + 12); // payload offset
    offset += data.length;
  });

  return Buffer.concat([header, directory, ...pngs.map((p) => p.data)]);
}

/** Draw the SVG at an exact pixel size on a transparent canvas and return a PNG buffer. */
async function rasterise(win, svgText, size, background) {
  // `background` fills the canvas first, so the mark's knocked-out arrow matches
  // the surface it sits on instead of leaving a hole.
  const prepared = background
    ? svgText.replace(/fill="#ffffff"/g, `fill="${background}"`)
    : svgText;
  // The SVG travels as a JSON literal: interpolating it into a template string
  // would let quotes or backticks inside the source break the script.
  const script = `(() => {
    const svg = ${JSON.stringify(prepared)};
    const size = ${Number(size)};
    const background = ${JSON.stringify(background || null)};
    return new Promise((resolve, reject) => {
      const image = new Image();
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      const timer = setTimeout(() => reject(new Error('SVG did not load within 5s at ' + size + 'px')), 5000);
      image.onload = () => {
        clearTimeout(timer);
        const canvas = document.createElement('canvas');
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (background) {
          ctx.fillStyle = background;
          ctx.fillRect(0, 0, size, size);
        } else {
          ctx.clearRect(0, 0, size, size);
        }
        ctx.drawImage(image, 0, 0, size, size);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/png'));
      };
      image.onerror = () => {
        clearTimeout(timer);
        reject(new Error('SVG failed to load into the canvas at ' + size + 'px'));
      };
      image.src = url;
    });
  })()`;

  const dataUrl = await win.webContents.executeJavaScript(script);
  const prefix = 'data:image/png;base64,';
  if (!String(dataUrl).startsWith(prefix)) throw new Error(`canvas returned no PNG for ${size}px`);
  return Buffer.from(String(dataUrl).slice(prefix.length), 'base64');
}

async function main() {
  const debug = path.join(process.env.TEMP || '.', 'brand-gen.log');
  const step = (msg) => fs.appendFileSync(debug, `${Date.now()} ${msg}\n`);
  step('main start');
  try {
    await renderAll(step);
  } catch (err) {
    step(`render failed ${(err && err.stack) || err}`);
    throw err;
  }
}

async function renderAll(step) {
  const markSvg = readSvg(MARK_SVG);
  const iconSvg = readSvg(ICON_SVG);
  step('svg read');

  fs.mkdirSync(BRAND_DIR, { recursive: true });

  await app.whenReady();
  step('whenReady');
  const win = new BrowserWindow({
    show: false,
    width: 64,
    height: 64,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  step('window');

  try {
    await win.loadURL('data:text/html,<html><body></body></html>');
    step('loaded');
    const written = [];
    const byName = new Map();

    for (const job of PNGS) {
      // The icon SVG already carries its own deep-green tile; the bare mark has
      // no background, so its knocked-out arrow is cut in white (docs only).
      const data = await rasterise(win, job.svg === MARK_SVG ? markSvg : iconSvg, job.size, job.background);
      step(`raster ${job.out} ${data.length}`);
      fs.writeFileSync(path.join(BRAND_DIR, job.out), data);
      byName.set(job.out, data);
      written.push({ file: job.out, bytes: data.length, size: job.size });
      console.log(`brand: ${job.out} ${data.length} bytes`);
    }

    const icoPngs = ICO_SIZES.map((size) => {
      const data = byName.get(`unidownload-icon-${size}.png`);
      if (!data) throw new Error(`missing icon PNG for the ICO at ${size}px`);
      return { size, data };
    });
    const ico = buildIco(icoPngs);
    fs.writeFileSync(path.join(BRAND_DIR, 'unidownload.ico'), ico);

    console.log(JSON.stringify({ written, ico: { bytes: ico.length, sizes: ICO_SIZES } }, null, 2));
  } finally {
    win.destroy();
  }
  app.exit(0);
}

module.exports = { buildIco, readSvg, MARK_SIZES, ICON_SIZES, ICO_SIZES };

// Electron may not keep `require.main === module` for the entry script, so the
// launcher is detected by its filename instead.
const ENTRY = path.join(__dirname, 'generate-brand.js');
const isEntry = (process.argv[1] && path.resolve(process.argv[1]) === ENTRY) || require.main === module;

// GPU acceleration adds nothing to a canvas rasterise and Electron only accepts
// this switch before the app becomes ready.
app.disableHardwareAcceleration();

if (isEntry) {
  // Run only after the app is ready: calling app.whenReady() first is what makes
  // a stray `app.exit()` or an early throw silently end the run.
  app.whenReady().then(main).catch((err) => {
    try {
      fs.appendFileSync(path.join(process.env.TEMP || '.', 'brand-gen.log'), `FAIL ${(err && err.stack) || err}\n`);
    } catch {}
    console.error('BRAND GENERATION FAILED:', err);
    app.exit(1);
  });
}
