
const express = require("express");
const http = require("http");

const app = express();
const httpServer = http.createServer(app);
const PORT = process.env.PORT || 10000;

app.use(express.json({limit:"100kb"}));

const state = {
  username: "",
  connected: false,
  scoreDuration: 15,
  scoring: false,
  scoreEndsAt: 0,
  votes: [],
  likes: {},
  raconGift: "",
  mekanGift: "",
  racon: {},
  mekan: {},
  lastRacon: null,
  lastMekan: null,
  wins: 0,
  maxWins: 20,
  penalty: 20
};

function clean(v, max=80) {
  return String(v || "").trim().replace(/^@+/, "").slice(0,max);
}
function gift(v) {
  return clean(v,80);
}
function snapshot() {
  const participants = new Set(state.votes.map(v=>v.username)).size;
  const average = state.votes.length
    ? Number((state.votes.reduce((a,v)=>a+v.score,0)/state.votes.length).toFixed(2))
    : 0;

  return {
    username: state.username,
    connected: state.connected,
    scoreDuration: state.scoreDuration,
    scoring: state.scoring,
    scoreEndsAt: state.scoreEndsAt,
    average,
    participants,
    votes: state.votes.slice(-100).reverse(),
    likes: Object.entries(state.likes)
      .map(([username,v])=>({username,likeCount:v.count,avatar:v.avatar||""}))
      .sort((a,b)=>b.likeCount-a.likeCount),
    raconGift: state.raconGift,
    mekanGift: state.mekanGift,
    racon: Object.values(state.racon).sort((a,b)=>b.count-a.count),
    mekan: Object.values(state.mekan).sort((a,b)=>b.count-a.count),
    lastRacon: state.lastRacon,
    lastMekan: state.lastMekan,
    wins: state.wins,
    maxWins: state.maxWins,
    penalty: state.penalty
  };
}

function startScoring() {
  state.votes = [];
  state.scoring = true;
  state.scoreEndsAt = Date.now() + state.scoreDuration * 1000;
  setTimeout(()=>{
    if(state.scoring && Date.now() >= state.scoreEndsAt) {
      state.scoring = false;
      state.scoreEndsAt = 0;
    }
  }, state.scoreDuration*1000 + 100);
}
function stopScoring() {
  state.scoring = false;
  state.scoreEndsAt = 0;
}
function addVote(user, score) {
  if(!state.scoring) return;
  const n = Number(score);
  if(!Number.isInteger(n) || n<1 || n>10) return;
  state.votes.push({username:clean(user)||"bilinmeyen",score:n,at:Date.now()});
}
function addLike(user,count) {
  const u=clean(user)||"bilinmeyen";
  const n=Math.max(1,Number(count)||1);
  if(!state.likes[u]) state.likes[u]={count:0,avatar:""};
  state.likes[u].count += n;
}
function addGift(user,giftName) {
  const u=clean(user)||"bilinmeyen";
  const g=gift(giftName)||"Hediye";
  const key=g.toLowerCase();

  if(state.raconGift && state.raconGift.toLowerCase()===key){
    if(!state.racon[u]) state.racon[u]={username:u,count:0,gift:g};
    state.racon[u].count += 1;
    state.lastRacon={username:u,gift:g,at:Date.now()};
  }
  if(state.mekanGift && state.mekanGift.toLowerCase()===key){
    if(!state.mekan[u]) state.mekan[u]={username:u,count:0,gift:g};
    state.mekan[u].count += 1;
    state.lastMekan={username:u,gift:g,at:Date.now()};
  }
}

const CSS = `
:root{
 --bg:#07080c;--side:#10131a;--card:#141923;--line:#282e3a;
 --text:#f5f6f8;--muted:#969eae;--red:#f04444;--green:#28b66d;--gold:#c99522
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;min-height:100%;background:var(--bg);color:var(--text);font-family:Segoe UI,Arial,sans-serif}
button,input{font:inherit}
button{border:0;border-radius:10px;padding:11px 15px;font-weight:800;cursor:pointer}
.btn{background:var(--red);color:white}.btn.secondary{background:#232935}.btn.green{background:var(--green)}.btn.gold{background:var(--gold)}.btn.danger{background:#aa2731}
.app{display:grid;grid-template-columns:250px 1fr;min-height:100vh}
.sidebar{background:var(--side);border-right:1px solid var(--line);padding:22px 16px;min-height:100vh}
.brand{font-size:23px;font-weight:950;padding:2px 8px 20px}.brand span{color:var(--red)}
.nav{display:flex;flex-direction:column;gap:5px}
.nav a{display:block;text-decoration:none;color:#d8dce5;border-radius:10px;padding:12px 12px;font-weight:700}
.nav a:hover,.nav a.active{background:#202531;color:#fff}
.main{width:100%;max-width:1500px;padding:28px}
.header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:20px}
h1{margin:0 0 6px;font-size:31px}.muted{color:var(--muted)}
.status{padding:8px 12px;border:1px solid var(--line);border-radius:999px;font-weight:800}
.status.ok{color:#6ce6a1}.status.off{color:#ff7b7b}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}
.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
.stat{font-size:34px;font-weight:950;margin-top:8px}
.row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
input,select{min-width:180px;background:#0d1016;color:white;border:1px solid #323947;padding:11px 12px;border-radius:10px;outline:none}
input:focus,select:focus{border-color:#5b667b}
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:11px 8px;border-bottom:1px solid var(--line)}
.empty{text-align:center;padding:24px;color:var(--muted)}
.code{font-family:Consolas,monospace;background:#0b0e13;border:1px solid var(--line);border-radius:10px;padding:11px;word-break:break-all}
@media(max-width:900px){.app{grid-template-columns:205px 1fr}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:650px){.app{display:block}.sidebar{min-height:auto}.main{padding:16px}.grid,.grid2{grid-template-columns:1fr}.header{display:block}}
`;

const PAGES = {
  connection: {path:"/connection", title:"Yayın Bağlantısı", icon:"🔴"},
  score: {path:"/puanlama", title:"Puanlama", icon:"⭐"},
  racon: {path:"/racon", title:"Racon Kralları", icon:"👑"},
  mekan: {path:"/mekan", title:"Mekan Sahibi", icon:"🏠"},
  likes: {path:"/begeni", title:"Beğeni Sıralaması", icon:"❤️"},
  win: {path:"/win", title:"WIN Sayacı", icon:"🏆"},
  test: {path:"/test", title:"Test Merkezi", icon:"🧪"},
  guide: {path:"/rehber", title:"Kullanım Rehberi", icon:"📖"}
};

function layout(title, active, body, script="") {
  const nav = Object.entries(PAGES).map(([key,p]) =>
    `<a class="${active===key?"active":""}" href="${p.path}">${p.icon} ${p.title}</a>`
  ).join("");

  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MS YAYIN - ${title}</title><style>${CSS}</style></head><body>
  <div class="app"><aside class="sidebar"><div class="brand">🔥 MS <span>YAYIN</span></div><nav class="nav">${nav}</nav></aside>
  <main class="main">
    <div class="header"><div><h1>${title}</h1><div class="muted">Tek yayın sistemi · doğrudan kullanıcı adı ile bağlantı</div></div>
    <div id="status" class="status ${state.connected?"ok":"off"}">${state.connected?"🟢 Bağlı":"🔴 Bağlı değil"}</div></div>
    ${body}
  </main></div>
  <script>
    async function api(url, opts={}){const r=await fetch(url,{headers:{"Content-Type":"application/json"},...opts});const d=await r.json();if(!r.ok)throw new Error(d.message||"İşlem başarısız");return d}
    async function refreshStatus(){try{const s=await api("/api/state");const e=document.getElementById("status");if(e){e.textContent=s.connected?"🟢 Bağlı":"🔴 Bağlı değil";e.className="status "+(s.connected?"ok":"off")}}catch{}}
    refreshStatus();setInterval(refreshStatus,1200);
    ${script}
  </script></body></html>`;
}

function connectionPage(){
 return layout("Yayın Bağlantısı","connection",`
 <div class="card"><h2>TikTok Kullanıcı Adı</h2><p class="muted">Sadece kullanıcı adını yazıp bağlan. Ekstra oda veya kod yok.</p>
 <div class="row"><input id="username" placeholder="@kullaniciadi" value="${esc(state.username)}"><button class="btn" onclick="connect()">🔴 BAĞLAN</button><button class="btn secondary" onclick="disconnect()">BAĞLANTIYI KES</button></div>
 <div id="msg" class="card" style="margin-top:14px;margin-bottom:0">Bağlantı durumu burada görünür.</div></div>
 <div class="grid">
 <div class="card"><div class="muted">Ortalama Puan</div><div id="a" class="stat">${snapshot().average}</div></div>
 <div class="card"><div class="muted">Katılımcı</div><div id="p" class="stat">${snapshot().participants}</div></div>
 <div class="card"><div class="muted">Beğeni Kullanıcısı</div><div id="l" class="stat">${snapshot().likes.length}</div></div>
 <div class="card"><div class="muted">WIN</div><div id="w" class="stat">${String(state.wins).padStart(2,"0")}/${state.maxWins}</div></div></div>`,
 `async function load(){const s=await api("/api/state");a.textContent=s.average;p.textContent=s.participants;l.textContent=s.likes.length;w.textContent=String(s.wins).padStart(2,"0")+"/"+s.maxWins}
 async function connect(){try{const d=await api("/api/connect",{method:"POST",body:JSON.stringify({username:username.value})});msg.textContent=d.message;load();refreshStatus()}catch(e){msg.textContent=e.message}}
 async function disconnect(){await api("/api/disconnect",{method:"POST",body:"{}"});msg.textContent="Bağlantı kesildi.";load();refreshStatus()}
 load();setInterval(load,1500);`);
}

function scorePage(){
 return layout("Puanlama","score",`
 <div class="card"><h2>⭐ Puanlama</h2><div class="row"><label>Süre<br><input id="dur" type="number" min="1" max="3600" value="${state.scoreDuration}"></label>
 <button class="btn secondary" onclick="saveDur()">SÜREYİ KAYDET</button><button class="btn green" onclick="start()">▶ BAŞLAT</button><button class="btn danger" onclick="stop()">■ BİTİR</button></div></div>
 <div class="grid"><div class="card"><div class="muted">Ortalama</div><div id="avg" class="stat">${snapshot().average}</div></div><div class="card"><div class="muted">Katılımcı</div><div id="part" class="stat">${snapshot().participants}</div></div><div class="card"><div class="muted">Kalan</div><div id="left" class="stat">—</div></div><div class="card"><div class="muted">Durum</div><div id="st" class="stat" style="font-size:22px">${state.scoring?"🟢 AKTİF":"⚪ BEKLEMEDE"}</div></div></div>
 <div class="card"><h3>Oy Verenler</h3><table><thead><tr><th>Kullanıcı</th><th>Puan</th></tr></thead><tbody id="rows"></tbody></table></div>
 <div class="card"><h3>Overlay Linki</h3><div class="code">${"/overlay/puanlama"}</div></div>`,
 `function esc(v){return String(v??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
 function render(s){avg.textContent=s.average;part.textContent=s.participants;st.textContent=s.scoring?"🟢 AKTİF":"⚪ BEKLEMEDE";left.textContent=s.scoring?Math.max(0,Math.ceil((s.scoreEndsAt-Date.now())/1000))+" sn":"—";rows.innerHTML=s.votes.map(v=>"<tr><td>@"+esc(v.username)+"</td><td><b>"+v.score+"</b></td></tr>").join("")||'<tr><td colspan="2" class="empty">Henüz puan yok.</td></tr>';dur.value=s.scoreDuration}
 async function load(){const s=await api("/api/state");render(s)} async function saveDur(){try{await api("/api/score/settings",{method:"POST",body:JSON.stringify({duration:dur.value})});load()}catch(e){alert(e.message)}} async function start(){await api("/api/score/start",{method:"POST",body:"{}"});load()} async function stop(){await api("/api/score/stop",{method:"POST",body:"{}"});load()} load();setInterval(load,500);`);
}

function giftPage(type){
 const isR=type==="racon", title=isR?"Racon Kralları":"Mekan Sahibi", icon=isR?"👑":"🏠", selected=isR?state.raconGift:state.mekanGift, arr=isR?Object.values(state.racon):Object.values(state.mekan);
 const rows=arr.sort((a,b)=>b.count-a.count).map((x,i)=>`<tr><td>${i<3?["🥇","🥈","🥉"][i]:i+1}</td><td>@${esc(x.username)}</td><td>${x.count}x</td><td>${esc(x.gift)}</td></tr>`).join("");
 return layout(title,type,`
 <div class="card"><h2>${icon} ${title}</h2><p class="muted">Hangi hediye seçilirse, o hediye geldiğinde gönderen otomatik listeye eklenir.</p>
 <div class="row"><input id="gift" list="gifts" placeholder="Hediye adı" value="${esc(selected)}"><datalist id="gifts"><option value="Test Hediyesi"><option value="Aslan"><option value="Galaxy"><option value="TikTok Universe"><option value="Rose"><option value="Finger Heart"></datalist>
 <button class="btn green" onclick="saveGift()">HEDİYEYİ AKTİF ET</button><button class="btn secondary" onclick="clearGift()">KALDIR</button></div>
 <p>Aktif hediye: <b id="selected">${esc(selected||"Yok")}</b></p></div>
 <div class="card"><h3>Otomatik Liste</h3><table><thead><tr><th>Sıra</th><th>Kullanıcı</th><th>Adet</th><th>Hediye</th></tr></thead><tbody id="rows">${rows||'<tr><td colspan="4" class="empty">Henüz kayıt yok.</td></tr>'}</tbody></table></div>
 <div class="card"><h3>Overlay Linki</h3><div class="code">${"/overlay/"+(isR?"racon":"mekan")}</div></div>`,
 `async function load(){const s=await api("/api/state");selected.textContent=s.${isR?"raconGift":"mekanGift"}||"Yok";gift.value=s.${isR?"raconGift":"mekanGift"}||"";const a=s.${isR?"racon":"mekan"};rows.innerHTML=a.map((x,i)=>"<tr><td>"+(i<3?["🥇","🥈","🥉"][i]:i+1)+"</td><td>@"+x.username+"</td><td>"+x.count+"x</td><td>"+x.gift+"</td></tr>").join("")||'<tr><td colspan="4" class="empty">Henüz kayıt yok.</td></tr>'}
 async function saveGift(){try{await api("/api/gift-rule",{method:"POST",body:JSON.stringify({type:"${type}",gift:gift.value})});load()}catch(e){alert(e.message)}} async function clearGift(){await api("/api/gift-rule/clear",{method:"POST",body:JSON.stringify({type:"${type}"})});load()} load();setInterval(load,1200);`);
}

function likesPage(){
 return layout("Beğeni Sıralaması","likes",`
 <div class="card"><div class="row" style="justify-content:space-between"><div><h2>❤️ Beğeni Sıralaması</h2><div class="muted">En çok beğeni gönderenler üstte</div></div><button class="btn danger" onclick="resetLikes()">SIFIRLA</button></div></div>
 <div class="card"><table><thead><tr><th>Sıra</th><th>Kullanıcı</th><th>Beğeni</th></tr></thead><tbody id="rows"></tbody></table></div>
 <div class="card"><h3>Overlay Linki</h3><div class="code">/overlay/begeni</div></div>`,
 `async function load(){const s=await api("/api/state");rows.innerHTML=s.likes.map((x,i)=>"<tr><td>"+(i<3?["🥇","🥈","🥉"][i]:i+1)+"</td><td>@"+x.username+"</td><td>"+Number(x.likeCount).toLocaleString("tr-TR")+" ❤️</td></tr>").join("")||'<tr><td colspan="3" class="empty">Henüz beğeni yok.</td></tr>'} async function resetLikes(){await api("/api/likes/reset",{method:"POST",body:"{}"});load()} load();setInterval(load,1200);`);
}

function winPage(){
 return layout("WIN Sayacı","win",`
 <div class="card"><h2>🏆 WIN Sayacı</h2><div id="win" class="stat" style="font-size:72px">${String(state.wins).padStart(2,"0")} / ${state.maxWins}</div><div class="muted">-${state.penalty} CEZA</div><div class="row" style="margin-top:18px"><button class="btn" onclick="chg(1)">+ WIN</button><button class="btn danger" onclick="chg(-1)">- WIN</button><button class="btn gold" onclick="chg(0)">SIFIRLA</button></div></div>
 <div class="card"><h3>Overlay Linki</h3><div class="code">/overlay/win</div></div>`,
 `async function load(){const s=await api("/api/state");win.textContent=String(s.wins).padStart(2,"0")+" / "+s.maxWins} async function chg(n){await api("/api/win",{method:"POST",body:JSON.stringify({change:n})});load()} load();setInterval(load,800);`);
}

function testPage(){
 return layout("Test Merkezi","test",`
 <div class="card"><h2>🧪 Test Merkezi</h2><p class="muted">Sisteme gerçek olay gelmiş gibi test verisi gönder.</p>
 <div class="grid2">
 <div class="card"><h3>⭐ Puan</h3><div class="row"><input id="u1" value="test_kullanici"><input id="sc" type="number" min="1" max="10" value="10"><button class="btn" onclick="tv()">GÖNDER</button></div></div>
 <div class="card"><h3>🎁 Hediye</h3><div class="row"><input id="u2" value="test_kullanici"><input id="gi" value="Test Hediyesi"><button class="btn" onclick="tgf()">GÖNDER</button></div></div>
 <div class="card"><h3>❤️ Beğeni</h3><div class="row"><input id="u3" value="test_kullanici"><input id="li" type="number" value="100"><button class="btn" onclick="tlk()">GÖNDER</button></div></div>
 </div></div>
 <div class="card"><h3>Overlaylar</h3><div class="code">/overlay/puanlama</div><br><div class="code">/overlay/racon</div><br><div class="code">/overlay/mekan</div><br><div class="code">/overlay/begeni</div><br><div class="code">/overlay/win</div></div>`,
 `async function tv(){await api("/api/test/vote",{method:"POST",body:JSON.stringify({username:u1.value,score:sc.value})});alert("Test puanı gönderildi.")}
 async function tgf(){await api("/api/test/gift",{method:"POST",body:JSON.stringify({username:u2.value,gift:gi.value})});alert("Test hediyesi gönderildi.")}
 async function tlk(){await api("/api/test/like",{method:"POST",body:JSON.stringify({username:u3.value,count:li.value})});alert("Test beğenisi gönderildi.")}`);
}

function guidePage(){
 return layout("Kullanım Rehberi","guide",`
 <div class="card"><h2>📖 Kullanım Rehberi</h2><ol><li>TikTok kullanıcı adını <b>Yayın Bağlantısı</b> bölümüne yaz.</li><li><b>Puanlama</b> bölümünde istediğin süreyi seçip başlat.</li><li><b>Racon Kralları</b> ve <b>Mekan Sahibi</b> bölümünde tetiklenecek hediyeyi seç.</li><li><b>Beğeni Sıralaması</b> kullanıcıları toplam beğeniye göre sıralar.</li><li>İlgili overlay bağlantısını OBS veya TikTok Live Studio'da Browser Source olarak kullan.</li></ol></div>`);
}

function overlayPage(type){
 const title={puanlama:"⭐ PUANLAMA",racon:"👑 RACON KRALI",mekan:"🏠 MEKAN SAHİBİ",begeni:"❤️ BEĞENİ SIRALAMASI",win:"🏆 WIN"}[type];
 const body=`
 <!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
 <style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;color:#fff;font-family:Arial,sans-serif}.wrap{width:100%;height:100%;display:flex;align-items:center;justify-content:center}.box{min-width:360px;max-width:88vw;padding:22px 28px;border-radius:20px;background:rgba(7,8,12,.88);border:1px solid rgba(255,255,255,.12);text-align:center}.title{font-size:28px;font-weight:900;margin-bottom:10px}.big{font-size:58px;font-weight:950}.muted{opacity:.7}.row{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid rgba(255,255,255,.12);gap:20px;text-align:left}</style>
 </head><body><div class="wrap"><div class="box" id="box"><div class="title">${title}</div><div class="muted">Bekleniyor...</div></div></div>
 <script>
 function esc(v){return String(v??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
 async function load(){try{const s=await fetch("/api/state").then(r=>r.json());let h="";
 if("${type}"==="puanlama")h=s.scoring?'<div class="title">${title}</div><div class="big">'+esc(s.average)+'</div><div>'+s.participants+' katılımcı · '+Math.max(0,Math.ceil((s.scoreEndsAt-Date.now())/1000))+' sn</div>':'<div class="title">${title}</div><div class="muted">Başlamayı bekliyor</div>';
 else if("${type}"==="racon")h='<div class="title">${title}</div>'+(s.lastRacon?'<div class="big">@'+esc(s.lastRacon.username)+'</div><div>'+esc(s.lastRacon.gift)+'</div>':'<div class="muted">Hediye bekleniyor</div>');
 else if("${type}"==="mekan")h='<div class="title">${title}</div>'+(s.lastMekan?'<div class="big">@'+esc(s.lastMekan.username)+'</div><div>'+esc(s.lastMekan.gift)+'</div>':'<div class="muted">Hediye bekleniyor</div>');
 else if("${type}"==="begeni")h='<div class="title">${title}</div>'+s.likes.slice(0,10).map((x,i)=>'<div class="row"><span>'+((i<3)?["🥇","🥈","🥉"][i]:(i+1)+".")+' @'+esc(x.username)+'</span><b>'+Number(x.likeCount).toLocaleString("tr-TR")+' ❤️</b></div>').join("");
 else h='<div class="title">${title}</div><div class="big">'+String(s.wins).padStart(2,"0")+'/'+s.maxWins+'</div><div class="muted">-'+s.penalty+' CEZA</div>';
 document.getElementById("box").innerHTML=h;}catch{}}
 load();setInterval(load,800);
 </script></body></html>`;
 return body;
}

app.get("/connection",(_req,res)=>res.type("html").send(connectionPage()));
app.get("/puanlama",(_req,res)=>res.type("html").send(scorePage()));
app.get("/racon",(_req,res)=>res.type("html").send(giftPage("racon")));
app.get("/mekan",(_req,res)=>res.type("html").send(giftPage("mekan")));
app.get("/begeni",(_req,res)=>res.type("html").send(likesPage()));
app.get("/win",(_req,res)=>res.type("html").send(winPage()));
app.get("/test",(_req,res)=>res.type("html").send(testPage()));
app.get("/rehber",(_req,res)=>res.type("html").send(guidePage()));
app.get("/overlay/:type",(req,res)=>{
 if(!["puanlama","racon","mekan","begeni","win"].includes(req.params.type)) return res.status(404).send("Overlay bulunamadı");
 res.type("html").send(overlayPage(req.params.type));
});
app.get("/api/state",(_req,res)=>res.json(snapshot()));
app.get("/api/health",(_req,res)=>res.json({ok:true,connected:state.connected}));
app.post("/api/connect",(req,res)=>{
 const user=clean(req.body?.username);
 if(!user)return res.status(400).json({message:"TikTok kullanıcı adı gerekli."});
 state.username=user;state.connected=true;res.json({ok:true,message:"Kullanıcı adı kaydedildi. Bağlantı aktif."});
});
app.post("/api/disconnect",(_req,res)=>{state.connected=false;res.json(snapshot())});
app.post("/api/score/settings",(req,res)=>{
 const n=Number(req.body?.duration);
 if(!Number.isFinite(n)||n<1||n>3600)return res.status(400).json({message:"Süre 1–3600 saniye arasında olmalı."});
 state.scoreDuration=Math.floor(n);res.json(snapshot());
});
app.post("/api/score/start",(_req,res)=>{startScoring();res.json(snapshot())});
app.post("/api/score/stop",(_req,res)=>{stopScoring();res.json(snapshot())});
app.post("/api/gift-rule",(req,res)=>{
 const type=req.body?.type,g=gift(req.body?.gift);
 if(!["racon","mekan"].includes(type)||!g)return res.status(400).json({message:"Hediye seç."});
 if(type==="racon")state.raconGift=g;else state.mekanGift=g;res.json(snapshot());
});
app.post("/api/gift-rule/clear",(req,res)=>{
 if(req.body?.type==="racon")state.raconGift="";else if(req.body?.type==="mekan")state.mekanGift="";else return res.status(400).json({message:"Geçersiz seçim."});
 res.json(snapshot());
});
app.post("/api/likes/reset",(_req,res)=>{state.likes={};res.json(snapshot())});
app.post("/api/win",(req,res)=>{
 const c=Number(req.body?.change);
 if(c===0)state.wins=0;else if(c===1)state.wins=Math.min(state.maxWins,state.wins+1);else if(c===-1)state.wins=Math.max(0,state.wins-1);else return res.status(400).json({message:"Geçersiz işlem."});
 res.json(snapshot());
});
app.post("/api/test/vote",(req,res)=>{if(!state.scoring)startScoring();addVote(req.body?.username,req.body?.score);res.json(snapshot())});
app.post("/api/test/like",(req,res)=>{addLike(req.body?.username,req.body?.count);res.json(snapshot())});
app.post("/api/test/gift",(req,res)=>{addGift(req.body?.username,req.body?.gift);res.json(snapshot())});

app.get("/",(_req,res)=>res.redirect("/connection"));

httpServer.listen(PORT,"0.0.0.0",()=>console.log("MS YAYIN ready on "+PORT));
