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
  // back-fill gameData on accounts created before per-user economy existed
  for (const key in users) ensureGameDataForLoadedUser(users[key]);
  console.log(`[users] loaded ${Object.keys(users).length} accounts from ${USERS_PATH}`);
} catch (e) {
  console.log(`[users] no user file at ${USERS_PATH} — starting empty`);
}
// stub so it can be called before ensureGameData is defined (uses same logic)
function ensureGameDataForLoadedUser(u) {
  // defaultGameData / ORE_VALUES / PLACED_SLOTS exist by hoisting (function decls + const exists after this file fully evaluates).
  // We only construct the default array; full validation runs again at runtime via ensureGameData.
  if (!u.gameData) {
    u.gameData = {
      money: 40, weights: 0, belts: 0, backpacks: 0, oxygenTanks: 0,
      placedOres: new Array(PLACED_SLOTS).fill(null), passiveIncome: 0,
    };
  }
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
const WEIGHT_BASE_COST = 75;
const WEIGHT_INCREMENT = 50;
const BELT_BASE_COST = 100;
const BELT_INCREMENT = 50;
const BACKPACK_BASE_COST = 150;
const BACKPACK_INCREMENT = 100;
const TROVE_BASE_COST = 500;
const TROVE_INCREMENT = 500;
const TROVE_SLOTS_PER_UPGRADE = 6;
const OXYGEN_COST = 125;
const SELL_MULT = 5;
const MAX_ACTIVE_ORES = 30;
const SHAFT_LEFT_X = 280;
const SHAFT_RIGHT_X = 520;
const PLACED_SLOTS = 12;

const SAVE_PATH = process.env.DATA_PATH || path.join(__dirname, 'gamedata.json');

const ORE_VALUES = {
  coal: 1, copper: 3, iron: 7, gold: 15, crystal: 35,
  ruby: 80, sapphire: 180, emerald: 400, topaz: 900, diamond: 2000,
  obsidian: 4500, mythril: 10000, plasma: 22000, voidstone: 50000, singularity: 110000,
};

const TIERS = [
  { tier: 1,  type: 'coal',        value: 1,      minDepth: 0,     maxDepth: 200   },
  { tier: 2,  type: 'copper',      value: 3,      minDepth: 200,   maxDepth: 500   },
  { tier: 3,  type: 'iron',        value: 7,      minDepth: 500,   maxDepth: 900   },
  { tier: 4,  type: 'gold',        value: 15,     minDepth: 900,   maxDepth: 1400  },
  { tier: 5,  type: 'crystal',     value: 35,     minDepth: 1400,  maxDepth: 2000  },
  { tier: 6,  type: 'ruby',        value: 80,     minDepth: 2000,  maxDepth: 2700  },
  { tier: 7,  type: 'sapphire',    value: 180,    minDepth: 2700,  maxDepth: 3500  },
  { tier: 8,  type: 'emerald',     value: 400,    minDepth: 3500,  maxDepth: 4400  },
  { tier: 9,  type: 'topaz',       value: 900,    minDepth: 4400,  maxDepth: 5400  },
  { tier: 10, type: 'diamond',     value: 2000,   minDepth: 5400,  maxDepth: 6500  },
  { tier: 11, type: 'obsidian',    value: 4500,   minDepth: 6500,  maxDepth: 7700  },
  { tier: 12, type: 'mythril',     value: 10000,  minDepth: 7700,  maxDepth: 9000  },
  { tier: 13, type: 'plasma',      value: 22000,  minDepth: 9000,  maxDepth: 10400 },
  { tier: 14, type: 'voidstone',   value: 50000,  minDepth: 10400, maxDepth: 11900 },
  { tier: 15, type: 'singularity', value: 110000, minDepth: 11900, maxDepth: 14000 },
];

// Shared state — only ephemeral live data (positions, active shaft ores).
// Economy (money, placed, weights, belts, backpacks, oxygen tanks) is PER-USER.
const gameState = {
  players: {},
  ores: [],
};

function defaultGameData() {
  return {
    money: 40,
    weights: 0,
    belts: 0,
    backpacks: 0,
    oxygenTanks: 0,
    troveExpansions: 0,
    placedOres: new Array(PLACED_SLOTS).fill(null),
    passiveIncome: 0,
  };
}

function maxTroveSlots(d) {
  return PLACED_SLOTS + (d.troveExpansions || 0) * TROVE_SLOTS_PER_UPGRADE;
}

function ensureGameData(u) {
  if (!u.gameData) {
    u.gameData = defaultGameData();
  } else {
    const d = u.gameData;
    if (typeof d.money !== 'number') d.money = 40;
    if (typeof d.weights !== 'number') d.weights = 0;
    if (typeof d.belts !== 'number') d.belts = 0;
    if (typeof d.backpacks !== 'number') d.backpacks = 0;
    if (typeof d.oxygenTanks !== 'number') d.oxygenTanks = 0;
    if (typeof d.troveExpansions !== 'number') d.troveExpansions = 0;
    const cap = maxTroveSlots(d);
    if (!Array.isArray(d.placedOres)) d.placedOres = new Array(cap).fill(null);
    while (d.placedOres.length < cap) d.placedOres.push(null);
    if (d.placedOres.length > cap) d.placedOres = d.placedOres.slice(0, cap);
    d.placedOres = d.placedOres.map(t =>
      (typeof t === 'string' && ORE_VALUES[t] !== undefined) ? t : null);
    recalcPassiveIncome(d);
  }
}

// Get a socket's gameData. Authenticated users use their saved user record;
// anonymous sockets get an ephemeral, in-memory record that vanishes on disconnect.
function gameDataFor(socket) {
  const uname = socket.data && socket.data.username;
  if (uname) {
    const u = users[uname.toLowerCase()];
    if (u) { ensureGameData(u); return u.gameData; }
  }
  if (!socket.data) socket.data = {};
  if (!socket.data.anonGameData) socket.data.anonGameData = defaultGameData();
  return socket.data.anonGameData;
}

function recalcPassiveIncome(d) {
  d.passiveIncome = d.placedOres.reduce(
    (s, t) => s + (t ? (ORE_VALUES[t] || 0) : 0), 0);
}

function weightCost(d)   { return WEIGHT_BASE_COST   + d.weights         * WEIGHT_INCREMENT; }
function beltCost(d)     { return BELT_BASE_COST     + d.belts           * BELT_INCREMENT; }
function backpackCost(d) { return BACKPACK_BASE_COST + d.backpacks       * BACKPACK_INCREMENT; }
function troveCost(d)    { return TROVE_BASE_COST    + d.troveExpansions * TROVE_INCREMENT; }

// Send each connected socket their own per-user economy + the shared players list.
function broadcastState() {
  io.sockets.sockets.forEach((sock) => {
    const d = gameDataFor(sock);
    sock.emit('game_state', {
      players: gameState.players,
      ores: gameState.ores,
      money: d.money,
      passiveIncome: d.passiveIncome,
      weights: d.weights,
      belts: d.belts,
      backpacks: d.backpacks,
      oxygenTanks: d.oxygenTanks,
      placedOres: d.placedOres,
    });
  });
}

// Persistence: only users.json is canonical now (it holds each user's gameData).
// The old shared gamedata.json is no longer read or written.
let saveTimer = null;
function scheduleSave() {
  // economy is per-user inside users.json, so just trigger users save
  saveUsers();
  // also clear any legacy timer if it existed
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
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
      if (u) { name = u.username; ensureGameData(u); }
    }
    if (!name && typeof data.username === 'string') {
      name = data.username.slice(0, 20).replace(/[^a-zA-Z0-9_-]/g, '') || null;
    }
    socket.data = socket.data || {};
    socket.data.username = name; // null for anon

    const myData = gameDataFor(socket);
    gameState.players[socket.id] = {
      x: SPAWN.x,
      y: SPAWN.y,
      depth: SPAWN.depth,
      carrying: [],
      oxygen: BASE_OXYGEN + OXYGEN_PER_TANK * myData.oxygenTanks,
      alive: true,
      name: name || 'anon',
    };
    console.log(`[join] player ${socket.id} as ${name || 'anon'} (${Object.keys(gameState.players).length} online)`);
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
    // Light broadcast: only positions changed, full per-socket state is heavier.
    // Sending the full state per socket keeps things consistent without extra event types.
    broadcastState();
  });

  socket.on('ore_grabbed', ({ oreId } = {}) => {
    const idx = gameState.ores.findIndex(o => o.id === oreId);
    if (idx === -1) return;
    gameState.ores.splice(idx, 1);
    io.emit('ore_removed', { oreId });
  });

  socket.on('ore_placed', ({ ore } = {}) => {
    const d = gameDataFor(socket);
    if (!ore) return;
    const type = typeof ore === 'string' ? ore : ore.type;
    if (!type || ORE_VALUES[type] === undefined) return;
    const idx = d.placedOres.findIndex(s => s === null);
    if (idx === -1) return;
    d.placedOres[idx] = type;
    recalcPassiveIncome(d);
    scheduleSave();
    broadcastState();
  });

  socket.on('set_all_placed', ({ placed } = {}) => {
    const d = gameDataFor(socket);
    if (!Array.isArray(placed)) return;
    const cap = maxTroveSlots(d);
    const safe = new Array(cap).fill(null);
    for (let i = 0; i < Math.min(cap, placed.length); i++) {
      const t = placed[i];
      if (typeof t === 'string' && ORE_VALUES[t] !== undefined) safe[i] = t;
    }
    d.placedOres = safe;
    recalcPassiveIncome(d);
    scheduleSave();
    broadcastState();
  });

  socket.on('purchase', ({ item } = {}) => {
    const d = gameDataFor(socket);
    let cost;
    if (item === 'weight') cost = weightCost(d);
    else if (item === 'belt') cost = beltCost(d);
    else if (item === 'backpack') cost = backpackCost(d);
    else if (item === 'trove') cost = troveCost(d);
    else if (item === 'oxygen') cost = OXYGEN_COST;
    else return;

    if (d.money < cost) {
      socket.emit('purchase_failed', { item, cost, reason: 'insufficient_funds' });
      return;
    }

    d.money -= cost;
    if (item === 'weight') d.weights++;
    else if (item === 'belt') d.belts++;
    else if (item === 'backpack') d.backpacks++;
    else if (item === 'trove') {
      d.troveExpansions++;
      // grow the placed array immediately so the new slots are visible
      for (let i = 0; i < TROVE_SLOTS_PER_UPGRADE; i++) d.placedOres.push(null);
    }
    else if (item === 'oxygen') d.oxygenTanks++;
    console.log(`[purchase] ${socket.data && socket.data.username || socket.id} bought ${item} for $${cost}`);
    scheduleSave();
    broadcastState();
  });

  socket.on('sell_ores', ({ ores } = {}) => {
    const d = gameDataFor(socket);
    if (!Array.isArray(ores) || ores.length === 0) return;
    let total = 0;
    for (const t of ores) {
      if (typeof t === 'string' && ORE_VALUES[t] !== undefined) {
        total += ORE_VALUES[t] * SELL_MULT;
      }
    }
    if (total <= 0) return;
    d.money += total;
    console.log(`[sell] ${socket.data && socket.data.username || socket.id} sold ${ores.length} ores for $${total}`);
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
    const d = gameDataFor(socket);
    p.oxygen = BASE_OXYGEN + OXYGEN_PER_TANK * d.oxygenTanks;
    broadcastState();
  });

  socket.on('disconnect', () => {
    delete gameState.players[socket.id];
    console.log(`[disconnect] player ${socket.id} (${Object.keys(gameState.players).length} online)`);
    broadcastState();
  });
});

// Passive income tick — every 1s. Each user earns from THEIR placed ores only.
setInterval(() => {
  let anyChange = false;
  for (const key in users) {
    const u = users[key];
    if (!u.gameData) continue;
    if (u.gameData.passiveIncome > 0) {
      u.gameData.money += u.gameData.passiveIncome;
      anyChange = true;
    }
  }
  // anon sockets also tick their ephemeral data
  io.sockets.sockets.forEach((sock) => {
    if (sock.data && sock.data.anonGameData && sock.data.anonGameData.passiveIncome > 0) {
      sock.data.anonGameData.money += sock.data.anonGameData.passiveIncome;
    }
  });
  if (anyChange) scheduleSave();
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
