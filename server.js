
"use strict";

const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");
const TikTokModule = require("tiktok-live-connector");

const WebcastPushConnection =
  TikTokModule?.WebcastPushConnection ||
  TikTokModule?.default?.WebcastPushConnection ||
  TikTokModule?.default;

if (typeof WebcastPushConnection !== "function") {
  throw new Error("TikTok bağlantı sınıfı bulunamadı.");
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });
const PORT = Number(process.env.PORT || 10000);

app.use(express.json({ limit: "100kb" }));

const rooms = new Map();
const cookies = new Map();

function makeCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function cleanUser(v) {
  return String(v || "").replace(/^@+/, "").trim().slice(0, 80);
}

function cleanText(v) {
  return String(v || "").trim().slice(0, 120);
}

function roomState(code) {
  if (!rooms.has(code)) {
    rooms.set(code, {
      code,
      username: "",
      connected: false,
      connecting: false,
      message: "TikTok kullanıcı adı yazıp BAĞLAN'a bas.",
      connection: null,
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
      scoreStartingAt: 0
    });
  }
  return rooms.get(code);
}

function snapshot(room) {
  const votes = room.votes.slice(-200).reverse();
  const average = room.votes.length
    ? Number((room.votes.reduce((sum, v) => sum + v.score, 0) / room.votes.length).toFixed(2))
    : 0;

  const likes = [...room.likes.entries()]
    .map(([username, v]) => ({
      username,
      likeCount: v.count,
      avatar: v.avatar || ""
    }))
    .sort((a, b) => b.likeCount - a.likeCount);

  return {
    room: room.code,
    username: room.username,
    connected: room.connected,
    connecting: room.connecting,
    message: room.message,
    scoreDuration: room.scoreDuration,
    scoring: room.scoring,
    scoreEndsAt: room.scoreEndsAt,
    average,
    participants: new Set(room.votes.map(v => v.username)).size,
    votes,
    likes,
    raconGift: room.raconGift,
    mekanGift: room.mekanGift,
    racon: [...room.racon.values()].sort((a,b) => b.count-a.count),
    mekan: [...room.mekan.values()].sort((a,b) => b.count-a.count),
    lastRacon: room.lastRacon,
    lastMekan: room.lastMekan,
    wins: room.wins,
    maxWins: room.maxWins,
    penalty: room.penalty
  };
}

function broadcast(room) {
  io.to("room:" + room.code).emit("state:update", snapshot(room));
}

function addLike(room, username, count, avatar="") {
  const user = cleanUser(username) || "bilinmeyen";
  const delta = Math.max(1, Number(count) || 1);
  const old = room.likes.get(user) || { count: 0, avatar: "" };
  room.likes.set(user, { count: old.count + delta, avatar: avatar || old.avatar || "" });
  broadcast(room);
}

function addVote(room, username, score, avatar="") {
  if (!room.scoring) return;
  const n = Number(score);
  if (!Number.isInteger(n) || n < 1 || n > 10) return;
  room.votes.push({
    username: cleanUser(username) || "bilinmeyen",
    score: n,
    avatar,
    at: Date.now()
  });
  room.votes = room.votes.slice(-500);
  broadcast(room);
}

function addGift(room, username, giftName, avatar="", repeatCount=1) {
  const user = cleanUser(username) || "bilinmeyen";
  const gift = cleanText(giftName) || "Hediye";
  const amount = Math.max(1, Number(repeatCount) || 1);
  const key = gift.toLowerCase();

  if (room.raconGift && room.raconGift.toLowerCase() === key) {
    const old = room.racon.get(user) || { username:user, count:0, gift, avatar:"" };
    const item = { username:user, count:old.count+amount, gift, avatar:avatar || old.avatar || "" };
    room.racon.set(user, item);
    room.lastRacon = { username:user, gift, count:amount, avatar:item.avatar, at:Date.now() };
  }

  if (room.mekanGift && room.mekanGift.toLowerCase() === key) {
    const old = room.mekan.get(user) || { username:user, count:0, gift, avatar:"" };
    const item = { username:user, count:old.count+amount, gift, avatar:avatar || old.avatar || "" };
    room.mekan.set(user, item);
    room.lastMekan = { username:user, gift, count:amount, avatar:item.avatar, at:Date.now() };
  }

  broadcast(room);
}

function startScoring(room) {
  if (room.scoreTimer) clearTimeout(room.scoreTimer);
  room.votes = [];
  room.scoring = true;
  room.scoreStartingAt = Date.now();
  room.scoreEndsAt = Date.now() + room.scoreDuration * 1000;
  room.scoreTimer = setTimeout(() => {
    room.scoring = false;
    room.scoreEndsAt = 0;
    broadcast(room);
  }, room.scoreDuration * 1000 + 100);
  broadcast(room);
}

function stopScoring(room) {
  room.scoring = false;
  room.scoreEndsAt = 0;
  if (room.scoreTimer) clearTimeout(room.scoreTimer);
  room.scoreTimer = null;
  broadcast(room);
}

async function disconnectTikTok(room, msg="Bağlantı kesildi.") {
  const c = room.connection;
  room.connection = null;
  if (c && typeof c.disconnect === "function") {
    try { await c.disconnect(); } catch {}
  }
  room.connected = false;
  room.connecting = false;
  room.message = msg;
  broadcast(room);
}

async function connectTikTok(room, username) {
  const user = cleanUser(username);
  if (!user) throw new Error("TikTok kullanıcı adı gerekli.");

  await disconnectTikTok(room, "Yeni bağlantı hazırlanıyor...");

  room.username = user;
  room.connecting = true;
  room.connected = false;
  room.message = "TikTok canlı yayını aranıyor...";
  broadcast(room);

  let conn;
  try {
    conn = new WebcastPushConnection(user, {
      processInitialData: false
    });
  } catch (e) {
    room.connecting = false;
    room.message = e?.message || "TikTok bağlantısı başlatılamadı.";
    broadcast(room);
    throw e;
  }

  room.connection = conn;

  conn.on("connected", () => {
    if (room.connection !== conn) return;
    room.connecting = false;
    room.connected = true;
    room.message = `@${user} yayınına bağlı`;
    broadcast(room);
  });

  conn.on("disconnected", () => {
    if (room.connection !== conn) return;
    room.connecting = false;
    room.connected = false;
    room.message = "TikTok bağlantısı kesildi.";
    broadcast(room);
  });

  conn.on("streamEnd", () => {
    if (room.connection !== conn) return;
    room.connecting = false;
    room.connected = false;
    room.message = "Canlı yayın sona erdi.";
    broadcast(room);
  });

  conn.on("error", (err) => {
    if (room.connection !== conn) return;
    room.connecting = false;
    room.connected = false;
    room.message = err?.message || "TikTok bağlantı hatası.";
    broadcast(room);
  });

  conn.on("chat", (data) => {
    const text = String(data?.comment || "").trim();
    if (/^(10|[1-9])$/.test(text)) {
      addVote(
        room,
        data?.uniqueId || data?.nickname,
        Number(text),
        data?.profilePictureUrl || ""
      );
    }
  });

  conn.on("like", (data) => {
    addLike(
      room,
      data?.uniqueId || data?.nickname,
      Number(data?.likeCount) || Number(data?.totalLikeCount) || 1,
      data?.profilePictureUrl || ""
    );
  });

  conn.on("gift", (data) => {
    addGift(
      room,
      data?.uniqueId || data?.nickname,
      data?.giftName || data?.gift || "Hediye",
      data?.profilePictureUrl || "",
      data?.repeatCount || 1
    );
  });

  try {
    await conn.connect();
  } catch (e) {
    room.connecting = false;
    room.connected = false;
    room.message = e?.message || "TikTok bağlantısı kurulamadı.";
    broadcast(room);
    throw e;
  }

  return snapshot(room);
}

const STYLE = `
:root{--bg:#07080c;--side:#10131a;--card:#141923;--line:#2a303c;--text:#f5f7fa;--muted:#98a1b0;--red:#ef4444;--green:#2fbd73;--gold:#c79a28}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:Segoe UI,Arial,sans-serif;background:var(--bg);color:var(--text)}
body{overflow-x:hidden}a{color:inherit}button,input,select{font:inherit}
button{border:0;border-radius:10px;padding:11px 15px;font-weight:900;cursor:pointer;background:var(--red);color:#fff}
button.secondary{background:#252b36}button.green{background:var(--green)}button.gold{background:var(--gold)}button.danger{background:#a92a36}
.layout{display:grid;grid-template-columns:250px 1fr;min-height:100vh}.side{background:var(--side);border-right:1px solid var(--line);padding:22px 15px}
.brand{font-size:23px;font-weight:950;margin:0 7px 24px}.brand span{color:var(--red)}.nav{display:flex;flex-direction:column;gap:5px}.nav a{padding:12px;border-radius:10px;text-decoration:none;font-weight:800;color:#d8dce4}.nav a.active,.nav a:hover{background:#202631;color:#fff}
.main{max-width:1500px;width:100%;padding:28px}.header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:20px}h1{margin:0 0 5px;font-size:31px}.muted{color:var(--muted)}
.status{padding:8px 12px;border:1px solid var(--line);border-radius:999px;font-weight:900}.ok{color:#62dda0}.wait{color:#ffd479}.off{color:#ff7777}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:16px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.row{display:flex;align-items:center;flex-wrap:wrap;gap:10px}.stat{font-size:36px;font-weight:950;margin-top:7px}input,select{background:#0d1117;border:1px solid #333a47;color:#fff;border-radius:10px;padding:11px 12px;min-width:190px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:11px 8px;border-bottom:1px solid var(--line)}.empty{text-align:center;color:var(--muted);padding:24px}.code{background:#0b0e13;border:1px solid var(--line);border-radius:10px;padding:11px;word-break:break-all;font-family:Consolas,monospace}
.note{padding:12px;border-radius:10px;background:#0e1117;color:#bfc5cf}.success{border:1px solid rgba(47,189,115,.35)}.dangerBox{border:1px solid rgba(239,68,68,.35)}
@media(max-width:900px){.layout{grid-template-columns:205px 1fr}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:650px){.layout{display:block}.main{padding:16px}.grid,.grid2{grid-template-columns:1fr}.header{display:block}}
`;

const NAV = [
  ["/connection","📡","TikTok Bağlantısı"],
  ["/puanlama","⭐","Puanlama"],
  ["/racon","👑","Racon Kralları"],
  ["/mekan","🏠","Mekan Sahibi"],
  ["/begeni","❤️","Beğeni Sıralaması"],
  ["/win","🏆","WIN Sayacı"],
  ["/test","🧪","Test Merkezi"],
  ["/rehber","📖","Kullanım Rehberi"]
];

function shell(room, title, active, body, js="") {
  const s=snapshot(room);
  const nav=NAV.map(x=>`<a href="${x[0]}?room=${encodeURIComponent(room.code)}" class="${x[0]===active?"active":""}">${x[1]} ${x[2]}</a>`).join("");
  const cls=s.connected?"ok":s.connecting?"wait":"off";
  const status=s.connected?`🟢 @${room.username} bağlı`:s.connecting?"🟡 Bağlanıyor...":"🔴 Bağlı değil";

  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>MS YAYIN - ${title}</title><style>${STYLE}</style></head><body>
<div class="layout"><aside class="side"><div class="brand">🔥 MS <span>YAYIN</span></div><nav class="nav">${nav}</nav></aside>
<main class="main"><div class="header"><div><h1>${title}</h1><div class="muted">Kendi MS YAYIN sistemin · otomatik oda · tek kullanıcı</div></div><div id="status" class="status ${cls}">${status}</div></div>${body}</main></div>
<script>
const ROOM=${JSON.stringify(room.code)};
async function api(url,opt={}){const r=await fetch(url,{headers:{"Content-Type":"application/json"},...opt});const d=await r.json();if(!r.ok)throw Error(d.message||"İşlem başarısız");return d}
async function top(){try{const s=await api("/api/state?room="+encodeURIComponent(ROOM));const e=document.getElementById("status");if(e){e.textContent=s.connected?"🟢 @"+s.username+" bağlı":s.connecting?"🟡 Bağlanıyor...":"🔴 Bağlı değil";e.className="status "+(s.connected?"ok":s.connecting?"wait":"off")}}catch{}}
top();setInterval(top,1200);${js}
</script></body></html>`;
}

function connectionPage(room) {
  const s=snapshot(room);
  return shell(room,"TikTok Bağlantısı","/connection",`
<div class="card"><h2>📡 TikTok Bağlantısı</h2>
<p class="muted">Kullanıcı adını yazıp BAĞLAN'a bas. Oda sistemi arkada otomatik oluştu; room kodu girmiyorsun.</p>
<div class="row"><input id="username" placeholder="@kullaniciadi" value="${escapeHtml(s.username)}"><button id="connect">BAĞLAN</button><button class="secondary" id="disconnect">KOPAR</button></div>
<div id="message" class="note ${s.connected?"success":""}" style="margin-top:14px">${escapeHtml(s.message)}</div></div>
<div class="card"><h3>Bu yayın odasının overlay adresleri</h3>
<p class="muted">Aynı odadaki tüm overlaylar aynı TikTok verisini kullanır.</p>
<div class="row">
<div class="code">Puanlama: ${overlayUrl(room,"puanlama")}</div>
<div class="code">Beğeni: ${overlayUrl(room,"begeni")}</div>
<div class="code">Racon: ${overlayUrl(room,"racon")}</div>
<div class="code">Mekan: ${overlayUrl(room,"mekan")}</div>
<div class="code">WIN: ${overlayUrl(room,"win")}</div>
</div></div>`,
`connect.onclick=async()=>{message.textContent="Bağlanıyor...";try{const s=await api("/api/connect",{method:"POST",body:JSON.stringify({room:ROOM,username:username.value})});message.textContent=s.message;top()}catch(e){message.textContent=e.message}}
disconnect.onclick=async()=>{const s=await api("/api/disconnect",{method:"POST",body:JSON.stringify({room:ROOM})});message.textContent=s.message;top()}`);
}

function scorePage(room) {
  return shell(room,"Puanlama","/puanlama",`
<div class="card"><h2>⭐ Puanlama</h2><div class="row"><label>Süre <input id="duration" type="number" min="1" max="3600" value="${room.scoreDuration}"> sn</label><button class="secondary" id="save">SÜREYİ KAYDET</button><button class="green" id="start">▶ BAŞLAT</button><button class="danger" id="stop">■ BİTİR</button></div></div>
<div class="grid"><div class="card"><div class="muted">Ortalama</div><div id="avg" class="stat">0</div></div><div class="card"><div class="muted">Katılımcı</div><div id="parts" class="stat">0</div></div><div class="card"><div class="muted">Kalan</div><div id="left" class="stat">—</div></div><div class="card"><div class="muted">Durum</div><div id="ss" class="stat" style="font-size:21px">⚪</div></div></div>
<div class="card"><h3>Oy Verenler</h3><table><thead><tr><th>Kullanıcı</th><th>Puan</th></tr></thead><tbody id="rows"></tbody></table></div>
<div class="card"><h3>Overlay</h3><div class="code">${overlayUrl(room,"puanlama")}</div></div>`,
`function esc2(v){return String(v??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
async function load(){const s=await api("/api/state?room="+ROOM);avg.textContent=s.average;parts.textContent=s.participants;duration.value=s.scoreDuration;ss.textContent=s.scoring?"🟢 AKTİF":"⚪ BEKLEMEDE";left.textContent=s.scoring?Math.max(0,Math.ceil((s.scoreEndsAt-Date.now())/1000))+" sn":"—";rows.innerHTML=s.votes.map(v=>"<tr><td>@"+esc2(v.username)+"</td><td>"+v.score+"</td></tr>").join("")||'<tr><td colspan="2" class="empty">Henüz puan yok.</td></tr>'}
save.onclick=async()=>{await api("/api/score/settings",{method:"POST",body:JSON.stringify({room:ROOM,duration:duration.value})});load()}
start.onclick=async()=>{await api("/api/score/start",{method:"POST",body:JSON.stringify({room:ROOM})});load()}
stop.onclick=async()=>{await api("/api/score/stop",{method:"POST",body:JSON.stringify({room:ROOM})});load()}
load();setInterval(load,500);`);
}

function giftPage(room,type) {
  const title=type==="racon"?"Racon Kralları":"Mekan Sahibi";
  const icon=type==="racon"?"👑":"🏠";
  const s=snapshot(room);
  const active=type==="racon"?s.raconGift:s.mekanGift;
  const list=type==="racon"?s.racon:s.mekan;
  return shell(room,title,"/"+type,`
<div class="card"><h2>${icon} ${title}</h2><p class="muted">Buraya hediye adını bir kez yaz. O hediye gelince gönderen otomatik listeye eklenir.</p>
<div class="row"><input id="gift" placeholder="Örn: Aslan" value="${escapeHtml(active)}"><button class="green" id="saveGift">AKTİF ET</button><button class="secondary" id="clearGift">KALDIR</button></div>
<div id="active" class="note" style="margin-top:12px">Aktif hediye: <b>${escapeHtml(active||"Yok")}</b></div></div>
<div class="card"><table><thead><tr><th>Sıra</th><th>Kullanıcı</th><th>Adet</th><th>Hediye</th></tr></thead><tbody id="rows">${list.map((x,i)=>`<tr><td>${i+1}</td><td>@${escapeHtml(x.username)}</td><td>${x.count}</td><td>${escapeHtml(x.gift)}</td></tr>`).join("")||'<tr><td colspan="4" class="empty">Henüz kayıt yok.</td></tr>'}</tbody></table></div>
<div class="card"><h3>Overlay</h3><div class="code">${overlayUrl(room,type)}</div></div>`,
`const T=${JSON.stringify(type)};async function load(){const s=await api("/api/state?room="+ROOM);const g=T==="racon"?s.raconGift:s.mekanGift;gift.value=g||"";active.innerHTML="Aktif hediye: <b>"+(g||"Yok")+"</b>";const a=T==="racon"?s.racon:s.mekan;rows.innerHTML=a.map((x,i)=>"<tr><td>"+(i+1)+"</td><td>@"+x.username+"</td><td>"+x.count+"</td><td>"+x.gift+"</td></tr>").join("")||'<tr><td colspan="4" class="empty">Henüz kayıt yok.</td></tr>'}
saveGift.onclick=async()=>{await api("/api/gift-rule",{method:"POST",body:JSON.stringify({room:ROOM,type:T,gift:gift.value})});load()}
clearGift.onclick=async()=>{await api("/api/gift-rule/clear",{method:"POST",body:JSON.stringify({room:ROOM,type:T})});load()}
load();setInterval(load,1000);`);
}

function likesPage(room) {
  return shell(room,"Beğeni Sıralaması","/begeni",`
<div class="card"><div class="row" style="justify-content:space-between"><div><h2>❤️ Beğeni Sıralaması</h2><p class="muted">Yayından gelen gerçek beğeni olayları bu listede birikir.</p></div><button class="danger" id="reset">SIFIRLA</button></div></div>
<div class="card"><table><thead><tr><th>Sıra</th><th>Kullanıcı</th><th>Beğeni</th></tr></thead><tbody id="rows"></tbody></table></div>
<div class="card"><h3>Overlay</h3><div class="code">${overlayUrl(room,"begeni")}</div></div>`,
`async function load(){const s=await api("/api/state?room="+ROOM);rows.innerHTML=s.likes.map((x,i)=>"<tr><td>"+(i<3?["🥇","🥈","🥉"][i]:(i+1))+"</td><td>@"+x.username+"</td><td>"+Number(x.likeCount).toLocaleString("tr-TR")+" ❤️</td></tr>").join("")||'<tr><td colspan="3" class="empty">Henüz beğeni yok.</td></tr>'}
reset.onclick=async()=>{await api("/api/likes/reset",{method:"POST",body:JSON.stringify({room:ROOM})});load()};load();setInterval(load,700);`);
}

function winPage(room) {
  return shell(room,"WIN Sayacı","/win",`
<div class="card"><h2>🏆 WIN Sayacı</h2><div id="win" class="stat" style="font-size:72px">${String(room.wins).padStart(2,"0")} / ${room.maxWins}</div><div class="muted">-${room.penalty} CEZA</div><div class="row" style="margin-top:18px"><button id="plus">+ WIN</button><button class="danger" id="minus">- WIN</button><button class="gold" id="zero">SIFIRLA</button></div></div>
<div class="card"><h3>Overlay</h3><div class="code">${overlayUrl(room,"win")}</div></div>`,
`async function load(){const s=await api("/api/state?room="+ROOM);win.textContent=String(s.wins).padStart(2,"0")+" / "+s.maxWins}
async function chg(n){await api("/api/win",{method:"POST",body:JSON.stringify({room:ROOM,change:n})});load()}
plus.onclick=()=>chg(1);minus.onclick=()=>chg(-1);zero.onclick=()=>chg(0);load();setInterval(load,700);`);
}

function testPage(room) {
  return shell(room,"Test Merkezi","/test",`
<div class="card"><h2>🧪 Test Merkezi</h2><p class="muted">Gerçek olay gelmiş gibi sistemin ekranlarını test et.</p><div class="grid2">
<div class="card"><h3>⭐ Puan</h3><div class="row"><input id="u1" value="test_kullanici"><input id="sc" type="number" value="10" min="1" max="10"><button id="vote">TEST</button></div></div>
<div class="card"><h3>🎁 Hediye</h3><div class="row"><input id="u2" value="test_kullanici"><input id="gi" value="Test Hediyesi"><button id="gift">TEST</button></div></div>
<div class="card"><h3>❤️ Beğeni</h3><div class="row"><input id="u3" value="test_kullanici"><input id="lc" type="number" value="100"><button id="like">TEST</button></div></div></div></div>`,
`vote.onclick=async()=>{await api("/api/test/vote",{method:"POST",body:JSON.stringify({room:ROOM,username:u1.value,score:sc.value})});alert("Test puanı gönderildi")}
gift.onclick=async()=>{await api("/api/test/gift",{method:"POST",body:JSON.stringify({room:ROOM,username:u2.value,gift:gi.value})});alert("Test hediyesi gönderildi")}
like.onclick=async()=>{await api("/api/test/like",{method:"POST",body:JSON.stringify({room:ROOM,username:u3.value,count:lc.value})});alert("Test beğenisi gönderildi")}`);
}

function guidePage(room) {
  return shell(room,"Kullanım Rehberi","/rehber",`
<div class="card"><h2>📖 Kullanım Rehberi</h2><ol><li>Yayın Bağlantısı'na git.</li><li>TikTok kullanıcı adını yaz ve BAĞLAN'a bas.</li><li>Üstte 🟢 bağlı görünce yayın bağlantısı kurulmuştur.</li><li>Puanlama, hediye ve beğeni sistemlerini kullan.</li><li>Overlay adreslerini OBS/TikTok Live Studio Browser Source olarak ekle.</li></ol></div>`);
}

function overlayPage(room,type) {
  const title={puanlama:"⭐ PUANLAMA",racon:"👑 RACON KRALI",mekan:"🏠 MEKAN SAHİBİ",begeni:"❤️ BEĞENİ SIRALAMASI",win:"🏆 WIN"}[type];
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;color:#fff;font-family:Arial,sans-serif}.wrap{width:100%;height:100%;display:flex;align-items:center;justify-content:center}.box{min-width:360px;max-width:94vw;padding:24px 30px;border-radius:20px;background:rgba(5,6,9,.88);border:1px solid rgba(255,255,255,.13);box-shadow:0 15px 55px rgba(0,0,0,.35);text-align:center}.title{font-size:28px;font-weight:900;margin-bottom:12px}.big{font-size:60px;font-weight:950}.muted{opacity:.7}.row{display:flex;justify-content:space-between;gap:24px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.12);text-align:left}
</style></head><body><div class="wrap"><div id="box" class="box"><div class="title">${title}</div><div class="muted">Veri bekleniyor...</div></div></div>
<script>
const ROOM=${JSON.stringify(room.code)}, TYPE=${JSON.stringify(type)};
function e(v){return String(v??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
async function load(){try{const s=await fetch("/api/state?room="+ROOM,{cache:"no-store"}).then(r=>r.json());let h="";
if(TYPE==="puanlama")h=s.scoring?'<div class="title">${title}</div><div class="big">'+e(s.average)+'</div><div>'+s.participants+' katılımcı · '+Math.max(0,Math.ceil((s.scoreEndsAt-Date.now())/1000))+' sn</div>':'<div class="title">${title}</div><div class="muted">Puanlama beklemede</div>';
else if(TYPE==="racon")h='<div class="title">${title}</div>'+(s.lastRacon?'<div class="big">@'+e(s.lastRacon.username)+'</div><div>'+e(s.lastRacon.gift)+'</div>':'<div class="muted">Hediye bekleniyor</div>');
else if(TYPE==="mekan")h='<div class="title">${title}</div>'+(s.lastMekan?'<div class="big">@'+e(s.lastMekan.username)+'</div><div>'+e(s.lastMekan.gift)+'</div>':'<div class="muted">Hediye bekleniyor</div>');
else if(TYPE==="begeni")h='<div class="title">${title}</div>'+s.likes.slice(0,10).map((v,i)=>'<div class="row"><span>'+((i<3)?["🥇","🥈","🥉"][i]:(i+1)+".")+' @'+e(v.username)+'</span><b>'+Number(v.likeCount).toLocaleString("tr-TR")+' ❤️</b></div>').join("");
else h='<div class="title">${title}</div><div class="big">'+String(s.wins).padStart(2,"0")+'/'+s.maxWins+'</div><div class="muted">-'+s.penalty+' CEZA</div>';
box.innerHTML=h}catch{}}
load();setInterval(load,700);
</script></body></html>`;
}

function overlayUrl(room,type) {
  // Relative URL is intentionally displayed so it works on the current hostname.
  return `${type} overlay: /overlay/${type}?room=${room.code}`;
}

function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]||c));
}

function getRoom(req,res) {
  const code = String(req.query.room || req.body?.room || "").toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,6);
  if (code) return roomState(code);

  const cookie = req.headers.cookie || "";
  const match = cookie.match(/msroom=([A-Z0-9]{6})/);
  if (match) return roomState(match[1]);

  const newCode = makeCode();
  res.setHeader("Set-Cookie", `msroom=${newCode}; Path=/; SameSite=Lax`);
  return roomState(newCode);
}

app.get("/", (req,res) => {
  const room=getRoom(req,res);
  res.redirect(`/connection?room=${room.code}`);
});

app.get("/connection",(req,res)=>{const room=getRoom(req,res);res.type("html").send(connectionPage(room))});
app.get("/puanlama",(req,res)=>{const room=getRoom(req,res);res.type("html").send(scorePage(room))});
app.get("/racon",(req,res)=>{const room=getRoom(req,res);res.type("html").send(giftPage(room,"racon"))});
app.get("/mekan",(req,res)=>{const room=getRoom(req,res);res.type("html").send(giftPage(room,"mekan"))});
app.get("/begeni",(req,res)=>{const room=getRoom(req,res);res.type("html").send(likesPage(room))});
app.get("/win",(req,res)=>{const room=getRoom(req,res);res.type("html").send(winPage(room))});
app.get("/test",(req,res)=>{const room=getRoom(req,res);res.type("html").send(testPage(room))});
app.get("/rehber",(req,res)=>{const room=getRoom(req,res);res.type("html").send(guidePage(room))});

app.get("/overlay/:type",(req,res)=>{
  const type=req.params.type;
  if(!["puanlama","racon","mekan","begeni","win"].includes(type)) return res.status(404).send("Overlay bulunamadı");
  const room=getRoom(req,res);
  res.type("html").send(overlayPage(room,type));
});

app.get("/api/state",(req,res)=>{
  const room=getRoom(req,res);
  res.json(snapshot(room));
});

app.get("/api/health",(_req,res)=>res.json({ok:true,rooms:rooms.size}));

app.post("/api/connect",async(req,res)=>{
  try{
    const room=getRoom(req,res);
    const user=cleanUser(req.body?.username);
    if(!user)return res.status(400).json({ok:false,message:"TikTok kullanıcı adı gerekli."});
    await connectTikTok(room,user);
    res.json(snapshot(room));
  }catch(e){
    const code=String(req.body?.room||"").toUpperCase();
    const room=rooms.get(code)||getRoom(req,res);
    room.connected=false;room.connecting=false;room.message=e?.message||"TikTok bağlantısı kurulamadı.";
    broadcast(room);
    res.status(400).json({ok:false,message:room.message});
  }
});

app.post("/api/disconnect",async(req,res)=>{
  const room=getRoom(req,res);
  await disconnectTikTok(room);
  room.username="";
  res.json(snapshot(room));
});

app.post("/api/score/settings",(req,res)=>{
  const room=getRoom(req,res),n=Number(req.body?.duration);
  if(!Number.isFinite(n)||n<1||n>3600)return res.status(400).json({ok:false,message:"Süre 1-3600 saniye olmalı."});
  room.scoreDuration=Math.floor(n);broadcast(room);res.json(snapshot(room));
});
app.post("/api/score/start",(req,res)=>{const room=getRoom(req,res);startScoring(room);res.json(snapshot(room))});
app.post("/api/score/stop",(req,res)=>{const room=getRoom(req,res);stopScoring(room);res.json(snapshot(room))});

app.post("/api/gift-rule",(req,res)=>{
  const room=getRoom(req,res),type=String(req.body?.type||""),gift=cleanText(req.body?.gift);
  if(!["racon","mekan"].includes(type)||!gift)return res.status(400).json({ok:false,message:"Hediye adı gerekli."});
  if(type==="racon")room.raconGift=gift;else room.mekanGift=gift;
  broadcast(room);res.json(snapshot(room));
});
app.post("/api/gift-rule/clear",(req,res)=>{
  const room=getRoom(req,res),type=String(req.body?.type||"");
  if(type==="racon")room.raconGift="";else if(type==="mekan")room.mekanGift="";else return res.status(400).json({ok:false,message:"Geçersiz sistem."});
  broadcast(room);res.json(snapshot(room));
});

app.post("/api/likes/reset",(req,res)=>{const room=getRoom(req,res);room.likes.clear();broadcast(room);res.json(snapshot(room))});
app.post("/api/win",(req,res)=>{
  const room=getRoom(req,res),n=Number(req.body?.change);
  if(n===0)room.wins=0;else if(n===1)room.wins=Math.min(room.maxWins,room.wins+1);else if(n===-1)room.wins=Math.max(0,room.wins-1);else return res.status(400).json({ok:false,message:"Geçersiz WIN."});
  broadcast(room);res.json(snapshot(room));
});

app.post("/api/test/vote",(req,res)=>{const room=getRoom(req,res);if(!room.scoring)startScoring(room);addVote(room,req.body?.username,req.body?.score);res.json(snapshot(room))});
app.post("/api/test/like",(req,res)=>{const room=getRoom(req,res);addLike(room,req.body?.username,req.body?.count);res.json(snapshot(room))});
app.post("/api/test/gift",(req,res)=>{const room=getRoom(req,res);addGift(room,req.body?.username,req.body?.gift,"",1);res.json(snapshot(room))});

io.on("connection",(socket)=>{
  const roomCode=String(socket.handshake.query.room||"").toUpperCase();
  if(roomCode){
    const room=roomState(roomCode);
    socket.join("room:"+room.code);
    socket.emit("state:update",snapshot(room));
  }
});

server.listen(PORT,"0.0.0.0",()=>console.log("MS YAYIN on",PORT));
