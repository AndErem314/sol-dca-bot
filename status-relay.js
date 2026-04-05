#!/usr/bin/env node
/**
 * DCA Bot Status Relay
 * Reads state files from all pairs and sends summary to Telegram DM.
 * Run via OpenClaw cron.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const STATE_DIR = '/home/andrey/.openclaw/workspace/skills/coding-assistant/sol-dca-bot/state';
const CHAT_ID = process.env.DCA_CHAT_ID || '1771741539'; // Default to Andrey's telegram ID
const BOT_TOKEN = process.env.SOL_DCA_BOT_TOKEN;

if (!BOT_TOKEN) {
  console.log('SOL_DCA_BOT_TOKEN not set — skipping');
  process.exit(0);
}

function sendTelegram(message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id: CHAT_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    const req = https.request(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: data }));
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function readState(filename) {
  try {
    const raw = fs.readFileSync(path.join(STATE_DIR, filename), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function emoji(status) {
  switch (status) {
    case 'filled': return '✅';
    case 'open': return '⏳';
    case 'pending': return '○';
    default: return '❓';
  }
}

async function main() {
  const files = fs.readdirSync(STATE_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.log('No state files found');
    process.exit(0);
  }

  let message = '📊 <b>DCA Bot Status</b>\n';
  message += '━━━━━━━━━━━━━━━━━━━━━\n\n';

  for (const file of files) {
    const state = readState(file);
    if (!state) continue;

    const pair = file.replace('.json', '').replace(/-/g, '/');
    const entry = state.entryPrice;
    const filled = state.grid ? state.grid.filter(l => l.status === 'filled').length : 0;
    const open = state.grid ? state.grid.filter(l => l.status === 'open').length : 0;
    const total = state.grid ? state.grid.length : 0;
    const invested = state.totalInvestedUSDC || 0;
    const bought = state.totalBaseBought || 0;
    const exit = state.exitPrice;
    const sellStatus = state.sellFilled ? '✅ sold' : state.sellOrderPlaced ? '🔄 sell open' : '⏳ no sell';
    const emergency = state.emergencyStop ? ' 🛑' : '';

    message += `<b>${pair}</b>${emergency}\n`;
    message += `Entry: $${entry?.toFixed(6) || 'N/A'}\n`;
    message += `Orders: ${filled}/${total} filled, ${open} open on Jupiter\n`;
    message += `Invested: $${invested.toFixed(2)} | Holding: ${bought.toFixed(6)}\n`;
    if (exit) {
      message += `Exit: $${exit.toFixed(6)} | ${sellStatus}\n`;
    }

    // Show next pending order
    if (state.grid) {
      const next = state.grid.find(l => l.status === 'pending');
      if (next) {
        message += `Next: #${next.orderNum} $${next.sizeUSDC.toFixed(2)} @ $${next.limitPrice.toFixed(6)} (${next.dropPercent}% drop)\n`;
      }
    }

    message += '─────────────────────\n\n';
  }

  const minsAgo = state => {
    if (!state.savedAt) return '?';
    const mins = Math.round((Date.now() - state.savedAt) / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins/60)}h ago`;
  };

  message += `Last update: ${minsAgo(readState(files[0]))}`;

  const result = await sendTelegram(message);
  if (result.ok) {
    console.log('Status sent to Telegram');
  } else {
    console.log(`Telegram error: ${result.status} - ${result.body}`);
  }
}

main().catch(console.error);
