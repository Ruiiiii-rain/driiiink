// 账号系统专项自测（隔离实例，SQLite 持久化）
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DB = path.join(process.cwd(), 'data', '_acct.db');
const rmSafe = (p) => { for (const f of [p, p + '-wal', p + '-shm']) { try { fs.rmSync(f, { force: true }); } catch { /* 忽略 */ } } };
rmSafe(DB);
const PORT = 3262;
const BASE = `http://127.0.0.1:${PORT}`;
let failed = 0;
const check = (n, c, extra = '') => { console.log((c ? '✅' : '❌') + ' ' + n + (extra ? ` [${extra}]` : '')); if (!c) failed++; };

let child;
async function boot(clean = true) {
  if (clean) rmSafe(DB);
  child = spawn(process.execPath, ['server.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), DATA_FILE: DB, LEGACY_JSON: DB + '.nol.json' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch {}
    await sleep(200);
  }
  throw new Error('实例未就绪');
}
async function j(method, p, body, token) {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { s: r.status, d: await r.json().catch(() => ({})) };
}

try {
  await boot();
  // 1. 密码注册
  const reg = await j('POST', '/api/register', { nickname: '喝水侠', password: 'secret123', avatar: 'cup' });
  check('带密码注册成功', reg.s === 200 && !!reg.d.token && !!reg.d.user.inviteCode);
  // 2. 重名冲突
  const dup = await j('POST', '/api/register', { nickname: '喝水侠', password: 'other456', avatar: 'drop' });
  check('重名注册被拒(409)', dup.s === 409);
  // 3. 短密码拒绝
  const short = await j('POST', '/api/register', { nickname: '新人', password: '123', avatar: 'cup' });
  check('短密码被拒(400)', short.s === 400);
  // 4. 正确登录
  const login = await j('POST', '/api/login', { nickname: '喝水侠', password: 'secret123' });
  check('正确密码登录成功', login.s === 200 && !!login.d.token);
  // 5. 错误密码
  const bad = await j('POST', '/api/login', { nickname: '喝水侠', password: 'wrong123' });
  check('错误密码被拒(401)', bad.s === 401);
  // 6. 无密码旧号登录被拒(403)
  await j('POST', '/api/register', { nickname: '旧号测试', avatar: 'tea' }); // 无密码注册（兼容测试）
  const old = await j('POST', '/api/login', { nickname: '旧号测试', password: 'whatever1' });
  check('无密码旧号登录被拒(403)', old.s === 403);
  // 7. token 可用 & 可喝水
  const token = login.d.token;
  await j('POST', '/api/drinks', { via: 'self' }, token);
  const me = await j('GET', '/api/me', null, token);
  check('登录 token 可用并计数', me.s === 200 && me.d.today.count === 1 && me.d.user.nickname === '喝水侠');
  // 8. 登出语义：删除 token 模拟 → 未授权
  const no = await j('GET', '/api/me', null, 'no-such-token-abc');
  check('无效 token 401', no.s === 401);

  // 9. SQLite 重启持久化（含账号与 token）
  child.kill();
  await sleep(500);
  await boot(false);
  const me2 = await j('GET', '/api/me', null, token);
  check('重启后登录态与杯数保留', me2.s === 200 && me2.d.today.count === 1);
  const login2 = await j('POST', '/api/login', { nickname: '喝水侠', password: 'secret123' });
  check('重启后密码登录正常', login2.s === 200);
} catch (e) {
  console.error('异常:', e && e.message);
  failed++;
} finally {
  try { child && child.kill(); } catch {}
  await sleep(400);
  rmSafe(DB);
}
console.log(failed === 0 ? '\n账号链路全部通过 🎉' : `\n${failed} 项失败`);
process.exit(failed ? 1 : 0);
