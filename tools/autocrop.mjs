// 图片自动裁剪（透明边缘去除 + 少量留白）零依赖
// 用法：node tools/autocrop.mjs <输入.png> <输出.png> [padPx]
import fs from 'node:fs';
import zlib from 'node:zlib';

const [, , inPath, outPath, padArg] = process.argv;
if (!inPath || !outPath) {
  console.log('用法: node tools/autocrop.mjs <输入.png> <输出.png> [padPx]');
  process.exit(1);
}
const PAD = padArg ? Number(padArg) : 0;

function decodePNG(buf) {
  let off = 8, W = 0, H = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      W = data.readUInt32BE(0); H = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (interlace !== 0 || bitDepth !== 8 || colorType !== 6) throw new Error(`不支持的 PNG: ${bitDepth}bit/type${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = W * 4;
  const px = Buffer.alloc(H * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let yy = 0; yy < H; yy++) {
    const filter = raw[yy * (stride + 1)];
    const line = raw.subarray(yy * (stride + 1) + 1, (yy + 1) * (stride + 1));
    const out = px.subarray(yy * stride, (yy + 1) * stride);
    for (let xx = 0; xx < stride; xx++) {
      const a = xx >= 4 ? out[xx - 4] : 0;
      const b = yy > 0 ? px[(yy - 1) * stride + xx] : 0;
      const c = yy > 0 && xx >= 4 ? px[(yy - 1) * stride + xx - 4] : 0;
      let v = line[xx];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      out[xx] = v & 0xff;
    }
  }
  return { W, H, px };
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(...chunks) {
  let c = 0xffffffff;
  for (const ch of chunks) for (const b of ch) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(t, data));
  return Buffer.concat([len, t, data, crc]);
}
function encodePNG(W, H, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = W * 4;
  const raw = Buffer.alloc(H * (stride + 1));
  for (let yy = 0; yy < H; yy++) {
    raw[yy * (stride + 1)] = 0;
    px.copy(raw, yy * (stride + 1) + 1, yy * stride, (yy + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const { W, H, px } = decodePNG(fs.readFileSync(inPath));
let minX = W, maxX = 0, minY = H, maxY = 0;
for (let yy = 0; yy < H; yy++) {
  for (let xx = 0; xx < W; xx++) {
    if (px[(yy * W + xx) * 4 + 3] > 30) {
      if (xx < minX) minX = xx; if (xx > maxX) maxX = xx;
      if (yy < minY) minY = yy; if (yy > maxY) maxY = yy;
    }
  }
}
if (maxX < minX) throw new Error('图内没有不透明内容');
const x0 = Math.max(0, minX - PAD), y0 = Math.max(0, minY - PAD);
const x1 = Math.min(W, maxX + 1 + PAD), y1 = Math.min(H, maxY + 1 + PAD);
const cw = x1 - x0, ch = y1 - y0;
const out = Buffer.alloc(cw * ch * 4);
for (let yy = 0; yy < ch; yy++) {
  for (let xx = 0; xx < cw; xx++) {
    const s = ((y0 + yy) * W + (x0 + xx)) * 4;
    const d = (yy * cw + xx) * 4;
    out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; out[d + 3] = px[s + 3];
  }
}
fs.writeFileSync(outPath, encodePNG(cw, ch, out));
console.log(`内容范围 x[${minX}-${maxX}] y[${minY}-${maxY}] → 裁剪为 ${cw}x${ch} → ${outPath}`);
