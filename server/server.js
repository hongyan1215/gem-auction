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
  }

  publicLobby() {
    return {
      code: this.code,
      members: this.members.map(m => ({ id: m.id, name: m.name })),
      started: !!this.game,
    };
  }

  addMember(socketId, name) {
    if (this.members.find(m => m.socketId === socketId)) return null;
    if (this.members.length >= PLAYERS) return null;
    const member = { socketId, id: 'p_' + socketId.slice(0, 8), name };
    this.members.push(member);
    return member;
  }

  removeMember(socketId) {
    const idx = this.members.findIndex(m => m.socketId === socketId);
    if (idx < 0) return null;
    return this.members.splice(idx, 1)[0];
  }

  start() {
    // Fill with bots
    const playerSpecs = this.members.slice();
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
      const delay = 800 + Math.random() * (BID_DURATION_MS - 2500);
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
    if (!this.game) {
      io.to(this.code).emit('lobby', this.publicLobby());
      return;
    }
    for (const m of this.members) {
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

  socket.on('createRoom', ({ name }, cb) => {
    const code = (() => { let c; do { c = makeRoomCode(); } while (rooms.has(c)); return c; })();
    const room = new Room(code, socket.id);
    rooms.set(code, room);
    const member = room.addMember(socket.id, name || 'Player');
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.memberId = member.id;
    cb && cb({ ok: true, code, you: member });
    room._broadcast();
  });

  socket.on('joinRoom', ({ code, name }, cb) => {
    const room = rooms.get(String(code || '').toUpperCase());
    if (!room) return cb && cb({ ok: false, reason: 'no_room' });
    if (room.game) return cb && cb({ ok: false, reason: 'started' });
    const member = room.addMember(socket.id, name || 'Player');
    if (!member) return cb && cb({ ok: false, reason: 'full' });
    socket.join(room.code);
    socket.data.roomCode = room.code;
    socket.data.memberId = member.id;
    cb && cb({ ok: true, code: room.code, you: member });
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
      // Mark disconnected; bots take over their bids
      const p = room.game.players.find(p => p.id === socket.data.memberId);
      if (p) {
        p.connected = false;
        p.isBot = true;
        p.profile = makeBotProfile();
      }
      room.members = room.members.filter(m => m.socketId !== socket.id);
      room._broadcast();
      room._maybeBotTurns();
    } else {
      room.removeMember(socket.id);
      if (room.members.length === 0) rooms.delete(code);
      else room._broadcast();
    }
  });
});

server.listen(PORT, () => {
  console.log(`Gem auction server on :${PORT}`);
});
