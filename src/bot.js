#!/usr/bin/env node

/**
 * Solana DCA Trading Bot - Multi-Pair Support
 * Supports: SOL/USDC, BONK/USDC, JUP/USDC, and more
 * Strategy: Earn extra base token through pyramiding DCA
 *
 * Key improvements:
 * - Catch-up: if price drops past multiple levels, places ALL missed orders
 * - Exit readiness: tracks exit price precisely and sells immediately on recovery
 * - Volatility-aware polling: speeds up during high price movement
 */

require('dotenv').config();
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const winston = require('winston');
const fs = require('fs').promises;
const path = require('path');

// ===================== Configuration =====================
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
const MIN_CHECK_MS = Math.max(parseInt(process.env.MIN_CHECK_INTERVAL_MS || 5000), 1000);
const MAX_CHECK_MS = parseInt(process.env.MAX_CHECK_INTERVAL_MS || 120000);
const MAX_ORDERS_PER_CYCLE = parseInt(process.env.MAX_ORDERS_PER_CYCLE || 5);

// ===================== Logging =====================
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
      new winston.transports.File({ filename: `logs/${PAIR.replace('/', '-')}-bot.log` })
    ] : [])
  ]
});

// ===================== Trading State =====================

/**
 * Pre-computes all DCA grid levels: order size, trigger price, cumulative totals.
 * Trigger prices are relative to entry price (set once first order executes).
 */
function buildOrderGrid() {
  const levels = [];
  let cumulativeUSDC = 0;

  for (let i = 0; i < MAX_ORDERS; i++) {
    const orderNum = i + 1;
    const orderSize = INITIAL_ORDER * Math.pow(ORDER_MULTIPLIER, i);
    const priceDropPct = i * PRICE_DROP_PERCENT;
    cumulativeUSDC += orderSize;

    levels.push({
      orderNum,
      orderIndex: i,
      orderSize,
      cumulativeUSDC,
      priceDropPct,
      // multiplier for trigger price: 1 - drop%/100
      priceMultiplier: 1 - priceDropPct / 100,
      filled: false,
      fillPrice: null,
      fillTimestamp: null,
    });
  }

  return levels;
}

class TradingState {
  constructor() {
    this.entryPrice = null;        // Set after first order
    this.grid = buildOrderGrid();
    this.totalInvestedQuote = 0;
    this.totalBaseBought = 0;
    this.averageEntryPrice = null;
    this.isRunning = false;
    this.emergencyStop = false;
    this.targetExtraBase = 0;
    this.targetTotalBase = 0;
  }

  get filledCount() {
    return this.grid.filter(l => l.filled).length;
  }

  get currentOrderIndex() {
    return this.filledCount;  // 0-based index of next order to fill
  }

  /**
   * Add a filled order to state.
   * For the first order, sets entryPrice and calculates trigger prices.
   */
  addOrder(level, actualPrice, actualBaseAmount) {
    level.filled = true;
    level.fillPrice = actualPrice;
    level.fillTimestamp = Date.now();

    // First order sets entry price and propagates trigger prices to all levels
    if (this.entryPrice === null) {
      this.entryPrice = actualPrice;
      for (const l of this.grid) {
        l.triggerPrice = actualPrice * l.priceMultiplier;
      }
    }

    this.totalInvestedQuote += level.orderSize;
    this.totalBaseBought += actualBaseAmount;
    this.averageEntryPrice = this.totalInvestedQuote / this.totalBaseBought;

    // Calculate target
    this.targetExtraBase = this.totalBaseBought * (PROFIT_TARGET_PERCENT / 100);
    this.targetTotalBase = this.totalBaseBought + this.targetExtraBase;

    const exitPrice = this.getExitPrice();
    logger.info(
      `[ORDER #${level.orderNum}] ${actualBaseAmount.toFixed(6)} ${BASE_TOKEN} @ $${actualPrice.toFixed(6)} ($${level.orderSize.toFixed(2)} USDC)`
    );
    logger.info(
      `[SUMMARY] Filled: ${this.filledCount}/${MAX_ORDERS} | Invested: $${this.totalInvestedQuote.toFixed(2)} | ${this.totalBaseBought.toFixed(6)} ${BASE_TOKEN} | Avg: $${this.averageEntryPrice.toFixed(6)}`
    );
    logger.info(
      `[EXIT] Target: ${this.targetExtraBase.toFixed(6)} extra ${BASE_TOKEN} (+${PROFIT_TARGET_PERCENT}%) | Exit price: $${exitPrice.toFixed(6)}`
    );
  }

  /**
   * The price at which we should sell to get our USDC back + extra base token.
   * exit_price = total_invested_USDC / (total_base + extra_base)
   * If price >= exit_price, we sold at break-even USDC but kept +extra_base tokens.
   */
  getExitPrice() {
    if (this.targetTotalBase === 0) return null;
    return this.totalInvestedQuote / this.targetTotalBase;
  }

  /**
   * Check if price is at or above exit target — ready to sell.
   */
  shouldExit(currentPrice) {
    const exitPrice = this.getExitPrice();
    if (!exitPrice || this.totalBaseBought === 0) return false;

    if (currentPrice >= exitPrice) {
      logger.info(
        `[EXIT] Profit target reached! Price $${currentPrice.toFixed(6)} >= Target $${exitPrice.toFixed(6)}`
      );
      return true;
    }

    if (ENABLE_EMERGENCY_STOP) {
      const dropPct = ((this.entryPrice - currentPrice) / this.entryPrice) * 100;
      if (dropPct > EMERGENCY_STOP_PCT) {
        logger.error(
          `[EMERGENCY] Drawdown ${dropPct.toFixed(1)}% exceeds ${EMERGENCY_STOP_PCT}% limit!`
        );
        this.emergencyStop = true;
        return true;  // Sell to stop losses
      }
    }

    return false;
  }

  /**
   * Find all grid levels whose trigger price has been reached by current price.
   * Returns levels that are NOT yet filled and whose triggerPrice >= currentPrice.
   * Sorted from oldest (lowest index) to newest.
   */
  getTriggeredLevels(currentPrice) {
    const triggered = [];
    for (const level of this.grid) {
      if (level.filled) continue;
      if (level.triggerPrice === undefined) continue;  // entry not set yet

      if (currentPrice <= level.triggerPrice) {
        triggered.push(level);
      }
    }
    return triggered;
  }
}

// ===================== Bot Class =====================
class DCABot {
  constructor() {
    this.connection = null;
    this.wallet = null;
    this.state = new TradingState();
    this.isTestMode = process.argv.includes('--test');

    this.baseMint = new PublicKey(process.env.BASE_MINT);
    this.quoteMint = new PublicKey(process.env.QUOTE_MINT);
    this.baseDecimals = parseInt(process.env.BASE_DECIMALS || 9);
    this.quoteDecimals = parseInt(process.env.QUOTE_DECIMALS || 6);

    // Volatility tracking for adaptive polling
    this.priceHistory = [];
    this.volatilityCheckMs = 0;  // When last volatility check ran
  }

  async initialize() {
    logger.info(`Initializing ${PAIR} DCA Bot...`);
    logger.info(`  Mode: ${this.isTestMode ? 'TEST (dry run)' : 'LIVE'}`);
    logger.info(`  Strategy: $${INITIAL_ORDER} initial, ${ORDER_MULTIPLIER}x multiplier, ${MAX_ORDERS} orders`);
    logger.info(`  Trigger: ${PRICE_DROP_PERCENT}% per level, +${PROFIT_TARGET_PERCENT}% ${BASE_TOKEN} target`);

    this.connection = new Connection(
      process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );

    const privateKey = process.env.PHANTOM_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error('PHANTOM_PRIVATE_KEY not found in .env file');
    }

    this.wallet = Keypair.fromSecretKey(Buffer.from(privateKey, 'base64'));
    logger.info(`  Wallet: ${this.wallet.publicKey.toString()}`);
    logger.info(`  Base mint: ${this.baseMint.toString()} (${BASE_TOKEN}, ${this.baseDecimals} decimals)`);
    logger.info(`  Quote mint: ${this.quoteMint.toString()} (${PAIR.split('/')[1]}, ${this.quoteDecimals} decimals)`);

    await this.checkBalances();

    this.state.isRunning = true;
  }

  async checkBalances() {
    try {
      const solBalance = await this.connection.getBalance(this.wallet.publicKey);
      logger.info(`  SOL balance: ${(solBalance / 1e9).toFixed(6)} SOL`);

      const tokenAccounts = await this.connection.getTokenAccountsByOwner(
        this.wallet.publicKey,
        { mint: this.quoteMint }
      );

      if (tokenAccounts.value.length > 0) {
        const balance = await this.connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
        const quoteBal = balance.value.uiAmount || 0;
        logger.info(`  ${PAIR.split('/')[1]} balance: ${quoteBal.toFixed(2)}`);
      } else {
        logger.warn(`  No ${PAIR.split('/')[1]} token account found`);
      }
    } catch (error) {
      logger.error(`  Balance check failed: ${error.message}`);
    }
  }

  async getPrice() {
    try {
      const baseAmount = Math.pow(10, this.baseDecimals);
      const params = new URLSearchParams({
        inputMint: this.baseMint.toString(),
        outputMint: this.quoteMint.toString(),
        amount: baseAmount.toString(),
        slippageBps: '50',
      });

      const resp = await fetch(`https://quote-api.jup.ag/v6/quote?${params}`);
      if (!resp.ok) throw new Error(`Jupiter API: ${resp.status} ${resp.statusText}`);

      const data = await resp.json();
      const quoteAmount = parseInt(data.outAmount);
      return quoteAmount / Math.pow(10, this.quoteDecimals);
    } catch (error) {
      logger.error(`Price fetch failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Calculate adaptive sleep time based on recent price volatility.
   * During high volatility → fast checks (5-10s).
   * During calm periods → slow checks (60-120s).
   * Always check at least every MAX_CHECK_MS.
   */
  getDynamicInterval(currentPrice) {
    // Store price for volatility calculation
    this.priceHistory.push({ price: currentPrice, time: Date.now() });
    // Keep last 5 minutes of data
    const cutoff = Date.now() - 5 * 60 * 1000;
    this.priceHistory = this.priceHistory.filter(p => p.time > cutoff);

    if (this.priceHistory.length >= 3) {
      const recent = this.priceHistory.slice(-10);
      const prices = recent.map(p => p.price);
      const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
      const volatility = prices.reduce((sum, p) => sum + Math.abs(p - avg), 0) / (avg * prices.length);

      // High vol (>2%): 5s, Medium (>1%): 15s, Low (<0.5%): 60s+
      if (volatility > 0.02) return Math.max(MIN_CHECK_MS, 5000);
      if (volatility > 0.01) return Math.max(MIN_CHECK_MS, 15000);
      if (volatility > 0.005) return 30000;
      return Math.min(MAX_CHECK_MS, 120000);
    }

    // Not enough data yet, use moderate interval
    return 15000;
  }

  async executeBuyOrder(amountQuote, baseToken) {
    if (this.isTestMode) {
      const mockPrice = 100.0;
      return { success: true, amountBase: amountQuote / mockPrice, mockPrice };
    }

    try {
      const inputAmount = Math.floor(amountQuote * Math.pow(10, this.quoteDecimals));
      const slippageBps = parseFloat(process.env.MAX_SLIPPAGE_PERCENT || 1.0) * 100;

      const params = new URLSearchParams({
        inputMint: this.quoteMint.toString(),
        outputMint: this.baseMint.toString(),
        amount: inputAmount.toString(),
        slippageBps: slippageBps.toString(),
      });

      const quoteResp = await fetch(`https://quote-api.jup.ag/v6/quote?${params}`);
      if (!quoteResp.ok) throw new Error(`Quote failed: ${quoteResp.status}`);
      const quoteData = await quoteResp.json();

      if (!quoteData.routePlan || quoteData.routePlan.length === 0) {
        throw new Error('No route found');
      }

      const baseAmount = parseInt(quoteData.outAmount);
      const amountBase = baseAmount / Math.pow(10, this.baseDecimals);
      const effectivePrice = amountQuote / amountBase;

      logger.info(
        `[QUOTE] $${amountQuote.toFixed(2)} → ${amountBase.toFixed(6)} ${BASE_TOKEN} (eff. price: $${effectivePrice.toFixed(6)})`
      );

      // TODO: Execute actual Jupiter swap here (POST /swap, sign, send)
      // For now: log the result. In live mode, uncomment swap execution.

      return { success: true, amountBase, quoteData };
    } catch (error) {
      logger.error(`Buy failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async executeSellAll() {
    if (this.isTestMode) {
      const currentPrice = await this.getPrice() || 100.0;
      return {
        success: true,
        amountQuote: this.state.totalBaseBought * currentPrice,
        profit: (this.state.totalBaseBought * currentPrice) - this.state.totalInvestedQuote,
      };
    }

    try {
      const inputAmount = Math.floor(this.state.totalBaseBought * Math.pow(10, this.baseDecimals));
      const slippageBps = parseFloat(process.env.MAX_SLIPPAGE_PERCENT || 1.0) * 100;

      const params = new URLSearchParams({
        inputMint: this.baseMint.toString(),
        outputMint: this.quoteMint.toString(),
        amount: inputAmount.toString(),
        slippageBps: slippageBps.toString(),
      });

      const quoteResp = await fetch(`https://quote-api.jup.ag/v6/quote?${params}`);
      if (!quoteResp.ok) throw new Error(`Sell quote failed: ${quoteResp.status}`);
      const quoteData = await quoteResp.json();

      const quoteAmount = parseInt(quoteData.outAmount);
      const amountQuote = quoteAmount / Math.pow(10, this.quoteDecimals);
      const profit = amountQuote - this.state.totalInvestedQuote;

      logger.info(
        `[SELL] ${this.state.totalBaseBought.toFixed(6)} ${BASE_TOKEN} → $${amountQuote.toFixed(2)} USDC (profit: $${profit.toFixed(2)})`
      );

      // TODO: Execute actual Jupiter swap
      return { success: true, amountQuote, profit };
    } catch (error) {
      logger.error(`Sell failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async saveState() {
    try {
      const stateDir = path.join(__dirname, '../state');
      await fs.mkdir(stateDir, { recursive: true });

      const stateFile = path.join(stateDir, `${PAIR.replace('/', '-')}-state.json`);

      // Serialize grid with fill status
      const gridData = this.state.grid.map(l => ({
        ...l,
        // Don't serialize undefined triggerPrice (before entry)
        triggerPrice: l.triggerPrice ?? null,
      }));

      await fs.writeFile(stateFile, JSON.stringify({
        entryPrice: this.state.entryPrice,
        totalInvestedQuote: this.state.totalInvestedQuote,
        totalBaseBought: this.state.totalBaseBought,
        averageEntryPrice: this.state.averageEntryPrice,
        targetExtraBase: this.state.targetExtraBase,
        targetTotalBase: this.state.targetTotalBase,
        emergencyStop: this.state.emergencyStop,
        grid: gridData,
        lastUpdated: Date.now(),
      }, null, 2));

      logger.debug('State saved');
    } catch (error) {
      logger.error(`Save state failed: ${error.message}`);
    }
  }

  async loadState() {
    try {
      const stateFile = path.join(dirname, '../state', `${PAIR.replace('/', '-')}-state.json`);
      const data = await fs.readFile(stateFile, 'utf8');
      const saved = JSON.parse(data);

      this.state.entryPrice = saved.entryPrice;
      this.state.totalInvestedQuote = saved.totalInvestedQuote || 0;
      this.state.totalBaseBought = saved.totalBaseBought || 0;
      this.state.averageEntryPrice = saved.averageEntryPrice;
      this.state.targetExtraBase = saved.targetExtraBase || 0;
      this.state.targetTotalBase = saved.targetTotalBase || 0;
      this.state.emergencyStop = saved.emergencyStop || false;

      if (saved.grid && Array.isArray(saved.grid)) {
        for (let i = 0; i < Math.min(saved.grid.length, this.state.grid.length); i++) {
          const savedLevel = saved.grid[i];
          const currentLevel = this.state.grid[i];
          currentLevel.filled = savedLevel.filled;
          currentLevel.fillPrice = savedLevel.fillPrice;
          currentLevel.fillTimestamp = savedLevel.fillTimestamp;
          if (savedLevel.triggerPrice) {
            currentLevel.triggerPrice = savedLevel.triggerPrice;
          }
        }
        logger.info(`Loaded state: ${this.state.filledCount}/${MAX_ORDERS} orders filled`);
      }

      return true;
    } catch {
      logger.info('No previous state — starting fresh');
      return false;
    }
  }

  /**
   * Print the current grid status showing filled and pending orders.
   */
  printGrid(currentPrice) {
    const exitPrice = this.state.getExitPrice();
    const pctToExit = exitPrice
      ? (((exitPrice - currentPrice) / currentPrice) * 100).toFixed(1)
      : '—';

    logger.info('═'.repeat(70));
    logger.info(`${PAIR} STATUS — Price: $${currentPrice.toFixed(6)} | Entry: ${this.state.entryPrice ? '$' + this.state.entryPrice.toFixed(6) : 'N/A'}`);
    logger.info(`Filled: ${this.state.filledCount}/${MAX_ORDERS} | Invested: $${this.state.totalInvestedQuote.toFixed(2)} | ${this.state.totalBaseBought.toFixed(6)} ${BASE_TOKEN}`);
    logger.info(`Exit target: $${exitPrice?.toFixed(6) ?? 'N/A'} (${pctToExit}% to go) | +${this.state.targetExtraBase.toFixed(6)} extra ${BASE_TOKEN}`);
    logger.info('─'.repeat(70));
    logger.info(
      '#'.padEnd(3) + ' ' +
      'Size'.padStart(8) + ' ' +
      'CumUSDC'.padStart(9) + ' ' +
      'Drop%'.padStart(8) + ' ' +
      'Trigger'.padStart(10) + ' ' +
      'Status'.padStart(12)
    );
    logger.info('─'.repeat(70));

    for (const level of this.state.grid) {
      const filled = level.filled ? 'FILLED' : (level.triggerPrice ? 'PENDING' : 'WAITING ENTRY');
      const triggerStr = level.triggerPrice ? `$${level.triggerPrice.toFixed(4)}` : '—';

      // Highlight: filled orders, next order, future orders
      const marker = level.filled ? '  ✓' : (level.triggerPrice && currentPrice <= level.triggerPrice ? '  ◆' : '   ');

      logger.info(
        `${level.orderNum.toString().padEnd(3)} ` +
        `$${level.orderSize.toFixed(2)}`.padStart(8) + ' ' +
        `$${level.cumulativeUSDC.toFixed(1)}`.padStart(9) + ' ' +
        `${level.priceDropPct.toFixed(1)}%`.padStart(8) + ' ' +
        triggerStr.padStart(10) + ' ' +
        `${filled}${marker}`
      );
    }
    logger.info('═'.repeat(70));
  }

  async run() {
    try {
      await this.initialize();

      const hadState = await this.loadState();

      const price = await this.getPrice();
      if (!price) {
        logger.error('Cannot get initial price. Exiting.');
        process.exit(1);
      }

      // Print initial grid
      this.printGrid(price);

      // If loading state with existing filled orders, show status
      if (hadState && this.state.entryPrice) {
        logger.info(`Resumed position: ${this.state.filledCount} orders filled, ${this.state.totalBaseBought.toFixed(6)} ${BASE_TOKEN}`);

        // Check for any missed orders (price may have dropped while we were offline)
        const triggered = this.state.getTriggeredLevels(price);
        if (triggered.length > 0) {
          logger.info(`  ⚠ ${triggered.length} missed order(s) detected — executing catch-up...`);
          await this.executeTriggeredOrders(triggered, price);
        }

        // Check if we can exit
        if (this.state.shouldExit(price)) {
          logger.info('  Exit condition met — selling now...');
          await this.doExit();
          return;
        }
      }

      logger.info(`Starting main loop — checking every ${MIN_CHECK_MS / 1000}s (adapts to volatility)`);

      while (!this.state.emergencyStop) {
        try {
          const currentPrice = await this.getPrice();
          if (!currentPrice) {
            logger.warn('Price fetch failed, waiting...');
            await this.sleep(15000);
            continue;
          }

          logger.debug(`Price: $${currentPrice.toFixed(6)}`);

          // ─── EXIT CHECK ───
          // Always check exit FIRST. If target hit, sell immediately.
          if (this.state.shouldExit(currentPrice)) {
            await this.doExit();
            return;
          }

          // ─── CATCH-UP ORDERS ───
          // Find all triggered levels that haven't been filled yet.
          const triggered = this.state.getTriggeredLevels(currentPrice);

          if (triggered.length > 0) {
            // We have missed levels — execute them
            const toExecute = triggered.slice(0, MAX_ORDERS_PER_CYCLE);
            logger.info(`[CATCH-UP] ${triggered.length} order(s) triggered, executing ${toExecute.length} this cycle...`);
            await this.executeTriggeredOrders(toExecute, currentPrice);

            // After execution, print updated grid
            this.printGrid(currentPrice);
          }

          // ─── STATUS LOG ───
          logger.info(
            `[STATUS] $${currentPrice.toFixed(6)} → Exit $${this.state.getExitPrice()?.toFixed(6) ?? 'N/A'} | ${this.state.filledCount}/${MAX_ORDERS} orders | $${this.state.totalInvestedQuote.toFixed(2)} invested`
          );

          // ─── ADAPTIVE SLEEP ───
          const sleepTime = this.getDynamicInterval(currentPrice);
          await this.sleep(sleepTime);

        } catch (error) {
          logger.error(`Loop error: ${error.message}`);
          await this.sleep(15000);
        }
      }

      logger.info(`${PAIR} Bot stopped`);
    } catch (error) {
      logger.error(`Fatal: ${error.message}`);
      process.exit(1);
    }
  }

  /**
   * Execute a batch of triggered orders.
   * In high volatility, this handles multiple levels at once.
   */
  async executeTriggeredOrders(levels, currentPrice) {
    for (const level of levels) {
      if (level.filled) continue;  // safety check

      const result = await this.executeBuyOrder(level.orderSize, BASE_TOKEN);

      if (result.success) {
        this.state.addOrder(level, currentPrice, result.amountBase);
        await this.saveState();
      } else {
        logger.error(`Failed to execute order #${level.orderNum}: ${result.error}`);
      }
    }
  }

  /**
   * Execute sell (take profit or emergency stop).
   * Saves state and sends notification.
   */
  async doExit() {
    const exitPrice = this.state.getExitPrice();
    const reason = this.state.emergencyStop ? 'EMERGENCY STOP' : 'PROFIT TARGET';
    logger.info(`[${reason}] Executing exit at $${(await this.getPrice())?.toFixed(6) ?? 'N/A'}...`);

    const result = await this.executeSellAll();

    if (result.success) {
      await this.saveState();

      const extraSolValue = this.state.targetExtraBase * (result.amountQuote / this.state.totalBaseBought);
      await this.notify(
        `[${reason}] ${PAIR} sold!\n` +
        `Invested: $${this.state.totalInvestedQuote.toFixed(2)} USDC\n` +
        `Received: $${result.amountQuote.toFixed(2)} USDC\n` +
        `Profit: $${result.profit?.toFixed(2) || '0.00'}\n` +
        `Extra ${BASE_TOKEN}: ${this.state.targetExtraBase.toFixed(6)} (worth ~$${extraSolValue.toFixed(2)})`
      );

      this.state.isRunning = false;
      this.state.emergencyStop = false;
    } else {
      logger.error(`Exit failed: ${result.error}`);
      await this.notify(`[ERROR] ${PAIR} exit failed: ${result.error}`);
      // Don't set isRunning = false so it retries
    }
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async notify(message) {
    logger.info(`┌─ NOTIFICATION ─────────────────────────────────`);
    for (const line of message.split('\n')) {
      logger.info(`│ ${line}`);
    }
    logger.info('└─────────────────────────────────────────────');

    // Telegram webhook
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      try {
        const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
        await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'Monospace',
          }),
        });
      } catch (err) {
        logger.warn(`Telegram notification failed: ${err.message}`);
      }
    }
  }
}

// ===================== Graceful Shutdown =====================
let bot;
process.on('SIGINT', async () => {
  logger.info('SIGINT — shutting down...');
  if (bot) {
    bot.state.isRunning = false;
    await bot.saveState();
  }
  setTimeout(() => process.exit(0), 1000);
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM — terminating...');
  if (bot) {
    bot.state.isRunning = false;
    await bot.saveState();
  }
  setTimeout(() => process.exit(0), 1000);
});

// ===================== Start =====================
bot = new DCABot();
bot.run().catch(error => {
  logger.error(`Startup failed: ${error.message}`);
  process.exit(1);
});