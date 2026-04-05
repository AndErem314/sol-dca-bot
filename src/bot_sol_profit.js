          logger.debug(`Price: $${currentPrice.toFixed(2)}`);
          
          // Check for new order
          if (this.state.shouldPlaceOrder(currentPrice)) {
            const orderSize = this.state.calculateOrderSize();
            const result = await this.executeBuyOrder(orderSize);
            
            if (result.success) {
              this.state.addOrder(currentPrice, orderSize, result.amountSol);
              await this.saveState();
              
              // Calculate and log target
              const targetExitPrice = this.state.getExitPriceForSolProfit();
              const recoveryNeeded = ((targetExitPrice / (this.state.entryPrice * 0.6)) - 1) * 100;
              
              logger.info(`🎯 Next target: $${targetExitPrice.toFixed(2)} (${recoveryNeeded.toFixed(1)}% recovery from bottom)`);
              
              await this.sendNotification(
                `Order #${this.state.currentOrder}: $${orderSize.toFixed(2)} → ${result.amountSol.toFixed(4)} SOL @ $${currentPrice.toFixed(2)}\n` +
                `Target: $${targetExitPrice.toFixed(2)} for +${this.state.solProfitTargetPercent}% SOL`
              );
            }
          }
          
          // Check exit conditions
          if (this.state.shouldExit(currentPrice)) {
            logger.info('🎯 SOL profit target reached! Executing sell...');
            const sellResult = await this.executeSellOrder();
            
            if (sellResult.success) {
              await this.sendNotification(
                `✅ Position sold!\n` +
                `Profit: $${sellResult.usdProfit?.toFixed(2) || '0.00'} USD\n` +
                `Extra SOL: ${this.state.targetExtraSol.toFixed(4)} worth $${sellResult.extraSolValue?.toFixed(2) || '0.00'}`
              );
              
              this.state.isRunning = false;
              break;
            }
          }
          
          // Show status every 10 minutes
          if (Date.now() % (10 * 60 * 1000) < checkInterval) {
            const targetExitPrice = this.state.getExitPriceForSolProfit();
            const priceToGo = targetExitPrice - currentPrice;
            const percentToGo = (priceToGo / currentPrice) * 100;
            
            logger.info(`Status: $${currentPrice.toFixed(2)} → Target: $${targetExitPrice.toFixed(2)} (${percentToGo.toFixed(1)}% to go)`);
            logger.info(`  Orders: ${this.state.currentOrder}/${process.env.MAX_SAFETY_ORDERS || 30}`);
            logger.info(`  Invested: $${this.state.totalInvestedUsdt.toFixed(2)}`);
            logger.info(`  SOL: ${this.state.totalSolBought.toFixed(4)} (+${this.state.targetExtraSol.toFixed(4)} target)`);
          }
          
          await this.sleep(checkInterval);
          
        } catch (error) {
          logger.error(`Loop error: ${error.message}`);
          await this.sleep(checkInterval);
        }
      }
      
      logger.info('Bot stopped');
      
    } catch (error) {
      logger.error(`Fatal: ${error.message}`);
      process.exit(1);
    }
  }

  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async sendNotification(message) {
    // Telegram/Discord integration here
    logger.info(`Notification: ${message}`);
  }
}

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Shutting down...');
  if (bot && bot.state) {
    bot.state.isRunning = false;
  }
  setTimeout(() => process.exit(0), 1000);
});

process.on('SIGTERM', async () => {
  logger.info('Terminating...');
  if (bot && bot.state) {
    bot.state.isRunning = false;
  }
  setTimeout(() => process.exit(0), 1000);
});

// Run bot
const bot = new SolProfitDCABot();
bot.run().catch(error => {
  logger.error(`Startup failed: ${error.message}`);
  process.exit(1);
});