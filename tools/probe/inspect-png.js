'use strict';

// Decode a PNG's pixels without any image library: PNG from the brand generator
// is always 8-bit RGBA, non-interlaced, so inflate + unfilter is enough.
//   node tools/probe/inspect-png.js <file> [x y]
// Prints size and a few alpha/colour samples, never file contents.

const fs = require('node:fs');
const zlib = require('node:zlib');

const [, , file, xArg, yArg] = process.argv;
const buffer = fs.readFileSync(file);
const width = buffer.readUInt32BE(16);
const height = buffer.readUInt32BE(20);
const bitDepth = buffer.readUInt8(24);
const colorType = buffer.readUInt8(25);
const interlace = buffer.readUInt8(28);

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
const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : null;
if (bitDepth !== 8 || !channels || interlace !== 0) {
  console.log(JSON.stringify({ file, width, height, bitDepth, colorType, interlace, decoded: false }));
  process.exit(0);
}

const stride = width * channels;
const pixels = Buffer.alloc(stride * height);
for (let y = 0; y < height; y += 1) {
  const filter = raw[y * (stride + 1)];
  const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
  for (let x = 0; x < stride; x += 1) {
    const left = x >= channels ? pixels[y * stride + x - channels] : 0;
    const up = y > 0 ? pixels[(y - 1) * stride + x] : 0;
    const upLeft = y > 0 && x >= channels ? pixels[(y - 1) * stride + x - channels] : 0;
    let value = line[x];
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

const at = (x, y) => {
  const base = y * stride + x * channels;
  return channels === 4
    ? { r: pixels[base], g: pixels[base + 1], b: pixels[base + 2], a: pixels[base + 3] }
    : { r: pixels[base], g: pixels[base + 1], b: pixels[base + 2], a: 255 };
};

let opaque = 0;
let transparent = 0;
for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    if (at(x, y).a > 16) opaque += 1;
    else transparent += 1;
  }
}

const x = xArg !== undefined ? Number(xArg) : Math.floor(width / 2);
const y = yArg !== undefined ? Number(yArg) : Math.floor(height / 2);

console.log(
  JSON.stringify(
    {
      file,
      width,
      height,
      channels,
      opaquePixels: opaque,
      transparentPixels: transparent,
      center: at(x, y),
      opaqueRatio: Number((opaque / (width * height)).toFixed(3)),
    },
    null,
    2
  )
);
