const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 10000);

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

const rooms = new Map();
const connections = new Map();

const GIFT_CATALOG = [
  'Gül',
  'Kalp Parmak',
  'Parmak Kalp',
  'GG',
  'Parıltılı Kalp',
  'Galaksi',
  'Aslan',
  'TikTok Universe',
  'Yat',
  'Konfeti',
  'Çiçek',
  'Kraliyet Tacı',
  'Taç',
  'Aşk Balonu'
];

function normalizeRoom(value) {
  return String(value || '').trim().toUpperCase();
}

function cleanUser(value) {
  return String(value || '').replace(/^@/, '').trim();
}

function normalizeGift(value) {
  return String(value || '').trim().toLowerCase();
}

function safeAvatar(data) {
  return String(
    data?.profilePictureUrl ||
    data?.profilePicture?.url ||
    data?.avatarUrl ||
    ''
  ).trim();
}

function createRoomCode() {
  let code = '';
  do {
    code = `MS-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  } while (rooms.has(code));
  return code;
}

function createRoom(code) {
  const room = normalizeRoom(code);
  if (!room) throw new Error('Room kodu boş olamaz.');
  if (!rooms.has(room)) {
    rooms.set(room, {
      room,
      createdAt: Date.now(),
      username: '',
      connected: false,
      scoreDuration: 15,
      scoring: false,
      scoreEndsAt: 0,
      votes: [],
      likes: new Map(),
      giftRules: [],
      raconMembers: new Map(),
      mekanMembers: new Map(),
      wins: 0,
      lastGift: null,
      lastEvent: null,
      scoreTimer: null
    });
  }
  return rooms.get(room);
}

function publicMemberList(map) {
  return [...map.values()]
    .sort((a, b) => b.count - a.count || a.updatedAt - b.updatedAt)
    .slice(0, 100);
}

function publicState(state) {
  const uniqueParticipants = new Set(state.votes.map((vote) => vote.username));
  const average = state.votes.length
    ? Number(
        (
          state.votes.reduce((sum, vote) => sum + vote.score, 0) /
          state.votes.length
        ).toFixed(2)
      )
    : 0;

  return {
    room: state.room,
    createdAt: state.createdAt,
    username: state.username,
    connected: state.connected,
    scoreDuration: state.scoreDuration,
    scoring: state.scoring,
    scoreEndsAt: state.scoreEndsAt,
    average,
    participants: uniqueParticipants.size,
    votes: state.votes.slice(-100).reverse(),
    likes: [...state.likes.values()]
      .sort((a, b) => b.likeCount - a.likeCount || a.username.localeCompare(b.username))
      .slice(0, 100),
    giftRules: state.giftRules,
    giftCatalog: GIFT_CATALOG,
    raconMembers: publicMemberList(state.raconMembers),
    mekanMembers: publicMemberList(state.mekanMembers),
    wins: state.wins,
    lastGift: state.lastGift,
    lastEvent: state.lastEvent
  };
}

function broadcast(state) {
  io.to(state.room).emit('state', publicState(state));
}

function findActiveRule(state, giftName, type) {
  const target = normalizeGift(giftName);
  return state.giftRules.find(
    (rule) =>
      rule.active &&
      rule.type === type &&
      normalizeGift(rule.gift) === target
  );
}

function upsertMember(map, username, avatar, gift, repeatCount) {
  const user = cleanUser(username) || 'bilinmeyen';
  const count = Math.max(1, Number(repeatCount) || 1);
  const existing = map.get(user);
  if (existing) {
    existing.count += count;
    existing.gift = gift;
    if (avatar) existing.avatar = avatar;
    existing.updatedAt = Date.now();
  } else {
    map.set(user, {
      username: user,
      avatar: avatar || '',
      gift,
      count,
      updatedAt: Date.now()
    });
  }
}

function handleGift(state, data) {
  const username = cleanUser(data?.uniqueId || data?.nickname || 'bilinmeyen');
  const gift = String(data?.giftName || data?.gift || 'Hediye').trim();
  const repeatCount = Math.max(1, Number(data?.repeatCount || data?.repeat || 1));
  const avatar = safeAvatar(data);
  const raconRule = findActiveRule(state, gift, 'racon');
  const mekanRule = findActiveRule(state, gift, 'mekan');
  const type = raconRule ? 'racon' : mekanRule ? 'mekan' : 'none';

  state.lastGift = {
    username,
    avatar,
    gift,
    repeatCount,
    type,
    time: Date.now()
  };
  state.lastEvent = { kind: 'gift', ...state.lastGift };

  if (raconRule) upsertMember(state.raconMembers, username, avatar, gift, repeatCount);
  if (mekanRule) upsertMember(state.mekanMembers, username, avatar, gift, repeatCount);

  broadcast(state);
}

function handleLike(state, data) {
  const username = cleanUser(data?.uniqueId || data?.nickname || 'bilinmeyen');
  const avatar = safeAvatar(data);
  const count = Math.max(1, Number(data?.likeCount || data?.totalLikeCount || 1));
  const existing = state.likes.get(username);
  if (existing) {
    existing.likeCount += count;
    if (avatar) existing.avatar = avatar;
    existing.updatedAt = Date.now();
  } else {
    state.likes.set(username, {
      username,
      avatar,
      likeCount: count,
      updatedAt: Date.now()
    });
  }
  state.lastEvent = {
    kind: 'like',
    username,
    avatar,
    count,
    time: Date.now()
  };
  broadcast(state);
}

function handleChat(state, data) {
  if (!state.scoring) return;
  const comment = String(data?.comment || '').trim();
  if (!/^(10|[1-9])$/.test(comment)) return;

  const score = Number(comment);
  const username = cleanUser(data?.uniqueId || data?.nickname || 'bilinmeyen');
  const avatar = safeAvatar(data);
  state.votes.push({ username, avatar, score, time: Date.now() });
  state.lastEvent = {
    kind: 'vote',
    username,
    avatar,
    score,
    time: Date.now()
  };
  broadcast(state);
}

async function disconnectRoom(roomCode) {
  const conn = connections.get(roomCode);
  if (!conn) return;
  connections.delete(roomCode);
  try {
    await conn.disconnect();
  } catch (_) {
    // ignore connector shutdown errors
  }
}

async function connectTikTok(roomCode, username) {
  const state = createRoom(roomCode);
  const user = cleanUser(username);
  if (!user) throw new Error('TikTok kullanıcı adı gerekli.');

  await disconnectRoom(state.room);
  state.username = user;
  state.connected = false;
  broadcast(state);

  const connection = new WebcastPushConnection(user, {
    processInitialData: false
  });
  connections.set(state.room, connection);

  connection.on('connected', () => {
    state.connected = true;
    broadcast(state);
  });
  connection.on('disconnected', () => {
    state.connected = false;
    broadcast(state);
  });
  connection.on('error', () => {
    state.connected = false;
    broadcast(state);
  });
  connection.on('chat', (data) => handleChat(state, data));
  connection.on('like', (data) => handleLike(state, data));
  connection.on('gift', (data) => handleGift(state, data));

  await connection.connect();
}

function startScoring(state) {
  if (state.scoreTimer) clearTimeout(state.scoreTimer);
  state.scoring = true;
  state.votes = [];
  state.scoreEndsAt = Date.now() + state.scoreDuration * 1000;
  broadcast(state);
  state.scoreTimer = setTimeout(() => {
    state.scoring = false;
    state.scoreEndsAt = 0;
    state.scoreTimer = null;
    broadcast(state);
  }, state.scoreDuration * 1000);
}

const INDEX_HTML = "<!doctype html>\n<html lang=\"tr\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n  <title>MS YAYIN</title>\n  <style>*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:Inter,Arial,sans-serif;background:#07080c;color:#f7f7f8}body{min-height:100vh}.layout{min-height:100vh;display:flex}.sidebar{position:fixed;left:0;top:0;bottom:0;width:260px;background:#0d0f15;border-right:1px solid #242935;padding:20px;z-index:10}.brand{font-weight:900;font-size:24px;margin-bottom:22px}.brand span{color:#e53535}.nav{display:flex;flex-direction:column;gap:5px}.nav button{border:0;background:transparent;color:#bfc5d1;padding:12px 13px;text-align:left;border-radius:10px;font-weight:700;cursor:pointer}.nav button.active,.nav button:hover{background:#1a1f2a;color:#fff}.sidebar-footer{margin-top:18px}.main{margin-left:260px;padding:28px;width:calc(100% - 260px)}.topbar{display:flex;justify-content:space-between;align-items:flex-start;gap:15px;flex-wrap:wrap;margin-bottom:22px}.title{margin:0 0 7px;font-size:32px}.muted{color:#9199aa}.room-badge{background:#11151e;border:1px solid #2a3040;padding:10px 13px;border-radius:11px}.card{background:#10131b;border:1px solid #252b38;border-radius:17px;padding:20px;margin-bottom:18px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.stat{font-size:30px;font-weight:900}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.field,input,select{font:inherit}.field,input,select{background:#151923;color:#fff;border:1px solid #303747;border-radius:10px;padding:10px 12px}.btn{border:0;border-radius:10px;padding:11px 15px;font-weight:800;cursor:pointer;background:#e53535;color:#fff}.btn.dark{background:#282e3a}.btn.green{background:#16834e}.btn.gold{background:#a27516}.btn.danger{background:#a8242e}.list{max-height:420px;overflow:auto}.item{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:11px 4px;border-bottom:1px solid #252b38}.pill{display:inline-flex;padding:4px 9px;border-radius:999px;background:#252b38;font-size:12px}.avatar{width:40px;height:40px;border-radius:50%;object-fit:cover;background:#242a36;display:inline-block}.person{display:flex;align-items:center;gap:10px}.person-text{display:flex;flex-direction:column;gap:3px}.rank{width:30px;text-align:center}.overlay-link{background:#0b0e14;border:1px dashed #343b4a;border-radius:10px;padding:11px;word-break:break-all;font-size:12px;margin-top:8px}.hero{min-height:100vh;display:grid;place-items:center;padding:28px}.hero-card{width:min(720px,100%);background:#10131b;border:1px solid #272d39;border-radius:24px;padding:36px;box-shadow:0 30px 90px #0008}.hero-card h1{font-size:38px;margin:0 0 10px}.hero-card p{line-height:1.7}.room-show{margin-top:16px;padding:14px;border-radius:12px;background:#0c0f15;border:1px dashed #394150;display:none}.toast{position:fixed;right:25px;bottom:25px;background:#1c2330;border:1px solid #394150;border-radius:12px;padding:14px 18px;display:none;z-index:50}.overlay-wrap{min-height:100vh;display:grid;place-items:center;padding:24px}.overlay-box{min-width:420px;max-width:92vw;background:rgba(7,8,12,.9);border:1px solid rgba(255,255,255,.14);border-radius:22px;padding:24px 28px;box-shadow:0 25px 80px rgba(0,0,0,.45);text-align:center}.overlay-title{font-size:26px;font-weight:900;margin-bottom:10px}.overlay-big{font-size:56px;font-weight:900}.overlay-row{display:flex;justify-content:center;align-items:center;gap:12px;flex-wrap:wrap}.overlay-item{padding:8px 0;font-size:20px;border-bottom:1px solid rgba(255,255,255,.08)}.overlay-person{display:flex;align-items:center;justify-content:center;gap:10px;font-size:22px;font-weight:800}.small{font-size:12px}.danger-text{color:#ff8585}@media(max-width:900px){.sidebar{width:210px}.main{margin-left:210px;width:calc(100% - 210px)}.grid{grid-template-columns:1fr}}@media(max-width:650px){.sidebar{position:static;width:100%;min-height:auto}.layout{display:block}.main{margin-left:0;width:100%}.nav{display:grid;grid-template-columns:1fr 1fr}.title{font-size:26px}.grid{grid-template-columns:1fr}.overlay-box{min-width:0;width:100%}}\n</style>\n</head>\n<body>\n  <main class=\"hero\">\n    <section class=\"hero-card\">\n      <div class=\"brand\">🔥 MS <span>YAYIN</span></div>\n      <h1>Yayın Yönetim Sistemi</h1>\n      <p class=\"muted\">Her yayın için oda kodunu otomatik oluştur. Panel, puanlama ve bütün overlay'lar aynı odaya bağlansın.</p>\n      <button class=\"btn\" id=\"newRoom\">🟢 YENİ YAYIN BAŞLAT</button>\n      <div class=\"room-show\" id=\"roomResult\"></div>\n    </section>\n  </main>\n  <script>\n    document.getElementById('newRoom').addEventListener('click', async () => {\n      const response = await fetch('/api/rooms', { method: 'POST' });\n      const data = await response.json();\n      if (!data.ok) return;\n      localStorage.setItem('ms_room', data.room);\n      location.href = data.panelUrl;\n    });\n  </script>\n</body>\n</html>\n";
const PANEL_HTML = "<!doctype html>\n<html lang=\"tr\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n  <title>MS YAYIN PANELİ</title>\n  <style>*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:Inter,Arial,sans-serif;background:#07080c;color:#f7f7f8}body{min-height:100vh}.layout{min-height:100vh;display:flex}.sidebar{position:fixed;left:0;top:0;bottom:0;width:260px;background:#0d0f15;border-right:1px solid #242935;padding:20px;z-index:10}.brand{font-weight:900;font-size:24px;margin-bottom:22px}.brand span{color:#e53535}.nav{display:flex;flex-direction:column;gap:5px}.nav button{border:0;background:transparent;color:#bfc5d1;padding:12px 13px;text-align:left;border-radius:10px;font-weight:700;cursor:pointer}.nav button.active,.nav button:hover{background:#1a1f2a;color:#fff}.sidebar-footer{margin-top:18px}.main{margin-left:260px;padding:28px;width:calc(100% - 260px)}.topbar{display:flex;justify-content:space-between;align-items:flex-start;gap:15px;flex-wrap:wrap;margin-bottom:22px}.title{margin:0 0 7px;font-size:32px}.muted{color:#9199aa}.room-badge{background:#11151e;border:1px solid #2a3040;padding:10px 13px;border-radius:11px}.card{background:#10131b;border:1px solid #252b38;border-radius:17px;padding:20px;margin-bottom:18px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.stat{font-size:30px;font-weight:900}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.field,input,select{font:inherit}.field,input,select{background:#151923;color:#fff;border:1px solid #303747;border-radius:10px;padding:10px 12px}.btn{border:0;border-radius:10px;padding:11px 15px;font-weight:800;cursor:pointer;background:#e53535;color:#fff}.btn.dark{background:#282e3a}.btn.green{background:#16834e}.btn.gold{background:#a27516}.btn.danger{background:#a8242e}.list{max-height:420px;overflow:auto}.item{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:11px 4px;border-bottom:1px solid #252b38}.pill{display:inline-flex;padding:4px 9px;border-radius:999px;background:#252b38;font-size:12px}.avatar{width:40px;height:40px;border-radius:50%;object-fit:cover;background:#242a36;display:inline-block}.person{display:flex;align-items:center;gap:10px}.person-text{display:flex;flex-direction:column;gap:3px}.rank{width:30px;text-align:center}.overlay-link{background:#0b0e14;border:1px dashed #343b4a;border-radius:10px;padding:11px;word-break:break-all;font-size:12px;margin-top:8px}.hero{min-height:100vh;display:grid;place-items:center;padding:28px}.hero-card{width:min(720px,100%);background:#10131b;border:1px solid #272d39;border-radius:24px;padding:36px;box-shadow:0 30px 90px #0008}.hero-card h1{font-size:38px;margin:0 0 10px}.hero-card p{line-height:1.7}.room-show{margin-top:16px;padding:14px;border-radius:12px;background:#0c0f15;border:1px dashed #394150;display:none}.toast{position:fixed;right:25px;bottom:25px;background:#1c2330;border:1px solid #394150;border-radius:12px;padding:14px 18px;display:none;z-index:50}.overlay-wrap{min-height:100vh;display:grid;place-items:center;padding:24px}.overlay-box{min-width:420px;max-width:92vw;background:rgba(7,8,12,.9);border:1px solid rgba(255,255,255,.14);border-radius:22px;padding:24px 28px;box-shadow:0 25px 80px rgba(0,0,0,.45);text-align:center}.overlay-title{font-size:26px;font-weight:900;margin-bottom:10px}.overlay-big{font-size:56px;font-weight:900}.overlay-row{display:flex;justify-content:center;align-items:center;gap:12px;flex-wrap:wrap}.overlay-item{padding:8px 0;font-size:20px;border-bottom:1px solid rgba(255,255,255,.08)}.overlay-person{display:flex;align-items:center;justify-content:center;gap:10px;font-size:22px;font-weight:800}.small{font-size:12px}.danger-text{color:#ff8585}@media(max-width:900px){.sidebar{width:210px}.main{margin-left:210px;width:calc(100% - 210px)}.grid{grid-template-columns:1fr}}@media(max-width:650px){.sidebar{position:static;width:100%;min-height:auto}.layout{display:block}.main{margin-left:0;width:100%}.nav{display:grid;grid-template-columns:1fr 1fr}.title{font-size:26px}.grid{grid-template-columns:1fr}.overlay-box{min-width:0;width:100%}}\n</style>\n  <script src=\"/socket.io/socket.io.js\"></script>\n</head>\n<body>\n<div class=\"layout\">\n  <aside class=\"sidebar\">\n    <div class=\"brand\">🔥 MS <span>YAYIN</span></div>\n    <nav class=\"nav\">\n      <button data-tab=\"connection\">🔴 Yayın Bağlantısı</button>\n      <button data-tab=\"score\">⭐ Puanlama</button>\n      <button data-tab=\"racon\">👑 Racon Kralları</button>\n      <button data-tab=\"mekan\">🏠 Mekan Sahibi</button>\n      <button data-tab=\"likes\">❤️ Beğeni Sıralaması</button>\n      <button data-tab=\"win\">🏆 WIN Sayacı</button>\n      <button data-tab=\"test\">🧪 Test Merkezi</button>\n      <button data-tab=\"guide\">📖 Kullanım Rehberi</button>\n    </nav>\n    <div class=\"sidebar-footer\">\n      <button class=\"btn dark\" style=\"width:100%\" id=\"newShow\">🆕 Yeni Yayın</button>\n    </div>\n  </aside>\n\n  <main class=\"main\">\n    <header class=\"topbar\">\n      <div>\n        <h1 class=\"title\">Yayın Yönetim Paneli</h1>\n        <div class=\"muted\">Room, TikTok bağlantısı ve bütün overlay'lar tek yerde.</div>\n      </div>\n      <div class=\"room-badge\">ROOM: <b id=\"roomLabel\">—</b></div>\n    </header>\n    <div id=\"app\"></div>\n  </main>\n</div>\n<div class=\"toast\" id=\"toast\"></div>\n<script>\nconst socket = io();\nconst params = new URLSearchParams(location.search);\nlet room = (params.get('room') || localStorage.getItem('ms_room') || '').toUpperCase();\nif (!room) {\n  location.href = '/';\n} else {\n  localStorage.setItem('ms_room', room);\n}\nlet state = null;\nlet currentTab = 'connection';\n\nconst app = document.getElementById('app');\nconst roomLabel = document.getElementById('roomLabel');\nroomLabel.textContent = room || '—';\n\nfunction toast(message) {\n  const node = document.getElementById('toast');\n  node.textContent = message || '';\n  node.style.display = 'block';\n  clearTimeout(window.__toastTimer);\n  window.__toastTimer = setTimeout(() => node.style.display = 'none', 2200);\n}\n\nasync function post(path, body = {}) {\n  const response = await fetch(path, {\n    method: 'POST',\n    headers: {'Content-Type': 'application/json'},\n    body: JSON.stringify({ room, ...body })\n  });\n  const data = await response.json();\n  if (!response.ok) toast(data.message || 'İşlem başarısız.');\n  return data;\n}\n\nfunction overlayUrl(type) {\n  return location.origin + '/overlay/' + encodeURIComponent(type) + '?room=' + encodeURIComponent(room);\n}\n\nfunction overlayCard(type) {\n  const url = overlayUrl(type);\n  return '<div class=\"card\"><b>🎥 Overlay Linki</b><div class=\"overlay-link\">' + url + '</div><div class=\"row\" style=\"margin-top:9px\"><button class=\"btn dark\" onclick=\"copyText(' + JSON.stringify(url) + ')\">📋 Linki Kopyala</button><button class=\"btn dark\" onclick=\"window.open(' + JSON.stringify(url) + ',\\'_blank\\')\">👁️ Önizle</button></div></div>';\n}\n\nasync function copyText(text) {\n  try { await navigator.clipboard.writeText(text); toast('Overlay linki kopyalandı.'); }\n  catch (_) { toast('Link kopyalanamadı.'); }\n}\n\nfunction giftSelect(id) {\n  const options = (state?.giftCatalog || []).map(g => '<option value=\"' + escapeHtml(g) + '\">🎁 ' + escapeHtml(g) + '</option>').join('');\n  return '<select id=\"' + id + '\">' + options + '</select>';\n}\n\nfunction escapeHtml(value) {\n  return String(value ?? '').replace(/[&<>'\"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',\"'\":'&#39;','\"':'&quot;'}[ch]));\n}\n\nfunction render(tab) {\n  currentTab = tab;\n  document.querySelectorAll('.nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));\n  let html = '';\n\n  if (tab === 'connection') {\n    html = `\n      <div class=\"card\"><h2>🔴 Yayın Bağlantısı</h2>\n        <p class=\"muted\">TikTok canlı kullanıcı adını gir. Room zaten otomatik hazırlandı.</p>\n        <div class=\"row\"><input class=\"field\" id=\"ttuser\" placeholder=\"@kullanici\" value=\"${escapeHtml(state?.username || '')}\"><button class=\"btn\" onclick=\"connectTikTok()\">BAĞLAN</button></div>\n        <p>Durum: <b>${state?.connected ? '🟢 BAĞLI' : '🔴 BAĞLI DEĞİL'}</b></p>\n        ${state?.connected ? '<div class=\"pill\">@' + escapeHtml(state.username) + ' canlı bağlantısı aktif</div>' : ''}\n      </div>\n      ${overlayCard('all')}\n    `;\n  }\n\n  if (tab === 'score') {\n    const left = state?.scoring ? Math.max(0, Math.ceil((state.scoreEndsAt - Date.now()) / 1000)) : 0;\n    html = `\n      <div class=\"card\"><h2>⭐ Puanlama</h2>\n        <div class=\"row\"><label>Süre <input class=\"field\" id=\"duration\" type=\"number\" min=\"1\" max=\"3600\" value=\"${state?.scoreDuration || 15}\"> saniye</label>\n        <button class=\"btn dark\" onclick=\"saveDuration()\">Kaydet</button><button class=\"btn green\" onclick=\"startScore()\">PUANLAMAYI BAŞLAT</button><button class=\"btn danger\" onclick=\"stopScore()\">BİTİR</button></div>\n        <div class=\"grid\" style=\"margin-top:16px\">\n          <div class=\"card\"><span class=\"muted\">Ortalama</span><div class=\"stat\">${state?.average || 0}</div></div>\n          <div class=\"card\"><span class=\"muted\">Katılımcı</span><div class=\"stat\">${state?.participants || 0}</div></div>\n          <div class=\"card\"><span class=\"muted\">Kalan</span><div class=\"stat\">${state?.scoring ? left + ' sn' : '—'}</div></div>\n        </div>\n        <div class=\"list\">${(state?.votes || []).map(v => `<div class=\"item\"><div class=\"person\"><img class=\"avatar\" src=\"${escapeHtml(v.avatar || '')}\" onerror=\"this.style.visibility='hidden'\"><div class=\"person-text\"><b>@${escapeHtml(v.username)}</b><span class=\"muted small\">oy verdi</span></div></div><b>${v.score}</b></div>`).join('') || '<div class=\"muted\">Henüz oy yok.</div>'}</div>\n      </div>${overlayCard('puanlama')}`;\n  }\n\n  if (tab === 'racon') {\n    const rules = (state?.giftRules || []).map((r, i) => ({...r, i})).filter(r => r.type === 'racon');\n    html = `<div class=\"card\"><h2>👑 Racon Kralları</h2><p class=\"muted\">Buradan hediye seç. O hediye canlıda geldiğinde gönderen otomatik listeye eklenir.</p>\n      <div class=\"row\">${giftSelect('raconGift')}<button class=\"btn\" onclick=\"addRule('racon')\">➕ Hediyeyi Aktif Et</button></div>\n      <div class=\"list\" style=\"margin-top:14px\">${rules.map(r => `<div class=\"item\"><span>🎁 ${escapeHtml(r.gift)}</span><div class=\"row\"><span class=\"pill\">${r.active ? '🟢 Aktif' : '⚪ Pasif'}</span><button class=\"btn dark\" onclick=\"toggleRule(${r.i})\">Aç/Kapat</button><button class=\"btn danger\" onclick=\"deleteRule(${r.i})\">Sil</button></div></div>`).join('') || '<div class=\"muted\">Henüz hediye seçilmedi.</div>'}</div></div>\n      <div class=\"card\"><div class=\"row\"><h3 style=\"margin-right:auto\">Otomatik Liste</h3><button class=\"btn danger\" onclick=\"resetRacon()\">Sıfırla</button></div><div class=\"list\">${(state?.raconMembers || []).map((m, i) => `<div class=\"item\"><div class=\"person\"><span class=\"rank\">${i < 3 ? ['🥇','🥈','🥉'][i] : i+1}</span><img class=\"avatar\" src=\"${escapeHtml(m.avatar || '')}\" onerror=\"this.style.visibility='hidden'\"><div class=\"person-text\"><b>@${escapeHtml(m.username)}</b><span class=\"muted small\">${escapeHtml(m.gift)}</span></div></div><b>${m.count}x</b></div>`).join('') || '<div class=\"muted\">Hediye gelince burada görünecek.</div>'}</div></div>\n      ${overlayCard('racon')}`;\n  }\n\n  if (tab === 'mekan') {\n    const rules = (state?.giftRules || []).map((r, i) => ({...r, i})).filter(r => r.type === 'mekan');\n    html = `<div class=\"card\"><h2>🏠 Mekan Sahibi</h2><p class=\"muted\">Buradan hediye seç. O hediye canlıda geldiğinde gönderen otomatik listeye eklenir.</p>\n      <div class=\"row\">${giftSelect('mekanGift')}<button class=\"btn\" onclick=\"addRule('mekan')\">➕ Hediyeyi Aktif Et</button></div>\n      <div class=\"list\" style=\"margin-top:14px\">${rules.map(r => `<div class=\"item\"><span>🎁 ${escapeHtml(r.gift)}</span><div class=\"row\"><span class=\"pill\">${r.active ? '🟢 Aktif' : '⚪ Pasif'}</span><button class=\"btn dark\" onclick=\"toggleRule(${r.i})\">Aç/Kapat</button><button class=\"btn danger\" onclick=\"deleteRule(${r.i})\">Sil</button></div></div>`).join('') || '<div class=\"muted\">Henüz hediye seçilmedi.</div>'}</div></div>\n      <div class=\"card\"><div class=\"row\"><h3 style=\"margin-right:auto\">Otomatik Liste</h3><button class=\"btn danger\" onclick=\"resetMekan()\">Sıfırla</button></div><div class=\"list\">${(state?.mekanMembers || []).map((m, i) => `<div class=\"item\"><div class=\"person\"><span class=\"rank\">${i < 3 ? ['🥇','🥈','🥉'][i] : i+1}</span><img class=\"avatar\" src=\"${escapeHtml(m.avatar || '')}\" onerror=\"this.style.visibility='hidden'\"><div class=\"person-text\"><b>@${escapeHtml(m.username)}</b><span class=\"muted small\">${escapeHtml(m.gift)}</span></div></div><b>${m.count}x</b></div>`).join('') || '<div class=\"muted\">Hediye gelince burada görünecek.</div>'}</div></div>\n      ${overlayCard('mekan')}`;\n  }\n\n  if (tab === 'likes') {\n    html = `<div class=\"card\"><div class=\"row\"><h2 style=\"margin-right:auto\">❤️ Beğeni Sıralaması</h2><button class=\"btn danger\" onclick=\"resetLikes()\">Sıfırla</button></div>\n      <div class=\"list\">${(state?.likes || []).map((m, i) => `<div class=\"item\"><div class=\"person\"><span class=\"rank\">${i < 3 ? ['🥇','🥈','🥉'][i] : i+1}</span><img class=\"avatar\" src=\"${escapeHtml(m.avatar || '')}\" onerror=\"this.style.visibility='hidden'\"><div class=\"person-text\"><b>@${escapeHtml(m.username)}</b></div></div><b>${Number(m.likeCount).toLocaleString('tr-TR')} ❤️</b></div>`).join('') || '<div class=\"muted\">Henüz beğeni yok.</div>'}</div></div>${overlayCard('begeni')}`;\n  }\n\n  if (tab === 'win') {\n    html = `<div class=\"card\"><h2>🏆 WIN Sayacı</h2><div class=\"stat\">${String(state?.wins || 0).padStart(2,'0')} / 20</div><div class=\"row\" style=\"margin-top:15px\"><button class=\"btn\" onclick=\"changeWin(1)\">+ WIN</button><button class=\"btn danger\" onclick=\"changeWin(-1)\">- WIN</button><button class=\"btn gold\" onclick=\"changeWin(0)\">SIFIRLA</button></div></div>${overlayCard('win')}`;\n  }\n\n  if (tab === 'test') {\n    html = `<div class=\"card\"><h2>🧪 Test Merkezi</h2><p class=\"muted\">Gerçek TikTok olayı gelmiş gibi test verisi gönder.</p>\n      <div class=\"row\"><input class=\"field\" id=\"testUser\" value=\"test_kullanici\" placeholder=\"kullanıcı\"><input class=\"field\" id=\"testScore\" type=\"number\" min=\"1\" max=\"10\" value=\"10\"><button class=\"btn\" onclick=\"testVote()\">⭐ Test Puanı</button></div>\n      <div class=\"row\" style=\"margin-top:10px\">${giftSelect('testGift')}<input class=\"field\" id=\"testRepeat\" type=\"number\" min=\"1\" value=\"1\" style=\"width:100px\"><button class=\"btn\" onclick=\"testGift()\">🎁 Test Hediye</button></div>\n      <div class=\"row\" style=\"margin-top:10px\"><input class=\"field\" id=\"testLikes\" type=\"number\" min=\"1\" value=\"100\"><button class=\"btn\" onclick=\"testLike()\">❤️ Test Beğeni</button></div>\n      <p class=\"muted small\">Not: Test hediyesinin görünmesi için önce Racon veya Mekan bölümünde o hediyeyi aktif et.</p>\n    </div>`;\n  }\n\n  if (tab === 'guide') {\n    html = `<div class=\"card\"><h2>📖 Kullanım Rehberi</h2><ol><li>Siteyi açıp <b>YENİ YAYIN BAŞLAT</b> de.</li><li>Oda kodu otomatik oluşur.</li><li>Yayın Bağlantısı bölümünde TikTok kullanıcı adını bağla.</li><li>Racon ve Mekan bölümlerinde hediyeyi listeden seçip aktif et.</li><li>Puanlama süresini ayarla ve başlat.</li><li>Overlay linkini OBS veya TikTok Live Studio'ya Browser Source olarak ekle.</li></ol><p class=\"muted\">Tüm sistemler aynı Room kodu üzerinden anlık haberleşir.</p></div>`;\n  }\n\n  app.innerHTML = html;\n}\n\nasync function connectTikTok() {\n  const user = document.getElementById('ttuser')?.value || '';\n  const data = await post('/api/connect', { username: user });\n  toast(data.message || 'Bağlantı işlemi gönderildi.');\n}\nasync function saveDuration() {\n  await post('/api/duration', { duration: Number(document.getElementById('duration')?.value || 15) });\n  toast('Puanlama süresi kaydedildi.');\n}\nasync function startScore() { await post('/api/score/start'); toast('Puanlama başladı.'); }\nasync function stopScore() { await post('/api/score/stop'); toast('Puanlama bitti.'); }\nasync function addRule(type) {\n  const id = type === 'racon' ? 'raconGift' : 'mekanGift';\n  const gift = document.getElementById(id)?.value || '';\n  const data = await post('/api/rule', { gift, type });\n  if (data?.giftRules) toast('Hediye kuralı kaydedildi.');\n}\nasync function toggleRule(index) { await post('/api/rule/toggle', { index }); }\nasync function deleteRule(index) { await post('/api/rule/delete', { index }); }\nasync function resetLikes() { await post('/api/likes/reset'); toast('Beğeniler sıfırlandı.'); }\nasync function resetRacon() { await post('/api/racon/reset'); toast('Racon listesi sıfırlandı.'); }\nasync function resetMekan() { await post('/api/mekan/reset'); toast('Mekan listesi sıfırlandı.'); }\nasync function changeWin(change) { await post('/api/win', { change }); }\nasync function testVote() { await post('/api/test/vote', { username: document.getElementById('testUser')?.value, score: Number(document.getElementById('testScore')?.value) }); }\nasync function testGift() { await post('/api/test/gift', { username: document.getElementById('testUser')?.value, gift: document.getElementById('testGift')?.value, repeatCount: Number(document.getElementById('testRepeat')?.value || 1) }); }\nasync function testLike() { await post('/api/test/like', { username: document.getElementById('testUser')?.value, count: Number(document.getElementById('testLikes')?.value || 100) }); }\n\ndocument.querySelectorAll('.nav button').forEach(btn => btn.addEventListener('click', () => render(btn.dataset.tab)));\ndocument.getElementById('newShow').addEventListener('click', () => location.href = '/');\nsocket.emit('join', room);\nsocket.on('state', incoming => { state = incoming; render(currentTab); });\nfetch('/api/state?room=' + encodeURIComponent(room)).then(r => r.json()).then(incoming => { state = incoming; render('connection'); });\nsetInterval(() => {\n  if (currentTab === 'score' && state?.scoring) render('score');\n}, 1000);\n</script>\n</body>\n</html>\n";
const OVERLAY_HTML = "<!doctype html>\n<html lang=\"tr\">\n<head>\n  <meta charset=\"utf-8\">\n  <meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n  <title>MS YAYIN OVERLAY</title>\n  <style>*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:Inter,Arial,sans-serif;background:#07080c;color:#f7f7f8}body{min-height:100vh}.layout{min-height:100vh;display:flex}.sidebar{position:fixed;left:0;top:0;bottom:0;width:260px;background:#0d0f15;border-right:1px solid #242935;padding:20px;z-index:10}.brand{font-weight:900;font-size:24px;margin-bottom:22px}.brand span{color:#e53535}.nav{display:flex;flex-direction:column;gap:5px}.nav button{border:0;background:transparent;color:#bfc5d1;padding:12px 13px;text-align:left;border-radius:10px;font-weight:700;cursor:pointer}.nav button.active,.nav button:hover{background:#1a1f2a;color:#fff}.sidebar-footer{margin-top:18px}.main{margin-left:260px;padding:28px;width:calc(100% - 260px)}.topbar{display:flex;justify-content:space-between;align-items:flex-start;gap:15px;flex-wrap:wrap;margin-bottom:22px}.title{margin:0 0 7px;font-size:32px}.muted{color:#9199aa}.room-badge{background:#11151e;border:1px solid #2a3040;padding:10px 13px;border-radius:11px}.card{background:#10131b;border:1px solid #252b38;border-radius:17px;padding:20px;margin-bottom:18px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.stat{font-size:30px;font-weight:900}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.field,input,select{font:inherit}.field,input,select{background:#151923;color:#fff;border:1px solid #303747;border-radius:10px;padding:10px 12px}.btn{border:0;border-radius:10px;padding:11px 15px;font-weight:800;cursor:pointer;background:#e53535;color:#fff}.btn.dark{background:#282e3a}.btn.green{background:#16834e}.btn.gold{background:#a27516}.btn.danger{background:#a8242e}.list{max-height:420px;overflow:auto}.item{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:11px 4px;border-bottom:1px solid #252b38}.pill{display:inline-flex;padding:4px 9px;border-radius:999px;background:#252b38;font-size:12px}.avatar{width:40px;height:40px;border-radius:50%;object-fit:cover;background:#242a36;display:inline-block}.person{display:flex;align-items:center;gap:10px}.person-text{display:flex;flex-direction:column;gap:3px}.rank{width:30px;text-align:center}.overlay-link{background:#0b0e14;border:1px dashed #343b4a;border-radius:10px;padding:11px;word-break:break-all;font-size:12px;margin-top:8px}.hero{min-height:100vh;display:grid;place-items:center;padding:28px}.hero-card{width:min(720px,100%);background:#10131b;border:1px solid #272d39;border-radius:24px;padding:36px;box-shadow:0 30px 90px #0008}.hero-card h1{font-size:38px;margin:0 0 10px}.hero-card p{line-height:1.7}.room-show{margin-top:16px;padding:14px;border-radius:12px;background:#0c0f15;border:1px dashed #394150;display:none}.toast{position:fixed;right:25px;bottom:25px;background:#1c2330;border:1px solid #394150;border-radius:12px;padding:14px 18px;display:none;z-index:50}.overlay-wrap{min-height:100vh;display:grid;place-items:center;padding:24px}.overlay-box{min-width:420px;max-width:92vw;background:rgba(7,8,12,.9);border:1px solid rgba(255,255,255,.14);border-radius:22px;padding:24px 28px;box-shadow:0 25px 80px rgba(0,0,0,.45);text-align:center}.overlay-title{font-size:26px;font-weight:900;margin-bottom:10px}.overlay-big{font-size:56px;font-weight:900}.overlay-row{display:flex;justify-content:center;align-items:center;gap:12px;flex-wrap:wrap}.overlay-item{padding:8px 0;font-size:20px;border-bottom:1px solid rgba(255,255,255,.08)}.overlay-person{display:flex;align-items:center;justify-content:center;gap:10px;font-size:22px;font-weight:800}.small{font-size:12px}.danger-text{color:#ff8585}@media(max-width:900px){.sidebar{width:210px}.main{margin-left:210px;width:calc(100% - 210px)}.grid{grid-template-columns:1fr}}@media(max-width:650px){.sidebar{position:static;width:100%;min-height:auto}.layout{display:block}.main{margin-left:0;width:100%}.nav{display:grid;grid-template-columns:1fr 1fr}.title{font-size:26px}.grid{grid-template-columns:1fr}.overlay-box{min-width:0;width:100%}}\n</style>\n  <script src=\"/socket.io/socket.io.js\"></script>\n</head>\n<body>\n<div class=\"overlay-wrap\"><div class=\"overlay-box\" id=\"box\"><div class=\"muted\">Bekleniyor...</div></div></div>\n<script>\nconst params = new URLSearchParams(location.search);\nconst room = (params.get('room') || '').toUpperCase();\nconst type = location.pathname.split('/').pop() || params.get('type') || 'all';\nconst socket = io();\n\nfunction esc(value) {\n  return String(value ?? '').replace(/[&<>'\"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',\"'\":'&#39;','\"':'&quot;'}[ch]));\n}\nfunction avatar(url) {\n  return url ? '<img class=\"avatar\" src=\"' + esc(url) + '\" onerror=\"this.style.visibility=\\'hidden\\'\">' : '';\n}\nfunction render(state) {\n  let html = '';\n  if (type === 'puanlama') {\n    const left = state.scoring ? Math.max(0, Math.ceil((state.scoreEndsAt - Date.now()) / 1000)) : 0;\n    html = '<div class=\"overlay-title\">⭐ PUANLAMA</div><div class=\"overlay-big\">' + (state.average || 0) + '</div><div>' + state.participants + ' katılımcı · ' + (state.scoring ? left + ' sn' : 'Beklemede') + '</div>';\n  } else if (type === 'racon') {\n    const members = state.raconMembers || [];\n    html = '<div class=\"overlay-title\">👑 RACON KRALLARI</div>' + members.slice(0, 10).map((m,i) => '<div class=\"overlay-item\"><div class=\"overlay-person\">' + (i < 3 ? ['🥇','🥈','🥉'][i] : (i+1)+'.') + ' ' + avatar(m.avatar) + '@' + esc(m.username) + '</div><div class=\"muted small\">' + esc(m.gift) + ' · ' + m.count + 'x</div></div>').join('');\n  } else if (type === 'mekan') {\n    const members = state.mekanMembers || [];\n    html = '<div class=\"overlay-title\">🏠 MEKAN SAHİBİ</div>' + members.slice(0, 10).map((m,i) => '<div class=\"overlay-item\"><div class=\"overlay-person\">' + (i < 3 ? ['🥇','🥈','🥉'][i] : (i+1)+'.') + ' ' + avatar(m.avatar) + '@' + esc(m.username) + '</div><div class=\"muted small\">' + esc(m.gift) + ' · ' + m.count + 'x</div></div>').join('');\n  } else if (type === 'begeni') {\n    html = '<div class=\"overlay-title\">❤️ BEĞENİ SIRALAMASI</div>' + (state.likes || []).slice(0, 10).map((m,i) => '<div class=\"overlay-item\"><div class=\"overlay-person\">' + (i < 3 ? ['🥇','🥈','🥉'][i] : (i+1)+'.') + ' ' + avatar(m.avatar) + '@' + esc(m.username) + '</div><div>' + Number(m.likeCount).toLocaleString('tr-TR') + ' ❤️</div></div>').join('');\n  } else if (type === 'win') {\n    html = '<div class=\"overlay-title\">🏆 WIN</div><div class=\"overlay-big\">' + String(state.wins || 0).padStart(2,'0') + '/20</div>';\n  } else {\n    const gift = state.lastGift;\n    html = '<div class=\"overlay-title\">🔥 MS YAYIN</div><div>⭐ ' + (state.average || 0) + ' · ❤️ ' + (state.likes || []).length + ' kişi · 🏆 ' + String(state.wins || 0).padStart(2,'0') + '/20</div>' + (gift ? '<div class=\"overlay-row\" style=\"margin-top:12px\">🎁 @' + esc(gift.username) + ' · ' + esc(gift.gift) + '</div>' : '');\n  }\n  document.getElementById('box').innerHTML = html || '<div class=\"muted\">Henüz veri yok.</div>';\n}\n\nsocket.emit('join', room);\nsocket.on('state', render);\nsetInterval(() => {\n  if (type === 'puanlama') fetch('/api/state?room=' + encodeURIComponent(room)).then(r => r.json()).then(render);\n}, 1000);\n</script>\n</body>\n</html>\n";

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'msyayin', rooms: rooms.size });
});

app.post('/api/rooms', (_req, res) => {
  const state = createRoom(createRoomCode());
  res.json({
    ok: true,
    room: state.room,
    panelUrl: `/panel.html?room=${encodeURIComponent(state.room)}`
  });
});

app.get('/api/state', (req, res) => {
  const room = normalizeRoom(req.query.room);
  if (!room) return res.status(400).json({ ok: false, message: 'Room gerekli.' });
  res.json(publicState(createRoom(room)));
});

app.post('/api/duration', (req, res) => {
  const state = createRoom(req.body.room);
  state.scoreDuration = Math.min(3600, Math.max(1, Number(req.body.duration) || 15));
  broadcast(state);
  res.json(publicState(state));
});

app.post('/api/score/start', (req, res) => {
  const state = createRoom(req.body.room);
  startScoring(state);
  res.json(publicState(state));
});

app.post('/api/score/stop', (req, res) => {
  const state = createRoom(req.body.room);
  if (state.scoreTimer) clearTimeout(state.scoreTimer);
  state.scoreTimer = null;
  state.scoring = false;
  state.scoreEndsAt = 0;
  broadcast(state);
  res.json(publicState(state));
});

app.post('/api/rule', (req, res) => {
  const state = createRoom(req.body.room);
  const type = req.body.type === 'mekan' ? 'mekan' : 'racon';
  const gift = String(req.body.gift || '').trim();
  if (!gift) return res.status(400).json({ ok: false, message: 'Hediye seç.' });
  const exists = state.giftRules.some(
    (rule) => rule.type === type && normalizeGift(rule.gift) === normalizeGift(gift)
  );
  if (!exists) state.giftRules.push({ gift, type, active: true });
  broadcast(state);
  res.json(publicState(state));
});

app.post('/api/rule/toggle', (req, res) => {
  const state = createRoom(req.body.room);
  const index = Number(req.body.index);
  if (!Number.isInteger(index) || !state.giftRules[index]) {
    return res.status(400).json({ ok: false, message: 'Kural bulunamadı.' });
  }
  state.giftRules[index].active = !state.giftRules[index].active;
  broadcast(state);
  res.json(publicState(state));
});

app.post('/api/rule/delete', (req, res) => {
  const state = createRoom(req.body.room);
  const index = Number(req.body.index);
  if (!Number.isInteger(index) || !state.giftRules[index]) {
    return res.status(400).json({ ok: false, message: 'Kural bulunamadı.' });
  }
  state.giftRules.splice(index, 1);
  broadcast(state);
  res.json(publicState(state));
});

app.post('/api/likes/reset', (req, res) => {
  const state = createRoom(req.body.room);
  state.likes.clear();
  broadcast(state);
  res.json(publicState(state));
});

app.post('/api/racon/reset', (req, res) => {
  const state = createRoom(req.body.room);
  state.raconMembers.clear();
  broadcast(state);
  res.json(publicState(state));
});

app.post('/api/mekan/reset', (req, res) => {
  const state = createRoom(req.body.room);
  state.mekanMembers.clear();
  broadcast(state);
  res.json(publicState(state));
});

app.post('/api/win', (req, res) => {
  const state = createRoom(req.body.room);
  const change = Number(req.body.change) || 0;
  state.wins = change === 0 ? 0 : Math.max(0, state.wins + change);
  broadcast(state);
  res.json(publicState(state));
});

app.post('/api/test/vote', (req, res) => {
  const state = createRoom(req.body.room);
  state.scoring = true;
  const username = cleanUser(req.body.username) || 'test_kullanici';
  const score = Math.max(1, Math.min(10, Number(req.body.score) || 10));
  state.votes.push({ username, avatar: '', score, time: Date.now() });
  broadcast(state);
  res.json(publicState(state));
});

app.post('/api/test/like', (req, res) => {
  const state = createRoom(req.body.room);
  handleLike(state, {
    uniqueId: cleanUser(req.body.username) || 'test_kullanici',
    likeCount: Math.max(1, Number(req.body.count) || 100)
  });
  res.json(publicState(state));
});

app.post('/api/test/gift', (req, res) => {
  const state = createRoom(req.body.room);
  handleGift(state, {
    uniqueId: cleanUser(req.body.username) || 'test_kullanici',
    giftName: req.body.gift || 'Hediye',
    repeatCount: Math.max(1, Number(req.body.repeatCount) || 1)
  });
  res.json(publicState(state));
});

app.post('/api/connect', async (req, res) => {
  const room = normalizeRoom(req.body.room);
  const username = cleanUser(req.body.username);
  if (!room || !username) {
    return res.status(400).json({ ok: false, message: 'Room ve TikTok kullanıcı adı gerekli.' });
  }

  try {
    await connectTikTok(room, username);
    res.json({ ok: true, message: `@${username} için bağlantı başlatıldı.` });
  } catch (error) {
    const state = createRoom(room);
    state.connected = false;
    broadcast(state);
    res.status(400).json({
      ok: false,
      message: `TikTok bağlantısı kurulamadı: ${error?.message || 'Bilinmeyen hata'}`
    });
  }
});

io.on('connection', (socket) => {
  socket.on('join', (rawRoom) => {
    const room = normalizeRoom(rawRoom);
    if (!room) return;
    socket.join(room);
    socket.emit('state', publicState(createRoom(room)));
  });
});

app.get('/panel', (_req, res) => res.type('html').send(PANEL_HTML));
app.get('/panel.html', (_req, res) => res.type('html').send(PANEL_HTML));
app.get('/overlay/:type', (_req, res) => res.type('html').send(OVERLAY_HTML));
app.get('/overlay.html', (_req, res) => res.type('html').send(OVERLAY_HTML));
app.get('/', (_req, res) => res.type('html').send(INDEX_HTML));

server.listen(PORT, () => {
  console.log(`MS Yayin running on ${PORT}`);
});
