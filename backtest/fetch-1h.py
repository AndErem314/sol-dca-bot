#!/usr/bin/env python3
"""Fetch Binance SOL/USDT 1h klines for the 2026 backtest window.
Usage: python3 fetch-1h.py   -> writes data/solusdt_1h_2026.json (candles [t,o,h,l,c])
"""
import json, time, urllib.request, datetime as dt, pathlib

BASE = "https://api.binance.com/api/v3/klines"
OUT = pathlib.Path(__file__).parent / "data/solusdt_1h_2026.json"

def main():
    tz = dt.timezone.utc
    start = int(dt.datetime(2026, 1, 1, tzinfo=tz).timestamp() * 1000)
    now_ms = int(time.time() * 1000)
    all_k, since = [], start
    while since < now_ms:
        url = f"{BASE}?symbol=SOLUSDT&interval=1h&startTime={since}&limit=1000"
        with urllib.request.urlopen(url, timeout=30) as r:
            k = json.load(r)
        if not k:
            break
        all_k.extend(k)
        since = k[-1][0] + 3_600_000
        time.sleep(0.25)
    seen = {row[0]: [row[0], float(row[1]), float(row[2]), float(row[3]), float(row[4])] for row in all_k}
    candles = [seen[t] for t in sorted(seen)][:-1]  # drop unfinished candle
    OUT.write_text(json.dumps(candles))
    print(f"{len(candles)} candles -> {OUT.name}")

if __name__ == "__main__":
    main()
