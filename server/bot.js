// bot.js — bidding AI for the gem auction
'use strict';

const { GEM_TYPES, valueForCount, counts, meets, TOTAL_GEM_AUCTIONS } = require('./GameState');

// ============ Archetype + traits ============
const BOT_ARCHETYPES = {
  Hoarder:       { aggression: 0.95, missionFocus: 0.65, intelligence: 0.80, signalAware: 0.65, loanLover: 0.30, investLover: 0.80 },
  Banker:        { aggression: 0.95, missionFocus: 0.60, intelligence: 0.95, signalAware: 0.80, loanLover: 0.40, investLover: 0.95 },
  Aggressor:     { aggression: 1.15, missionFocus: 0.65, intelligence: 0.75, signalAware: 0.60, loanLover: 0.50, investLover: 0.65 },
  Sniper:        { aggression: 1.05, missionFocus: 0.70, intelligence: 1.00, signalAware: 0.95, loanLover: 0.40, investLover: 0.80 },
  MissionHunter: { aggression: 1.10, missionFocus: 1.30, intelligence: 0.85, signalAware: 0.75, loanLover: 0.50, investLover: 0.65 },
  LoanLover:     { aggression: 0.90, missionFocus: 0.60, intelligence: 0.75, signalAware: 0.60, loanLover: 0.55, investLover: 0.75 },
  Wildcard:      { aggression: 1.10, missionFocus: 0.85, intelligence: 1.0, signalAware: 1.0, loanLover: 0.85, investLover: 0.85 },
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
    // Smart bots realize loans = early cash advantage; higher intel → higher utility
    const cashUtility = 0.25 + 0.25 * t.loanLover + 0.15 * t.intelligence;
    const debtAlready = (p.loans || []).reduce((a, l) => a + l.value, 0);
    // Style-aware debt limits — smart bots can leverage one loan
    const debtCap = style === 'LoanLover' ? 15 : 10;
    if (debtAlready >= debtCap) return 0;
    if (debtAlready >= 25) return 0;
    const debtPenalty = Math.min(1.0, debtAlready / 14); // discourage stacking
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

  // *** WILDCARD CHEAT: omniscient — sees every player's hidden gems for perfect V(n) ***
  if (String(style || '').toLowerCase() === 'wildcard') {
    for (const tt of GEM_TYPES) myEstUnused[tt] = 0;
    for (const pl of game.players) {
      for (const g of pl.hiddenGems) myEstUnused[g] = (myEstUnused[g] || 0) + 1;
      for (const g of pl.revealedGems) myEstUnused[g] = (myEstUnused[g] || 0) + 1;
    }
    // After winning this lot we reveal one of OUR hiddens. So one of our hidden
    // moves to revealed (still unused). Net: unused count unchanged. Good.
  }

  let lotValue = 0;
  for (const g of lot) {
    // V is per-gem value if I LEAVE this gem in unused — but I'm taking it out of auction (different pool).
    // V depends on count remaining unused at endgame; auctioning doesn't reduce unused.
    // So I value lot at V(myEstUnused[g]) per gem.
    lotValue += valueForCount(myEstUnused[g] || 0);
  }

  // *** WILDCARD CHEAT FAST-PATH ***
  // Sees true endgame V(n). Strategy: snipe — bid just above predicted opp max,
  // never more than (true_value - 1), and pace cash across remaining auctions.
  if (String(style || '').toLowerCase() === 'wildcard' && card.kind === 'AUCTION_GEM') {
    let cheatMission = 0;
    for (const m of game.missions) {
      if (m.completedBy) continue;
      if (meets(m, p.wonGems)) continue;
      if (meets(m, p.wonGems.concat(lot))) cheatMission += m.score;
    }
    const trueValue = lotValue + cheatMission;
    if (trueValue < 2) return 0;
    const ceiling = Math.max(1, trueValue - 1);
    // Pace: split cash across remaining gem auctions in pool (incl. this one).
    const remainingGemAuctions = Math.max(1, ((game.auctionPool && game.auctionPool.length) || 0) + 1);
    // Allow up to 2x average per-lot budget (for high-value lots)
    const paceBudget = Math.floor((p.money / remainingGemAuctions) * 2.2);
    // Snipe: predict opponent max from history; bid opp_max + 1
    const oppMaxPred = _predictOppMax(p, game, card, lot, t);
    let snipeBid;
    if (oppMaxPred != null) {
      snipeBid = Math.ceil(oppMaxPred + 1);
    } else {
      // No history: assume opps will bid up to ~40% of avg cash
      let avgOppCash = 0, n = 0;
      for (const opp of game.players) if (opp.id !== p.id) { avgOppCash += opp.money; n++; }
      snipeBid = Math.ceil((avgOppCash / Math.max(1, n)) * 0.45);
    }
    // Final: min(ceiling, max(snipeBid, smallFloor)) capped by paceBudget AND cash
    let bid = Math.min(ceiling, Math.max(snipeBid, 1));
    // For massive prizes (mission completion, V>=18), break the pace budget
    const isJackpot = cheatMission >= 10 || trueValue >= 18;
    if (!isJackpot) bid = Math.min(bid, paceBudget);
    bid = Math.min(bid, p.money);
    return Math.max(0, bid);
  }

  // Mission contribution — value progress, not just completion
  let missionBonus = 0;
  let oneAwayBonus = 0;
  for (const m of game.missions) {
    if (m.completedBy) continue;
    if (meets(m, p.wonGems)) continue;
    const wouldBeWon = p.wonGems.concat(lot);
    if (meets(m, wouldBeWon)) {
      // COMPLETION = jackpot. Value the full score (not 55%).
      // MissionHunter values it at ~110% to reflect "must-have" mentality.
      missionBonus += m.score * (0.85 + 0.55 * t.missionFocus);
      continue;
    }
    const myCounts = counts(p.wonGems);
    if (m.type === 'TWO_SPECIFIC' || m.type === 'THREE_SPECIFIC') {
      const totalNeeded = m.gems.length;
      const have = m.gems.filter(g => myCounts[g]).length;
      const willGet = m.gems.filter(g => lot.includes(g)).length;
      const newProgress = have + willGet;
      const missing = totalNeeded - newProgress;
      if (newProgress > have) {
        // Progress made — boosted weights, MissionHunter cares MORE
        const focusMul = 0.4 + 0.6 * t.missionFocus;
        if (missing === 0) oneAwayBonus += m.score * 0.65 * focusMul;
        else if (missing === 1) oneAwayBonus += m.score * 0.40 * focusMul;
        else oneAwayBonus += m.score * 0.20 * focusMul;
      }
    } else if (m.type === 'FOUR_DIFFERENT') {
      const types = new Set(p.wonGems);
      const newTypes = new Set(p.wonGems.concat(lot));
      const gained = newTypes.size - types.size;
      if (gained > 0) {
        const missing = 4 - newTypes.size;
        const focusMul = 0.4 + 0.6 * t.missionFocus;
        if (missing <= 0) oneAwayBonus += m.score * 0.65 * focusMul;
        else if (missing === 1) oneAwayBonus += m.score * 0.40 * focusMul;
        else oneAwayBonus += m.score * 0.18 * gained * focusMul;
      }
    } else if (m.type === 'THREE_OF_A_KIND') {
      const c = counts(p.wonGems);
      const focusMul = 0.4 + 0.6 * t.missionFocus;
      for (const g of lot) {
        const had = c[g] || 0;
        if (had === 2) { oneAwayBonus += m.score * 0.55 * focusMul; break; }
        else if (had === 1) { oneAwayBonus += m.score * 0.25 * focusMul; break; }
        c[g] = had + 1; // simulate stacking
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
  const endgameUrgency = lotsRemaining <= 5 ? (1 + (5 - lotsRemaining) * 0.18 * t.intelligence) : 1.0;
  const earlyDiscount = 0.78 + progress * 0.22;
  // Cash-burn pressure: idle cash late = wasted score
  const cashBurnRatio = lotsRemaining > 0 ? (p.money / (lotsRemaining * 7)) : 1;
  const cashBurnMult = (progress >= 0.5 && cashBurnRatio > 1.3)
    ? 1 + Math.min(0.30, (cashBurnRatio - 1.3) * 0.22) * t.intelligence
    : 1.0;

  let base = lotValue * earlyDiscount + missionBonus + blockBonus + diversityBonus + oneAwayBonus - leakPenalty;
  base *= endgameUrgency * cashBurnMult;
  base = Math.max(0, base);

  // Opponent bid modeling
  const predictedOppMax = _predictOppMax(p, game, card, lot, t);

  // Personality / style modifier
  let personalityMult = t.aggression;
  const styleKey = String(style || '').toLowerCase();
  switch (styleKey) {
    case 'sniper': {
      // Sniper: precise predator. Snipe at +1 over predicted opp max.
      // Even without history, estimate from opp cash and intel-cap.
      const expectedValue = lotValue + missionBonus + oneAwayBonus + diversityBonus;
      let predOpp = predictedOppMax;
      if (predOpp == null) {
        // Fall back: assume best opp will bid up to 50% of their money
        let maxOppCash = 0;
        for (const opp of game.players) {
          if (opp.id === p.id) continue;
          if (opp.money > maxOppCash) maxOppCash = opp.money;
        }
        predOpp = maxOppCash * 0.5;
      }
      if (p.money >= 2) {
        const target = Math.min(p.money, Math.ceil(predOpp + 1 + r() * 1.2));
        const profit = expectedValue - target;
        if (profit >= 0.5) {
          // Lock in the win
          return Math.max(1, target);
        }
      }
      // Big strike when value is high
      const strikeWorthy = expectedValue >= 6 && p.money >= 3;
      if (strikeWorthy && r() < (0.75 + 0.20 * t.aggression)) {
        let strike = Math.floor(expectedValue * (0.90 + r() * 0.10));
        strike = Math.min(strike, p.money);
        return Math.max(2, strike);
      }
      personalityMult = 0.80 + r() * 0.18;
      break;
    }
    case 'wildcard': {
      // CHEATER: knows true endgame V(n). lotValue is the TRUE total value.
      // Bid AT true value — opponents see lower V because they only see visibleUnused.
      // Snipe by paying full fair value when they underbid.
      personalityMult = 1.00 + r() * 0.05;
      break;
    }
    case 'newbie':
      personalityMult = 0.6 + r() * 0.5; // sometimes way over, sometimes way under
      base *= 0.85 + r() * 0.4; // noisy valuation
      break;
    case 'aggressor':
      // Cash discipline: don't bleed below 8 unless huge value
      if (p.money < 8 && base < 14) personalityMult = 0.55 + r() * 0.2;
      // Aggressor still uses opp-aware sniping below
      else personalityMult = t.aggression * (0.98 + r() * 0.12);
      break;
    case 'hoarder':
      // Hoard early, then unload aggressively. Esp value gem stacks for V(n).
      // Late-game: convert cash to anything that holds value.
      personalityMult = (progress < 0.4 ? 0.78 : 1.18) + r() * 0.15;
      // Hoarder also values gems higher because of their endgame V(n) leverage
      if (progress >= 0.4) base *= 1.10;
      break;
    case 'banker':
      // Calculated: bid hard when value clear, fold when not
      personalityMult = 0.95 + r() * 0.15;
      break;
    case 'missionhunter':
      // Pursue missions decisively
      personalityMult = (missionBonus > 0 ? 1.10 : 0.85) + r() * 0.15;
      break;
  }

  let bid = Math.floor(base * personalityMult);

  // Opponent-aware sniping: bid just enough to win, not more
  if (predictedOppMax != null && t.intelligence >= 0.5 && styleKey !== 'newbie' && styleKey !== 'sniper') {
    const myValue = lotValue + missionBonus + diversityBonus + oneAwayBonus;
    const targetBid = Math.ceil(predictedOppMax + 1 + r() * 1.5);
    // If I'd profit at the snipe price, snipe (cap my bid down OR push up just to win)
    if (myValue >= targetBid + 1) {
      // Choose min(currentBid, targetBid) but never below 1 if we want it
      if (bid > targetBid) bid = targetBid;
      else if (bid < targetBid && bid > 0) bid = Math.min(targetBid, Math.floor(myValue));
    } else {
      // Can't profitably snipe: don't overbid past my value
      if (bid > myValue) bid = Math.max(0, Math.floor(myValue));
    }
  }

  // Opportunity cost: smart bots refuse to overpay
  const totalValueToMe = lotValue + missionBonus + diversityBonus + oneAwayBonus + blockBonus * 0.5;
  if (t.intelligence >= 0.4) {
    // Smarter = stricter margin
    let margin = Math.max(0, Math.floor(t.intelligence * 1.5 - 0.3));
    if (styleKey === 'missionhunter' && missionBonus > 5) margin = 0;
    if (styleKey === 'aggressor') margin = 0;  // Aggressor accepts thin margins
    if (styleKey === 'wildcard') margin = 0;   // Cheater: knows true value, no safety margin needed
    if (bid > totalValueToMe - margin) {
      bid = Math.max(0, Math.floor(totalValueToMe - margin));
    }
  }

  // ============ HARD CAP: don't overpay vs opponents' available cash ============
  bid = _capByOpponents(p, game, bid);

  // ============ PACING: don't blow all cash early ============
  // Wildcard wins because everyone else burns cash in first 5 rounds, then it
  // sniper-buys cheap late gems. Give every bot pacing too — but per-style.
  if (styleKey !== 'wildcard') {
    const remainingAuctions = Math.max(1, (game.deck && game.deck.length) || 1);
    // pacingFactor: lower = spend faster (1.0 = even split, 0.6 = front-load)
    const paceFactorByStyle = {
      hoarder: 1.20,        // most patient
      banker: 1.15,
      sniper: 1.10,
      missionhunter: 1.00,
      loanlover: 1.00,
      aggressor: 0.75,      // still front-loads
      newbie: 0.60,         // dumb, burns cash
    };
    const pf = paceFactorByStyle[styleKey] || 1.00;
    const paceBudget = Math.ceil((p.money * pf) / remainingAuctions) + 2; // +2 floor jitter
    const isJackpot = (missionBonus >= 10) || (lotValue >= 16) || (card.kind === 'INVEST' && (card.value || 0) >= 10);

    // Late-game blitz: when ≤6 cards left and a known cheater (Wildcard) still has cash,
    // smart bots dump pacing and try to outbid them. Wildcard wins by sniping cheap late
    // gems — flip the script and make late gems EXPENSIVE.
    let lateBlitz = false;
    if (t.intelligence >= 0.7 && remainingAuctions <= 6 && lotValue >= 8) {
      const richOpp = game.players.some(o =>
        o.id !== p.id && (o.profile?.style || '').toLowerCase() === 'wildcard' && o.money >= 6
      );
      if (richOpp) lateBlitz = true;
    }

    if (!isJackpot && !lateBlitz && bid > paceBudget) {
      bid = paceBudget;
    }
  }

  // ============ MINIMUM-FLOOR: don't pass on obviously valuable lots ============
  // If lot has positive net value and we have cash, at least throw a minimal bid in.
  const netValue = lotValue + missionBonus + diversityBonus + oneAwayBonus;
  if (netValue >= 6 && p.money >= 2 && bid < 1 && t.intelligence >= 0.5) {
    bid = 1 + Math.floor(r() * Math.min(3, p.money - 1));
  } else if (netValue >= 10 && p.money >= 3 && bid < 2 && t.intelligence >= 0.4) {
    bid = 2 + Math.floor(r() * Math.min(3, p.money - 2));
  }

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
  if (t.intelligence < 0.5) return null;
  let maxPred = 0;
  const hasHistory = game.bidHistory && game.bidHistory.length >= 1;
  for (const opp of game.players) {
    if (opp.id === p.id) continue;
    let total = 0, n = 0;
    if (hasHistory) {
      for (const h of game.bidHistory) {
        if (h.cardKind !== card.kind) continue;
        if (h.cardKind === 'AUCTION_GEM' && h.lotSize !== lot.length) continue;
        const b = h.bids[opp.id];
        if (typeof b === 'number') { total += b; n++; }
      }
    }
    let pred;
    if (n >= 1) {
      const avg = total / n;
      // Cash ratio: relative to starting money 20
      const cashRatio = Math.max(0.4, Math.min(1.5, opp.money / 14));
      pred = avg * cashRatio;
    } else {
      // No history — assume opp will bid up to ~40% of their money on a typical lot
      pred = opp.money * 0.4;
    }
    pred = Math.min(pred, opp.money);
    if (pred > maxPred) maxPred = pred;
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
