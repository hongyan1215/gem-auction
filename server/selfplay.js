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
      // Sniper peeks: it bids LAST so it can read game.bids
      const order = [...game.players].sort((a, b) => {
        const sa = (a.profile?.style || a.name || '').toLowerCase() === 'sniper' ? 1 : 0;
        const sb = (b.profile?.style || b.name || '').toLowerCase() === 'sniper' ? 1 : 0;
        return sa - sb;
      });
      for (const p of order) {
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
    if (!stats[style]) stats[style] = {
      games: 0, wins: 0, totalScore: 0, totalRank: 0,
      gems: 0, money: 0, missions: 0, investNet: 0, loanNet: 0,
      loansTaken: 0, investsWon: 0, gemLotsWon: 0,
    };
    const s = stats[style];
    s.games++;
    if (rank === 0) s.wins++;
    s.totalScore += r.total;
    s.totalRank += (rank + 1);
    s.gems += r.gemScore || 0;
    s.money += r.money || 0;
    s.missions += r.missionScore || 0;
    s.investNet += (r.investBonus || 0); // bonus is endgame +5/+10; refund returned to money
    s.loanNet += -(r.loanPenalty || 0);  // negative penalty
    // Count from player object in game
    const player = game.players.find(p => p.id === r.id);
    if (player) {
      s.loansTaken += (player.loans || []).length;
      s.investsWon += (player.investments || []).length;
      s.gemLotsWon += (player.wonGems || []).length;
    }
  });
}

console.log(`=== Self-play results over ${N} games ===`);
const hdr = ['Archetype','Games','WinRate','AvgScore','AvgRank','Gem','Money','Mis','InvN','LoanN','Loans','Inv','Gems'];
const widths = [14, 6, 8, 9, 8, 6, 7, 6, 6, 7, 7, 6, 6];
console.log(hdr.map((h, i) => h.padEnd(widths[i])).join(''));
const rows = Object.entries(stats).sort((a, b) => b[1].wins / b[1].games - a[1].wins / a[1].games);
for (const [style, s] of rows) {
  const cells = [
    style,
    String(s.games),
    (s.wins / s.games * 100).toFixed(1) + '%',
    (s.totalScore / s.games).toFixed(1),
    (s.totalRank / s.games).toFixed(2),
    (s.gems / s.games).toFixed(1),
    (s.money / s.games).toFixed(1),
    (s.missions / s.games).toFixed(1),
    (s.investNet / s.games).toFixed(1),
    (s.loanNet / s.games).toFixed(1),
    (s.loansTaken / s.games).toFixed(2),
    (s.investsWon / s.games).toFixed(2),
    (s.gemLotsWon / s.games).toFixed(1),
  ];
  console.log(cells.map((c, i) => c.padEnd(widths[i])).join(''));
}
