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
  pingTimeout: 60000,
  pingInterval: 25000,
});

// Path-specific JSON limits: the admin import endpoint accepts up to 50 MB
// (full user database). Everything else stays at 8 KB to keep abuse bounded.
// IMPORTANT: the larger-limit middleware must be registered BEFORE the global
// one, otherwise express.json sees the 8kb cap first and rejects with 413.
app.use('/api/admin/import', express.json({ limit: '50mb' }));
app.use(express.json({ limit: '8kb' }));
// Serve the game directly at the bare root so the URL is just the domain
// (no /depth.html suffix). /depth.html still works for anyone who has it bookmarked.
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'depth.html')));
app.get('/privacy', (req, res) => res.sendFile(path.join(__dirname, 'public', 'privacy.html')));
// Background music — files live in /.music (hidden dir) and are exposed via
// clean URLs. Sent with a long cache so they aren't re-downloaded on scene changes.
const MUSIC_DIR = path.join(__dirname, '.music');
const MUSIC_HEADERS = { 'Cache-Control': 'public, max-age=86400' };
app.get('/music/menu.mp3', (req, res) => { res.set(MUSIC_HEADERS); res.sendFile(path.join(MUSIC_DIR, 'Menu Music.mp3')); });
app.get('/music/up.mp3',   (req, res) => { res.set(MUSIC_HEADERS); res.sendFile(path.join(MUSIC_DIR, 'Up Music.mp3')); });
app.get('/music/down.mp3', (req, res) => { res.set(MUSIC_HEADERS); res.sendFile(path.join(MUSIC_DIR, 'Down Music.mp3')); });
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
  res.json({ token, username: trimmed, isAdmin: isAdminUser(users[key]) });
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
  // Single-session enforcement: a fresh login invalidates ALL previous tokens
  // for this account. Any other tab using an old token can no longer act.
  u.sessions = [{ token, expiresAt: Date.now() + SESSION_TTL_MS }];
  // Also kick any live socket currently logged in as this user
  io.sockets.sockets.forEach((sock) => {
    if (sock.data && sock.data.username && sock.data.username.toLowerCase() === key) {
      sock.emit('session_replaced');
      sock.disconnect(true);
      delete gameState.players[sock.id];
    }
  });
  saveUsers();
  console.log(`[login] ${u.username}`);
  res.json({ token, username: u.username, isAdmin: isAdminUser(u) });
});

app.post('/api/me', (req, res) => {
  const { token } = req.body || {};
  const u = findUserByToken(token);
  if (!u) return res.status(401).json({ error: 'invalid token' });
  res.json({ username: u.username, isAdmin: isAdminUser(u) });
});

// Admin: trigger a force-reload broadcast to every connected client.
// First registered user is the default admin, or set ADMIN_USER env var.
function isAdminUser(u) {
  if (!u) return false;
  if (process.env.ADMIN_USER) return u.username.toLowerCase() === process.env.ADMIN_USER.toLowerCase();
  const sorted = Object.values(users).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  return sorted.length > 0 && sorted[0].username === u.username;
}

// Two-factor admin gate: must be on the admin account AND know the PIN
// (stored in env var ADMIN_PIN so it never lands in source). Without ADMIN_PIN
// set, all admin endpoints refuse — fail-closed.
function checkAdminAndPin(token, pin) {
  const u = findUserByToken(token);
  if (!u || !isAdminUser(u)) return { ok: false, status: 403, reason: 'not_admin' };
  const expected = process.env.ADMIN_PIN;
  if (!expected) return { ok: false, status: 503, reason: 'pin_not_configured' };
  if (String(pin || '') !== String(expected)) return { ok: false, status: 403, reason: 'wrong_pin' };
  return { ok: true, user: u };
}

app.post('/api/admin/verify_pin', (req, res) => {
  const { token, pin } = req.body || {};
  const r = checkAdminAndPin(token, pin);
  if (!r.ok) return res.status(r.status).json({ error: r.reason });
  res.json({ ok: true });
});

app.post('/api/admin/force_reload', (req, res) => {
  const { token, pin, message } = req.body || {};
  const r = checkAdminAndPin(token, pin);
  if (!r.ok) return res.status(r.status).json({ error: r.reason });
  const msg = (typeof message === 'string' && message.trim())
    ? message.trim().slice(0, 200)
    : null;
  console.log(`[admin] ${r.user.username} broadcast force_reload${msg ? ': ' + msg : ''}`);
  io.emit('force_reload', { by: r.user.username, message: msg });
  res.json({ ok: true });
});

app.post('/api/admin/stats', (req, res) => {
  const { token, pin } = req.body || {};
  const r = checkAdminAndPin(token, pin);
  if (!r.ok) return res.status(r.status).json({ error: r.reason });
  res.json({
    online: Object.keys(gameState.players).length,
    accounts: Object.keys(users).length,
    activeSockets: io.sockets.sockets.size,
  });
});

// Dump the entire users database (auth + game data) as JSON. Admin + PIN only.
// Used for migrating between hosting providers.
app.post('/api/admin/export', (req, res) => {
  const { token, pin } = req.body || {};
  const r = checkAdminAndPin(token, pin);
  if (!r.ok) return res.status(r.status).json({ error: r.reason });
  console.log(`[admin] ${r.user.username} exported users.json (${Object.keys(users).length} accounts)`);
  res.set('Cache-Control', 'no-store');
  res.json({ users, exportedAt: Date.now(), accountCount: Object.keys(users).length });
});

// Replace the entire users database with uploaded JSON. DESTRUCTIVE — everyone
// currently logged in gets kicked, sessions invalidated, and the file overwritten.
app.post('/api/admin/import', (req, res) => {
  const { token, pin, payload } = req.body || {};
  const r = checkAdminAndPin(token, pin);
  if (!r.ok) return res.status(r.status).json({ error: r.reason });
  if (!payload || typeof payload !== 'object' || !payload.users || typeof payload.users !== 'object') {
    return res.status(400).json({ error: 'invalid_payload' });
  }
  // Sanity check: payload.users should look like { lowercase_name: { username, salt, hash, ... } }
  const incoming = payload.users;
  let valid = 0;
  for (const k in incoming) {
    const u = incoming[k];
    if (u && typeof u.username === 'string' && typeof u.salt === 'string' && typeof u.hash === 'string') {
      valid++;
    }
  }
  if (valid === 0) return res.status(400).json({ error: 'no_valid_accounts' });

  // Disconnect every live socket so they reconnect against the fresh dataset.
  io.sockets.sockets.forEach((sock) => {
    try { sock.emit('force_reload', { by: r.user.username, message: 'Data restored — reloading.' }); } catch (e) {}
    try { sock.disconnect(true); } catch (e) {}
  });
  gameState.players = {};

  users = incoming;
  // run ensure on each loaded record so gameData is back-filled if missing
  for (const key in users) ensureGameDataForLoadedUser(users[key]);
  saveUsers();
  console.log(`[admin] ${r.user.username} imported users.json (${Object.keys(users).length} accounts)`);
  res.json({ ok: true, importedAccounts: Object.keys(users).length });
});

app.post('/api/admin/online_players', (req, res) => {
  const { token, pin } = req.body || {};
  const r = checkAdminAndPin(token, pin);
  if (!r.ok) return res.status(r.status).json({ error: r.reason });
  const players = [];
  for (const sid in gameState.players) {
    const p = gameState.players[sid];
    players.push({
      sid,
      name: p.name || 'anon',
      depth: Math.floor(p.depth || 0),
      alive: p.alive !== false,
    });
  }
  players.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  res.json({ players });
});

// Server-only kick. The client doesn't need to listen for anything — we just
// disconnect their socket and they vanish from gameState. Their tab will see
// the disconnect through socket.io's standard mechanism.
app.post('/api/admin/kick', (req, res) => {
  const { token, pin, target } = req.body || {};
  const r = checkAdminAndPin(token, pin);
  if (!r.ok) return res.status(r.status).json({ error: r.reason });
  if (!target) return res.status(400).json({ error: 'target required' });
  let kicked = 0;
  io.sockets.sockets.forEach((sock, sid) => {
    const matchesSid = sid === target;
    const sockName = sock.data && sock.data.username;
    const matchesName = sockName && sockName.toLowerCase() === String(target).toLowerCase();
    if (matchesSid || matchesName) {
      sock.disconnect(true);
      delete gameState.players[sid];
      kicked++;
    }
  });
  console.log(`[admin] ${r.user.username} kicked "${target}" (${kicked} socket(s))`);
  if (kicked > 0) broadcastState();
  res.json({ ok: true, kicked });
});

app.post('/api/admin/grant_ore', (req, res) => {
  const { token, pin, target, oreType } = req.body || {};
  const r = checkAdminAndPin(token, pin);
  if (!r.ok) return res.status(r.status).json({ error: r.reason });
  if (!target || !String(target).trim()) return res.status(400).json({ error: 'target required' });
  if (!oreType || typeof oreType !== 'string' || ORE_VALUES[oreType] === undefined) {
    return res.status(400).json({ error: 'invalid_ore' });
  }
  const normalized = String(target).trim().toLowerCase();
  const sid = Object.keys(gameState.players).find((id) => {
    const p = gameState.players[id];
    return p && p.name && p.name.toLowerCase() === normalized;
  });
  if (!sid) return res.status(404).json({ error: 'target_offline' });
  const p = gameState.players[sid];
  if (!Array.isArray(p.carrying)) p.carrying = [];
  p.carrying.push(oreType);
  const sock = io.sockets.sockets.get(sid);
  if (sock) {
    sock.emit('admin_granted_ore', { oreType, target: p.name, by: r.user.username });
  }
  broadcastState();
  console.log(`[admin] ${r.user.username} granted ${oreType} to ${p.name}`);
  res.json({ ok: true });
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

app.get('/api/leaderboards', (req, res) => {
  const all = Object.values(users).filter(u => u.gameData);
  const board = (key) => all
    .map(u => ({ name: u.username, value: u.gameData[key] || 0 }))
    .filter(e => e.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, 10);
  res.json({
    money: board('money'),
    weights: board('weights'),
    belts: board('belts'),
    backpacks: board('backpacks'),
    troveExpansions: board('troveExpansions'),
    oxygenTanks: board('oxygenTanks'),
  });
});

app.get('/api/visit', (req, res) => {
  const username = (req.query.user || '').toString();
  if (!username) return res.status(400).json({ error: 'username required' });
  const u = users[username.toLowerCase()];
  if (!u || !u.gameData) return res.status(404).json({ error: 'not found' });
  res.json({
    username: u.username,
    placedOres: u.gameData.placedOres,
    passiveIncome: u.gameData.passiveIncome,
    money: u.gameData.money,
    weights: u.gameData.weights,
    belts: u.gameData.belts,
    backpacks: u.gameData.backpacks,
    troveExpansions: u.gameData.troveExpansions,
    oxygenTanks: u.gameData.oxygenTanks,
  });
});

const SPAWN = { x: 150, y: 300, depth: 0 };
const BASE_OXYGEN = 100;
const OXYGEN_PER_TANK = 16;     // nerfed from 80 (5x less)
const PRICE_MULT = 1.2;          // each purchase costs 20% more than the last
const WEIGHT_BASE_COST = 75;
const BELT_BASE_COST = 100;
const BACKPACK_BASE_COST = 150;
const TROVE_BASE_COST = 500;
const OXYGEN_BASE_COST = 125;
const TROVE_SLOTS_PER_UPGRADE = 6;
const BACKPACK_SLOTS_PER_UPGRADE = 1; // nerfed from 6 (5x less)
const SELL_MULT = 5;
const MAX_ACTIVE_ORES = 30;
const SHAFT_LEFT_X = 280;
const SHAFT_RIGHT_X = 520;
const PLACED_SLOTS = 12;

const SAVE_PATH = process.env.DATA_PATH || path.join(__dirname, 'gamedata.json');

// Base ore values (no quality variants). Variants are generated below.
const BASE_ORE_VALUES = {
  coal: 1, copper: 1, iron: 2, gold: 3, crystal: 7,
  ruby: 16, sapphire: 36, emerald: 80, topaz: 180, diamond: 400,
  obsidian: 900, mythril: 2000, plasma: 4400, voidstone: 10000, singularity: 22000,
  stardust: 48000, nebula: 106000, quasar: 233000, pulsar: 513000, antimatter: 1130000,
  darkmatter: 2500000, tachyon: 5400000, quantum: 12000000, infinity: 26000000, genesis: 58000000,
  // 20 new deep tiers (max depth 500k)
  ascension: 128000000, zenith: 281000000, ethereal: 619000000, omega: 1360000000,
  chronos: 3000000000, nirvana: 6600000000, paradox: 14500000000, eclipse: 32000000000,
  supernova: 70000000000, cosmos: 154000000000, oblivion: 339000000000, dimension: 745000000000,
  realm: 1640000000000, divine: 3600000000000, eternal: 7900000000000, transcend: 17500000000000,
  apex: 38500000000000, archon: 84700000000000, primordial: 186000000000000, creation: 410000000000000,
};

// Build ORE_VALUES including all quality variants (gold 1.25x, diamond 2x, rainbow 5x).
const QUALITY_MULTS = { '': 1, 'g_': 1.25, 'd_': 2, 'r_': 10 };
const ORE_VALUES = {};
for (const base in BASE_ORE_VALUES) {
  for (const prefix in QUALITY_MULTS) {
    ORE_VALUES[prefix + base] = Math.ceil(BASE_ORE_VALUES[base] * QUALITY_MULTS[prefix]);
  }
}

const TIERS = Object.entries(BASE_ORE_VALUES).map(([type, value], i) => {
  const minDepths = [0, 200, 500, 900, 1400, 2000, 2700, 3500, 4400, 5400,
                     6500, 7700, 9000, 10400, 11900, 14000, 17000, 20500, 24500, 29000,
                     34500, 41000, 49000, 59000, 72000,
                     90000, 110000, 130000, 155000, 180000, 210000, 240000, 270000, 300000, 330000,
                     360000, 380000, 400000, 420000, 440000, 455000, 470000, 480000, 490000, 500000];
  return { tier: i + 1, type, value, minDepth: minDepths[i], maxDepth: minDepths[i + 1] || (minDepths[i] + 20000) };
});

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

function weightCost(d)   { return Math.ceil(WEIGHT_BASE_COST   * Math.pow(PRICE_MULT, d.weights        )); }
function beltCost(d)     { return Math.ceil(BELT_BASE_COST     * Math.pow(PRICE_MULT, d.belts          )); }
function backpackCost(d) { return Math.ceil(BACKPACK_BASE_COST * Math.pow(PRICE_MULT, d.backpacks      )); }
function troveCost(d)    { return Math.ceil(TROVE_BASE_COST    * Math.pow(PRICE_MULT, d.troveExpansions)); }
function oxygenCost(d)   { return Math.ceil(OXYGEN_BASE_COST   * Math.pow(PRICE_MULT, d.oxygenTanks    )); }

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
      troveExpansions: d.troveExpansions,
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
  // Sets identity AND adds the socket to the visible world (backward compat
  // for clients that don't know about player_active/inactive).
  socket.on('player_join', (data = {}) => {
    // sweep ghosts: any player whose socket isn't actually connected anymore
    const activeSids = new Set(Array.from(io.sockets.sockets.keys()));
    for (const sid in gameState.players) {
      if (!activeSids.has(sid)) {
        console.log(`[cleanup] removed ghost ${sid}`);
        delete gameState.players[sid];
      }
    }
    let name = null;
    if (data.token) {
      const u = findUserByToken(data.token);
      if (u) { name = u.username; ensureGameData(u); }
    }
    socket.data = socket.data || {};
    socket.data.username = name;
    // Single-session: kick any other live socket using this same username.
    // The new arrival wins; the old tab is told it was replaced and disconnected.
    if (name) {
      io.sockets.sockets.forEach((other) => {
        if (other.id === socket.id) return;
        if (other.data && other.data.username && other.data.username.toLowerCase() === name.toLowerCase()) {
          other.emit('session_replaced');
          other.disconnect(true);
          delete gameState.players[other.id];
        }
      });
    }
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
    console.log(`[join] ${name || 'anon'} (${Object.keys(gameState.players).length} in world)`);
    broadcastState();
  });

  // New clients toggle these on scene transitions. `player_inactive` removes
  // them from the visible world while keeping the socket alive for chat/state
  // (used when on menu/leaderboard/admin pages).
  socket.on('player_active', () => {
    if (gameState.players[socket.id]) return;
    const myData = gameDataFor(socket);
    const name = (socket.data && socket.data.username) || null;
    gameState.players[socket.id] = {
      x: SPAWN.x,
      y: SPAWN.y,
      depth: SPAWN.depth,
      carrying: [],
      oxygen: BASE_OXYGEN + OXYGEN_PER_TANK * myData.oxygenTanks,
      alive: true,
      name: name || 'anon',
    };
    console.log(`[active] ${name || socket.id}`);
    broadcastState();
  });
  socket.on('player_inactive', () => {
    if (!gameState.players[socket.id]) return;
    delete gameState.players[socket.id];
    const name = (socket.data && socket.data.username) || socket.id;
    console.log(`[inactive] ${name}`);
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
    else if (item === 'oxygen') cost = oxygenCost(d);
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

  socket.on('chat_message', ({ text } = {}) => {
    const name = socket.data && socket.data.username;
    if (!name) return; // anonymous sockets can't chat (spoofing protection)
    const trimmed = String(text || '').slice(0, 200).trim();
    if (!trimmed) return;
    // strip control chars but keep punctuation/spaces/emoji
    const clean = trimmed.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, '');
    if (!clean) return;
    console.log(`[chat] ${name}: ${clean}`);
    io.emit('chat', { from: name, text: clean, ts: Date.now() });
  });

  socket.on('disconnect', () => {
    delete gameState.players[socket.id];
    console.log(`[disconnect] player ${socket.id} (${Object.keys(gameState.players).length} online)`);
    broadcastState();
  });
});

// Ghost sweep — every 3s, drop any player whose socket isn't actually connected.
// Without this, players who close their tab badly (mobile suspend, crash, etc.)
// can linger floating mid-air for everyone else until the ping timeout.
setInterval(() => {
  const activeSids = new Set(Array.from(io.sockets.sockets.keys()));
  let removed = 0;
  for (const sid in gameState.players) {
    if (!activeSids.has(sid)) {
      delete gameState.players[sid];
      removed++;
    }
  }
  if (removed > 0) {
    console.log(`[sweep] removed ${removed} ghost(s)`);
    broadcastState();
  }
}, 3000);

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

// Render injects PORT (often 10000) and expects the app to bind to 0.0.0.0.
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
server.listen(PORT, HOST, () => {
  console.log(`mine-game server listening on ${HOST}:${PORT}`);
});
