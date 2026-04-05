# Solana DCA Trading Bot

Multi-pair pyramiding DCA bot for Solana tokens on Jupiter Exchange with Phantom wallet.

## Supported Pairs

| Pair | Base Token | Quote | Config File | Risk |
|------|-----------|-------|-------------|------|
| **SOL/USDC** | SOL | USDC | `.env.sol-usdc` | Low |
| **BONK/USDC** | BONK | USDC | `.env.bonk-usdc` | High (meme) |
| **JUP/USDC** | JUP | USDC | `.env.jup-usdc` | Medium |

## Strategy

The bot pyramids DCA orders: buy more as price drops, then sell all when price recovers. Instead of chasing USD profit, the goal is to **accumulate extra base tokens** (SOL, BONK, or JUP).

### How It Works
1. First order: $10 USDC at current price
2. Each safety order is 5% larger than the previous
3. Buys trigger at every 1.33% price drop
4. Up to 30 orders (40% max drawdown)
5. Sells all when price recovers to target
6. Profit = extra base tokens kept

### Example: SOL/USDC
- Total investment: ~$664 USDC
- SOL accumulated: ~8.91 SOL
- Target: +8% extra SOL (0.71 SOL)
- Recovery needed from bottom: ~15%

## Quick Start

### 1. Install
```bash
npm install
```

### 2. Configure
Choose a pair and set up:
```bash
cp .env.sol-usdc .env
# Edit .env — add your Phantom private key (base64)
```

### 3. Run
```bash
# Single pair
./run.sh sol-usdc         # live
./run.sh sol-usdc --test  # dry run
./run.sh bonk-usdc
./run.sh jup-usdc

# All pairs at once
./run.sh all
```

Or via npm:
```bash
npm start          # SOL/USDC live
npm start:bonk     # BONK/USDC live
npm start:jup      # JUP/USDC live
npm test           # SOL/USDC dry run
```

## Configuration Options

### Required
| Variable | Example | Description |
|----------|---------|-------------|
| PHANTOM_PRIVATE_KEY | base64... | Wallet private key |
| BASE_MINT | So111... | Base token mint address |
| QUOTE_MINT | EPjFW... | Quote token (USDC) address |
| BASE_TOKEN | SOL | Token symbol for logging |
| BASE_DECIMALS | 9 | Token decimal places |
| PAIR_LABEL | SOL/USDC | Display label |

### Strategy
| Variable | Default | Description |
|----------|---------|-------------|
| INITIAL_ORDER | 10.0 | First order size (USDC) |
| ORDER_MULTIPLIER | 1.05 | Each order 5% larger |
| MAX_SAFETY_ORDERS | 30 | Max DCA orders |
| PRICE_DROP_PERCENT | 1.33 | Drop % between orders |
| PROFIT_TARGET_PERCENT | 8.0 | Extra base token % |
| MAX_DRAWDOWN_PERCENT | 40.0 | Emergency stop threshold |

### Trading
| Variable | Default | Description |
|----------|---------|-------------|
| MAX_SLIPPAGE_PERCENT | 1.0 | Max allowed slippage |
| CHECK_INTERVAL_SECONDS | 60 | Price check frequency |
| MIN_SOL_BALANCE | 0.1 | Min SOL for fees |
| MIN_QUOTE_BALANCE | 50.0 | Min USDC required |

## Token Addresses (Mainnet)

| Token | Mint Address | Decimals |
|-------|-------------|----------|
| SOL | So11111111111111111111111111111111111111112 | 9 |
| USDC | EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v | 6 |
| BONK | DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 | 5 |
| JUP | JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN | 6 |

## Adding a New Pair

1. Copy a config: `cp .env.sol-usdc .env.mytoken-usdc`
2. Edit: set BASE_MINT, BASE_TOKEN, BASE_DECIMALS, QUOTE_MINT, PAIR_LABEL
3. Create a run alias in `run.sh` and `run.sh`

## Files

```
├── src/
│   ├── bot.js              # Main multi-pair DCA bot
│   └── utils/
│       ├── calculateOrders.js  # Strategy calculator
│       └── checkBalance.js     # Wallet checker
├── .env.sol-usdc           # SOL/USDC config
├── .env.bonk-usdc          # BONK/USDC config
├── .env.jup-usdc           # JUP/USDC config
├── run.sh                  # Multi-pair runner
└── package.json
```

## Architecture

The bot is token-agnostic — it reads all parameters from the `.env` file:
- **BASE_MINT/BASE_TOKEN**: The token you want to accumulate
- **QUOTE_MINT**: The stablecoin you trade with (USDC)
- **Jupiter API**: Fetches prices and swap quotes automatically
- **State persistence**: Resume after restart, per-pair state files

## Safety

- Dedicated wallet with limited funds only
- Emergency stop at configurable drawdown
- Balance checks before every trade
- State files in `state/` directory
- Test mode for validation before live trading

## Disclaimer

This bot is for educational purposes. Crypto trading carries significant risk. Always test with small amounts first. Never share your private key.