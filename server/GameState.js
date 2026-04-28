// GameState.js — authoritative game logic for 5-player gem auction
'use strict';

const GEM_TYPES = ['RUBY', 'SAPPHIRE', 'EMERALD', 'TOPAZ', 'AMETHYST'];
const GEMS_PER_TYPE = 6;
const PLAYERS = 5;
const STARTING_MONEY = 20;
const HIDDEN_GEMS_PER_PLAYER = 3;
const TOTAL_GEM_AUCTIONS = 15;

const BID_DURATION_MS = 10_000;
const REVEAL_DURATION_MS = 8_000;
const RESOLUTION_VIEW_MS = 4_000;

// Card deck spec
function buildDeck() {
  const deck = [];
  for (let i = 0; i < 13; i++) deck.push({ kind: 'AUCTION_GEM', size: 1 });
  for (let i = 0; i < 4; i++)  deck.push({ kind: 'AUCTION_GEM', size: 2 });
  deck.push({ kind: 'INVEST', value: 5 });
  deck.push({ kind: 'INVEST', value: 5 });
  deck.push({ kind: 'INVEST', value: 10 });
  deck.push({ kind: 'INVEST', value: 10 });
  deck.push({ kind: 'LOAN', value: 10 });
  deck.push({ kind: 'LOAN', value: 10 });
  deck.push({ kind: 'LOAN', value: 20 });
  deck.push({ kind: 'LOAN', value: 20 });
  return deck;
}

// Mission templates
function buildMissionPool() {
  const pool = [];
  // 2 specific gems +5
  for (let i = 0; i < GEM_TYPES.length; i++) {
    for (let j = i + 1; j < GEM_TYPES.length; j++) {
      pool.push({ type: 'TWO_SPECIFIC', gems: [GEM_TYPES[i], GEM_TYPES[j]], score: 5 });
    }
  }
  // 3 specific gems +10
  for (let i = 0; i < GEM_TYPES.length; i++) {
    for (let j = i + 1; j < GEM_TYPES.length; j++) {
      for (let k = j + 1; k < GEM_TYPES.length; k++) {
        pool.push({ type: 'THREE_SPECIFIC', gems: [GEM_TYPES[i], GEM_TYPES[j], GEM_TYPES[k]], score: 10 });
      }
    }
  }
  // 4 different gems +10
  pool.push({ type: 'FOUR_DIFFERENT', score: 10 });
  // 3 of a kind (any) +10
  pool.push({ type: 'THREE_OF_A_KIND', score: 10 });
  return pool;
}

const shuffle = (a) => {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
};

const counts = (arr) => {
  const c = {};
  for (const x of arr) c[x] = (c[x] || 0) + 1;
  return c;
};

// V(n) = min(4n, 20); n=0 => 0
const valueForCount = (n) => n <= 0 ? 0 : Math.min(4 * n, 20);

// Mission satisfied?
function meets(mission, wonGems) {
  const c = counts(wonGems);
  switch (mission.type) {
    case 'TWO_SPECIFIC':
      return mission.gems.every(g => c[g]);
    case 'THREE_SPECIFIC':
      return mission.gems.every(g => c[g]);
    case 'FOUR_DIFFERENT':
      return Object.keys(c).length >= 4;
    case 'THREE_OF_A_KIND':
      return Object.values(c).some(v => v >= 3);
  }
  return false;
}

class GameState {
  constructor(playerSpecs /* [{id, name, isBot, profile?}] */) {
    if (playerSpecs.length !== PLAYERS) throw new Error('Need exactly 5 players');

    // --- Build pools
    const allGems = [];
    for (const t of GEM_TYPES) for (let i = 0; i < GEMS_PER_TYPE; i++) allGems.push(t);
    const shuffled = shuffle(allGems);
    this.auctionPool = shuffled.slice(0, 15);     // available for auction (15)
    this.unusedPool  = shuffled.slice(15);        // distributed as hidden (15)

    // --- Players
    this.players = playerSpecs.map((s, idx) => ({
      id: s.id,
      name: s.name,
      isBot: !!s.isBot,
      profile: s.profile || null,
      seat: idx,
      money: STARTING_MONEY,
      wonGems: [],
      hiddenGems: this.unusedPool.slice(idx * HIDDEN_GEMS_PER_PLAYER, (idx + 1) * HIDDEN_GEMS_PER_PLAYER),
      revealedGems: [],
      investments: [], // [{value, paid}]
      loans: [],       // [{value, received}]
      score: 0,        // mission score only (cash & gems counted at end)
      connected: true,
    }));

    // --- Deck
    this.deck = shuffle(buildDeck());

    // --- Market: 2 face-up gems from auction pool
    this.market = [this.auctionPool.shift(), this.auctionPool.shift()].filter(Boolean);

    // --- Missions: 4 random
    const pool = shuffle(buildMissionPool());
    this.missions = pool.slice(0, 4).map(m => ({ ...m, completedBy: null }));

    // --- Round state
    this.round = 0;
    this.phase = 'WAITING'; // WAITING | DRAW | BIDDING | RESOLVING | AWAITING_REVEAL | GAME_OVER
    this.currentCard = null;
    this.currentLot = []; // [gemType] for AUCTION_GEM; empty for INVEST/LOAN
    this.bids = new Map(); // playerId -> amount (hidden during bidding)
    this.bidDeadline = 0;
    this.winner = null;
    this.lastWinnerSeat = null;
    this.gemsAuctionedCount = 0;
    this.bidHistory = []; // [{round, cardKind, lotSize, lot, cardValue, bids: {pid: amt}}]
    this.revealDeadline = 0;
    this.endgame = null; // computed at game over
    this.message = null;
  }

  // ============ Public API ============

  startGame() {
    if (this.phase !== 'WAITING') return;
    this._beginNextRound();
  }

  submitBid(playerId, amount) {
    if (this.phase !== 'BIDDING') return { ok: false, reason: 'not_bidding' };
    const p = this.players.find(x => x.id === playerId);
    if (!p) return { ok: false, reason: 'no_player' };
    let amt = Math.floor(Number(amount) || 0);
    if (amt < 0) amt = 0;
    if (amt > p.money) amt = p.money;
    this.bids.set(playerId, amt);
    return { ok: true, amount: amt };
  }

  hasBid(playerId) { return this.bids.has(playerId); }

  resolveBidding() {
    if (this.phase !== 'BIDDING') return null;
    this.phase = 'RESOLVING';

    for (const p of this.players) if (!this.bids.has(p.id)) this.bids.set(p.id, 0);

    // Record bid history (for opponent modeling)
    const bidsObj = {};
    for (const [pid, amt] of this.bids) bidsObj[pid] = amt;
    this.bidHistory.push({
      round: this.round,
      cardKind: this.currentCard ? this.currentCard.kind : null,
      cardValue: this.currentCard ? (this.currentCard.value || null) : null,
      lotSize: (this.currentLot || []).length,
      lot: (this.currentLot || []).slice(),
      bids: bidsObj,
    });

    const winnerSeat = this._pickWinnerSeat();
    const winnerPlayer = this.players[winnerSeat];
    const amount = this.bids.get(winnerPlayer.id);

    this._applyAuctionEffect(winnerPlayer, amount);
    this._checkMissions(winnerPlayer);

    this.winner = { playerId: winnerPlayer.id, seat: winnerSeat, amount };
    this.lastWinnerSeat = winnerSeat;

    const isGemCard = this.currentCard.kind === 'AUCTION_GEM';
    const needsReveal = winnerPlayer.hiddenGems.length > 0;

    if (needsReveal) {
      this.phase = 'AWAITING_REVEAL';
      this.revealDeadline = Date.now() + REVEAL_DURATION_MS;
    } else {
      this._postResolve();
    }
    return { winnerSeat, amount, card: this.currentCard, lot: this.currentLot.slice() };
  }

  submitReveal(playerId, gemType) {
    if (this.phase !== 'AWAITING_REVEAL') return { ok: false, reason: 'not_reveal' };
    if (!this.winner || this.winner.playerId !== playerId) return { ok: false, reason: 'not_your_turn' };
    const p = this.players[this.winner.seat];
    const idx = p.hiddenGems.indexOf(gemType);
    if (idx < 0) return { ok: false, reason: 'no_such_gem' };
    p.hiddenGems.splice(idx, 1);
    p.revealedGems.push(gemType);
    this._postResolve();
    return { ok: true };
  }

  // Auto-pick reveal (for bots or timeout): leak the LEAST valuable hidden gem
  autoReveal() {
    if (this.phase !== 'AWAITING_REVEAL') return;
    const p = this.players[this.winner.seat];
    if (!p.hiddenGems.length) { this._postResolve(); return; }
    // Pick the gem whose hidden type contributes least to V(n) endgame value for me
    // Simpler: pick the one with most copies in unused pool (so revealing changes V least)
    const unusedCounts = counts(this._allUnusedHiddenAndRevealed());
    let best = p.hiddenGems[0];
    let bestScore = -Infinity;
    for (const g of p.hiddenGems) {
      // Higher unusedCounts = revealing it tells less new info AND keeping it has redundant value
      const score = unusedCounts[g] || 0;
      if (score > bestScore) { bestScore = score; best = g; }
    }
    this.submitReveal(p.id, best);
  }

  // ============ Private ============

  _allUnusedHiddenAndRevealed() {
    const out = [];
    for (const p of this.players) {
      out.push(...p.hiddenGems, ...p.revealedGems);
    }
    return out;
  }

  _pickWinnerSeat() {
    const max = Math.max(...[...this.bids.values()]);
    const tiedSeats = this.players
      .filter(p => this.bids.get(p.id) === max)
      .map(p => p.seat);
    if (tiedSeats.length === 1) return tiedSeats[0];

    // Tie-break: nearest clockwise from lastWinnerSeat
    if (this.lastWinnerSeat == null) {
      return tiedSeats[Math.floor(Math.random() * tiedSeats.length)];
    }
    let bestSeat = tiedSeats[0];
    let bestDist = Infinity;
    for (const seat of tiedSeats) {
      const d = ((seat - this.lastWinnerSeat - 1 + PLAYERS) % PLAYERS) + 1; // start from left+1
      if (d < bestDist) { bestDist = d; bestSeat = seat; }
    }
    return bestSeat;
  }

  _applyAuctionEffect(p, amount) {
    const card = this.currentCard;
    if (card.kind === 'AUCTION_GEM') {
      p.money -= amount;
      for (const g of this.currentLot) p.wonGems.push(g);
      this.gemsAuctionedCount += this.currentLot.length;
    } else if (card.kind === 'INVEST') {
      p.money -= amount;
      p.investments.push({ value: card.value, paid: amount });
    } else if (card.kind === 'LOAN') {
      // Receive (cardValue - bid). Bid is interest.
      const received = Math.max(0, card.value - amount);
      p.money += received;
      p.money -= 0; // bid is consumed as interest (already not credited)
      p.loans.push({ value: card.value, interest: amount });
    }
  }

  _checkMissions(p) {
    for (const m of this.missions) {
      if (m.completedBy) continue;
      if (meets(m, p.wonGems)) {
        m.completedBy = p.id;
        p.score += m.score;
      }
    }
  }

  _postResolve() {
    // Refill market from auctionPool to size 2 (only if a gem was taken)
    while (this.market.length < 2 && this.auctionPool.length > 0) {
      this.market.push(this.auctionPool.shift());
    }

    if (this.gemsAuctionedCount >= TOTAL_GEM_AUCTIONS || this.deck.length === 0) {
      this._endGame();
      return;
    }
    setTimeout(() => this._beginNextRound(), RESOLUTION_VIEW_MS);
  }

  _beginNextRound() {
    if (this.phase === 'GAME_OVER') return;
    this.round += 1;
    this.bids.clear();
    this.winner = null;
    this.currentLot = [];
    this.currentCard = null;

    // Draw card
    let card = this.deck.shift();
    if (!card) { this._endGame(); return; }

    // If gem card but no market gems → skip card, draw next non-gem? We draw next.
    // Per spec: AUCTION_2_GEMS with only 1 in pool → only 1.
    while (card.kind === 'AUCTION_GEM' && this.market.length === 0 && this.deck.length > 0) {
      card = this.deck.shift();
    }
    this.currentCard = card;

    if (card.kind === 'AUCTION_GEM') {
      if (card.size === 1) {
        if (this.market.length > 0) this.currentLot = [this.market.shift()];
      } else {
        this.currentLot = this.market.splice(0, Math.min(2, this.market.length));
      }
      if (this.currentLot.length === 0) {
        // Nothing to auction; recurse
        this._beginNextRound();
        return;
      }
    }

    this.phase = 'BIDDING';
    this.bidDeadline = Date.now() + BID_DURATION_MS;
  }

  _endGame() {
    this.phase = 'GAME_OVER';
    // Force reveal all hidden
    for (const p of this.players) {
      p.revealedGems.push(...p.hiddenGems);
      p.hiddenGems = [];
    }
    // Compute V(n): n = total of each type in unused (hidden+revealed across all players)
    const allUnused = this._allUnusedHiddenAndRevealed();
    const ncount = counts(allUnused);
    const finalValue = {};
    for (const t of GEM_TYPES) finalValue[t] = valueForCount(ncount[t] || 0);

    const results = this.players.map(p => {
      const wonCounts = counts(p.wonGems);
      const gemScore = Object.entries(wonCounts).reduce((a, [t, c]) => a + c * (finalValue[t] || 0), 0);
      const investBonus = p.investments.reduce((a, i) => a + i.value, 0);
      const loanPenalty = p.loans.reduce((a, l) => a + l.value, 0);
      const total = p.money + gemScore + investBonus - loanPenalty + p.score;
      return {
        id: p.id, name: p.name, seat: p.seat,
        money: p.money,
        wonGems: p.wonGems.slice(),
        revealedGems: p.revealedGems.slice(),
        investments: p.investments.slice(),
        loans: p.loans.slice(),
        missionScore: p.score,
        gemScore, investBonus, loanPenalty,
        total,
      };
    }).sort((a, b) => b.total - a.total);
    this.endgame = { results, finalValue, ncount };
  }

  // Public snapshot for a viewer
  publicSnapshot(viewerId = null) {
    return {
      phase: this.phase,
      round: this.round,
      bidDeadline: this.bidDeadline,
      revealDeadline: this.revealDeadline,
      currentCard: this.currentCard,
      currentLot: this.currentLot.slice(),
      market: this.market.slice(),
      missions: this.missions.map(m => ({ ...m })),
      players: this.players.map(p => ({
        id: p.id, name: p.name, seat: p.seat, isBot: p.isBot, connected: p.connected,
        money: p.money,
        wonGems: p.wonGems.slice(),
        revealedGems: p.revealedGems.slice(),
        investments: p.investments.length,
        loans: p.loans.length,
        score: p.score,
        hiddenCount: p.hiddenGems.length,
        // Hidden gems only revealed to self
        hiddenGems: viewerId === p.id ? p.hiddenGems.slice() : null,
        hasBid: this.bids.has(p.id),
      })),
      winner: this.winner,
      lastWinnerSeat: this.lastWinnerSeat,
      gemsAuctionedCount: this.gemsAuctionedCount,
      auctionPoolRemaining: this.auctionPool.length,
      deckRemaining: this.deck.length,
      endgame: this.endgame,
    };
  }
}

module.exports = {
  GameState,
  GEM_TYPES, GEMS_PER_TYPE, PLAYERS, STARTING_MONEY, HIDDEN_GEMS_PER_PLAYER, TOTAL_GEM_AUCTIONS,
  BID_DURATION_MS, REVEAL_DURATION_MS, RESOLUTION_VIEW_MS,
  shuffle, counts, valueForCount, meets, buildDeck, buildMissionPool,
};
