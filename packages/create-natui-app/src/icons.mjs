import { deflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const ICNS_ENTRIES = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
];

const CRC_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC_TABLE.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  CRC_TABLE[index] = value >>> 0;
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, payload) {
  const name = Buffer.from(type, 'ascii');
  const chunk = Buffer.allocUnsafe(12 + payload.length);
  chunk.writeUInt32BE(payload.length, 0);
  name.copy(chunk, 4);
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([name, payload])), 8 + payload.length);
  return chunk;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundedRectangleCoverage(x, y, size) {
  const center = size / 2;
  const half = size * 0.43;
  const radius = size * 0.19;
  const dx = Math.abs(x - center) - (half - radius);
  const dy = Math.abs(y - center) - (half - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  const distance = outside + inside - radius;
  return clamp(0.5 - distance);
}

function segmentCoverage(x, y, startX, startY, endX, endY, width) {
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  const lengthSquared = deltaX * deltaX + deltaY * deltaY;
  const position = clamp(
    ((x - startX) * deltaX + (y - startY) * deltaY) / lengthSquared,
  );
  const nearestX = startX + deltaX * position;
  const nearestY = startY + deltaY * position;
  return clamp(0.5 + width / 2 - Math.hypot(x - nearestX, y - nearestY));
}

function arcCoverage(x, y, centerX, centerY, radius, upperHalf, width) {
  const onArcSide = upperHalf ? y <= centerY : y >= centerY;
  const distance = onArcSide
    ? Math.abs(Math.hypot(x - centerX, y - centerY) - radius)
    : Math.min(
        Math.hypot(x - (centerX - radius), y - centerY),
        Math.hypot(x - (centerX + radius), y - centerY),
      );
  return clamp(0.5 + width / 2 - distance);
}

// The glyph geometry mirrors docs/public/icon.svg, drawn in its 501x490
// viewBox: a stroked "n" with two semicircular arches plus a dot.
function renderRgba(size, { fullSquare = false } = {}) {
  const pixels = Buffer.allocUnsafe(size * size * 4);
  const scale = (size * 0.5) / 501;
  const offsetX = (size - 501 * scale) / 2;
  const offsetY = (size - 490 * scale) / 2;
  const stroke = Math.max(1.5, 90 * scale);
  const leftX = offsetX + 45 * scale;
  const middleX = offsetX + 246 * scale;
  const rightX = offsetX + 445 * scale;
  const archTopY = offsetY + 145.5 * scale;
  const archBottomY = offsetY + 345.5 * scale;
  const rightStemTopY = offsetY + 245.5 * scale;
  const topArchCenterX = offsetX + 145.5 * scale;
  const bottomArchCenterX = offsetX + 345.5 * scale;
  const topArchRadius = 100.5 * scale;
  const bottomArchRadius = 99.5 * scale;
  const dotX = offsetX + 445.5 * scale;
  const dotY = offsetY + 99.5 * scale;
  const dotRadius = 55 * scale;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const pixelX = x + 0.5;
      const pixelY = y + 0.5;
      const background = fullSquare ? 1 : roundedRectangleCoverage(pixelX, pixelY, size);
      const glyphShape = Math.max(
        segmentCoverage(pixelX, pixelY, leftX, archTopY, leftX, archBottomY, stroke),
        arcCoverage(pixelX, pixelY, topArchCenterX, archTopY, topArchRadius, true, stroke),
        segmentCoverage(pixelX, pixelY, middleX, archTopY, middleX, archBottomY, stroke),
        arcCoverage(pixelX, pixelY, bottomArchCenterX, archBottomY, bottomArchRadius, false, stroke),
        segmentCoverage(pixelX, pixelY, rightX, rightStemTopY, rightX, archBottomY, stroke),
        clamp(0.5 + dotRadius - Math.hypot(pixelX - dotX, pixelY - dotY)),
      );
      const glyph = glyphShape * background;
      const verticalPosition = y / Math.max(1, size - 1);
      const red = Math.round(244 - verticalPosition * 41);
      const green = Math.round(112 - verticalPosition * 60);
      const blue = Math.round(74 - verticalPosition * 36);
      const offset = (y * size + x) * 4;
      pixels[offset] = Math.round(red + (255 - red) * glyph);
      pixels[offset + 1] = Math.round(green + (255 - green) * glyph);
      pixels[offset + 2] = Math.round(blue + (255 - blue) * glyph);
      pixels[offset + 3] = Math.round(background * 255);
    }
  }

  return pixels;
}

function createPng(size, options) {
  const rgba = renderRgba(size, options);
  const rowLength = size * 4;
  const raw = Buffer.allocUnsafe((rowLength + 1) * size);

  for (let y = 0; y < size; y += 1) {
    const rowOffset = y * (rowLength + 1);
    raw[rowOffset] = 0;
    rgba.copy(raw, rowOffset + 1, y * rowLength, (y + 1) * rowLength);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function createIconDib(size) {
  const rgba = renderRgba(size);
  const pixelBytes = size * size * 4;
  const maskStride = Math.ceil(size / 32) * 4;
  const maskBytes = maskStride * size;
  const dib = Buffer.alloc(40 + pixelBytes + maskBytes);

  dib.writeUInt32LE(40, 0);
  dib.writeInt32LE(size, 4);
  dib.writeInt32LE(size * 2, 8);
  dib.writeUInt16LE(1, 12);
  dib.writeUInt16LE(32, 14);
  dib.writeUInt32LE(0, 16);
  dib.writeUInt32LE(pixelBytes, 20);

  for (let y = 0; y < size; y += 1) {
    const sourceY = size - y - 1;
    const pixelRow = 40 + y * size * 4;
    const maskRow = 40 + pixelBytes + y * maskStride;

    for (let x = 0; x < size; x += 1) {
      const source = (sourceY * size + x) * 4;
      const target = pixelRow + x * 4;
      dib[target] = rgba[source + 2];
      dib[target + 1] = rgba[source + 1];
      dib[target + 2] = rgba[source];
      dib[target + 3] = rgba[source + 3];
      if (rgba[source + 3] < 128) {
        dib[maskRow + Math.floor(x / 8)] |= 1 << (7 - (x % 8));
      }
    }
  }

  return dib;
}

export function createWindowsIcon() {
  const images = ICO_SIZES.map((size) => ({
    size,
    payload: size === 256 ? createPng(size) : createIconDib(size),
  }));
  const directoryLength = 6 + images.length * 16;
  const output = Buffer.alloc(
    directoryLength + images.reduce((total, image) => total + image.payload.length, 0),
  );
  output.writeUInt16LE(0, 0);
  output.writeUInt16LE(1, 2);
  output.writeUInt16LE(images.length, 4);

  let payloadOffset = directoryLength;
  for (let index = 0; index < images.length; index += 1) {
    const { size, payload } = images[index];
    const offset = 6 + index * 16;
    output[offset] = size === 256 ? 0 : size;
    output[offset + 1] = size === 256 ? 0 : size;
    output[offset + 2] = 0;
    output[offset + 3] = 0;
    output.writeUInt16LE(1, offset + 4);
    output.writeUInt16LE(32, offset + 6);
    output.writeUInt32LE(payload.length, offset + 8);
    output.writeUInt32LE(payloadOffset, offset + 12);
    payload.copy(output, payloadOffset);
    payloadOffset += payload.length;
  }

  return output;
}

export function createMacIcon() {
  const pngBySize = new Map();
  const entries = ICNS_ENTRIES.map(([type, size]) => {
    let payload = pngBySize.get(size);
    if (!payload) {
      payload = createPng(size, { fullSquare: true });
      pngBySize.set(size, payload);
    }
    const entry = Buffer.allocUnsafe(8 + payload.length);
    entry.write(type, 0, 4, 'ascii');
    entry.writeUInt32BE(entry.length, 4);
    payload.copy(entry, 8);
    return entry;
  });
  const output = Buffer.allocUnsafe(8 + entries.reduce((total, entry) => total + entry.length, 0));
  output.write('icns', 0, 4, 'ascii');
  output.writeUInt32BE(output.length, 4);
  let offset = 8;
  for (const entry of entries) {
    entry.copy(output, offset);
    offset += entry.length;
  }
  return output;
}
