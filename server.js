// 喝了么 · 服务端（公网正式版基础：SQLite 存储 + 账号密码 + token 过期 + 注册限流）
// 零第三方依赖：node:http + node:sqlite；SSE 实时推送
// 运行：node server.js → http://localhost:3000（数据默认 data/data.db，可用 DATA_FILE 覆盖）
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = process.env.DATA_FILE || path.join(DATA_DIR, 'data.db');
const LEGACY_JSON = process.env.LEGACY_JSON || path.join(DATA_DIR, 'data.json');

const TOKEN_TTL_MS = Number(process.env.TOKEN_TTL_MS || 30 * 24 * 3600 * 1000);
const AUTH_RATE_PER_HOUR = Number(process.env.AUTH_RATE_PER_HOUR || 30); // 每 IP 每小时注册/登录尝试上限
const REGISTER_DAILY = Number(process.env.REGISTER_DAILY || 300); // 全局每日新账号上限

const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉易混的 0/O/1/I
const MIN_GOAL = 1;
const MAX_GOAL = 20;
const MAX_BODY = 1024 * 1024;
const MAX_FEED = 5000;

// 防打扰规则（正式默认值；测试/演示可用环境变量覆盖，见 README）
const CFG = {
  remindCooldownMs: Number(process.env.REMIND_COOLDOWN_MS || 10 * 60 * 1000),
  justDrankMs: Number(process.env.REMIND_JUST_DRANK_MS || 15 * 60 * 1000),
  dailyLimit: Number(process.env.REMIND_DAILY_LIMIT || 8),
};

const REMIND_TEXTS = [
  '别装没看见，起来喝水',
  '你的肾在向你求救',
  '再不动弹要变成咸鱼干了',
  '间歇性养生，持续性熬夜，先从喝水开始',
  '水都不喝，你改修仙了？',
  '你的水友提醒你：杯子空了，人别空',
  '快喝水，别让我催第二遍',
  '吨吨吨时间到，起来补补水',
];
// 自己喝水后自动邀请水友一起干杯（喝水即提醒，以身作则）
const NUDGE_TEXTS = [
  '我刚干了杯，该你了',
  '碰杯时间到，起来一起喝',
  '我都喝完了，别让我一个人努力',
  '这杯敬你，下一杯轮到你了',
  '吨吨吨，我刚喝了一杯，快跟上',
];
const REPLY_TEXTS = ['干了一杯，敬你', '已喝，债清了', '咕咚一声，杯数+1'];
const FRIEND_OK_TEXTS = ['从今天起，你俩互相盯喝水'];
const QUIET_DEFAULT = { manual: false, start: '23:00', end: '08:00' };

// ---------- SQLite 存储（内存态 + 事务快照落库） ----------
const j = (x) => JSON.stringify(x || {});
const unj = (s) => { try { return JSON.parse(s || '{}'); } catch { return {}; } };
function emptyStore() {
  return { users: [], tokens: {}, tokenExp: {}, drinks: [], friendships: [], reminds: [], feed: [] };
}
let store = emptyStore();
let db = null;

function openDb() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const d = new DatabaseSync(DB_FILE);
  d.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, nickname TEXT, avatar TEXT, inviteCode TEXT, dailyGoal INTEGER, quiet TEXT, passwordHash TEXT, createdAt TEXT);
    CREATE TABLE IF NOT EXISTS tokens(token TEXT PRIMARY KEY, userId TEXT, exp INTEGER);
    CREATE TABLE IF NOT EXISTS drinks(id TEXT PRIMARY KEY, userId TEXT, at TEXT, via TEXT, remindId TEXT);
    CREATE TABLE IF NOT EXISTS friendships(id TEXT PRIMARY KEY, userA TEXT, userB TEXT, by TEXT, status TEXT, at TEXT);
    CREATE TABLE IF NOT EXISTS reminds(id TEXT PRIMARY KEY, fromId TEXT, toId TEXT, at TEXT, text TEXT, repliedAt TEXT, repliedDrinkId TEXT, source TEXT);
    CREATE TABLE IF NOT EXISTS feed(id TEXT PRIMARY KEY, ts TEXT, type TEXT, fromId TEXT, toId TEXT, text TEXT, cups INTEGER, remindId TEXT, recipients TEXT, readBy TEXT, hiddenBy TEXT);
    CREATE INDEX IF NOT EXISTS idx_drinks_user ON drinks(userId);
    CREATE INDEX IF NOT EXISTS idx_feed_ts ON feed(ts);
  `);
  return d;
}
function dbSaveAll() {
  if (!db) db = openDb();
  const d = db;
  d.exec('BEGIN');
  try {
    d.exec('DELETE FROM users; DELETE FROM tokens; DELETE FROM drinks; DELETE FROM friendships; DELETE FROM reminds; DELETE FROM feed;');
    const insU = d.prepare('INSERT INTO users VALUES (?,?,?,?,?,?,?,?)');
    for (const u of store.users) insU.run(u.id, u.nickname || '', u.avatar || '', u.inviteCode || '', u.dailyGoal ?? 8, j(u.quiet), u.passwordHash || null, u.createdAt || '');
    const insT = d.prepare('INSERT INTO tokens VALUES (?,?,?)');
    for (const tk of Object.keys(store.tokens)) {
      const exp = store.tokenExp[tk] || (Date.now() + TOKEN_TTL_MS);
      if (exp > Date.now()) insT.run(tk, store.tokens[tk], exp);
    }
    const insD = d.prepare('INSERT INTO drinks VALUES (?,?,?,?,?)');
    for (const x of store.drinks) insD.run(x.id, x.userId, x.at, x.via || 'self', x.remindId || null);
    const insF = d.prepare('INSERT INTO friendships VALUES (?,?,?,?,?,?)');
    for (const x of store.friendships) insF.run(x.id, x.userA, x.userB, x.by || '', x.status, x.at || '');
    const insR = d.prepare('INSERT INTO reminds VALUES (?,?,?,?,?,?,?,?)');
    for (const x of store.reminds) insR.run(x.id, x.fromId, x.toId, x.at, x.text || '', x.repliedAt || null, x.repliedDrinkId || null, x.source || null);
    const insE = d.prepare('INSERT INTO feed VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    for (const x of store.feed) insE.run(x.id, x.ts, x.type, x.fromId || null, x.toId || null, x.text || null, x.cups ?? null, x.remindId || null, j(x.recipients), j(x.readBy), j(x.hiddenBy));
    d.exec('COMMIT');
  } catch (e) {
    try { d.exec('ROLLBACK'); } catch { /* 忽略 */ }
    throw e;
  }
}
function dbLoadAll() {
  db = openDb();
  store = emptyStore();
  const now = Date.now();
  for (const r of db.prepare('SELECT * FROM users').all()) {
    const u = {
      id: r.id, nickname: r.nickname || '', avatar: r.avatar || '',
      inviteCode: r.inviteCode || '', dailyGoal: r.dailyGoal ?? 8, createdAt: r.createdAt || '',
      quiet: unj(r.quiet),
    };
    if (!u.quiet || typeof u.quiet !== 'object') u.quiet = { ...QUIET_DEFAULT };
    if (!('start' in u.quiet) || !('end' in u.quiet) || !('manual' in u.quiet)) {
      u.quiet = { manual: !!u.quiet.manual, start: u.quiet.start || '23:00', end: u.quiet.end || '08:00' };
    }
    if (r.passwordHash) u.passwordHash = r.passwordHash;
    store.users.push(u);
  }
  for (const r of db.prepare('SELECT * FROM tokens').all()) {
    if (r.exp && r.exp > now) {
      store.tokens[r.token] = r.userId;
      store.tokenExp[r.token] = r.exp;
    }
  }
  for (const r of db.prepare('SELECT * FROM drinks').all()) store.drinks.push({ id: r.id, userId: r.userId, at: r.at, via: r.via || 'self', remindId: r.remindId });
  for (const r of db.prepare('SELECT * FROM friendships').all()) store.friendships.push({ id: r.id, userA: r.userA, userB: r.userB, by: r.by || '', status: r.status, at: r.at || '' });
  for (const r of db.prepare('SELECT * FROM reminds').all()) {
    store.reminds.push({ id: r.id, fromId: r.fromId, toId: r.toId, at: r.at, text: r.text || '', repliedAt: r.repliedAt, repliedDrinkId: r.repliedDrinkId, source: r.source });
  }
  for (const r of db.prepare('SELECT * FROM feed').all()) {
    store.feed.push({
      id: r.id, ts: r.ts, type: r.type, fromId: r.fromId, toId: r.toId, text: r.text,
      cups: r.cups, remindId: r.remindId, recipients: unj(r.recipients),
      readBy: unj(r.readBy), hiddenBy: unj(r.hiddenBy),
    });
  }
  pruneFeed();
}
function migrateLegacyJson(jsonPath) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8')); } catch { return false; }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.users)) return false;
  store.users = Array.isArray(raw.users) ? raw.users : [];
  store.tokens = (raw.tokens && typeof raw.tokens === 'object') ? raw.tokens : {};
  store.tokenExp = {};
  store.drinks = Array.isArray(raw.drinks) ? raw.drinks : [];
  store.friendships = Array.isArray(raw.friendships) ? raw.friendships : [];
  store.reminds = Array.isArray(raw.reminds) ? raw.reminds : [];
  store.feed = Array.isArray(raw.feed) ? raw.feed : [];
  for (const u of store.users) if (!u.quiet) u.quiet = { ...QUIET_DEFAULT };
  for (const tk of Object.keys(store.tokens)) store.tokenExp[tk] = Date.now() + TOKEN_TTL_MS;
  pruneFeed();
  return true;
}
function ensureStore() {
  if (fs.existsSync(DB_FILE)) {
    const head = fs.readFileSync(DB_FILE).subarray(0, 16).toString('latin1');
    if (head.startsWith('SQLite format 3')) { dbLoadAll(); return; }
    // 旧 JSON 文件（DATA_FILE 直接指到 json 的场景）原地迁移
    const bak = `${DB_FILE}.legacy-${Date.now()}.json`;
    try { fs.renameSync(DB_FILE, bak); } catch { /* 忽略 */ }
    if (migrateLegacyJson(bak)) console.log(`[store] 已从旧 JSON 迁移（${bak}）`);
    db = openDb();
    dbSaveAll();
    return;
  }
  // 全新库：默认路径时若存在旧 data.json 则自动导入一次
  if (DB_FILE !== LEGACY_JSON && fs.existsSync(LEGACY_JSON)) {
    if (migrateLegacyJson(LEGACY_JSON)) {
      console.log(`[store] 已从 ${LEGACY_JSON} 导入旧数据`);
      try { fs.renameSync(LEGACY_JSON, `${LEGACY_JSON}.migrated-${Date.now()}`); } catch { /* 忽略 */ }
    }
  }
  db = openDb();
  dbSaveAll();
}
function persist() { dbSaveAll(); }
function pruneFeed() {
  if (store.feed.length > MAX_FEED) store.feed.splice(0, store.feed.length - MAX_FEED);
}

// ---------- SSE 客户端 ----------
const sseClients = new Map(); // userId -> Set<res>
function pushToUsers(userIds, payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const uid of new Set(userIds)) {
    const set = sseClients.get(uid);
    if (!set) continue;
    for (const res of [...set]) {
      try { res.write(data); } catch { /* 连接已断，由 close 清理 */ }
    }
  }
}

// ---------- 工具 ----------
function pad2(n) { return String(n).padStart(2, '0'); }
function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function todayCount(userId) {
  const key = dayKey();
  return store.drinks.filter((x) => x.userId === userId && dayKey(new Date(x.at)) === key).length;
}
function drinkCountSince(userId, sinceMs) {
  return store.drinks.filter((x) => x.userId === userId && new Date(x.at).getTime() >= sinceMs).length;
}
function lastDrinkAt(userId) {
  let latest = null;
  for (const x of store.drinks) {
    if (x.userId === userId && (!latest || x.at > latest)) latest = x.at;
  }
  return latest;
}
function findUser(userId) { return store.users.find((u) => u.id === userId) || null; }
function userIdByToken(token) {
  if (!token) return null;
  const exp = store.tokenExp[token];
  if (exp && exp < Date.now()) return null; // 过期 token
  const id = store.tokens[token];
  return id && findUser(id) ? id : null;
}
function newToken(userId) {
  const token = crypto.randomUUID();
  store.tokens[token] = userId;
  store.tokenExp[token] = Date.now() + TOKEN_TTL_MS;
  return token;
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  if (!stored) return false;
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  try {
    const calc = crypto.scryptSync(pw, salt, 32);
    const exp = Buffer.from(hash, 'hex');
    return calc.length === exp.length && crypto.timingSafeEqual(calc, exp);
  } catch { return false; }
}
// 轻量防滥用：每 IP 每小时尝试上限 + 全局每日新账号上限（单进程内存）
const authHits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const rec = authHits.get(ip);
  if (!rec || now - rec.start > 3600e3) {
    authHits.set(ip, { start: now, n: 1 });
    return false;
  }
  rec.n += 1;
  return rec.n > AUTH_RATE_PER_HOUR;
}
let regDayKey = '';
let regCount = 0;
function registerAllowed() {
  const k = dayKey();
  if (k !== regDayKey) { regDayKey = k; regCount = 0; }
  regCount += 1;
  return regCount <= REGISTER_DAILY;
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
}
function makeInviteCode() {
  for (let i = 0; i < 50; i++) {
    let code = '';
    for (let j = 0; j < 6; j++) code += INVITE_ALPHABET[crypto.randomInt(INVITE_ALPHABET.length)];
    if (!store.users.some((u) => u.inviteCode === code)) return code;
  }
  return crypto.randomBytes(6).toString('hex').toUpperCase().slice(0, 6);
}
function pick(arr) { return arr[crypto.randomInt(arr.length)]; }
function publicUser(u) {
  return { id: u.id, nickname: u.nickname, avatar: u.avatar, inviteCode: u.inviteCode, dailyGoal: u.dailyGoal, createdAt: u.createdAt };
}
function friendIdsOf(uid) {
  return store.friendships
    .filter((f) => f.status === 'accepted' && (f.userA === uid || f.userB === uid))
    .map((f) => (f.userA === uid ? f.userB : f.userA));
}
function addFeed({ recipients, type, fromId = null, toId = null, text = null, cups = null, remindId = null }) {
  const item = {
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    type, // sys | urge | nudge | reply | drink
    fromId, toId, text, cups, remindId,
    recipients: [...new Set(recipients)],
    readBy: {},
    hiddenBy: {},
  };
  store.feed.push(item);
  pruneFeed();
  return item;
}

// ---------- 免打扰 ----------
function toMin(hhmm) {
  const [h, m] = String(hhmm || '00:00').split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}
function fmtHHMM(min) { return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`; }
function isQuietNow(user, d = new Date()) {
  const q = user.quiet || QUIET_DEFAULT;
  if (q.manual) return true;
  const now = d.getHours() * 60 + d.getMinutes();
  const s = toMin(q.start), e = toMin(q.end);
  if (s === e) return false;
  return s < e ? now >= s && now < e : now >= s || now < e; // 跨零点（如 23:00-08:00）
}
function quietDesc(user) {
  const q = user.quiet || QUIET_DEFAULT;
  return q.manual ? '对方开启了免打扰' : `对方在免打扰时段（${q.start}-${q.end}）`;
}

// ---------- HTTP 辅助 ----------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}
function tokenOf(req, url) {
  const h = req.headers['authorization'] || '';
  return h.startsWith('Bearer ') ? h.slice(7) : (url.searchParams.get('token') || '');
}
function mePayload(user) {
  const uid = user.id;
  const q = user.quiet || QUIET_DEFAULT;
  const openUrges = store.reminds
    .filter((r) => r.toId === uid && !r.repliedAt)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
    .slice(0, 10)
    .map((r) => ({
      id: r.id, at: r.at, text: r.text,
      kind: r.source === 'auto' ? 'nudge' : 'urge',
      from: publicUser(findUser(r.fromId)),
    }));
  return {
    user: publicUser(user),
    today: { date: dayKey(), count: todayCount(uid) },
    quiet: { manual: q.manual, start: q.start, end: q.end, active: isQuietNow(user) },
    pendingUrges: openUrges,
  };
}

// ---------- 业务逻辑 ----------
function getPair(a, b) {
  return store.friendships.find((f) => (f.userA === a && f.userB === b) || (f.userA === b && f.userB === a)) || null;
}
function lastRemind(fromId, toId) {
  // 只统计手动催喝（source!=='auto'），喝水自动邀请不占用手动催喝的冷却/额度
  const today = dayKey();
  const list = store.reminds.filter(
    (r) => r.fromId === fromId && r.toId === toId && r.source !== 'auto' && dayKey(new Date(r.at)) === today);
  list.sort((a, b) => (a.at < b.at ? 1 : -1));
  return list[0] || null;
}
function remindUrgeState(fromId, toId) {
  // 返回 { can, reason, remainMs } —— 判定顺序：免打扰 > 冷却 > 刚喝过 > 每日上限
  const target = findUser(toId);
  if (target && isQuietNow(target)) return { can: false, reason: 'QUIET' };
  const last = lastRemind(fromId, toId);
  if (last) {
    const remain = new Date(last.at).getTime() + CFG.remindCooldownMs - Date.now();
    if (remain > 0) return { can: false, reason: 'COOLDOWN', remainMs: remain };
  }
  const justDrank = drinkCountSince(toId, Date.now() - CFG.justDrankMs) > 0;
  if (justDrank) return { can: false, reason: 'JUST_DRANK' };
  const today = dayKey();
  const cnt = store.reminds.filter(
    (r) => r.fromId === fromId && r.toId === toId && r.source !== 'auto' && dayKey(new Date(r.at)) === today).length;
  if (cnt >= CFG.dailyLimit) return { can: false, reason: 'DAILY_LIMIT' };
  return { can: true };
}
function fmtRemain(ms) {
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  return m > 0 ? `${m} 分 ${s % 60} 秒` : `${s} 秒`;
}

// 打卡（self / reply）
function doDrink(uid, body) {
  const via = body.via === 'reply' ? 'reply' : 'self';
  let remind = null;
  if (via === 'reply') {
    const rid = body.remindId;
    remind = store.reminds.find((r) => r.id === rid);
    if (!remind || remind.toId !== uid) return { error: '回敬目标不存在', status: 400 };
    if (remind.repliedAt) return { error: '这杯已经回敬过了', status: 400, code: 'ALREADY_REPLIED' };
    remind.repliedAt = new Date().toISOString();
  }
  const at = new Date().toISOString();
  store.drinks.push({ id: crypto.randomUUID(), userId: uid, at, via, remindId: remind ? remind.id : null });
  const count = todayCount(uid);
  const me = findUser(uid);

  if (remind) {
    const item = addFeed({
      recipients: [remind.fromId],
      type: 'reply', fromId: uid, toId: remind.fromId,
      text: pick(REPLY_TEXTS), remindId: remind.id,
    });
    pushToUsers(item.recipients, {
      ev: 'reply', feedId: item.id, fromId: uid,
      fromName: me ? me.nickname : '', fromAvatar: me ? me.avatar : '',
    });
    return { count };
  }

  // 自己喝水：向"勾选的水友"发起碰杯邀请（喝水即提醒）
  // 不打扰的（没勾选/刚喝过/对方免打扰）只收到安静的喝水动态
  const friends = friendIdsOf(uid);
  const selected = Array.isArray(body.toIds) ? friends.filter((f) => body.toIds.includes(f)) : friends;
  const nudged = new Set();
  for (const fid of selected) {
    const fuser = findUser(fid);
    if (!fuser) continue;
    if (drinkCountSince(fid, Date.now() - CFG.justDrankMs) > 0) continue; // 刚喝过就不打扰
    if (isQuietNow(fuser)) continue; // 对方免打扰中，不推送（保留安静动态）
    const text = pick(NUDGE_TEXTS);
    store.reminds.push({
      id: crypto.randomUUID(), fromId: uid, toId: fid, at, text,
      repliedAt: null, repliedDrinkId: null, source: 'auto',
    });
    const remindObj = store.reminds[store.reminds.length - 1];
    const item = addFeed({
      recipients: [uid, fid], type: 'nudge', fromId: uid, toId: fid,
      text, remindId: remindObj.id,
    });
    nudged.add(fid);
    pushToUsers([fid], {
      ev: 'nudge', feedId: item.id, fromId: uid,
      fromName: me ? me.nickname : '', fromAvatar: me ? me.avatar : '',
    });
  }

  // 没被喊到的好友仍收到安静的喝水动态
  const passive = friends.filter((f) => !nudged.has(f));
  if (passive.length) {
    const item = addFeed({ recipients: passive, type: 'drink', fromId: uid, cups: count });
    pushToUsers(item.recipients, { ev: 'drink', feedId: item.id });
  }
  return { count };
}

// ---------- API 路由 ----------
async function handleApi(req, res, url, method) {
  const p = url.pathname;

  if (method === 'POST' && p === '/api/register') {
    const ip = clientIp(req);
    if (rateLimited(ip)) return sendJson(res, 429, { error: '操作太频繁，请稍后再试' });
    if (!registerAllowed()) return sendJson(res, 429, { error: '今日注册人数已满，明天再来吧' });
    const body = await readBody(req);
    const nickname = String(body.nickname || '').trim().slice(0, 16);
    if (!nickname) return sendJson(res, 400, { error: '昵称不能为空' });
    if (store.users.some((u) => u.nickname === nickname)) return sendJson(res, 409, { error: '这个昵称已经被用啦，换一个吧' });
    // 头像只允许普通字符/emoji key，去掉 HTML 元字符防注入
    const avatar = String(body.avatar || 'cup').replace(/[<>&"']/g, '').trim().slice(0, 12) || 'cup';
    const pw = body.password !== undefined ? String(body.password) : '';
    if (pw && pw.length < 6) return sendJson(res, 400, { error: '密码至少 6 位' });
    const user = {
      id: crypto.randomUUID(), nickname, avatar,
      inviteCode: makeInviteCode(), dailyGoal: 8, createdAt: new Date().toISOString(),
      quiet: { ...QUIET_DEFAULT },
    };
    if (pw) user.passwordHash = hashPassword(pw);
    store.users.push(user);
    const token = newToken(user.id);
    persist();
    return sendJson(res, 200, { user: publicUser(user), token });
  }

  if (method === 'POST' && p === '/api/login') {
    const ip = clientIp(req);
    if (rateLimited(ip)) return sendJson(res, 429, { error: '操作太频繁，请稍后再试' });
    const body = await readBody(req);
    const nickname = String(body.nickname || '').trim().slice(0, 16);
    const pw = String(body.password || '');
    const user = store.users.find((u) => u.nickname === nickname);
    if (!user) return sendJson(res, 401, { error: '昵称或密码不对' });
    if (!user.passwordHash) return sendJson(res, 403, { error: '该账号未设置密码（旧版测试号），请用新昵称重新注册' });
    if (!verifyPassword(pw, user.passwordHash)) return sendJson(res, 401, { error: '昵称或密码不对' });
    const token = newToken(user.id);
    persist();
    return sendJson(res, 200, { user: publicUser(user), token });
  }

  if (p === '/api/me') {
    const uid = userIdByToken(tokenOf(req, url));
    if (!uid) return sendJson(res, 401, { error: '未登录' });
    if (method === 'GET') return sendJson(res, 200, mePayload(findUser(uid)));
    if (method === 'PATCH') {
      const body = await readBody(req);
      const me = findUser(uid);
      if (body.dailyGoal !== undefined) {
        let goal = Math.round(Number(body.dailyGoal));
        if (!Number.isFinite(goal)) return sendJson(res, 400, { error: '目标杯数不合法' });
        me.dailyGoal = Math.min(MAX_GOAL, Math.max(MIN_GOAL, goal));
      }
      if (body.quiet !== undefined) {
        const q = body.quiet || {};
        const start = q.start !== undefined ? String(q.start) : me.quiet.start;
        const end = q.end !== undefined ? String(q.end) : me.quiet.end;
        const okTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
        if (!okTime(start) || !okTime(end)) return sendJson(res, 400, { error: '时间格式应为 HH:MM，如 23:00' });
        if (start === end) return sendJson(res, 400, { error: '开始与结束时间不能相同' });
        me.quiet = { manual: !!q.manual, start, end };
      }
      persist();
      return sendJson(res, 200, mePayload(me));
    }
    return sendJson(res, 405, { error: '不支持的请求方法' });
  }

  if (p === '/api/drinks' && method === 'POST') {
    const uid = userIdByToken(tokenOf(req, url));
    if (!uid) return sendJson(res, 401, { error: '未登录' });
    const body = await readBody(req);
    const r = doDrink(uid, body);
    if (r.error) return sendJson(res, r.status || 400, { error: r.error, code: r.code });
    persist();
    return sendJson(res, 200, { count: r.count });
  }

  // ---- 好友 ----
  if (p === '/api/friend/request' && method === 'POST') {
    const uid = userIdByToken(tokenOf(req, url));
    if (!uid) return sendJson(res, 401, { error: '未登录' });
    const body = await readBody(req);
    const code = String(body.code || '').trim().toUpperCase();
    const target = store.users.find((u) => u.inviteCode === code);
    if (!target) return sendJson(res, 404, { error: '邀请码不存在，检查一下是不是抄错了' });
    if (target.id === uid) return sendJson(res, 400, { error: '这是你自己的邀请码' });
    const pair = getPair(uid, target.id);
    if (pair) {
      if (pair.status === 'accepted') return sendJson(res, 400, { error: `你们已经是水友了` });
      if (pair.by === uid) return sendJson(res, 400, { error: '请求已发送，等对方同意吧' });
      // 反向 pending：直接转正
      pair.status = 'accepted';
      pair.at = new Date().toISOString();
      const item = addFeed({
        recipients: [uid, target.id], type: 'sys',
        text: pick(FRIEND_OK_TEXTS),
      });
      pushToUsers(item.recipients, { ev: 'sys', feedId: item.id });
      persist();
      return sendJson(res, 200, { autoAccepted: true });
    }
    store.friendships.push({
      id: crypto.randomUUID(), userA: uid, userB: target.id,
      by: uid, status: 'pending', at: new Date().toISOString(),
    });
    persist();
    pushToUsers([target.id], { ev: 'friend_req', from: uid });
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/friend/requests' && method === 'GET') {
    const uid = userIdByToken(tokenOf(req, url));
    if (!uid) return sendJson(res, 401, { error: '未登录' });
    const involved = (f) => f.userA === uid || f.userB === uid;
    const incoming = store.friendships
      .filter((f) => f.status === 'pending' && f.by !== uid && involved(f))
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .map((f) => ({ id: f.id, at: f.at, user: publicUser(findUser(f.by)) }));
    const outgoing = store.friendships
      .filter((f) => f.status === 'pending' && f.by === uid)
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .map((f) => ({ id: f.id, at: f.at, user: publicUser(findUser(f.userA === uid ? f.userB : f.userA)) }));
    return sendJson(res, 200, { incoming, outgoing });
  }

  if (p === '/api/friend/reply' && method === 'POST') {
    const uid = userIdByToken(tokenOf(req, url));
    if (!uid) return sendJson(res, 401, { error: '未登录' });
    const body = await readBody(req);
    const f = store.friendships.find((x) => x.id === body.id);
    const isInvolved = f && f.status === 'pending' && f.by !== uid && (f.userA === uid || f.userB === uid);
    if (!isInvolved) {
      return sendJson(res, 404, { error: '这条请求不存在或已处理' });
    }
    if (body.accept) {
      f.status = 'accepted';
      f.at = new Date().toISOString();
      const item = addFeed({
        recipients: [f.by, uid], type: 'sys', text: pick(FRIEND_OK_TEXTS),
      });
      pushToUsers(item.recipients, { ev: 'sys', feedId: item.id });
    } else {
      store.friendships = store.friendships.filter((x) => x.id !== f.id);
    }
    persist();
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/friends' && method === 'GET') {
    const uid = userIdByToken(tokenOf(req, url));
    if (!uid) return sendJson(res, 401, { error: '未登录' });
    const ids = friendIdsOf(uid);
    const today = dayKey();
    const out = ids.map((id) => {
      const u = findUser(id);
      const state = remindUrgeState(uid, id);
      // 今日互动小记：我手动催过几次、其中回敬了几次
      const mineToday = store.reminds.filter(
        (r) => r.fromId === uid && r.toId === id && dayKey(new Date(r.at)) === today);
      return {
        user: publicUser(u),
        todayCount: todayCount(id),
        lastDrinkAt: lastDrinkAt(id),
        urge: state,
        manualToday: mineToday.filter((r) => r.source !== 'auto').length,
        repliedToday: mineToday.filter((r) => r.repliedAt).length,
      };
    });
    out.sort((a, b) => (a.user.nickname < b.user.nickname ? -1 : 1));
    return sendJson(res, 200, { friends: out });
  }

  // ---- 催喝 ----
  if (p === '/api/reminds' && method === 'POST') {
    const uid = userIdByToken(tokenOf(req, url));
    if (!uid) return sendJson(res, 401, { error: '未登录' });
    const body = await readBody(req);
    const target = findUser(body.toId);
    if (!target) return sendJson(res, 404, { error: '目标水友不存在' });
    const pair = getPair(uid, target.id);
    if (!pair || pair.status !== 'accepted') return sendJson(res, 403, { error: '还不是水友，先加个好友' });
    const state = remindUrgeState(uid, target.id);
    if (!state.can) {
      const msg = state.reason === 'COOLDOWN' ? `催太密了，冷却 ${fmtRemain(state.remainMs)} 后再来`
        : state.reason === 'JUST_DRANK' ? 'TA 刚喝过，缓一缓再催'
        : state.reason === 'QUIET' ? `${quietDesc(target)}，稍后再约`
        : '今天已经催 TA 够多次了，明天见分晓';
      return sendJson(res, 400, { error: msg, code: state.reason, remainMs: state.remainMs });
    }
    const text = pick(REMIND_TEXTS);
    const remind = { id: crypto.randomUUID(), fromId: uid, toId: target.id, at: new Date().toISOString(), text, repliedAt: null, repliedDrinkId: null };
    store.reminds.push(remind);
    const item = addFeed({ recipients: [uid, target.id], type: 'urge', fromId: uid, toId: target.id, text, remindId: remind.id });
    pushToUsers(item.recipients, { ev: 'urge', feedId: item.id, fromId: uid });
    persist();
    return sendJson(res, 200, { ok: true, remind: { id: remind.id, text } });
  }

  // ---- 消息流 ----
  if (p === '/api/feed' && method === 'GET') {
    const uid = userIdByToken(tokenOf(req, url));
    if (!uid) return sendJson(res, 401, { error: '未登录' });
    const after = url.searchParams.get('after');
    const sinceTs = after ? new Date(Number(after) || after).getTime() : 0;
    let visible = store.feed.filter((it) => it.recipients.includes(uid) && !(it.hiddenBy && it.hiddenBy[uid]));
    if (sinceTs) visible = visible.filter((it) => new Date(it.ts).getTime() > sinceTs);
    let unread = 0;
    const items = visible.slice(-100).reverse().map((it) => {
      // 喝水动态只展示不打扰：不计入未读红点（催喝/碰杯/回敬/系统才需要注意力）
      const needAttention = it.type !== 'drink' && !it.readBy[uid] && it.fromId !== uid;
      if (needAttention) unread++;
      const mine = it.fromId === uid;
      let from = null;
      if (it.fromId) {
        const u = findUser(it.fromId);
        if (u) from = { nickname: u.nickname, avatar: u.avatar };
      }
      let toNick = null;
      if (it.toId) {
        const u = findUser(it.toId);
        if (u) toNick = u.nickname;
      }
      // 催喝/碰杯条目的「已回敬」状态存在 remind 记录里，需跨表关联
      const rem = (it.type === 'urge' || it.type === 'nudge') && it.remindId
        ? store.reminds.find((r) => r.id === it.remindId)
        : null;
      const replied = !!rem && !!rem.repliedAt;
      return {
        id: it.id, ts: it.ts, type: it.type, mine,
        from, toNick,
        text: it.text, cups: it.cups,
        replied,
        open: (it.type === 'urge' || it.type === 'nudge') && it.toId === uid && !replied,
        remindId: it.remindId,
        unread: needAttention,
      };
    });
    return sendJson(res, 200, { items, unread });
  }

  if (p === '/api/feed/read' && method === 'POST') {
    const uid = userIdByToken(tokenOf(req, url));
    if (!uid) return sendJson(res, 401, { error: '未登录' });
    const now = new Date().toISOString();
    for (const it of store.feed) {
      if (it.recipients.includes(uid) && it.fromId !== uid) it.readBy[uid] = now;
    }
    persist();
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/feed/clear' && method === 'POST') {
    // 清空我的消息视图：只隐藏我可见的条目，不影响对方那一侧的记录
    const uid = userIdByToken(tokenOf(req, url));
    if (!uid) return sendJson(res, 401, { error: '未登录' });
    const now = new Date().toISOString();
    for (const it of store.feed) {
      if (it.recipients.includes(uid) && !(it.hiddenBy && it.hiddenBy[uid])) it.hiddenBy[uid] = now;
    }
    persist();
    return sendJson(res, 200, { ok: true });
  }

  // ---- SSE ----
  if (p === '/api/events' && method === 'GET') {
    const uid = userIdByToken(tokenOf(req, url));
    if (!uid) return sendJson(res, 401, { error: '未登录' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    res.write(`data: ${JSON.stringify({ ev: 'hello' })}\n\n`);
    if (!sseClients.has(uid)) sseClients.set(uid, new Set());
    sseClients.get(uid).add(res);
    const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 25000);
    const cleanup = () => {
      clearInterval(heartbeat);
      const set = sseClients.get(uid);
      if (set) { set.delete(res); if (!set.size) sseClients.delete(uid); }
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    return undefined; // 连接保持
  }

  if (p === '/api/health') return sendJson(res, 200, { ok: true });
  return sendJson(res, 404, { error: '接口不存在' });
}

// ---------- 静态文件 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
function serveStatic(res, pathname) {
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) {
    return sendJson(res, 403, { error: '禁止访问' });
  }
  fs.readFile(file, (err, buf) => {
    if (err) return sendJson(res, 404, { error: '文件不存在' });
    const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}

// ---------- 启动 ----------
ensureStore();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const method = req.method;
  try {
    if (url.pathname.startsWith('/api/')) {
      if (!['GET', 'POST', 'PATCH'].includes(method)) return sendJson(res, 405, { error: '不支持的请求方法' });
      return await handleApi(req, res, url, method);
    }
    if (!['GET', 'HEAD'].includes(method)) return sendJson(res, 405, { error: '不支持的请求方法' });
    return serveStatic(res, url.pathname);
  } catch (err) {
    return sendJson(res, 400, { error: err.message || '请求处理失败' });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[喝了么] 端口 ${PORT} 已被占用，可用 PORT=3001 node server.js 换端口启动`);
    process.exit(1);
  }
  console.error(err);
});

server.listen(PORT, () => {
  console.log('');
  console.log('🥤 喝了么（M0+M1+M2）已启动');
  console.log(`   本机访问: http://localhost:${PORT}`);
  console.log(`   数据文件: ${DB_FILE}`);
  console.log(`   规则: 催喝冷却 ${CFG.remindCooldownMs / 1000}s / 刚喝过禁催 ${CFG.justDrankMs / 1000}s / 每日上限 ${CFG.dailyLimit} 次`);
  console.log('');
});
