'use strict';

const express = require('express');
const { pool } = require('../db');
const db      = require('../db');
const {
  authMiddleware, adminOnly,
  signToken,
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
    const user = await db.createUser(name.trim(), String(pin), safeRole, '');
    res.json({ success: true, user });
  } catch (err) {
    if (err.message?.includes('UNIQUE') || err.message?.includes('unique'))
      return res.status(409).json({ error: 'A user with this name already exists' });
    next(err);
  }
});

// ── DELETE /api/users/:id (admin) ────────────────────────────
router.delete('/users/:id', authMiddleware, adminOnly, async (req, res, next) => {
  try { res.json(await db.deleteUser(parseInt(req.params.id, 10))); }
  catch (err) { next(err); }
});

// ── GET /api/users/names (public) ────────────────────────────
router.get('/users/names', async (req, res, next) => {
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
  const { name, pin, mobile } = req.body || {};
  const clean = (name || '').toLowerCase().trim();
  if (!isValidUsername(clean)) return res.status(400).json({ error: 'Invalid username — use 3–20 lowercase letters, numbers, _ or . only' });
  if (!pin || !/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be 4–6 digits' });
  try {
    const result = await db.createUser(clean, String(pin), 'sales', '');
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
    const { id, display_name, role, telegram_user_id, created_at } = user;
    res.json({ id, display_name, role, telegram_user_id, created_at });
  } catch (err) { next(err); }
});

// ── PATCH /api/users/me/profile ───────────────────────────────
router.patch('/users/me/profile', authMiddleware, async (req, res, next) => {
  const { display_name, pin } = req.body || {};
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
    const newToken = signToken(newName, user.role);
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
