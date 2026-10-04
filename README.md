# Solana DCA Trading Bot — v2

Multi-pair pyramiding DCA bot for Solana tokens on **Jupiter** (Trigger limit orders) with Phantom wallet.
**Paper mode by default** — live prices, simulated fills, zero funds at risk.

> v2 (Oct 2026) was a ground-up repair after a verified audit of v1: its Jupiter
> `limit/v4` and `quote/v6` endpoints are dead (Jupiter migrated APIs in 2025),
> its dependencies no longer install, and its take-profit math sold 108% of
> holdings at a price *below* average entry. The v1 code is preserved under
> `src/legacy/`. See [CHANGES-v2](#whats-fixed-in-v2) below.

## Supported Pairs

| Pair | Base Token | Quote | Config File | Risk |
|------|-----------|-------|-------------|------|
| **SOL/USDC** | SOL | USDC | `.env.sol-usdc` | Low |
| **BONK/USDC** | BONK | USDC | `.env.bonk-usdc` | High (meme) |
| **JUP/USDC** | JUP | USDC | `.env.jup-usdc` | Medium |

## Strategy

Buy more as price drops; on recovery, sell **only what is needed** to recover
capital + a USD floor, and **keep the rest as extra base tokens**. Then the
cycle resets at the new market price — profits compound in tokens, not just USD.

### How It Works
1. Cycle opens at market; first order $10 buys immediately
2. Each safety order is 5% larger; next level arms **only after the previous fills** (capital is committed progressively, never fully escrowed up-front)
3. Buys trigger at every 1.33% price drop (limit orders at grid levels)
4. As soon as any tranche is held, a take-profit sell is armed:
   - `TP_MODE=base` (default): sell 92% of holdings at a price recovering **invested + MIN_USD_PROFIT_PERCENT**, keep +8% extra base
   - `TP_MODE=usd`: sell 100% at avg entry × (1 + PROFIT_TARGET%)
5. TP sell re-sizes automatically whenever new buys fill (avg entry improves)
6. On sell fill: realize, **reset cycle** at current price
7. Optional emergency stop (`ENABLE_EMERGENCY_STOP=true`): cancels **all** open orders and liquidates at market — not just a flag

## Quick Start

```bash
npm install

# PAPER mode — no wallet key needed, default:
./run.sh sol-usdc            # or: npm start
./run.sh all                 # all three pairs, paper

# tests (strategy math + deterministic full-lifecycle simulations):
npm test

# LIVE mode when you're confident (Jupiter minimum order $10):
cp .env.sol-usdc .env        # edit .env — add your Phantom private key (base64)
npm start:live               # or: ./run.sh sol-usdc --live
```

## Configuration Options

### Strategy
| Variable | Default | Description |
|----------|---------|-------------|
| INITIAL_ORDER | 10.0 | First order size (USDC) — live min $10 |
| ORDER_MULTIPLIER | 1.05 | Each order 5% larger |
| MAX_SAFETY_ORDERS | 30 | Max DCA levels (sequential arming) |
| PRICE_DROP_PERCENT | 1.33 | Drop % between levels |
| TP_MODE | base | `base` = keep extra tokens; `usd` = sell all |
| PROFIT_TARGET_PERCENT | 8.0 | Extra base % to keep (base mode) / USD profit (usd mode) |
| MIN_USD_PROFIT_PERCENT | 0.5 | USD floor on every closed cycle (base mode) |
| ENABLE_EMERGENCY_STOP | false | Cancel-all + liquidate on deep drop |
| EMERGENCY_STOP_PERCENT | 50.0 | Drawdown from cycle entry that triggers it |

### Trading
| Variable | Default | Description |
|----------|---------|-------------|
| MAX_SLIPPAGE_PERCENT | 1.0 | Slippage on Jupiter orders (bps = %×100) |
| CHECK_INTERVAL_SECONDS | 60 | Tick frequency (canonical name — v1 code silently ignored this and used `CHECK_INTERVAL_MS`) |
| ORDER_TTL_SECONDS | 2592000 | Live order expiry (30 d) |
| MIN_SOL_BALANCE | 0.1 | Min SOL for fees |
| RPC_ENDPOINT | mainnet-beta | Solana RPC |

### Integrations
| Variable | Description |
|----------|-------------|
| PHANTOM_PRIVATE_KEY | base64 secret key (**live only; never commit, never share**) |
| TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID | order/fill/close notifications |
| LOG_LEVEL | info / debug |

## Platform (v2)

All Jupiter REST calls use the **free `lite-api.jup.ag` tier** (verified live):

| Function | Endpoint |
|----------|----------|
| Price | `GET /price/v3?ids=<mint>` |
| Limit orders | `POST /trigger/v1/createOrder` → sign → `POST /trigger/v1/execute` |
| Reconcile | `GET /trigger/v1/getTriggerOrders?user=&orderStatus=` |
| Cancel | `POST /trigger/v1/cancelOrder` + signed withdrawal tx |

No RPC needed except for balance/fee checks and cancel-withdrawal submission.

## Files

```
├── src/
│   ├── bot.js              # v2 orchestration (state machine + persistence)
│   ├── config.js           # single source of truth for env
│   ├── strategy.js         # pure math: grid, TP plan, emergency stop (unit-tested)
│   ├── broker.js           # PaperBroker (sim) + JupiterBroker (live)
│   ├── marketData.js       # price feed w/ stale-cache fallback
│   ├── utils/              # calculateOrders, checkBalance (v2)
│   └── legacy/             # v1 code kept for reference
├── tests/                  # node:test — math regressions + lifecycle sims
├── .env.{sol,bonk,jup}-usdc # per-pair templates
└── run.sh                  # multi-pair runner (paper default)
```

## Safety

- **Paper mode is the default** — running `npm start` cannot move funds
- Live mode refuses to start with missing/placeholder keys or sub-$10 orders
- Take-profit order is sized `min(plan, actual holdings)` — over-selling is
  impossible by construction (regression-tested)
- Emergency stop is actionable: cancels grid + TP, refunds escrow, liquidates
- Dedicated wallet with limited funds only; keep fee SOL above MIN_SOL_BALANCE
- `state/*.json` written every tick — resume after restart

## What's fixed in v2

1. `npm install` worked again (removed `@jup-ag/api@3.x` — off npm — + 3 unused deps)
2. Price feed migrated from dead `quote-api.jup.ag/v6` to `/price/v3` + `/swap/v1`
3. Order engine migrated from the never-existent `jup.ag/api/limit/v4` to Jupiter Trigger v1 (verified live)
4. TP math: sell ≤ holdings (was 108%), exit **above** avg entry (was below), correct fill units (was USDC ÷ SOL-decimals)
5. Partial take-profit: cycle closes on any tranche depth, not only after all 30 fills (v1 effectively never sold)
6. Sequential grid arming: capital committed progressively; unfilled capital stays liquid
7. Emergency stop cancels + liquidates instead of just flagging
8. 404-on-order no longer counted as "filled"; cancelled/expired orders re-arm
9. One canonical env var name per setting; docs match code
10. `telegram-listener.js` paths configurable (was hardcoded to an old Linux server)
11. Test suite: 12 tests, node:test, zero dependencies, incl. oracle-computed lifecycle settlement

## Token Addresses (Mainnet)

| Token | Mint Address | Decimals |
|-------|-------------|----------|
| SOL | So11111111111111111111111111111111111111112 | 9 |
| USDC | EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v | 6 |
| BONK | DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 | 5 |
| JUP | JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN | 6 |

## Adding a New Pair

1. Copy a config: `cp .env.sol-usdc .env.mytoken-usdc`
2. Edit: BASE_MINT, BASE_TOKEN, BASE_DECIMALS, QUOTE_MINT, PAIR_LABEL
3. Run: `PAIR_FILE=.env.mytoken-usdc npm start`

## Disclaimer

This bot is for educational purposes. Crypto trading carries significant risk.
Run paper mode for days, then tiny amounts. Never share your private key.
