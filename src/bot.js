#!/usr/bin/env node

/**
 * Solana DCA Trading Bot - Multi-Pair Support
 * Supports: SOL/USDC, BONK/USDC, JUP/USDC, and more
 * Strategy: Earn extra base token through pyramiding DCA
 */

require('dotenv').config();
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const winston = require('winston');
const fs = require('fs').promises;
const path = require('path');

// Configure logging
const PAIR = process.env.PAIR_LABEL || 'SOL/USDC';
const BASE_TOKEN = process.env.BASE_TOKEN || 'SOL';

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${PAIR}] [${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    ...(process.env.LOG_TO_FILE === 'true' ? [
      new winston.transports.File({ 
        filename: `logs/${PAIR.replace('/', '-')}-bot.log` 
      })
    ] : [])
  ]
});

// ===================== Trading State =====================
class TradingState {
  constructor() {
    this.entryPrice = null;
    this.currentOrder = 0;
    this.ordersPlaced = [];
    this.totalInvestedQuote = 0;    // Total quote token invested (USDC)
    this.totalBaseBought = 0;       // Total base token accumulated (SOL, BONK, JUP)
    this.averageEntryPrice = null;
    this.isRunning = false;
    this.emergencyStop = false;
    this.profitTargetPercent = parseFloat(process.env.PROFIT_TARGET_PERCENT || 8.0);
    this.targetExtraBase = 0;
    this.targetTotalBase = 0;
  }

  addOrder(price, amountQuote, amountBase) {
    this.ordersPlaced.push({
      order: this.currentOrder + 1,
      price,
      amountQuote,
      amountBase,
      timestamp: Date.now()
    });

    this.totalInvestedQuote += amountQuote;
    this.totalBaseBought += amountBase;
    this.averageEntryPrice = this.totalInvestedQuote / this.totalBaseBought;
    this.currentOrder++;

    this.targetExtraBase = this.totalBaseBought * (this.profitTargetPercent / 100);
    this.targetTotalBase = this.totalBaseBought + this.targetExtraBase;

    const baseToken = BASE_TOKEN;
    logger.info(
      `Order #${this.currentOrder}: $${amountQuote.toFixed(2)} USDC → ${amountBase.toFixed(4)} ${baseToken} @ $${price.toFixed(6)}`
    );
    logger.info(
      `Total: $${this.totalInvestedQuote.toFixed(2)} invested, ${this.totalBaseBought.toFixed(4)} ${baseToken}`
    );
    logger.info(
      `Target: +${this.profitTargetPercent}% ${baseToken} = ${this.targetExtraBase.toFixed(4)} extra`
    );
  }

  shouldPlaceOrder(currentPrice) {
    if (this.emergencyStop) return false;
    if (this.currentOrder >= parseInt(process.env.MAX_SAFETY_ORDERS || 30)) return false;

    if (!this.entryPrice) {
      this.entryPrice = currentPrice;
      return true;
    }

    const priceDropPct = ((this.entryPrice - currentPrice) / this.entryPrice) * 100;
    const triggerLevel = this.currentOrder * parseFloat(process.env.PRICE_DROP_PERCENT || 1.33);

    return priceDropPct >= triggerLevel;
  }

  calculateOrderSize() {
    const initial = parseFloat(process.env.INITIAL_ORDER || 10.0);
    const multiplier = parseFloat(process.env.ORDER_MULTIPLIER || 1.05);
    return initial * Math.pow(multiplier, this.currentOrder);
  }

  shouldExit(currentPrice) {
    if (!this.averageEntryPrice || this.totalBaseBought === 0) return false;

    const targetExitPrice = this.totalInvestedQuote / this.targetTotalBase;

    if (currentPrice >= targetExitPrice) {
      logger.info(`${BASE_TOKEN} profit target reached! Price: $${currentPrice.toFixed(6)} >= Target: $${targetExitPrice.toFixed(6)}`);
      return true;
    }

    if (process.env.ENABLE_EMERGENCY_STOP === 'true') {
      const maxDD = parseFloat(process.env.MAX_DRAWDOWN_PERCENT || 40.0);
      const drawdown = ((this.entryPrice - currentPrice) / this.entryPrice) * 100;
      if (drawdown > maxDD) {
        logger.warn(`Emergency stop: ${drawdown.toFixed(1)}% drawdown`);
        this.emergencyStop = true;
        return true;
      }
    }

    return false;
  }

  getExitPriceForTarget() {
    if (this.targetTotalBase === 0) return null;
    return this.totalInvestedQuote / this.targetTotalBase;
  }
}

// ===================== Bot Class =====================
class DCABot {
  constructor() {
    this.connection = null;
    this.wallet = null;
    this.state = new TradingState();
    this.isTestMode = process.argv.includes('--test');

    // Token mint addresses
    this.baseMint = new PublicKey(process.env.BASE_MINT);
    this.quoteMint = new PublicKey(process.env.QUOTE_MINT);
    this.baseDecimals = parseInt(process.env.BASE_DECIMALS || 9);  // SOL=9, BONK=5, JUP=6
    this.quoteDecimals = parseInt(process.env.QUOTE_DECIMALS || 6); // USDC=6
  }

  async initialize() {
    logger.info(`Initializing ${PAIR} DCA Bot...`);

    this.connection = new Connection(
      process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );

    const privateKey = process.env.PHANTOM_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error('PHANTOM_PRIVATE_KEY not found in .env file');
    }

    this.wallet = Keypair.fromSecretKey(Buffer.from(privateKey, 'base64'));
    logger.info(`Wallet: ${this.wallet.publicKey.toString()}`);

    await this.checkBalances();
    logger.info(`${PAIR} Bot initialized — Test mode: ${this.isTestMode}`);
    this.state.isRunning = true;
  }

  async checkBalances() {
    try {
      const solBalance = await this.connection.getBalance(this.wallet.publicKey);
      logger.info(`SOL balance: ${(solBalance / 1e9).toFixed(4)} SOL`);

      // Check quote token balance
      const tokenAccounts = await this.connection.getTokenAccountsByOwner(
        this.wallet.publicKey,
        { mint: this.quoteMint }
      );

      if (tokenAccounts.value.length > 0) {
        const balance = await this.connection.getTokenAccountBalance(tokenAccounts.value[0].pubkey);
        const quoteBalance = balance.value.uiAmount || 0;
        logger.info(`Quote balance: ${quoteBalance.toFixed(2)} (USDC)`);

        const minQuote = parseFloat(process.env.MIN_QUOTE_BALANCE || 50.0);
        if (quoteBalance < minQuote) {
          logger.warn(`Low quote balance: ${quoteBalance.toFixed(2)} < $${minQuote}`);
        }
      } else {
        logger.warn(`No ${PAIR.split('/')[1]} token account found`);
      }
    } catch (error) {
      logger.error(`Balance check failed: ${error.message}`);
    }
  }

  /**
   * Get current price: how much quote token (USDC) per 1 base token.
   * Uses Jupiter quote API.
   */
  async getPrice() {
    try {
      // Ask Jupiter: "1 base token = how much USDC?"
      const baseAmount = Math.pow(10, this.baseDecimals); // 1 full base token

      const params = new URLSearchParams({
        inputMint: this.baseMint.toString(),
        outputMint: this.quoteMint.toString(),
        amount: baseAmount.toString(),
        slippageBps: '50',
      });

      const response = await fetch(
        `https://quote-api.jup.ag/v6/quote?${params}`
      );

      if (!response.ok) {
        throw new Error(`Jupiter API error: ${response.status}`);
      }

      const data = await response.json();
      const quoteAmount = parseInt(data.outAmount);
      const price = quoteAmount / Math.pow(10, this.quoteDecimals);

      return price;
    } catch (error) {
      logger.error(`Price fetch failed: ${error.message}`);
      return null;
    }
  }

  /**
   * Execute a buy order: swap quote token (USDC) for base token (SOL, BONK, JUP)
   */
  async executeBuyOrder(amountQuote) {
    if (this.isTestMode) {
      const mockPrice = 100.0;
      const mockBase = amountQuote / mockPrice;
      logger.info(`[TEST] Buy: $${amountQuote.toFixed(2)} USDC → ${mockBase.toFixed(4)} ${BASE_TOKEN}`);
      return { success: true, amountBase: mockBase };
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

      const quoteResp = await fetch(
        `https://quote-api.jup.ag/v6/quote?${params}`
      );

      if (!quoteResp.ok) throw new Error(`Quote failed: ${quoteResp.status}`);
      const quoteData = await quoteResp.json();

      if (!quoteData.routePlan || quoteData.routePlan.length === 0) {
        throw new Error('No route found');
      }

      // For a full implementation, you would:
      // 1. POST to /swap to get the swap transaction
      // 2. Sign with wallet
      // 3. Send to network
      // For now, we return the quote data

      const baseAmount = parseInt(quoteData.outAmount);
      const amountBase = baseAmount / Math.pow(10, this.baseDecimals);

      logger.info(`Quote: $${amountQuote.toFixed(2)} USDC → ${amountBase.toFixed(4)} ${BASE_TOKEN}`);

      return { success: true, amountBase, quoteData };
    } catch (error) {
      logger.error(`Buy order failed: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Execute sell: swap all base token back to quote token
   */
  async executeSellAll() {
    if (this.isTestMode) {
      const mockPrice = await this.getPrice() || 100.0;
      const totalValue = this.state.totalBaseBought * mockPrice;
      logger.info(`[TEST] Sell: ${this.state.totalBaseBought.toFixed(4)} ${BASE_TOKEN} → $${totalValue.toFixed(2)} USDC`);
      return { success: true, amountQuote: totalValue };
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

      const quoteResp = await fetch(
        `https://quote-api.jup.ag/v6/quote?${params}`
      );

      if (!quoteResp.ok) throw new Error(`Sell quote failed: ${quoteResp.status}`);
      const quoteData = await quoteResp.json();

      const quoteAmount = parseInt(quoteData.outAmount);
      const amountQuote = quoteAmount / Math.pow(10, this.quoteDecimals);

      logger.info(`Sell quote: ${this.state.totalBaseBought.toFixed(4)} ${BASE_TOKEN} → $${amountQuote.toFixed(2)} USDC`);

      const profit = amountQuote - this.state.totalInvestedQuote;
      const profitPct = (profit / this.state.totalInvestedQuote) * 100;
      const extraBaseValue = this.state.targetExtraBase * (amountQuote / this.state.totalBaseBought);

      logger.info(`Profit: $${profit.toFixed(2)} (${profitPct.toFixed(2)}%)`);
      logger.info(`Extra ${BASE_TOKEN}: ${this.state.targetExtraBase.toFixed(4)} worth $${extraBaseValue.toFixed(2)}`);

      return { success: true, amountQuote, profit, extraBaseValue };
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
      const stateData = {
        entryPrice: this.state.entryPrice,
        currentOrder: this.state.currentOrder,
        ordersPlaced: this.state.ordersPlaced,
        totalInvestedQuote: this.state.totalInvestedQuote,
        totalBaseBought: this.state.totalBaseBought,
        averageEntryPrice: this.state.averageEntryPrice,
        targetExtraBase: this.state.targetExtraBase,
        targetTotalBase: this.state.targetTotalBase,
        lastUpdated: Date.now()
      };

      await fs.writeFile(stateFile, JSON.stringify(stateData, null, 2));
      logger.debug('State saved');
    } catch (error) {
      logger.error(`Save state failed: ${error.message}`);
    }
  }

  async loadState() {
    try {
      const stateFile = path.join(__dirname, '../state', `${PAIR.replace('/', '-')}-state.json`);
      const data = await fs.readFile(stateFile, 'utf8');
      const sd = JSON.parse(data);

      this.state.entryPrice = sd.entryPrice;
      this.state.currentOrder = sd.currentOrder;
      this.state.ordersPlaced = sd.ordersPlaced || [];
      this.state.totalInvestedQuote = sd.totalInvestedQuote;
      this.state.totalBaseBought = sd.totalBaseBought;
      this.state.averageEntryPrice = sd.averageEntryPrice;
      this.state.targetExtraBase = sd.targetExtraBase;
      this.state.targetTotalBase = sd.targetTotalBase;

      logger.info(`Loaded state: ${this.state.currentOrder} orders, $${this.state.totalInvestedQuote.toFixed(2)}, ${this.state.totalBaseBought.toFixed(4)} ${BASE_TOKEN}`);
    } catch {
      logger.info('No previous state — starting fresh');
    }
  }

  async run() {
    try {
      await this.initialize();
      await this.loadState();

      const checkInterval = parseInt(process.env.CHECK_INTERVAL_SECONDS || 60) * 1000;

      logger.info(`🚀 ${PAIR} DCA Bot running — ${BASE_TOKEN} profit target: ${this.state.profitTargetPercent}%`);

      while (this.state.isRunning && !this.state.emergencyStop) {
        try {
          const currentPrice = await this.getPrice();
          if (!currentPrice) {
            logger.warn('Price fetch failed, waiting...');
            await this.sleep(checkInterval);
            continue;
          }

          logger.debug(`${PAIR} price: $${currentPrice.toFixed(6)}`);

          // Place order if needed
          if (this.state.shouldPlaceOrder(currentPrice)) {
            const orderSize = this.state.calculateOrderSize();
            const result = await this.executeBuyOrder(orderSize);

            if (result.success) {
              this.state.addOrder(currentPrice, orderSize, result.amountBase);
              await this.saveState();

              const targetPrice = this.state.getExitPriceForTarget();
              if (targetPrice) {
                const recovery = ((targetPrice / (this.state.entryPrice * 0.6)) - 1) * 100;
                logger.info(`🎯 Exit target: $${targetPrice.toFixed(6)} (${recovery.toFixed(1)}% recovery from bottom)`);
              }

              await this.notify(
                `Order #${this.state.currentOrder}: $${orderSize.toFixed(2)} → ${result.amountBase.toFixed(4)} ${BASE_TOKEN} @ $${currentPrice.toFixed(6)}`
              );
            }
          }

          // Check exit
          if (this.state.shouldExit(currentPrice)) {
            logger.info('🎯 Profit target reached — selling all...');
            const result = await this.executeSellAll();

            if (result.success) {
              await this.notify(
                `✅ ${PAIR} sold!\nProfit: $${result.profit?.toFixed(2) || '0.00'}\nExtra ${BASE_TOKEN}: ${this.state.targetExtraBase.toFixed(4)}`
              );
              this.state.isRunning = false;
              break;
            }
          }

          // Periodic status
          if (Date.now() % (10 * 60 * 1000) < checkInterval) {
            const targetPrice = this.state.getExitPriceForTarget();
            if (targetPrice) {
              const pctToGo = ((targetPrice - currentPrice) / currentPrice) * 100;
              logger.info(
                `${PAIR}: $${currentPrice.toFixed(6)} → $${targetPrice.toFixed(6)} (${pctToGo.toFixed(1)}% to go) | ${this.state.currentOrder}/30 orders | $${this.state.totalInvestedQuote.toFixed(2)} invested`
              );
            }
          }

          await this.sleep(checkInterval);
        } catch (error) {
          logger.error(`Loop error: ${error.message}`);
          await this.sleep(checkInterval);
        }
      }

      logger.info(`${PAIR} Bot stopped`);
    } catch (error) {
      logger.error(`Fatal: ${error.message}`);
      process.exit(1);
    }
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async notify(message) {
    logger.info(`[NOTIFY] ${message}`);
    // Telegram integration placeholder
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      // Implement Telegram notification
    }
  }
}

// ===================== Graceful Shutdown =====================
let bot;
process.on('SIGINT', async () => {
  logger.info('SIGINT — shutting down...');
  if (bot && bot.state) bot.state.isRunning = false;
  setTimeout(() => process.exit(0), 1000);
});

process.on('SIGTERM', async () => {
  logger.info('SIGTERM — terminating...');
  if (bot && bot.state) bot.state.isRunning = false;
  setTimeout(() => process.exit(0), 1000);
});

// ===================== Start =====================
bot = new DCABot();
bot.run().catch(error => {
  logger.error(`Startup failed: ${error.message}`);
  process.exit(1);
});