'use strict';

require('dotenv').config();
const http    = require('http');
const express = require('express');
const { Server } = require('socket.io');
const fs      = require('fs');
const path    = require('path');
const db      = require('./db');

const { globalErrorHandler } = require('./middleware/errors');
// Telegram integration is frozen — code archived under _archive/telegram.
// Set TELEGRAM_ENABLED=true (and restore the module) to bring it back.

const app        = express();
const httpServer = http.createServer(app);
const io         = new Server(httpServer);

const PORT = process.env.PORT || 3000;
const {
  ADMIN_USER = 'admin',
  ADMIN_PASS = 'admin123',
} = process.env;

// ── Core middleware ────────────────────────────────────────────
app.set('trust proxy', 1);
app.disable('x-powered-by');
// Large limit: voice notes are sent as base64 JSON (default 100kb rejects them)
app.use(express.json({ limit: '25mb' }));

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), payment=(), usb=()');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Health check ──────────────────────────────────────────────
app.get('/health', (_req, res) => res.status(200).send('OK'));

// ── Uploads ───────────────────────────────────────────────────
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use('/uploads', express.static(uploadsDir));

// ── Socket.IO — Live Agent Location ───────────────────────────
const agentLocations = {};
const AGENT_TTL_MS = 10 * 60 * 1000;

function pruneStaleAgents() {
  const cutoff = Date.now() - AGENT_TTL_MS;
  for (const [id, loc] of Object.entries(agentLocations)) {
    if (loc.ts < cutoff) delete agentLocations[id];
  }
}
setInterval(pruneStaleAgents, 60 * 1000).unref();

io.on('connection', (socket) => {
  pruneStaleAgents();
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

// ── Global error handler (must be last) ───────────────────────
app.use(globalErrorHandler);

// ── Start ─────────────────────────────────────────────────────
async function startServer() {
  await db.initSchema();
  await db.seedAdminUser(ADMIN_USER, ADMIN_PASS);

  httpServer.listen(PORT, () => {
    console.log(`\n🚀 SalesCRM running at http://localhost:${PORT}`);
    console.log(`   Database    : PostgreSQL`);
    console.log(`   Telegram    : ⏸ frozen (archived under _archive/telegram)`);
    if (!process.env.JWT_SECRET) console.warn('   ⚠️  JWT_SECRET is not set — using an insecure default. Set it in production!');
    if (!process.env.ADMIN_PASS) console.warn('   ⚠️  ADMIN_PASS is not set — the seeded admin uses the default password. Set it in production!');
  });
}

startServer().catch(err => {
  console.error('🚨 Failed to start:', err.message);
  process.exit(1);
});
