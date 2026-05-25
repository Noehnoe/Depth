const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

const SPAWN = { x: 150, y: 300, depth: 0 };
const BASE_OXYGEN = 100;
const OXYGEN_PER_TANK = 80;
const WEIGHT_BASE_COST = 15;
const WEIGHT_INCREMENT = 10;
const OXYGEN_COST = 25;
const MAX_ACTIVE_ORES = 30;
const SHAFT_LEFT_X = 280;
const SHAFT_RIGHT_X = 520;

const TIERS = [
  { tier: 1, value: 1,  minDepth: 0,    maxDepth: 200  },
  { tier: 2, value: 3,  minDepth: 200,  maxDepth: 500  },
  { tier: 3, value: 7,  minDepth: 500,  maxDepth: 900  },
  { tier: 4, value: 15, minDepth: 900,  maxDepth: 1400 },
  { tier: 5, value: 35, minDepth: 1400, maxDepth: 2000 },
];

const gameState = {
  players: {},
  ores: [],
  placedOres: [],
  money: 40,
  passiveIncome: 0,
  weights: 0,
  oxygenTanks: 0,
};

function broadcastState() {
  io.emit('game_state', gameState);
}

function recalcPassiveIncome() {
  gameState.passiveIncome = gameState.placedOres.reduce((s, o) => s + (o.value || 0), 0);
}

function weightCost() {
  return WEIGHT_BASE_COST + gameState.weights * WEIGHT_INCREMENT;
}

io.on('connection', (socket) => {
  socket.on('player_join', () => {
    gameState.players[socket.id] = {
      x: SPAWN.x,
      y: SPAWN.y,
      depth: SPAWN.depth,
      carrying: [],
      oxygen: BASE_OXYGEN + OXYGEN_PER_TANK * gameState.oxygenTanks,
      alive: true,
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
    if (!ore || typeof ore.value !== 'number') return;
    gameState.placedOres.push({
      tier: ore.tier,
      value: ore.value,
    });
    recalcPassiveIncome();
    broadcastState();
  });

  socket.on('purchase', ({ item } = {}) => {
    let cost;
    if (item === 'weight') cost = weightCost();
    else if (item === 'oxygen') cost = OXYGEN_COST;
    else return;

    if (gameState.money < cost) {
      socket.emit('purchase_failed', { item, cost, reason: 'insufficient_funds' });
      return;
    }

    gameState.money -= cost;
    if (item === 'weight') gameState.weights++;
    else gameState.oxygenTanks++;
    console.log(`[purchase] ${socket.id} bought ${item} for $${cost}`);
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
  gameState.money += gameState.passiveIncome;
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
