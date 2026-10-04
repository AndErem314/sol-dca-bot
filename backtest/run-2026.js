#!/usr/bin/env node
/**
 * 2026 YTD backtest of the LIVE v2 strategy code (src/bot.js state machine,
 * PaperBroker fills, strategy.js TP math) on Binance SOL/USDT hourly candles.
 *
 * Configs:
 *   baseline   — exactly the default settings, no filter
 *   rsi1h>90   — block OPENING a new cycle when RSI(14) on last closed 1h > 90
 *   rsi4h>90   — same on last closed 4h candle
 *
 * Fill model: intra-candle path O→L→H→C (bullish) / O→H→L→C (bearish);
 * limit orders fill at limit price; 10 bps fee both sides (≈ Jupiter swap fee).
 * No lookahead: RSI at hour i uses closes strictly before candle i.
 */
process.env.PAIR_LABEL = 'SOL/USDC';
process.env.BASE_TOKEN = 'SOL';
process.env.BASE_DECIMALS = '9';
process.env.QUOTE_DECIMALS = '6';
process.env.INITIAL_ORDER = process.env.BT_INITIAL_ORDER || '10';
process.env.ORDER_MULTIPLIER = '1.05';
process.env.MAX_SAFETY_ORDERS = '30';
process.env.PRICE_DROP_PERCENT = '1.33';
process.env.PROFIT_TARGET_PERCENT = '8';
process.env.TP_MODE = 'base';
process.env.MIN_USD_PROFIT_PERCENT = '0.5';
process.env.ENABLE_EMERGENCY_STOP = 'false';
process.env.LOG_LEVEL = 'error';

const fs = require('fs');
const path = require('path');
const { Bot } = require('../src/bot');
const { PaperBroker } = require('../src/broker');

const START_BALANCE = 1000;
const FEE_BPS = 10;
const RSI_PERIOD = 14;
const RSI_BLOCK_ABOVE = parseFloat(process.env.BT_RSI_BLOCK || '90');

// ── RSI (Wilder) ─────────────────────────────────────────────────
function rsiSeries(closes, period = RSI_PERIOD) {
  const rsi = new Array(closes.length).fill(null);
  if (closes.length <= period) return rsi;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  let ag = gain / period, al = loss / period;
  rsi[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    rsi[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return rsi;
}

// 4h closes aggregated from 1h closes; group g covers hours [4g..4g+3]
function confirmed4hRsi(closes1h) {
  const c4 = [];
  for (let i = 3; i < closes1h.length; i += 4) c4.push(closes1h[i]);
  const rsi4 = rsiSeries(c4);
  // at hour i (0-based), fully-closed 4h groups = floor(i/4)
  return (hourIdx) => {
    const n = Math.floor(hourIdx / 4); // last closed group index = n-1
    return n >= 1 ? rsi4[n - 1] : null;
  };
}

// ── load candles ─────────────────────────────────────────────────
const candles = JSON.parse(fs.readFileSync(path.join(__dirname, 'data/solusdt_1h_2026.json')));
const closes = candles.map(c => c[4]);
const rsi1h = rsiSeries(closes);
const rsi4hAt = confirmed4hRsi(closes);
console.log(`Loaded ${candles.length} 1h candles, ${new Date(candles[0][0]).toISOString().slice(0,10)} → ${new Date(candles.at(-1)[0]).toISOString().slice(0,16)} UTC`);
console.log(`SOL range: $${Math.min(...candles.map(c=>c[3])).toFixed(2)} – $${Math.max(...candles.map(c=>c[2])).toFixed(2)}`);

// RSI character of the year (for threshold choice)
{
  const r1 = rsi1h.filter(r => r !== null);
  const max1 = Math.max(...r1);
  const dates1 = candles.map((c, i) => rsi1h[i] > 85 ? new Date(c[0]).toISOString().slice(0,10) : null).filter(Boolean);
  const r4vals = candles.map((_, i) => rsi4hAt(i)).filter(r => r !== null && r !== undefined);
  console.log(`1h RSI(14): max ${max1.toFixed(1)} | hours>85: ${r1.filter(r=>r>85).length} >90: ${r1.filter(r=>r>90).length} | days>85: ${[...new Set(dates1)].join(', ') || 'none'}`);
  console.log(`4h RSI(14): max ${Math.max(...r4vals).toFixed(1)} | hours>85: ${r4vals.filter(r=>r>85).length} >90: ${r4vals.filter(r=>r>90).length}`);
}
console.log(`1h RSI>90 hours: ${rsi1h.filter(r => r !== null && r > RSI_BLOCK_ABOVE).length} | 4h RSI>90 hours: ${candles.reduce((n,_,i)=>n+(rsi4hAt(i)>RSI_BLOCK_ABOVE?1:0),0)}`);

// ── one config run ───────────────────────────────────────────────
async function runConfig(name, filter) {
  const logger = { info() {}, warn() {}, error() {} };
  const broker = new PaperBroker(logger, FEE_BPS);
  let idx = 0, sub = 0;
  let blockedAttempts = 0;
  const bot = new Bot({
    mode: 'paper', broker, paperBalance: START_BALANCE,
    notifier: async () => {},
    priceOverride: () => {
      const c = candles[idx];
      const bull = c[4] >= c[1];
      const p = bull ? [c[1], c[3], c[2], c[4]] : [c[1], c[2], c[3], c[4]];
      return p[Math.min(sub, 3)];
    },
    entryFilter: filter ? () => {
      const r = filter === '1h' ? (idx > 0 ? rsi1h[idx - 1] : null) : rsi4hAt(idx);
      if (r !== null && r !== undefined && r > RSI_BLOCK_ABOVE) { blockedAttempts++; return false; }
      return true;
    } : null,
  });
  bot.saveState = async () => {};
  bot.printStatus = () => {};

  let equityMin = START_BALANCE, equityMax = START_BALANCE;
  let maxDeployed = 0;
  const cycleEvents = [];
  bot.notify = async (msg) => {
    const when = new Date(candles[idx][0]).toISOString().slice(0, 16);
    const r1 = idx > 0 ? rsi1h[idx - 1] : null;
    const r4 = rsi4hAt(idx);
    if (msg.startsWith('✅')) cycleEvents.push({ when, kind: 'SETTLED', px: candles[idx][1], rsi1h: r1 && +r1.toFixed(1), rsi4h: r4 && +r4.toFixed(1) });
    if (msg.startsWith('Cycle #')) cycleEvents.push({ when, kind: 'ENTRY', px: candles[idx][1], rsi1h: r1 && +r1.toFixed(1), rsi4h: r4 && +r4.toFixed(1) });
  };

  const equityOf = (px) => {
    // open TP sell = sellBase TOKENS at market, not gross proceeds (they may never fill)
    const c = bot.cycle;
    const sellEscrow = c && c.sellOrderId ? c.sellQuote : 0;
    const sellBase = c && c.sellOrderId ? c.sellBase : 0;
    return bot.wallet.quote + (bot.wallet.escrow - sellEscrow) + (bot.wallet.base + sellBase) * px;
  };

  for (idx = 0; idx < candles.length; idx++) {
    for (sub = 0; sub < 4; sub++) await bot.tick(); // intra-candle path
    const px = closes[idx];
    const equity = equityOf(px);
    equityMin = Math.min(equityMin, equity);
    equityMax = Math.max(equityMax, equity);
    const openBuys = bot.cycle ? bot.cycle.grid.filter(l => l.status === 'open').reduce((s, l) => s + l.sizeQuote, 0) : 0;
    const deployed = (bot.cycle ? bot.cycle.invested : 0) + openBuys;
    maxDeployed = Math.max(maxDeployed, deployed);
  }

  // final position MTM
  const finalPx = closes.at(-1);
  const finalEquity = equityOf(finalPx);

  const res = {
    name,
    closedCycles: bot.realizedCycles,
    cycleEvents,
    blockedEntryHours: blockedAttempts,
    realizedUsd: +bot.realizedProfitUsd.toFixed(2),
    extraSolKept: +bot.realizedExtraBase.toFixed(4),
    extraSolAtEndValue: +(bot.realizedExtraBase * finalPx).toFixed(2),
    wallet: { quote: +bot.wallet.quote.toFixed(2), base: +bot.wallet.base.toFixed(4) },
    openCycleAtEnd: bot.cycle ? {
      entry: +bot.cycle.entryPrice.toFixed(2), filled: bot.cycle.filled.length,
      invested: +bot.cycle.invested.toFixed(2), holdings: +bot.cycle.holdings.toFixed(4),
    } : null,
    finalEquityMtm: +finalEquity.toFixed(2),
    minEquity: +equityMin.toFixed(2),
    maxDeployedUSD: +maxDeployed.toFixed(2),
  };
  return res;
}

(async () => {
  const T = RSI_BLOCK_ABOVE;
  const results = [];
  results.push(await runConfig('baseline', null));
  results.push(await runConfig(`rsi1h>${T}`, '1h'));
  results.push(await runConfig(`rsi4h>${T}`, '4h'));

  const bh = {
    name: 'buy&hold',
    invested: START_BALANCE,
    sol: +(START_BALANCE / closes[0]).toFixed(4),
    finalValue: +(START_BALANCE * closes.at(-1) / closes[0]).toFixed(2),
    ytdPct: +((closes.at(-1) / closes[0] - 1) * 100).toFixed(2),
  };

  const out = { meta: {
    symbol: 'SOL/USDT (Binance 1h) as SOL/USDC proxy',
    period: `${new Date(candles[0][0]).toISOString()} → ${new Date(candles.at(-1)[0]).toISOString()}`,
    params: { initialOrder: 10, multiplier: 1.05, orders: 30, dropPct: 1.33, tpMode: 'base', profitPct: 8, usdFloorPct: 0.5, feeBps: FEE_BPS, startBalance: START_BALANCE },
    fillModel: 'intra-candle O-L-H-C path, limit fills at limit price, no slippage modeling',
  }, results, buyHold: bh };

  fs.writeFileSync(path.join(__dirname, `results-2026-ytd-rsi${T}.json`), JSON.stringify(out, null, 2));
  console.log('\n' + JSON.stringify(out, null, 2));
})();
