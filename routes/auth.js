'use strict';

const express  = require('express');
const crypto   = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const db       = require('../db');
const rateLimit = require('express-rate-limit');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const cache    = require('../cache');
const {
  signAccessToken, signToken,
  authMiddleware,
  parseBrowser, parseOS, parseDeviceName, getIP,
} = require('../middleware/auth');

const router = express.Router();

const PORT = process.env.PORT || 3000;
// Env-credential fast-path only works when explicitly configured —
// no hardcoded fallbacks (the seeded DB admin covers first-boot login).
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const SALES_USER = process.env.SALES_USER || '';
const SALES_PASS = process.env.SALES_PASS || '';

// Shared password strength check — min 8 chars with at least one letter and one number.
function validatePassword(pw) {
  const s = String(pw || '');
  if (s.length < 8) return 'Password must be at least 8 characters';
  if (s.length > 128) return 'Password is too long';
  if (!/[a-zA-Z]/.test(s) || !/\d/.test(s)) return 'Password must include at least one letter and one number';
  return null;
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
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

// ── POST /api/auth/login ──────────────────────────────────────
router.post(['/auth/login', '/login'], loginLimiter, async (req, res, next) => {
  const { credential, username, password, pin, fingerprint, trustDevice, deviceMeta } = req.body || {};
  const cred   = (credential || username || '').trim();
  const secret = (password  || pin      || '').trim();
  const ip     = getIP(req);
  const ua     = req.headers['user-agent'] || '';

  if (!cred || !secret) return res.status(400).json({ error: 'Credential and password/PIN are required' });

  try {
    const envAdminMatch = ADMIN_USER && ADMIN_PASS && cred === ADMIN_USER && secret === ADMIN_PASS;
    const envSalesMatch = SALES_USER && SALES_PASS && cred === SALES_USER && secret === SALES_PASS;
    if (envAdminMatch || envSalesMatch) {
      const role     = envAdminMatch ? 'admin' : 'sales';
      const dbUser   = await db.getUserByCredential(cred);
      const userId   = dbUser?.id || 0;
      let   session  = null;
      if (userId) session = await db.createSession(userId, null, ip, ua);
      const sessionId = session?.id || uuidv4();
      const token     = signAccessToken(userId, cred, role, sessionId);
      const refresh   = session ? await db.issueRefreshToken(session.id) : null;
      if (userId) await db.logSecurity(userId, 'login_success', { method: 'env' }, ip, ua, session?.id, null);
      return res.json({ token, accessToken: token, refreshToken: refresh, role, username: cred,
        userId, sessionId, deviceId: session?.id || null, deviceTrusted: false, hasPIN: false, teams: [] });
    }

    const user = await db.getUserByCredential(cred);
    if (!user) {
      await db.logSecurity(null, 'login_failed', { credential: cred, reason: 'user_not_found' }, ip, ua, null, null);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
      return res.status(423).json({ error: `Account locked. Try again in ${mins} minute${mins !== 1 ? 's' : ''}.` });
    }

    // Primary credential is the account password. Accounts created before the
    // password migration have none yet — accept their existing PIN once and flag
    // that they must set a password (handled by the client's blocking setup step).
    let valid = false;
    let needsPasswordSetup = false;
    if (user.password_hash) {
      valid = !!(await db.verifyUserPassword(user.display_name, secret));
    } else {
      valid = !!(await db.verifyUserPin(user.display_name, secret));
      needsPasswordSetup = valid;
    }

    if (!valid) {
      await db.incrementFailedAttempts(user.id);
      await db.logSecurity(user.id, 'login_failed', { reason: 'wrong_secret' }, ip, ua, null, null);
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

    const session     = await db.createSession(user.id, device?.id || null, ip, ua);
    const accessToken = signAccessToken(user.id, user.display_name, user.role, session.id);
    const refreshToken = await db.issueRefreshToken(session.id);
    const hasPIN      = device ? await db.hasDevicePin(user.id, device.id) : false;
    const teams       = await db.getUserTeams(user.id);

    await db.logSecurity(user.id, 'login_success', { device: device?.device_name }, ip, ua, session.id, device?.id);

    res.json({
      token: accessToken, accessToken, refreshToken,
      role: user.role, username: user.display_name,
      userId: user.id, sessionId: session.id,
      deviceId: device?.id || null,
      deviceTrusted: !!device,
      hasPIN, teams, needsPasswordSetup,
    });
  } catch (err) { next(err); }
});

// ── POST /api/auth/set-password ───────────────────────────────
// Used both by the one-time migration (legacy accounts with no password)
// and for changing an existing password (requires the current one).
router.post('/auth/set-password', authMiddleware, async (req, res, next) => {
  const { password, currentPassword } = req.body || {};
  const err = validatePassword(password);
  if (err) return res.status(400).json({ error: err });
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    // Changing an existing password requires proving the current one.
    if (user.password_hash) {
      if (!currentPassword || !(await db.verifyUserPassword(user.display_name, currentPassword))) {
        return res.status(401).json({ error: 'Current password is incorrect' });
      }
    }
    await db.setUserPassword(user.id, password);
    await db.logSecurity(user.id, 'password_set', {}, getIP(req), req.headers['user-agent'] || '', req.user.sessionId, null);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── POST /api/auth/guest ──────────────────────────────────────
router.post('/auth/guest', (req, res) => {
  const JWT_SECRET = process.env.JWT_SECRET || 'crm_default_secret_change_me';
  const jwt = require('jsonwebtoken');
  const token = jwt.sign(
    { sub: 'guest', username: 'Guest', role: 'guest', jti: uuidv4() },
    JWT_SECRET,
    { expiresIn: '4h' }
  );
  res.json({ accessToken: token, username: 'Guest', role: 'guest' });
});

// ── POST /api/auth/refresh ────────────────────────────────────
router.post('/auth/refresh', async (req, res, next) => {
  const { refreshToken } = req.body || {};
  if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
  try {
    const { sessionId, newRaw } = await db.rotateRefreshToken(refreshToken);
    const session = await db.getSessionById(sessionId);
    if (!session || session.revoked) return res.status(401).json({ error: 'Session revoked' });
    const { rows: [u] } = await pool.query('SELECT * FROM users WHERE id=$1', [session.user_id]);
    if (!u) return res.status(401).json({ error: 'User not found' });
    const accessToken = signAccessToken(u.id, u.display_name, u.role, sessionId);
    res.json({ accessToken, refreshToken: newRaw, username: u.display_name, role: u.role });
  } catch (err) { res.status(err.status || 401).json({ error: err.message }); }
});

// ── POST /api/auth/logout ─────────────────────────────────────
router.post('/auth/logout', authMiddleware, async (req, res) => {
  const { sessionId } = req.user;
  if (sessionId) {
    await db.revokeSession(sessionId);
    await db.logSecurity(req.user.userId ? parseInt(req.user.userId) : null,
      'logout', {}, getIP(req), req.headers['user-agent'] || '', sessionId, null);
  }
  res.json({ success: true });
});

// ── POST /api/auth/logout-all ─────────────────────────────────
router.post('/auth/logout-all', authMiddleware, async (req, res) => {
  const user = await db.getUserByName(req.user.username);
  if (user) {
    await db.revokeAllUserSessions(user.id, req.user.sessionId || null);
    await db.logSecurity(user.id, 'logout_all', {}, getIP(req), req.headers['user-agent'] || '', req.user.sessionId, null);
  }
  res.json({ success: true });
});

// ── POST /api/auth/pin-setup ──────────────────────────────────
router.post('/auth/pin-setup', authMiddleware, async (req, res, next) => {
  const { pin, deviceId } = req.body || {};
  if (!pin || !/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be 4–6 digits' });
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const device = await db.getDeviceById(deviceId, user.id);
    if (!device) return res.status(404).json({ error: 'Device not found or not trusted' });
    await db.setupDevicePin(user.id, device.id, pin);
    await db.logSecurity(user.id, 'pin_created', { device: device.device_name },
      getIP(req), req.headers['user-agent'] || '', req.user.sessionId, device.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── POST /api/auth/pin-unlock ─────────────────────────────────
router.post('/auth/pin-unlock', async (req, res, next) => {
  const { refreshToken, pin, deviceId } = req.body || {};
  if (!refreshToken || !pin || !deviceId) return res.status(400).json({ error: 'refreshToken, pin, and deviceId required' });
  try {
    const { sessionId, newRaw } = await db.rotateRefreshToken(refreshToken);
    const session = await db.getSessionById(sessionId);
    if (!session || session.revoked) return res.status(401).json({ error: 'Session invalid' });
    const { rows: [u] } = await pool.query('SELECT * FROM users WHERE id=$1', [session.user_id]);
    if (!u) return res.status(401).json({ error: 'User not found' });
    const result = await db.verifyDevicePin(u.id, deviceId, pin);
    if (!result.ok) {
      if (result.reason === 'locked') return res.status(423).json({ error: 'PIN locked. Use password to log in.' });
      if (result.reason === 'no_pin') return res.status(404).json({ error: 'No PIN set for this device' });
      await db.logSecurity(u.id, 'pin_failed', { attemptsLeft: result.attemptsLeft },
        getIP(req), req.headers['user-agent'] || '', sessionId, deviceId);
      return res.status(401).json({ error: `Wrong PIN. ${result.attemptsLeft} attempt${result.attemptsLeft !== 1 ? 's' : ''} remaining.` });
    }
    const accessToken = signAccessToken(u.id, u.display_name, u.role, sessionId);
    await db.logSecurity(u.id, 'pin_unlock', {}, getIP(req), req.headers['user-agent'] || '', sessionId, deviceId);
    res.json({ accessToken, refreshToken: newRaw, username: u.display_name, role: u.role, userId: u.id });
  } catch (err) { res.status(err.status || 401).json({ error: err.message }); }
});

// ── POST /api/auth/pin-check ──────────────────────────────────
router.post('/auth/pin-check', async (req, res) => {
  const { refreshToken, deviceId } = req.body || {};
  if (!refreshToken || !deviceId) return res.json({ hasPIN: false });
  try {
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

// ── DELETE /api/auth/pin ──────────────────────────────────────
router.delete('/auth/pin', authMiddleware, async (req, res, next) => {
  const { deviceId } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: 'deviceId required' });
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await pool.query(`DELETE FROM device_pins WHERE user_id=$1 AND device_id=$2`, [user.id, deviceId]);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── POST /api/auth/forgot-password ───────────────────────────
router.post('/auth/forgot-password', resetLimiter, async (req, res, next) => {
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'Credential required' });
  try {
    const user = await db.getUserByCredential(credential.trim());
    if (user) {
      await db.logSecurity(user.id, 'reset_requested', { credential },
        getIP(req), req.headers['user-agent'] || '', null, null);
    }
    res.json({ message: 'If that account exists, your admin can reset your PIN from Team → Reset PIN.' });
  } catch (err) { next(err); }
});

// ── GET /api/sessions ─────────────────────────────────────────
router.get('/sessions', authMiddleware, async (req, res, next) => {
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'Not found' });
    const sessions = await db.listUserSessions(user.id);
    res.json(sessions.map(s => ({ ...s, current: s.id === req.user.sessionId })));
  } catch (err) { next(err); }
});

// ── DELETE /api/sessions/:id ──────────────────────────────────
router.delete('/sessions/:id', authMiddleware, async (req, res, next) => {
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'Not found' });
    const session = await db.getSessionById(req.params.id);
    if (!session || session.user_id !== user.id) return res.status(404).json({ error: 'Session not found' });
    await db.revokeSession(req.params.id);
    await db.logSecurity(user.id, 'session_revoked', { sessionId: req.params.id },
      getIP(req), req.headers['user-agent'] || '', req.user.sessionId, null);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── DELETE /api/sessions ──────────────────────────────────────
router.delete('/sessions', authMiddleware, async (req, res, next) => {
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'Not found' });
    await db.revokeAllUserSessions(user.id, req.user.sessionId);
    await db.logSecurity(user.id, 'logout_all_others', {}, getIP(req), req.headers['user-agent'] || '', req.user.sessionId, null);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── GET /api/devices ──────────────────────────────────────────
router.get('/devices', authMiddleware, async (req, res, next) => {
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json(await db.listUserDevices(user.id));
  } catch (err) { next(err); }
});

// ── PATCH /api/devices/:id ────────────────────────────────────
router.patch('/devices/:id', authMiddleware, async (req, res, next) => {
  const { name } = req.body || {};
  if (!name || name.trim().length < 1) return res.status(400).json({ error: 'Name required' });
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'Not found' });
    await db.renameDevice(req.params.id, user.id, name.trim());
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── DELETE /api/devices/:id ───────────────────────────────────
router.delete('/devices/:id', authMiddleware, async (req, res, next) => {
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'Not found' });
    await db.removeDevice(req.params.id, user.id);
    await pool.query(`UPDATE sessions SET revoked=TRUE WHERE device_id=$1 AND user_id=$2`, [req.params.id, user.id]);
    await db.logSecurity(user.id, 'device_removed', { deviceId: req.params.id },
      getIP(req), req.headers['user-agent'] || '', req.user.sessionId, req.params.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── GET /api/security-log ─────────────────────────────────────
router.get('/security-log', authMiddleware, async (req, res, next) => {
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'Not found' });
    const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
    res.json(await db.getUserSecurityLog(user.id, limit));
  } catch (err) { next(err); }
});

// ============================================================
//  WEBAUTHN
// ============================================================
const RP_NAME = 'SalesCRM';

function getWebAuthnConfig(req) {
  const envOrigin = process.env.ORIGIN;
  const envRpId   = process.env.RP_ID;
  if (envOrigin && envRpId) return { origin: envOrigin, rpId: envRpId };

  let reqOrigin = (req.headers.origin || '').replace(/\/$/, '');
  if (!reqOrigin && req.headers.referer) {
    try { reqOrigin = new URL(req.headers.referer).origin; } catch {}
  }
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

// 1. Register options
router.post('/webauthn/register-options', authMiddleware, async (req, res, next) => {
  try {
    const { origin, rpId } = getWebAuthnConfig(req);
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const existing = await db.getWebAuthnCred(user.id);
    const options  = await generateRegistrationOptions({
      rpName: RP_NAME, rpID: rpId,
      userID: String(user.id), userName: user.display_name, userDisplayName: user.display_name,
      timeout: 60000, attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      excludeCredentials: existing ? [{ id: Buffer.from(existing.credentialID, 'base64url'), type: 'public-key' }] : [],
    });
    cache.put(`wa_reg_${user.id}`, { challenge: options.challenge, origin, rpId }, 120);
    res.json(options);
  } catch (err) { next(err); }
});

// 2. Register verify
router.post('/webauthn/register-verify', authMiddleware, async (req, res, next) => {
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const cached = cache.get(`wa_reg_${user.id}`);
    if (!cached) return res.status(400).json({ error: 'Challenge expired — try again.' });
    const { challenge: expectedChallenge, origin, rpId } = cached;
    const verification = await verifyRegistrationResponse({
      response: req.body, expectedChallenge, expectedOrigin: origin, expectedRPID: rpId,
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
  } catch (err) { next(err); }
});

// 3. Auth options (public)
router.post('/webauthn/auth-options', async (req, res, next) => {
  try {
    const { origin, rpId } = getWebAuthnConfig(req);
    const sessionId = crypto.randomBytes(16).toString('hex');
    const options   = await generateAuthenticationOptions({
      rpID: rpId, timeout: 60000, allowCredentials: [], userVerification: 'preferred',
    });
    cache.put(`wa_auth_${sessionId}`, { challenge: options.challenge, origin, rpId }, 120);
    res.json({ ...options, sessionId });
  } catch (err) { next(err); }
});

// 4. Auth verify (public)
router.post('/webauthn/auth-verify', async (req, res, next) => {
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
      response: credential, expectedChallenge, expectedOrigin: origin, expectedRPID: rpId,
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
    res.json({ token: signToken(user.display_name, user.role), role: user.role, username: user.display_name });
  } catch (err) { next(err); }
});

module.exports = router;
