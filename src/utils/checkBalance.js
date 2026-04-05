#!/usr/bin/env node

/**
 * Utility to check Phantom wallet balances
 */

require('dotenv').config();
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const { Jupiter } = require('@jup-ag/api');

async function checkBalances() {
  console.log('🔍 Checking Phantom Wallet Balances...');
  console.log('='.repeat(50));
  
  try {
    // Initialize connection
    const connection = new Connection(
      process.env.RPC_ENDPOINT || 'https://api.mainnet-beta.solana.com',
      'confirmed'
    );
    
    // Initialize wallet
    const privateKey = process.env.PHANTOM_PRIVATE_KEY;
    if (!privateKey) {
      console.error('❌ PHANTOM_PRIVATE_KEY not found in .env file');
      process.exit(1);
    }
    
    const wallet = Keypair.fromSecretKey(
      Buffer.from(privateKey, 'base64')
    );
    
    console.log(`Wallet: ${wallet.publicKey.toString()}`);
    console.log();
    
    // Check SOL balance
    const solBalance = await connection.getBalance(wallet.publicKey);
    const solBalanceSol = solBalance / 1e9;
    
    console.log('💰 SOL Balance:');
    console.log(`  ${solBalanceSol.toFixed(6)} SOL`);
    console.log(`  ${solBalance} lamports`);
    console.log();
    
    // Check token balances
    console.log('💎 Token Balances:');
    
    // Common token mints
    const tokens = {
      'USDT': 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
      'USDC': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'BONK': 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
      'RAY': '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    };
    
    for (const [symbol, mint] of Object.entries(tokens)) {
      try {
        const tokenAccounts = await connection.getTokenAccountsByOwner(
          wallet.publicKey,
          { mint: new PublicKey(mint) }
        );
        
        if (tokenAccounts.value.length > 0) {
          const accountInfo = await connection.getTokenAccountBalance(
            tokenAccounts.value[0].pubkey
          );
          
          let decimals = 6; // Default
          if (symbol === 'SOL') decimals = 9;
          if (symbol === 'BONK') decimals = 5;
          
          const balance = accountInfo.value.uiAmount || 0;
          console.log(`  ${symbol}: ${balance.toFixed(4)}`);
        }
      } catch (error) {
        // Token might not exist in wallet
      }
    }
    
    console.log();
    
    // Get current SOL price
    console.log('📈 Current Prices:');
    try {
      const jupiter = await Jupiter.load({
        connection,
        wallet: wallet.publicKey,
        cluster: 'mainnet-beta',
      });
      
      const routes = await jupiter.computeRoutes({
        inputMint: new PublicKey(tokens.USDT),
        outputMint: new PublicKey('So11111111111111111111111111111111111111112'), // SOL
        inputAmount: 1000000, // 1 USDT
        slippageBps: 50,
      });
      
      if (routes.routesInfos && routes.routesInfos.length > 0) {
        const solPrice = 1 / (routes.routesInfos[0].outAmount / 1e9);
        console.log(`  SOL/USDT: $${solPrice.toFixed(2)}`);
        
        // Calculate portfolio value
        const solValue = solBalanceSol * solPrice;
        console.log(`  SOL Value: $${solValue.toFixed(2)}`);
      }
    } catch (error) {
      console.log(`  SOL price: Error fetching (${error.message})`);
    }
    
    console.log();
    
    // Check if balances meet minimum requirements
    const minSol = parseFloat(process.env.MIN_SOL_BALANCE || 0.1);
    const minUsdt = parseFloat(process.env.MIN_USDT_BALANCE || 20.0);
    
    console.log('⚡ Minimum Requirements:');
    console.log(`  Minimum SOL: ${minSol} SOL (for transaction fees)`);
    console.log(`  Minimum USDT: $${minUsdt} USDT (for trading)`);
    
    if (solBalanceSol < minSol) {
      console.log(`  ⚠️  LOW SOL BALANCE: ${solBalanceSol.toFixed(4)} SOL < ${minSol} SOL`);
      console.log('     Deposit more SOL for transaction fees');
    } else {
      console.log(`  ✅ SOL balance sufficient: ${solBalanceSol.toFixed(4)} SOL`);
    }
    
    console.log();
    console.log('💡 Tips:');
    console.log('  • Keep at least 0.1 SOL for transaction fees');
    console.log('  • USDT is needed for buying SOL');
    console.log('  • Monitor balances regularly');
    
  } catch (error) {
    console.error(`❌ Error checking balances: ${error.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  checkBalances();
}

module.exports = { checkBalances };