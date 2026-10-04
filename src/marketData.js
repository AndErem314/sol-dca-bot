#!/usr/bin/env node
/**
 * Market data — verified-working Jupiter endpoints (probed live Oct 2026):
 *   price:  GET {lite|api}.jup.ag/price/v3?ids=<mint>
 *   quote:  GET {lite}.jup.ag/swap/v1/quote?...      (replaces dead v6 host)
 * Original code used quote-api.jup.ag/v6 → unreachable since Jupiter's 2025 migration.
 */
const { config } = require('./config');

const PRICE_HOSTS = [config.jupiterLiteBase, config.jupiterPriceApi];

let lastGoodPrice = null;

/** USD price of 1 base token. Uses Price v3 (simple, robust). */
async function getBaseUsdPrice(mint = config.baseMint) {
  for (const host of PRICE_HOSTS) {
    try {
      const resp = await fetch(`${host}/price/v3?ids=${mint}`, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) continue;
      const data = await resp.json();
      const usd = data?.[mint]?.usdPrice;
      if (typeof usd === 'number' && usd > 0) {
        lastGoodPrice = usd;
        return usd;
      }
    } catch { /* try next host */ }
  }
  return null;
}

/**
 * Exact quote-based price: value of 1 whole base token in quote units.
 * (Matches the original semantics; used as cross-check for stable pairs.)
 */
async function getQuotePrice() {
  try {
    const amount = Math.pow(10, config.baseDecimals).toString();
    const params = new URLSearchParams({
      inputMint: config.baseMint,
      outputMint: config.quoteMint,
      amount,
      slippageBps: '50',
    });
    const resp = await fetch(`${config.jupiterLiteBase}/swap/v1/quote?${params}`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    const out = parseInt(data.outAmount, 10);
    return out > 0 ? out / Math.pow(10, config.quoteDecimals) : null;
  } catch {
    return null;
  }
}

/** Price with stale fallback (log warning on fallback). */
async function getPrice(logger) {
  const usd = await getBaseUsdPrice();
  if (usd) return { price: usd, source: 'price-v3', stale: false };
  if (lastGoodPrice) {
    logger?.warn(`Price feed failed — using last good price ${lastGoodPrice} (STALE)`);
    return { price: lastGoodPrice, source: 'stale-cache', stale: true };
  }
  return { price: null, source: null, stale: false };
}

module.exports = { getBaseUsdPrice, getQuotePrice, getPrice };
