const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 8000,
  pingInterval: 3000,
});

app.use(express.json({ limit: '8kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- USERS / AUTH ----------
const USERS_PATH = process.env.USERS_PATH || path.join(__dirname, 'users.json');
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
let users = {}; // username(lower) -> { username, salt, hash, sessions: [{token, expiresAt}] }

try {
  users = JSON.parse(fs.readFileSync(USERS_PATH, 'utf8'));
  console.log(`[users] loaded ${Object.keys(users).length} accounts from ${USERS_PATH}`);
} catch (e) {
  console.log(`[users] no user file at ${USERS_PATH} — starting empty`);
}

let usersSaveTimer = null;
function saveUsers() {
  if (usersSaveTimer) return;
  usersSaveTimer = setTimeout(() => {
    usersSaveTimer = null;
    fs.writeFile(USERS_PATH, JSON.stringify(users, null, 2), (err) => {
      if (err) console.error('[users] save error:', err.message);
    });
  }, 500);
}

function hashPassword(pw, salt) {
  return crypto.pbkdf2Sync(pw, salt, 100000, 32, 'sha256').toString('hex');
}
function makeToken() {
  return crypto.randomBytes(24).toString('hex');
}
function findUserByToken(token) {
  if (!token) return null;
  for (const key in users) {
    const u = users[key];
    if (!u.sessions) continue;
    const s = u.sessions.find(s => s.token === token && s.expiresAt > Date.now());
    if (s) return u;
  }
  return null;
}

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'username and password required' });
  }
  const trimmed = username.trim();
  if (trimmed.length < 3 || trimmed.length > 20) {
    return res.status(400).json({ error: 'username must be 3-20 characters' });
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
    return res.status(400).json({ error: 'username can only contain letters, numbers, _ and -' });
  }
  if (password.length < 4 || password.length > 64) {
    return res.status(400).json({ error: 'password must be 4-64 characters' });
  }
  const key = trimmed.toLowerCase();
  if (users[key]) return res.status(409).json({ error: 'username already taken' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const token = makeToken();
  users[key] = {
    username: trimmed,
    salt,
    hash,
    sessions: [{ token, expiresAt: Date.now() + SESSION_TTL_MS }],
    createdAt: Date.now(),
  };
  saveUsers();
  console.log(`[register] ${trimmed}`);
  res.json({ token, username: trimmed });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'username and password required' });
  }
  const key = username.trim().toLowerCase();
  const u = users[key];
  if (!u) return res.status(401).json({ error: 'invalid username or password' });
  const hash = hashPassword(password, u.salt);
  if (hash !== u.hash) return res.status(401).json({ error: 'invalid username or password' });
  const token = makeToken();
  u.sessions = (u.sessions || []).filter(s => s.expiresAt > Date.now());
  u.sessions.push({ token, expiresAt: Date.now() + SESSION_TTL_MS });
  saveUsers();
  console.log(`[login] ${u.username}`);
  res.json({ token, username: u.username });
});

app.post('/api/me', (req, res) => {
  const { token } = req.body || {};
  const u = findUserByToken(token);
  if (!u) return res.status(401).json({ error: 'invalid token' });
  res.json({ username: u.username });
});

app.post('/api/logout', (req, res) => {
  const { token } = req.body || {};
  if (token) {
    for (const key in users) {
      const u = users[key];
      if (u.sessions) u.sessions = u.sessions.filter(s => s.token !== token);
    }
    saveUsers();
  }
  res.json({ ok: true });
});

const SPAWN = { x: 150, y: 300, depth: 0 };
const BASE_OXYGEN = 100;
const OXYGEN_PER_TANK = 80;
const WEIGHT_BASE_COST = 15;
const WEIGHT_INCREMENT = 10;
const BELT_BASE_COST = 20;
const BELT_INCREMENT = 10;
const OXYGEN_COST = 25;
const MAX_ACTIVE_ORES = 30;
const SHAFT_LEFT_X = 280;
const SHAFT_RIGHT_X = 520;
const PLACED_SLOTS = 12;

const SAVE_PATH = process.env.DATA_PATH || path.join(__dirname, 'gamedata.json');

const ORE_VALUES = { coal: 1, copper: 3, iron: 7, gold: 15, crystal: 35 };

const TIERS = [
  { tier: 1, type: 'coal',    value: 1,  minDepth: 0,    maxDepth: 200  },
  { tier: 2, type: 'copper',  value: 3,  minDepth: 200,  maxDepth: 500  },
  { tier: 3, type: 'iron',    value: 7,  minDepth: 500,  maxDepth: 900  },
  { tier: 4, type: 'gold',    value: 15, minDepth: 900,  maxDepth: 1400 },
  { tier: 5, type: 'crystal', value: 35, minDepth: 1400, maxDepth: 2000 },
];

const gameState = {
  players: {},
  ores: [],
  placedOres: new Array(PLACED_SLOTS).fill(null),
  money: 40,
  passiveIncome: 0,
  weights: 0,
  belts: 0,
  oxygenTanks: 0,
};

// ---------- persistence ----------
function loadData() {
  try {
    const raw = fs.readFileSync(SAVE_PATH, 'utf8');
    const saved = JSON.parse(raw);
    if (typeof saved.money === 'number') gameState.money = saved.money;
    if (typeof saved.weights === 'number') gameState.weights = saved.weights;
    if (typeof saved.belts === 'number') gameState.belts = saved.belts;
    if (typeof saved.oxygenTanks === 'number') gameState.oxygenTanks = saved.oxygenTanks;
    if (Array.isArray(saved.placedOres)) {
      const arr = saved.placedOres.slice(0, PLACED_SLOTS).map(t =>
        (typeof t === 'string' && ORE_VALUES[t] !== undefined) ? t : null);
      while (arr.length < PLACED_SLOTS) arr.push(null);
      gameState.placedOres = arr;
    }
    console.log(`[load] restored game data from ${SAVE_PATH}`);
  } catch (e) {
    console.log(`[load] no save file at ${SAVE_PATH} — starting fresh`);
  }
}
loadData();

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const persist = {
      money: gameState.money,
      placedOres: gameState.placedOres,
      weights: gameState.weights,
      belts: gameState.belts,
      oxygenTanks: gameState.oxygenTanks,
    };
    fs.writeFile(SAVE_PATH, JSON.stringify(persist, null, 2), (err) => {
      if (err) console.error('[save] error:', err.message);
    });
  }, 3000);
}

function broadcastState() {
  io.emit('game_state', gameState);
}

function recalcPassiveIncome() {
  gameState.passiveIncome = gameState.placedOres.reduce(
    (s, t) => s + (t ? (ORE_VALUES[t] || 0) : 0), 0);
}
recalcPassiveIncome();

function weightCost() {
  return WEIGHT_BASE_COST + gameState.weights * WEIGHT_INCREMENT;
}
function beltCost() {
  return BELT_BASE_COST + gameState.belts * BELT_INCREMENT;
}

io.on('connection', (socket) => {
  socket.on('player_join', (data = {}) => {
    // sweep ghosts: any player whose socket isn't actually connected anymore
    const activeSids = new Set(Array.from(io.sockets.sockets.keys()));
    for (const sid in gameState.players) {
      if (!activeSids.has(sid)) {
        console.log(`[cleanup] removed ghost ${sid}`);
        delete gameState.players[sid];
      }
    }
    // verify auth token if provided; trust the username on the user record
    let name = null;
    if (data.token) {
      const u = findUserByToken(data.token);
      if (u) name = u.username;
    }
    if (!name && typeof data.username === 'string') {
      // fallback for offline/anonymous play
      name = data.username.slice(0, 20).replace(/[^a-zA-Z0-9_-]/g, '') || null;
    }
    gameState.players[socket.id] = {
      x: SPAWN.x,
      y: SPAWN.y,
      depth: SPAWN.depth,
      carrying: [],
      oxygen: BASE_OXYGEN + OXYGEN_PER_TANK * gameState.oxygenTanks,
      alive: true,
      name: name || 'anon',
    };
    console.log(`[join] player ${socket.id} (${Object.keys(gameState.players).length} online)`);
    broadcastState();
  });

  socket.on('player_update', (data) => {
    const p = gameState.players[socket.id];
    if (!p || !data) return;
    if (typeof data.x === 'number') p.x = data.x;
    if (typeof data.y === 'number') p.y = data.y;
    if (typeof data.depth === 'number') p.depth = data.depth;
    if (typeof data.oxygen === 'number') p.oxygen = data.oxygen;
    if (Array.isArray(data.carrying)) p.carrying = data.carrying;
    socket.broadcast.emit('game_state', gameState);
  });

  socket.on('ore_grabbed', ({ oreId } = {}) => {
    const idx = gameState.ores.findIndex(o => o.id === oreId);
    if (idx === -1) return;
    gameState.ores.splice(idx, 1);
    io.emit('ore_removed', { oreId });
  });

  socket.on('ore_placed', ({ ore } = {}) => {
    if (!ore) return;
    const type = typeof ore === 'string' ? ore : ore.type;
    if (!type || ORE_VALUES[type] === undefined) return;
    const idx = gameState.placedOres.findIndex(s => s === null);
    if (idx === -1) return;
    gameState.placedOres[idx] = type;
    recalcPassiveIncome();
    scheduleSave();
    broadcastState();
  });

  // Canonical: client sends the full 12-slot array of type strings (or null) on any change
  socket.on('set_all_placed', ({ placed } = {}) => {
    if (!Array.isArray(placed)) return;
    const safe = new Array(PLACED_SLOTS).fill(null);
    for (let i = 0; i < Math.min(PLACED_SLOTS, placed.length); i++) {
      const t = placed[i];
      if (typeof t === 'string' && ORE_VALUES[t] !== undefined) safe[i] = t;
    }
    gameState.placedOres = safe;
    recalcPassiveIncome();
    scheduleSave();
    broadcastState();
  });

  socket.on('purchase', ({ item } = {}) => {
    let cost;
    if (item === 'weight') cost = weightCost();
    else if (item === 'belt') cost = beltCost();
    else if (item === 'oxygen') cost = OXYGEN_COST;
    else return;

    if (gameState.money < cost) {
      socket.emit('purchase_failed', { item, cost, reason: 'insufficient_funds' });
      return;
    }

    gameState.money -= cost;
    if (item === 'weight') gameState.weights++;
    else if (item === 'belt') gameState.belts++;
    else if (item === 'oxygen') gameState.oxygenTanks++;
    console.log(`[purchase] ${socket.id} bought ${item} for $${cost}`);
    scheduleSave();
    broadcastState();
  });

  socket.on('player_died', ({ playerId } = {}) => {
    const id = playerId || socket.id;
    const p = gameState.players[id];
    if (!p) return;
    p.carrying = [];
    p.alive = false;
    console.log(`[died] player ${id}`);
    broadcastState();
  });

  socket.on('player_respawned', ({ playerId } = {}) => {
    const id = playerId || socket.id;
    const p = gameState.players[id];
    if (!p) return;
    p.x = SPAWN.x;
    p.y = SPAWN.y;
    p.depth = SPAWN.depth;
    p.alive = true;
    p.oxygen = BASE_OXYGEN + OXYGEN_PER_TANK * gameState.oxygenTanks;
    broadcastState();
  });

  socket.on('disconnect', () => {
    delete gameState.players[socket.id];
    console.log(`[disconnect] player ${socket.id} (${Object.keys(gameState.players).length} online)`);
    broadcastState();
  });
});

// passive income tick — every 1s
setInterval(() => {
  if (gameState.passiveIncome > 0) {
    gameState.money += gameState.passiveIncome;
    scheduleSave();
  }
  broadcastState();
}, 1000);

// ore generation tick — every 3s
setInterval(() => {
  if (gameState.ores.length >= MAX_ACTIVE_ORES) return;
  const toGenerate = 1 + Math.floor(Math.random() * 3); // 1..3
  for (let i = 0; i < toGenerate; i++) {
    if (gameState.ores.length >= MAX_ACTIVE_ORES) break;
    const tier = TIERS[Math.floor(Math.random() * TIERS.length)];
    const depth = tier.minDepth + Math.random() * (tier.maxDepth - tier.minDepth);
    const x = Math.random() < 0.5 ? SHAFT_LEFT_X : SHAFT_RIGHT_X;
    gameState.ores.push({
      id: Date.now() + Math.random(),
      x,
      depth,
      tier: tier.tier,
      value: tier.value,
    });
  }
  broadcastState();
}, 3000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`mine-game server listening on port ${PORT}`);
});
