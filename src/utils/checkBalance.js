#!/usr/bin/env node
/**
 * Utility: wallet balance checker (v2).
 * Uses plain RPC + Jupiter Price v3 — the old version imported @jup-ag/api v3
 * Jupiter.load()/computeRoutes() which no longer exists on npm.
 */
require('dotenv').config({ path: process.env.PAIR_FILE || '.env' });
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const { config } = require('../config');

async function checkBalances() {
  const connection = new Connection(config.rpcEndpoint, 'confirmed');

  let publicKey;
  if (config.privateKey && config.privateKey !== 'your_private_key_base64_here') {
    publicKey = Keypair.fromSecretKey(Buffer.from(config.privateKey, 'base64')).publicKey;
  } else if (process.env.PHANTOM_PUBLIC_KEY && process.env.PHANTOM_PUBLIC_KEY !== 'your_public_key_here') {
    publicKey = new PublicKey(process.env.PHANTOM_PUBLIC_KEY);
  } else {
    console.error('❌ Set PHANTOM_PRIVATE_KEY or PHANTOM_PUBLIC_KEY in the env file');
    process.exit(1);
  }
  console.log(`Wallet: ${publicKey.toString()}`);

  const sol = (await connection.getBalance(publicKey)) / 1e9;
  console.log(`SOL:  ${sol.toFixed(6)}${sol < config.minBaseForFees ? '  ⚠️ below fee minimum' : ''}`);

  for (const [label, mint] of [
    [`quote(${(process.env.PAIR_LABEL || 'USDC').split('/')[1]})`, config.quoteMint],
    [config.baseToken, config.baseMint],
  ].filter(([, m]) => m)) {
    try {
      const accounts = await connection.getTokenAccountsByOwner(publicKey, { mint: new PublicKey(mint) });
      let bal = 0;
      for (const a of accounts.value) {
        const info = await connection.getTokenAccountBalance(a.pubkey);
        bal += info.value.uiAmount || 0;
      }
      console.log(`${label}: ${bal.toFixed(6)}`);
    } catch (e) {
      console.log(`${label}: error (${e.message})`);
    }
  }

  // USD value via Price v3 (verified live Oct 2026)
  try {
    const ids = [
      'So11111111111111111111111111111111111111112',
      config.baseMint, config.quoteMint,
    ].filter(Boolean).join(',');
    const resp = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids}`, { signal: AbortSignal.timeout(10000) });
    const prices = await resp.json();
    const usdOf = (mint) => prices?.[mint]?.usdPrice;
    console.log(`SOL: $${usdOf('So11111111111111111111111111111111111111112') ?? '?'}`);
    if (config.baseMint && config.baseMint !== 'So11111111111111111111111111111111111111112') {
      console.log(`${config.baseToken}: $${usdOf(config.baseMint) ?? '?'}`);
    }
  } catch (e) {
    console.log(`price: error (${e.message})`);
  }
}
if (require.main === module) checkBalances();
