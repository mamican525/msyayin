const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const puppeteer = require('puppeteer-core');
const chromium = require('@sparticuz/chromium');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true, credentials: true } });

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 10000;
const sessions = new Map();

function id(len = 8) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len).toUpperCase();
}

function cleanUsername(v) {
  return String(v || '').trim().replace(/^@+/, '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40);
}

function newSession() {
  const key = id(10);
  const state = {
    key,
    connected: false,
    status: 'hazır',
    tiktokUsername: '',
    createdAt: Date.now(),
    score: {
      active: false,
      seconds: 15,
      startedAt: null,
      endsAt: null,
      votes: []
    },
    raconGifts: [],
    raconGiftKey: '',
    mekanGifts: [],
    mekanGiftKey: '',
    likes: {},
    wins: 0,
    targetWins: 20,
    latestAlert: null,
    recentEvents: [],
    observer: null,
    browser: null,
    page: null
  };
  sessions.set(key, state);
  return state;
}

function getSession(key) {
  const s = sessions.get(String(key || '').toUpperCase());
  return s || null;
}

function safeState(s) {
  return {
    key: s.key,
    connected: s.connected,
    status: s.status,
    tiktokUsername: s.tiktokUsername,
    score: s.score,
    raconGifts: s.raconGifts.slice(0, 100),
    raconGiftKey: s.raconGiftKey,
    mekanGifts: s.mekanGifts.slice(0, 100),
    mekanGiftKey: s.mekanGiftKey,
    likes: s.likes,
    wins: s.wins,
    targetWins: s.targetWins,
    latestAlert: s.latestAlert,
    recentEvents: s.recentEvents.slice(0, 40)
  };
}

function broadcast(s) {
  io.to(s.key).emit('state:update', safeState(s));
}

function pushEvent(s, ev) {
  const row = { ...ev, at: Date.now() };
  s.recentEvents.unshift(row);
  s.recentEvents = s.recentEvents.slice(0, 40);
  io.to(s.key).emit('event:new', row);
}

function normalizeGiftKey(v) {
  return String(v || '').trim().toLowerCase();
}

function nameOfUser(obj) {
  return obj?.nickname || obj?.displayName || obj?.username || obj?.uniqueId || obj?.unique_id || obj?.user?.nickname || obj?.user?.uniqueId || obj?.user?.unique_id || 'Kullanıcı';
}

function giftNameOf(obj) {
  return obj?.giftName || obj?.gift_name || obj?.gift?.name || obj?.gift?.giftName || obj?.name || obj?.itemName || obj?.item_name || 'Hediye';
}

function parseNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(String(v || '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function deepFind(obj, keys, depth = 0, seen = new Set()) {
  if (!obj || typeof obj !== 'object' || depth > 7) return undefined;
  if (seen.has(obj)) return undefined;
  seen.add(obj);
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) return obj[k];
  }
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object') {
      const found = deepFind(v, keys, depth + 1, seen);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function inferType(obj) {
  const t = deepFind(obj, ['event', 'eventName', 'type', 'method', 'action', 'cmd', 'messageType']);
  if (typeof t === 'string') return t.toLowerCase();
  return '';
}

function parsePayload(payload) {
  if (!payload || typeof payload !== 'string') return [];
  let text = payload.trim();
  if (text.startsWith('42')) text = text.slice(2);
  else if (text.startsWith('4')) text = text.slice(1);
  const out = [];
  const candidates = [text];
  if (text.includes('\u0000')) candidates.push(text.replace(/\u0000/g, ''));
  for (const c of candidates) {
    try {
      const val = JSON.parse(c);
      out.push(val);
    } catch {}
  }
  return out;
}

function processObject(s, obj) {
  if (!obj) return;
  if (Array.isArray(obj)) {
    for (const x of obj) processObject(s, x);
    return;
  }
  if (typeof obj !== 'object') return;

  const type = inferType(obj);
  const username = String(nameOfUser(obj));
  const message = deepFind(obj, ['comment', 'commentText', 'message', 'content', 'text']);
  const rawGift = giftNameOf(obj);
  const gift = String(rawGift || '');
  const likeCount = parseNumber(deepFind(obj, ['likeCount', 'diggCount', 'likes', 'count', 'repeatCount', 'repeat_count']));
  const hasGift = !!deepFind(obj, ['giftName', 'gift_name', 'giftId', 'gift_id', 'gift'] ) || /gift/.test(type);
  const looksLike = /like|digg/.test(type) || deepFind(obj, ['likeCount', 'diggCount']) !== undefined;
  const looksComment = /comment|chat|message/.test(type) || (typeof message === 'string' && message.length > 0 && !hasGift);
  
  if (looksComment && typeof message === 'string' && message.trim()) {
    pushEvent(s, { type: 'comment', username, message: message.trim() });
    handleComment(s, username, message.trim());
  }

  if (hasGift) {
    const qty = Math.max(1, parseNumber(deepFind(obj, ['repeatCount', 'repeat_count', 'quantity', 'count'])) || 1);
    pushEvent(s, { type: 'gift', username, gift, quantity: qty });
    handleGift(s, username, gift, qty);
  }

  if (looksLike && likeCount >= 0) {
    const qty = Math.max(1, likeCount || 1);
    if (username && username !== 'Kullanıcı') {
      s.likes[username] = (s.likes[username] || 0) + qty;
      pushEvent(s, { type: 'like', username, count: qty, total: s.likes[username] });
      broadcast(s);
    }
  }
}

function handleComment(s, username, message) {
  if (!s.score.active) return;
  const m = message.match(/(?:^|\s)(10|[1-9])(?:\s|$)/);
  if (!m) return;
  const value = Number(m[1]);
  const existing = s.score.votes.findIndex(v => v.username.toLowerCase() === username.toLowerCase());
  const vote = { username, value, at: Date.now() };
  if (existing >= 0) s.score.votes.splice(existing, 1);
  s.score.votes.unshift(vote);
  broadcast(s);
}

function handleGift(s, username, gift, quantity) {
  const key = normalizeGiftKey(gift);
  if (!key) return;
  const doGift = (kind) => {
    const item = { username, gift, quantity, at: Date.now() };
    const list = kind === 'racon' ? s.raconGifts : s.mekanGifts;
    list.unshift(item);
    if (kind === 'racon') s.raconGifts = list.slice(0, 100);
    else s.mekanGifts = list.slice(0, 100);
    s.latestAlert = { kind, username, gift, quantity, at: Date.now() };
  };
  if (s.raconGiftKey && key === s.raconGiftKey) doGift('racon');
  if (s.mekanGiftKey && key === s.mekanGiftKey) doGift('mekan');
  broadcast(s);
}

async function browserPath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  return await chromium.executablePath();
}

async function stopObserver(s) {
  s.connected = false;
  if (s.page) { try { await s.page.close(); } catch {} }
  if (s.browser) { try { await s.browser.close(); } catch {} }
  s.page = null;
  s.browser = null;
  s.observer = null;
}

async function startObserver(s) {
  await stopObserver(s);
  const username = cleanUsername(s.tiktokUsername);
  if (!username) throw new Error('TikTok kullanıcı adı girilmedi.');
  s.status = 'TikTok LIVE sayfası açılıyor…';
  broadcast(s);

  const executablePath = await browserPath();
  s.browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      ...chromium.args,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1365,900'
    ],
    defaultViewport: { width: 1365, height: 900 }
  });
  s.page = await s.browser.newPage();
  await s.page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36');
  await s.page.setExtraHTTPHeaders({ 'accept-language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7' });

  const cdp = await s.page.target().createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketFrameReceived', ({ response }) => {
    const candidates = parsePayload(response?.payloadData || '');
    for (const c of candidates) processObject(s, c);
  });

  s.page.on('response', async (res) => {
    try {
      const url = res.url();
      if (!/tiktok\.com|byteoversea|ibytedtos|tiktokcdn/i.test(url)) return;
      const ct = res.headers()['content-type'] || '';
      if (!ct.includes('json') && !ct.includes('javascript') && !ct.includes('text')) return;
      if (!['xhr', 'fetch'].includes(res.request().resourceType())) return;
      const text = await res.text();
      if (text && text.length < 2_000_000) {
        const parsed = parsePayload(text);
        for (const p of parsed) processObject(s, p);
      }
    } catch {}
  });

  const liveUrl = `https://www.tiktok.com/@${encodeURIComponent(username)}/live`;
  await s.page.goto(liveUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await new Promise(r => setTimeout(r, 8000));

  s.connected = true;
  s.status = 'TikTok LIVE gözlemleniyor';
  broadcast(s);
  pushEvent(s, { type: 'system', message: `@${username} LIVE sayfası açıldı.` });

  s.observer = setInterval(async () => {
    if (!s.page) return;
    try {
      const bodyText = await s.page.evaluate(() => document.body?.innerText?.slice(-8000) || '');
      // Visible chat/gift toasts vary by TikTok web version. Detect numeric 1-10 chat lines as a best-effort fallback.
      const lines = bodyText.split(/\n+/).map(x => x.trim()).filter(Boolean);
      for (let i = Math.max(0, lines.length - 80); i < lines.length; i++) {
        const line = lines[i];
        const m = line.match(/^@?([A-Za-z0-9._-]{2,40})\s*[:：]\s*(10|[1-9])$/);
        if (m) handleComment(s, m[1], m[2]);
      }
    } catch {}
  }, 2500);
}

app.get('/api/session/new', (req, res) => res.json({ key: newSession().key }));
app.get('/api/session/:key', (req, res) => {
  const s = getSession(req.params.key);
  if (!s) return res.status(404).json({ error: 'Oturum bulunamadı' });
  res.json(safeState(s));
});

app.post('/api/connect', async (req, res) => {
  const s = getSession(req.body.key);
  if (!s) return res.status(404).json({ error: 'Oturum bulunamadı' });
  s.tiktokUsername = cleanUsername(req.body.username);
  if (!s.tiktokUsername) return res.status(400).json({ error: 'TikTok kullanıcı adı gerekli' });
  startObserver(s).then(() => broadcast(s)).catch(err => {
    s.connected = false;
    s.status = `Bağlantı hatası: ${err.message}`;
    pushEvent(s, { type: 'error', message: err.message });
    broadcast(s);
  });
  res.json({ ok: true });
});

app.post('/api/disconnect', async (req, res) => {
  const s = getSession(req.body.key);
  if (!s) return res.status(404).json({ error: 'Oturum bulunamadı' });
  await stopObserver(s);
  s.status = 'bağlantı kesildi';
  broadcast(s);
  res.json({ ok: true });
});

app.post('/api/settings/score', (req, res) => {
  const s = getSession(req.body.key);
  if (!s) return res.status(404).json({ error: 'Oturum bulunamadı' });
  const sec = Math.max(5, Math.min(600, parseNumber(req.body.seconds) || 15));
  s.score.seconds = sec;
  broadcast(s);
  res.json({ ok: true });
});

app.post('/api/score/start', (req, res) => {
  const s = getSession(req.body.key);
  if (!s) return res.status(404).json({ error: 'Oturum bulunamadı' });
  const sec = s.score.seconds || 15;
  s.score.active = true;
  s.score.startedAt = Date.now();
  s.score.endsAt = Date.now() + sec * 1000;
  s.score.votes = [];
  pushEvent(s, { type: 'system', message: `Puanlama başladı (${sec} sn)` });
  broadcast(s);
  setTimeout(() => {
    const cur = sessions.get(s.key);
    if (!cur || cur.score.startedAt !== s.score.startedAt) return;
    cur.score.active = false;
    cur.score.endsAt = null;
    pushEvent(cur, { type: 'system', message: 'Puanlama tamamlandı.' });
    broadcast(cur);
  }, sec * 1000 + 150);
  res.json({ ok: true });
});

app.post('/api/gift/select', (req, res) => {
  const s = getSession(req.body.key);
  if (!s) return res.status(404).json({ error: 'Oturum bulunamadı' });
  const kind = req.body.kind === 'mekan' ? 'mekan' : 'racon';
  const value = String(req.body.gift || '').trim();
  if (kind === 'racon') s.raconGiftKey = normalizeGiftKey(value);
  else s.mekanGiftKey = normalizeGiftKey(value);
  broadcast(s);
  res.json({ ok: true });
});

app.post('/api/win', (req, res) => {
  const s = getSession(req.body.key);
  if (!s) return res.status(404).json({ error: 'Oturum bulunamadı' });
  const delta = Math.max(-50, Math.min(50, parseNumber(req.body.delta)));
  s.wins = Math.max(0, s.wins + delta);
  if (req.body.target != null) s.targetWins = Math.max(1, Math.min(999, parseNumber(req.body.target) || 20));
  broadcast(s);
  res.json({ ok: true });
});

app.post('/api/test', (req, res) => {
  const s = getSession(req.body.key);
  if (!s) return res.status(404).json({ error: 'Oturum bulunamadı' });
  const type = req.body.type;
  const username = String(req.body.username || 'TestKullanici');
  if (type === 'vote') handleComment(s, username, String(req.body.value || '10'));
  if (type === 'gift') handleGift(s, username, String(req.body.gift || 'Gül'), 1);
  if (type === 'like') {
    const qty = Math.max(1, parseNumber(req.body.count) || 1);
    s.likes[username] = (s.likes[username] || 0) + qty;
    pushEvent(s, { type: 'like', username, count: qty, total: s.likes[username], test: true });
  }
  if (type === 'win') s.wins = Math.max(0, s.wins + (parseNumber(req.body.delta) || 1));
  broadcast(s);
  res.json({ ok: true });
});

io.on('connection', socket => {
  socket.on('join', key => {
    const s = getSession(key);
    if (!s) return;
    socket.join(s.key);
    socket.emit('state:update', safeState(s));
  });
});

setInterval(() => {
  const cutoff = Date.now() - 1000 * 60 * 60 * 12;
  for (const [key, s] of sessions) {
    if (s.createdAt < cutoff) {
      stopObserver(s).catch(() => {});
      sessions.delete(key);
    }
  }
}, 1000 * 60 * 30);

app.get('/overlay/:name', (req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(PORT, () => console.log(`MS YAYIN listening on port ${PORT}`));
