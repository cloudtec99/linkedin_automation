#!/usr/bin/env node
/**
 * notify-result.js [success|failed]
 * Sends the final outcome back to Telegram after the publish workflow runs.
 */

const https   = require('https');
const outcome = process.argv[2]; // 'success' or 'failed'

const TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const CHATID = process.env.TELEGRAM_CHAT_ID;
const URL    = process.env.LINKEDIN_URL || '';

function send(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req  = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${TOKEN}/sendMessage`,
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
  const text = outcome === 'success'
    ? (URL
        ? `✅ *Post is LIVE on LinkedIn\\!*\n\n🔗 [View your post](${URL})\n\n_See you tomorrow at 10:00 AM IST 🚀_`
        : `✅ *Post published to LinkedIn successfully\\!*\n\n_See you tomorrow at 10:00 AM IST 🚀_`)
    : `❌ *LinkedIn post FAILED*\n\nCheck [GitHub Actions](https://github.com/${process.env.GITHUB_REPOSITORY}/actions) for details\\.`;

  const result = await send({
    chat_id:                  CHATID,
    text,
    parse_mode:               'MarkdownV2',
    disable_web_page_preview: false,
  });

  console.log(result.ok ? `✅  Result notification sent (${outcome})` : `❌  ${result.description}`);
}

main().catch(err => { console.error('notify-result.js failed:', err.message); process.exit(1); });
