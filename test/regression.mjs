// 喝了么 · 回归测试：node test/regression.mjs
// 覆盖注册/好友/勾选喊人/催喝回敬/免打扰/清空/筛选数据/重启持久化；用快速规则跑，与正式默认无关
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rmSafe = (p) => { for (const f of [p, p + '-wal', p + '-shm']) { try { fs.rmSync(f, { force: true }); } catch { /* 句柄未释放时忽略 */ } } };
let failed = 0;
const check = (n, c, extra = '') => {
  console.log((c ? '✅' : '❌') + ' ' + n + (extra ? ` [${extra}]` : ''));
  if (!c) failed++;
};
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (min) => `${pad(Math.floor((((min % 1440) + 1440) % 1440) / 60))}:${pad(((min % 1440) + 1440) % 60)}`;
const DB = path.join(process.cwd(), 'data', 'regression.json');
const PORT = 3251;

async function boot(clean = true) {
  if (clean) rmSafe(DB);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(), env: { ...process.env, PORT: String(PORT), DATA_FILE: DB, LEGACY_JSON: DB + '.nol.json', REMIND_COOLDOWN_MS: '0', REMIND_JUST_DRANK_MS: '0' }, stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/api/health`)).ok) return child; } catch {}
    await sleep(200);
  }
  throw new Error('实例未就绪');
}
async function j(method, p, body, token) {
  const r = await fetch(`http://127.0.0.1:${PORT}` + p, {
    method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { s: r.status, d: await r.json().catch(() => ({})) };
}
let child = null;
try {
  child = await boot();
  // ---- 注册 + 输入清洗 ----
  const A = (await j('POST', '/api/register', { nickname: '甲', avatar: '🐷' })).d;
  const B = (await j('POST', '/api/register', { nickname: '乙', avatar: '🐰' })).d;
  const C = (await j('POST', '/api/register', { nickname: '丙', avatar: '🐸' })).d;
  const D = (await j('POST', '/api/register', { nickname: '丁', avatar: '🐨' })).d;
  const inj = (await j('POST', '/api/register', { nickname: '注入', avatar: '<img onerror=1>' })).d;
  check('注册四人成功', !!(A.token && B.token && C.token && D.token));
  check('头像 HTML 清洗', !(inj.user.avatar || '').includes('<'));
  check('邀请码 6 位格式', [A, B, C, D].every((u) => /^[A-Z2-9]{6}$/.test(u.user.inviteCode)));
  const ta = A.token, tb = B.token, tc = C.token, td = D.token;

  const addF = async (from, toToken, toUser) => {
    await j('POST', '/api/friend/request', { code: toUser.inviteCode }, from);
    const reqs = (await j('GET', '/api/friend/requests', null, toToken)).d;
    await j('POST', '/api/friend/reply', { id: reqs.incoming[0].id, accept: true }, toToken);
  };
  await addF(ta, tb, B.user);
  await addF(ta, tc, C.user);
  await addF(tb, td, D.user);
  check('三角色好友关系建立', (await j('GET', '/api/friends', null, ta)).d.friends.length === 2
    && (await j('GET', '/api/friends', null, tb)).d.friends.length === 2);
  check('重复请求被拦截', (await j('POST', '/api/friend/request', { code: B.user.inviteCode }, ta)).s === 400);
  check('无效邀请码 404', (await j('POST', '/api/friend/request', { code: 'ZZZZZZ' }, ta)).s === 404);
  check('无 token 401', (await j('GET', '/api/me')).s === 401);

  // ---- 喝水勾选喊人 + 未读语义 ----
  await j('POST', '/api/drinks', { via: 'self', toIds: [B.user.id] }, ta);
  const meB = (await j('GET', '/api/me', null, tb)).d;
  const meC = (await j('GET', '/api/me', null, tc)).d;
  check('只勾选乙：乙收到碰杯邀请', meB.pendingUrges.length === 1 && meB.pendingUrges[0].kind === 'nudge');
  check('丙未被喊', meC.pendingUrges.length === 0);
  const fC = (await j('GET', '/api/feed', null, tc)).d;
  check('丙收安静动态且不计未读', fC.items.some((i) => i.type === 'drink' && !i.mine && i.unread === false));
  await j('POST', '/api/drinks', { via: 'self', toIds: [] }, ta);
  check('清空勾选后不再喊', (await j('GET', '/api/me', null, tb)).d.pendingUrges.length === 1);

  // ---- 催喝 + 回敬闭环 + 好友互动小记 ----
  check('A 手动催 B', (await j('POST', '/api/reminds', { toId: B.user.id }, ta)).s === 200);
  const fA = (await j('GET', '/api/friends', null, ta)).d;
  check('好友卡记录：今日催过 1 次', fA.friends.find((f) => f.user.id === B.user.id).manualToday === 1);
  const meB2 = (await j('GET', '/api/me', null, tb)).d;
  check('B 有两个待回应（碰杯+催喝）', meB2.pendingUrges.length === 2);
  await j('POST', '/api/drinks', { via: 'reply', remindId: meB2.pendingUrges[0].id }, tb);
  check('同一催喝二次回敬拦截', (await j('POST', '/api/drinks', { via: 'reply', remindId: meB2.pendingUrges[0].id }, tb)).d.code === 'ALREADY_REPLIED');
  const fA2 = (await j('GET', '/api/friends', null, ta)).d;
  const fB2 = (await j('GET', '/api/friends', null, tb)).d;
  check('回敬后：A 视角 manualToday=1 且 repliedToday=1', (() => {
    const a2b = fA2.friends.find((f) => f.user.id === B.user.id);
    return a2b.manualToday === 1 && a2b.repliedToday === 1;
  })());
  const feedA = (await j('GET', '/api/feed', null, ta)).d;
  check('A 有未读（回敬等）', feedA.unread >= 1 && feedA.items.some((i) => i.type === 'reply' && !i.mine && i.unread));
  await j('POST', '/api/feed/read', {}, ta);
  check('已读归零', (await j('GET', '/api/feed', null, ta)).d.unread === 0);

  // ---- 免打扰 ----
  await j('PATCH', '/api/me', { quiet: { manual: true, start: '23:00', end: '08:00' } }, tb);
  const meB3 = (await j('GET', '/api/me', null, tb)).d;
  check('me 返回 quiet.active=true', meB3.quiet.active === true && meB3.quiet.manual === true);
  const q = (await j('POST', '/api/reminds', { toId: B.user.id }, ta)).d;
  check('手动免打扰拦截催喝', q.code === 'QUIET');
  const fa3 = (await j('GET', '/api/friends', null, ta)).d;
  check('好友列表乙状态 QUIET', fa3.friends.find((f) => f.user.id === B.user.id).urge.reason === 'QUIET');
  const beforePending = (await j('GET', '/api/me', null, tb)).d.pendingUrges.length;
  await j('POST', '/api/drinks', { via: 'self', toIds: [B.user.id] }, ta);
  check('免打扰中不被喝水喊到', (await j('GET', '/api/me', null, tb)).d.pendingUrges.length === beforePending);
  await j('PATCH', '/api/me', { quiet: { manual: false, start: '23:00', end: '08:00' } }, tb);
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes();
  check('当前不在免打扰时段：active=false', (await j('GET', '/api/me', null, tb)).d.quiet.active === false);
  await j('PATCH', '/api/me', { quiet: { manual: false, start: hhmm(nowMin - 2), end: hhmm(nowMin + 2) } }, tb);
  check('时段覆盖当前：催喝被拦', (await j('POST', '/api/reminds', { toId: B.user.id }, ta)).d.code === 'QUIET');
  await j('PATCH', '/api/me', { quiet: { manual: false, start: hhmm(nowMin + 120), end: hhmm(nowMin + 121) } }, tb);
  check('时段外放行', (await j('POST', '/api/reminds', { toId: B.user.id }, ta)).s === 200);
  check('起止相同 400', (await j('PATCH', '/api/me', { quiet: { start: '23:00', end: '23:00' } }, tb)).s === 400);

  // ---- 消息清空（视图隔离）+ 清空后新消息 ----
  const before = (await j('GET', '/api/feed', null, tb)).d;
  check('清空前乙有消息', before.items.length > 0);
  await j('POST', '/api/feed/clear', {}, tb);
  const afterClear = (await j('GET', '/api/feed', null, tb)).d;
  check('清空后乙视图空且无未读', afterClear.items.length === 0 && afterClear.unread === 0);
  check('甲视图不受影响', (await j('GET', '/api/feed', null, ta)).d.items.length > 0);
  await j('POST', '/api/drinks', { via: 'self', toIds: [] }, ta);
  check('清空后新动态正常到达乙', (await j('GET', '/api/feed', null, tb)).d.items.some((i) => i.type === 'drink'));

  // ---- 重启持久化 ----
  const drinkBefore = (await j('GET', '/api/me', null, tb)).d.today.count;
  child.kill(); await sleep(400);
  child = await boot(false); // 不删库重启，验证持久化
  const meRestart = (await j('GET', '/api/me', null, tb)).d;
  check('重启后今日杯数保留', meRestart.today.count === drinkBefore && drinkBefore >= 1);
  check('重启后好友关系保留', (await j('GET', '/api/friends', null, ta)).d.friends.length === 2);
  check('重启后免打扰配置保留', (await j('GET', '/api/me', null, tb)).d.quiet.start === hhmm(nowMin + 120));
  const fBfin = (await j('GET', '/api/feed', null, tb)).d;
  check('重启后清空视图保持（只有清空后的新消息）', fBfin.items.every((i) => i.type !== 'sys'));
} catch (e) {
  console.error('异常:', e && e.message);
  failed++;
} finally {
  try { child && child.kill(); await sleep(400); } catch {}
  rmSafe(DB);
}
console.log(failed === 0 ? '\n全量回归 100% 通过 🎉' : `\n${failed} 项失败 ❌`);
process.exit(failed ? 1 : 0);
