#!/usr/bin/env node
/**
 * Solana DCA Trading Bot — v2 (Jupiter Trigger v1 + paper mode)
 *
 * Rewritten Oct 2026 after a full audit of the original limit/v4 version,
 * which could not install (dead npm deps), could not price (dead quote v6),
 * could not order (limit/v4 never existed), and could not take profit
 * (sell sized at 108% of holdings; exit price BELOW average entry).
 * Original kept at src/legacy/bot.v1.js.
 *
 * Modes:
 *   --paper   live prices, simulated fills, zero funds at risk   ← default
 *   --live    real orders via Jupiter Trigger v1 (funded wallet)  ← opt-in
 *
 * Lifecycle: sequential grid buys → TP sell sized to holdings → on fill,
 * realize + RESET cycle. Emergency stop actually cancels and liquidates.
 */
const fs = require('fs').promises;
const path = require('path');
const winston = require('winston');
const { config, validateForLive } = require('./config');
const { getPrice } = require('./marketData');
const { PaperBroker } = require('./broker');
const { buildGrid, computeTpPlan, shouldEmergencyStop } = require('./strategy');

const PAIR = config.pairLabel;
const logger = winston.createLogger({
  level: config.logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${PAIR}] [${level.toUpperCase()}]: ${message}`)
  ),
  transports: [new winston.transports.Console()],
});

class Cycle {
  constructor(entryPrice, grid) {
    this.entryPrice = entryPrice;
    this.grid = grid;
    this.sellOrderId = null;
    this.sellPlacedPrice = null;
    this.sellBase = 0;      // base committed to the TP sell order
    this.sellQuote = 0;     // expected proceeds of that sell
    this.keepBase = 0;      // extra base deliberately left unsold (the reward)
    this.startedAt = Date.now();
  }
  get filled() { return this.grid.filter(l => l.status === 'filled'); }
  get nextPending() { return this.grid.find(l => l.status === 'pending') || null; }
  get invested() { return this.filled.reduce((s, l) => s + l.sizeQuote, 0); }
  get holdings() { return this.filled.reduce((s, l) => s + (l.filledBaseAmount || 0), 0); }
  get avgEntry() { const h = this.holdings; return h > 0 ? this.invested / h : 0; }
}

class Bot {
  constructor(opts = {}) {
    this.mode = opts.mode || 'paper';
    this.broker = opts.broker || null;
    this.notifier = opts.notifier || null;
    this.priceOverride = opts.priceOverride || null;
    this.entryFilter = opts.entryFilter || null; // optional: () => bool — gate cycle opening (RSI etc.)
    this.jupiterBrokerFactory = opts.jupiterBrokerFactory || null;
    this.now = opts.now || Date.now;
    this.cycle = null;
    this.events = [];
    this.realizedCycles = 0;
    this.realizedProfitUsd = 0;
    this.realizedExtraBase = 0;
    this.wallet = { quote: opts.paperBalance ?? 2000, base: 0, escrow: 0 };
    this.stopped = false;
  }

  async notify(msg) {
    logger.info(`📢 ${msg.replace(/\n/g, ' | ')}`);
    this.events.push({ t: this.now(), msg });
    if (this.notifier) await this.notifier(msg).catch(() => {});
  }

  // ── persistence ────────────────────────────────────────────────
  stateFile() { return path.join(process.cwd(), 'state', `${PAIR.replace('/', '-')}.${this.mode}.json`); }

  async saveState() {
    await fs.mkdir(path.join(process.cwd(), 'state'), { recursive: true });
    await fs.writeFile(this.stateFile(), JSON.stringify({
      mode: this.mode, pair: PAIR,
      cycle: this.cycle,
      realizedCycles: this.realizedCycles,
      realizedProfitUsd: this.realizedProfitUsd,
      realizedExtraBase: this.realizedExtraBase,
      wallet: this.wallet,
      events: this.events.slice(-500),
      savedAt: this.now(),
    }, null, 2));
  }

  async loadState() {
    try {
      const data = JSON.parse(await fs.readFile(this.stateFile(), 'utf8'));
      if (data.cycle?.entryPrice) {
        const c = new Cycle(data.cycle.entryPrice, data.cycle.grid || []);
        Object.assign(c, data.cycle);
        this.cycle = c;
      }
      Object.assign(this, {
        realizedCycles: data.realizedCycles || 0,
        realizedProfitUsd: data.realizedProfitUsd || 0,
        realizedExtraBase: data.realizedExtraBase || 0,
      });
      if (data.wallet) this.wallet = data.wallet;
      this.events = data.events || [];
      return true;
    } catch { return false; }
  }

  async tickPrice() {
    if (this.priceOverride) return this.priceOverride();
    const { price } = await getPrice(logger);
    return price;
  }

  // ── lifecycle ──────────────────────────────────────────────────
  async openCycle(price) {
    this.cycle = new Cycle(price, buildGrid(price, {
      initialOrder: config.initialOrder,
      orderMultiplier: config.orderMultiplier,
      maxOrders: config.maxOrders,
      priceDropPercent: config.priceDropPercent,
    }));
    await this.notify(
      `Cycle #${this.realizedCycles + 1} opened @ $${price.toFixed(6)} | ` +
      `${config.maxOrders} levels, ${config.priceDropPercent}% spacing, ${config.orderMultiplier}x sizing`);
  }

  async placeBuy(level) {
    const expectedBase = level.sizeQuote / level.limitPrice;
    const res = await this.broker.place({
      side: 'buy',
      quoteAmount: level.sizeQuote, baseAmount: expectedBase, limitPrice: level.limitPrice,
      makingAtomic: Math.floor(level.sizeQuote * 10 ** config.quoteDecimals),
      takingAtomic: Math.floor(expectedBase * 10 ** config.baseDecimals),
      isSell: false,
    });
    if (res.success) {
      level.status = 'open';
      level.orderId = res.orderId;
      if (this.mode === 'paper') { this.wallet.quote -= level.sizeQuote; this.wallet.escrow += level.sizeQuote; }
    }
    return res;
  }

  /** Sequential arming: only place the next grid level once the previous filled. */
  async placeNextBuy() {
    const c = this.cycle;
    const idx = c.grid.findIndex(l => l.status === 'pending');
    if (idx === -1) return;
    if (idx > 0 && c.grid[idx - 1].status !== 'filled') return; // wait for previous fill
    return this.placeBuy(c.grid[idx]);
  }

  async applyBuyFill(level, f) {
    const c = this.cycle;
    level.status = 'filled';
    level.filledPrice = f.filledPrice;
    level.filledAt = this.now();
    level.filledBaseAmount = f.baseAmount;
    if (this.mode === 'paper') { this.wallet.escrow -= level.sizeQuote; this.wallet.base += f.baseAmount; }
    await this.notify(
      `Buy #${level.orderNum} filled: ${f.baseAmount.toFixed(6)} ${config.baseToken} @ $${f.filledPrice.toFixed(6)} | ` +
      `cycle ${c.filled.length}/${c.grid.length}, invested $${c.invested.toFixed(2)}, avg $${c.avgEntry.toFixed(6)}`);
  }

  /** Compute TP and (re)place the sell; never sells more than held. */
  async replanTp() {
    const c = this.cycle;
    if (!(c.holdings > 0)) return;
    const plan = computeTpPlan(
      { invested: c.invested, holdings: c.holdings, avgEntry: c.avgEntry },
      { mode: config.tpMode(), profitTargetPercent: config.profitTargetPercent, minUsdProfitPct: config.minUsdProfitPct() });
    if (!plan?.armed) return;

    if (c.sellOrderId && c.sellPlacedPrice && Math.abs(plan.exitPrice - c.sellPlacedPrice) < 1e-12) return;

    // refund the old sell reservation before replacing it
    if (c.sellOrderId) {
      const ok = await this.broker.cancel(c.sellOrderId);
      if (ok && this.mode === 'paper') { this.wallet.base += c.sellBase; this.wallet.escrow -= c.sellQuote; }
      else if (!ok && this.mode === 'live') { logger.warn('cancel of stale sell failed — skipping replan this tick'); return; }
    }

    const sellBase = Math.min(plan.sellBase, c.holdings);  // THE bug fix: ≤ holdings, always
    const sellQuote = sellBase * plan.exitPrice;
    const res = await this.broker.place({
      side: 'sell',
      quoteAmount: sellQuote, baseAmount: sellBase, limitPrice: plan.exitPrice,
      makingAtomic: Math.floor(sellBase * 10 ** config.baseDecimals),
      takingAtomic: Math.floor(sellQuote * 10 ** config.quoteDecimals),
      isSell: true,
    });
    if (res.success) {
      c.sellOrderId = res.orderId;
      c.sellPlacedPrice = plan.exitPrice;
      c.sellBase = sellBase;
      c.sellQuote = sellQuote;
      c.keepBase = plan.keepBase ?? (c.holdings - sellBase);
      if (this.mode === 'paper') { this.wallet.base -= sellBase; this.wallet.escrow += sellQuote; }
      await this.notify(
        `TP armed: sell ${sellBase.toFixed(6)} ${config.baseToken} @ $${plan.exitPrice.toFixed(6)} ` +
        `(keep ${c.keepBase.toFixed(6)} extra) | needs +${(plan.exitPrice / c.avgEntry * 100 - 100).toFixed(1)}% over avg`);
    }
  }

  async settleCycle(f) {
    const c = this.cycle;
    const gross = c.sellQuote;
    const proceeds = (f && typeof f.quoteAmount === 'number' && f.quoteAmount > 0) ? f.quoteAmount : gross;
    const usdPnl = proceeds - c.invested;
    this.realizedCycles += 1;
    this.realizedProfitUsd += usdPnl;
    this.realizedExtraBase += c.keepBase;
    if (this.mode === 'paper') { this.wallet.escrow -= gross; this.wallet.quote += proceeds; }
    await this.notify(
      `✅ Cycle closed: proceeds $${proceeds.toFixed(2)} (gross $${gross.toFixed(2)}) vs invested $${c.invested.toFixed(2)} ` +
      `(USD P/L ${usdPnl.toFixed(2)}) | kept ${c.keepBase.toFixed(6)} extra ${config.baseToken}`);
    this.cycle = null;
  }

  async emergencyStop(price) {
    const c = this.cycle;
    await this.notify(`🛑 EMERGENCY STOP @ $${price.toFixed(6)} — cancelling all orders, liquidating.`);
    for (const l of c.grid) {
      if (l.status === 'open' && l.orderId) {
        const ok = await this.broker.cancel(l.orderId);
        if (ok && this.mode === 'paper') { this.wallet.escrow -= l.sizeQuote; this.wallet.quote += l.sizeQuote; }
        l.status = 'cancelled'; l.orderId = null;
      }
    }
    if (c.sellOrderId) {
      const ok = await this.broker.cancel(c.sellOrderId);
      if (ok && this.mode === 'paper') { this.wallet.base += c.sellBase; this.wallet.escrow -= c.sellQuote; }
      c.sellOrderId = null;
    }
    const freeBase = this.mode === 'paper' ? this.wallet.base : c.holdings;
    if (freeBase > 0) {
      const px = price * 0.995; // marketable limit → triggers instantly
      const res = await this.broker.place({
        side: 'sell', quoteAmount: freeBase * px, baseAmount: freeBase, limitPrice: px,
        makingAtomic: Math.floor(freeBase * 10 ** config.baseDecimals),
        takingAtomic: Math.floor(freeBase * px * 10 ** config.quoteDecimals),
        isSell: true,
      });
      if (res.success && this.mode === 'paper') {
        this.wallet.base -= freeBase; this.wallet.escrow += freeBase * px;
        const fills = this.broker.match(price);
        for (const f of fills) if (f.side === 'sell') {
          this.wallet.escrow -= f.quoteAmount; this.wallet.quote += f.quoteAmount;
          await this.notify(`Liquidated ${f.baseAmount.toFixed(6)} ${config.baseToken} → $${f.quoteAmount.toFixed(2)}`);
        }
      }
    }
    this.cycle = null;
    this.stopped = true;
    await this.saveState();
  }

  // ── live fill reconciliation ───────────────────────────────────
  async reconcileLive() {
    const c = this.cycle;
    if (!c) return;
    for (const l of c.grid) {
      if (l.status !== 'open' || !l.orderId) continue;
      const st = await this.broker.status(l.orderId);
      if (st?.filled) {
        const baseAmt = st.raw?.outputAmount != null
          ? Number(st.raw.outputAmount) / 10 ** config.baseDecimals
          : l.sizeQuote / l.limitPrice;
        await this.applyBuyFill(l, { side: 'buy', filledPrice: l.limitPrice, baseAmount: baseAmt, orderId: l.orderId });
      } else if (st && ['cancelled', 'expired', 'failed'].includes(st.state)) {
        l.status = 'pending'; l.orderId = null; // re-arm on next tick
      }
    }
    if (c.sellOrderId) {
      const st = await this.broker.status(c.sellOrderId);
      if (st?.filled) {
        await this.settleCycle({
          quoteAmount: st.raw?.outputAmount != null
            ? Number(st.raw.outputAmount) / 10 ** config.quoteDecimals : undefined,
        });
      }
      else if (st && ['cancelled', 'expired', 'failed'].includes(st.state)) {
        c.sellOrderId = null; c.sellPlacedPrice = null; // replan will re-place
      }
    }
  }

  // ── main loop ──────────────────────────────────────────────────
  async tick() {
    const price = await this.tickPrice();
    this.lastPrice = price;
    if (!price) { logger.warn('No price available this tick — skipping'); return; }

    if (this.mode === 'paper') {
      for (const f of this.broker.match(price)) {
        if (f.side === 'buy') {
          const c = this.cycle;
          const lvl = c?.grid.find(l => l.orderId === f.orderId);
          if (lvl) await this.applyBuyFill(lvl, f);
        } else if (f.side === 'sell' && this.cycle?.sellOrderId === f.orderId) {
          await this.settleCycle(f);
        }
      }
    }

    if (!this.cycle) {
      if (!this.stopped && (!this.entryFilter || this.entryFilter())) await this.openCycle(price);
    } else {
      if (shouldEmergencyStop(price, this.cycle.entryPrice, {
        emergencyStopEnabled: config.emergencyStopEnabled(),
        emergencyStopPercent: config.emergencyStopPercent(),
      })) {
        await this.emergencyStop(price);
        return;
      }
      await this.placeNextBuy();
      if (this.mode === 'live') await this.reconcileLive();
      await this.replanTp();
    }
    await this.saveState();
  }

  printStatus(price) {
    const c = this.cycle;
    logger.info(`── ${PAIR} [${this.mode.toUpperCase()}] @ $${price?.toFixed?.(6) ?? '—'} | closed cycles: ${this.realizedCycles} | realized USD: $${this.realizedProfitUsd.toFixed(2)} ──`);
    if (c) {
      logger.info(`  entry $${c.entryPrice.toFixed(6)} | filled ${c.filled.length}/${c.grid.length} | invested $${c.invested.toFixed(2)} | ${c.holdings.toFixed(6)} ${config.baseToken} @ avg $${c.avgEntry.toFixed(6)}${c.sellPlacedPrice ? ` | TP sell @ $${c.sellPlacedPrice.toFixed(6)} (keep ${c.keepBase.toFixed(4)})` : ''}`);
    }
    if (this.mode === 'paper') {
      logger.info(`  wallet: $${this.wallet.quote.toFixed(2)} + ${this.wallet.base.toFixed(6)} ${config.baseToken} | escrow $${this.wallet.escrow.toFixed(2)}`);
    }
  }

  async run() {
    if (this.mode === 'live') await this.initLive();
    if (!this.broker) this.broker = this.mode === 'paper' ? new PaperBroker(logger) : await this.jupiterBrokerFactory?.();
    if (!this.broker) throw new Error('No broker available');
    await this.loadState();
    logger.info(`${PAIR} DCA v2 — ${this.mode.toUpperCase()} mode | entry→sequential grid→TP sized to holdings→reset`);
    while (!this.stopped) {
      await this.tick();
      this.printStatus(this.lastPrice);
      await new Promise(r => setTimeout(r, config.intervalSeconds * 1000));
    }
    logger.info('Bot stopped.');
  }

  async initLive() {
    const problems = validateForLive(config);
    if (problems.length) {
      logger.error(`Refusing LIVE start: ${problems.join('; ')}. Use --paper for simulation.`);
      process.exit(2);
    }
    const { Connection, Keypair } = require('@solana/web3.js');
    const { JupiterBroker } = require('./broker');
    const connection = new Connection(config.rpcEndpoint, 'confirmed');
    const wallet = Keypair.fromSecretKey(Buffer.from(config.privateKey, 'base64'));
    const sol = await connection.getBalance(wallet.publicKey);
    logger.info(`LIVE wallet ${wallet.publicKey.toString()} | ${(sol / 1e9).toFixed(4)} SOL`);
    if (sol / 1e9 < config.minBaseForFees) logger.warn(`SOL below ${config.minBaseForFees} — orders may fail on fees`);
    this.broker = new JupiterBroker(logger, wallet, connection);
  }
}

module.exports = { Bot, Cycle };

if (require.main === module) {
  const mode = process.argv.includes('--live') ? 'live' : 'paper';
  new Bot({ mode }).run().catch(e => { logger.error(`Fatal: ${e.message}`); process.exit(1); });
}
