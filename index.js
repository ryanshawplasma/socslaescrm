'use strict';

require('dotenv').config();
const http    = require('http');
const express = require('express');
const { Server } = require('socket.io');
const fs      = require('fs');
const path    = require('path');
const axios   = require('axios');
const cache   = require('./cache');
const db      = require('./db');

const { globalErrorHandler } = require('./middleware/errors');
const { handleMessage, handleCallback, handleVoice, handlePhoto, startDailyBriefings } = require('./telegram/bot');

const app        = express();
const httpServer = http.createServer(app);
const io         = new Server(httpServer);

const PORT = process.env.PORT || 3000;
const {
  TELEGRAM_TOKEN,
  WEBHOOK_URL,
  ADMIN_USER = 'admin',
  ADMIN_PASS = 'admin123',
} = process.env;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ── Core middleware ────────────────────────────────────────────
app.set('trust proxy', 1);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Health check ──────────────────────────────────────────────
app.get('/health', (_req, res) => res.status(200).send('OK'));

// ── Uploads ───────────────────────────────────────────────────
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use('/uploads', express.static(uploadsDir));

// ── Socket.IO — Live Agent Location ───────────────────────────
const agentLocations = {};
io.on('connection', (socket) => {
  if (Object.keys(agentLocations).length) socket.emit('agents-snapshot', agentLocations);
  socket.on('update-agent-location', ({ agentId, lat, lng, name, accuracy }) => {
    if (!agentId || lat == null || lng == null) return;
    agentLocations[agentId] = { agentId, lat, lng, name: name || agentId, accuracy: accuracy || 0, ts: Date.now() };
    io.emit('agent-moved', agentLocations[agentId]);
  });
});

// ── Routes ────────────────────────────────────────────────────
app.use('/api', require('./routes/auth'));
app.use('/api', require('./routes/leads'));
app.use('/api', require('./routes/teams'));
app.use('/api', require('./routes/users'));
app.use('/api', require('./routes/ai'));

// ── Telegram webhook ──────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');
  try {
    const update = req.body;
    const uidKey = 'uid_' + String(update.update_id);
    if (cache.get(uidKey)) return;
    cache.put(uidKey, '1', 300);
    if (update.callback_query)       await handleCallback(update.callback_query);
    else if (update.message?.voice)  await handleVoice(update.message);
    else if (update.message?.photo)  await handlePhoto(update.message);
    else if (update.message?.text)   await handleMessage(update.message);
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

// ── Webhook setup helper ──────────────────────────────────────
app.get('/setup', async (req, res) => {
  if (!TELEGRAM_TOKEN || !WEBHOOK_URL) return res.status(400).json({ error: 'TELEGRAM_TOKEN or WEBHOOK_URL not set' });
  try {
    await axios.get(`${TELEGRAM_API}/deleteWebhook?drop_pending_updates=true`);
    const set = await axios.post(`${TELEGRAM_API}/setWebhook`, { url: `${WEBHOOK_URL}/webhook` });
    res.json({ status: '✅ Webhook set', ok: set.data.ok, description: set.data.description });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Global error handler (must be last) ───────────────────────
app.use(globalErrorHandler);

// ── Long-poll fallback ────────────────────────────────────────
function usePolling() {
  return !WEBHOOK_URL || WEBHOOK_URL.includes('your-domain');
}

async function startPolling() {
  try { await axios.get(`${TELEGRAM_API}/deleteWebhook?drop_pending_updates=true`, { timeout: 5000 }); } catch (_) {}
  console.log('   Bot status  : 🟢 Listening via long-poll\n');
  let offset = 0, backoff = 3000;
  while (true) {
    try {
      const res = await axios.get(`${TELEGRAM_API}/getUpdates`, {
        params: { offset, timeout: 10, allowed_updates: ['message', 'callback_query'] },
        timeout: 15000,
      });
      backoff = 3000;
      for (const update of (res.data.result || [])) {
        offset = update.update_id + 1;
        try {
          if (update.callback_query)       await handleCallback(update.callback_query);
          else if (update.message?.voice)  await handleVoice(update.message);
          else if (update.message?.photo)  await handlePhoto(update.message);
          else if (update.message?.text)   await handleMessage(update.message);
        } catch (err) { console.error('Poll update error:', err.message); }
      }
    } catch (err) {
      const msg = err.message || '';
      if (!msg.includes('ENOTFOUND') && !msg.includes('ECONNRESET') && !msg.includes('ECONNABORTED')) console.error('Poll error:', msg);
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60000);
    }
  }
}

// ── Start ─────────────────────────────────────────────────────
async function startServer() {
  await db.initSchema();
  await db.seedAdminUser(ADMIN_USER, ADMIN_PASS);

  httpServer.listen(PORT, () => {
    console.log(`\n🚀 SalesCRM running at http://localhost:${PORT}`);
    console.log(`   Database    : PostgreSQL (Aiven)`);
    console.log(`   Admin login : ${ADMIN_USER} / ${ADMIN_PASS}`);
    startDailyBriefings();
    if (usePolling()) {
      console.log('   Mode        : POLLING (no webhook URL set)');
      startPolling();
    } else {
      console.log(`   Webhook     : POST /webhook`);
      console.log(`   Setup       : GET  /setup\n`);
    }
  });
}

startServer().catch(err => {
  console.error('🚨 Failed to start:', err.message);
  process.exit(1);
});
