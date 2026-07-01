'use strict';

const express  = require('express');
const axios    = require('axios');
const db       = require('../db');
const { authMiddleware, adminOnly, noGuest, requireLeadAccess } = require('../middleware/auth');

const router = express.Router();

const DEMO_LEADS = [
  { id: 9001, factory_number: 'D1', factory_name: 'Arun Enterprises', person_in_charge: 'Arun Sharma', contact: '+91 98100 00001', lead_type: 'Hot', stage: 'Sample Sent', notes: 'Interested in Hotmelt', created_by: 'demo', last_updated: '', items: [], contacts: [] },
  { id: 9002, factory_number: 'D2', factory_name: 'Mehta Industries',  person_in_charge: 'Priya Mehta',  contact: '+91 98200 00002', lead_type: 'Warm', stage: 'Quotation', notes: 'Asked for brochure', created_by: 'demo', last_updated: '', items: [], contacts: [] },
  { id: 9003, factory_number: 'D3', factory_name: 'Joshi Trading',     person_in_charge: 'Vikram Joshi', contact: '+91 98300 00003', lead_type: 'Cold', stage: 'New Lead', notes: 'Found via referral', created_by: 'demo', last_updated: '', items: [], contacts: [] },
];

// ── GET /api/leads ────────────────────────────────────────────
router.get('/leads', authMiddleware, async (req, res, next) => {
  try {
    if (req.user.role === 'guest') return res.json(DEMO_LEADS);
    const leads = req.user.role === 'admin'
      ? await db.getLeads()
      : await db.getLeadsForUser(req.user.username);
    res.json(leads);
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

    // Field-level history: diff changed fields
    const trackFields = ['factory_name','person_in_charge','contact','stage','follow_up','notes','area','lead_type'];
    for (const field of trackFields) {
      if (req.body[field] !== undefined) {
        db.logLeadHistory(rowId, req.user.username, field, '', req.body[field], req.body.team_id || null).catch(() => {});
      }
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

// ── GET /api/leads/:id/access ─────────────────────────────────
router.get('/leads/:id/access', authMiddleware, adminOnly, async (req, res, next) => {
  try { res.json(await db.getLeadAccess(parseInt(req.params.id, 10))); }
  catch (err) { next(err); }
});

router.post('/leads/:id/access', authMiddleware, adminOnly, async (req, res, next) => {
  const { user_display_name } = req.body || {};
  if (!user_display_name) return res.status(400).json({ error: 'user_display_name required' });
  try { res.json(await db.grantLeadAccess(parseInt(req.params.id, 10), user_display_name, req.user.username)); }
  catch (err) { next(err); }
});

router.delete('/leads/:id/access/:name', authMiddleware, adminOnly, async (req, res, next) => {
  try { res.json(await db.revokeLeadAccess(parseInt(req.params.id, 10), decodeURIComponent(req.params.name))); }
  catch (err) { next(err); }
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
    const leads = req.user.role === 'admin'
      ? await db.getLeads()
      : await db.getLeadsForUser(req.user.username);
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
