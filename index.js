require('dotenv').config();
const http       = require('http');
const express    = require('express');
const { Server } = require('socket.io');
const axios      = require('axios');
const crypto     = require('crypto');
const fs         = require('fs');
const { v4: uuidv4 } = require('uuid');
const path       = require('path');
const jwt        = require('jsonwebtoken');
const rateLimit  = require('express-rate-limit');
const cache      = require('./cache');
const db         = require('./db');
const { pool }   = db;
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const app        = express();
const httpServer = http.createServer(app);
const io         = new Server(httpServer);

app.set('trust proxy', 1); // trust Render/Cloudflare proxy for req.ip
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (_req, res) => res.status(200).send('OK'));

// ============================================================
//  SOCKET.IO — Live Agent Location Relay
// ============================================================
const agentLocations = {};

io.on('connection', (socket) => {
  // Send existing positions snapshot to new dashboard client
  if (Object.keys(agentLocations).length) {
    socket.emit('agents-snapshot', agentLocations);
  }

  socket.on('update-agent-location', ({ agentId, lat, lng, name, accuracy }) => {
    if (!agentId || lat == null || lng == null) return;
    agentLocations[agentId] = { agentId, lat, lng, name: name || agentId, accuracy: accuracy || 0, ts: Date.now() };
    io.emit('agent-moved', agentLocations[agentId]);
  });
});

// Serve uploaded factory photos
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use('/uploads', express.static(uploadsDir));

const {
  TELEGRAM_TOKEN,
  GEMINI_API_KEY,
  WEBHOOK_URL,
  PORT = 3000,
  ADMIN_USER = 'admin',
  ADMIN_PASS = 'admin123',
  SALES_USER = 'sales',
  SALES_PASS = 'sales123',
  JWT_SECRET = 'crm_default_secret_change_me',
} = process.env;

// ─── Rate limiters ─────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,   // 15 minutes
  limit: 15,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});
const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  message: { error: 'Too many reset requests. Try again in 1 hour.' },
});

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ============================================================
//  AUTH — JWT token sign / verify
// ============================================================
const ACCESS_TTL  = '15m';
const ACCESS_TTL_MS = 15 * 60 * 1000;

function signAccessToken(userId, username, role, sessionId) {
  return jwt.sign(
    { sub: String(userId), username, role, sid: sessionId, jti: uuidv4() },
    JWT_SECRET,
    { expiresIn: ACCESS_TTL }
  );
}

// Legacy token verifier (HMAC base64.sig format) — supports existing sessions during migration
function verifyLegacyToken(token) {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const b64     = token.slice(0, dot);
  const sig     = token.slice(dot + 1);
  let payload;
  try { payload = Buffer.from(b64, 'base64').toString(); } catch { return null; }
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('hex');
  if (sig !== expected) return null;
  const parts  = payload.split(':');
  if (parts.length < 3) return null;
  if (Date.now() > parseInt(parts[2], 10)) return null;
  return { username: parts[0], role: parts[1] };
}

function verifyAccessToken(token) {
  if (!token) return null;
  // Try JWT first
  try {
    const p = jwt.verify(token, JWT_SECRET);
    return { userId: p.sub, username: p.username, role: p.role, sessionId: p.sid };
  } catch {}
  // Fall back to legacy HMAC token (users who haven't re-logged-in yet)
  const legacy = verifyLegacyToken(token);
  if (legacy) return { userId: null, username: legacy.username, role: legacy.role, sessionId: null };
  return null;
}

// Keep signToken for backward compat (used by Telegram bot flow)
function signToken(username, role) {
  return signAccessToken(0, username, role, null);
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const user = verifyAccessToken(header.slice(7));
  if (!user) return res.status(401).json({ error: 'token_expired' });
  req.user = user;
  next();
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// Helper: get request IP
function getIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
}

// ============================================================
//  AUTH ENDPOINTS
// ============================================================

// POST /api/auth/login  — main login (rate-limited)
app.post(['/api/auth/login', '/api/login'], loginLimiter, async (req, res) => {
  const { credential, username, password, pin, fingerprint, trustDevice, deviceMeta } = req.body || {};
  const cred   = (credential || username || '').trim();
  const secret = (password  || pin      || '').trim();
  const ip     = getIP(req);
  const ua     = req.headers['user-agent'] || '';

  if (!cred || !secret) return res.status(400).json({ error: 'Credential and password/PIN are required' });

  try {
    // ── Env-based admin/sales login (legacy fallback) ────────
    if ((cred === ADMIN_USER && secret === ADMIN_PASS) || (cred === SALES_USER && secret === SALES_PASS)) {
      const role     = cred === ADMIN_USER ? 'admin' : 'sales';
      const dbUser   = await db.getUserByCredential(cred);
      const userId   = dbUser?.id || 0;
      let   deviceId = null;
      let   session  = null;
      if (userId) {
        session  = await db.createSession(userId, null, ip, ua);
        deviceId = session.id; // use session as proxy device for env users
      }
      const sessionId = session?.id || uuidv4();
      const token     = signAccessToken(userId, cred, role, sessionId);
      const refresh   = session ? await db.issueRefreshToken(session.id) : null;
      if (userId) await db.logSecurity(userId, 'login_success', { method: 'env' }, ip, ua, session?.id, null);
      return res.json({ token, accessToken: token, refreshToken: refresh, role, username: cred,
        userId, sessionId, deviceId, deviceTrusted: false, hasPIN: false, teams: [] });
    }

    // ── DB user lookup ───────────────────────────────────────
    const user = await db.getUserByCredential(cred);
    if (!user) {
      await db.logSecurity(null, 'login_failed', { credential: cred, reason: 'user_not_found' }, ip, ua, null, null);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Lockout check
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(423).json({ error: `Account locked. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.` });
    }

    // Verify PIN / password
    const valid = await db.verifyUserPin(user.display_name, secret);
    if (!valid) {
      await db.incrementFailedAttempts(user.id);
      await db.logSecurity(user.id, 'login_failed', { reason: 'wrong_pin' }, ip, ua, null, null);
      const updated = await db.getUserByCredential(cred);
      const attempts = updated?.failed_attempts || 0;
      const attemptsLeft = Math.max(0, 5 - attempts);
      return res.status(401).json({
        error: attemptsLeft > 0
          ? `Invalid credentials. ${attemptsLeft} attempt${attemptsLeft !== 1 ? 's' : ''} remaining.`
          : 'Account locked for 15 minutes due to too many failed attempts.',
      });
    }

    await db.resetFailedAttempts(user.id);

    // ── Device trust ─────────────────────────────────────────
    let device = null;
    if (fingerprint) device = await db.getDeviceByFingerprint(user.id, fingerprint);
    if (!device && trustDevice && fingerprint) {
      device = await db.trustDevice(user.id, fingerprint, {
        name:    deviceMeta?.name    || parseDeviceName(ua),
        browser: deviceMeta?.browser || parseBrowser(ua),
        os:      deviceMeta?.os      || parseOS(ua),
        type:    deviceMeta?.type    || 'unknown',
        ip,
      });
    }
    if (device) await db.touchDevice(device.id);

    // ── Create session + tokens ───────────────────────────────
    const session     = await db.createSession(user.id, device?.id || null, ip, ua);
    const accessToken = signAccessToken(user.id, user.display_name, user.role, session.id);
    const refreshToken = await db.issueRefreshToken(session.id);
    const hasPIN      = device ? await db.hasDevicePin(user.id, device.id) : false;
    const teams       = await db.getUserTeams(user.id);

    await db.logSecurity(user.id, 'login_success', { device: device?.device_name }, ip, ua, session.id, device?.id);

    res.json({
      token: accessToken,      // backward compat field
      accessToken,
      refreshToken,
      role:          user.role,
      username:      user.display_name,
      userId:        user.id,
      sessionId:     session.id,
      deviceId:      device?.id || null,
      deviceTrusted: !!device,
      hasPIN,
      teams,
    });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /api/auth/refresh — rotate refresh token, issue new access token
app.post('/api/auth/refresh', async (req, res) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
  try {
    const { sessionId, newRaw } = await db.rotateRefreshToken(refreshToken);
    const session = await db.getSessionById(sessionId);
    if (!session || session.revoked) return res.status(401).json({ error: 'Session revoked' });
    const user = await db.getUserByName(session.user_id ?
      (await pool.query('SELECT display_name FROM users WHERE id=$1', [session.user_id])).rows[0]?.display_name
      : '') || {};
    // Resolve username from session
    const { rows: [u] } = await pool.query('SELECT * FROM users WHERE id=$1', [session.user_id]);
    if (!u) return res.status(401).json({ error: 'User not found' });
    const accessToken = signAccessToken(u.id, u.display_name, u.role, sessionId);
    res.json({ accessToken, refreshToken: newRaw, username: u.display_name, role: u.role });
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message });
  }
});

// POST /api/auth/logout — revoke current session
app.post('/api/auth/logout', authMiddleware, async (req, res) => {
  const { sessionId } = req.user;
  if (sessionId) {
    await db.revokeSession(sessionId);
    await db.logSecurity(req.user.userId ? parseInt(req.user.userId) : null,
      'logout', {}, getIP(req), req.headers['user-agent'] || '', sessionId, null);
  }
  res.json({ success: true });
});

// POST /api/auth/logout-all — revoke all user sessions
app.post('/api/auth/logout-all', authMiddleware, async (req, res) => {
  const user = await db.getUserByName(req.user.username);
  if (user) {
    await db.revokeAllUserSessions(user.id, req.user.sessionId || null);
    await db.logSecurity(user.id, 'logout_all', {}, getIP(req), req.headers['user-agent'] || '', req.user.sessionId, null);
  }
  res.json({ success: true });
});

// POST /api/auth/pin-setup — set a quick-unlock PIN for this device
app.post('/api/auth/pin-setup', authMiddleware, async (req, res) => {
  const { pin, deviceId } = req.body || {};
  if (!pin || !/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be 4–6 digits' });
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  const user = await db.getUserByName(req.user.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const device = await db.getDeviceById(deviceId, user.id);
  if (!device) return res.status(404).json({ error: 'Device not found or not trusted' });
  await db.setupDevicePin(user.id, device.id, pin);
  await db.logSecurity(user.id, 'pin_created', { device: device.device_name },
    getIP(req), req.headers['user-agent'] || '', req.user.sessionId, device.id);
  res.json({ success: true });
});

// POST /api/auth/pin-unlock — verify device PIN, return new access token
app.post('/api/auth/pin-unlock', async (req, res) => {
  const { refreshToken, pin, deviceId } = req.body || {};
  if (!refreshToken || !pin || !deviceId) return res.status(400).json({ error: 'refreshToken, pin, and deviceId required' });
  try {
    // Validate refresh token to know which user this is
    const { sessionId, newRaw } = await db.rotateRefreshToken(refreshToken);
    const session = await db.getSessionById(sessionId);
    if (!session || session.revoked) return res.status(401).json({ error: 'Session invalid' });
    const { rows: [u] } = await pool.query('SELECT * FROM users WHERE id=$1', [session.user_id]);
    if (!u) return res.status(401).json({ error: 'User not found' });
    // Verify device PIN
    const result = await db.verifyDevicePin(u.id, deviceId, pin);
    if (!result.ok) {
      if (result.reason === 'locked')
        return res.status(423).json({ error: 'PIN locked. Use password to log in.' });
      if (result.reason === 'no_pin')
        return res.status(404).json({ error: 'No PIN set for this device' });
      await db.logSecurity(u.id, 'pin_failed', { attemptsLeft: result.attemptsLeft },
        getIP(req), req.headers['user-agent'] || '', sessionId, deviceId);
      return res.status(401).json({ error: `Wrong PIN. ${result.attemptsLeft} attempt${result.attemptsLeft !== 1 ? 's' : ''} remaining.` });
    }
    const accessToken = signAccessToken(u.id, u.display_name, u.role, sessionId);
    await db.logSecurity(u.id, 'pin_unlock', {}, getIP(req), req.headers['user-agent'] || '', sessionId, deviceId);
    res.json({ accessToken, refreshToken: newRaw, username: u.display_name, role: u.role, userId: u.id });
  } catch (err) {
    res.status(err.status || 401).json({ error: err.message });
  }
});

// POST /api/auth/pin-check — does this device have a PIN set? (needs refreshToken to identify user)
app.post('/api/auth/pin-check', async (req, res) => {
  const { refreshToken, deviceId } = req.body || {};
  if (!refreshToken || !deviceId) return res.json({ hasPIN: false });
  try {
    // Peek at the session without consuming the token
    const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
    const { rows: [rt] } = await pool.query(
      `SELECT rt.session_id, s.user_id FROM refresh_tokens rt
       JOIN sessions s ON s.id = rt.session_id
       WHERE rt.token_hash=$1 AND NOT rt.used AND rt.expires_at > NOW() AND NOT s.revoked`, [hash]
    );
    if (!rt) return res.json({ hasPIN: false });
    const hasPIN = await db.hasDevicePin(rt.user_id, deviceId);
    const { rows: [u] } = await pool.query('SELECT display_name FROM users WHERE id=$1', [rt.user_id]);
    res.json({ hasPIN, username: u?.display_name || '' });
  } catch {
    res.json({ hasPIN: false });
  }
});

// DELETE /api/auth/pin — remove device PIN
app.delete('/api/auth/pin', authMiddleware, async (req, res) => {
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  const user = await db.getUserByName(req.user.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  await pool.query(`DELETE FROM device_pins WHERE user_id=$1 AND device_id=$2`, [user.id, deviceId]);
  res.json({ success: true });
});

// GET /api/sessions — list all active sessions
app.get('/api/sessions', authMiddleware, async (req, res) => {
  const user = await db.getUserByName(req.user.username);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const sessions = await db.listUserSessions(user.id);
  res.json(sessions.map(s => ({ ...s, current: s.id === req.user.sessionId })));
});

// DELETE /api/sessions/:id — revoke one session
app.delete('/api/sessions/:id', authMiddleware, async (req, res) => {
  const user = await db.getUserByName(req.user.username);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const session = await db.getSessionById(req.params.id);
  if (!session || session.user_id !== user.id) return res.status(404).json({ error: 'Session not found' });
  await db.revokeSession(req.params.id);
  await db.logSecurity(user.id, 'session_revoked', { sessionId: req.params.id },
    getIP(req), req.headers['user-agent'] || '', req.user.sessionId, null);
  res.json({ success: true });
});

// DELETE /api/sessions — revoke all sessions except current
app.delete('/api/sessions', authMiddleware, async (req, res) => {
  const user = await db.getUserByName(req.user.username);
  if (!user) return res.status(404).json({ error: 'Not found' });
  await db.revokeAllUserSessions(user.id, req.user.sessionId);
  await db.logSecurity(user.id, 'logout_all_others', {}, getIP(req), req.headers['user-agent'] || '', req.user.sessionId, null);
  res.json({ success: true });
});

// GET /api/devices — list trusted devices
app.get('/api/devices', authMiddleware, async (req, res) => {
  const user = await db.getUserByName(req.user.username);
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json(await db.listUserDevices(user.id));
});

// PATCH /api/devices/:id — rename a device
app.patch('/api/devices/:id', authMiddleware, async (req, res) => {
  const { name } = req.body || {};
  if (!name || name.trim().length < 1) return res.status(400).json({ error: 'Name required' });
  const user = await db.getUserByName(req.user.username);
  if (!user) return res.status(404).json({ error: 'Not found' });
  await db.renameDevice(req.params.id, user.id, name.trim());
  res.json({ success: true });
});

// DELETE /api/devices/:id — remove a trusted device (revokes its sessions + PIN)
app.delete('/api/devices/:id', authMiddleware, async (req, res) => {
  const user = await db.getUserByName(req.user.username);
  if (!user) return res.status(404).json({ error: 'Not found' });
  await db.removeDevice(req.params.id, user.id);
  // Also revoke active sessions that used this device
  await pool.query(`UPDATE sessions SET revoked=TRUE WHERE device_id=$1 AND user_id=$2`, [req.params.id, user.id]);
  await db.logSecurity(user.id, 'device_removed', { deviceId: req.params.id },
    getIP(req), req.headers['user-agent'] || '', req.user.sessionId, req.params.id);
  res.json({ success: true });
});

// GET /api/security-log — user's own security event log
app.get('/api/security-log', authMiddleware, async (req, res) => {
  const user = await db.getUserByName(req.user.username);
  if (!user) return res.status(404).json({ error: 'Not found' });
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  res.json(await db.getUserSecurityLog(user.id, limit));
});

// POST /api/auth/forgot-password — stub (log + inform admin)
app.post('/api/auth/forgot-password', resetLimiter, async (req, res) => {
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'Credential required' });
  const user = await db.getUserByCredential(credential.trim());
  if (user) {
    await db.logSecurity(user.id, 'reset_requested', { credential },
      getIP(req), req.headers['user-agent'] || '', null, null);
  }
  // Always return 200 — don't reveal if user exists
  res.json({ message: 'If that account exists, your admin can reset your PIN from Team → Reset PIN.' });
});

// ── UA helpers for device naming ──────────────────────────────
function parseBrowser(ua) {
  if (!ua) return 'Unknown';
  if (/Edg\//.test(ua))     return 'Edge';
  if (/OPR\//.test(ua))     return 'Opera';
  if (/Chrome\//.test(ua))  return 'Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua))  return 'Safari';
  return 'Browser';
}
function parseOS(ua) {
  if (!ua) return 'Unknown';
  if (/Windows NT 10/.test(ua))  return 'Windows 11/10';
  if (/Windows/.test(ua))        return 'Windows';
  if (/Android/.test(ua))        return 'Android';
  if (/iPhone|iPad/.test(ua))    return 'iOS';
  if (/Mac OS X/.test(ua))       return 'macOS';
  if (/Linux/.test(ua))          return 'Linux';
  return 'Unknown OS';
}
function parseDeviceName(ua) {
  const browser = parseBrowser(ua);
  const os      = parseOS(ua);
  return `${browser} on ${os}`;
}

// ============================================================
//  TELEGRAM WEBHOOK (no auth — Telegram calls this directly)
// ============================================================
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

// ============================================================
//  VOICE HANDLER
// ============================================================
async function handleVoice(message) {
  const chatId = message.chat.id;
  const fileId = message.voice.file_id;
  const telegramUserId = String(message.from?.id || chatId);
  const registeredUser = await db.getUserByTelegramId(telegramUserId);
  const createdBy = registeredUser ? registeredUser.display_name : '';

  await sendTelegram('sendMessage', { chat_id: chatId, text: '🎤 Processing your voice note...' });

  try {
    const fileRes   = await axios.get(`${TELEGRAM_API}/getFile`, { params: { file_id: fileId } });
    const filePath  = fileRes.data.result.file_path;
    const fileUrl   = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
    const audioRes  = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const audioBase64 = Buffer.from(audioRes.data).toString('base64');

    console.log(`🎤 Voice: ${(audioRes.data.byteLength / 1024).toFixed(1)} KB downloaded`);

    const parsed = await callGeminiWithAudio(audioBase64);
    if (!parsed) {
      await sendTelegram('sendMessage', {
        chat_id: chatId, parse_mode: 'HTML',
        text: '⚠️ Voice note could not be processed (quota or token limit reached). Try a <b>shorter voice note</b> or <b>type</b> the info instead.',
      });
      return;
    }

    const { existingRow, action } = await findExistingLead(parsed);
    if (!parsed.stage && action === 'ADD') { parsed.stage = 'New Lead'; parsed.stage_number = 1; }

    const uuid = uuidv4();
    cache.put('data_' + uuid, JSON.stringify({ parsed, existingRow, action, createdBy }), 600);

    await sendTelegram('sendMessage', {
      chat_id:      chatId,
      text:         '🎤 ' + buildPreview(parsed, action, existingRow),
      parse_mode:   'HTML',
      reply_markup: confirmEditKeyboard(uuid, parsed.lead_type),
    });
  } catch (err) {
    console.error('Voice handler error:', err.message);
    await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ Failed to process voice. Try sending as text.' });
  }
}

async function callGeminiWithAudio(audioBase64) {
  const voicePrompt = CRM_SYSTEM_PROMPT + '\n\nThe user sent a VOICE NOTE. First transcribe the audio, then extract CRM fields. Return ONLY the JSON.';
  for (const model of ['gemini-2.0-flash', 'gemini-2.0-flash-lite']) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const res = await axios.post(url, {
        system_instruction: { parts: [{ text: voicePrompt }] },
        contents: [{
          role: 'user',
          parts: [
            { inline_data: { mime_type: 'audio/ogg', data: audioBase64 } },
            { text: 'Transcribe and extract CRM lead data as JSON.' },
          ],
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 1500, responseMimeType: 'application/json' },
      });
      let raw = res.data.candidates[0].content.parts[0].text.trim()
        .replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/\s*```$/i,'').trim();
      console.log('✅ Voice parsed via', model);
      return JSON.parse(raw);
    } catch (err) {
      const code = err.response?.data?.error?.code;
      const errMsg = err.response?.data?.error?.message || '';
      if (code === 429 || code === 503 || errMsg.includes('RESOURCE_EXHAUSTED')) {
        console.warn(`⚠️ Gemini ${model} quota/rate limit for voice`); continue;
      }
      if (code === 400 && errMsg.toLowerCase().includes('token')) {
        console.warn(`⚠️ Gemini ${model} token limit hit for voice`); continue;
      }
      if (code === 404) { console.warn(`⚠️ Gemini ${model} unavailable (404) for voice`); continue; }
      console.error('Gemini voice error:', err.response?.data || err.message);
    }
  }
  return null;
}

// ============================================================
//  PHOTO HANDLER
// ============================================================
async function handlePhoto(message) {
  const chatId  = message.chat.id;
  const photos  = message.photo;
  const largest = photos[photos.length - 1];
  const fileId  = largest.file_id;
  const caption = message.caption || '';
  const telegramUserId = String(message.from?.id || chatId);
  const registeredUser = db.getUserByTelegramId(telegramUserId);

  const photoSession = cache.get('photo_for_' + chatId);
  if (photoSession) {
    const { leadId } = JSON.parse(photoSession);
    cache.remove('photo_for_' + chatId);
    await savePhotoForLead(chatId, fileId, leadId, caption, registeredUser?.display_name || '');
    return;
  }

  cache.put('photo_pending_' + chatId, JSON.stringify({ fileId, caption, uploadedBy: registeredUser?.display_name || '' }), 300);
  await sendTelegram('sendMessage', {
    chat_id: chatId,
    text: '📷 Photo received! Which factory is this for?\nSend factory number or name:',
  });
}

async function savePhotoForLead(chatId, fileId, leadId, caption, uploadedBy) {
  try {
    const fileRes  = await axios.get(`${TELEGRAM_API}/getFile`, { params: { file_id: fileId } });
    const filePath = fileRes.data.result.file_path;
    const fileUrl  = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
    const imgData  = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const fileName = `${leadId}_${Date.now()}.jpg`;
    fs.writeFileSync(path.join(uploadsDir, fileName), Buffer.from(imgData.data));
    await db.addPhoto(leadId, `/uploads/${fileName}`, caption, uploadedBy);
    await sendTelegram('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `✅ Photo saved for lead #${leadId}. View in dashboard.` });
  } catch (err) {
    console.error('Photo save error:', err.message);
    await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ Failed to save photo.' });
  }
}

// ============================================================
//  MESSAGE HANDLER
// ============================================================
const EDITALL_FIELDS = [
  { key: 'factory_number',   label: 'Factory #',       hint: 'e.g. M277' },
  { key: 'factory_name',     label: 'Factory Name',    hint: 'e.g. Ramesh Industries' },
  { key: 'person_in_charge', label: 'Person in Charge', hint: 'e.g. Rameshji' },
  { key: 'contact',          label: 'Contact #',       hint: '10-digit phone number' },
  { key: 'items',            label: 'Items',           hint: 'Hotmelt 500 120, Solvent 200 80\n(product quantity rate, comma-separated)' },
  { key: 'stage',            label: 'Stage',           hint: '1=New Lead 2=Sample Req 3=Sample Sent\n4=Quotation 5=Negotiation 6=Won 7=Repeat 0=Lost' },
  { key: 'follow_up',        label: 'Follow-up Date',  hint: 'dd/MM/yyyy or "next week", "tomorrow"' },
  { key: 'area',             label: 'Area',            hint: 'e.g. Mumbai, Surat, Bhiwandi' },
  { key: 'notes',            label: 'Notes',           hint: 'Any additional notes' },
  { key: 'lead_type',        label: 'Lead Type',       hint: 'hot / warm / cold' },
];

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text   = message.text.trim();
  const telegramUserId = String(message.from?.id || chatId);

  // ── Registration session ──
  const registerSession = cache.get('register_' + chatId);
  if (registerSession) {
    const sess = JSON.parse(registerSession);
    if (sess.step === 0) {
      const name = text.trim();
      if (name.length < 2) {
        await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ Name too short. Try again:' });
        return;
      }
      cache.put('register_' + chatId, JSON.stringify({ step: 1, name }), 300);
      await sendTelegram('sendMessage', { chat_id: chatId, text: `👍 Hi ${name}! Now set a 4-6 digit PIN:` });
      return;
    }
    if (sess.step === 1) {
      const pin = text.trim();
      if (!/^\d{4,6}$/.test(pin)) {
        await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ PIN must be 4-6 digits only. Try again:' });
        return;
      }
      const result = await db.createUser(sess.name, pin, 'sales', telegramUserId);
      cache.remove('register_' + chatId);
      if (!result.ok) {
        await sendTelegram('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `⚠️ ${esc(result.message)}\n\nUse /register to try a different name.` });
      } else {
        await sendTelegram('sendMessage', {
          chat_id: chatId, parse_mode: 'HTML',
          text: `✅ <b>Registered as ${esc(sess.name)}!</b>\n\nLog into the dashboard with:\n• Name: <b>${esc(sess.name)}</b>\n• PIN: <b>${pin}</b>\n\nYour leads will be tagged with your name. 🎉`,
        });
      }
      return;
    }
  }

  // ── Change PIN session ──
  const changePinSession = cache.get('changepin_' + chatId);
  if (changePinSession) {
    const pin = text.trim();
    if (!/^\d{4,6}$/.test(pin)) {
      await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ PIN must be 4-6 digits. Try again:' });
      return;
    }
    const { userId } = JSON.parse(changePinSession);
    await db.updateUserPin(userId, pin);
    cache.remove('changepin_' + chatId);
    await sendTelegram('sendMessage', { chat_id: chatId, text: '✅ PIN updated successfully!' });
    return;
  }

  // ── Edit All session ──
  const editAllSession = cache.get('editall_' + chatId);
  if (editAllSession) {
    const sess = JSON.parse(editAllSession);
    const { uuid, fieldIndex } = sess;
    const cached = cache.get('data_' + uuid);
    if (!cached) { cache.remove('editall_' + chatId); return; }
    const data = JSON.parse(cached);

    const field = EDITALL_FIELDS[fieldIndex];
    if (text !== '.') {
      if (field.key === 'items') {
        const items = parseItemsText(text);
        if (items.length) {
          data.parsed.items = items;
          data.parsed.product  = items[0].product;
          data.parsed.quantity = items[0].quantity;
          data.parsed.rate     = items[0].rate;
        }
      } else if (field.key === 'stage') {
        const stageResult = parseStageInput(text);
        data.parsed.stage        = stageResult.stage;
        data.parsed.stage_number = stageResult.stage_number;
      } else if (field.key === 'follow_up') {
        data.parsed.follow_up = parseDateInput(text);
      } else if (field.key === 'lead_type') {
        const tl = text.toLowerCase();
        data.parsed.lead_type = tl.includes('hot') ? 'Hot' : tl.includes('warm') ? 'Warm' : tl.includes('cold') ? 'Cold' : data.parsed.lead_type;
      } else {
        data.parsed[field.key] = text;
      }
    }

    cache.put('data_' + uuid, JSON.stringify(data), 600);

    const nextIndex = fieldIndex + 1;
    if (nextIndex < EDITALL_FIELDS.length) {
      cache.put('editall_' + chatId, JSON.stringify({ uuid, fieldIndex: nextIndex }), 600);
      await sendEditAllFieldPrompt(chatId, data.parsed, nextIndex);
    } else {
      cache.remove('editall_' + chatId);
      await sendTelegram('sendMessage', {
        chat_id:      chatId,
        text:         '✅ All fields done! Review and confirm:\n\n' + buildPreview(data.parsed, data.action, data.existingRow),
        parse_mode:   'HTML',
        reply_markup: confirmEditKeyboard(uuid, data.parsed.lead_type),
      });
    }
    return;
  }

  // ── Custom follow-up date session ──
  const fuCustomSession = cache.get('fudate_custom_' + chatId);
  if (fuCustomSession) {
    const { fuUuid, rowIndex, messageId: fuMsgId } = JSON.parse(fuCustomSession);
    cache.remove('fudate_custom_' + chatId);
    const dateStr = parseDateInput(text);
    await db.updateLead(rowIndex, { follow_up: dateStr });
    await sendTelegram('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `✅ Follow-up set: <b>${esc(dateStr)}</b>` });
    try { await sendTelegram('editMessageText', { chat_id: chatId, message_id: fuMsgId, text: `✅ Follow-up set: <b>${esc(dateStr)}</b>`, parse_mode: 'HTML' }); } catch (_) {}
    cache.remove('fudate_' + fuUuid);
    // Broadcast to team (bid system) for Hot/Warm leads
    { const _leads = await db.getLeads(); const fl = _leads.find(l => l.rowIndex === String(rowIndex)); if (fl && ['Hot','Warm'].includes(fl.lead_type)) broadcastFollowUpAvailable(rowIndex, dateStr).catch(() => {}); }
    return;
  }

  // ── Photo pending session ──
  const photoPendingSession = cache.get('photo_pending_' + chatId);
  if (photoPendingSession) {
    const { fileId, caption, uploadedBy } = JSON.parse(photoPendingSession);
    const leads = await db.getLeads();
    const q     = text.toLowerCase();
    const found = leads.find(l =>
      String(l.factory_number || '').toLowerCase() === q ||
      String(l.factory_name   || '').toLowerCase().includes(q)
    );
    if (!found) {
      await sendTelegram('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `🔍 No lead found for "<b>${esc(text)}</b>". Try factory number (e.g. M277):` });
      return;
    }
    cache.remove('photo_pending_' + chatId);
    await savePhotoForLead(chatId, fileId, Number(found.rowIndex), caption, uploadedBy);
    return;
  }

  // ── Field edit session ──
  const editSession = cache.get('edit_' + chatId);
  if (editSession) {
    const { uuid, field, messageId } = JSON.parse(editSession);
    cache.remove('edit_' + chatId);
    const cached = cache.get('data_' + uuid);
    if (cached) {
      const data = JSON.parse(cached);
      data.parsed[field] = text;
      if (field === 'stage') {
        const sr = parseStageInput(text);
        data.parsed.stage        = sr.stage;
        data.parsed.stage_number = sr.stage_number;
      }
      cache.put('data_' + uuid, JSON.stringify(data), 600);
      await sendTelegram('editMessageText', {
        chat_id:      chatId,
        message_id:   messageId,
        text:         buildPreview(data.parsed, data.action, data.existingRow),
        parse_mode:   'HTML',
        reply_markup: confirmEditKeyboard(uuid, data.parsed.lead_type),
      });
    }
    return;
  }

  // ── Commands ──
  if (text === '/start') {
    await sendTelegram('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: [
        '👋 <b>CRM Bot Ready</b>',
        '',
        '<b>Add/Update a lead:</b>',
        '<code>M277 Ramesh Industries Sureshji hotmelt 500@120, solvent 200@80 hot</code>',
        '',
        '🎤 <b>Voice:</b> Send a voice note with lead details',
        '📷 <b>Photo:</b> Send a factory photo and specify the lead',
        '',
        '<b>Commands:</b>',
        '/find &lt;name or factory #&gt;',
        '/lead &lt;factory #&gt;',
        '/followups',
        '/register  — create your salesperson account',
        '/changepin — update your PIN',
        '/stage &lt;factory #&gt; &lt;0-7&gt;',
        '/delete &lt;factory #&gt;',
        '',
        '<b>Stages:</b> 1=New Lead  2=Sample Req  3=Sample Sent',
        '4=Quotation  5=Negotiation  6=Won  7=Repeat  0=Lost',
      ].join('\n'),
    });
    return;
  }

  if (text === '/register') {
    const existingUser = await db.getUserByTelegramId(telegramUserId);
    if (existingUser) {
      await sendTelegram('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `✅ Already registered as <b>${esc(existingUser.display_name)}</b>.\n\nUse /changepin to update your PIN.` });
      return;
    }
    cache.put('register_' + chatId, JSON.stringify({ step: 0 }), 300);
    await sendTelegram('sendMessage', { chat_id: chatId, text: '👤 What is your name? (This will be your login for the dashboard)' });
    return;
  }

  if (text === '/changepin') {
    const user = await db.getUserByTelegramId(telegramUserId);
    if (!user) {
      await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ You need to /register first.' });
      return;
    }
    cache.put('changepin_' + chatId, JSON.stringify({ userId: user.id }), 300);
    await sendTelegram('sendMessage', { chat_id: chatId, text: '🔐 Enter your new 4-6 digit PIN:' });
    return;
  }

  if (text.startsWith('/find ')) { await handleFind(chatId, text.slice(6).trim()); return; }
  if (text.startsWith('/lead ')) { await handleLeadCard(chatId, text.slice(6).trim()); return; }
  if (text === '/followups')      { await handleFollowups(chatId); return; }

  if (text.startsWith('/stage ')) {
    const parts = text.slice(7).trim().split(/\s+/);
    if (parts.length < 2) { await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ Usage: /stage M277 6' }); return; }
    await handleStageUpdate(chatId, parts[0], parseInt(parts[1], 10));
    return;
  }

  if (text.startsWith('/delete ')) {
    await handleDeleteLead(chatId, text.slice(8).trim());
    return;
  }

  // ── Natural language → Gemini → confirm ──
  const registeredUser = await db.getUserByTelegramId(telegramUserId);
  const createdBy = registeredUser ? registeredUser.display_name : '';

  const parsed = await callGemini(text);
  if (!parsed) {
    await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ Could not parse. Try again with more detail.' });
    return;
  }

  const { existingRow, action, leads: _allLeads } = await findExistingLead(parsed);

  if (!parsed.stage) {
    if (action === 'ADD') {
      parsed.stage = 'New Lead'; parsed.stage_number = 1;
    } else {
      const existingLead = _allLeads.find(l => l.rowIndex === String(existingRow));
      if (existingLead) { parsed.stage = existingLead.stage || 'New Lead'; parsed.stage_number = existingLead.stage_number != null ? existingLead.stage_number : 1; }
    }
  }

  const uuid = uuidv4();
  cache.put('data_' + uuid, JSON.stringify({ parsed, existingRow, action, createdBy }), 600);

  await sendTelegram('sendMessage', {
    chat_id:      chatId,
    text:         buildPreview(parsed, action, existingRow),
    parse_mode:   'HTML',
    reply_markup: confirmEditKeyboard(uuid, parsed.lead_type),
  });
}

// ── Format multiple contacts for Telegram display ────────────
function formatContacts(lead) {
  const contacts = (lead.contacts || []).filter(c => c.person_name || c.contact);
  if (!contacts.length) return `👤 ${esc(lead.person_in_charge || '—')}  📞 ${esc(lead.contact || '—')}`;
  if (contacts.length === 1) return `👤 ${esc(contacts[0].person_name || '—')}  📞 ${esc(contacts[0].contact || '—')}`;
  return contacts.map((c, i) =>
    `${i === 0 ? '👤' : '   '} ${esc(c.person_name || '—')} — 📞 ${esc(c.contact || '—')}${c.designation ? ` <i>(${esc(c.designation)})</i>` : ''}`
  ).join('\n');
}

// ============================================================
//  COMMAND HANDLERS
// ============================================================
async function handleFind(chatId, query) {
  if (!query) { await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ Usage: /find M277 or /find Factory Name' }); return; }
  const leads   = await db.getLeads();
  const q       = query.toLowerCase();
  const matches = [];
  for (const l of leads) {
    const num       = String(l.factory_number || '').toLowerCase();
    const name      = String(l.factory_name   || '').toLowerCase();
    const allPeople = (l.contacts || []).map(c => c.person_name).join(' ').toLowerCase();
    if (num === q || name.includes(q) || allPeople.includes(q)) { matches.push(l); if (matches.length >= 5) break; }
  }
  if (!matches.length) { await sendTelegram('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `🔍 No leads found for "<b>${esc(query)}</b>".` }); return; }
  const lines = [`🔍 <b>${matches.length} result(s) for "${esc(query)}":</b>`];
  matches.forEach((l, idx) => {
    const typeEmoji = { Hot: '🔥', Warm: '🟡', Cold: '🔵' }[l.lead_type] || '';
    lines.push('');
    lines.push(`${idx + 1}. <b>${esc(l.factory_number)} — ${esc(l.factory_name)}</b> ${typeEmoji}`);
    lines.push(`   ${formatContacts(l)}`);
    lines.push(`   📊 ${esc(l.stage)}  📅 ${esc(l.follow_up)}`);
  });
  await sendTelegram('sendMessage', { chat_id: chatId, text: lines.join('\n'), parse_mode: 'HTML' });
}

async function handleLeadCard(chatId, query) {
  if (!query) { await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ Usage: /lead M277' }); return; }
  const leads = await db.getLeads();
  const q     = query.toLowerCase();
  const found = leads.find(l =>
    String(l.factory_number || '').toLowerCase() === q ||
    String(l.factory_name   || '').toLowerCase().includes(q)
  );
  if (!found) { await sendTelegram('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `🔍 No lead found for "<b>${esc(query)}</b>".` }); return; }
  const stageDisplay = found.stage ? esc(found.stage) + (found.stage_number ? ` (#${found.stage_number})` : '') : '—';
  const typeEmoji    = { Hot: '🔥', Warm: '🟡', Cold: '🔵' };
  const typeDisplay  = found.lead_type ? (typeEmoji[found.lead_type] || '') + ' ' + esc(found.lead_type) : '—';
  const itemsLines   = (found.items || []).map((it, i) => `   ${i+1}. ${esc(it.product)} × ${esc(it.quantity)} @ ₹${esc(it.rate)}`);
  await sendTelegram('sendMessage', {
    chat_id: chatId, parse_mode: 'HTML',
    text: [
      `📋 <b>Lead Card — Row ${found.rowIndex}</b>`,
      '━━━━━━━━━━━━━━━━━━━━',
      `🏭 <b>Factory #:</b>    ${esc(found.factory_number)}`,
      `🏢 <b>Factory Name:</b> ${esc(found.factory_name)}`,
      `👥 <b>Contacts:</b>`,
      ...((found.contacts || []).filter(c => c.person_name || c.contact).length
        ? (found.contacts || []).filter(c => c.person_name || c.contact).map((c, i) =>
            `   ${i + 1}. ${esc(c.person_name || '—')} — 📞 ${esc(c.contact || '—')}${c.designation ? ` <i>(${esc(c.designation)})</i>` : ''}`)
        : [`   👤 ${esc(found.person_in_charge || '—')}  📞 ${esc(found.contact || '—')}`]),
      `📦 <b>Items:</b>`,
      ...itemsLines,
      `📊 <b>Stage:</b>        ${stageDisplay}`,
      `🌡️ <b>Lead Type:</b>    ${typeDisplay}`,
      `📅 <b>Follow Up:</b>    ${esc(found.follow_up)}`,
      `📝 <b>Notes:</b>        ${esc(found.notes)}`,
      `🗺️ <b>Area:</b>         ${esc(found.area)}`,
      found.created_by ? `👨‍💼 <b>Added by:</b>     ${esc(found.created_by)}` : '',
      `🕐 <b>Updated:</b>      ${esc(found.last_updated)}`,
      '━━━━━━━━━━━━━━━━━━━━',
    ].filter(Boolean).join('\n'),
  });
}

async function handleFollowups(chatId) {
  const leads = await db.getLeads();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const overdue = [], todayList = [];
  for (const l of leads) {
    const fuStr = String(l.follow_up || '').trim();
    if (!fuStr) continue;
    const parts = fuStr.split(/[\/\-]/);
    if (parts.length < 3) continue;
    const fuDate = new Date(parseInt(parts[2].length === 2 ? '20' + parts[2] : parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
    fuDate.setHours(0, 0, 0, 0);
    if (isNaN(fuDate.getTime())) continue;
    if (fuDate < today) overdue.push(l);
    else if (fuDate.getTime() === today.getTime()) todayList.push(l);
  }
  if (!overdue.length && !todayList.length) { await sendTelegram('sendMessage', { chat_id: chatId, text: '✅ No follow-ups due today or overdue.' }); return; }
  const lines = ['📅 <b>Follow-Up Report</b>', '━━━━━━━━━━━━━━━━━━━━'];
  if (overdue.length) {
    lines.push(`\n🔴 <b>Overdue (${overdue.length})</b>`);
    overdue.forEach((l, i) => {
      const te = { Hot: '🔥', Warm: '🟡', Cold: '🔵' }[l.lead_type] || '';
      lines.push(`${i + 1}. <b>${esc(l.factory_number)} — ${esc(l.factory_name)}</b> ${te} (${esc(l.stage)})`);
      lines.push(`   ${formatContacts(l)}  📅 ${esc(l.follow_up)}`);
    });
  }
  if (todayList.length) {
    lines.push(`\n🟡 <b>Due Today (${todayList.length})</b>`);
    todayList.forEach((l, i) => {
      const te = { Hot: '🔥', Warm: '🟡', Cold: '🔵' }[l.lead_type] || '';
      lines.push(`${i + 1}. <b>${esc(l.factory_number)} — ${esc(l.factory_name)}</b> ${te}`);
      lines.push(`   ${formatContacts(l)}`);
    });
  }
  await sendTelegram('sendMessage', { chat_id: chatId, text: lines.join('\n'), parse_mode: 'HTML' });
}

const STAGE_NAMES = { 0:'Lost', 1:'New Lead', 2:'Sample Required', 3:'Sample Sent', 4:'Quotation', 5:'Negotiation', 6:'Order Won', 7:'Repeat Customer' };

async function handleStageUpdate(chatId, factoryNum, stageNum) {
  if (isNaN(stageNum) || stageNum < 0 || stageNum > 7) {
    await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ Stage must be 0–7.\n\n0=Lost  1=New Lead  2=Sample Required\n3=Sample Sent  4=Quotation  5=Negotiation\n6=Order Won  7=Repeat Customer' });
    return;
  }
  const leads = await db.getLeads();
  const found = leads.find(l => String(l.factory_number || '').toLowerCase() === factoryNum.toLowerCase());
  if (!found) { await sendTelegram('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `🔍 No lead with factory number <b>${esc(factoryNum)}</b>.` }); return; }
  const stageName = STAGE_NAMES[stageNum];
  const uuid      = uuidv4();
  cache.put('stage_' + uuid, JSON.stringify({ rowIndex: found.rowIndex, stageNum, stageName, factoryNum, factoryName: found.factory_name }), 300);
  await sendTelegram('sendMessage', {
    chat_id: chatId, parse_mode: 'HTML',
    text: `📊 <b>Stage Update</b>\n\n<b>${esc(factoryNum)} — ${esc(found.factory_name)}</b>\nNew stage: <b>${stageName} (#${stageNum})</b>\n\nConfirm?`,
    reply_markup: { inline_keyboard: [[{ text: '✅ Confirm', callback_data: 'STAGE_' + uuid }, { text: '❌ Cancel', callback_data: 'CANCEL_' + uuid }]] },
  });
}

async function handleDeleteLead(chatId, factoryNum) {
  if (!factoryNum) { await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ Usage: /delete M277' }); return; }
  const leads = await db.getLeads();
  const found = leads.find(l => String(l.factory_number || '').toLowerCase() === factoryNum.toLowerCase());
  if (!found) { await sendTelegram('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `🔍 No lead with factory number <b>${esc(factoryNum)}</b>.` }); return; }
  const uuid = uuidv4();
  cache.put('del_' + uuid, JSON.stringify({ rowIndex: found.rowIndex, factoryNum, factoryName: found.factory_name }), 300);
  await sendTelegram('sendMessage', {
    chat_id: chatId, parse_mode: 'HTML',
    text: `🗑️ <b>Delete Lead</b>\n\n<b>${esc(factoryNum)} — ${esc(found.factory_name)}</b> (Row ${found.rowIndex})\n\n⚠️ This cannot be undone. Confirm?`,
    reply_markup: { inline_keyboard: [[{ text: '🗑️ Yes, Delete', callback_data: 'DELETE_' + uuid }, { text: '❌ Cancel', callback_data: 'CANCEL_' + uuid }]] },
  });
}

// ============================================================
//  CALLBACK HANDLER
// ============================================================
async function handleCallback(callbackQuery) {
  const cbId      = callbackQuery.id;
  const chatId    = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const cbData    = callbackQuery.data;

  await sendTelegram('answerCallbackQuery', { callback_query_id: cbId });

  // ── Claim follow-up (bid system) ──
  if (cbData.startsWith('CLAIM_')) {
    const leadId = parseInt(cbData.replace('CLAIM_', ''), 10);
    const telegramUserId = String(callbackQuery.from?.id || chatId);
    const user = await db.getUserByTelegramId(telegramUserId);
    const claimerName = user ? user.display_name : (callbackQuery.from?.first_name || 'Someone');
    const result = await db.claimFollowUp(leadId, claimerName);
    if (result.ok) {
      const claimLeads = await db.getLeads();
      const lead = claimLeads.find(l => l.rowIndex === String(leadId));
      const factName = lead ? esc(lead.factory_name || lead.factory_number) : `Lead #${leadId}`;
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
        text: `✅ <b>You claimed the follow-up for ${factName}!</b>\n\nIt's now assigned to you. Update after the visit.` });
    } else if (result.alreadyClaimed) {
      const claimLeads = await db.getLeads();
      const lead = claimLeads.find(l => l.rowIndex === String(leadId));
      const factName = lead ? esc(lead.factory_name || lead.factory_number) : `Lead #${leadId}`;
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
        text: `⚡ <b>Already claimed by ${esc(result.claimedBy)}</b>\n\n${factName} — want to request it?`,
        reply_markup: { inline_keyboard: [[{ text: '📬 Request Follow-up', callback_data: `REQFU_${leadId}_${claimerName}` }]] },
      });
    }
    return;
  }

  // ── Request follow-up reassignment ──
  if (cbData.startsWith('REQFU_')) {
    const parts = cbData.replace('REQFU_', '').split('_');
    const leadId = parseInt(parts[0], 10);
    const requesterName = parts.slice(1).join('_');
    const reqfuLeads = await db.getLeads();
    const lead = reqfuLeads.find(l => l.rowIndex === String(leadId));
    const factName = lead ? esc(lead.factory_name || lead.factory_number) : `Lead #${leadId}`;
    const currentAssignee = lead ? esc(lead.assigned_to || '—') : '—';
    // Notify admin
    const allUsers = await db.getAllUsers();
    const adminUser = allUsers.find(u => u.role === 'admin' && u.telegram_user_id);
    if (adminUser) {
      await sendTelegram('sendMessage', {
        chat_id: adminUser.telegram_user_id, parse_mode: 'HTML',
        text: `📬 <b>${esc(requesterName)}</b> is requesting the follow-up for <b>${factName}</b>\n\n👤 Currently assigned to: <b>${currentAssignee}</b>`,
        reply_markup: { inline_keyboard: [[{ text: `✅ Reassign to ${esc(requesterName)}`, callback_data: `REASSIGN_${leadId}_${requesterName}` }]] },
      }).catch(() => {});
    }
    await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
      text: `📬 <b>Request sent!</b> Admin has been notified.\n\n${factName} — you'll get a message if it's reassigned to you.` });
    return;
  }

  // ── Admin reassigns follow-up ──
  if (cbData.startsWith('REASSIGN_')) {
    const parts = cbData.replace('REASSIGN_', '').split('_');
    const leadId = parseInt(parts[0], 10);
    const newAssignee = parts.slice(1).join('_');
    const reassignLeads = await db.getLeads();
    const lead = reassignLeads.find(l => l.rowIndex === String(leadId));
    const factName = lead ? esc(lead.factory_name || lead.factory_number) : `Lead #${leadId}`;
    const result = await db.reassignFollowUp(leadId, newAssignee);
    if (result.ok) {
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
        text: `✅ <b>Reassigned to ${esc(newAssignee)}</b>\n\n${factName} follow-up is now with ${esc(newAssignee)}.` });
      // Notify the new assignee
      const allUsers = await db.getAllUsers();
      const assigneeUser = allUsers.find(u => u.display_name === newAssignee && u.telegram_user_id);
      if (assigneeUser) {
        await sendTelegram('sendMessage', {
          chat_id: assigneeUser.telegram_user_id, parse_mode: 'HTML',
          text: `✅ <b>Follow-up assigned to you!</b>\n\n🏭 <b>${factName}</b>\n\nAdmin has reassigned this follow-up to you. Update after your visit.`,
        }).catch(() => {});
      }
    }
    return;
  }

  // ── Cancel ──
  if (cbData.startsWith('CANCEL_')) {
    cache.remove('edit_' + chatId);
    cache.remove('editall_' + chatId);
    await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '❌ <b>Cancelled.</b> No changes saved.', parse_mode: 'HTML' });
    return;
  }

  // ── Temperature buttons (Hot / Warm / Cold) ──
  if (cbData.startsWith('TEMP_')) {
    const rest    = cbData.replace('TEMP_', '');
    const sep     = rest.indexOf('_');
    const tempType = rest.slice(0, sep);       // 'Hot' | 'Warm' | 'Cold'
    const uuid    = rest.slice(sep + 1);
    const cached  = cache.get('data_' + uuid);
    if (!cached) { await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '⏰ <b>Session expired.</b> Please send again.', parse_mode: 'HTML' }); return; }
    const data = JSON.parse(cached);
    data.parsed.lead_type = tempType;
    cache.put('data_' + uuid, JSON.stringify(data), 600);
    await sendTelegram('editMessageText', {
      chat_id:      chatId,
      message_id:   messageId,
      text:         buildPreview(data.parsed, data.action, data.existingRow),
      parse_mode:   'HTML',
      reply_markup: confirmEditKeyboard(uuid, tempType),
    });
    return;
  }

  // ── Follow-up date buttons ──
  if (cbData.startsWith('FUDATE_')) {
    const rest   = cbData.replace('FUDATE_', '');
    const sep    = rest.indexOf('_');
    const type   = rest.slice(0, sep);
    const fuUuid = rest.slice(sep + 1);
    const cached = cache.get('fudate_' + fuUuid);
    if (!cached) { await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '⏰ <b>Session expired.</b>', parse_mode: 'HTML' }); return; }
    const { rowIndex } = JSON.parse(cached);

    if (type === 'skip') {
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '📅 No follow-up date set. You can add one later via Edit.', parse_mode: 'HTML' });
      cache.remove('fudate_' + fuUuid);
      return;
    }
    if (type === 'custom') {
      cache.put('fudate_custom_' + chatId, JSON.stringify({ fuUuid, rowIndex, messageId }), 300);
      await sendTelegram('sendMessage', { chat_id: chatId, text: '📅 Type the follow-up date:\n(dd/MM/yyyy or e.g. "15 July", "next week")' });
      return;
    }

    const offsets = { tomorrow: 1, '2days': 2, nextweek: 7, '2weeks': 14 };
    const dateStr = dateIST(offsets[type] || 1);
    await db.updateLead(rowIndex, { follow_up: dateStr });
    await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: `✅ Follow-up set: <b>${dateStr}</b>`, parse_mode: 'HTML' });
    cache.remove('fudate_' + fuUuid);
    // Broadcast to team (bid system) for Hot/Warm leads
    { const _fl = await db.getLeads(); const fl = _fl.find(l => l.rowIndex === String(rowIndex)); if (fl && ['Hot','Warm'].includes(fl.lead_type)) broadcastFollowUpAvailable(rowIndex, dateStr).catch(() => {}); }
    return;
  }

  // ── Edit All guided flow ──
  if (cbData.startsWith('EDITALL_')) {
    const uuid   = cbData.replace('EDITALL_', '');
    const cached = cache.get('data_' + uuid);
    if (!cached) { await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '⏰ <b>Session expired.</b>', parse_mode: 'HTML' }); return; }
    const data = JSON.parse(cached);
    cache.put('editall_' + chatId, JSON.stringify({ uuid, fieldIndex: 0 }), 600);
    await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '✏️ <b>Edit All — Step by step</b>\n\nSend <code>.</code> to keep the current value for any field.', parse_mode: 'HTML' });
    await sendEditAllFieldPrompt(chatId, data.parsed, 0);
    return;
  }

  // ── Edit: show field selector ──
  if (cbData.startsWith('EDIT_')) {
    const uuid   = cbData.replace('EDIT_', '');
    const cached = cache.get('data_' + uuid);
    if (!cached) { await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '⏰ <b>Session expired.</b>', parse_mode: 'HTML' }); return; }
    await sendTelegram('editMessageReplyMarkup', {
      chat_id: chatId, message_id: messageId,
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏭 Factory #', callback_data: 'FIELD_' + uuid + '_factory_number' }, { text: '🏢 Name', callback_data: 'FIELD_' + uuid + '_factory_name' }],
          [{ text: '👤 Person',    callback_data: 'FIELD_' + uuid + '_person_in_charge' }, { text: '📞 Contact', callback_data: 'FIELD_' + uuid + '_contact' }],
          [{ text: '📦 Product',   callback_data: 'FIELD_' + uuid + '_product' }, { text: '🔢 Quantity', callback_data: 'FIELD_' + uuid + '_quantity' }],
          [{ text: '💰 Rate',      callback_data: 'FIELD_' + uuid + '_rate' }, { text: '📊 Stage', callback_data: 'FIELD_' + uuid + '_stage' }],
          [{ text: '📅 Follow Up', callback_data: 'FIELD_' + uuid + '_follow_up' }, { text: '🗺️ Area', callback_data: 'FIELD_' + uuid + '_area' }],
          [{ text: '📝 Notes',     callback_data: 'FIELD_' + uuid + '_notes' }, { text: '🌡️ Lead Type', callback_data: 'FIELD_' + uuid + '_lead_type' }],
          [{ text: '◀️ Back',      callback_data: 'BACK_' + uuid }],
        ],
      },
    });
    return;
  }

  // ── Back: return to confirm keyboard ──
  if (cbData.startsWith('BACK_')) {
    const uuid = cbData.replace('BACK_', '');
    cache.remove('edit_' + chatId);
    const cached = cache.get('data_' + uuid);
    const lt = cached ? JSON.parse(cached).parsed?.lead_type : '';
    await sendTelegram('editMessageReplyMarkup', {
      chat_id: chatId, message_id: messageId,
      reply_markup: confirmEditKeyboard(uuid, lt),
    });
    return;
  }

  // ── Field: user picked a field to edit ──
  if (cbData.startsWith('FIELD_')) {
    const rest  = cbData.replace('FIELD_', '');
    const uuid  = rest.slice(0, 36);
    const field = rest.slice(37);
    const fieldLabels = {
      factory_number: 'Factory #', factory_name: 'Factory Name',
      person_in_charge: 'Person in Charge', contact: 'Contact',
      product: 'Product', quantity: 'Quantity', rate: 'Rate',
      stage: 'Stage (1-7 or name)', follow_up: 'Follow Up (dd/MM/yyyy)',
      area: 'Area', notes: 'Notes', lead_type: 'Lead Type (Hot / Warm / Cold)',
    };
    cache.put('edit_' + chatId, JSON.stringify({ uuid, field, messageId }), 300);
    await sendTelegram('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `✏️ Type the new value for <b>${fieldLabels[field] || field}</b>:` });
    return;
  }

  // ── Confirm ──
  if (cbData.startsWith('CONFIRM_')) {
    const uuid   = cbData.replace('CONFIRM_', '');
    const cached = cache.get('data_' + uuid);
    if (!cached) { await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '⏰ <b>Session expired.</b> Please send again.', parse_mode: 'HTML' }); return; }
    const { parsed, existingRow, action, createdBy = '' } = JSON.parse(cached);
    let savedRowIndex = existingRow;
    try {
      if (action === 'UPDATE' && existingRow > 0) {
        await db.updateLead(existingRow, parsed);
        await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: `✅ <b>Updated!</b> Row ${existingRow} — <b>${esc(parsed.factory_name || parsed.factory_number)}</b>`, parse_mode: 'HTML' });
        if (parsed.stage === 'Order Won') notifyOrderWon(parsed, createdBy).catch(() => {});
      } else {
        const result = await db.addLead(parsed, createdBy);
        if (result.conflict) {
          await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: `⚠️ <b>Duplicate:</b> ${esc(result.message)}`, parse_mode: 'HTML' });
          return;
        }
        savedRowIndex = result.rowIndex;
        await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: `✅ <b>Added!</b> New entry for <b>${esc(parsed.factory_name || parsed.factory_number)}</b> saved.`, parse_mode: 'HTML' });
        if (parsed.stage === 'Order Won') notifyOrderWon(parsed, createdBy).catch(() => {});
      }
    } catch (err) {
      console.error('DB write error:', err.message);
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '🚨 <b>Write failed.</b> Check server logs.', parse_mode: 'HTML' });
      return;
    }
    cache.remove('data_' + uuid);

    // Offer follow-up date if Hot/Warm and no date set
    if (['Hot', 'Warm'].includes(parsed.lead_type) && !parsed.follow_up && savedRowIndex) {
      const fuUuid = uuidv4();
      cache.put('fudate_' + fuUuid, JSON.stringify({ rowIndex: savedRowIndex }), 600);
      const typeLabel = parsed.lead_type === 'Hot' ? '🔥 Hot' : '🟡 Warm';
      await sendTelegram('sendMessage', {
        chat_id: chatId, parse_mode: 'HTML',
        text: `📅 <b>${typeLabel} lead</b> — set a follow-up date?`,
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Tomorrow',   callback_data: 'FUDATE_tomorrow_'  + fuUuid },
              { text: 'In 2 Days',  callback_data: 'FUDATE_2days_'     + fuUuid },
              { text: 'Next Week',  callback_data: 'FUDATE_nextweek_'  + fuUuid },
            ],
            [
              { text: 'In 2 Weeks', callback_data: 'FUDATE_2weeks_'   + fuUuid },
              { text: '📅 Custom',  callback_data: 'FUDATE_custom_'   + fuUuid },
              { text: 'Skip',       callback_data: 'FUDATE_skip_'     + fuUuid },
            ],
          ],
        },
      });
    }
    return;
  }

  // ── Stage update confirm ──
  if (cbData.startsWith('STAGE_')) {
    const uuid   = cbData.replace('STAGE_', '');
    const cached = cache.get('stage_' + uuid);
    if (!cached) { await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '⏰ <b>Session expired.</b>', parse_mode: 'HTML' }); return; }
    const { rowIndex, stageNum, stageName, factoryNum, factoryName } = JSON.parse(cached);
    try {
      await db.updateLead(rowIndex, { stage: stageName, stage_number: String(stageNum) });
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: `✅ <b>Stage Updated!</b>\n<b>${esc(factoryNum)} — ${esc(factoryName)}</b>\nNow: <b>${stageName} (#${stageNum})</b>`, parse_mode: 'HTML' });
      if (stageName === 'Order Won') {
        const leads = await db.getLeads();
        const lead  = leads.find(l => l.rowIndex === String(rowIndex));
        if (lead) notifyOrderWon(lead, '').catch(() => {});
      }
    } catch (err) {
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '🚨 <b>Failed to update stage.</b>', parse_mode: 'HTML' });
    }
    cache.remove('stage_' + uuid);
    return;
  }

  // ── Delete confirm ──
  if (cbData.startsWith('DELETE_')) {
    const uuid   = cbData.replace('DELETE_', '');
    const cached = cache.get('del_' + uuid);
    if (!cached) { await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '⏰ <b>Session expired.</b>', parse_mode: 'HTML' }); return; }
    const { rowIndex, factoryNum, factoryName } = JSON.parse(cached);
    try {
      await db.deleteLead(rowIndex);
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: `🗑️ <b>Deleted!</b>\n<b>${esc(factoryNum)} — ${esc(factoryName)}</b> removed.`, parse_mode: 'HTML' });
    } catch (err) {
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '🚨 <b>Failed to delete.</b>', parse_mode: 'HTML' });
    }
    cache.remove('del_' + uuid);
    return;
  }
}

// ============================================================
//  WEB API — protected by authMiddleware
// ============================================================
app.get('/api/leads', authMiddleware, async (req, res) => {
  try {
    const leads = req.user.role === 'admin' ? await db.getLeads() : await db.getLeadsForUser(req.user.username);
    res.json(leads);
  }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/leads', authMiddleware, async (req, res) => {
  try {
    const result = await db.addLead(req.body, req.user?.username || '');
    if (result.conflict) return res.status(409).json(result);
    res.json(result);
  }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/leads/:row', authMiddleware, async (req, res) => {
  try {
    const result = await db.updateLead(parseInt(req.params.row, 10), req.body);
    if (req.body.stage === 'Order Won') notifyOrderWon(req.body, req.user.username).catch(() => {});
    res.json(result);
  }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/leads/:row', authMiddleware, adminOnly, async (req, res) => {
  try { res.json(await db.deleteLead(parseInt(req.params.row, 10))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/parse', authMiddleware, async (req, res) => {
  const { text } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  try {
    const parsed = await callGemini(text).catch(() => localParse(text));
    const { existingRow, action } = await findExistingLead(parsed);
    res.json({ parsed, action, existingRow });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const leads = req.user.role === 'admin' ? await db.getLeads() : await db.getLeadsForUser(req.user.username);
    const byStage = {}, byProduct = {}, byProductRevenue = {};
    let won = 0, lost = 0;
    for (const l of leads) {
      const s = l.stage || 'Unknown';
      byStage[s] = (byStage[s] || 0) + 1;
      const items = l.items?.length ? l.items : [{ product: l.product, quantity: l.quantity, rate: l.rate }];
      for (const it of items) {
        const p = it.product || 'Unknown';
        byProduct[p]        = (byProduct[p]        || 0) + 1;
        byProductRevenue[p] = (byProductRevenue[p] || 0) + (parseFloat(it.quantity) || 0) * (parseFloat(it.rate) || 0);
      }
      if (l.stage_number === '6' || l.stage_number === '7') won++;
      if (l.stage_number === '0') lost++;
    }
    const by_lead_type = leads.reduce((acc, l) => { const t = l.lead_type || 'Unset'; acc[t] = (acc[t] || 0) + 1; return acc; }, {});
    res.json({ total: leads.length, active: leads.length - won - lost, won, lost, by_stage: byStage, by_product: byProduct, by_product_revenue: byProductRevenue, by_lead_type });
  }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Pin factory location on map ──────────────────────────────
app.patch('/api/leads/:row/location', authMiddleware, async (req, res) => {
  const { lat, lng } = req.body || {};
  if (lat == null || lng == null) return res.status(400).json({ error: 'lat and lng required' });
  if (isNaN(parseFloat(lat)) || isNaN(parseFloat(lng))) return res.status(400).json({ error: 'Invalid coordinates' });
  try {
    res.json(await db.updateLeadCoords(parseInt(req.params.row, 10), lat, lng));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Smart Route Optimization via OSRM ────────────────────────
//
// PostgreSQL/PostGIS equivalent query (if migrating):
//   SELECT id, factory_number, factory_name, person_in_charge,
//          ST_Y(location::geometry) AS lat,
//          ST_X(location::geometry) AS lng
//   FROM   factories
//   WHERE  id = ANY($1::int[])
//     AND  location IS NOT NULL;
//
// Current SQLite version handled via db.getLeadCoordinates(ids).
//
app.post('/api/route/optimize', authMiddleware, async (req, res) => {
  try {
    const { factory_ids, start_location } = req.body || {};

    if (!Array.isArray(factory_ids) || factory_ids.length < 1)
      return res.status(400).json({ error: 'Provide at least one factory_id.' });
    if (!start_location?.lat || !start_location?.lng)
      return res.status(400).json({ error: 'start_location { lat, lng } is required.' });

    // 1. Fetch factory coordinates
    const rows    = await db.getLeadCoordinates(factory_ids);
    const valid   = rows.filter(r => r.lat && r.lng && !isNaN(+r.lat) && !isNaN(+r.lng));
    const skipped = rows.filter(r => !r.lat || !r.lng || isNaN(+r.lat) || isNaN(+r.lng));

    if (!valid.length)
      return res.status(400).json({
        error: 'None of the selected factories have map coordinates. Pin them on the map first.',
        skipped: skipped.map(f => ({ id: f.id, name: f.factory_name })),
      });

    // 2. Build OSRM coordinate string — OSRM expects lng,lat (not lat,lng)
    //    waypoints[0] = agent start, waypoints[1..n] = factories
    const coords = [
      `${+start_location.lng},${+start_location.lat}`,
      ...valid.map(f => `${+f.lng},${+f.lat}`),
    ].join(';');

    const osrmUrl =
      `http://router.project-osrm.org/trip/v1/driving/${coords}` +
      `?roundtrip=true&source=first&geometries=geojson&annotations=false`;

    const { data } = await axios.get(osrmUrl, { timeout: 20000 });
    if (data.code !== 'Ok')
      throw new Error(`OSRM: ${data.code}${data.message ? ' — ' + data.message : ''}`);

    const trip          = data.trips[0];
    const osrmWaypoints = data.waypoints; // indexed by INPUT order

    // 3. Determine optimized visit sequence
    //    osrmWaypoints[i].waypoint_index = position in the optimized trip
    //    slice(1) drops the start-location entry (waypoints[0])
    const stops = osrmWaypoints
      .slice(1)
      .map((wp, i) => ({ pos: wp.waypoint_index, factory: valid[i] }))
      .sort((a, b) => a.pos - b.pos)
      .map((s, i) => ({
        order:          i + 1,
        factory_id:     s.factory.id,
        factory_number: s.factory.factory_number,
        factory_name:   s.factory.factory_name,
        person:         s.factory.person_in_charge,
        lat:            +s.factory.lat,
        lng:            +s.factory.lng,
      }));

    res.json({
      route: {
        geometry:     trip.geometry,
        distance_km:  (trip.distance / 1000).toFixed(1),
        duration_min: Math.round(trip.duration / 60),
      },
      stops,
      skipped: skipped.map(f => ({ id: f.id, name: f.factory_name })),
    });

  } catch (err) {
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT')
      return res.status(504).json({ error: 'OSRM timed out. Try again.' });
    console.error('Route optimize:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Photos API
app.get('/api/leads/:id/photos', authMiddleware, async (req, res) => {
  try { res.json(await db.getPhotos(parseInt(req.params.id, 10))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Users API (admin only)
app.get('/api/users', authMiddleware, adminOnly, async (req, res) => {
  try { res.json(await db.getAllUsers()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/users/:id', authMiddleware, adminOnly, async (req, res) => {
  try { res.json(await db.deleteUser(parseInt(req.params.id, 10))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin creates a new user directly from the dashboard
app.post('/api/users', authMiddleware, adminOnly, async (req, res) => {
  const { name, pin, role } = req.body || {};
  if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters' });
  if (!pin || !/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be 4–6 digits' });
  const safeRole = ['admin', 'sales'].includes(role) ? role : 'sales';
  try {
    const user = await db.createUser(name.trim(), String(pin), safeRole, '');
    res.json({ success: true, user });
  } catch (err) {
    if (err.message?.includes('UNIQUE') || err.message?.includes('unique')) return res.status(409).json({ error: 'A user with this name already exists' });
    res.status(500).json({ error: err.message });
  }
});

// Public: list of user display names only (no PINs, no roles, no IDs)
app.get('/api/users/names', async (req, res) => {
  try {
    const users = await db.getAllUsers();
    res.json(users.map(u => u.display_name));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin: reset any user's PIN
app.patch('/api/users/:id/pin', authMiddleware, adminOnly, async (req, res) => {
  const { pin } = req.body || {};
  if (!pin || !/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be 4–6 digits' });
  try {
    await db.updateUserPin(parseInt(req.params.id, 10), String(pin));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Public self-registration (no auth required — anyone can create a sales account)
app.post('/api/register', async (req, res) => {
  const { name, pin } = req.body || {};
  if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters' });
  if (!pin || !/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be 4–6 digits' });
  try {
    const result = await db.createUser(name.trim(), String(pin), 'sales', '');
    if (!result.ok) return res.status(409).json({ error: result.message });
    res.json({ success: true });
  } catch (err) {
    if (err.message?.includes('UNIQUE') || err.message?.includes('unique')) return res.status(409).json({ error: 'Name already taken, choose another' });
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/users/me/pin', authMiddleware, async (req, res) => {
  const { pin } = req.body || {};
  if (!pin || !/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be 4-6 digits' });
  const user = await db.getUserByName(req.user.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(await db.updateUserPin(user.id, pin));
});

// Profile — get current user info
app.get('/api/users/me', authMiddleware, async (req, res) => {
  const user = await db.getUserByName(req.user.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { id, display_name, role, telegram_user_id, created_at } = user;
  res.json({ id, display_name, role, telegram_user_id, created_at });
});

// Profile — update name and/or PIN (returns fresh token if name changed)
app.patch('/api/users/me/profile', authMiddleware, async (req, res) => {
  const { display_name, pin } = req.body || {};
  const user = await db.getUserByName(req.user.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  let newName = user.display_name;
  if (display_name && display_name.trim() && display_name.trim() !== user.display_name) {
    const result = await db.updateUserName(user.id, display_name.trim());
    if (!result.ok) return res.status(400).json({ error: result.message });
    newName = display_name.trim();
  }
  if (pin) {
    if (!/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be 4-6 digits' });
    await db.updateUserPin(user.id, pin);
  }
  const newToken = signToken(newName, user.role);
  res.json({ ok: true, token: newToken, username: newName, role: user.role });
});

// Lead access — admin manages which salespeople can see a lead
app.get('/api/leads/:id/access', authMiddleware, adminOnly, async (req, res) => {
  try { res.json(await db.getLeadAccess(parseInt(req.params.id, 10))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/leads/:id/access', authMiddleware, adminOnly, async (req, res) => {
  const { user_display_name } = req.body || {};
  if (!user_display_name) return res.status(400).json({ error: 'user_display_name required' });
  try { res.json(await db.grantLeadAccess(parseInt(req.params.id, 10), user_display_name, req.user.username)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/leads/:id/access/:name', authMiddleware, adminOnly, async (req, res) => {
  try { res.json(await db.revokeLeadAccess(parseInt(req.params.id, 10), decodeURIComponent(req.params.name))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Claim a follow-up (bid system)
app.post('/api/leads/:id/claim', authMiddleware, async (req, res) => {
  try { res.json(await db.claimFollowUp(parseInt(req.params.id, 10), req.user.username)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  TEAM WORKSPACE
// ============================================================

// Middleware: validate X-Team-ID header and active membership
async function teamMemberMiddleware(req, res, next) {
  const teamId = parseInt(req.headers['x-team-id'], 10);
  if (!teamId) return res.status(400).json({ error: 'X-Team-ID header required' });
  const user = await db.getUserByName(req.user.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const member = await db.getTeamMember(teamId, user.id);
  if (!member || member.status !== 'active') return res.status(403).json({ error: 'Not an active member of this team' });
  req.teamId   = teamId;
  req.teamRole = member.role;
  req.dbUser   = user;
  next();
}

// Middleware: requires owner or admin in the team
function teamAdminMiddleware(req, res, next) {
  if (!['owner', 'admin'].includes(req.teamRole)) return res.status(403).json({ error: 'Team admin access required' });
  next();
}

// GET /api/my/teams — teams the logged-in user belongs to
app.get('/api/my/teams', authMiddleware, async (req, res) => {
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.json([]);
    res.json(await db.getUserTeams(user.id));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/teams — create a new team
app.post('/api/teams', authMiddleware, async (req, res) => {
  const { name, handle } = req.body || {};
  if (!name || name.trim().length < 2)   return res.status(400).json({ error: 'Team name must be at least 2 characters' });
  if (!handle || !/^@?[a-z0-9_]{3,30}$/i.test(handle.replace(/^@/, '')))
    return res.status(400).json({ error: 'Handle must be 3–30 letters/numbers/underscores' });
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const existing = await db.getTeamByHandle(handle);
    if (existing) return res.status(409).json({ error: 'Handle already taken, choose another' });
    const team = await db.createTeam(name, handle, user.id);
    res.json(team);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/teams/search?q=abc — search public teams
app.get('/api/teams/search', authMiddleware, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try { res.json(await db.searchTeams(q)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/teams/:id — team details (must be member OR searching)
app.get('/api/teams/:id', authMiddleware, async (req, res) => {
  try {
    const team = await db.getTeamById(parseInt(req.params.id, 10));
    if (!team) return res.status(404).json({ error: 'Team not found' });
    res.json(team);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/teams/:id — update team settings (admin/owner)
app.patch('/api/teams/:id', authMiddleware, teamMemberMiddleware, teamAdminMiddleware, async (req, res) => {
  const { name, handle, publicSearch, autoApprove } = req.body || {};
  try {
    await db.updateTeam(req.teamId, { name, handle, publicSearch, autoApprove });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/teams/:id/invite/regenerate — regenerate invite code
app.post('/api/teams/:id/invite/regenerate', authMiddleware, teamMemberMiddleware, teamAdminMiddleware, async (req, res) => {
  try {
    const code = await db.regenerateInviteCode(req.teamId);
    res.json({ invite_code: code });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/teams/join — join via invite code
app.post('/api/teams/join', authMiddleware, async (req, res) => {
  const { invite_code } = req.body || {};
  if (!invite_code) return res.status(400).json({ error: 'Invite code required' });
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const team = await db.getTeamByInviteCode(invite_code.trim());
    if (!team) return res.status(404).json({ error: 'Invalid invite code' });
    const existing = await db.getTeamMember(team.id, user.id);
    if (existing && existing.status === 'active') return res.status(409).json({ error: 'You are already a member of this team' });
    await db.addTeamMember(team.id, user.id, 'sales', 'active');
    res.json({ success: true, team: { id: team.id, name: team.name, handle: team.handle } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/teams/:id/request — request to join a public team
app.post('/api/teams/:id/request', authMiddleware, async (req, res) => {
  const teamId = parseInt(req.params.id, 10);
  const { message } = req.body || {};
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const team = await db.getTeamById(teamId);
    if (!team) return res.status(404).json({ error: 'Team not found' });
    const existing = await db.getTeamMember(teamId, user.id);
    if (existing && existing.status === 'active') return res.status(409).json({ error: 'Already a member' });
    if (team.auto_approve) {
      await db.addTeamMember(teamId, user.id, 'sales', 'active');
      return res.json({ success: true, auto_approved: true, team: { id: team.id, name: team.name } });
    }
    await db.createJoinRequest(teamId, user.id, message || '');
    res.json({ success: true, auto_approved: false });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/teams/:id/requests — list join requests (admin)
app.get('/api/teams/:id/requests', authMiddleware, teamMemberMiddleware, teamAdminMiddleware, async (req, res) => {
  try { res.json(await db.getJoinRequests(req.teamId, req.query.status || null)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/teams/:id/requests/:rid — approve or reject
app.patch('/api/teams/:id/requests/:rid', authMiddleware, teamMemberMiddleware, teamAdminMiddleware, async (req, res) => {
  const { status } = req.body || {};
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'status must be approved or rejected' });
  try {
    const requests = await db.getJoinRequests(req.teamId);
    const jr = requests.find(r => r.id === parseInt(req.params.rid, 10));
    if (!jr) return res.status(404).json({ error: 'Request not found' });
    await db.updateJoinRequest(jr.id, status, req.dbUser.id);
    if (status === 'approved') await db.addTeamMember(req.teamId, jr.user_id, 'sales', 'active');
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/teams/:id/members — list team members
app.get('/api/teams/:id/members', authMiddleware, teamMemberMiddleware, async (req, res) => {
  try { res.json(await db.getTeamMembers(req.teamId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/teams/:id/members/:uid — change role or status
app.patch('/api/teams/:id/members/:uid', authMiddleware, teamMemberMiddleware, teamAdminMiddleware, async (req, res) => {
  const uid    = parseInt(req.params.uid, 10);
  const { role, status } = req.body || {};
  const validRoles   = ['admin', 'manager', 'sales', 'viewer'];
  const validStatus  = ['active', 'suspended'];
  if (role   && !validRoles.includes(role))   return res.status(400).json({ error: 'Invalid role' });
  if (status && !validStatus.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  const target = await db.getTeamMember(req.teamId, uid);
  if (!target) return res.status(404).json({ error: 'Member not found' });
  if (target.role === 'owner') return res.status(403).json({ error: 'Cannot modify owner' });
  try {
    await db.updateTeamMember(req.teamId, uid, { role, status });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /api/teams/:id/members/:uid — remove member
app.delete('/api/teams/:id/members/:uid', authMiddleware, teamMemberMiddleware, teamAdminMiddleware, async (req, res) => {
  const uid = parseInt(req.params.uid, 10);
  const target = await db.getTeamMember(req.teamId, uid);
  if (!target) return res.status(404).json({ error: 'Member not found' });
  if (target.role === 'owner') return res.status(403).json({ error: 'Cannot remove owner' });
  try {
    await db.removeTeamMember(req.teamId, uid);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/teams/:id/leave — leave team
app.post('/api/teams/:id/leave', authMiddleware, teamMemberMiddleware, async (req, res) => {
  if (req.teamRole === 'owner') return res.status(403).json({ error: 'Owner cannot leave. Transfer ownership first.' });
  try {
    await db.removeTeamMember(req.teamId, req.dbUser.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/teams/:id/leads — leads for this team
app.get('/api/teams/:id/leads', authMiddleware, teamMemberMiddleware, async (req, res) => {
  try { res.json(await db.getLeadsByTeam(req.teamId)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /api/teams/:id/leads — add lead to team
app.post('/api/teams/:id/leads', authMiddleware, teamMemberMiddleware, async (req, res) => {
  if (!['owner','admin','manager','sales'].includes(req.teamRole)) return res.status(403).json({ error: 'Viewers cannot create leads' });
  try {
    const lead = await db.addLead({ ...req.body, created_by: req.user.username, team_id: req.teamId });
    res.json(lead);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  WEBAUTHN — Biometric login (auto-detects origin from request)
// ============================================================
const RP_NAME = 'SalesCRM';

// Detect the correct origin + rpId from the incoming request.
// Env vars ORIGIN / RP_ID override everything if both are set.
// Otherwise: try Origin header → Referer header → reconstruct from Host + x-forwarded-proto.
// The Host+proto fallback is needed because mobile browsers often omit the Origin header
// on same-origin POST requests, which breaks WebAuthn on Render/HF behind a proxy.
function getWebAuthnConfig(req) {
  const envOrigin = process.env.ORIGIN;
  const envRpId   = process.env.RP_ID;
  if (envOrigin && envRpId) return { origin: envOrigin, rpId: envRpId };

  let reqOrigin = (req.headers.origin || '').replace(/\/$/, '');
  if (!reqOrigin && req.headers.referer) {
    try { reqOrigin = new URL(req.headers.referer).origin; } catch {}
  }
  // Last resort: build from Host header (always present) + forwarded proto
  if (!reqOrigin && req.headers.host) {
    const proto = req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http');
    reqOrigin = `${proto}://${req.headers.host}`;
  }

  const origin = envOrigin || reqOrigin || `http://localhost:${PORT}`;
  let rpId = envRpId;
  if (!rpId) {
    try { rpId = new URL(origin).hostname; } catch { rpId = 'localhost'; }
  }
  console.log('[WebAuthn] origin=%s rpId=%s', origin, rpId);
  return { origin, rpId };
}

// 1. Get registration options (challenge) — user must be logged in
app.post('/api/webauthn/register-options', authMiddleware, async (req, res) => {
  try {
    const { origin, rpId } = getWebAuthnConfig(req);
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const existing = await db.getWebAuthnCred(user.id);
    const options  = await generateRegistrationOptions({
      rpName:          RP_NAME,
      rpID:            rpId,
      userID:          String(user.id),
      userName:        user.display_name,
      userDisplayName: user.display_name,
      timeout:         60000,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey:      'required',
        userVerification: 'preferred',
      },
      excludeCredentials: existing ? [{
        id:   Buffer.from(existing.credentialID, 'base64url'),
        type: 'public-key',
      }] : [],
    });

    cache.put(`wa_reg_${user.id}`, { challenge: options.challenge, origin, rpId }, 120);
    res.json(options);
  } catch (err) {
    console.error('WebAuthn register-options:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 2. Verify registration and save credential
app.post('/api/webauthn/register-verify', authMiddleware, async (req, res) => {
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const cached = cache.get(`wa_reg_${user.id}`);
    if (!cached) return res.status(400).json({ error: 'Challenge expired — try again.' });
    const { challenge: expectedChallenge, origin, rpId } = cached;

    const verification = await verifyRegistrationResponse({
      response:          req.body,
      expectedChallenge,
      expectedOrigin:    origin,
      expectedRPID:      rpId,
    });

    if (!verification.verified) return res.status(400).json({ error: 'Verification failed' });

    const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;
    await db.saveWebAuthnCred(user.id, {
      credentialID:        Buffer.from(credentialID).toString('base64url'),
      credentialPublicKey: Buffer.from(credentialPublicKey).toString('base64url'),
      counter,
      transports: req.body.response?.transports || [],
    });

    cache.remove(`wa_reg_${user.id}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('WebAuthn register-verify:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 3. Get authentication options (public — no login required)
app.post('/api/webauthn/auth-options', async (req, res) => {
  try {
    const { origin, rpId } = getWebAuthnConfig(req);
    const sessionId = crypto.randomBytes(16).toString('hex');
    const options   = await generateAuthenticationOptions({
      rpID:              rpId,
      timeout:           60000,
      allowCredentials:  [],
      userVerification:  'preferred',
    });

    cache.put(`wa_auth_${sessionId}`, { challenge: options.challenge, origin, rpId }, 120);
    res.json({ ...options, sessionId });
  } catch (err) {
    console.error('WebAuthn auth-options:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 4. Verify authentication and return JWT
app.post('/api/webauthn/auth-verify', async (req, res) => {
  try {
    const { credential, sessionId } = req.body;
    if (!credential || !sessionId) return res.status(400).json({ error: 'Missing credential or sessionId' });

    const cached = cache.get(`wa_auth_${sessionId}`);
    if (!cached) return res.status(400).json({ error: 'Challenge expired — try again.' });
    const { challenge: expectedChallenge, origin, rpId } = cached;

    const user = await db.getUserByWebAuthnCredId(credential.id);
    if (!user) return res.status(400).json({ error: 'No biometric registered for this device. Log in with your PIN first and enable biometric.' });

    const cred = await db.getWebAuthnCred(user.id);

    const verification = await verifyAuthenticationResponse({
      response:          credential,
      expectedChallenge,
      expectedOrigin:    origin,
      expectedRPID:      rpId,
      authenticator: {
        credentialID:        Buffer.from(cred.credentialID, 'base64url'),
        credentialPublicKey: Buffer.from(cred.credentialPublicKey, 'base64url'),
        counter:             cred.counter,
        transports:          cred.transports || [],
      },
    });

    if (!verification.verified) return res.status(400).json({ error: 'Biometric check failed' });

    cred.counter = verification.authenticationInfo.newCounter;
    await db.saveWebAuthnCred(user.id, cred);
    cache.remove(`wa_auth_${sessionId}`);

    res.json({
      token:    signToken(user.display_name, user.role),
      role:     user.role,
      username: user.display_name,
    });
  } catch (err) {
    console.error('WebAuthn auth-verify:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  WEBHOOK SETUP ROUTE
// ============================================================
app.get('/setup', async (req, res) => {
  if (!TELEGRAM_TOKEN || !WEBHOOK_URL) return res.status(400).json({ error: 'TELEGRAM_TOKEN or WEBHOOK_URL not set in .env' });
  try {
    await axios.get(`${TELEGRAM_API}/deleteWebhook?drop_pending_updates=true`);
    const set = await axios.post(`${TELEGRAM_API}/setWebhook`, { url: `${WEBHOOK_URL}/webhook` });
    res.json({ status: '✅ Webhook set', ok: set.data.ok, description: set.data.description });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  GEMINI SYSTEM PROMPT — smarter field identification
// ============================================================
const CRM_SYSTEM_PROMPT = `You are a CRM data extraction AI for an adhesive sales team in India. Your ONLY output must be a single raw JSON object — no markdown, no code fences, no explanation.

FIELD IDENTIFICATION RULES:

FACTORY NUMBER: An alphanumeric code starting with 1-3 letters followed by digits (M277, F12, D5, B100, AB3). Always appears first or near the start of the message. This is NOT a person name and NOT a factory name. Examples: M277, F3, D12, AB100.

FACTORY NAME: The business/company name — often ends with words like "Industries", "Traders", "Enterprises", "Works", "Pvt", "Ltd", "Co", "Manufacturing", "Plastics", "Footwear", OR is a place name + industry type. Appears AFTER the factory number. Examples: "Ramesh Industries", "Surat Plastics", "Om Traders".

PERSON IN CHARGE: The human contact at the factory — typically a first name or full name, often followed by honorifics like "ji", "bhai", "sahab", "sir". Appears AFTER factory name. NOT the factory name itself. Examples: "Rameshji", "Suresh bhai", "Amit sahab", "Rajesh".

ITEMS: Extract as an array. Each item has product, quantity (with unit), and rate (number only, strip ₹ symbol).
- Products (all aliases recognised): "hotmelt"/"htmlt"/"hotmolt"/"hm" → "Hotmelt"; "rubber adhesive"/"rubad"/"rub ad"/"ra" → "Rubber Adhesive"; "solvent"/"solv"/"solv ad"/"sa" → "Solvent"; "latex"/"ltx" → "Latex"; "bc" → "BC"; "toluene"/"tol" → "Toluene"; "r6" → "R6"; "mek" → "MEK"; "pu adhesive"/"pu ad"/"puad"/"pu" → "PU Adhesive"; "silicon"/"silicone"/"sil" → "Silicon"
- Multiple items in ONE message: each product follows the pattern — product name → quantity → rate. Items can be separated by commas, slashes, "&", "and", "plus", newlines, or just listed one after another with no separator.
- Rate indicators: "@", "at", "rate", "₹", "rs", "pr", "per", "/kg", "/ltr" — extract the number after any of these
- Quantity units: kg, ltr, litre, ton, pcs, drum, barrel, can, bag — preserve as spoken. If no unit given, leave it as just the number.
- Format: [{"product":"Hotmelt","quantity":"500 kg","rate":"120"}]
- If only one item, still use array format. If no product found, use empty array [].
- MULTI-PRODUCT RULE: when you see multiple product names in one message, create a separate array entry for each — never merge them into one item.

LEAD TYPE: "hot"/"urgent"/"priority"/"ready to buy"/"confirmed"/"pakka"/"fix" → "Hot"; "warm"/"maybe"/"soch raha"/"considering"/"thinking"/"interested"/"dekhte hain" → "Warm"; "cold"/"not interested"/"baad mein"/"dormant"/"inactive"/"later"/"nahi chahiye" → "Cold". If not mentioned → "".

FOLLOW UP: Any date mention — "next week", "15 july", "monday", "15/07", "kal", "parso", convert to dd/MM/yyyy. "next week"/"agla hafte" = 7 days from now, "kal" = tomorrow, "aaj" = today, "is hafte" = this week. Leave empty if no date mentioned.

AREA: Extract any city, district, region, or location (e.g. "Mumbai", "Surat", "Bhiwandi", "Delhi NCR", "Agra", "Kanpur"). Title Case. Leave empty if none.

STAGE MAPPING: New Lead→1, Sample Required→2, Sample Sent→3, Quotation→4, Negotiation→5, Order Won→6, Repeat Customer→7, Lost→0. If no stage mentioned → stage:"", stage_number:null. "sample do"/"sample bhejo" → Sample Required. "order aa gaya"/"order mila"/"deal done" → Order Won. "baar baar leta hai"/"regular" → Repeat Customer.

NAME FORMATTING: Title Case. Name ending in "g" often means "ji" (Amitg → Amitji). Common name shorthand: "Rj" → "Rajesh", "Aj" → "Ajay" — expand only if obvious.

NOTES: Put anything that doesn't fit other fields into notes — complaints, special requests, custom requirements, context ("wants credit", "price too high bola", "compare kar raha competitor se").

LANGUAGE & SALESMAN STYLES: Messages come from different salespeople with very different styles — all must be handled:
- Brief shorthand: "M12 500 hm 120 hot" — extract everything even from terse input
- Hinglish natural: "M12 wale Rameshji ne bola 500 kg hotmelt chahiye, rate 120 pe dena, next week pakka"
- Voice/casual: "haan toh M277 Ramesh footwear ke Rameshji ne bola unhe hotmelt chahiye 500 kg, 120 ka rate, aur wo hot lead hai"
- Update only: "M12 follow up 15 july" — no product is fine
- Multi-product: "F3 200 rub ad 95, 100 ltx 45, 50 ltr bc 60"
- Hindi connectors to ignore: "ka", "ke", "ki", "se", "aur", "ko", "mein", "ne", "pe", "par", "wala", "wale", "toh", "bhi", "hai", "tha"

DISAMBIGUATION RULES:
- If a word has an honorific (ji/bhai/sahab/sir/g suffix) → it is PERSON IN CHARGE, not factory name
- Factory name usually has a business-type word (Industries/Traders/Works/Pvt/Ltd/Plastics/Footwear/Enterprises/Manufacturing). If none present, prefer leaving factory_name blank over guessing.
- Factory number always comes FIRST. Names come after it, before product/stage keywords.
- "pu" alone always means PU Adhesive (not a name or other word)

EXAMPLES (follow these exactly):

Input: "M277 Ramesh Footwear Rameshji 500 kg hotmelt @ 120 hot follow up 15/07"
Output: {"factory_number":"M277","factory_name":"Ramesh Footwear","person_in_charge":"Rameshji","contact":"","stage":"","stage_number":null,"follow_up":"15/07/2026","area":"","notes":"","lead_type":"Hot","items":[{"product":"Hotmelt","quantity":"500 kg","rate":"120"}]}

Input: "F3 Om Traders Suresh bhai rub ad 200 ltr 95 warm negotiation mumbai"
Output: {"factory_number":"F3","factory_name":"Om Traders","person_in_charge":"Suresh Bhai","contact":"","stage":"Negotiation","stage_number":5,"follow_up":"","area":"Mumbai","notes":"","lead_type":"Warm","items":[{"product":"Rubber Adhesive","quantity":"200 ltr","rate":"95"}]}

Input: "AB12 Surat Plastics Amitg sample sent"
Output: {"factory_number":"AB12","factory_name":"Surat Plastics","person_in_charge":"Amitji","contact":"","stage":"Sample Sent","stage_number":3,"follow_up":"","area":"","notes":"","lead_type":"","items":[]}

Input: "D5 order won hotmelt 1 ton 110 latex 100 ltr 45"
Output: {"factory_number":"D5","factory_name":"","person_in_charge":"","contact":"","stage":"Order Won","stage_number":6,"follow_up":"","area":"","notes":"","lead_type":"","items":[{"product":"Hotmelt","quantity":"1 ton","rate":"110"},{"product":"Latex","quantity":"100 ltr","rate":"45"}]}

Input: "M12 500 hm 120 hot"
Output: {"factory_number":"M12","factory_name":"","person_in_charge":"","contact":"","stage":"","stage_number":null,"follow_up":"","area":"","notes":"","lead_type":"Hot","items":[{"product":"Hotmelt","quantity":"500","rate":"120"}]}

Input: "B7 Rajesh bhai ne bola 200 ltr pu chahiye rate 185 pe, soch raha hai, agla hafte batayega"
Output: {"factory_number":"B7","factory_name":"","person_in_charge":"Rajesh Bhai","contact":"","stage":"","stage_number":null,"follow_up":"07/07/2026","area":"","notes":"","lead_type":"Warm","items":[{"product":"PU Adhesive","quantity":"200 ltr","rate":"185"}]}

Input: "K22 Krishna Industries follow up kal"
Output: {"factory_number":"K22","factory_name":"Krishna Industries","person_in_charge":"","contact":"","stage":"","stage_number":null,"follow_up":"01/07/2026","area":"","notes":"","lead_type":"","items":[]}

Input: "P9 200 hm 120, 100 ltr ltx 45, 50 bc 80, 100 pu 185 hot order won"
Output: {"factory_number":"P9","factory_name":"","person_in_charge":"","contact":"","stage":"Order Won","stage_number":6,"follow_up":"","area":"","notes":"","lead_type":"Hot","items":[{"product":"Hotmelt","quantity":"200","rate":"120"},{"product":"Latex","quantity":"100 ltr","rate":"45"},{"product":"BC","quantity":"50","rate":"80"},{"product":"PU Adhesive","quantity":"100","rate":"185"}]}

Input: "T3 Suresh bhai ne bola toluene 500 ltr 95, mek 200 ltr 110 aur r6 100 ltr 75 chahiye, warm hai agla hafte confirm karega"
Output: {"factory_number":"T3","factory_name":"","person_in_charge":"Suresh Bhai","contact":"","stage":"","stage_number":null,"follow_up":"07/07/2026","area":"","notes":"","lead_type":"Warm","items":[{"product":"Toluene","quantity":"500 ltr","rate":"95"},{"product":"MEK","quantity":"200 ltr","rate":"110"},{"product":"R6","quantity":"100 ltr","rate":"75"}]}

Return ONLY this JSON (no extra fields):
{
  "factory_number": "",
  "factory_name": "",
  "person_in_charge": "",
  "contact": "",
  "stage": "",
  "stage_number": null,
  "follow_up": "",
  "area": "",
  "notes": "",
  "lead_type": "",
  "items": [{"product": "", "quantity": "", "rate": ""}]
}`;

async function callGemini(userText) {
  for (const model of ['gemini-2.0-flash', 'gemini-2.0-flash-lite']) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const res = await axios.post(url, {
        system_instruction: { parts: [{ text: CRM_SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 768, responseMimeType: 'application/json' },
      });
      let raw = res.data.candidates[0].content.parts[0].text.trim()
        .replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/\s*```$/i,'').trim();
      console.log('✅ Gemini parsed via', model);
      const parsed = JSON.parse(raw);
      // Normalize items
      if (!Array.isArray(parsed.items) || !parsed.items.length) {
        parsed.items = parsed.product ? [{ product: parsed.product, quantity: parsed.quantity || '', rate: parsed.rate || '' }] : [];
      }
      return parsed;
    } catch (err) {
      const code = err.response?.data?.error?.code;
      if (code === 429 || code === 404) { console.warn(`⚠️ Gemini ${model} unavailable (${code})`); continue; }
      console.error('Gemini error:', err.response?.data || err.message);
    }
  }
  console.warn('⚠️ Gemini quota exhausted — using local parser');
  return localParse(userText);
}

// ============================================================
//  LOCAL FALLBACK PARSER
// ============================================================
function localParse(text) {
  const t  = text.trim();
  const tl = t.toLowerCase();

  // Factory number: 1-3 letters + digits at word boundary
  const factNumMatch = t.match(/\b([A-Za-z]{1,3}\d+)\b/);
  const factory_number = factNumMatch ? factNumMatch[1].toUpperCase() : '';

  // Extract items (multi-product support)
  const items = parseLocalItems(tl);
  const product  = items.length ? items[0].product  : '';
  const quantity = items.length ? items[0].quantity : '';
  const rate     = items.length ? items[0].rate     : '';

  // Stage
  const stagePatterns = [
    { keys: ['lost','cancelled','cancel','rejected','no deal'],           name: 'Lost',              num: 0 },
    { keys: ['new lead'],                                                  name: 'New Lead',          num: 1 },
    { keys: ['sample required','sample req','need sample','send sample'],  name: 'Sample Required',   num: 2 },
    { keys: ['sample sent','sent sample','sample dispatched'],             name: 'Sample Sent',       num: 3 },
    { keys: ['quotation','quote','pricing','price sent'],                  name: 'Quotation',         num: 4 },
    { keys: ['negotiation','negotiating','discussing'],                    name: 'Negotiation',       num: 5 },
    { keys: ['order won','won','confirmed','deal done','order confirmed'],  name: 'Order Won',         num: 6 },
    { keys: ['repeat','reorder','re-order','repeat customer'],             name: 'Repeat Customer',   num: 7 },
  ];
  let stage = '', stage_number = null;
  for (const { keys, name, num } of stagePatterns) {
    if (keys.some(k => tl.includes(k))) { stage = name; stage_number = num; break; }
  }

  // Follow-up date
  const fuMatch = t.match(/follow[\s-]?up\s+(.+?)(?:\s+(?:for|in|at|by|and|,|$))/i)
                || t.match(/follow[\s-]?up\s+(.+)$/i);
  const follow_up = fuMatch ? fuMatch[1].trim() : '';

  // Area
  const cities = ['mumbai','delhi','surat','ahmedabad','pune','bangalore','bengaluru','hyderabad',
    'chennai','kolkata','jaipur','lucknow','bhopal','indore','nagpur','vadodara',
    'bhiwandi','thane','navi mumbai','noida','gurgaon','gurugram','faridabad'];
  let area = '';
  for (const city of cities) {
    if (tl.includes(city)) { area = city.replace(/\b\w/g, c => c.toUpperCase()); break; }
  }

  // Factory name: words between factory_number and known keywords
  let factory_name = '';
  if (factory_number) {
    const afterNum = t.slice(t.toUpperCase().indexOf(factory_number) + factory_number.length).trim();
    const stopWords = ['follow','rate','₹','rs','kg','ltr','ton','hotmelt','htmlt','solvent','latex','rubad',
      'new lead','sample','quotation','negotiation','order','lost','repeat', quantity.split(' ')[0]].filter(Boolean);
    const stopRe = new RegExp('\\b(' + stopWords.join('|') + ')\\b', 'i');
    const m = afterNum.match(stopRe);
    const raw = m ? afterNum.slice(0, m.index).trim() : afterNum.split(/\s{2,}/)[0].trim();
    // Grab first 1-4 words — likely factory name
    const words = raw.split(/\s+/).slice(0, 4);
    // Detect person suffix (ji/bhai/sahab) to trim factory name
    const personIdx = words.findIndex(w => /ji$|bhai$|sahab$|sir$/i.test(w));
    factory_name = (personIdx > 0 ? words.slice(0, personIdx) : words).join(' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  // Person in charge: word ending in ji/bhai/sahab, or second name group after factory name
  let person_in_charge = '';
  const personMatch = t.match(/\b(\w+(?:ji|bhai|sahab|sir))\b/i);
  if (personMatch) person_in_charge = personMatch[1].replace(/\b\w/g, c => c.toUpperCase());

  // Lead type
  const typePatterns = [
    { keys: ['hot lead','hot ','urgent','priority','ready to buy'], type: 'Hot' },
    { keys: ['warm lead','warm ','maybe','considering','thinking'],  type: 'Warm' },
    { keys: ['cold lead','cold ','not interested','dormant'],        type: 'Cold' },
  ];
  let lead_type = '';
  for (const { keys, type } of typePatterns) {
    if (keys.some(k => tl.includes(k))) { lead_type = type; break; }
  }
  // Simple keyword check as fallback
  if (!lead_type) {
    if (/\bhot\b/i.test(t))  lead_type = 'Hot';
    else if (/\bwarm\b/i.test(t)) lead_type = 'Warm';
    else if (/\bcold\b/i.test(t)) lead_type = 'Cold';
  }

  console.log('📌 Local parser:', { factory_number, factory_name, person_in_charge, items, stage, follow_up, area, lead_type });
  return { factory_number, factory_name, person_in_charge, contact:'', product, quantity, rate, stage, follow_up, notes:'', area, stage_number, lead_type, items };
}

function parseLocalItems(tl) {
  const productMap = {
    'rubber adhesive': 'Rubber Adhesive',
    'rub ad': 'Rubber Adhesive',
    'rubad':  'Rubber Adhesive',
    'ra':     'Rubber Adhesive',
    'hotmelt':'Hotmelt',
    'hotmolt':'Hotmelt',
    'htmlt':  'Hotmelt',
    'hmelt':  'Hotmelt',
    'hm':     'Hotmelt',
    'solvent':'Solvent',
    'solv':   'Solvent',
    'solv ad':'Solvent',
    'sa':     'Solvent',
    'latex':  'Latex',
    'ltx':    'Latex',
    'bc':     'BC',
    'toluene':'Toluene',
    'tol':    'Toluene',
    'r6':     'R6',
    'mek':    'MEK',
    'pu adhesive': 'PU Adhesive',
    'pu ad':  'PU Adhesive',
    'puad':   'PU Adhesive',
    'pu':     'PU Adhesive',
    'silicon':'Silicon',
    'silicone':'Silicon',
    'sil':    'Silicon',
  };

  const items  = [];
  let lastPos  = 0;

  // Find all product occurrences in order
  const productOccurrences = [];
  for (const [alias, name] of Object.entries(productMap)) {
    let pos = tl.indexOf(alias, 0);
    while (pos !== -1) {
      // Short aliases (<=3 chars) must be at word boundaries to avoid false matches
      // e.g. "ra" in "rate", "sa" in "sample", "pu" in "supply"
      if (alias.length <= 3) {
        const before = pos > 0 ? tl[pos - 1] : ' ';
        const after  = tl[pos + alias.length] || ' ';
        if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) {
          pos = tl.indexOf(alias, pos + 1);
          continue;
        }
      }
      productOccurrences.push({ pos, alias, name });
      pos = tl.indexOf(alias, pos + 1);
    }
  }
  productOccurrences.sort((a, b) => a.pos - b.pos);

  // Deduplicate: remove longer match if shorter alias already matched at same position
  const seen = new Set();
  const uniqueOccurrences = productOccurrences.filter(o => {
    const key = o.pos;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (const { pos, alias, name } of uniqueOccurrences) {
    if (pos < lastPos) continue;
    const after = tl.slice(pos + alias.length);

    // Quantity: first number after product
    const qtyMatch = after.match(/[\s@x×:]*(\d+(?:\.\d+)?)\s*(kg|ltr|liter|ton|pcs|bags?)?/i);
    const quantity = qtyMatch ? qtyMatch[1] + (qtyMatch[2] ? ' ' + qtyMatch[2] : '') : '';

    // Rate: after @, ₹, rs, or second number
    const rateMatch = after.match(/[@₹]\s*(\d+(?:\.\d+)?)/i)
                    || after.match(/(?:rs\.?|rate[:\s]+)\s*(\d+(?:\.\d+)?)/i)
                    || (qtyMatch ? after.slice((qtyMatch.index || 0) + qtyMatch[0].length).match(/[\s@×:]*(\d+(?:\.\d+)?)/) : null);
    const rate = rateMatch ? rateMatch[1] : '';

    items.push({ product: name, quantity, rate: rate ? '₹' + rate : '' });
    lastPos = pos + alias.length + (qtyMatch ? qtyMatch[0].length : 0);
  }

  return items;
}

// ============================================================
//  HELPERS
// ============================================================
async function findExistingLead(parsed) {
  const leads = await db.getLeads();
  const pNum  = String(parsed.factory_number || '').trim().toLowerCase();
  const pName = String(parsed.factory_name   || '').trim().toLowerCase();
  let existingRow = -1;
  for (const lead of leads) {
    const rNum  = String(lead.factory_number || '').trim().toLowerCase();
    const rName = String(lead.factory_name   || '').trim().toLowerCase();
    if (pNum && pNum === rNum)             { existingRow = lead.rowIndex; break; }
    if (!pNum && pName && pName === rName) { existingRow = lead.rowIndex; break; }
  }
  const action = existingRow !== -1 ? 'UPDATE' : 'ADD';
  return { existingRow, action, leads };
}

function dateIST(offsetDays = 0) {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000) + now.getTimezoneOffset() * 60000);
  ist.setDate(ist.getDate() + offsetDays);
  const dd   = String(ist.getDate()).padStart(2, '0');
  const mm   = String(ist.getMonth() + 1).padStart(2, '0');
  const yyyy = ist.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function parseDateInput(text) {
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(text)) return text;
  const tl = text.toLowerCase();
  if (/next week/i.test(tl))    return dateIST(7);
  if (/tomorrow/i.test(tl))     return dateIST(1);
  if (/in 2 days/i.test(tl))   return dateIST(2);
  if (/in 2 weeks/i.test(tl))  return dateIST(14);
  if (/next month/i.test(tl))  return dateIST(30);
  // Try native parse
  const parsed = new Date(text);
  if (!isNaN(parsed.getTime())) {
    return `${String(parsed.getDate()).padStart(2,'0')}/${String(parsed.getMonth()+1).padStart(2,'0')}/${parsed.getFullYear()}`;
  }
  return text;
}

function parseItemsText(text) {
  const productAliases = {
    'rubber adhesive': 'Rubber Adhesive', 'rub ad': 'Rubber Adhesive', 'rubad': 'Rubber Adhesive',
    'hotmelt': 'Hotmelt', 'hotmolt': 'Hotmelt', 'htmlt': 'Hotmelt', 'hmelt': 'Hotmelt',
    'solvent': 'Solvent', 'solv': 'Solvent',
    'latex': 'Latex', 'ltx': 'Latex',
  };

  const parts = text.split(/[,;]/).map(s => s.trim()).filter(Boolean);
  const items = [];

  for (const part of parts) {
    const pl = part.toLowerCase();
    let productName = '';
    for (const [alias, name] of Object.entries(productAliases)) {
      if (pl.includes(alias)) { productName = name; break; }
    }

    const tokens = part.trim().split(/\s+/);
    if (!productName && tokens.length >= 1) {
      productName = tokens[0].replace(/\b\w/g, c => c.toUpperCase());
    }

    const nums = part.match(/\d+(?:\.\d+)?/g) || [];
    const quantity = nums[0] || '';
    const rate     = nums[1] ? '₹' + nums[1] : '';

    items.push({ product: productName, quantity, rate });
  }
  return items;
}

function parseStageInput(text) {
  const n = parseInt(text, 10);
  if (!isNaN(n) && n >= 0 && n <= 7) return { stage: STAGE_NAMES[n], stage_number: n };
  const nameMap = { 'new lead':1,'sample required':2,'sample req':2,'sample sent':3,'quotation':4,'negotiation':5,'order won':6,'won':6,'repeat customer':7,'repeat':7,'lost':0 };
  const match = nameMap[text.toLowerCase().trim()];
  if (match !== undefined) return { stage: STAGE_NAMES[match], stage_number: match };
  return { stage: text, stage_number: null };
}

async function sendEditAllFieldPrompt(chatId, parsed, fieldIndex) {
  const field = EDITALL_FIELDS[fieldIndex];
  let currentVal = '';

  if (field.key === 'items') {
    const items = parsed.items && parsed.items.length ? parsed.items : (parsed.product ? [{ product: parsed.product, quantity: parsed.quantity, rate: parsed.rate }] : []);
    currentVal = items.length ? items.map(i => `${i.product} ${i.quantity} ${i.rate}`).join(', ') : '—';
  } else {
    currentVal = parsed[field.key] || '—';
  }

  const progress = `[${fieldIndex + 1}/${EDITALL_FIELDS.length}]`;
  await sendTelegram('sendMessage', {
    chat_id:    chatId,
    parse_mode: 'HTML',
    text: `${progress} ✏️ <b>${field.label}</b>\n<i>Current: ${esc(String(currentVal))}</i>\n\n${field.hint}\n\n<code>.</code> to keep current`,
  });
}

function buildPreview(p, action, existingRow) {
  const actionTag    = action === 'UPDATE' ? `🔄 <b>UPDATE</b> — Row ${existingRow}` : '🆕 <b>NEW ENTRY</b>';
  const stageDisplay = p.stage ? esc(p.stage) + (p.stage_number != null ? ` (#${p.stage_number})` : '') : '—';
  const typeEmoji    = { Hot: '🔥', Warm: '🟡', Cold: '🔵' };
  const typeDisplay  = p.lead_type ? (typeEmoji[p.lead_type] || '') + ' ' + esc(p.lead_type) : '—';

  const itemsList = p.items && p.items.length
    ? p.items
    : (p.product ? [{ product: p.product, quantity: p.quantity, rate: p.rate }] : []);

  const itemsBlock = itemsList.length
    ? '\n' + itemsList.map((it, i) => `   ${i + 1}. ${esc(it.product)} × ${esc(it.quantity)} @ ₹${esc(it.rate)}`).join('\n')
    : '\n   —';

  return [
    '📋 <b>CRM Entry Preview</b>', actionTag, '━━━━━━━━━━━━━━━━━━━━',
    `🏭 <b>Factory #:</b>   ${esc(p.factory_number)}`,
    `🏢 <b>Factory:</b>     ${esc(p.factory_name)}`,
    `👤 <b>Person:</b>      ${esc(p.person_in_charge)}`,
    `📞 <b>Contact:</b>     ${esc(p.contact)}`,
    `📦 <b>Items:</b>${itemsBlock}`,
    `📊 <b>Stage:</b>       ${stageDisplay}`,
    `🌡️ <b>Lead Type:</b>   ${typeDisplay}`,
    `📅 <b>Follow Up:</b>   ${esc(p.follow_up)}`,
    `📝 <b>Notes:</b>       ${esc(p.notes)}`,
    `🗺️ <b>Area:</b>        ${esc(p.area)}`,
    '━━━━━━━━━━━━━━━━━━━━',
  ].join('\n');
}

function confirmEditKeyboard(uuid, currentLeadType = '') {
  const hot  = currentLeadType === 'Hot'  ? '🔥 Hot ✓'  : '🔥 Hot';
  const warm = currentLeadType === 'Warm' ? '🟡 Warm ✓' : '🟡 Warm';
  const cold = currentLeadType === 'Cold' ? '🔵 Cold ✓' : '🔵 Cold';
  return {
    inline_keyboard: [
      [
        { text: hot,  callback_data: 'TEMP_Hot_'  + uuid },
        { text: warm, callback_data: 'TEMP_Warm_' + uuid },
        { text: cold, callback_data: 'TEMP_Cold_' + uuid },
      ],
      [
        { text: '✅ Confirm',  callback_data: 'CONFIRM_'  + uuid },
        { text: '✏️ Edit All', callback_data: 'EDITALL_'  + uuid },
        { text: '❌ Cancel',   callback_data: 'CANCEL_'   + uuid },
      ],
    ],
  };
}

// Broadcast a follow-up opportunity to all team members (bid system)
// ============================================================
//  DAILY BRIEFINGS & NOTIFICATIONS
// ============================================================

function todayIST() {
  return new Date().toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric',
  }); // "01/07/2026"
}

function nowHHMM() {
  return new Date().toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  }).trim(); // "09:00"
}

function parseFollowUpDate(s) {
  if (!s) return null;
  const [d, m, y] = s.split('/');
  if (!d || !m || !y) return null;
  return new Date(Number(y), Number(m) - 1, Number(d));
}

async function sendToAllTelegram(text, opts = {}) {
  const users = await db.getAllUsers();
  for (const u of users) {
    if (!u.telegram_user_id) continue;
    try { await sendTelegram('sendMessage', { chat_id: u.telegram_user_id, text, parse_mode: 'HTML', ...opts }); }
    catch (_) {}
  }
}

async function sendMorningBriefing() {
  try {
    const leads  = await db.getLeads();
    const today  = todayIST();
    const todayD = parseFollowUpDate(today);

    const active   = leads.filter(l => l.stage !== 'Lost');
    const hot      = active.filter(l => l.lead_type === 'Hot');
    const warm     = active.filter(l => l.lead_type === 'Warm');
    const dueToday = active.filter(l => l.follow_up === today);
    const overdue  = active.filter(l => {
      if (!l.follow_up) return false;
      const d = parseFollowUpDate(l.follow_up);
      return d && d < todayD;
    });

    const lines = [
      `🌅 <b>Good Morning! Daily Briefing</b>`,
      `📅 ${today}`,
      ``,
      `📊 <b>Pipeline</b>  🔥 Hot: <b>${hot.length}</b>  🟡 Warm: <b>${warm.length}</b>  📋 Total: <b>${active.length}</b>`,
    ];

    if (dueToday.length) {
      lines.push(``, `📅 <b>Follow-ups Due Today (${dueToday.length})</b>`);
      dueToday.slice(0, 8).forEach(l => {
        const e = { Hot: '🔥', Warm: '🟡', Cold: '🔵' }[l.lead_type] || '◎';
        lines.push(`${e} ${esc(l.factory_name || l.factory_number)} — ${esc(l.stage || '—')}`);
      });
      if (dueToday.length > 8) lines.push(`   …and ${dueToday.length - 8} more`);
    }

    if (overdue.length) {
      lines.push(``, `⚠️ <b>Overdue Follow-ups (${overdue.length})</b>`);
      overdue.slice(0, 5).forEach(l => {
        lines.push(`◎ ${esc(l.factory_name || l.factory_number)} — was due ${esc(l.follow_up)}`);
      });
      if (overdue.length > 5) lines.push(`   …and ${overdue.length - 5} more`);
    }

    if (!dueToday.length && !overdue.length) lines.push(``, `✅ No follow-ups due today — have a great day!`);

    await sendToAllTelegram(lines.join('\n'));
    console.log('📅 Morning briefing sent');
  } catch (err) { console.error('Morning briefing error:', err.message); }
}

async function sendEveningBriefing() {
  try {
    const leads = await db.getLeads();
    const today = todayIST(); // "01/07/2026"

    const todayLeads = leads.filter(l => (l.last_updated || '').startsWith(today));
    const ordersWon  = todayLeads.filter(l => l.stage === 'Order Won');
    const newLeads   = todayLeads.filter(l => {
      // Rough: if created_by is set and it's in today's updates, count as new
      const notUpdatedStages = ['Order Won', 'Lost', 'Repeat Customer'];
      return !notUpdatedStages.includes(l.stage);
    });

    const lines = [
      `🌆 <b>End of Day Summary</b>`,
      `📅 ${today}`,
      ``,
      `📦 Leads touched today: <b>${todayLeads.length}</b>  |  🏆 Orders Won: <b>${ordersWon.length}</b>`,
    ];

    if (ordersWon.length) {
      lines.push(``, `🏆 <b>Orders Won Today</b>`);
      ordersWon.forEach(l => {
        const items = (l.items || []).map(i => `${i.product} ${i.quantity}`.trim()).filter(Boolean).join(', ');
        lines.push(`✅ <b>${esc(l.factory_name || l.factory_number)}</b>${items ? ' — ' + esc(items) : ''}`);
      });
    }

    if (todayLeads.length) {
      lines.push(``, `📋 <b>Activity</b>`);
      todayLeads.slice(0, 10).forEach(l => {
        const e = { Hot: '🔥', Warm: '🟡', Cold: '🔵' }[l.lead_type] || '◎';
        lines.push(`${e} ${esc(l.factory_name || l.factory_number)} → ${esc(l.stage || '—')} <i>${esc(l.created_by || '')}</i>`);
      });
      if (todayLeads.length > 10) lines.push(`   …and ${todayLeads.length - 10} more`);
    } else {
      lines.push(``, `No leads were updated today.`);
    }

    await sendToAllTelegram(lines.join('\n'));
    console.log('🌆 Evening briefing sent');
  } catch (err) { console.error('Evening briefing error:', err.message); }
}

async function notifyOrderWon(lead, byUser) {
  try {
    const items = (lead.items || []).map(i => `${i.product} ${i.quantity}${i.rate ? ' @₹' + i.rate : ''}`).join(', ');
    const text = [
      `🏆 <b>Order Won!</b>`,
      ``,
      `🏭 <b>${esc(lead.factory_name || lead.factory_number)}</b>`,
      items        ? `📦 ${esc(items)}`   : '',
      lead.area    ? `📍 ${esc(lead.area)}` : '',
      `👤 Closed by: <b>${esc(byUser)}</b>`,
    ].filter(Boolean).join('\n');
    await sendToAllTelegram(text);
  } catch (_) {}
}

const _briefingSent = { morning: '', evening: '' };

function startDailyBriefings() {
  setInterval(async () => {
    const hhmm = nowHHMM();
    const today = todayIST();
    if (hhmm === '09:00' && _briefingSent.morning !== today) {
      _briefingSent.morning = today;
      await sendMorningBriefing();
    }
    if (hhmm === '19:00' && _briefingSent.evening !== today) {
      _briefingSent.evening = today;
      await sendEveningBriefing();
    }
  }, 60000);
  console.log('   Briefings   : ⏰ 9:00 AM & 7:00 PM IST');
}

async function broadcastFollowUpAvailable(leadId, dateStr) {
  const leads = await db.getLeads();
  const lead  = leads.find(l => l.rowIndex === String(leadId));
  if (!lead) return;
  const users = await db.getAllUsers();
  const typeEmoji = { Hot: '🔥', Warm: '🟡', Cold: '🔵' }[lead.lead_type] || '';
  const text = [
    `📅 <b>Follow-up Available ${typeEmoji}</b>`,
    '',
    `🏭 <b>${esc(lead.factory_name || lead.factory_number)}</b>`,
    formatContacts(lead),
    `📅 Date: <b>${esc(dateStr)}</b>  📊 ${esc(lead.stage || '—')}`,
    '',
    '✋ First to tap below handles this follow-up:',
  ].join('\n');
  for (const u of users) {
    if (!u.telegram_user_id) continue;
    try {
      await sendTelegram('sendMessage', {
        chat_id: u.telegram_user_id, text, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '✋ Claim this follow-up', callback_data: 'CLAIM_' + leadId }]] },
      });
    } catch (_) {}
  }
}

async function sendTelegram(method, params) {
  try { await axios.post(`${TELEGRAM_API}/${method}`, params); }
  catch (err) { console.error(`Telegram.${method}:`, err.response?.data || err.message); }
}

function esc(v) {
  if (v === undefined || v === null || String(v).trim() === '') return '—';
  return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ============================================================
//  POLLING — auto-starts when WEBHOOK_URL is not set
// ============================================================
function usePolling() {
  return !WEBHOOK_URL || WEBHOOK_URL.includes('your-domain');
}

async function startPolling() {
  try { await axios.get(`${TELEGRAM_API}/deleteWebhook?drop_pending_updates=true`, { timeout: 5000 }); } catch (_) {}
  console.log('   Bot status  : 🟢 Listening via long-poll\n');
  let offset  = 0;
  let backoff = 3000;
  while (true) {
    try {
      const res = await axios.get(`${TELEGRAM_API}/getUpdates`, {
        params: { offset, timeout: 10, allowed_updates: ['message', 'callback_query'] },
        timeout: 15000,
      });
      backoff = 3000;
      const updates = res.data.result || [];
      for (const update of updates) {
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
      if (!msg.includes('ENOTFOUND') && !msg.includes('ECONNRESET') && !msg.includes('ECONNABORTED')) {
        console.error('Poll error:', msg);
      } else if (backoff >= 30000) {
        console.warn(`⚠️ Network issue — retrying in ${backoff / 1000}s...`);
      }
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60000);
    }
  }
}

// ============================================================
//  START
// ============================================================
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
