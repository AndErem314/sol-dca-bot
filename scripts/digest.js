#!/usr/bin/env node
/**
 * One-shot paper-fleet digest for the morning briefing.
 * Reads state/*.paper.json + pidfiles, live prices from Jupiter Price v3,
 * prints a plain-text Telegram-ready report. Exit 0 always; health issues
 * are reported in-band (cron decides to restart).
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PAIRS = [
  { label: 'SOL/USDC', file: 'state/SOL-USDC.paper.json', pid: 'logs/paper.sol-usdc.pid', mint: 'So11111111111111111111111111111111111111112', start: 1500 },
  { label: 'PUMP/USDC', file: 'state/PUMP-USDC.paper.json', pid: 'logs/paper.pump-usdc.pid', mint: 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn', start: 1500 },
  { label: 'TRUMP/USDC', file: 'state/TRUMP-USDC.paper.json', pid: 'logs/paper.trump-usdc.pid', mint: '6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN', start: 1500 },
];

function alive(pidFile) {
  try {
    const pid = parseInt(fs.readFileSync(path.join(ROOT, pidFile), 'utf8').trim(), 10);
    process.kill(pid, 0);
    return { up: true, pid };
  } catch { return { up: false }; }
}

async function prices() {
  try {
    const resp = await fetch(`https://lite-api.jup.ag/price/v3?ids=${PAIRS.map(p => p.mint).join(',')}`, { signal: AbortSignal.timeout(10000) });
    const j = await resp.json();
    const out = {};
    for (const p of PAIRS) out[p.label] = j?.[p.mint]?.usdPrice ?? null;
    return out;
  } catch { return {}; }
}

const fmt = (n, d = 2) => n == null ? '—' : Number(n).toFixed(d);

(async () => {
  const px = await prices();
  const lines = ['☀️ SOL DCA Paper Fleet — morning digest', '━━━━━━━━━━━━━━━━━━━━'];
  let anyDown = false, totalEquity = 0, totalStart = 0;

  for (const p of PAIRS) {
    const h = alive(p.pid);
    if (!h.up) anyDown = true;
    let s;
    try { s = JSON.parse(fs.readFileSync(path.join(ROOT, p.file), 'utf8')); }
    catch { lines.push(`${h.up ? '🟢' : '🔴'} ${p.label}: no state yet`); continue; }
    const ageMin = Math.round((Date.now() - (s.savedAt || 0)) / 60000);
    const price = px[p.label];
    totalStart += p.start;

    const c = s.cycle;
    const sellEscrow = c && c.sellOrderId ? c.sellQuote : 0;
    const sellBase = c && c.sellOrderId ? c.sellBase : 0;
    const equity = s.wallet.quote + (s.wallet.escrow - sellEscrow) + (s.wallet.base + sellBase) * (price ?? 0);
    totalEquity += equity;
    const pnlPct = (equity / p.start - 1) * 100;

    lines.push(`${h.up ? '🟢' : '🔴'} ${p.label} ${price ? `@ $${fmt(price, price < 1 ? 6 : 2)}` : ''} — equity $${fmt(equity)} (${pnlPct >= 0 ? '+' : ''}${fmt(pnlPct, 1)}%)`);
    if (c) {
      const filled = c.grid.filter(l => l.status === 'filled').length;
      const invested = c.invested ?? c.grid.filter(l => l.status === 'filled').reduce((a, l) => a + l.sizeQuote, 0);
      const holdings = c.holdings ?? c.grid.filter(l => l.status === 'filled').reduce((a, l) => a + (l.filledBaseAmount || 0), 0);
      const avg = holdings > 0 ? invested / holdings : 0;
      let row = `   cycle entry $${fmt(c.entryPrice, 4)} | ${filled}/30 filled | inv $${fmt(invested)} | ${fmt(holdings, 4)} ${p.label.split('/')[0]} @ avg $${fmt(avg, 4)}`;
      if (c.sellOrderId && price) {
        const dist = (c.sellPlacedPrice / price - 1) * 100;
        row += `\n   TP $${fmt(c.sellPlacedPrice, 4)} — ${dist <= 0 ? '✅ triggered?' : `${fmt(dist, 1)}% away`}${dist < 3 ? ' ⚡ close!' : ''}`;
      }
      lines.push(row);
      if (filled === 0 && ageMin > 1440) lines.push(`   ⚠️ stale: entry limit unfilled >24h (price never revisited)`);
    } else {
      lines.push(`   idle (no open cycle)`);
    }
    lines.push(`   closed cycles: ${s.realizedCycles} | realized $${fmt(s.realizedProfitUsd)} | extra ${p.label.split('/')[0]} kept: ${fmt(s.realizedExtraBase, 4)} | last tick ${ageMin < 2 ? 'now' : ageMin + 'm ago' + (ageMin > 10 ? ' ⚠️' : '')}`);
  }

  lines.push(`━━ Fleet total: $${fmt(totalEquity)} vs $${fmt(totalStart)} (${((totalEquity / totalStart - 1) * 100).toFixed(1)}%)`);
  if (anyDown) lines.push('🔴 DOWN: at least one bot process is not running — needs start-paper.sh');
  console.log(lines.join('\n'));
})();
