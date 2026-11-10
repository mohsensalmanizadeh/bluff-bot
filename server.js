const express = require('express'), http = require('http'), crypto = require('crypto'), fs = require('fs');
const { WebSocketServer } = require('ws');
const { Bot, InlineKeyboard } = require('grammy');
const { BOT_TOKEN, WEBAPP_URL, BOT_USERNAME, DEV, PORT = 3000 } = process.env;
const PRIZE = 500;

// ---------- DB (فایل JSON ساده) ----------
const DBF = 'db.json';
const db = fs.existsSync(DBF) ? JSON.parse(fs.readFileSync(DBF)) : { users: {} };
let st; const save = () => { clearTimeout(st); st = setTimeout(() => fs.writeFileSync(DBF, JSON.stringify(db)), 300); };

// ---------- Telegram bot ----------
if (BOT_TOKEN) {
  const bot = new Bot(BOT_TOKEN);
  bot.command('start', (ctx) => {
    const code = (ctx.match || '').trim().replace(/[^A-Z0-9]/gi, '');
    const url = WEBAPP_URL + (code ? `?room=${code}` : '');
    return ctx.reply(code ? '🎴 دعوت به بازی بلف! برای ورود بزن:' : '🎴 به بازی بلف خوش اومدی!',
      { reply_markup: new InlineKeyboard().webApp('▶️ ورود به بازی', url) });
  });
  bot.start();
}

// ---------- Auth ----------
function verify(init) {
  if (DEV && init.startsWith('dev:')) return { id: init.slice(4), first_name: init.slice(4) };
  const p = new URLSearchParams(init), h = p.get('hash'); p.delete('hash');
  const s = [...p].map(([k, v]) => k + '=' + v).sort().join('\n');
  const k = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  if (crypto.createHmac('sha256', k).update(s).digest('hex') !== h) return null;
  return JSON.parse(p.get('user'));
}
const AV = ['😎', '🦊', '🐯', '🐼', '🦁', '🐸', '🦄', '🐙', '🤖', '👑', '🔥', '🌹'];

// ---------- Game ----------
const rooms = {}, userRoom = {}, clients = {};
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
const rid = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const send = (id, m) => clients[id] && clients[id].readyState === 1 && clients[id].send(JSON.stringify(m));
const BOTN = ['علی', 'سارا', 'رضا', 'مینا', 'کیان'];

function deal(r) {
  const d = shuffle([...Array(52).keys()]);
  r.players.forEach((p) => (p.hand = []));
  d.forEach((c, i) => r.players[i % r.players.length].hand.push(c));
  r.players.forEach((p) => p.hand.sort((a, b) => a % 13 - b % 13));
  Object.assign(r, { pile: [], rank: null, last: null, pendingWin: null, turn: (r.round - 1) % r.players.length, dealt: Date.now() });
}
function view(r, uid) {
  const me = r.players.findIndex((p) => p.id === uid);
  return {
    t: 'state', code: r.code, link: `https://t.me/${BOT_USERNAME}?start=${r.code}`, status: r.status, host: r.host, max: r.max,
    rounds: r.rounds, round: r.round, practice: r.practice, me, dealt: r.dealt, prize: PRIZE, winner: r.winner,
    players: r.players.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, bot: p.bot, n: p.hand.length, score: r.scores[p.id] || 0 })),
    hand: me >= 0 ? r.players[me].hand : [], pile: r.pile.length, rank: r.rank, turn: r.turn, pending: r.pendingWin,
    last: r.last ? { p: r.last.p, n: r.last.cards.length, claim: r.last.claim } : null,
  };
}
function push(r) { r.players.forEach((p) => !p.bot && send(p.id, view(r, p.id))); botAct(r); }
const evt = (r, m) => r.players.forEach((p) => !p.bot && send(p.id, m));

function play(r, i, cards, claim) {
  const p = r.players[i];
  if (r.status !== 'play' || r.turn !== i || r.pendingWin !== null) return 'نوبت شما نیست';
  cards = [...new Set(cards)];
  if (!cards.length || cards.length > 4 || !cards.every((c) => p.hand.includes(c))) return 'کارت نامعتبر';
  if (!(claim >= 0 && claim < 13) || (r.rank !== null && claim !== r.rank)) return 'ادعای نامعتبر';
  p.hand = p.hand.filter((c) => !cards.includes(c));
  r.pile.push(...cards); r.rank = claim; r.last = { p: i, cards, claim };
  if (!p.hand.length) r.pendingWin = i;
  r.turn = (i + 1) % r.players.length;
  push(r);
}
function call(r, i) {
  if (r.status !== 'play' || !r.last || r.last.p === i) return 'قابل انجام نیست';
  const L = r.last, truth = L.cards.every((c) => c % 13 === L.claim);
  const loser = truth ? i : L.p;
  r.players[loser].hand.push(...r.pile);
  r.players[loser].hand.sort((a, b) => a % 13 - b % 13);
  evt(r, { t: 'reveal', cards: L.cards, claim: L.claim, bluff: !truth, caller: r.players[i].name, liar: r.players[L.p].name, loser: r.players[loser].name });
  const pw = r.pendingWin;
  Object.assign(r, { pile: [], rank: null, last: null, pendingWin: null, turn: loser });
  if (pw !== null && truth) return endRound(r, pw);
  push(r);
}
function accept(r, i) {
  if (r.pendingWin === null || r.turn !== i) return 'قابل انجام نیست';
  endRound(r, r.pendingWin);
}
function endRound(r, w) {
  const id = r.players[w].id; r.scores[id] = (r.scores[id] || 0) + 1;
  if (r.round >= r.rounds) {
    const best = Math.max(...r.players.map((p) => r.scores[p.id] || 0));
    const top = r.players.filter((p) => (r.scores[p.id] || 0) === best);
    const win = top.find((p) => p.id === id) || top[0];
    r.status = 'end'; r.winner = win.id;
    const humans = r.players.filter((p) => !p.bot);
    humans.forEach((p) => { const u = db.users[p.id]; if (!u) return; u.games++; if (p.id === win.id) { u.wins++; if (!r.practice && humans.length > 1) u.coins += PRIZE; } send(p.id, { t: 'me', user: u }); });
    save(); push(r);
  } else { r.round++; deal(r); r.players.forEach(() => 0); push(r); }
}

function botAct(r) {
  if (r.status !== 'play' || !r.players[r.turn].bot) return;
  const idx = r.turn, b = r.players[idx];
  setTimeout(() => {
    if (r.status !== 'play' || r.turn !== idx) return;
    if (r.last && r.last.p !== idx) {
      const own = b.hand.filter((c) => c % 13 === r.last.claim).length;
      const imp = r.last.cards.length > 4 - own;
      const pr = imp ? 1 : r.pendingWin !== null ? 0.6 : 0.12 + 0.12 * (r.last.cards.length - 1) + (r.pile.length > 12 ? 0.1 : 0);
      if (Math.random() < pr) return call(r, idx);
      if (r.pendingWin !== null) return accept(r, idx);
    }
    let rank = r.rank;
    const cnt = Array(13).fill(0); b.hand.forEach((c) => cnt[c % 13]++);
    if (rank === null) rank = cnt.indexOf(Math.max(...cnt));
    const honest = b.hand.filter((c) => c % 13 === rank);
    let cards;
    if (honest.length && (Math.random() > 0.25 || b.hand.length === honest.length)) cards = honest.slice(0, 1 + (Math.random() * honest.length | 0));
    else { const other = shuffle(b.hand.filter((c) => c % 13 !== rank)); cards = other.slice(0, Math.min(other.length, 1 + (Math.random() < 0.3 ? 1 : 0))); }
    if (!cards.length) cards = [b.hand[0]];
    play(r, idx, cards, rank);
  }, 1300 + Math.random() * 900);
}

function leave(uid) {
  const r = rooms[userRoom[uid]]; delete userRoom[uid];
  if (!r) return;
  const i = r.players.findIndex((p) => p.id === uid);
  if (i < 0) return;
  if (r.status === 'lobby') { r.players.splice(i, 1); if (r.host === uid && r.players[0]) r.host = r.players[0].id; }
  else if (r.status === 'play') Object.assign(r.players[i], { bot: true, id: 'x' + rid(), name: r.players[i].name + ' 🤖' });
  if (!r.players.some((p) => !p.bot)) { delete rooms[r.code]; return; }
  push(r);
}

// ---------- WebSocket ----------
const app = express(); app.use(express.static('public'));
const server = http.createServer(app), wss = new WebSocketServer({ server });
wss.on('connection', (ws) => {
  let uid = null;
  const err = (m) => ws.send(JSON.stringify({ t: 'err', m }));
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'auth') {
      const tu = verify(m.init || ''); if (!tu) return err('احراز هویت ناموفق');
      uid = String(tu.id); clients[uid] = ws;
      db.users[uid] = db.users[uid] || { name: (tu.username || tu.first_name || 'player').slice(0, 16), avatar: AV[Math.random() * AV.length | 0], coins: 0, wins: 0, games: 0 };
      save(); ws.send(JSON.stringify({ t: 'me', user: db.users[uid] }));
      const r = rooms[userRoom[uid]]; if (r) send(uid, view(r, uid));
      return;
    }
    if (!uid) return;
    const u = db.users[uid], r = rooms[userRoom[uid]], i = r ? r.players.findIndex((p) => p.id === uid) : -1;
    const mk = (o) => { const code = rid(); const room = { code, host: uid, players: [], scores: {}, round: 1, status: 'lobby', pile: [], ...o }; rooms[code] = room; return room; };
    const sit = (room) => { room.players.push({ id: uid, name: u.name, avatar: u.avatar, hand: [] }); userRoom[uid] = room.code; };
    let e;
    switch (m.t) {
      case 'profile': {
        const n = String(m.name || '').trim();
        if (n.length < 3 || n.length > 16) return err('نام کاربری باید ۳ تا ۱۶ کاراکتر باشد');
        if (Object.entries(db.users).some(([k, v]) => k !== uid && v.name.toLowerCase() === n.toLowerCase())) return err('این نام قبلاً گرفته شده');
        u.name = n; if (AV.includes(m.avatar)) u.avatar = m.avatar; save();
        return ws.send(JSON.stringify({ t: 'me', user: u }));
      }
      case 'top':
        return ws.send(JSON.stringify({ t: 'top', list: Object.values(db.users).sort((a, b) => b.coins - a.coins).slice(0, 10).map(({ name, avatar, coins, wins }) => ({ name, avatar, coins, wins })) }));
      case 'practice': {
        if (r) leave(uid);
        const n = Math.min(5, Math.max(1, +m.bots || 1)), room = mk({ practice: true, max: n + 1, rounds: Math.min(9, Math.max(1, +m.rounds || 1)) });
        sit(room); for (let k = 0; k < n; k++) room.players.push({ id: 'b' + k, bot: true, name: BOTN[k], avatar: '🤖', hand: [] });
        room.status = 'play'; deal(room); return push(room);
      }
      case 'create': {
        if (r) leave(uid);
        const room = mk({ practice: false, max: Math.min(6, Math.max(2, +m.max || 2)), rounds: Math.min(9, Math.max(1, +m.rounds || 3)) });
        sit(room); return push(room);
      }
      case 'join': {
        const room = rooms[String(m.code || '').toUpperCase()];
        if (!room || room.status !== 'lobby' || room.practice) return err('اتاق پیدا نشد یا بازی شروع شده');
        if (userRoom[uid] === room.code) return push(room);
        if (room.players.length >= room.max) return err('اتاق پر است');
        if (r) leave(uid); sit(room); return push(room);
      }
      case 'start':
        if (!r || r.host !== uid || r.status !== 'lobby') return;
        if (r.players.length < 2) return err('حداقل ۲ بازیکن لازم است');
        r.status = 'play'; deal(r); return push(r);
      case 'play': e = r && play(r, i, m.cards || [], m.claim); break;
      case 'call': e = r && call(r, i); break;
      case 'accept': e = r && accept(r, i); break;
      case 'leave': leave(uid); return ws.send(JSON.stringify({ t: 'left' }));
    }
    if (e) err(e);
  });
  ws.on('close', () => { if (uid && clients[uid] === ws) { delete clients[uid]; const r = rooms[userRoom[uid]]; if (r && r.status === 'lobby') leave(uid); } });
});
server.listen(PORT, () => console.log('listening', PORT));
