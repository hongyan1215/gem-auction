// server.js — Express + Socket.io for gem auction
'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const { GameState, BID_DURATION_MS, REVEAL_DURATION_MS, RESOLUTION_VIEW_MS, PLAYERS } = require('./GameState');
const { botPickBid, botPickReveal, BOT_ARCHETYPES, rollTraits, makeBotProfile, randomBotName } = require('./bot');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(path.join(__dirname, '..', 'client')));
app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/rooms', (req, res) => {
  const now = Date.now();
  res.json({
    count: rooms.size,
    rooms: [...rooms.entries()].map(([code, r]) => ({
      code,
      members: r.members.length,
      liveHumans: r.members.filter(m => m.socketId !== null).length,
      phase: r.game ? r.game.phase : 'LOBBY',
      ageMin: ((now - (r.createdAt || now)) / 60000).toFixed(1),
      idleMin: ((now - (r.lastActivity || now)) / 60000).toFixed(1),
    })),
  });
});

const PORT = process.env.PORT || 4000;

// ============ Room management ============
const rooms = new Map(); // roomCode -> Room

class Room {
  constructor(code, hostSocketId) {
    this.code = code;
    this.host = hostSocketId;
    this.members = []; // [{socketId, id, name}]
    this.game = null;
    this.bidTimer = null;
    this.revealTimer = null;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
  }

  touch() { this.lastActivity = Date.now(); }

  publicLobby() {
    return {
      code: this.code,
      members: this.members.map(m => ({ id: m.id, name: m.name })),
      started: !!this.game,
    };
  }

  addMember(socketId, name, playerKey) {
    if (this.members.find(m => m.socketId === socketId)) return null;
    if (this.members.length >= PLAYERS) return null;
    const member = { socketId, id: 'p_' + Math.random().toString(36).slice(2, 10), name, playerKey };
    this.members.push(member);
    return member;
  }

  // Reattach a returning player by their persistent key. Returns the member or null.
  rejoin(socketId, playerKey) {
    if (!playerKey) return null;
    const member = this.members.find(m => m.playerKey === playerKey);
    if (!member) return null;
    member.socketId = socketId;
    if (this.game) {
      const p = this.game.players.find(pl => pl.id === member.id);
      if (p) {
        p.connected = true;
        p.isBot = false;
        p.profile = null;
      }
    }
    return member;
  }

  removeMember(socketId) {
    const idx = this.members.findIndex(m => m.socketId === socketId);
    if (idx < 0) return null;
    return this.members.splice(idx, 1)[0];
  }

  start() {
    // Shuffle members so seats are randomised each game
    const playerSpecs = this.members.slice();
    for (let i = playerSpecs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [playerSpecs[i], playerSpecs[j]] = [playerSpecs[j], playerSpecs[i]];
    }
    while (playerSpecs.length < PLAYERS) {
      const profile = makeBotProfile();
      playerSpecs.push({
        socketId: null,
        id: 'bot_' + Math.random().toString(36).slice(2, 9),
        name: profile.name,
        isBot: true,
        profile,
      });
    }
    this.game = new GameState(playerSpecs);
    this.game.startGame();
    this._broadcast();
    // Server-authoritative 10s pregame countdown — all clients sync from snap.pregameDeadline
    clearTimeout(this.pregameTimer);
    this.pregameTimer = setTimeout(() => {
      this.game.beginFirstRound();
      this._scheduleBidTimer();
      this._broadcast();
      this._maybeBotTurns();
    }, 10000);
  }

  _clearAllTimers() {
    clearTimeout(this.pregameTimer);
    clearTimeout(this.bidTimer);
    clearTimeout(this.revealTimer);
    this.pregameTimer = null;
    this.bidTimer = null;
    this.revealTimer = null;
  }

  resetForReplay() {
    this._clearAllTimers();
    this.game = null;
    // Drop bot members so the host can re-fill or wait for humans
    this.members = this.members.filter(m => m.socketId !== null);
    this._broadcast();
  }

  _scheduleBidTimer() {
    clearTimeout(this.bidTimer);
    if (this.game.phase !== 'BIDDING') return;
    const ms = Math.max(50, this.game.bidDeadline - Date.now());
    this.bidTimer = setTimeout(() => this._resolve(), ms);
  }

  _scheduleRevealTimer() {
    clearTimeout(this.revealTimer);
    if (this.game.phase !== 'AWAITING_REVEAL') return;
    const ms = Math.max(50, this.game.revealDeadline - Date.now());
    this.revealTimer = setTimeout(() => {
      this.game.autoReveal();
      this._broadcast();
      this._scheduleAfterReveal();
    }, ms);
  }

  _scheduleAfterReveal() {
    if (this.game.phase === 'BIDDING') this._scheduleBidTimer();
    else if (this.game.phase === 'AWAITING_REVEAL') this._scheduleRevealTimer();
    else if (this.game.phase === 'RESOLVING') {
      // Submitted reveal queued next round; rebroadcast & rearm when it lands.
      const delay = Math.max(50, (this.game.nextRoundAt || Date.now()) - Date.now()) + 100;
      setTimeout(() => {
        if (!this.game) return;
        this._broadcast();
        if (this.game.phase === 'BIDDING') {
          this._scheduleBidTimer();
          this._maybeBotTurns();
        }
      }, delay);
    }
    this._maybeBotTurns();
  }

  _resolve() {
    this.game.resolveBidding();
    this._broadcast();
    if (this.game.phase === 'AWAITING_REVEAL') {
      // If winner is bot, auto-reveal quickly with thinking
      const winner = this.game.players[this.game.winner.seat];
      if (winner.isBot) {
        const pick = botPickReveal(winner, this.game);
        setTimeout(() => {
          this.game.submitReveal(winner.id, pick);
          this._broadcast();
          this._scheduleAfterReveal();
        }, 600 + Math.random() * 800);
      } else {
        this._scheduleRevealTimer();
      }
    } else {
      // RESOLVING: GameState scheduled _beginNextRound; rearm based on its actual deadline.
      const delay = Math.max(50, (this.game.nextRoundAt || Date.now()) - Date.now()) + 100;
      setTimeout(() => {
        if (!this.game) return;
        this._broadcast();
        if (this.game.phase === 'BIDDING') {
          this._scheduleBidTimer();
          this._maybeBotTurns();
        }
      }, delay);
    }
  }

  _maybeBotTurns() {
    if (!this.game || this.game.phase !== 'BIDDING') return;
    for (const p of this.game.players) {
      if (!p.isBot || this.game.hasBid(p.id)) continue;
      const isSniper = (p.profile?.style || '').toLowerCase() === 'sniper';
      // Sniper cheats by peeking — schedule it last (after all other bots)
      const delay = isSniper
        ? BID_DURATION_MS - 600 - Math.random() * 400
        : 800 + Math.random() * (BID_DURATION_MS - 3500);
      setTimeout(() => {
        if (this.game && this.game.phase === 'BIDDING' && !this.game.hasBid(p.id)) {
          const bid = botPickBid(p, this.game);
          this.game.submitBid(p.id, bid);
          this._broadcast();
        }
      }, delay);
    }
  }

  _broadcast() {
    this.touch();
    if (!this.game) {
      io.to(this.code).emit('lobby', this.publicLobby());
      return;
    }
    for (const m of this.members) {
      if (!m.socketId) continue;
      io.to(m.socketId).emit('state', this.game.publicSnapshot(m.id));
    }
  }
}

// ============ Socket events ============
function makeRoomCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 4; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

io.on('connection', (socket) => {
  socket.data.roomCode = null;

  socket.on('createRoom', ({ name, playerKey }, cb) => {
    const code = (() => { let c; do { c = makeRoomCode(); } while (rooms.has(c)); return c; })();
    const room = new Room(code, socket.id);
    rooms.set(code, room);
    const member = room.addMember(socket.id, name || 'Player', playerKey);
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.memberId = member.id;
    cb && cb({ ok: true, code, you: member });
    room._broadcast();
  });

  socket.on('joinRoom', ({ code, name, playerKey }, cb) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return cb && cb({ ok: false, reason: 'no_room' });
    // If game already running, attempt rejoin via persistent key
    if (room.game) {
      const member = room.rejoin(socket.id, playerKey);
      if (!member) return cb && cb({ ok: false, reason: 'started' });
      socket.join(room.code);
      socket.data.roomCode = room.code;
      socket.data.memberId = member.id;
      cb && cb({ ok: true, code: room.code, you: member, rejoined: true });
      room._broadcast();
      return;
    }
    const member = room.addMember(socket.id, name || 'Player', playerKey);
    if (!member) return cb && cb({ ok: false, reason: 'full' });
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.memberId = member.id;
    cb && cb({ ok: true, code: room.code, you: member });
    room._broadcast();
  });

  // Pure rejoin: client knows code+key and just wants to reattach
  socket.on('rejoin', ({ code, playerKey }, cb) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return cb && cb({ ok: false, reason: 'no_room' });
    const member = room.rejoin(socket.id, playerKey);
    if (!member) return cb && cb({ ok: false, reason: 'no_seat' });
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.memberId = member.id;
    cb && cb({ ok: true, code: room.code, you: member, rejoined: true });
    room._broadcast();
  });

  socket.on('startGame', (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb && cb({ ok: false, reason: 'no_room' });
    if (room.host !== socket.id) return cb && cb({ ok: false, reason: 'not_host' });
    if (room.game) return cb && cb({ ok: false, reason: 'started' });
    room.start();
    cb && cb({ ok: true });
  });

  socket.on('restartGame', (_, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return cb && cb({ ok: false, reason: 'no_room' });
    if (!room.game || room.game.phase !== 'GAME_OVER') return cb && cb({ ok: false, reason: 'not_over' });
    // Anyone in the room can restart once the game is over (no host gating)
    room.resetForReplay();
    cb && cb({ ok: true });
  });

  socket.on('submitBid', ({ amount }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.game) return cb && cb({ ok: false });
    const r = room.game.submitBid(socket.data.memberId, amount);
    cb && cb(r);
    room._broadcast();
  });

  socket.on('reveal', ({ gem }, cb) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.game) return cb && cb({ ok: false });
    const r = room.game.submitReveal(socket.data.memberId, gem);
    cb && cb(r);
    room._broadcast();
    if (r.ok) {
      clearTimeout(room.revealTimer);
      // _postResolve scheduled _beginNextRound after a short delay; rebroadcast & rearm afterwards.
      const delay = Math.max(50, (room.game.nextRoundAt || Date.now()) - Date.now()) + 100;
      setTimeout(() => {
        if (!room.game) return;
        room._broadcast();
        if (room.game.phase === 'BIDDING') {
          room._scheduleBidTimer();
          room._maybeBotTurns();
        }
      }, delay);
    }
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    if (room.game) {
      // Mark disconnected; bots take over their bids. Keep member in list for rejoin.
      const p = room.game.players.find(p => p.id === socket.data.memberId);
      if (p) {
        p.connected = false;
        p.isBot = true;
        p.profile = makeBotProfile();
      }
      const m = room.members.find(m => m.socketId === socket.id);
      if (m) m.socketId = null; // keep playerKey for potential rejoin
      room._broadcast();
      room._maybeBotTurns();
    } else {
      room.removeMember(socket.id);
    }
    // Universal cleanup: if no live humans left in this room, nuke it.
    // Prevents zombie rooms (game-in-progress with everyone gone, or
    // GAME_OVER rooms abandoned without 再玩一局).
    const liveHumans = room.members.filter(m => m.socketId !== null).length;
    if (liveHumans === 0) {
      room._clearAllTimers();
      rooms.delete(code);
      console.log(`Room ${code} reaped (no live humans)`);
    } else if (!room.game) {
      room._broadcast();
    }
  });
});

// ---- Idle room sweeper ----
// Belt-and-suspenders: nuke any room idle > IDLE_TTL_MS even if disconnect
// handler missed it (e.g. orphaned game with all-bot members, weird socket states).
const IDLE_TTL_MS = 30 * 60 * 1000; // 30 min
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > IDLE_TTL_MS) {
      room._clearAllTimers && room._clearAllTimers();
      rooms.delete(code);
      console.log(`Room ${code} reaped (idle > ${IDLE_TTL_MS / 60000}min)`);
    }
  }
}, 60 * 1000); // check every minute

server.listen(PORT, () => {
  console.log(`Gem auction server on :${PORT}`);
});
