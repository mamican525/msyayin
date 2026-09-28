const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { WebcastPushConnection } = require("tiktok-live-connector");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 10000;

app.use(express.json());
app.use(express.urlencoded({extended:true}));

const rooms = new Map();
const connections = new Map();

function id() { return crypto.randomBytes(3).toString("hex").toUpperCase(); }
function roomState(room) {
  if (!rooms.has(room)) rooms.set(room, {
    room, connected:false, username:"",
    scoreDuration:15, scoring:false, scoreEndsAt:0,
    votes:[], likes:new Map(), giftRules:[], wins:0, penalty:20,
    lastGift:null
  });
  return rooms.get(room);
}
function cleanUser(u){ return (u || "").replace(/^@/,"").trim(); }

function publicState(s){
  return {
    room:s.room, connected:s.connected, username:s.username,
    scoreDuration:s.scoreDuration, scoring:s.scoring, scoreEndsAt:s.scoreEndsAt,
    votes:s.votes.slice(-100).reverse(),
    average:s.votes.length ? +(s.votes.reduce((a,v)=>a+v.score,0)/s.votes.length).toFixed(2) : 0,
    participants:new Set(s.votes.map(v=>v.username)).size,
    likes:[...s.likes.entries()].map(([username,likeCount])=>({username,likeCount}))
      .sort((a,b)=>b.likeCount-a.likeCount).slice(0,100),
    giftRules:s.giftRules, wins:s.wins, penalty:s.penalty, lastGift:s.lastGift
  };
}
function broadcast(s){ io.to(s.room).emit("state", publicState(s)); }

app.get("/", (req,res)=>res.send(page("panel")));
app.get("/panel", (req,res)=>res.send(page("panel")));
app.get("/overlay", (req,res)=>res.send(page("overlay")));
app.get("/health", (req,res)=>res.json({ok:true,rooms:rooms.size}));

function page(kind){
return `<!doctype html><html lang="tr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MS Yayın Paneli</title><script src="/socket.io/socket.io.js"></script>
<style>
*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:#090a0f;color:#f5f5f5}
button,input,select{font:inherit}button{cursor:pointer;border:0;border-radius:10px;padding:11px 15px;background:#e53935;color:#fff;font-weight:700}
input,select{background:#141720;color:#fff;border:1px solid #2a2f3c;border-radius:9px;padding:10px}
.panel{display:flex;min-height:100vh}.side{width:250px;background:#0f1118;border-right:1px solid #252936;padding:22px;position:fixed;inset:0 auto 0 0}
.logo{font-size:22px;font-weight:900;margin-bottom:25px}.logo span{color:#e53935}
.nav button{display:block;width:100%;text-align:left;background:transparent;margin:4px 0;color:#cdd1dc}.nav button.active,.nav button:hover{background:#1c202b;color:#fff}
.main{margin-left:250px;padding:28px;width:calc(100% - 250px)}.top{display:flex;justify-content:space-between;gap:15px;align-items:center;margin-bottom:25px}
.card{background:#11141d;border:1px solid #252a37;border-radius:16px;padding:20px;margin-bottom:18px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:15px}
.stat{font-size:28px;font-weight:900}.muted{color:#8f96a7}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.danger{background:#a91e2a}.green{background:#17804d}.gold{background:#9b6b12}.hidden{display:none}
.list{max-height:360px;overflow:auto}.item{padding:10px;border-bottom:1px solid #252936;display:flex;justify-content:space-between}
.badge{padding:5px 9px;border-radius:20px;background:#242938}.overlay{min-height:100vh;display:grid;place-items:center;background:transparent}.box{background:rgba(8,9,14,.88);border:1px solid rgba(255,255,255,.12);border-radius:20px;padding:28px;min-width:420px;text-align:center;box-shadow:0 20px 60px #0008}.big{font-size:54px;font-weight:900}.title{font-size:25px;font-weight:800;margin-bottom:12px}
@media(max-width:850px){.side{width:190px}.main{margin-left:190px;width:calc(100% - 190px)}.grid{grid-template-columns:1fr}}
</style></head><body>${kind==="panel"?panelHtml():overlayHtml()}</body></html>`;
}

function panelHtml(){
return `<div class="panel"><aside class="side"><div class="logo">🔥 MS <span>YAYIN</span></div>
<div class="nav">
<button onclick="show('connection')">🔴 Yayın Bağlantısı</button>
<button onclick="show('score')">⭐ Puanlama</button>
<button onclick="show('racon')">👑 Racon Kralları</button>
<button onclick="show('mekan')">🏠 Mekan Sahibi</button>
<button onclick="show('likes')">❤️ Beğeni Sıralaması</button>
<button onclick="show('win')">🏆 WIN Sayacı</button>
<button onclick="show('test')">🧪 Test Merkezi</button>
<button onclick="show('guide')">📖 Kullanım Rehberi</button>
</div></aside>
<main class="main"><div class="top"><div><h1>Yayın Yönetim Paneli</h1><div class="muted">Room sistemi · tek panel · tüm overlaylar</div></div>
<div class="row"><input id="room" placeholder="ROOM KODU"><button onclick="enterRoom()">Odaya Gir</button></div></div>
<div id="app"></div></main></div>
<script>
const socket=io(); let room=localStorage.getItem("ms_room")||"";
const appEl=document.getElementById("app");
function api(path,body){return fetch(path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({...body,room})}).then(r=>r.json())}
function enterRoom(){room=(document.getElementById("room").value||"").trim().toUpperCase(); if(!room) room=Math.random().toString(36).slice(2,8).toUpperCase(); localStorage.setItem("ms_room",room); socket.emit("join",room); show("connection")}
function show(tab){
const views={
connection:\`<div class="card"><h2>🔴 Yayın Bağlantısı</h2><p class="muted">TikTok kullanıcı adını gir ve canlı bağlantıyı başlat.</p><div class="row"><input id="ttuser" placeholder="@kullanici" value=""><button onclick="connectTikTok()">BAĞLAN</button></div><p>Room: <b>\${room||"henüz yok"}</b> · Durum: <b id="conn">—</b></p></div>\`,
score:\`<div class="card"><h2>⭐ Puanlama</h2><div class="row"><label>Süre (saniye) <input id="dur" type="number" min="1" value="15"></label><button onclick="setDuration()">Kaydet</button><button class="green" onclick="startScore()">PUANLAMAYI BAŞLAT</button><button class="danger" onclick="stopScore()">BİTİR</button></div><div class="grid"><div class="card"><span class="muted">Ortalama</span><div class="stat" id="avg">0</div></div><div class="card"><span class="muted">Katılımcı</span><div class="stat" id="parts">0</div></div><div class="card"><span class="muted">Kalan</span><div class="stat" id="left">—</div></div></div><div id="votes" class="list"></div></div>\`,
racon:\`<div class="card"><h2>👑 Racon Kralları</h2><p class="muted">Bir hediye geldiğinde gönderen otomatik gösterilir.</p><div class="row"><input id="giftR" placeholder="Hediye adı, örn. Aslan"><button onclick="addRule('racon')">Racon hediyesi ekle</button></div><div id="rulesR" class="list"></div></div>\`,
mekan:\`<div class="card"><h2>🏠 Mekan Sahibi</h2><p class="muted">Seçtiğin hediye geldiğinde gönderen otomatik gösterilir.</p><div class="row"><input id="giftM" placeholder="Hediye adı, örn. Galaksi"><button onclick="addRule('mekan')">Mekan hediyesi ekle</button></div><div id="rulesM" class="list"></div></div>\`,
likes:\`<div class="card"><h2>❤️ Beğeni Sıralaması</h2><button class="danger" onclick="resetLikes()">Beğenileri Sıfırla</button><div id="likes" class="list"></div></div>\`,
win:\`<div class="card"><h2>🏆 WIN Sayacı</h2><div class="stat" id="wins">00 / 20</div><div class="row"><button onclick="win(1)">+ WIN</button><button class="danger" onclick="win(-1)">- WIN</button><button class="gold" onclick="win(0)">SIFIRLA</button></div></div>\`,
test:\`<div class="card"><h2>🧪 Test Merkezi</h2><p class="muted">TikTok gelmiş gibi sahte veri gönder.</p><div class="row"><input id="tu" placeholder="kullanici" value="test_kullanici"><input id="ts" type="number" min="1" max="10" value="10"><button onclick="testVote()">Test Puanı</button><input id="tg" placeholder="Hediye adı"><button onclick="testGift()">Test Hediye</button><input id="tl" type="number" value="100"><button onclick="testLike()">Test Beğeni</button></div></div>\`,
guide:\`<div class="card"><h2>📖 Kullanım Rehberi</h2><ol><li>Önce bir Room kodu oluştur veya mevcut Room'a gir.</li><li>TikTok kullanıcı adını Yayın Bağlantısı bölümünden bağla.</li><li>Hediye adlarını Racon/Mekan bölümlerine ekle.</li><li>Puanlama süresini seç ve başlat.</li><li>OBS/TikTok Live Studio'ya overlay URL'sini Browser Source olarak ekle.</li></ol><p><b>Overlay:</b> <code>\${location.origin}/overlay?room=\${room||"ROOM"}&type=all</code></p></div>\`
}; appEl.innerHTML=views[tab]||views.connection; updateFromLast()}
function setDuration(){api("/api/duration",{duration:+document.getElementById("dur").value}).then(update)}
function startScore(){api("/api/score/start",{}).then(update)}
function stopScore(){api("/api/score/stop",{}).then(update)}
function connectTikTok(){api("/api/connect",{username:document.getElementById("ttuser").value}).then(r=>{alert(r.message);update()})}
function addRule(type){const el=document.getElementById(type==="racon"?"giftR":"giftM"); api("/api/rule",{gift:el.value,type}).then(update)}
function resetLikes(){api("/api/likes/reset",{}).then(update)}
function win(n){api("/api/win",{change:n}).then(update)}
function testVote(){api("/api/test/vote",{username:document.getElementById("tu").value,score:+document.getElementById("ts").value}).then(update)}
function testGift(){api("/api/test/gift",{username:document.getElementById("tu").value,gift:document.getElementById("tg").value}).then(update)}
function testLike(){api("/api/test/like",{username:document.getElementById("tu").value,count:+document.getElementById("tl").value}).then(update)}
function update(){return fetch("/api/state?room="+encodeURIComponent(room)).then(r=>r.json()).then(updateState)}
let last=null; function updateFromLast(){if(last) updateState(last)}
function updateState(s){last=s; const q=id=>document.getElementById(id); if(!s)return;
if(q("conn"))q("conn").textContent=s.connected?"🟢 BAĞLI":"🔴 BAĞLI DEĞİL";
if(q("avg"))q("avg").textContent=s.average;if(q("parts"))q("parts").textContent=s.participants;
if(q("wins"))q("wins").textContent=String(s.wins).padStart(2,"0")+" / 20";
if(q("votes"))q("votes").innerHTML=s.votes.map(v=>'<div class="item"><span>@'+v.username+'</span><b>'+v.score+'</b></div>').join("");
if(q("likes"))q("likes").innerHTML=s.likes.map((v,i)=>'<div class="item"><span>'+(i<3?["🥇","🥈","🥉"][i]:"")+" @"+v.username+'</span><b>'+v.likeCount.toLocaleString()+" ❤️</b></div>").join("");
if(q("rulesR"))q("rulesR").innerHTML=s.giftRules.filter(x=>x.type==="racon").map(x=>'<div class="item">'+x.gift+' <span class="badge">👑 Racon</span></div>').join("");
if(q("rulesM"))q("rulesM").innerHTML=s.giftRules.filter(x=>x.type==="mekan").map(x=>'<div class="item">'+x.gift+' <span class="badge">🏠 Mekan</span></div>').join("");
if(q("dur"))q("dur").value=s.scoreDuration;
}
socket.on("state",s=>{if(!room||s.room===room)updateState(s)}); if(room){document.getElementById("room").value=room;socket.emit("join",room);update()} else show("connection"); setInterval(()=>{if(last&&last.scoring&&document.getElementById("left"))document.getElementById("left").textContent=Math.max(0,Math.ceil((last.scoreEndsAt-Date.now())/1000))+" sn"},250);
</script>`;
}

function overlayHtml(){
return `<div class="overlay"><div class="box" id="box"><div class="title">MS YAYIN</div><div class="muted">Room bekleniyor...</div></div></div>
<script>
const p=new URLSearchParams(location.search), room=p.get("room"), type=p.get("type")||"all", socket=io();
socket.emit("join",room);
socket.on("state",s=>{
 let b=document.getElementById("box"), html="";
 if(type==="puanlama"||type==="all") html+=s.scoring?'<div class="title">⭐ PUANLAMA</div><div class="big">'+s.average+'</div><div>'+s.participants+' katılımcı · '+Math.max(0,Math.ceil((s.scoreEndsAt-Date.now())/1000))+' sn</div>':'';
 if(type==="racon") html='<div class="title">👑 RACON KRALI</div><div class="big">'+(s.lastGift?.type==="racon"?"@"+s.lastGift.username:"")+'</div>';
 if(type==="mekan") html='<div class="title">🏠 MEKAN SAHİBİ</div><div class="big">'+(s.lastGift?.type==="mekan"?"@"+s.lastGift.username:"")+'</div>';
 if(type==="begeni"){html='<div class="title">❤️ BEĞENİ SIRALAMASI</div>'+s.likes.slice(0,10).map((x,i)=>'<div class="item">'+(i+1)+'. @'+x.username+' — '+x.likeCount.toLocaleString()+' ❤️</div>').join("")}
 if(type==="win") html='<div class="title">🏆 WIN</div><div class="big">'+String(s.wins).padStart(2,"0")+'/20</div>';
 if(type==="all") html='<div class="title">⭐ PUAN '+s.average+'</div><div>'+s.participants+' katılımcı</div><hr><div class="title">🏆 WIN '+String(s.wins).padStart(2,"0")+'/20</div>'+ (s.lastGift?'<div class="title">🎁 @'+s.lastGift.username+'</div>':'');
 b.innerHTML=html||'<div class="muted">Bekleniyor...</div>';
});
</script>`;
}

app.get("/api/state",(req,res)=>res.json(publicState(roomState((req.query.room||"").toUpperCase()))));

app.post("/api/duration",(req,res)=>{const s=roomState((req.body.room||"").toUpperCase()); s.scoreDuration=Math.max(1,Number(req.body.duration)||15); broadcast(s);res.json(publicState(s));});
app.post("/api/score/start",(req,res)=>{const s=roomState((req.body.room||"").toUpperCase()); s.scoring=true;s.votes=[];s.scoreEndsAt=Date.now()+s.scoreDuration*1000;broadcast(s);setTimeout(()=>{if(Date.now()>=s.scoreEndsAt){s.scoring=false;broadcast(s)}},s.scoreDuration*1000+100);res.json(publicState(s));});
app.post("/api/score/stop",(req,res)=>{const s=roomState((req.body.room||"").toUpperCase());s.scoring=false;broadcast(s);res.json(publicState(s));});
app.post("/api/rule",(req,res)=>{const s=roomState((req.body.room||"").toUpperCase());const gift=String(req.body.gift||"").trim();if(gift)s.giftRules.push({gift,type:req.body.type});broadcast(s);res.json(publicState(s));});
app.post("/api/likes/reset",(req,res)=>{const s=roomState((req.body.room||"").toUpperCase());s.likes.clear();broadcast(s);res.json(publicState(s));});
app.post("/api/win",(req,res)=>{const s=roomState((req.body.room||"").toUpperCase());s.wins=req.body.change===0?0:Math.max(0,s.wins+(Number(req.body.change)||0));broadcast(s);res.json(publicState(s));});
app.post("/api/test/vote",(req,res)=>{const s=roomState((req.body.room||"").toUpperCase());if(s.scoring){s.votes.push({username:cleanUser(req.body.username),score:Math.max(1,Math.min(10,Number(req.body.score)||1)),time:Date.now()});broadcast(s)}res.json(publicState(s));});
app.post("/api/test/like",(req,res)=>{const s=roomState((req.body.room||"").toUpperCase());const u=cleanUser(req.body.username)||"test";s.likes.set(u,(s.likes.get(u)||0)+Math.max(1,Number(req.body.count)||1));broadcast(s);res.json(publicState(s));});
app.post("/api/test/gift",(req,res)=>{const s=roomState((req.body.room||"").toUpperCase());handleGift(s,cleanUser(req.body.username)||"test",String(req.body.gift||"Test Hediyesi"));res.json(publicState(s));});

function handleGift(s,username,gift){
 const rules=s.giftRules.filter(r=>r.gift.toLowerCase()===gift.toLowerCase());
 const hit=rules[0];
 s.lastGift={username,gift,type:hit?.type||"none",time:Date.now()};
 broadcast(s);
}

app.post("/api/connect",async(req,res)=>{
 const room=(req.body.room||"").toUpperCase(), username=cleanUser(req.body.username);
 if(!room||!username)return res.json({ok:false,message:"Room ve TikTok kullanıcı adı gerekli."});
 if(connections.has(room)) try{await connections.get(room).disconnect()}catch{}
 const s=roomState(room); s.username=username;
 const conn=new WebcastPushConnection(username,{processInitialData:false});
 connections.set(room,conn);
 conn.on("connected",()=>{s.connected=true;broadcast(s)});
 conn.on("disconnected",()=>{s.connected=false;broadcast(s)});
 conn.on("error",()=>{s.connected=false;broadcast(s)});
 conn.on("chat",d=>{
   if(!s.scoring)return;
   const m=String(d.comment||"").trim();
   const n=Number(m.replace(/[^\d]/g,""));
   if(n>=1&&n<=10){s.votes.push({username:cleanUser(d.uniqueId||d.nickname),score:n,time:Date.now()});broadcast(s)}
 });
 conn.on("like",d=>{
   const u=cleanUser(d.uniqueId||d.nickname)||"bilinmeyen";
   const count=Number(d.likeCount||d.totalLikeCount||1)||1;
   s.likes.set(u,(s.likes.get(u)||0)+count);broadcast(s);
 });
 conn.on("gift",d=>{
   const u=cleanUser(d.uniqueId||d.nickname)||"bilinmeyen";
   const gift=String(d.giftName||d.gift||"Hediye");
   handleGift(s,u,gift);
 });
 try{await conn.connect();res.json({ok:true,message:"TikTok bağlantısı başlatıldı."})}
 catch(e){s.connected=false;broadcast(s);res.json({ok:false,message:"TikTok bağlantısı kurulamadı: "+e.message})}
});

io.on("connection",socket=>socket.on("join",room=>{room=String(room||"").toUpperCase();if(room){socket.join(room);socket.emit("state",publicState(roomState(room)))}}));

server.listen(PORT,()=>console.log("MS Yayin running on "+PORT));
