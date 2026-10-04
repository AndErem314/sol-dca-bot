#!/usr/bin/env node
/**
 * Strategy math — pure functions, no network, no state. Unit-tested.
 *
 * FIXES vs original bot.js (verified Oct 2026 code review):
 *  1. Sell sizing: original sold `invested / exitPrice` = 108% of holdings
 *     (unfillable). Correct: sell the minimum amount whose proceeds recover
 *     capital + profit; keep the remainder as extra base ("SOL profit" mode).
 *  2. Exit price: original computed exit = invested/(holdings*1.08), which is
 *     BELOW average entry → guaranteed USD loss. Correct: exit trigger is
 *     ABOVE average entry: avgEntry * (1 + targetUsd/100).
 *  3. Grid cumulative totals: original rounded per-level then accumulated
 *     drift. Now exact.
 */

/**
 * Build the DCA pyramid grid.
 * @param {number} entryPrice  market price when the cycle opens (quote per base)
 * @param {object} p {initialOrder, orderMultiplier, maxOrders, priceDropPercent}
 */
function buildGrid(entryPrice, p) {
  if (!(entryPrice > 0)) throw new Error(`buildGrid: bad entryPrice ${entryPrice}`);
  const grid = [];
  let cum = 0;
  for (let i = 0; i < p.maxOrders; i++) {
    const size = p.initialOrder * Math.pow(p.orderMultiplier, i);
    cum += size;
    const dropPct = i * p.priceDropPercent;
    grid.push({
      orderNum: i + 1,
      orderIndex: i,
      sizeQuote: size,
      cumulativeQuote: cum,
      dropPercent: dropPct,
      limitPrice: entryPrice * (1 - dropPct / 100),
      status: 'pending',
      orderId: null,
      filledPrice: null,
      filledAt: null,
      filledBaseAmount: null,
    });
  }
  return grid;
}

/** Total grid commitment in quote units. */
function gridTotal(grid) {
  return grid.reduce((s, l) => s + l.sizeQuote, 0);
}

/**
 * Take-profit plan for the currently held tranche.
 *
 * Modes:
 *  - 'base'  (default — "earn extra SOL"): sell ONLY what is needed to recover
 *    capital + a small USD floor; keep the rest as extra base tokens.
 *    Requires price >= avgEntry * (1 + minUsdProfitPct/100).
 *    keepPct of holdings is the reward; price target:
 *      exitPrice = invested / (holdings * (1 - keepPct))   [must be > avgEntry]
 *    If keepPct at that price would need exit <= avgEntry, fall back to
 *    the minUsdProfit price and keep whatever extra results.
 *  - 'usd': sell 100% of holdings at avgEntry * (1 + profitTargetPercent/100).
 *    Extra base kept = 0.
 *
 * @returns {{armed:boolean, reason?:string, exitPrice:number, sellBase:number,
 *            keepBase:number, expectedProceeds:number, profitUsd:number,
 *            extraBasePct:number}|null}
 */
function computeTpPlan(state, p) {
  const { invested, holdings, avgEntry } = state;
  if (!(invested > 0) || !(holdings > 0) || !(avgEntry > 0)) return null;

  const keepPct = p.profitTargetPercent / 100; // desired extra-base fraction
  const floorPrice = avgEntry * (1 + p.minUsdProfitPct / 100);

  if (p.mode === 'usd') {
    const exitPrice = avgEntry * (1 + keepPct);
    return {
      armed: true, mode: 'usd', exitPrice,
      sellBase: holdings, keepBase: 0,
      expectedProceeds: holdings * exitPrice,
      profitUsd: holdings * exitPrice - invested,
      extraBasePct: 0,
      floorPrice,
    };
  }

  // 'base' mode.
  // Price needed to recover capital+floor while keeping keepPct of holdings:
  const sellFraction = Math.min(1 - keepPct, 1);
  const sellBase = holdings * sellFraction;
  const neededPrice = invested / sellBase; // price at which sale recovers exactly capital
  const exitPrice = Math.max(neededPrice * (1 + p.minUsdProfitPct / 100), floorPrice);

  // Sanity: we must not sell more than we hold, and exit must be above avg entry
  if (sellBase > holdings + 1e-12) {
    return { armed: false, reason: 'sell-sizing-invalid', exitPrice: Infinity, sellBase: 0, keepBase: 0 };
  }

  const expectedProceeds = sellBase * exitPrice;
  return {
    armed: true,
    mode: 'base',
    exitPrice,
    sellBase,
    keepBase: holdings - sellBase,
    expectedProceeds,
    profitUsd: expectedProceeds - invested,
    extraBasePct: keepPct,
    extraBase: holdings - sellBase,
    floorPrice,
    requiresRecoveryPct: (exitPrice / avgEntry - 1) * 100,
  };
}

/**
 * Emergency-stop check (price-based, actionable — original only set a flag).
 */
function shouldEmergencyStop(currentPrice, entryPrice, p) {
  if (!p.emergencyStopEnabled || !(entryPrice > 0)) return false;
  return currentPrice <= entryPrice * (1 - p.emergencyStopPercent / 100);
}

module.exports = { buildGrid, gridTotal, computeTpPlan, shouldEmergencyStop };
