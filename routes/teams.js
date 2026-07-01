'use strict';

const express = require('express');
const db      = require('../db');
const {
  authMiddleware,
  teamMemberMiddleware,
  teamAdminMiddleware,
} = require('../middleware/auth');

const router = express.Router();

// ── GET /api/my/teams ─────────────────────────────────────────
router.get('/my/teams', authMiddleware, async (req, res, next) => {
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.json([]);
    res.json(await db.getUserTeams(user.id));
  } catch (err) { next(err); }
});

// ── POST /api/teams — create team ─────────────────────────────
router.post('/teams', authMiddleware, async (req, res, next) => {
  const { name, handle } = req.body || {};
  if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Team name must be at least 2 characters' });
  if (!handle || !/^@?[a-z0-9_]{3,30}$/i.test(handle.replace(/^@/, '')))
    return res.status(400).json({ error: 'Handle must be 3–30 letters/numbers/underscores' });
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const existing = await db.getTeamByHandle(handle);
    if (existing) return res.status(409).json({ error: 'Handle already taken, choose another' });
    const team = await db.createTeam(name, handle, user.id);
    res.json(team);
  } catch (err) { next(err); }
});

// ── GET /api/teams/search ─────────────────────────────────────
router.get('/teams/search', authMiddleware, async (req, res, next) => {
  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  try { res.json(await db.searchTeams(q)); }
  catch (err) { next(err); }
});

// ── GET /api/teams/:id ────────────────────────────────────────
router.get('/teams/:id', authMiddleware, async (req, res, next) => {
  try {
    const team = await db.getTeamById(parseInt(req.params.id, 10));
    if (!team) return res.status(404).json({ error: 'Team not found' });
    res.json(team);
  } catch (err) { next(err); }
});

// ── PATCH /api/teams/:id ──────────────────────────────────────
router.patch('/teams/:id', authMiddleware, teamMemberMiddleware, teamAdminMiddleware, async (req, res, next) => {
  const { name, handle, publicSearch, autoApprove } = req.body || {};
  try {
    await db.updateTeam(req.teamId, { name, handle, publicSearch, autoApprove });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── POST /api/teams/:id/invite/regenerate ─────────────────────
router.post('/teams/:id/invite/regenerate', authMiddleware, teamMemberMiddleware, teamAdminMiddleware, async (req, res, next) => {
  try {
    const code = await db.regenerateInviteCode(req.teamId);
    res.json({ invite_code: code });
  } catch (err) { next(err); }
});

// ── POST /api/teams/join ──────────────────────────────────────
router.post('/teams/join', authMiddleware, async (req, res, next) => {
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
  } catch (err) { next(err); }
});

// ── POST /api/teams/:id/request ───────────────────────────────
router.post('/teams/:id/request', authMiddleware, async (req, res, next) => {
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
  } catch (err) { next(err); }
});

// ── GET /api/teams/:id/requests ───────────────────────────────
router.get('/teams/:id/requests', authMiddleware, teamMemberMiddleware, teamAdminMiddleware, async (req, res, next) => {
  try { res.json(await db.getJoinRequests(req.teamId, req.query.status || null)); }
  catch (err) { next(err); }
});

// ── PATCH /api/teams/:id/requests/:rid ───────────────────────
router.patch('/teams/:id/requests/:rid', authMiddleware, teamMemberMiddleware, teamAdminMiddleware, async (req, res, next) => {
  const { status } = req.body || {};
  if (!['approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'status must be approved or rejected' });
  try {
    const requests = await db.getJoinRequests(req.teamId);
    const jr = requests.find(r => r.id === parseInt(req.params.rid, 10));
    if (!jr) return res.status(404).json({ error: 'Request not found' });
    await db.updateJoinRequest(jr.id, status, req.dbUser.id);
    if (status === 'approved') await db.addTeamMember(req.teamId, jr.user_id, 'sales', 'active');
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── GET /api/teams/:id/members ────────────────────────────────
router.get('/teams/:id/members', authMiddleware, teamMemberMiddleware, async (req, res, next) => {
  try { res.json(await db.getTeamMembers(req.teamId)); }
  catch (err) { next(err); }
});

// ── PATCH /api/teams/:id/members/:uid ────────────────────────
router.patch('/teams/:id/members/:uid', authMiddleware, teamMemberMiddleware, teamAdminMiddleware, async (req, res, next) => {
  const uid = parseInt(req.params.uid, 10);
  const { role, status } = req.body || {};
  const validRoles  = ['admin', 'manager', 'sales', 'viewer'];
  const validStatus = ['active', 'suspended'];
  if (role   && !validRoles.includes(role))   return res.status(400).json({ error: 'Invalid role' });
  if (status && !validStatus.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const target = await db.getTeamMember(req.teamId, uid);
    if (!target) return res.status(404).json({ error: 'Member not found' });
    if (target.role === 'owner') return res.status(403).json({ error: 'Cannot modify owner' });
    await db.updateTeamMember(req.teamId, uid, { role, status });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── DELETE /api/teams/:id/members/:uid ───────────────────────
router.delete('/teams/:id/members/:uid', authMiddleware, teamMemberMiddleware, teamAdminMiddleware, async (req, res, next) => {
  const uid = parseInt(req.params.uid, 10);
  try {
    const target = await db.getTeamMember(req.teamId, uid);
    if (!target) return res.status(404).json({ error: 'Member not found' });
    if (target.role === 'owner') return res.status(403).json({ error: 'Cannot remove owner' });
    await db.removeTeamMember(req.teamId, uid);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── POST /api/teams/:id/leave ─────────────────────────────────
router.post('/teams/:id/leave', authMiddleware, teamMemberMiddleware, async (req, res, next) => {
  if (req.teamRole === 'owner') return res.status(403).json({ error: 'Owner cannot leave. Transfer ownership first.' });
  try {
    await db.removeTeamMember(req.teamId, req.dbUser.id);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// ── GET /api/teams/:id/leads ──────────────────────────────────
router.get('/teams/:id/leads', authMiddleware, teamMemberMiddleware, async (req, res, next) => {
  try { res.json(await db.getLeadsByTeam(req.teamId)); }
  catch (err) { next(err); }
});

// ── POST /api/teams/:id/leads ─────────────────────────────────
router.post('/teams/:id/leads', authMiddleware, teamMemberMiddleware, async (req, res, next) => {
  if (!['owner','admin','manager','sales'].includes(req.teamRole))
    return res.status(403).json({ error: 'Viewers cannot create leads' });
  try {
    const lead = await db.addLead({ ...req.body, created_by: req.user.username, team_id: req.teamId });
    res.json(lead);
  } catch (err) { next(err); }
});

// ============================================================
//  DEPARTMENT ENDPOINTS (new)
// ============================================================

// GET /api/teams/:id/departments
router.get('/teams/:id/departments', authMiddleware, teamMemberMiddleware, async (req, res, next) => {
  try { res.json(await db.getDepartments(req.teamId)); }
  catch (err) { next(err); }
});

// POST /api/teams/:id/departments
router.post('/teams/:id/departments', authMiddleware, teamMemberMiddleware, teamAdminMiddleware, async (req, res, next) => {
  const { name, managerId } = req.body || {};
  if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Department name required (min 2 chars)' });
  try {
    const dept = await db.createDepartment(req.teamId, name.trim(), managerId || null);
    res.json(dept);
  } catch (err) { next(err); }
});

// PATCH /api/teams/:id/departments/:deptId
router.patch('/teams/:id/departments/:deptId', authMiddleware, teamMemberMiddleware, teamAdminMiddleware, async (req, res, next) => {
  const deptId = parseInt(req.params.deptId, 10);
  const { name, description, managerId } = req.body || {};
  try {
    await db.updateDepartment(deptId, { name, description, managerId });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /api/teams/:id/departments/:deptId — archive
router.delete('/teams/:id/departments/:deptId', authMiddleware, teamMemberMiddleware, teamAdminMiddleware, async (req, res, next) => {
  try {
    await db.archiveDepartment(parseInt(req.params.deptId, 10));
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/teams/:id/departments/:deptId/members
router.get('/teams/:id/departments/:deptId/members', authMiddleware, teamMemberMiddleware, async (req, res, next) => {
  try { res.json(await db.getDepartmentMembers(parseInt(req.params.deptId, 10))); }
  catch (err) { next(err); }
});

// POST /api/teams/:id/departments/:deptId/members
router.post('/teams/:id/departments/:deptId/members', authMiddleware, teamMemberMiddleware, teamAdminMiddleware, async (req, res, next) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    await db.addDepartmentMember(parseInt(req.params.deptId, 10), parseInt(userId, 10));
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /api/teams/:id/departments/:deptId/members/:uid
router.delete('/teams/:id/departments/:deptId/members/:uid', authMiddleware, teamMemberMiddleware, teamAdminMiddleware, async (req, res, next) => {
  try {
    await db.removeDepartmentMember(parseInt(req.params.deptId, 10), parseInt(req.params.uid, 10));
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
