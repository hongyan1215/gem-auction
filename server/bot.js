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
  LoanLover:     { aggression: 1.05, missionFocus: 0.70, intelligence: 0.95, signalAware: 0.75, loanLover: 1.10, investLover: 0.80 },
  Wildcard:      { aggression: 1.15, missionFocus: 0.95, intelligence: 1.10, signalAware: 1.10, loanLover: 0.85, investLover: 0.90 },
  Newbie:        { aggression: 0.85, missionFocus: 0.55, intelligence: 0.55, signalAware: 0.50, loanLover: 0.50, investLover: 0.55 },
  God:           { aggression: 1.40, missionFocus: 1.40, intelligence: 1.40, signalAware: 1.40, loanLover: 1.00, investLover: 1.00 },
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
  // God is internal-test only — never spawned in real games
  const publicPool = STYLE_KEYS.filter(s => s !== 'God');
  const pool = publicPool.filter(s => !exclude.has(s));
  const candidates = pool.length > 0 ? pool : publicPool; // fallback if all used
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

  // ---- LOAN handling (LEVERAGE MODEL) ----
  if (card.kind === 'LOAN') {
    // Loan: pay bid (interest) NOW, receive (value-bid) cash NOW, owe value at end.
    // Net cash now: +(value - bid - bid) = value - 2*bid? NO. Re-read:
    //   submitBid(amount) → received = value - amount; p.money += received; bid is consumed.
    //   So cash delta now = value - amount - amount = value - 2*amount? NO.
    //   Actually: bid amount is NOT subtracted, it's "consumed as interest" (line 285 says
    //   p.money -= 0). So cash NOW: +(value - bid). Endgame: -value (face).
    //   Net score impact: -bid (cash gain offset by face penalty), but cash NOW can buy
    //   gems worth V which exceed cash 1:1. THAT is the leverage.
    // → True utility = (cash_received * gem_multiplier) - bid_cost
    //   where gem_multiplier = E[score per $1 spent on remaining gem auctions]

    const debtAlready = (p.loans || []).reduce((a, l) => a + l.value, 0);
    // Hard cap: 30 (was 50). Two $10 + one $10 OR one $20 + one $10. Beyond
    // this the face penalty crushes any leverage upside.
    if (debtAlready >= 30) return 0;

    // ESTIMATE GEM-MULTIPLIER: how many gem-value points can $1 buy in remaining pool?
    // Naive baseline: avg gem V across types I'd target ÷ avg winning bid for those.
    // Practical proxy: if pool has many lots & I'm cash-poor relative to opps, mult is high.
    let avgOppCash2 = 0, oppN2 = 0;
    for (const opp of game.players) {
      if (opp.id === p.id) continue;
      avgOppCash2 += opp.money; oppN2++;
    }
    avgOppCash2 = oppN2 > 0 ? avgOppCash2 / oppN2 : 20;
    // cashDeficit ∈ [0, 1]: how much poorer am I vs avg opp
    const cashDeficit = Math.max(0, Math.min(1, (avgOppCash2 - p.money) / Math.max(8, avgOppCash2)));
    // Lots remaining in pool (higher = more chances to deploy cash)
    const lotsLeft = (game.auctionPool || []).length + (game.market || []).length;
    const earlyGameBoost = lotsLeft >= 8 ? 1.0 : (lotsLeft >= 4 ? 0.7 : 0.35);
    // Multiplier: 1.0 = breakeven, 1.5+ = leverage profitable
    // Smart bots understand this; low intel doesn't.
    const baseMult = 1.0 + 0.6 * earlyGameBoost + 0.4 * cashDeficit;
    const intelMult = 0.5 + 0.7 * t.intelligence; // 0.5..1.2
    let gemMultiplier = baseMult * intelMult * (0.85 + 0.30 * t.loanLover);
    // *** LIQUIDITY DISCIPLINE (softened): borrowing without cash pressure is weaker EV,
    //     but $10 loans early game are still a steal (face -10 split into 30 future bid-$).
    //     Don't fully skip — just discount. ***
    if (cashDeficit < 0.15 && p.money >= 10) {
      // No cash pressure → soft discount, not a hard skip.
      // LoanLover identity ignores it; others mild discount for liquidity option value.
      if (style !== 'LoanLover') gemMultiplier *= 0.80;
    }
    // BIG-LOAN BONUS: $20 loans inject more cash → higher leverage value. Without
    // this, math underprices them and nobody bids → human freebie.
    if (card.value >= 20) gemMultiplier *= 1.15;
    // Cap multiplier in early game: was 1.30 (too tight, killed $20 loan bids).
    // Raised so bots actually compete on Loans without being reckless.
    const earlyCapMult = lotsLeft >= 10 ? 1.65 : (lotsLeft >= 6 ? 1.80 : 2.00);
    if (gemMultiplier > earlyCapMult) gemMultiplier = earlyCapMult;

    // Max willing bid: such that (received_cash * mult) > bid + (face_penalty - face_already_paid)
    //   The face value (-card.value) is unavoidable if we win. So:
    //   Profit = (value - bid) * gemMultiplier - bid - card.value
    //         = value*mult - bid*(mult+1) - card.value
    //   Profitable when: bid < (value*(mult-1)) / (mult+1) ... roughly.
    // Simpler: bid up to value * (mult-1)/(mult+1) * margin
    const breakEven = card.value * Math.max(0, gemMultiplier - 1) / (gemMultiplier + 1);
    let maxWilling = breakEven * (0.75 + 0.45 * t.aggression); // 0.75..1.20
    // LoanLover IDENTITY: this is your specialty. Always commit harder than the math says.
    if (style === 'LoanLover') maxWilling *= 1.55;

    // Stacking: existing debt costs cash flow at endgame (we have to NOT spend it)
    // but each new loan still adds NET cash now. Penalty is mild for smart bots.
    const stackPenalty = Math.min(0.5, debtAlready / 80);
    maxWilling *= (1 - stackPenalty);

    // CHEAT (LoanLover/Banker): wait for bigger loan if one's coming
    if ((style === 'LoanLover' || style === 'Banker') && cheats.nextLoan != null && cheats.nextLoan > card.value) {
      maxWilling *= 0.4; // not zero — sometimes still grab if cheap
    }
    // CHEAT (LoanLover): last loan available → press
    if (style === 'LoanLover' && cheats.deckCounts && (cheats.deckCounts.LOAN === 0 || cheats.nextLoan == null)) {
      maxWilling *= 1.30;
    }

    let bid = Math.floor(maxWilling * (0.85 + r() * 0.30));
    bid = Math.min(bid, p.money);
    bid = _capByOpponents(p, game, bid);
    return Math.max(0, bid);
  }

  // ---- INVEST handling ----
  if (card.kind === 'INVEST') {
    // Invest is PURE +EV: bid X, refund X at end + bonus value. Net = +value (free score)
    // unless overbid. Max profitable bid is value-1. Anyone passing is leaving money on table.
    // CHEAT (Banker): if a bigger Invest is coming, soft-discount this one (don't fully skip — others will grab it)
    let lookaheadDiscount = 1.0;
    if (style === 'Banker' && cheats.nextInvest != null && cheats.nextInvest > card.value) {
      lookaheadDiscount = 0.65;
    }
    const valueToMe = card.value;
    // Ceiling: bonus is free score, BUT locking $X costs ~0.55X in lost gem-buying.
    // Profitable up to bid s.t. bonus > 0.55*bid → bid < 1.8*bonus, capped at value-1.
    // Use 0.85*value-1 as ceiling, let trait spread fill it.
    let maxWilling = Math.max(1, Math.floor(valueToMe * 0.85) - 1);
    // BIG trait spread so different bots actually bid differently:
    // investLover 0 → 0.45×ceiling, investLover 1 → 1.10×ceiling
    maxWilling *= 0.45 + 0.65 * t.investLover;
    // Banker IDENTITY: invest specialist
    if (style === 'Banker') {
      maxWilling *= (card.value >= 10 ? 1.30 : 1.20);
    }
    maxWilling *= lookaheadDiscount;
    // CHEAT (Banker): last invest in deck → press
    if (style === 'Banker' && cheats.deckCounts.INVEST === 0) maxWilling *= 1.15;

    // *** LIQUIDITY-AWARE CEILING: locking cash in invest means you can't bid gems
    // for the next several lots. Early game with many lots ahead, this is a big
    // opportunity cost. Cap the bid below the +EV ceiling when liquidity is precious. ***
    const lotsLeftI = (game.auctionPool || []).length + (game.market || []).length;
    if (style === 'Banker' && lotsLeftI >= 12) {
      // Only the very first 3 lots: cap $5 at value-2, $10 at value-3.
      const earlyCap = card.value - (card.value >= 10 ? 3 : 2);
      maxWilling = Math.min(maxWilling, earlyCap);
    }
    // Mid+late: no extra cap beyond the natural value-1 ceiling — Banker wants invests.

    // Aggression nudge (don't multiply twice — keep it modest)
    let bid = Math.floor(maxWilling * (0.85 + 0.25 * t.aggression) * (0.85 + r() * 0.25));
    // Hard ceiling: never bid value or above (would zero out the profit)
    bid = Math.min(bid, valueToMe - 1);
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

  // *** WILDCARD/GOD CHEAT: omniscient — sees every player's hidden gems for perfect V(n) ***
  const _styleLower = String(style || '').toLowerCase();
  if (_styleLower === 'wildcard' || _styleLower === 'god') {
    for (const tt of GEM_TYPES) myEstUnused[tt] = 0;
    for (const pl of game.players) {
      for (const g of pl.hiddenGems) myEstUnused[g] = (myEstUnused[g] || 0) + 1;
      for (const g of pl.revealedGems) myEstUnused[g] = (myEstUnused[g] || 0) + 1;
    }
  }

  let lotValue = 0;
  for (const g of lot) {
    // V is per-gem value if I LEAVE this gem in unused — but I'm taking it out of auction (different pool).
    // V depends on count remaining unused at endgame; auctioning doesn't reduce unused.
    // So I value lot at V(myEstUnused[g]) per gem.
    lotValue += valueForCount(myEstUnused[g] || 0);
  }

  // *** GOD FAST-PATH: omniscient + reads ACTUAL submitted bids (peeks last) ***
  // Strategy: God knows EXACT trueValue. She bids min(money, trueValue) — outbids
  // anyone up to true value, wins every profitable lot, never overpays.
  if (String(style || '').toLowerCase() === 'god') {
    let cheatMission = 0;
    let cheatMissionProgress = 0;
    if (card.kind === 'AUCTION_GEM') {
      for (const m of game.missions) {
        if (m.completedBy) continue;
        if (meets(m, p.wonGems)) continue;
        if (meets(m, p.wonGems.concat(lot))) {
          cheatMission += m.score;
        } else {
          // Partial progress — value at 0.4× score
          const myCounts = counts(p.wonGems);
          const futureCounts = counts(p.wonGems.concat(lot));
          if (m.type === 'TWO_SPECIFIC' || m.type === 'THREE_SPECIFIC') {
            const have = m.gems.filter(g => myCounts[g]).length;
            const willGet = m.gems.filter(g => lot.includes(g) && !myCounts[g]).length;
            if (willGet > 0) cheatMissionProgress += m.score * 0.40 * (willGet / m.gems.length);
          } else if (m.type === 'FOUR_DIFFERENT') {
            const haveTypes = Object.keys(myCounts).length;
            const newTypes = Object.keys(futureCounts).length;
            if (newTypes > haveTypes) cheatMissionProgress += m.score * 0.40 * ((newTypes - haveTypes) / 4);
          } else if (m.type === 'THREE_SAME') {
            for (const g of GEM_TYPES) {
              if ((myCounts[g] || 0) < 3 && (futureCounts[g] || 0) > (myCounts[g] || 0)) {
                cheatMissionProgress += m.score * 0.40 * ((futureCounts[g] || 0) / 3);
              }
            }
          }
        }
      }
    }
    let trueValue;
    if (card.kind === 'AUCTION_GEM') {
      // Boost partial mission progress 0.40 → 0.65 (sweet spot from grid search)
      trueValue = lotValue + cheatMission + cheatMissionProgress * 1.625;
    } else if (card.kind === 'INVEST') {
      // Invest: lock X cash, get +bonus at endgame.
      // Opportunity cost: locked X could have bought ~0.60×X worth of gem score.
      // Net trueValue = bonus - 0.60×X (cash returns at end, but we lose buying power).
      const bonus = card.bonus || (card.value === 5 ? 5 : 10);
      const lockCost = card.value * 0.60;
      trueValue = bonus - lockCost;
      if (trueValue < 1) return 0;
    } else if (card.kind === 'LOAN') {
      // Loan: get (value - bid) cash now, lose value at end. Net score = -bid.
      // God uses Loan strategically: if she's cash-starved AND a known jackpot
      // is coming up in the remaining deck, the cash translates to score.
      const lotsLeft = ((game.auctionPool && game.auctionPool.length) || 0);
      // Look ahead: count upcoming jackpot lots (V≥4 per gem × 2-gem lot, or solo gem with stacked V)
      let upcomingJackpots = 0;
      const remainingDeck = (game.deck && Array.isArray(game.deck)) ? game.deck : [];
      // Estimate remaining gems in pool: any gem whose myEstUnused ≥ 3 (V≥12) is "high value"
      const highValueGems = GEM_TYPES.filter(g => (myEstUnused[g] || 0) >= 3);
      // Auction cards remaining that bring high-V gems out
      for (const c of remainingDeck) {
        if (c.kind === 'AUCTION_GEM' || c.kind === 'AUCTION_2GEMS') upcomingJackpots++;
      }
      // Heuristic: if money < 8 AND ≥3 auction lots left AND high-V gems exist → borrow cheap
      if (p.money < 8 && lotsLeft >= 3 && highValueGems.length > 0 && upcomingJackpots >= 3) {
        if (card.value <= 10) trueValue = 1;
        else if (p.money < 4 && upcomingJackpots >= 4) trueValue = 1;
        else return 0;
      } else if (p.money >= 8 || lotsLeft < 3) {
        return 0;
      } else {
        trueValue = 1;
      }
    } else {
      trueValue = card.value || 0;
    }
    // God-spoiler: also compute how much score each opponent would gain from this lot.
    // God is willing to bid up to (max_opp_gain + own_gain) to deny competitors.
    let maxOppGain = 0;
    if (card.kind === 'AUCTION_GEM') {
      for (const opp of game.players) {
        if (opp.id === p.id) continue;
        let oppGemVal = 0;
        for (const g of lot) oppGemVal += valueForCount(myEstUnused[g] || 0);
        let oppMission = 0;
        for (const m of game.missions) {
          if (m.completedBy) continue;
          if (meets(m, opp.wonGems)) continue;
          if (meets(m, opp.wonGems.concat(lot))) {
            oppMission += m.score;
          } else {
            // Partial: opp gets closer to mission with this lot
            const oppFuture = opp.wonGems.concat(lot);
            if (m.type === 'TWO_SPECIFIC' || m.type === 'THREE_SPECIFIC') {
              const haveBefore = m.gems.filter(g => opp.wonGems.includes(g)).length;
              const haveAfter = m.gems.filter(g => oppFuture.includes(g)).length;
              if (haveAfter > haveBefore) oppMission += m.score * 0.30 * ((haveAfter-haveBefore)/m.gems.length);
            } else if (m.type === 'THREE_SAME') {
              const cb = counts(opp.wonGems);
              const ca = counts(oppFuture);
              for (const g of GEM_TYPES) {
                if ((cb[g]||0) < 3 && (ca[g]||0) > (cb[g]||0)) oppMission += m.score * 0.30 * ((ca[g]||0)/3);
              }
            }
          }
        }
        const oppTotal = oppGemVal + oppMission;
        if (oppTotal > maxOppGain) maxOppGain = oppTotal;
      }
      // Spoiler 1.0×: God denies opponent's full gain (she peeks last, always wins)
      trueValue = Math.max(trueValue, maxOppGain);
    }
    if (trueValue < 0.5) return 0;

    // Read actual submitted bids (God peeks last). game.bids is a Map.
    let oppMax = 0;
    let oppMaxSeats = []; // seats of all opponents tied at oppMax
    if (game.bids && typeof game.bids.entries === 'function') {
      for (const [pid, bidVal] of game.bids.entries()) {
        if (pid === p.id || typeof bidVal !== 'number') continue;
        if (bidVal > oppMax) { oppMax = bidVal; oppMaxSeats = []; }
        if (bidVal === oppMax) {
          const opp = game.players.find(pl => pl.id === pid);
          if (opp && typeof opp.seat === 'number') oppMaxSeats.push(opp.seat);
        }
      }
    }
    // Tie-break check: if God ties at oppMax, does she win?
    // Tie order = clockwise from lastWinnerSeat+1. Lower distance wins.
    const PLAYERS_COUNT = game.players.length;
    function tieDist(seat) {
      if (game.lastWinnerSeat == null) return seat; // first round random; treat seat as fallback
      return ((seat - game.lastWinnerSeat - 1 + PLAYERS_COUNT) % PLAYERS_COUNT);
    }
    const myDist = (typeof p.seat === 'number') ? tieDist(p.seat) : 999;
    const oppBestDist = oppMaxSeats.length ? Math.min(...oppMaxSeats.map(tieDist)) : 999;
    const winsTie = (game.lastWinnerSeat != null) && (myDist < oppBestDist);
    // Strict pace: hoard cash for jackpots
    const lotsLeftG = ((game.auctionPool && game.auctionPool.length) || 0);
    const isJackpot = trueValue >= 15 || cheatMission >= 10;

    // Strict pace: hoard cash for jackpots
    let paceCap = isJackpot ? p.money : Math.floor(p.money * (lotsLeftG > 6 ? 0.30 : lotsLeftG > 3 ? 0.50 : 0.95));

    // God strategy: if tie-break favors her, just match oppMax. Else outbid by 1.
    const needToBeat = winsTie ? oppMax : oppMax + 1;
    let bid = Math.min(Math.floor(trueValue) + 1, needToBeat);
    bid = Math.max(1, bid);
    bid = Math.min(bid, paceCap, p.money);
    return bid;
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
    // ENDGAME CASH-DUMP: last 3 lots, push to ceiling (idle cash = wasted)
    const lotsLeftWC = ((game.auctionPool && game.auctionPool.length) || 0);
    if (lotsLeftWC <= 2 && p.money > 0) {
      bid = Math.min(ceiling, Math.max(bid, Math.floor(p.money * 0.55)));
    }
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
  // ANTI-HUMAN: humans get DOUBLE denial weight (the table colludes against the threat).
  let blockBonus = 0;
  if (t.signalAware > 0.4) {
    let totalDenial = 0;
    for (const opp of game.players) {
      if (opp.id === p.id) continue;
      const humanMult = opp.isBot ? 1.0 : 2.0;
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
              totalDenial += m.score * 0.20 * t.signalAware * humanMult;
            }
          }
          continue;
        }
        // YES — lot completes opp's mission. Denial value = m.score * urgency factor.
        // Urgency lower if opp has low cash (they might not afford this lot anyway).
        const oppCash = opp.money;
        const urgency = Math.min(1.0, oppCash / Math.max(1, lotValue + 2));
        const denialValue = m.score * urgency * 0.55 * t.signalAware * humanMult;
        totalDenial += denialValue;
      }
    }
    // CAP: denial bonus can't exceed 8 (a hair more for human-anchored denial).
    blockBonus = Math.min(8, totalDenial);
  }

  // Diversity (have many of one type already, less marginal value)
  const myWon = counts(p.wonGems);
  let diversityBonus = 0;
  for (const g of lot) {
    const have = myWon[g] || 0;
    if (have === 0) diversityBonus += 1;
    if (have >= 3) diversityBonus -= 1.5; // diminishing
  }

  // *** STACK BONUS: 3-of-a-kind only matters if a 3-OF-A-KIND mission exists this game.
  //     Without that mission, the third gem of a type is worth only V(n) — no mission
  //     pyramid bonus. Smart bots check the table before paying the stack premium. ***
  const hasThreeOfKindMission = game.missions.some(m =>
    m.type === 'THREE_OF_A_KIND' && !m.completedBy
  );
  let stackBonus = 0;
  for (const g of lot) {
    const have = myWon[g] || 0;
    // own hidden of same type also counts toward V (they stay unused at endgame)
    const hiddenOfType = (ownHiddenCounts[g] || 0);
    if (hasThreeOfKindMission) {
      if (have === 2) stackBonus += 6 * t.intelligence; // completes pair → 3-of-a-kind setup
      else if (have === 1 && hiddenOfType >= 1) stackBonus += 3 * t.intelligence;
    }
    // Hidden-lock bonus is independent of mission: each hidden of same type stays in
    // unused pool, raising V at endgame. Always applies.
    if (hiddenOfType >= 1) stackBonus += 1.0 * hiddenOfType;
  }

  // *** V-SATURATION BRAKE: if myEstUnused[g] >= 5, V is already at/near 20 cap.
  //     Marginal value of a 6th gem is 0 (V capped). Don't overpay. ***
  let saturationPenalty = 0;
  for (const g of lot) {
    if ((myEstUnused[g] || 0) >= 5) saturationPenalty += 2.0 * t.intelligence;
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

  let base = lotValue * earlyDiscount + missionBonus + blockBonus + diversityBonus + stackBonus + oneAwayBonus - leakPenalty - saturationPenalty;
  base *= endgameUrgency * cashBurnMult;

  // *** ENDGAME CASH-DUMP: in the last 3 lots, idle cash is worth $1 of score, but a
  //     gem with V=20 is worth $20. Smart bots dump cash AGGRESSIVELY in last 3 lots,
  //     even at slight overpay, since the alternative is unspent cash → 1:1 score. ***
  if (lotsRemaining <= 3 && p.money > 0) {
    const dumpFactor = 1 + (4 - lotsRemaining) * 0.18 * t.intelligence; // up to ~1.54
    base *= dumpFactor;
  }

  // ANTI-HUMAN GANG-UP: DISABLED (user found it actually made bots easier to beat —
  // they bid up everything human touched even when human was bluffing; now bots play
  // straight EV against humans).
  let humanThreatMult = 1.0;
  base *= humanThreatMult;
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
        // Larger noise — Sniper isn't omniscient, sometimes misjudges EV
        const noise = (r() - 0.5) * 4.0;  // -2..+2
        // Require 10% profit margin (target ≤ EV*0.90) — don't snipe break-even lots
        const profitFloor = expectedValue * 0.90 + noise;
        // 12% random skip — even cheaters get distracted / mis-click
        if (r() < 0.12) return 0;
        if (target <= p.money && target <= profitFloor) {
          return Math.max(1, target);
        }
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
    case 'profiler_REMOVED': {
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
      personalityMult = 0.90 + r() * 0.20; // 0.90-1.10 fallback (Sniper有信心)
      break;
    }
    case 'newbie':
      // Less unhinged: still imperfect but no longer self-destructive
      personalityMult = 0.70 + r() * 0.50; // 0.70–1.20 (真的 newbie 抖動大)
      base *= 0.85 + r() * 0.30;            // valuation noise also wider
      break;
    case 'aggressor': {
      // Aggressor = 敢 overpay 換 tempo / 任務 / 場面壓力。輸贏拉得開沒差。
      const aggEV = lotValue + missionBonus + oneAwayBonus + diversityBonus;
      if (cheats.futureGemAuctions <= 3 && lotValue >= 6) {
        personalityMult = 1.05 + r() * 0.15;   // 1.05-1.20 last-gem all-in
      } else if (p.money < 8 && base < 14) {
        personalityMult = 0.55 + r() * 0.20;   // 真沒錢才縮
      } else {
        // identity: aggression trait 直接拉到 1.15 上限
        personalityMult = 0.85 + t.aggression * 0.30 + r() * 0.10; // 0.85-1.25
      }
      p._aggStopLoss = Math.max(1, Math.floor(aggEV * 1.15));
      break;
    }
    case 'hoarder':
      // Patient hoarder: 早期極度節制，後期才出手。差距要大。
      personalityMult = (progress < 0.4 ? 0.40 : 1.00) + r() * 0.15;
      if (progress >= 0.4) base *= 1.05;
      if (cheats.futureGemAuctions <= 4 && p.money >= 10 && lotValue >= 6) {
        base *= 1.20; personalityMult *= 1.10; // 後期 weaponize 真的兇
      }
      if (progress < 0.7) {
        const cashCap = Math.floor(p.money * (progress < 0.35 ? 0.40 : 0.65));
        p._hoarderCashCap = cashCap;
      }
      break;
    case 'banker':
      // Banker = 中庸理性派。
      personalityMult = 0.75 + r() * 0.20; // 0.75-0.95
      if (cheats.deckCounts && cheats.deckCounts.INVEST <= 1 && lotValue >= 5) {
        base *= 1.08;
      }
      break;
    case 'missionhunter':
      // 任務獵人：有 mission 路徑就敢追，沒就極度被動。
      let blockBoost = 0;
      let contenderDiscount = 1.0;
      if (cheats.oppHiddenAll) {
        for (const m of game.missions) {
          if (m.completedBy) continue;
          for (const opp of cheats.oppHiddenAll) {
            const oppPool = [...(game.players.find(x=>x.id===opp.id)?.wonGems||[])];
            if (meets(m, oppPool.concat(lot))) { blockBoost += m.score * 0.5; break; }
          }
          if (m.type === 'TWO_SPECIFIC' || m.type === 'THREE_SPECIFIC') {
            for (const opp of game.players) {
              if (opp.id === p.id) continue;
              const oc = counts(opp.wonGems);
              const have = m.gems.filter(g => oc[g]).length;
              if (have >= m.gems.length - 1 && opp.money >= 5) {
                contenderDiscount *= 0.7; break;
              }
            }
          }
        }
      }
      base += blockBoost;
      if (contenderDiscount < 1.0 && missionBonus > 0) {
        base -= missionBonus * (1 - contenderDiscount);
      }
      // mission 路徑敢上到 1.15，沒任務就壓 0.55
      personalityMult = (missionBonus > 0 ? 1.00 : 0.55) + r() * 0.15;
      p._mhStopLoss = lotValue + missionBonus * 1.05 + diversityBonus + oneAwayBonus;
      break;
    case 'loanlover':
      // LoanLover 對寶石冷感（資金都拿去玩 loan）
      personalityMult = 0.60 + r() * 0.15; // 0.60-0.75
      break;
  }

  let bid = Math.floor(base * personalityMult);

  // MissionHunter stop-loss: never bid more than gemEV + 70% of missionBonus.
  // Prevents over-paying when someone else is also positioned to grab the mission.
  if (styleKey === 'missionhunter' && typeof p._mhStopLoss === 'number') {
    if (bid > p._mhStopLoss) bid = Math.max(0, Math.floor(p._mhStopLoss));
    delete p._mhStopLoss;
  }
  // Aggressor stop-loss: cap at EV*1.10. Identity preserved (10% premium for tempo).
  if (styleKey === 'aggressor' && typeof p._aggStopLoss === 'number') {
    if (bid > p._aggStopLoss) bid = Math.max(0, Math.floor(p._aggStopLoss));
    delete p._aggStopLoss;
  }
  // Hoarder cash conservation: identity-driven cap at 50%/70% of cash in
  // early/mid game. Stops the "spent $19 of $20 on first lot" behavior.
  if (styleKey === 'hoarder' && typeof p._hoarderCashCap === 'number') {
    if (bid > p._hoarderCashCap) bid = Math.max(0, p._hoarderCashCap);
    delete p._hoarderCashCap;
  }

  // *** GLOBAL EARLY-GAME BRAKE: in the first 5 lots (lotsLeft >= 11),
  //     cap any GEM bid at EV * 0.85. Why? Empirically all bots burn cash
  //     too fast in early lots, leaving them with $1-2 by lot 10. The first
  //     few gems aren't usually mission-critical and V can shift wildly,
  //     so paying full EV early is -EV. Skipped for: Sniper (cheat-driven),
  //     Hoarder (already has its own pacing), Newbie (identity = irrational). ***
  if (card.kind === 'AUCTION_GEM') {
    const lotsLeftG = (game.auctionPool || []).length + (game.market || []).length;
    if (lotsLeftG >= 11 && styleKey !== 'sniper' && styleKey !== 'hoarder' && styleKey !== 'newbie') {
      const earlyEV = lotValue + missionBonus + diversityBonus + oneAwayBonus;
      const earlyCap = Math.floor(earlyEV * 0.85);
      if (bid > earlyCap) bid = Math.max(0, earlyCap);
    }
  }

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

  // ============ OVERPAY GUARD: cap bid at ~120% of expected value ============
  // Tightened (1.30→1.20) — 1.30 + bluff overbid + noise stacking caused
  // visibly absurd spikes that humans flagged as "broken".
  // Jackpots & Loan cards still exempt.
  const _isJackpot = (missionBonus >= 10) || (lotValue >= 16) || (card.kind === 'INVEST' && (card.value || 0) >= 10);
  if (!_isJackpot && card.kind !== 'LOAN') {
    const ev = lotValue + missionBonus + diversityBonus + oneAwayBonus;
    if (ev > 0) {
      const hardCap = Math.ceil(ev * 1.20) + 1;
      if (bid > hardCap) bid = hardCap;
    } else if (ev <= 0 && bid > 1) {
      bid = Math.min(bid, 1);
    }
  }

  // ============ UNPREDICTABILITY LAYER ============
  // 1) Per-bot noise (±15%) — diversity without spikes that look "obviously broken"
  // 2) Bluff dice (3%): occasional small overbid or sandbag. Jam capped at EV*1.15
  //    (was 1.4, but humans complained about random absurd-high bids).
  if (!_isJackpot && card.kind !== 'LOAN' && bid > 0) {
    const noise = 1 + (r() - 0.5) * 0.30; // 0.85..1.15
    bid = Math.max(0, Math.round(bid * noise));

    const bluffChance = 0.03;
    if (r() < bluffChance && p.money >= 3) {
      const ev = Math.max(1, lotValue + missionBonus + diversityBonus + oneAwayBonus);
      if (r() < 0.50) {
        // OVERBID bluff: small jam, capped at EV*1.15 (was 1.4 — too spiky)
        const jam = Math.min(p.money, Math.ceil(ev * (1.05 + r() * 0.10)));
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
  const isCheater = (style === 'wildcard' || style === 'sniper' || style === 'god');

  let bestGem = uniqueCandidates[0];
  let bestScore = -Infinity;
  // Count own wonGems by type — types we're stacking are PROTECTED (don't reveal them
  // because that confirms our strategy AND lets opps deny our mission gem).
  const myWonCounts = counts(p.wonGems);

  for (const g of uniqueCandidates) {
    const myCount = myHiddenCounts[g];
    let score = 0;

    // 1) *** PREFER LONELY HIDDENS (single-copy types) — revealing one of two
    //    same-type hiddens leaks "I have a stack" info to opponents; revealing
    //    a singleton leaks far less. Strongly prefer myCount === 1. ***
    if (myCount === 1) score += 4.0;
    else if (myCount === 2) score -= 2.0;
    else if (myCount >= 3) score -= 5.0;  // never reveal a 3-stack hidden

    // 2) *** PROTECT MISSION/STACK GEMS: if I already have wonGems of this type,
    //    revealing my hidden of same type tells opps "MissionHunter target lock" —
    //    they'll deny or overbid future lots of this gem. Strongly avoid. ***
    const wonOfType = myWonCounts[g] || 0;
    if (wonOfType >= 2) score -= 4.0;
    else if (wonOfType === 1) score -= 1.5;

    // 3) Already very public → reveal adds little new info (good)
    score += publicCounts[g] * 1.5;

    // 4) My OWN final-V damage if this type's true count is HIGH already → revealing
    //    1 more barely changes V (it caps at 20 anyway).
    if (trueUnused[g] >= 4) score += 2.0;

    // 5) CHEATER MISDIRECTION: reveal a gem whose true V is LOW but opps think it's HIGH.
    if (isCheater) {
      const trueV = Math.min(20, 4 * trueUnused[g]);
      const oppVisible = publicCounts[g];
      const oppEstUnused = oppVisible + 2;
      const oppEstV = Math.min(20, 4 * oppEstUnused);
      const misdirectGain = (oppEstV - trueV) * 0.4;
      score += misdirectGain;
      if (trueV >= 12 && oppEstV <= trueV - 4) score -= 6.0;
    }

    if (score > bestScore) { bestScore = score; bestGem = g; }
  }
  return bestGem;
}

module.exports = { botPickBid, botPickReveal, BOT_ARCHETYPES, rollTraits, makeBotProfile, randomBotName };
