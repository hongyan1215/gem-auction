// bot.js — bidding AI for the gem auction
'use strict';

const { GEM_TYPES, valueForCount, counts, meets, TOTAL_GEM_AUCTIONS } = require('./GameState');

// ============ Archetype + traits ============
const BOT_ARCHETYPES = {
  Hoarder:       { aggression: 0.85, missionFocus: 0.55, intelligence: 0.75, signalAware: 0.6, loanLover: 0.2, investLover: 0.65 },
  Banker:        { aggression: 0.90, missionFocus: 0.5, intelligence: 0.9, signalAware: 0.75, loanLover: 0.5, investLover: 0.8 },
  Aggressor:     { aggression: 1.00, missionFocus: 0.55, intelligence: 0.55, signalAware: 0.45, loanLover: 0.3, investLover: 0.4 },
  Sniper:        { aggression: 1.00, missionFocus: 0.65, intelligence: 1.0, signalAware: 0.9, loanLover: 0.3, investLover: 0.6 },
  MissionHunter: { aggression: 0.95, missionFocus: 1.0, intelligence: 0.7, signalAware: 0.6, loanLover: 0.4, investLover: 0.5 },
  LoanLover:     { aggression: 0.80, missionFocus: 0.55, intelligence: 0.6, signalAware: 0.5, loanLover: 0.85, investLover: 0.6 },
  Wildcard:      { aggression: 0.75, missionFocus: 0.5, intelligence: 0.30, signalAware: 0.30, loanLover: 0.5, investLover: 0.5 },
  Newbie:        { aggression: 0.65, missionFocus: 0.4, intelligence: 0.20, signalAware: 0.20, loanLover: 0.4, investLover: 0.4 },
};
const STYLE_KEYS = Object.keys(BOT_ARCHETYPES);

function rollTraits(style) {
  const base = BOT_ARCHETYPES[style];
  const jitter = (v, sd) => Math.max(0, Math.min(1.4, v + (Math.random() - 0.5) * 2 * sd));
  return {
    aggression: jitter(base.aggression, 0.10),
    missionFocus: jitter(base.missionFocus, 0.12),
    intelligence: jitter(base.intelligence, 0.10),
    signalAware: jitter(base.signalAware, 0.10),
    loanLover: jitter(base.loanLover, 0.12),
    investLover: jitter(base.investLover, 0.10),
  };
}

const BOT_NAMES = ['Apex','Bingo','Cash','Dingo','Echo','Fizz','Gizmo','Hex','Iris','Jade','Kilo','Lumi','Maxi','Nova','Onyx','Pip','Quill','Ruby','Sage','Tiko','Uno','Vex','Wisp','Xeno','Yoyo','Zephyr'];
function randomBotName() { return BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + Math.floor(Math.random() * 100); }

function makeBotProfile() {
  const style = STYLE_KEYS[Math.floor(Math.random() * STYLE_KEYS.length)];
  return { style, traits: rollTraits(style), name: randomBotName() + '·' + style };
}

// ============ Bidding logic ============
function botPickBid(p, game) {
  const r = Math.random;
  const profile = p.profile || makeBotProfile();
  const style = profile.style;
  const t = profile.traits;
  const card = game.currentCard;
  const lot = game.currentLot || [];

  // ---- LOAN handling ----
  if (card.kind === 'LOAN') {
    // Loan: receive (value - bid), pay value at end. Bid IS interest.
    // True value of loan = (value - bid) cash now - bid_endgame_loss = value - bid - 0 ? no.
    // Net at end: +money received +0 (cash 1:1) - value loaned. So: -bid (interest cost).
    // BUT current cash can buy gems → indirect value. Worth ~20-40% of received cash.
    const cashUtility = 0.35 + 0.45 * t.loanLover; // 0.35 .. 0.80
    const debtAlready = (p.loans || []).reduce((a, l) => a + l.value, 0);
    const debtPenalty = Math.min(1.0, debtAlready / 30); // discourage stacking
    const willingnessFactor = (1 - debtPenalty) * cashUtility;
    // OPENING PHASE COOLDOWN: in first 3 rounds, slash loan interest
    const earlyCooldown = game.round <= 3 ? 0.55 : 1.0;
    let bid = Math.floor(card.value * willingnessFactor * earlyCooldown * (0.7 + r() * 0.3));
    // Cap by money + by what opponents could realistically pay
    bid = Math.min(bid, p.money);
    bid = _capByOpponents(p, game, bid);
    return Math.max(0, bid);
  }

  // ---- INVEST handling ----
  if (card.kind === 'INVEST') {
    // Cost = bid (cash). Endgame: +investValue.
    // Net = investValue - bid. Bid up to investValue - margin.
    const valueToMe = card.value;
    const margin = 1 + r() * 2; // require 1-3 profit margin
    let maxWilling = Math.max(0, valueToMe - margin);
    maxWilling *= 0.7 + 0.6 * t.investLover; // 0.7 .. 1.3
    let bid = Math.floor(maxWilling * (t.aggression * (0.7 + r() * 0.4)));
    bid = Math.min(bid, p.money);
    bid = _capByOpponents(p, game, bid);
    return Math.max(0, bid);
  }

  // ---- AUCTION_GEM ----
  // Compute lot value via current valuation table (based on visible unused gems)
  const visibleUnused = _visibleUnusedCounts(game);
  // Estimate true unused counts: visible + hidden private (ours)
  const ownHiddenCounts = counts(p.hiddenGems);
  const myEstUnused = {};
  for (const tt of GEM_TYPES) myEstUnused[tt] = (visibleUnused[tt] || 0) + (ownHiddenCounts[tt] || 0);

  let lotValue = 0;
  for (const g of lot) {
    // V is per-gem value if I LEAVE this gem in unused — but I'm taking it out of auction (different pool).
    // V depends on count remaining unused at endgame; auctioning doesn't reduce unused.
    // So I value lot at V(myEstUnused[g]) per gem.
    lotValue += valueForCount(myEstUnused[g] || 0);
  }

  // Mission contribution
  let missionBonus = 0;
  let oneAwayBonus = 0;
  for (const m of game.missions) {
    if (m.completedBy) continue;
    if (meets(m, p.wonGems)) continue;
    const wouldBeWon = p.wonGems.concat(lot);
    if (meets(m, wouldBeWon)) {
      missionBonus += m.score * (0.5 + 0.5 * t.missionFocus);
    } else {
      // One-away check
      const myCounts = counts(p.wonGems);
      if (m.type === 'TWO_SPECIFIC' || m.type === 'THREE_SPECIFIC') {
        const missing = m.gems.filter(g => !myCounts[g]);
        if (missing.length === 1 && lot.includes(missing[0])) {
          oneAwayBonus += m.score * 0.5 * (0.4 + 0.6 * t.missionFocus);
        }
      } else if (m.type === 'FOUR_DIFFERENT') {
        const types = new Set(p.wonGems);
        if (types.size === 3 && lot.some(g => !types.has(g))) {
          oneAwayBonus += m.score * 0.5 * (0.4 + 0.6 * t.missionFocus);
        }
      } else if (m.type === 'THREE_OF_A_KIND') {
        const c = counts(p.wonGems);
        for (const g of lot) if ((c[g] || 0) === 2) { oneAwayBonus += m.score * 0.4 * (0.4 + 0.6 * t.missionFocus); break; }
      }
    }
  }

  // Block opponents close to missions (signalAware)
  let blockBonus = 0;
  if (t.signalAware > 0.4) {
    for (const opp of game.players) {
      if (opp.id === p.id) continue;
      for (const m of game.missions) {
        if (m.completedBy) continue;
        if (meets(m, opp.wonGems)) continue;
        const oppCounts = counts(opp.wonGems);
        if (m.type === 'TWO_SPECIFIC' || m.type === 'THREE_SPECIFIC') {
          const missing = m.gems.filter(g => !oppCounts[g]);
          if (missing.length === 1 && lot.includes(missing[0])) {
            blockBonus += m.score * 0.25 * t.signalAware;
          }
        }
      }
    }
  }

  // Diversity (have many of one type already, less marginal value)
  const myWon = counts(p.wonGems);
  let diversityBonus = 0;
  for (const g of lot) {
    const have = myWon[g] || 0;
    if (have === 0) diversityBonus += 1;
    if (have >= 3) diversityBonus -= 1.5; // diminishing
  }

  // Leak penalty: winning forces revealing one hidden gem
  let leakPenalty = 0;
  for (const ty of Object.keys(ownHiddenCounts)) {
    const k = ownHiddenCounts[ty];
    if (k >= 2) leakPenalty += (k - 1) * 0.8 * t.signalAware;
  }

  // Game progress
  const progress = Math.min(1, game.gemsAuctionedCount / TOTAL_GEM_AUCTIONS);
  const lotsRemaining = Math.max(1, TOTAL_GEM_AUCTIONS - game.gemsAuctionedCount);
  const endgameUrgency = lotsRemaining <= 5 ? (1 + (5 - lotsRemaining) * 0.13 * t.intelligence) : 1.0;
  const earlyDiscount = 0.75 + progress * 0.25;

  let base = lotValue * earlyDiscount + missionBonus + blockBonus + diversityBonus + oneAwayBonus - leakPenalty;
  base *= endgameUrgency;
  base = Math.max(0, base);

  // Opponent bid modeling
  const predictedOppMax = _predictOppMax(p, game, card, lot, t);

  // Personality / style modifier
  let personalityMult = t.aggression;
  const styleKey = String(style || '').toLowerCase();
  switch (styleKey) {
    case 'sniper': {
      // Sniper SAVE-and-STRIKE: stay cheap most rounds, then strike with predator precision.
      const expectedValue = lotValue + missionBonus + oneAwayBonus + diversityBonus;
      // Use opp model when reliable
      if (predictedOppMax != null && game.bidHistory.length >= 3 && p.money >= 3) {
        const target = Math.min(p.money, Math.ceil(predictedOppMax + 1 + r() * 2));
        const profit = expectedValue - target;
        if (profit >= 2) {
          return Math.max(1, target);
        }
      }
      // High-value strike
      const strikeWorthy = expectedValue >= 7 && p.money >= 4;
      if (strikeWorthy && r() < (0.65 + 0.25 * t.aggression)) {
        let strike = Math.floor(expectedValue * (0.85 + r() * 0.15));
        strike = Math.min(strike, p.money);
        return Math.max(2, strike);
      }
      // Otherwise solid bid (Sniper isn't passive)
      personalityMult = 0.78 + r() * 0.18;
      break;
    }
    case 'wildcard':
      personalityMult = 0.4 + r() * 0.9;
      break;
    case 'newbie':
      personalityMult = 0.6 + r() * 0.5; // sometimes way over, sometimes way under
      base *= 0.85 + r() * 0.4; // noisy valuation
      break;
    case 'aggressor':
      // Cash discipline: don't bleed below 8 unless huge value
      if (p.money < 8 && base < 14) personalityMult = 0.6 + r() * 0.2;
      break;
    case 'hoarder':
      // hoard cash early, strike late when gems are scarce
      personalityMult = (progress < 0.45 ? 0.65 : 0.95) + r() * 0.18;
      break;
  }

  let bid = Math.floor(base * personalityMult);

  // Opponent-aware sniping (most styles)
  if (predictedOppMax != null && t.intelligence >= 0.5 && styleKey !== 'wildcard' && styleKey !== 'newbie' && styleKey !== 'sniper') {
    const myValue = lotValue + missionBonus + diversityBonus + oneAwayBonus;
    const targetBid = Math.ceil(predictedOppMax + 1 + r() * 2);
    if (myValue >= targetBid + 2 && targetBid < bid) {
      bid = Math.max(targetBid, bid - 4);
    } else if (myValue >= targetBid + 1 && bid < targetBid && bid > 0) {
      bid = Math.min(targetBid, Math.floor(myValue - 1));
    }
  }

  // Opportunity cost: net must be >= 0 for smart bots
  const totalValueToMe = lotValue + missionBonus + diversityBonus + oneAwayBonus + blockBonus * 0.5;
  if (t.intelligence >= 0.55 && bid > totalValueToMe) {
    bid = Math.floor(totalValueToMe);
  }

  // ============ HARD CAP: don't overpay vs opponents' available cash ============
  bid = _capByOpponents(p, game, bid);

  bid = Math.max(0, Math.min(bid, p.money));
  return bid;
}

// Cap bid at (max opponent money + 1 + small bluff margin).
// You cannot lose to someone who has X cash if you bid X+1.
function _capByOpponents(p, game, bid) {
  let maxOpp = 0;
  for (const opp of game.players) {
    if (opp.id === p.id) continue;
    if (opp.money > maxOpp) maxOpp = opp.money;
  }
  // Bluff margin: assume up to +1 over their cash is impossible. Add small buffer
  // for randomness / safety: smarter bot = tighter cap.
  const profile = p.profile || makeBotProfile();
  const intel = profile.traits.intelligence;
  const buffer = Math.round(2 - intel * 1.5); // intel 0..1 → buffer 2..0
  const cap = maxOpp + 1 + Math.max(0, buffer);
  return Math.min(bid, cap);
}

function _visibleUnusedCounts(game) {
  // Visible unused = revealedGems across all players + (hidden counts for the asking player handled outside).
  const c = {};
  for (const p of game.players) {
    for (const g of p.revealedGems) c[g] = (c[g] || 0) + 1;
    // Note: hiddenGems are NOT visible (other than our own); caller should add own counts.
  }
  // Final reveal at end: when phase==GAME_OVER all hiddens are exposed.
  return c;
}

function _predictOppMax(p, game, card, lot, t) {
  if (t.intelligence < 0.55 || !game.bidHistory || game.bidHistory.length < 2) return null;
  let maxPred = 0;
  for (const opp of game.players) {
    if (opp.id === p.id) continue;
    let total = 0, n = 0;
    for (const h of game.bidHistory) {
      if (h.cardKind !== card.kind) continue;
      if (h.cardKind === 'AUCTION_GEM' && h.lotSize !== lot.length) continue;
      const b = h.bids[opp.id];
      if (typeof b === 'number') { total += b; n++; }
    }
    if (n >= 1) {
      const avg = total / n;
      const cashRatio = Math.max(0.3, Math.min(1.4, opp.money / 12));
      let pred = avg * cashRatio;
      // Hard cap at their actual money — cannot bid more
      pred = Math.min(pred, opp.money);
      if (pred > maxPred) maxPred = pred;
    } else {
      // No history yet — assume opp could bid up to half their money
      const guess = Math.min(opp.money, opp.money * 0.5);
      if (guess > maxPred) maxPred = guess;
    }
  }
  return maxPred;
}

// Reveal the gem with the highest count among my hiddens (revealing redundant info)
function botPickReveal(p, game) {
  if (!p.hiddenGems.length) return null;
  const c = counts(p.hiddenGems);
  let best = p.hiddenGems[0];
  let bestCount = -1;
  for (const g of p.hiddenGems) {
    if (c[g] > bestCount) { bestCount = c[g]; best = g; }
  }
  return best;
}

module.exports = { botPickBid, botPickReveal, BOT_ARCHETYPES, rollTraits, makeBotProfile, randomBotName };
