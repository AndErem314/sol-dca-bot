#!/bin/bash
# Multi-pair DCA Bot Runner (v2)
# Usage: ./run.sh [pair] [--live]
# Pairs: sol-usdc, bonk-usdc, jup-usdc, all
# Default mode: PAPER (live prices, simulated fills, no funds at risk)

set -e

if [ "$1" = "all" ]; then
  echo "Starting all DCA bots in PAPER mode..."
  for pair in sol-usdc bonk-usdc jup-usdc; do
    PAIR_FILE=.env.$pair node src/bot.js "${@:2}" &
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
  echo "Usage: ./run.sh [sol-usdc|bonk-usdc|jup-usdc|all] [--live]"
  exit 1
fi

MODE="PAPER (simulated fills, live prices)"
[ "$2" = "--live" ] && MODE="LIVE (real orders, real funds)"
echo "Starting $PAIR DCA Bot..."
echo "   Config: $ENV_FILE"
echo "   Mode:   $MODE"
echo ""

export PAIR_FILE="$ENV_FILE"
exec node src/bot.js "${@:2}"
