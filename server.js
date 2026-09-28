const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });
const PORT = Number(process.env.PORT || 10000);
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "MSYAYIN-BRIDGE-7F4K-29QX";

app.use(express.json({ limit: "100kb" }));

const state = {
  username: "",
  connected: false,
  connecting: false,
  bridgeOnline: false,
  connectionMessage: "Windows Bridge bekleniyor.",
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
  penalty: 20
};

let bridgeSocket = null;
let scoreTimer = null;

function clean(v, max = 100) {
  return String(v || "").replace(/^@+/, "").trim().slice(0, max);
}

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;"
  }[c] || c));
}

function snapshot() {
  const votes = state.votes.slice(-200).reverse();
  const average = state.votes.length
    ? Number((state.votes.reduce((a, v) => a + v.score, 0) / state.votes.length).toFixed(2))
    : 0;

  return {
    username: state.username,
    connected: state.connected,
    connecting: state.connecting,
    bridgeOnline: state.bridgeOnline,
    connectionMessage: state.connectionMessage,
    scoreDuration: state.scoreDuration,
    scoring: state.scoring,
    scoreEndsAt: state.scoreEndsAt,
    average,
    participants: new Set(state.votes.map(v => v.username)).size,
    votes,
    likes: [...state.likes.entries()]
      .map(([username, v]) => ({ username, likeCount: v.count, avatar: v.avatar || "" }))
      .sort((a, b) => b.likeCount - a.likeCount),
    raconGift: state.raconGift,
    mekanGift: state.mekanGift,
    racon: [...state.racon.values()].sort((a, b) => b.count - a.count),
    mekan: [...state.mekan.values()].sort((a, b) => b.count - a.count),
    lastRacon: state.lastRacon,
    lastMekan: state.lastMekan,
    wins: state.wins,
    maxWins: state.maxWins,
    penalty: state.penalty
  };
}

function broadcast() {
  io.emit("state", snapshot());
}

function addLike(username, count, avatar = "") {
  const u = clean(username) || "bilinmeyen";
  const n = Math.max(1, Number(count) || 1);
  const old = state.likes.get(u) || { count: 0, avatar: "" };
  state.likes.set(u, { count: old.count + n, avatar: avatar || old.avatar || "" });
  broadcast();
}

function addVote(username, score, avatar = "") {
  if (!state.scoring) return;
  const n = Number(score);
  if (!Number.isInteger(n) || n < 1 || n > 10) return;
  state.votes.push({ username: clean(username) || "bilinmeyen", score: n, avatar, at: Date.now() });
  state.votes = state.votes.slice(-500);
  broadcast();
}

function addGift(username, giftName, avatar = "") {
  const u = clean(username) || "bilinmeyen";
  const g = clean(giftName) || "Hediye";
  const key = g.toLowerCase();

  if (state.raconGift && state.raconGift.toLowerCase() === key) {
    const old = state.racon.get(u) || { username: u, count: 0, gift: g, avatar: "" };
    const item = { username: u, count: old.count + 1, gift: g, avatar: avatar || old.avatar || "" };
    state.racon.set(u, item);
    state.lastRacon = { username: u, gift: g, avatar: item.avatar, at: Date.now() };
  }

  if (state.mekanGift && state.mekanGift.toLowerCase() === key) {
    const old = state.mekan.get(u) || { username: u, count: 0, gift: g, avatar: "" };
    const item = { username: u, count: old.count + 1, gift: g, avatar: avatar || old.avatar || "" };
    state.mekan.set(u, item);
    state.lastMekan = { username: u, gift: g, avatar: item.avatar, at: Date.now() };
  }
  broadcast();
}

function startScore() {
  if (scoreTimer) clearTimeout(scoreTimer);
  state.votes = [];
  state.scoring = true;
  state.scoreEndsAt = Date.now() + state.scoreDuration * 1000;
  scoreTimer = setTimeout(() => {
    state.scoring = false;
    state.scoreEndsAt = 0;
    broadcast();
  }, state.scoreDuration * 1000 + 100);
  broadcast();
}

function stopScore() {
  state.scoring = false;
  state.scoreEndsAt = 0;
  if (scoreTimer) clearTimeout(scoreTimer);
  scoreTimer = null;
  broadcast();
}

const CSS = `
:root{--bg:#07080c;--side:#10131a;--card:#141923;--line:#292f3a;--text:#f5f7fa;--muted:#9aa2b1;--red:#ef4444;--green:#29b76e;--gold:#c99827}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:Segoe UI,Arial,sans-serif;background:var(--bg);color:var(--text)}
button,input,select{font:inherit}button{border:0;border-radius:10px;padding:11px 15px;font-weight:800;cursor:pointer;background:var(--red);color:#fff}button.secondary{background:#252b36}button.green{background:var(--green)}button.gold{background:var(--gold)}button.danger{background:#a72935}
.layout{display:grid;grid-template-columns:255px 1fr;min-height:100vh}.side{background:var(--side);border-right:1px solid var(--line);padding:22px 16px}.brand{font-size:23px;font-weight:950;margin:0 6px 24px}.brand span{color:var(--red)}
.nav{display:flex;flex-direction:column;gap:4px}.nav a{padding:12px;border-radius:10px;text-decoration:none;color:#d8dce4;font-weight:750}.nav a:hover,.nav a.active{background:#202631;color:#fff}
.main{width:100%;max-width:1500px;padding:28px}.header{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:20px}
h1{font-size:31px;margin:0 0 5px}.muted{color:var(--muted)}.status{padding:8px 12px;border-radius:999px;border:1px solid var(--line);font-weight:900}.ok{color:#63dda0}.off{color:#ff7777}.wait{color:#ffd479}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:16px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.stat{font-size:36px;font-weight:950;margin-top:7px}
input,select{background:#0d1117;color:#fff;border:1px solid #323947;border-radius:10px;padding:11px 12px;min-width:190px}table{width:100%;border-collapse:collapse}th,td{padding:11px 8px;text-align:left;border-bottom:1px solid var(--line)}
.empty{text-align:center;color:var(--muted);padding:24px}.code{font-family:Consolas,monospace;background:#0b0e13;border:1px solid var(--line);padding:11px;border-radius:10px;word-break:break-all}
@media(max-width:900px){.layout{grid-template-columns:205px 1fr}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:650px){.layout{display:block}.main{padding:16px}.grid,.grid2{grid-template-columns:1fr}.header{display:block}}
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

function shell(title, active, body, js) {
  const nav = NAV.map(x => `<a href="${x[0]}" class="${x[0]===active?"active":""}">${x[1]} ${x[2]}</a>`).join("");
  const cls = state.connected ? "ok" : state.connecting ? "wait" : "off";
  const st = state.connected ? "🟢 Bağlı" : state.connecting ? "🟡 Bağlanıyor" : state.bridgeOnline ? "🔴 Bağlı değil" : "⚫ Bridge kapalı";
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MS YAYIN - ${esc(title)}</title><style>${CSS}</style></head><body>
  <div class="layout"><aside class="side"><div class="brand">🔥 MS <span>YAYIN</span></div><nav class="nav">${nav}</nav></aside>
  <main class="main"><div class="header"><div><h1>${esc(title)}</h1><div class="muted">Tek yayıncı · Room yok · Windows Bridge</div></div><div id="status" class="status ${cls}">${st}</div></div>${body}</main></div>
  <script>
  async function api(u,o={}){const r=await fetch(u,{headers:{"Content-Type":"application/json"},...o});const d=await r.json();if(!r.ok)throw Error(d.message||"İşlem başarısız");return d}
  async function top(){try{const s=await api("/api/state"),e=document.getElementById("status");if(e){e.textContent=s.connected?"🟢 Bağlı":s.connecting?"🟡 Bağlanıyor":s.bridgeOnline?"🔴 Bağlı değil":"⚫ Bridge kapalı";e.className="status "+(s.connected?"ok":s.connecting?"wait":"off")}}catch{}}
  top();setInterval(top,1000);${js}
  </script></body></html>`;
}

function connectionPage() {
  return shell("Yayın Bağlantısı","/connection",`
  <div class="card"><h2>📡 TikTok Bağlantısı</h2>
  <p class="muted">Önce Windows Bridge'i çalıştır. Sonra kullanıcı adını yazıp BAĞLAN'a bas.</p>
  <div class="row"><input id="user" placeholder="@kullaniciadi" value="${esc(state.username)}"><button id="connect">BAĞLAN</button><button class="secondary" id="disconnect">KOPAR</button></div>
  <div id="msg" class="card" style="margin-top:14px;margin-bottom:0">${esc(state.connectionMessage)}</div>
  </div>`,
  `connect.onclick=async()=>{try{const s=await api("/api/connect",{method:"POST",body:JSON.stringify({username:user.value})});msg.textContent=s.connectionMessage}catch(e){msg.textContent=e.message}}
   disconnect.onclick=async()=>{const s=await api("/api/disconnect",{method:"POST",body:"{}"});msg.textContent=s.connectionMessage}`);
}

function scorePage() {
  return shell("Puanlama","/puanlama",`
  <div class="card"><h2>⭐ Puanlama</h2><div class="row"><label>Süre <input id="duration" type="number" min="1" max="3600" value="${state.scoreDuration}"> sn</label><button class="secondary" id="save">SÜREYİ KAYDET</button><button class="green" id="start">▶ BAŞLAT</button><button class="danger" id="stop">■ BİTİR</button></div></div>
  <div class="grid"><div class="card"><div class="muted">Ortalama</div><div id="avg" class="stat">0</div></div><div class="card"><div class="muted">Katılımcı</div><div id="parts" class="stat">0</div></div><div class="card"><div class="muted">Kalan</div><div id="left" class="stat">—</div></div><div class="card"><div class="muted">Durum</div><div id="st" class="stat" style="font-size:20px">⚪</div></div></div>
  <div class="card"><h3>Oy Verenler</h3><table><thead><tr><th>Kullanıcı</th><th>Puan</th></tr></thead><tbody id="rows"></tbody></table></div>
  <div class="card"><h3>Overlay</h3><div class="code">https://msyayin.onrender.com/overlay/puanlama</div></div>`,
  `async function load(){const s=await api("/api/state");avg.textContent=s.average;parts.textContent=s.participants;duration.value=s.scoreDuration;st.textContent=s.scoring?"🟢 AKTİF":"⚪ BEKLEMEDE";left.textContent=s.scoring?Math.max(0,Math.ceil((s.scoreEndsAt-Date.now())/1000))+" sn":"—";rows.innerHTML=s.votes.map(v=>"<tr><td>@"+esc2(v.username)+"</td><td>"+v.score+"</td></tr>").join("")||'<tr><td colspan="2" class="empty">Henüz puan yok.</td></tr>'}
  function esc2(v){return String(v??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
  save.onclick=async()=>{await api("/api/score/settings",{method:"POST",body:JSON.stringify({duration:duration.value})});load()};start.onclick=async()=>{await api("/api/score/start",{method:"POST",body:"{}"});load()};stop.onclick=async()=>{await api("/api/score/stop",{method:"POST",body:"{}"});load()};load();setInterval(load,500);`);
}

function giftPage(type) {
  const title = type === "racon" ? "Racon Kralları" : "Mekan Sahibi";
  const icon = type === "racon" ? "👑" : "🏠";
  const selected = type === "racon" ? state.raconGift : state.mekanGift;
  const list = type === "racon" ? [...state.racon.values()] : [...state.mekan.values()];
  const rows = list.map((x,i)=>`<tr><td>${i+1}</td><td>@${esc(x.username)}</td><td>${x.count}x</td><td>${esc(x.gift)}</td></tr>`).join("");
  return shell(title,"/"+type,`
  <div class="card"><h2>${icon} ${title}</h2><p class="muted">Tetiklenecek hediye adını belirle. O hediye geldiğinde kullanıcı otomatik listeye eklenir.</p>
  <div class="row"><input id="gift" value="${esc(selected)}" placeholder="Hediye adı"><button class="green" id="saveGift">AKTİF ET</button><button class="secondary" id="clearGift">KALDIR</button></div><p>Aktif: <b id="active">${esc(selected||"Yok")}</b></p></div>
  <div class="card"><table><thead><tr><th>Sıra</th><th>Kullanıcı</th><th>Adet</th><th>Hediye</th></tr></thead><tbody id="rows">${rows||'<tr><td colspan="4" class="empty">Henüz kayıt yok.</td></tr>'}</tbody></table></div>
  <div class="card"><h3>Overlay</h3><div class="code">https://msyayin.onrender.com/overlay/${type}</div></div>`,
  `const typ=${JSON.stringify(type)};async function load(){const s=await api("/api/state");const g=typ==="racon"?s.raconGift:s.mekanGift;active.textContent=g||"Yok";gift.value=g||"";const a=typ==="racon"?s.racon:s.mekan;rows.innerHTML=a.map((x,i)=>"<tr><td>"+(i+1)+"</td><td>@"+x.username+"</td><td>"+x.count+"x</td><td>"+x.gift+"</td></tr>").join("")||'<tr><td colspan="4" class="empty">Henüz kayıt yok.</td></tr>'}
  saveGift.onclick=async()=>{await api("/api/gift-rule",{method:"POST",body:JSON.stringify({type:typ,gift:gift.value})});load()};clearGift.onclick=async()=>{await api("/api/gift-rule/clear",{method:"POST",body:JSON.stringify({type:typ})});load()};load();setInterval(load,1000);`);
}

function likesPage() {
  return shell("Beğeni Sıralaması","/begeni",`
  <div class="card"><div class="row" style="justify-content:space-between"><div><h2>❤️ Beğeni Sıralaması</h2><div class="muted">Windows Bridge üzerinden gelen gerçek beğeni olayları.</div></div><button class="danger" id="reset">SIFIRLA</button></div></div>
  <div class="card"><table><thead><tr><th>Sıra</th><th>Kullanıcı</th><th>Beğeni</th></tr></thead><tbody id="rows"></tbody></table></div>
  <div class="card"><h3>Overlay</h3><div class="code">https://msyayin.onrender.com/overlay/begeni</div></div>`,
  `async function load(){const s=await api("/api/state");rows.innerHTML=s.likes.map((x,i)=>"<tr><td>"+(i<3?["🥇","🥈","🥉"][i]:(i+1))+"</td><td>@"+x.username+"</td><td>"+Number(x.likeCount).toLocaleString("tr-TR")+" ❤️</td></tr>").join("")||'<tr><td colspan="3" class="empty">Henüz beğeni yok.</td></tr>'}reset.onclick=async()=>{await api("/api/likes/reset",{method:"POST",body:"{}"});load()};load();setInterval(load,700);`);
}

function winPage() {
  return shell("WIN Sayacı","/win",`
  <div class="card"><h2>🏆 WIN Sayacı</h2><div id="win" class="stat" style="font-size:72px">${String(state.wins).padStart(2,"0")} / ${state.maxWins}</div><div class="muted">-${state.penalty} CEZA</div><div class="row" style="margin-top:18px"><button id="plus">+ WIN</button><button class="danger" id="minus">- WIN</button><button class="gold" id="zero">SIFIRLA</button></div></div>
  <div class="card"><h3>Overlay</h3><div class="code">https://msyayin.onrender.com/overlay/win</div></div>`,
  `async function load(){const s=await api("/api/state");win.textContent=String(s.wins).padStart(2,"0")+" / "+s.maxWins}async function chg(n){await api("/api/win",{method:"POST",body:JSON.stringify({change:n})});load()}plus.onclick=()=>chg(1);minus.onclick=()=>chg(-1);zero.onclick=()=>chg(0);load();setInterval(load,700);`);
}

function testPage() {
  return shell("Test Merkezi","/test",`
  <div class="card"><h2>🧪 Test Merkezi</h2><div class="grid2">
  <div class="card"><h3>⭐ Puan</h3><div class="row"><input id="u1" value="test_kullanici"><input id="sc" type="number" value="10" min="1" max="10"><button id="vote">TEST</button></div></div>
  <div class="card"><h3>🎁 Hediye</h3><div class="row"><input id="u2" value="test_kullanici"><input id="gi" value="Test Hediyesi"><button id="gift">TEST</button></div></div>
  <div class="card"><h3>❤️ Beğeni</h3><div class="row"><input id="u3" value="test_kullanici"><input id="lc" type="number" value="100"><button id="like">TEST</button></div></div>
  </div></div>`,
  `vote.onclick=async()=>{await api("/api/test/vote",{method:"POST",body:JSON.stringify({username:u1.value,score:sc.value})});alert("Test puanı gönderildi")}
   gift.onclick=async()=>{await api("/api/test/gift",{method:"POST",body:JSON.stringify({username:u2.value,gift:gi.value})});alert("Test hediyesi gönderildi")}
   like.onclick=async()=>{await api("/api/test/like",{method:"POST",body:JSON.stringify({username:u3.value,count:lc.value})});alert("Test beğenisi gönderildi")}`);
}

function guidePage() {
  return shell("Kullanım Rehberi","/rehber",`
  <div class="card"><h2>📖 Kullanım Rehberi</h2><ol><li>Windows Bridge'i çalıştır.</li><li>Yayın Bağlantısı'ndan TikTok kullanıcı adını yaz ve BAĞLAN'a bas.</li><li>Puanlama, hediyeler ve beğeniler Bridge üzerinden gelir.</li><li>Overlay linkini OBS/TikTok Live Studio Browser Source'a ekle.</li></ol></div>`);
}

function overlayPage(type) {
  const titles = {puanlama:"⭐ PUANLAMA",racon:"👑 RACON KRALI",mekan:"🏠 MEKAN SAHİBİ",begeni:"❤️ BEĞENİ SIRALAMASI",win:"🏆 WIN"};
  const title = titles[type];
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
  <style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;color:#fff;font-family:Arial,sans-serif}.wrap{width:100%;height:100%;display:flex;align-items:center;justify-content:center}.box{min-width:360px;max-width:90vw;padding:24px 30px;border-radius:20px;background:rgba(5,6,9,.9);border:1px solid rgba(255,255,255,.12);box-shadow:0 16px 60px rgba(0,0,0,.4);text-align:center}.title{font-size:28px;font-weight:900;margin-bottom:12px}.big{font-size:60px;font-weight:950}.muted{opacity:.7}.row{display:flex;justify-content:space-between;gap:25px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.12);text-align:left}</style></head>
  <body><div class="wrap"><div class="box" id="box"><div class="title">${title}</div><div class="muted">Veri bekleniyor...</div></div></div>
  <script>
  function x(v){return String(v??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
  async function load(){try{const s=await fetch("/api/state",{cache:"no-store"}).then(r=>r.json());let h="";
  if(${JSON.stringify(type)}==="puanlama")h=s.scoring?'<div class="title">${title}</div><div class="big">'+x(s.average)+'</div><div>'+s.participants+' katılımcı · '+Math.max(0,Math.ceil((s.scoreEndsAt-Date.now())/1000))+' sn</div>':'<div class="title">${title}</div><div class="muted">Başlamayı bekliyor</div>';
  else if(${JSON.stringify(type)}==="racon")h='<div class="title">${title}</div>'+(s.lastRacon?'<div class="big">@'+x(s.lastRacon.username)+'</div><div>'+x(s.lastRacon.gift)+'</div>':'<div class="muted">Hediye bekleniyor</div>');
  else if(${JSON.stringify(type)}==="mekan")h='<div class="title">${title}</div>'+(s.lastMekan?'<div class="big">@'+x(s.lastMekan.username)+'</div><div>'+x(s.lastMekan.gift)+'</div>':'<div class="muted">Hediye bekleniyor</div>');
  else if(${JSON.stringify(type)}==="begeni")h='<div class="title">${title}</div>'+s.likes.slice(0,10).map((v,i)=>'<div class="row"><span>'+((i<3)?["🥇","🥈","🥉"][i]:(i+1)+".")+' @'+x(v.username)+'</span><b>'+Number(v.likeCount).toLocaleString("tr-TR")+' ❤️</b></div>').join("");
  else h='<div class="title">${title}</div><div class="big">'+String(s.wins).padStart(2,"0")+'/'+s.maxWins+'</div><div class="muted">-'+s.penalty+' CEZA</div>';
  document.getElementById("box").innerHTML=h}catch{}}
  load();setInterval(load,700);
  </script></body></html>`;
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
app.get("/overlay/:type",(req,res)=>{
  if(!["puanlama","racon","mekan","begeni","win"].includes(req.params.type)) return res.status(404).send("Overlay bulunamadı");
  res.type("html").send(overlayPage(req.params.type));
});

app.get("/api/state", (_req,res) => res.json(snapshot()));
app.get("/api/health", (_req,res) => res.json({ok:true,bridgeOnline:state.bridgeOnline,connected:state.connected}));

app.post("/api/connect", (req,res) => {
  const username = clean(req.body?.username);
  if(!username) return res.status(400).json({ok:false,message:"TikTok kullanıcı adı gerekli."});
  if(!bridgeSocket || !state.bridgeOnline) {
    return res.status(503).json({ok:false,message:"Windows Bridge bağlı değil. Önce Bridge'i çalıştır."});
  }
  state.username = username;
  state.connecting = true;
  state.connected = false;
  state.connectionMessage = `@${username} canlı yayını aranıyor...`;
  bridgeSocket.emit("bridge:connect", {username});
  broadcast();
  res.json(snapshot());
});

app.post("/api/disconnect", async (_req,res) => {
  if(bridgeSocket) bridgeSocket.emit("bridge:disconnect");
  state.username = "";
  state.connected = false;
  state.connecting = false;
  state.connectionMessage = "Bağlantı kesildi.";
  broadcast();
  res.json(snapshot());
});

app.post("/api/score/settings", (req,res) => {
  const n = Number(req.body?.duration);
  if(!Number.isFinite(n) || n < 1 || n > 3600) return res.status(400).json({ok:false,message:"Süre 1-3600 saniye olmalı."});
  state.scoreDuration = Math.floor(n);
  broadcast();
  res.json(snapshot());
});
app.post("/api/score/start", (_req,res) => { startScore(); res.json(snapshot()); });
app.post("/api/score/stop", (_req,res) => { stopScore(); res.json(snapshot()); });

app.post("/api/gift-rule",(req,res)=>{
  const t=String(req.body?.type||""),g=clean(req.body?.gift);
  if(!["racon","mekan"].includes(t)||!g) return res.status(400).json({ok:false,message:"Hediye adı gerekli."});
  if(t==="racon") state.raconGift=g; else state.mekanGift=g;
  broadcast();
  res.json(snapshot());
});
app.post("/api/gift-rule/clear",(req,res)=>{
  const t=String(req.body?.type||"");
  if(t==="racon") state.raconGift=""; else if(t==="mekan") state.mekanGift=""; else return res.status(400).json({ok:false,message:"Geçersiz sistem."});
  broadcast();
  res.json(snapshot());
});

app.post("/api/likes/reset",(_req,res)=>{state.likes.clear();broadcast();res.json(snapshot())});
app.post("/api/win",(req,res)=>{
  const n=Number(req.body?.change);
  if(n===0) state.wins=0; else if(n===1) state.wins=Math.min(state.maxWins,state.wins+1); else if(n===-1) state.wins=Math.max(0,state.wins-1); else return res.status(400).json({ok:false,message:"Geçersiz WIN."});
  broadcast();
  res.json(snapshot());
});

app.post("/api/test/vote",(req,res)=>{if(!state.scoring)startScore();addVote(req.body?.username,req.body?.score);res.json(snapshot())});
app.post("/api/test/like",(req,res)=>{addLike(req.body?.username,req.body?.count);res.json(snapshot())});
app.post("/api/test/gift",(req,res)=>{addGift(req.body?.username,req.body?.gift);res.json(snapshot())});

io.on("connection",(socket)=>{
  socket.emit("state",snapshot());

  socket.on("bridge:hello",(data)=>{
    if(data?.token!==BRIDGE_TOKEN) return socket.disconnect(true);
    bridgeSocket=socket;
    state.bridgeOnline=true;
    state.connectionMessage="Windows Bridge bağlı. Kullanıcı adını yazıp BAĞLAN'a bas.";
    broadcast();
  });

  socket.on("bridge:status",(data)=>{
    if(socket!==bridgeSocket)return;
    state.username=clean(data?.username||state.username);
    state.connected=Boolean(data?.connected);
    state.connecting=Boolean(data?.connecting);
    state.connectionMessage=String(data?.message||state.connectionMessage);
    broadcast();
  });

  socket.on("bridge:like",(data)=>{
    if(socket!==bridgeSocket)return;
    addLike(data?.username,data?.count,data?.avatar||"");
  });

  socket.on("bridge:chat",(data)=>{
    if(socket!==bridgeSocket)return;
    const comment=String(data?.comment||"").trim();
    if(/^(10|[1-9])$/.test(comment)) addVote(data?.username,Number(comment),data?.avatar||"");
  });

  socket.on("bridge:gift",(data)=>{
    if(socket!==bridgeSocket)return;
    addGift(data?.username,data?.gift,data?.avatar||"");
  });

  socket.on("disconnect",()=>{
    if(socket!==bridgeSocket)return;
    bridgeSocket=null;
    state.bridgeOnline=false;
    state.connected=false;
    state.connecting=false;
    state.connectionMessage="Windows Bridge bağlantısı koptu.";
    broadcast();
  });
});

server.listen(PORT,"0.0.0.0",()=>console.log("MS YAYIN cloud server on",PORT));
