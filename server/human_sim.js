// human_sim.js — simulate a "smart human" v2 vs the bot pool.
// v2 adds: opponent threat tracking, Loan opportunism, mission push,
// cheap snipe when opps are broke, endgame all-in.
'use strict';

const { GameState, GEM_TYPES, valueForCount, counts, meets, TOTAL_GEM_AUCTIONS } =
  require('./GameState');
const { botPickBid, botPickReveal, rollTraits, BOT_ARCHETYPES } = require('./bot');

const N = parseInt(process.argv[2] || '500', 10);
const STYLES = Object.keys(BOT_ARCHETYPES);

function humanPickBid(p, game) {
  const card = game.currentCard;
  if (!card) return 0;
  const lot = (game.currentLot || []).slice();

  const opps = game.players.filter(x => x.id !== p.id);
  const oppCash = opps.map(o => o.money);
  const maxOppCash = Math.max(0, ...oppCash);
  const avgOppCash = oppCash.reduce((a,b)=>a+b,0) / Math.max(1, oppCash.length);
  const brokeOpps = oppCash.filter(c => c <= 3).length;
  const allOppsBroke = avgOppCash <= 3;

  const remainingAuctions = Math.max(1, (game.deck && game.deck.length) || 1);
  const progress = game.gemsAuctionedCount / TOTAL_GEM_AUCTIONS;

  if (card.kind === 'INVEST') {
    const v = card.value || 5;
    let want = Math.floor(v * 0.65);
    if (allOppsBroke) want = Math.min(want, Math.max(1, Math.ceil(maxOppCash) + 1));
    return Math.max(0, Math.min(p.money, want));
  }

  if (card.kind === 'LOAN') {
    const v = card.value || 10;
    const cashShort = p.money <= 6;
    const earlyMid = progress < 0.65;
    if (cashShort && earlyMid) {
      let want = Math.floor(v * 0.3);
      if (allOppsBroke) want = Math.min(want, Math.max(1, Math.ceil(maxOppCash) + 1));
      return Math.max(0, Math.min(p.money, want));
    }
    if (allOppsBroke) return Math.min(p.money, Math.max(1, Math.ceil(maxOppCash) + 1));
    return 0;
  }

  // GEM lot EV from public info
  const visibleUnused = {};
  for (const t of GEM_TYPES) visibleUnused[t] = 0;
  for (const pl of game.players) for (const g of pl.revealedGems) visibleUnused[g]++;
  for (const g of p.hiddenGems) visibleUnused[g]++;

  let known = 0;
  for (const t of GEM_TYPES) known += visibleUnused[t];
  const unknown = Math.max(0, 15 - known);
  const perTypePrior = unknown / 5;

  const estimatedV = {};
  for (const t of GEM_TYPES) {
    const expected = visibleUnused[t] + perTypePrior;
    estimatedV[t] = Math.min(20, 4 * expected);
  }

  let lotValue = 0;
  for (const g of lot) lotValue += estimatedV[g];

  const myWon = p.wonGems;
  const myAfter = myWon.concat(lot);
  let missionBonus = 0;
  let oneAwayBoost = 0;
  for (const m of game.missions) {
    if (m.completedBy) continue;
    if (meets(m, myWon)) continue;
    if (meets(m, myAfter)) missionBonus += m.score;
    else if (m.kind === 'TWO_SPECIFIC' || m.kind === 'THREE_SPECIFIC') {
      const required = m.gems || [];
      const haveSet = new Set(myWon);
      const afterSet = new Set(myAfter);
      const beforeMatched = required.filter(g => haveSet.has(g)).length;
      const afterMatched = required.filter(g => afterSet.has(g)).length;
      if (afterMatched === required.length - 1 && afterMatched > beforeMatched) {
        oneAwayBoost += m.score * 0.3;
      }
    }
  }

  let denial = 0;
  for (const opp of opps) {
    for (const m of game.missions) {
      if (m.completedBy) continue;
      if (meets(m, opp.wonGems)) continue;
      if (meets(m, opp.wonGems.concat(lot))) {
        denial += m.score * 0.5;
      }
    }
  }

  let ev = lotValue + missionBonus + oneAwayBoost + denial;

  // Selectivity: only fight hard for high-EV / mission lots, conserve cash on the rest
  const myCashFrac = p.money / Math.max(1, remainingAuctions);
  const lotImportance = ev / Math.max(3, lotValue * 0.5 + 6); // higher = better lot
  const isHighValue = ev >= 8 || missionBonus >= 5;
  const isMidValue = ev >= 5 && !isHighValue;

  let bid;
  if (isHighValue) {
    bid = Math.floor(ev * 1.15);                     // pay premium for great lots (beat anti-human cap)
  } else if (isMidValue) {
    bid = Math.floor(ev * 0.90);
  } else {
    bid = Math.floor(ev * 0.50);
  }

  if (allOppsBroke && ev >= 2) {
    const snipe = Math.min(p.money, Math.max(1, Math.ceil(maxOppCash) + 1));
    if (snipe <= ev) return snipe;
  }
  if (brokeOpps >= 3 && ev >= 3) {
    const snipe = Math.min(p.money, Math.max(1, Math.ceil(maxOppCash) + 1));
    if (snipe <= ev * 1.05) bid = Math.min(bid, snipe);
  }

  if (missionBonus >= 10) {
    bid = Math.max(bid, Math.floor(ev * 1.10));
  }

  // Endgame burn: last 3 gem lots, dump cash
  const remainingGemLots = Math.max(1, TOTAL_GEM_AUCTIONS - game.gemsAuctionedCount);
  if (remainingGemLots <= 3 && lot.length > 0 && ev >= 3) {
    const burn = Math.min(p.money, Math.ceil(p.money / remainingGemLots) + 2);
    bid = Math.max(bid, Math.min(burn, Math.floor(ev * 1.20)));
  }

  bid = Math.min(bid, p.money);
  bid = Math.max(0, bid);
  return bid;
}

function humanPickReveal(p, game) {
  if (!p.hiddenGems.length) return null;
  const c = counts(p.hiddenGems);
  let best = p.hiddenGems[0];
  let bestCount = -1;
  for (const g of p.hiddenGems) {
    if (c[g] > bestCount) { bestCount = c[g]; best = g; }
  }
  return best;
}

function runOne() {
  const shuffled = STYLES.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const botStyles = shuffled.slice(0, 4);

  const playerSpecs = [
    { id: 'human', name: 'Human', isBot: false,
      profile: { style: 'human', name: 'Human' } },
    ...botStyles.map((style, i) => ({
      id: 'b' + i, name: style, isBot: true,
      profile: { style, traits: rollTraits(style), name: style }
    })),
  ];
  for (let i = playerSpecs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [playerSpecs[i], playerSpecs[j]] = [playerSpecs[j], playerSpecs[i]];
  }

  const game = new GameState(playerSpecs);
  game.startGame();
  if (game.phase === 'PREGAME') game.beginFirstRound();

  let safety = 200;
  while (game.phase !== 'GAME_OVER' && safety-- > 0) {
    if (game.phase === 'BIDDING') {
      const order = [...game.players].sort((a, b) => {
        const sa = (a.profile?.style || '').toLowerCase() === 'sniper' ? 1 : 0;
        const sb = (b.profile?.style || '').toLowerCase() === 'sniper' ? 1 : 0;
        return sa - sb;
      });
      for (const p of order) {
        const bid = p.isBot ? botPickBid(p, game) : humanPickBid(p, game);
        game.submitBid(p.id, bid);
      }
      game.resolveBidding();
      if (game.phase === 'AWAITING_REVEAL') {
        const winner = game.players[game.winner.seat];
        const pick = winner.isBot ? botPickReveal(winner, game) : humanPickReveal(winner, game);
        game.submitReveal(winner.id, pick);
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
  const results = game.endgame.results;
  const idToStyle = {};
  for (const p of players) idToStyle[p.id] = p.profile.style;
  results.forEach((r, rank) => {
    const style = idToStyle[r.id];
    if (!stats[style]) stats[style] = { games: 0, wins: 0, top2: 0, totalScore: 0, totalRank: 0,
      gemScore: 0, missionScore: 0, money: 0 };
    const s = stats[style];
    s.games++;
    if (rank === 0) s.wins++;
    if (rank <= 1) s.top2++;
    s.totalScore += r.total;
    s.totalRank += (rank + 1);
    s.gemScore += r.gemScore || 0;
    s.missionScore += r.missionScore || 0;
    s.money += r.money || 0;
  });
}

console.log(`=== Human v2 vs Bots over ${N} games ===`);
const hdr = ['Player', 'Games', 'Win', 'Top2', 'AvgSc', 'AvgRk', 'Gem', 'Mis', 'Money'];
const widths = [14, 6, 7, 7, 7, 7, 6, 6, 7];
console.log(hdr.map((h, i) => h.padEnd(widths[i])).join(''));
const rows = Object.entries(stats).sort((a, b) => b[1].wins / b[1].games - a[1].wins / a[1].games);
for (const [style, s] of rows) {
  const cells = [
    style,
    String(s.games),
    (s.wins / s.games * 100).toFixed(1) + '%',
    (s.top2 / s.games * 100).toFixed(1) + '%',
    (s.totalScore / s.games).toFixed(1),
    (s.totalRank / s.games).toFixed(2),
    (s.gemScore / s.games).toFixed(1),
    (s.missionScore / s.games).toFixed(1),
    (s.money / s.games).toFixed(1),
  ];
  console.log(cells.map((c, i) => c.padEnd(widths[i])).join(''));
}
