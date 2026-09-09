// 手绘素材"失误笔迹"清理：02 相对相邻模板独有且为深色的连通墨迹 → 抹为透明
// 用法：node tools/stray-erase.mjs <目标.png> <邻图A.png> [邻图B.png] [输出.png]
import fs from 'node:fs';
import zlib from 'node:zlib';

const [, , target, refA, refB, outArg] = process.argv;
const OUT = outArg || target;

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
  if (interlace !== 0 || bitDepth !== 8 || colorType !== 6) throw new Error(`不支持 PNG ${bitDepth}/${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = W * 4;
  const px = Buffer.alloc(H * stride);
  const paeth = (a, b, c) => {
    const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < H; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = px.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[x - 4] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = y > 0 && x >= 4 ? px[(y - 1) * stride + x - 4] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      out[x] = v & 0xff;
    }
  }
  return { W, H, px };
}
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
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
  ihdr[8] = 8; ihdr[9] = 6;
  const stride = W * 4;
  const raw = Buffer.alloc(H * (stride + 1));
  for (let y = 0; y < H; y++) { raw[y * (stride + 1)] = 0; px.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- 深色掩码 ----
function darkMask(img) {
  const { W, H, px } = img;
  const m = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      if (px[i + 3] > 50 && px[i] < 130 && px[i + 1] < 130 && px[i + 2] < 130) m[y * W + x] = 1;
    }
  }
  return m;
}
function dilated(m, W, H, radius) {
  const out = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let hit = false;
      for (let dy = -radius; dy <= radius && !hit; dy++) {
        for (let dx = -radius; dx <= radius && !hit; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy >= 0 && yy < H && xx >= 0 && xx < W && m[yy * W + xx]) hit = true;
        }
      }
      out[y * W + x] = hit ? 1 : 0;
    }
  }
  return out;
}

const imgT = decodePNG(fs.readFileSync(target));
const refs = [refA, refB].filter(Boolean).map((p) => darkMask(decodePNG(fs.readFileSync(p))));
const { W, H } = imgT;
const darkT = darkMask(imgT);
// 深色但邻图 3px 内都没有同色像素 → 疑似失误笔迹
let stray = Buffer.alloc(W * H);
for (const rm of refs) {
  const rD = dilated(rm, W, H, 3);
  for (let i = 0; i < W * H; i++) if (darkT[i] && !rD[i]) stray[i] = 1;
}
if (refs.length === 1) {
  // 只有一个参照时保留全深色为候选（调用方已保证参照同模板）
  stray = Buffer.from(darkT);
}
// 连通域
const visited = Buffer.alloc(W * H);
const clusters = [];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const idx = y * W + x;
    if (!stray[idx] || visited[idx]) continue;
    // BFS
    const stack = [[x, y]];
    visited[idx] = 1;
    let minX = x, maxX = x, minY = y, maxY = y, n = 0;
    while (stack.length) {
      const [cx, cy] = stack.pop();
      n++;
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy; if (cy > maxY) maxY = cy;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx, ny = cy + dy;
          if (nx >= 0 && nx < W && ny >= 0 && ny < H) {
            const ni = ny * W + nx;
            if (stray[ni] && !visited[ni]) { visited[ni] = 1; stack.push([nx, ny]); }
          }
        }
      }
    }
    clusters.push({ minX, maxX, minY, maxY, n });
  }
}
// 只处理"中等大小"的墨迹（线/圈），排除极小噪点与极端大块
const targets = clusters.filter((c) => c.n >= 25 && c.n <= 30000);
console.log(`深色差异连通域 ${clusters.length} 个；将抹除 ${targets.length} 个：`);
for (const c of targets) console.log(`  box x[${c.minX}-${c.maxX}] y[${c.minY}-${c.maxY}] 像素${c.n}`);

if (targets.length) {
  const erase = Buffer.alloc(W * H);
  for (const c of targets) {
    for (let y = c.minY - 1; y <= c.maxY + 1; y++) {
      for (let x = c.minX - 1; x <= c.maxX + 1; x++) {
        if (y >= 0 && y < H && x >= 0 && x < W) erase[y * W + x] = 1;
      }
    }
  }
  for (let i = 0; i < W * H; i++) if (erase[i]) imgT.px[i * 4 + 3] = 0;
  fs.writeFileSync(OUT, encodePNG(W, H, imgT.px));
  console.log(`已抹除并写出 ${OUT}`);
} else {
  console.log('未发现疑似失误笔迹（或笔迹与邻图重叠），未修改');
}
