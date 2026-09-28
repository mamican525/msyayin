const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 10000);

app.use(express.json({ limit: "256kb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const rooms = new Map();

const DEFAULT_GIFTS = [
  "Rose", "Finger Heart", "Galaxy", "TikTok Universe",
  "Lion", "Fireworks", "GG", "Perfume"
];

function cleanUser(value) {
  return String(value || "").replace(/^@+/, "").trim().slice(0, 80);
}

function makeRoomCode() {
  let code;
  do {
    code = "MS-" + crypto.randomBytes(3).toString("hex").toUpperCase();
  } while (rooms.has(code));
  return code;
}

function newRoom() {
  return {
    room: null,
    createdAt: Date.now(),
    connected: false,
    tiktokUsername: "",
    scoreDuration: 15,
    scoring: false,
    scoreEndsAt: 0,
    votes: [],
    likes: new Map(),
    giftRules: {
      racon: "",
      mekan: ""
    },
    giftHistory: [],
    raconList: [],
    mekanList: [],
    wins: 0,
    maxWins: 20,
    penalties: 0,
    lastGift: null
  };
}

function getRoom(code) {
  const key = String(code || "").trim().toUpperCase();
  if (!key) return null;
  if (!rooms.has(key)) {
    const s = newRoom();
    s.room = key;
    rooms.set(key, s);
  }
  return rooms.get(key);
}

function publicState(s) {
  const voteCount = s.votes.length;
  const average = voteCount
    ? Number((s.votes.reduce((sum, v) => sum + v.score, 0) / voteCount).toFixed(2))
    : 0;

  const participants = new Set(s.votes.map(v => v.username)).size;

  const likes = [...s.likes.entries()]
    .map(([username, value]) => ({
      username,
      likeCount: Number(value?.likeCount || 0),
      avatarUrl: value?.avatarUrl || ""
    }))
    .sort((a,b) => b.likeCount - a.likeCount)
    .slice(0, 100);

  return {
    room: s.room,
    createdAt: s.createdAt,
    connected: s.connected,
    tiktokUsername: s.tiktokUsername,
    scoreDuration: s.scoreDuration,
    scoring: s.scoring,
    scoreEndsAt: s.scoreEndsAt,
    average,
    participants,
    votes: s.votes.slice(-100).reverse(),
    likes,
    giftRules: s.giftRules,
    giftHistory: s.giftHistory.slice(-50).reverse(),
    raconList: s.raconList.slice(-50).reverse(),
    mekanList: s.mekanList.slice(-50).reverse(),
    wins: s.wins,
    maxWins: s.maxWins,
    penalties: s.penalties,
    lastGift: s.lastGift
  };
}

function broadcast(s) {
  io.to(s.room).emit("state", publicState(s));
}

function addLike(s, username, count, avatarUrl = "") {
  username = cleanUser(username) || "bilinmeyen";
  count = Math.max(1, Math.floor(Number(count) || 1));

  const previous = s.likes.get(username);
  if (previous && typeof previous === "object") {
    previous.likeCount += count;
  } else {
    s.likes.set(username, { likeCount: count, avatarUrl });
  }
}

function addVote(s, username, score) {
  username = cleanUser(username) || "bilinmeyen";
  score = Math.max(1, Math.min(10, Math.floor(Number(score) || 1)));
  s.votes.push({ username, score, time: Date.now() });
}

function triggerGift(s, username, gift, avatarUrl = "", forcedType = "") {
  username = cleanUser(username) || "bilinmeyen";
  gift = String(gift || "").trim().slice(0, 100) || "Hediye";

  let type = forcedType || "";
  if (!type) {
    if (s.giftRules.racon && s.giftRules.racon.toLowerCase() === gift.toLowerCase()) type = "racon";
    if (s.giftRules.mekan && s.giftRules.mekan.toLowerCase() === gift.toLowerCase()) type = "mekan";
  }

  const item = {
    id: crypto.randomBytes(4).toString("hex"),
    username,
    gift,
    avatarUrl,
    type,
    time: Date.now()
  };

  s.giftHistory.push(item);
  s.lastGift = item;

  if (type === "racon") s.raconList.push(item);
  if (type === "mekan") s.mekanList.push(item);
}

function createRoomHandler(req, res) {
  const code = makeRoomCode();
  getRoom(code);
  res.json({ ok: true, room: code, panelUrl: `/panel?room=${encodeURIComponent(code)}` });
}

app.get("/", (req, res) => {
  res.sendFile("index.html", { root: "public" });
});

app.get("/panel", (req, res) => {
  res.sendFile("panel.html", { root: "public" });
});

app.get("/overlay", (req, res) => {
  res.sendFile("overlay.html", { root: "public" });
});

app.get("/api/room", createRoomHandler);

app.post("/api/room", createRoomHandler);

app.get("/api/state", (req, res) => {
  const state = getRoom(req.query.room);
  if (!state) return res.status(400).json({ ok: false, error: "Room gerekli." });
  res.json({ ok: true, state: publicState(state) });
});

app.post("/api/settings/duration", (req, res) => {
  const s = getRoom(req.body.room);
  if (!s) return res.status(400).json({ ok:false, error:"Room gerekli." });
  const duration = Math.max(1, Math.min(3600, Math.floor(Number(req.body.duration) || 15)));
  s.scoreDuration = duration;
  broadcast(s);
  res.json({ ok:true, state:publicState(s) });
});

app.post("/api/score/start", (req, res) => {
  const s = getRoom(req.body.room);
  if (!s) return res.status(400).json({ ok:false, error:"Room gerekli." });

  s.votes = [];
  s.scoring = true;
  s.scoreEndsAt = Date.now() + s.scoreDuration * 1000;
  broadcast(s);

  setTimeout(() => {
    if (s.scoring && Date.now() >= s.scoreEndsAt) {
      s.scoring = false;
      s.scoreEndsAt = 0;
      broadcast(s);
    }
  }, s.scoreDuration * 1000 + 150);

  res.json({ ok:true, state:publicState(s) });
});

app.post("/api/score/stop", (req, res) => {
  const s = getRoom(req.body.room);
  if (!s) return res.status(400).json({ ok:false, error:"Room gerekli." });
  s.scoring = false;
  s.scoreEndsAt = 0;
  broadcast(s);
  res.json({ ok:true, state:publicState(s) });
});

app.post("/api/gift-rule", (req, res) => {
  const s = getRoom(req.body.room);
  if (!s) return res.status(400).json({ ok:false, error:"Room gerekli." });
  const type = req.body.type === "mekan" ? "mekan" : "racon";
  s.giftRules[type] = String(req.body.gift || "").trim().slice(0,100);
  broadcast(s);
  res.json({ ok:true, state:publicState(s) });
});

app.post("/api/tiktok-user", (req, res) => {
  const s = getRoom(req.body.room);
  if (!s) return res.status(400).json({ ok:false, error:"Room gerekli." });
  s.tiktokUsername = cleanUser(req.body.username);
  s.connected = false;
  broadcast(s);
  res.json({ ok:true, state:publicState(s) });
});

app.post("/api/reset/likes", (req, res) => {
  const s = getRoom(req.body.room);
  if (!s) return res.status(400).json({ ok:false, error:"Room gerekli." });
  s.likes.clear();
  broadcast(s);
  res.json({ ok:true, state:publicState(s) });
});

app.post("/api/win", (req, res) => {
  const s = getRoom(req.body.room);
  if (!s) return res.status(400).json({ ok:false, error:"Room gerekli." });

  const change = Math.floor(Number(req.body.change) || 0);
  if (change === 0) {
    s.wins = 0;
    s.penalties = 0;
  } else {
    s.wins = Math.max(0, Math.min(s.maxWins, s.wins + change));
    if (change < 0) s.penalties += Math.abs(change);
  }
  broadcast(s);
  res.json({ ok:true, state:publicState(s) });
});

app.post("/api/test/vote", (req,res) => {
  const s = getRoom(req.body.room);
  if (!s) return res.status(400).json({ ok:false, error:"Room gerekli." });
  if (!s.scoring) return res.status(400).json({ ok:false, error:"Önce puanlamayı başlat." });
  addVote(s, req.body.username, req.body.score);
  broadcast(s);
  res.json({ ok:true, state:publicState(s) });
});

app.post("/api/test/like", (req,res) => {
  const s = getRoom(req.body.room);
  if (!s) return res.status(400).json({ ok:false, error:"Room gerekli." });
  addLike(s, req.body.username, req.body.count, req.body.avatarUrl);
  broadcast(s);
  res.json({ ok:true, state:publicState(s) });
});

app.post("/api/test/gift", (req,res) => {
  const s = getRoom(req.body.room);
  if (!s) return res.status(400).json({ ok:false, error:"Room gerekli." });
  triggerGift(s, req.body.username, req.body.gift, req.body.avatarUrl, req.body.type);
  broadcast(s);
  res.json({ ok:true, state:publicState(s) });
});

// Adapter endpoint: later a verified TikTok event source can POST real events here.
// Keeping this endpoint independent means the UI/overlays do not break when the provider changes.
app.post("/api/events", (req,res) => {
  const s = getRoom(req.body.room);
  if (!s) return res.status(400).json({ok:false,error:"Room gerekli."});

  const type = String(req.body.type || "").toLowerCase();
  const username = req.body.username;
  const avatarUrl = req.body.avatarUrl || "";

  if (type === "like") {
    addLike(s, username, req.body.count, avatarUrl);
  } else if (type === "gift") {
    triggerGift(s, username, req.body.gift, avatarUrl);
  } else if (type === "vote" && s.scoring) {
    addVote(s, username, req.body.score);
  } else {
    return res.status(400).json({ok:false,error:"Desteklenen olaylar: like, gift, vote"});
  }

  broadcast(s);
  res.json({ok:true});
});

app.get("/api/gifts", (req,res) => {
  res.json({ ok:true, gifts: DEFAULT_GIFTS });
});

io.on("connection", socket => {
  socket.on("joinRoom", room => {
    const code = String(room || "").trim().toUpperCase();
    const s = getRoom(code);
    if (!s) return;
    socket.join(code);
    socket.emit("state", publicState(s));
  });
});

setInterval(() => {
  for (const s of rooms.values()) {
    if (s.scoring && s.scoreEndsAt && Date.now() >= s.scoreEndsAt) {
      s.scoring = false;
      s.scoreEndsAt = 0;
      broadcast(s);
    }
  }
}, 500);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`MS Yayın v2 running on port ${PORT}`);
});
