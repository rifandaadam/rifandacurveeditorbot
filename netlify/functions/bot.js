'use strict';

// ═══════════════════════════════════════════════════════════════
//  RCE Curve Preview Bot — Netlify Serverless Function
//  Rifanda Curve Editor (GCam & Geliosoft) — Telegram Bot
// ═══════════════════════════════════════════════════════════════

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
//  CURVE MATH
// ═══════════════════════════════════════════════════════════════

function clamp(v, lo = 0, hi = 1) {
  return Math.min(hi, Math.max(lo, v));
}

function hexLeToDouble(hex16) {
  if (hex16.length !== 16) throw new Error(`Invalid hex chunk (${hex16.length} chars): "${hex16}"`);
  const buf = Buffer.from(hex16, 'hex');
  return buf.readDoubleLE(0);
}

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

function detectSubMode(hexLen) {
  for (const [key, def] of Object.entries(SUB_MODE)) {
    if (def.hexChars === hexLen) return key;
  }
  return null;
}

function parseHex(cleanHex, pointCount) {
  const yVals = [];
  for (let i = 0; i < pointCount; i++) {
    const chunk = cleanHex.substr(i * 16, 16);
    yVals.push(hexLeToDouble(chunk));
  }
  return yVals;
}

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

// ═══════════════════════════════════════════════════════════════
//  DEEP ANALYTICS ENGINE
// ═══════════════════════════════════════════════════════════════

/**
 * Full in-depth analytics from curve Y values and fixed X points.
 */
function deepAnalytics(fixedXPoints, yValues) {
  const n = yValues.length;

  // Deviation from identity (y = x)
  const deviations = yValues.map((y, i) => y - fixedXPoints[i]);
  const maxDev     = Math.max(...deviations.map(Math.abs));

  // Zone boundaries: shadows ~0-33%, midtones ~33-67%, highlights ~67-100%
  const s = Math.floor(n * 0.33);
  const h = Math.floor(n * 0.67);

  const avg = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

  const shadowLift    = avg(deviations.slice(0, s));
  const midtoneLift   = avg(deviations.slice(s, h));
  const highlightLift = avg(deviations.slice(h));

  // Midtone contrast: average slope in the midtone zone vs identity slope (1.0)
  const midSlopes = [];
  for (let i = s; i < h - 1; i++) {
    const dx = fixedXPoints[i + 1] - fixedXPoints[i];
    if (dx > 0) midSlopes.push((yValues[i + 1] - yValues[i]) / dx);
  }
  const contrastScore = midSlopes.length ? avg(midSlopes) : 1.0;

  // Output dynamic range
  const outputMin = Math.min(...yValues);
  const outputMax = Math.max(...yValues);
  const dynRange  = outputMax - outputMin;

  // Black/white point
  const blackClip   = yValues[0];
  const whiteClip   = yValues[n - 1];
  const blackCrushed = blackClip > 0.02;
  const whiteCrushed = whiteClip < 0.97;

  // Monotonicity violations (dips)
  let nonMonotonic = 0;
  for (let i = 0; i < n - 1; i++) {
    if (yValues[i + 1] < yValues[i] - 0.005) nonMonotonic++;
  }

  const midY = yValues[Math.floor(n / 2)];

  // Curve character label
  let character;
  if (maxDev < 0.01)                                           character = '≈ Linear';
  else if (shadowLift < -0.03 && highlightLift < -0.03)       character = '↓ Global Crush';
  else if (shadowLift >  0.03 && highlightLift >  0.03)       character = '↑ Global Lift';
  else if (shadowLift < -0.03 && highlightLift >  0.03)       character = 'S-Curve (Contrast+)';
  else if (shadowLift >  0.03 && highlightLift < -0.03)       character = 'Inverse-S (Contrast-)';
  else if (midtoneLift >  0.04)                                character = '↑ Midtone Lift';
  else if (midtoneLift < -0.04)                                character = '↓ Midtone Crush';
  else if (shadowLift >  0.03)                                 character = '↑ Shadow Lift';
  else if (highlightLift < -0.03)                              character = '↓ Highlight Roll-off';
  else if (midY > 0.52)                                        character = '↑ Slight Lift';
  else if (midY < 0.48)                                        character = '↓ Slight Crush';
  else                                                         character = '≈ Neutral';

  // Tonal balance label
  const diff = shadowLift - highlightLift;
  let balance;
  if (Math.abs(diff) < 0.02)   balance = 'Balanced';
  else if (diff >  0.05)        balance = 'Shadow-biased';
  else if (diff < -0.05)        balance = 'Highlight-biased';
  else if (shadowLift > 0)      balance = 'Slight shadow lift';
  else                          balance = 'Slight highlight pull';

  return {
    minY: outputMin, maxY: outputMax, midY, maxDev,
    shadowLift, midtoneLift, highlightLift,
    contrastScore, dynRange,
    blackClip, whiteClip, blackCrushed, whiteCrushed,
    nonMonotonic, character, balance,
  };
}

function fmtDev(v) {
  return (v >= 0 ? '+' : '') + v.toFixed(4);
}

/** Analytics caption for /preview */
function buildAnalyticsCaption(def, yValues, cleanHex) {
  const a = deepAnalytics(def.fixedXPoints, yValues);

  const cLabel = a.contrastScore > 1.08 ? '⬆ High'
               : a.contrastScore < 0.92 ? '⬇ Low'
               : '➡ Neutral';

  const warnings = [];
  if (a.blackCrushed)  warnings.push(`  ⚠️ Blacks lifted  (+${a.blackClip.toFixed(4)})`);
  if (a.whiteCrushed)  warnings.push(`  ⚠️ Whites pulled  (${a.whiteClip.toFixed(4)})`);
  if (a.nonMonotonic)  warnings.push(`  ⚠️ Non-monotonic: ${a.nonMonotonic} dip(s)`);

  return [
    `${def.emoji} <b>${def.name} Curve Preview</b>`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    `<b>Type:</b> ${def.name}  |  <b>Points:</b> ${def.pointCount}  |  <b>Hex:</b> ${cleanHex.length} chars`,
    ``,
    `<b>🎯 Character</b>`,
    `  Shape:   <code>${a.character}</code>`,
    `  Balance: <code>${a.balance}</code>`,
    ``,
    `<b>📊 Zone Deviation from Identity</b>`,
    `  Shadows:    <code>${fmtDev(a.shadowLift)}</code>`,
    `  Midtones:   <code>${fmtDev(a.midtoneLift)}</code>`,
    `  Highlights: <code>${fmtDev(a.highlightLift)}</code>`,
    ``,
    `<b>⚡ Contrast &amp; Range</b>`,
    `  Mid-slope:  <code>${a.contrastScore.toFixed(3)}</code>  ${cLabel}`,
    `  Dyn. range: <code>${(a.dynRange * 100).toFixed(1)}%</code>  of full scale`,
    ``,
    `<b>🔑 Key Points</b>`,
    `  Black: <code>${a.blackClip.toFixed(4)}</code>  |  White: <code>${a.whiteClip.toFixed(4)}</code>`,
    `  Mid:   <code>${a.midY.toFixed(4)}</code>  |  Max dev: <code>${a.maxDev.toFixed(4)}</code>`,
    ...(warnings.length ? [``, `<b>⚠️ Warnings</b>`, ...warnings] : []),
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    `🔧 <i>RCE – Rifanda Curve Editor v1.1</i>`,
  ].join('\n');
}

/** Compare caption for /compare */
function buildCompareCaption(def, yA, yB) {
  const a = deepAnalytics(def.fixedXPoints, yA);
  const b = deepAnalytics(def.fixedXPoints, yB);

  const diffs     = yA.map((v, i) => Math.abs(v - yB[i]));
  const avgDiff   = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const maxDiff   = Math.max(...diffs);
  const simPct    = (100 - avgDiff * 100).toFixed(1);

  const brighter  = a.midY > b.midY ? 'A' : b.midY > a.midY ? 'B' : '≈';
  const moreContr = a.contrastScore > b.contrastScore ? 'A'
                  : b.contrastScore > a.contrastScore ? 'B' : '≈';

  const delta = (va, vb) => {
    const d = vb - va;
    if (Math.abs(d) < 0.0005) return '≈';
    return (d > 0 ? '+' : '') + d.toFixed(4);
  };

  return [
    `🆚 <b>${def.name} Curve Comparison</b>`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    `<b>🎯 Character</b>`,
    `  A: <code>${a.character}</code>`,
    `  B: <code>${b.character}</code>`,
    ``,
    `<b>📊 Zone Deviation (A → B delta)</b>`,
    `  Shadows:    A <code>${fmtDev(a.shadowLift)}</code>  B <code>${fmtDev(b.shadowLift)}</code>  Δ <code>${delta(a.shadowLift, b.shadowLift)}</code>`,
    `  Midtones:   A <code>${fmtDev(a.midtoneLift)}</code>  B <code>${fmtDev(b.midtoneLift)}</code>  Δ <code>${delta(a.midtoneLift, b.midtoneLift)}</code>`,
    `  Highlights: A <code>${fmtDev(a.highlightLift)}</code>  B <code>${fmtDev(b.highlightLift)}</code>  Δ <code>${delta(a.highlightLift, b.highlightLift)}</code>`,
    ``,
    `<b>⚡ Contrast &amp; Brightness</b>`,
    `  Mid-slope: A <code>${a.contrastScore.toFixed(3)}</code>  B <code>${b.contrastScore.toFixed(3)}</code>`,
    `  Mid Y:     A <code>${a.midY.toFixed(4)}</code>  B <code>${b.midY.toFixed(4)}</code>`,
    `  Brighter: <b>${brighter}</b>   More contrast: <b>${moreContr}</b>`,
    ``,
    `<b>📐 Point-by-Point Difference</b>`,
    `  Avg Δ:      <code>${avgDiff.toFixed(4)}</code>`,
    `  Max Δ:      <code>${maxDiff.toFixed(4)}</code>`,
    `  Similarity: <code>${simPct}%</code>`,
    `━━━━━━━━━━━━━━━━━━━━━━━━`,
    `<i>A = ${def.emoji} ${def.name} (native color)  |  B = 🟠 orange curve</i>`,
    `🔧 <i>RCE – Rifanda Curve Editor v1.1</i>`,
  ].join('\n');
}

// ═══════════════════════════════════════════════════════════════
//  IMAGE GENERATION
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

function drawBase(ctx, W, H, PAD) {
  ctx.fillStyle = '#0f172a';
  ctx.fillRect(0, 0, W, H);

  for (let i = 0; i <= 16; i++) {
    const xi = PAD + (i / 16) * (W - 2 * PAD);
    const yi = PAD + (i / 16) * (H - 2 * PAD);
    const gridCol = i % 4 === 0 ? '#1e3a5f' : '#152236';
    drawLine(ctx, xi, PAD, xi, H - PAD, gridCol, 1);
    drawLine(ctx, PAD, yi, W - PAD, yi, gridCol, 1);
  }
  // Identity diagonal
  drawLine(ctx, PAD, H - PAD, W - PAD, PAD, '#e63946', 1);
}

function drawCurve(ctx, W, H, PAD, fixedXPoints, yValues, curveColor, glowColor, dotColor) {
  const N  = 512;
  const xd = Array.from({ length: N }, (_, i) => i / (N - 1));
  const yd = pchip(fixedXPoints, yValues, xd);

  const toCanvasX = x => PAD + x * (W - 2 * PAD);
  const toCanvasY = y => H - PAD - y * (H - 2 * PAD);

  // Glow
  ctx.globalAlpha = 0.30;
  ctx.strokeStyle = glowColor;
  ctx.lineWidth   = 9;
  ctx.beginPath();
  yd.forEach((y, i) => {
    const cx = toCanvasX(xd[i]), cy = toCanvasY(y);
    i === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy);
  });
  ctx.stroke();
  ctx.globalAlpha = 1.0;

  // Main line
  ctx.strokeStyle = curveColor;
  ctx.lineWidth   = 3;
  ctx.beginPath();
  yd.forEach((y, i) => {
    const cx = toCanvasX(xd[i]), cy = toCanvasY(y);
    i === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy);
  });
  ctx.stroke();

  // Control dots
  for (let i = 0; i < fixedXPoints.length; i++) {
    drawCircle(ctx, toCanvasX(fixedXPoints[i]), toCanvasY(yValues[i]), 5, '#ffffff');
    drawCircle(ctx, toCanvasX(fixedXPoints[i]), toCanvasY(yValues[i]), 3, dotColor);
  }
}

function drawBorders(ctx, W, H, PAD) {
  ctx.fillStyle = '#94a3b8';
  ctx.fillRect(PAD - 2, H - PAD - 2, 5, 5);
  ctx.fillRect(W - PAD - 3, PAD - 3, 5, 5);
  ctx.strokeStyle = '#1e3a5f'; ctx.lineWidth = 2;
  ctx.strokeRect(PAD, PAD, W - 2 * PAD, H - 2 * PAD);
  ctx.strokeStyle = '#1e2d3d'; ctx.lineWidth = 3;
  ctx.strokeRect(1, 1, W - 2, H - 2);
}

function encodePNG(img) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = new PassThrough();
    stream.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    stream.on('end',  () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
    PImage.encodePNGToStream(img, stream).catch(reject);
  });
}

async function generateCurveImage(subModeKey, yValues) {
  const W = CANVAS_SIZE, H = CANVAS_SIZE, PAD = 24;
  const def = SUB_MODE[subModeKey];
  const img = PImage.make(W, H);
  const ctx = img.getContext('2d');

  drawBase(ctx, W, H, PAD);
  drawCurve(ctx, W, H, PAD, def.fixedXPoints, yValues,
            def.curveColor, def.glowColor, def.dotColor);
  drawBorders(ctx, W, H, PAD);

  return encodePNG(img);
}

async function generateCompareImage(subModeKey, yValuesA, yValuesB) {
  const W = CANVAS_SIZE, H = CANVAS_SIZE, PAD = 24;
  const def = SUB_MODE[subModeKey];
  const img = PImage.make(W, H);
  const ctx = img.getContext('2d');

  drawBase(ctx, W, H, PAD);
  // Curve A — submode's native color
  drawCurve(ctx, W, H, PAD, def.fixedXPoints, yValuesA,
            def.curveColor, def.glowColor, def.dotColor);
  // Curve B — always orange so it's distinguishable
  drawCurve(ctx, W, H, PAD, def.fixedXPoints, yValuesB,
            '#f4a261', '#c2440f', '#ffd166');
  drawBorders(ctx, W, H, PAD);

  return encodePNG(img);
}

// ═══════════════════════════════════════════════════════════════
//  SHARED VALIDATION HELPER
// ═══════════════════════════════════════════════════════════════

function validateHex(raw) {
  if (!raw || !raw.trim()) return { ok: false, error: 'empty' };
  const cleanHex = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[0-9A-F]+$/.test(cleanHex)) return { ok: false, error: 'invalid_chars', cleanHex };
  const subModeKey = detectSubMode(cleanHex.length);
  if (!subModeKey) return { ok: false, error: 'unknown_length', cleanHex, len: cleanHex.length };
  const def = SUB_MODE[subModeKey];
  try {
    const yValues = parseHex(cleanHex, def.pointCount);
    return { ok: true, cleanHex, subModeKey, def, yValues };
  } catch (err) {
    return { ok: false, error: 'parse_error', message: err.message };
  }
}

function validLengthList() {
  return Object.values(SUB_MODE)
    .map(d => `• <code>${d.hexChars}</code> chars → ${d.emoji} <b>${d.name}</b> (${d.pointCount} pts)`)
    .join('\n');
}

function validationErrorMsg(v, label = 'Input') {
  if (v.error === 'empty')          return `${label} is empty.`;
  if (v.error === 'invalid_chars')  return `${label} has invalid characters. Only <code>0-9</code> and <code>A-F</code> are allowed.`;
  if (v.error === 'unknown_length') return `${label} has unrecognized length (<code>${v.len}</code> chars).\n\nValid lengths:\n${validLengthList()}`;
  return `${label} parse error: <code>${v.message}</code>`;
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
  if (!json.ok) console.error(`[Telegram] ${method} failed:`, JSON.stringify(json));
  return json;
}

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

async function sendPhoto(chatId, photoBuffer, caption, replyToMsgId = null) {
  const form = new FormData();
  form.append('chat_id',    String(chatId));
  form.append('caption',   caption);
  form.append('parse_mode', 'HTML');
  if (replyToMsgId) form.append('reply_to_message_id', String(replyToMsgId));
  form.append('photo', photoBuffer, {
    filename:    'curve_preview.png',
    contentType: 'image/png',
    knownLength: photoBuffer.length,
  });
  const resp = await fetch(`${TELEGRAM_API}/sendPhoto`, {
    method:  'POST',
    body:    form,
    headers: form.getHeaders(),
    timeout: 15000,
  });
  const json = await resp.json();
  if (!json.ok) console.error('[Telegram] sendPhoto failed:', JSON.stringify(json));
  return json;
}

// ═══════════════════════════════════════════════════════════════
//  COMMAND HANDLERS
// ═══════════════════════════════════════════════════════════════

async function handleStart(chatId, firstName, msgId) {
  const name = firstName ? ` ${firstName}` : '';
  const lines = [
    `🎨 <b>RCE Curve Preview Bot</b>`,
    `<i>Rifanda Curve Editor — GCam Parametric Preview</i>`,
    ``,
    `Hey${name}! 👋 Send your RCE hex string and I'll render a curve image with deep analytics.`,
    ``,
    `<b>📌 Commands</b>`,
    `<code>/preview &lt;hex&gt;</code>`,
    `  → Render a single curve with full analytics`,
    ``,
    `<code>/compare &lt;hexA&gt; | &lt;hexB&gt;</code>`,
    `  → Overlay &amp; compare two curves side-by-side`,
    `  → Both must be the same curve type (same length)`,
    ``,
    `<b>🔍 Curve types (auto-detected by hex length):</b>`,
    `• <code>272</code> chars → 🌊 <b>Tone</b> (17 pts)`,
    `• <code>528</code> chars → 📈 <b>Gamma</b> (33 pts)`,
    `• <code>112</code> chars → ☀️ <b>Sect</b> (7 pts)`,
    ``,
    `<b>💡 How to use:</b>`,
    `1. Open <b>RCE App</b> and set your curve`,
    `2. Copy the <i>Hex Joined</i> string from the table`,
    `3. Send: <code>/preview &lt;hex&gt;</code>`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━━━`,
    `🔗 <a href="https://t.me/portalgcam">Portal GCam</a>`,
  ];
  await sendMessage(chatId, lines.join('\n'), msgId, { disable_web_page_preview: true });
}

async function handlePreview(chatId, hexInput, msgId) {
  const v = validateHex(hexInput);
  if (!v.ok) {
    await sendMessage(chatId, `❌ <b>${validationErrorMsg(v)}</b>`, msgId);
    return;
  }

  const outOfRange = v.yValues.filter(y => y < -0.01 || y > 1.01);
  if (outOfRange.length > 0) {
    await sendMessage(chatId,
      `⚠️ <b>Warning:</b> ${outOfRange.length} Y value(s) out of [0, 1] range.\n` +
      `Possibly a mismatched submode or corrupted data.`, msgId);
  }

  await sendChatAction(chatId, 'upload_photo');

  let imgBuf;
  try {
    imgBuf = await generateCurveImage(v.subModeKey, v.yValues);
  } catch (err) {
    console.error('[generateCurveImage]', err);
    await sendMessage(chatId, `❌ <b>Image generation failed:</b>\n<code>${err.message}</code>`, msgId);
    return;
  }

  const caption = buildAnalyticsCaption(v.def, v.yValues, v.cleanHex);
  const result  = await sendPhoto(chatId, imgBuf, caption, msgId);
  if (!result.ok) {
    await sendMessage(chatId,
      `❌ <b>Failed to send photo:</b>\n<code>${result.description || 'Unknown error'}</code>`, msgId);
  }
}

async function handleCompare(chatId, argStr, msgId) {
  if (!argStr || !argStr.includes('|')) {
    await sendMessage(chatId,
      `❓ <b>Usage:</b>\n<code>/compare &lt;hexA&gt; | &lt;hexB&gt;</code>\n\n` +
      `Separate two hex strings with <code>|</code>.\n` +
      `Both must be the same curve type (same hex length).\n\n` +
      `<b>Example:</b>\n<code>/compare 000...A | 000...B</code>`, msgId);
    return;
  }

  const splitIdx = argStr.indexOf('|');
  const rawA = argStr.slice(0, splitIdx).trim();
  const rawB = argStr.slice(splitIdx + 1).trim();

  const vA = validateHex(rawA);
  const vB = validateHex(rawB);

  if (!vA.ok) {
    await sendMessage(chatId, `❌ <b>Curve A — ${validationErrorMsg(vA)}</b>`, msgId);
    return;
  }
  if (!vB.ok) {
    await sendMessage(chatId, `❌ <b>Curve B — ${validationErrorMsg(vB)}</b>`, msgId);
    return;
  }

  if (vA.subModeKey !== vB.subModeKey) {
    await sendMessage(chatId,
      `❌ <b>Curve type mismatch!</b>\n\n` +
      `Curve A: ${vA.def.emoji} <b>${vA.def.name}</b> (${vA.cleanHex.length} chars)\n` +
      `Curve B: ${vB.def.emoji} <b>${vB.def.name}</b> (${vB.cleanHex.length} chars)\n\n` +
      `Both curves must be the same type to compare.`, msgId);
    return;
  }

  await sendChatAction(chatId, 'upload_photo');

  let imgBuf;
  try {
    imgBuf = await generateCompareImage(vA.subModeKey, vA.yValues, vB.yValues);
  } catch (err) {
    console.error('[generateCompareImage]', err);
    await sendMessage(chatId, `❌ <b>Image generation failed:</b>\n<code>${err.message}</code>`, msgId);
    return;
  }

  const caption = buildCompareCaption(vA.def, vA.yValues, vB.yValues);
  const result  = await sendPhoto(chatId, imgBuf, caption, msgId);
  if (!result.ok) {
    await sendMessage(chatId,
      `❌ <b>Failed to send photo:</b>\n<code>${result.description || 'Unknown error'}</code>`, msgId);
  }
}

// ═══════════════════════════════════════════════════════════════
//  NETLIFY SERVERLESS HANDLER
// ═══════════════════════════════════════════════════════════════

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'text/plain' },
      body: '✅ RCE Curve Preview Bot is running!\n',
    };
  }

  let update;
  try {
    update = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 200, body: 'OK' };
  }

  const msg = update.message;
  if (!msg?.text) return { statusCode: 200, body: 'OK' };

  const chatId    = msg.chat.id;
  const msgId     = msg.message_id;
  const text      = (msg.text || '').trim();
  const firstName = msg.from?.first_name || '';

  const [rawCmd, ...args] = text.split(/\s+/);
  const command = rawCmd.split('@')[0].toLowerCase();
  const argStr  = args.join(' ');

  console.log(`[${chatId}] ${command} ${argStr.slice(0, 60)}`);

  try {
    switch (command) {
      case '/start':
      case '/help':
        await handleStart(chatId, firstName, msgId);
        break;
      case '/preview':
        await handlePreview(chatId, argStr, msgId);
        break;
      case '/compare':
        await handleCompare(chatId, argStr, msgId);
        break;
      default:
        if (command.startsWith('/')) {
          await sendMessage(chatId,
            `❓ Unknown command: <code>${command}</code>\n\nSend /start for help.`, msgId);
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
