// selfplay_godvsspammers.js — God vs 4 RandomHighBidders
// RandomHighBidder: ignores value, bids random in [0, money] — often overpays.
'use strict';

const { GameState } = require('./GameState');
const { botPickBid, botPickReveal, rollTraits } = require('./bot');

const N = parseInt(process.argv[2] || '2000', 10);

function pickRandomBid(p, game) {
  // 30% pass, 70% bid uniformly random up to money
  if (Math.random() < 0.30) return 0;
  return Math.floor(Math.random() * (p.money + 1));
}

function pickRandomReveal(p) {
  const arr = p.hiddenGems || [];
  return arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;
}

function runOne() {
  const SPECS = ['God', 'Spammer', 'Spammer', 'Spammer', 'Spammer'];
  // shuffle seats
  for (let i = SPECS.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [SPECS[i], SPECS[j]] = [SPECS[j], SPECS[i]];
  }
  const playerSpecs = SPECS.map((style, i) => ({
    id: 'b' + i, name: style + i, isBot: true,
    profile: { style: style === 'Spammer' ? 'Newbie' : style, traits: rollTraits(style === 'Spammer' ? 'Newbie' : style), name: style + i, _spammer: style === 'Spammer' },
  }));
  const game = new GameState(playerSpecs);
  game.startGame();
  if (game.phase === 'PREGAME') game.beginFirstRound();
  let safety = 200;
  while (game.phase !== 'GAME_OVER' && safety-- > 0) {
    if (game.phase === 'BIDDING') {
      // Spammers bid first, then God peeks
      const peekRank = (p) => (p.profile?.style || '').toLowerCase() === 'god' ? 1 : 0;
      const ord = [...game.players].sort((a, b) => peekRank(a) - peekRank(b));
      for (const p of ord) {
        const bid = p.profile?._spammer ? pickRandomBid(p, game) : botPickBid(p, game);
        game.submitBid(p.id, bid);
      }
      game.resolveBidding();
      if (game.phase === 'AWAITING_REVEAL') {
        const w = game.players[game.winner.seat];
        const pick = w.profile?._spammer ? pickRandomReveal(w) : botPickReveal(w, game);
        game.submitReveal(w.id, pick);
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
  const idToLabel = Object.fromEntries(players.map(p => [p.id, p.profile._spammer ? 'Spammer' : 'God']));
  game.endgame.results.forEach((r, rank) => {
    const label = idToLabel[r.id];
    if (!stats[label]) stats[label] = { games: 0, wins: 0, score: 0, rank: 0 };
    const s = stats[label];
    s.games++;
    if (rank === 0) s.wins++;
    s.score += r.total;
    s.rank += rank + 1;
  });
}
console.log(`=== God vs 4 RandomHighBidders, ${N} games ===`);
console.log('Style    Games  WinRate  AvgScore  AvgRank');
for (const [label, s] of Object.entries(stats)) {
  console.log(
    label.padEnd(9) +
    String(s.games).padEnd(7) +
    ((s.wins / s.games * 100).toFixed(1) + '%').padEnd(9) +
    (s.score / s.games).toFixed(1).padEnd(10) +
    (s.rank / s.games).toFixed(2)
  );
}
