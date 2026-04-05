#!/usr/bin/env node

/**
 * Utility to calculate DCA order sizes and strategy parameters
 */

require('dotenv').config();

function calculateDCAOrders() {
  const initialOrder = parseFloat(process.env.INITIAL_ORDER_USDT || 10.0);
  const multiplier = parseFloat(process.env.ORDER_MULTIPLIER || 1.10);
  const maxOrders = parseInt(process.env.MAX_SAFETY_ORDERS || 30);
  const priceDropPercent = parseFloat(process.env.PRICE_DROP_PERCENT || 1.33);
  const targetProfit = parseFloat(process.env.TARGET_PROFIT_PERCENT || 2.0);
  const maxDrawdown = parseFloat(process.env.MAX_DRAWDOWN_PERCENT || 40.0);
  
  console.log('='.repeat(60));
  console.log('SOL/USDT DCA STRATEGY CALCULATOR');
  console.log('='.repeat(60));
  console.log();
  
  console.log('📊 STRATEGY PARAMETERS:');
  console.log(`  Initial order: $${initialOrder.toFixed(2)} USDT`);
  console.log(`  Multiplier: ${multiplier.toFixed(2)}x (each order ${((multiplier-1)*100).toFixed(1)}% larger)`);
  console.log(`  Max safety orders: ${maxOrders}`);
  console.log(`  Price drop per order: ${priceDropPercent}%`);
  console.log(`  Total drawdown: ${maxDrawdown}%`);
  console.log(`  Target profit: ${targetProfit}%`);
  console.log();
  
  // Calculate order sizes
  const orders = [];
  let totalInvested = 0;
  
  for (let i = 0; i < maxOrders; i++) {
    const size = initialOrder * Math.pow(multiplier, i);
    totalInvested += size;
    orders.push({
      order: i + 1,
      size: size,
      cumulative: totalInvested,
      priceLevel: 100 - (i * priceDropPercent),
      trigger: `Price drops ${(i * priceDropPercent).toFixed(2)}% from entry`
    });
  }
  
  console.log('📈 ORDER SCHEDULE:');
  console.log('-'.repeat(80));
  console.log(`${'Order'.padEnd(6)} ${'Size (USDT)'.padEnd(12)} ${'Cumulative'.padEnd(12)} ${'Price Level'.padEnd(12)} ${'Trigger'.padEnd(30)}`);
  console.log('-'.repeat(80));
  
  // Show first 10 orders
  for (let i = 0; i < Math.min(10, orders.length); i++) {
    const o = orders[i];
    console.log(
      `${o.order.toString().padEnd(6)} ` +
      `$${o.size.toFixed(2).padEnd(11)} ` +
      `$${o.cumulative.toFixed(2).padEnd(11)} ` +
      `${o.priceLevel.toFixed(1)}%`.padEnd(12) +
      o.trigger.padEnd(30)
    );
  }
  
  if (orders.length > 10) {
    console.log('...'.padEnd(80));
    
    // Show last 5 orders
    for (let i = Math.max(10, orders.length - 5); i < orders.length; i++) {
      const o = orders[i];
      console.log(
        `${o.order.toString().padEnd(6)} ` +
        `$${o.size.toFixed(2).padEnd(11)} ` +
        `$${o.cumulative.toFixed(2).padEnd(11)} ` +
        `${o.priceLevel.toFixed(1)}%`.padEnd(12) +
        o.trigger.padEnd(30)
      );
    }
  }
  
  console.log();
  console.log('💰 CAPITAL REQUIREMENTS:');
  console.log(`  Total investment: $${totalInvested.toFixed(2)} USDT`);
  console.log(`  Average order: $${(totalInvested / maxOrders).toFixed(2)} USDT`);
  console.log(`  First order: $${orders[0].size.toFixed(2)} USDT`);
  console.log(`  Last order: $${orders[orders.length - 1].size.toFixed(2)} USDT`);
  console.log();
  
  // Calculate profit scenario
  console.log('🎯 PROFIT SCENARIO:');
  const averagePriceReduction = 1 - (maxDrawdown / 100 * (multiplier - 1) * 0.3);
  const recoveryNeeded = ((1 + targetProfit/100) / averagePriceReduction - 1) * 100;
  
  console.log(`  Average entry price reduction: ${((1 - averagePriceReduction) * 100).toFixed(1)}%`);
  console.log(`  Recovery needed from bottom: ${recoveryNeeded.toFixed(1)}%`);
  console.log(`  Total recovery needed: ${(maxDrawdown + recoveryNeeded).toFixed(1)}% from entry`);
  console.log();
  
  // Risk assessment
  console.log('⚠️  RISK ASSESSMENT:');
  console.log(`  Max potential loss: $${(totalInvested * maxDrawdown/100).toFixed(2)} (${maxDrawdown}%)`);
  console.log(`  Target profit: $${(totalInvested * targetProfit/100).toFixed(2)} (${targetProfit}%)`);
  console.log(`  Risk/Reward ratio: 1:${(targetProfit/maxDrawdown).toFixed(2)}`);
  console.log();
  
  // Recommendations
  console.log('💡 RECOMMENDATIONS:');
  if (multiplier >= 1.3) {
    console.log('  ⚠️  High multiplier: Consider reducing to 1.1-1.2x for better risk management');
  }
  if (totalInvested > 5000) {
    console.log('  ⚠️  High capital requirement: Consider reducing initial order or multiplier');
  }
  if (recoveryNeeded > 50) {
    console.log('  ⚠️  High recovery needed: Price needs significant bounce to reach target');
  }
  
  console.log(`  ✅ Keep at least ${(totalInvested * 0.1).toFixed(2)} USDT extra for fees/slippage`);
  console.log(`  ✅ Monitor position daily, adjust if market conditions change`);
  console.log();
  
  return orders;
}

// Export for use in other modules
if (require.main === module) {
  calculateDCAOrders();
}

module.exports = { calculateDCAOrders };