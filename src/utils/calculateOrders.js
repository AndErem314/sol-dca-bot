#!/usr/bin/env node
/**
 * Utility: DCA order schedule calculator (v2 — uses strategy.js, single source of truth).
 * Replaces the old version that read never-set env names (INITIAL_ORDER_USDT,
 * TARGET_PROFIT_PERCENT) and a made-up "recovery needed" formula.
 */
const { config } = require('../config');
const { buildGrid, gridTotal, computeTpPlan } = require('../strategy');

const price = parseFloat(process.argv[2]) || 200;
const grid = buildGrid(price, {
  initialOrder: config.initialOrder,
  orderMultiplier: config.orderMultiplier,
  maxOrders: config.maxOrders,
  priceDropPercent: config.priceDropPercent,
});

console.log('═'.repeat(64));
console.log(`${config.pairLabel} DCA grid — calculator (entry $${price})`);
console.log('═'.repeat(64));
console.log(' #    size $     drop%     limit $      cum $');
for (const l of grid) {
  if (l.orderNum > 10 && l.orderNum < grid.length - 4 && l.orderNum % 5) continue;
  console.log(
    `${String(l.orderNum).padStart(2)}  ${l.sizeQuote.toFixed(2).padStart(8)}  ` +
    `${l.dropPercent.toFixed(2).padStart(6)}%  ${l.limitPrice.toFixed(4).padStart(11)}  ` +
    `${l.cumulativeQuote.toFixed(2).padStart(9)}`);
}
const total = gridTotal(grid);
console.log('─'.repeat(64));
console.log(`Total capital at full pyramid: $${total.toFixed(2)}`);
console.log(`Max coverage: ${(grid.length * config.priceDropPercent).toFixed(1)}% below entry`);
console.log(`Keep ${config.profitTargetPercent}% extra base (TP_MODE=base), min +${config.minUsdProfitPct()}% USD`);

// exit-target example for the worst case: all levels filled
let invested = 0, holdings = 0;
for (const l of grid) { invested += l.sizeQuote; holdings += l.sizeQuote / l.limitPrice; }
const plan = computeTpPlan({ invested, holdings, avgEntry: invested / holdings }, {
  mode: config.tpMode(), profitTargetPercent: config.profitTargetPercent, minUsdProfitPct: config.minUsdProfitPct(),
});
console.log(`Full-pyramid TP: sell ${plan.sellBase.toFixed(6)} @ $${plan.exitPrice.toFixed(4)} ` +
  `(+${((plan.exitPrice / (invested / holdings) - 1) * 100).toFixed(1)}% over avg), keep ${plan.keepBase.toFixed(6)} extra, ` +
  `proceeds $${plan.expectedProceeds.toFixed(2)} (P/L $${plan.profitUsd.toFixed(2)})`);
