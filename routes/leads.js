'use strict';

const express  = require('express');
const axios    = require('axios');
const db       = require('../db');
const { authMiddleware, adminOnly, noGuest, requireLeadAccess } = require('../middleware/auth');

// Lazy accessor for the shared Gemini provider. Required lazily (not at module
// load) because ai.js already requires THIS module (leadsForRequest) — a static
// top-level require here would create a load-time cycle and undefine that.
const getGemini = () => require('./ai').gemini;

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

// Products (catalog "major items") share list-style scoping/permission rules.
function productInContext(p, username, teamId) {
  if (!p) return false;
  if (teamId) return Number(p.team_id) === Number(teamId);
  return p.team_id == null &&
    String(p.owner || '').toLowerCase() === String(username || '').toLowerCase();
}
async function canManageProduct(p, req) {
  if (!p) return false;
  if (req.user.role === 'admin') return true;
  if (String(p.owner || '').toLowerCase() === String(req.user.username).toLowerCase()) return true;
  if (p.team_id) {
    const user = await db.getUserByName(req.user.username);
    const member = user && await db.getTeamMember(p.team_id, user.id);
    return !!(member && member.status === 'active' && TEAM_MANAGER_ROLES.includes(member.role));
  }
  return false;
}

// Keep a lead only if it's in the requested bucket. Default 'working' isolates
// the active sheet from the Database; 'database' shows the reference bank; 'all'
// skips the filter (used when validating a set of ids across both).
function bucketFilter(leads, bucket) {
  if (bucket === 'all') return leads;
  const want = bucket === 'database' ? 'database' : 'working';
  return leads.filter(l => (l.bucket || 'working') === want);
}

// Returns the leads visible to this request (personal or team-scoped),
// each annotated with can_edit. Throws {status:403} if not a team member.
// `bucket`: 'working' (default) | 'database' | 'all'.
async function leadsForRequest(req, bucket = 'working') {
  if (req.user.role === 'guest') return DEMO_LEADS.map(l => ({ ...l, can_edit: false, bucket: 'working' }));

  const ctx = await resolveTeamContext(req);
  if (ctx?.forbidden) {
    const err = new Error('Not an active member of this team');
    err.status = 403;
    throw err;
  }

  if (ctx) {
    const leads   = bucketFilter(await db.getLeadsByTeam(ctx.teamId), bucket);
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
  return attachLists(bucketFilter(leads, bucket).map(l => ({ ...l, can_edit: true })), req.user.username, null);
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
// ?bucket=database returns the team's reference bank; default is the working sheet.
router.get('/leads', authMiddleware, async (req, res, next) => {
  try {
    const bucket = req.query.bucket === 'database' ? 'database' : 'working';
    res.json(await leadsForRequest(req, bucket));
  } catch (err) { next(err); }
});

// ── POST /api/leads ───────────────────────────────────────────
router.post('/leads', authMiddleware, noGuest, async (req, res, next) => {
  try {
    // Team scoping: honor a client-supplied team_id only for active members —
    // otherwise a user could write into any team, and a stale dest lands in an
    // ex-team. Mirrors the import path's membership check.
    if (req.body.team_id) {
      const tid = parseInt(req.body.team_id, 10);
      const user = await db.getUserByName(req.user.username);
      const member = user && await db.getTeamMember(tid, user.id);
      req.body.team_id = (member && member.status === 'active') ? tid : null;
    }
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
  const { leads, assign_to, team_id, list_id, bucket } = req.body || {};
  const dest = bucket === 'database' ? 'database' : 'working';
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

    // AI product normalisation: rewrite messy product strings to catalog names
    // (saving learned aliases), and stash anything still unknown for admin review.
    // Never blocks the import — on any failure we import the raw strings as-is.
    let normalized = 0, unmatched = [];
    try {
      ({ normalized, unmatched } = await normalizeImportProducts(rows, req.user.username, teamId));
    } catch (e) { console.warn('[leads] product normalisation skipped:', e && e.message); }

    const result = await db.importLeads(rows, defaultCreatedBy, teamId, listId, dest);
    db.logAiAction(null, 'import', 'file', `${result.added}/${result.total} rows imported → ${dest}`,
      { skipped: result.skipped.slice(0, 50), normalized, unmatched },
      req.user.username, teamId).catch(e => console.warn('[leads] import log failed:', e && e.message));
    res.json({ ...result, normalized, unmatched });
  } catch (err) { next(err); }
});

// Resolve rows[].product against the catalog + alias table, then one Gemini call
// for whatever's left; mutates rows to canonical names in place. Returns
// { normalized, unmatched:[strings] }. Accepts ONLY catalog names from the AI;
// truly-unknown strings are kept as-is and saved for admin review.
async function normalizeImportProducts(rows, username, teamId) {
  const raws = [...new Set(rows.flatMap(r => {
    const list = [String(r.product || '').trim()];
    if (Array.isArray(r.items)) for (const it of r.items) list.push(String((it && it.product) || '').trim());
    return list;
  }).filter(Boolean))];
  if (!raws.length) return { normalized: 0, unmatched: [] };

  const catalog = await db.getProductsForContext(username, teamId);
  const nameToId = {};
  for (const p of catalog) nameToId[p.name.toLowerCase()] = p.id;
  const catalogNames = catalog.map(p => p.name);

  const { resolved, unresolved } = await db.resolveProducts(raws, username, teamId);

  if (unresolved.length && catalogNames.length >= 0) {
    let ai = null;
    try { ai = await getGemini().resolveProducts(catalogNames, unresolved); } catch (_) { ai = null; }
    if (ai && Array.isArray(ai.results)) {
      const byRaw = {};
      for (const r of ai.results) if (r && r.raw != null) byRaw[String(r.raw).toLowerCase()] = r;
      for (const raw of unresolved) {
        const r = byRaw[raw.toLowerCase()];
        const map = r && r.map ? String(r.map) : 'unknown';
        const pid = nameToId[map.toLowerCase()];
        if (map !== 'unknown' && pid) {                 // AI picked a REAL catalog product
          const canonical = catalog.find(p => p.id === pid).name;
          resolved[raw] = canonical;
          await db.saveAlias(raw, pid, 'ai').catch(e => console.warn('[leads] saveAlias failed:', e && e.message));
        } else {                                        // still unknown → stash for review
          await db.upsertSuggestion(raw, (r && r.suggestions) || [], 1)
            .catch(e => console.warn('[leads] upsertSuggestion failed:', e && e.message));
        }
      }
    }
  }

  // Rewrite rows to canonical names (case-insensitive), counting real changes.
  const resolvedLower = {};
  for (const [raw, canon] of Object.entries(resolved)) resolvedLower[raw.toLowerCase()] = canon;
  let normalized = 0;
  for (const r of rows) {
    const raw = String(r.product || '').trim();
    if (raw) {
      const canon = resolvedLower[raw.toLowerCase()];
      if (canon && canon !== raw) { r.product = canon; normalized++; }
    }
    // Multi-product rows: keep items[] in sync with the same resolution map,
    // so leads.product never diverges from the items[] the UI reads.
    if (Array.isArray(r.items)) {
      for (const it of r.items) {
        const iraw = String((it && it.product) || '').trim();
        if (!iraw) continue;
        const ic = resolvedLower[iraw.toLowerCase()];
        if (ic && ic !== iraw) { it.product = ic; normalized++; }
      }
    }
  }
  const unmatched = raws.filter(x => !resolvedLower[x.toLowerCase()]);
  return { normalized, unmatched };
}

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

// ── Products catalog ("major items") ─────────────────────────
// GET /api/products — the catalog available in the current context
router.get('/products', authMiddleware, async (req, res, next) => {
  try {
    if (req.user.role === 'guest') return res.json([]);
    const ctx = await resolveTeamContext(req);
    if (ctx?.forbidden) return res.status(403).json({ error: 'Not a member of this team' });
    res.json(await db.getProductsForContext(req.user.username, ctx?.teamId || null));
  } catch (err) { next(err); }
});

// POST /api/products { name, division, aliases } — add a major item
router.post('/products', authMiddleware, noGuest, async (req, res, next) => {
  try {
    const name = String((req.body || {}).name || '').trim();
    if (!name) return res.status(400).json({ error: 'Product name is required' });
    if (name.length > 80) return res.status(400).json({ error: 'Product name is too long (max 80)' });
    const ctx = await resolveTeamContext(req);
    if (ctx?.forbidden) return res.status(403).json({ error: 'Not a member of this team' });
    const teamId = ctx?.teamId || null;
    const existing = await db.getProductsForContext(req.user.username, teamId);
    if (existing.some(p => p.name.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: 'A product with that name already exists' });
    }
    const p = await db.createProduct(name, (req.body || {}).division, (req.body || {}).aliases, req.user.username, teamId);
    res.json(p);
  } catch (err) { next(err); }
});

// PATCH /api/products/:id { name?, division?, aliases? }
router.patch('/products/:id', authMiddleware, noGuest, async (req, res, next) => {
  try {
    const p = await db.getProductById(parseInt(req.params.id, 10));
    if (!p) return res.status(404).json({ error: 'Product not found' });
    if (!(await canManageProduct(p, req))) return res.status(403).json({ error: 'You cannot manage this product' });
    const { name, division, aliases } = req.body || {};
    if (name != null && !String(name).trim()) return res.status(400).json({ error: 'Product name cannot be empty' });
    res.json(await db.updateProduct(p.id, {
      name:     name     != null ? name     : null,
      division: division != null ? division : null,
      aliases:  aliases  != null ? aliases  : null,
    }));
  } catch (err) { next(err); }
});

// DELETE /api/products/:id
router.delete('/products/:id', authMiddleware, noGuest, async (req, res, next) => {
  try {
    const p = await db.getProductById(parseInt(req.params.id, 10));
    if (!p) return res.status(404).json({ error: 'Product not found' });
    if (!(await canManageProduct(p, req))) return res.status(403).json({ error: 'You cannot manage this product' });
    await db.deleteProduct(p.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// POST /api/products/bulk-delete { ids:[...] } — remove many catalog items at
// once (used by the "clear import junk" flow). Only touches items in the
// caller's context; shared/team items still require manager rights.
router.post('/products/bulk-delete', authMiddleware, noGuest, async (req, res, next) => {
  try {
    const ids = Array.isArray((req.body || {}).ids) ? (req.body || {}).ids : [];
    if (!ids.length) return res.status(400).json({ error: 'No products selected' });
    const ctx = await resolveTeamContext(req);
    if (ctx?.forbidden) return res.status(403).json({ error: 'Not a member of this team' });
    const teamId = ctx?.teamId || null;
    // Removing shared team products is a manager/admin action.
    if (teamId && req.user.role !== 'admin') {
      const user   = await db.getUserByName(req.user.username);
      const member = user && await db.getTeamMember(teamId, user.id);
      if (!(member && member.status === 'active' && TEAM_MANAGER_ROLES.includes(member.role))) {
        return res.status(403).json({ error: 'Only team managers can bulk-remove shared products' });
      }
    }
    const deleted = await db.deleteProductsScoped(ids, req.user.username, teamId);
    res.json({ ok: true, deleted });
  } catch (err) { next(err); }
});

// ── Product data clean-up (admin) ────────────────────────────
// GET /api/products/cleanup-scan — distinct product values NOT matching the
// catalog/aliases, each with its usage count + AI-proposed fix (one Gemini call).
router.get('/products/cleanup-scan', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const ctx = await resolveTeamContext(req);
    if (ctx?.forbidden) return res.status(403).json({ error: 'Not a member of this team' });
    const teamId = ctx?.teamId || null;
    const username = req.user.username;

    const distinct = await db.distinctProductValues();                 // [{value, n}]
    const countByLower = {};
    for (const d of distinct) countByLower[String(d.value).toLowerCase()] = d.n;
    const values = distinct.map(d => d.value);

    const { unresolved } = await db.resolveProducts(values, username, teamId);
    if (!unresolved.length) return res.json({ items: [], model: null });

    const catalog = await db.getProductsForContext(username, teamId);
    const catalogNames = catalog.map(p => p.name);
    const nameSet = new Set(catalogNames.map(n => n.toLowerCase()));

    let model = null, byRaw = {};
    try {
      const ai = await getGemini().resolveProducts(catalogNames, unresolved);
      if (ai && Array.isArray(ai.results)) { model = ai.model; for (const r of ai.results) if (r && r.raw != null) byRaw[String(r.raw).toLowerCase()] = r; }
    } catch (e) { console.warn('[products] cleanup-scan AI failed:', e && e.message); }

    const items = [];
    for (const raw of unresolved) {
      const r = byRaw[raw.toLowerCase()] || {};
      const aiMap = (r.map && r.map !== 'unknown' && nameSet.has(String(r.map).toLowerCase())) ? r.map : null;
      const suggestions = Array.isArray(r.suggestions) ? r.suggestions.slice(0, 3) : [];
      await db.upsertSuggestion(raw, suggestions, 0).catch(e => console.warn('[products] upsertSuggestion failed:', e && e.message));
      items.push({ raw, count: countByLower[raw.toLowerCase()] || 0, aiMap, suggestions });
    }
    items.sort((a, b) => b.count - a.count);
    res.json({ items, model });
  } catch (err) { next(err); }
});

// POST /api/products/cleanup-apply { decisions:[{raw, action, productId?, name?, division?}] }
// action: 'map' (existing product), 'create' (new product), 'keep' (keep raw).
router.post('/products/cleanup-apply', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const ctx = await resolveTeamContext(req);
    if (ctx?.forbidden) return res.status(403).json({ error: 'Not a member of this team' });
    const teamId = ctx?.teamId || null;
    const username = req.user.username;
    const decisions = Array.isArray(req.body?.decisions) ? req.body.decisions : [];
    if (!decisions.length) return res.status(400).json({ error: 'No decisions to apply' });

    let mapped = 0, kept = 0, createdCount = 0, rowsChanged = 0;
    for (const d of decisions) {
      const raw = String(d?.raw || '').trim();
      if (!raw) continue;
      if (d.action === 'keep') {
        await db.saveAlias(raw, null, 'keep-original');
        await db.setSuggestionStatus(raw, 'resolved');
        kept++;
      } else if (d.action === 'map') {
        const p = await db.getProductById(parseInt(d.productId, 10));
        if (!p) continue;
        await db.saveAlias(raw, p.id, 'manual');
        rowsChanged += await db.rewriteProductValue(raw, p.name);
        await db.setSuggestionStatus(raw, 'resolved');
        mapped++;
      } else if (d.action === 'create') {
        const name = String(d.name || '').trim();
        if (!name) continue;
        // reuse an existing catalog product of the same name, else create it
        const existing = (await db.getProductsForContext(username, teamId)).find(p => p.name.toLowerCase() === name.toLowerCase());
        const prod = existing || await db.createProduct(name, d.division || '', '', username, teamId);
        await db.saveAlias(raw, prod.id, 'manual');
        rowsChanged += await db.rewriteProductValue(raw, prod.name || name);
        await db.setSuggestionStatus(raw, 'resolved');
        createdCount++;
      }
    }
    db.logAiAction(null, 'product_cleanup', 'admin', `mapped ${mapped}, created ${createdCount}, kept ${kept}, rows ${rowsChanged}`, {},
      username, teamId).catch(e => console.warn('[products] cleanup log failed:', e && e.message));
    res.json({ ok: true, applied: mapped + createdCount + kept, mapped, created: createdCount, kept, rowsChanged });
  } catch (err) { next(err); }
});

// ── Team Database (reference bank) actions ───────────────────
// POST /api/leads/copy-to-working { lead_ids } — pull Database leads into the
// working sheet. Originals stay in the Database (permanent reference bank).
router.post('/leads/copy-to-working', authMiddleware, noGuest, async (req, res, next) => {
  try {
    const ctx = await resolveTeamContext(req);
    if (ctx?.forbidden) return res.status(403).json({ error: 'Not a member of this team' });
    const requested = (Array.isArray(req.body?.lead_ids) ? req.body.lead_ids : []).map(Number).filter(Boolean);
    if (!requested.length) return res.status(400).json({ error: 'No leads selected' });
    const dbLeads = await leadsForRequest(req, 'database');
    const allowed = new Set(dbLeads.map(l => Number(l.rowIndex)));
    const ids = requested.filter(id => allowed.has(id));
    if (!ids.length) return res.status(400).json({ error: 'None of those leads are in your Database' });
    const result = await db.copyLeadsToWorking(ids, req.user.username, ctx?.teamId || null);
    res.json({ ok: true, ...result });
  } catch (err) { next(err); }
});

// POST /api/leads/move-to-database { lead_ids } — stash working leads into the
// Database to declutter the working sheet (only leads you can edit).
router.post('/leads/move-to-database', authMiddleware, noGuest, async (req, res, next) => {
  try {
    const ctx = await resolveTeamContext(req);
    if (ctx?.forbidden) return res.status(403).json({ error: 'Not a member of this team' });
    const requested = (Array.isArray(req.body?.lead_ids) ? req.body.lead_ids : []).map(Number).filter(Boolean);
    if (!requested.length) return res.status(400).json({ error: 'No leads selected' });
    const working = await leadsForRequest(req, 'working');
    const allowed = new Set(working.filter(l => l.can_edit).map(l => Number(l.rowIndex)));
    const ids = requested.filter(id => allowed.has(id));
    if (!ids.length) return res.status(400).json({ error: 'You can only move leads you can edit' });
    const moved = await db.moveLeadsBucket(ids, 'database');
    res.json({ ok: true, moved });
  } catch (err) { next(err); }
});

// POST /api/leads/bulk-fix { updates:[{id, factory_name?, person_in_charge?,
// area?, product?, items?}] } — apply the client-computed clean-up (Proper-Case
// names/areas + catalog-normalised products) to the caller's EDITABLE working
// leads. The client does the normalising; the server only applies to leads the
// caller is actually allowed to edit.
router.post('/leads/bulk-fix', authMiddleware, noGuest, async (req, res, next) => {
  try {
    const updates = Array.isArray(req.body?.updates) ? req.body.updates : [];
    if (!updates.length) return res.status(400).json({ error: 'No changes to apply' });
    if (updates.length > 5000) return res.status(400).json({ error: 'Too many leads in one pass' });
    const editable = new Set(
      (await leadsForRequest(req, 'working')).filter(l => l.can_edit).map(l => Number(l.rowIndex)));
    let changed = 0;
    for (const u of updates) {
      const id = Number(u?.id);
      if (!id || !editable.has(id)) continue;
      let did = false;
      const fields = {};
      if (u.factory_name     != null) fields.factory_name     = String(u.factory_name);
      if (u.person_in_charge != null) fields.person_in_charge = String(u.person_in_charge);
      if (u.area             != null) fields.area             = String(u.area);
      if (Object.keys(fields).length) { await db.updateLeadFields(id, fields); did = true; }
      if (u.product != null || Array.isArray(u.items)) {
        await db.setLeadProducts(id, u.product != null ? u.product : '', Array.isArray(u.items) ? u.items : null);
        did = true;
      }
      if (did) changed++;
    }
    res.json({ ok: true, changed, scanned: updates.length });
  } catch (err) { next(err); }
});

// POST /api/leads/bulk-delete { lead_ids } — delete multiple leads. Each is
// only removed if the caller may delete it (global admin, the lead's creator,
// or a manager of the lead's team). Others are counted as denied, not deleted.
router.post('/leads/bulk-delete', authMiddleware, noGuest, async (req, res, next) => {
  try {
    const ids = (Array.isArray(req.body?.lead_ids) ? req.body.lead_ids : []).map(Number).filter(Boolean);
    if (!ids.length) return res.status(400).json({ error: 'No leads selected' });
    if (ids.length > 1000) return res.status(400).json({ error: 'Too many leads in one delete (max 1000)' });
    let deleted = 0, denied = 0;
    for (const id of ids) {
      const lead = await db.getLeadById(id);
      if (!lead) continue;
      let allowed = req.user.role === 'admin' || lead.created_by === req.user.username;
      if (!allowed && lead.team_id) {
        const user = await db.getUserByName(req.user.username);
        const member = user && await db.getTeamMember(lead.team_id, user.id);
        allowed = !!(member && member.status === 'active' && TEAM_MANAGER_ROLES.includes(member.role));
      }
      if (!allowed) { denied++; continue; }
      await db.deleteLead(id);
      deleted++;
    }
    db.logAiAction(null, 'bulk_delete', 'leads', `${deleted} deleted, ${denied} denied`, {}, req.user.username, null)
      .catch(e => console.warn('[leads] bulk-delete log failed:', e && e.message));
    res.json({ ok: true, deleted, denied, requested: ids.length });
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
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.json([]);   // e.g. demo leads have no real id
  try { res.json(await db.getPhotos(id)); }
  catch (err) { next(err); }
});

// Can this user attach/remove photos on this lead? Admin, the lead's owner, or
// an active member of the lead's team. Returns the lead (or null) so callers
// don't re-fetch.
async function canManageLeadPhotos(req, leadId) {
  if (!Number.isInteger(leadId)) return { ok: false, code: 400, error: 'Invalid lead id' };
  const lead = await db.getLeadById(leadId);
  if (!lead) return { ok: false, code: 404, error: 'Lead not found' };
  if (req.user.role === 'admin' || lead.created_by === req.user.username) return { ok: true, lead };
  if (lead.team_id) {
    const user   = await db.getUserByName(req.user.username);
    const member = user && await db.getTeamMember(lead.team_id, user.id);
    if (member && member.status === 'active') return { ok: true, lead };
  }
  return { ok: false, code: 403, error: 'You do not have access to this lead' };
}

// ── POST /api/leads/:id/photos — attach a captured photo (stored as a
//    compressed data-URL in Postgres so it persists across redeploys) ──
router.post('/leads/:id/photos', authMiddleware, noGuest, async (req, res, next) => {
  try {
    const leadId = parseInt(req.params.id, 10);
    const { image, caption } = req.body || {};
    if (!image || typeof image !== 'string' || !/^data:image\/(jpe?g|png|webp);base64,/i.test(image)) {
      return res.status(400).json({ error: 'A JPEG or PNG image is required' });
    }
    if (image.length > 6 * 1024 * 1024) {   // ~4.5MB decoded — client already downscales
      return res.status(413).json({ error: 'Image is too large — please retake' });
    }
    const auth = await canManageLeadPhotos(req, leadId);
    if (!auth.ok) return res.status(auth.code).json({ error: auth.error });
    await db.addPhoto(leadId, image, String(caption || 'Factory pic').slice(0, 120), req.user.username);
    db.logLeadActivity(leadId, auth.lead.team_id || null, 'photo_added',
      `${req.user.username} added a photo`, {}, req.user.username).catch(() => {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── DELETE /api/leads/:id/photos/:photoId ─────────────────────
router.delete('/leads/:id/photos/:photoId', authMiddleware, noGuest, async (req, res, next) => {
  try {
    const leadId  = parseInt(req.params.id, 10);
    const photoId = parseInt(req.params.photoId, 10);
    const auth = await canManageLeadPhotos(req, leadId);
    if (!auth.ok) return res.status(auth.code).json({ error: auth.error });
    const photo = await db.getPhotoById(photoId);
    if (!photo || photo.lead_id !== leadId) return res.status(404).json({ error: 'Photo not found' });
    await db.deletePhoto(photoId);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ============================================================
//  Plan / Pro entitlement (Lite vs Pro) + dev access codes
// ============================================================
// Current user's plan — the client calls this after login to gate Pro features.
router.get('/me/plan', authMiddleware, async (req, res, next) => {
  try {
    if (req.user.role === 'guest') return res.json({ isPro: false, plan: 'lite', daysLeft: 0 });
    const user = await db.getUserByName(req.user.username);
    res.json(db.entitlementOf(user));
  } catch (err) { next(err); }
});

// Redeem a dev-issued access code → extends the caller's Pro window.
router.post('/plan/redeem', authMiddleware, noGuest, async (req, res, next) => {
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const result = await db.redeemAccessCode((req.body || {}).code, user.id);
    if (!result.ok) return res.status(400).json({ error: result.error });
    const fresh = await db.getUserByName(req.user.username);
    res.json({ ok: true, added_days: result.days, plan: db.entitlementOf(fresh) });
  } catch (err) { next(err); }
});

// Dev code panel (admin only): generate / list / delete access codes.
router.get('/admin/codes', authMiddleware, adminOnly, async (req, res, next) => {
  try { res.json(await db.getAccessCodes()); } catch (err) { next(err); }
});
router.post('/admin/codes', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const b = req.body || {};
    let code = String(b.code || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (!code) code = 'DIVE-' + Math.random().toString(36).slice(2, 8).toUpperCase();
    const days    = Math.max(1, Math.min(3650, parseInt(b.days, 10) || 30));
    const maxUses = Math.max(1, Math.min(100000, parseInt(b.max_uses, 10) || 1));
    const created = await db.createAccessCode({ code, days, label: b.label, maxUses, createdBy: req.user.username });
    res.json({ ok: true, code: created });
  } catch (err) {
    if (String(err && err.message || '').toLowerCase().includes('duplicate')) return res.status(409).json({ error: 'That code already exists' });
    next(err);
  }
});
router.delete('/admin/codes/:id', authMiddleware, adminOnly, async (req, res, next) => {
  try { await db.deleteAccessCode(req.params.id); res.json({ ok: true }); }
  catch (err) { next(err); }
});

// ============================================================
//  Team Hub (Pro): tasks · activity · chat · leaderboard
// ============================================================
// Gate: caller must be on Pro (global admins always pass; guests are Lite).
async function requirePro(req, res, next) {
  try {
    if (req.user.role === 'admin') { req.proUser = null; return next(); }
    if (req.user.role === 'guest') return res.status(402).json({ error: 'Pro required', code: 'pro_required' });
    const user = await db.getUserByName(req.user.username);
    if (!db.entitlementOf(user).isPro) return res.status(402).json({ error: 'Pro required', code: 'pro_required' });
    req.proUser = user;
    return next();
  } catch (err) { next(err); }
}

// Gate: resolve + require active membership of ?teamId=. Sets req.team = {teamId, user, member}.
async function requireTeam(req, res, next) {
  try {
    const ctx = await resolveTeamContext(req);
    if (!ctx) return res.status(400).json({ error: 'Pick a team first', code: 'no_team' });
    if (ctx.forbidden) return res.status(403).json({ error: 'You are not a member of this team' });
    req.team = ctx;
    return next();
  } catch (err) { next(err); }
}

// Lightweight presence heartbeat (any logged-in user). Powers "who's online".
router.post('/presence', authMiddleware, noGuest, async (req, res, next) => {
  try {
    const user = req.proUser || await db.getUserByName(req.user.username);
    if (user) db.touchLastSeen(user.id).catch(() => {});
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Tasks ─────────────────────────────────────────────────────
router.get('/tasks', authMiddleware, requirePro, requireTeam, async (req, res, next) => {
  try { res.json(await db.getTasks(req.team.teamId, req.user.username)); }
  catch (err) { next(err); }
});

router.post('/tasks', authMiddleware, noGuest, requirePro, requireTeam, async (req, res, next) => {
  try {
    const b = req.body || {};
    const title = String(b.title || '').trim();
    if (!title) return res.status(400).json({ error: 'Task title is required' });
    const task = await db.createTask({
      teamId: req.team.teamId, title, assignee: b.assignee, createdBy: req.user.username,
      leadId: b.lead_id ? parseInt(b.lead_id, 10) : null, leadLabel: b.lead_label,
      dueAt: b.due_at, status: b.status,
    });
    db.logTeamActivity(req.team.teamId, req.user.username, 'task_created', 'task', title,
      { assignee: task.assignee }).catch(() => {});
    res.json({ ok: true, task });
  } catch (err) { next(err); }
});

router.patch('/tasks/:id', authMiddleware, noGuest, requirePro, requireTeam, async (req, res, next) => {
  try {
    const before = await db.getTaskById(req.params.id);
    if (!before || Number(before.team_id) !== Number(req.team.teamId))
      return res.status(404).json({ error: 'Task not found' });
    const b = req.body || {};
    const fields = {};
    for (const k of ['title', 'assignee', 'lead_id', 'lead_label', 'due_at', 'status']) {
      if (b[k] !== undefined) fields[k] = k === 'title' ? String(b[k]).trim() : b[k];
    }
    const task = await db.updateTask(req.params.id, fields);
    if (b.status && b.status === 'done' && before.status !== 'done')
      db.logTeamActivity(req.team.teamId, req.user.username, 'task_done', 'task', task.title, {}).catch(() => {});
    res.json({ ok: true, task });
  } catch (err) { next(err); }
});

router.delete('/tasks/:id', authMiddleware, noGuest, requirePro, requireTeam, async (req, res, next) => {
  try {
    const before = await db.getTaskById(req.params.id);
    if (!before || Number(before.team_id) !== Number(req.team.teamId))
      return res.status(404).json({ error: 'Task not found' });
    res.json(await db.deleteTask(req.params.id));
  } catch (err) { next(err); }
});

// ── Activity feed ─────────────────────────────────────────────
router.get('/team/activity', authMiddleware, requirePro, requireTeam, async (req, res, next) => {
  try { res.json(await db.getTeamActivity(req.team.teamId, req.query.limit)); }
  catch (err) { next(err); }
});

// ── Chat ──────────────────────────────────────────────────────
router.get('/team/messages', authMiddleware, requirePro, requireTeam, async (req, res, next) => {
  try {
    if (req.team.user) db.touchLastSeen(req.team.user.id).catch(() => {});
    res.json(await db.getTeamMessages(req.team.teamId, req.query.after, req.query.limit));
  } catch (err) { next(err); }
});

router.post('/team/messages', authMiddleware, noGuest, requirePro, requireTeam, async (req, res, next) => {
  try {
    const body = String((req.body || {}).body || '').trim();
    if (!body) return res.status(400).json({ error: 'Empty message' });
    const msg = await db.addTeamMessage(req.team.teamId, req.user.username, body, 'msg');
    if (req.team.user) db.touchLastSeen(req.team.user.id).catch(() => {});
    res.json({ ok: true, message: msg });
  } catch (err) { next(err); }
});

// ── Leaderboard (+ presence) ──────────────────────────────────
router.get('/team/leaderboard', authMiddleware, requirePro, requireTeam, async (req, res, next) => {
  try { res.json(await db.getTeamLeaderboard(req.team.teamId)); }
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
