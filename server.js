const path = require("path");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const connectorModule = require("tiktok-live-connector");
const WebcastPushConnection =
  connectorModule?.WebcastPushConnection ||
  connectorModule?.default?.WebcastPushConnection ||
  connectorModule?.default ||
  connectorModule;

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = Number(process.env.PORT || 10000);

app.set("trust proxy", 1);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();
const connections = new Map();

const GIFT_CATALOG = [
  "Rose", "Finger Heart", "Perfume", "Cap", "Sunglasses",
  "Galaxy", "Lion", "TikTok Universe", "Dragon Flame",
  "Falcon", "Money Gun", "Fireworks", "Crown",
  "Custom Gift"
];

function cleanUser(value) {
  return String(value || "").replace(/^@/, "").trim();
}

function makeRoomCode() {
  return `MS-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
}

function getRoom(code) {
  const room = String(code || "").trim().toUpperCase();
  if (!rooms.has(room)) {
    rooms.set(room, {
      room,
      connected: false,
      username: "",
      scoreDuration: 15,
      scoring: false,
      scoreEndsAt: 0,
      votes: [],
      likes: new Map(),
      giftRules: [],
      giftHits: new Map(),
      wins: 0,
      penalty: 20,
      lastGift: null
    });
  }
  return rooms.get(room);
}

function snapshot(state) {
  const voteUsers = new Set(state.votes.map(v => v.username));
  const average = state.votes.length
    ? +(state.votes.reduce((sum, v) => sum + v.score, 0) / state.votes.length).toFixed(2)
    : 0;

  const likes = [...state.likes.entries()]
    .map(([username, likeCount]) => ({ username, likeCount }))
    .sort((a, b) => b.likeCount - a.likeCount)
    .slice(0, 100);

  const giftHits = [...state.giftHits.entries()]
    .map(([username, hitCount]) => ({ username, hitCount }))
    .sort((a, b) => b.hitCount - a.hitCount)
    .slice(0, 100);

  return {
    room: state.room,
    connected: state.connected,
    username: state.username,
    scoreDuration: state.scoreDuration,
    scoring: state.scoring,
    scoreEndsAt: state.scoreEndsAt,
    average,
    participants: voteUsers.size,
    votes: state.votes.slice(-100).reverse(),
    likes,
    giftRules: state.giftRules,
    giftHits,
    wins: state.wins,
    penalty: state.penalty,
    lastGift: state.lastGift,
    giftCatalog: GIFT_CATALOG
  };
}

function broadcast(state) {
  io.to(state.room).emit("state", snapshot(state));
}

function normalizeGift(name) {
  return String(name || "").trim().toLowerCase();
}

function handleGift(state, username, giftName) {
  const gift = String(giftName || "Hediye").trim();
  const matching = state.giftRules.filter(
    rule => normalizeGift(rule.gift) === normalizeGift(gift)
  );
  const activeRule = matching[0] || null;

  state.lastGift = {
    username,
    gift,
    type: activeRule ? activeRule.type : "none",
    time: Date.now()
  };

  if (activeRule) {
    state.giftHits.set(username, (state.giftHits.get(username) || 0) + 1);
  }

  broadcast(state);
}

async function connectTikTok(state, username) {
  if (connections.has(state.room)) {
    try { await connections.get(state.room).disconnect(); } catch (_) {}
    connections.delete(state.room);
  }

  if (typeof WebcastPushConnection !== "function") {
    throw new Error("TikTok bağlantı modülü beklenen WebcastPushConnection sınıfını vermiyor.");
  }

  const connection = new WebcastPushConnection(username, {
    processInitialData: false
  });
  connections.set(state.room, connection);

  connection.on("connected", () => {
    state.connected = true;
    broadcast(state);
  });

  connection.on("disconnected", () => {
    state.connected = false;
    broadcast(state);
  });

  connection.on("error", () => {
    state.connected = false;
    broadcast(state);
  });

  connection.on("chat", data => {
    if (!state.scoring) return;
    const raw = String(data?.comment || "").trim();
    const score = Number(raw.replace(/[^\d]/g, ""));
    if (score >= 1 && score <= 10) {
      state.votes.push({
        username: cleanUser(data?.uniqueId || data?.nickname || "bilinmeyen"),
        score,
        time: Date.now()
      });
      broadcast(state);
    }
  });

  connection.on("like", data => {
    const username = cleanUser(data?.uniqueId || data?.nickname || "bilinmeyen");
    const count = Number(data?.likeCount || data?.totalLikeCount || 1) || 1;
    state.likes.set(username, (state.likes.get(username) || 0) + count);
    broadcast(state);
  });

  connection.on("gift", data => {
    const username = cleanUser(data?.uniqueId || data?.nickname || "bilinmeyen");
    const giftName = String(data?.giftName || data?.gift || "Hediye");
    handleGift(state, username, giftName);
  });

  await connection.connect();
}

/* Pages */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/panel", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "panel.html"));
});

app.get("/overlay", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "overlay.html"));
});

app.get("/health", (req, res) => {
  res.json({ ok: true, rooms: rooms.size });
});

/* API */
app.post("/api/rooms", (req, res) => {
  let code = makeRoomCode();
  while (rooms.has(code)) code = makeRoomCode();
  const state = getRoom(code);
  res.json({ ok: true, room: state.room, panelUrl: `/panel?room=${encodeURIComponent(state.room)}` });
});

app.get("/api/state", (req, res) => {
  const state = getRoom(req.query.room);
  res.json(snapshot(state));
});

app.post("/api/duration", (req, res) => {
  const state = getRoom(req.body.room);
  state.scoreDuration = Math.max(1, Math.min(3600, Number(req.body.duration) || 15));
  broadcast(state);
  res.json(snapshot(state));
});

app.post("/api/score/start", (req, res) => {
  const state = getRoom(req.body.room);
  state.scoring = true;
  state.votes = [];
  state.scoreEndsAt = Date.now() + state.scoreDuration * 1000;
  broadcast(state);

  setTimeout(() => {
    if (state.scoring && Date.now() >= state.scoreEndsAt) {
      state.scoring = false;
      broadcast(state);
    }
  }, state.scoreDuration * 1000 + 50);

  res.json(snapshot(state));
});

app.post("/api/score/stop", (req, res) => {
  const state = getRoom(req.body.room);
  state.scoring = false;
  state.scoreEndsAt = 0;
  broadcast(state);
  res.json(snapshot(state));
});

app.post("/api/rule", (req, res) => {
  const state = getRoom(req.body.room);
  const gift = String(req.body.gift || "").trim();
  const type = req.body.type === "mekan" ? "mekan" : "racon";
  if (!gift) return res.status(400).json({ ok: false, message: "Hediye seçilmedi." });

  const exists = state.giftRules.some(
    r => r.type === type && normalizeGift(r.gift) === normalizeGift(gift)
  );
  if (!exists) state.giftRules.push({ gift, type });

  broadcast(state);
  res.json(snapshot(state));
});

app.post("/api/rule/delete", (req, res) => {
  const state = getRoom(req.body.room);
  const gift = normalizeGift(req.body.gift);
  const type = req.body.type === "mekan" ? "mekan" : "racon";
  state.giftRules = state.giftRules.filter(
    r => !(r.type === type && normalizeGift(r.gift) === gift)
  );
  broadcast(state);
  res.json(snapshot(state));
});

app.post("/api/likes/reset", (req, res) => {
  const state = getRoom(req.body.room);
  state.likes.clear();
  broadcast(state);
  res.json(snapshot(state));
});

app.post("/api/win", (req, res) => {
  const state = getRoom(req.body.room);
  const change = Number(req.body.change) || 0;
  state.wins = change === 0 ? 0 : Math.max(0, state.wins + change);
  broadcast(state);
  res.json(snapshot(state));
});

app.post("/api/test/vote", (req, res) => {
  const state = getRoom(req.body.room);
  if (state.scoring) {
    state.votes.push({
      username: cleanUser(req.body.username) || "test",
      score: Math.max(1, Math.min(10, Number(req.body.score) || 1)),
      time: Date.now()
    });
    broadcast(state);
  }
  res.json(snapshot(state));
});

app.post("/api/test/like", (req, res) => {
  const state = getRoom(req.body.room);
  const username = cleanUser(req.body.username) || "test";
  const count = Math.max(1, Number(req.body.count) || 1);
  state.likes.set(username, (state.likes.get(username) || 0) + count);
  broadcast(state);
  res.json(snapshot(state));
});

app.post("/api/test/gift", (req, res) => {
  const state = getRoom(req.body.room);
  handleGift(
    state,
    cleanUser(req.body.username) || "test",
    String(req.body.gift || "Rose")
  );
  res.json(snapshot(state));
});

app.post("/api/connect", async (req, res) => {
  const state = getRoom(req.body.room);
  const username = cleanUser(req.body.username);

  if (!username) {
    return res.status(400).json({ ok: false, message: "TikTok kullanıcı adı gerekli." });
  }

  state.username = username;
  try {
    await connectTikTok(state, username);
    res.json({ ok: true, message: "TikTok bağlantısı başlatıldı." });
  } catch (error) {
    state.connected = false;
    broadcast(state);
    res.status(500).json({
      ok: false,
      message: `TikTok bağlantısı kurulamadı: ${error.message}`
    });
  }
});

io.on("connection", socket => {
  socket.on("join", room => {
    const normalized = String(room || "").trim().toUpperCase();
    if (!normalized) return;
    socket.join(normalized);
    socket.emit("state", snapshot(getRoom(normalized)));
  });
});

server.listen(PORT, () => {
  console.log(`MS Yayin running on ${PORT}`);
});
