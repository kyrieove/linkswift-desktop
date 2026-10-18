'use strict';

/**
 * Verify the Unidownload brand assets and the compatibility promises that go
 * with them. Node only, no Electron, no network:
 *
 *   npm run check:brand
 */

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const BRAND = path.join(ROOT, 'resources', 'brand');
const PKG = require('../package.json');

const MARK_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const ICON_SIZES = [16, 24, 32, 48, 64, 128, 256, 512];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const checks = [];
function check(name, fn) {
  try {
    fn();
    checks.push({ name, ok: true });
  } catch (err) {
    checks.push({ name, ok: false, error: err.message });
  }
}

/** IHDR width/height from a PNG buffer; throws if the signature does not match. */
function pngSize(buffer, file) {
  assert(buffer.length >= 24, `${file} is too short to be a PNG`);
  assert(buffer.subarray(0, 8).equals(PNG_SIGNATURE), `${file} has no PNG signature`);
  assert.strictEqual(buffer.toString('ascii', 12, 16), 'IHDR', `${file} does not start with IHDR`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function readBrand(name) {
  return fs.readFileSync(path.join(BRAND, name));
}

/**
 * Decode an 8-bit RGBA, non-interlaced PNG far enough to count opaque pixels.
 * The generator always writes that format, and this keeps the checker free of
 * dependencies. A blank or fully transparent file would otherwise pass a
 * width/height check.
 */
function opaquePixelCount(buffer, file) {
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer.readUInt8(24);
  const colorType = buffer.readUInt8(25);
  const interlace = buffer.readUInt8(28);
  assert.strictEqual(bitDepth, 8, `${file} must be an 8-bit PNG`);
  assert.strictEqual(colorType, 6, `${file} must be RGBA so transparency is real`);
  assert.strictEqual(interlace, 0, `${file} must not be interlaced`);

  const chunks = [];
  let offset = 8;
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  const channels = 4;
  const stride = width * channels;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? pixels[y * stride + x - channels] : 0;
      const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
      let value = raw[y * (stride + 1) + 1 + x];
      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += Math.floor((left + up) / 2);
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      pixels[y * stride + x] = value & 0xff;
    }
  }

  let opaque = 0;
  for (let index = 3; index < pixels.length; index += channels) {
    if (pixels[index] > 16) opaque += 1;
  }
  return { width, height, opaque, total: width * height };
}

// 1. Vector sources: real SVG, no embedded raster.
check('mark and icon SVG are real vectors', () => {
  for (const name of ['unidownload-mark.svg', 'unidownload-icon.svg']) {
    const svg = readBrand(name).toString('utf8');
    assert(/<svg[\s>]/.test(svg), `${name} is not an SVG document`);
    assert(/viewBox="0 0 256 256"/.test(svg), `${name} must use the 0 0 256 256 viewBox`);
    assert(!/<image[\s>]/.test(svg), `${name} embeds an <image>; the brand must stay vector`);
    assert(!/data:image\//.test(svg), `${name} embeds a data URI bitmap`);
    assert(/233c2e/i.test(svg), `${name} must use the deep green #233c2e`);
  }
});

check('icon SVG uses the mint mark on the deep green tile', () => {
  const svg = readBrand('unidownload-icon.svg').toString('utf8');
  assert(/d0efb5/i.test(svg), 'icon must paint the mark in mint #d0efb5');
  assert(/<rect[^>]*fill="#233c2e"/i.test(svg), 'icon must have a deep green tile');
});

// 2. Every PNG is a real PNG at the exact expected size, and actually has ink.
check('mark PNGs exist at every required size and are not blank', () => {
  for (const size of MARK_SIZES) {
    const file = `unidownload-mark-${size}.png`;
    const buffer = readBrand(file);
    const { width, height } = pngSize(buffer, file);
    assert.strictEqual(width, size, `${file} is ${width}px wide`);
    assert.strictEqual(height, size, `${file} is ${height}px tall`);
    const { opaque, total } = opaquePixelCount(buffer, file);
    assert(opaque / total > 0.1, `${file} has only ${opaque}/${total} opaque pixels; it looks blank`);
  }
});

check('icon PNGs exist at every required size and are not blank', () => {
  for (const size of ICON_SIZES) {
    const file = `unidownload-icon-${size}.png`;
    const buffer = readBrand(file);
    const { width, height } = pngSize(buffer, file);
    assert.strictEqual(width, size, `${file} is ${width}px wide`);
    assert.strictEqual(height, size, `${file} is ${height}px tall`);
    const { opaque, total } = opaquePixelCount(buffer, file);
    assert(opaque / total > 0.5, `${file} has only ${opaque}/${total} opaque pixels; the tile looks blank`);
  }
});

check('mark has no white knockout fill', () => {
  // A white arrow "hole" only works on white backgrounds; the mark must be flat
  // deep green on transparency.
  for (const name of ['unidownload-mark.svg', 'unidownload-mark-256.png']) {
    const text = readBrand(name).toString('latin1');
    assert(!/#ffffff/i.test(text), `${name} still contains a white fill`);
    assert(!/\xef\xbf\xbd/.test(text), `${name} is not clean text`);
  }
});

// 3. The ICO is a well-formed directory whose payloads are the icon PNGs.
check('ICO directory lists every Windows size with valid offsets', () => {
  const ico = readBrand('unidownload.ico');
  assert.strictEqual(ico.readUInt16LE(0), 0, 'ICO reserved field must be 0');
  assert.strictEqual(ico.readUInt16LE(2), 1, 'ICO type must be 1 (icon)');
  const count = ico.readUInt16LE(4);
  assert.strictEqual(count, ICO_SIZES.length, `ICO has ${count} entries, expected ${ICO_SIZES.length}`);
  assert(ico.length >= 6 + count * 16, 'ICO is shorter than its directory');

  const seen = [];
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    const width = ico.readUInt8(entry) || 256;
    const height = ico.readUInt8(entry + 1) || 256;
    const bytes = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    const size = ICO_SIZES[index];
    assert.strictEqual(width, size, `ICO entry ${index} width ${width} != ${size}`);
    assert.strictEqual(height, size, `ICO entry ${index} height ${height} != ${size}`);
    assert(offset + bytes <= ico.length, `ICO entry ${index} payload runs past the file`);
    assert.strictEqual(bytes, readBrand(`unidownload-icon-${size}.png`).length, `ICO entry ${index} payload size mismatch`);
    const payload = ico.subarray(offset, offset + bytes);
    assert(payload.subarray(0, 8).equals(PNG_SIGNATURE), `ICO entry ${index} is not a PNG payload`);
    seen.push(size);
  }
  assert.deepStrictEqual(seen, ICO_SIZES, 'ICO entries must be in ascending size order');
});

// 4. Identity and storage stay exactly as before, so old settings, logins and
//    resumable downloads are still found after the rename.
check('package identity is unchanged', () => {
  assert.strictEqual(PKG.name, 'linkswift-desktop', 'package.name must stay linkswift-desktop to keep userData');
  assert.strictEqual(PKG.productName, undefined, 'productName would change the default userData directory');
});

check('main process keeps the persistent partition and never renames storage', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  assert(/const PARTITION = 'persist:linkswift';/.test(main), "partition must stay 'persist:linkswift'");
  assert(!/app\.setName\s*\(/.test(main), 'app.setName() must not be called');
  assert(!/setPath\s*\(\s*['"]userData/.test(main), 'userData path must not be redirected');
  assert(!/setPath\s*\(\s*['"]sessionData/.test(main), 'sessionData path must not be redirected');
  assert(/app\.getPath\('userData'\)/.test(main), 'userData must still come from app.getPath');
});

check('window uses the Unidownload name and the brand icon', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'main.js'), 'utf8');
  assert(/const PRODUCT_NAME = 'Unidownload';/.test(main), "PRODUCT_NAME must be 'Unidownload'");
  assert(/title: PRODUCT_NAME/.test(main), 'BrowserWindow title must use PRODUCT_NAME');
  assert(/icon: brandIconPath\(\)/.test(main), 'BrowserWindow must pass brandIconPath() as its icon');
  assert(/backgroundColor: '#233c2e'/.test(main), 'window background must match the brand deep green');

  // The icon path the window resolves at runtime must be a real file: a typo or a
  // missing asset would otherwise only show up as a blank icon.
  const packaged = path.join(ROOT, 'resources', 'brand', 'unidownload.ico');
  const dev = path.join(ROOT, 'src', 'main', '..', '..', 'resources', 'brand', 'unidownload.ico');
  assert(fs.existsSync(packaged), `packaged icon missing: ${packaged}`);
  assert(
    path.resolve(dev) === path.resolve(packaged),
    'the development icon path must resolve to resources/brand/unidownload.ico'
  );

  const renderer = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
  assert(/<title>Unidownload/.test(renderer), 'renderer title must be Unidownload');
  assert(/unidownload-icon-256\.png/.test(renderer), 'renderer must reference the brand icon as its favicon');
  assert(/class="brandmark"/.test(renderer), 'renderer must draw the brand mark instead of a generic bolt icon');
});

const failed = checks.filter((entry) => !entry.ok);
for (const entry of checks) {
  console.log(`${entry.ok ? 'PASS' : 'FAIL'}  ${entry.name}${entry.ok ? '' : `\n      ${entry.error}`}`);
}
if (failed.length) {
  console.error(`\ncheck:brand FAILED: ${failed.length}/${checks.length}`);
  process.exit(1);
}
console.log(`\ncheck:brand OK: ${checks.length} checks`);
