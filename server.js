const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const TiktokLib = require("tiktok-live-connector");
const WebcastPushConnection =
  TiktokLib.WebcastPushConnection || TiktokLib.default || TiktokLib;

if (typeof WebcastPushConnection !== "function") {
  throw new Error("TikTok bağlantı modülü yüklenemedi.");
}

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);
const PORT = process.env.PORT || 10000;

app.use(express.json({ limit: "100kb" }));

const state = {
  connected: false,
  username: "",
  scoreDuration: 15,
  scoring: false,
  scoreEndsAt: 0,
  votes: [],
  likes: new Map(),
  giftRules: {
    racon: "",
    mekan: ""
  },
  giftCatalog: [],
  racon: new Map(),
  mekan: new Map(),
  lastRacon: null,
  lastMekan: null,
  wins: 0,
  maxWins: 20,
  penalty: 20,
  lastEventAt: 0
};

let tiktok = null;
let scoreTimer = null;

function cleanUsername(value) {
  return String(value || "").replace(/^@+/, "").trim().slice(0, 80);
}

function normalizeGift(value) {
  return String(value || "").trim().toLowerCase();
}

function safeGiftName(value) {
  return String(value || "Hediye").trim().slice(0, 80);
}

function avatarOf(data) {
  return data?.profilePictureUrl || data?.profilePicture || data?.avatar || "";
}

function publicState() {
  const voteUsers = new Set(state.votes.map((v) => v.username));
  const voteSum = state.votes.reduce((sum, v) => sum + v.score, 0);

  return {
    connected: state.connected,
    username: state.username,
    scoreDuration: state.scoreDuration,
    scoring: state.scoring,
    scoreEndsAt: state.scoreEndsAt,
    average: state.votes.length ? Number((voteSum / state.votes.length).toFixed(2)) : 0,
    participants: voteUsers.size,
    votes: state.votes.slice(-100).reverse(),
    likes: Array.from(state.likes.entries())
      .map(([username, item]) => ({
        username,
        likeCount: item.likeCount,
        avatar: item.avatar || ""
      }))
      .sort((a, b) => b.likeCount - a.likeCount)
      .slice(0, 100),
    giftRules: { ...state.giftRules },
    giftCatalog: state.giftCatalog.slice(-100),
    racon: Array.from(state.racon.values()).sort((a, b) => b.count - a.count).slice(0, 50),
    mekan: Array.from(state.mekan.values()).sort((a, b) => b.count - a.count).slice(0, 50),
    lastRacon: state.lastRacon,
    lastMekan: state.lastMekan,
    wins: state.wins,
    maxWins: state.maxWins,
    penalty: state.penalty,
    lastEventAt: state.lastEventAt
  };
}

function broadcast() {
  io.emit("state", publicState());
}

function upsertGiftCatalog(gift) {
  const normalized = normalizeGift(gift);
  if (!normalized) return;
  if (!state.giftCatalog.some((g) => normalizeGift(g) === normalized)) {
    state.giftCatalog.push(safeGiftName(gift));
    state.giftCatalog = state.giftCatalog.slice(-100);
  }
}

function addVote(username, score, avatar = "") {
  if (!state.scoring) return;
  const n = Number(score);
  if (!Number.isInteger(n) || n < 1 || n > 10) return;
  state.votes.push({
    username: cleanUsername(username) || "bilinmeyen",
    score: n,
    avatar: avatar || "",
    at: Date.now()
  });
  state.votes = state.votes.slice(-300);
  state.lastEventAt = Date.now();
  broadcast();
}

function addLikes(username, count, avatar = "") {
  const user = cleanUsername(username) || "bilinmeyen";
  const delta = Math.max(1, Number(count) || 1);
  const old = state.likes.get(user) || { likeCount: 0, avatar: "" };
  state.likes.set(user, {
    likeCount: old.likeCount + delta,
    avatar: avatar || old.avatar || ""
  });
  state.lastEventAt = Date.now();
  broadcast();
}

function addGift(username, gift, avatar = "") {
  const user = cleanUsername(username) || "bilinmeyen";
  const giftName = safeGiftName(gift);
  const key = normalizeGift(giftName);
  upsertGiftCatalog(giftName);

  if (state.giftRules.racon && normalizeGift(state.giftRules.racon) === key) {
    const old = state.racon.get(user) || { username: user, count: 0, avatar: "" };
    const item = { username: user, count: old.count + 1, avatar: avatar || old.avatar || "", gift: giftName };
    state.racon.set(user, item);
    state.lastRacon = { username: user, avatar: item.avatar, gift: giftName, at: Date.now() };
  }

  if (state.giftRules.mekan && normalizeGift(state.giftRules.mekan) === key) {
    const old = state.mekan.get(user) || { username: user, count: 0, avatar: "" };
    const item = { username: user, count: old.count + 1, avatar: avatar || old.avatar || "", gift: giftName };
    state.mekan.set(user, item);
    state.lastMekan = { username: user, avatar: item.avatar, gift: giftName, at: Date.now() };
  }

  state.lastEventAt = Date.now();
  broadcast();
}

function stopScoring() {
  state.scoring = false;
  state.scoreEndsAt = 0;
  if (scoreTimer) clearTimeout(scoreTimer);
  scoreTimer = null;
  broadcast();
}

function startScoring() {
  stopScoring();
  state.votes = [];
  state.scoring = true;
  state.scoreEndsAt = Date.now() + state.scoreDuration * 1000;
  scoreTimer = setTimeout(stopScoring, state.scoreDuration * 1000);
  broadcast();
}

async function disconnectTikTok() {
  if (!tiktok) return;
  try {
    if (typeof tiktok.disconnect === "function") await tiktok.disconnect();
  } catch (_) {}
  tiktok = null;
  state.connected = false;
  broadcast();
}

async function connectTikTok(username) {
  const user = cleanUsername(username);
  if (!user) throw new Error("TikTok kullanıcı adı boş olamaz.");

  await disconnectTikTok();

  const connection = new WebcastPushConnection(user, {
    processInitialData: false,
    enableWebsocketUpgrade: true
  });

  tiktok = connection;
  state.username = user;
  state.connected = false;
  broadcast();

  connection.on("connected", () => {
    state.connected = true;
    state.lastEventAt = Date.now();
    broadcast();
  });

  connection.on("disconnected", () => {
    state.connected = false;
    broadcast();
  });

  connection.on("streamEnd", () => {
    state.connected = false;
    broadcast();
  });

  connection.on("error", () => {
    state.connected = false;
    broadcast();
  });

  connection.on("chat", (data) => {
    const comment = String(data?.comment || "").trim();
    if (/^(10|[1-9])$/.test(comment)) {
      addVote(
        data?.uniqueId || data?.nickname,
        Number(comment),
        avatarOf(data)
      );
    }
  });

  connection.on("like", (data) => {
    addLikes(
      data?.uniqueId || data?.nickname,
      data?.likeCount || data?.totalLikeCount || 1,
      avatarOf(data)
    );
  });

  connection.on("gift", (data) => {
    addGift(
      data?.uniqueId || data?.nickname,
      data?.giftName || data?.gift || "Hediye",
      avatarOf(data)
    );
  });

  await connection.connect();
  return { ok: true };
}

app.get("/", (_req, res) => res.type("html").send(PANEL_HTML));
app.get("/overlay/:type", (req, res) => {
  const allowed = ["puanlama", "racon", "mekan", "begeni", "win", "all"];
  const type = allowed.includes(req.params.type) ? req.params.type : "all";
  res.type("html").send(OVERLAY_HTML.replace("__OVERLAY_TYPE__", type));
});

app.get("/api/state", (_req, res) => {
  res.json(publicState());
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, connected: state.connected });
});

app.post("/api/connect", async (req, res) => {
  try {
    await connectTikTok(req.body?.username);
    res.json({ ok: true, message: "TikTok bağlantısı başlatıldı." });
  } catch (error) {
    state.connected = false;
    broadcast();
    res.status(400).json({
      ok: false,
      message: error?.message || "TikTok bağlantısı kurulamadı."
    });
  }
});

app.post("/api/disconnect", async (_req, res) => {
  await disconnectTikTok();
  state.username = "";
  res.json(publicState());
});

app.post("/api/score/settings", (req, res) => {
  const duration = Number(req.body?.duration);
  if (!Number.isFinite(duration) || duration < 1 || duration > 3600) {
    return res.status(400).json({ ok: false, message: "Süre 1 ile 3600 saniye arasında olmalı." });
  }
  state.scoreDuration = Math.floor(duration);
  broadcast();
  res.json(publicState());
});

app.post("/api/score/start", (_req, res) => {
  startScoring();
  res.json(publicState());
});

app.post("/api/score/stop", (_req, res) => {
  stopScoring();
  res.json(publicState());
});

app.post("/api/gift-rule", (req, res) => {
  const type = String(req.body?.type || "");
  const gift = safeGiftName(req.body?.gift);
  if (!["racon", "mekan"].includes(type)) {
    return res.status(400).json({ ok: false, message: "Geçersiz sistem." });
  }
  if (!gift) {
    return res.status(400).json({ ok: false, message: "Hediye seçilmedi." });
  }
  upsertGiftCatalog(gift);
  state.giftRules[type] = gift;
  broadcast();
  res.json(publicState());
});

app.post("/api/gift-rule/clear", (req, res) => {
  const type = String(req.body?.type || "");
  if (!["racon", "mekan"].includes(type)) {
    return res.status(400).json({ ok: false, message: "Geçersiz sistem." });
  }
  state.giftRules[type] = "";
  broadcast();
  res.json(publicState());
});

app.post("/api/likes/reset", (_req, res) => {
  state.likes.clear();
  broadcast();
  res.json(publicState());
});

app.post("/api/win", (req, res) => {
  const change = Number(req.body?.change);
  if (change === 0) state.wins = 0;
  else if (change === 1) state.wins = Math.min(state.maxWins, state.wins + 1);
  else if (change === -1) state.wins = Math.max(0, state.wins - 1);
  else return res.status(400).json({ ok: false, message: "Geçersiz WIN işlemi." });
  broadcast();
  res.json(publicState());
});

app.post("/api/test/vote", (req, res) => {
  if (!state.scoring) startScoring();
  addVote(req.body?.username || "test_kullanici", Number(req.body?.score) || 10);
  res.json(publicState());
});

app.post("/api/test/gift", (req, res) => {
  addGift(
    req.body?.username || "test_kullanici",
    req.body?.gift || "Test Hediyesi"
  );
  res.json(publicState());
});

app.post("/api/test/like", (req, res) => {
  addLikes(
    req.body?.username || "test_kullanici",
    Number(req.body?.count) || 100
  );
  res.json(publicState());
});

io.on("connection", (socket) => {
  socket.emit("state", publicState());
});

const PANEL_HTML = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MS YAYIN</title>
<style>
:root{--bg:#08090d;--side:#0f1118;--card:#131722;--line:#252a36;--text:#f7f7f7;--muted:#8f96a7;--red:#e53935;--green:#25b36a;--gold:#d5a329}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:Inter,Segoe UI,Arial,sans-serif;background:var(--bg);color:var(--text)}
button,input,select{font:inherit}button{border:0;border-radius:10px;padding:11px 15px;font-weight:800;cursor:pointer;background:var(--red);color:#fff}button.secondary{background:#222733}button.green{background:var(--green)}button.gold{background:#9a721b}button.danger{background:#a91f2d}
.layout{display:flex;min-height:100vh}.side{position:fixed;left:0;top:0;bottom:0;width:255px;padding:22px;background:var(--side);border-right:1px solid var(--line)}
.brand{font-size:23px;font-weight:950;margin-bottom:22px}.brand b{color:var(--red)}
.nav button{display:block;width:100%;text-align:left;background:transparent;color:#d1d5df;margin:4px 0}.nav button:hover,.nav button.active{background:#1b202b;color:#fff}
.main{margin-left:255px;width:calc(100% - 255px);padding:28px;max-width:1500px}.top{display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:22px}.top h1{margin:0 0 5px;font-size:30px}.muted{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:16px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.stat{font-size:32px;font-weight:950;margin-top:8px}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}input,select{background:#0e1118;border:1px solid #303645;color:#fff;padding:11px;border-radius:10px;min-width:180px}.wide{width:min(520px,100%)}
.table{width:100%;border-collapse:collapse}.table th,.table td{padding:11px 8px;border-bottom:1px solid var(--line);text-align:left}.empty{padding:24px;color:var(--muted);text-align:center}
.notice{padding:12px 14px;border-radius:10px;background:#171c26;border:1px solid var(--line)}.status{font-weight:900}.greenText{color:var(--green)}.redText{color:#ff6666}
.hero{padding:28px;border-radius:18px;background:linear-gradient(135deg,#171b25,#0e1017);border:1px solid var(--line)}
.overlayHint{font-size:13px;color:var(--muted);word-break:break-all;background:#0b0d12;padding:10px;border-radius:8px}
@media(max-width:900px){.side{width:205px}.main{margin-left:205px;width:calc(100% - 205px)}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:650px){.side{position:static;width:100%;height:auto}.layout{display:block}.main{margin:0;width:100%;padding:16px}.top{display:block}.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="layout">
<aside class="side">
  <div class="brand">🔥 MS <b>YAYIN</b></div>
  <div class="nav" id="nav">
    <button data-page="connection">🔴 Yayın Bağlantısı</button>
    <button data-page="score">⭐ Puanlama</button>
    <button data-page="racon">👑 Racon Kralları</button>
    <button data-page="mekan">🏠 Mekan Sahibi</button>
    <button data-page="likes">❤️ Beğeni Sıralaması</button>
    <button data-page="win">🏆 WIN Sayacı</button>
    <button data-page="test">🧪 Test Merkezi</button>
    <button data-page="guide">📖 Kullanım Rehberi</button>
  </div>
</aside>
<main class="main">
  <div class="top">
    <div><h1 id="pageTitle">Yayın Bağlantısı</h1><div class="muted">Tek yayıncı · Room yok · direkt kullanıcı adı ile bağlantı</div></div>
    <div class="notice">Durum: <span id="topStatus" class="status redText">Bağlı değil</span></div>
  </div>
  <div id="content"></div>
</main>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
const socket = io();
let S = null;
let page = "connection";
const $ = (id) => document.getElementById(id);

function getState(){
  return fetch("/api/state").then(r => r.json()).then(setState);
}
function post(url, body){
  return fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body||{})})
    .then(async r => {
      const data = await r.json();
      if(!r.ok) throw new Error(data.message || "İşlem başarısız");
      return data;
    }).then(setState);
}
function esc(v){
  return String(v ?? "").replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));
}
function setState(s){
  S = s;
  $("topStatus").textContent = s.connected ? "🟢 Bağlı" : "🔴 Bağlı değil";
  $("topStatus").className = "status " + (s.connected ? "greenText" : "redText");
  render();
}
function overlayLink(type){
  return location.origin + "/overlay/" + type;
}
function show(pageName){
  page = pageName;
  document.querySelectorAll("#nav button").forEach(b => b.classList.toggle("active", b.dataset.page === page));
  const titles={connection:"Yayın Bağlantısı",score:"Puanlama",racon:"Racon Kralları",mekan:"Mekan Sahibi",likes:"Beğeni Sıralaması",win:"WIN Sayacı",test:"Test Merkezi",guide:"Kullanım Rehberi"};
  $("pageTitle").textContent = titles[page];
  render();
}
document.querySelectorAll("#nav button").forEach(b => b.addEventListener("click",()=>show(b.dataset.page)));

function giftOptions(selected){
  const all = Array.from(new Set((S?.giftCatalog || []).filter(Boolean)));
  let html = '<option value="">Hediye seç...</option>';
  all.forEach(g => html += '<option value="'+esc(g)+'" '+(g===selected?'selected':'')+'>'+esc(g)+'</option>');
  if(!all.length) html += '<option disabled>Henüz hediye algılanmadı</option>';
  return html;
}
function render(){
  if(!S) return;
  const base = {
    connection: connectionView,
    score: scoreView,
    racon: raconView,
    mekan: mekanView,
    likes: likesView,
    win: winView,
    test: testView,
    guide: guideView
  };
  $("content").innerHTML = base[page]();
  wirePage();
}
function connectionView(){
  return '<div class="hero"><h2>🔴 Yayına Bağlan</h2><p class="muted">Sadece TikTok kullanıcı adını yaz. Oda kodu yok.</p>'+
  '<div class="row"><input id="ttUser" class="wide" placeholder="@kullaniciadi" value="'+esc(S.username)+'"><button id="connectBtn">BAĞLAN</button><button class="secondary" id="disconnectBtn">BAĞLANTIYI KES</button></div>'+
  '<p>Durum: <b class="'+(S.connected?'greenText':'redText')+'">'+(S.connected?'🟢 Canlı bağlantı aktif':'🔴 Bağlı değil')+'</b></p></div>'+
  '<div class="grid"><div class="card"><div class="muted">Puanlama</div><div class="stat">'+esc(S.average)+'</div></div><div class="card"><div class="muted">Katılımcı</div><div class="stat">'+esc(S.participants)+'</div></div><div class="card"><div class="muted">Beğeni kullanıcısı</div><div class="stat">'+esc(S.likes.length)+'</div></div><div class="card"><div class="muted">WIN</div><div class="stat">'+String(S.wins).padStart(2,"0")+'/'+S.maxWins+'</div></div></div>';
}
function scoreView(){
  const left = S.scoring ? Math.max(0,Math.ceil((S.scoreEndsAt-Date.now())/1000)) : 0;
  let rows=S.votes.map(v=>'<tr><td>@'+esc(v.username)+'</td><td><b>'+v.score+'</b></td></tr>').join('');
  return '<div class="card"><h2>⭐ Puanlama</h2><div class="row"><label>Süre <input id="duration" type="number" min="1" max="3600" value="'+S.scoreDuration+'"> sn</label><button id="saveDuration" class="secondary">SÜREYİ KAYDET</button><button id="startScore" class="green">PUANLAMAYI BAŞLAT</button><button id="stopScore" class="danger">BİTİR</button></div></div>'+
  '<div class="grid"><div class="card"><div class="muted">Ortalama</div><div class="stat">'+esc(S.average)+'</div></div><div class="card"><div class="muted">Katılımcı</div><div class="stat">'+esc(S.participants)+'</div></div><div class="card"><div class="muted">Kalan</div><div class="stat">'+(S.scoring?left+" sn":"—")+'</div></div><div class="card"><div class="muted">Durum</div><div class="stat" style="font-size:22px">'+(S.scoring?'🟢 AKTİF':'⚪ BEKLEMEDE')+'</div></div></div>'+
  '<div class="card"><h3>Oy verenler</h3><table class="table"><thead><tr><th>Kullanıcı</th><th>Puan</th></tr></thead><tbody>'+(rows||'<tr><td colspan="2" class="empty">Henüz puan yok.</td></tr>')+'</tbody></table></div>'+
  '<div class="card"><h3>Overlay</h3><div class="overlayHint">'+esc(overlayLink("puanlama"))+'</div></div>';
}
function categoryView(type, title, icon, linkType){
  const selected=S.giftRules[type];
  const list=(S[type]||[]).map((x,i)=>'<tr><td>'+((i<3)?["🥇","🥈","🥉"][i]:(i+1)+".")+' @'+esc(x.username)+'</td><td>'+esc(x.count)+'x</td><td>'+esc(x.gift||"")+'</td></tr>').join('');
  return '<div class="card"><h2>'+icon+' '+title+'</h2><p class="muted">Dropdown’dan hediyeyi seç. O hediye geldiğinde gönderen otomatik listeye eklenir.</p><div class="row"><select id="giftSelect">'+giftOptions(selected)+'</select><button id="saveGift" class="green">HEDİYEYİ AKTİF ET</button><button id="clearGift" class="secondary">KALDIR</button></div><p>Aktif hediye: <b>'+(selected?esc(selected):'Yok')+'</b></p></div>'+
  '<div class="card"><h3>Otomatik liste</h3><table class="table"><thead><tr><th>Kullanıcı</th><th>Adet</th><th>Hediye</th></tr></thead><tbody>'+(list||'<tr><td colspan="3" class="empty">Henüz kayıt yok.</td></tr>')+'</tbody></table></div>'+
  '<div class="card"><h3>Overlay</h3><div class="overlayHint">'+esc(overlayLink(linkType))+'</div></div>';
}
function raconView(){return categoryView("racon","Racon Kralları","👑","racon")}
function mekanView(){return categoryView("mekan","Mekan Sahibi","🏠","mekan")}
function likesView(){
  const rows=S.likes.map((x,i)=>'<tr><td>'+((i<3)?["🥇","🥈","🥉"][i]:(i+1)+".")+' @'+esc(x.username)+'</td><td>'+Number(x.likeCount).toLocaleString("tr-TR")+' ❤️</td></tr>').join('');
  return '<div class="card"><div class="row" style="justify-content:space-between"><h2>❤️ Beğeni Sıralaması</h2><button class="danger" id="resetLikes">SIFIRLA</button></div><table class="table"><thead><tr><th>Kullanıcı</th><th>Beğeni</th></tr></thead><tbody>'+(rows||'<tr><td colspan="2" class="empty">Henüz beğeni yok.</td></tr>')+'</tbody></table></div><div class="card"><h3>Overlay</h3><div class="overlayHint">'+esc(overlayLink("begeni"))+'</div></div>';
}
function winView(){
  return '<div class="card"><h2>🏆 WIN Sayacı</h2><div class="stat" style="font-size:64px">'+String(S.wins).padStart(2,"0")+' / '+S.maxWins+'</div><p class="muted">Ceza: -'+S.penalty+'</p><div class="row"><button id="winPlus">+ WIN</button><button id="winMinus" class="danger">- WIN</button><button id="winReset" class="gold">SIFIRLA</button></div></div><div class="card"><h3>Overlay</h3><div class="overlayHint">'+esc(overlayLink("win"))+'</div></div>';
}
function testView(){
  return '<div class="card"><h2>🧪 Test Merkezi</h2><p class="muted">Gerçek TikTok olayı gelmiş gibi test eder.</p><div class="row"><input id="testUser" placeholder="kullanici" value="test_kullanici"><input id="testScore" type="number" min="1" max="10" value="10"><button id="testVote">TEST PUANI</button></div><br><div class="row"><input id="testGift" placeholder="Hediye adı" value="Test Hediyesi"><button id="testGiftBtn">TEST HEDİYE</button></div><br><div class="row"><input id="testLike" type="number" min="1" value="100"><button id="testLikeBtn">TEST BEĞENİ</button></div></div><div class="card"><h3>Sonraki adım</h3><p>Önce Test Merkezi'ni çalıştırıp panel ve overlayların düzgün olduğunu doğrulayacağız. Sonra gerçek TikTok akışını kullanacağız.</p></div>';
}
function guideView(){
  return '<div class="card"><h2>📖 Kullanım Rehberi</h2><ol><li>Yayın Bağlantısı’ndan TikTok kullanıcı adını yaz ve Bağlan’a bas.</li><li>Puanlama bölümünde süreyi seçip başlat.</li><li>Racon/Mekan bölümünde hediyeyi dropdown’dan seç.</li><li>Beğeni Sıralaması gelen beğenileri otomatik toplar.</li><li>WIN sayacını gerektiğinde artır/azalt.</li><li>OBS veya TikTok Live Studio’da ilgili Overlay URL’sini Browser Source olarak kullan.</li></ol><p class="muted">Bu sistem Room kullanmaz; tek yayın bağlantısı vardır.</p></div>';
}
function wirePage(){
  const c=(id,fn)=>$(id)&&$(id).addEventListener("click",fn);
  c("connectBtn",()=>post("/api/connect",{username:$("ttUser").value}).catch(e=>alert(e.message)));
  c("disconnectBtn",()=>post("/api/disconnect",{}).catch(e=>alert(e.message)));
  c("saveDuration",()=>post("/api/score/settings",{duration:$("duration").value}).catch(e=>alert(e.message)));
  c("startScore",()=>post("/api/score/start",{}).catch(e=>alert(e.message)));
  c("stopScore",()=>post("/api/score/stop",{}).catch(e=>alert(e.message)));
  c("resetLikes",()=>post("/api/likes/reset",{}).catch(e=>alert(e.message)));
  c("winPlus",()=>post("/api/win",{change:1}).catch(e=>alert(e.message)));
  c("winMinus",()=>post("/api/win",{change:-1}).catch(e=>alert(e.message)));
  c("winReset",()=>post("/api/win",{change:0}).catch(e=>alert(e.message)));
  c("testVote",()=>post("/api/test/vote",{username:$("testUser").value,score:$("testScore").value}).catch(e=>alert(e.message)));
  c("testGiftBtn",()=>post("/api/test/gift",{username:$("testUser").value,gift:$("testGift").value}).catch(e=>alert(e.message)));
  c("testLikeBtn",()=>post("/api/test/like",{username:$("testUser").value,count:$("testLike").value}).catch(e=>alert(e.message)));
  c("saveGift",()=>{
    const type=(page==="racon"?"racon":"mekan");
    post("/api/gift-rule",{type,gift:$("giftSelect").value}).catch(e=>alert(e.message));
  });
  c("clearGift",()=>{
    const type=(page==="racon"?"racon":"mekan");
    post("/api/gift-rule/clear",{type}).catch(e=>alert(e.message));
  });
}
socket.on("state", setState);
getState().catch(()=>{ $("content").innerHTML='<div class="card"><h2>Bağlantı kurulamadı</h2><p class="muted">Sayfayı yenile.</p></div>'; });
setInterval(()=>{ if(S && S.scoring && page==="score") render(); },1000);
</script>
</body>
</html>`;

const OVERLAY_HTML = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MS YAYIN Overlay</title>
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;font-family:Arial,sans-serif;color:#fff}
.wrap{width:100%;height:100%;display:flex;align-items:center;justify-content:center}
.box{min-width:380px;max-width:85vw;padding:24px 30px;border-radius:20px;background:rgba(7,8,12,.88);border:1px solid rgba(255,255,255,.12);box-shadow:0 12px 50px rgba(0,0,0,.38);text-align:center}
.title{font-weight:900;font-size:28px;margin-bottom:12px}.big{font-size:58px;font-weight:950}.muted{opacity:.7}.list{text-align:left;margin-top:10px}.row{padding:6px 0;border-bottom:1px solid rgba(255,255,255,.12);display:flex;justify-content:space-between}.flash{animation:pop .45s ease-out}@keyframes pop{0%{transform:scale(.75);opacity:.1}70%{transform:scale(1.05);opacity:1}100%{transform:scale(1);opacity:1}}
</style></head>
<body>
<div class="wrap"><div id="box" class="box"><div class="title">🔥 MS YAYIN</div><div class="muted">Bekleniyor...</div></div></div>
<script src="/socket.io/socket.io.js"></script>
<script>
const TYPE="__OVERLAY_TYPE__";
const socket=io();
let previousEvent=0;
function esc(v){return String(v??"").replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[ch]));}
function show(s){
  const b=document.getElementById("box");
  let html="";
  if(TYPE==="puanlama"){
    html=s.scoring
      ? '<div class="title">⭐ PUANLAMA</div><div class="big">'+esc(s.average)+'</div><div>'+esc(s.participants)+' katılımcı · '+Math.max(0,Math.ceil((s.scoreEndsAt-Date.now())/1000))+' sn</div>'
      : '<div class="title">⭐ PUANLAMA</div><div class="muted">Başlamayı bekliyor</div>';
  }else if(TYPE==="racon"){
    html='<div class="title">👑 RACON KRALI</div><div class="big">'+(s.lastRacon?'@'+esc(s.lastRacon.username):'')+'</div>'+(s.lastRacon?'<div>'+esc(s.lastRacon.gift)+'</div>':'<div class="muted">Hediye bekleniyor</div>');
  }else if(TYPE==="mekan"){
    html='<div class="title">🏠 MEKAN SAHİBİ</div><div class="big">'+(s.lastMekan?'@'+esc(s.lastMekan.username):'')+'</div>'+(s.lastMekan?'<div>'+esc(s.lastMekan.gift)+'</div>':'<div class="muted">Hediye bekleniyor</div>');
  }else if(TYPE==="begeni"){
    html='<div class="title">❤️ BEĞENİ SIRALAMASI</div><div class="list">'+s.likes.slice(0,10).map((x,i)=>'<div class="row"><span>'+((i<3)?['🥇','🥈','🥉'][i]:(i+1)+'.')+' @'+esc(x.username)+'</span><b>'+Number(x.likeCount).toLocaleString("tr-TR")+' ❤️</b></div>').join('')+'</div>';
  }else if(TYPE==="win"){
    html='<div class="title">🏆 WIN</div><div class="big">'+String(s.wins).padStart(2,"0")+'/'+esc(s.maxWins)+'</div><div class="muted">-'+esc(s.penalty)+' CEZA</div>';
  }else{
    html='<div class="title">🔥 MS YAYIN</div><div class="big">⭐ '+esc(s.average)+'</div><div>'+esc(s.participants)+' katılımcı</div><div style="margin-top:10px">🏆 '+String(s.wins).padStart(2,"0")+'/'+esc(s.maxWins)+'</div>';
  }
  b.innerHTML=html||'<div class="muted">Bekleniyor...</div>';
  if(s.lastEventAt && s.lastEventAt!==previousEvent){b.classList.remove("flash");void b.offsetWidth;b.classList.add("flash");previousEvent=s.lastEventAt;}
}
socket.on("state",show);
fetch("/api/state").then(r=>r.json()).then(show);
setInterval(()=>fetch("/api/state").then(r=>r.json()).then(show).catch(()=>{}),1000);
</script>
</body></html>`;

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log("MS YAYIN çalışıyor. Port:", PORT);
});
