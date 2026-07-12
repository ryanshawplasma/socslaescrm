'use strict';

const express = require('express');
const { pool } = require('../db');
const db      = require('../db');
const { BUSINESS_KEYS } = require('../business-types');
const {
  authMiddleware, adminOnly, noGuest,
  signAccessToken,
  teamMemberMiddleware, teamAdminMiddleware,
  requirePermission, PERMISSIONS,
} = require('../middleware/auth');

const router = express.Router();

function isValidUsername(name) {
  if (!name || name.length < 3 || name.length > 20) return false;
  if (!/^[a-z0-9._]+$/.test(name)) return false;
  if (/^[._]|[._]$/.test(name)) return false;
  if (/[._]{2}/.test(name)) return false;
  if (!/[a-z]/.test(name)) return false;
  return true;
}

// Password strength — kept in sync with routes/auth.js validatePassword.
function validatePassword(pw) {
  const s = String(pw || '');
  if (s.length < 8) return 'Password must be at least 8 characters';
  if (s.length > 128) return 'Password is too long';
  if (!/[a-zA-Z]/.test(s) || !/\d/.test(s)) return 'Password must include at least one letter and one number';
  return null;
}

// ── GET /api/users (admin) ────────────────────────────────────
router.get('/users', authMiddleware, adminOnly, async (req, res, next) => {
  try { res.json(await db.getAllUsers()); }
  catch (err) { next(err); }
});

// ── POST /api/users (admin creates user) ─────────────────────
router.post('/users', authMiddleware, adminOnly, async (req, res, next) => {
  const { name, pin, role } = req.body || {};
  if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Name must be at least 2 characters' });
  if (!pin || !/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be 4–6 digits' });
  const safeRole = ['admin', 'sales'].includes(role) ? role : 'sales';
  try {
    const result = await db.createUser(name.trim(), String(pin), safeRole, '');
    if (!result.ok) return res.status(409).json({ error: result.message || 'A user with this name already exists' });
    res.json({ success: true });
  } catch (err) {
    if (err.message?.includes('UNIQUE') || err.message?.includes('unique'))
      return res.status(409).json({ error: 'A user with this name already exists' });
    next(err);
  }
});

// ── DELETE /api/users/:id (admin) ────────────────────────────
router.delete('/users/:id', authMiddleware, adminOnly, async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  try {
    const all    = await db.getAllUsers();
    const target = all.find(u => u.id === id);
    if (target && target.role === 'admin' && all.filter(u => u.role === 'admin').length <= 1) {
      return res.status(409).json({ error: 'Cannot remove the last admin' });
    }
    res.json(await db.deleteUser(id));
  } catch (err) { next(err); }
});

// ── PATCH /api/users/:id (admin sets role / designation / area / forced reset) ──
router.patch('/users/:id', authMiddleware, adminOnly, async (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user id' });
  const { role, designation, default_area, must_change_password } = req.body || {};
  if (role !== undefined && !['admin', 'sales'].includes(role))
    return res.status(400).json({ error: 'Role must be admin or sales' });
  try {
    const all    = await db.getAllUsers();
    const target = all.find(u => u.id === id);
    if (!target) return res.status(404).json({ error: 'User not found' });

    if (role !== undefined && role !== target.role) {
      // Never leave the workspace without an admin.
      if (target.role === 'admin' && role === 'sales') {
        const admins = all.filter(u => u.role === 'admin').length;
        if (admins <= 1) return res.status(409).json({ error: 'Cannot demote the last admin — promote someone else first' });
      }
      await db.setUserRole(id, role);
    }
    if (designation !== undefined) {
      await db.setUserDesignation(id, String(designation));
    }
    if (default_area !== undefined) {
      await db.updateUserDefaultArea(id, String(default_area).slice(0, 60));
    }
    if (must_change_password !== undefined) {
      await db.setMustChangePassword(id, !!must_change_password);
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── POST /api/users/require-password-change-all (admin) ──────
// Flags every account — admins included — so the next successful login (with
// whatever credential each person already has) is intercepted by the
// blocking set-password step. Nobody's existing credential is touched, so
// nobody is locked out; this only forces them to replace it with a real,
// self-chosen one before they can use the app again.
router.post('/users/require-password-change-all', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const result = await db.setMustChangePasswordForAll();
    const actor = await db.getUserByName(req.user.username);
    await db.logSecurity(actor?.id || null, 'password_change_forced_all', { count: result.count },
      req.ip || '', req.headers['user-agent'] || '', null, null);
    res.json({ success: true, count: result.count });
  } catch (err) { next(err); }
});

// ── GET /api/users/names (signed-in users only) ──────────────
// Not public: the account list (incl. admins) is not exposed on the login page.
router.get('/users/names', authMiddleware, async (req, res, next) => {
  try {
    const users = await db.getAllUsers();
    res.json(users.map(u => u.display_name));
  } catch (err) { next(err); }
});

// ── PATCH /api/users/:id/pin (admin resets PIN) ──────────────
router.patch('/users/:id/pin', authMiddleware, adminOnly, async (req, res, next) => {
  const { pin } = req.body || {};
  if (!pin || !/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be 4–6 digits' });
  try {
    await db.updateUserPin(parseInt(req.params.id, 10), String(pin));
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── PATCH /api/users/:id/password (admin resets a member's password) ──
router.patch('/users/:id/password', authMiddleware, adminOnly, async (req, res, next) => {
  const { password } = req.body || {};
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  try {
    const id     = parseInt(req.params.id, 10);
    const target = (await db.getAllUsers()).find(u => u.id === id);
    if (!target) return res.status(404).json({ error: 'User not found' });
    await db.setUserPassword(id, String(password));
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── GET /api/check-username (public) ─────────────────────────
router.get('/check-username', async (req, res, next) => {
  const name = (req.query.name || '').toLowerCase().trim();
  if (!isValidUsername(name)) return res.json({ available: false, reason: 'invalid' });
  try {
    const users = await db.getAllUsers();
    const taken = users.some(u => u.display_name.toLowerCase() === name);
    res.json({ available: !taken });
  } catch (err) { next(err); }
});

// ── POST /api/register (public self-registration) ─────────────
router.post('/register', async (req, res, next) => {
  const { name, pin, mobile, password } = req.body || {};
  const clean = (name || '').toLowerCase().trim();
  if (!isValidUsername(clean)) return res.status(400).json({ error: 'Invalid username — use 3–20 lowercase letters, numbers, _ or . only' });
  const pwErr = validatePassword(password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  // PIN is now optional (device quick-unlock); validate only if supplied.
  if (pin && !/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be 4–6 digits' });
  try {
    const result = await db.createUser(clean, pin ? String(pin) : '', 'sales', '', String(password));
    if (!result.ok) return res.status(409).json({ error: result.message });
    if (mobile) {
      const m = String(mobile).replace(/[\s\-\(\)]/g, '');
      if (/^\+?\d{10,15}$/.test(m)) {
        await pool.query(`UPDATE users SET mobile = $1 WHERE display_name = $2`, [m, clean]).catch(() => {});
      }
    }
    res.json({ success: true });
  } catch (err) {
    if (err.message?.includes('UNIQUE') || err.message?.includes('unique'))
      return res.status(409).json({ error: 'Username taken — choose another' });
    next(err);
  }
});

// ── PATCH /api/users/me/pin ───────────────────────────────────
router.patch('/users/me/pin', authMiddleware, async (req, res, next) => {
  const { pin } = req.body || {};
  if (!pin || !/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be 4-6 digits' });
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(await db.updateUserPin(user.id, pin));
  } catch (err) { next(err); }
});

// ── GET /api/users/me ─────────────────────────────────────────
router.get('/users/me', authMiddleware, async (req, res, next) => {
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const { id, display_name, role, telegram_user_id, created_at, default_area, designation } = user;
    res.json({ id, display_name, role, telegram_user_id, created_at,
      default_area: default_area || '', designation: designation || '',
      business_type: user.business_type || 'factory', business_custom: user.business_custom || '',
      has_password: !!user.password_hash });
  } catch (err) { next(err); }
});

// ── PATCH /api/me/business ────────────────────────────────────
// Set the caller's Personal-workspace business type + custom terms. This router
// is mounted under /api, so the path here omits the prefix.
router.patch('/me/business', authMiddleware, noGuest, async (req, res, next) => {
  const { businessType, businessCustom } = req.body || {};
  if (businessType !== undefined && !BUSINESS_KEYS.includes(businessType))
    return res.status(400).json({ error: 'Unknown business type' });
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const type = businessType !== undefined ? businessType : (user.business_type || 'factory');
    // businessCustom may be an object or a string; store a JSON string ≤2000
    // chars. When omitted, keep whatever the user already had.
    let custom;
    if (businessCustom === undefined)            custom = user.business_custom || '';
    else if (typeof businessCustom === 'string') custom = businessCustom;
    else { try { custom = JSON.stringify(businessCustom); } catch (_) { custom = ''; } }
    custom = String(custom || '').slice(0, 2000);
    await db.setUserBusiness(user.id, type, custom);
    res.json({ success: true, business_type: type, business_custom: custom });
  } catch (err) { next(err); }
});

// ── PATCH /api/users/me/profile ───────────────────────────────
router.patch('/users/me/profile', authMiddleware, async (req, res, next) => {
  const { display_name, pin, default_area } = req.body || {};
  try {
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
    if (default_area !== undefined) {
      await db.updateUserDefaultArea(user.id, String(default_area).slice(0, 60));
    }
    const newToken = signAccessToken(user.id, newName, user.role, req.user.sessionId || null);
    res.json({ ok: true, token: newToken, username: newName, role: user.role });
  } catch (err) { next(err); }
});

// ============================================================
//  GRANULAR PERMISSION ENDPOINTS (new)
// ============================================================

// GET /api/teams/:id/members/:uid/permissions
router.get('/teams/:id/members/:uid/permissions', authMiddleware, teamMemberMiddleware, teamAdminMiddleware, async (req, res, next) => {
  try {
    const uid = parseInt(req.params.uid, 10);
    res.json(await db.getUserPermissions(uid, req.teamId));
  } catch (err) { next(err); }
});

// POST /api/teams/:id/members/:uid/permissions — grant
router.post('/teams/:id/members/:uid/permissions', authMiddleware, teamMemberMiddleware, teamAdminMiddleware, async (req, res, next) => {
  const uid  = parseInt(req.params.uid, 10);
  const { code } = req.body || {};
  const validCodes = Object.values(PERMISSIONS);
  if (!code || !validCodes.includes(code)) return res.status(400).json({ error: `Invalid permission code. Valid: ${validCodes.join(', ')}` });
  try {
    await db.grantPermission(uid, req.teamId, code, req.dbUser.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /api/teams/:id/members/:uid/permissions/:code — revoke
router.delete('/teams/:id/members/:uid/permissions/:code', authMiddleware, teamMemberMiddleware, teamAdminMiddleware, async (req, res, next) => {
  const uid = parseInt(req.params.uid, 10);
  try {
    await db.revokePermission(uid, req.teamId, req.params.code);
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
