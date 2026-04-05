#!/bin/bash
# Multi-pair DCA Bot Runner
# Usage: ./run.sh [pair] [--test]
# Pairs: sol-usdc, bonk-usdc, jup-usdc, all

set -e

if [ "$1" = "all" ]; then
  echo "Starting all DCA bots..."
  for pair in sol-usdc bonk-usdc jup-usdc; do
    ENV_FILE=.env.$pair node src/bot.js "${@:2}" &
    echo "  Started $pair (PID $!)"
    sleep 2
  done
  echo ""
  echo "All bots running. Press Ctrl+C to stop all."
  wait
  exit 0
fi

PAIR=${1:-sol-usdc}
ENV_FILE=.env.$PAIR

if [ ! -f "$ENV_FILE" ]; then
  echo "Config not found: $ENV_FILE"
  echo "Usage: ./run.sh [sol-usdc|bonk-usdc|jup-usdc|all] [--test]"
  exit 1
fi

echo "Starting $PAIR DCA Bot..."
echo "   Config: $ENV_FILE"
if [ "$2" = "--test" ]; then
  echo "   Mode: TEST (dry run)"
else
  echo "   Mode: LIVE"
fi
echo ""

set -a
source "$ENV_FILE"
set +a

exec node src/bot.js "${@:2}"
