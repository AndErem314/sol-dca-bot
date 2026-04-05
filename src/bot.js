#!/usr/bin/env node

/**
 * Solana DCA Trading Bot — Limit Order Edition
 *
 * Uses Jupiter Limit Order API so orders persist on-chain.
 * After placing a limit order, the bot tracks it and
 * automatically places the next order when it fills.
 *
 * Flow:
 *   1. Bot starts → checks for existing open limit orders
 *   2. If none → places first buy limit order at current price
 *   3. On fill → places next buy limit order at lower price
 *   4. Repeat until all orders filled
 *   5. When all filled (or anytime) → place sell limit order at exit price
 *   6. Sell fills → take profit, done
 *
 * Orders survive bot restarts — they live on Jupiter's order book.
 */

require('dotenv').config();
const { Connection, Keypair, PublicKey, VersionedTransaction } = require('@solana/web3.js');
const winston = require('winston');
const fs = require('fs').promises;
const path = require('path');

// ─── Config ──────────────────────────────────────────────────────
const PAIR = process.env.PAIR_LABEL || 'SOL/USDC';
const BASE_TOKEN = process.env.BASE_TOKEN || 'SOL';
const INITIAL_ORDER = parseFloat(process.env.INITIAL_ORDER || 10.0);
const ORDER_MULTIPLIER = parseFloat(process.env.ORDER_MULTIPLIER || 1.05);
const MAX_ORDERS = parseInt(process.env.MAX_SAFETY_ORDERS || 30);
const PRICE_DROP_PERCENT = parseFloat(process.env.PRICE_DROP_PERCENT || 1.33);
const PROFIT_TARGET_PERCENT = parseFloat(process.env.PROFIT_TARGET_PERCENT || 8.0);
const MAX_DRAWDOWN = parseFloat(process.env.MAX_DRAWDOWN_PERCENT || 40.0);
const ENABLE_EMERGENCY_STOP = process.env.ENABLE_EMERGENCY_STOP === 'true';
const EMERGENCY_STOP_PCT = parseFloat(process.env.EMERGENCY_STOP_PERCENT || 50.0);
const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || 30000);

// Jupiter API
const JUPITER_API = 'https://jup.ag/api';
const JUP_LIMIT_V4 = `${JUPITER_API}/limit/v4`;

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) =>
      `${timestamp} [${PAIR}] [${level.toUpperCase()}]: ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    ...(process.env.LOG_TO_FILE === 'true' ? [
      new winston.transports.File({ filename: `logs/${PAIR.replace('/', '-')}.log` })
    ] : [])
  ]
});

// ─── Grid Builder ────────────────────────────────────────────────

function buildGrid(entryPrice) {
  const grid = [];
  let cumulativeUSDC = 0;

  for (let i = 0; i < MAX_ORDERS; i++) {
    const orderNum = i + 1;
    const size = INITIAL_ORDER * Math.pow(ORDER_MULTIPLIER, i);
    const dropPct = i * PRICE_DROP_PERCENT;
    cumulativeUSDC += size;

    grid.push({
      orderNum,
      orderIndex: i,
      sizeUSDC: size,
      cumulativeUSDC: Math.round(cumulativeUSDC * 100) / 100,
      dropPercent: Math.round(dropPct * 100) / 100,
      limitPrice: Math.round(entryPrice * (1 - dropPct / 100) * 1e8) / 1e8,
      // Jupiter limit order state
      status: 'pending',   // pending | open | filled | cancelled
      orderId: null,
      filledPrice: null,
      filledAt: null,
      filledBaseAmount: null,
    });
  }

  return grid;
}

// ─── Bot State ───────────────────────────────────────────────────

class BotState {
  constructor() {
    this.entryPrice = null;
    this.grid = [];
    this.totalInvestedUSDC = 0;
    this.totalBaseBought = 0;
    this.avgEntryPrice = null;
    this.targetExtraBase = 0;
    this.targetTotalBase = 0;
    this.exitPrice = null;
    this.emergencyStop = false;
    this.sellOrderPlaced = false;
    this.sellOrderId = null;
    this.sellFilled = false;

    // Trading
    this.baseMint = null;
    this.quoteMint = null;
    this.baseDecimals = 9;
    this.quoteDecimals = 6;
  }

  get filledCount() {
    return this.grid.filter(l => l.status === 'filled').length;
  }

  get openOrderCount() {
    return this.grid.filter(l => l.status === 'open').length;
  }

  get nextPendingOrder() {
    return this.grid.find(l => l.status === 'pending') || null;
  }

  get allOrdersFilled() {
    return this.filledCount === MAX_ORDERS;
  }

  calculateTargets() {
    if (this.totalBaseBought === 0) return;

    this.targetExtraBase = this.totalBaseBought * (PROFIT_TARGET_PERCENT / 100);
    this.targetTotalBase = this.totalBaseBought + this.targetExtraBase;
    this.exitPrice = Math.round((this.totalInvestedUSDC / this.targetTotalBase) * 1e8) / 1e8;

    logger.info(
      `[TARGET] ${this.totalBaseBought.toFixed(6)} ${BASE_TOKEN} | ` +
      `exit: $${this.exitPrice.toFixed(6)} | ` +
      `extra: +${this.targetExtraBase.toFixed(6)} ${BASE_TOKEN} (+${PROFIT_TARGET_PERCENT}%)`
    );

    // Drawdown check
    if (ENABLE_EMERGENCY_STOP && this.entryPrice) {
      const dd = ((this.entryPrice - this.exitPrice) / this.entryPrice) * 100;
      if (dd > MAX_DRAWDOWN + 5) {
        logger.error(
          `[EMERGENCY] Exit target ${dd.toFixed(1)}% below entry — exceeds ${MAX_DRAWDOWN}% limit`
        );
        this.emergencyStop = true;
      }
    }
  }
}

// ─── Jupiter Limit Order API ───────────────────────────────────

class JupiterLimits {
  constructor(wallet, connection) {
    this.wallet = wallet;
    this.connection = connection;
  }

  /**
   * Create a limit order.
   *
   * @param {string} inputMint  - Token you're selling
   * @param {string} outputMint - Token you're buying
   * @param {number} inAmount   - Amount of input tokens (raw, with decimals)
   * @param {number} outAmount  - Minimum amount of output tokens (raw, with decimals)
   * @returns {Promise<{success: boolean, orderId?: string, tx?: VersionedTransaction}>}
   */
  async createOrder(inputMint, outputMint, inAmount, outAmount) {
    try {
      const body = {
        inputMint,
        outputMint,
        inAmount: inAmount.toString(),
        outAmount: outAmount.toString(),
        expiredAt: null,
        publicKey: this.wallet.publicKey.toString(),
      };

      logger.debug(`[JUP LIMIT] POST /order — ${inAmount} → ${outAmount}`);

      const resp = await fetch(`${JUP_LIMIT_V4}/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const err = await resp.text();
        throw new Error(`Jupiter API ${resp.status}: ${err}`);
      }

      const data = await resp.json();
      const orderId = data.orderId;

      if (!orderId) {
        throw new Error('No orderId in Jupiter response');
      }

      if (data.tx) {
        // If transaction is returned, we need to sign and send it.
        // Base64-decode → deserialize → sign → send.
        const txBuf = Buffer.from(data.tx, 'base64');
        const tx = VersionedTransaction.deserialize(txBuf);
        tx.sign([this.wallet]);

        const txId = await this.connection.sendTransaction(tx, {
          skipPreflight: true,
          maxRetries: 2,
        });

        logger.info(`[JUP LIMIT] Order ${orderId} submitted — tx: https://solscan.io/tx/${txId}`);
      } else {
        logger.info(`[JUP LIMIT] Order created: ${orderId}`);
      }

      return { success: true, orderId };
    } catch (error) {
      logger.error(`[JUP LIMIT] Create order failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get all open orders for a wallet.
   */
  async getOpenOrders() {
    try {
      const resp = await fetch(
        `${JUP_LIMIT_V4}/orders?wallet=${this.wallet.publicKey.toString()}&state=open`
      );
      if (!resp.ok) {
        logger.error(`[JUP LIMIT] Fetch orders failed: ${resp.status}`);
        return [];
      }
      return await resp.json();
    } catch (error) {
      logger.error(`[JUP LIMIT] Fetch orders error: ${error.message}`);
      return [];
    }
  }

  /**
   * Cancel an order.
   */
  async cancelOrder(orderId) {
    try {
      const resp = await fetch(`${JUP_LIMIT_V4}/order`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId,
          publicKey: this.wallet.publicKey.toString(),
        }),
      });
      return resp.ok;
    } catch (error) {
      logger.error(`[JUP LIMIT] Cancel failed: ${error.message}`);
      return false;
    }
  }
}

// ─── Bot ─────────────────────────────────────────────────────────

class DCABot {
  constructor() {
    this.state = new BotState();
    this.jup = null;
    this.isTestMode = process.argv.includes('--test');
  }

  async init() {
    logger.info(`Initializing ${PAIR} DCA Bot (limit orders)...`);
    logger.info(`  Base: ${BASE_TOKEN} (${process.env.BASE_MINT})`);
    logger.info(`  Quote: ${PAIR.split('/')[1]} (${process.env.QUOTE_MINT})`);
    logger.info(`  Grid: $${INITIAL_ORDER} × ${ORDER_MULTIPLIER}x, ${MAX_ORDERS} levels, ${PRICE_DROP_PERCENT}% spacing`);

    // Tokens
    this.state.baseMint = new PublicKey(process.env.BASE_MINT);
    this.state.quoteMint = new PublicKey(process.env.QUOTE_MINT);
    this.state.baseDecimals = parseInt(process.env.BASE_DECIMALS || 9);
    this.state.quoteDecimals = parseInt(process.env.QUOTE_DECIMALS || 6);

    // Connection
    const connection = new Connection(
      process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );
    this.state.connection = connection;

    // Wallet
    const pk = process.env.PHANTOM_PRIVATE_KEY;
    if (!pk) throw new Error('PHANTOM_PRIVATE_KEY not set');

    const wallet = Keypair.fromSecretKey(Buffer.from(pk, 'base64'));
    logger.info(`  Wallet: ${wallet.publicKey.toString()}`);

    this.state.wallet = wallet;
    this.jup = new JupiterLimits(wallet, connection);

    // Balances
    try {
      const solBal = await connection.getBalance(wallet.publicKey);
      logger.info(`  SOL: ${(solBal / 1e9).toFixed(4)}`);
    } catch {}

    logger.info(`Ready${this.isTestMode ? ' (TEST MODE)' : ''}`);
  }

  // ─── Price ───────────────────────────────────────────────────

  async getPrice() {
    try {
      const params = new URLSearchParams({
        inputMint: this.state.baseMint.toString(),
        outputMint: this.state.quoteMint.toString(),
        amount: Math.pow(10, this.state.baseDecimals).toString(),
        slippageBps: '50',
      });
      const resp = await fetch(`https://quote-api.jup.ag/v6/quote?${params}`);
      if (!resp.ok) return null;
      const data = await resp.json();
      return parseInt(data.outAmount) / Math.pow(10, this.state.quoteDecimals);
    } catch {
      return null;
    }
  }

  // ─── State Persistence ───────────────────────────────────────

  async saveState() {
    const dir = path.join(process.cwd(), 'state');
    await fs.mkdir(dir, { recursive: true });

    const file = path.join(dir, `${PAIR.replace('/', '-')}.json`);
    const data = {
      entryPrice: this.state.entryPrice,
      grid: this.state.grid,
      totalInvestedUSDC: this.state.totalInvestedUSDC,
      totalBaseBought: this.state.totalBaseBought,
      avgEntryPrice: this.state.avgEntryPrice,
      exitPrice: this.state.exitPrice,
      emergencyStop: this.state.emergencyStop,
      sellOrderPlaced: this.state.sellOrderPlaced,
      sellOrderId: this.state.sellOrderId,
      sellFilled: this.state.sellFilled,
      savedAt: Date.now(),
    };

    await fs.writeFile(file, JSON.stringify(data, null, 2));
  }

  async loadState() {
    const file = path.join(process.cwd(), 'state', `${PAIR.replace('/', '-')}.json`);
    try {
      const raw = await fs.readFile(file, 'utf8');
      const data = JSON.parse(raw);

      const ageMin = Math.round((Date.now() - data.savedAt) / 60000);
      logger.info(`Loaded state (saved ${ageMin}m ago)`);

      this.state.entryPrice = data.entryPrice;
      this.state.grid = data.grid;
      this.state.totalInvestedUSDC = data.totalInvestedUSDC || 0;
      this.state.totalBaseBought = data.totalBaseBought || 0;
      this.state.avgEntryPrice = data.avgEntryPrice;
      this.state.exitPrice = data.exitPrice;
      this.state.emergencyStop = data.emergencyStop;
      this.state.sellOrderPlaced = data.sellOrderPlaced;
      this.state.sellOrderId = data.sellOrderId;
      this.state.sellFilled = data.sellFilled;

      return true;
    } catch {
      return false;
    }
  }

  // ─── Place Buy Limit Order ───────────────────────────────────

  /**
   * Place a limit order: sell USDC → buy BASE at limitPrice.
   *
   *   inAmount  = USDC amount (quote token, with decimals)
   *   outAmount = minimum BASE we expect at limitPrice (base token, with decimals)
   *
   *   outAmount = floor(inAmount / limitPrice * 0.998)  // 0.2% buffer for dust/fees
   */
  async placeBuyLimit(level) {
    if (this.isTestMode) {
      logger.info(`[TEST] Buy limit: $${level.sizeUSDC.toFixed(2)} @ $${level.limitPrice.toFixed(6)}`);
      return { success: true, orderId: `test-order-${level.orderNum}` };
    }

    const inAmount = Math.floor(level.sizeUSDC * Math.pow(10, this.state.quoteDecimals));
    const outAmount = Math.floor((level.sizeUSDC / level.limitPrice) * Math.pow(10, this.state.baseDecimals) * 0.998);

    logger.info(
      `[BUY LIMIT] Order #${level.orderNum}: $${level.sizeUSDC.toFixed(2)} @ $${level.limitPrice.toFixed(6)} ` +
      `(→ ~${(outAmount / Math.pow(10, this.state.baseDecimals)).toFixed(6)} ${BASE_TOKEN})`
    );

    const result = await this.jup.createOrder(
      this.state.quoteMint.toString(),
      this.state.baseMint.toString(),
      inAmount,
      outAmount,
    );

    if (result.success) {
      level.status = 'open';
      level.orderId = result.orderId;
      await this.saveState();

      logger.info(`[BUY LIMIT] ✓ Order #${level.orderNum} placed: ${result.orderId}`);
    }

    return result;
  }

  // ─── Place Sell Limit Order ──────────────────────────────────

  /**
   * Place a limit sell: sell all accumulated BASE → receive USDC at exitPrice.
   * After fill we keep extra BASE (the profit) because the sell only sells
   * the amount needed to recover totalInvestedUSDC.
   *
   * We sell: totalBaseBought × (exitPrice / avgEntryPrice) fraction
   * Actually: we sell enough to get totalInvestedUSDC back at exitPrice.
   *   sellBaseAmount = totalInvestedUSDC / exitPrice = targetTotalBase
   *   keptBase = totalBaseBought - sellBaseAmount = targetExtraBase
   */
  async placeSellLimit() {
    if (this.state.sellOrderPlaced || this.state.totalBaseBought === 0) return;

    const sellBaseAmount = this.state.targetTotalBase !== 0
      ? this.state.totalInvestedUSDC / this.state.exitPrice
      : this.state.totalBaseBought;

    // If targetTotalBase < totalBaseBought, we keep the difference (the profit)
    const keepAmount = this.state.targetExtraBase;

    if (sellBaseAmount <= 0) {
      logger.warn('[SELL] Nothing to sell');
      return;
    }

    if (this.isTestMode) {
      logger.info(`[TEST] Sell limit: ${sellBaseAmount.toFixed(6)} ${BASE_TOKEN} @ $${this.state.exitPrice.toFixed(6)}`);
      this.state.sellOrderId = 'test-sell';
      this.state.sellOrderPlaced = true;
      return;
    }

    const inAmount = Math.floor(sellBaseAmount * Math.pow(10, this.state.baseDecimals));
    const outAmount = Math.floor(this.state.totalInvestedUSDC * Math.pow(10, this.state.quoteDecimals));

    logger.info(
      `[SELL LIMIT] ${sellBaseAmount.toFixed(6)} ${BASE_TOKEN} @ $${this.state.exitPrice.toFixed(6)} → $${this.state.totalInvestedUSDC.toFixed(2)} USDC ` +
      `(keep ${keepAmount.toFixed(6)} extra ${BASE_TOKEN})`
    );

    const result = await this.jup.createOrder(
      this.state.baseMint.toString(),
      this.state.quoteMint.toString(),
      inAmount,
      outAmount,
    );

    if (result.success) {
      this.state.sellOrderId = result.orderId;
      this.state.sellOrderPlaced = true;
      await this.saveState();

      logger.info(`[SELL LIMIT] ✓ Sell placed: ${result.orderId}`);
    }
  }

  // ─── Main Loop ───────────────────────────────────────────────

  async run() {
    await this.init();

    const hadState = await this.loadState();

    // If no state yet, get price and set up the grid
    if (!hadState || !this.state.entryPrice) {
      const price = await this.getPrice();
      if (!price) {
        logger.error('Cannot fetch initial price. Exiting.');
        process.exit(1);
      }

      logger.info(`Entry price: $${price.toFixed(6)}`);
      this.state.entryPrice = price;
      this.state.grid = buildGrid(price);
      await this.saveState();
    }

    // If we have state but no grid, rebuild it
    if (this.state.grid.length === 0) {
      this.state.grid = buildGrid(this.state.entryPrice);
    }

    // ─── Reconcile with Jupiter open orders ───
    if (!this.isTestMode) {
      const openOrders = await this.jup.getOpenOrders();
      const orderMap = new Map(openOrders.map(o => [o.id, o]));

      for (const level of this.state.grid) {
        if (level.status === 'open' && level.orderId) {
          const jupOrder = orderMap.get(level.orderId);
          if (!jupOrder) {
            // Order not on Jupiter anymore — might have filled
            level.status = 'filled';
            logger.info(`Order #${level.orderNum} (${level.orderId}) no longer on Jupiter — marked filled`);
          }
        }
      }

      // Check if sell order is still open
      if (this.state.sellOrderId && this.state.sellOrderPlaced && !this.state.sellFilled) {
        const sellOnJup = openOrders.find(o => o.id === this.state.sellOrderId);
        if (!sellOnJup) {
          this.state.sellFilled = true;
          logger.info(`[SELL] Order no longer on Jupiter — assumed filled!`);
        }
      }
    }

    await this.saveState();
    this.printStatus();

    // ─── Check if we already exit-ed ───
    if (this.state.sellFilled) {
      logger.info('Sell already filled — position closed.');
      return;
    }

    // ─── Main loop ───
    while (!this.state.emergencyStop) {
      await this.tick();
      await this.sleep(CHECK_INTERVAL_MS);
    }

    logger.info('Bot stopped.');
  }

  async tick() {
    // ── 1. Check filled buy orders ──
    for (const level of this.state.grid) {
      if (level.status !== 'open') continue;

      if (this.isTestMode) {
        // In test mode, treat as filled on next tick
        level.status = 'filled';
        level.filledPrice = level.limitPrice;
        level.filledAt = Date.now();
        level.filledBaseAmount = level.sizeUSDC / level.limitPrice;
        logger.info(`[TEST] Order #${level.orderNum} filled`);
      }

      // In live mode, check Jupiter API if the order is gone (it filled)
      if (!this.isTestMode && level.orderId) {
        const orderDetails = await this.checkOrderStatus(level.orderId);
        if (orderDetails && orderDetails.filled) {
          level.status = 'filled';
          level.filledPrice = orderDetails.filledAvgPrice || level.limitPrice;
          level.filledAt = Date.now();
          level.filledBaseAmount = orderDetails.filledInputAmount / Math.pow(10, this.state.baseDecimals);
          logger.info(`Order #${level.orderNum} filled @ $${level.filledPrice.toFixed(6)}`);
        }
      }
    }

    // ── 2. Recalculate totals from filled orders ──
    this.recalculate();

    // ── 3. If we have enough BASE and haven't placed sell, calculate exit ──
    if (this.state.filledCount > 0 && !this.state.sellOrderPlaced) {
      this.state.calculateTargets();
    }

    // ── 4. Place next buy limit order if there's a pending one ──
    if (!this.state.allOrdersFilled && !this.state.emergencyStop) {
      const next = this.state.nextPendingOrder;
      if (next) {
        await this.placeBuyLimit(next);
      }
    }

    // ── 5. If all buys filled (or max reached) and no sell yet, place sell ──
    if (this.state.allOrdersFilled && !this.state.sellOrderPlaced && !this.state.sellFilled) {
      this.state.calculateTargets();
      await this.placeSellLimit();
    }

    // ── 6. Check sell fill ──
    if (this.state.sellFilled) {
      logger.info('✅ Position closed — sell order filled!');
      this.state.emergencyStop = true;
    }

    this.printStatus();
    await this.saveState();
  }

  recalculate() {
    let invested = 0;
    let bought = 0;

    for (const level of this.state.grid) {
      if (level.filledBaseAmount) {
        invested += level.sizeUSDC;
        bought += level.filledBaseAmount;
      }
    }

    this.state.totalInvestedUSDC = Math.round(invested * 100) / 100;
    this.state.totalBaseBought = bought;
    if (bought > 0) {
      this.state.avgEntryPrice = this.state.totalInvestedUSDC / bought;
    }
  }

  async checkOrderStatus(orderId) {
    try {
      const resp = await fetch(`${JUP_LIMIT_V4}/order/${orderId}`);
      if (!resp.ok) return null;
      const data = await resp.json();

      // If state is 'filled' or order not found → it was filled
      if (data.state === 'filled') {
        return { filled: true, filledAvgPrice: data.filledPrice, filledInputAmount: data.filledInputAmount };
      }
      if (resp.status === 404) {
        return { filled: true };
      }

      return { filled: false, state: data.state };
    } catch {
      return null;
    }
  }

  printStatus() {
    const s = this.state;
    logger.info('═'.repeat(72));
    logger.info(`${PAIR} — Entry: ${s.entryPrice ? '$' + s.entryPrice.toFixed(6) : '—'}`);
    logger.info(
      `Orders: ${s.filledCount}/${MAX_ORDERS} filled | ${s.openOrderCount} open on Jupiter | ` +
      `$${s.totalInvestedUSDC.toFixed(2)} invested | ${s.totalBaseBought.toFixed(6)} ${BASE_TOKEN}`
    );
    if (s.exitPrice) {
      logger.info(`Exit: $${s.exitPrice.toFixed(6)} | Extra: +${s.targetExtraBase.toFixed(6)} ${BASE_TOKEN} | Sell: ${s.sellFilled ? '✅ FILLED' : s.sellOrderPlaced ? '🔄 OPEN' : '⏳ NOT PLACED'}`);
    }
    if (s.emergencyStop) logger.info(`🛑 EMERGENCY STOP`);
    logger.info('─'.repeat(72));
    logger.info(
      `  # ` +
      `Size`.padStart(8) +
      `  Drop%` +
      `  Price`.padStart(10) +
      `  Status`
    );
    for (const l of s.grid) {
      const icon =
        l.status === 'filled' ? '✓' :
        l.status === 'open' ? '◌' : '○';
      logger.info(
        `${l.orderNum.toString().padStart(3)} ` +
        `$${l.sizeUSDC.toFixed(2)}`.padStart(8) +
        ` ${l.dropPercent.toFixed(1)}%`.padStart(7) +
        ` $${l.limitPrice.toFixed(6)}`.padStart(13) +
        ` ${icon} ${l.status.toUpperCase()}`
      );
    }
    logger.info('═'.repeat(72));
  }

  sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }
}

// ─── Signals ─────────────────────────────────────────────────────

let bot;
process.on('SIGINT', () => {
  logger.info('SIGINT — saving state...');
  if (bot) bot.saveState().finally(() => process.exit(0));
});
process.on('SIGTERM', () => {
  logger.info('SIGTERM — saving state...');
  if (bot) bot.saveState().finally(() => process.exit(0));
});

bot = new DCABot();
bot.run().catch(e => {
  logger.error(`Fatal: ${e.message}`);
  process.exit(1);
});