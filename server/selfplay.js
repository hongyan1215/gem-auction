// selfplay.js — headless 5-bot full-game simulator
'use strict';

const { GameState, BID_DURATION_MS, REVEAL_DURATION_MS, RESOLUTION_VIEW_MS } = require('./GameState');
const { botPickBid, botPickReveal, makeBotProfile, rollTraits, BOT_ARCHETYPES } = require('./bot');

const N = parseInt(process.argv[2] || '500', 10);

const STYLES = Object.keys(BOT_ARCHETYPES);

function runOne() {
  const specs = STYLES.slice(0, 8); // we have 8 archetypes; pick 5 random unique
  // shuffle
  for (let i = specs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [specs[i], specs[j]] = [specs[j], specs[i]];
  }
  const chosen = specs.slice(0, 5);
  const playerSpecs = chosen.map((style, i) => {
    return { id: 'b' + i, name: style, isBot: true,
      profile: { style, traits: rollTraits(style), name: style } };
  });

  const game = new GameState(playerSpecs);
  // Patch out setTimeout-driven flow — we drive synchronously
  game.startGame();
  // Skip PREGAME countdown for headless self-play
  if (game.phase === 'PREGAME') game.beginFirstRound();

  let safety = 200;
  while (game.phase !== 'GAME_OVER' && safety-- > 0) {
    if (game.phase === 'BIDDING') {
      for (const p of game.players) {
        const bid = botPickBid(p, game);
        game.submitBid(p.id, bid);
      }
      game.resolveBidding();
      if (game.phase === 'AWAITING_REVEAL') {
        const winner = game.players[game.winner.seat];
        const pick = botPickReveal(winner, game);
        game.submitReveal(winner.id, pick);
      }
      // _postResolve uses setTimeout for next round; trigger manually
      if (game.phase !== 'GAME_OVER') {
        game._beginNextRound();
      }
    } else {
      break;
    }
  }
  // Force end if not over
  if (game.phase !== 'GAME_OVER') game._endGame();
  return { game, players: playerSpecs };
}

const stats = {}; // style -> {games, wins, totalScore, totalRank}

for (let i = 0; i < N; i++) {
  const { game, players } = runOne();
  const results = game.endgame.results;
  // Map player id -> style
  const idToStyle = {};
  for (const p of players) idToStyle[p.id] = p.profile.style;

  results.forEach((r, rank) => {
    const style = idToStyle[r.id];
    if (!stats[style]) stats[style] = { games: 0, wins: 0, totalScore: 0, totalRank: 0 };
    stats[style].games++;
    if (rank === 0) stats[style].wins++;
    stats[style].totalScore += r.total;
    stats[style].totalRank += (rank + 1);
  });
}

console.log(`=== Self-play results over ${N} games ===`);
console.log('Archetype'.padEnd(16) + 'Games'.padEnd(8) + 'WinRate'.padEnd(10) + 'AvgScore'.padEnd(11) + 'AvgRank');
const rows = Object.entries(stats).sort((a, b) => b[1].wins / b[1].games - a[1].wins / a[1].games);
for (const [style, s] of rows) {
  const wr = (s.wins / s.games * 100).toFixed(1) + '%';
  const sc = (s.totalScore / s.games).toFixed(1);
  const rk = (s.totalRank / s.games).toFixed(2);
  console.log(style.padEnd(16) + String(s.games).padEnd(8) + wr.padEnd(10) + sc.padEnd(11) + rk);
}
