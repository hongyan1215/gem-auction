// lossanalyze.js — analyze why God loses
'use strict';
const { GameState } = require('./GameState');
const { botPickBid, botPickReveal, rollTraits, BOT_ARCHETYPES } = require('./bot');

const N = parseInt(process.argv[2] || '1000', 10);
const STYLES = Object.keys(BOT_ARCHETYPES);

function runOne() {
  const specs = STYLES.slice();
  for (let i = specs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [specs[i], specs[j]] = [specs[j], specs[i]];
  }
  const chosen = specs.slice(0, 5);
  const playerSpecs = chosen.map((style, i) => ({
    id: 'b' + i, name: style, isBot: true,
    profile: { style, traits: rollTraits(style), name: style }
  }));
  const game = new GameState(playerSpecs);
  game.startGame();
  if (game.phase === 'PREGAME') game.beginFirstRound();
  let safety = 200;
  while (game.phase !== 'GAME_OVER' && safety-- > 0) {
    if (game.phase !== 'BIDDING') break;
    const peekRank = (p) => {
      const s = (p.profile?.style || p.name || '').toLowerCase();
      if (s === 'god') return 2;
      if (s === 'sniper') return 1;
      return 0;
    };
    const order = [...game.players].sort((a, b) => peekRank(a) - peekRank(b));
    for (const p of order) game.submitBid(p.id, botPickBid(p, game));
    game.resolveBidding();
    if (game.phase === 'AWAITING_REVEAL') {
      const winner = game.players[game.winner.seat];
      game.submitReveal(winner.id, botPickReveal(winner, game));
    }
    if (game.phase !== 'GAME_OVER') game._beginNextRound();
  }
  if (game.phase !== 'GAME_OVER') game._endGame();
  return { game, playerSpecs };
}

const stats = {
  total: 0, godPlayed: 0, godWon: 0, godLost: 0,
  losses: { close: 0, blowout: 0, godNotPresent: 0 },
  marginBuckets: { '0-3': 0, '4-7': 0, '8-15': 0, '16-30': 0, '31+': 0 },
  loserStats: { totalScore: 0, gem: 0, money: 0, mission: 0, invest: 0, loan: 0,
                gemLots: 0, missionsCompleted: 0, lostByArchetype: {} },
  winnerStats: { totalScore: 0, gem: 0, money: 0, mission: 0, invest: 0, loan: 0,
                 gemLots: 0, missionsCompleted: 0 },
  // Specific loss causes
  causes: {
    outbidJackpot: 0,    // God lost a high-V (V≥15) lot in resolution
    cashStarvation: 0,   // God ended with money<3 AND winner had >5 more lots
    missionMissed: 0,    // Winner had ≥2 missions, God had ≤1
    badHiddens: 0,       // God's final hidden gems all low-V (sum<3)
    luckyTie: 0,         // Winner had same gem score, won by mission/luck
    bigJackpot: 0,       // Winner had a single gem stack worth ≥30
  }
};

for (let g = 0; g < N; g++) {
  const { game, playerSpecs } = runOne();
  stats.total++;
  const idToStyle = {};
  for (const p of playerSpecs) idToStyle[p.id] = p.profile.style;
  const godSpec = playerSpecs.find(p => String(p.profile.style).toLowerCase() === 'god');
  if (!godSpec) { stats.losses.godNotPresent++; continue; }
  stats.godPlayed++;
  const results = game.endgame.results;
  const godResult = results.find(r => r.id === godSpec.id);
  const godRank = results.indexOf(godResult);
  const winnerResult = results[0];
  if (godRank === 0) { stats.godWon++; continue; }
  stats.godLost++;
  const margin = winnerResult.total - godResult.total;
  if (margin <= 5) stats.losses.close++; else stats.losses.blowout++;
  if (margin <= 3) stats.marginBuckets['0-3']++;
  else if (margin <= 7) stats.marginBuckets['4-7']++;
  else if (margin <= 15) stats.marginBuckets['8-15']++;
  else if (margin <= 30) stats.marginBuckets['16-30']++;
  else stats.marginBuckets['31+']++;

  // Stats compare
  const ls = stats.loserStats, ws = stats.winnerStats;
  ls.totalScore += godResult.total;
  ls.gem += godResult.gemScore || 0;
  ls.money += godResult.money || 0;
  ls.mission += godResult.missionScore || 0;
  ls.invest += godResult.investBonus || 0;
  ls.loan += -(godResult.loanPenalty || 0);
  const godPlayer = game.players.find(p => p.id === godSpec.id);
  ls.gemLots += (godPlayer?.wonGems || []).length;
  ls.missionsCompleted += game.missions.filter(m => m.completedBy === godSpec.id).length;
  const winnerStyle = idToStyle[winnerResult.id];
  ls.lostByArchetype[winnerStyle] = (ls.lostByArchetype[winnerStyle] || 0) + 1;

  ws.totalScore += winnerResult.total;
  ws.gem += winnerResult.gemScore || 0;
  ws.money += winnerResult.money || 0;
  ws.mission += winnerResult.missionScore || 0;
  ws.invest += winnerResult.investBonus || 0;
  ws.loan += -(winnerResult.loanPenalty || 0);
  const winPlayer = game.players.find(p => p.id === winnerResult.id);
  ws.gemLots += (winPlayer?.wonGems || []).length;
  ws.missionsCompleted += game.missions.filter(m => m.completedBy === winnerResult.id).length;

  // Cause inference
  if (godPlayer.money < 3 && (winPlayer?.wonGems?.length || 0) - (godPlayer.wonGems?.length || 0) >= 3) {
    stats.causes.cashStarvation++;
  }
  const winMissions = game.missions.filter(m => m.completedBy === winnerResult.id).length;
  const godMissions = game.missions.filter(m => m.completedBy === godSpec.id).length;
  if (winMissions >= 2 && godMissions <= 1) stats.causes.missionMissed++;
  // Big jackpot for winner: any single gem type stack worth ≥30
  const winGemCounts = {};
  for (const g of (winPlayer?.wonGems || [])) winGemCounts[g] = (winGemCounts[g] || 0) + 1;
  let bigStack = 0;
  for (const g in winGemCounts) {
    // approx V: count unused per type; we don't have direct access, use endgame
  }
  // Use winner gemScore directly: if winner's gemScore - god's gemScore ≥ 25 → big jackpot win
  if ((winnerResult.gemScore || 0) - (godResult.gemScore || 0) >= 25) stats.causes.bigJackpot++;
  // God's hiddens at end (already revealed): sum of value
  // Tie loss
  if (Math.abs((winnerResult.gemScore || 0) - (godResult.gemScore || 0)) <= 3 && margin <= 5) {
    stats.causes.luckyTie++;
  }
}

console.log(`\n=== God loss analysis over ${N} games ===`);
console.log(`Played: ${stats.godPlayed}, Won: ${stats.godWon} (${(stats.godWon/stats.godPlayed*100).toFixed(1)}%), Lost: ${stats.godLost}`);
console.log(`Not present: ${stats.losses.godNotPresent}`);
console.log(`\n=== Margin distribution (when God lost) ===`);
for (const [bucket, n] of Object.entries(stats.marginBuckets)) {
  console.log(`  ${bucket.padEnd(6)} ${String(n).padStart(4)} (${(n/stats.godLost*100).toFixed(1)}%)`);
}
console.log(`\n=== Avg per loss: God vs Winner ===`);
const ls = stats.loserStats, ws = stats.winnerStats;
const L = stats.godLost;
console.log(`            God        Winner    Diff`);
console.log(`Total      ${(ls.totalScore/L).toFixed(1).padStart(7)}  ${(ws.totalScore/L).toFixed(1).padStart(7)}  ${((ws.totalScore-ls.totalScore)/L).toFixed(1).padStart(6)}`);
console.log(`GemScore   ${(ls.gem/L).toFixed(1).padStart(7)}  ${(ws.gem/L).toFixed(1).padStart(7)}  ${((ws.gem-ls.gem)/L).toFixed(1).padStart(6)}`);
console.log(`Money      ${(ls.money/L).toFixed(1).padStart(7)}  ${(ws.money/L).toFixed(1).padStart(7)}  ${((ws.money-ls.money)/L).toFixed(1).padStart(6)}`);
console.log(`Mission    ${(ls.mission/L).toFixed(1).padStart(7)}  ${(ws.mission/L).toFixed(1).padStart(7)}  ${((ws.mission-ls.mission)/L).toFixed(1).padStart(6)}`);
console.log(`Invest     ${(ls.invest/L).toFixed(1).padStart(7)}  ${(ws.invest/L).toFixed(1).padStart(7)}  ${((ws.invest-ls.invest)/L).toFixed(1).padStart(6)}`);
console.log(`Loan       ${(ls.loan/L).toFixed(1).padStart(7)}  ${(ws.loan/L).toFixed(1).padStart(7)}  ${((ws.loan-ls.loan)/L).toFixed(1).padStart(6)}`);
console.log(`GemLots    ${(ls.gemLots/L).toFixed(1).padStart(7)}  ${(ws.gemLots/L).toFixed(1).padStart(7)}  ${((ws.gemLots-ls.gemLots)/L).toFixed(1).padStart(6)}`);
console.log(`Missions#  ${(ls.missionsCompleted/L).toFixed(2).padStart(7)}  ${(ws.missionsCompleted/L).toFixed(2).padStart(7)}  ${((ws.missionsCompleted-ls.missionsCompleted)/L).toFixed(2).padStart(6)}`);

console.log(`\n=== Loss causes (overlapping) ===`);
console.log(`  cashStarvation (God broke + lost lots): ${stats.causes.cashStarvation} (${(stats.causes.cashStarvation/L*100).toFixed(1)}%)`);
console.log(`  missionMissed (winner ≥2 mis, God ≤1):  ${stats.causes.missionMissed} (${(stats.causes.missionMissed/L*100).toFixed(1)}%)`);
console.log(`  bigJackpot (winner gem +25 vs God):     ${stats.causes.bigJackpot} (${(stats.causes.bigJackpot/L*100).toFixed(1)}%)`);
console.log(`  luckyTie (close margin, similar gem):   ${stats.causes.luckyTie} (${(stats.causes.luckyTie/L*100).toFixed(1)}%)`);

console.log(`\n=== Who beat God ===`);
const archEntries = Object.entries(ls.lostByArchetype).sort((a,b)=>b[1]-a[1]);
for (const [arch, n] of archEntries) {
  console.log(`  ${arch.padEnd(15)} ${String(n).padStart(4)} (${(n/L*100).toFixed(1)}%)`);
}
