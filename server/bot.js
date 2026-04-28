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

function makeBotProfile() {
  const style = STYLE_KEYS[Math.floor(Math.random() * STYLE_KEYS.length)];
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
      // CHEATER (peek mode, throttled to 50%): Sniper goes LAST and CAN see bids.
      // 50% rounds it acts on the peek; the other 50% it relies on a STRONG
      // non-cheat heuristic so it stays competitive even without the peek.
      const expectedValue = lotValue + missionBonus + oneAwayBonus + diversityBonus;
      const usePeek = Math.random() < 0.70;
      let peekMax = -1;
      if (usePeek) {
        try {
          if (game && game.bids && typeof game.bids.forEach === 'function') {
            game.bids.forEach((amt, pid) => {
              if (pid !== p.id && typeof amt === 'number' && amt > peekMax) peekMax = amt;
            });
          }
        } catch {}
      }
      if (usePeek && peekMax >= 0 && p.money >= 1) {
        const target = Math.min(p.money, peekMax + 1);
        const profit = expectedValue - target;
        if (profit >= 0.5 || (peekMax <= 2 && expectedValue >= 3)) {
          return Math.max(1, target);
        }
        if (peekMax === 0 && expectedValue >= 2) return Math.min(1, p.money);
      }
      // ---------- NON-CHEAT MODE: strong model-based sniping ----------
      // 1) Aggressive opp-max prediction (assumes rivals bid ~75% of their cash on big lots)
      let predOpp = predictedOppMax;
      if (predOpp == null) {
        let maxOppCash = 0;
        for (const opp of game.players) {
          if (opp.id === p.id) continue;
          if (opp.money > maxOppCash) maxOppCash = opp.money;
        }
        // Scale prediction by lot value: high-value lots → opps bid more
        const valueScale = Math.min(1.0, expectedValue / 12);
        predOpp = maxOppCash * (0.45 + 0.40 * valueScale); // 0.45..0.85
      }
      // 2) Try to snipe at predOpp+1 if profitable
      if (p.money >= 2) {
        const target = Math.min(p.money, Math.ceil(predOpp + 1 + r() * 1.5));
        const profit = expectedValue - target;
        if (profit >= 0.0) {
          return Math.max(1, target);
        }
      }
      // 3) Strike on high-value lots even if margin is thin (Sniper specialty)
      const strikeWorthy = expectedValue >= 5 && p.money >= 2;
      if (strikeWorthy && r() < (0.85 + 0.12 * t.aggression)) {
        let strike = Math.floor(expectedValue * (0.85 + r() * 0.15));
        strike = Math.min(strike, p.money);
        return Math.max(2, strike);
      }
      // 4) Endgame cash-dump: don't sit on idle money
      const lotsLeft = Math.max(1, TOTAL_GEM_AUCTIONS - game.gemsAuctionedCount);
      if (lotsLeft <= 4 && p.money >= 6 && expectedValue >= 3) {
        const dump = Math.min(p.money, Math.max(2, Math.floor(p.money / lotsLeft) + 2));
        return dump;
      }
      personalityMult = 0.95 + r() * 0.18;
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

  // ============ OVERPAY GUARD: never bid more than ~115% of expected value ============
  // Stops rich bots from dumping cash on low-value lots just because they can.
  // Jackpot lots and Loan cards are exempt (Loan: bid IS interest, not a price).
  const _isJackpot = (missionBonus >= 10) || (lotValue >= 16) || (card.kind === 'INVEST' && (card.value || 0) >= 10);
  if (!_isJackpot && card.kind !== 'LOAN') {
    const ev = lotValue + missionBonus + diversityBonus + oneAwayBonus;
    if (ev > 0) {
      const hardCap = Math.ceil(ev * 1.15) + 1;
      if (bid > hardCap) bid = hardCap;
    } else if (ev <= 0 && bid > 1) {
      // Worthless lot: token bid only
      bid = Math.min(bid, 1);
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
