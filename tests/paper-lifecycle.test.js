/**
 * Deterministic end-to-end lifecycle test for paper mode.
 * Drives Bot.tick() with a scripted price series — no network, no wallet.
 */
process.env.PAIR_LABEL = 'TEST/USDC';
process.env.BASE_TOKEN = 'TST';
process.env.BASE_DECIMALS = '9';
process.env.QUOTE_DECIMALS = '6';
process.env.INITIAL_ORDER = '10';
process.env.ORDER_MULTIPLIER = '1.05';
process.env.MAX_SAFETY_ORDERS = '5';
process.env.PRICE_DROP_PERCENT = '1.33';
process.env.PROFIT_TARGET_PERCENT = '8';
process.env.TP_MODE = 'base';
process.env.MIN_USD_PROFIT_PERCENT = '0.5';
process.env.LOG_LEVEL = 'error';

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// isolate state dir
const stateDir = path.join(process.cwd(), 'state-test');
fs.mkdirSync(stateDir, { recursive: true });
process.chdir(stateDir);

const { Bot } = require('../src/bot');
const { PaperBroker } = require('../src/broker');

function scriptedBot(prices, opts = {}) {
  let i = 0;
  const logger = { info() {}, warn() {}, error() {} };
  const broker = new PaperBroker(logger);
  const bot = new Bot({
    mode: 'paper',
    broker,
    priceOverride: () => prices[Math.min(i++, prices.length - 1)],
    paperBalance: opts.paperBalance ?? 500,
    notifier: async () => {},
  });
  bot.printStatus = () => {};
  return { bot, broker, advance: () => i++ };
}

describe('paper lifecycle: entry → dip fill → recovery TP → reset', () => {
  test('full profitable cycle with sequential grid and correct sizing', async () => {
    // entry 200, L1 fills at 200, price dips → L2 fills at 197.34, then spike → TP sells
    const prices = [200, 200, 197, 196, 196, 220, 220, 220];
    const { bot } = scriptedBot(prices);

    for (let t = 0; t < prices.length; t++) await bot.tick();

    assert.equal(bot.realizedCycles, 1, 'exactly one cycle closed');

    // ORACLE: independently recompute the expected settlement from first principles
    const h1 = 10 / 200, h2 = 10.5 / (200 * (1 - 0.0133));      // two fills
    const holdings = h1 + h2, invested = 20.5, avg = invested / holdings;
    const sellBase = holdings * 0.92;                            // keep 8% extra
    const needed = invested / sellBase;
    const exit = Math.max(needed * 1.005, avg * 1.005);          // floor 0.5%
    const expectedProfit = sellBase * exit - invested;
    assert.ok(bot.realizedProfitUsd > 0 && bot.realizedProfitUsd < 1.0,
      `USD P/L ${bot.realizedProfitUsd} in (0, $1)`);
    assert.ok(Math.abs(bot.realizedProfitUsd - expectedProfit) < 1e-9,
      `P/L ${bot.realizedProfitUsd} == oracle ${expectedProfit}`);
    assert.ok(Math.abs(bot.realizedExtraBase - (holdings - sellBase)) < 1e-9,
      `kept extra base ${bot.realizedExtraBase} == oracle ${holdings - sellBase}`);

    // new cycle opened at spike price
    assert.ok(bot.cycle, 'reset opened a new cycle');
    assert.equal(bot.cycle.entryPrice, 220);

    // accounting sanity: nothing went negative, escrow bounded
    const w = bot.wallet;
    assert.ok(w.escrow >= -1e-9, 'escrow never negative');
    assert.ok(w.quote >= 0 && w.base >= 0);
    assert.ok(w.quote + w.escrow < 500 + 5, 'no phantom money');
  });
});

describe('paper lifecycle: emergency stop is actionable', () => {
  test('crash 35% cancels everything and liquidates to quote', async () => {
    process.env.ENABLE_EMERGENCY_STOP = 'true';
    process.env.EMERGENCY_STOP_PERCENT = '30';
    const prices = [200, 200, 197, 130];
    const { bot, broker } = scriptedBot(prices, { paperBalance: 200 });

    for (let t = 0; t < prices.length; t++) await bot.tick();

    assert.equal(bot.stopped, true, 'emergency stop halts the bot');
    assert.equal(bot.cycle, null);
    assert.equal(broker.stats.cancelOps >= 1, true, 'open orders were cancelled');
    assert.ok(bot.wallet.base < 1e-9, 'position liquidated (no base left)');
    assert.equal(bot.wallet.escrow < 1, true, 'escrow drained');
    const w = bot.wallet;
    assert.ok(w.quote <= 200 && w.quote > 200 * 0.6, `crash loss bounded: ${w.quote.toFixed(2)} USDC left of 200`);
    delete process.env.ENABLE_EMERGENCY_STOP;
    delete process.env.EMERGENCY_STOP_PERCENT;
  });
});

describe('paper lifecycle: no-fill drift', () => {
  test('flat price above grid → L1 fills, no TP ever forced, no negative balances', async () => {
    const prices = Array(10).fill(201);
    const { bot } = scriptedBot(prices, { paperBalance: 100 });
    for (let t = 0; t < prices.length; t++) await bot.tick();
    assert.equal(bot.realizedCycles, 0);
    assert.ok(bot.wallet.quote >= 0);
    // entry=201 → L1 limit 201 fills (price<=limit). Sequential arming places L2
    // (open on-book) but NOT L3+: at most 1 open order beyond the fill.
    const filled = bot.cycle.grid.filter(l => l.status === 'filled').length;
    const open = bot.cycle.grid.filter(l => l.status === 'open').length;
    assert.equal(filled, 1);
    assert.ok(open <= 1, `sequential arming: open orders ${open} ≤ 1, never the whole grid`);
  });
});
