const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const assetsDir = path.join(root, 'assets');
const iconsetDir = path.join(assetsDir, 'icon.iconset');

fs.mkdirSync(assetsDir, { recursive: true });

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBuffer = Buffer.from(type);
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);

  length.writeUInt32BE(data.length, 0);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);

  return Buffer.concat([length, typeBuffer, data, crc]);
}

function mix(a, b, t) {
  return Math.round(a + (b - a) * t);
}

function smoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function ellipseAlpha(x, y, cx, cy, rx, ry, feather) {
  const d = Math.sqrt(((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2);
  return 1 - smoothstep(1 - feather, 1, d);
}

function drawIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const bgA = [17, 38, 72];
  const bgB = [13, 78, 118];
  const cloudA = [230, 246, 255];
  const cloudB = [93, 177, 236];
  const cloudC = [36, 108, 180];

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const nx = x / (size - 1);
      const ny = y / (size - 1);
      const dx = nx - 0.48;
      const dy = ny - 0.36;
      const radial = Math.max(0, Math.min(1, Math.sqrt(dx * dx + dy * dy) * 1.8));
      const vignette = smoothstep(0.62, 0.98, Math.sqrt((nx - 0.5) ** 2 + (ny - 0.5) ** 2) * 1.55);
      const idx = (y * size + x) * 4;

      rgba[idx] = Math.max(0, mix(bgB[0], bgA[0], radial) - vignette * 16);
      rgba[idx + 1] = Math.max(0, mix(bgB[1], bgA[1], radial) - vignette * 16);
      rgba[idx + 2] = Math.max(0, mix(bgB[2], bgA[2], radial) - vignette * 16);
      rgba[idx + 3] = 255;

      const ring = Math.abs(Math.sqrt((nx - 0.5) ** 2 + (ny - 0.5) ** 2) - 0.37);
      const ringAlpha = (1 - smoothstep(0.012, 0.03, ring)) * 0.34;
      if (ringAlpha > 0) {
        rgba[idx] = mix(rgba[idx], 134, ringAlpha);
        rgba[idx + 1] = mix(rgba[idx + 1], 207, ringAlpha);
        rgba[idx + 2] = mix(rgba[idx + 2], 255, ringAlpha);
      }

      const cloud =
        ellipseAlpha(nx, ny, 0.34, 0.58, 0.21, 0.13, 0.18) * 0.9 +
        ellipseAlpha(nx, ny, 0.49, 0.52, 0.25, 0.18, 0.16) +
        ellipseAlpha(nx, ny, 0.66, 0.59, 0.22, 0.13, 0.18) * 0.82 +
        ellipseAlpha(nx, ny, 0.5, 0.66, 0.34, 0.13, 0.2) * 0.84;

      const cloudAlpha = Math.min(1, cloud);
      if (cloudAlpha > 0) {
        const shade = Math.max(0, Math.min(1, (ny - 0.42) * 2.2));
        const r = mix(cloudA[0], cloudB[0], shade);
        const g = mix(cloudA[1], cloudB[1], shade);
        const b = mix(cloudA[2], cloudB[2], shade);
        rgba[idx] = mix(rgba[idx], r, cloudAlpha);
        rgba[idx + 1] = mix(rgba[idx + 1], g, cloudAlpha);
        rgba[idx + 2] = mix(rgba[idx + 2], b, cloudAlpha);
      }

      const shadow = ellipseAlpha(nx, ny, 0.52, 0.72, 0.3, 0.07, 0.45) * 0.28;
      if (shadow > 0) {
        rgba[idx] = mix(rgba[idx], cloudC[0], shadow);
        rgba[idx + 1] = mix(rgba[idx + 1], cloudC[1], shadow);
        rgba[idx + 2] = mix(rgba[idx + 2], cloudC[2], shadow);
      }
    }
  }

  return rgba;
}

function pngBuffer(size) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const rgba = drawIcon(size);
  const scanlines = Buffer.alloc((size * 4 + 1) * size);

  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (size * 4 + 1);
    scanlines[rowStart] = 0;
    rgba.copy(scanlines, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function writePng(filePath, size) {
  const png = pngBuffer(size);
  fs.writeFileSync(filePath, png);
  return png;
}

function writeIco(filePath) {
  const sizes = [16, 32, 48, 256];
  const images = sizes.map(size => ({ size, data: pngBuffer(size) }));
  const headerSize = 6 + images.length * 16;
  const header = Buffer.alloc(headerSize);
  let offset = headerSize;

  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  images.forEach((image, index) => {
    const pos = 6 + index * 16;
    header[pos] = image.size === 256 ? 0 : image.size;
    header[pos + 1] = image.size === 256 ? 0 : image.size;
    header[pos + 2] = 0;
    header[pos + 3] = 0;
    header.writeUInt16LE(1, pos + 4);
    header.writeUInt16LE(32, pos + 6);
    header.writeUInt32LE(image.data.length, pos + 8);
    header.writeUInt32LE(offset, pos + 12);
    offset += image.data.length;
  });

  fs.writeFileSync(filePath, Buffer.concat([header, ...images.map(image => image.data)]));
}

function writeIcns() {
  if (process.platform !== 'darwin') return false;

  fs.rmSync(iconsetDir, { recursive: true, force: true });
  fs.mkdirSync(iconsetDir, { recursive: true });

  const sizes = [
    ['icon_16x16.png', 16],
    ['icon_16x16@2x.png', 32],
    ['icon_32x32.png', 32],
    ['icon_32x32@2x.png', 64],
    ['icon_128x128.png', 128],
    ['icon_128x128@2x.png', 256],
    ['icon_256x256.png', 256],
    ['icon_256x256@2x.png', 512],
    ['icon_512x512.png', 512],
    ['icon_512x512@2x.png', 1024]
  ];

  for (const [fileName, size] of sizes) {
    writePng(path.join(iconsetDir, fileName), size);
  }

  const result = childProcess.spawnSync('iconutil', ['-c', 'icns', iconsetDir, '-o', path.join(assetsDir, 'icon.icns')], {
    stdio: 'inherit'
  });

  fs.rmSync(iconsetDir, { recursive: true, force: true });
  return result.status === 0;
}

writePng(path.join(assetsDir, 'icon.png'), 1024);
writeIco(path.join(assetsDir, 'icon.ico'));

const wroteIcns = writeIcns();
console.log(`Generated assets/icon.png and assets/icon.ico${wroteIcns ? ' and assets/icon.icns' : ''}.`);
