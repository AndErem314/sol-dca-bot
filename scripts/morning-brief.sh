#!/bin/bash
# Morning brief: self-heal the paper fleet, then emit the digest (stdout = delivered message).
cd "$(dirname "$0")/.."
RESTART_NOTE=""
for pair in sol-usdc pump-usdc trump-usdc; do
  pidfile="logs/paper.$pair.pid"
  alive=false
  if [ -f "$pidfile" ]; then
    pid=$(cat "$pidfile" 2>/dev/null)
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then alive=true; fi
  fi
  if [ "$alive" = false ]; then
    bash scripts/start-paper.sh >/dev/null 2>&1
    sleep 2
    RESTART_NOTE="♻️ Restarted dead bot(s): $pair — check logs/paper.$pair.log if it repeats"
    echo "$RESTART_NOTE"
    break
  fi
done
node scripts/digest.js
