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
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const sessions = new Map();

function id(len = 10) { return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len).toUpperCase(); }
function cleanUsername(v) { return String(v || '').trim().replace(/^@+/, '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 40); }
function normalize(v) { return String(v || '').trim().toLowerCase(); }
function parseNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

function newSession() {
  const key = id();
  const s = {
    key,
    createdAt: Date.now(),
    connected: false,
    status: 'Hazır',
    tiktokUsername: '',
    liveFound: false,
    lastEventAt: null,
    score: { active: false, seconds: 15, startedAt: null, endsAt: null, votes: [] },
    raconGift: '',
    mekanGift: '',
    raconGifts: [],
    mekanGifts: [],
    likes: {},
    wins: 0,
    targetWins: 20,
    recentEvents: [],
    giftOptions: [],
    latestAlert: null,
    browser: null,
    page: null,
    observerTimer: null,
    processed: new Set(),
    lastDomScan: 0,
  };
  sessions.set(key, s);
  return s;
}
function getSession(key) { return sessions.get(String(key || '').toUpperCase()) || null; }

function safeState(s) {
  return {
    key: s.key,
    connected: s.connected,
    status: s.status,
    tiktokUsername: s.tiktokUsername,
    liveFound: s.liveFound,
    lastEventAt: s.lastEventAt,
    score: s.score,
    raconGift: s.raconGift,
    mekanGift: s.mekanGift,
    raconGifts: s.raconGifts.slice(0, 100),
    mekanGifts: s.mekanGifts.slice(0, 100),
    likes: s.likes,
    wins: s.wins,
    targetWins: s.targetWins,
    recentEvents: s.recentEvents.slice(0, 60),
    giftOptions: s.giftOptions.slice(0, 100),
    latestAlert: s.latestAlert,
  };
}
function broadcast(s) { io.to(s.key).emit('state:update', safeState(s)); }
function pushEvent(s, ev) {
  const row = { id: id(12), ...ev, at: Date.now() };
  s.recentEvents.unshift(row);
  s.recentEvents = s.recentEvents.slice(0, 60);
  s.lastEventAt = row.at;
  io.to(s.key).emit('event:new', row);
}
function seen(s, key) {
  if (!key) return false;
  if (s.processed.has(key)) return true;
  s.processed.add(key);
  if (s.processed.size > 2500) s.processed = new Set([...s.processed].slice(-1600));
  return false;
}

function addGiftOption(s, gift) {
  const g = String(gift || '').trim();
  const k = normalize(g);
  if (!g || !k || ['hediye','gift','send','gönderdi','sent'].includes(k)) return;
  if (!s.giftOptions.some(x => normalize(x) === k)) {
    s.giftOptions.unshift(g);
    s.giftOptions = s.giftOptions.slice(0, 100);
  }
}

function addVote(s, username, value, avatarUrl = '') {
  if (!s.score.active) return;
  if (!username || !Number.isInteger(value) || value < 1 || value > 10) return;
  const vote = { username, value, avatarUrl, at: Date.now() };
  s.score.votes.unshift(vote); // her oy tutulur; eski oylar silinmez
  s.score.votes = s.score.votes.slice(0, 1000);
  broadcast(s);
}

function addLike(s, username, count, avatarUrl = '') {
  if (!username || username === 'Kullanıcı') return;
  const n = Math.max(1, parseNumber(count) || 1);
  if (!s.likes[username]) s.likes[username] = { count: 0, avatarUrl };
  s.likes[username].count += n;
  if (avatarUrl) s.likes[username].avatarUrl = avatarUrl;
  pushEvent(s, { type: 'like', username, count: n, total: s.likes[username].count, avatarUrl });
  broadcast(s);
}

function addSelectedGift(s, username, gift, quantity = 1, avatarUrl = '') {
  const g = String(gift || '').trim();
  const k = normalize(g);
  if (!g || !username || !k) return;
  addGiftOption(s, g);
  const item = { username, gift: g, quantity: Math.max(1, quantity), avatarUrl, at: Date.now() };
  let matched = false;
  if (s.raconGift && k === normalize(s.raconGift)) {
    s.raconGifts.unshift(item);
    s.raconGifts = s.raconGifts.slice(0, 100);
    s.latestAlert = { kind: 'racon', ...item };
    matched = true;
  }
  if (s.mekanGift && k === normalize(s.mekanGift)) {
    s.mekanGifts.unshift(item);
    s.mekanGifts = s.mekanGifts.slice(0, 100);
    s.latestAlert = { kind: 'mekan', ...item };
    matched = true;
  }
  pushEvent(s, { type: 'gift', username, gift: g, quantity: item.quantity, avatarUrl, matched });
  broadcast(s);
}

function extractUserLine(lines) {
  const cleaned = lines.map(x => String(x).trim()).filter(Boolean);
  if (cleaned.length < 2) return null;
  for (let i = 0; i < cleaned.length - 1; i++) {
    const a = cleaned[i].replace(/^@/, '');
    const b = cleaned[i + 1];
    if (/^[A-Za-z0-9._-]{2,40}$/.test(a) && b.length >= 1 && b.length <= 220 && !/^(Follow|Takip|Like|Beğen|Share|Paylaş)$/i.test(b)) {
      return { username: a, message: b };
    }
  }
  return null;
}
function parseDomRecord(rec) {
  if (!rec || typeof rec !== 'object') return;
  const username = cleanUsername(rec.username || '');
  const avatarUrl = String(rec.avatarUrl || '');
  const message = String(rec.message || '').trim();
  if (rec.kind === 'comment' && username && message) {
    const m = message.match(/^(10|[1-9])$/);
    if (m && !seen(currentSessionForRecord, `vote|${username}|${message}|${rec.fingerprint || ''}`)) return;
  }
}

// ----- Browser observation helpers -----
function printableUtf8(buf) {
  try {
    const s = Buffer.from(buf).toString('utf8');
    const ok = s.length > 0 && /^[\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]+$/.test(s);
    return ok ? s : '';
  } catch { return ''; }
}
function readVarint(buf, pos) {
  let n = 0n, shift = 0n, i = pos;
  while (i < buf.length && shift < 70n) {
    const b = buf[i++];
    n |= BigInt(b & 127) << shift;
    if ((b & 128) === 0) return { value: Number(n <= BigInt(Number.MAX_SAFE_INTEGER) ? n : 0), next: i };
    shift += 7n;
  }
  return null;
}
function protoStrings(buf, depth = 0, out = []) {
  if (!Buffer.isBuffer(buf) || depth > 5 || buf.length < 2 || buf.length > 2_000_000) return out;
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos); if (!tag) break; pos = tag.next;
    const wire = tag.value & 7;
    if (wire === 0) { const v = readVarint(buf, pos); if (!v) break; pos = v.next; continue; }
    if (wire === 1) { pos += 8; continue; }
    if (wire === 5) { pos += 4; continue; }
    if (wire !== 2) break;
    const len = readVarint(buf, pos); if (!len || len.value < 0 || len.value > buf.length - len.next) break;
    pos = len.next;
    const part = buf.subarray(pos, pos + len.value); pos += len.value;
    const str = printableUtf8(part);
    if (str && str.length >= 1 && str.length <= 240) out.push(str);
    if (part.length >= 2) protoStrings(part, depth + 1, out);
  }
  return out;
}
function looksUsername(v) { return /^[A-Za-z0-9._-]{2,40}$/.test(v) && !/^(LIVE|TikTok|Follow|Takip|Share|Paylaş|Gift|Hediye|Kullanıcı)$/i.test(v); }
function processBinaryFrame(s, frame) {
  try {
    const opcode = Number(frame?.response?.opcode || 1);
    let buf;
    if (opcode === 2) buf = Buffer.from(frame?.response?.payloadData || '', 'base64');
    else buf = Buffer.from(String(frame?.response?.payloadData || ''), 'utf8');
    if (!buf.length) return;
    const strings = [...new Set(protoStrings(buf))];
    if (!strings.length) return;
    const sig = crypto.createHash('sha1').update(strings.slice(0, 80).join('|')).digest('hex');
    if (seen(s, `ws:${sig}`)) return;

    // The browser's TikTok websocket uses protobuf. We don't need to sign the request ourselves;
    // for scoring we only need a nearby user + exact 1-10 message string.
    for (let i = 0; i < strings.length; i++) {
      if (!/^(10|[1-9])$/.test(strings[i])) continue;
      const candidates = [strings[i - 1], strings[i + 1], ...strings.slice(Math.max(0, i - 4), i), ...strings.slice(i + 1, i + 5)];
      const user = candidates.find(looksUsername);
      if (user && s.score.active) {
        addVote(s, user, Number(strings[i]), '');
        pushEvent(s, { type: 'comment', username: user, message: strings[i], source: 'websocket' });
        break;
      }
    }
  } catch {}
}

async function installDomObserver(page) {
  await page.evaluate(() => {
    if (window.__MSYAYIN_INSTALLED__) return;
    window.__MSYAYIN_INSTALLED__ = true;
    window.__MSYAYIN_QUEUE__ = [];
    window.__MSYAYIN_SEEN__ = new Set();
    const norm = x => String(x || '').replace(/\\s+/g, ' ').trim();
    const imgFor = el => {
      let p = el;
      for (let i = 0; i < 5 && p; i++, p = p.parentElement) {
        const img = p.querySelector?.('img');
        if (img?.src) return img.src;
      }
      return '';
    };
    const push = rec => {
      const key = [rec.kind, rec.username, rec.message, rec.gift, rec.count, rec.text].join('|').slice(0, 800);
      if (!key || window.__MSYAYIN_SEEN__.has(key)) return;
      window.__MSYAYIN_SEEN__.add(key);
      if (window.__MSYAYIN_SEEN__.size > 1800) window.__MSYAYIN_SEEN__ = new Set([...window.__MSYAYIN_SEEN__].slice(-1000));
      window.__MSYAYIN_QUEUE__.push(rec);
    };
    const scan = root => {
      const selectors = [
        '[data-e2e*="comment" i]', '[data-e2e*="chat" i]', '[data-e2e*="gift" i]', '[data-e2e*="like" i]',
        '[class*="comment" i]', '[class*="chat" i]', '[class*="gift" i]', '[class*="like" i]'
      ];
      const els = root.querySelectorAll ? [...root.querySelectorAll(selectors.join(','))] : [];
      for (const el of els.slice(-120)) {
        const text = norm(el.innerText || el.textContent || '');
        if (!text || text.length > 260) continue;
        const lines = (el.innerText || '').split(/\n+/).map(norm).filter(Boolean);
        const img = imgFor(el);
        const pair = lines.length >= 2 ? { username: lines.find(x => /^[A-Za-z0-9._-]{2,40}$/.test(x.replace(/^@/, '')))?.replace(/^@/, ''), message: lines[lines.length - 1] } : null;
        const voteLine = text.match(/(?:^|\s)@([A-Za-z0-9._-]{2,40})\s+(10|[1-9])(?:\s|$)/);
        if (pair?.username && /^(10|[1-9])$/.test(pair.message)) push({ kind: 'comment', username: pair.username, message: pair.message, avatarUrl: img });
        else if (voteLine) push({ kind: 'comment', username: voteLine[1], message: voteLine[2], avatarUrl: img });

        if (/(sent|gönderdi|hediye|gift|gave)/i.test(text)) {
          const user = pair?.username || (text.match(/@([A-Za-z0-9._-]{2,40})/) || [])[1] || '';
          const qty = parseInt((text.match(/(?:x|×)\s*(\d+)/i) || [])[1] || '1', 10);
          const parts = text.split(/\s+/);
          const gift = parts.filter(x => !/^@?[A-Za-z0-9._-]{2,40}$/.test(x)).filter(x => !/^(sent|gönderdi|gift|hediye|x\d+)$/i.test(x)).slice(-4).join(' ');
          if (user && gift) push({ kind: 'gift', username: user, gift, quantity: qty, avatarUrl: img, text });
        }
        if (/(liked|beğendi|beğeni|likes)/i.test(text)) {
          const user = pair?.username || (text.match(/@([A-Za-z0-9._-]{2,40})/) || [])[1] || '';
          const count = parseInt((text.match(/(\d[\d.,]*)\s*(like|beğeni)/i) || [])[1]?.replace(/[.,]/g, '') || '1', 10);
          if (user) push({ kind: 'like', username: user, count: Math.max(1, count), avatarUrl: img, text });
        }
      }
    };
    const mo = new MutationObserver(muts => {
      for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) scan(n);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true });
    window.__MSYAYIN_SCAN__ = () => scan(document);
    setInterval(() => { try { scan(document); } catch {} }, 1800);
  });
}
async function looksLikeLive(page) {
  const info = await page.evaluate(() => {
    const body = (document.body?.innerText || '').slice(0, 30000);
    const title = document.title || '';
    const hasChat = !!document.querySelector('[data-e2e*="comment" i],[data-e2e*="chat" i],[class*="chat" i]');
    const blocked = /captcha|verify you are human|robot|something went wrong|page not available/i.test(body);
    const notLive = /isn't live|is not live|şu anda canlı değil|canlı yayın sona erdi/i.test(body);
    return { title, hasChat, blocked, notLive, bodyHasLive: /\bLIVE\b|CANLI/i.test(body) };
  }).catch(() => ({title:'',hasChat:false,blocked:true,notLive:false,bodyHasLive:false}));
  return info;
}
async function drainDomQueue(s) {
  if (!s.page) return;
  const records = await s.page.evaluate(() => {
    try { return (window.__MSYAYIN_QUEUE__ || []).splice(0, 120); } catch { return []; }
  }).catch(() => []);
  for (const rec of records) {
    const user = cleanUsername(rec.username || '');
    if (rec.kind === 'comment' && user && /^(10|[1-9])$/.test(String(rec.message || ''))) {
      const fp = `dom-vote|${user}|${rec.message}|${Math.floor(Date.now()/1500)}`;
      if (!seen(s, fp)) {
        addVote(s, user, Number(rec.message), rec.avatarUrl || '');
        pushEvent(s, { type: 'comment', username: user, message: String(rec.message), avatarUrl: rec.avatarUrl || '', source: 'dom' });
      }
    } else if (rec.kind === 'gift') {
      addSelectedGift(s, user, rec.gift, rec.quantity || 1, rec.avatarUrl || '');
    } else if (rec.kind === 'like') {
      addLike(s, user, rec.count || 1, rec.avatarUrl || '');
    }
  }
}

async function stopObserver(s) {
  if (s.observerTimer) clearInterval(s.observerTimer);
  s.observerTimer = null;
  if (s.page) { try { await s.page.close(); } catch {} }
  if (s.browser) { try { await s.browser.close(); } catch {} }
  s.page = null; s.browser = null;
  s.connected = false; s.liveFound = false;
}

async function browserExecutable() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  return chromium.executablePath();
}

async function startObserver(s) {
  await stopObserver(s);
  const username = cleanUsername(s.tiktokUsername);
  if (!username) throw new Error('TikTok kullanıcı adı girilmedi.');
  s.status = 'TikTok LIVE açılıyor…';
  s.connected = false;
  s.liveFound = false;
  s.recentEvents = [];
  s.giftOptions = [];
  s.processed.clear();
  broadcast(s);

  const executablePath = await browserExecutable();
  s.browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
      ...(chromium.args || []),
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
      '--disable-blink-features=AutomationControlled', '--window-size=1440,1000'
    ],
    defaultViewport: { width: 1440, height: 1000 }
  });
  s.page = await s.browser.newPage();
  await s.page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36');
  await s.page.setExtraHTTPHeaders({ 'accept-language': 'tr-TR,tr;q=0.9,en-US;q=0.8,en;q=0.7' });
  await s.page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  const cdp = await s.page.target().createCDPSession();
  await cdp.send('Network.enable');
  cdp.on('Network.webSocketFrameReceived', ev => processBinaryFrame(s, ev).catch?.(() => {}));

  await s.page.goto(`https://www.tiktok.com/@${encodeURIComponent(username)}/live`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await installDomObserver(s);
  await new Promise(r => setTimeout(r, 2500));

  let info = await looksLikeLive(s.page);
  let waited = 0;
  while (!info.notLive && !info.blocked && !(info.hasChat && info.bodyHasLive) && waited < 20000) {
    await new Promise(r => setTimeout(r, 2500));
    waited += 2500;
    info = await looksLikeLive(s.page);
  }

  if (info.blocked) {
    s.status = 'TikTok erişimi engellendi veya doğrulama istedi.';
    s.connected = false;
    s.liveFound = false;
    pushEvent(s, { type: 'error', message: s.status });
    broadcast(s);
    return;
  }
  if (info.notLive || !info.hasChat) {
    s.status = `@${username} şu anda canlı görünmüyor.`;
    s.connected = false;
    s.liveFound = false;
    pushEvent(s, { type: 'system', message: s.status });
    broadcast(s);
    return;
  }

  s.connected = true;
  s.liveFound = true;
  s.status = `@${username} LIVE bağlı — olaylar dinleniyor`;
  pushEvent(s, { type: 'system', message: `@${username} LIVE bulundu ve tarayıcı gözlemcisi aktif.` });
  broadcast(s);

  s.observerTimer = setInterval(async () => {
    try {
      if (!s.page) return;
      await s.page.evaluate(() => window.__MSYAYIN_SCAN__?.());
      await drainDomQueue(s);
    } catch (err) {
      s.connected = false;
      s.status = `Bağlantı kesildi: ${err.message}`;
      broadcast(s);
    }
  }, 1200);
}

// ----- API -----
app.get('/api/session/new', (req, res) => res.json({ key: newSession().key }));
app.get('/api/session/:key', (req, res) => {
  const s = getSession(req.params.key);
  if (!s) return res.status(404).json({ error: 'Oturum bulunamadı' });
  res.json(safeState(s));
});
app.post('/api/connect', async (req, res) => {
  const s = getSession(req.body.key);
  if (!s) return res.status(404).json({ error: 'Oturum bulunamadı' });
  const username = cleanUsername(req.body.username);
  if (!username) return res.status(400).json({ error: 'TikTok kullanıcı adı gerekli' });
  s.tiktokUsername = username;
  startObserver(s).catch(err => {
    s.connected = false;
    s.liveFound = false;
    s.status = `Bağlantı hatası: ${err.message}`;
    pushEvent(s, { type: 'error', message: err.message });
    broadcast(s);
  });
  res.json({ ok: true });
});
app.post('/api/disconnect', async (req, res) => {
  const s = getSession(req.body.key);
  if (!s) return res.status(404).json({ error: 'Oturum bulunamadı' });
  await stopObserver(s); s.status = 'Bağlantı kesildi'; broadcast(s); res.json({ ok: true });
});
app.post('/api/settings/score', (req, res) => {
  const s = getSession(req.body.key); if (!s) return res.status(404).json({ error: 'Oturum bulunamadı' });
  s.score.seconds = Math.max(5, Math.min(600, parseNumber(req.body.seconds) || 15)); broadcast(s); res.json({ ok: true });
});
app.post('/api/score/start', (req, res) => {
  const s = getSession(req.body.key); if (!s) return res.status(404).json({ error: 'Oturum bulunamadı' });
  const sec = s.score.seconds || 15;
  s.score.active = true; s.score.startedAt = Date.now(); s.score.endsAt = Date.now() + sec * 1000; s.score.votes = [];
  pushEvent(s, { type: 'system', message: `Puanlama başladı (${sec} sn)` }); broadcast(s);
  setTimeout(() => {
    const cur = sessions.get(s.key); if (!cur || cur.score.startedAt !== s.score.startedAt) return;
    cur.score.active = false; cur.score.endsAt = null;
    pushEvent(cur, { type: 'system', message: 'Puanlama tamamlandı.' }); broadcast(cur);
  }, sec * 1000 + 100);
  res.json({ ok: true });
});
app.post('/api/gift/select', (req, res) => {
  const s = getSession(req.body.key); if (!s) return res.status(404).json({ error: 'Oturum bulunamadı' });
  const kind = req.body.kind === 'mekan' ? 'mekan' : 'racon';
  const gift = String(req.body.gift || '').trim();
  s[kind === 'racon' ? 'raconGift' : 'mekanGift'] = gift;
  broadcast(s); res.json({ ok: true });
});
app.post('/api/win', (req, res) => {
  const s = getSession(req.body.key); if (!s) return res.status(404).json({ error: 'Oturum bulunamadı' });
  const delta = Math.max(-50, Math.min(50, parseNumber(req.body.delta)));
  s.wins = Math.max(0, s.wins + delta);
  if (req.body.target != null) s.targetWins = Math.max(1, Math.min(999, parseNumber(req.body.target) || 20));
  broadcast(s); res.json({ ok: true });
});
app.post('/api/test', (req, res) => {
  const s = getSession(req.body.key); if (!s) return res.status(404).json({ error: 'Oturum bulunamadı' });
  const username = cleanUsername(req.body.username || 'TestKullanici') || 'TestKullanici';
  const type = req.body.type;
  if (type === 'vote') { if (!s.score.active) s.score.active = true; addVote(s, username, Math.max(1, Math.min(10, parseNumber(req.body.value) || 10)), ''); }
  else if (type === 'gift') addSelectedGift(s, username, String(req.body.gift || 'Gül'), 1, '');
  else if (type === 'like') addLike(s, username, Math.max(1, parseNumber(req.body.count) || 50), '');
  else if (type === 'win') { s.wins = Math.max(0, s.wins + (parseNumber(req.body.delta) || 1)); broadcast(s); }
  res.json({ ok: true });
});
app.post('/api/reset', (req, res) => {
  const s = getSession(req.body.key); if (!s) return res.status(404).json({ error: 'Oturum bulunamadı' });
  s.score.votes = []; s.raconGifts = []; s.mekanGifts = []; s.likes = {}; s.wins = 0; s.giftOptions = []; s.recentEvents = []; s.latestAlert = null; broadcast(s); res.json({ ok: true });
});

io.on('connection', socket => {
  socket.on('join', key => {
    const s = getSession(key); if (!s) return;
    socket.join(s.key); socket.emit('state:update', safeState(s));
  });
});

setInterval(() => {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  for (const [key, s] of sessions) {
    if (s.createdAt < cutoff) {
      stopObserver(s).catch(() => {}); sessions.delete(key);
    }
  }
}, 30 * 60 * 1000);

app.get('/overlay/:name', (req, res) => res.sendFile(path.join(__dirname, 'public', 'overlay.html')));

server.listen(PORT, () => console.log(`MS YAYIN listening on ${PORT}`));
