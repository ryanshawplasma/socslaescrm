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
    return leads.map(l => ({
      ...l,
      can_edit: manager || l.created_by === req.user.username || shared.has(Number(l.rowIndex)),
    }));
  }

  const leads = req.user.role === 'admin'
    ? await db.getLeads()
    : await db.getLeadsForUser(req.user.username);
  return leads.map(l => ({ ...l, can_edit: true }));
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

// ── DELETE /api/leads/:row ────────────────────────────────────
router.delete('/leads/:row', authMiddleware, adminOnly, requireLeadAccess, async (req, res, next) => {
  try {
    res.json(await db.deleteLead(parseInt(req.params.row, 10)));
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
async function tgSendTo(displayName, text) {
  const { TELEGRAM_TOKEN } = process.env;
  if (!TELEGRAM_TOKEN || !displayName) return;
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
    if (!TELEGRAM_TOKEN) return;
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
