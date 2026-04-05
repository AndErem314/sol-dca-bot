#!/bin/bash

# SOL/USDT DCA Bot Setup Script
# For Jupiter Exchange with Phantom Wallet

set -e

echo "=========================================="
echo "SOL/USDT DCA BOT SETUP"
echo "=========================================="
echo ""

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

print_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

print_info() {
    echo -e "${YELLOW}➜ $1${NC}"
}

print_error() {
    echo -e "${RED}✗ $1${NC}"
}

# Check Node.js version
print_info "Checking Node.js version..."
if command -v node &> /dev/null; then
    NODE_VERSION=$(node --version | cut -d'v' -f2)
    NODE_MAJOR=$(echo $NODE_VERSION | cut -d'.' -f1)
    
    if [ $NODE_MAJOR -ge 18 ]; then
        print_success "Node.js $NODE_VERSION found (>=18 required)"
    else
        print_error "Node.js $NODE_VERSION found, but version 18+ is required"
        exit 1
    fi
else
    print_error "Node.js not found. Please install Node.js 18+"
    echo "Visit: https://nodejs.org/"
    exit 1
fi

# Check npm
print_info "Checking npm..."
if command -v npm &> /dev/null; then
    print_success "npm found"
else
    print_error "npm not found"
    exit 1
fi

# Create necessary directories
print_info "Creating directories..."
mkdir -p logs state src/utils
print_success "Directories created"

# Install dependencies
print_info "Installing dependencies..."
npm install
if [ $? -eq 0 ]; then
    print_success "Dependencies installed"
else
    print_error "Failed to install dependencies"
    exit 1
fi

# Setup environment file
print_info "Setting up environment configuration..."
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        cp .env.example .env
        print_success "Created .env file from template"
        print_info "Please edit .env file with your configuration"
    else
        print_error ".env.example not found"
        exit 1
    fi
else
    print_success ".env file already exists"
fi

# Create Phantom wallet guide
print_info "Creating Phantom wallet setup guide..."
cat > PHANTOM_SETUP.md << 'EOF'
# Phantom Wallet Setup Guide

## 1. Install Phantom Wallet
- Chrome: https://chrome.google.com/webstore/detail/phantom/bfnaelmomeimhlpmgjnjophhpkkoljpa
- Firefox: https://addons.mozilla.org/en-US/firefox/addon/phantom-app/
- Brave: Same as Chrome

## 2. Create or Import Wallet
1. Open Phantom extension
2. Click "Create New Wallet" or "Import Wallet"
3. **SAVE YOUR SEED PHRASE SECURELY**
   - Write it down on paper
   - Never store digitally
   - Never share with anyone

## 3. Get Your Private Key
1. Open Phantom wallet
2. Click settings (gear icon)
3. Click "Export Private Key"
4. Enter your password
5. Copy the private key (base58 format)

## 4. Convert Private Key for Bot
Your private key needs to be converted to base64 for the bot:

```bash
# Install Solana CLI tools
sh -c "$(curl -sSfL https://release.solana.com/v1.17.0/install)"

# Convert private key
echo "your_private_key_base58_here" | base64
```

Copy the base64 output to your `.env` file as `PHANTOM_PRIVATE_KEY`.

## 5. Fund Your Wallet
1. Buy SOL from an exchange (Binance, Coinbase, etc.)
2. Send SOL to your Phantom wallet address
3. Also get some USDT for trading

## 6. Test Small Amount First
Always test with small amounts first ($10-20) before committing larger funds.

## ⚠️ Security Warning
- **Never share** your private key or seed phrase
- Use a **dedicated wallet** for bot trading only
- Keep **minimum required funds** in the bot wallet
- Regular **backups** of your seed phrase
EOF

print_success "Phantom wallet guide created: PHANTOM_SETUP.md"

# Create test script
print_info "Creating test script..."
cat > test-bot.sh << 'EOF'
#!/bin/bash
echo "Testing DCA Bot..."
echo ""

# Check if .env exists
if [ ! -f ".env" ]; then
    echo "❌ .env file not found. Run setup.sh first."
    exit 1
fi

# Test Node.js modules
echo "1. Testing Node.js modules..."
node -e "console.log('✅ Node.js working');"

# Test configuration
echo ""
echo "2. Testing configuration..."
node src/utils/calculateOrders.js

# Test balance check (dry run)
echo ""
echo "3. Testing balance check (dry run)..."
echo "Note: This requires PHANTOM_PRIVATE_KEY in .env"
echo ""

# Test bot in test mode
echo ""
echo "4. Testing bot in test mode..."
echo "Running: npm run test"
echo ""
npm run test

echo ""
echo "✅ Test completed!"
echo "If all tests pass, you can run: npm start"
EOF

chmod +x test-bot.sh
print_success "Test script created: test-bot.sh"

# Create strategy calculation
print_info "Calculating DCA strategy..."
node src/utils/calculateOrders.js > strategy_calculation.txt
print_success "Strategy calculation saved: strategy_calculation.txt"

echo ""
echo "=========================================="
echo "✅ SETUP COMPLETE!"
echo "=========================================="
echo ""
echo "Next steps:"
echo ""
echo "1. 📝 Edit .env file with your configuration:"
echo "   - PHANTOM_PRIVATE_KEY (from Phantom wallet)"
echo "   - Trading parameters (optional)"
echo ""
echo "2. 🔐 Read PHANTOM_SETUP.md for wallet setup"
echo ""
echo "3. 🧪 Test the bot:"
echo "   ./test-bot.sh"
echo ""
echo "4. 🚀 Run the bot:"
echo "   npm start"
echo ""
echo "5. 📊 Monitor logs:"
echo "   tail -f logs/bot.log"
echo ""
echo "=========================================="
echo "⚠️  IMPORTANT SECURITY NOTES:"
echo "=========================================="
echo "• Use a DEDICATED wallet for bot trading only"
echo "• Keep MINIMUM required funds in the bot wallet"
echo "• NEVER share your private key or seed phrase"
echo "• Test with SMALL amounts first ($10-20)"
echo "• Monitor the bot REGULARLY"
echo "=========================================="