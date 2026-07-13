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
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '';   // no hardcoded fallback

// Fail fast in production if critical secrets are missing — never boot a live
// deploy with insecure defaults (a guessable admin password or the shared JWT
// fallback). In development we warn but continue.
function requireProdSecrets() {
  if (process.env.NODE_ENV !== 'production') return;
  // JWT_SECRET is the only hard requirement — without it every token is signed
  // with a shared default (or empty), which is a real compromise. ADMIN_PASS is
  // optional: if it's unset we simply don't seed the env-admin (DB accounts are
  // the normal access path), so it can't take the deploy down.
  if (!process.env.JWT_SECRET) {
    console.error('🚨 Refusing to start in production — JWT_SECRET is not set. Set it and redeploy.');
    process.exit(1);
  }
  if (!process.env.ADMIN_PASS) {
    console.warn('ℹ️  ADMIN_PASS not set — the env-admin login is disabled (log in with a database account).');
  }
}

// ── Core middleware ────────────────────────────────────────────
app.set('trust proxy', 1);
app.disable('x-powered-by');
// Body size: 5mb is plenty for normal JSON. Only the routes that carry big
// base64 payloads (voice/image AI, bulk import) get the larger 25mb limit — and
// they must be registered BEFORE the global parser so they win for those paths.
app.use(['/api/ai', '/api/leads/import'], express.json({ limit: '25mb' }));
app.use(express.json({ limit: '5mb' }));

// Content-Security-Policy. The frontend uses inline event handlers / styles
// (so 'unsafe-inline' is required) plus a few pinned CDN deps: chart.js & xlsx
// (jsdelivr), leaflet & simplewebauthn (unpkg), Google Fonts. Map tiles and
// uploaded/base64 images come over https/data/blob.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://unpkg.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'self'",
  "base-uri 'self'",
].join('; ');

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), payment=(), usb=()');
  res.setHeader('Content-Security-Policy', CSP);
  next();
});

// Always revalidate the HTML shell so a new deploy's app.js?v=… / style.css?v=…
// references are picked up immediately (the JS/CSS themselves are cache-busted
// by their ?v= query). Without this a browser can keep serving an old index.html
// that points at a stale bundle.
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/index.html' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
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
app.use('/api', require('./routes/pay'));

// ── Global error handler (must be last) ───────────────────────
app.use(globalErrorHandler);

// ── Start ─────────────────────────────────────────────────────
async function startServer() {
  requireProdSecrets();
  await db.initSchema();
  // Only seed the env-admin when a password is actually configured — never seed
  // a default-password admin.
  if (ADMIN_PASS) await db.seedAdminUser(ADMIN_USER, ADMIN_PASS);

  httpServer.listen(PORT, () => {
    console.log(`\n🚀 Dive running at http://localhost:${PORT}`);
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
