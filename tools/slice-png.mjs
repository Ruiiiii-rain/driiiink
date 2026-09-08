// 手绘素材裁剪工具（零依赖）：从原图裁出矩形区域存为新 PNG
// 用法：node tools/slice-png.mjs <输入.png> <输出.png> <x> <y> <w> <h>
import fs from 'node:fs';
import zlib from 'node:zlib';

const [, , inPath, outPath, x, y, w, h] = process.argv;
if (!inPath || !outPath) {
  console.log('用法: node tools/slice-png.mjs <输入.png> <输出.png> <x> <y> <w> <h>');
  process.exit(1);
}

// ---------- 解码 ----------
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
  if (interlace !== 0 || bitDepth !== 8 || colorType !== 6) throw new Error(`不支持的 PNG: ${bitDepth}bit/type${colorType}/interlace${interlace}`);
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

// ---------- 编码 ----------
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

// ---------- 裁剪 ----------
const { W, H, px } = decodePNG(fs.readFileSync(inPath));
const sx = Number(x), sy = Number(y), sw = Number(w), sh = Number(h);
if (sx < 0 || sy < 0 || sx + sw > W || sy + sh > H) throw new Error(`裁剪越界: 图 ${W}x${H}，要裁 ${sx},${sy},${sw}x${sh}`);
const out = Buffer.alloc(sw * sh * 4);
for (let yy = 0; yy < sh; yy++) {
  for (let xx = 0; xx < sw; xx++) {
    const s = ((sy + yy) * W + (sx + xx)) * 4;
    const d = (yy * sw + xx) * 4;
    out[d] = px[s]; out[d + 1] = px[s + 1]; out[d + 2] = px[s + 2]; out[d + 3] = px[s + 3];
  }
}
fs.writeFileSync(outPath, encodePNG(sw, sh, out));
console.log(`已裁剪 ${sw}x${sh} → ${outPath}`);
