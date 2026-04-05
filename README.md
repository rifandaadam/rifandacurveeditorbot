# 🎨 RCE Curve Preview Bot

**Telegram bot serverless** untuk [Rifanda Curve Editor (RCE)](https://t.me/portalgcam).  
User kirim hex → bot auto-detect tipe kurva → bot balas dengan foto kurva.

---

## ✨ Fitur

| Command | Fungsi |
|---------|--------|
| `/start` atau `/help` | Tampilkan panduan |
| `/preview <hex>` | Generate & kirim gambar preview kurva |

### Auto-detect tipe kurva dari panjang hex:

| Panjang Hex | Tipe | Titik | Keterangan |
|-------------|------|-------|------------|
| `272` chars | 🌊 **Tone** | 17 | GCam Tone Curve |
| `528` chars | 📈 **Gamma** | 33 | GCam Gamma Curve |
| `112` chars | ☀️ **Sect** | 7 | GCam Sect Curve |

---

## 🚀 Deploy ke Netlify

### 1. Clone & setup

```bash
git clone <repo-url>
cd rce-curve-bot
npm install
```

### 2. Buat Telegram Bot

1. Chat ke [@BotFather](https://t.me/BotFather) di Telegram
2. Kirim `/newbot`
3. Ikuti instruksi, dapatkan **BOT_TOKEN**

### 3. Deploy ke Netlify

**Via Netlify CLI:**
```bash
npm install -g netlify-cli
netlify init         # login & link ke Netlify
netlify deploy --prod
```

**Via GitHub (recommended):**
1. Push repo ke GitHub
2. Buka [app.netlify.com](https://app.netlify.com)
3. "Add new site" → "Import from Git"
4. Pilih repo ini

### 4. Set Environment Variable

Di Netlify Dashboard:
- **Site Settings → Environment Variables → Add variable**

```
TELEGRAM_BOT_TOKEN = 1234567890:ABCdef...  (dari BotFather)
```

### 5. Set Webhook

Buat file `.env`:
```env
TELEGRAM_BOT_TOKEN=1234567890:ABCdef...
NETLIFY_SITE_URL=https://your-site-name.netlify.app
```

Kemudian jalankan:
```bash
npm run setup-webhook
```

Output sukses:
```
✅  Webhook set successfully!
    URL           : https://your-site.netlify.app/.netlify/functions/bot
    Pending updates: 0
    Last error    : none

🤖  Test your bot by sending /start to it on Telegram!
```

---

## 🧪 Test Bot

1. Buka RCE App → set kurva sesuai keinginan
2. Di tabel bawah, copy kolom **Hex (64-bit LE)** → "Hex Joined" string
3. Kirim ke bot: `/preview 000000000000F03F...`
4. Bot akan balas dengan foto kurva + statistik

**Contoh hex Tone (default/linear):**
```
/preview 000000000000000000000000000080BF0000000000008ABF000000000000943F0000000000809E3F000000000000A03F0000000000A0A43F000000000000A83F000000000000AC3F000000000000B03F000000000000B43F000000000000B83F000000000000BC3F000000000000BE3F000000000000BF3F0000000000C0BF3F0000000000C0BF3F000000000000F03F
```

---

## 📁 Struktur Project

```
rce-curve-bot/
├── netlify/
│   └── functions/
│       └── bot.js          ← Main handler (webhook + image gen)
├── scripts/
│   └── set-webhook.js      ← Helper untuk set webhook Telegram
├── public/
│   └── index.html          ← Placeholder page
├── netlify.toml            ← Konfigurasi Netlify
├── package.json
└── README.md
```

---

## 🔧 Cara Kerja

```
User: /preview <hex>
         │
         ▼
   Netlify Function (bot.js)
         │
         ├─ Clean & validate hex
         ├─ Detect submode (Tone/Gamma/Sect) by hex length
         ├─ Parse hex chunks → Y values (float64 LE)
         ├─ PCHIP interpolate → smooth curve points
         ├─ Draw canvas 512×512 (pureimage):
         │   ├─ Dark background
         │   ├─ 16-division grid
         │   ├─ Red identity diagonal
         │   ├─ Glow + main curve line
         │   └─ Control point dots
         ├─ Encode PNG → Buffer
         └─ sendPhoto → Telegram
```

---

## 🛠 Dependencies

| Package | Versi | Fungsi |
|---------|-------|--------|
| `pureimage` | `^0.3.9` | Canvas rendering pure JS (no native deps) |
| `node-fetch` | `^2.7.0` | HTTP client (CommonJS compatible) |
| `form-data` | `^4.0.0` | Multipart form untuk sendPhoto |

---

## ⚙️ Menghapus Webhook

```bash
npm run delete-webhook
```

---

## 📄 License

MIT — Rifanda Adam / Portal GCam
