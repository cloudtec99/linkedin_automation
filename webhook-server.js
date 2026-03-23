#!/usr/bin/env node
/**
 * webhook-server.js
 *
 * Receives Telegram button callbacks → triggers GitHub Actions workflows.
 * Deploy FREE on Railway (https://railway.app) — takes 3 minutes.
 *
 * This is the only "server" piece in the whole system.
 * It's tiny: ~150 lines, uses only built-in Node modules + express.
 */

require('dotenv').config();
const express = require('express');
const https   = require('https');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = String(process.env.TELEGRAM_CHAT_ID);
const GH_PAT    = process.env.GH_PAT;
const GH_REPO   = process.env.GITHUB_REPOSITORY;  // e.g. "prabhu/linkedin-groq"
const PORT      = process.env.PORT || 3000;

// In-memory store: post_id → { content, topic }
const store = new Map();
// Track who is waiting to send an edited post
const editWaiting = new Map(); // chat_id → post_id

// ── Telegram helper ──────────────────────────────────────────────────
function tlg(method, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req  = https.request({
      hostname: 'api.telegram.org',
      path:     `/bot${BOT_TOKEN}/${method}`,
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

// ── GitHub Actions trigger ───────────────────────────────────────────
function triggerGHA(eventType, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ event_type: eventType, client_payload: payload });
    const req  = https.request({
      hostname: 'api.github.com',
      path:     `/repos/${GH_REPO}/dispatches`,
      method:   'POST',
      headers:  {
        'Authorization':  `Bearer ${GH_PAT}`,
        'Content-Type':   'application/json',
        'User-Agent':     'linkedin-groq-bot',
        'Content-Length': Buffer.byteLength(body),
      },
    }, res => {
      let raw = '';
      res.on('data', c => (raw += c));
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Store incoming post (called by generate.js via this endpoint) ─────
app.post('/store', (req, res) => {
  const { post_id, post_content, post_topic } = req.body;
  if (!post_id || !post_content) return res.status(400).json({ error: 'Missing post_id or post_content' });
  store.set(post_id, { content: post_content, topic: post_topic });
  console.log(`📦  Stored: ${post_id}`);
  res.json({ ok: true });
});

// ── Telegram webhook ─────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Always respond immediately — Telegram retries if you don't
  res.json({ ok: true });

  const update = req.body;

  // ── Inline button pressed ───────────────────────────────────────
  if (update.callback_query) {
    const cb          = update.callback_query;
    const [action, postId] = (cb.data || '').split('::');
    const msgId       = cb.message?.message_id;
    const post        = store.get(postId);

    await tlg('answerCallbackQuery', { callback_query_id: cb.id });

    if (!post && action !== 'regen') {
      await tlg('sendMessage', { chat_id: CHAT_ID, text: '⚠️ Post not found (server may have restarted). Please trigger a new generation.' });
      return;
    }

    if (action === 'approve') {
      // Remove buttons from original message
      await tlg('editMessageReplyMarkup', { chat_id: CHAT_ID, message_id: msgId, reply_markup: { inline_keyboard: [] } });
      await tlg('sendMessage', { chat_id: CHAT_ID, text: '⏳ Triggering LinkedIn publish…' });

      const statusCode = await triggerGHA('publish-post', { post_id: postId, post_content: post.content });

      if (statusCode === 204) {
        store.delete(postId);
        await tlg('sendMessage', { chat_id: CHAT_ID, text: '🚀 Publish workflow triggered! You\'ll get a confirmation once it\'s live.' });
      } else {
        await tlg('sendMessage', { chat_id: CHAT_ID, text: `❌ Failed to trigger workflow (HTTP ${statusCode}). Check GitHub Actions.` });
      }

    } else if (action === 'skip') {
      await tlg('editMessageReplyMarkup', { chat_id: CHAT_ID, message_id: msgId, reply_markup: { inline_keyboard: [] } });
      store.delete(postId);
      await tlg('sendMessage', { chat_id: CHAT_ID, text: '⏭️ Skipped. See you tomorrow at 10:00 AM IST 👋' });

    } else if (action === 'edit') {
      editWaiting.set(CHAT_ID, postId);
      await tlg('sendMessage', {
        chat_id:      CHAT_ID,
        text:         `✏️ *Send your edited post as the next message.*\n\nCurrent preview:\n\n${post.content.substring(0, 400)}${post.content.length > 400 ? '…' : ''}`,
        parse_mode:   'Markdown',
        reply_markup: { force_reply: true, selective: true },
      });

    } else if (action === 'regen') {
      await tlg('editMessageReplyMarkup', { chat_id: CHAT_ID, message_id: msgId, reply_markup: { inline_keyboard: [] } });
      await tlg('sendMessage', { chat_id: CHAT_ID, text: '🔄 Regenerating… new post coming in ~30 seconds.' });
      await triggerGHA('generate-daily-post', { manual: true });
    }
  }

  // ── Plain text reply (edited post content) ──────────────────────
  if (update.message?.text && String(update.message.chat.id) === CHAT_ID) {
    const pendingPostId = editWaiting.get(CHAT_ID);

    if (pendingPostId) {
      const newContent = update.message.text;
      const post       = store.get(pendingPostId);

      if (post) {
        post.content = newContent;
        store.set(pendingPostId, post);
        editWaiting.delete(CHAT_ID);

        await tlg('sendMessage', {
          chat_id:      CHAT_ID,
          text:         `✅ Edit saved (${newContent.length}/3000 chars).\n\nApprove when ready:`,
          reply_markup: {
            inline_keyboard: [[
              { text: '✅  Approve & Post', callback_data: `approve::${pendingPostId}` },
              { text: '⏭️  Skip',           callback_data: `skip::${pendingPostId}` },
            ]],
          },
        });
      }
    }
  }
});

// ── Health check ─────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ ok: true, stored: store.size, uptime: Math.round(process.uptime()) + 's' });
});

// ── Register webhook with Telegram on startup ─────────────────────────
async function registerWebhook() {
  const url = process.env.WEBHOOK_URL;
  if (!url) { console.log('⚠️  WEBHOOK_URL not set — skipping registration'); return; }
  const r = await tlg('setWebhook', { url, drop_pending_updates: true });
  console.log(r.ok ? `✅  Webhook registered: ${url}` : `❌  Webhook failed: ${r.description}`);
}

app.listen(PORT, async () => {
  console.log(`🤖  Webhook server listening on :${PORT}`);
  await registerWebhook();
});
