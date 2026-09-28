const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 10000);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
const connections = new Map();

const GIFT_CATALOG = [
  'Gül', 'Kalp Parmak', 'Parmak Kalp', 'GG', 'Parıltılı Kalp',
  'Galaksi', 'Aslan', 'TikTok Universe', 'Yat', 'Konfeti',
  'Çiçek', 'Kraliyet Tacı', 'Taç', 'Aşk Balonu', 'Diğer'
];

function clean(value) {
  return String(value ?? '').trim();
}
function cleanUser(value) {
  return clean(value).replace(/^@/, '');
}
function norm(value) {
  return clean(value).toLowerCase();
}
function roomCode(value) {
  return clean(value).toUpperCase();
}
function newRoomCode() {
  let code = '';
  do code = `MS-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  while (rooms.has(code));
  return code;
}
function getRoom(code) {
  const room = roomCode(code);
  if (!room) throw new Error('Room gerekli.');
  if (!rooms.has(room)) {
    rooms.set(room, {
      room,
      createdAt: Date.now(),
      username: '',
      connected: false,
      scoreDuration: 15,
      scoring: false,
      scoreEndsAt: 0,
      scoreTimer: null,
      votes: [],
      likes: new Map(),
      giftRules: [],
      raconMembers: new Map(),
      mekanMembers: new Map(),
      wins: 0,
      lastGift: null,
      lastEvent: null
    });
  }
  return rooms.get(room);
}

function avatarOf(data) {
  return clean(
    data?.profilePictureUrl ||
    data?.profilePicture?.url ||
    data?.avatarUrl || ''
  );
}

function membersFrom(map) {
  return [...map.values()]
    .sort((a, b) => b.count - a.count || a.username.localeCompare(b.username))
    .slice(0, 100);
}

function stateOf(s) {
  const unique = new Set(s.votes.map(v => v.username));
  const average = s.votes.length
    ? Number((s.votes.reduce((sum, v) => sum + v.score, 0) / s.votes.length).toFixed(2))
    : 0;
  return {
    room: s.room,
    createdAt: s.createdAt,
    username: s.username,
    connected: s.connected,
    scoreDuration: s.scoreDuration,
    scoring: s.scoring,
    scoreEndsAt: s.scoreEndsAt,
    average,
    participants: unique.size,
    votes: s.votes.slice(-100).reverse(),
    likes: [...s.likes.values()].sort((a, b) => b.likeCount - a.likeCount || a.username.localeCompare(b.username)).slice(0, 100),
    giftCatalog: GIFT_CATALOG,
    giftRules: s.giftRules,
    raconMembers: membersFrom(s.raconMembers),
    mekanMembers: membersFrom(s.mekanMembers),
    wins: s.wins,
    lastGift: s.lastGift,
    lastEvent: s.lastEvent
  };
}

function findRule(s, gift, type) {
  return s.giftRules.find(r => r.active && r.type === type && norm(r.gift) === norm(gift));
}

function addMember(map, username, avatar, gift, count) {
  const user = cleanUser(username) || 'bilinmeyen';
  const c = Math.max(1, Number(count) || 1);
  const old = map.get(user);
  if (old) {
    old.count += c;
    old.gift = gift;
    if (avatar) old.avatar = avatar;
    old.updatedAt = Date.now();
  } else {
    map.set(user, { username: user, avatar: avatar || '', gift, count: c, updatedAt: Date.now() });
  }
}

function handleGift(s, data) {
  const username = cleanUser(data?.uniqueId || data?.nickname || 'bilinmeyen');
  const gift = clean(data?.giftName || data?.gift || 'Hediye');
  const repeatCount = Math.max(1, Number(data?.repeatCount || data?.repeat || 1));
  const avatar = avatarOf(data);
  const racon = findRule(s, gift, 'racon');
  const mekan = findRule(s, gift, 'mekan');
  s.lastGift = { username, avatar, gift, repeatCount, type: racon ? 'racon' : mekan ? 'mekan' : 'none', time: Date.now() };
  if (racon) addMember(s.raconMembers, username, avatar, gift, repeatCount);
  if (mekan) addMember(s.mekanMembers, username, avatar, gift, repeatCount);
  s.lastEvent = { kind: 'gift', ...s.lastGift };
}

function handleLike(s, data) {
  const username = cleanUser(data?.uniqueId || data?.nickname || 'bilinmeyen');
  const avatar = avatarOf(data);
  const count = Math.max(1, Number(data?.likeCount || data?.totalLikeCount || 1));
  const old = s.likes.get(username);
  if (old) {
    old.likeCount += count;
    if (avatar) old.avatar = avatar;
    old.updatedAt = Date.now();
  } else {
    s.likes.set(username, { username, avatar, likeCount: count, updatedAt: Date.now() });
  }
  s.lastEvent = { kind: 'like', username, avatar, count, time: Date.now() };
}

function handleChat(s, data) {
  if (!s.scoring) return;
  const comment = clean(data?.comment);
  if (!/^(10|[1-9])$/.test(comment)) return;
  s.votes.push({
    username: cleanUser(data?.uniqueId || data?.nickname || 'bilinmeyen'),
    avatar: avatarOf(data),
    score: Number(comment),
    time: Date.now()
  });
}

function startScoring(s) {
  if (s.scoreTimer) clearTimeout(s.scoreTimer);
  s.votes = [];
  s.scoring = true;
  s.scoreEndsAt = Date.now() + s.scoreDuration * 1000;
  s.scoreTimer = setTimeout(() => {
    s.scoring = false;
    s.scoreEndsAt = 0;
    s.scoreTimer = null;
  }, s.scoreDuration * 1000);
}

function resolveConnectorConstructor() {
  const mod = require('tiktok-live-connector');
  const candidates = [
    mod?.WebcastPushConnection,
    mod?.default?.WebcastPushConnection,
    mod?.default,
    mod?.TikTokLiveConnection,
    mod?.TikTokLiveConnector
  ];
  const found = candidates.find(value => typeof value === 'function');
  if (!found) {
    const keys = Object.keys(mod || {}).join(', ') || 'no-exports';
    throw new Error(`TikTok bağlantı modülü yüklendi ancak uygun bağlantı sınıfı bulunamadı. Exportlar: ${keys}`);
  }
  return found;
}

async function connectTikTok(s, username) {
  const old = connections.get(s.room);
  if (old) {
    try { await old.disconnect(); } catch (_) {}
    connections.delete(s.room);
  }

  const Connector = resolveConnectorConstructor();
  const connection = new Connector(username, { processInitialData: false });
  connections.set(s.room, connection);
  s.username = username;
  s.connected = false;

  connection.on('connected', () => {
    s.connected = true;
  });
  connection.on('disconnected', () => {
    s.connected = false;
  });
  connection.on('error', () => {
    s.connected = false;
  });
  connection.on('chat', data => handleChat(s, data));
  connection.on('like', data => handleLike(s, data));
  connection.on('gift', data => handleGift(s, data));

  await connection.connect();
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'msyayin', rooms: rooms.size }));
app.post('/api/rooms', (_req, res) => {
  const s = getRoom(newRoomCode());
  res.json({ ok: true, room: s.room, panelUrl: `/panel?room=${encodeURIComponent(s.room)}` });
});
app.get('/api/state', (req, res) => {
  try { return res.json(stateOf(getRoom(req.query.room))); }
  catch (e) { return res.status(400).json({ ok: false, message: e.message }); }
});
app.post('/api/duration', (req, res) => {
  const s = getRoom(req.body.room);
  s.scoreDuration = Math.min(3600, Math.max(1, Number(req.body.duration) || 15));
  res.json(stateOf(s));
});
app.post('/api/score/start', (req, res) => {
  const s = getRoom(req.body.room);
  startScoring(s);
  res.json(stateOf(s));
});
app.post('/api/score/stop', (req, res) => {
  const s = getRoom(req.body.room);
  if (s.scoreTimer) clearTimeout(s.scoreTimer);
  s.scoreTimer = null; s.scoring = false; s.scoreEndsAt = 0;
  res.json(stateOf(s));
});
app.post('/api/rule', (req, res) => {
  const s = getRoom(req.body.room);
  const type = req.body.type === 'mekan' ? 'mekan' : 'racon';
  const gift = clean(req.body.gift);
  if (!gift) return res.status(400).json({ ok: false, message: 'Hediye seç.' });
  const exists = s.giftRules.some(r => r.type === type && norm(r.gift) === norm(gift));
  if (!exists) s.giftRules.push({ gift, type, active: true });
  res.json(stateOf(s));
});
app.post('/api/rule/toggle', (req, res) => {
  const s = getRoom(req.body.room); const i = Number(req.body.index);
  if (!Number.isInteger(i) || !s.giftRules[i]) return res.status(400).json({ ok: false, message: 'Kural bulunamadı.' });
  s.giftRules[i].active = !s.giftRules[i].active; res.json(stateOf(s));
});
app.post('/api/rule/delete', (req, res) => {
  const s = getRoom(req.body.room); const i = Number(req.body.index);
  if (!Number.isInteger(i) || !s.giftRules[i]) return res.status(400).json({ ok: false, message: 'Kural bulunamadı.' });
  s.giftRules.splice(i, 1); res.json(stateOf(s));
});
app.post('/api/likes/reset', (req, res) => { const s = getRoom(req.body.room); s.likes.clear(); res.json(stateOf(s)); });
app.post('/api/racon/reset', (req, res) => { const s = getRoom(req.body.room); s.raconMembers.clear(); res.json(stateOf(s)); });
app.post('/api/mekan/reset', (req, res) => { const s = getRoom(req.body.room); s.mekanMembers.clear(); res.json(stateOf(s)); });
app.post('/api/win', (req, res) => { const s = getRoom(req.body.room); const change = Number(req.body.change) || 0; s.wins = change === 0 ? 0 : Math.max(0, s.wins + change); res.json(stateOf(s)); });
app.post('/api/test/vote', (req, res) => {
  const s = getRoom(req.body.room);
  s.scoring = true;
  s.votes.push({ username: cleanUser(req.body.username) || 'test_kullanici', avatar: '', score: Math.max(1, Math.min(10, Number(req.body.score) || 10)), time: Date.now() });
  res.json(stateOf(s));
});
app.post('/api/test/like', (req, res) => { const s = getRoom(req.body.room); handleLike(s, { uniqueId: req.body.username || 'test_kullanici', likeCount: req.body.count }); res.json(stateOf(s)); });
app.post('/api/test/gift', (req, res) => { const s = getRoom(req.body.room); handleGift(s, { uniqueId: req.body.username || 'test_kullanici', giftName: req.body.gift || 'Hediye', repeatCount: req.body.repeatCount || 1 }); res.json(stateOf(s)); });
app.post('/api/connect', async (req, res) => {
  const s = getRoom(req.body.room); const username = cleanUser(req.body.username);
  if (!username) return res.status(400).json({ ok: false, message: 'TikTok kullanıcı adı gerekli.' });
  try {
    await connectTikTok(s, username);
    res.json({ ok: true, message: `@${username} bağlantısı başlatıldı.`, connected: s.connected });
  } catch (e) {
    s.connected = false;
    res.status(400).json({ ok: false, message: `TikTok bağlantısı kurulamadı: ${e.message}` });
  }
});

app.get('/panel', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'panel.html')));
app.get('/overlay/:type', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));

server.listen(PORT, () => console.log(`MS Yayin running on ${PORT}`));
