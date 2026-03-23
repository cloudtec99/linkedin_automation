#!/usr/bin/env node
/**
 * notify.js
 * Sends the generated post to Telegram with inline action buttons.
 */

const https = require('https');

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CONTENT = process.env.POST_CONTENT || '';
const TOPIC   = process.env.POST_TOPIC   || 'DevOps';
const POST_ID = process.env.POST_ID      || `post_${Date.now()}`;

// ── Escape MarkdownV2 special characters ────────────────────────────
function esc(text) {
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

// ── Send Telegram request ────────────────────────────────────────────
function tlg(method, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req  = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${TOKEN}/${method}`,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => resolve(JSON.parse(raw)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  if (!TOKEN || !CHAT_ID) {
    console.error('❌  TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
    process.exit(1);
  }

  // Truncate if too long for Telegram (4096 char hard limit)
  const preview = CONTENT.length > 2800
    ? CONTENT.substring(0, 2800) + '\n\n…\\(truncated\\)'
    : CONTENT;

  const charCount = CONTENT.length;
  const bar       = '█'.repeat(Math.round(charCount / 300)) + '░'.repeat(10 - Math.round(charCount / 300));

  const text = `🤖 *Daily LinkedIn Post — Approval Needed*

📌 *${esc(TOPIC)}*
📊 \`${bar}\` ${charCount}/3000 chars

━━━━━━━━━━━━━━━━━━━━━━━━
${esc(preview)}
━━━━━━━━━━━━━━━━━━━━━━━━

🕙 Scheduled: *10:00 AM IST*
👇 Choose an action:`;

  const keyboard = {
    inline_keyboard: [
      [
        { text: '✅  Approve & Post',  callback_data: `approve::${POST_ID}` },
        { text: '⏭️  Skip Today',      callback_data: `skip::${POST_ID}` },
      ],
      [
        { text: '✏️  Edit Post',        callback_data: `edit::${POST_ID}` },
        { text: '🔄  Regenerate',       callback_data: `regen::${POST_ID}` },
      ],
    ],
  };

  const result = await tlg('sendMessage', {
    chat_id:      CHAT_ID,
    text,
    parse_mode:   'MarkdownV2',
    reply_markup: keyboard,
  });

  if (result.ok) {
    console.log(`✅  Telegram message sent — msg_id: ${result.result.message_id}`);
    console.log(`📱  Post ID: ${POST_ID}`);
  } else {
    console.error('❌  Telegram send failed:', JSON.stringify(result));
    process.exit(1);
  }
}

main().catch(err => {
  console.error('❌  notify.js failed:', err.message);
  process.exit(1);
});

// NOTE: notify.js already sends post via Telegram.
// The store endpoint call is handled in generate.js via RAILWAY_URL env var.
