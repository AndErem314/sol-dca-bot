#!/usr/bin/env node
/**
 * SolDCA_314_bot Telegram Listener
 * Standalone Telegram bot that:
 * - Receives state updates from bot.js (via state files)
 * - Responds to commands: /start, /status, /pause, /resume, /cancel
 * - Acts as a relay between the DCA bot and Andrey
 */
require('dotenv').config({ path: '/home/andrey/.openclaw/.env' });

const https = require('https');
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.SOL_DCA_BOT_TOKEN;
const ALLOWED_USER = 1771741539; // Andrey's Telegram ID
const STATE_DIR = '/home/andrey/.openclaw/workspace/skills/coding-assistant/sol-dca-bot/state';

if (!BOT_TOKEN) {
  console.error('SOL_DCA_BOT_TOKEN not set');
  process.exit(1);
}

let offset = 0;

function tg(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let r = '';
      res.on('data', c => r += c);
      res.on('end', () => {
        try { resolve(JSON.parse(r)); } catch { resolve({ ok: false, body: r }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function readState(pair) {
  try {
    const file = path.join(STATE_DIR, `${pair.replace('/', '-')}.json`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

function formatState(state, pair) {
  if (!state) return `No active position for ${pair}`;

  const filled = state.grid?.filter(l => l.status === 'filled').length || 0;
  const open = state.grid?.filter(l => l.status === 'open').length || 0;
  const total = state.grid?.length || 0;
  const mins = state.savedAt ? Math.round((Date.now() - state.savedAt) / 60000) : '?';
  const sold = state.sellFilled ? '\n✅ Sell filled — position closed' :
               state.sellOrderPlaced ? '\n⏳ Sell order pending on Jupiter' : '';

  const base = pair.split('/')[0];
  const extra = state.targetExtraBase?.toFixed(6);

  let msg = `${pair}\n`;
  msg += `Entry: $${(state.entryPrice || 0).toFixed(6)}\n`;
  msg += `Orders: ${filled}/${total} filled, ${open} open\n`;
  msg += `Invested: $${(state.totalInvestedUSDC || 0).toFixed(2)}\n`;
  msg += `Holding: ${(state.totalBaseBought || 0).toFixed(6)} ${base}`;
  if (state.exitPrice) msg += `\nExit: $${state.exitPrice.toFixed(6)}`;
  if (extra && extra !== '0.000000') msg += `\nExtra target: +${extra} ${base}`;
  msg += sold;
  msg += `\nUpdated ${mins < 1 ? 'now' : `${mins}m ago`}`;

  if (state.emergencyStop) msg += '\n🛑 Emergency stop active';

  return msg;
}

async function handleUpdate(update) {
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const from = msg.from;
  if (from.id !== ALLOWED_USER) {
    await tg('sendMessage', { chat_id: from.id, text: 'Not authorized.' });
    return;
  }

  const text = (msg.text || '').trim();
  const chatId = msg.chat.id;

  if (text === '/start') {
    await tg('sendMessage', {
      chat_id: chatId,
      text: `👋 SolDCA Bot\n\nCommands:\n/status — check all pairs\n/status <pair> — check one pair\n/bots — running bots\n/pause <pair> — emergency stop a pair\n/resume <pair> — re-enable a pair\n/cancel — stop this bot process`,
    });
    return;
  }

  if (text === '/status') {
    const files = fs.readdirSync(STATE_DIR).filter(f => f.endsWith('.json'));
    if (files.length === 0) {
      await tg('sendMessage', { chat_id: chatId, text: 'No active positions.' });
      return;
    }
    let out = '📊 DCA Bot Status\n━━━━━━━━━━━━━━━\n\n';
    for (const f of files) {
      const pair = f.replace('.json', '').replace(/-/g, '/');
      const state = readState(pair);
      out += formatState(state, pair) + '\n\n─────────────────\n\n';
    }
    await tg('sendMessage', { chat_id: chatId, text: out });
    return;
  }

  if (text.startsWith('/status ')) {
    const pair = text.split(' ')[1].toUpperCase();
    const state = readState(pair);
    await tg('sendMessage', { chat_id: chatId, text: formatState(state, pair) });
    return;
  }

  if (text === '/bots') {
    // Check if bot processes are running
    try {
      const { execSync } = require('child_process');
      const output = execSync('pgrep -f "node.*bot.js" | xargs -r ps -p', { encoding: 'utf8' });
      if (output.trim()) {
        await tg('sendMessage', { chat_id: chatId, text: `Running bots:\n\`\`\`\n${output}\`\`\``, parse_mode: 'Markdown' });
      } else {
        await tg('sendMessage', { chat_id: chatId, text: 'No DCA bot processes running.' });
      }
    } catch {
      await tg('sendMessage', { chat_id: chatId, text: 'No DCA bot processes running.' });
    }
    return;
  }

  if (text.startsWith('/pause ') || text.startsWith('/resume ')) {
    await tg('sendMessage', {
      chat_id: chatId,
      text: '⚠️ This requires direct state file edit. Bot will check next cycle.\n\nFor now, edit the state file directly or send a kill signal to the bot process.',
    });
    return;
  }

  if (text === '/cancel') {
    await tg('sendMessage', { chat_id: chatId, text: 'Shutting down DCA listener...' });
    await tg('sendMessage', { chat_id: chatId, text: 'To restart: `node telegram-listener.js`', parse_mode: 'Markdown' });
    process.exit(0);
    return;
  }

  await tg('sendMessage', {
    chat_id: chatId,
    text: `Unknown command: ${text}\n\nUse /start for available commands.`,
  });
}

async function poll() {
  try {
    const resp = await tg('getUpdates', { offset, timeout: 30 });
    if (resp.ok && resp.result.length > 0) {
      for (const update of resp.result) {
        offset = update.update_id + 1;
        await handleUpdate(update);
      }
    }
  } catch (err) {
    console.error('Poll error:', err.message);
  }
  setTimeout(poll, 1000);
}

console.log('SolDCA_314_bot listener started');
console.log('Polling for updates...');
poll();