// 喝了么 · 前端逻辑（M0 喝水 + M1 SSE 实时 + M2 好友/催喝/回敬/消息流）
const TOKEN_KEY = 'hlem_token';   // 主身份（localStorage，所有窗口共享）
const TOKEN_KEY_S = 'hlem_token_s'; // 临时身份（sessionStorage，仅当前窗口，双开演示用）

// 手绘水位档位：13 张图（00 空杯 + 01~12），frac 为实测水位百分比（面积法）
const CUP_LEVELS = [
  { frac: 0.000, src: '/images/levels/00.png' },
  { frac: 0.051, src: '/images/levels/01.png' },
  { frac: 0.098, src: '/images/levels/02.png' },
  { frac: 0.153, src: '/images/levels/03.png' },
  { frac: 0.202, src: '/images/levels/04.png' },
  { frac: 0.263, src: '/images/levels/05.png' },
  { frac: 0.322, src: '/images/levels/06.png' },
  { frac: 0.380, src: '/images/levels/07.png' },
  { frac: 0.451, src: '/images/levels/08.png' },
  { frac: 0.581, src: '/images/levels/09.png' },
  { frac: 0.712, src: '/images/levels/10.png' },
  { frac: 0.866, src: '/images/levels/11.png' },
  { frac: 1.000, src: '/images/levels/12.png' },
];

// 可选头像：5 个饮品系可爱角色（画风与手绘一致，可在注册页挑选）
const AVATARS = [
  { key: 'cup', name: '小水杯' },
  { key: 'drop', name: '小水滴' },
  { key: 'juice', name: '橙汁杯' },
  { key: 'tea', name: '奶茶杯' },
  { key: 'coffee', name: '咖啡杯' },
];
const AVATAR_SRC = {
  cup: '/images/avatars/cup.svg',
  drop: '/images/avatars/drop.svg',
  juice: '/images/avatars/juice.svg',
  tea: '/images/avatars/tea.svg',
  coffee: '/images/avatars/coffee.svg',
};
function avatarSrc(avatar) { return AVATAR_SRC[avatar] || AVATAR_SRC.cup; }
function avaHtml(u) {
  const key = u && u.avatar ? u.avatar : 'cup';
  return `<img class="uava" src="${avatarSrc(key)}" alt="头像">`;
}

const $ = (id) => document.getElementById(id);
const readToken = () => sessionStorage.getItem(TOKEN_KEY_S) || localStorage.getItem(TOKEN_KEY);
const isTemp = () => !!sessionStorage.getItem(TOKEN_KEY_S);
const state = {
  tab: 'drink',
  selectedAvatar: AVATARS[0],
  me: null,
  friends: [],
  feed: { items: [], unread: 0 },
  reqIncoming: [],
  reqOutgoing: [],
  nudgeSel: null, // null=全部勾选；[]=一个都不喊；否则为选中的好友 id 数组
};

// ---------- 小工具 ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtAgo(ts) {
  const d = new Date(ts).getTime();
  const diff = Date.now() - d;
  if (diff < 60e3) return '刚刚';
  if (diff < 3600e3) return `${Math.floor(diff / 60e3)} 分钟前`;
  if (diff < 86400e3) return `${Math.floor(diff / 3600e3)} 小时前`;
  const dt = new Date(d);
  return `${dt.getMonth() + 1}月${dt.getDate()}日`;
}
function fmtCd(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function avatarOf(u) { return avaHtml(u); } // 兼容旧调用：一律渲染头像小图

// ---------- 请求 ----------
async function api(path, options = {}) {
  const token = readToken();
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(path, { ...options, headers });
  } catch {
    throw new Error('连不上服务了——确认服务端还在运行（node server.js）');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `请求失败（${res.status}）`), data);
  return data;
}

// ---------- Toast ----------
let toastTimer = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2400);
}

// ---------- 视图切换 ----------
function showRegister() {
  closeSSE(); // 离开登录态时断开旧身份的实时连接，避免残留推送
  showRegMode();
  $('view-register').hidden = false;
  $('view-app').hidden = true;
  $('tabbar').hidden = true;
  $('topbar').hidden = true;
}
function showApp() {
  $('view-register').hidden = true;
  $('view-app').hidden = false;
  $('tabbar').hidden = false;
  $('topbar').hidden = false;
}
function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('panel-drink').hidden = tab !== 'drink';
  $('panel-friends').hidden = tab !== 'friends';
  $('panel-msgs').hidden = tab !== 'msgs';
  if (tab === 'msgs') markFeedRead();
}

// ---------- 头像选择 ----------
function renderAvatars() {
  const grid = $('avatarGrid');
  grid.innerHTML = '';
  AVATARS.forEach((a) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'avatar-item' + (a.key === state.selectedAvatar ? ' sel' : '');
    b.title = a.name;
    b.innerHTML = `<img class="uava big" src="${avatarSrc(a.key)}" alt="${a.name}">`;
    b.addEventListener('click', () => { state.selectedAvatar = a.key; renderAvatars(); });
    grid.appendChild(b);
  });
}

// ---------- 数据获取 ----------
async function refreshAll() {
  try {
    const [me, friends, feed, reqs] = await Promise.all([
      api('/api/me'), api('/api/friends'), api('/api/feed'), api('/api/friend/requests'),
    ]);
    const prevIds = new Set(state.friends.map((f) => f.user.id));
    state.me = me; state.friends = friends.friends;
    state.feed = feed; state.reqIncoming = reqs.incoming; state.reqOutgoing = reqs.outgoing;
    // 新加的好友自动补进"全选"式勾选（如果此前是全部勾选状态）
    if (state.nudgeSel && state.nudgeSel.length && prevIds.size &&
        [...prevIds].every((id) => state.nudgeSel.includes(id))) {
      for (const f of state.friends) {
        if (!prevIds.has(f.user.id) && !state.nudgeSel.includes(f.user.id)) state.nudgeSel.push(f.user.id);
      }
    }
    // 冷却倒计时在每次拉数据时记一次终点，渲染时只读剩余时间（避免每秒重绘把倒计时拉长）
    const cdEnds = {};
    for (const f of state.friends) {
      if (f.urge.reason === 'COOLDOWN') cdEnds[f.user.id] = Date.now() + f.urge.remainMs;
    }
    state.cdEnds = cdEnds;
    render();
  } catch (err) {
    // 401 等会话失效场景：只清除当前窗口正在使用的 token
    if (err.status === 401 || /未登录/.test(err.message)) {
      (isTemp() ? sessionStorage : localStorage).removeItem(isTemp() ? TOKEN_KEY_S : TOKEN_KEY);
      showRegister();
    }
  }
}

// ---------- 渲染：喝水页 ----------
function renderDrink() {
  const me = state.me;
  const goal = me.user.dailyGoal;
  const count = me.today.count;
  $('todayGreeting').innerHTML =
    count === 0 ? `${avaHtml(me.user)} <b>${esc(me.user.nickname)}</b>，今天还没开张，来一杯？`
    : count >= goal ? `${avaHtml(me.user)} 今日目标达成，你是水神！`
    : `${avaHtml(me.user)} <b>${esc(me.user.nickname)}</b> 已喝 ${count} 杯`;

  // 水位档位图：按 count/goal 的百分比，就近选择用户手绘的水位图
  const target = goal > 0 ? count / goal : 0;
  let best = 0, bestDiff = Infinity;
  for (let i = 0; i < CUP_LEVELS.length; i++) {
    const diff = Math.abs(CUP_LEVELS[i].frac - target);
    if (diff < bestDiff) { bestDiff = diff; best = i; }
  }
  const cupImg = $('cupImg');
  const nextSrc = CUP_LEVELS[best].src;
  if (cupImg.getAttribute('src') !== nextSrc) {
    cupImg.src = nextSrc;
    cupImg.classList.remove('cup-pop');
    void cupImg.offsetWidth; // 重触发切图动画
    cupImg.classList.add('cup-pop');
  }
  $('cupLevel').textContent = `${count} / ${goal} 杯`;
  $('goalVal').textContent = `目标 ${goal} 杯`;
  $('goalVal').title = `点击修改每日目标（当前 ${goal} 杯）`;

  $('inviteCode').textContent = me.user.inviteCode;
  $('myCodeMini').textContent = me.user.inviteCode;
  const now = new Date();
  $('todayDate').textContent = `${now.getMonth() + 1}月${now.getDate()}日`;

  // 主按钮上下文切换：有未回敬的催喝/碰杯 → 回应模式
  const urge = me.pendingUrges[0];
  const replyTag = $('replyTag');
  replyTag.hidden = !urge;
  if (urge) {
    const nudge = urge.kind === 'nudge';
    replyTag.innerHTML = nudge
      ? `${avaHtml(urge.from)}<b> ${esc(urge.from.nickname)}</b> 邀你碰杯`
      : `${avaHtml(urge.from)}<b> ${esc(urge.from.nickname)}</b> 催你喝水，回应一下`;
    $('drinkHint').textContent = `干了这杯，${nudge ? '回应碰杯' : '回敬 ' + urge.from.nickname}`;
  } else {
    $('drinkHint').textContent = count >= goal ? '超标了，奖励一杯 🎉' : '咕咚，干了';
  }
  $('drinkStatus').textContent =
    count > 0 ? (urge ? `今天第 ${count} 杯 · 回敬后 TA 会收到你的消息` : `今天第 ${count} 杯下肚，继续加油`) : '';

  // ---- 主页提醒横幅：最新一条未读回敬（B 回敬 A 时在这里弹出）----
  const reply = state.feed.items.find((i) => i.type === 'reply' && !i.mine && i.unread);
  const banner = $('replyBanner');
  banner.hidden = !reply;
  if (reply) {
    banner.innerHTML = `
      <span class="banner-txt"><img class="fi" src="/images/ui/icon-cheers.svg" alt=""> ${avaHtml(reply.from)}<b> ${esc(reply.from.nickname)}</b> ${esc(reply.text)}（${fmtAgo(reply.ts)}）</span>
      <button class="banner-btn" data-act="goto-msgs">去看看</button>`;
  }

  // ---- 安静的状态行：我催过/喊过的水友还没干杯 ----
  const waiting = state.feed.items.filter(
    (i) => (i.type === 'urge' || i.type === 'nudge') && i.mine && !i.replied);
  const wl = $('waitingLine');
  wl.hidden = !waiting.length;
  if (waiting.length) {
    const names = [...new Set(waiting.map((i) => i.toNick))].join('、');
    wl.innerHTML = `<img class="fi" src="/images/ui/icon-time.svg" alt=""> 已喊 <b>${esc(names)}</b>，等 TA 干杯…`;
  }

  // ---- 这杯喊谁（勾选提醒对象）----
  renderNudgeChips();

  // ---- 设置按钮状态：免打扰生效中换月亮水滴图 ----
  $('btnSettingsIco').src = me.quiet.active
    ? '/images/ui/icon-quiet.svg'
    : '/images/ui/icon-settings.svg';
}

function nudgeCheckedSet() {
  return state.nudgeSel
    ? new Set(state.nudgeSel)
    : new Set(state.friends.map((f) => f.user.id));
}
function renderNudgeChips() {
  const chips = $('nudgeChips');
  const empty = $('nudgeEmpty');
  if (!state.friends.length) {
    chips.innerHTML = '';
    chips.hidden = true;
    empty.hidden = false;
    return;
  }
  chips.hidden = false;
  empty.hidden = true;
  const checked = nudgeCheckedSet();
  const none = checked.size === 0;
  chips.innerHTML = state.friends.map((f) => {
    const on = checked.has(f.user.id);
    return `<button type="button" class="nudge-chip ${on ? 'on' : ''}" data-nudge-id="${f.user.id}">
      ${avaHtml(f.user)} ${esc(f.user.nickname)}</button>`;
  }).join('');
}
function toggleNudge(id) {
  const s = nudgeCheckedSet();
  if (s.has(id)) s.delete(id); else s.add(id);
  state.nudgeSel = s.size === state.friends.length && state.friends.length ? null : [...s];
  renderNudgeChips();
}

// ---------- 渲染：好友页 ----------
function renderFriends() {
  const list = $('friendList');
  $('friendCount').textContent = state.friends.length;
  $('reqCard').hidden = !state.reqIncoming.length && !state.reqOutgoing.length;

  // 请求
  const reqBox = $('reqList');
  reqBox.innerHTML = state.reqIncoming.map((r) => `
    <div class="req-row">
      <div class="req-info"><span class="avatar-big">${avatarOf(r.user)}</span>
        <div><b>${esc(r.user.nickname)}</b><div class="meta">想和你互相盯喝水</div></div>
      </div>
      <div class="req-acts">
        <button class="btn-mini ok" data-act="accept" data-id="${r.id}">同意</button>
        <button class="btn-mini" data-act="reject" data-id="${r.id}">忽略</button>
      </div>
    </div>`).join('') +
    state.reqOutgoing.map((r) => `
    <div class="req-row dim">
      <div class="req-info"><span class="avatar-big">${avatarOf(r.user)}</span>
        <div><b>${esc(r.user.nickname)}</b><div class="meta">等待对方同意…</div></div>
      </div>
    </div>`).join('');

  // 好友列表
  list.innerHTML = state.friends.length ? state.friends.map((f) => {
    const u = f.user;
    const lastTxt = f.lastDrinkAt ? `上次喝水 ${fmtAgo(f.lastDrinkAt)}` : '今天还没喝';
    const countTxt = f.todayCount ? `今日 ${f.todayCount} 杯` : '';
    const meta = [countTxt, lastTxt].filter(Boolean).join(' · ');
    const extra = f.manualToday
      ? `今日催过 ${f.manualToday} 次${f.repliedToday ? `，已回敬 ${f.repliedToday}` : ''}`
      : '';
    let act = '';
    if (f.urge.can) {
      act = `<button class="btn-mini primary" data-act="urge" data-id="${u.id}">催TA</button>`;
    } else if (f.urge.reason === 'COOLDOWN') {
      const remain = Math.max(0, state.cdEnds[u.id] - Date.now());
      act = `<button class="btn-mini disabled" disabled>冷却 ${fmtCd(remain)}</button>`;
    } else if (f.urge.reason === 'JUST_DRANK') {
      act = `<button class="btn-mini disabled" disabled>刚喝过，缓一缓</button>`;
    } else if (f.urge.reason === 'QUIET') {
      act = `<button class="btn-mini disabled" disabled>免打扰中</button>`;
    } else {
      act = `<button class="btn-mini disabled" disabled>今日已催满</button>`;
    }
    return `
    <div class="friend-row">
      <span class="avatar-big">${avatarOf(u)}</span>
      <div class="friend-info">
        <b>${esc(u.nickname)}</b>
        <div class="meta">${meta}</div>
        ${extra ? `<div class="meta sub">${extra}</div>` : ''}
      </div>
      <div class="friend-act">${act}</div>
    </div>`;
  }).join('') : `<div class="empty">还没有水友。<br>把邀请码发给朋友，或用对方的邀请码添加 TA。</div>`;

  $('friendReqBadge').hidden = !state.reqIncoming.length;
  if (state.reqIncoming.length) $('friendReqBadge').textContent = state.reqIncoming.length;
}

function tickCooldowns() {
  if (state.tab !== 'friends' || document.hidden || !state.cdEnds) return;
  const ends = Object.values(state.cdEnds);
  if (!ends.length) return;
  if (ends.every((t) => t <= Date.now())) {
    refreshAll(); // 冷却全部到期，拉取最新可催状态
    return;
  }
  renderFriends();
}

// ---------- 渲染：消息页 ----------
function feedItemHtml(it) {
  const time = `<span class="feed-time">${fmtAgo(it.ts)}</span>`;
  let body = '';
  if (it.type === 'sys') {
    body = `<div class="feed-line sys"><img class="fi" src="/images/ui/icon-sys.svg" alt=""> ${esc(it.text)} ${time}</div>`;
  } else if (it.type === 'drink') {
    body = `<div class="feed-line"><img class="fi" src="/images/ui/icon-drink.svg" alt=""> ${avaHtml(it.from)} <b>${esc(it.from.nickname)}</b> 喝了今天第 <b>${it.cups}</b> 杯 ${time}</div>`;
  } else if (it.type === 'reply') {
    body = `<div class="feed-line"><img class="fi" src="/images/ui/icon-cheers.svg" alt=""> ${avaHtml(it.from)} <b>${esc(it.from.nickname)}</b> ${esc(it.text)} ${time}</div>`;
  } else if (it.type === 'urge' || it.type === 'nudge') {
    const nudge = it.type === 'nudge';
    const cheers = nudge ? '/images/ui/icon-cheers.svg' : '/images/ui/icon-urge.svg';
    if (it.mine) {
      const chip = it.replied ? `<span class="chip ok">已回敬</span>` : `<span class="chip">等待回应…</span>`;
      const head = nudge
        ? `<img class="fi" src="${cheers}" alt=""> 你干了一杯，喊了 <b>${esc(it.toNick)}</b>：`
        : `<img class="fi" src="${cheers}" alt=""> 你催了 <b>${esc(it.toNick)}</b>：`;
      body = `<div class="feed-line">${head}<span class="quote">“${esc(it.text)}”</span> ${chip} ${time}</div>`;
    } else {
      const btn = it.open
        ? `<button class="btn-mini primary reply" data-act="reply" data-id="${it.id}" data-remind="${it.remindId}">干了这杯</button>`
        : `<span class="chip ok">已回敬</span>`;
      const head = nudge
        ? `<img class="fi" src="${cheers}" alt=""> ${avaHtml(it.from)} <b>${esc(it.from.nickname)}</b> 干了一杯，喊你一起：`
        : `<img class="fi" src="${cheers}" alt=""> ${avaHtml(it.from)} <b>${esc(it.from.nickname)}</b> 催你喝水：`;
      body = `<div class="feed-line urge">${head}
        <div class="quote">“${esc(it.text)}”</div>${btn} ${time}</div>`;
    }
  }
  return `<div class="feed-item ${it.open ? 'hot' : ''}">${body}</div>`;
}

function renderMsgs() {
  const list = $('feedList');
  $('btnClearFeed').hidden = state.feed.items.length === 0;
  $('feedFilters').hidden = state.feed.items.length === 0;
  const f = state.feedFilter || 'all';
  document.querySelectorAll('#feedFilters .f-chip').forEach((b) =>
    b.classList.toggle('on', b.dataset.f === f));
  const arr = state.feed.items.filter((i) => {
    if (f === 'all') return true;
    if (f === 'action') return i.type === 'urge' || i.type === 'nudge';
    return i.type === f;
  });
  const emptyText = !state.feed.items.length
    ? '还没有动静 🌊<br>添加水友后，TA 的喝水动态和催促会出现在这里'
    : '这类消息暂时还没有';
  list.innerHTML = arr.length
    ? arr.map(feedItemHtml).join('')
    : `<div class="feed-empty">${emptyText}</div>`;
  const n = state.feed.unread;
  $('msgBadge').hidden = n === 0;
  if (n > 0) $('msgBadge').textContent = n > 99 ? '99+' : n;
}

async function clearFeed() {
  if (!confirm('清空消息列表？\n（只清空你自己的视图，对方那侧不受影响）')) return;
  try {
    await api('/api/feed/clear', { method: 'POST' });
    toast('消息已清空');
    await refreshAll();
  } catch (err) { toast(err.message); }
}

// ---------- 总渲染 ----------
function render() {
  if (!state.me) return;
  $('idTag').hidden = !isTemp();
  renderDrink();
  renderFriends();
  renderMsgs();
}

// ---------- 动作 ----------
async function drinkMain() {
  const btn = $('btnDrink');
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const urge = state.me.pendingUrges[0];
    let data;
    if (urge) {
      data = await api('/api/drinks', { method: 'POST', body: JSON.stringify({ via: 'reply', remindId: urge.id }) });
      toast(`已回敬 ${urge.from.nickname}，TA 会收到你的消息`);
    } else {
      // 按"这杯喊谁"的勾选推送喝水邀请（[]=谁都不喊，只安静记录）
      const toIds = state.nudgeSel === null
        ? state.friends.map((f) => f.user.id)
        : [...state.nudgeSel];
      data = await api('/api/drinks', {
        method: 'POST',
        body: JSON.stringify({ via: 'self', toIds }),
      });
      if (data.count % 5 === 0) toast(`第 ${data.count} 杯！离水神又近一步`);
    }
    btn.classList.remove('bump');
    void btn.offsetWidth;
    btn.classList.add('bump');
    await refreshAll();
  } catch (err) {
    toast(err.message);
    if (err.code === 'ALREADY_REPLIED') await refreshAll();
  } finally {
    btn.disabled = false;
  }
}

async function addFriend() {
  const input = $('friendCode');
  const code = input.value.trim().toUpperCase();
  if (!/^[A-Z2-9]{6}$/.test(code)) { toast('邀请码是 6 位大写字母数字（不含 0/O/1/I）'); return; }
  const btn = $('btnAddFriend');
  btn.disabled = true;
  try {
    const r = await api('/api/friend/request', { method: 'POST', body: JSON.stringify({ code }) });
    input.value = '';
    toast(r.autoAccepted ? '你们互相请求过，已直接成为水友！' : '请求已发送，等 TA 同意');
    await refreshAll();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function onFriendAct(act, id) {
  if (act === 'urge') {
    try {
      const r = await api('/api/reminds', { method: 'POST', body: JSON.stringify({ toId: id }) });
      toast(`已提醒 TA：“${r.remind.text}”`);
      await refreshAll();
    } catch (err) {
      toast(err.message);
      if (err.code === 'COOLDOWN') { await refreshAll(); tickCooldowns(); }
    }
  } else if (act === 'accept' || act === 'reject') {
    try {
      await api('/api/friend/reply', { method: 'POST', body: JSON.stringify({ id, accept: act === 'accept' }) });
      toast(act === 'accept' ? '成为水友，开始互相盯喝水' : '已忽略该请求');
      await refreshAll();
    } catch (err) { toast(err.message); }
  }
}

async function onReply(remindId) {
  try {
    await api('/api/drinks', { method: 'POST', body: JSON.stringify({ via: 'reply', remindId }) });
    toast('干了这杯，回敬成功');
    markFeedRead();
    await refreshAll();
  } catch (err) {
    toast(err.message);
    await refreshAll();
  }
}

async function markFeedRead() {
  try {
    const before = state.feed.unread;
    await api('/api/feed/read', { method: 'POST' });
    if (before > 0) {
      state.feed.unread = 0;
      renderMsgs();
    }
  } catch { /* 忽略 */ }
}

// ---------- 喝水页小动作 ----------
async function editGoal() {
  const me = state.me;
  const input = prompt(`每日目标杯数（1-20），当前 ${me.user.dailyGoal}：`, String(me.user.dailyGoal));
  if (input === null) return;
  const n = Math.round(Number(input));
  if (!Number.isFinite(n) || n < 1 || n > 20) { toast('请输入 1-20 之间的数字'); return; }
  try {
    await api('/api/me', { method: 'PATCH', body: JSON.stringify({ dailyGoal: n }) });
    await refreshAll();
    toast(`目标已改为每天 ${n} 杯`);
  } catch (err) { toast(err.message); }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

// ---------- 设置弹层（免打扰） ----------
function openSettings() {
  const q = state.me.quiet;
  $('quietManual').checked = q.manual;
  $('quietStart').value = q.start;
  $('quietEnd').value = q.end;
  $('quietState').textContent = q.active
    ? `当前免打扰生效中（${q.start} - ${q.end}${q.manual ? '，手动开启' : ''}）`
    : `🟢 当前正常接收提醒${!q.manual ? `（时段 ${q.start} - ${q.end}）` : ''}`;
  $('settingsModal').hidden = false;
}
function closeSettings() { $('settingsModal').hidden = true; }

async function saveQuiet() {
  const manual = $('quietManual').checked;
  const start = $('quietStart').value;
  const end = $('quietEnd').value;
  if (!start || !end) { toast('请选择完整的开始与结束时间'); return; }
  if (start === end) { toast('开始与结束时间不能相同'); return; }
  const btn = $('btnSaveQuiet');
  btn.disabled = true;
  try {
    await api('/api/me', { method: 'PATCH', body: JSON.stringify({ quiet: { manual, start, end } }) });
    closeSettings();
    toast(manual ? '免打扰已开启' : `免打扰时段已设为 ${start} - ${end}`);
    await refreshAll();
  } catch (err) { toast(err.message); } finally { btn.disabled = false; }
}

// ---------- 注册 / 登录 / 换身份 ----------
function persistToken(token) {
  // 已存在主身份时，新身份只进当前窗口（sessionStorage）；否则存为主身份
  if (localStorage.getItem(TOKEN_KEY)) sessionStorage.setItem(TOKEN_KEY_S, token);
  else localStorage.setItem(TOKEN_KEY, token);
}
function showRegMode() {
  $('nickname').hidden = false;
  $('regPassword').hidden = false;
  $('avatarGrid').hidden = false;
  $('btnRegister').hidden = false;
  $('btnToLogin').hidden = false;
  $('loginBox').hidden = true;
}
function showLoginMode() {
  $('nickname').hidden = true;
  $('regPassword').hidden = true;
  $('avatarGrid').hidden = true;
  $('btnRegister').hidden = true;
  $('btnToLogin').hidden = true;
  $('loginBox').hidden = false;
}
async function register() {
  const nickname = $('nickname').value.trim();
  const password = $('regPassword').value;
  if (!nickname) { toast('先给自己起个名字呗'); return; }
  if (password.length < 6) { toast('密码至少 6 位'); return; }
  const btn = $('btnRegister');
  btn.disabled = true;
  try {
    const data = await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({ nickname, password, avatar: state.selectedAvatar }),
    });
    const temp = !!localStorage.getItem(TOKEN_KEY);
    persistToken(data.token);
    await boot();
    toast(temp
      ? `临时水友 ${nickname}（仅此窗口），邀请码 ${data.user.inviteCode}`
      : `欢迎水友 ${nickname}，邀请码 ${data.user.inviteCode}`);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}
async function login() {
  const nickname = $('loginNick').value.trim();
  const password = $('loginPw').value;
  if (!nickname || !password) { toast('请输入昵称和密码'); return; }
  const btn = $('btnLogin');
  btn.disabled = true;
  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ nickname, password }),
    });
    persistToken(data.token);
    await boot();
    toast(`欢迎回来，${nickname}`);
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

function switchIdentity() {
  // 此窗口当前是临时身份 → 清除它，回到主身份（若有）
  if (isTemp()) {
    if (!confirm('清除此窗口的临时身份？\n将回到主身份（如果有）。')) return;
    sessionStorage.removeItem(TOKEN_KEY_S);
    boot();
    return;
  }
  // 此窗口当前是主身份 → 在本窗口新建临时身份，用于双开演示
  if (localStorage.getItem(TOKEN_KEY)) {
    if (!confirm('此窗口将注册一个【临时身份】用于双开演示：\n· 不会覆盖主身份\n· 刷新页面仍是临时身份\n· 关闭此窗口后临时身份失效')) return;
    showRegister();
    return;
  }
  // 完全没有身份 → 直接去注册页
  showRegister();
}

// ---------- SSE 实时 ----------
let sse = null;
function closeSSE() {
  if (sse) { sse.close(); sse = null; }
}
function connectSSE() {
  closeSSE();
  const token = readToken();
  if (!token) return;
  const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  sse = es;
  es.onmessage = (e) => {
    let ev = {};
    try { ev = JSON.parse(e.data); } catch { /* ignore */ }
    if (ev.ev === 'hello') return;
    if (ev.ev === 'friend_req') toast('有人请求加你为水友');
    if (ev.ev === 'urge' && ev.fromId !== state.me?.user?.id) toast('有人催你喝水，快去看看');
    if (ev.ev === 'nudge' && ev.fromId !== state.me?.user?.id) {
      toast(`${ev.fromName || '水友'} 喝了一杯，喊你一起干杯`);
    }
    if (ev.ev === 'reply' && ev.fromId !== state.me?.user?.id) {
      toast(`${ev.fromName || '水友'} 干了一杯回敬你！`);
    }
    refreshAll();
  };
  es.onerror = () => { /* EventSource 会自动重连 */ };
}

// ---------- 启动 ----------
async function boot() {
  const token = readToken();
  if (!token) { showRegister(); return; }
  try {
    await refreshAll();
    showApp();
    connectSSE();

    // 带邀请码的链接：?invite=XXXXXX → 跳好友页并预填
    const inv = new URLSearchParams(location.search).get('invite');
    if (inv) {
      $('friendCode').value = inv.toUpperCase();
      switchTab('friends');
      history.replaceState(null, '', location.pathname);
    }
  } catch {
    (isTemp() ? sessionStorage : localStorage).removeItem(isTemp() ? TOKEN_KEY_S : TOKEN_KEY);
    showRegister();
  }
}

function bindEvents() {
  renderAvatars();
  $('btnRegister').addEventListener('click', register);
  $('nickname').addEventListener('keydown', (e) => { if (e.key === 'Enter') register(); });
  $('regPassword').addEventListener('keydown', (e) => { if (e.key === 'Enter') register(); });
  $('btnToLogin').addEventListener('click', showLoginMode);
  $('btnToReg').addEventListener('click', showRegMode);
  $('btnLogin').addEventListener('click', login);
  $('loginNick').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  $('loginPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  $('btnDrink').addEventListener('click', drinkMain);
  $('goalVal').addEventListener('click', editGoal);
  $('btnCopyInvite').addEventListener('click', async () => {
    if (await copyText(state.me.user.inviteCode)) toast('邀请码已复制');
  });
  $('btnCopyMini').addEventListener('click', async () => {
    if (await copyText(state.me.user.inviteCode)) toast('邀请码已复制');
  });
  $('btnCopyLink').addEventListener('click', async () => {
    const url = `${location.origin}/?invite=${state.me.user.inviteCode}`;
    if (await copyText(url)) toast('邀请链接已复制 🔗 朋友点开即自动填码');
  });
  $('friendCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') addFriend(); });
  $('btnAddFriend').addEventListener('click', addFriend);
  $('btnSwitch').addEventListener('click', switchIdentity);
  $('btnSettings').addEventListener('click', openSettings);
  $('btnCloseSettings').addEventListener('click', closeSettings);
  $('btnSaveQuiet').addEventListener('click', saveQuiet);
  $('settingsModal').addEventListener('click', (e) => { if (e.target === $('settingsModal')) closeSettings(); });
  $('btnClearFeed').addEventListener('click', clearFeed);
  $('feedFilters').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-f]');
    if (chip) {
      state.feedFilter = chip.dataset.f;
      renderMsgs();
    }
  });
  $('btnSelAll').addEventListener('click', () => { state.nudgeSel = null; renderNudgeChips(); });
  $('btnSelNone').addEventListener('click', () => { state.nudgeSel = []; renderNudgeChips(); });
  $('nudgeChips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-nudge-id]');
    if (chip) toggleNudge(chip.dataset.nudgeId);
  });

  document.querySelectorAll('.tab-btn').forEach((b) =>
    b.addEventListener('click', () => switchTab(b.dataset.tab)));

  // 列表事件委托
  $('friendList').addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (el) onFriendAct(el.dataset.act, el.dataset.id);
  });
  // 主页横幅「去看看」→ 消息 Tab 并标记已读
  $('panel-drink').addEventListener('click', (e) => {
    if (e.target.closest('[data-act="goto-msgs"]')) {
      switchTab('msgs');
      markFeedRead();
      refreshAll();
    }
  });
  $('reqList').addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (el) onFriendAct(el.dataset.act, el.dataset.id);
  });
  $('feedList').addEventListener('click', (e) => {
    const el = e.target.closest('[data-act="reply"]');
    if (el) onReply(el.dataset.remind);
  });

  setInterval(tickCooldowns, 1000); // 催喝冷却倒计时
  setInterval(() => { if (readToken() && state.me) refreshAll(); }, 20000); // 兜底轮询
}

bindEvents();
boot();
