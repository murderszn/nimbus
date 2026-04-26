const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const root = path.resolve(__dirname, '..');
const assetsDir = path.join(root, 'assets');
const sourcePath = path.join(assetsDir, 'icon-source.png');
const iconsetDir = path.join(assetsDir, 'icon.iconset');

fs.mkdirSync(assetsDir, { recursive: true });

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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

function paethPredictor(left, up, upperLeft) {
  const p = left + up - upperLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upperLeft);

  if (pa <= pb && pa <= pc) return left;
  if (pb <= pc) return up;
  return upperLeft;
}

function unfilter(row, previousRow, filter, bytesPerPixel) {
  for (let i = 0; i < row.length; i += 1) {
    const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0;
    const up = previousRow[i] ?? 0;
    const upperLeft = i >= bytesPerPixel ? previousRow[i - bytesPerPixel] : 0;
    let predictor = 0;

    if (filter === 1) predictor = left;
    else if (filter === 2) predictor = up;
    else if (filter === 3) predictor = Math.floor((left + up) / 2);
    else if (filter === 4) predictor = paethPredictor(left, up, upperLeft);
    else if (filter !== 0) throw new Error(`Unsupported PNG filter type: ${filter}`);

    row[i] = (row[i] + predictor) & 0xff;
  }
}

function colorChannels(colorType) {
  if (colorType === 2) return 3;
  if (colorType === 6) return 4;
  throw new Error(`Unsupported PNG color type: ${colorType}. Expected truecolor RGB or RGBA.`);
}

function readPng(filePath) {
  const file = fs.readFileSync(filePath);

  if (!file.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error(`${path.relative(root, filePath)} is not a PNG file.`);
  }

  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let compression = 0;
  let filterMethod = 0;
  let interlace = 0;
  const idatChunks = [];

  while (offset < file.length) {
    const length = file.readUInt32BE(offset);
    const type = file.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const data = file.subarray(dataStart, dataEnd);

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      compression = data[10];
      filterMethod = data[11];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }

    offset = dataEnd + 4;
  }

  if (!width || !height || idatChunks.length === 0) {
    throw new Error(`${path.relative(root, filePath)} is missing required PNG data.`);
  }

  if (bitDepth !== 8 || compression !== 0 || filterMethod !== 0 || interlace !== 0) {
    throw new Error(`${path.relative(root, filePath)} must be an 8-bit, non-interlaced PNG.`);
  }

  const channels = colorChannels(colorType);
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
  const rgba = Buffer.alloc(width * height * 4);
  let readOffset = 0;
  let previousRow = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[readOffset];
    const row = Buffer.from(raw.subarray(readOffset + 1, readOffset + 1 + stride));

    unfilter(row, previousRow, filter, channels);

    for (let x = 0; x < width; x += 1) {
      const sourceIndex = x * channels;
      const targetIndex = (y * width + x) * 4;

      rgba[targetIndex] = row[sourceIndex];
      rgba[targetIndex + 1] = row[sourceIndex + 1];
      rgba[targetIndex + 2] = row[sourceIndex + 2];
      rgba[targetIndex + 3] = channels === 4 ? row[sourceIndex + 3] : 255;
    }

    previousRow = row;
    readOffset += stride + 1;
  }

  return { width, height, rgba };
}

function samplePixel(image, x, y) {
  const clampedX = Math.max(0, Math.min(image.width - 1, x));
  const clampedY = Math.max(0, Math.min(image.height - 1, y));
  const index = (clampedY * image.width + clampedX) * 4;

  return [
    image.rgba[index],
    image.rgba[index + 1],
    image.rgba[index + 2],
    image.rgba[index + 3]
  ];
}

function resizeBilinear(image, size, cropX, cropY, cropSize) {
  const output = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    const sourceY = cropY + ((y + 0.5) * cropSize) / size - 0.5;
    const y0 = Math.floor(sourceY);
    const y1 = y0 + 1;
    const yWeight = sourceY - y0;

    for (let x = 0; x < size; x += 1) {
      const sourceX = cropX + ((x + 0.5) * cropSize) / size - 0.5;
      const x0 = Math.floor(sourceX);
      const x1 = x0 + 1;
      const xWeight = sourceX - x0;
      const samples = [
        [samplePixel(image, x0, y0), (1 - xWeight) * (1 - yWeight)],
        [samplePixel(image, x1, y0), xWeight * (1 - yWeight)],
        [samplePixel(image, x0, y1), (1 - xWeight) * yWeight],
        [samplePixel(image, x1, y1), xWeight * yWeight]
      ];
      const targetIndex = (y * size + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (const [sample, weight] of samples) {
        const alpha = (sample[3] / 255) * weight;
        r += sample[0] * alpha;
        g += sample[1] * alpha;
        b += sample[2] * alpha;
        a += alpha;
      }

      output[targetIndex + 3] = Math.round(a * 255);
      if (a > 0) {
        output[targetIndex] = Math.round(r / a);
        output[targetIndex + 1] = Math.round(g / a);
        output[targetIndex + 2] = Math.round(b / a);
      }
    }
  }

  return output;
}

function resizeArea(image, size, cropX, cropY, cropSize) {
  const output = Buffer.alloc(size * size * 4);

  for (let y = 0; y < size; y += 1) {
    const sourceY0 = cropY + (y * cropSize) / size;
    const sourceY1 = cropY + ((y + 1) * cropSize) / size;
    const yStart = Math.max(0, Math.floor(sourceY0));
    const yEnd = Math.min(image.height, Math.ceil(sourceY1));

    for (let x = 0; x < size; x += 1) {
      const sourceX0 = cropX + (x * cropSize) / size;
      const sourceX1 = cropX + ((x + 1) * cropSize) / size;
      const xStart = Math.max(0, Math.floor(sourceX0));
      const xEnd = Math.min(image.width, Math.ceil(sourceX1));
      const targetIndex = (y * size + x) * 4;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let totalWeight = 0;

      for (let sourceY = yStart; sourceY < yEnd; sourceY += 1) {
        const yWeight = Math.min(sourceY1, sourceY + 1) - Math.max(sourceY0, sourceY);
        if (yWeight <= 0) continue;

        for (let sourceX = xStart; sourceX < xEnd; sourceX += 1) {
          const xWeight = Math.min(sourceX1, sourceX + 1) - Math.max(sourceX0, sourceX);
          if (xWeight <= 0) continue;

          const weight = xWeight * yWeight;
          const sourceIndex = (sourceY * image.width + sourceX) * 4;
          const alpha = (image.rgba[sourceIndex + 3] / 255) * weight;

          r += image.rgba[sourceIndex] * alpha;
          g += image.rgba[sourceIndex + 1] * alpha;
          b += image.rgba[sourceIndex + 2] * alpha;
          a += alpha;
          totalWeight += weight;
        }
      }

      const alpha = totalWeight > 0 ? a / totalWeight : 0;
      output[targetIndex + 3] = Math.round(alpha * 255);
      if (a > 0) {
        output[targetIndex] = Math.round(r / a);
        output[targetIndex + 1] = Math.round(g / a);
        output[targetIndex + 2] = Math.round(b / a);
      }
    }
  }

  return output;
}

function resizeToSquare(image, size) {
  const cropSize = Math.min(image.width, image.height);
  const cropX = (image.width - cropSize) / 2;
  const cropY = (image.height - cropSize) / 2;

  if (cropSize >= size) {
    return resizeArea(image, size, cropX, cropY, cropSize);
  }

  return resizeBilinear(image, size, cropX, cropY, cropSize);
}

function pngBuffer(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  const scanlines = Buffer.alloc((width * 4 + 1) * height);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1);
    scanlines[rowStart] = 0;
    rgba.copy(scanlines, rowStart + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function iconPngBuffer(sourceImage, size) {
  return pngBuffer(size, size, resizeToSquare(sourceImage, size));
}

function writePng(filePath, sourceImage, size) {
  const png = iconPngBuffer(sourceImage, size);
  fs.writeFileSync(filePath, png);
  return png;
}

function writeIco(filePath, sourceImage) {
  const sizes = [16, 32, 48, 256];
  const images = sizes.map(size => ({ size, data: iconPngBuffer(sourceImage, size) }));
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

function writeIcns(sourceImage) {
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
    writePng(path.join(iconsetDir, fileName), sourceImage, size);
  }

  const result = childProcess.spawnSync('iconutil', ['-c', 'icns', iconsetDir, '-o', path.join(assetsDir, 'icon.icns')], {
    stdio: 'inherit'
  });

  fs.rmSync(iconsetDir, { recursive: true, force: true });

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`iconutil exited with status ${result.status}.`);

  return true;
}

function writeWebIcons(sourceImage) {
  const sizes = [
    ['favicon-16.png', 16],
    ['favicon-32.png', 32],
    ['favicon-48.png', 48],
    ['apple-touch-icon.png', 180],
    ['icon-192.png', 192],
    ['icon-512.png', 512]
  ];

  for (const [fileName, size] of sizes) {
    writePng(path.join(assetsDir, fileName), sourceImage, size);
  }
}

function writeWebManifest() {
  const manifest = {
    name: 'Nimbus Pomodoro Timer',
    short_name: 'Nimbus',
    description: 'A polished Pomodoro timer for focused work sessions with session tracking, metrics, and desktop builds.',
    start_url: '../pomodoro-cloud-v2.html',
    scope: '../',
    display: 'standalone',
    background_color: '#061a3d',
    theme_color: '#061a3d',
    icons: [
      {
        src: './icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any maskable'
      },
      {
        src: './icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable'
      }
    ]
  };

  fs.writeFileSync(path.join(assetsDir, 'site.webmanifest'), `${JSON.stringify(manifest, null, 2)}\n`);
}

if (!fs.existsSync(sourcePath)) {
  console.error(`Missing ${path.relative(root, sourcePath)}. Generate or add a square source PNG before running this script.`);
  process.exit(1);
}

const sourceImage = readPng(sourcePath);

writePng(path.join(assetsDir, 'icon.png'), sourceImage, 1024);
writeIco(path.join(assetsDir, 'icon.ico'), sourceImage);
writeWebIcons(sourceImage);
writeWebManifest();

const wroteIcns = writeIcns(sourceImage);
console.log(`Generated desktop and web icons${wroteIcns ? ', including assets/icon.icns,' : ''} from assets/icon-source.png.`);
