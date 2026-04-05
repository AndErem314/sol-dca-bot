#!/usr/bin/env node

/**
 * SOL/USDT DCA Trading Bot for Jupiter Exchange
 * Pyramiding strategy with Phantom wallet integration
 */

require('dotenv').config();
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const { Jupiter } = require('@jup-ag/api');
const winston = require('winston');
const fs = require('fs').promises;
const path = require('path');

// Configure logging
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => {
      return `${timestamp} [${level.toUpperCase()}]: ${message}`;
    })
  ),
  transports: [
    new winston.transports.Console(),
    ...(process.env.LOG_TO_FILE === 'true' ? [
      new winston.transports.File({ filename: 'logs/bot.log' })
    ] : [])
  ]
});

// Trading state
class TradingState {
  constructor() {
    this.entryPrice = null;
    this.currentOrder = 0;
    this.ordersPlaced = [];
    this.totalInvested = 0;
    this.totalSolBought = 0;
    this.averageEntryPrice = null;
    this.isRunning = false;
    this.emergencyStop = false;
  }

  addOrder(price, amountUsdt, amountSol) {
    this.ordersPlaced.push({
      order: this.currentOrder,
      price,
      amountUsdt,
      amountSol,
      timestamp: Date.now()
    });
    this.totalInvested += amountUsdt;
    this.totalSolBought += amountSol;
    this.averageEntryPrice = this.totalInvested / this.totalSolBought;
    this.currentOrder++;
    
    logger.info(`Order #${this.currentOrder} placed: $${amountUsdt.toFixed(2)} USDT for ${amountSol.toFixed(4)} SOL @ $${price.toFixed(2)}`);
    logger.info(`Total: $${this.totalInvested.toFixed(2)} invested, ${this.totalSolBought.toFixed(4)} SOL, Avg: $${this.averageEntryPrice.toFixed(2)}`);
  }

  shouldPlaceOrder(currentPrice) {
    if (this.emergencyStop) return false;
    if (this.currentOrder >= parseInt(process.env.MAX_SAFETY_ORDERS)) return false;
    
    // Calculate price drop from entry
    if (!this.entryPrice) {
      this.entryPrice = currentPrice;
      return true; // First order
    }
    
    const priceDrop = ((this.entryPrice - currentPrice) / this.entryPrice) * 100;
    const triggerLevel = (this.currentOrder) * parseFloat(process.env.PRICE_DROP_PERCENT);
    
    return priceDrop >= triggerLevel;
  }

  calculateOrderSize() {
    const initial = parseFloat(process.env.INITIAL_ORDER_USDT);
    const multiplier = parseFloat(process.env.ORDER_MULTIPLIER);
    return initial * Math.pow(multiplier, this.currentOrder);
  }

  shouldExit(currentPrice) {
    if (!this.averageEntryPrice) return false;
    
    // Check for profit target
    const profitPercent = ((currentPrice - this.averageEntryPrice) / this.averageEntryPrice) * 100;
    if (profitPercent >= parseFloat(process.env.TARGET_PROFIT_PERCENT)) {
      logger.info(`Profit target reached: ${profitPercent.toFixed(2)}%`);
      return true;
    }
    
    // Check for emergency stop
    if (process.env.ENABLE_EMERGENCY_STOP === 'true') {
      const drawdown = ((this.entryPrice - currentPrice) / this.entryPrice) * 100;
      if (drawdown >= parseFloat(process.env.EMERGENCY_STOP_PERCENT)) {
        logger.warn(`Emergency stop triggered: ${drawdown.toFixed(2)}% drawdown`);
        this.emergencyStop = true;
        return true;
      }
    }
    
    return false;
  }
}

class DCABot {
  constructor() {
    this.connection = null;
    this.wallet = null;
    this.jupiter = null;
    this.state = new TradingState();
    this.isTestMode = process.argv.includes('--test');
  }

  async initialize() {
    logger.info('Initializing DCA Bot...');
    
    // Initialize Solana connection
    this.connection = new Connection(
      process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );
    
    // Initialize wallet
    const privateKey = process.env.PHANTOM_PRIVATE_KEY;
    if (!privateKey) {
      throw new Error('PHANTOM_PRIVATE_KEY not found in .env file');
    }
    
    this.wallet = Keypair.fromSecretKey(
      Buffer.from(privateKey, 'base64')
    );
    
    logger.info(`Wallet initialized: ${this.wallet.publicKey.toString()}`);
    
    // Initialize Jupiter
    this.jupiter = await Jupiter.load({
      connection: this.connection,
      wallet: this.wallet.publicKey,
      cluster: 'mainnet-beta',
    });
    
    logger.info('Jupiter API initialized');
    
    // Check balances
    await this.checkBalances();
    
    this.state.isRunning = true;
    logger.info('DCA Bot initialized successfully');
  }

  async checkBalances() {
    try {
      const solBalance = await this.connection.getBalance(this.wallet.publicKey);
      const solBalanceSol = solBalance / 1e9;
      
      logger.info(`Wallet balance: ${solBalanceSol.toFixed(4)} SOL`);
      
      if (solBalanceSol < parseFloat(process.env.MIN_SOL_BALANCE || 0.1)) {
        logger.warn(`Low SOL balance: ${solBalanceSol.toFixed(4)} SOL. Minimum recommended: ${process.env.MIN_SOL_BALANCE || 0.1} SOL`);
      }
      
      return solBalanceSol;
    } catch (error) {
      logger.error(`Error checking balances: ${error.message}`);
      throw error;
    }
  }

  async getSolPrice() {
    try {
      // Get SOL/USDT price from Jupiter
      const routes = await this.jupiter.computeRoutes({
        inputMint: new PublicKey(process.env.USDT_MINT),
        outputMint: new PublicKey(process.env.SOL_MINT),
        inputAmount: 1000000, // 1 USDT (6 decimals)
        slippageBps: 50, // 0.5% slippage for price check
      });
      
      if (!routes.routesInfos || routes.routesInfos.length === 0) {
        throw new Error('No routes found for SOL/USDT');
      }
      
      const bestRoute = routes.routesInfos[0];
      const price = 1 / (bestRoute.outAmount / 1e9); // Price per SOL in USDT
      
      return price;
    } catch (error) {
      logger.error(`Error getting SOL price: ${error.message}`);
      // Fallback to simple price check
      return await this.getSimplePrice();
    }
  }

  async getSimplePrice() {
    // Simple price check using Jupiter quote API
    try {
      const response = await fetch(
        `https://quote-api.jup.ag/v6/quote?inputMint=${process.env.USDT_MINT}&outputMint=${process.env.SOL_MINT}&amount=1000000&slippageBps=50`
      );
      const data = await response.json();
      return 1 / (data.outAmount / 1e9);
    } catch (error) {
      logger.error(`Fallback price check failed: ${error.message}`);
      return null;
    }
  }

  async executeBuyOrder(amountUsdt) {
    if (this.isTestMode) {
      logger.info(`[TEST] Would buy $${amountUsdt.toFixed(2)} USDT of SOL`);
      return { success: true, amountSol: amountUsdt / 100 }; // Mock
    }
    
    try {
      const inputAmount = Math.floor(amountUsdt * 1e6); // USDT has 6 decimals
      
      const routes = await this.jupiter.computeRoutes({
        inputMint: new PublicKey(process.env.USDT_MINT),
        outputMint: new PublicKey(process.env.SOL_MINT),
        inputAmount,
        slippageBps: parseFloat(process.env.MAX_SLIPPAGE_PERCENT || 1.0) * 100,
      });
      
      if (!routes.routesInfos || routes.routesInfos.length === 0) {
        throw new Error('No routes available for swap');
      }
      
      const { execute } = await this.jupiter.exchange({
        route: routes.routesInfos[0],
      });
      
      const swapResult = await execute();
      
      if (swapResult.error) {
        throw new Error(`Swap failed: ${swapResult.error}`);
      }
      
      const amountSol = swapResult.outputAmount / 1e9;
      logger.info(`Swap executed: $${amountUsdt.toFixed(2)} USDT -> ${amountSol.toFixed(4)} SOL`);
      
      return {
        success: true,
        amountSol,
        txId: swapResult.txid
      };
    } catch (error) {
      logger.error(`Error executing buy order: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async executeSellOrder() {
    if (this.isTestMode) {
      const currentPrice = await this.getSolPrice();
      const totalValue = this.state.totalSolBought * currentPrice;
      logger.info(`[TEST] Would sell ${this.state.totalSolBought.toFixed(4)} SOL for ~$${totalValue.toFixed(2)} USDT`);
      return { success: true };
    }
    
    try {
      const inputAmount = Math.floor(this.state.totalSolBought * 1e9); // SOL has 9 decimals
      
      const routes = await this.jupiter.computeRoutes({
        inputMint: new PublicKey(process.env.SOL_MINT),
        outputMint: new PublicKey(process.env.USDT_MINT),
        inputAmount,
        slippageBps: parseFloat(process.env.MAX_SLIPPAGE_PERCENT || 1.0) * 100,
      });
      
      if (!routes.routesInfos || routes.routesInfos.length === 0) {
        throw new Error('No routes available for sell');
      }
      
      const { execute } = await this.jupiter.exchange({
        route: routes.routesInfos[0],
      });
      
      const swapResult = await execute();
      
      if (swapResult.error) {
        throw new Error(`Sell failed: ${swapResult.error}`);
      }
      
      const amountUsdt = swapResult.outputAmount / 1e6;
      logger.info(`Sold ${this.state.totalSolBought.toFixed(4)} SOL for $${amountUsdt.toFixed(2)} USDT`);
      
      return {
        success: true,
        amountUsdt,
        txId: swapResult.txid
      };
    } catch (error) {
      logger.error(`Error executing sell order: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async saveState() {
    try {
      const stateFile = path.join(__dirname, '../state/trading-state.json');
      const stateData = {
        entryPrice: this.state.entryPrice,
        currentOrder: this.state.currentOrder,
        ordersPlaced: this.state.ordersPlaced,
        totalInvested: this.state.totalInvested,
        totalSolBought: this.state.totalSolBought,
        averageEntryPrice: this.state.averageEntryPrice,
        lastUpdated: Date.now()
      };
      
      await fs.mkdir(path.dirname(stateFile), { recursive: true });
      await fs.writeFile(stateFile, JSON.stringify(stateData, null, 2));
      logger.debug('Trading state saved');
    } catch (error) {
      logger.error(`Error saving state: ${error.message}`);
    }
  }

  async loadState() {
    try {
      const stateFile = path.join(__dirname, '../state/trading-state.json');
      const data = await fs.readFile(stateFile, 'utf8');
      const stateData = JSON.parse(data);
      
      this.state.entryPrice = stateData.entryPrice;
      this.state.currentOrder = stateData.currentOrder;
      this.state.ordersPlaced = stateData.ordersPlaced;
      this.state.totalInvested = stateData.totalInvested;
      this.state.totalSolBought = stateData.totalSolBought;
      this.state.averageEntryPrice = stateData.averageEntryPrice;
      
      logger.info(`Loaded state: ${this.state.currentOrder} orders placed, $${this.state.totalInvested.toFixed(2)} invested`);
    } catch (error) {
      logger.info('No previous state found, starting fresh');
    }
  }

  async run() {
    try {
      await this.initialize();
      await this.loadState();
      
      logger.info('Starting DCA bot main loop...');
      logger.info(`Strategy: ${process.env.INITIAL_ORDER_USDT} USDT initial, ${process.env.ORDER_MULTIPLIER}x multiplier`);
      logger.info(`Target: ${process.env.TARGET_PROFIT_PERCENT}% profit, Max drawdown: ${process.env.MAX_DRAWDOWN_PERCENT}%`);
      
      const checkInterval = parseInt(process.env.CHECK_INTERVAL_SECONDS || 60) * 1000;
      
      while (this.state.isRunning && !this.state.emergencyStop) {
        try {
          // Get current price
          const currentPrice = await this.getSolPrice();
          if (!currentPrice) {
            logger.warn('Failed to get price, retrying...');
            await new Promise(resolve => setTimeout(resolve, checkInterval));
            continue;
          }
          
          logger.debug(`Current SOL price: $${currentPrice.toFixed(2)}`);
          
          // Check if we should place an order
          if (this.state.shouldPlaceOrder(currentPrice)) {
            const orderSize = this.state.calculateOrderSize();
            const result = await this.executeBuyOrder(orderSize);
            
            if (result.success) {
              this.state.addOrder(currentPrice, orderSize, result.amountSol);
              await this.saveState();
              
              // Send notification if configured
              await this.sendNotification(`Order #${this.state.currentOrder} placed: $${orderSize.toFixed(2)} for ${result.amountSol.toFixed(4)} SOL @ $${currentPrice.toFixed(2)}`);
            }
          }
          
          // Check if we should exit
          if (this.state.shouldExit(currentPrice)) {
            logger.info('Exit conditions met, selling position...');
            const sellResult = await this.executeSellOrder();
            
            if (sellResult.success) {
              const profit = sellResult.amountUsdt - this.state.totalInvested;
              const profitPercent = (profit / this.state.totalInvested) * 100;
              
              logger.info(`Position sold. Profit: $${profit.toFixed(2)} (${profitPercent.toFixed(2)}%)`);
              await this.sendNotification(`Position sold: $${profit.toFixed(2)} profit (${profitPercent.toFixed(2)}%)`);
              
              this.state.isRunning = false;
              break;
            }
          }
          
          // Wait for next check
          await new Promise(resolve => setTimeout(resolve, checkInterval));
          
        } catch (error) {
          logger.error(`Error in main loop: ${error.message}`);
          await new Promise(resolve => setTimeout(resolve, checkInterval));
        }
      }
      
      logger.info('DCA bot stopped');
      
    } catch (error) {
      logger.error(`Fatal error: ${error.message}`);
      process.exit(1);
    }
  }

  async sendNotification(message) {
    // Implement Telegram/Discord notifications if configured
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
      // Telegram notification implementation
    }
    logger.info(`Notification: ${message}`);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  if (bot && bot.state) {
    bot.state.isRunning = false;
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  if (bot && bot.state) {
    bot.state.isRunning = false;
  }
  process.exit(0);
});

// Run the bot
const bot = new DCABot();
bot.run().catch(error => {
  logger.error(`Bot failed to start: ${error.message}`);
  process.exit(1);
});