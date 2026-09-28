
"use strict";

const express = require("express");
const http = require("http");

const TikTokModule = require("tiktok-live-connector");
const WebcastPushConnection =
  TikTokModule?.WebcastPushConnection ||
  TikTokModule?.default?.WebcastPushConnection ||
  TikTokModule?.default;

if (typeof WebcastPushConnection !== "function") {
  throw new Error("WebcastPushConnection bulunamadı.");
}

const app = express();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 10000);

app.use(express.json({ limit: "50kb" }));

const state = {
  username: "",
  status: "disconnected", // disconnected | connecting | connected | error
  message: "Kullanıcı adı bekleniyor.",
  connectedAt: 0
};

let connection = null;

function cleanUsername(value) {
  return String(value || "").replace(/^@+/, "").trim().slice(0, 80);
}

function htmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  }[c] || c));
}

function disconnectExisting() {
  if (!connection) return Promise.resolve();
  const old = connection;
  connection = null;
  try {
    if (typeof old.disconnect === "function") {
      return Promise.resolve(old.disconnect()).catch(() => {});
    }
  } catch (_) {}
  return Promise.resolve();
}

async function connectTikTok(username) {
  const user = cleanUsername(username);
  if (!user) throw new Error("TikTok kullanıcı adı gerekli.");

  await disconnectExisting();

  state.username = user;
  state.status = "connecting";
  state.message = `@${user} canlı yayını aranıyor...`;
  state.connectedAt = 0;

  const client = new WebcastPushConnection(user, {
    processInitialData: false
  });

  connection = client;

  client.on("connected", () => {
    if (connection !== client) return;
    state.status = "connected";
    state.message = `@${user} yayınına bağlı`;
    state.connectedAt = Date.now();
  });

  client.on("disconnected", () => {
    if (connection !== client) return;
    state.status = "disconnected";
    state.message = "TikTok bağlantısı kesildi.";
  });

  client.on("streamEnd", () => {
    if (connection !== client) return;
    state.status = "disconnected";
    state.message = "Canlı yayın sona erdi.";
  });

  client.on("error", (error) => {
    if (connection !== client) return;
    state.status = "error";
    state.message = error?.message || "TikTok bağlantı hatası.";
  });

  await client.connect();

  return {
    ok: true,
    status: state.status,
    message: state.message
  };
}

function snapshot() {
  return {
    username: state.username,
    status: state.status,
    message: state.message,
    connected: state.status === "connected",
    connecting: state.status === "connecting"
  };
}

const PAGE = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MS YAYIN - TikTok Bağlantısı</title>
<style>
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;font-family:Segoe UI,Arial,sans-serif;background:#090a0e;color:#fff}
body{display:flex;align-items:center;justify-content:center;padding:30px}
.panel{width:min(900px,100%);background:#14161d;border:1px solid #262a34;border-radius:18px;padding:30px;box-shadow:0 20px 80px rgba(0,0,0,.35)}
.top{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:26px}
h1{margin:0;font-size:30px}.brand{font-weight:900}.brand span{color:#ef4444}
.status{padding:10px 16px;border-radius:999px;border:1px solid #303642;font-weight:800}
.status.ok{color:#55dc97}.status.wait{color:#ffd166}.status.bad{color:#ff7b7b}
.card{background:#181a21;border:1px solid #242934;border-radius:14px;padding:20px}
.label{font-weight:800;margin-bottom:10px}
.row{display:flex;gap:12px}.row input{flex:1;min-width:0}
input{height:50px;border:1px solid #303540;background:#0a0b0f;color:#fff;border-radius:10px;padding:0 16px;font-size:16px;outline:none}
input:focus{border-color:#4a5568}
button{height:50px;border:0;border-radius:10px;padding:0 23px;font-weight:900;cursor:pointer;color:#fff}
.connect{background:#3a63a8}.disconnect{background:#e53f46}
.message{margin-top:15px;background:#101217;border-radius:10px;padding:15px;color:#a8aebb;word-break:break-word}
.help{margin-top:13px;color:#7f8798;font-size:14px}
.badge{font-size:18px}
@media(max-width:700px){body{padding:15px}.panel{padding:18px}.top{display:block}.status{display:inline-block;margin-top:15px}.row{flex-direction:column}button{width:100%}}
</style>
</head>
<body>
<section class="panel">
  <div class="top">
    <h1>📡 TikTok Bağlantısı</h1>
    <div id="status" class="status bad">🔴 Bağlı değil</div>
  </div>

  <div class="card">
    <div class="label">TikTok kullanıcı adı</div>
    <div class="row">
      <input id="username" placeholder="@kullaniciadi" value="">
      <button class="connect" id="connect">BAĞLAN</button>
      <button class="disconnect" id="disconnect">KOPAR</button>
    </div>
    <div id="message" class="message">Canlı yayın yapan hesabın kullanıcı adını girin. Yayın aktif olmalıdır.</div>
    <div class="help">Room kodu yok. Ekstra kod yok. Sadece kullanıcı adı.</div>
  </div>
</section>

<script>
const statusEl = document.getElementById("status");
const messageEl = document.getElementById("message");
const usernameEl = document.getElementById("username");

function paint(s){
  if(s.status === "connected"){
    statusEl.textContent = "🟢 @" + s.username + " yayınına bağlı";
    statusEl.className = "status ok";
  }else if(s.status === "connecting"){
    statusEl.textContent = "🟡 Bağlanıyor...";
    statusEl.className = "status wait";
  }else if(s.status === "error"){
    statusEl.textContent = "🔴 Bağlantı hatası";
    statusEl.className = "status bad";
  }else{
    statusEl.textContent = "🔴 Bağlı değil";
    statusEl.className = "status bad";
  }
  messageEl.textContent = s.message;
  if(s.username && !usernameEl.value) usernameEl.value = s.username;
}

async function state(){
  const r = await fetch("/api/state",{cache:"no-store"});
  paint(await r.json());
}

document.getElementById("connect").onclick = async () => {
  const username = usernameEl.value.trim();
  if(!username){
    messageEl.textContent = "Önce TikTok kullanıcı adını yaz.";
    usernameEl.focus();
    return;
  }
  messageEl.textContent = "TikTok canlı yayını aranıyor...";
  try{
    const r = await fetch("/api/connect",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({username})
    });
    const d = await r.json();
    if(!r.ok) throw new Error(d.message || "Bağlantı kurulamadı.");
    paint(d);
  }catch(e){
    paint({status:"error",username,message:e.message});
  }
};

document.getElementById("disconnect").onclick = async () => {
  const r = await fetch("/api/disconnect",{method:"POST"});
  paint(await r.json());
};

state();
setInterval(state,1000);
</script>
</body>
</html>`;

app.get("/", (_req, res) => res.type("html").send(PAGE));
app.get("/api/state", (_req, res) => res.json(snapshot()));

app.post("/api/connect", async (req, res) => {
  try {
    const result = await connectTikTok(req.body?.username);
    res.json({
      ...snapshot(),
      ok: result.ok
    });
  } catch (error) {
    state.status = "error";
    state.message = error?.message || "TikTok bağlantısı kurulamadı.";
    res.status(400).json({
      ...snapshot(),
      ok: false
    });
  }
});

app.post("/api/disconnect", async (_req, res) => {
  await disconnectExisting();
  state.username = "";
  state.status = "disconnected";
  state.message = "Bağlantı kesildi.";
  state.connectedAt = 0;
  res.json(snapshot());
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, status: state.status });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log("MS YAYIN TikTok bağlantı paneli:", PORT);
});
