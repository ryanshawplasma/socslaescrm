'use strict';

const express = require('express');
const db      = require('../db');
const cache   = require('../cache');
const { BUSINESS_KEYS } = require('../business-types');
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
  const { name, handle, businessType } = req.body || {};
  if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Team name must be at least 2 characters' });
  if (!handle || !/^@?[a-z0-9_]{3,30}$/i.test(handle.replace(/^@/, '')))
    return res.status(400).json({ error: 'Handle must be 3–30 letters/numbers/underscores' });
  if (businessType !== undefined && !BUSINESS_KEYS.includes(businessType))
    return res.status(400).json({ error: 'Unknown business type' });
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const existing = await db.getTeamByHandle(handle);
    if (existing) return res.status(409).json({ error: 'Handle already taken, choose another' });
    const team = await db.createTeam(name, handle, user.id);
    if (businessType && businessType !== 'factory') {
      await db.updateTeam(team.id, { businessType });
      cache.remove('bizprofile_team_' + team.id);
      team.business_type = businessType;
    }
    team.business_type = team.business_type || 'factory';
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

// ── GET /api/teams/public — discoverable teams (no query needed) ──
router.get('/teams/public', authMiddleware, async (req, res, next) => {
  try { res.json(await db.getPublicTeams(req.query.limit || 12)); }
  catch (err) { next(err); }
});

// ── GET /api/teams/:id ────────────────────────────────────────
router.get('/teams/:id', authMiddleware, async (req, res, next) => {
  try {
    const team = await db.getTeamById(parseInt(req.params.id, 10));
    if (!team) return res.status(404).json({ error: 'Team not found' });
    // The invite_code is the secret that lets you self-join bypassing approval —
    // only active members (and global admins) may see it. Everyone else gets the
    // team WITHOUT it, so a public "discover" lookup can't harvest join codes.
    const actor  = await db.getUserByName(req.user.username).catch(() => null);
    const member = actor && await db.getTeamMember(team.id, actor.id).catch(() => null);
    const isMember = req.user.role === 'admin' || !!(member && member.status === 'active');
    if (!isMember) { const { invite_code, ...safe } = team; return res.json(safe); }
    res.json(team);
  } catch (err) { next(err); }
});

// ── PATCH /api/teams/:id ──────────────────────────────────────
router.patch('/teams/:id', authMiddleware, teamMemberMiddleware, teamAdminMiddleware, async (req, res, next) => {
  const { name, handle, publicSearch, autoApprove, businessType, businessCustom } = req.body || {};
  if (businessType !== undefined && !BUSINESS_KEYS.includes(businessType))
    return res.status(400).json({ error: 'Unknown business type' });
  try {
    await db.updateTeam(req.teamId, { name, handle, publicSearch, autoApprove, businessType, businessCustom });
    cache.remove('bizprofile_team_' + req.teamId);
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
    // A suspended member must NOT be able to silently re-activate themselves by
    // re-entering the invite code — only a team admin can lift a suspension.
    if (existing && existing.status === 'suspended') return res.status(403).json({ error: 'Your membership in this team is suspended. Contact a team admin.' });
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
    if (existing && existing.status === 'suspended') return res.status(403).json({ error: 'Your membership is suspended. Contact a team admin.' });
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
    // Only act on a still-pending request. Re-approving an already-processed one
    // would re-run addTeamMember (hardcoded 'sales') and silently demote a member
    // who has since been promoted.
    if (jr.status !== 'pending') return res.status(409).json({ error: 'Request already processed' });
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

// NOTE: the former GET /api/teams/:id/leads was removed — the SPA reads team
// leads via GET /api/leads?teamId= (leadsForRequest), which correctly applies
// visibility ('private' hiding) and can_edit. The old endpoint returned raw
// getLeadsByTeam() with no such filtering, leaking hidden leads to rank-and-file
// members.

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
    const dept = await db.getDepartmentById(deptId);
    if (!dept || dept.team_id !== req.teamId) return res.status(404).json({ error: 'Department not found' });
    await db.updateDepartment(deptId, { name, description, managerId });
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /api/teams/:id/departments/:deptId — archive
router.delete('/teams/:id/departments/:deptId', authMiddleware, teamMemberMiddleware, teamAdminMiddleware, async (req, res, next) => {
  const deptId = parseInt(req.params.deptId, 10);
  try {
    const dept = await db.getDepartmentById(deptId);
    if (!dept || dept.team_id !== req.teamId) return res.status(404).json({ error: 'Department not found' });
    await db.archiveDepartment(deptId);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// GET /api/teams/:id/departments/:deptId/members
router.get('/teams/:id/departments/:deptId/members', authMiddleware, teamMemberMiddleware, async (req, res, next) => {
  const deptId = parseInt(req.params.deptId, 10);
  try {
    const dept = await db.getDepartmentById(deptId);
    if (!dept || dept.team_id !== req.teamId) return res.status(404).json({ error: 'Department not found' });
    res.json(await db.getDepartmentMembers(deptId));
  } catch (err) { next(err); }
});

// POST /api/teams/:id/departments/:deptId/members
router.post('/teams/:id/departments/:deptId/members', authMiddleware, teamMemberMiddleware, teamAdminMiddleware, async (req, res, next) => {
  const deptId = parseInt(req.params.deptId, 10);
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error: 'userId required' });
  try {
    const dept = await db.getDepartmentById(deptId);
    if (!dept || dept.team_id !== req.teamId) return res.status(404).json({ error: 'Department not found' });
    const m = await db.getTeamMember(req.teamId, parseInt(userId, 10));
    if (!m || m.status !== 'active') return res.status(400).json({ error: 'User is not an active team member' });
    await db.addDepartmentMember(deptId, parseInt(userId, 10));
    res.json({ success: true });
  } catch (err) { next(err); }
});

// DELETE /api/teams/:id/departments/:deptId/members/:uid
router.delete('/teams/:id/departments/:deptId/members/:uid', authMiddleware, teamMemberMiddleware, teamAdminMiddleware, async (req, res, next) => {
  const deptId = parseInt(req.params.deptId, 10);
  try {
    const dept = await db.getDepartmentById(deptId);
    if (!dept || dept.team_id !== req.teamId) return res.status(404).json({ error: 'Department not found' });
    await db.removeDepartmentMember(deptId, parseInt(req.params.uid, 10));
    res.json({ success: true });
  } catch (err) { next(err); }
});

module.exports = router;
