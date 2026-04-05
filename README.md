# SOL/USDT DCA Trading Bot for Jupiter Exchange

## 🎯 Strategy Overview
**Pyramiding Dollar Cost Averaging (DCA) bot** for SOL/USDT on Jupiter Exchange with Phantom wallet integration.

### **Two Strategy Options:**

#### **1. SOL Profit Strategy (RECOMMENDED)**
- **Goal**: Earn extra SOL through DCA accumulation
- **Multiplier**: 1.05x (each order 5% larger)
- **Target**: +8% extra SOL
- **Capital**: $664.39 USDT
- **Exit**: Sell at break-even USD price
- **Recovery needed**: 15% from bottom

#### **2. USD Profit Strategy**
- **Goal**: Make 2% USD profit on total investment
- **Multiplier**: 1.10x (each order 10% larger)
- **Target**: +2% USD profit
- **Capital**: $1,644.94 USDT
- **Exit**: Sell at 2% USD profit
- **Recovery needed**: 42.5% from bottom

## 📊 Why SOL Profit Strategy is Better

| Metric | USD Profit | SOL Profit | Advantage |
|--------|------------|------------|-----------|
| Capital | $1,644.94 | $664.39 | **60% less** |
| Max loss | $657.98 | $265.76 | **60% less** |
| Target | +2% USD ($32.90) | +8% SOL (0.7132 SOL) | **3x more value*** |
| Recovery | 42.5% from bottom | 15.0% from bottom | **66% less** |
| Max order | $158.63 | $37.34 | **76% smaller** |

*Value at $150 SOL: 0.7132 SOL = $107.00 vs $32.90 USD

## 🚀 Quick Start

### 1. Prerequisites
```bash
# Install Node.js and npm
sudo apt install nodejs npm

# Install Solana tools
npm install -g @solana/web3.js @project-serum/anchor
```

### 2. Setup Phantom Wallet
1. Install Phantom wallet browser extension
2. Create or import wallet
3. Get your private key (for bot automation)
4. Fund with SOL and USDT

### 3. Clone and Setup
```bash
git clone <repository-url>
cd sol-dca-bot
npm install

# Choose your strategy:
# For SOL Profit (Recommended):
cp .env.sol-profit .env

# For USD Profit:
cp .env.example .env

# Edit .env with your wallet and API keys
```

### 4. Run Bot
```bash
# Test mode (dry run)
npm run test

# Live trading (SOL Profit strategy)
node src/bot_sol_profit.js

# Live trading (USD Profit strategy)
node src/bot.js
```

## 🔧 Configuration

### Environment Variables (`.env`):
```bash
# Phantom Wallet
PHANTOM_PRIVATE_KEY=your_private_key_here
PHANTOM_PUBLIC_KEY=your_public_key_here

# Solana Network
RPC_ENDPOINT=https://api.mainnet-beta.solana.com

# Token Addresses (Solana mainnet)
SOL_MINT=So11111111111111111111111111111111111111112
USDT_MINT=Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB

# Trading Strategy Parameters
INITIAL_ORDER_USDT=10.0
ORDER_MULTIPLIER=1.05          # 1.05 for SOL profit, 1.10 for USD profit
MAX_SAFETY_ORDERS=30
PRICE_DROP_PERCENT=1.33
SOL_PROFIT_TARGET_PERCENT=8.0  # For SOL profit strategy only
TARGET_PROFIT_PERCENT=2.0      # For USD profit strategy only
MAX_DRAWDOWN_PERCENT=40.0

# Trading Settings
MAX_SLIPPAGE_PERCENT=1.0
CHECK_INTERVAL_SECONDS=60
MIN_SOL_BALANCE=0.1
MIN_USDT_BALANCE=50.0

# Safety Features
ENABLE_EMERGENCY_STOP=true
EMERGENCY_STOP_PERCENT=50.0
```

## 🤖 Bot Architecture

### Core Components:
1. **Wallet Manager** - Phantom wallet integration
2. **Price Monitor** - Real-time SOL/USDT price tracking
3. **Order Calculator** - DCA order size calculations
4. **Trade Executor** - Jupiter swap execution
5. **Profit Tracker** - SOL or USD profit tracking
6. **Risk Manager** - Drawdown and position monitoring

### Available Bots:
- **`src/bot.js`** - USD profit strategy (2% USD target)
- **`src/bot_sol_profit.js`** - SOL profit strategy (8% extra SOL target)

## 📈 Expected Performance

### SOL Profit Strategy:
- **Best case**: +0.7132 SOL extra (worth $107 at $150 SOL)
- **Worst case**: -40% USD ($265.76 loss)
- **Recovery needed**: 15% from bottom
- **Capital required**: $664.39 USDT

### USD Profit Strategy:
- **Best case**: +2% USD ($32.90 profit)
- **Worst case**: -40% USD ($657.98 loss)
- **Recovery needed**: 42.5% from bottom
- **Capital required**: $1,644.94 USDT

## ⚠️ Risk Management

### Safety Features:
1. **Balance checks** - Won't trade if insufficient funds
2. **Slippage protection** - Limits price impact
3. **Maximum orders** - Stops at 30 orders (40% drawdown)
4. **Emergency stop** - Sells everything if extreme drop
5. **State persistence** - Resume after restart

### Monitoring:
- Real-time P&L tracking
- Position size monitoring
- Wallet balance alerts
- Price movement alerts

## 🔄 Jupiter Exchange Integration

### Why Jupiter?
1. **Best prices** - Aggregates liquidity from all DEXs
2. **Low fees** - Competitive trading fees
3. **SOL native** - Built on Solana, fast and cheap
4. **API support** - Well-documented API for bots

## 🛡️ Security Considerations

### Wallet Security:
- **Never share** private key
- Use **dedicated wallet** for bot only
- Keep **minimum required funds** in bot wallet
- Regular **backups** of wallet seed phrase

### Bot Security:
- Run in **isolated environment**
- Regular **security updates**
- **Monitor** for unauthorized access
- **Emergency stop** functionality

## 📚 Resources

### Documentation:
- [Jupiter API Docs](https://docs.jup.ag/)
- [Solana Web3.js](https://solana-labs.github.io/solana-web3.js/)
- [Phantom Wallet API](https://docs.phantom.app/)

### Tools:
- [Solana Explorer](https://explorer.solana.com/)
- [Solscan](https://solscan.io/)
- [Jupiter Swap](https://jup.ag/)

## 🆘 Support

### Common Issues:
1. **Insufficient SOL for fees** - Keep at least 0.1 SOL in wallet
2. **Slippage too high** - Adjust slippage tolerance
3. **Network congestion** - Wait or increase priority fee
4. **API rate limits** - Implement request throttling

### Troubleshooting:
```bash
# Check wallet balance
npm run check-balance

# Test swap (small amount)
npm run test-swap 1

# View bot logs
tail -f logs/bot.log
```

## 📄 License
MIT License - Use at your own risk. Cryptocurrency trading involves significant risk.

---

## 📖 Additional Documentation

- [SOL_PROFIT_STRATEGY.md](SOL_PROFIT_STRATEGY.md) - Detailed SOL profit strategy
- [STRATEGY_SUMMARY.md](STRATEGY_SUMMARY.md) - Complete strategy analysis
- [PHANTOM_SETUP.md](PHANTOM_SETUP.md) - Wallet setup guide

**Disclaimer**: This bot is for educational purposes. Always test with small amounts first. Past performance does not guarantee future results.