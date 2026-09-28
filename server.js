
const express = require("express");
const http = require("http");

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 10000;

app.use(express.json({limit:"100kb"}));

const state = {
  username:"",
  connected:false,
  scoreDuration:15,
  scoring:false,
  scoreEndsAt:0,
  votes:[],
  likes:{},
  raconGift:"",
  mekanGift:"",
  racon:{},
  mekan:{},
  lastRacon:null,
  lastMekan:null,
  wins:0,
  maxWins:20,
  penalty:20
};

function esc(v){
  return String(v ?? "").replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c] || c));
}
function clean(v){return String(v||"").replace(/^@+/,"").trim().slice(0,80)}
function snap(){
  const average = state.votes.length ? +(state.votes.reduce((a,v)=>a+v.score,0)/state.votes.length).toFixed(2) : 0;
  return {
    username:state.username, connected:state.connected,
    scoreDuration:state.scoreDuration, scoring:state.scoring, scoreEndsAt:state.scoreEndsAt,
    average, participants:new Set(state.votes.map(v=>v.username)).size,
    votes:state.votes.slice(-100).reverse(),
    likes:Object.entries(state.likes).map(([username,x])=>({username,likeCount:x.count})).sort((a,b)=>b.likeCount-a.likeCount),
    raconGift:state.raconGift, mekanGift:state.mekanGift,
    racon:Object.values(state.racon).sort((a,b)=>b.count-a.count),
    mekan:Object.values(state.mekan).sort((a,b)=>b.count-a.count),
    lastRacon:state.lastRacon,lastMekan:state.lastMekan,
    wins:state.wins,maxWins:state.maxWins,penalty:state.penalty
  };
}

function htmlShell(title, active, body, js=""){
  const nav = [
    ["/connection","🔴","Yayın Bağlantısı"],
    ["/puanlama","⭐","Puanlama"],
    ["/racon","👑","Racon Kralları"],
    ["/mekan","🏠","Mekan Sahibi"],
    ["/begeni","❤️","Beğeni Sıralaması"],
    ["/win","🏆","WIN Sayacı"],
    ["/test","🧪","Test Merkezi"],
    ["/rehber","📖","Kullanım Rehberi"]
  ].map(x=>`<a href="${x[0]}" class="${active===x[0]?"active":""}">${x[1]} ${x[2]}</a>`).join("");
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MS YAYIN - ${esc(title)}</title>
  <style>
  :root{--bg:#07080c;--side:#10131a;--card:#141923;--line:#282e3a;--text:#f6f7f9;--muted:#959dad;--red:#ef4545;--green:#29b76e;--gold:#c99422}
  *{box-sizing:border-box}html,body{margin:0;min-height:100%;font-family:Segoe UI,Arial,sans-serif;background:var(--bg);color:var(--text)}
  a,button,input{font:inherit}button{border:0;border-radius:10px;padding:11px 15px;font-weight:800;cursor:pointer;background:var(--red);color:#fff}button.secondary{background:#252b36}button.green{background:var(--green)}button.gold{background:var(--gold)}button.danger{background:#a92a36}
  .layout{display:grid;grid-template-columns:250px 1fr;min-height:100vh}.side{background:var(--side);border-right:1px solid var(--line);padding:22px 15px}.logo{font-size:23px;font-weight:950;margin:0 7px 22px}.logo span{color:var(--red)}.nav{display:flex;flex-direction:column;gap:4px}.nav a{color:#d6dae2;text-decoration:none;font-weight:750;padding:12px;border-radius:10px}.nav a:hover,.nav a.active{background:#202631;color:#fff}
  .main{padding:28px;width:100%;max-width:1500px}.header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:20px}h1{font-size:31px;margin:0 0 6px}.muted{color:var(--muted)}
  .status{border:1px solid var(--line);border-radius:999px;padding:8px 12px;font-weight:900}.ok{color:#63dda0}.off{color:#ff7777}.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:20px;margin-bottom:16px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px}.grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.stat{font-size:36px;font-weight:950;margin-top:7px}
  input,select{background:#0d1117;border:1px solid #323947;color:#fff;border-radius:10px;padding:11px 12px;min-width:190px}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:11px 8px;border-bottom:1px solid var(--line)}.empty{text-align:center;color:var(--muted);padding:24px}.code{background:#0b0e13;border:1px solid var(--line);border-radius:10px;padding:11px;word-break:break-all;font-family:Consolas,monospace}
  @media(max-width:850px){.layout{grid-template-columns:205px 1fr}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:650px){.layout{display:block}.side{padding:14px}.main{padding:16px}.grid,.grid2{grid-template-columns:1fr}.header{display:block}}
  </style></head><body><div class="layout"><aside class="side"><div class="logo">🔥 MS <span>YAYIN</span></div><nav class="nav">${nav}</nav></aside>
  <main class="main"><div class="header"><div><h1>${esc(title)}</h1><div class="muted">Tek yayıncı · Room yok · direkt bağlantı</div></div><div id="status" class="status ${state.connected?"ok":"off"}">${state.connected?"🟢 Bağlı":"🔴 Bağlı değil"}</div></div>${body}</main></div>
  <script>
  async function api(u,o={}){const r=await fetch(u,{headers:{"Content-Type":"application/json"},...o});const d=await r.json();if(!r.ok)throw Error(d.message||"İşlem başarısız");return d}
  async function refresh(){try{const s=await api("/api/state"),e=document.getElementById("status");if(e){e.textContent=s.connected?"🟢 Bağlı":"🔴 Bağlı değil";e.className="status "+(s.connected?"ok":"off")}}catch{}}
  refresh();setInterval(refresh,1200);${js}
  </script></body></html>`;
}

function connectionPage(){
  return htmlShell("Yayın Bağlantısı","/connection",`
  <div class="card"><h2>🔴 TikTok Kullanıcı Adı</h2><p class="muted">Kullanıcı adını yaz. Gerçek canlı bağlantı katmanı daha sonra burada devreye alınacak.</p>
  <div class="row"><input id="user" placeholder="@kullaniciadi" value="${esc(state.username)}"><button onclick="connect()">BAĞLAN</button><button class="secondary" onclick="disconnect()">BAĞLANTIYI KES</button></div>
  <div id="msg" class="card" style="margin-top:14px;margin-bottom:0">Hazır.</div></div>`,
  `async function connect(){try{const d=await api("/api/connect",{method:"POST",body:JSON.stringify({username:user.value})});msg.textContent=d.message;refresh()}catch(e){msg.textContent=e.message}}
   async function disconnect(){await api("/api/disconnect",{method:"POST",body:"{}"});msg.textContent="Bağlantı kesildi.";refresh()}`);
}

function scorePage(){
  return htmlShell("Puanlama","/puanlama",`
  <div class="card"><h2>⭐ Puanlama</h2><div class="row"><label>Süre <input id="dur" type="number" min="1" max="3600" value="${state.scoreDuration}"> sn</label><button class="secondary" onclick="save()">SÜREYİ KAYDET</button><button class="green" onclick="start()">▶ BAŞLAT</button><button class="danger" onclick="stop()">■ BİTİR</button></div></div>
  <div class="grid"><div class="card"><div class="muted">Ortalama</div><div id="avg" class="stat">${snap().average}</div></div><div class="card"><div class="muted">Katılımcı</div><div id="part" class="stat">${snap().participants}</div></div><div class="card"><div class="muted">Kalan</div><div id="left" class="stat">—</div></div><div class="card"><div class="muted">Durum</div><div id="ss" class="stat" style="font-size:22px">${state.scoring?"🟢 AKTİF":"⚪ BEKLEMEDE"}</div></div></div>
  <div class="card"><h3>Oy Verenler</h3><table><thead><tr><th>Kullanıcı</th><th>Puan</th></tr></thead><tbody id="rows"></tbody></table></div>
  <div class="card"><h3>Overlay Linki</h3><div class="code">https://msyayin.onrender.com/overlay/puanlama</div></div>`,
  `async function load(){const s=await api("/api/state");avg.textContent=s.average;part.textContent=s.participants;ss.textContent=s.scoring?"🟢 AKTİF":"⚪ BEKLEMEDE";left.textContent=s.scoring?Math.max(0,Math.ceil((s.scoreEndsAt-Date.now())/1000))+" sn":"—";dur.value=s.scoreDuration;rows.innerHTML=s.votes.map(v=>"<tr><td>@"+esc2(v.username)+"</td><td>"+v.score+"</td></tr>").join("")||'<tr><td colspan="2" class="empty">Henüz puan yok.</td></tr>'}
   function esc2(v){return String(v??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
   async function save(){await api("/api/score/settings",{method:"POST",body:JSON.stringify({duration:dur.value})});load()}
   async function start(){await api("/api/score/start",{method:"POST",body:"{}"});load()}
   async function stop(){await api("/api/score/stop",{method:"POST",body:"{}"});load()}
   load();setInterval(load,500)`);
}

function giftPage(type){
  const title=type==="racon"?"Racon Kralları":"Mekan Sahibi", icon=type==="racon"?"👑":"🏠";
  const selected=type==="racon"?state.raconGift:state.mekanGift;
  const arr=type==="racon"?Object.values(state.racon):Object.values(state.mekan);
  const rows=arr.map((x,i)=>`<tr><td>${i+1}</td><td>@${esc(x.username)}</td><td>${x.count}x</td><td>${esc(x.gift)}</td></tr>`).join("");
  return htmlShell(title,"/"+type,`
  <div class="card"><h2>${icon} ${title}</h2><p class="muted">Tetiklenecek hediye adını seç/ayarla.</p><div class="row"><input id="gift" value="${esc(selected)}" list="g"><datalist id="g"><option>Test Hediyesi</option><option>Aslan</option><option>Galaxy</option><option>Gül</option><option>Finger Heart</option><option>TikTok Universe</option></datalist><button class="green" onclick="saveG()">AKTİF ET</button><button class="secondary" onclick="clearG()">KALDIR</button></div><p>Aktif hediye: <b id="sel">${esc(selected||"Yok")}</b></p></div>
  <div class="card"><table><thead><tr><th>Sıra</th><th>Kullanıcı</th><th>Adet</th><th>Hediye</th></tr></thead><tbody id="rows">${rows||'<tr><td colspan="4" class="empty">Henüz kayıt yok.</td></tr>'}</tbody></table></div>
  <div class="card"><h3>Overlay Linki</h3><div class="code">https://msyayin.onrender.com/overlay/${type}</div></div>`,
  `async function load(){const s=await api("/api/state");const t=${json.dumps(type)};const active=t==="racon"?s.raconGift:s.mekanGift;sel.textContent=active||"Yok";gift.value=active||"";const a=t==="racon"?s.racon:s.mekan;rows.innerHTML=a.map((x,i)=>"<tr><td>"+(i+1)+"</td><td>@"+x.username+"</td><td>"+x.count+"x</td><td>"+x.gift+"</td></tr>").join("")||'<tr><td colspan="4" class="empty">Henüz kayıt yok.</td></tr>'}
   async function saveG(){await api("/api/gift-rule",{method:"POST",body:JSON.stringify({type:${json.dumps(type)},gift:gift.value})});load()}
   async function clearG(){await api("/api/gift-rule/clear",{method:"POST",body:JSON.stringify({type:${json.dumps(type)}})});load()}
   load();setInterval(load,1000)`);
}

function likesPage(){
  return htmlShell("Beğeni Sıralaması","/begeni",`
  <div class="card"><div class="row" style="justify-content:space-between"><div><h2>❤️ Beğeni Sıralaması</h2><div class="muted">En çok beğeni gönderenler üstte</div></div><button class="danger" onclick="resetL()">SIFIRLA</button></div></div>
  <div class="card"><table><thead><tr><th>Sıra</th><th>Kullanıcı</th><th>Beğeni</th></tr></thead><tbody id="rows"></tbody></table></div>
  <div class="card"><h3>Overlay Linki</h3><div class="code">https://msyayin.onrender.com/overlay/begeni</div></div>`,
  `async function load(){const s=await api("/api/state");rows.innerHTML=s.likes.map((x,i)=>"<tr><td>"+(i+1)+"</td><td>@"+x.username+"</td><td>"+Number(x.likeCount).toLocaleString("tr-TR")+" ❤️</td></tr>").join("")||'<tr><td colspan="3" class="empty">Henüz beğeni yok.</td></tr>'}
   async function resetL(){await api("/api/likes/reset",{method:"POST",body:"{}"});load()}load();setInterval(load,1000)`);
}

function winPage(){
  return htmlShell("WIN Sayacı","/win",`
  <div class="card"><h2>🏆 WIN Sayacı</h2><div id="win" class="stat" style="font-size:70px">${String(state.wins).padStart(2,"0")} / ${state.maxWins}</div><div class="muted">-${state.penalty} CEZA</div><div class="row" style="margin-top:18px"><button onclick="chg(1)">+ WIN</button><button class="danger" onclick="chg(-1)">- WIN</button><button class="gold" onclick="chg(0)">SIFIRLA</button></div></div>
  <div class="card"><h3>Overlay Linki</h3><div class="code">https://msyayin.onrender.com/overlay/win</div></div>`,
  `async function load(){const s=await api("/api/state");win.textContent=String(s.wins).padStart(2,"0")+" / "+s.maxWins}async function chg(n){await api("/api/win",{method:"POST",body:JSON.stringify({change:n})});load()}load();setInterval(load,700)`);
}

function testPage(){
  return htmlShell("Test Merkezi","/test",`
  <div class="card"><h2>🧪 Test Merkezi</h2><div class="grid2">
  <div class="card"><h3>⭐ Puan</h3><div class="row"><input id="u1" value="test_kullanici"><input id="sc" type="number" min="1" max="10" value="10"><button onclick="tv()">TEST</button></div></div>
  <div class="card"><h3>🎁 Hediye</h3><div class="row"><input id="u2" value="test_kullanici"><input id="gi" value="Test Hediyesi"><button onclick="tg()">TEST</button></div></div>
  <div class="card"><h3>❤️ Beğeni</h3><div class="row"><input id="u3" value="test_kullanici"><input id="li" type="number" value="100"><button onclick="tl()">TEST</button></div></div>
  </div></div>
  <div class="card"><h3>Overlaylar</h3>
  <p><a href="/overlay/puanlama" target="_blank">Puanlama Overlay</a></p>
  <p><a href="/overlay/racon" target="_blank">Racon Overlay</a></p>
  <p><a href="/overlay/mekan" target="_blank">Mekan Overlay</a></p>
  <p><a href="/overlay/begeni" target="_blank">Beğeni Overlay</a></p>
  <p><a href="/overlay/win" target="_blank">WIN Overlay</a></p></div>`,
  `async function tv(){await api("/api/test/vote",{method:"POST",body:JSON.stringify({username:u1.value,score:sc.value})});alert("Test puanı gönderildi")}
   async function tg(){await api("/api/test/gift",{method:"POST",body:JSON.stringify({username:u2.value,gift:gi.value})});alert("Test hediyesi gönderildi")}
   async function tl(){await api("/api/test/like",{method:"POST",body:JSON.stringify({username:u3.value,count:li.value})});alert("Test beğenisi gönderildi")}`);
}

function guidePage(){
  return htmlShell("Kullanım Rehberi","/rehber",`
  <div class="card"><h2>📖 Kullanım Rehberi</h2><ol><li>Kullanıcı adını bağlantı bölümüne yaz.</li><li>Puanlama süresini ayarla ve başlat.</li><li>Racon/Mekan için tetiklenecek hediye adını seç.</li><li>Test Merkezi ile önce sistemi dene.</li><li>OBS/TikTok Live Studio'da overlay'a <b>tam URL</b> ver.</li></ol>
  <div class="code">https://msyayin.onrender.com/overlay/puanlama</div></div>`);
}

function overlay(type){
  const title={puanlama:"⭐ PUANLAMA",racon:"👑 RACON KRALI",mekan:"🏠 MEKAN SAHİBİ",begeni:"❤️ BEĞENİ SIRALAMASI",win:"🏆 WIN"}[type];
  return `<!doctype html><html lang="tr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
  <style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;color:#fff;font-family:Arial,sans-serif}.wrap{width:100%;height:100%;display:flex;align-items:center;justify-content:center}.box{min-width:360px;max-width:92vw;padding:24px 30px;border-radius:20px;background:rgba(5,6,9,.88);border:1px solid rgba(255,255,255,.14);box-shadow:0 16px 55px rgba(0,0,0,.4);text-align:center}.title{font-size:28px;font-weight:900;margin-bottom:12px}.big{font-size:60px;font-weight:950}.muted{opacity:.7}.row{display:flex;justify-content:space-between;gap:22px;padding:8px 0;border-bottom:1px solid rgba(255,255,255,.12);text-align:left}</style></head>
  <body><div class="wrap"><div class="box" id="box"><div class="title">${title}</div><div class="muted">Veri bekleniyor...</div></div></div>
  <script>
  function e(v){return String(v??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
  async function load(){try{const s=await fetch("/api/state",{cache:"no-store"}).then(r=>r.json());let h="";
  if(${json.dumps(type)}==="puanlama")h=s.scoring?'<div class="title">${title}</div><div class="big">'+e(s.average)+'</div><div>'+s.participants+' katılımcı · '+Math.max(0,Math.ceil((s.scoreEndsAt-Date.now())/1000))+' sn</div>':'<div class="title">${title}</div><div class="muted">Başlamayı bekliyor</div>';
  else if(${json.dumps(type)}==="racon")h='<div class="title">${title}</div>'+(s.lastRacon?'<div class="big">@'+e(s.lastRacon.username)+'</div><div>'+e(s.lastRacon.gift)+'</div>':'<div class="muted">Hediye bekleniyor</div>');
  else if(${json.dumps(type)}==="mekan")h='<div class="title">${title}</div>'+(s.lastMekan?'<div class="big">@'+e(s.lastMekan.username)+'</div><div>'+e(s.lastMekan.gift)+'</div>':'<div class="muted">Hediye bekleniyor</div>');
  else if(${json.dumps(type)}==="begeni")h='<div class="title">${title}</div>'+s.likes.slice(0,10).map((x,i)=>'<div class="row"><span>'+((i<3)?["🥇","🥈","🥉"][i]:(i+1)+".")+' @'+e(x.username)+'</span><b>'+Number(x.likeCount).toLocaleString("tr-TR")+' ❤️</b></div>').join("");
  else h='<div class="title">${title}</div><div class="big">'+String(s.wins).padStart(2,"0")+'/'+s.maxWins+'</div><div class="muted">-'+s.penalty+' CEZA</div>';
  document.getElementById("box").innerHTML=h;}catch{document.getElementById("box").innerHTML='<div class="title">${title}</div><div class="muted">Sunucu bağlantısı bekleniyor...</div>'}}
  load();setInterval(load,700);
  </script></body></html>`;
}

app.get("/",(_req,res)=>res.redirect("/connection"));
app.get("/connection",(_req,res)=>res.type("html").send(connectionPage()));
app.get("/puanlama",(_req,res)=>res.type("html").send(scorePage()));
app.get("/racon",(_req,res)=>res.type("html").send(giftPage("racon")));
app.get("/mekan",(_req,res)=>res.type("html").send(giftPage("mekan")));
app.get("/begeni",(_req,res)=>res.type("html").send(likesPage()));
app.get("/win",(_req,res)=>res.type("html").send(winPage()));
app.get("/test",(_req,res)=>res.type("html").send(testPage()));
app.get("/rehber",(_req,res)=>res.type("html").send(guidePage()));
app.get("/overlay",(req,res)=>res.type("html").send(`<h1>MS YAYIN Overlay</h1><p>Overlay seç:</p><ul>${["puanlama","racon","mekan","begeni","win"].map(t=>`<li><a href="/overlay/${t}">${t}</a></li>`).join("")}</ul>`));
app.get("/overlay/:type",(req,res)=>{
  if(!["puanlama","racon","mekan","begeni","win"].includes(req.params.type))return res.status(404).send("Overlay bulunamadı");
  res.type("html").send(overlay(req.params.type));
});

app.get("/api/state",(_req,res)=>res.json(snap()));
app.get("/api/health",(_req,res)=>res.json({ok:true,connected:state.connected}));
app.post("/api/connect",(req,res)=>{const u=clean(req.body?.username);if(!u)return res.status(400).json({message:"TikTok kullanıcı adı gerekli."});state.username=u;state.connected=true;res.json({ok:true,message:"Kullanıcı adı kaydedildi (demo bağlantı)."});});
app.post("/api/disconnect",(_req,res)=>{state.username="";state.connected=false;res.json(snap())});
app.post("/api/score/settings",(req,res)=>{const n=Number(req.body?.duration);if(!Number.isFinite(n)||n<1||n>3600)return res.status(400).json({message:"Süre 1–3600 saniye olmalı."});state.scoreDuration=Math.floor(n);res.json(snap())});
app.post("/api/score/start",(_req,res)=>{state.votes=[];state.scoring=true;state.scoreEndsAt=Date.now()+state.scoreDuration*1000;setTimeout(()=>{if(state.scoring&&Date.now()>=state.scoreEndsAt){state.scoring=false;state.scoreEndsAt=0}},state.scoreDuration*1000+50);res.json(snap())});
app.post("/api/score/stop",(_req,res)=>{state.scoring=false;state.scoreEndsAt=0;res.json(snap())});
app.post("/api/gift-rule",(req,res)=>{const t=req.body?.type,g=clean(req.body?.gift);if(!["racon","mekan"].includes(t)||!g)return res.status(400).json({message:"Hediye adı gerekli."});if(t==="racon")state.raconGift=g;else state.mekanGift=g;res.json(snap())});
app.post("/api/gift-rule/clear",(req,res)=>{if(req.body?.type==="racon")state.raconGift="";else if(req.body?.type==="mekan")state.mekanGift="";else return res.status(400).json({message:"Geçersiz sistem."});res.json(snap())});
app.post("/api/likes/reset",(_req,res)=>{state.likes={};res.json(snap())});
app.post("/api/win",(req,res)=>{const c=Number(req.body?.change);if(c===0)state.wins=0;else if(c===1)state.wins=Math.min(state.maxWins,state.wins+1);else if(c===-1)state.wins=Math.max(0,state.wins-1);else return res.status(400).json({message:"Geçersiz WIN."});res.json(snap())});
app.post("/api/test/vote",(req,res)=>{if(!state.scoring){state.scoring=true;state.scoreEndsAt=Date.now()+state.scoreDuration*1000}addVote(req.body?.username,req.body?.score);res.json(snap())});
app.post("/api/test/like",(req,res)=>{const u=clean(req.body?.username)||"test";const n=Math.max(1,Number(req.body?.count)||1);if(!state.likes[u])state.likes[u]={count:0};state.likes[u].count+=n;res.json(snap())});
app.post("/api/test/gift",(req,res)=>{addGift(req.body?.username,req.body?.gift);res.json(snap())});

function addVote(user,score){if(!state.scoring)return;const n=Number(score);if(!Number.isInteger(n)||n<1||n>10)return;state.votes.push({username:clean(user)||"test",score:n,at:Date.now()})}
function addGift(user,g){const u=clean(user)||"test",gift=clean(g)||"Hediye";if(state.raconGift&&state.raconGift.toLowerCase()===gift.toLowerCase()){if(!state.racon[u])state.racon[u]={username:u,count:0,gift};state.racon[u].count++;state.lastRacon={username:u,gift,at:Date.now()}}if(state.mekanGift&&state.mekanGift.toLowerCase()===gift.toLowerCase()){if(!state.mekan[u])state.mekan[u]={username:u,count:0,gift};state.mekan[u].count++;state.lastMekan={username:u,gift,at:Date.now()}}}

server.listen(PORT,"0.0.0.0",()=>console.log("MS YAYIN listening on",PORT));
