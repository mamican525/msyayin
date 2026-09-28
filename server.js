const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT) || 10000;
const PUBLIC_DIR = path.join(__dirname, 'public');

app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: false, limit: '256kb' }));

const rooms = new Map();
const liveConnections = new Map();

function cleanUser(value) {
  return String(value || '').replace(/^@+/, '').trim() || 'bilinmeyen';
}

function makeRoomCode() {
  let code;
  do {
    code = 'MS-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  } while (rooms.has(code));
  return code;
}

function makeRoom() {
  return {
    room: makeRoomCode(),
    createdAt: Date.now(),
    username: '',
    connected: false,
    scoreDuration: 15,
    scoring: false,
    scoreEndsAt: 0,
    votes: [],
    likes: new Map(),
    raconRules: [],
    mekanRules: [],
    raconEntries: [],
    mekanEntries: [],
    wins: 0,
    penalty: 20,
    lastGift: null,
    ticker: '',
    error: ''
  };
}

function getRoom(roomCode) {
  const key = String(roomCode || '').trim().toUpperCase();
  if (!key) return null;
  return rooms.get(key) || null;
}

function ensureRoom(roomCode) {
  let room = getRoom(roomCode);
  if (!room) {
    room = makeRoom();
    if (roomCode) room.room = String(roomCode).trim().toUpperCase();
    rooms.set(room.room, room);
  }
  return room;
}

function uniqueParticipants(room) {
  return new Set(room.votes.map(v => v.username)).size;
}

function averageScore(room) {
  if (!room.votes.length) return 0;
  const sum = room.votes.reduce((total, v) => total + v.score, 0);
  return Number((sum / room.votes.length).toFixed(2));
}

function serializeRoom(room) {
  return {
    room: room.room,
    createdAt: room.createdAt,
    username: room.username,
    connected: room.connected,
    scoreDuration: room.scoreDuration,
    scoring: room.scoring,
    scoreEndsAt: room.scoreEndsAt,
    average: averageScore(room),
    participants: uniqueParticipants(room),
    votes: room.votes.slice(-100).reverse(),
    raconRules: [...room.raconRules],
    mekanRules: [...room.mekanRules],
    raconEntries: room.raconEntries.slice(-100).reverse(),
    mekanEntries: room.mekanEntries.slice(-100).reverse(),
    likes: [...room.likes.entries()]
      .map(([username, likeCount]) => ({ username, likeCount }))
      .sort((a, b) => b.likeCount - a.likeCount)
      .slice(0, 100),
    wins: room.wins,
    penalty: room.penalty,
    lastGift: room.lastGift,
    ticker: room.ticker,
    error: room.error
  };
}

function getRuleForGift(room, giftName) {
  const normalized = String(giftName || '').trim().toLocaleLowerCase('tr-TR');
  if (!normalized) return null;
  if (room.raconRules.some(x => x.toLocaleLowerCase('tr-TR') === normalized)) return 'racon';
  if (room.mekanRules.some(x => x.toLocaleLowerCase('tr-TR') === normalized)) return 'mekan';
  return null;
}

function addEntry(list, username, giftName) {
  const existing = list.find(item => item.username === username && item.gift === giftName);
  if (existing) {
    existing.count += 1;
    existing.time = Date.now();
  } else {
    list.push({ username, gift: giftName, count: 1, time: Date.now() });
  }
}

function processGift(room, username, giftName) {
  const category = getRuleForGift(room, giftName);
  room.lastGift = { username, gift: giftName, category: category || 'none', time: Date.now() };
  if (category === 'racon') addEntry(room.raconEntries, username, giftName);
  if (category === 'mekan') addEntry(room.mekanEntries, username, giftName);
  room.ticker = `@${username} • ${giftName}`;
}

function processVote(room, username, rawText) {
  if (!room.scoring) return false;
  const match = String(rawText || '').match(/\b(10|[1-9])\b/);
  if (!match) return false;
  const score = Number(match[1]);
  room.votes.push({ username, score, comment: String(rawText || ''), time: Date.now() });
  return true;
}

function processLike(room, username, count) {
  const n = Math.max(1, Number(count) || 1);
  room.likes.set(username, (room.likes.get(username) || 0) + n);
}

async function loadTikTokConnector() {
  try {
    const mod = await import('tiktok-live-connector');
    return mod.WebcastPushConnection || mod.default?.WebcastPushConnection || mod.default || null;
  } catch (dynamicError) {
    try {
      const mod = require('tiktok-live-connector');
      return mod.WebcastPushConnection || mod.default?.WebcastPushConnection || mod.default || mod || null;
    } catch (requireError) {
      return null;
    }
  }
}

function getUserFromEvent(data) {
  return cleanUser(data?.uniqueId || data?.username || data?.nickname || data?.user?.uniqueId);
}

async function connectTikTok(room, username) {
  const Connector = await loadTikTokConnector();
  if (typeof Connector !== 'function') {
    throw new Error('TikTok bağlantı modülü yüklenemedi. Panel çalışır; TikTok bağlantı modülü bu sunucuda kullanılamıyor.');
  }

  const previous = liveConnections.get(room.room);
  if (previous?.connection && typeof previous.connection.disconnect === 'function') {
    try { await previous.connection.disconnect(); } catch (_) {}
  }

  const connection = new Connector(username, { processInitialData: false });
  const holder = { connection };
  liveConnections.set(room.room, holder);
  room.username = username;
  room.error = '';

  const markConnected = () => {
    room.connected = true;
    room.error = '';
  };
  const markDisconnected = () => {
    room.connected = false;
  };
  const markError = err => {
    room.connected = false;
    room.error = err?.message || String(err || 'TikTok bağlantı hatası');
  };

  if (typeof connection.on === 'function') {
    connection.on('connected', markConnected);
    connection.on('disconnected', markDisconnected);
    connection.on('error', markError);

    connection.on('chat', data => {
      const user = getUserFromEvent(data);
      const text = String(data?.comment || '').trim();
      processVote(room, user, text);
    });

    connection.on('like', data => {
      const user = getUserFromEvent(data);
      const count = Number(data?.likeCount || data?.totalLikeCount || 1) || 1;
      processLike(room, user, count);
    });

    connection.on('gift', data => {
      const user = getUserFromEvent(data);
      const giftName = String(data?.giftName || data?.gift || data?.repeatEnd || 'Hediye').trim();
      processGift(room, user, giftName);
    });
  }

  await connection.connect();
  room.connected = true;
  return true;
}

function scheduleScoreStop(room) {
  const remaining = Math.max(0, room.scoreEndsAt - Date.now());
  setTimeout(() => {
    if (room.scoring && Date.now() >= room.scoreEndsAt) {
      room.scoring = false;
      room.scoreEndsAt = 0;
    }
  }, remaining + 50);
}

// ---------- API: these routes are intentionally declared BEFORE any catch-all HTML route ----------

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'msyayin', rooms: rooms.size, now: Date.now() });
});

app.post('/api/rooms', (_req, res) => {
  const room = makeRoom();
  rooms.set(room.room, room);
  res.status(201).json({ ok: true, room: room.room });
});

app.get('/api/state', (req, res) => {
  const room = getRoom(req.query.room);
  if (!room) return res.status(404).json({ ok: false, error: 'ROOM bulunamadı.' });
  res.json({ ok: true, state: serializeRoom(room) });
});

app.post('/api/settings', (req, res) => {
  const room = ensureRoom(req.body.room);
  if (req.body.duration !== undefined) room.scoreDuration = Math.max(1, Math.min(3600, Number(req.body.duration) || 15));
  if (req.body.penalty !== undefined) room.penalty = Math.max(0, Number(req.body.penalty) || 20);
  res.json({ ok: true, state: serializeRoom(room) });
});

app.post('/api/score/start', (req, res) => {
  const room = ensureRoom(req.body.room);
  room.scoring = true;
  room.votes = [];
  room.scoreEndsAt = Date.now() + room.scoreDuration * 1000;
  scheduleScoreStop(room);
  res.json({ ok: true, state: serializeRoom(room) });
});

app.post('/api/score/stop', (req, res) => {
  const room = ensureRoom(req.body.room);
  room.scoring = false;
  room.scoreEndsAt = 0;
  res.json({ ok: true, state: serializeRoom(room) });
});

app.post('/api/rules', (req, res) => {
  const room = ensureRoom(req.body.room);
  const gift = String(req.body.gift || '').trim();
  const category = req.body.category === 'mekan' ? 'mekan' : 'racon';
  if (!gift) return res.status(400).json({ ok: false, error: 'Hediye seçilmedi.' });
  const target = category === 'racon' ? room.raconRules : room.mekanRules;
  if (!target.includes(gift)) target.push(gift);
  res.json({ ok: true, state: serializeRoom(room) });
});

app.delete('/api/rules', (req, res) => {
  const room = ensureRoom(req.body.room);
  const gift = String(req.body.gift || '').trim();
  const category = req.body.category === 'mekan' ? 'mekan' : 'racon';
  const target = category === 'racon' ? room.raconRules : room.mekanRules;
  const filtered = target.filter(x => x !== gift);
  if (category === 'racon') room.raconRules = filtered; else room.mekanRules = filtered;
  res.json({ ok: true, state: serializeRoom(room) });
});

app.post('/api/likes/reset', (req, res) => {
  const room = ensureRoom(req.body.room);
  room.likes.clear();
  res.json({ ok: true, state: serializeRoom(room) });
});

app.post('/api/win', (req, res) => {
  const room = ensureRoom(req.body.room);
  const change = Number(req.body.change) || 0;
  if (req.body.reset) room.wins = 0;
  else room.wins = Math.max(0, Math.min(20, room.wins + change));
  res.json({ ok: true, state: serializeRoom(room) });
});

app.post('/api/test/vote', (req, res) => {
  const room = ensureRoom(req.body.room);
  const wasScoring = room.scoring;
  if (!wasScoring) room.scoring = true;
  const username = cleanUser(req.body.username);
  const scoreText = String(req.body.score || '10');
  processVote(room, username, scoreText);
  if (!wasScoring) room.scoring = false;
  res.json({ ok: true, state: serializeRoom(room) });
});

app.post('/api/test/like', (req, res) => {
  const room = ensureRoom(req.body.room);
  processLike(room, cleanUser(req.body.username), req.body.count);
  res.json({ ok: true, state: serializeRoom(room) });
});

app.post('/api/test/gift', (req, res) => {
  const room = ensureRoom(req.body.room);
  processGift(room, cleanUser(req.body.username), String(req.body.gift || 'Galaxy').trim());
  res.json({ ok: true, state: serializeRoom(room) });
});

app.post('/api/connect', async (req, res) => {
  const room = ensureRoom(req.body.room);
  const username = cleanUser(req.body.username);
  if (!username || username === 'bilinmeyen') return res.status(400).json({ ok: false, error: 'TikTok kullanıcı adı gerekli.' });
  try {
    await connectTikTok(room, username);
    res.json({ ok: true, message: 'TikTok bağlantısı kuruldu.', state: serializeRoom(room) });
  } catch (error) {
    room.connected = false;
    room.error = error?.message || String(error);
    res.status(500).json({ ok: false, error: room.error, state: serializeRoom(room) });
  }
});

// Static assets come after API routes.
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

app.get('/panel', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'panel.html')));
app.get('/overlay', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'overlay.html')));
app.get('/', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ ok: false, error: 'API adresi bulunamadı.' });
  res.status(404).send('Sayfa bulunamadı.');
});

app.listen(PORT, () => {
  console.log(`MS Yayin running on port ${PORT}`);
});
