#!/usr/bin/env node
/**
 * Single source of truth for configuration.
 * Reads PAIR_FILE (a specific env file) or falls back to `.env`.
 *
 * Fix vs. old bot.js: README said CHECK_INTERVAL_SECONDS but code read
 * CHECK_INTERVAL_MS. One canonical name here, with compat for old files.
 */
require('dotenv').config({ path: process.env.PAIR_FILE || '.env' });

function num(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = parseFloat(raw);
  if (Number.isNaN(v)) {
    throw new Error(`Config error: ${name}="${raw}" is not a number`);
  }
  return v;
}

function bool(name, def = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  return raw === 'true';
}

const intervalSeconds =
  process.env.CHECK_INTERVAL_SECONDS !== undefined
    ? num('CHECK_INTERVAL_SECONDS', 60)
    : num('CHECK_INTERVAL_MS', 60000) / 1000;

const config = {
  // Environment / mode
  isPaper:
    process.argv.includes('--paper') || process.env.PAPER_MODE === 'true',
  isTest: process.argv.includes('--test'),

  // Simulated market data for deterministic lifecycle tests (paper only)
  simPriceFile: process.env.SIM_PRICE_FILE || null,
  simTickMs: num('SIM_TICK_MS', 300),

  // Pair
  pairLabel: process.env.PAIR_LABEL || 'SOL/USDC',
  baseToken: process.env.BASE_TOKEN || 'SOL',
  baseMint: process.env.BASE_MINT || null,
  quoteMint: process.env.QUOTE_MINT || null,
  baseDecimals: num('BASE_DECIMALS', 9),
  quoteDecimals: num('QUOTE_DECIMALS', 6),

  // Strategy grid
  initialOrder: num('INITIAL_ORDER', 10.0),
  orderMultiplier: num('ORDER_MULTIPLIER', 1.05),
  maxOrders: num('MAX_SAFETY_ORDERS', 30),
  priceDropPercent: num('PRICE_DROP_PERCENT', 1.33),
  profitTargetPercent: num('PROFIT_TARGET_PERCENT', 8.0),
  maxDrawdownPercent: num('MAX_DRAWDOWN_PERCENT', 40.0),
  emergencyStopEnabled: bool('ENABLE_EMERGENCY_STOP', false),
  emergencyStopPercent: num('EMERGENCY_STOP_PERCENT', 50.0),

  // Trading / risk
  slippageBps: Math.round(num('MAX_SLIPPAGE_PERCENT', 1.0) * 100),
  intervalSeconds,
  minBaseForFees: num('MIN_SOL_BALANCE', 0.1),
  orderTtlSeconds: num('ORDER_TTL_SECONDS', 30 * 24 * 3600), // live orders expire in 30d
  // 'base' = keep +N% extra base token, recover capital+floor in USD; 'usd' = sell all at +N%
  tpMode: () => (process.env.TP_MODE === 'usd' ? 'usd' : 'base'),
  minUsdProfitPct: () => num('MIN_USD_PROFIT_PERCENT', 0.5),
  // Emergency stop read live (runtime-tunable + test-injectable):
  emergencyStopEnabled: () => process.env.ENABLE_EMERGENCY_STOP === 'true',
  emergencyStopPercent: () => num('EMERGENCY_STOP_PERCENT', 50.0),
  // Paper mode simulation knobs
  paperBalance: num('PAPER_BALANCE', 2000),
  paperFeeBps: num('PAPER_FEE_BPS', 10), // ~Jupiter swap fee, mirrors backtest assumptions

  // Accounts / integrations
  privateKey: process.env.PHANTOM_PRIVATE_KEY || null,
  rpcEndpoint: process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com',
  tgBotToken: process.env.TELEGRAM_BOT_TOKEN || null,
  tgChatId: process.env.TELEGRAM_CHAT_ID || null,

  // API hosts (verified live Oct 2026)
  jupiterLiteBase: 'https://lite-api.jup.ag',
  jupiterPriceApi: 'https://api.jup.ag',

  logLevel: process.env.LOG_LEVEL || 'info',
};

// Real min order constraints (Jupiter validates these too)
config.MIN_ORDER_USD = 1;     // paper-mode floor (USDC minimums are strict on live)
config.LIVE_MIN_ORDER_USD = 10; // Jupiter v1/v2 validation rule

function validateForLive(cfg) {
  const problems = [];
  if (!cfg.baseMint || !cfg.quoteMint) problems.push('BASE_MINT / QUOTE_MINT not set');
  if (!cfg.privateKey) problems.push('PHANTOM_PRIVATE_KEY not set');
  else if (cfg.privateKey === 'your_private_key_base64_here')
    problems.push('PHANTOM_PRIVATE_KEY is still the placeholder');
  if (cfg.initialOrder < cfg.LIVE_MIN_ORDER_USD)
    problems.push(`INITIAL_ORDER $${cfg.initialOrder} < Jupiter live minimum $${cfg.LIVE_MIN_ORDER_USD}`);
  return problems;
}

module.exports = { config, validateForLive };
