'use strict';

const express  = require('express');
const axios    = require('axios');
const db       = require('../db');
const { authMiddleware, adminOnly, noGuest, requireLeadAccess } = require('../middleware/auth');

const router = express.Router();

const DEMO_LEADS = [
  { id: 9001, factory_number: 'D1', factory_name: 'Arun Enterprises', person_in_charge: 'Arun Sharma', contact: '+91 98100 00001', lead_type: 'Hot', stage: 'Sample Sent', stage_number: '3', notes: 'Interested in Hotmelt', created_by: 'demo', last_updated: '', items: [{ product: 'Hotmelt', quantity: '500 kg', rate: '120' }], contacts: [] },
  { id: 9002, factory_number: 'D2', factory_name: 'Mehta Industries',  person_in_charge: 'Priya Mehta',  contact: '+91 98200 00002', lead_type: 'Warm', stage: 'Quotation', stage_number: '4', notes: 'Asked for brochure', created_by: 'demo', last_updated: '', items: [{ product: 'Solvent', quantity: '200 ltr', rate: '80' }], contacts: [] },
  { id: 9003, factory_number: 'D3', factory_name: 'Joshi Trading',     person_in_charge: 'Vikram Joshi', contact: '+91 98300 00003', lead_type: 'Cold', stage: 'New Lead', stage_number: '1', notes: 'Found via referral', created_by: 'demo', last_updated: '', items: [{ product: 'Rubber Adhesive', quantity: '100 kg', rate: '150' }], contacts: [] },
];

// ── Team context helper (?teamId= scoping) ───────────────────
const TEAM_MANAGER_ROLES = ['owner', 'admin', 'manager'];

async function resolveTeamContext(req) {
  const teamId = parseInt(req.query.teamId, 10);
  if (!teamId) return null;
  const user = await db.getUserByName(req.user.username);
  if (!user) return { forbidden: true };
  const member = await db.getTeamMember(teamId, user.id);
  if (!member || member.status !== 'active') return { forbidden: true };
  return { teamId, user, member };
}

// Can a list be used for filing/filtering in this request's context?
function listInContext(list, username, teamId) {
  if (!list) return false;
  if (teamId) return Number(list.team_id) === Number(teamId);
  return list.team_id == null &&
    String(list.owner || '').toLowerCase() === String(username || '').toLowerCase();
}

// Can this user rename/delete the list? Creator, team manager, or global admin.
async function canManageList(list, req) {
  if (!list) return false;
  if (req.user.role === 'admin') return true;
  if (String(list.owner || '').toLowerCase() === String(req.user.username).toLowerCase()) return true;
  if (list.team_id) {
    const user = await db.getUserByName(req.user.username);
    const member = user && await db.getTeamMember(list.team_id, user.id);
    return !!(member && member.status === 'active' && TEAM_MANAGER_ROLES.includes(member.role));
  }
  return false;
}

// Returns the leads visible to this request (personal or team-scoped),
// each annotated with can_edit. Throws {status:403} if not a team member.
async function leadsForRequest(req) {
  if (req.user.role === 'guest') return DEMO_LEADS.map(l => ({ ...l, can_edit: false }));

  const ctx = await resolveTeamContext(req);
  if (ctx?.forbidden) {
    const err = new Error('Not an active member of this team');
    err.status = 403;
    throw err;
  }

  if (ctx) {
    const leads   = await db.getLeadsByTeam(ctx.teamId);
    const manager = req.user.role === 'admin' || TEAM_MANAGER_ROLES.includes(ctx.member.role);
    const shared  = manager ? null : await db.getAccessibleLeadIds(req.user.username);
    let mapped    = leads.map(l => ({
      ...l,
      can_edit: manager || l.created_by === req.user.username || shared.has(Number(l.rowIndex)),
    }));
    // Hidden ('private') leads are invisible to other salespeople — but the
    // owner, anyone they've shared with, and team managers/admins still see them.
    if (!manager) {
      mapped = mapped.filter(l =>
        String(l.visibility) !== 'private' ||
        l.created_by === req.user.username ||
        shared.has(Number(l.rowIndex)));
    }
    return attachLists(mapped, req.user.username, ctx.teamId);
  }

  const leads = req.user.role === 'admin'
    ? await db.getLeads()
    : await db.getLeadsForUser(req.user.username);
  return attachLists(leads.map(l => ({ ...l, can_edit: true })), req.user.username, null);
}

// Annotate each lead with the lists (tags) visible in this context.
async function attachLists(leads, owner, teamId) {
  const ids = leads.map(l => Number(l.rowIndex));
  const memberships = await db.getListMembershipsForLeads(ids, owner, teamId || null);
  for (const l of leads) {
    l.lists    = memberships[Number(l.rowIndex)] || [];
    l.list_ids = l.lists.map(x => x.id);
  }
  return leads;
}

// ── GET /api/leads ────────────────────────────────────────────
router.get('/leads', authMiddleware, async (req, res, next) => {
  try {
    res.json(await leadsForRequest(req));
  } catch (err) { next(err); }
});

// ── POST /api/leads ───────────────────────────────────────────
router.post('/leads', authMiddleware, noGuest, async (req, res, next) => {
  try {
    const result = await db.addLead(req.body, req.user?.username || '');
    if (result.conflict) return res.status(409).json(result);
    // Log activity
    if (result.ok) {
      db.logLeadActivity(result.rowIndex, req.body.team_id || null, 'created',
        `Lead created by ${req.user.username}`, {}, req.user.username).catch(() => {});
      // File the new lead into any chosen lists (tags) the user can use here
      if (Array.isArray(req.body.list_ids) && req.body.list_ids.length) {
        const teamId = req.body.team_id ? parseInt(req.body.team_id, 10) : null;
        const allowed = await db.getListsForContext(req.user.username, teamId);
        const allowedIds = allowed.map(l => l.id);
        await db.setLeadListMemberships(result.rowIndex, req.body.list_ids, allowedIds).catch(() => {});
      }
    }
    res.json(result);
  } catch (err) { next(err); }
});

// ── PUT /api/leads/:row ───────────────────────────────────────
router.put('/leads/:row', authMiddleware, noGuest, requireLeadAccess, async (req, res, next) => {
  try {
    const rowId = parseInt(req.params.row, 10);

    // Fetch lead before update for diffing
    const before = await db.getLeadById(rowId);
    const result = await db.updateLead(rowId, req.body);

    // Stage change → log specific activity
    if (req.body.stage) {
      db.logLeadActivity(rowId, req.body.team_id || before?.team_id || null, 'stage_change',
        `Stage changed to ${req.body.stage}`,
        { stage: req.body.stage }, req.user.username).catch(() => {});
    } else {
      db.logLeadActivity(rowId, req.body.team_id || before?.team_id || null, 'edit',
        `Lead updated by ${req.user.username}`, {}, req.user.username).catch(() => {});
    }

    // Field-level history: only log fields that actually changed
    const trackFields = ['factory_name','person_in_charge','contact','stage','follow_up','notes','area','lead_type'];
    for (const field of trackFields) {
      const newVal = req.body[field];
      if (newVal === undefined) continue;
      const oldVal = before ? String(before[field] ?? '') : '';
      if (String(newVal) === oldVal) continue;
      db.logLeadHistory(rowId, req.user.username, field, oldVal, newVal, req.body.team_id || before?.team_id || null).catch(() => {});
    }

    if (req.body.stage === 'Order Won') {
      notifyOrderWon(req.body, req.user.username).catch(() => {});
    }
    res.json(result);
  } catch (err) { next(err); }
});

// ── POST /api/leads/import — bulk import from Excel/Sheets ───
router.post('/leads/import', authMiddleware, noGuest, async (req, res, next) => {
  const { leads, assign_to, team_id, list_id } = req.body || {};
  if (!Array.isArray(leads) || !leads.length) return res.status(400).json({ error: 'No rows to import' });
  if (leads.length > 1000) return res.status(400).json({ error: 'Maximum 1000 rows per import — split the file' });
  try {
    const isAdmin = req.user.role === 'admin';
    // Non-admins always import as themselves; admins can assign to a salesman
    const defaultCreatedBy = (isAdmin && assign_to) ? String(assign_to).trim() : req.user.username;
    const rows = leads.map(l => ({
      ...l,
      created_by: isAdmin ? String(l.created_by || '').trim() : '', // per-row salesman column (admin only)
    }));

    // Team scoping: only tag the team if the importer is an active member
    let teamId = null;
    if (team_id) {
      const user = await db.getUserByName(req.user.username);
      const member = user && await db.getTeamMember(parseInt(team_id, 10), user.id);
      if (member && member.status === 'active') teamId = parseInt(team_id, 10);
    }

    // Optional: file all imported rows into a list the importer can use
    let listId = null;
    if (list_id) {
      const list = await db.getListById(parseInt(list_id, 10));
      if (list && listInContext(list, req.user.username, teamId)) listId = list.id;
    }

    const result = await db.importLeads(rows, defaultCreatedBy, teamId, listId);
    db.logAiAction(null, 'import', 'file', `${result.added}/${result.total} rows imported`, { skipped: result.skipped.slice(0, 50) },
      req.user.username, teamId).catch(() => {});
    res.json(result);
  } catch (err) { next(err); }
});

// ── POST /api/import/sheet — fetch a public Google Sheet as CSV ──
router.post('/import/sheet', authMiddleware, async (req, res, next) => {
  const url = String((req.body || {}).url || '').trim();
  const gidMatch = url.match(/[#&?]gid=(\d+)/);
  // "Publish to web" links use /d/e/{token}; normal share links use /d/{id}.
  // Check the /d/e/ form first (the plain /d/ regex would otherwise capture "e").
  const pub = url.match(/spreadsheets\/d\/e\/([a-zA-Z0-9-_]+)/);
  const std = url.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  let base;
  if (pub)       base = `https://docs.google.com/spreadsheets/d/e/${pub[1]}/pub?single=true&output=csv`;
  else if (std)  base = `https://docs.google.com/spreadsheets/d/${std[1]}/export?format=csv`;
  else return res.status(400).json({ error: 'That doesn\'t look like a Google Sheets link. Copy the URL from your browser\'s address bar — it should contain docs.google.com/spreadsheets/…' });

  // A "Copy link" share URL has no gid, and a stale/wrong gid makes Google 400.
  // So try the requested tab first (if any), then fall back to the first tab
  // (no gid at all → Google exports the default sheet).
  const withGid   = gidMatch ? `${base}${base.includes('?') ? '&' : '?'}gid=${gidMatch[1]}` : base;
  const candidates = withGid === base ? [base] : [withGid, base];

  const looksHtml = d => typeof d !== 'string' || /<(!doctype|html)/i.test(d.slice(0, 300));
  let data = null, lastErr = null;
  for (const u of candidates) {
    try {
      const resp = await axios.get(u, { timeout: 20000, maxRedirects: 5, responseType: 'text' });
      if (!looksHtml(resp.data) && String(resp.data).trim()) { data = resp.data; break; }
      lastErr = { html: true };   // private sheet returns an HTML sign-in page
    } catch (e) { lastErr = e; }   // e.g. wrong gid → 400 → try the first tab next
  }

  if (data) return res.json({ csv: data });

  if (lastErr && lastErr.html) {
    return res.status(400).json({ error: 'That sheet isn\'t publicly readable. In Google Sheets: Share → General access → "Anyone with the link" → Viewer, then paste the link again.' });
  }
  const st = lastErr && lastErr.response && lastErr.response.status;
  if (st === 404) return res.status(400).json({ error: 'Sheet not found — double-check the link is correct.' });
  if (st && st >= 400 && st < 500) {
    return res.status(400).json({ error: `Couldn't read that sheet (Google error ${st}). Make sure it's shared "Anyone with the link → Viewer", and try copying the link again from the tab that actually has your data.` });
  }
  return res.status(400).json({ error: `Couldn't reach Google Sheets (${(lastErr && lastErr.code) || 'network error'}). Please try again in a moment.` });
});

// ── DELETE /api/leads/:row ────────────────────────────────────
router.delete('/leads/:row', authMiddleware, adminOnly, requireLeadAccess, async (req, res, next) => {
  try {
    res.json(await db.deleteLead(parseInt(req.params.row, 10)));
  } catch (err) { next(err); }
});

// ── Lead lists (tags) ─────────────────────────────────────────
// GET /api/lead-lists — lists available in the current context
router.get('/lead-lists', authMiddleware, async (req, res, next) => {
  try {
    if (req.user.role === 'guest') return res.json([]);
    const ctx = await resolveTeamContext(req);
    if (ctx?.forbidden) return res.status(403).json({ error: 'Not a member of this team' });
    res.json(await db.getListsForContext(req.user.username, ctx?.teamId || null));
  } catch (err) { next(err); }
});

// POST /api/lead-lists { name, color } — create a list
router.post('/lead-lists', authMiddleware, noGuest, async (req, res, next) => {
  try {
    const name = String((req.body || {}).name || '').trim();
    if (!name) return res.status(400).json({ error: 'List name is required' });
    if (name.length > 60) return res.status(400).json({ error: 'List name is too long (max 60)' });
    const ctx = await resolveTeamContext(req);
    if (ctx?.forbidden) return res.status(403).json({ error: 'Not a member of this team' });
    const teamId = ctx?.teamId || null;
    // Prevent duplicate names within the same context
    const existing = await db.getListsForContext(req.user.username, teamId);
    if (existing.some(l => l.name.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: 'A list with that name already exists' });
    }
    const list = await db.createList(name, (req.body || {}).color, req.user.username, teamId);
    res.json(list);
  } catch (err) { next(err); }
});

// PATCH /api/lead-lists/:id { name?, color? }
router.patch('/lead-lists/:id', authMiddleware, noGuest, async (req, res, next) => {
  try {
    const list = await db.getListById(parseInt(req.params.id, 10));
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (!(await canManageList(list, req))) return res.status(403).json({ error: 'You cannot manage this list' });
    const { name, color } = req.body || {};
    if (name != null && !String(name).trim()) return res.status(400).json({ error: 'List name cannot be empty' });
    res.json(await db.renameList(list.id, name != null ? name : null, color != null ? color : null));
  } catch (err) { next(err); }
});

// DELETE /api/lead-lists/:id — removes the list and its memberships (leads untouched)
router.delete('/lead-lists/:id', authMiddleware, noGuest, async (req, res, next) => {
  try {
    const list = await db.getListById(parseInt(req.params.id, 10));
    if (!list) return res.status(404).json({ error: 'List not found' });
    if (!(await canManageList(list, req))) return res.status(403).json({ error: 'You cannot manage this list' });
    await db.deleteList(list.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/lead-lists/:id/add-leads { lead_ids } — additively file many leads
// into one list ("assign all shown to a list"). Only adds leads the caller can
// actually see, and only into a list that lives in the caller's current context.
router.post('/lead-lists/:id/add-leads', authMiddleware, noGuest, async (req, res, next) => {
  try {
    const list = await db.getListById(parseInt(req.params.id, 10));
    if (!list) return res.status(404).json({ error: 'List not found' });
    const ctx = await resolveTeamContext(req);
    if (ctx?.forbidden) return res.status(403).json({ error: 'Not a member of this team' });
    if (!listInContext(list, req.user.username, ctx?.teamId || null)) {
      return res.status(403).json({ error: 'That list is not available in this view' });
    }
    const requested = (Array.isArray(req.body?.lead_ids) ? req.body.lead_ids : [])
      .map(Number).filter(Boolean);
    if (!requested.length) return res.status(400).json({ error: 'No leads to add' });
    // Restrict to leads visible to this caller in this context (no tagging what
    // you can't see).
    const visible = await leadsForRequest(req);
    const allowed = new Set(visible.map(l => Number(l.rowIndex)));
    const toAdd   = requested.filter(id => allowed.has(id));
    if (!toAdd.length) return res.status(400).json({ error: 'None of those leads are available here' });
    const added = await db.addLeadsToList(list.id, toAdd);
    res.json({ ok: true, added, matched: toAdd.length, requested: requested.length });
  } catch (err) { next(err); }
});

// PUT /api/leads/:row/lists { list_ids } — set a lead's tags in this context
router.put('/leads/:row/lists', authMiddleware, noGuest, requireLeadAccess, async (req, res, next) => {
  try {
    const rowId = parseInt(req.params.row, 10);
    const ctx = await resolveTeamContext(req);
    if (ctx?.forbidden) return res.status(403).json({ error: 'Not a member of this team' });
    const allowed = await db.getListsForContext(req.user.username, ctx?.teamId || null);
    const allowedIds = allowed.map(l => l.id);
    const wanted = await db.setLeadListMemberships(rowId, req.body?.list_ids || [], allowedIds);
    res.json({ ok: true, list_ids: wanted });
  } catch (err) { next(err); }
});

// ── PATCH /api/leads/:row/location ───────────────────────────
router.patch('/leads/:row/location', authMiddleware, requireLeadAccess, async (req, res, next) => {
  const { lat, lng } = req.body || {};
  if (lat == null || lng == null) return res.status(400).json({ error: 'lat and lng required' });
  if (isNaN(parseFloat(lat)) || isNaN(parseFloat(lng))) return res.status(400).json({ error: 'Invalid coordinates' });
  try {
    res.json(await db.updateLeadCoords(parseInt(req.params.row, 10), lat, lng));
  } catch (err) { next(err); }
});

// ── GET /api/leads/:id/photos ─────────────────────────────────
router.get('/leads/:id/photos', authMiddleware, async (req, res, next) => {
  try { res.json(await db.getPhotos(parseInt(req.params.id, 10))); }
  catch (err) { next(err); }
});

// ── Lead sharing: owner, global admin, or team owner/admin ───
async function requireLeadManage(req, res, next) {
  try {
    const leadId = parseInt(req.params.id, 10);
    const lead = await db.getLeadById(leadId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    req.lead = lead;
    if (req.user.role === 'admin' || lead.created_by === req.user.username) return next();
    if (lead.team_id) {
      const user = await db.getUserByName(req.user.username);
      const member = user && await db.getTeamMember(lead.team_id, user.id);
      if (member && member.status === 'active' && ['owner', 'admin'].includes(member.role)) return next();
    }
    return res.status(403).json({ error: 'Only the lead owner or an admin can manage sharing' });
  } catch (err) { next(err); }
}

// ── GET /api/leads/:id/access ─────────────────────────────────
router.get('/leads/:id/access', authMiddleware, requireLeadManage, async (req, res, next) => {
  try { res.json(await db.getLeadAccess(parseInt(req.params.id, 10))); }
  catch (err) { next(err); }
});

router.post('/leads/:id/access', authMiddleware, noGuest, requireLeadManage, async (req, res, next) => {
  const { user_display_name } = req.body || {};
  if (!user_display_name) return res.status(400).json({ error: 'user_display_name required' });
  try {
    const result = await db.grantLeadAccess(parseInt(req.params.id, 10), user_display_name, req.user.username);
    db.logLeadActivity(parseInt(req.params.id, 10), req.lead?.team_id || null, 'shared',
      `Shared with ${user_display_name} by ${req.user.username}`, {}, req.user.username).catch(() => {});
    notifyLeadShared(req.lead, user_display_name, req.user.username).catch(() => {});
    res.json(result);
  } catch (err) { next(err); }
});

router.delete('/leads/:id/access/:name', authMiddleware, noGuest, requireLeadManage, async (req, res, next) => {
  try { res.json(await db.revokeLeadAccess(parseInt(req.params.id, 10), decodeURIComponent(req.params.name))); }
  catch (err) { next(err); }
});

// ── PATCH /api/leads/:id/visibility — hide/unhide from the team ──
// Owner or admin/manager only (requireLeadManage). Hidden ('private') leads
// disappear for other salespeople but stay visible to the owner + managers.
router.patch('/leads/:id/visibility', authMiddleware, noGuest, requireLeadManage, async (req, res, next) => {
  const hidden = !!(req.body || {}).hidden;
  try {
    const result = await db.setLeadVisibility(parseInt(req.params.id, 10), hidden ? 'private' : 'team');
    db.logLeadActivity(parseInt(req.params.id, 10), req.lead?.team_id || null, hidden ? 'hidden' : 'unhidden',
      `${hidden ? 'Hidden from' : 'Made visible to'} the team by ${req.user.username}`, {}, req.user.username).catch(() => {});
    res.json(result);
  } catch (err) { next(err); }
});

// ── POST /api/leads/:id/request-access ───────────────────────
router.post('/leads/:id/request-access', authMiddleware, noGuest, async (req, res, next) => {
  const leadId = parseInt(req.params.id, 10);
  const message = String((req.body || {}).message || '').slice(0, 300);
  try {
    const lead = await db.getLeadById(leadId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    if (lead.created_by === req.user.username)
      return res.status(400).json({ error: 'You already own this lead' });
    if (await db.userHasLeadAccess(leadId, req.user.username))
      return res.status(409).json({ error: 'You already have access to this lead' });
    const request = await db.createLeadShareRequest(leadId, lead.team_id, req.user.username, lead.created_by || '', message);
    notifyShareRequest(lead, req.user.username, message).catch(() => {});
    res.json({ ok: true, request });
  } catch (err) { next(err); }
});

// ── GET /api/lead-requests — my inbox + outbox ───────────────
router.get('/lead-requests', authMiddleware, async (req, res, next) => {
  try {
    if (req.user.role === 'guest') return res.json({ incoming: [], outgoing: [] });
    const [incoming, outgoing] = await Promise.all([
      db.getIncomingLeadRequests(req.user.username, req.user.role === 'admin'),
      db.getOutgoingLeadRequests(req.user.username),
    ]);
    res.json({ incoming, outgoing });
  } catch (err) { next(err); }
});

// ── PATCH /api/lead-requests/:id — approve / reject ──────────
router.patch('/lead-requests/:id', authMiddleware, noGuest, async (req, res, next) => {
  const { status } = req.body || {};
  if (!['approved', 'rejected'].includes(status))
    return res.status(400).json({ error: 'status must be approved or rejected' });
  try {
    const request = await db.getLeadShareRequestById(parseInt(req.params.id, 10));
    if (!request) return res.status(404).json({ error: 'Request not found' });
    if (request.status !== 'pending') return res.status(409).json({ error: 'Request already reviewed' });

    let allowed = req.user.role === 'admin' || request.owner === req.user.username;
    if (!allowed && request.team_id) {
      const user = await db.getUserByName(req.user.username);
      const member = user && await db.getTeamMember(request.team_id, user.id);
      allowed = !!(member && member.status === 'active' && ['owner', 'admin'].includes(member.role));
    }
    if (!allowed) return res.status(403).json({ error: 'Only the lead owner or an admin can review this request' });

    await db.reviewLeadShareRequest(request.id, status, req.user.username);
    if (status === 'approved') {
      await db.grantLeadAccess(request.lead_id, request.requester, req.user.username);
      db.logLeadActivity(request.lead_id, request.team_id || null, 'shared',
        `Access request from ${request.requester} approved by ${req.user.username}`, {}, req.user.username).catch(() => {});
    }
    notifyShareDecision(request, status).catch(() => {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── GET/POST /api/leads/:id/activities ───────────────────────
router.get('/leads/:id/activities', authMiddleware, async (req, res, next) => {
  try { res.json(await db.getLeadActivities(parseInt(req.params.id, 10))); }
  catch (err) { next(err); }
});

// ── GET /api/leads/:id/history ───────────────────────────────
router.get('/leads/:id/history', authMiddleware, async (req, res, next) => {
  try { res.json(await db.getLeadHistory(parseInt(req.params.id, 10))); }
  catch (err) { next(err); }
});

// ── POST /api/leads/:id/claim ─────────────────────────────────
router.post('/leads/:id/claim', authMiddleware, async (req, res, next) => {
  try { res.json(await db.claimFollowUp(parseInt(req.params.id, 10), req.user.username)); }
  catch (err) { next(err); }
});

// ── GET /api/stats ────────────────────────────────────────────
router.get('/stats', authMiddleware, async (req, res, next) => {
  try {
    const leads = await leadsForRequest(req);
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
    const by_lead_type = leads.reduce((acc, l) => {
      const t = l.lead_type || 'Unset'; acc[t] = (acc[t] || 0) + 1; return acc;
    }, {});
    res.json({ total: leads.length, active: leads.length - won - lost, won, lost, by_stage: byStage, by_product: byProduct, by_product_revenue: byProductRevenue, by_lead_type });
  } catch (err) { next(err); }
});

// ── POST /api/route/optimize ──────────────────────────────────
router.post('/route/optimize', authMiddleware, async (req, res, next) => {
  try {
    const { factory_ids, start_location } = req.body || {};
    if (!Array.isArray(factory_ids) || factory_ids.length < 1)
      return res.status(400).json({ error: 'Provide at least one factory_id.' });
    if (!start_location?.lat || !start_location?.lng)
      return res.status(400).json({ error: 'start_location { lat, lng } is required.' });

    const rows    = await db.getLeadCoordinates(factory_ids);
    const valid   = rows.filter(r => r.lat && r.lng && !isNaN(+r.lat) && !isNaN(+r.lng));
    const skipped = rows.filter(r => !r.lat || !r.lng || isNaN(+r.lat) || isNaN(+r.lng));

    if (!valid.length)
      return res.status(400).json({
        error: 'None of the selected factories have map coordinates.',
        skipped: skipped.map(f => ({ id: f.id, name: f.factory_name })),
      });

    const coords = [
      `${+start_location.lng},${+start_location.lat}`,
      ...valid.map(f => `${+f.lng},${+f.lat}`),
    ].join(';');

    const osrmUrl = `http://router.project-osrm.org/trip/v1/driving/${coords}?roundtrip=true&source=first&geometries=geojson&annotations=false`;
    const { data } = await axios.get(osrmUrl, { timeout: 20000 });
    if (data.code !== 'Ok') throw new Error(`OSRM: ${data.code}`);

    const trip = data.trips[0];
    const stops = data.waypoints.slice(1)
      .map((wp, i) => ({ pos: wp.waypoint_index, factory: valid[i] }))
      .sort((a, b) => a.pos - b.pos)
      .map((s, i) => ({
        order: i + 1, factory_id: s.factory.id,
        factory_number: s.factory.factory_number,
        factory_name: s.factory.factory_name,
        person: s.factory.person_in_charge,
        lat: +s.factory.lat, lng: +s.factory.lng,
      }));

    res.json({
      route: { geometry: trip.geometry, distance_km: (trip.distance/1000).toFixed(1), duration_min: Math.round(trip.duration/60) },
      stops,
      skipped: skipped.map(f => ({ id: f.id, name: f.factory_name })),
    });
  } catch (err) {
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT')
      return res.status(504).json({ error: 'OSRM timed out. Try again.' });
    next(err);
  }
});

// ── Telegram notifications for sharing ───────────────────────
// Frozen: only fire when TELEGRAM_ENABLED=true (bot code is archived).
const TELEGRAM_ENABLED = process.env.TELEGRAM_ENABLED === 'true';

async function tgSendTo(displayName, text) {
  const { TELEGRAM_TOKEN } = process.env;
  if (!TELEGRAM_ENABLED || !TELEGRAM_TOKEN || !displayName) return;
  const user = await db.getUserByName(displayName);
  if (!user?.telegram_user_id) return;
  await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
    { chat_id: user.telegram_user_id, text, parse_mode: 'HTML' }).catch(() => {});
}

async function notifyShareRequest(lead, requester, message) {
  const text = [
    `🔑 <b>Lead access request</b>`, '',
    `👤 <b>${esc(requester)}</b> is requesting access to:`,
    `🏭 <b>${esc(lead.factory_name || lead.factory_number)}</b>`,
    message ? `💬 “${esc(message)}”` : '',
    '', 'Review it in the dashboard → Workspace → Requests.',
  ].filter(Boolean).join('\n');
  await tgSendTo(lead.created_by, text);
}

async function notifyLeadShared(lead, withUser, byUser) {
  const text = [
    `🤝 <b>Lead shared with you</b>`, '',
    `🏭 <b>${esc(lead?.factory_name || lead?.factory_number || 'A lead')}</b>`,
    `👤 Shared by: <b>${esc(byUser)}</b>`,
  ].join('\n');
  await tgSendTo(withUser, text);
}

async function notifyShareDecision(request, status) {
  const emoji = status === 'approved' ? '✅' : '❌';
  const text = [
    `${emoji} <b>Access request ${status}</b>`, '',
    `🏭 <b>${esc(request.factory_name || request.factory_number || `Lead #${request.lead_id}`)}</b>`,
  ].join('\n');
  await tgSendTo(request.requester, text);
}

// ── Notify Order Won (Telegram) ───────────────────────────────
async function notifyOrderWon(lead, byUser) {
  try {
    const { TELEGRAM_TOKEN } = process.env;
    if (!TELEGRAM_ENABLED || !TELEGRAM_TOKEN) return;
    const items = (lead.items || []).map(i => `${i.product} ${i.quantity}${i.rate ? ' @₹' + i.rate : ''}`).join(', ');
    const text = [
      `🏆 <b>Order Won!</b>`, '',
      `🏭 <b>${esc(lead.factory_name || lead.factory_number)}</b>`,
      items     ? `📦 ${esc(items)}`     : '',
      lead.area ? `📍 ${esc(lead.area)}` : '',
      `👤 Closed by: <b>${esc(byUser)}</b>`,
    ].filter(Boolean).join('\n');
    const users = await db.getAllUsers();
    for (const u of users) {
      if (!u.telegram_user_id) continue;
      try {
        await require('axios').post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
          { chat_id: u.telegram_user_id, text, parse_mode: 'HTML' });
      } catch (_) {}
    }
  } catch (_) {}
}

function esc(v) {
  if (v === undefined || v === null || String(v).trim() === '') return '—';
  return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

module.exports = router;
module.exports.leadsForRequest = leadsForRequest;
