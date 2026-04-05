#!/usr/bin/env node
/**
 * RCE Curve Bot — Webhook Setup Script
 * Usage:
 *   node scripts/set-webhook.js             → set webhook
 *   node scripts/set-webhook.js --delete    → remove webhook
 *
 * Required env vars (or create a .env file):
 *   TELEGRAM_BOT_TOKEN   = your bot token from @BotFather
 *   NETLIFY_SITE_URL     = https://yoursite.netlify.app
 */

require('dotenv').config({ path: '.env' });

const https = require('https');

const TOKEN      = process.env.TELEGRAM_BOT_TOKEN;
const SITE_URL   = process.env.NETLIFY_SITE_URL?.replace(/\/$/, '');
const IS_DELETE  = process.argv.includes('--delete');

if (!TOKEN) {
  console.error('❌  TELEGRAM_BOT_TOKEN not set');
  process.exit(1);
}

function callTelegram(method, body = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'api.telegram.org',
      path:     `/bot${TOKEN}/${method}`,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function main() {
  if (IS_DELETE) {
    console.log('🗑  Deleting webhook...');
    const res = await callTelegram('deleteWebhook');
    if (res.ok) {
      console.log('✅  Webhook deleted successfully.');
    } else {
      console.error('❌  Failed:', res.description);
    }
    return;
  }

  if (!SITE_URL) {
    console.error('❌  NETLIFY_SITE_URL not set');
    process.exit(1);
  }

  const webhookUrl = `${SITE_URL}/.netlify/functions/bot`;
  console.log(`🔗  Setting webhook → ${webhookUrl}`);

  const res = await callTelegram('setWebhook', {
    url:             webhookUrl,
    allowed_updates: ['message'],
    drop_pending_updates: true,
  });

  if (res.ok) {
    console.log('✅  Webhook set successfully!');
    console.log('');
    console.log('📋  Webhook info:');
    const info = await callTelegram('getWebhookInfo');
    const w = info.result;
    console.log(`    URL           : ${w.url}`);
    console.log(`    Pending updates: ${w.pending_update_count}`);
    console.log(`    Last error    : ${w.last_error_message || 'none'}`);
    console.log('');
    console.log('🤖  Test your bot by sending /start to it on Telegram!');
  } else {
    console.error('❌  Failed to set webhook:', res.description);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('❌  Error:', err.message);
  process.exit(1);
});
