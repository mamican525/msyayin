const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const { WebcastPushConnection } = require('tiktok-live-connector');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const rooms = new Map();
const connections = new Map();

const GIFT_CATALOG = [
  'Gül', 'Kalp Parmak', 'Parmak Kalp', 'GG', 'Parıltılı Kalp',
  'Galaksi', 'Aslan', 'TikTok Universe', 'Yat', 'Konfeti',
  'Çiçek', 'Kraliyet Tacı', 'Taç', 'Aşk Balonu', 'Diğer'
];

function makeRoomCode() {
  return `MS-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

function cleanUser(value) {
  return String(value || '').replace(/^@/, '').trim();
}

function getRoom(code) {
  const room = String(code || '').trim().toUpperCase();
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
      wins: 0,
      penalty: 20,
      lastGift: null,
      lastEvent: null
    });
  }
  return rooms.get(room);
}

function makePublicState(s) {
  const uniqueParticipants = new Set(s.votes.map(v => v.username));
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
    participants: uniqueParticipants.size,
    votes: s.votes.slice(-100).reverse(),
    likes: [...s.likes.entries()]
      .map(([username, likeCount]) => ({ username, likeCount }))
      .sort((a, b) => b.likeCount - a.likeCount)
      .slice(0, 100),
    giftRules: s.giftRules,
    giftCatalog: GIFT_CATALOG,
    wins: s.wins,
    penalty: s.penalty,
    lastGift: s.lastGift,
    lastEvent: s.lastEvent
  };
}

function broadcast(s) {
  io.to(s.room).emit('state', makePublicState(s));
}

function findRule(s, giftName) {
  const target = String(giftName || '').trim().toLowerCase();
  return s.giftRules.find(rule => String(rule.gift || '').trim().toLowerCase() === target);
}

function handleGift(s, username, giftName, repeatCount = 1) {
  const rule = findRule(s, giftName);
  const gift = String(giftName || 'Hediye').trim();
  s.lastGift = {
    username: cleanUser(username) || 'bilinmeyen',
    gift,
    repeatCount: Number(repeatCount) || 1,
    type: rule ? rule.type : 'none',
    time: Date.now()
  };
  s.lastEvent = { kind: 'gift', ...s.lastGift };
  broadcast(s);
}

function saveRule(s, gift, type) {
  const normalized = String(gift || '').trim();
  if (!normalized) return;
  const existing = s.giftRules.find(r => r.type === type && r.gift.toLowerCase() === normalized.toLowerCase());
  if (!existing) s.giftRules.push({ gift: normalized, type, active: true });
}

function appPage() {
  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MS Yayın</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:#090a0f;color:#f5f5f5}.wrap{min-height:100vh;display:grid;place-items:center;padding:28px}.card{width:min(640px,100%);background:#11141d;border:1px solid #272c38;border-radius:22px;padding:34px;box-shadow:0 25px 80px #0008}.logo{font-size:34px;font-weight:900;margin-bottom:10px}.logo span{color:#e53935}.muted{color:#9299a8;line-height:1.6}.btn{display:block;width:100%;border:0;border-radius:12px;padding:14px 18px;font-weight:800;font-size:16px;cursor:pointer;margin-top:18px;background:#e53935;color:#fff}.room{margin-top:18px;padding:16px;border-radius:14px;background:#0b0e14;border:1px dashed #373d4a;display:none}.room b{font-size:20px}
</style></head>
<body><div class="wrap"><div class="card">
<div class="logo">🔥 MS <span>YAYIN</span></div>
<h1>Yayın Yönetim Sistemi</h1>
<p class="muted">Tek tıkla yeni yayın odası oluştur. Room kodunu sen yazmak zorunda değilsin.</p>
<button class="btn" id="newRoom">🟢 YENİ YAYIN BAŞLAT</button>
<div class="room" id="result"></div>
</div></div>
<script>
document.getElementById('newRoom').onclick=async()=>{
  const r=await fetch('/api/rooms',{method:'POST'}).then(x=>x.json());
  localStorage.setItem('ms_room',r.room);
  location.href='/panel?room='+encodeURIComponent(r.room);
};
</script></body></html>`;
}

function panelPage() {
  return `<!doctype html>
<html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MS Yayın Paneli</title><script src="/socket.io/socket.io.js"></script>
<style>
*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:#090a0f;color:#f5f5f5}.panel{min-height:100vh;display:flex}.side{position:fixed;inset:0 auto 0 0;width:255px;background:#0f1118;border-right:1px solid #252936;padding:20px}.logo{font-size:22px;font-weight:900;margin-bottom:22px}.logo span{color:#e53935}.nav button{width:100%;border:0;background:transparent;color:#cbd0dc;text-align:left;padding:11px 12px;border-radius:10px;margin:3px 0;cursor:pointer;font-weight:700}.nav button:hover,.nav button.active{background:#1b1f29;color:#fff}.main{margin-left:255px;width:calc(100% - 255px);padding:28px}.top{display:flex;justify-content:space-between;align-items:center;gap:15px;margin-bottom:22px;flex-wrap:wrap}.roombox{background:#11141d;border:1px solid #252a37;padding:12px 15px;border-radius:12px}.card{background:#11141d;border:1px solid #252a37;border-radius:16px;padding:20px;margin-bottom:16px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}.stat{font-size:30px;font-weight:900}.muted{color:#9097a7}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}button,input,select{font:inherit}button{cursor:pointer;border:0;border-radius:10px;padding:11px 14px;background:#e53935;color:#fff;font-weight:800}button.green{background:#16804b}button.gold{background:#8f6812}button.dark{background:#252a36}button.danger{background:#a51f2a}input,select{background:#141821;color:#fff;border:1px solid #303646;border-radius:10px;padding:10px;min-width:180px}.list{max-height:390px;overflow:auto}.item{display:flex;justify-content:space-between;gap:10px;padding:11px 4px;border-bottom:1px solid #252a36}.badge{display:inline-block;border-radius:999px;padding:4px 9px;background:#252a36}.links{word-break:break-all;background:#0c0f15;padding:10px;border-radius:10px}.guide li{margin:10px 0}.toast{position:fixed;right:25px;bottom:25px;background:#1d2430;padding:14px 18px;border-radius:12px;border:1px solid #3a4050;display:none}.small{font-size:12px}.overlayUrl{font-size:12px}
@media(max-width:850px){.side{width:200px}.main{margin-left:200px;width:calc(100% - 200px)}.grid{grid-template-columns:1fr}}
</style></head>
<body><div class="panel"><aside class="side"><div class="logo">🔥 MS <span>YAYIN</span></div><div class="nav">
<button data-tab="connection">🔴 Yayın Bağlantısı</button><button data-tab="score">⭐ Puanlama</button><button data-tab="racon">👑 Racon Kralları</button><button data-tab="mekan">🏠 Mekan Sahibi</button><button data-tab="likes">❤️ Beğeni Sıralaması</button><button data-tab="win">🏆 WIN Sayacı</button><button data-tab="test">🧪 Test Merkezi</button><button data-tab="guide">📖 Kullanım Rehberi</button>
</div><button class="dark" style="width:100%;margin-top:12px" onclick="newShow()">🆕 Yeni Yayın</button></aside>
<main class="main"><div class="top"><div><h1 style="margin:0 0 6px">Yayın Yönetim Paneli</h1><div class="muted">Room otomatik oluşturuldu · tüm overlaylar aynı odaya bağlı</div></div><div class="roombox">ROOM: <b id="roomLabel">—</b></div></div><div id="app"></div></main></div><div id="toast" class="toast"></div>
<script>
const socket=io();
const params=new URLSearchParams(location.search);
let room=params.get('room')||localStorage.getItem('ms_room');
if(!room){location.href='/';}
room=room.toUpperCase();localStorage.setItem('ms_room',room);socket.emit('join',room);
let state=null;
function toast(t){const e=document.getElementById('toast');e.textContent=t;e.style.display='block';setTimeout(()=>e.style.display='none',2200)}
async function post(path,body={}){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room,...body})});return r.json()}
function overlayLinks(type){return location.origin+'/overlay?room='+encodeURIComponent(room)+'&type='+encodeURIComponent(type)}
function nav(tab){document.querySelectorAll('.nav button').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));render(tab)}
document.querySelectorAll('.nav button').forEach(b=>b.onclick=()=>nav(b.dataset.tab));
document.getElementById('roomLabel').textContent=room;
function render(tab){
const overlayBox=type=>'<div class="card"><b>🎥 Overlay Linki</b><div class="links">'+overlayLinks(type)+'</div><button class="dark" onclick="navigator.clipboard.writeText(\''+overlayLinks(type)+\').then(()=>toast(\'Overlay linki kopyalandı\'))">📋 Linki Kopyala</button></div>';
const giftSelect=(id)=>'<select id="'+id+'">'+(state?.giftCatalog||[]).map(g=>'<option value="'+g+'">🎁 '+g+'</option>').join('')+'</select>';
let html='';
if(tab==='connection') html=\`<div class="card"><h2>🔴 Yayın Bağlantısı</h2><p class="muted">TikTok kullanıcı adını yaz. Room otomatik olarak hazırlandı.</p><div class="row"><input id="ttuser" placeholder="@kullanici"><button onclick="connectTikTok()">BAĞLAN</button></div><p>Durum: <b>${state?.connected?'🟢 BAĞLI':'🔴 BAĞLI DEĞİL'}</b></p></div>\`;
if(tab==='score') html=\`<div class="card"><h2>⭐ Puanlama</h2><div class="row"><label>Süre <input id="duration" type="number" min="1" value="${state?.scoreDuration||15}"> saniye</label><button class="dark" onclick="saveDuration()">Kaydet</button><button class="green" onclick="startScore()">PUANLAMAYI BAŞLAT</button><button class="danger" onclick="stopScore()">BİTİR</button></div><div class="grid" style="margin-top:15px"><div class="card"><span class="muted">Ortalama</span><div class="stat">${state?.average||0}</div></div><div class="card"><span class="muted">Katılımcı</span><div class="stat">${state?.participants||0}</div></div><div class="card"><span class="muted">Durum</span><div class="stat">${state?.scoring?'🟢':'⚪'}</div></div></div><div class="list">${(state?.votes||[]).map(v=>'<div class="item"><span>@'+v.username+'</span><b>'+v.score+'</b></div>').join('')}</div></div>\`+overlayBox('puanlama');
if(tab==='racon') html=\`<div class="card"><h2>👑 Racon Kralları</h2><p class="muted">Hediye adını yazmıyoruz; listeden seçiyoruz.</p><div class="row">${giftSelect('raconGift')}<button onclick="addRule('racon')">➕ Racon Hediyesi Ekle</button></div><div class="list" style="margin-top:12px">${(state?.giftRules||[]).filter(r=>r.type==='racon').map(r=>'<div class="item"><span>🎁 '+r.gift+'</span><span class="badge">👑 Aktif</span></div>').join('')||'<div class="muted">Henüz hediye seçilmedi.</div>'}</div></div>\`+overlayBox('racon');
if(tab==='mekan') html=\`<div class="card"><h2>🏠 Mekan Sahibi</h2><p class="muted">Hediye adını yazmıyoruz; listeden seçiyoruz.</p><div class="row">${giftSelect('mekanGift')}<button onclick="addRule('mekan')">➕ Mekan Hediyesi Ekle</button></div><div class="list" style="margin-top:12px">${(state?.giftRules||[]).filter(r=>r.type==='mekan').map(r=>'<div class="item"><span>🎁 '+r.gift+'</span><span class="badge">🏠 Aktif</span></div>').join('')||'<div class="muted">Henüz hediye seçilmedi.</div>'}</div></div>\`+overlayBox('mekan');
if(tab==='likes') html=\`<div class="card"><h2>❤️ Beğeni Sıralaması</h2><button class="danger" onclick="resetLikes()">Beğenileri Sıfırla</button><div class="list" style="margin-top:10px">${(state?.likes||[]).map((v,i)=>'<div class="item"><span>'+(i<3?['🥇','🥈','🥉'][i]+' ':'')+'@'+v.username+'</span><b>'+Number(v.likeCount).toLocaleString('tr-TR')+' ❤️</b></div>').join('')||'<div class="muted">Henüz beğeni yok.</div>'}</div></div>\`+overlayBox('begeni');
if(tab==='win') html=\`<div class="card"><h2>🏆 WIN Sayacı</h2><div class="stat">${String(state?.wins||0).padStart(2,'0')} / 20</div><div class="row" style="margin-top:15px"><button onclick="changeWin(1)">+ WIN</button><button class="danger" onclick="changeWin(-1)">- WIN</button><button class="gold" onclick="resetWin()">SIFIRLA</button></div></div>\`+overlayBox('win');
if(tab==='test') html=\`<div class="card"><h2>🧪 Test Merkezi</h2><p class="muted">Gerçek yayın gelmiş gibi test verisi gönder.</p><div class="row"><input id="testUser" value="test_kullanici" placeholder="kullanıcı"><input id="testScore" type="number" min="1" max="10" value="10"><button onclick="testVote()">⭐ Test Puanı</button></div><div class="row" style="margin-top:10px">${giftSelect('testGift')}<button onclick="testGift()">🎁 Test Hediye</button></div><div class="row" style="margin-top:10px"><input id="testLikes" type="number" value="100"><button onclick="testLike()">❤️ Test Beğeni</button></div></div>\`;
if(tab==='guide') html=\`<div class="card guide"><h2>📖 Kullanım Rehberi</h2><ol><li>Site açılınca <b>Yeni Yayın Başlat</b> de. Room kodu otomatik oluşur.</li><li>TikTok kullanıcı adını <b>Yayın Bağlantısı</b> bölümünden bağla.</li><li>Racon ve Mekan bölümlerinde hediyeyi <b>listeden seç</b>.</li><li>Puanlama süresini değiştirip başlat.</li><li>Overlay linklerini OBS/TikTok Live Studio'ya Browser Source olarak ekle.</li></ol><p class="muted">Aynı Room kodu paneli ve bütün overlayları birbirine bağlar.</p></div>\`;
document.getElementById('app').innerHTML=html;
}
async function connectTikTok(){const u=document.getElementById('ttuser').value;const r=await post('/api/connect',{username:u});toast(r.message||'');}
async function saveDuration(){await post('/api/duration',{duration:Number(document.getElementById('duration').value)});toast('Puanlama süresi kaydedildi');}
async function startScore(){await post('/api/score/start');toast('Puanlama başladı');}
async function stopScore(){await post('/api/score/stop');toast('Puanlama bitti');}
async function addRule(type){const id=type==='racon'?'raconGift':'mekanGift';await post('/api/rule',{gift:document.getElementById(id).value,type});toast('Hediye kuralı eklendi');}
async function resetLikes(){await post('/api/likes/reset');toast('Beğeniler sıfırlandı');}
async function changeWin(change){await post('/api/win',{change});}
async function resetWin(){await post('/api/win',{change:0});}
async function testVote(){await post('/api/test/vote',{username:document.getElementById('testUser').value,score:Number(document.getElementById('testScore').value)});}
async function testGift(){await post('/api/test/gift',{username:document.getElementById('testUser').value,gift:document.getElementById('testGift').value});}
async function testLike(){await post('/api/test/like',{username:document.getElementById('testUser').value,count:Number(document.getElementById('testLikes').value)});}
function newShow(){location.href='/';}
socket.on('state',s=>{state=s;const active=document.querySelector('.nav button.active');render(active?active.dataset.tab:'connection')});
fetch('/api/state?room='+encodeURIComponent(room)).then(r=>r.json()).then(s=>{state=s;nav('connection')});
</script></body></html>`;
}

function overlayPage() {
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MS Yayın Overlay</title><script src="/socket.io/socket.io.js"></script>
<style>*{box-sizing:border-box}body{margin:0;background:transparent;font-family:Arial,sans-serif;color:#fff}.wrap{min-height:100vh;display:grid;place-items:center;padding:25px}.box{min-width:420px;max-width:90vw;padding:28px 34px;border-radius:22px;background:rgba(8,9,14,.90);border:1px solid rgba(255,255,255,.14);box-shadow:0 25px 70px rgba(0,0,0,.4);text-align:center}.title{font-size:26px;font-weight:900;margin-bottom:10px}.big{font-size:56px;font-weight:900}.row{display:flex;justify-content:center;gap:10px;flex-wrap:wrap;margin-top:12px}.item{padding:7px 0;font-size:20px}.muted{opacity:.7;font-size:14px}</style></head><body><div class="wrap"><div class="box" id="box"><div class="muted">Bekleniyor...</div></div></div>
<script>
const q=new URLSearchParams(location.search),room=q.get('room'),type=q.get('type')||'all';const socket=io();socket.emit('join',room);
function render(s){
const b=document.getElementById('box');let html='';
if(type==='puanlama'){html='<div class="title">⭐ PUANLAMA</div><div class="big">'+(s.average||0)+'</div><div>'+s.participants+' katılımcı</div><div class="muted">'+(s.scoring?'PUANLAMA AKTİF':'Beklemede')+'</div>';}
else if(type==='racon'){const g=s.lastGift;html='<div class="title">👑 RACON KRALI</div><div class="big">'+(g&&g.type==='racon'?'@'+g.username:'')+'</div><div>'+(g&&g.type==='racon'?g.gift:'Bekleniyor...')+'</div>';}
else if(type==='mekan'){const g=s.lastGift;html='<div class="title">🏠 MEKAN SAHİBİ</div><div class="big">'+(g&&g.type==='mekan'?'@'+g.username:'')+'</div><div>'+(g&&g.type==='mekan'?g.gift:'Bekleniyor...')+'</div>';}
else if(type==='begeni'){html='<div class="title">❤️ BEĞENİ SIRALAMASI</div>'+s.likes.slice(0,10).map((x,i)=>'<div class="item">'+(i+1)+'. @'+x.username+' — '+Number(x.likeCount).toLocaleString('tr-TR')+' ❤️</div>').join('');}
else if(type==='win'){html='<div class="title">🏆 WIN</div><div class="big">'+String(s.wins).padStart(2,'0')+'/20</div>';}
else {html='<div class="title">MS YAYIN</div><div>⭐ '+(s.average||0)+' · ❤️ '+s.likes.length+' kişi · 🏆 '+String(s.wins).padStart(2,'0')+'/20</div>'+(s.lastGift?'<div class="row"><span>🎁 @'+s.lastGift.username+'</span><span>'+s.lastGift.gift+'</span></div>':'');}
b.innerHTML=html||'<div class="muted">Bekleniyor...</div>';
}
socket.on('state',render);
</script></body></html>`;
}

app.get('/', (req, res) => res.send(appPage()));
app.get('/panel', (req, res) => res.send(panelPage()));
app.get('/overlay', (req, res) => res.send(overlayPage()));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

app.post('/api/rooms', (req, res) => {
  const room = makeRoomCode();
  getRoom(room);
  res.json({ ok: true, room, panelUrl: `/panel?room=${room}` });
});

app.get('/api/state', (req, res) => {
  const room = String(req.query.room || '').toUpperCase();
  if (!room) return res.status(400).json({ ok: false, message: 'Room gerekli.' });
  res.json(makePublicState(getRoom(room)));
});

app.post('/api/duration', (req, res) => {
  const s = getRoom(req.body.room);
  s.scoreDuration = Math.max(1, Number(req.body.duration) || 15);
  broadcast(s); res.json(makePublicState(s));
});

app.post('/api/score/start', (req, res) => {
  const s = getRoom(req.body.room);
  s.scoring = true; s.votes = []; s.scoreEndsAt = Date.now() + s.scoreDuration * 1000;
  broadcast(s);
  setTimeout(() => {
    if (s.scoring && Date.now() >= s.scoreEndsAt) { s.scoring = false; broadcast(s); }
  }, s.scoreDuration * 1000 + 100);
  res.json(makePublicState(s));
});

app.post('/api/score/stop', (req, res) => {
  const s = getRoom(req.body.room); s.scoring = false; broadcast(s); res.json(makePublicState(s));
});

app.post('/api/rule', (req, res) => {
  const s = getRoom(req.body.room); saveRule(s, req.body.gift, req.body.type); broadcast(s); res.json(makePublicState(s));
});

app.post('/api/likes/reset', (req, res) => {
  const s = getRoom(req.body.room); s.likes.clear(); broadcast(s); res.json(makePublicState(s));
});

app.post('/api/win', (req, res) => {
  const s = getRoom(req.body.room); const change = Number(req.body.change);
  s.wins = change === 0 ? 0 : Math.max(0, s.wins + (Number.isFinite(change) ? change : 0));
  broadcast(s); res.json(makePublicState(s));
});

app.post('/api/test/vote', (req, res) => {
  const s = getRoom(req.body.room);
  if (s.scoring) {
    const score = Math.max(1, Math.min(10, Number(req.body.score) || 1));
    s.votes.push({ username: cleanUser(req.body.username) || 'test', score, time: Date.now() });
    broadcast(s);
  }
  res.json(makePublicState(s));
});

app.post('/api/test/like', (req, res) => {
  const s = getRoom(req.body.room); const username = cleanUser(req.body.username) || 'test';
  const count = Math.max(1, Number(req.body.count) || 1);
  s.likes.set(username, (s.likes.get(username) || 0) + count);
  broadcast(s); res.json(makePublicState(s));
});

app.post('/api/test/gift', (req, res) => {
  const s = getRoom(req.body.room);
  handleGift(s, cleanUser(req.body.username) || 'test', req.body.gift, 1);
  res.json(makePublicState(s));
});

app.post('/api/connect', async (req, res) => {
  const room = String(req.body.room || '').toUpperCase();
  const username = cleanUser(req.body.username);
  if (!room || !username) return res.status(400).json({ ok: false, message: 'Room ve TikTok kullanıcı adı gerekli.' });

  if (connections.has(room)) {
    try { await connections.get(room).disconnect(); } catch (_) {}
  }

  const s = getRoom(room); s.username = username;
  const conn = new WebcastPushConnection(username, { processInitialData: false });
  connections.set(room, conn);

  conn.on('connected', () => { s.connected = true; broadcast(s); });
  conn.on('disconnected', () => { s.connected = false; broadcast(s); });
  conn.on('error', () => { s.connected = false; broadcast(s); });

  conn.on('chat', data => {
    if (!s.scoring) return;
    const comment = String(data.comment || '').trim();
    const digits = Number(comment.replace(/[^0-9]/g, ''));
    if (digits >= 1 && digits <= 10) {
      s.votes.push({ username: cleanUser(data.uniqueId || data.nickname) || 'bilinmeyen', score: digits, time: Date.now() });
      broadcast(s);
    }
  });

  conn.on('like', data => {
    const username = cleanUser(data.uniqueId || data.nickname) || 'bilinmeyen';
    const count = Number(data.likeCount || data.totalLikeCount || 1) || 1;
    s.likes.set(username, (s.likes.get(username) || 0) + count);
    s.lastEvent = { kind: 'like', username, count, time: Date.now() };
    broadcast(s);
  });

  conn.on('gift', data => {
    const username = cleanUser(data.uniqueId || data.nickname) || 'bilinmeyen';
    const giftName = String(data.giftName || data.gift || 'Hediye');
    const repeatCount = Number(data.repeatCount || 1) || 1;
    handleGift(s, username, giftName, repeatCount);
  });

  try {
    await conn.connect();
    res.json({ ok: true, message: 'TikTok bağlantısı başlatıldı.' });
  } catch (error) {
    s.connected = false; broadcast(s);
    res.json({ ok: false, message: `TikTok bağlantısı kurulamadı: ${error.message}` });
  }
});

io.on('connection', socket => {
  socket.on('join', room => {
    room = String(room || '').toUpperCase();
    if (!room) return;
    socket.join(room);
    socket.emit('state', makePublicState(getRoom(room)));
  });
});

server.listen(PORT, () => console.log(`MS Yayın running on ${PORT}`));
