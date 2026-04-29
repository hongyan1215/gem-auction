// selfplay_godvsnewbies.js — God vs 4 Newbies, measure spoiler-overpay scenario
'use strict';

const { GameState } = require('./GameState');
const { botPickBid, botPickReveal, rollTraits } = require('./bot');

const N = parseInt(process.argv[2] || '2000', 10);
const SPECS = ['God', 'Newbie', 'Newbie', 'Newbie', 'Newbie'];

function runOne() {
  // randomize seat order so God isn't always seat 0
  const order = SPECS.slice();
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const playerSpecs = order.map((style, i) => ({
    id: 'b' + i, name: style + i, isBot: true,
    profile: { style, traits: rollTraits(style), name: style + i },
  }));
  const game = new GameState(playerSpecs);
  game.startGame();
  if (game.phase === 'PREGAME') game.beginFirstRound();
  let safety = 200;
  while (game.phase !== 'GAME_OVER' && safety-- > 0) {
    if (game.phase === 'BIDDING') {
      const peekRank = (p) => (p.profile?.style || '').toLowerCase() === 'god' ? 1 : 0;
      const ord = [...game.players].sort((a, b) => peekRank(a) - peekRank(b));
      for (const p of ord) game.submitBid(p.id, botPickBid(p, game));
      game.resolveBidding();
      if (game.phase === 'AWAITING_REVEAL') {
        const w = game.players[game.winner.seat];
        game.submitReveal(w.id, botPickReveal(w, game));
      }
      if (game.phase !== 'GAME_OVER') game._beginNextRound();
    } else break;
  }
  if (game.phase !== 'GAME_OVER') game._endGame();
  return { game, players: playerSpecs };
}

const stats = {};
for (let i = 0; i < N; i++) {
  const { game, players } = runOne();
  const idToStyle = Object.fromEntries(players.map(p => [p.id, p.profile.style]));
  game.endgame.results.forEach((r, rank) => {
    const style = idToStyle[r.id];
    if (!stats[style]) stats[style] = { games: 0, wins: 0, score: 0, rank: 0 };
    const s = stats[style];
    s.games++;
    if (rank === 0) s.wins++;
    s.score += r.total;
    s.rank += rank + 1;
  });
}
console.log(`=== God vs 4 Newbies, ${N} games ===`);
console.log('Style       Games  WinRate  AvgScore  AvgRank');
for (const [style, s] of Object.entries(stats)) {
  console.log(
    style.padEnd(12) +
    String(s.games).padEnd(7) +
    ((s.wins / s.games * 100).toFixed(1) + '%').padEnd(9) +
    (s.score / s.games).toFixed(1).padEnd(10) +
    (s.rank / s.games).toFixed(2)
  );
}
