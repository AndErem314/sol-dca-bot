#!/bin/bash
# Start the 3-paper-pair fleet (SOL, PUMP, TRUMP / USDC) with logging.
cd "$(dirname "$0")/.."
mkdir -p logs
for pair in sol-usdc pump-usdc trump-usdc; do
  if pgrep -f "PAIR_FILE=.env.paper.$pair|src/bot.js.*$pair" > /dev/null; then
    echo "$pair already running"; continue
  fi
  # only match bots for THIS pair via the state file name they lock (cheap check: process env not visible; rely on pidfile)
  if [ -f "logs/paper.$pair.pid" ] && kill -0 "$(cat logs/paper.$pair.pid)" 2>/dev/null; then
    echo "$pair already running (pid $(cat logs/paper.$pair.pid))"; continue
  fi
  PAIR_FILE=.env.paper.$pair nohup node src/bot.js > "logs/paper.$pair.log" 2>&1 &
  echo $! > "logs/paper.$pair.pid"
  echo "$pair started pid $!"
  sleep 1
done
