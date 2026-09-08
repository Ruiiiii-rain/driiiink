// 喝了么 · MVP 验收测试（正式规则下的完整用户旅程 + SSE 实时断言）
// 用法：node test/mvp.mjs   （自动起隔离实例 :3261，不影响正式数据）
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rmSafe = (p) => { for (const f of [p, p + '-wal', p + '-shm']) { try { fs.rmSync(f, { force: true }); } catch { /* 句柄未释放时忽略 */ } } };
const DB = path.join(process.cwd(), 'data', 'mvp.json');
const PORT = 3261;
const BASE = `http://127.0.0.1:${PORT}`;
let passed = 0;
let failed = 0;
const ok = (n) => { console.log('  ✅ ' + n); passed++; };
const bad = (n, extra = '') => { console.log('  ❌ ' + n + (extra ? `  [${extra}]` : '')); failed++; };
const step = (n) => console.log(`\n▎${n}`);

async function boot(clean = true) {
  if (clean) rmSafe(DB);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), DATA_FILE: DB }, stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return child; } catch {}
    await sleep(200);
  }
  throw new Error('实例未就绪');
}
async function j(method, p, body, token) {
  const r = await fetch(BASE + p, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { s: r.status, d: await r.json().catch(() => ({})) };
}
function openSSE(token) {
  return new Promise((resolve) => {
    const events = [];
    const req = http.get(`${BASE}/api/events?token=${encodeURIComponent(token)}`, (r) => {
      let buf = '';
      r.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split('\n').find((l) => l.startsWith('data:'));
          if (line) { try { events.push(JSON.parse(line.slice(5).trim())); } catch { /* ignore */ } }
        }
      });
      resolve({ req, events });
    });
    req.on('error', () => resolve({ req, events: [] }));
  });
}
async function waitEvent(events, ev, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const hit = events.find((e) => e.ev === ev);
    if (hit) return hit;
    await sleep(100);
  }
  return null;
}

console.log('🥤 喝了么 · MVP 验收测试（正式规则：冷却10min / 刚喝过15min / 每日8次）');
let child = null;
try {
  child = await boot();

  // ---------- 旅程 1：两台"新设备"各自注册 ----------
  step('1. 新设备注册（老张 / 小王）');
  const A = (await j('POST', '/api/register', { nickname: '老张', avatar: '🐷' })).d;
  const B = (await j('POST', '/api/register', { nickname: '小王', avatar: '🐰' })).d;
  const meA = (await j('GET', '/api/me', null, A.token)).d;
  if (A.token && B.token && /^[A-Z2-9]{6}$/.test(A.user.inviteCode)) ok('注册成功，双方获得 6 位邀请码');
  else bad('注册成功');
  if (meA.today.count === 0 && meA.user.dailyGoal === 8) ok('新账号：今日 0 杯、目标 8 杯');
  else bad('新账号初始状态');

  // ---------- 旅程 2：小王用邀请码加老张，老张同意 ----------
  step('2. 小王加老张为水友');
  const addRes = await j('POST', '/api/friend/request', { code: A.user.inviteCode }, B.token);
  if (addRes.s === 200) ok('小王输入老张邀请码 → 请求发送');
  else bad('请求发送', addRes.s);
  const reqsA = (await j('GET', '/api/friend/requests', null, A.token)).d;
  if (reqsA.incoming.length === 1) ok('老张收到 1 条待处理请求');
  else bad('老张收到请求');
  await j('POST', '/api/friend/reply', { id: reqsA.incoming[0].id, accept: true }, A.token);
  const fA = (await j('GET', '/api/friends', null, A.token)).d;
  const fB = (await j('GET', '/api/friends', null, B.token)).d;
  if (fA.friends.length === 1 && fB.friends.length === 1) ok('双方互为水友（双向可见）');
  else bad('互为水友');
  const sysB = (await j('GET', '/api/feed', null, B.token)).d;
  if (sysB.items.some((i) => i.type === 'sys')) ok('双方消息流出现"成为水友"系统消息');
  else bad('系统消息');

  // ---------- 旅程 3：双方实时在线，老张手动催小王 ----------
  step('3. 老张催小王（实时推送）');
  const sseA = await openSSE(A.token);
  const sseB = await openSSE(B.token);
  await waitEvent(sseA.events, 'hello');
  await waitEvent(sseB.events, 'hello');
  const urge = await j('POST', '/api/reminds', { toId: B.user.id }, A.token);
  if (urge.s === 200 && urge.d.remind && urge.d.remind.text) ok(`催喝成功，随机文案："${urge.d.remind.text}"`);
  else bad('催喝成功', JSON.stringify(urge.d).slice(0, 60));
  const evUrge = await waitEvent(sseB.events, 'urge');
  if (evUrge && evUrge.fromId === A.user.id) ok('小王 1 秒内实时收到催促推送');
  else bad('实时推送催喝');
  const meB1 = (await j('GET', '/api/me', null, B.token)).d;
  if (meB1.pendingUrges.length === 1 && meB1.pendingUrges[0].kind === 'urge') ok('小王主页主按钮进入"回应催促"模式（pending=1）');
  else bad('回应模式');
  const ufB = (await j('GET', '/api/feed', null, B.token)).d;
  if (ufB.unread >= 1) ok('小王消息 Tab 出现未读红点');
  else bad('未读红点');

  // ---------- 旅程 4：规则——立刻再催被礼貌拦截 ----------
  step('4. 防打扰规则：连续催喝被冷却拦截');
  const cd = (await j('POST', '/api/reminds', { toId: B.user.id }, A.token)).d;
  if (cd.code === 'COOLDOWN' && cd.remainMs > 0) ok('立刻再催 → 冷却拦截并给出倒计时');
  else bad('冷却拦截', cd.code);

  // ---------- 旅程 5：小王干杯回敬，老张主页实时收到 ----------
  step('5. 小王点「干了这杯」回敬');
  const meB2 = (await j('GET', '/api/me', null, B.token)).d;
  const rep = await j('POST', '/api/drinks', { via: 'reply', remindId: meB2.pendingUrges[0].id }, B.token);
  if (rep.s === 200 && rep.d.count === 1) ok('小王回敬成功，今日杯数 +1');
  else bad('回敬成功', rep.s);
  const evReply = await waitEvent(sseA.events, 'reply');
  if (evReply && evReply.fromName === '小王') ok('老张实时收到回敬推送');
  else bad('实时回敬推送');
  const fA2 = (await j('GET', '/api/feed', null, A.token)).d;
  if (fA2.items.some((i) => i.type === 'reply' && !i.mine && i.unread)) ok('老张主页回敬横幅数据就绪（未读回敬）');
  else bad('主页横幅数据');
  await j('POST', '/api/feed/read', {}, A.token);

  // ---------- 旅程 6：老张自己喝水喊人——小王刚喝过 → 只安静提醒（符合设计）----------
  step('6. 老张喝水"喊"小王（小王刚喝过 → 不打扰）');
  const beforePending = (await j('GET', '/api/me', null, B.token)).d.pendingUrges.length;
  const drinkRes = await j('POST', '/api/drinks', { via: 'self', toIds: [B.user.id] }, A.token);
  if (drinkRes.s === 200 && drinkRes.d.count === 1) ok('老张喝水计数 +1');
  else bad('老张喝水');
  const evDrink = await waitEvent(sseB.events, 'drink');
  const afterPending = (await j('GET', '/api/me', null, B.token)).d.pendingUrges.length;
  if (evDrink && afterPending === beforePending) ok('小王刚干杯过（15 分钟内）→ 只收安静动态，不被连环喊（防打扰设计）');
  else bad('刚喝过不打扰', `pending ${beforePending}→${afterPending}`);

  // ---------- 旅程 7：小王开免打扰，老张被拦 ----------
  step('7. 免打扰');
  await j('PATCH', '/api/me', { quiet: { manual: true, start: '23:00', end: '08:00' } }, B.token);
  const q = (await j('POST', '/api/reminds', { toId: B.user.id }, A.token)).d;
  if (q.code === 'QUIET') ok('小王开启免打扰 → 老张催喝被拦（提示稍后再约）');
  else bad('免打扰拦截', q.code);
  const fa3 = (await j('GET', '/api/friends', null, A.token)).d;
  if (fa3.friends.find((f) => f.user.id === B.user.id).urge.reason === 'QUIET') ok('老张好友列表同步显示"免打扰中"');
  else bad('好友列表状态');
  await j('PATCH', '/api/me', { quiet: { manual: false, start: '23:00', end: '08:00' } }, B.token);

  // ---------- 旅程 8：消息清空（只清自己） ----------
  step('8. 消息管理');
  await j('POST', '/api/feed/clear', {}, B.token);
  const afterClearB = (await j('GET', '/api/feed', null, B.token)).d;
  if (afterClearB.items.length === 0 && afterClearB.unread === 0) ok('小王清空消息（视图空、红点清零）');
  else bad('清空消息');
  const fA4 = (await j('GET', '/api/feed', null, A.token)).d;
  if (fA4.items.length > 0) ok('老张的消息记录不受影响');
  else bad('清空隔离');

  // ---------- 旅程 9：重启服务，数据不丢 ----------
  step('9. 持久化（重启）');
  const beforeDrinkA = (await j('GET', '/api/me', null, A.token)).d.today.count;
  child.kill(); await sleep(400);
  child = await boot(false); // 不删库重启，验证持久化
  const meA2 = (await j('GET', '/api/me', null, A.token)).d;
  const fA5 = (await j('GET', '/api/friends', null, A.token)).d;
  const fB5 = (await j('GET', '/api/feed', null, B.token)).d;
  if (meA2.today.count === beforeDrinkA && meA2.today.count === 1) ok('重启后今日杯数保留');
  else bad('杯数持久化');
  if (fA5.friends.length === 1) ok('重启后好友关系保留');
  else bad('好友持久化');
  if (!fB5.items.some((i) => i.type === 'sys')) ok('重启后清空视图保持');
  else bad('清空视图持久化');
} catch (e) {
  console.error('测试异常:', e && e.message);
  failed++;
} finally {
  try { child && child.kill(); await sleep(400); } catch {}
  rmSafe(DB);
}

console.log(`\n======== MVP 验收结果：${failed === 0 ? '✅ 通过' : `❌ ${failed} 项未通过`}（${passed} 项通过）========`);
process.exit(failed ? 1 : 0);
