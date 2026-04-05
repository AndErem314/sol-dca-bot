# Phantom Wallet Setup Guide

## 1. Install Phantom Wallet
- **Chrome**: https://chrome.google.com/webstore/detail/phantom/bfnaelmomeimhlpmgjnjophhpkkoljpa
- **Firefox**: https://addons.mozilla.org/en-US/firefox/addon/phantom-app/
- **Brave**: Same as Chrome (Chromium-based)

## 2. Create or Import Wallet

### Option A: Create New Wallet (Recommended for bot)
1. Open Phantom extension
2. Click "Create New Wallet"
3. **CRITICAL**: Save your seed phrase securely
   - Write it down on paper (not digitally)
   - Store in a safe place
   - Never share with anyone
4. Set a strong password

### Option B: Import Existing Wallet
1. Open Phantom extension
2. Click "Import Wallet"
3. Enter your seed phrase
4. Set a password

## 3. Get Your Private Key for Bot

### **⚠️ SECURITY WARNING:**
- **Never share** your private key
- Use a **dedicated wallet** for bot trading only
- Keep **minimum required funds** in bot wallet

### Steps to Get Private Key:
1. Open Phantom wallet
2. Click settings (gear icon) ⚙️
3. Click "Export Private Key"
4. Enter your password
5. Copy the private key (base58 format)

## 4. Convert Private Key for Bot

The bot needs the private key in **base64 format**. Here's how to convert:

### Method 1: Using Solana CLI (Recommended)
```bash
# Install Solana CLI tools
sh -c "$(curl -sSfL https://release.solana.com/v1.17.0/install)"

# Convert private key
echo "your_private_key_base58_here" | base64
```

### Method 2: Using Node.js
```bash
# Create a simple conversion script
cat > convert-key.js << 'EOF'
const bs58 = require('bs58');

// Your base58 private key from Phantom
const base58Key = 'your_private_key_base58_here';

// Convert to base64
const bytes = bs58.decode(base58Key);
const base64Key = Buffer.from(bytes).toString('base64');

console.log('Base64 private key:');
console.log(base64Key);
EOF

# Install bs58 package and run
npm install bs58
node convert-key.js
```

### Method 3: Online Tool (Less Secure)
**Only use if you trust the tool and have a dedicated wallet:**
1. Go to: https://www.base64encode.org/
2. Paste your base58 private key
3. Encode to base64
4. **IMPORTANT**: Clear browser history after

## 5. Add to Bot Configuration

Edit your `.env` file:
```bash
# Phantom Wallet
PHANTOM_PRIVATE_KEY=your_base64_private_key_here
PHANTOM_PUBLIC_KEY=your_public_key_here
```

## 6. Fund Your Wallet

### Minimum Required:
- **SOL**: 0.5 SOL (0.1 minimum + buffer for transaction fees)
- **USDT**: $700 USDT ($664 for strategy + buffer)

### Recommended:
- **SOL**: 1.0 SOL (for multiple transactions)
- **USDT**: $800 USDT ($664 strategy + $136 buffer)

### How to Fund:
1. **Buy SOL/USDT** on an exchange (Binance, Coinbase, etc.)
2. **Send to Phantom** wallet address
3. **Verify receipt** in Phantom wallet

## 7. Test Small Amount First

### **ALWAYS TEST WITH SMALL AMOUNTS FIRST!**

1. **Start with $10-20** USDT in wallet
2. Run bot in **test mode**:
   ```bash
   node src/bot_sol_profit.js --test
   ```
3. Verify everything works
4. **Only then** fund with full amount

## 8. Security Best Practices

### **Wallet Security:**
- ✅ **Dedicated wallet** for bot only
- ✅ **Minimum funds** required for strategy
- ✅ **Paper backup** of seed phrase
- ✅ **Strong password** (12+ characters)
- ❌ **Never share** private key or seed phrase
- ❌ **Never store** digitally (no screenshots, text files)
- ❌ **Never use** main wallet for bot

### **Bot Security:**
- ✅ Run in **isolated environment**
- ✅ Regular **security updates**
- ✅ **Monitor** for unauthorized access
- ✅ **Emergency stop** procedures ready

## 9. Troubleshooting

### Common Issues:

#### **1. "Invalid private key" error**
- **Cause**: Wrong format or corrupted key
- **Fix**: Re-export from Phantom and convert again

#### **2. Insufficient SOL for fees**
- **Cause**: Need SOL for transaction fees
- **Fix**: Send at least 0.5 SOL to wallet

#### **3. Transaction failures**
- **Cause**: Network congestion or low balance
- **Fix**: Increase SOL balance, retry later

#### **4. Price feed issues**
- **Cause**: Jupiter API or RPC problems
- **Fix**: Check RPC endpoint, use alternative

## 10. Recovery Procedures

### **If Bot Fails or Gets Stuck:**
1. **Stop bot**: Ctrl+C in terminal
2. **Check logs**: `tail -f logs/bot-sol-profit.log`
3. **Manual sell**: Use Jupiter interface if needed
4. **Withdraw funds**: Send to secure wallet
5. **Investigate**: Check error messages

### **If Compromised:**
1. **Immediately** transfer funds to new wallet
2. **Create new wallet** with new seed phrase
3. **Never reuse** compromised wallet
4. **Investigate** how compromise occurred

## 11. Regular Maintenance

### **Daily:**
- Check wallet balances
- Monitor bot status
- Review transaction history

### **Weekly:**
- Backup wallet state files
- Review strategy performance
- Update bot if needed

### **Monthly:**
- Security audit
- Parameter review
- Performance analysis

## 12. Support Resources

### **Phantom Support:**
- Website: https://phantom.app/
- Help Center: https://help.phantom.app/
- Twitter: @phantom

### **Solana Resources:**
- Explorer: https://explorer.solana.com/
- Status: https://status.solana.com/
- Docs: https://docs.solana.com/

### **Jupiter Resources:**
- Website: https://jup.ag/
- Docs: https://docs.jup.ag/
- Twitter: @JupiterExchange

---

**⚠️ REMEMBER: Your private key = Your funds. Protect it like cash!**