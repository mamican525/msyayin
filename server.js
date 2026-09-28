
"use strict";

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

// Support both common export shapes used by tiktok-live-connector versions.
const TikTokModule = require("tiktok-live-connector");
const WebcastPushConnection =
  TikTokModule?.WebcastPushConnection ||
  TikTokModule?.default?.WebcastPushConnection ||
  TikTokModule?.default ||
  TikTokModule;

if (typeof WebcastPushConnection !== "function") {
  throw new Error("TikTok bağlantı sınıfı bulunamadı. tiktok-live-connector paketi beklenen API'yi sunmuyor.");
}

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer, {
  cors: { origin: true, methods: ["GET", "POST"] }
});

const PORT = Number(process.env.PORT || 10000);

app.use(express.json({ limit: "100kb" }));

const state = {
  username: "",
  connected: false,
  connecting: false,
  connectionMessage: "Bağlı değil",
  scoreDuration: 15,
  scoring: false,
  scoreEndsAt: 0,
  votes: [],
  likes: new Map(),
  raconGift: "",
  mekanGift: "",
  racon: new Map(),
  mekan: new Map(),
  lastRacon: null,
  lastMekan: null,
  wins: 0,
  maxWins: 20,
  penalty: 20,
  lastEventAt: 0
};

let tiktokConnection = null;
let scoreTimer = null;

function cleanUsername(value) {
  return String(value || "").replace(/^@+/, "").trim().slice(0, 80);
}

function cleanGift(value) {
  return String(value || "").trim().slice(0, 100);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[c]));
}

function userFrom(data) {
  return cleanUsername(
    data?.uniqueId ||
    data?.unique_id ||
    data?.user?.uniqueId ||
    data?.nickname
  ) || "bilinmeyen";
}

function avatarFrom(data) {
  return (
    data?.profilePictureUrl ||
    data?.profilePicture ||
    data?.user?.profilePictureUrl ||
    ""
  );
}

function emitState() {
  io.emit("state", snapshot());
}

function snapshot() {
  const votes = state.votes.slice(-150).reverse();
  const voteCount = state.votes.length;
  const average = voteCount
    ? Number((state.votes.reduce((sum, v) => sum + v.score, 0) / voteCount).toFixed(2))
    : 0;

  const likes = [...state.likes.entries()]
    .map(([username, item]) => ({
      username,
      likeCount: item.likeCount,
      avatar: item.avatar || ""
    }))
    .sort((a, b) => b.likeCount - a.likeCount);

  return {
    username: state.username,
    connected: state.connected,
    connecting: state.connecting,
    connectionMessage: state.connectionMessage,
    scoreDuration: state.scoreDuration,
    scoring: state.scoring,
    scoreEndsAt: state.scoreEndsAt,
    votes,
    average,
    participants: new Set(state.votes.map((v) => v.username)).size,
    likes,
    raconGift: state.raconGift,
    mekanGift: state.mekanGift,
    racon: [...state.racon.values()].sort((a, b) => b.count - a.count),
    mekan: [...state.mekan.values()].sort((a, b) => b.count - a.count),
    lastRacon: state.lastRacon,
    lastMekan: state.lastMekan,
    wins: state.wins,
    maxWins: state.maxWins,
    penalty: state.penalty,
    lastEventAt: state.lastEventAt
  };
}

function broadcast() {
  emitState();
}

function stopScore() {
  state.scoring = false;
  state.scoreEndsAt = 0;
  if (scoreTimer) clearTimeout(scoreTimer);
  scoreTimer = null;
  broadcast();
}

function startScore() {
  stopScore();
  state.votes = [];
  state.scoring = true;
  state.scoreEndsAt = Date.now() + state.scoreDuration * 1000;
  scoreTimer = setTimeout(stopScore, state.scoreDuration * 1000 + 75);
  broadcast();
}

function recordVote(username, score, avatar = "") {
  if (!state.scoring) return;
  const n = Number(score);
  if (!Number.isInteger(n) || n < 1 || n > 10) return;

  state.votes.push({
    username: cleanUsername(username) || "bilinmeyen",
    score: n,
    avatar,
    at: Date.now()
  });
  state.votes = state.votes.slice(-500);
  state.lastEventAt = Date.now();
  broadcast();
}

function recordLike(username, count, avatar = "") {
  const user = cleanUsername(username) || "bilinmeyen";
  const delta = Math.max(1, Number(count) || 1);

  const old = state.likes.get(user) || {
    likeCount: 0,
    avatar: ""
  };

  state.likes.set(user, {
    likeCount: old.likeCount + delta,
    avatar: avatar || old.avatar || ""
  });

  state.lastEventAt = Date.now();
  broadcast();
}

function recordGift(username, giftName, avatar = "") {
  const user = cleanUsername(username) || "bilinmeyen";
  const gift = cleanGift(giftName) || "Hediye";

  const raconGift = state.raconGift.trim().toLowerCase();
  const mekanGift = state.mekanGift.trim().toLowerCase();
  const key = gift.toLowerCase();

  if (raconGift && raconGift === key) {
    const old = state.racon.get(user) || {
      username: user,
      count: 0,
      gift,
      avatar: ""
    };
    const next = {
      username: user,
      count: old.count + 1,
      gift,
      avatar: avatar || old.avatar || ""
    };
    state.racon.set(user, next);
    state.lastRacon = {
      username: user,
      gift,
      avatar: next.avatar,
      at: Date.now()
    };
  }

  if (mekanGift && mekanGift === key) {
    const old = state.mekan.get(user) || {
      username: user,
      count: 0,
      gift,
      avatar: ""
    };
    const next = {
      username: user,
      count: old.count + 1,
      gift,
      avatar: avatar || old.avatar || ""
    };
    state.mekan.set(user, next);
    state.lastMekan = {
      username: user,
      gift,
      avatar: next.avatar,
      at: Date.now()
    };
  }

  state.lastEventAt = Date.now();
  broadcast();
}

async function disconnectTikTok(message = "Bağlantı kesildi.") {
  if (tiktokConnection) {
    try {
      if (typeof tiktokConnection.disconnect === "function") {
        await tiktokConnection.disconnect();
      }
    } catch (_) {}
  }
  tiktokConnection = null;
  state.connected = false;
  state.connecting = false;
  state.connectionMessage = message;
  broadcast();
}

async function connectTikTok(username) {
  const user = cleanUsername(username);
  if (!user) {
    throw new Error("TikTok kullanıcı adı gerekli.");
  }

  await disconnectTikTok("Yeni bağlantı hazırlanıyor...");

  state.username = user;
  state.connecting = true;
  state.connected = false;
  state.connectionMessage = "TikTok canlı yayınına bağlanılıyor...";
  broadcast();

  let connection;
  try {
    connection = new WebcastPushConnection(user, {
      processInitialData: false
    });
  } catch (err) {
    state.connecting = false;
    state.connected = false;
    state.connectionMessage = "Bağlantı nesnesi oluşturulamadı.";
    broadcast();
    throw err;
  }

  tiktokConnection = connection;

  connection.on("connected", () => {
    state.connecting = false;
    state.connected = true;
    state.connectionMessage = "TikTok canlı yayınına bağlandı.";
    state.lastEventAt = Date.now();
    broadcast();
  });

  connection.on("disconnected", () => {
    state.connecting = false;
    state.connected = false;
    state.connectionMessage = "TikTok bağlantısı kesildi.";
    broadcast();
  });

  connection.on("streamEnd", () => {
    state.connecting = false;
    state.connected = false;
    state.connectionMessage = "Canlı yayın sona erdi.";
    broadcast();
  });

  connection.on("error", (err) => {
    state.connecting = false;
    state.connected = false;
    state.connectionMessage = err?.message
      ? `TikTok bağlantı hatası: ${err.message}`
      : "TikTok bağlantı hatası.";
    broadcast();
  });

  connection.on("chat", (data) => {
    const comment = String(data?.comment || "").trim();
    if (/^(10|[1-9])$/.test(comment)) {
      recordVote(userFrom(data), Number(comment), avatarFrom(data));
    }
  });

  connection.on("like", (data) => {
    // TikTok connector emits like events in batches; likeCount is the delta for this event.
    const count =
      Number(data?.likeCount) ||
      Number(data?.likeCountTotal) ||
      Number(data?.totalLikeCount) ||
      1;

    recordLike(userFrom(data), count, avatarFrom(data));
  });

  connection.on("gift", (data) => {
    recordGift(
      userFrom(data),
      data?.giftName || data?.gift || data?.repeatCount && data?.giftName || "Hediye",
      avatarFrom(data)
    );
  });

  await connection.connect();
  state.connectionMessage = "Bağlantı isteği gönderildi; canlı yayının durumu bekleniyor.";
  broadcast();
  return snapshot();
}

const CSS = `
:root{
  --bg:#07080c;--side:#10131a;--card:#141923;--line:#282e3a;
  --text:#f5f7fa;--muted:#9aa2b1;--red:#ef4444;--green:#29b76e;
  --gold:#c99827;--blue:#3b82f6;
}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--text);font-family:Segoe UI,Arial,sans-serif}
a{color:inherit}
button,input{font:inherit}
button{border:0;border-radius:10px;padding:11px 15px;font-weight:800;cursor:pointer;background:var(--red);color:#fff}
button.secondary{background:#252b36}button.green{background:var(--green)}button.gold{background:var(--gold)}button.danger{background:#a72935}
.layout{display:grid;grid-template-columns:255px 1fr;min-height:100vh}
.side{background:var(--side);border-right:1px solid var(--line);padding:22px 16px}
.brand{font-size:23px;font-weight:950;margin:0 6px 24px}.brand span{color:var(--red)}
.nav{display:flex;flex-direction:column;gap:5px}
.nav a{padding:12px;border-radius:10px;text-decoration:none;color:#d8dce4;font-weight:750}
.nav a:hover,.nav a.active{background:#202631;color:#fff}
.main{width:100%;max-width:1500px;padding:28px}
.header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:20px}
h1{margin:0 0 6px;font-size:31px}.muted{color:var(--muted)}
.status{padding:8px 12px;border-radius:999px;border:1px solid var(--line);font-weight:900}.ok{color:#63dda0}.off{color:#ff7d7d}.wait{color:#ffd479}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.stat{font-size:36px;font-weight:950;margin-top:7px}
input{background:#0d1117;color:#fff;border:1px solid #323947;border-radius:10px;padding:11px 12px;min-width:190px}
table{width:100%;border-collapse:collapse}th,td{padding:11px 8px;text-align:left;border-bottom:1px solid var(--line)}
.empty{text-align:center;color:var(--muted);padding:24px}.code{font-family:Consolas,monospace;background:#0b0e13;border:1px solid var(--line);padding:11px;border-radius:10px;word-break:break-all}
@media(max-width:900px){.layout{grid-template-columns:205px 1fr}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:650px){.layout{display:block}.side{min-height:auto}.main{padding:16px}.grid,.grid2{grid-template-columns:1fr}.header{display:block}}
`;

const NAV = [
  ["/connection","🔴","Yayın Bağlantısı"],
  ["/puanlama","⭐","Puanlama"],
  ["/racon","👑","Racon Kralları"],
  ["/mekan","🏠","Mekan Sahibi"],
  ["/begeni","❤️","Beğeni Sıralaması"],
  ["/win","🏆","WIN Sayacı"],
  ["/test","🧪","Test Merkezi"],
  ["/rehber","📖","Kullanım Rehberi"]
];

function shell(title, active, body, script = "") {
  const nav = NAV.map(([href, icon, name]) =>
    `<a href="${href}" class="${active === href ? "active" : ""}">${icon} ${name}</a>`
  ).join("");

  const statusClass = state.connected ? "ok" : (state.connecting ? "wait" : "off");
  const statusText = state.connected ? "🟢 Bağlı" : (state.connecting ? "🟡 Bağlanıyor" : "🔴 Bağlı değil");

  return `<!doctype html>
<html lang="tr">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MS YAYIN - ${escapeHtml(title)}</title><style>${CSS}</style></head>
<body>
<div class="layout">
<aside class="side"><div class="brand">🔥 MS <span>YAYIN</span></div><nav class="nav">${nav}</nav></aside>
<main class="main">
<div class="header"><div><h1>${escapeHtml(title)}</h1><div class="muted">Tek yayıncı · Room yok · direkt TikTok kullanıcı adı</div></div><div id="status" class="status ${statusClass}">${statusText}</div></div>
${body}
</main></div>
<script>
async function api(url,opts={}){const r=await fetch(url,{headers:{"Content-Type":"application/json"},...opts});const d=await r.json();if(!r.ok)throw new Error(d.message||"İşlem başarısız");return d}
async function refreshTop(){try{const s=await api("/api/state");const e=document.getElementById("status");if(e){e.textContent=s.connected?"🟢 Bağlı":(s.connecting?"🟡 Bağlanıyor":"🔴 Bağlı değil");e.className="status "+(s.connected?"ok":(s.connecting?"wait":"off"));}}catch{}}
refreshTop();setInterval(refreshTop,1000);
${script}
</script></body></html>`;
}

function connectionPage() {
  return shell("Yayın Bağlantısı","/connection",`
<div class="card">
<h2>🔴 TikTok Canlı Yayın Bağlantısı</h2>
<p class="muted">Kullanıcı adını yazıp <b>BAĞLAN</b> butonuna bas. Oda/Room kodu yok.</p>
<div class="row"><input id="username" placeholder="@kullaniciadi" value="${escapeHtml(state.username)}"><button onclick="connect()">BAĞLAN</button><button class="secondary" onclick="disconnect()">BAĞLANTIYI KES</button></div>
<div id="msg" class="card" style="margin-top:14px;margin-bottom:0">${escapeHtml(state.connectionMessage)}</div>
</div>
<div class="grid">
<div class="card"><div class="muted">Ortalama Puan</div><div id="avg" class="stat">${snapshot().average}</div></div>
<div class="card"><div class="muted">Katılımcı</div><div id="parts" class="stat">${snapshot().participants}</div></div>
<div class="card"><div class="muted">Beğeni Kullanıcısı</div><div id="likeUsers" class="stat">${snapshot().likes.length}</div></div>
<div class="card"><div class="muted">WIN</div><div id="wins" class="stat">${String(state.wins).padStart(2,"0")}/${state.maxWins}</div></div>
</div>`,
`
async function connect(){
  msg.textContent="TikTok canlı yayını aranıyor...";
  try{const d=await api("/api/connect",{method:"POST",body:JSON.stringify({username:username.value})});msg.textContent=d.message||d.connectionMessage;refreshTop();loadStats();}
  catch(e){msg.textContent=e.message;refreshTop();}
}
async function disconnect(){await api("/api/disconnect",{method:"POST",body:"{}"});msg.textContent="Bağlantı kesildi.";refreshTop();loadStats();}
async function loadStats(){try{const s=await api("/api/state");avg.textContent=s.average;parts.textContent=s.participants;likeUsers.textContent=s.likes.length;wins.textContent=String(s.wins).padStart(2,"0")+"/"+s.maxWins;msg.textContent=s.connectionMessage;}catch{}}
loadStats();setInterval(loadStats,1000);
`);
}

function scorePage() {
  return shell("Puanlama","/puanlama",`
<div class="card"><h2>⭐ Puanlama</h2><div class="row">
<label>Süre <input id="duration" type="number" min="1" max="3600" value="${state.scoreDuration}"> sn</label>
<button class="secondary" onclick="saveDuration()">SÜREYİ KAYDET</button><button class="green" onclick="startScore()">▶ BAŞLAT</button><button class="danger" onclick="stopScore()">■ BİTİR</button>
</div></div>
<div class="grid">
<div class="card"><div class="muted">Ortalama</div><div id="avg" class="stat">0</div></div>
<div class="card"><div class="muted">Katılımcı</div><div id="parts" class="stat">0</div></div>
<div class="card"><div class="muted">Kalan</div><div id="left" class="stat">—</div></div>
<div class="card"><div class="muted">Durum</div><div id="st" class="stat" style="font-size:21px">⚪ BEKLEMEDE</div></div>
</div>
<div class="card"><h3>Oy Verenler</h3><table><thead><tr><th>Kullanıcı</th><th>Puan</th></tr></thead><tbody id="rows"></tbody></table></div>
<div class="card"><h3>Overlay Linki</h3><div class="code">https://msyayin.onrender.com/overlay/puanlama</div></div>`,
`
function esc2(v){return String(v??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
async function load(){const s=await api("/api/state");duration.value=s.scoreDuration;avg.textContent=s.average;parts.textContent=s.participants;st.textContent=s.scoring?"🟢 AKTİF":"⚪ BEKLEMEDE";left.textContent=s.scoring?Math.max(0,Math.ceil((s.scoreEndsAt-Date.now())/1000))+" sn":"—";rows.innerHTML=s.votes.map(v=>"<tr><td>@"+esc2(v.username)+"</td><td><b>"+v.score+"</b></td></tr>").join("")||'<tr><td colspan="2" class="empty">Henüz puan yok.</td></tr>'}
async function saveDuration(){try{await api("/api/score/settings",{method:"POST",body:JSON.stringify({duration:duration.value})});load()}catch(e){alert(e.message)}}
async function startScore(){await api("/api/score/start",{method:"POST",body:"{}"});load()}
async function stopScore(){await api("/api/score/stop",{method:"POST",body:"{}"});load()}
load();setInterval(load,500);
`);
}

function giftPage(type) {
  const title = type === "racon" ? "Racon Kralları" : "Mekan Sahibi";
  const icon = type === "racon" ? "👑" : "🏠";
  const selected = type === "racon" ? state.raconGift : state.mekanGift;
  const arr = type === "racon" ? [...state.racon.values()] : [...state.mekan.values()];
  const rows = arr.map((x,i)=>`<tr><td>${i+1}</td><td>@${escapeHtml(x.username)}</td><td>${x.count}x</td><td>${escapeHtml(x.gift)}</td></tr>`).join("");

  return shell(title,`/${type}`,`
<div class="card"><h2>${icon} ${title}</h2>
<p class="muted">Hediye adını bir kez seç. Canlıda aynı hediye geldiğinde gönderen otomatik listeye eklenir.</p>
<div class="row"><input id="gift" list="giftList" value="${escapeHtml(selected)}" placeholder="Hediye adı">
<datalist id="giftList"><option>Aslan</option><option>Galaxy</option><option>TikTok Universe</option><option>Rose</option><option>Finger Heart</option><option>Test Hediyesi</option></datalist>
<button class="green" onclick="saveGift()">HEDİYEYİ AKTİF ET</button><button class="secondary" onclick="clearGift()">KALDIR</button></div>
<p>Aktif hediye: <b id="activeGift">${escapeHtml(selected || "Yok")}</b></p></div>
<div class="card"><table><thead><tr><th>Sıra</th><th>Kullanıcı</th><th>Adet</th><th>Hediye</th></tr></thead><tbody id="rows">${rows || '<tr><td colspan="4" class="empty">Henüz kayıt yok.</td></tr>'}</tbody></table></div>
<div class="card"><h3>Overlay Linki</h3><div class="code">https://msyayin.onrender.com/overlay/${type}</div></div>`,
`
async function load(){const s=await api("/api/state");const t=${JSON.stringify(type)};const active=t==="racon"?s.raconGift:s.mekanGift;activeGift.textContent=active||"Yok";gift.value=active||"";const a=t==="racon"?s.racon:s.mekan;rows.innerHTML=a.map((x,i)=>"<tr><td>"+(i+1)+"</td><td>@"+x.username+"</td><td>"+x.count+"x</td><td>"+x.gift+"</td></tr>").join("")||'<tr><td colspan="4" class="empty">Henüz kayıt yok.</td></tr>'}
async function saveGift(){try{await api("/api/gift-rule",{method:"POST",body:JSON.stringify({type:${JSON.stringify(type)},gift:gift.value})});load()}catch(e){alert(e.message)}}
async function clearGift(){await api("/api/gift-rule/clear",{method:"POST",body:JSON.stringify({type:${JSON.stringify(type)}})});load()}
load();setInterval(load,1000);
`);
}

function likesPage() {
  return shell("Beğeni Sıralaması","/begeni",`
<div class="card"><div class="row" style="justify-content:space-between"><div><h2>❤️ Beğeni Sıralaması</h2><div class="muted">TikTok canlıdan gelen beğeniler otomatik toplanır.</div></div><button class="danger" onclick="resetLikes()">SIFIRLA</button></div></div>
<div class="card"><table><thead><tr><th>Sıra</th><th>Kullanıcı</th><th>Beğeni</th></tr></thead><tbody id="rows"></tbody></table></div>
<div class="card"><h3>Overlay Linki</h3><div class="code">https://msyayin.onrender.com/overlay/begeni</div></div>`,
`
async function load(){const s=await api("/api/state");rows.innerHTML=s.likes.map((x,i)=>"<tr><td>"+(i<3?["🥇","🥈","🥉"][i]:(i+1))+"</td><td>@"+x.username+"</td><td>"+Number(x.likeCount).toLocaleString("tr-TR")+" ❤️</td></tr>").join("")||'<tr><td colspan="3" class="empty">Henüz beğeni yok.</td></tr>'}
async function resetLikes(){await api("/api/likes/reset",{method:"POST",body:"{}"});load()} load();setInterval(load,800);
`);
}

function winPage() {
  return shell("WIN Sayacı","/win",`
<div class="card"><h2>🏆 WIN Sayacı</h2><div id="win" class="stat" style="font-size:72px">${String(state.wins).padStart(2,"0")} / ${state.maxWins}</div><div class="muted">-${state.penalty} CEZA</div>
<div class="row" style="margin-top:18px"><button onclick="chg(1)">+ WIN</button><button class="danger" onclick="chg(-1)">- WIN</button><button class="gold" onclick="chg(0)">SIFIRLA</button></div></div>
<div class="card"><h3>Overlay Linki</h3><div class="code">https://msyayin.onrender.com/overlay/win</div></div>`,
`async function load(){const s=await api("/api/state");win.textContent=String(s.wins).padStart(2,"0")+" / "+s.maxWins}async function chg(n){await api("/api/win",{method:"POST",body:JSON.stringify({change:n})});load()}load();setInterval(load,600);`);
}

function testPage() {
  return shell("Test Merkezi","/test",`
<div class="card"><h2>🧪 Test Merkezi</h2><p class="muted">Gerçek olay gelmiş gibi test verisi gönder.</p>
<div class="grid2">
<div class="card"><h3>⭐ Puan</h3><div class="row"><input id="u1" value="test_kullanici"><input id="sc" type="number" min="1" max="10" value="10"><button onclick="voteTest()">TEST PUANI</button></div></div>
<div class="card"><h3>🎁 Hediye</h3><div class="row"><input id="u2" value="test_kullanici"><input id="gi" value="Test Hediyesi"><button onclick="giftTest()">TEST HEDİYE</button></div></div>
<div class="card"><h3>❤️ Beğeni</h3><div class="row"><input id="u3" value="test_kullanici"><input id="lc" type="number" value="100"><button onclick="likeTest()">TEST BEĞENİ</button></div></div>
</div></div>
<div class="card"><h3>Overlay Testleri</h3>
<div class="row"><a href="/overlay/puanlama" target="_blank">⭐ Puanlama</a><a href="/overlay/racon" target="_blank">👑 Racon</a><a href="/overlay/mekan" target="_blank">🏠 Mekan</a><a href="/overlay/begeni" target="_blank">❤️ Beğeni</a><a href="/overlay/win" target="_blank">🏆 WIN</a></div></div>`,
`
async function voteTest(){await api("/api/test/vote",{method:"POST",body:JSON.stringify({username:u1.value,score:sc.value})});alert("Test puanı gönderildi")}
async function giftTest(){await api("/api/test/gift",{method:"POST",body:JSON.stringify({username:u2.value,gift:gi.value})});alert("Test hediyesi gönderildi")}
async function likeTest(){await api("/api/test/like",{method:"POST",body:JSON.stringify({username:u3.value,count:lc.value})});alert("Test beğenisi gönderildi")}
`);
}

function guidePage() {
  return shell("Kullanım Rehberi","/rehber",`
<div class="card"><h2>📖 Kullanım Rehberi</h2>
<ol><li>Yayın Bağlantısı'na gir ve TikTok kullanıcı adını yaz.</li><li>BAĞLAN'a bas ve durumun 🟢 Bağlı olmasını bekle.</li><li>Puanlama süresini ayarla ve başlat.</li><li>Racon/Mekan bölümünde tetiklenecek hediye adını ayarla.</li><li>Beğeni Sıralaması canlıdaki beğenileri toplar.</li><li>Overlay adresini OBS veya TikTok Live Studio Browser Source olarak ekle.</li></ol>
</div>`);
}

function overlayPage(type) {
  const titleMap = {
    puanlama:"⭐ PUANLAMA",
    racon:"👑 RACON KRALI",
    mekan:"🏠 MEKAN SAHİBİ",
    begeni:"❤️ BEĞENİ SIRALAMASI",
    win:"🏆 WIN"
  };
  const title = titleMap[type];

  const html = `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;color:#fff;font-family:Arial,sans-serif}
.wrap{width:100%;height:100%;display:flex;align-items:center;justify-content:center}
.box{min-width:360px;max-width:90vw;padding:24px 30px;border-radius:20px;background:rgba(5,6,9,.9);border:1px solid rgba(255,255,255,.12);box-shadow:0 16px 60px rgba(0,0,0,.4);text-align:center}
.title{font-size:28px;font-weight:900;margin-bottom:12px}.big{font-size:60px;font-weight:950}.muted{opacity:.7}
.row{display:flex;justify-content:space-between;gap:25px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.12);text-align:left}
</style></head><body><div class="wrap"><div class="box" id="box"><div class="title">${title}</div><div class="muted">Veri bekleniyor...</div></div></div>
<script>
function esc(v){return String(v??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
async function load(){
 try{
   const s=await fetch("/api/state",{cache:"no-store"}).then(r=>r.json());
   let h="";
   if(${JSON.stringify(type)}==="puanlama"){
     h=s.scoring
       ? '<div class="title">${title}</div><div class="big">'+esc(s.average)+'</div><div>'+s.participants+' katılımcı · '+Math.max(0,Math.ceil((s.scoreEndsAt-Date.now())/1000))+' sn</div>'
       : '<div class="title">${title}</div><div class="muted">Başlamayı bekliyor</div>';
   } else if(${JSON.stringify(type)}==="racon"){
     h='<div class="title">${title}</div>'+(s.lastRacon?'<div class="big">@'+esc(s.lastRacon.username)+'</div><div>'+esc(s.lastRacon.gift)+'</div>':'<div class="muted">Hediye bekleniyor</div>');
   } else if(${JSON.stringify(type)}==="mekan"){
     h='<div class="title">${title}</div>'+(s.lastMekan?'<div class="big">@'+esc(s.lastMekan.username)+'</div><div>'+esc(s.lastMekan.gift)+'</div>':'<div class="muted">Hediye bekleniyor</div>');
   } else if(${JSON.stringify(type)}==="begeni"){
     h='<div class="title">${title}</div>'+s.likes.slice(0,10).map((x,i)=>'<div class="row"><span>'+((i<3)?["🥇","🥈","🥉"][i]:(i+1)+".")+' @'+esc(x.username)+'</span><b>'+Number(x.likeCount).toLocaleString("tr-TR")+' ❤️</b></div>').join("");
   } else {
     h='<div class="title">${title}</div><div class="big">'+String(s.wins).padStart(2,"0")+'/'+s.maxWins+'</div><div class="muted">-'+s.penalty+' CEZA</div>';
   }
   document.getElementById("box").innerHTML=h;
 }catch{
   document.getElementById("box").innerHTML='<div class="title">${title}</div><div class="muted">Sunucu bağlantısı bekleniyor...</div>';
 }
}
load();setInterval(load,500);
</script></body></html>`;

  return html;
}

app.get("/", (_req,res) => res.redirect("/connection"));
app.get("/connection", (_req,res) => res.type("html").send(connectionPage()));
app.get("/puanlama", (_req,res) => res.type("html").send(scorePage()));
app.get("/racon", (_req,res) => res.type("html").send(giftPage("racon")));
app.get("/mekan", (_req,res) => res.type("html").send(giftPage("mekan")));
app.get("/begeni", (_req,res) => res.type("html").send(likesPage()));
app.get("/win", (_req,res) => res.type("html").send(winPage()));
app.get("/test", (_req,res) => res.type("html").send(testPage()));
app.get("/rehber", (_req,res) => res.type("html").send(guidePage()));
app.get("/overlay/:type", (req,res) => {
  if (!["puanlama","racon","mekan","begeni","win"].includes(req.params.type)) {
    return res.status(404).send("Overlay bulunamadı");
  }
  res.type("html").send(overlayPage(req.params.type));
});

app.get("/api/state", (_req,res) => res.json(snapshot()));
app.get("/api/health", (_req,res) => res.json({ ok:true, connected:state.connected, connecting:state.connecting }));

app.post("/api/connect", async (req,res) => {
  try {
    const s = await connectTikTok(req.body?.username);
    res.json({ ok:true, message:s.connectionMessage, state:s });
  } catch (error) {
    state.connected = false;
    state.connecting = false;
    state.connectionMessage = error?.message || "TikTok bağlantısı kurulamadı.";
    broadcast();
    res.status(400).json({ ok:false, message:state.connectionMessage });
  }
});

app.post("/api/disconnect", async (_req,res) => {
  await disconnectTikTok();
  state.username = "";
  res.json(snapshot());
});

app.post("/api/score/settings", (req,res) => {
  const duration = Number(req.body?.duration);
  if (!Number.isFinite(duration) || duration < 1 || duration > 3600) {
    return res.status(400).json({ ok:false, message:"Süre 1 ile 3600 saniye arasında olmalı." });
  }
  state.scoreDuration = Math.floor(duration);
  broadcast();
  res.json(snapshot());
});

app.post("/api/score/start", (_req,res) => {
  startScore();
  res.json(snapshot());
});

app.post("/api/score/stop", (_req,res) => {
  stopScore();
  res.json(snapshot());
});

app.post("/api/gift-rule", (req,res) => {
  const type = String(req.body?.type || "");
  const gift = cleanGift(req.body?.gift);
  if (!["racon","mekan"].includes(type) || !gift) {
    return res.status(400).json({ ok:false, message:"Hediye adı gerekli." });
  }
  if (type === "racon") state.raconGift = gift;
  else state.mekanGift = gift;
  broadcast();
  res.json(snapshot());
});

app.post("/api/gift-rule/clear", (req,res) => {
  const type = String(req.body?.type || "");
  if (type === "racon") state.raconGift = "";
  else if (type === "mekan") state.mekanGift = "";
  else return res.status(400).json({ ok:false, message:"Geçersiz sistem." });
  broadcast();
  res.json(snapshot());
});

app.post("/api/likes/reset", (_req,res) => {
  state.likes.clear();
  broadcast();
  res.json(snapshot());
});

app.post("/api/win", (req,res) => {
  const change = Number(req.body?.change);
  if (change === 0) state.wins = 0;
  else if (change === 1) state.wins = Math.min(state.maxWins, state.wins + 1);
  else if (change === -1) state.wins = Math.max(0, state.wins - 1);
  else return res.status(400).json({ ok:false, message:"Geçersiz WIN." });
  broadcast();
  res.json(snapshot());
});

app.post("/api/test/vote", (req,res) => {
  if (!state.scoring) startScore();
  recordVote(req.body?.username, req.body?.score);
  res.json(snapshot());
});

app.post("/api/test/like", (req,res) => {
  recordLike(req.body?.username, req.body?.count);
  res.json(snapshot());
});

app.post("/api/test/gift", (req,res) => {
  recordGift(req.body?.username, req.body?.gift);
  res.json(snapshot());
});

io.on("connection", (socket) => {
  socket.emit("state", snapshot());
});

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log("MS YAYIN çalışıyor. Port:", PORT);
});
