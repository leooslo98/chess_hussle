'use strict';
require('dotenv').config();
const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');
const fetch = require('node-fetch');

const PORT = process.env.PORT || 3000;
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '';
const SOLANA_NETWORK = process.env.SOLANA_NETWORK || 'devnet';

const app = express();
app.use(express.json());

// ─── Serve static HTML ────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'chess-hussle.html'));
});

// ─── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ─── In-memory state ──────────────────────────────────────────────────────────
const clients = new Map();           // wsId → { ws, walletAddress, gameId, roomId, teamId }
let clientIdCounter = 0;

// Matchmaking queues
const queues = {
  '1v1': [],       // { wsId, wager, timeControl, color, elo, ts }
  'team': [],      // { wsId, wager, teamCode, slot }
  'tournament': {} // tournamentId → [wsId, ...]
};

// Active games
const games = new Map();             // gameId → GameRoom
const teams = new Map();             // teamId → TeamRoom
const spectators = new Map();        // gameId → Set<wsId>
const sportsbookBets = new Map();    // lichessGameId → { white: [{wsId,amount}], black: [...], pool: n }

// Tournament state
const tournaments = {
  speed: {
    id: 'speed-daily',
    type: 'speed',
    name: 'Daily Blitz',
    timeControl: '3+0',
    entryFee: 0.5,
    maxPlayers: 8,
    prizes: [0.50, 0.30, 0.10, 0.10],
    registered: [],
    bracket: null,
    status: 'open', // open | active | finished
    startHour: 18,
    startMinute: 0,
  },
  weekly: {
    id: 'weekly',
    type: 'weekly',
    name: 'Weekly Rapid',
    timeControl: '10+0',
    entryFee: 1.0,
    maxPlayers: 16,
    prizes: [0.40, 0.25, 0.15, 0.10, 0.05],
    platformFee: 0.05,
    registered: [],
    bracket: null,
    status: 'open',
  }
};

// Daily puzzle cache
let dailyPuzzleCache = null;
let dailyPuzzleDate = null;  // 'YYYY-MM-DD'
const dailyPuzzlePools = new Map(); // date → { pool: SOL, entries: Map<wallet, {solved,timeMs}> }

// Puzzle buy-in pools
const puzzlePools = {
  easy:   { pool: 0, entries: new Map(), activePuzzles: [] },
  medium: { pool: 0, entries: new Map(), activePuzzles: [] },
  hard:   { pool: 0, entries: new Map(), activePuzzles: [] },
};

// Lichess live sportsbook state
// Channel names must match Lichess API exactly (lowercase/camelCase)
const TRACKED_CHANNELS = ['best', 'bullet', 'blitz', 'rapid', 'classical', 'chess960'];
const CHANNEL_DISPLAY = {
  best:      'Top Game',
  bullet:    'Bullet',
  blitz:     'Blitz',
  rapid:     'Rapid',
  classical: 'Classical',
  chess960:  'Chess960',
};
const liveSportsbookGames = new Map();   // channelName → { gameId, fen, lastMove, players, clocks, whiteBets, blackBets }
const sportsbookWatchers = new Set();    // wsIds currently watching sportsbook
const activeChannelStreams = new Map();  // channelName → AbortController

// ─── Helpers ──────────────────────────────────────────────────────────────────
function generateId() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function send(wsId, payload) {
  const c = clients.get(wsId);
  if (c && c.ws.readyState === WebSocket.OPEN) {
    c.ws.send(JSON.stringify(payload));
  }
}

function broadcast(wsIds, payload) {
  const data = JSON.stringify(payload);
  for (const wsId of wsIds) {
    const c = clients.get(wsId);
    if (c && c.ws.readyState === WebSocket.OPEN) c.ws.send(data);
  }
}

function broadcastRoom(gameId, payload, excludeWsId) {
  const game = games.get(gameId);
  if (!game) return;
  const specSet = spectators.get(gameId) || new Set();
  const recipients = [...game.players, ...specSet].filter(id => id !== excludeWsId);
  broadcast(recipients, payload);
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

// ─── Matchmaking ──────────────────────────────────────────────────────────────
function tryMatch1v1() {
  const q = queues['1v1'];
  if (q.length < 2) return;

  // Simple: pair first two (real impl would sort by ELO + wager)
  const a = q.shift();
  const b = q.shift();

  const gameId = generateId();
  const colorA = a.color === 'white' ? 'w' : a.color === 'black' ? 'b' : (Math.random() < 0.5 ? 'w' : 'b');
  const colorB = colorA === 'w' ? 'b' : 'w';

  const game = {
    id: gameId,
    players: [a.wsId, b.wsId],
    colors: { [a.wsId]: colorA, [b.wsId]: colorB },
    wager: Math.min(a.wager, b.wager),
    timeControl: a.timeControl,
    moves: [],
    clocks: { w: parseTimeControl(a.timeControl), b: parseTimeControl(a.timeControl) },
    lastMoveTs: null,
    status: 'active',
    spectatorBets: { white: [], black: [] },
  };
  games.set(gameId, game);
  spectators.set(gameId, new Set());

  const clientA = clients.get(a.wsId);
  const clientB = clients.get(b.wsId);
  if (clientA) clientA.gameId = gameId;
  if (clientB) clientB.gameId = gameId;

  send(a.wsId, { type: 'game_found', gameId, color: colorA, opponent: clientB?.walletAddress || 'Opponent', wager: game.wager });
  send(b.wsId, { type: 'game_found', gameId, color: colorB, opponent: clientA?.walletAddress || 'Opponent', wager: game.wager });
}

function tryMatchTeam() {
  const q = queues['team'];
  if (q.length < 6) return;

  const teamA = q.splice(0, 3);
  const teamB = q.splice(0, 3);
  const teamId = generateId();

  // Create 3 games for this team battle
  const boardGames = teamA.map((pA, i) => {
    const pB = teamB[i];
    const gameId = generateId();
    const colorA = i % 2 === 0 ? 'w' : 'b';
    const colorB = colorA === 'w' ? 'b' : 'w';
    const wager = Math.min(pA.wager, pB.wager);
    const game = {
      id: gameId,
      players: [pA.wsId, pB.wsId],
      colors: { [pA.wsId]: colorA, [pB.wsId]: colorB },
      wager,
      timeControl: '5+0',
      moves: [],
      clocks: { w: 300, b: 300 },
      lastMoveTs: null,
      status: 'active',
      teamId,
      boardIndex: i,
    };
    games.set(gameId, game);
    spectators.set(gameId, new Set());
    return gameId;
  });

  const team = {
    id: teamId,
    teamA: teamA.map(p => p.wsId),
    teamB: teamB.map(p => p.wsId),
    games: boardGames,
    scores: { A: 0, B: 0 },
    wager: teamA[0].wager,
    status: 'active',
  };
  teams.set(teamId, team);

  // Notify all players
  teamA.forEach((p, i) => {
    const c = clients.get(p.wsId);
    if (c) c.teamId = teamId;
    send(p.wsId, { type: 'team_game_found', teamId, gameId: boardGames[i], boardIndex: i, team: 'A', color: games.get(boardGames[i]).colors[p.wsId] });
  });
  teamB.forEach((p, i) => {
    const c = clients.get(p.wsId);
    if (c) c.teamId = teamId;
    send(p.wsId, { type: 'team_game_found', teamId, gameId: boardGames[i], boardIndex: i, team: 'B', color: games.get(boardGames[i]).colors[p.wsId] });
  });
}

function parseTimeControl(tc) {
  const m = String(tc).match(/^(\d+)/);
  return m ? parseInt(m[1]) * 60 : 300;
}

// ─── Game Move Handling ───────────────────────────────────────────────────────
function handleMove(wsId, msg) {
  const { gameId, move } = msg;
  const game = games.get(gameId);
  if (!game) return;
  if (!game.players.includes(wsId)) return;

  const now = Date.now();
  const color = game.colors[wsId];

  // Update clock
  if (game.lastMoveTs && game.moves.length > 0) {
    const elapsed = (now - game.lastMoveTs) / 1000;
    game.clocks[color] = Math.max(0, game.clocks[color] - elapsed);
    if (game.clocks[color] <= 0) {
      endGame(gameId, color === 'w' ? 'b' : 'w', 'timeout');
      return;
    }
  }
  game.lastMoveTs = now;
  game.moves.push({ move, color, ts: now });

  // Echo move to opponent + spectators
  broadcastRoom(gameId, { type: 'move', gameId, move, clocks: game.clocks }, wsId);
  // Also confirm back to sender
  send(wsId, { type: 'move_ack', gameId, move, clocks: game.clocks });
}

function handleResign(wsId, msg) {
  const { gameId } = msg;
  const game = games.get(gameId);
  if (!game) return;
  const color = game.colors[wsId];
  const winner = color === 'w' ? 'b' : 'w';
  endGame(gameId, winner, 'resign');
}

function endGame(gameId, winner, reason) {
  const game = games.get(gameId);
  if (!game || game.status !== 'active') return;
  game.status = 'finished';
  game.winner = winner;

  broadcast(game.players, { type: 'game_over', gameId, winner, reason });

  // Resolve spectator bets
  const specSet = spectators.get(gameId) || new Set();
  if (specSet.size > 0 && (game.spectatorBets.white.length || game.spectatorBets.black.length)) {
    resolveSpectatorBets(gameId, winner);
  }

  // Handle team scoring
  if (game.teamId) {
    updateTeamScore(game.teamId, gameId, winner);
  }
}

function resolveSpectatorBets(gameId, winner) {
  const game = games.get(gameId);
  if (!game) return;
  const winningSide = winner === 'w' ? 'white' : 'black';
  const losingSide = winner === 'w' ? 'black' : 'white';
  const winBets = game.spectatorBets[winningSide] || [];
  const loseBets = game.spectatorBets[losingSide] || [];
  const totalPool = [...winBets, ...loseBets].reduce((s, b) => s + b.amount, 0);
  const winPool = winBets.reduce((s, b) => s + b.amount, 0);

  if (winPool > 0) {
    winBets.forEach(b => {
      const payout = (b.amount / winPool) * totalPool * 0.95;
      send(b.wsId, { type: 'bet_result', gameId, won: true, payout: payout.toFixed(4) });
    });
  }
  loseBets.forEach(b => {
    send(b.wsId, { type: 'bet_result', gameId, won: false, payout: 0 });
  });
}

function updateTeamScore(teamId, gameId, winner) {
  const team = teams.get(teamId);
  if (!team || team.status !== 'active') return;
  const game = games.get(gameId);
  if (!game) return;

  // Determine which team player was white/black
  const winnerWsId = game.players.find(wsId => game.colors[wsId] === winner);
  const teamSide = team.teamA.includes(winnerWsId) ? 'A' : 'B';
  team.scores[teamSide]++;

  // Broadcast update
  const allPlayers = [...team.teamA, ...team.teamB];
  broadcast(allPlayers, { type: 'team_score_update', teamId, scores: team.scores, gameId });

  // Check if team has won (2+ wins)
  if (team.scores[teamSide] >= 2) {
    team.status = 'finished';
    broadcast(allPlayers, { type: 'team_over', teamId, winner: teamSide, scores: team.scores });
  }
}

// ─── Spectator Handling ───────────────────────────────────────────────────────
function handleSpectate(wsId, msg) {
  const { gameId } = msg;
  const game = games.get(gameId);
  if (!game) { send(wsId, { type: 'error', msg: 'Game not found' }); return; }

  const specSet = spectators.get(gameId) || new Set();
  specSet.add(wsId);
  spectators.set(gameId, specSet);
  const c = clients.get(wsId);
  if (c) c.roomId = gameId;

  send(wsId, { type: 'spectate_ok', gameId, moves: game.moves, clocks: game.clocks, colors: game.colors });
}

function handleSpectatorBet(wsId, msg) {
  const { gameId, side, amount } = msg;
  const game = games.get(gameId);
  if (!game || game.status !== 'active') { send(wsId, { type: 'error', msg: 'Game not active' }); return; }

  const sideKey = side === 'white' ? 'white' : 'black';
  game.spectatorBets[sideKey].push({ wsId, amount: parseFloat(amount) || 0 });

  const totalWhite = game.spectatorBets.white.reduce((s, b) => s + b.amount, 0);
  const totalBlack = game.spectatorBets.black.reduce((s, b) => s + b.amount, 0);
  broadcastRoom(gameId, { type: 'odds_update', gameId, whitePool: totalWhite, blackPool: totalBlack });
}

// ─── Lichess Live Sportsbook Streaming ───────────────────────────────────────

function sportsbookPayload(channelName) {
  const g = liveSportsbookGames.get(channelName);
  if (!g) return null;
  const totalW = g.whiteBets.reduce((s, b) => s + b.amount, 0);
  const totalB = g.blackBets.reduce((s, b) => s + b.amount, 0);
  return {
    type: 'sportsbook_update',
    channelName,
    displayName: CHANNEL_DISPLAY[channelName] || channelName,
    gameId: g.gameId,
    fen: g.fen,
    lastMove: g.lastMove,
    players: g.players,
    clocks: g.clocks,
    whitePool: totalW,
    blackPool: totalB,
  };
}

function broadcastSportsbookUpdate(channelName) {
  if (!sportsbookWatchers.size) return;
  const payload = sportsbookPayload(channelName);
  if (payload) broadcast([...sportsbookWatchers], payload);
}

function handleLichessEvent(channelName, msg) {
  if (msg.t === 'featured') {
    const { id, players, fen, orientation } = msg.d;
    const white = (players || []).find(p => p.color === 'white') || {};
    const black = (players || []).find(p => p.color === 'black') || {};

    // When a new game starts on this channel, carry over bets only if same gameId
    const existing = liveSportsbookGames.get(channelName);
    const whiteBets = (existing && existing.gameId === id) ? existing.whiteBets : [];
    const blackBets = (existing && existing.gameId === id) ? existing.blackBets : [];

    liveSportsbookGames.set(channelName, {
      gameId: id,
      channelName,
      fen: fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
      lastMove: null,
      players: {
        white: { name: white.user?.name || '?', rating: white.rating || 0 },
        black: { name: black.user?.name || '?', rating: black.rating || 0 },
      },
      clocks: {
        w: typeof white.seconds === 'number' ? white.seconds : 300,
        b: typeof black.seconds === 'number' ? black.seconds : 300,
      },
      whiteBets,
      blackBets,
    });
    broadcastSportsbookUpdate(channelName);

  } else if (msg.t === 'fen') {
    const game = liveSportsbookGames.get(channelName);
    if (!game) return;
    game.fen = msg.d.fen || game.fen;
    game.lastMove = msg.d.lm || null;
    // Lichess sends centiseconds
    if (typeof msg.d.wc === 'number') game.clocks.w = Math.floor(msg.d.wc / 100);
    if (typeof msg.d.bc === 'number') game.clocks.b = Math.floor(msg.d.bc / 100);
    broadcastSportsbookUpdate(channelName);
  }
}

async function startChannelStream(channelName) {
  if (activeChannelStreams.has(channelName)) return;
  const controller = new AbortController();
  activeChannelStreams.set(channelName, controller);

  try {
    const res = await fetch(`https://lichess.org/api/tv/${channelName}/feed`, {
      headers: { Accept: 'application/x-ndjson' },
      signal: controller.signal,
    });

    if (!res.ok) {
      console.warn(`[sportsbook] Channel ${channelName} returned ${res.status}`);
      activeChannelStreams.delete(channelName);
      setTimeout(() => startChannelStream(channelName), 15000);
      return;
    }

    let buf = '';
    res.body.on('data', chunk => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop(); // keep any incomplete line
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try { handleLichessEvent(channelName, JSON.parse(trimmed)); } catch (_) {}
      }
    });

    res.body.on('end', () => {
      activeChannelStreams.delete(channelName);
      setTimeout(() => startChannelStream(channelName), 5000);
    });

    res.body.on('error', err => {
      if (err.name !== 'AbortError') console.warn(`[sportsbook] Stream error ${channelName}:`, err.message);
      activeChannelStreams.delete(channelName);
      setTimeout(() => startChannelStream(channelName), 10000);
    });

  } catch (err) {
    if (err.name !== 'AbortError') console.warn(`[sportsbook] Connect error ${channelName}:`, err.message);
    activeChannelStreams.delete(channelName);
    setTimeout(() => startChannelStream(channelName), 15000);
  }
}

function initSportsbookStreams() {
  // Stagger starts to avoid hammering Lichess at once
  TRACKED_CHANNELS.forEach((ch, i) => {
    setTimeout(() => startChannelStream(ch), i * 1500);
  });
}

// Handle sportsbook bets (now stored inside liveSportsbookGames)
function handleSportsbookBet(wsId, msg) {
  const { channelName, side, amount } = msg;
  const game = liveSportsbookGames.get(channelName);
  if (!game) { send(wsId, { type: 'error', msg: 'Channel not found' }); return; }

  const amt = parseFloat(amount) || 0;
  if (amt <= 0) { send(wsId, { type: 'error', msg: 'Invalid amount' }); return; }

  if (side === 'white') game.whiteBets.push({ wsId, amount: amt });
  else game.blackBets.push({ wsId, amount: amt });

  send(wsId, { type: 'bet_placed', channelName, side, amount: amt });
  broadcastSportsbookUpdate(channelName);
}

// ─── Daily Puzzle ─────────────────────────────────────────────────────────────
async function getDailyPuzzle() {
  const today = todayStr();
  if (dailyPuzzleCache && dailyPuzzleDate === today) return dailyPuzzleCache;
  try {
    const res = await fetch('https://lichess.org/api/puzzle/daily', {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error('Lichess puzzle API returned ' + res.status);
    const data = await res.json();
    dailyPuzzleCache = {
      id: data.puzzle.id,
      fen: data.game.fen,
      moves: data.puzzle.solution,
      rating: data.puzzle.rating,
      initialMove: data.game.pgn ? data.game.pgn.split(' ').pop() : null,
    };
    dailyPuzzleDate = today;

    // Init pool for today if not already
    if (!dailyPuzzlePools.has(today)) {
      dailyPuzzlePools.set(today, { pool: 0, entries: new Map() });
    }
    return dailyPuzzleCache;
  } catch (e) {
    console.warn('[daily] Puzzle fetch failed:', e.message);
    return dailyPuzzleCache;
  }
}

// Refresh daily puzzle at midnight UTC
function scheduleDailyPuzzleRefresh() {
  const now = new Date();
  const nextMidnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  const msUntilMidnight = nextMidnight.getTime() - now.getTime();
  setTimeout(async () => {
    dailyPuzzleCache = null;
    dailyPuzzleDate = null;
    await getDailyPuzzle();
    scheduleDailyPuzzleRefresh();
  }, msUntilMidnight);
}

// ─── Puzzle Buy-in ────────────────────────────────────────────────────────────
async function fetchLichessPuzzle(difficulty) {
  const ratings = { easy: '1000,1400', medium: '1400,1800', hard: '1800,2400' };
  const rng = ratings[difficulty] || ratings.medium;
  try {
    const res = await fetch(`https://lichess.org/api/puzzle/next?rating=${rng}`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error('status ' + res.status);
    return await res.json();
  } catch (e) {
    console.warn('[puzzle] fetch failed:', e.message);
    return null;
  }
}

function handleEnterDaily(wsId, msg) {
  const { walletAddress } = msg;
  const today = todayStr();
  const pool = dailyPuzzlePools.get(today);
  if (!pool) { send(wsId, { type: 'error', msg: 'Daily puzzle not loaded yet' }); return; }
  if (pool.entries.has(walletAddress)) { send(wsId, { type: 'error', msg: 'Already entered' }); return; }

  const ENTRY_FEE = 0.05;
  pool.pool += ENTRY_FEE;
  pool.entries.set(walletAddress, { wsId, startTs: null, solved: false, timeMs: null });

  if (!dailyPuzzleCache) { send(wsId, { type: 'error', msg: 'Puzzle not available' }); return; }
  send(wsId, {
    type: 'daily_state',
    puzzle: dailyPuzzleCache,
    pool: pool.pool,
    entries: pool.entries.size,
    topTimes: getTopTimes(today),
  });
}

function handleDailyStart(wsId, msg) {
  const { walletAddress } = msg;
  const today = todayStr();
  const pool = dailyPuzzlePools.get(today);
  if (!pool || !pool.entries.has(walletAddress)) return;
  const entry = pool.entries.get(walletAddress);
  if (!entry.startTs) entry.startTs = Date.now();
}

function handlePuzzleSolve(wsId, msg) {
  const { puzzleId, move, timeMs, walletAddress, difficulty } = msg;

  if (puzzleId === 'daily') {
    const today = todayStr();
    const pool = dailyPuzzlePools.get(today);
    if (!pool || !pool.entries.has(walletAddress)) return;
    const entry = pool.entries.get(walletAddress);
    if (entry.solved) return;

    const puzzle = dailyPuzzleCache;
    const correct = puzzle && puzzle.moves && puzzle.moves[0] === move;
    if (correct) {
      entry.solved = true;
      entry.timeMs = timeMs;
    }
    send(wsId, { type: 'puzzle_result', correct, reward: correct ? 'pending' : 0, solution: puzzle?.moves });
    // Broadcast updated leaderboard
    broadcastDailyUpdate(today);
    return;
  }

  // Puzzle buy-in
  const tier = puzzlePools[difficulty];
  if (!tier) return;
  const puzzle = tier.activePuzzles.find(p => p.id === puzzleId);
  if (!puzzle) return;
  const correct = puzzle.solution && puzzle.solution[0] === move;
  send(wsId, { type: 'puzzle_result', correct, reward: correct ? (tier.pool / Math.max(1, tier.entries.size)).toFixed(4) : 0, solution: puzzle.solution });
}

function getTopTimes(dateStr) {
  const pool = dailyPuzzlePools.get(dateStr);
  if (!pool) return [];
  return [...pool.entries.entries()]
    .filter(([, e]) => e.solved && e.timeMs != null)
    .sort((a, b) => a[1].timeMs - b[1].timeMs)
    .slice(0, 5)
    .map(([addr, e]) => ({ addr: addr.slice(0, 6) + '...', timeMs: e.timeMs }));
}

function broadcastDailyUpdate(dateStr) {
  const pool = dailyPuzzlePools.get(dateStr);
  if (!pool) return;
  const payload = {
    type: 'daily_state',
    puzzle: dailyPuzzleCache,
    pool: pool.pool,
    entries: pool.entries.size,
    topTimes: getTopTimes(dateStr),
  };
  for (const [wsId] of clients) {
    const c = clients.get(wsId);
    if (c && c.inDaily) send(wsId, payload);
  }
}

// ─── Tournament ───────────────────────────────────────────────────────────────
function handleJoinTournament(wsId, msg) {
  const { tournamentId } = msg;
  const t = tournaments[tournamentId] || Object.values(tournaments).find(t => t.id === tournamentId);
  if (!t) { send(wsId, { type: 'error', msg: 'Tournament not found' }); return; }
  if (t.registered.includes(wsId)) { send(wsId, { type: 'error', msg: 'Already registered' }); return; }
  if (t.registered.length >= t.maxPlayers) { send(wsId, { type: 'error', msg: 'Tournament full' }); return; }

  t.registered.push(wsId);
  send(wsId, { type: 'tournament_joined', tournamentId: t.id, position: t.registered.length, maxPlayers: t.maxPlayers });
  broadcast(t.registered, { type: 'tournament_update', tournamentId: t.id, registered: t.registered.length, maxPlayers: t.maxPlayers, bracket: t.bracket, status: t.status });

  if (t.registered.length >= t.maxPlayers) {
    startTournament(t);
  }
}

function startTournament(t) {
  t.status = 'active';
  if (t.type === 'speed') {
    t.bracket = buildSingleElimBracket(t.registered);
  } else {
    t.bracket = buildSwissBracket(t.registered);
  }
  broadcast(t.registered, { type: 'tournament_update', tournamentId: t.id, bracket: t.bracket, status: t.status });
  // Start first round games
  startTournamentRound(t);
}

function buildSingleElimBracket(players) {
  const shuffled = [...players].sort(() => Math.random() - 0.5);
  const rounds = [];
  let current = shuffled.map(id => ({ wsId: id, name: id.slice(0, 6) }));
  while (current.length > 1) {
    const pairs = [];
    for (let i = 0; i < current.length; i += 2) {
      pairs.push({ playerA: current[i], playerB: current[i + 1] || null, winner: null });
    }
    rounds.push(pairs);
    current = pairs.map(() => ({ wsId: null, name: 'TBD' }));
  }
  return { type: 'single_elim', rounds, currentRound: 0 };
}

function buildSwissBracket(players) {
  const standing = players.map(id => ({ wsId: id, points: 0, opponents: [] }));
  return { type: 'swiss', rounds: 5, currentRound: 0, standing, pairings: [] };
}

function startTournamentRound(t) {
  if (!t.bracket) return;
  if (t.bracket.type === 'single_elim') {
    const round = t.bracket.rounds[t.bracket.currentRound];
    round.forEach(pair => {
      if (!pair.playerA || !pair.playerB) return;
      const gameId = generateId();
      const game = {
        id: gameId,
        players: [pair.playerA.wsId, pair.playerB.wsId],
        colors: { [pair.playerA.wsId]: 'w', [pair.playerB.wsId]: 'b' },
        wager: t.entryFee,
        timeControl: t.timeControl,
        moves: [],
        clocks: { w: parseTimeControl(t.timeControl), b: parseTimeControl(t.timeControl) },
        lastMoveTs: null,
        status: 'active',
        tournamentId: t.id,
      };
      games.set(gameId, game);
      pair.gameId = gameId;
      send(pair.playerA.wsId, { type: 'game_found', gameId, color: 'w', opponent: pair.playerB.name, wager: t.entryFee });
      send(pair.playerB.wsId, { type: 'game_found', gameId, color: 'b', opponent: pair.playerA.name, wager: t.entryFee });
    });
  }
}

// ─── Sportsbook Bet ───────────────────────────────────────────────────────────
function handleSportsbookBet(wsId, msg) {
  const { matchId, side, amount } = msg;
  if (!sportsbookBets.has(matchId)) {
    sportsbookBets.set(matchId, { white: [], black: [], pool: 0, status: 'open' });
  }
  const bet = sportsbookBets.get(matchId);
  if (bet.status !== 'open') { send(wsId, { type: 'error', msg: 'Betting closed' }); return; }

  const sideKey = side === 'white' ? 'white' : 'black';
  bet[sideKey].push({ wsId, amount: parseFloat(amount) || 0 });
  bet.pool += parseFloat(amount) || 0;

  const totalW = bet.white.reduce((s, b) => s + b.amount, 0);
  const totalB = bet.black.reduce((s, b) => s + b.amount, 0);

  // Broadcast odds update to all connected clients
  for (const [id] of clients) {
    send(id, { type: 'odds_update', matchId, whitePool: totalW, blackPool: totalB });
  }
  send(wsId, { type: 'bet_placed', matchId, side, amount });
}

// ─── WebSocket Message Router ─────────────────────────────────────────────────
wss.on('connection', (ws) => {
  const wsId = String(++clientIdCounter);
  clients.set(wsId, { ws, walletAddress: null, gameId: null, roomId: null, teamId: null, inDaily: false });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'identify':
        clients.get(wsId).walletAddress = msg.walletAddress;
        send(wsId, { type: 'identified', wsId });
        break;

      case 'join_queue': {
        // Remove any existing queue entry for this client
        queues['1v1'] = queues['1v1'].filter(q => q.wsId !== wsId);
        queues['1v1'].push({ wsId, wager: parseFloat(msg.wager) || 0, timeControl: msg.timeControl || '5+0', color: msg.color || 'random', elo: msg.elo || 1200, ts: Date.now() });
        send(wsId, { type: 'queue_position', position: queues['1v1'].length, eta: queues['1v1'].length * 10 });
        tryMatch1v1();
        break;
      }

      case 'leave_queue':
        queues['1v1'] = queues['1v1'].filter(q => q.wsId !== wsId);
        break;

      case 'join_team_queue':
        queues['team'] = queues['team'].filter(q => q.wsId !== wsId);
        queues['team'].push({ wsId, wager: parseFloat(msg.wager) || 0, teamCode: msg.teamCode || null });
        send(wsId, { type: 'queue_position', position: queues['team'].length, eta: queues['team'].length * 10 });
        tryMatchTeam();
        break;

      case 'join_tournament':
        handleJoinTournament(wsId, msg);
        break;

      case 'move':
        handleMove(wsId, msg);
        break;

      case 'resign':
        handleResign(wsId, msg);
        break;

      case 'spectate':
        handleSpectate(wsId, msg);
        break;

      case 'spectator_bet':
        handleSpectatorBet(wsId, msg);
        break;

      case 'place_bet':
        handleSportsbookBet(wsId, msg);
        break;

      case 'watch_sportsbook':
        sportsbookWatchers.add(wsId);
        // Send current state for all tracked channels immediately
        for (const ch of TRACKED_CHANNELS) {
          const payload = sportsbookPayload(ch);
          if (payload) send(wsId, payload);
        }
        break;

      case 'unwatch_sportsbook':
        sportsbookWatchers.delete(wsId);
        break;

      case 'enter_daily': {
        const c = clients.get(wsId);
        if (c) c.inDaily = true;
        handleEnterDaily(wsId, msg);
        break;
      }

      case 'daily_start':
        handleDailyStart(wsId, msg);
        break;

      case 'puzzle_solve':
        handlePuzzleSolve(wsId, msg);
        break;

      case 'get_live_games': {
        const liveGames = [...games.values()]
          .filter(g => g.status === 'active' && !g.teamId && !g.tournamentId)
          .map(g => ({ id: g.id, wager: g.wager, timeControl: g.timeControl, moves: g.moves.length }));
        send(wsId, { type: 'live_games', games: liveGames });
        break;
      }

      default:
        console.log('[ws] Unknown message type:', msg.type);
    }
  });

  ws.on('close', () => {
    const c = clients.get(wsId);
    if (c) {
      // Remove from queues
      queues['1v1'] = queues['1v1'].filter(q => q.wsId !== wsId);
      queues['team'] = queues['team'].filter(q => q.wsId !== wsId);

      // Forfeit active game after 60s
      if (c.gameId) {
        const game = games.get(c.gameId);
        if (game && game.status === 'active') {
          setTimeout(() => {
            const game2 = games.get(c.gameId);
            if (game2 && game2.status === 'active') {
              const disconnColor = game2.colors[wsId];
              const winner = disconnColor === 'w' ? 'b' : 'w';
              endGame(c.gameId, winner, 'disconnect');
            }
          }, 60000);
        }
      }

      // Remove from spectators
      if (c.roomId) {
        const specSet = spectators.get(c.roomId);
        if (specSet) specSet.delete(wsId);
      }
      // Remove from sportsbook watchers
      sportsbookWatchers.delete(wsId);
    }
    clients.delete(wsId);
  });

  ws.on('error', (err) => console.warn('[ws] Error:', err.message));
});

// ─── REST API ─────────────────────────────────────────────────────────────────

// Live sportsbook state (all tracked channels)
app.get('/api/sportsbook/live', (req, res) => {
  const games = TRACKED_CHANNELS
    .map(ch => sportsbookPayload(ch))
    .filter(Boolean);
  res.json(games);
});

// Daily puzzle
app.get('/api/daily/puzzle', async (req, res) => {
  try {
    const puzzle = await getDailyPuzzle();
    const today = todayStr();
    const pool = dailyPuzzlePools.get(today) || { pool: 0, entries: new Map() };
    res.json({ puzzle, pool: pool.pool, entries: pool.entries.size, topTimes: getTopTimes(today) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Puzzle by difficulty
app.get('/api/puzzle/:difficulty', async (req, res) => {
  const { difficulty } = req.params;
  if (!['easy', 'medium', 'hard'].includes(difficulty)) return res.status(400).json({ error: 'Invalid difficulty' });
  try {
    const puzzle = await fetchLichessPuzzle(difficulty);
    if (!puzzle) return res.status(503).json({ error: 'Puzzle fetch failed' });
    res.json(puzzle);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Tournament state
app.get('/api/tournament/:id', (req, res) => {
  const t = tournaments[req.params.id] || [...Object.values(tournaments)].find(t => t.id === req.params.id);
  if (!t) return res.status(404).json({ error: 'Not found' });
  res.json({ id: t.id, name: t.name, status: t.status, registered: t.registered.length, maxPlayers: t.maxPlayers, entryFee: t.entryFee, timeControl: t.timeControl, bracket: t.bracket });
});

// Live games list
app.get('/api/games/live', (req, res) => {
  const liveGames = [...games.values()]
    .filter(g => g.status === 'active')
    .map(g => ({ id: g.id, wager: g.wager, timeControl: g.timeControl, moves: g.moves.length, spectators: (spectators.get(g.id) || new Set()).size }));
  res.json(liveGames);
});

// NFT mint transaction builder
app.post('/api/nft/build-mint-tx', async (req, res) => {
  const { walletPubkey, setId } = req.body;
  if (!walletPubkey || !setId) return res.status(400).json({ error: 'Missing walletPubkey or setId' });

  const nftSets = {
    'classic-gold':  { name: 'Classic Gold Chess Set', symbol: 'CGCS',  mintEnv: process.env.NFT_CLASSIC_GOLD_MINT },
    'neon-circuit':  { name: 'Neon Circuit Chess Set',  symbol: 'NCCS',  mintEnv: process.env.NFT_NEON_CIRCUIT_MINT },
    'midnight':      { name: 'Midnight Chess Set',       symbol: 'MDCS',  mintEnv: process.env.NFT_MIDNIGHT_MINT },
    'ice':           { name: 'Ice Chess Set',             symbol: 'ICCS',  mintEnv: process.env.NFT_ICE_MINT },
    'pixel':         { name: 'Pixel Chess Set',           symbol: 'PXCS',  mintEnv: process.env.NFT_PIXEL_MINT },
    'samurai':       { name: 'Samurai Chess Set',         symbol: 'SMCS',  mintEnv: process.env.NFT_SAMURAI_MINT },
  };

  const set = nftSets[setId];
  if (!set) return res.status(400).json({ error: 'Unknown set ID' });
  if (!set.mintEnv) return res.status(503).json({ error: 'Collection not configured on server' });

  // In a real implementation this would use @metaplex-foundation/js to build and serialize
  // a mint transaction. For now, return a stub indicating the feature is wired up.
  res.json({
    status: 'stub',
    message: 'Set HELIUS_API_KEY and NFT collection mints in .env to enable real minting.',
    set: { id: setId, name: set.name, collectionMint: set.mintEnv },
  });
});

// Sportsbook bet state
app.get('/api/sportsbook/bets/:matchId', (req, res) => {
  const bet = sportsbookBets.get(req.params.matchId);
  if (!bet) return res.json({ whitePool: 0, blackPool: 0, status: 'open' });
  const totalW = bet.white.reduce((s, b) => s + b.amount, 0);
  const totalB = bet.black.reduce((s, b) => s + b.amount, 0);
  res.json({ whitePool: totalW, blackPool: totalB, status: bet.status });
});

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`Chess Hussle server running on http://localhost:${PORT}`);
  console.log(`WebSocket available at ws://localhost:${PORT}`);
  // Pre-fetch daily puzzle
  getDailyPuzzle().then(p => {
    if (p) console.log('[daily] Puzzle loaded:', p.id);
    else console.warn('[daily] Could not load puzzle at startup');
  });
  // Start Lichess TV streams
  initSportsbookStreams();
  console.log('[sportsbook] Connecting to Lichess TV channels:', TRACKED_CHANNELS.join(', '));
  scheduleDailyPuzzleRefresh();
});
