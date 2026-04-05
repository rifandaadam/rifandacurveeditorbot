'use strict';

// ═══════════════════════════════════════════════════════════════
//  RCE Curve Preview Bot — Netlify Serverless Function
//  Rifanda Curve Editor (GCam & Geliosoft) — Telegram Bot
// ═══════════════════════════════════════════════════════════════

const https    = require('https');
const { PassThrough } = require('stream');
const PImage   = require('pureimage');
const FormData = require('form-data');
const fetch    = require('node-fetch');

const TOKEN        = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

if (!TOKEN) {
  console.error('[RCE-Bot] TELEGRAM_BOT_TOKEN is not set!');
}

// ═══════════════════════════════════════════════════════════════
//  CURVE MATH  (ported 1:1 from RCE main.js)
// ═══════════════════════════════════════════════════════════════

function clamp(v, lo = 0, hi = 1) {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Parse 16-char hex (64-bit IEEE754 little-endian) → float64
 */
function hexLeToDouble(hex16) {
  if (hex16.length !== 16) throw new Error(`Invalid hex chunk (${hex16.length} chars): "${hex16}"`);
  const buf = Buffer.from(hex16, 'hex');
  return buf.readDoubleLE(0);
}

/**
 * Submode definitions  (mirrors subModeDef in main.js)
 */
const SUB_MODE = {
  tone: {
    name:         'Tone',
    emoji:        '🌊',
    pointCount:   17,
    hexChars:     272,
    fixedXPoints: [0, 0.0625, 0.125, 0.1875, 0.25, 0.3125, 0.375, 0.4375, 0.5,
                   0.5625, 0.625, 0.6875, 0.75, 0.8125, 0.875, 0.9375, 1],
    pointNames:   ['Black','P1','P2','P3','Shadow','P5','P6','P7','Midtone',
                   'P9','P10','P11','Highlight','P13','P14','P15','White'],
    curveColor:   '#3a86ff',
    glowColor:    '#1d4ed8',
    dotColor:     '#8338ec',
  },
  gamma: {
    name:         'Gamma',
    emoji:        '📈',
    pointCount:   33,
    hexChars:     528,
    fixedXPoints: Array.from({ length: 33 }, (_, i) => i / 32),
    pointNames:   Array.from({ length: 33 }, (_, i) =>
                    i === 0 ? 'Black' : i === 32 ? 'White' : `G${i}`),
    curveColor:   '#38b000',
    glowColor:    '#166534',
    dotColor:     '#84cc16',
  },
  sect: {
    name:         'Sect',
    emoji:        '☀️',
    pointCount:   7,
    hexChars:     112,
    fixedXPoints: [0, 1/6, 2/6, 3/6, 4/6, 5/6, 1],
    pointNames:   ['Black', 'S1', 'S2', 'Midtone', 'S4', 'S5', 'White'],
    curveColor:   '#ff006e',
    glowColor:    '#9d0050',
    dotColor:     '#ff6b9d',
  },
};

/**
 * Detect submode by hex length (auto-detect)
 */
function detectSubMode(hexLen) {
  for (const [key, def] of Object.entries(SUB_MODE)) {
    if (def.hexChars === hexLen) return key;
  }
  return null;
}

/**
 * Parse hex joined string → array of Y values
 */
function parseHex(cleanHex, pointCount) {
  const yVals = [];
  for (let i = 0; i < pointCount; i++) {
    const chunk = cleanHex.substr(i * 16, 16);
    yVals.push(hexLeToDouble(chunk));
  }
  return yVals;
}

/**
 * PCHIP interpolation (Piecewise Cubic Hermite Interpolating Polynomial)
 * Exact port from RCE main.js
 */
function pchip(x, y, xd) {
  const n = x.length;
  const h = [], delta = [], d = [];
  for (let i = 0; i < n - 1; i++) {
    h[i]     = x[i + 1] - x[i];
    delta[i] = (y[i + 1] - y[i]) / h[i];
  }
  d[0]     = delta[0];
  d[n - 1] = delta[n - 2];
  for (let i = 1; i < n - 1; i++) {
    if (delta[i - 1] * delta[i] > 0) {
      const w1 = 2 * h[i] + h[i - 1];
      const w2 = h[i] + 2 * h[i - 1];
      d[i] = (w1 + w2) / (w1 / delta[i - 1] + w2 / delta[i]);
    } else {
      d[i] = 0;
    }
  }
  return xd.map(X => {
    let i = 0;
    while (i < n - 1 && X > x[i + 1]) i++;
    if (i >= n - 1) return clamp(y[n - 1]);
    const t = (X - x[i]) / h[i];
    const t2 = t * t, t3 = t2 * t;
    return clamp(
      (2*t3 - 3*t2 + 1)  * y[i]        +
      (t3  - 2*t2 + t)   * h[i] * d[i] +
      (-2*t3 + 3*t2)     * y[i + 1]    +
      (t3 - t2)          * h[i] * d[i + 1]
    );
  });
}

/**
 * Calculate basic curve statistics for caption
 */
function curveStats(fixedXPoints, yValues) {
  const deviations = yValues.map((y, i) => y - fixedXPoints[i]);
  const maxDev     = Math.max(...deviations.map(Math.abs));
  const midY       = yValues[Math.floor(yValues.length / 2)];
  const minY       = Math.min(...yValues);
  const maxY       = Math.max(...yValues);

  let character = 'Linear';
  if (maxDev < 0.01)       character = '≈ Linear (flat)';
  else if (midY > 0.55)    character = '↑ Brightened';
  else if (midY < 0.45)    character = '↓ Darkened';
  else if (deviations[Math.floor(deviations.length * 0.25)] < -0.02 &&
           deviations[Math.floor(deviations.length * 0.75)] >  0.02)
                            character = 'S-Curve (contrast+)';
  else if (deviations[Math.floor(deviations.length * 0.25)] >  0.02 &&
           deviations[Math.floor(deviations.length * 0.75)] < -0.02)
                            character = 'Inverse-S (contrast-)';
  else if (midY > 0.52)    character = '↑ Slight Lift';
  else if (midY < 0.48)    character = '↓ Slight Crush';

  return { minY, maxY, midY, maxDev, character };
}

// ═══════════════════════════════════════════════════════════════
//  IMAGE GENERATION  (pureimage canvas)
// ═══════════════════════════════════════════════════════════════

const CANVAS_SIZE = 512;

function drawCircle(ctx, cx, cy, r, fillColor) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, 2 * Math.PI);
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();
}

function drawLine(ctx, x1, y1, x2, y2, color, width) {
  ctx.strokeStyle = color;
  ctx.lineWidth   = width;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
}

async function generateCurveImage(subModeKey, yValues) {
  const W   = CANVAS_SIZE;
  const H   = CANVAS_SIZE;
  const PAD = 24;
  const def = SUB_MODE[subModeKey];

  const img = PImage.make(W, H);
  const ctx = img.getContext('2d');

  // Background
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, W, H);

  // Grid (16 divisions)
  ctx.lineWidth = 1;
  for (let i = 0; i <= 16; i++) {
    const xi = PAD + (i / 16) * (W - 2 * PAD);
    const yi = PAD + (i / 16) * (H - 2 * PAD);
    const isMajor = i % 4 === 0;
    const gridCol = isMajor ? '#1e3a5f' : '#152236';
    drawLine(ctx, xi, PAD,     xi, H - PAD, gridCol, 1);
    drawLine(ctx, PAD, yi, W - PAD, yi,     gridCol, 1);
  }

  // Identity diagonal (red)
  drawLine(ctx, PAD, H - PAD, W - PAD, PAD, '#e63946', 1);

  // PCHIP Curve
  const N  = 512;
  const xd = Array.from({ length: N }, (_, i) => i / (N - 1));
  const yd = pchip(def.fixedXPoints, yValues, xd);

  const toCanvasX = x => PAD + x * (W - 2 * PAD);
  const toCanvasY = y => H - PAD - y * (H - 2 * PAD);

  // Glow pass
  ctx.globalAlpha = 0.35;
  ctx.strokeStyle = def.glowColor;
  ctx.lineWidth   = 9;
  ctx.beginPath();
  yd.forEach((y, i) => {
    const cx = toCanvasX(xd[i]);
    const cy = toCanvasY(y);
    i === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy);
  });
  ctx.stroke();
  ctx.globalAlpha = 1.0;

  // Main curve line
  ctx.strokeStyle = def.curveColor;
  ctx.lineWidth   = 3;
  ctx.beginPath();
  yd.forEach((y, i) => {
    const cx = toCanvasX(xd[i]);
    const cy = toCanvasY(y);
    i === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy);
  });
  ctx.stroke();

  // Control point dots
  for (let i = 0; i < def.fixedXPoints.length; i++) {
    const cx = toCanvasX(def.fixedXPoints[i]);
    const cy = toCanvasY(yValues[i]);
    drawCircle(ctx, cx, cy, 5, '#ffffff');
    drawCircle(ctx, cx, cy, 3, def.dotColor);
  }

  // Corner markers
  const cornerSize = 5;
  ctx.fillStyle = '#94a3b8';
  ctx.fillRect(PAD - 2, H - PAD - 2, cornerSize, cornerSize);
  ctx.fillRect(W - PAD - 3, PAD - 3, cornerSize, cornerSize);

  // Border frame
  ctx.strokeStyle = '#1e3a5f';
  ctx.lineWidth   = 2;
  ctx.strokeRect(PAD, PAD, W - 2 * PAD, H - 2 * PAD);

  // Outer border
  ctx.strokeStyle = '#1e2d3d';
  ctx.lineWidth   = 3;
  ctx.strokeRect(1, 1, W - 2, H - 2);

  // Encode to PNG buffer
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = new PassThrough();
    stream.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on('end',  () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    PImage.encodePNGToStream(img, stream).catch(reject);
  });
}

// ═══════════════════════════════════════════════════════════════
//  TELEGRAM API HELPERS
// ═══════════════════════════════════════════════════════════════

async function callTelegram(method, body) {
  const resp = await fetch(`${TELEGRAM_API}/${method}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
    timeout: 8000,
  });
  const json = await resp.json();
  if (!json.ok) {
    console.error(`[Telegram] ${method} failed:`, JSON.stringify(json));
  }
  return json;
}

// FIX: Tambah replyToMsgId agar bot membalas (reply) pesan user
async function sendMessage(chatId, text, replyToMsgId = null, extra = {}) {
  return callTelegram('sendMessage', {
    chat_id:    chatId,
    text,
    parse_mode: 'HTML',
    ...(replyToMsgId && { reply_to_message_id: replyToMsgId }),
    ...extra,
  });
}

async function sendChatAction(chatId, action = 'upload_photo') {
  return callTelegram('sendChatAction', { chat_id: chatId, action });
}

// FIX: Tambah replyToMsgId agar sendPhoto juga reply ke pesan user
async function sendPhoto(chatId, photoBuffer, caption, replyToMsgId = null) {
  const form = new FormData();
  form.append('chat_id',    String(chatId));
  form.append('caption',   caption);
  form.append('parse_mode', 'HTML');
  if (replyToMsgId) {
    form.append('reply_to_message_id', String(replyToMsgId));
  }
  form.append('photo', photoBuffer, {
    filename:    'curve_preview.png',
    contentType: 'image/png',
    knownLength: photoBuffer.length,
  });

  const resp = await fetch(`${TELEGRAM_API}/sendPhoto`, {
    method:  'POST',
    body:    form,
    headers: form.getHeaders(),
    timeout: 12000,
  });
  const json = await resp.json();
  if (!json.ok) {
    console.error('[Telegram] sendPhoto failed:', JSON.stringify(json));
  }
  return json;
}

// ═══════════════════════════════════════════════════════════════
//  COMMAND HANDLERS
// ═══════════════════════════════════════════════════════════════

// FIX: Semua handler terima msgId dan teruskan ke sendMessage / sendPhoto
async function handleStart(chatId, firstName, msgId) {
  const name = firstName ? ` ${firstName}` : '';
  const lines = [
    `🎨 <b>RCE Curve Preview Bot</b>`,
    `<i>Rifanda Curve Editor — GCam Parametric Preview</i>`,
    ``,
    `Halo${name}! 👋 Kirim hex kurva dari RCE dan aku akan render gambar kurva-nya.`,
    ``,
    `<b>📌 Command:</b>`,
    `<code>/preview &lt;hex&gt;</code>`,
    ``,
    `<b>🔍 Auto-detect berdasarkan panjang hex:</b>`,
    `• <code>272</code> chars → 🌊 <b>Tone</b> (17 titik)`,
    `• <code>528</code> chars → 📈 <b>Gamma</b> (33 titik)`,
    `• <code>112</code> chars → ☀️ <b>Sect</b> (7 titik)`,
    ``,
    `<b>💡 Cara pakai:</b>`,
    `1. Buka <b>RCE App</b>`,
    `2. Set kurva yang diinginkan`,
    `3. Copy <i>Hex Joined</i> dari tabel`,
    `4. Kirim ke bot: <code>/preview &lt;hex&gt;</code>`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `🔗 <a href="https://t.me/portalgcam">Portal GCam</a>`,
  ];
  await sendMessage(chatId, lines.join('\n'), msgId, { disable_web_page_preview: true });
}

async function handlePreview(chatId, hexInput, msgId) {
  // Validate input exists
  if (!hexInput || !hexInput.trim()) {
    await sendMessage(chatId,
      `❓ <b>Cara pakai:</b>\n` +
      `<code>/preview &lt;hex&gt;</code>\n\n` +
      `Paste <i>Hex Joined</i> dari tabel RCE.\n\n` +
      `<b>Contoh:</b>\n` +
      `<code>/preview 000000000000F03F...</code>\n\n` +
      `Ketik /start untuk info lengkap.`,
      msgId
    );
    return;
  }

  // Clean hex — remove whitespace, normalize uppercase
  const cleanHex = hexInput.replace(/\s+/g, '').toUpperCase();

  // Validate hex chars
  if (!/^[0-9A-F]+$/.test(cleanHex)) {
    await sendMessage(chatId,
      `❌ <b>Input tidak valid</b>\n\n` +
      `Hex hanya boleh mengandung karakter <code>0-9</code> dan <code>A-F</code>.\n\n` +
      `Pastikan kamu copy dari kolom <b>Hex (64-bit LE)</b> di tabel RCE.`,
      msgId
    );
    return;
  }

  // Detect submode by hex length
  const subModeKey = detectSubMode(cleanHex.length);
  if (!subModeKey) {
    const validList = Object.values(SUB_MODE)
      .map(d => `• <code>${d.hexChars}</code> chars → ${d.emoji} <b>${d.name}</b> (${d.pointCount} pts)`)
      .join('\n');
    await sendMessage(chatId,
      `❌ <b>Panjang hex tidak dikenali</b>\n` +
      `Diterima: <code>${cleanHex.length}</code> chars\n\n` +
      `<b>Panjang yang valid:</b>\n${validList}\n\n` +
      `Pastikan kamu copy <b>keseluruhan</b> hex dari RCE (tanpa spasi).`,
      msgId
    );
    return;
  }

  const def = SUB_MODE[subModeKey];

  // Parse Y values
  let yValues;
  try {
    yValues = parseHex(cleanHex, def.pointCount);
  } catch (err) {
    await sendMessage(chatId, `❌ <b>Gagal parse hex:</b>\n${err.message}`, msgId);
    return;
  }

  // Validate Y values are in [0, 1]
  const outOfRange = yValues.filter(y => y < -0.01 || y > 1.01);
  if (outOfRange.length > 0) {
    await sendMessage(chatId,
      `⚠️ <b>Peringatan:</b> ${outOfRange.length} nilai Y di luar rentang [0, 1].\n` +
      `Kemungkinan hex dari submode yang berbeda atau data korup.`,
      msgId
    );
  }

  // Send "uploading photo" action
  await sendChatAction(chatId, 'upload_photo');

  // Generate image
  let imgBuf;
  try {
    imgBuf = await generateCurveImage(subModeKey, yValues);
  } catch (err) {
    console.error('[generateCurveImage]', err);
    await sendMessage(chatId, `❌ <b>Gagal generate gambar:</b>\n<code>${err.message}</code>`, msgId);
    return;
  }

  // Compute stats for caption
  const stats = curveStats(def.fixedXPoints, yValues);

  // Build caption
  const caption = [
    `${def.emoji} <b>${def.name} Curve Preview</b>`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    `📊 <b>Points:</b> ${def.pointCount}  |  <b>Hex:</b> ${cleanHex.length} chars`,
    `📉 <b>Min Y:</b> <code>${stats.minY.toFixed(4)}</code>  |  <b>Max Y:</b> <code>${stats.maxY.toFixed(4)}</code>`,
    `⚖️ <b>Midpoint Y:</b> <code>${stats.midY.toFixed(4)}</code>`,
    `🔎 <b>Karakter:</b> ${stats.character}`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    `<b>Titik kunci:</b>`,
    `  Black: <code>${yValues[0].toFixed(4)}</code>  |  White: <code>${yValues[def.pointCount - 1].toFixed(4)}</code>`,
    def.pointCount >= 7
      ? `  Midtone: <code>${yValues[Math.floor(def.pointCount / 2)].toFixed(4)}</code>`
      : '',
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    `🔧 <i>RCE – Rifanda Curve Editor v1.1</i>`,
  ].filter(Boolean).join('\n');

  // Send photo (as reply)
  const result = await sendPhoto(chatId, imgBuf, caption, msgId);
  if (!result.ok) {
    await sendMessage(chatId,
      `❌ <b>Gagal kirim foto:</b>\n<code>${result.description || 'Unknown error'}</code>`,
      msgId
    );
  }
}

// ═══════════════════════════════════════════════════════════════
//  NETLIFY SERVERLESS HANDLER
// ═══════════════════════════════════════════════════════════════

exports.handler = async (event) => {
  // GET / HEAD → health check
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 200,
      headers:    { 'Content-Type': 'text/plain' },
      body:       '✅ RCE Curve Preview Bot is running!\n',
    };
  }

  // Parse Telegram update
  let update;
  try {
    update = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 200, body: 'OK' };
  }

  // Only handle regular messages (ignore channel posts, etc.)
  const msg = update.message;
  if (!msg?.text) return { statusCode: 200, body: 'OK' };

  const chatId    = msg.chat.id;
  const msgId     = msg.message_id;            // FIX: ambil message_id untuk reply
  const text      = (msg.text || '').trim();
  const firstName = msg.from?.first_name || '';

  // Parse command (handle /cmd@BotUsername format)
  const [rawCmd, ...args] = text.split(/\s+/);
  const command = rawCmd.split('@')[0].toLowerCase();
  const argStr  = args.join(' ');

  console.log(`[${chatId}] ${command} ${argStr.slice(0, 40)}`);

  try {
    switch (command) {
      case '/start':
      case '/help':
        await handleStart(chatId, firstName, msgId);
        break;

      case '/preview':
        await handlePreview(chatId, argStr, msgId);
        break;

      default:
        if (command.startsWith('/')) {
          await sendMessage(chatId,
            `❓ Command tidak dikenal: <code>${command}</code>\n\nKirim /start untuk bantuan.`,
            msgId
          );
        }
        break;
    }
  } catch (err) {
    console.error('[handler error]', err);
    try {
      await sendMessage(chatId, `❌ Internal error: <code>${err.message}</code>`, msgId);
    } catch { /* swallow */ }
  }

  return { statusCode: 200, body: 'OK' };
};
