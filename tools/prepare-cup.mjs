// 手绘素材预处理（零依赖 PNG 编解码）
// 用法：node tools/prepare-cup.mjs <输入png> <输出png> [模式]
//   模式: both(默认)=抠白底+抠蓝水 | white=只抠白底(保留蓝色标记) | blue=只抠蓝水
import fs from 'node:fs';
import zlib from 'node:zlib';

const [, , inPath, outPath, modeArg] = process.argv;
const mode = modeArg || 'both';
if (!inPath || !outPath) {
  console.log('用法: node tools/prepare-cup.mjs <输入.png> <输出.png> [both|white|blue]');
  process.exit(1);
}

// ---------- PNG 解码 ----------
function decodePNG(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG');
  let off = 8, w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (interlace !== 0) throw new Error('暂不支持 interlaced PNG');
  if (bitDepth !== 8 || colorType !== 6) throw new Error(`仅支持 8bit RGBA（当前 ${bitDepth}bit/type${colorType}）`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = w * bpp;
  const px = Buffer.alloc(h * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < h; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? out[x - bpp] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = y > 0 && x >= bpp ? px[(y - 1) * stride + x - bpp] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      out[x] = v & 0xff;
    }
  }
  return { w, h, px };
}

// ---------- PNG 编码 ----------
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
function encodePNG(w, h, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 4;
  const raw = Buffer.alloc(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- 抠图规则 ----------
const { w, h, px } = decodePNG(fs.readFileSync(inPath));
let removedWhite = 0, removedBlue = 0, kept = 0;
for (let i = 0; i < px.length; i += 4) {
  const r = px[i], g = px[i + 1], b = px[i + 2], a = px[i + 3];
  if (a < 20) continue;
  const isWhite = r >= 240 && g >= 240 && b >= 240;             // 白纸底
  const isWaterBlue = b >= 130 && b >= r + 35 && g >= r + 5;    // 画的蓝色水（浅蓝系）
  const doWhite = mode !== 'blue';
  const doBlue = mode === 'both' || mode === 'blue';
  if (doWhite && isWhite) { px[i + 3] = 0; removedWhite++; }
  else if (doBlue && isWaterBlue) { px[i + 3] = 0; removedBlue++; }
  else kept++;
}
fs.writeFileSync(outPath, encodePNG(w, h, px));
console.log(`完成：${w}x${h}｜抠除白底 ${removedWhite}px｜抠除蓝水 ${removedBlue}px｜保留轮廓 ${kept}px → ${outPath}`);
