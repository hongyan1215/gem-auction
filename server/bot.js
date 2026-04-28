// bot.js — bidding AI for the gem auction
'use strict';

const { GEM_TYPES, valueForCount, counts, meets, TOTAL_GEM_AUCTIONS } = require('./GameState');

// ============ Archetype + traits ============
const BOT_ARCHETYPES = {
  Hoarder:       { aggression: 1.00, missionFocus: 0.75, intelligence: 0.92, signalAware: 0.80, loanLover: 0.35, investLover: 0.85 },
  Banker:        { aggression: 1.00, missionFocus: 0.70, intelligence: 1.05, signalAware: 0.92, loanLover: 0.45, investLover: 1.00 },
  Aggressor:     { aggression: 1.20, missionFocus: 0.75, intelligence: 0.90, signalAware: 0.75, loanLover: 0.55, investLover: 0.70 },
  Sniper:        { aggression: 1.10, missionFocus: 0.80, intelligence: 1.10, signalAware: 1.05, loanLover: 0.45, investLover: 0.85 },
  MissionHunter: { aggression: 1.15, missionFocus: 1.40, intelligence: 1.00, signalAware: 0.90, loanLover: 0.55, investLover: 0.70 },
  LoanLover:     { aggression: 0.95, missionFocus: 0.70, intelligence: 0.90, signalAware: 0.75, loanLover: 0.65, investLover: 0.80 },
  Wildcard:      { aggression: 1.15, missionFocus: 0.95, intelligence: 1.10, signalAware: 1.10, loanLover: 0.85, investLover: 0.90 },
  Profiler:      { aggression: 1.05, missionFocus: 0.85, intelligence: 1.20, signalAware: 1.25, loanLover: 0.50, investLover: 0.85 },
  Newbie:        { aggression: 0.85, missionFocus: 0.55, intelligence: 0.55, signalAware: 0.50, loanLover: 0.50, investLover: 0.55 },
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

function makeBotProfile(excludeStyles = null) {
  const exclude = excludeStyles instanceof Set ? excludeStyles : new Set(excludeStyles || []);
  const pool = STYLE_KEYS.filter(s => !exclude.has(s));
  const candidates = pool.length > 0 ? pool : STYLE_KEYS; // fallback if all used
  const style = candidates[Math.floor(Math.random() * candidates.length)];
  return { style, traits: rollTraits(style), name: randomBotName() + '·' + style };
}

// ============ Per-archetype CHEATS (privileged peeks) ============
// Each style gets a unique privileged view of game state — different from the
// player's legitimate observation — to amplify its strategic identity.
function _cheatsFor(p, game) {
  const style = String(p.profile?.style || '').toLowerCase();
  const out = {
    deckCounts: null,        // {AUCTION_GEM, AUCTION_2GEM, INVEST, LOAN}
    nextInvest: null,        // value of next Invest in deck (0 if none)
    nextLoan: null,          // value of next Loan in deck (0 if none)
    futureGemAuctions: 0,    // remaining gem auction "slots"
    oppHiddenAll: null,      // [{id, hidden:[gem...]}] — peeks at all opp hidden hands
    oppHiddenCounts: null,   // {gemType: count across all opp hiddens}
    oppMoneyByMission: null, // {missionIdx: [oppId...]} — who can finish each mission
  };
  const deck = game.deck || [];
  const deckCounts = { AUCTION_GEM: 0, AUCTION_2GEM: 0, INVEST: 0, LOAN: 0 };
  for (const c of deck) {
    if (c.kind === 'AUCTION_GEM') {
      if ((c.size || 1) >= 2) deckCounts.AUCTION_2GEM++;
      else deckCounts.AUCTION_GEM++;
    } else if (c.kind === 'INVEST') deckCounts.INVEST++;
    else if (c.kind === 'LOAN') deckCounts.LOAN++;
  }
  out.deckCounts = deckCounts;
  out.futureGemAuctions = deckCounts.AUCTION_GEM + deckCounts.AUCTION_2GEM * 2;

  // Hoarder/Banker/Aggressor see deck composition & next of each kind
  if (style === 'hoarder' || style === 'banker' || style === 'aggressor' || style === 'loanlover') {
    for (const c of deck) {
      if (c.kind === 'INVEST' && out.nextInvest == null) out.nextInvest = c.value;
      if (c.kind === 'LOAN' && out.nextLoan == null) out.nextLoan = c.value;
      if (out.nextInvest != null && out.nextLoan != null) break;
    }
  }
  // MissionHunter peeks at opp hidden gems to predict who can rush a mission
  if (style === 'missionhunter') {
    out.oppHiddenAll = [];
    const counts = {};
    for (const opp of game.players) {
      if (opp.id === p.id) continue;
      out.oppHiddenAll.push({ id: opp.id, hidden: [...opp.hiddenGems] });
      for (const g of opp.hiddenGems) counts[g] = (counts[g] || 0) + 1;
    }
    out.oppHiddenCounts = counts;
  }
  return out;
}

// ============ Bidding logic ============
function botPickBid(p, game) {
  const r = Math.random;
  const profile = p.profile || makeBotProfile();
  const style = profile.style;
  const t = profile.traits;
  const card = game.currentCard;
  const lot = game.currentLot || [];
  const cheats = _cheatsFor(p, game);

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
    let willingnessFactor = (1 - debtPenalty) * cashUtility;
    // CHEAT (LoanLover): if a higher-value Loan is still in deck, fold and wait
    if (style === 'LoanLover' && cheats.nextLoan != null && cheats.nextLoan > card.value) {
      return 0;
    }
    // CHEAT (LoanLover): if THIS is the best/last loan, push hard
    if (style === 'LoanLover' && (cheats.deckCounts.LOAN === 0 || cheats.nextLoan == null)) {
      willingnessFactor *= 1.25;
    }
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
    // CHEAT (Banker): if a more valuable Invest is coming, skip this one
    if (style === 'Banker' && cheats.nextInvest != null && cheats.nextInvest > card.value) {
      // Wait for the better one
      return 0;
    }
    const valueToMe = card.value;
    const margin = 1 + r() * 2; // require 1-3 profit margin
    let maxWilling = Math.max(0, valueToMe - margin);
    maxWilling *= 0.7 + 0.6 * t.investLover; // 0.7 .. 1.3
    // CHEAT (Banker): last invest in deck → push to win
    if (style === 'Banker' && cheats.deckCounts.INVEST === 0) maxWilling *= 1.20;
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

  // *** BAYESIAN INFERENCE for smart bots (intelligence >= 0.75) ***
  // Each gem type has 6 total. We can see: own hand (hidden+wonGems) + everyone's
  // wonGems + everyone's revealedGems + market + (auctionPool - market). Unknown =
  // other players' hiddenGems + remaining auctionPool (unrevealed).
  // For each type, expected unused-pool-count = visible-unused + (unknown_of_type * (hiddenPoolRemaining / unknownTotal))
  if (String(style || '').toLowerCase() !== 'wildcard' && t.intelligence >= 0.75) {
    const seen = {}; // counts we directly see
    for (const tt of GEM_TYPES) seen[tt] = 0;
    for (const pl of game.players) {
      for (const g of pl.wonGems) seen[g]++;
      for (const g of pl.revealedGems) seen[g]++;
    }
    for (const g of (game.market || [])) seen[g]++;
    // Add own hidden (we see it)
    for (const g of p.hiddenGems) seen[g]++;
    let totalUnknown = 0;
    const unknownByType = {};
    for (const tt of GEM_TYPES) {
      unknownByType[tt] = Math.max(0, 6 - seen[tt]);
      totalUnknown += unknownByType[tt];
    }
    // Hidden pool remaining = (5 players - 1 me) * 3 hidden each minus already-revealed
    let othersHiddenRemaining = 0;
    for (const pl of game.players) {
      if (pl.id === p.id) continue;
      othersHiddenRemaining += pl.hiddenGems.length;
    }
    if (totalUnknown > 0) {
      const hiddenShare = othersHiddenRemaining / totalUnknown; // fraction of unknown that's in opp hidden = unused
      for (const tt of GEM_TYPES) {
        // expected unused = visible-in-unused-pool (own hidden + revealed) + expected opp hidden of this type
        const visibleInUnused = (ownHiddenCounts[tt] || 0);
        let revealedOfType = 0;
        for (const pl of game.players) for (const g of pl.revealedGems) if (g === tt) revealedOfType++;
        const expOppHidden = unknownByType[tt] * hiddenShare;
        myEstUnused[tt] = visibleInUnused + revealedOfType + expOppHidden;
      }
    }
  }

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

  // Block opponents close to missions (signalAware) — DENIAL PLAY
  // Cap denial uplift so we don't burn cash chasing every block.
  let blockBonus = 0;
  if (t.signalAware > 0.4) {
    let totalDenial = 0;
    for (const opp of game.players) {
      if (opp.id === p.id) continue;
      for (const m of game.missions) {
        if (m.completedBy) continue;
        if (meets(m, opp.wonGems)) continue;
        // Would lot complete the mission for opp?
        const oppPlus = opp.wonGems.concat(lot);
        if (!meets(m, oppPlus)) {
          // Not a completion, but maybe they're 1-away after we let them have it
          const oppCounts = counts(opp.wonGems);
          if (m.type === 'TWO_SPECIFIC' || m.type === 'THREE_SPECIFIC') {
            const missing = m.gems.filter(g => !oppCounts[g]);
            if (missing.length === 1 && lot.includes(missing[0])) {
              totalDenial += m.score * 0.20 * t.signalAware; // small nudge
            }
          }
          continue;
        }
        // YES — lot completes opp's mission. Denial value = m.score * urgency factor.
        // Urgency lower if opp has low cash (they might not afford this lot anyway).
        const oppCash = opp.money;
        const urgency = Math.min(1.0, oppCash / Math.max(1, lotValue + 2));
        const denialValue = m.score * urgency * 0.55 * t.signalAware;
        totalDenial += denialValue;
      }
    }
    // CAP: denial bonus can't exceed 6 (≈half of largest mission). Stops cash burn.
    blockBonus = Math.min(6, totalDenial);
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
  // Cash-burn pressure (E): idle cash late = wasted score. Apply to ALL bots once
  // we're past mid-game, but FLOOR it — if opponents are already broke, don't dump
  // (otherwise everyone hits 0 and a human just wins at bid=1).
  const cashBurnRatio = lotsRemaining > 0 ? (p.money / (lotsRemaining * 7)) : 1;
  let avgOppCash = 0; let oppN = 0;
  for (const opp of game.players) {
    if (opp.id === p.id) continue;
    avgOppCash += opp.money; oppN++;
  }
  avgOppCash = oppN > 0 ? avgOppCash / oppN : 20;
  // Relative-richness factor: 1.0 if I'm 2× avg opp, 0 if I'm at/below avg.
  const richness = Math.max(0, Math.min(1, (p.money - avgOppCash) / Math.max(4, avgOppCash)));
  // Vacuum guard: if avg opp already < 4, the table is broke; don't pour gas.
  const vacuumGuard = avgOppCash < 4 ? 0.0 : 1.0;
  const cashBurnMult = (progress >= 0.45 && cashBurnRatio > 1.2)
    ? 1 + Math.min(0.32, (cashBurnRatio - 1.2) * 0.24) * t.intelligence * (0.4 + 0.6 * richness) * vacuumGuard
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
      // CHEATER (peek mode): Sniper goes LAST and CAN see all current bids.
      // Pure logic: if peekMax+1 ≤ EV → snipe at peekMax+1. Otherwise pass (bid 0).
      // No random skips, no fallback overbidding — that wastes the cheat.
      const expectedValue = lotValue + missionBonus + oneAwayBonus + diversityBonus;
      let peekMax = -1;
      try {
        if (game && game.bids && typeof game.bids.forEach === 'function') {
          game.bids.forEach((amt, pid) => {
            if (pid !== p.id && typeof amt === 'number' && amt > peekMax) peekMax = amt;
          });
        }
      } catch {}
      if (peekMax >= 0 && p.money >= 1) {
        const target = peekMax + 1;
        // Reasonable = target ≤ EV (with tiny ±0.5 noise so we don't always +1 on the dot)
        const noise = (r() - 0.5);  // -0.5..+0.5
        if (target <= p.money && target <= expectedValue + noise) {
          return Math.max(1, target);
        }
        // Unreasonable: don't chase. Pass.
        return 0;
      }
      // No peek data (shouldn't happen at Sniper's turn) → conservative pass
      return 0;
    }
    case 'wildcard': {
      // CHEATER: knows true endgame V(n). lotValue is the TRUE total value.
      // Bid AT true value — opponents see lower V because they only see visibleUnused.
      // Snipe by paying full fair value when they underbid.
      personalityMult = 1.00 + r() * 0.05;
      break;
    }
    case 'profiler': {
      // OBSERVER: builds a per-opponent model from bid history on similar lots.
      // For each opp: avg their past bids on lots of THIS kind, scale by their
      // current cash vs their cash-then proxy, then take the max.
      const myEV = lotValue + missionBonus + oneAwayBonus + diversityBonus;
      const hist = (game.bidHistory && game.bidHistory.length >= 1) ? game.bidHistory : [];
      let topPred = 0;
      let totalSamples = 0;
      for (const opp of game.players) {
        if (opp.id === p.id) continue;
        // Same-kind bids
        const sameKind = [];
        const allBids = [];
        for (const h of hist) {
          const b = h.bids[opp.id];
          if (typeof b !== 'number') continue;
          allBids.push(b);
          if (h.cardKind === card.kind) {
            if (h.cardKind === 'AUCTION_GEM' && h.lotSize !== lot.length) continue;
            sameKind.push(b);
          }
        }
        let pred;
        if (sameKind.length >= 2) {
          // Sorted, drop top outlier, take mean of rest
          const s = sameKind.slice().sort((a, b) => a - b);
          if (s.length >= 4) s.pop();
          pred = s.reduce((a, b) => a + b, 0) / s.length;
        } else if (sameKind.length === 1) {
          pred = sameKind[0] * 0.85; // single sample, hedge down
        } else if (allBids.length >= 1) {
          // No same-kind data: use overall avg as weak prior
          pred = (allBids.reduce((a, b) => a + b, 0) / allBids.length) * 0.7;
        } else {
          // Cold start: assume reasonably aggressive opp (≈55% of EV)
          pred = Math.min(opp.money, myEV * 0.55);
        }
        // Cash floor: opp can't bid more than they have right now
        pred = Math.min(pred, opp.money);
        totalSamples += sameKind.length;
        if (pred > topPred) topPred = pred;
      }
      // Decision: outbid topPred by +1 if profitable, with confidence-tiered margin
      if (p.money >= 1 && topPred >= 0) {
        const target = Math.min(p.money, Math.ceil(topPred + 1 + r() * 1.0));
        const profit = myEV - target;
        // More samples → trust model more → tolerate thinner margin
        const confidence = Math.min(1.0, totalSamples / 8);
        const requiredMargin = Math.max(0.5, target * (0.20 - 0.10 * confidence));
        const cashFraction = target / Math.max(1, p.money);
        const cashOK = cashFraction <= 0.65 || profit >= target * 0.30;
        const skip = r() < 0.08;
        if (!skip && profit >= requiredMargin && cashOK) {
          return Math.max(1, target);
        }
        // Cheap grab: if predicted top is very low and EV solid
        if (topPred <= 2 && myEV >= 3 && p.money >= 2 && r() > 0.10) {
          return Math.min(p.money, Math.max(1, Math.ceil(topPred + 1)));
        }
      }
      personalityMult = 0.95 + r() * 0.15; // 0.95–1.10 fallback
      break;
    }
    case 'newbie':
      // Less unhinged: still imperfect but no longer self-destructive
      personalityMult = 0.80 + r() * 0.30; // 0.80–1.10
      base *= 0.92 + r() * 0.18;            // mild valuation noise
      break;
    case 'aggressor':
      // CHEAT: knows future gem auction count → all-in when this is one of the last big lots
      if (cheats.futureGemAuctions <= 3 && lotValue >= 6) {
        // This may be the last gem chance; bid hard
        personalityMult = (1.20 + r() * 0.15);
        base *= 1.15;
      } else if (p.money < 8 && base < 14) personalityMult = 0.55 + r() * 0.2;
      else personalityMult = t.aggression * (0.98 + r() * 0.12);
      break;
    case 'hoarder':
      // CHEAT: knows exact remaining gem-auction count → ultra-precise pacing
      // Hoard early, then unload aggressively. Esp value gem stacks for V(n).
      personalityMult = (progress < 0.4 ? 0.78 : 1.18) + r() * 0.15;
      if (progress >= 0.4) base *= 1.10;
      // Late-game: if few gem auctions left and we're cash-heavy, weaponize
      if (cheats.futureGemAuctions <= 4 && p.money >= 10 && lotValue >= 6) {
        base *= 1.25; personalityMult *= 1.10;
      }
      break;
    case 'banker':
      // CHEAT: knows next Invest face value → bids accordingly on current INVEST cards
      // (handled in INVEST branch above ideally; here we boost gem bids when no good Invest coming)
      personalityMult = 0.95 + r() * 0.15;
      // If no more high-value Invest cards remain, banker shifts focus to gems
      if (cheats.deckCounts && cheats.deckCounts.INVEST <= 1 && lotValue >= 5) {
        base *= 1.12;
      }
      break;
    case 'missionhunter':
      // CHEAT: peeks at opp hidden gems → knows if opp could complete a mission with this lot
      // Boost if winning this lot blocks an opp who is mission-close
      let blockBoost = 0;
      if (cheats.oppHiddenAll) {
        for (const m of game.missions) {
          if (m.completedBy) continue;
          for (const opp of cheats.oppHiddenAll) {
            const oppPool = [...(game.players.find(x=>x.id===opp.id)?.wonGems||[])];
            if (meets(m, oppPool.concat(lot))) { blockBoost += m.score * 0.5; break; }
          }
        }
      }
      base += blockBoost;
      personalityMult = (missionBonus > 0 ? 1.15 : 0.85) + r() * 0.15;
      break;
    case 'loanlover':
      // CHEAT: knows if a more profitable Loan card is coming → don't waste cash now
      personalityMult = 1.0 + r() * 0.10;
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
      newbie: 0.95,         // less wasteful now
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

  // ============ OVERPAY GUARD: cap bid at ~130% of expected value ============
  // Loosened (1.15→1.30) to add strategic noise — bots are too readable when
  // every bid lives in [EV*0.85, EV*1.15]. Jackpots & Loan cards exempt.
  const _isJackpot = (missionBonus >= 10) || (lotValue >= 16) || (card.kind === 'INVEST' && (card.value || 0) >= 10);
  if (!_isJackpot && card.kind !== 'LOAN') {
    const ev = lotValue + missionBonus + diversityBonus + oneAwayBonus;
    if (ev > 0) {
      const hardCap = Math.ceil(ev * 1.30) + 1;
      if (bid > hardCap) bid = hardCap;
    } else if (ev <= 0 && bid > 1) {
      bid = Math.min(bid, 1);
    }
  }

  // ============ UNPREDICTABILITY LAYER ============
  // 1) Per-bot noise (±20%) so two bots with same archetype don't bid identically
  // 2) Bluff dice (8%): occasionally OVERBID modestly, or PASS on a juicy lot
  if (!_isJackpot && card.kind !== 'LOAN' && bid > 0) {
    const noise = 1 + (r() - 0.5) * 0.40; // 0.80..1.20
    bid = Math.max(0, Math.round(bid * noise));

    const bluffChance = 0.08;
    if (r() < bluffChance && p.money >= 3) {
      const ev = Math.max(1, lotValue + missionBonus + diversityBonus + oneAwayBonus);
      if (r() < 0.50) {
        // OVERBID bluff: small jam, capped at EV*1.4 — not money-dump
        const jam = Math.min(p.money, Math.ceil(ev * (1.20 + r() * 0.20)));
        bid = Math.max(bid, jam);
      } else {
        // SANDBAG bluff: pass / minimal bid even on decent lot
        bid = Math.min(bid, 1 + Math.floor(r() * 2));
      }
    }
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

// Smart reveal: choose hidden gem to leak that minimises info gain to opponents.
// Score per candidate gem g = -(reveal hurts my future V(g)) + (already public a lot → little info)
//                            + (cheater bonus: misleads opps' V estimate to my benefit)
// Tie-break: prefer the gem I have the MOST copies of in hiddens (redundant).
function botPickReveal(p, game) {
  if (!p.hiddenGems.length) return null;
  const myHiddenCounts = counts(p.hiddenGems);
  const uniqueCandidates = Array.from(new Set(p.hiddenGems));

  // Public visibility per type: revealedGems across all players + market + auctionPool
  const publicCounts = {};
  for (const t of GEM_TYPES) publicCounts[t] = 0;
  for (const pl of game.players) for (const g of pl.revealedGems) publicCounts[g]++;
  for (const g of (game.market || [])) publicCounts[g]++;
  // auctionPool is unknown to opps but reveals don't change pool

  // True unused count per type (only cheaters use this)
  const trueUnused = {};
  for (const t of GEM_TYPES) trueUnused[t] = 0;
  for (const pl of game.players) {
    for (const g of pl.hiddenGems) trueUnused[g]++;
    for (const g of pl.revealedGems) trueUnused[g]++;
  }

  const style = String((p.profile && p.profile.style) || '').toLowerCase();
  const isCheater = (style === 'wildcard' || style === 'sniper');

  let bestGem = uniqueCandidates[0];
  let bestScore = -Infinity;
  for (const g of uniqueCandidates) {
    // 1) "I have many copies in hidden" → safer to reveal one (information loss diluted)
    const myCount = myHiddenCounts[g];
    let score = myCount * 2.0;

    // 2) Already very public → reveal adds little new info (good)
    score += publicCounts[g] * 1.5;

    // 3) My OWN final-V damage if this type's true count is HIGH already → revealing
    //    1 more barely changes V (it caps at 20 anyway). Prefer types where unused>=4.
    if (trueUnused[g] >= 4) score += 2.0;

    // 4) CHEATER MISDIRECTION: reveal a gem whose true V is LOW but opps think it's HIGH.
    //    Why? Opps will dump cash on lots they THINK are valuable; revealing this lowers
    //    their estimate (they see one more in unused), making them bid LESS — but the gem
    //    was already low value to me anyway. So I lose nothing and they bid less.
    //    Reverse: if true V is HIGH and opps don't know yet, hiding (not revealing) is best.
    if (isCheater) {
      const trueV = Math.min(20, 4 * trueUnused[g]);
      // Opps' visible-only count
      const oppVisible = publicCounts[g];
      const oppEstUnused = oppVisible + 2; // rough: assume 2 hidden of this type on avg
      const oppEstV = Math.min(20, 4 * oppEstUnused);
      // Misdirection: reveal types where (trueV is low) AND (oppEst is similar/higher)
      // → revealing makes opp realise they're cheap; they bid less; ok for me since trueV low.
      // Conversely AVOID revealing types where trueV is HIGH but oppEst is LOW (we'd give away the secret).
      const misdirectGain = (oppEstV - trueV) * 0.4;
      score += misdirectGain;
      // STRONG penalty: never reveal a high-true-V type that opps underestimate
      if (trueV >= 12 && oppEstV <= trueV - 4) score -= 6.0;
    }

    if (score > bestScore) { bestScore = score; bestGem = g; }
  }
  return bestGem;
}

module.exports = { botPickBid, botPickReveal, BOT_ARCHETYPES, rollTraits, makeBotProfile, randomBotName };
