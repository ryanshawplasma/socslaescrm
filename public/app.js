// ============================================================
//  State
// ============================================================
const state = {
  leads:       [],
  stats:       null,
  page:        'dashboard',
  role:        localStorage.getItem('crm_role') || null,
  me:          null,   // /api/users/me payload (business_type/business_custom, default_area, ...) — stashed by initApp
  myTeams:     [],
  activeOrgId: localStorage.getItem('crm_org_id') || '',
  search:      '',
  filterStage: '',
  filterProduct: '',
  filterDivision: '',
  filterSalesman: '',
  filterList:  '',
  filterGroup: '',   // '', 'active', 'won', 'lost' — set by clicking a dashboard KPI card
  myLists:     [],
  myProducts:  [],   // catalog "major items": [{id,name,division,aliases}]
  dbLeads:     [],   // team Database (reference bank) leads
  dbSelected:  new Set(),
  dbSearch:    '',
  selectedLeads: new Set(),   // bulk-select on the main Leads table
  view:        'table',
  fuFilter:    'overdue',
  sortKey:     '',
  sortDir:     'asc',
  charts:      {},
  aiMode: {
    leads:     localStorage.getItem('crm_ai_mode_leads')     === 'true',
    followups: localStorage.getItem('crm_ai_mode_followups') === 'true',
  },
};
window._aiParsedData = {};

const STAGE_COLORS = {
  'New Lead':        '#64748b',
  'Sample Required': '#06b6d4',
  'Sample Sent':     '#6366f1',
  'Quotation':       '#8b5cf6',
  'Negotiation':     '#f59e0b',
  'Order Won':       '#10b981',
  'Repeat Customer': '#14b8a6',
  'Lost':            '#ef4444',
};

const STAGE_NUMBERS = {
  'New Lead': '1', 'Sample Required': '2', 'Sample Sent': '3',
  'Quotation': '4', 'Negotiation': '5', 'Order Won': '6',
  'Repeat Customer': '7', 'Lost': '0',
};

// ============================================================
//  Business Types — CLIENT MIRROR of business-types.js (server copy).
//  Dive works for many businesses, not just factories. A team (or a user's
//  Personal workspace) picks ONE of these types; it changes the words the
//  app uses (what a lead is called, field labels, pipeline stage names).
//  IT NEVER CHANGES THE SCHEMA — factory_number/factory_name/... stay the
//  storage field names for every business; this is a display layer only.
//
//  If you edit business-types.js, mirror the change here too (and vice
//  versa). aiHint is server-only (AI-prompt vocabulary) and intentionally
//  omitted from this copy — the client never needs it.
// ============================================================
const BUSINESS_TYPES = {
  factory: {
    icon: '🏭', label: 'Manufacturing / Factories',
    entity: 'Factory', entityPlural: 'Factories',
    terms: { code: 'Factory #', name: 'Factory / Party Name', person: 'Person in Charge',
             product: 'Product', area: 'Area' },
    stages: {},   // the original — no relabels
    example: 'M99 Kapoor Shoes, Rameshji, 9876543210 — hotmelt 500kg @120, follow up Tuesday',
  },
  retail: {
    icon: '🏪', label: 'Retail & Shops',
    entity: 'Shop', entityPlural: 'Shops',
    terms: { code: 'Shop Code', name: 'Shop Name', person: 'Owner',
             product: 'Item', area: 'Locality' },
    stages: { 'New Lead': 'New Shop', 'Sample Required': 'Sample Asked', 'Sample Sent': 'Sample Given',
              'Quotation': 'Rates Shared', 'Order Won': 'Order Won', 'Repeat Customer': 'Repeat Buyer' },
    example: 'Sharma General Store, Ramesh bhai, 9876543210 — 20 boxes soap, follow up Tuesday',
  },
  distribution: {
    icon: '📦', label: 'Distribution / Wholesale',
    entity: 'Party', entityPlural: 'Parties',
    terms: { code: 'Party Code', name: 'Party Name', person: 'Contact Person',
             product: 'Product', area: 'Area' },
    stages: { 'New Lead': 'New Party', 'Quotation': 'Rates Shared' },
    example: 'Om Traders, Mehul bhai, 9876543210 — 50 cartons biscuits, rates shared, follow up Monday',
  },
  construction: {
    icon: '🏗️', label: 'Construction & Real Estate',
    entity: 'Site', entityPlural: 'Sites',
    terms: { code: 'Site Code', name: 'Site / Builder Name', person: 'Site Contact',
             product: 'Material / Service', area: 'Location' },
    stages: { 'New Lead': 'New Enquiry', 'Sample Required': 'Site Visit Planned', 'Sample Sent': 'Site Visit Done',
              'Quotation': 'Proposal Sent', 'Order Won': 'Booking Done', 'Repeat Customer': 'Repeat Client' },
    example: 'Skyline Builders site at Baner, Anil, 9876543210 — cement + waterproofing quote, site visit Friday',
  },
  pharma: {
    icon: '💊', label: 'Pharma & Medical',
    entity: 'Doctor / Chemist', entityPlural: 'Doctors & Chemists',
    terms: { code: 'Doctor Code', name: 'Doctor / Chemist Name', person: 'Contact Person',
             product: 'Brand / Product', area: 'Territory' },
    stages: { 'New Lead': 'New Doctor', 'Sample Required': 'Samples Asked', 'Sample Sent': 'Samples Given',
              'Quotation': 'Rate List Sent', 'Order Won': 'Prescribing', 'Repeat Customer': 'Regular Prescriber' },
    example: 'Dr Mehta, Apollo Clinic Andheri, 9876543210 — wants samples of Azithro 250, visit Tuesday',
  },
  services: {
    icon: '💼', label: 'Services & Agencies',
    entity: 'Client', entityPlural: 'Clients',
    terms: { code: 'Client Code', name: 'Client / Company Name', person: 'Contact Person',
             product: 'Service', area: 'Area' },
    stages: { 'New Lead': 'New Enquiry', 'Sample Required': 'Demo Requested', 'Sample Sent': 'Demo Done',
              'Quotation': 'Proposal Sent', 'Order Won': 'Contract Won', 'Repeat Customer': 'Retainer Client' },
    example: 'Nexus Tech, Priya, 9876543210 — website + SEO proposal, demo Friday',
  },
  logistics: {
    icon: '🚚', label: 'Logistics & Transport',
    entity: 'Client', entityPlural: 'Clients',
    terms: { code: 'Client Code', name: 'Client / Company Name', person: 'Contact Person',
             product: 'Route / Service', area: 'Zone' },
    stages: { 'New Lead': 'New Enquiry', 'Sample Required': 'Trial Asked', 'Sample Sent': 'Trial Shipment Done',
              'Quotation': 'Rates Shared', 'Order Won': 'Contract Won', 'Repeat Customer': 'Regular Client' },
    example: 'Kwality Foods, Arjun, 9876543210 — Mumbai–Delhi weekly route, trial shipment Monday',
  },
  education: {
    icon: '🎓', label: 'Education & Coaching',
    entity: 'Student', entityPlural: 'Students',
    terms: { code: 'Enquiry No.', name: 'Student Name', person: 'Parent / Guardian',
             product: 'Course', area: 'Locality' },
    stages: { 'New Lead': 'New Enquiry', 'Sample Required': 'Demo Class Asked', 'Sample Sent': 'Demo Class Done',
              'Quotation': 'Fees Quoted', 'Negotiation': 'Counselling', 'Order Won': 'Admitted', 'Repeat Customer': 'Renewed' },
    example: 'Aarav Sharma, father Rajesh, 9876543210 — Class 10 maths enquiry, demo class Saturday',
  },
  hospitality: {
    icon: '🏨', label: 'Hotels & Restaurants',
    entity: 'Outlet', entityPlural: 'Outlets',
    terms: { code: 'Outlet Code', name: 'Hotel / Restaurant Name', person: 'Manager / Owner',
             product: 'Product', area: 'Area' },
    stages: { 'New Lead': 'New Outlet', 'Sample Required': 'Sample Asked', 'Sample Sent': 'Tasting / Sample Done',
              'Quotation': 'Rates Shared', 'Repeat Customer': 'Regular Buyer' },
    example: 'Cafe Blue Terrace, manager Rohit, 9876543210 — monthly coffee supply, tasting Thursday',
  },
  agro: {
    icon: '🌾', label: 'Agro & Farm Inputs',
    entity: 'Dealer', entityPlural: 'Dealers',
    terms: { code: 'Dealer Code', name: 'Dealer / Farmer Name', person: 'Contact Person',
             product: 'Product', area: 'Village / Area' },
    stages: { 'New Lead': 'New Dealer', 'Sample Required': 'Demo Asked', 'Sample Sent': 'Field Demo Done',
              'Quotation': 'Rates Shared', 'Repeat Customer': 'Repeat Dealer' },
    example: 'Kisan Agro Center, Balu bhai, 9876543210 — 100 bags urea, field demo Monday',
  },
  finance: {
    icon: '💰', label: 'Finance & Insurance',
    entity: 'Client', entityPlural: 'Clients',
    terms: { code: 'Client Code', name: 'Client Name', person: 'Contact Person',
             product: 'Product / Policy', area: 'Area' },
    stages: { 'New Lead': 'New Enquiry', 'Sample Required': 'Quote Shared', 'Sample Sent': 'Proposal Shared',
              'Quotation': 'Documents Requested', 'Order Won': 'Policy Issued', 'Repeat Customer': 'Renewal Client' },
    example: 'Suresh Patel, 9876543210 — term insurance 1Cr quote, documents pending, call Wednesday',
  },
  custom: {
    icon: '⚙️', label: 'Custom',
    entity: 'Lead', entityPlural: 'Leads',
    terms: { code: 'Code', name: 'Name', person: 'Contact Person',
             product: 'Product', area: 'Area' },
    stages: {},
    example: 'New lead: name, contact, what they want, follow-up day',
  },
};
const BUSINESS_KEYS = Object.keys(BUSINESS_TYPES);

// Resolve a profile: valid type key + custom-term overrides merged in (mirrors
// resolveBusinessProfile() in business-types.js — keep both in sync). Custom
// terms only apply to the 'custom' type. Always safe — unknown/missing keys
// fall back to 'factory' so nothing existing ever changes behaviour.
function resolveBizProfile(type, customJson) {
  const key = BUSINESS_KEYS.includes(type) ? type : 'factory';
  const base = BUSINESS_TYPES[key];
  if (key !== 'custom') return { key, ...base };
  let custom = {};
  try { custom = typeof customJson === 'string' ? JSON.parse(customJson || '{}') : (customJson || {}); } catch (_) {}
  // JSON.parse('null')/'0'/'"x"' all succeed without throwing, so `custom` can
  // still be non-object here (e.g. null) — guard before custom.entity etc. below.
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)) custom = {};
  // Optional per-stage display renames (custom type only): keep only exact
  // canonical stage keys with non-empty string values, capped at 30 chars —
  // stageLabel() then picks them up everywhere automatically.
  const stages = {};
  const rawStages = (custom.stages && typeof custom.stages === 'object' && !Array.isArray(custom.stages)) ? custom.stages : {};
  for (const canon of Object.keys(STAGE_NUMBERS)) {
    const v = rawStages[canon];
    if (typeof v === 'string' && v.trim()) stages[canon] = v.trim().slice(0, 30);
  }
  return {
    key, ...base, stages,
    entity: String(custom.entity || base.entity).slice(0, 30),
    entityPlural: String(custom.entityPlural || custom.entity || base.entityPlural).slice(0, 30),
    terms: {
      code:    String(custom.code    || base.terms.code).slice(0, 30),
      name:    String(custom.name    || base.terms.name).slice(0, 40),
      person:  String(custom.person  || base.terms.person).slice(0, 30),
      product: String(custom.product || base.terms.product).slice(0, 30),
      area:    String(custom.area    || base.terms.area).slice(0, 30),
    },
  };
}

// The ACTIVE business profile: the current team's (when viewing a team
// workspace) else the signed-in user's Personal profile. Falls back to
// 'factory' automatically — via resolveBizProfile — until data has loaded.
function biz() {
  if (state.activeOrgId) {
    const team = (state.myTeams || []).find(t => String(t.id) === String(state.activeOrgId));
    return resolveBizProfile(team && team.business_type, team && team.business_custom);
  }
  return resolveBizProfile(state.me && state.me.business_type, state.me && state.me.business_custom);
}

// Term lookup on the active profile: T('entity'), T('entityPlural'),
// T('code'), T('name'), T('person'), T('product'), T('area').
function T(key) {
  const p = biz();
  if (key === 'entity' || key === 'entityPlural') return p[key];
  return p.terms[key] || '';
}

// Display-only relabel of a canonical stage name. NEVER use this for stored
// values or filter comparisons — leads.stage / STAGE_NUMBERS keys never
// change; this is purely what gets painted on screen.
function stageLabel(canonicalStage) {
  return biz().stages[canonicalStage] || canonicalStage;
}

// ── Static-DOM business-term relabeling ──────────────────────────────────
// index.html has some labels/headers/placeholders that are plain static
// markup (not built by a render function that re-runs on every navigation).
// Mark those nodes with data-bizterm="<T() key>" (whole text = one term) or
// data-bizterm-tpl="...{key}..." (a sentence with one or more {key}/{key|lower}
// tokens — e.g. "{entityPlural} to Visit"), and data-bizterm-ph / data-bizterm-ph-tpl
// for the same on an input's placeholder. applyBusinessTerms() fills them all in
// from the active business profile. It's cheap and idempotent — safe to call on
// every renderPage(), which is exactly where it's wired in (top of renderPage()),
// so switching page / workspace / business type always keeps these in sync.
// Assignment goes through .textContent / .placeholder (never innerHTML), so this
// is XSS-safe even though custom business-type terms are user-supplied text.
const BIZTERM_KEYS = ['entity', 'entityPlural', 'code', 'name', 'person', 'product', 'area'];

function bizTermValue(token) {
  const [key, mod] = token.split('|');
  let v = BIZTERM_KEYS.includes(key) ? T(key)
        : key === 'example' ? (biz().example || '')   // per-business sample message
        : '';
  return mod === 'lower' ? v.toLowerCase() : v;
}

function fillBizTemplate(tpl) {
  return String(tpl || '').replace(/\{([\w]+(?:\|\w+)?)\}/g, (_, token) => bizTermValue(token));
}

function applyBusinessTerms() {
  document.querySelectorAll('[data-bizterm]').forEach(el => {
    el.textContent = T(el.getAttribute('data-bizterm'));
  });
  document.querySelectorAll('[data-bizterm-tpl]').forEach(el => {
    el.textContent = fillBizTemplate(el.getAttribute('data-bizterm-tpl'));
  });
  document.querySelectorAll('[data-bizterm-ph]').forEach(el => {
    el.placeholder = T(el.getAttribute('data-bizterm-ph'));
  });
  document.querySelectorAll('[data-bizterm-ph-tpl]').forEach(el => {
    el.placeholder = fillBizTemplate(el.getAttribute('data-bizterm-ph-tpl'));
  });
  // #f-stage is the one static canonical-stage <option> list in index.html (the
  // Add/Edit lead modal). Relabel the visible text only — `value` stays the
  // canonical STAGE_NUMBERS string the form actually submits.
  document.querySelectorAll('#f-stage option[value]').forEach(opt => {
    if (opt.value) opt.textContent = stageLabel(opt.value);
  });
}

// ── Lazy library loaders ─────────────────────────────────────
// chart.js (~200KB), xlsx (~880KB) and leaflet (~150KB) used to be render-
// blocking <script>s in <head>. They're each only needed on specific surfaces
// (dashboard/reports charts, import, map), so we load them on demand — keeping
// them off the startup critical path. Each loader is memoized so concurrent
// callers share one download.
const _libPromises = {};
function loadScriptOnce(key, src) {
  if (_libPromises[key]) return _libPromises[key];
  _libPromises[key] = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { _libPromises[key] = null; reject(new Error('Failed to load ' + src)); };
    document.head.appendChild(s);
  });
  return _libPromises[key];
}
// Self-hosted under /vendor (with a ?v cache-buster) — same-origin so they load
// fast, get cached by the service worker for offline, and carry no external-CDN
// dependency. Bump the ?v when upgrading a vendored library.
function ensureXLSX() {
  return (typeof XLSX !== 'undefined')
    ? Promise.resolve()
    : loadScriptOnce('xlsx', '/vendor/xlsx.full.min.js?v=1');
}
function ensureChart() {
  if (typeof Chart !== 'undefined') { registerChartPlugins(); return Promise.resolve(); }
  return loadScriptOnce('chart', '/vendor/chart.umd.min.js?v=1')
    .then(registerChartPlugins);
}
function ensureLeaflet() {
  if (typeof L !== 'undefined') return Promise.resolve();
  if (!document.getElementById('leaflet-css')) {
    const link = document.createElement('link');
    link.id = 'leaflet-css'; link.rel = 'stylesheet';
    link.href = '/vendor/leaflet.css?v=1';
    document.head.appendChild(link);
  }
  return loadScriptOnce('leaflet', '/vendor/leaflet.js?v=1');
}

// ── Doughnut center-text plugin — registered once, after chart.js loads ──────
let _chartPluginsRegistered = false;
function registerChartPlugins() {
  if (_chartPluginsRegistered || typeof Chart === 'undefined') return;
  _chartPluginsRegistered = true;
  Chart.register({
    id: 'doughnutCenter',
    afterDatasetsDraw(chart) {
      if (chart.config.type !== 'doughnut') return;
      const cfg = chart.config.options.plugins?.doughnutCenter;
      if (!cfg?.enabled) return;
      const { ctx, chartArea } = chart;
      if (!chartArea) return;
      const cx = chartArea.left + chartArea.width / 2;
      const cy = chartArea.top  + chartArea.height / 2;
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      ctx.save();
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = "bold 22px 'Inter', system-ui, sans-serif";
      ctx.fillStyle = dark ? '#e6edf3' : '#0f172a';
      ctx.fillText(String(cfg.value ?? ''), cx, cy - 9);
      ctx.font = "11px 'Inter', system-ui, sans-serif";
      ctx.fillStyle = '#8b949e';
      ctx.fillText(cfg.label ?? '', cx, cy + 10);
      ctx.restore();
    },
  });
}

// ============================================================
//  AUTH — token management
// ============================================================

function storeTokens(accessToken, refreshToken) {
  localStorage.setItem('crm_token', accessToken);
  if (refreshToken) localStorage.setItem('crm_refresh_token', refreshToken);
  // Decode JWT expiry (payload is base64url-encoded JSON between the two dots)
  try {
    const payload = JSON.parse(atob(accessToken.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
    if (payload.exp) localStorage.setItem('crm_token_exp', String(payload.exp));
  } catch (_) {}
}

function clearTokens() {
  ['crm_token','crm_refresh_token','crm_token_exp'].forEach(k => localStorage.removeItem(k));
}

function tokenIsExpired() {
  const exp = parseInt(localStorage.getItem('crm_token_exp') || '0', 10);
  return exp ? Date.now() / 1000 > exp - 30 : false; // treat as expired 30s early
}

// Refresh tokens are single-use — two calls racing on the same stored token
// (e.g. the 60s auto-refresh's Promise.all([loadLeads(), loadStats()]) both
// noticing the access token is about to expire) used to make the loser look
// like a stolen-token replay to the server, which revoked the whole session
// and silently broke "remember this device". De-duping concurrent calls to a
// single in-flight promise — same-tab always, cross-tab via the Web Locks API
// where supported — stops the race from happening in the first place; the
// server also now tolerates a short race window as defense in depth.
// Retry a few times before giving up — covers a Render free-tier cold start
// where the first refresh hits a still-booting server (5xx/timeout). Stops
// early if the token turns out to be genuinely invalid (401 clears it).
async function tryRefreshWithRetries(attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    if (await tryRefreshToken()) return true;
    if (!localStorage.getItem('crm_refresh_token')) return false;  // 401 → token gone, no point retrying
    if (i < attempts - 1) await new Promise(r => setTimeout(r, 1200 * (i + 1)));
  }
  return false;
}

let _refreshInFlight = null;
async function tryRefreshToken() {
  if (_refreshInFlight) return _refreshInFlight;
  const run = async () => {
    const rt = localStorage.getItem('crm_refresh_token');
    if (!rt) return false;
    try {
      const res  = await fetch('/api/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      });
      // Only a genuine auth rejection (invalid/expired/revoked token) should end
      // the remembered session. A 5xx or timeout — e.g. Render's free tier still
      // cold-starting when the app is opened — is TRANSIENT: keep the saved token
      // so the very next attempt (or the "Continue" tap) succeeds. Wiping it here
      // was why a cold open looked like the device was never remembered.
      if (res.status === 401 || res.status === 403) { clearTokens(); return false; }
      if (!res.ok) return false;   // transient — token preserved, try again shortly
      const data = await res.json();
      storeTokens(data.accessToken, data.refreshToken);
      if (data.username) localStorage.setItem('crm_user', data.username);
      if (data.role)     { localStorage.setItem('crm_role', data.role); state.role = data.role; }
      return true;
    } catch { return false; }   // network error / server waking — keep the token
  };
  _refreshInFlight = (async () => {
    try {
      if (navigator.locks && navigator.locks.request) {
        // Cross-tab mutex: only one tab of this origin rotates the token at a time.
        return await navigator.locks.request('crm-refresh-token', run);
      }
      return await run();
    } catch {
      return false; // tryRefreshToken() must never reject — callers just await a boolean
    } finally {
      _refreshInFlight = null;
    }
  })();
  return _refreshInFlight;
}

// ── Device fingerprint ────────────────────────────────────────
function getDeviceFingerprint() {
  const parts = [navigator.userAgent, screen.width + 'x' + screen.height,
    Intl.DateTimeFormat().resolvedOptions().timeZone, navigator.language];
  const raw = parts.join('|');
  // Simple hash via btoa (not cryptographic, but good enough for device ID)
  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  return 'fp_' + Math.abs(hash).toString(36) + '_' + btoa(navigator.userAgent.slice(0,20)).replace(/[^a-z0-9]/gi,'').slice(0,8);
}

function getDeviceMeta() {
  const ua = navigator.userAgent;
  let browser = 'Browser', os = 'Unknown';
  if (/Edg\//.test(ua))     browser = 'Edge';
  else if (/OPR\//.test(ua))  browser = 'Opera';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';
  if (/Windows/.test(ua))     os = 'Windows';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/iPhone|iPad/.test(ua)) os = 'iOS';
  else if (/Mac/.test(ua))    os = 'macOS';
  else if (/Linux/.test(ua))  os = 'Linux';
  const type = /Mobi|Android|iPhone|iPad/.test(ua) ? 'mobile' : 'desktop';
  return { name: `${browser} on ${os}`, browser, os, type };
}

// ── Credential detection label ─────────────────────────────────
function detectCredentialType(val) {
  if (!val) return '';
  if (val.includes('@')) return 'Email';
  if (/^\+?\d{7,}$/.test(val.replace(/[\s\-\(\)]/g,''))) return 'Mobile';
  return 'Username';
}

// ── Login / Register screen switching ────────────────────────
// User-name chips are intentionally NOT shown on the login page — we don't
// expose the list of accounts (incl. admins) publicly. The last-used username
// is still remembered per device for a fast sign-in.
function updateCredentialLabel(val) {
  const lbl = document.getElementById('credential-type-label');
  if (lbl) lbl.textContent = detectCredentialType(val);
}

function showForgotPin(e) {
  if (e) e.preventDefault();
  const box = document.getElementById('forgot-pin-box');
  box.style.display = box.style.display === 'none' ? '' : 'none';
}

// ── Invite deep-links (…?join=CODE) ───────────────────────────
// An invite link must survive the login/register wall: the code is parked in
// localStorage at boot, surfaced as a banner on the auth screens, and consumed
// by initApp() right after the user is signed in (or right after they register).
function capturePendingInvite() {
  try {
    const params = new URLSearchParams(location.search);
    const joinCode = (params.get('join') || '').trim();
    const refCode  = (params.get('ref')  || '').trim();
    if (!joinCode && !refCode) return;
    if (joinCode) { localStorage.setItem('crm_pending_join', joinCode); params.delete('join'); }
    if (refCode)  { localStorage.setItem('crm_pending_ref',  refCode);  params.delete('ref'); }
    const qs = params.toString();
    history.replaceState({}, '', location.pathname + (qs ? '?' + qs : ''));
  } catch (_) {}
}

function pendingInviteCode() { return (localStorage.getItem('crm_pending_join') || '').trim(); }
function pendingRefCode()    { return (localStorage.getItem('crm_pending_ref')  || '').trim(); }

// Show/refresh the "you've been invited" note on both auth screens.
function renderInviteBanners() {
  const code = pendingInviteCode();
  const ref  = pendingRefCode();
  ['login-screen', 'register-screen'].forEach(id => {
    const scr = document.getElementById(id);
    if (!scr) return;
    let b = scr.querySelector('.invite-banner');
    if (!code && !ref) { b?.remove(); return; }
    if (!b) {
      b = document.createElement('div');
      b.className = 'invite-banner';
      scr.prepend(b);
    }
    b.innerHTML = code
      ? `🎟 <b>Team invite detected</b> — sign in or create an account and you'll join the team automatically. New members get 2 months of Pro free.`
      : `🎁 You've been invited — create an account and get 2 months of Dive Pro free.`;
  });
}

// Join the team an invite link promised, right after auth. Guests keep the
// code parked so it still works once they create a real account.
async function consumePendingInvite() {
  const code = pendingInviteCode();
  if (!code || state.role === 'guest') return;
  try {
    const { team } = await apiFetch('/api/teams/join', { method: 'POST', body: JSON.stringify({ invite_code: code }) });
    localStorage.removeItem('crm_pending_join');
    state.activeOrgId = String(team.id);
    localStorage.setItem('crm_org_id', state.activeOrgId);
    localStorage.setItem('ws_team_id', state.activeOrgId);
    setLeadDest(String(team.id));
    toast(`Welcome to ${team.name}! 🎉 You're in the team — new leads save here.`, 'success');
  } catch (err) {
    if (/already a member/i.test(err.message || '')) { localStorage.removeItem('crm_pending_join'); return; }   // nothing to do
    toast(`Couldn't accept the team invite: ${err.message}`, 'error');
  }
}

function showLoginPage() {
  // Hide PIN unlock, show login screen
  document.getElementById('pin-unlock-screen').style.display = 'none';
  document.getElementById('login-screen').style.display      = '';
  document.getElementById('register-screen').style.display   = 'none';
  renderInviteBanners();
  const overlay = document.getElementById('login-overlay');
  overlay.classList.remove('fade-out');   // clear any leftover dissolve state
  overlay.classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  // Prefill last-used username for a faster sign-in
  const lastUser = localStorage.getItem('crm_last_user');
  const credEl   = document.getElementById('login-username');
  if (lastUser && credEl && !credEl.value) {
    credEl.value = lastUser;
    updateCredentialLabel(lastUser);
    setTimeout(() => document.getElementById('login-password')?.focus(), 50);
  } else {
    setTimeout(() => credEl?.focus(), 50);
  }
  if (window.SimpleWebAuthnBrowser?.browserSupportsWebAuthn())
    document.getElementById('biometric-login-section').classList.remove('hidden');
}

// ── Login helpers: show/hide secret + error shake ─────────────
function togglePw(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  btn.textContent = show ? '🙈' : '👁';
  btn.setAttribute('aria-label', show ? 'Hide PIN' : 'Show PIN');
  input.focus();
}

function shakeError(el) {
  if (!el) return;
  el.classList.remove('shake');
  void el.offsetWidth; // restart animation
  el.classList.add('shake');
}

function hideLoginPage() {
  const overlay = document.getElementById('login-overlay');
  const app     = document.getElementById('app');
  app.classList.remove('hidden');
  applyRoleUI();
  // Reveal the app underneath, then dissolve the overlay over it (rather than a
  // hard display:none cut). Guarded so a missing/already-hidden overlay is a
  // no-op. During the launch splash this runs invisibly beneath the splash.
  if (overlay.classList.contains('hidden')) return;
  overlay.classList.add('fade-out');
  setTimeout(() => {
    overlay.classList.add('hidden');
    overlay.classList.remove('fade-out');
  }, 340);
}

function applyRoleUI() {
  const isAdmin = state.role === 'admin';
  document.querySelectorAll('.admin-only').forEach(el => el.style.display = isAdmin ? '' : 'none');
  const name   = localStorage.getItem('crm_user') || '';
  const userEl = document.getElementById('current-user');
  if (userEl) userEl.textContent = `${name} (${state.role || '?'})`;

  // New sidebar user card
  const avatarEl = document.getElementById('sidebar-avatar');
  const nameEl   = document.getElementById('sidebar-username');
  const roleEl   = document.getElementById('sidebar-role');
  const initials = name ? name.trim().replace(/[^a-zA-Z0-9]/g, ' ').trim().split(/\s+/)
    .slice(0, 2).map(w => w[0]).join('').toUpperCase() || name[0].toUpperCase() : '?';
  if (avatarEl) avatarEl.textContent = initials;
  if (nameEl)   nameEl.textContent   = name || 'Guest';
  if (roleEl)   roleEl.textContent   = (state.role || 'user').replace(/^\w/, c => c.toUpperCase());
  if (window.SimpleWebAuthnBrowser?.browserSupportsWebAuthn()) {
    const bioBtn = document.getElementById('btn-enable-biometric');
    if (bioBtn) {
      const enabled = localStorage.getItem('biometric_enabled') === name;
      bioBtn.classList.toggle('hidden', enabled);
      bioBtn.textContent = enabled ? '🔐 Biometric Active' : '🔐 Enable Biometric Login';
      bioBtn.disabled = enabled;
    }
  }
}

// Wipe every account-scoped localStorage key + in-memory state field so the
// next login on this device/tab (a different person, or the same person
// re-authenticating) can never inherit a leftover workspace, team, or lead
// destination from the account that was just signed out. Without this, since
// logout/switch-account never reloads the page, `state.activeOrgId` — which
// applyDefaultWorkspace() only sets when *empty* — would silently keep
// pointing at the previous account's team for the entire next session.
function resetAccountScopedState() {
  localStorage.removeItem('crm_org_id');
  localStorage.removeItem('ws_team_id');
  localStorage.removeItem('crm_lead_dest');
  localStorage.removeItem('crm_default_area');
  _defaultWorkspaceApplied = false;   // next sign-in re-applies its default workspace
  state.activeOrgId  = '';
  state.myTeams      = [];
  state.leads        = [];
  state.dbLeads      = [];
  state.stats        = null;
  state.myLists      = [];
  state.myProducts   = [];
  state.selectedLeads.clear();
  state.dbSelected.clear();
}

// Kill every background loop the app runs while signed in. Without this,
// logout / session-expiry leaves the presence heartbeat, auto-refresh and hub
// chat poll firing unauthenticated requests (endless 401s + "session expired"
// noise) and the socket keeps the user looking "online" after they left.
function stopBackgroundTimers() {
  clearInterval(autoRefreshTimer);   autoRefreshTimer = null;
  clearInterval(refreshLabelTimer);  refreshLabelTimer = null;
  if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
  hubStopChatPoll();
  if (_socket) { try { _socket.disconnect(); } catch (_) {} _socket = null; }
}

async function logout() {
  if (!confirm('Sign out of Dive?')) return;
  stopBackgroundTimers();
  // Tell server to revoke session (best-effort)
  try {
    const token = localStorage.getItem('crm_token');
    if (token) await fetch('/api/auth/logout', { method: 'POST', headers: { Authorization: 'Bearer ' + token } });
  } catch (_) {}
  clearTokens();
  localStorage.removeItem('crm_role');
  localStorage.removeItem('crm_user');
  localStorage.removeItem('crm_user_id');
  localStorage.removeItem('crm_session_id');
  resetAccountScopedState();
  state.role = null;
  showLoginPage();
}

function switchAccount() {
  stopBackgroundTimers();
  clearTokens();
  localStorage.removeItem('crm_role');
  localStorage.removeItem('crm_user');
  localStorage.removeItem('crm_user_id');
  localStorage.removeItem('crm_session_id');
  localStorage.removeItem('crm_device_trusted');
  localStorage.removeItem('crm_device_id');
  localStorage.removeItem('crm_device_has_pin');
  resetAccountScopedState();
  state.role = null;
  document.getElementById('pin-unlock-screen').style.display = 'none';
  showLoginScreen();
}

// ── PIN Unlock screen ─────────────────────────────────────────
// ── Idle re-lock ──────────────────────────────────────────────
// The app keeps you signed in on a known device, but after a long gap since it
// was last used it re-asks for your quick-unlock PIN (or biometric) on open.
// Within the window it still auto-logs-in — no prompt. "Last used" is kept
// fresh by a heartbeat while the app is visible and when it's backgrounded.
const IDLE_LOCK_MS = 60 * 60 * 1000;   // 1 hour

function touchActivity() {
  try { localStorage.setItem('crm_last_active', String(Date.now())); } catch (_) {}
}
function idleExceeded() {
  const t = parseInt(localStorage.getItem('crm_last_active'), 10);
  if (!t) return true;                 // unknown last-active → treat as idle (safer)
  return (Date.now() - t) > IDLE_LOCK_MS;
}
// A usable second factor exists on this device: a quick-unlock PIN, or a
// registered biometric on a browser that actually supports WebAuthn.
function hasUnlockFactor() {
  if (localStorage.getItem('crm_device_has_pin') === 'true') return true;
  const bioUser = localStorage.getItem('biometric_enabled');
  const user    = localStorage.getItem('crm_user');
  const bioOk   = !!(window.SimpleWebAuthnBrowser
    && window.SimpleWebAuthnBrowser.browserSupportsWebAuthn
    && window.SimpleWebAuthnBrowser.browserSupportsWebAuthn());
  return !!bioUser && bioUser === user && bioOk;
}
// Wire the heartbeat + background/return handling once, at startup.
function initIdleLock() {
  const active = () => state.role && state.role !== 'guest';
  setInterval(() => { if (document.visibilityState === 'visible' && active()) touchActivity(); }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (!active()) return;
    if (document.visibilityState === 'hidden') { touchActivity(); return; }
    // Returned to the foreground: if we've been idle past the window and a factor
    // is set, reload so checkAndShowAuth() presents the lock screen; else resume.
    if (idleExceeded() && hasUnlockFactor()) location.reload();
    else touchActivity();
  });
}

async function checkAndShowAuth() {
  // Resume guest/demo session if still valid
  const guestToken = localStorage.getItem('crm_access');
  if (localStorage.getItem('crm_role') === 'guest' && guestToken) {
    localStorage.setItem('crm_token', guestToken); // ensure apiFetch can read it
    state.role = 'guest';
    hideLoginPage();
    showDemoBanner();
    await initApp();
    return;
  }

  const rt          = localStorage.getItem('crm_refresh_token');
  const devicePin   = localStorage.getItem('crm_device_has_pin') === 'true';
  const savedUser   = localStorage.getItem('crm_user');

  // Remembered device:
  //  • If a quick-unlock PIN was set, ask for it (the user's security choice).
  //  • Otherwise KEEP THEM LOGGED IN — silently refresh the session and go
  //    straight into the app, no welcome tap needed. Only if that refresh
  //    fails do we show the greeting/continue screen as a fallback.
  if (rt && savedUser) {
    // Re-lock (PIN/biometric) ONLY after a long idle gap; within the window we
    // keep the fast auto-login even when a PIN is set. Devices with no PIN and
    // no usable biometric are never blocked here.
    if (idleExceeded() && hasUnlockFactor()) {
      showPinUnlockScreen(savedUser, devicePin, true);
      return;
    }
    const ok = await tryRefreshWithRetries();
    if (ok) {
      state.role = localStorage.getItem('crm_role') || 'sales';
      touchActivity();
      hideLoginPage();
      await initApp();
      return;
    }
    // Couldn't refresh right now. If the token is still here it was a transient
    // failure (server waking) — greet them and let "Continue" retry, never a
    // blank fresh login.
    showPinUnlockScreen(savedUser, false);
    return;
  }

  // A refresh token but no saved username → try a silent refresh, else login.
  if (rt) {
    const ok = await tryRefreshWithRetries();
    if (ok) {
      state.role = localStorage.getItem('crm_role') || 'sales';
      hideLoginPage();
      await initApp();
      return;
    }
  }

  // Fall through to login
  showLoginPage();
}

function showPinUnlockScreen(username, hasPIN, lock = false) {
  const name    = username || 'there';
  const bioAvail = !!(window.SimpleWebAuthnBrowser && window.SimpleWebAuthnBrowser.browserSupportsWebAuthn
    && window.SimpleWebAuthnBrowser.browserSupportsWebAuthn());

  document.getElementById('pin-unlock-name').textContent   = 'Welcome back, ' + name;
  document.getElementById('pin-unlock-avatar').textContent = (name[0] || '?').toUpperCase();
  document.getElementById('pin-error').textContent = '';

  const padWrap = document.getElementById('pin-pad-wrap');
  const contBtn = document.getElementById('pin-unlock-continue');
  const bioBtn  = document.getElementById('pin-unlock-biometric');
  const sub     = document.getElementById('pin-unlock-sub');
  const input   = document.getElementById('pin-input');

  if (input) { input.value = ''; input.maxLength = pinUnlockLen(); }
  pinInputChanged('');   // (re)draw the empty PIN dots at the right count (4 or 6)

  if (hasPIN) {
    padWrap.classList.remove('hidden');
    contBtn.classList.add('hidden');
    const digits = pinUnlockLen();
    sub.textContent = bioAvail ? `Enter your ${digits}-digit PIN, or use biometric` : `Enter your ${digits}-digit PIN`;
  } else {
    padWrap.classList.add('hidden');
    // In an enforced idle-lock with no PIN, require biometric — hide the one-tap
    // Continue so the lock can't be bypassed (the "use password" link stays as a
    // fallback). Otherwise this is just the friendly welcome-back / retry screen.
    contBtn.classList.toggle('hidden', lock);
    contBtn.textContent = 'Continue as ' + name + ' →';
    sub.textContent = bioAvail
      ? (lock ? 'Unlock with biometric to continue' : 'Unlock with biometric, or continue')
      : (lock ? 'Unlock to continue' : 'Tap continue to open your account');
  }
  bioBtn.classList.toggle('hidden', !bioAvail);

  document.getElementById('pin-unlock-screen').style.display = '';
  document.getElementById('login-screen').style.display      = 'none';
  document.getElementById('register-screen').style.display   = 'none';
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  if (hasPIN) setTimeout(() => input && input.focus(), 100);
}

// One-tap open for a remembered device that has no quick-unlock PIN: silently
// refresh the session and go straight in. Never leaves the user on a blank
// screen — on failure it shows an error and the password fallback stays.
async function continueRemembered() {
  const btn = document.getElementById('pin-unlock-continue');
  const err = document.getElementById('pin-error');
  err.textContent = '';
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Opening…';
  try {
    const ok = await tryRefreshWithRetries(4);
    if (!ok) {
      // Token still present → server was just waking; otherwise it truly expired.
      throw new Error(localStorage.getItem('crm_refresh_token')
        ? 'Still connecting… tap continue again in a moment.'
        : 'Your session has expired — please sign in with your password.');
    }
    state.role = localStorage.getItem('crm_role') || 'sales';
    hideLoginPage();
    await initApp();
  } catch (e) {
    err.textContent = e.message || 'Could not open — use your password below.';
    btn.disabled = false;
    btn.textContent = label;
  }
}

function pinUnlockLen() {
  const n = parseInt(localStorage.getItem('crm_pin_len'), 10);
  return (n === 4 || n === 6) ? n : 6;   // default 6 for older PINs with no stored length
}

function pinInputChanged(val) {
  const dots  = document.getElementById('pin-dots');
  const total = pinUnlockLen();
  const len   = Math.min(val.length, total);
  dots.innerHTML = Array.from({ length: total }, (_, i) =>
    `<div class="pin-dot${i < len ? ' filled' : ''}"></div>`
  ).join('');
  // Seamless: submit automatically the moment the full PIN is entered — no need
  // to hit the → key. submitPinUnlock guards against a double-submit itself.
  if (val.length === total && /^\d+$/.test(val)) submitPinUnlock();
}

async function submitPinUnlock() {
  const pin      = document.getElementById('pin-input').value.trim();
  const deviceId = localStorage.getItem('crm_device_id');
  const rt       = localStorage.getItem('crm_refresh_token');
  const errEl    = document.getElementById('pin-error');
  const btn      = document.getElementById('pin-unlock-btn');
  if (btn.disabled) return;   // already submitting (auto-submit + Enter could race)
  errEl.textContent = '';
  if (!pin || !/^\d{4,6}$/.test(pin)) { errEl.textContent = 'Enter 4–6 digit PIN'; return; }
  btn.disabled = true;
  try {
    const res  = await fetch('/api/auth/pin-unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt, pin, deviceId }),
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || 'Wrong PIN';
      document.getElementById('pin-input').value = '';
      pinInputChanged('');
      return;
    }
    storeTokens(data.accessToken, data.refreshToken);
    localStorage.setItem('crm_user', data.username);
    localStorage.setItem('crm_role', data.role);
    state.role = data.role;
    hideLoginPage();
    await initApp();
  } catch (err) {
    errEl.textContent = 'Connection error. Try again.';
  } finally {
    btn.disabled = false;
  }
}

// ── Post-login device setup ───────────────────────────────────
async function offerDeviceSetup(loginData) {
  const { deviceId, deviceTrusted, hasPIN, username, accessToken, refreshToken } = loginData;
  storeTokens(accessToken, refreshToken);
  localStorage.setItem('crm_user',      username);
  localStorage.setItem('crm_last_user', username);   // remembered for next sign-in on this device
  localStorage.setItem('crm_role',      loginData.role);
  localStorage.setItem('crm_user_id',   String(loginData.userId || ''));
  localStorage.setItem('crm_session_id', loginData.sessionId || '');
  state.role = loginData.role;

  if (deviceId) {
    localStorage.setItem('crm_device_id',      deviceId);
    localStorage.setItem('crm_device_trusted', 'true');
    localStorage.setItem('crm_device_has_pin', String(hasPIN));
    // If this account has no PIN on this device, drop any stale length left by a
    // previous account so the unlock screen never shows the wrong # of boxes.
    if (!hasPIN) localStorage.removeItem('crm_pin_len');
  } else {
    // Untrusted login — clear any previous account's device/PIN flags so they
    // never leak into this session.
    localStorage.removeItem('crm_device_id');
    localStorage.removeItem('crm_device_trusted');
    localStorage.removeItem('crm_device_has_pin');
    localStorage.removeItem('crm_pin_len');
  }

  hideLoginPage();

  if (loginData.needsPasswordSetup) {
    // Legacy account that just logged in with its PIN — force a real password
    // before anything else. PIN setup (if any) is chained after it's done.
    showSetPasswordModal({ migration: true, deviceId, deviceTrusted, hasPIN });
  } else if (deviceTrusted && !hasPIN && localStorage.getItem('crm_pin_offered') !== deviceId) {
    // Offer a quick-unlock PIN ONCE per device. If the user set or skipped it
    // already we never nag again — they can still add one later from the account
    // menu. (This is what was popping up on every single login.)
    setTimeout(() => showPinSetupModal(deviceId), 500);
  }

  await initApp();
}

// ── PIN Setup modal ───────────────────────────────────────────
let pinSetupLen = 4;   // user picks 4- or 6-digit; drives maxlength + validation

// Toggle the 4- vs 6-digit choice: update both inputs' maxlength/placeholder and
// the active button. Clears any partly-typed PIN so it can't exceed the new len.
function setPinSetupLen(n) {
  pinSetupLen = n === 6 ? 6 : 4;
  document.querySelectorAll('#pin-setup-modal .pin-len-btn').forEach(b =>
    b.classList.toggle('active', Number(b.dataset.len) === pinSetupLen));
  ['pin-setup-input', 'pin-setup-input2'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.maxLength = pinSetupLen;
    el.placeholder = pinSetupLen + ' digits';
    el.value = '';
  });
  const err = document.getElementById('pin-setup-error');
  if (err) err.textContent = '';
}

function showPinSetupModal(deviceId) {
  const modal = document.getElementById('pin-setup-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.dataset.deviceId = deviceId || '';
  // NOTE: we do NOT mark the device as "offered" here — only an explicit "Not
  // now" (skipPinSetup) or a successful set does. That way an accidental
  // reload/navigate re-offers next time instead of silently killing the feature
  // (the reason PIN quick-unlock "never showed up").
  setPinSetupLen(4);   // default to the simpler 4-digit PIN
  document.getElementById('pin-setup-error').textContent = '';
  setTimeout(() => document.getElementById('pin-setup-input')?.focus(), 120);
}

function closePinSetupModal() {
  const modal = document.getElementById('pin-setup-modal');
  if (modal) modal.classList.add('hidden');
}

// Explicit "Not now" — a deliberate skip, so we remember it and don't re-offer
// automatically (they can still add one anytime from the account menu).
function skipPinSetup() {
  const deviceId = document.getElementById('pin-setup-modal')?.dataset.deviceId;
  if (deviceId) localStorage.setItem('crm_pin_offered', deviceId);
  closePinSetupModal();
}

// Let the user set (or replace) a quick-unlock PIN whenever they want, from the
// account menu — so skipping the one-time offer isn't a dead end.
function openPinSetupFromMenu() {
  const deviceId = localStorage.getItem('crm_device_id') || '';
  if (!deviceId) { toast('Sign in with “remember this device” on first, then set a PIN.', 'warning'); return; }
  showPinSetupModal(deviceId);
}

// Hide the "Set PIN" shortcut once this device already has one.
function updateSecurityButtons() {
  const btn = document.getElementById('btn-set-pin');
  if (!btn) return;
  const hasPin  = localStorage.getItem('crm_device_has_pin') === 'true';
  const trusted = localStorage.getItem('crm_device_id');
  // Only offer on a remembered device that has no PIN yet, and never for guests.
  btn.classList.toggle('hidden', !!hasPin || !trusted || state.role === 'guest');
}

async function submitPinSetup() {
  const pin    = document.getElementById('pin-setup-input').value.trim();
  const pin2   = document.getElementById('pin-setup-input2').value.trim();
  const errEl  = document.getElementById('pin-setup-error');
  const deviceId = document.getElementById('pin-setup-modal').dataset.deviceId;
  errEl.textContent = '';
  if (!new RegExp(`^\\d{${pinSetupLen}}$`).test(pin)) { errEl.textContent = `Enter a ${pinSetupLen}-digit PIN`; return; }
  if (pin !== pin2)             { errEl.textContent = 'PINs do not match'; return; }
  try {
    await apiFetch('/api/auth/pin-setup', {
      method: 'POST',
      body: JSON.stringify({ pin, deviceId }),
    });
    localStorage.setItem('crm_device_has_pin', 'true');
    localStorage.setItem('crm_pin_len', String(pinSetupLen));   // so unlock shows the right # of boxes
    if (deviceId) localStorage.setItem('crm_pin_offered', deviceId);
    closePinSetupModal();
    updateSecurityButtons();
    toast('Quick-unlock PIN set! Use it next time you open the app.', 'success');
  } catch (err) {
    errEl.textContent = err.message || 'Failed to set PIN';
  }
}

// ── Set / Change Password modal ───────────────────────────────
// opts.migration = true  → blocking first-time setup (no current pw, no cancel)
// opts.migration = false → voluntary change (requires current pw, cancellable)
function showSetPasswordModal(opts = {}) {
  const modal = document.getElementById('set-password-modal');
  if (!modal) return;
  const migration = !!opts.migration;
  modal.dataset.migration    = migration ? '1' : '';
  modal.dataset.deviceId     = opts.deviceId || '';
  modal.dataset.deviceTrusted = opts.deviceTrusted ? '1' : '';
  modal.dataset.hasPin       = opts.hasPIN ? '1' : '';

  document.getElementById('set-pw-title').textContent = migration ? '🔑 Set Your Password' : '🔑 Change Password';
  document.getElementById('set-pw-intro').textContent = migration
    ? "For your security, create a password for your account. You'll use it to sign in from now on — your PIN stays as quick-unlock on trusted devices."
    : 'Enter your current password, then choose a new one.';
  document.getElementById('set-pw-current-wrap').style.display = migration ? 'none' : '';
  document.getElementById('set-pw-cancel').classList.toggle('hidden', migration);
  document.getElementById('set-pw-btn').textContent = migration ? 'Set Password' : 'Change Password';

  document.getElementById('set-pw-current').value = '';
  document.getElementById('set-pw-input').value   = '';
  document.getElementById('set-pw-input2').value  = '';
  document.getElementById('set-pw-error').textContent = '';
  modal.classList.remove('hidden');
  setTimeout(() => document.getElementById(migration ? 'set-pw-input' : 'set-pw-current')?.focus(), 100);
}

function closeSetPasswordModal() {
  const modal = document.getElementById('set-password-modal');
  // A blocking migration modal cannot be dismissed without setting a password.
  if (modal?.dataset.migration === '1') return;
  if (modal) modal.classList.add('hidden');
}

async function submitSetPassword() {
  const modal     = document.getElementById('set-password-modal');
  const migration = modal.dataset.migration === '1';
  const current   = document.getElementById('set-pw-current').value;
  const password  = document.getElementById('set-pw-input').value;
  const password2 = document.getElementById('set-pw-input2').value;
  const errEl     = document.getElementById('set-pw-error');
  const btn       = document.getElementById('set-pw-btn');
  errEl.textContent = '';
  if (!migration && !current) { errEl.textContent = 'Enter your current password'; return; }
  const pwErr = getPasswordError(password);
  if (pwErr)                  { errEl.textContent = pwErr; return; }
  if (password !== password2) { errEl.textContent = 'Passwords do not match'; return; }
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Saving…';
  try {
    const body = migration ? { password } : { password, currentPassword: current };
    await apiFetch('/api/auth/set-password', { method: 'POST', body: JSON.stringify(body) });
    modal.dataset.migration = '';        // unlock so it can close
    modal.classList.add('hidden');
    toast(migration ? 'Password set — use it to sign in next time.' : 'Password updated.', 'success');
    if (migration && modal.dataset.deviceTrusted === '1' && modal.dataset.hasPin !== '1') {
      setTimeout(() => showPinSetupModal(modal.dataset.deviceId), 400);
    }
  } catch (err) {
    errEl.textContent = err.message || 'Could not set password';
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function showRegisterScreen(e) {
  if (e) e.preventDefault();
  document.getElementById('login-screen').style.display    = 'none';
  document.getElementById('register-screen').style.display = '';
  document.getElementById('register-error').textContent    = '';
  const inviteEl = document.getElementById('reg-invite');
  if (inviteEl && !inviteEl.value) inviteEl.value = pendingRefCode() || pendingInviteCode();
  setTimeout(() => document.getElementById('reg-name')?.focus(), 60);
}

function showLoginScreen(e) {
  if (e) e.preventDefault();
  document.getElementById('register-screen').style.display = 'none';
  document.getElementById('login-screen').style.display    = '';
  document.getElementById('login-error').textContent       = '';
  setTimeout(() => document.getElementById('login-username')?.focus(), 60);
}

function getUsernameFormatError(v) {
  if (v.length < 3)               return 'Too short — minimum 3 characters';
  if (v.length > 20)              return 'Too long — maximum 20 characters';
  if (/[._]{2}/.test(v))         return 'No consecutive . or _ characters';
  if (/^[._]|[._]$/.test(v))    return 'Cannot start or end with . or _';
  if (!/[a-z]/.test(v))          return 'Must contain at least one letter';
  return null;
}

function onUsernameInput(input) {
  const pos = input.selectionStart;
  input.value = input.value.toLowerCase().replace(/[^a-z0-9._]/g, '');
  try { input.setSelectionRange(pos, pos); } catch {}

  const val      = input.value;
  const statusEl = document.getElementById('reg-username-status');
  const hintEl   = document.getElementById('reg-username-hint');

  if (!val) {
    statusEl.textContent = '';
    statusEl.className   = 'username-status';
    hintEl.textContent   = '3–20 chars · letters, numbers, _ and . only';
    hintEl.style.color   = '';
    return;
  }

  const fmt = getUsernameFormatError(val);
  if (fmt) {
    statusEl.textContent = '✗';
    statusEl.className   = 'username-status un-err';
    hintEl.textContent   = fmt;
    hintEl.style.color   = 'var(--danger, #e74c3c)';
  } else {
    statusEl.textContent = '✓';
    statusEl.className   = 'username-status un-ok';
    hintEl.textContent   = 'Looks good';
    hintEl.style.color   = '#27ae60';
  }
}

async function enterGuest() {
  try {
    const r = await fetch('/api/auth/guest', { method: 'POST' });
    const d = await r.json();
    if (!r.ok) throw new Error('Could not start demo');
    localStorage.setItem('crm_access',  d.accessToken);
    localStorage.setItem('crm_token',   d.accessToken);  // apiFetch reads crm_token
    localStorage.setItem('crm_user',    'Guest');
    localStorage.setItem('crm_role',    'guest');
    localStorage.removeItem('crm_refresh_token');
    localStorage.removeItem('crm_session_id');
    hideLoginPage();
    showDemoBanner();
    await initApp();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function showDemoBanner() {
  if (document.getElementById('demo-banner')) return;
  const b = document.createElement('div');
  b.id = 'demo-banner';
  b.innerHTML = `
    <span>You're in demo mode — data is not saved.</span>
    <a href="#" onclick="(function(){['crm_access','crm_token','crm_role','crm_user'].forEach(k=>localStorage.removeItem(k));location.reload();})()" style="color:#fff;font-weight:600;margin-left:10px;text-decoration:underline">Create Account →</a>
    <button onclick="this.parentElement.remove()" style="background:none;border:none;color:#fff;float:right;cursor:pointer;font-size:16px;line-height:1">✕</button>
  `;
  b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#e67e22;color:#fff;padding:10px 16px;font-size:13px;display:flex;align-items:center;gap:6px;';
  document.body.prepend(b);
}

// Password strength — mirrors validatePassword() in routes/auth.js + routes/users.js.
function getPasswordError(pw) {
  const s = String(pw || '');
  if (s.length < 8)   return 'Password must be at least 8 characters';
  if (s.length > 128) return 'Password is too long';
  if (!/[a-zA-Z]/.test(s) || !/\d/.test(s)) return 'Password must include a letter and a number';
  return null;
}

function onRegPasswordInput(input) {
  const hint = document.getElementById('reg-password-hint');
  if (!hint) return;
  if (!input.value) {
    hint.textContent = 'At least 8 characters, with a letter and a number';
    hint.style.color = '';
    return;
  }
  const err = getPasswordError(input.value);
  hint.textContent = err || 'Looks good';
  hint.style.color = err ? 'var(--danger, #e74c3c)' : '#27ae60';
}

async function handleRegister(e) {
  e.preventDefault();
  const name  = document.getElementById('reg-name').value.toLowerCase().trim();
  const password  = document.getElementById('reg-password').value;
  const password2 = document.getElementById('reg-password2').value;
  const errEl = document.getElementById('register-error');
  const btn   = document.getElementById('register-btn');
  errEl.textContent = '';
  const fmtErr = getUsernameFormatError(name);
  if (fmtErr)                    { errEl.textContent = fmtErr; return; }
  const pwErr = getPasswordError(password);
  if (pwErr)                     { errEl.textContent = pwErr; return; }
  if (password !== password2)    { errEl.textContent = 'Passwords do not match'; return; }
  btn.disabled    = true;
  btn.textContent = 'Creating…';
  try {
    const mobile     = (document.getElementById('reg-mobile')?.value || '').trim();
    const inviteCode = (document.getElementById('reg-invite')?.value || '').trim();
    // Computed once and reused for both calls below — the referral engine uses
    // it (server-side) to skip referrer credit when a signup is from the
    // referrer's own device.
    const fingerprint = getDeviceFingerprint();
    const regRes  = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, password, mobile, inviteCode, fingerprint }),
    });
    const regData = await regRes.json();
    if (!regRes.ok) {
      if (regRes.status === 409) {
        errEl.innerHTML = 'Name already taken. <a href="#" id="reg-login-link" style="color:var(--primary)">Log in instead →</a>';
        document.getElementById('reg-login-link').onclick = function(ev) {
          ev.preventDefault();
          document.getElementById('login-username').value = name;
          showLoginScreen();
        };
        return;
      }
      throw new Error(regData.error || 'Registration failed');
    }

    // Auto-login directly after registration
    const deviceMeta  = getDeviceMeta();
    const loginRes  = await fetch('/api/auth/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ credential: name, password, fingerprint, trustDevice: true, deviceMeta }),
    });
    const loginData = await loginRes.json();
    if (!loginRes.ok) throw new Error(loginData.error || 'Login failed after registration');
    toast('Welcome ' + name + '! Account created.', 'success');
    // Flag captured now (before the await below) so it survives the
    // offerDeviceSetup → initApp chain; the referral toast fires right after
    // that whole chain resolves, once the app has actually loaded.
    const referralApplied = !!regData.referralApplied;
    await offerDeviceSetup(loginData);
    if (referralApplied) {
      localStorage.removeItem('crm_pending_ref');   // crm_pending_join is left alone — the team-join pipeline still needs it
      toast('🎁 2 months of Dive Pro unlocked — welcome!', 'success');
    }
  } catch (err) {
    errEl.textContent = (err instanceof TypeError && err.message.toLowerCase().includes('fetch'))
      ? 'Server is starting up, please try again in 30 seconds.'
      : err.message;
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Create Account';
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const credential   = document.getElementById('login-username').value.trim();
  const password     = document.getElementById('login-password').value.trim();
  const trustDevice  = document.getElementById('remember-device')?.checked ?? true;
  const errEl        = document.getElementById('login-error');
  const btn          = document.getElementById('login-btn');
  errEl.textContent  = '';
  btn.disabled       = true;
  btn.classList.add('btn-loading');
  btn.textContent    = 'Signing in…';

  try {
    const fingerprint = getDeviceFingerprint();
    const deviceMeta  = getDeviceMeta();
    const res = await fetch('/api/auth/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ credential, password, fingerprint, trustDevice, deviceMeta }),
    });
    const data = await res.json();
    if (!res.ok) {
      errEl.textContent = data.error || 'Login failed';
      shakeError(errEl);
      document.getElementById('login-password')?.select();
      return;
    }
    localStorage.setItem('crm_last_user', credential);
    await offerDeviceSetup(data);
  } catch (err) {
    errEl.textContent = (err instanceof TypeError && err.message.toLowerCase().includes('fetch'))
      ? 'Server is starting up, please try again in 30 seconds.'
      : err.message;
    shakeError(errEl);
  } finally {
    btn.disabled    = false;
    btn.classList.remove('btn-loading');
    btn.textContent = 'Sign In';
  }
}

// ============================================================
//  API
// ============================================================
async function apiFetch(path, opts = {}) {
  // Proactively refresh if access token is about to expire
  if (tokenIsExpired()) await tryRefreshToken();

  const makeRequest = () => {
    const token   = localStorage.getItem('crm_token');
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch(path, { ...opts, headers });
  };

  let res = await makeRequest();

  // If 401, attempt one refresh then retry
  if (res.status === 401) {
    const refreshed = await tryRefreshToken();
    if (refreshed) {
      res = await makeRequest();
    } else {
      stopBackgroundTimers();   // stop the 401 storm from heartbeat/auto-refresh
      clearTokens();
      localStorage.removeItem('crm_role');
      localStorage.removeItem('crm_user');
      state.role = null;
      showLoginPage();
      const errEl = document.getElementById('login-error');
      if (errEl) errEl.textContent = 'Your session expired — please sign in again.';
      throw new Error('Session expired. Please log in again.');
    }
  }

  if (res.status === 403) {
    const body = await res.json().catch(() => ({}));
    if (body.error === 'demo_only') {
      toast('Create an account to save changes', 'warning');
      throw new Error('demo_only');
    }
    throw new Error(body.error || 'Access denied');
  }
  if (!res.ok) {
    // Surface the server's own error message (e.g. the Google-Sheets import's
    // "set sharing to Anyone with the link can view") instead of a cryptic
    // "POST /api/… → 400". Fall back to the status line if there's no body.
    let msg = '';
    try { const body = await res.json(); msg = body && body.error; } catch (_) {}
    throw new Error(msg || `${opts.method || 'GET'} ${path} → ${res.status}`);
  }
  return res.json();
}

function orgQuery() { return state.activeOrgId ? `?teamId=${encodeURIComponent(state.activeOrgId)}` : ''; }

async function loadLeads()  {
  const [leads] = await Promise.all([ apiFetch('/api/leads' + orgQuery()), loadLists(), loadProducts() ]);
  state.leads = leads;
  state.stats = computeStats(leads);
}
async function loadLists() {
  try { state.myLists = await apiFetch('/api/lead-lists' + orgQuery()); }
  catch { state.myLists = []; }
  return state.myLists;
}
async function loadProducts() {
  try { state.myProducts = await apiFetch('/api/products' + orgQuery()); }
  catch { state.myProducts = []; }
  _prodDivMapCache = null;   // catalog changed → rebuild the division map lazily
  return state.myProducts;
}

// Product name → division, built from the team's catalog (case-insensitive).
// Memoized: filteredLeads() calls this per lead when filtering by division, so
// rebuilding it every time was O(leads × catalog). Invalidated in loadProducts.
let _prodDivMapCache = null;
function productDivisionMap() {
  if (_prodDivMapCache) return _prodDivMapCache;
  const m = {};
  for (const p of (state.myProducts || [])) {
    if (p.name) m[p.name.toLowerCase()] = p.division || '';
  }
  return (_prodDivMapCache = m);
}
// Distinct divisions defined in the catalog, sorted.
function catalogDivisions() {
  return [...new Set((state.myProducts || []).map(p => p.division).filter(Boolean))].sort();
}
// Every product name a lead touches (all its items + the primary field).
function leadProductNames(l) {
  const names = (l.items || []).map(i => i.product).filter(Boolean);
  if (l.product) names.push(l.product);
  return [...new Set(names)];
}
// Readable "product · qty @₹rate" lines for every item on a lead (raw text —
// escape at the call site). Falls back to the primary product/qty/rate.
function leadItemLines(l) {
  const items = (l.items && l.items.length)
    ? l.items
    : (l.product ? [{ product: l.product, quantity: l.quantity, rate: l.rate }] : []);
  return items.filter(i => i.product).map(i =>
    `${i.product}${i.quantity ? ' · ' + i.quantity : ''}${i.rate ? ' @₹' + i.rate : ''}`);
}
async function loadStats()  { state.stats = computeStats(state.leads); }
// ── Where new leads are stored ────────────────────────────────
// Independent of which workspace you're VIEWING: a remembered per-user
// default so all new leads pool into your team by default (admins included),
// without changing what anyone can see. '' = Personal (no team).
function getLeadDest() {
  const saved = localStorage.getItem('crm_lead_dest');
  if (saved !== null) return saved;                 // explicit choice (may be '')
  return state.myTeams && state.myTeams.length ? String(state.myTeams[0].id) : '';
}
function setLeadDest(v) { localStorage.setItem('crm_lead_dest', v == null ? '' : String(v)); }

function onLeadDestChange(v) {
  setLeadDest(v);
  const wrap = document.querySelector('.dest-3d-wrap');
  if (wrap) { wrap.classList.remove('dest-pop'); void wrap.offsetWidth; wrap.classList.add('dest-pop'); }
}

// Populate the "Save to" selector in the Add-Lead form. Only meaningful when
// the user belongs to at least one team.
function renderLeadDestSelect() {
  const section = document.getElementById('modal-dest-section');
  const sel     = document.getElementById('f-dest');
  if (!section || !sel) return;
  const teams = state.myTeams || [];
  if (!teams.length) { section.style.display = 'none'; return; }
  section.style.display = '';
  const cur = getLeadDest();
  sel.innerHTML = `<option value="">👤 Personal (only me)</option>` +
    teams.map(t => `<option value="${t.id}" ${String(t.id) === String(cur) ? 'selected' : ''}>${(BUSINESS_TYPES[t.business_type] || BUSINESS_TYPES.factory).icon} ${escHtml(t.name)}</option>`).join('');
}

// Session "active list": the list the user picks on app open (see
// promptActiveList). Every lead added this session is also filed into it, until
// they change it or reload. Kept in sessionStorage so it resets each session.
function getActiveList() { return sessionStorage.getItem('crm_active_list') || ''; }
function setActiveList(v) {
  if (v) sessionStorage.setItem('crm_active_list', String(v));
  else   sessionStorage.removeItem('crm_active_list');
}
function activeListName() {
  const id = getActiveList();
  const l  = (state.myLists || []).find(x => String(x.id) === String(id));
  return l ? l.name : '';
}

async function createLead(data) {
  // An explicit team_id (from the form's "Save to" selector) wins; otherwise
  // fall back to the remembered default destination.
  if (data.team_id == null) {
    const dest = getLeadDest();
    data.team_id = dest ? parseInt(dest, 10) : null;
  }
  const result = await apiFetch('/api/leads', { method: 'POST', body: JSON.stringify(data) });
  // File the new lead into the session's active list, if one is set.
  const listId = getActiveList();
  if (listId && result && result.rowIndex != null && !result.conflict) {
    try {
      await apiFetch(`/api/lead-lists/${listId}/add-leads` + orgQuery(),
        { method: 'POST', body: JSON.stringify({ lead_ids: [result.rowIndex] }) });
    } catch (_) { /* non-fatal — the lead is saved regardless */ }
  }
  return result;
}
async function updateLead(row, data) { return apiFetch(`/api/leads/${row}`, { method: 'PUT', body: JSON.stringify(data) }); }
async function deleteLead(row) { return apiFetch(`/api/leads/${row}`, { method: 'DELETE' }); }

// One-time-per-session prompt on app open: which list do today's new leads go
// into? Only shown when the user actually has lists to choose from.
function maybePromptActiveList() {
  if (state.role === 'guest') return;
  if (sessionStorage.getItem('crm_active_list_prompted')) return;
  if (!(state.myLists || []).length) return;   // nothing to choose — skip silently
  sessionStorage.setItem('crm_active_list_prompted', '1');
  openActiveListModal();
}
function openActiveListModal() {
  document.getElementById('active-list-modal')?.remove();
  const cur = getActiveList();
  const opts = (state.myLists || []).map(l =>
    `<button class="al-opt ${String(l.id) === String(cur) ? 'active' : ''}" onclick="chooseActiveList('${escAttr(String(l.id))}')">
       <span class="al-dot" style="background:${listColor(l.name)}"></span>${escHtml(l.name)}</button>`).join('');
  const html = `
  <div class="up-overlay" id="active-list-modal" onclick="if(event.target===this)closeActiveListModal()">
    <div class="up-box al-box" role="dialog" aria-modal="true" aria-label="Choose a list for new leads">
      <button class="up-close" onclick="closeActiveListModal()" aria-label="Close">✕</button>
      <div class="up-head"><div class="up-kicker">This session</div><h2 class="up-title">📋 Which list are you adding to?</h2>
      <p class="up-sub">Every lead you add now gets filed into this list. You can change it anytime from Lists.</p></div>
      <div class="al-opts">
        <button class="al-opt ${!cur ? 'active' : ''}" onclick="chooseActiveList('')"><span class="al-dot" style="background:var(--text-muted)"></span>No list — just save</button>
        ${opts}
      </div>
    </div>
  </div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstElementChild);
}
function closeActiveListModal() { document.getElementById('active-list-modal')?.remove(); }
function chooseActiveList(id) {
  setActiveList(id);
  closeActiveListModal();
  const nm = activeListName();
  toast(id && nm ? `New leads → “${nm}” list` : 'New leads won’t be filed into a list');
}

// ============================================================
//  Auto-refresh
// ============================================================
let autoRefreshTimer = null;
let lastRefreshed    = null;
let refreshLabelTimer = null;
let _leadsSearchDebounce = null;   // debounce timers for the search inputs
let _dbSearchDebounce    = null;

function startAutoRefresh() {
  // Only re-render pages that are actually built from the working leads/stats we
  // reload here. Pages that self-fetch (database) or are static/heavy (map, team,
  // workspace, chat, ai-debug) must NOT be re-rendered on the timer — doing so
  // flashes a loading state and wipes scroll/selection ("the table jumps").
  const LIVE_PAGES = ['today', 'dashboard', 'leads', 'pipeline', 'followups', 'reports'];
  clearInterval(autoRefreshTimer);    // never stack timers if initApp runs twice
  clearInterval(refreshLabelTimer);
  autoRefreshTimer = setInterval(async () => {
    try {
      // Always resync team membership first (cheap single query). This is what
      // carries an admin's Team Settings business-type/custom-term edit out to
      // other members, and also catches a join-request approval that landed
      // while the user was away. loadMyTeams() is blip-safe: on a transient
      // fetch failure it returns early leaving state.myTeams (and
      // state.activeOrgId) untouched, so a network hiccup can't silently yank
      // the user back to Personal.
      const wasTeamless  = state.role !== 'guest' && !(state.myTeams || []).length;
      const activeBefore = (state.myTeams || []).find(t => String(t.id) === String(state.activeOrgId));
      const profileBefore = JSON.stringify(activeBefore
        ? [activeBefore.business_type, activeBefore.business_custom]
        : [state.me && state.me.business_type, state.me && state.me.business_custom]);

      await loadMyTeams();

      // Team-less → now in a team: unchanged from before, just no longer
      // gated behind the fetch itself (which now always runs).
      let switcherDirty = false;
      if (wasTeamless && state.myTeams.length) {
        switcherDirty = true;
        toast(`You've been added to ${state.myTeams[0].name}! 🎉`, 'success');
      }

      // Did the active workspace's business profile change under us (e.g. an
      // admin edited Team Settings)? Compare against the pre-fetch snapshot.
      const activeAfter = (state.myTeams || []).find(t => String(t.id) === String(state.activeOrgId));
      const profileAfter = JSON.stringify(activeAfter
        ? [activeAfter.business_type, activeAfter.business_custom]
        : [state.me && state.me.business_type, state.me && state.me.business_custom]);
      const profileChanged = profileAfter !== profileBefore;
      if (profileChanged) switcherDirty = true;
      if (switcherDirty) renderOrgSwitcher();

      await loadLeads();
      lastRefreshed = new Date();
      // Don't re-render out from under the user mid-interaction: skip while a
      // modal / lead-detail / stage-picker is open or the search box is focused.
      const busy = document.querySelector(
        '#modal-overlay:not(.hidden), #lead-detail-overlay, #stage-picker-overlay, #products-modal-overlay:not(.hidden)')
        || document.activeElement === document.getElementById('global-search');
      // A business-profile change must repaint the CURRENT page even when it's
      // not one of the LIVE_PAGES (Team/Workspace/Chat show these terms too) —
      // but still never rip the UI out from under an open modal; if busy, this
      // tick just skips the render and the next non-busy tick catches it.
      if (!busy && (LIVE_PAGES.includes(state.page) || profileChanged)) renderPage(state.page);
    } catch (_) {}
  }, 60000);

  refreshLabelTimer = setInterval(updateRefreshLabel, 5000);
}

function updateRefreshLabel() {
  const el = document.getElementById('last-refreshed');
  if (!el || !lastRefreshed) return;
  const secs = Math.floor((Date.now() - lastRefreshed.getTime()) / 1000);
  el.textContent = secs < 10 ? 'Updated just now' : `Updated ${secs}s ago`;
}

// ============================================================
//  CSV Export
// ============================================================
function exportCSV() {
  const cols = ['factory_number','factory_name','person_in_charge','contact','product',
                 'quantity','rate','stage','follow_up','area','notes','last_updated'];
  // Header row speaks the active business's language for the term-mapped
  // columns (so the file reads naturally AND re-imports auto-map via the
  // business-term aliases). Factory stays byte-identical to the historic
  // raw-key header. Stage VALUES stay canonical either way — machine-readable,
  // and normImportStage round-trips them.
  const TERM_COLS = { factory_number: 'code', factory_name: 'name', person_in_charge: 'person',
                      product: 'product', area: 'area' };
  const headerCell = c => (biz().key === 'factory' || !TERM_COLS[c])
    ? c
    : `"${String(T(TERM_COLS[c])).replace(/"/g, '""')}"`;
  const header = [...cols.map(headerCell), 'extra_contacts'].join(',');
  const rows   = state.leads.map(l => {
    const base  = cols.map(c => `"${String(l[c] || '').replace(/"/g, '""')}"`).join(',');
    const extra = (l.contacts || []).slice(1).map(c => `${c.person_name}:${c.contact}`).join(' | ');
    return base + `,"${extra.replace(/"/g, '""')}"`;
  });
  const csv  = [header, ...rows].join('\n');
  const link = document.createElement('a');
  link.href     = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
  link.download = 'leads_' + new Date().toISOString().slice(0, 10) + '.csv';
  link.click();
}

// ============================================================
//  Date conversion helpers (sheet uses dd/MM/yyyy, input uses yyyy-MM-dd)
// ============================================================
// ============================================================
//  IMPORT — Excel / CSV / Google Sheets
// ============================================================
const IMPORT_FIELDS = [
  ['',                 '— skip —'],
  ['factory_number',   'Factory #'],
  ['factory_name',     'Factory / Party Name'],
  ['person_in_charge', 'Contact Person'],
  ['contact',          'Phone / Mobile'],
  ['product',          'Product'],
  ['quantity',         'Quantity'],
  ['rate',             'Rate'],
  ['stage',            'Stage / Status'],
  ['follow_up',        'Follow-up Date'],
  ['area',             'Area / City'],
  ['notes',            'Notes / Remarks'],
  ['lead_type',        'Lead Type (Hot/Warm/Cold)'],
  ['created_by',       'Salesman (admin only)'],
];

// Display label for an IMPORT_FIELDS key, business-term aware. IMPORT_FIELDS
// itself stays a plain module-level const (canonical keys + default labels,
// used for column order and as the alias/lookup source) because it's
// evaluated once at script load — before the active business profile is
// known. Routing the handful of business-term fields through T() here (at
// render time, inside renderImportMap()) keeps that fast/simple while still
// reflecting the active business type in the mapping UI.
function importFieldLabel(key) {
  const overrides = { factory_number: T('code'), factory_name: T('name'), person_in_charge: T('person') };
  if (overrides[key]) return overrides[key];
  const entry = IMPORT_FIELDS.find(([k]) => k === key);
  return entry ? entry[1] : key;
}

const IMPORT_ALIASES = {
  factory_number:   ['factorynumber','factoryno','factno','fnumber','fno','code','partycode','leadno','leadid'],
  factory_name:     ['factoryname','factory','partyname','party','company','companyname','business','businessname','firm','firmname','customer','customername','name','account'],
  person_in_charge: ['personincharge','person','contactperson','incharge','proprietor','propreitor','concernedperson','ownername'],
  contact:          ['contact','phone','mobile','phonenumber','mobilenumber','contactnumber','phoneno','mobileno','contactno','whatsapp','whatsappno'],
  product:          ['product','products','item','items','material'],
  quantity:         ['quantity','qty','volume'],
  rate:             ['rate','price','rateperkg','priceperkg','rates'],
  stage:            ['stage','status','leadstage','dealstage'],
  follow_up:        ['followup','followupdate','nextfollowup','nextvisit','visitdate','followupon','date'],
  area:             ['area','city','location','region','district','zone'],
  notes:            ['notes','note','remarks','remark','comments','comment','description'],
  lead_type:        ['leadtype','type','temperature','temp','priority'],
  created_by:       ['salesman','salesperson','salesrep','agent','addedby','createdby','executive','salesexecutive'],
};

// Extend IMPORT_ALIASES with every business type's own term labels (plus the
// entity words) so headers like 'Shop Name' / 'Owner' / 'Locality' auto-map
// instantly, no AI pass needed. Uses the same normalizer as importLoaded().
// EXISTING aliases always win: any candidate a field already claims is
// skipped, so the historic factory mapping never shifts (e.g. 'Factory #'
// normalizes to 'factory', which must stay a factory_name alias — not become
// a factory_number one). Static registry only — safe at module load.
(() => {
  const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const owned = new Set(Object.values(IMPORT_ALIASES).flat());
  const push = (field, cand) => {
    const n = norm(cand);
    if (!n || owned.has(n)) return;
    owned.add(n);
    IMPORT_ALIASES[field].push(n);
  };
  for (const t of Object.values(BUSINESS_TYPES)) {
    push('factory_number',   t.terms.code);
    push('factory_name',     t.terms.name);
    push('person_in_charge', t.terms.person);
    push('product',          t.terms.product);
    push('area',             t.terms.area);
    // Entity words double as name-column headers — 'Shop', 'Shop Name', and
    // each part of a split entity ('Doctor / Chemist' → doctor(name), chemist(name)).
    for (const p of [t.entity, ...String(t.entity).split('/')]) {
      push('factory_name', p);
      push('factory_name', String(p) + ' name');
    }
  }
})();

let _import = null; // { name, headers, rows, mapping[] }
let _importDefaultBucket = 'working';  // preselected import destination

function openImportModal(defaultBucket) {
  if (state.role === 'guest') { toast('Create an account to import data', 'warning'); return; }
  _import = null;
  _importDefaultBucket = defaultBucket === 'database' ? 'database' : 'working';
  document.getElementById('import-step-source').classList.remove('hidden');
  document.getElementById('import-step-map').classList.add('hidden');
  document.getElementById('import-step-done').classList.add('hidden');
  document.getElementById('import-source-error').textContent = '';
  document.getElementById('import-gsheet-url').value = '';
  document.getElementById('import-file-input').value = '';
  document.getElementById('import-modal-overlay').classList.remove('hidden');
}
function openImportToDatabase() { openImportModal('database'); }

function closeImportModal(refreshAfter) {
  document.getElementById('import-modal-overlay').classList.add('hidden');
  _import = null;
  if (refreshAfter) refresh();
}

function importReset() { openImportModal(); }

function importFileSelected(input) {
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      await ensureXLSX();   // lazy-load the spreadsheet parser on first import
      const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: false });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
      importLoaded(file.name, aoa);
    } catch (err) {
      document.getElementById('import-source-error').textContent = 'Could not read the file: ' + err.message;
    }
  };
  reader.readAsArrayBuffer(file);
}

async function importFromGoogleSheet() {
  const url = document.getElementById('import-gsheet-url').value.trim();
  const errEl = document.getElementById('import-source-error');
  const btn = document.getElementById('import-gsheet-btn');
  errEl.textContent = '';
  if (!url) { errEl.textContent = 'Paste the Google Sheets link first'; return; }
  btn.disabled = true; btn.textContent = 'Fetching…';
  try {
    const { csv } = await apiFetch('/api/import/sheet', { method: 'POST', body: JSON.stringify({ url }) });
    await ensureXLSX();   // lazy-load the spreadsheet parser on first import
    const wb = XLSX.read(csv, { type: 'string' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
    importLoaded('Google Sheet', aoa);
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Fetch Sheet';
  }
}

function importLoaded(name, aoa) {
  // First non-empty row = headers
  const rows = (aoa || []).filter(r => (r || []).some(c => String(c).trim() !== ''));
  if (rows.length < 2) {
    document.getElementById('import-source-error').textContent = 'The file needs a header row and at least one data row.';
    return;
  }
  const headers = rows[0].map(h => String(h || '').trim());
  const dataRows = rows.slice(1);

  // Auto-map headers → CRM fields
  const used = new Set();
  const mapping = headers.map(h => {
    const norm = h.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!norm) return '';
    for (const [field, aliases] of Object.entries(IMPORT_ALIASES)) {
      if (used.has(field)) continue;
      if (aliases.includes(norm)) { used.add(field); return field; }
    }
    return '';
  });

  _import = { name, headers, rows: dataRows, mapping };
  renderImportMap();
  document.getElementById('import-step-source').classList.add('hidden');
  document.getElementById('import-step-map').classList.remove('hidden');
  const destSel = document.getElementById('import-dest-select');
  if (destSel) destSel.value = _importDefaultBucket;
  loadImportAssignees();
  populateImportListSelect();
  aiRefineImportMapping();   // AI refines the column→field mapping in the background
}

// Ask the AI to map the spreadsheet's columns to CRM fields, then merge its
// picks over the alias auto-map (AI first, alias map fills any gaps). Runs
// right after load; also re-runnable by clicking the badge.
async function aiRefineImportMapping() {
  if (!_import) return;
  const target = _import;
  const badge = document.getElementById('import-ai-badge');
  const { headers, rows } = _import;
  if (badge) { badge.style.display = ''; badge.className = 'import-ai-badge loading'; badge.textContent = '✨ AI is reading your columns…'; }
  try {
    const body = { headers, rows: rows.slice(0, 8) };
    if (getLeadDest()) body.teamId = getLeadDest();
    const res = await apiFetch('/api/import/ai-map', { method: 'POST', body: JSON.stringify(body) });
    if (_import !== target || !Array.isArray(res.mapping) || res.mapping.length !== headers.length) {
      if (badge) badge.style.display = 'none';
      return;
    }
    const used = new Set();
    const merged = headers.map(() => '');
    headers.forEach((_, i) => {                       // 1) take the AI's picks
      const ai = String(res.mapping[i] || '');
      if (ai && !used.has(ai)) { merged[i] = ai; used.add(ai); }
    });
    headers.forEach((_, i) => {                        // 2) fill blanks from the alias map
      if (merged[i]) return;
      const prev = String(_import.mapping[i] || '');
      if (prev && !used.has(prev)) { merged[i] = prev; used.add(prev); }
    });
    _import.mapping  = merged;
    _import.aiMapped = true;
    renderImportMap();
    if (badge) { badge.className = 'import-ai-badge done'; badge.textContent = '✨ AI mapped your columns — review & tweak below'; }
  } catch (err) {
    if (badge) { badge.className = 'import-ai-badge'; badge.textContent = '↻ Map with AI'; badge.style.display = ''; }
  }
}

async function populateImportListSelect() {
  const row = document.getElementById('import-list-row');
  const sel = document.getElementById('import-list-select');
  if (!row || !sel) return;
  await loadLists();
  const lists = state.myLists || [];
  // Always available now — even with no lists yet, you can create one on import.
  row.style.display = '';
  sel.innerHTML = '<option value="">— None —</option>' +
    lists.map(l => `<option value="${l.id}">${escHtml(l.name)}</option>`).join('') +
    '<option value="__new__">＋ New list…</option>';
  const inp = document.getElementById('import-new-list-name');
  if (inp) { inp.style.display = 'none'; inp.value = ''; }
}

// Reveal the "new list name" box when "＋ New list…" is chosen.
function onImportListChange(v) {
  const inp = document.getElementById('import-new-list-name');
  if (!inp) return;
  const isNew = v === '__new__';
  inp.style.display = isNew ? '' : 'none';
  if (isNew) setTimeout(() => inp.focus(), 0);
}

async function loadImportAssignees() {
  const sel = document.getElementById('import-assign-select');
  const me = localStorage.getItem('crm_user') || '';
  if (state.role === 'admin') {
    let names = [me];
    try { names = (await apiFetch('/api/users')).map(u => u.display_name); } catch (_) {}
    sel.innerHTML = names.map(n => `<option ${n === me ? 'selected' : ''}>${escHtml(n)}</option>`).join('');
    sel.disabled = false;
  } else {
    sel.innerHTML = `<option>${escHtml(me)}</option>`;
    sel.disabled = true;
    document.querySelector('.import-assign-hint').textContent = 'Imported leads are added under your name';
  }
}

function renderImportMap() {
  const { name, headers, rows, mapping } = _import;
  document.getElementById('import-file-label').textContent = `${name} · ${rows.length} row${rows.length !== 1 ? 's' : ''}`;
  document.getElementById('import-count-label').textContent = `${rows.length} rows`;

  const fieldOptions = IMPORT_FIELDS
    .filter(([v]) => v !== 'created_by' || state.role === 'admin')
    .map(([v]) => `<option value="${v}">${escHtml(importFieldLabel(v))}</option>`).join('');

  document.getElementById('import-map-head').innerHTML = `
    <tr>${headers.map((h, i) => `
      <th>
        <div class="import-col-name" title="${escAttr(h)}">${escHtml(h || '(col ' + (i + 1) + ')')}</div>
        <select class="import-map-select" onchange="importMapChanged(${i}, this.value)">${fieldOptions}</select>
      </th>`).join('')}
    </tr>`;
  // set current mapping values
  document.querySelectorAll('.import-map-select').forEach((sel, i) => { sel.value = mapping[i] || ''; });

  document.getElementById('import-map-preview').innerHTML = rows.slice(0, 5).map(r => `
    <tr>${headers.map((_, i) => `<td class="${mapping[i] ? '' : 'import-col-skipped'}">${escHtml(String(r[i] ?? '').slice(0, 40)) || '—'}</td>`).join('')}</tr>
  `).join('');
}

function importMapChanged(idx, val) {
  // one CRM field per column
  if (val) _import.mapping = _import.mapping.map((m, i) => (i !== idx && m === val) ? '' : m);
  _import.mapping[idx] = val;
  renderImportMap();
}

function normImportDate(v) {
  const s = String(v || '').trim();
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);                      // ISO yyyy-mm-dd
  if (m) return `${m[3].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[1]}`;
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);           // d/m/y (Indian convention)
  if (m) {
    const y = m[3].length === 2 ? '20' + m[3] : m[3];
    return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${y}`;
  }
  return s;
}

function normImportLeadType(v) {
  const s = String(v || '').toLowerCase();
  if (s.includes('hot'))  return 'Hot';
  if (s.includes('warm')) return 'Warm';
  if (s.includes('cold')) return 'Cold';
  return '';
}

// Reverse map of every display relabel across ALL business types (lowercased
// label → canonical stage), so a hand-typed import value like 'New Shop' or
// 'Samples Given' stores the canonical stage instead of silently dropping out
// of Kanban/Reports. Safe to build once at load: it reads only the static
// registry (labels verified unambiguous across types), never the active
// profile. Canonical names always win first in normImportStage below.
const STAGE_LABEL_TO_CANONICAL = (() => {
  const map = {};
  for (const t of Object.values(BUSINESS_TYPES)) {
    for (const [canon, label] of Object.entries(t.stages || {})) map[String(label).toLowerCase()] = canon;
  }
  return map;
})();

function normImportStage(v) {
  const s = String(v || '').trim();
  if (!s) return { stage: '', stage_number: '' };
  const canonical = Object.keys(STAGE_NUMBERS).find(k => k.toLowerCase() === s.toLowerCase());
  if (canonical) return { stage: canonical, stage_number: STAGE_NUMBERS[canonical] };
  // Not canonical — try display labels: the ACTIVE profile first (evaluated at
  // call time, so custom-type stage renames are honoured), then the static
  // all-types reverse map.
  const low = s.toLowerCase();
  const activeStages = biz().stages || {};
  const fromActive = Object.keys(activeStages).find(k => String(activeStages[k]).toLowerCase() === low);
  const mapped = fromActive || STAGE_LABEL_TO_CANONICAL[low];
  if (mapped && STAGE_NUMBERS[mapped] !== undefined) return { stage: mapped, stage_number: STAGE_NUMBERS[mapped] };
  return { stage: s, stage_number: '' };
}

// Snap a raw product string from an import onto one of our canonical products
// (PRODUCT_OPTIONS), so filtering/organising works instead of every spelling
// variant becoming its own "product type". Handles spacing, case, common short
// codes and misspellings. Returns '' when nothing recognisable — the caller then
// keeps a tidied version of the original so no data is silently lost.
const PRODUCT_ALIASES = {
  'Hotmelt':         ['hotmelt','hm','hotmeltadhesive','hotmeltglue','hotmeltgum','hotmelts','hmadhesive'],
  'Rubber Adhesive': ['rubber','rubberadhesive','rubberbase','rubberbased','rb','sbr','rubbergum','rubbersolution','rubbercement','rubberadh'],
  'Solvent':         ['solvent','solventadhesive','solventbase','solventbased','sol','solventglue','solvant'],
  'Latex':           ['latex','latexadhesive','ltx','latexgum','latexadh'],
  'BC':              ['bc','bondingcompound','bondingcoat'],
  'Toluene':         ['toluene','toluol','tol','tolune','tuolene','tolueen','tolwene','tulene'],
  'R6':              ['r6'],
  'MEK':             ['mek','methylethylketone','methylethylketon'],
  'PU Adhesive':     ['pu','puadhesive','polyurethane','puadh','puglue','pubase','puadhesives'],
  'Silicon':         ['silicon','silicone','siliconadhesive','siliconesealant','siliconsealant','siliconeadhesive'],
};

function tidyProductText(raw) {
  // Collapse whitespace so "hot  melt " and "Hot Melt" don't count as two types.
  return String(raw || '').trim().replace(/\s+/g, ' ');
}

// Proper-Case a name/area from messy imported/AI data. Only rewrites values that
// are ALL-CAPS or all-lowercase — anything already mixed-case is left as typed
// (so a deliberate ALL-CAPS a user enters by hand is respected elsewhere).
function toProperCase(v) {
  const str = String(v || '').trim().replace(/\s+/g, ' ');
  if (!str) return '';
  const isAllCaps  = str === str.toUpperCase() && /[A-Z]/.test(str);
  const isAllLower = str === str.toLowerCase() && /[a-z]/.test(str);
  if (!isAllCaps && !isAllLower) return str;
  return str.toLowerCase().replace(/(^|[\s\-/&(.])([a-z])/g, (m, p, c) => p + c.toUpperCase());
}

// Try to recognise a raw product string against the team's own catalog first
// (name + the comma-separated aliases the user added). Their catalog wins over
// the built-in defaults so "add major items for it to read" actually steers it.
function catalogProductMatch(raw) {
  const catalog = state.myProducts || [];
  if (!catalog.length) return '';
  const key    = raw.toLowerCase().replace(/[^a-z0-9]/g, '');
  const tokens = raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const formsOf = p => [p.name, ...String(p.aliases || '').split(',')].map(s => s.trim()).filter(Boolean);
  // exact / token match
  for (const p of catalog) {
    for (const f of formsOf(p)) {
      const fk = f.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (fk && fk === key) return p.name;
      if (tokens.includes(f.toLowerCase())) return p.name;
    }
  }
  // longer forms embedded in a description
  for (const p of catalog) {
    const fks = formsOf(p).map(f => f.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean);
    if (fks.some(fk => fk.length >= 4 && key.includes(fk))) return p.name;
  }
  return '';
}

function normImportProduct(v) {
  const raw = tidyProductText(v);
  if (!raw) return '';
  const fromCatalog = catalogProductMatch(raw);
  if (fromCatalog) return fromCatalog;
  const key = raw.toLowerCase().replace(/[^a-z0-9]/g, '');

  // 1) whole-string exact match on a canonical name or one of its aliases
  for (const [canon, aliases] of Object.entries(PRODUCT_ALIASES)) {
    if (canon.toLowerCase().replace(/[^a-z0-9]/g, '') === key) return canon;
    if (aliases.includes(key)) return canon;
  }
  // 2) token match — short codes (pu, bc, r6, mek…) only when they stand alone,
  //    so "adhesive" (contains "si") can't be mistaken for Silicon.
  const tokens = raw.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const [canon, aliases] of Object.entries(PRODUCT_ALIASES)) {
    const set = new Set([canon.toLowerCase().replace(/[^a-z0-9]/g, ''), ...aliases]);
    if (tokens.some(t => set.has(t))) return canon;
  }
  // 3) longer aliases embedded in a description ("hot melt adhesive – white").
  //    Guard with length ≥ 5 to avoid short-code false positives.
  for (const [canon, aliases] of Object.entries(PRODUCT_ALIASES)) {
    if (aliases.some(a => a.length >= 5 && key.includes(a))) return canon;
  }
  return '';
}

// A single import cell can list several products ("Latex, Hotmelt", "R6 / Toluene",
// "PU + Silicon"). Split on multi-value delimiters (but NOT plain spaces, so
// two-word names like "Rubber Adhesive" / "PU Adhesive" stay intact), normalise
// each part to a catalog/canonical name, and return the DISTINCT list — so every
// product ends up in items[] instead of the whole cell collapsing to just the
// first match.
function normImportProducts(v) {
  const raw = tidyProductText(v);
  if (!raw) return [];
  const parts = raw.split(/\s*[,;/|+\n]\s*|\s+&\s+|\s+and\s+/i).map(s => s.trim()).filter(Boolean);
  const source = parts.length ? parts : [raw];
  const out = [], seen = new Set();
  for (const part of source) {
    const canon = normImportProduct(part) || tidyProductText(part);
    if (!canon) continue;
    const key = canon.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(canon);
  }
  return out;
}

async function runImport() {
  const { headers, rows, mapping } = _import;
  const errEl = document.getElementById('import-map-error');
  errEl.textContent = '';
  if (!mapping.includes('factory_name') && !mapping.includes('factory_number')) {
    errEl.textContent = `Map at least the ${T('name')} or ${T('code')} column.`;
    return;
  }

  const leads = rows.map(r => {
    const obj = {};
    let products = null;
    mapping.forEach((field, i) => {
      if (!field) return;
      const val = String(r[i] ?? '').trim();
      if (!val) return;
      if (field === 'follow_up')      obj.follow_up = normImportDate(val);
      else if (field === 'lead_type') obj.lead_type = normImportLeadType(val) || val;
      else if (field === 'stage')     Object.assign(obj, normImportStage(val));
      else if (field === 'product')   { products = normImportProducts(val); obj.product = products[0] || tidyProductText(val); }
      // Proper-Case messy name/area data on the way in (codes & numbers untouched).
      else if (field === 'factory_name' || field === 'person_in_charge' || field === 'area')
        obj[field] = toProperCase(val);
      else obj[field] = val;
    });
    // Multi-product cell → one item per product so ALL of them are captured, not
    // just the first. The single quantity/rate columns attach to the primary
    // product; obj.product stays the first (legacy single-product field + dedupe).
    if (products && products.length > 1) {
      obj.items = products.map((p, idx) => ({
        product:  p,
        quantity: idx === 0 ? (obj.quantity || '') : '',
        rate:     idx === 0 ? (obj.rate || '')     : '',
      }));
    }
    return obj;
  }).filter(o => Object.keys(o).length);

  const btn = document.getElementById('import-run-btn');
  btn.disabled = true; btn.textContent = 'Importing…';
  try {
    // Resolve the target list: an existing one, or create a new one by name.
    // Create it in the SAME team context the leads are imported into, so the
    // server accepts it (list + leads share a context).
    const listSel = document.getElementById('import-list-select');
    let listId = null;
    if (listSel && listSel.value === '__new__') {
      const newName = (document.getElementById('import-new-list-name')?.value || '').trim();
      if (newName) {
        const q = getLeadDest() ? ('?teamId=' + encodeURIComponent(getLeadDest())) : '';
        const created = await apiFetch('/api/lead-lists' + q, { method: 'POST', body: JSON.stringify({ name: newName }) });
        listId = created?.id || null;
      }
    } else if (listSel && listSel.value) {
      listId = listSel.value;
    }

    const result = await apiFetch('/api/leads/import', {
      method: 'POST',
      body: JSON.stringify({
        leads,
        assign_to: document.getElementById('import-assign-select').value,
        team_id: getLeadDest() || null,   // pool imports into the default team too
        list_id: listId,
        bucket: document.getElementById('import-dest-select')?.value || 'working',
      }),
    });
    const skippedHtml = result.skipped.length
      ? `<div class="import-skip-list"><b>Skipped ${result.skipped.length}:</b><br>${
          result.skipped.slice(0, 12).map(s => `Row ${s.row}: ${escHtml(s.reason)}`).join('<br>')
        }${result.skipped.length > 12 ? `<br>…and ${result.skipped.length - 12} more` : ''}</div>`
      : '';
    // AI product normalisation summary — "N auto-matched, M need review".
    const nNorm = result.normalized || 0;
    const nUnmatched = (result.unmatched || []).length;
    const normHtml = nNorm ? `<div class="import-norm">✨ ${nNorm} product${nNorm === 1 ? '' : 's'} auto-matched to your catalog</div>` : '';
    const reviewHtml = nUnmatched
      ? `<div class="import-review">⚠️ ${nUnmatched} product${nUnmatched === 1 ? '' : 's'} need review${
          state.role === 'admin' ? ` — <a href="#" onclick="closeImportModal(true); openProductCleanup(); return false;">Fix Product Data →</a>` : ''}</div>`
      : '';
    document.getElementById('import-result-summary').innerHTML = `
      <div class="import-result-big">✅ Imported <b>${result.added}</b> of ${result.total} leads</div>
      ${normHtml}${reviewHtml}${skippedHtml}`;
    document.getElementById('import-step-map').classList.add('hidden');
    document.getElementById('import-step-done').classList.remove('hidden');
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false; btn.innerHTML = `Import <span id="import-count-label">${rows.length} rows</span>`;
  }
}

function ddmmyyyyToISO(str) {
  if (!str) return '';
  const parts = String(str).split('/');
  if (parts.length !== 3) return '';
  return `${parts[2].slice(0,4)}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
}

function isoToddmmyyyy(str) {
  if (!str) return '';
  const parts = String(str).split('-');
  if (parts.length !== 3) return str;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

// ============================================================
//  Toast
// ============================================================
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className  = `toast-msg ${type}`;
  el.textContent = msg;
  document.getElementById('toast').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

// ============================================================
//  Navigation
// ============================================================
const PAGE_TITLES = {
  today: 'Today', dashboard: 'Dashboard', leads: 'Leads', database: 'Database',
  pipeline: 'Pipeline', followups: 'Follow-ups', reports: 'Reports', team: 'Team', map: 'Map', chat: 'Chat',
  workspace: 'Workspace', brochure: 'Brochure Maker', hub: 'Team Hub',
  'ai-debug': 'AI Debug',
};

function navigate(page) {
  // Premium: cross-fade the page content on switch via the View Transitions API
  // (scoped to #content in CSS — the sidebar/topbar stay put). Guarded on browser
  // support, a real page change, and prefers-reduced-motion; otherwise an instant
  // switch. NOT a monkey-patch: the body is renamed _navigate (different name).
  const prev = state.page;
  state.page = page;   // keep state.page correct SYNCHRONOUSLY (the VT callback
                       // that runs _navigate is deferred a frame; only the visual
                       // DOM swap should lag, never the state other code reads).
  // Skip the transition for chat (its fixed composer + keyboard-aware viewport
  // locking doesn't play well with the snapshot) and when reduced-motion is set.
  const changed = prev && prev !== page;
  const chatInvolved = prev === 'chat' || page === 'chat';
  if (changed && !chatInvolved && document.startViewTransition &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    document.startViewTransition(() => _navigate(page));
  } else {
    _navigate(page);
  }
}
function _navigate(page) {
  state.page = page;
  // Leaving the Leads table clears the bulk selection + its floating bar.
  if (page !== 'leads') { state.selectedLeads.clear(); document.getElementById('leads-bulk-bar')?.remove(); }
  // Leaving the Team Hub stops its chat poll so we don't network in the background.
  if (page !== 'hub') hubStopChatPoll();
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item, #bottom-nav .bn-item').forEach(n => n.classList.remove('active'));
  const pageEl = document.getElementById(`page-${page}`);
  if (pageEl) pageEl.classList.add('active');
  document.querySelector(`.nav-item[data-page="${page}"]`)?.classList.add('active');
  document.querySelector(`#bottom-nav .bn-item[data-page="${page}"]`)?.classList.add('active');
  document.getElementById('page-title').textContent = PAGE_TITLES[page] || page;
  // Chat page needs edge-to-edge layout (no content padding)
  document.getElementById('content')?.classList.toggle('chat-mode', page === 'chat');
  // The chat page has its own fixed composer at the bottom — hide the mobile
  // bottom nav there so the two don't stack/overlap.
  document.getElementById('bottom-nav')?.classList.toggle('hidden', page === 'chat');
  // The floating AI bubble is redundant on the chat page (you're already there).
  const _bubble = document.getElementById('ai-bubble');
  if (_bubble) {
    if (page === 'chat') _bubble.classList.add('hidden');
    else if (!bubbleHidden()) _bubble.classList.remove('hidden');
  }
  applyChatViewport();
  renderPage(page);
}

// Keep the chat page fitted to the on-screen keyboard-aware visible height so
// the composer + the understanding/messages scroll-area never hide behind the
// phone keyboard. On every other page (and where visualViewport is missing) we
// clear the override and fall back to normal full-height layout.
function applyChatViewport() {
  const vv   = window.visualViewport;
  const root = document.documentElement;
  if (!vv || state.page !== 'chat') {
    root.style.removeProperty('--app-vh');
    root.classList.remove('chat-vp-lock');
    return;
  }
  root.style.setProperty('--app-vh', Math.round(vv.height) + 'px');
  // On phones/tablets (the drawer layout) the on-screen keyboard shrinks the
  // visual viewport, and iOS then scrolls the WHOLE document to reveal the
  // focused input — pushing the topbar (with the ☰ that opens the sidebar) off
  // the top and shifting the understanding card. Locking the document (CSS via
  // this class) stops that scroll; #app + the drawer are sized to --app-vh so
  // nothing hides behind the keyboard. Desktop keeps its normal layout.
  const drawerLayout = window.matchMedia('(max-width: 1024px)').matches;
  root.classList.toggle('chat-vp-lock', drawerLayout);
}
function initChatViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  vv.addEventListener('resize', applyChatViewport);
  vv.addEventListener('scroll', applyChatViewport);
}

function renderPage(page) {
  applyBusinessTerms();      // refresh static business-term nodes (labels/placeholders/stage options)
  if (page === 'today')      renderToday();
  if (page === 'dashboard')  renderDashboard();
  if (page === 'leads')      renderLeads();
  if (page === 'database')   renderDatabase();
  if (page === 'pipeline')   renderPipeline();
  if (page === 'followups')  renderFollowups();
  if (page === 'reports')    renderReports();
  if (page === 'team')       renderTeam();
  if (page === 'map')        renderMap();
  if (page === 'chat') {
    chatFocusInput();
    if (!_chatInited) {
      // First open: fully initialise the default mode (Command) — sets the active
      // button, shows the messages area (not the understanding card), and prints
      // the mode's one-time greeting.
      _chatInited = true;
      setAiMode(aiMode);
    } else {
      // Later opens: refresh the composer for whatever mode we're already in —
      // command mode's chips/placeholder reference T('entity'), which goes stale
      // if the workspace/business type switches. Placeholder only (never .value,
      // so a half-typed message survives) and no hello-greeting path.
      renderChatChips(aiMode);
      const chatInputEl = document.getElementById('chat-input');
      const modeInfo = chatModeInfo(aiMode);
      if (chatInputEl && modeInfo?.ph) chatInputEl.placeholder = modeInfo.ph;
    }
  }
  if (page === 'workspace')  renderWorkspace();
  if (page === 'brochure')   renderBrochure();
  if (page === 'hub')        renderHub();
  if (page === 'ai-debug')   renderAiDebugPage();
}

// ============================================================
//  Brochure Maker — build a product rate-list flyer, export it as
//  a JPG / PDF, or share it straight to WhatsApp (native share sheet).
//  All client-side; the brochure config persists in localStorage.
// ============================================================
// One brochure PER WORKSPACE — the config is namespaced by the active org so
// switching workspace can never export a flyer with another team's company
// name / catalog. The pre-namespacing global key is migrated once, to the
// first workspace that opens the page.
const BROCHURE_LEGACY_KEY = 'crm_brochure';
function brochureKey() { return `crm_brochure_${state.activeOrgId || 'personal'}`; }

function defaultBrochure() {
  return { company: '', tagline: '', website: '', phone: '', email: '', address: '', accent: '#5E6AD2', items: [] };
}
function seedBrochure() {
  const b = defaultBrochure();
  // Seed the company from the ACTIVE team when there is one (a rep in team 2
  // shouldn't get team 1's name), falling back to the historic first-team pick.
  const activeTeam = (state.myTeams || []).find(t => String(t.id) === String(state.activeOrgId));
  b.company = (activeTeam && activeTeam.name) || (state.myTeams && state.myTeams[0] && state.myTeams[0].name) || '';
  const cat = state.myProducts || [];
  b.items = cat.slice(0, 8).map(p => ({ product: p.name, rate: '', unit: '' }));
  if (!b.items.length) b.items = [{ product: '', rate: '', unit: '' }];
  return b;
}
function loadBrochureCfg() {
  try {
    const own = JSON.parse(localStorage.getItem(brochureKey()));
    if (own) return own;
    // One-time migration: hand the legacy global brochure to the first
    // workspace that opens the page (the one it was built in), then remove it
    // so other workspaces seed fresh instead of inheriting the wrong company.
    const legacy = JSON.parse(localStorage.getItem(BROCHURE_LEGACY_KEY));
    if (legacy) {
      localStorage.removeItem(BROCHURE_LEGACY_KEY);
      try { localStorage.setItem(brochureKey(), JSON.stringify(legacy)); } catch (_) {}
      return legacy;
    }
    return null;
  } catch { return null; }
}
function saveBrochure() {
  try { localStorage.setItem(brochureKey(), JSON.stringify(state.brochure)); } catch (_) {}
}

// Darken/lighten a #rrggbb hex by a fraction (used for the header gradient —
// concrete hex stops so html2canvas renders them reliably, unlike color-mix()).
function shadeHex(hex, pct) {
  const h = String(hex || '').replace('#', '');
  if (h.length !== 6) return hex;
  const n = parseInt(h, 16); let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = pct < 0 ? 0 : 255, p = Math.abs(pct);
  r = Math.round((f - r) * p) + r; g = Math.round((f - g) * p) + g; b = Math.round((f - b) * p) + b;
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

function renderBrochure() {
  // Reload whenever the workspace changed since the config was loaded —
  // state.brochure must always be the ACTIVE workspace's brochure.
  const orgKey = state.activeOrgId || 'personal';
  if (!state.brochure || state._brochureOrg !== orgKey) {
    state.brochure = loadBrochureCfg() || seedBrochure();
    state._brochureOrg = orgKey;
  }
  const b = state.brochure;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v || ''; };
  set('br-company', b.company); set('br-tagline', b.tagline); set('br-website', b.website);
  set('br-phone', b.phone); set('br-email', b.email); set('br-address', b.address);
  set('br-accent', b.accent || '#5E6AD2');
  renderBrochureItems();
  renderBrochurePoster();
}

function brochureFieldChanged() {
  const b = state.brochure, v = id => (document.getElementById(id)?.value || '');
  b.company = v('br-company'); b.tagline = v('br-tagline'); b.website = v('br-website');
  b.phone = v('br-phone'); b.email = v('br-email'); b.address = v('br-address');
  b.accent = v('br-accent') || '#5E6AD2';
  saveBrochure(); renderBrochurePoster();
}

function renderBrochureItems() {
  const wrap = document.getElementById('br-items');
  if (!wrap) return;
  const its = state.brochure.items;
  wrap.innerHTML = its.length ? its.map((it, i) => `
    <div class="bre-item">
      <input class="bre-item-name" value="${escAttr(it.product || '')}" placeholder="Product" oninput="brochureItemChanged(${i},'product',this.value)">
      <input class="bre-item-rate" value="${escAttr(it.rate || '')}" placeholder="Rate" inputmode="decimal" oninput="brochureItemChanged(${i},'rate',this.value)">
      <input class="bre-item-unit" value="${escAttr(it.unit || '')}" placeholder="Unit" oninput="brochureItemChanged(${i},'unit',this.value)">
      <button class="bre-item-del" onclick="removeBrochureItem(${i})" aria-label="Remove">✕</button>
    </div>`).join('') : '<div class="bre-empty">No products yet — add some below.</div>';
}
function brochureItemChanged(i, field, v) {
  if (!state.brochure.items[i]) return;
  state.brochure.items[i][field] = v; saveBrochure(); renderBrochurePoster();
}
function addBrochureItem() {
  state.brochure.items.push({ product: '', rate: '', unit: '' });
  saveBrochure(); renderBrochureItems(); renderBrochurePoster();
}
function removeBrochureItem(i) {
  state.brochure.items.splice(i, 1);
  saveBrochure(); renderBrochureItems(); renderBrochurePoster();
}
function addBrochureItemFromCatalog() {
  const cat = state.myProducts || [];
  if (!cat.length) { toast('No products in your catalog yet — add some under Manage Products.', 'warning'); return; }
  const have = new Set(state.brochure.items.map(i => (i.product || '').toLowerCase()));
  let added = 0;
  cat.forEach(p => { if (p.name && !have.has(p.name.toLowerCase())) { state.brochure.items.push({ product: p.name, rate: '', unit: '' }); added++; } });
  saveBrochure(); renderBrochureItems(); renderBrochurePoster();
  toast(added ? `Added ${added} product${added === 1 ? '' : 's'} from your catalog` : 'All catalog products are already on the list');
}

function renderBrochurePoster() {
  const el = document.getElementById('brochure-poster');
  if (!el) return;
  const b = state.brochure, accent = b.accent || '#5E6AD2';
  const rows = b.items.filter(it => (it.product || '').trim()).map(it => `
    <div class="bp-item">
      <span class="bp-item-name">${escHtml(it.product)}</span>
      <span class="bp-item-rate">${it.rate ? '₹' + escHtml(it.rate) : '—'}${it.unit ? ` <small>/ ${escHtml(it.unit)}</small>` : ''}</span>
    </div>`).join('');
  const contact = [
    b.phone   ? `<span>📞 ${escHtml(b.phone)}</span>`   : '',
    b.email   ? `<span>✉ ${escHtml(b.email)}</span>`    : '',
    b.website ? `<span>🌐 ${escHtml(b.website)}</span>` : '',
  ].filter(Boolean).join('');
  el.innerHTML = `
    <div class="bp" style="--bp-accent:${escAttr(accent)};--bp-accent2:${escAttr(shadeHex(accent, -0.28))}">
      <div class="bp-header">
        <div class="bp-company">${escHtml(b.company || 'Your Company')}</div>
        ${b.tagline ? `<div class="bp-tagline">${escHtml(b.tagline)}</div>` : ''}
      </div>
      <div class="bp-body">
        <div class="bp-title">Product Rate List</div>
        <div class="bp-items">${rows || '<div class="bp-empty">Add products to see them here.</div>'}</div>
      </div>
      <div class="bp-footer">
        ${contact ? `<div class="bp-contact">${contact}</div>` : ''}
        ${b.address ? `<div class="bp-address">📍 ${escHtml(b.address)}</div>` : ''}
        <div class="bp-brand">Made with Dive</div>
      </div>
    </div>`;
}

// ── Export (lazy-loads html2canvas / jsPDF only on first use) ──
async function ensureBrochureLibs(needPdf) {
  if (!window.html2canvas) await loadScriptOnce('html2canvas', 'https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js');
  if (needPdf && !(window.jspdf && window.jspdf.jsPDF)) await loadScriptOnce('jspdf', 'https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js');
}
async function captureBrochureCanvas() {
  const poster = document.querySelector('#brochure-poster .bp');
  if (!poster) throw new Error('Nothing to export yet');
  // Clone into a fixed 794px offscreen holder so the export is crisp and the
  // same size regardless of the on-screen viewport.
  const holder = document.createElement('div');
  holder.style.cssText = 'position:fixed;left:-10000px;top:0;width:794px;background:#fff';
  const clone = poster.cloneNode(true);
  clone.style.width = '794px';
  holder.appendChild(clone);
  document.body.appendChild(holder);
  try {
    return await window.html2canvas(clone, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
  } finally { holder.remove(); }
}
function setBrochureBusy(busy, label) {
  document.querySelectorAll('.brochure-actions button').forEach(btn => { btn.disabled = busy; });
  const s = document.getElementById('brochure-status');
  if (s) s.textContent = busy ? (label || 'Generating…') : '';
}
function downloadDataUrl(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}
async function exportBrochure(kind) {
  const b = state.brochure || defaultBrochure();
  const fname = ((b.company || 'brochure').replace(/[^\w]+/g, '_').replace(/^_+|_+$/g, '') || 'brochure').toLowerCase();
  try {
    setBrochureBusy(true, kind === 'share' ? 'Preparing…' : 'Generating…');
    await ensureBrochureLibs(kind === 'pdf');
    const canvas = await captureBrochureCanvas();

    if (kind === 'pdf') {
      const jsPDF = window.jspdf.jsPDF;
      const pdf = new jsPDF({ unit: 'pt', format: 'a4' });
      const pw = pdf.internal.pageSize.getWidth(), ph = pdf.internal.pageSize.getHeight();
      let iw = pw, ih = canvas.height * (pw / canvas.width);
      if (ih > ph) { ih = ph; iw = canvas.width * (ph / canvas.height); }   // fit the whole poster on one page
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', (pw - iw) / 2, (ph - ih) / 2, iw, ih);
      pdf.save(fname + '.pdf');
      toast('PDF downloaded');
      return;
    }

    const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
    if (kind === 'share') {
      try {
        const blob = await (await fetch(dataUrl)).blob();
        const file = new File([blob], fname + '.jpg', { type: 'image/jpeg' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file], title: b.company || 'Brochure', text: `${b.company || ''} — product rate list`.trim() });
          return;
        }
      } catch (e) { if (e && e.name === 'AbortError') return; /* user cancelled */ }
      downloadDataUrl(dataUrl, fname + '.jpg');
      toast('Sharing not available here — saved the image instead');
      return;
    }
    downloadDataUrl(dataUrl, fname + '.jpg');
    toast('JPG downloaded');
  } catch (err) {
    toast('Export failed: ' + (err && err.message ? err.message : err), 'error');
  } finally {
    setBrochureBusy(false);
  }
}

// ============================================================
//  MAP
// ============================================================
const AREA_GEOJSON = {
  "type": "FeatureCollection",
  "features": [{
    "type": "Feature",
    "properties": {},
    "geometry": {
      "type": "Polygon",
      "coordinates": [[
        [76.9523955, 28.6944576],
        [76.9636481, 28.6938173],
        [76.9631007, 28.6894954],
        [76.9523955, 28.6902424],
        [76.9674801, 28.6994729],
        [76.9523955, 28.6944576]
      ]]
    }
  }]
};

let _leafletMap     = null;
let _socket         = null;
let _factoryLayer   = null;  // L.layerGroup for factory pins
let _routeLayer     = null;  // L.geoJSON for the OSRM route polyline
let _startMarker    = null;  // green dot for agent start position
let _startLocation  = null;  // { lat, lng }
let _pinModeTarget  = null;  // { rowIndex, name } when map is in click-to-pin mode

const agentMarkers = {};
const agentData    = {};

// ── Agent marker helpers ─────────────────────────────────────
function createAgentIcon(name) {
  const safe = String(name || '?').replace(/</g, '&lt;');
  return L.divIcon({
    className: '',
    html: `<div class="agent-pulse-wrapper">
             <div class="agent-pulse-ring"></div>
             <div class="agent-pulse-dot"></div>
             <span class="agent-label">${safe}</span>
           </div>`,
    iconSize:    [16, 16],
    iconAnchor:  [8, 8],
    popupAnchor: [0, -20],
  });
}

function upsertAgentMarker(agent) {
  if (!_leafletMap) return;
  const { agentId, lat, lng, name, accuracy } = agent;
  const accuracyText = accuracy ? `±${Math.round(accuracy)}m` : '';
  const popup = `<b>${escHtml(name || agentId)}</b><br>Live Location ${escHtml(accuracyText)}`;
  if (agentMarkers[agentId]) {
    agentMarkers[agentId].setLatLng([lat, lng]);
    agentMarkers[agentId].setIcon(createAgentIcon(name));
    agentMarkers[agentId].getPopup()?.setContent(popup);
  } else {
    agentMarkers[agentId] = L.marker([lat, lng], { icon: createAgentIcon(name) })
      .addTo(_leafletMap)
      .bindPopup(popup);
  }
}

// ── Socket.io connection ─────────────────────────────────────
function initSocket() {
  if (_socket) return;
  _socket = io();

  _socket.on('agents-snapshot', (snapshot) => {
    Object.assign(agentData, snapshot);
    Object.values(snapshot).forEach(a => upsertAgentMarker(a));
  });

  _socket.on('agent-moved', (agent) => {
    agentData[agent.agentId] = agent;
    upsertAgentMarker(agent);
  });
}

// ── Icon builders ──────────────────────────────────────────────
const TYPE_COLORS = { Hot: '#ef4444', Warm: '#f59e0b', Cold: '#3b82f6' };

function createFactoryIcon(label, leadType, number) {
  const color = TYPE_COLORS[leadType] || '#6366f1';
  const display = number != null ? String(number) : String(label || '◈').slice(0, 4);
  return L.divIcon({
    className: '',
    html: `<div class="factory-pin${number != null ? ' factory-pin-numbered' : ''}" style="background:${color}">${display}</div>`,
    iconSize:    [34, 34],
    iconAnchor:  [17, 17],
    popupAnchor: [0, -20],
  });
}

// ── Map init ───────────────────────────────────────────────────
async function renderMap() {
  if (_leafletMap) {
    _leafletMap.invalidateSize();
    Object.values(agentData).forEach(a => upsertAgentMarker(a));
    renderFactoryChecklist();
    return;
  }
  await ensureLeaflet();   // lazy-load Leaflet + its CSS the first time the map opens

  const map = L.map('crm-map', { zoomControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 19,
  }).addTo(map);

  // Territory polygon
  const territory = L.geoJSON(AREA_GEOJSON, {
    style: { color: '#6366f1', weight: 2.5, fillColor: '#818cf8', fillOpacity: 0.2 },
  }).addTo(map);

  _factoryLayer = L.layerGroup().addTo(map);
  _leafletMap   = map;

  // Click-to-pin handler
  map.on('click', e => {
    if (!_pinModeTarget) return;
    const { lat, lng } = e.latlng;
    const { rowIndex, name } = _pinModeTarget;
    cancelPinMode();

    apiFetch(`/api/leads/${rowIndex}/location`, {
      method: 'PATCH',
      body: JSON.stringify({ lat, lng }),
    }).then(() => {
      const lead = state.leads.find(l => String(l.rowIndex) === String(rowIndex));
      if (lead) { lead.lat = String(lat); lead.lng = String(lng); }
      toast(`📍 Location saved for ${name}`);
      renderFactoryChecklist();
      loadFactoryMarkers();
    }).catch(err => toast('Save failed: ' + err.message, 'error'));
  });

  map.fitBounds(territory.getBounds(), { padding: [40, 40] });

  loadFactoryMarkers();
  renderFactoryChecklist();
  Object.values(agentData).forEach(a => upsertAgentMarker(a));
}

// ── Factory markers on the map ─────────────────────────────────
function loadFactoryMarkers() {
  if (!_leafletMap || !_factoryLayer) return;
  _factoryLayer.clearLayers();

  state.leads
    .filter(l => l.lat && l.lng && !isNaN(+l.lat) && !isNaN(+l.lng))
    .forEach(l => {
      const m = L.marker([+l.lat, +l.lng], { icon: createFactoryIcon(l.factory_number, l.lead_type) });
      m.bindPopup(`
        <div style="min-width:160px">
          <b>${l.factory_name || l.factory_number}</b><br>
          <span style="color:#64748b;font-size:12px">${l.factory_number} · ${l.stage ? stageLabel(l.stage) : '—'}</span><br>
          <span style="font-size:12px">${l.person_in_charge || ''}</span>
          <br><br>
          <button onclick="startPinMode(${l.rowIndex},'${(l.factory_name||l.factory_number).replace(/'/g,'')}');document.querySelector('.leaflet-popup-close-button')?.click()"
            style="font-size:12px;cursor:pointer">📍 Move Pin</button>
        </div>
      `);
      m.addTo(_factoryLayer);
    });
}

// ── Route panel checklist ──────────────────────────────────────
function renderFactoryChecklist() {
  const container = document.getElementById('factory-checklist');
  if (!container) return;

  if (!state.leads.length) {
    container.innerHTML = `<p class="route-hint">No ${escHtml(T('entityPlural').toLowerCase())} in CRM yet.</p>`;
    return;
  }

  const withCoords    = state.leads.filter(l => l.lat && l.lng);
  const withoutCoords = state.leads.filter(l => !l.lat || !l.lng);

  let html = '';

  if (withCoords.length) {
    html += withCoords.map(l => `
      <label class="factory-check-item">
        <input type="checkbox" value="${l.rowIndex}" onchange="updateOptimizeBtn()">
        <span class="check-name">${l.factory_name || l.factory_number}</span>
        <span class="check-type" style="color:${TYPE_COLORS[l.lead_type]||'#94a3b8'}">${l.lead_type||''}</span>
      </label>
    `).join('');
  }

  if (withoutCoords.length) {
    html += `<div class="route-label" style="margin-top:10px;margin-bottom:4px">No location set</div>`;
    html += withoutCoords.map(l => `
      <div class="factory-check-item no-coords">
        <span class="check-name" style="color:#94a3b8">${l.factory_name || l.factory_number}</span>
        <button class="btn-pin-sm" data-row="${l.rowIndex}"
          data-name="${(l.factory_name||l.factory_number).replace(/"/g,'')}"
          title="Click to pin on map">📍 Pin</button>
      </div>
    `).join('');
  }

  container.innerHTML = html;

  // Wire pin buttons via event delegation (avoids inline onclick escaping issues)
  container.querySelectorAll('.btn-pin-sm').forEach(btn => {
    btn.addEventListener('click', () => startPinMode(+btn.dataset.row, btn.dataset.name));
  });

  updateOptimizeBtn();
}

function updateOptimizeBtn() {
  const count = document.querySelectorAll('#factory-checklist input:checked').length;
  const btn   = document.getElementById('btn-optimize');
  if (!btn) return;
  btn.disabled = !(count >= 1 && _startLocation);
  btn.textContent = _startLocation
    ? `🗺 Plan My Route (${count} selected)`
    : '🗺 Set location first';
}

// ── GPS start location ─────────────────────────────────────────
function useGpsLocation() {
  const btn = document.getElementById('btn-use-gps');
  btn.textContent = '📍 Locating…';
  btn.disabled    = true;

  navigator.geolocation.getCurrentPosition(pos => {
    _startLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };

    const chip = document.getElementById('start-coord-chip');
    chip.textContent = `${_startLocation.lat.toFixed(5)}, ${_startLocation.lng.toFixed(5)}`;
    chip.classList.remove('hidden');

    btn.textContent = '📍 Location Set ✓';
    btn.disabled    = false;

    // Green dot on map
    if (_startMarker) _startMarker.remove();
    _startMarker = L.circleMarker([_startLocation.lat, _startLocation.lng], {
      radius: 9, color: '#10b981', fillColor: '#10b981', fillOpacity: 1, weight: 2,
    }).bindPopup('📍 Your Start Location').addTo(_leafletMap);
    _leafletMap.panTo([_startLocation.lat, _startLocation.lng]);

    updateOptimizeBtn();
  }, err => {
    btn.textContent = '📍 GPS Failed — Try Again';
    btn.disabled    = false;
    toast('GPS error: ' + err.message, 'error');
  }, { enableHighAccuracy: true, timeout: 12000 });
}

// ── Pin mode ───────────────────────────────────────────────────
function startPinMode(rowIndex, name) {
  _pinModeTarget = { rowIndex, name };
  document.getElementById('pin-mode-banner').classList.remove('hidden');
  if (_leafletMap) _leafletMap.getContainer().style.cursor = 'crosshair';
  toast(`Tap the map to place the pin for "${name}"`);
}

function cancelPinMode() {
  _pinModeTarget = null;
  document.getElementById('pin-mode-banner').classList.add('hidden');
  if (_leafletMap) _leafletMap.getContainer().style.cursor = '';
}

// ── Route optimization ─────────────────────────────────────────
async function optimizeRoute() {
  const ids = [...document.querySelectorAll('#factory-checklist input:checked')]
    .map(el => +el.value);

  if (!ids.length || !_startLocation) return;

  const btn = document.getElementById('btn-optimize');
  btn.disabled    = true;
  btn.textContent = '🗺 Calculating…';

  // Clear previous route
  if (_routeLayer) { _routeLayer.remove(); _routeLayer = null; }

  try {
    const result = await apiFetch('/api/route/optimize', {
      method: 'POST',
      body:   JSON.stringify({ factory_ids: ids, start_location: _startLocation }),
    });

    // Draw the route polyline
    _routeLayer = L.geoJSON(result.route.geometry, {
      style: {
        color:    '#f97316',
        weight:   5,
        opacity:  0.85,
        lineJoin: 'round',
        lineCap:  'round',
      },
    }).addTo(_leafletMap);

    // Rebuild factory markers as numbered badges in visit order
    _factoryLayer.clearLayers();
    result.stops.forEach(stop => {
      const lead = state.leads.find(l => String(l.rowIndex) === String(stop.factory_id));
      L.marker([stop.lat, stop.lng], {
        icon: createFactoryIcon(stop.factory_number, lead?.lead_type, stop.order),
        zIndexOffset: 500,
      })
      .bindPopup(`<b>Stop ${stop.order}: ${escHtml(stop.factory_name)}</b><br>${escHtml(stop.factory_number)}<br>${escHtml(stop.person||'')}`)
      .addTo(_factoryLayer);
    });

    // Route stats
    document.getElementById('route-distance').textContent = result.route.distance_km;
    document.getElementById('route-time').textContent     = result.route.duration_min;
    document.getElementById('route-result').classList.remove('hidden');
    document.getElementById('btn-clear-route').style.display = '';

    // Ordered stop list
    document.getElementById('stop-list').innerHTML = result.stops.map(s => `
      <div class="stop-item">
        <div class="stop-badge" style="background:${TYPE_COLORS[state.leads.find(l=>String(l.rowIndex)===String(s.factory_id))?.lead_type]||'#6366f1'}">${s.order}</div>
        <div class="stop-info">
          <div class="stop-name">${escHtml(s.factory_name || s.factory_number)}</div>
          <div class="stop-detail">${escHtml(s.factory_number)}${s.person ? ' · ' + escHtml(s.person) : ''}</div>
        </div>
      </div>
    `).join('');

    if (result.skipped?.length)
      toast(`${result.skipped.length} ${T('entity').toLowerCase()} skipped (no coordinates)`, 'warning');

    _leafletMap.fitBounds(_routeLayer.getBounds(), { padding: [50, 50] });

  } catch (err) {
    toast('Route failed: ' + err.message, 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = '🗺 Plan My Route';
    updateOptimizeBtn();
  }
}

// ── Clear route ────────────────────────────────────────────────
function clearRoute() {
  if (_routeLayer) { _routeLayer.remove(); _routeLayer = null; }
  document.getElementById('route-result').classList.add('hidden');
  document.getElementById('btn-clear-route').style.display = 'none';
  document.querySelectorAll('#factory-checklist input').forEach(cb => cb.checked = false);
  loadFactoryMarkers();
  updateOptimizeBtn();
}

// ============================================================
//  Helpers
// ============================================================
function stageBadge(lead) {
  // label comes from stageLabel() → the team/user's custom business-profile stage
  // names, which are free text — MUST be escHtml'd here (this is the one sink that
  // injects it as raw HTML into cards/kanban/tables). n feeds a class attribute,
  // so escAttr it against a crafted (import-sourced) stage_number.
  const n     = escAttr(String(lead.stage_number ?? ''));
  const label = escHtml(lead.stage ? stageLabel(lead.stage) : '—');
  // Guests (and rows not in the working set) get a static badge; everyone else
  // gets a one-tap stage changer. stopPropagation so it doesn't also open the
  // row's lead-detail sheet.
  if (state.role === 'guest') return `<span class="badge badge-${n}">${label}</span>`;
  return `<button type="button" class="badge badge-${n} badge-stage" title="Tap to change stage"
    onclick="event.stopPropagation(); openStagePicker(${lead.rowIndex})">${label}<span class="badge-caret">▾</span></button>`;
}

// Won / Lost / Active grouping — mirrors getStats() in db.js (won = stage 6/7,
// lost = 0, active = everything else). Used by the clickable dashboard KPI cards.
function groupOf(l) {
  const n = String(l.stage_number || STAGE_NUMBERS[l.stage] || '');
  if (n === '6' || n === '7') return 'won';
  if (n === '0')              return 'lost';
  return 'active';
}

// Stats used to come from /api/stats, which re-ran the same heavy pipeline
// /api/leads already runs — twice a minute. The SPA holds the full dataset, so
// we derive stats client-side instead. by_stage stays keyed by the raw
// canonical l.stage (NOT display labels) to match the old server output.
function computeStats(leads) {
  const by_stage = {}, by_product = {}, by_product_revenue = {};
  let won = 0, lost = 0;
  for (const l of (leads || [])) {
    const s = l.stage || 'Unknown';
    by_stage[s] = (by_stage[s] || 0) + 1;
    const items = (l.items && l.items.length) ? l.items : [{ product: l.product, quantity: l.quantity, rate: l.rate }];
    for (const it of items) {
      const p = it.product || 'Unknown';
      by_product[p] = (by_product[p] || 0) + 1;
      by_product_revenue[p] = (by_product_revenue[p] || 0) + (parseFloat(it.quantity) || 0) * (parseFloat(it.rate) || 0);
    }
    if (l.stage_number === '6' || l.stage_number === '7') won++;
    if (l.stage_number === '0') lost++;
  }
  const by_lead_type = (leads || []).reduce((acc, l) => { const t = l.lead_type || 'Unset'; acc[t] = (acc[t] || 0) + 1; return acc; }, {});
  const total = (leads || []).length;
  return { total, active: total - won - lost, won, lost, by_stage, by_product, by_product_revenue, by_lead_type };
}

function filteredLeads() {
  const q = state.search.toLowerCase();
  let leads = state.leads.filter(l => {
    const allContactText = (l.contacts || []).map(c => `${c.person_name} ${c.contact}`).join(' ');
    const prodNames = leadProductNames(l);
    const matchSearch = !q || [l.factory_number, l.factory_name, prodNames.join(' '), allContactText]
      .some(v => String(v).toLowerCase().includes(q));
    const matchStage    = !state.filterStage    || l.stage      === state.filterStage;
    // Product/division match ANY item on the lead — multi-product friendly.
    const matchProduct  = !state.filterProduct  || prodNames.includes(state.filterProduct);
    const divMap        = state.filterDivision ? productDivisionMap() : null;
    const matchDivision = !state.filterDivision ||
      prodNames.some(n => (divMap[n.toLowerCase()] || '') === state.filterDivision);
    const matchSalesman = !state.filterSalesman || l.created_by === state.filterSalesman;
    const matchGroup    = !state.filterGroup    || groupOf(l)   === state.filterGroup;
    const matchList     = !state.filterList
      || (state.filterList === '__none__'
            ? !(l.list_ids || []).length
            : (l.list_ids || []).map(String).includes(String(state.filterList)));
    return matchSearch && matchStage && matchProduct && matchDivision && matchSalesman && matchGroup && matchList;
  });
  if (state.sortKey) {
    leads = [...leads].sort((a, b) => {
      const va = String(a[state.sortKey] || '').toLowerCase();
      const vb = String(b[state.sortKey] || '').toLowerCase();
      const cmp = va.localeCompare(vb, undefined, { numeric: true });
      return state.sortDir === 'asc' ? cmp : -cmp;
    });
  }
  return leads;
}

function sortBy(key) {
  if (state.sortKey === key) {
    state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    state.sortKey = key;
    state.sortDir = 'asc';
  }
  renderLeadsView();
}

function uniqueValues(key) {
  return [...new Set(state.leads.map(l => l[key]).filter(Boolean))].sort();
}

const TYPE_ROW_CLASS  = { Hot: 'row-hot', Warm: 'row-warm', Cold: 'row-cold' };
const TYPE_CARD_CLASS = { Hot: 'card-hot', Warm: 'card-warm', Cold: 'card-cold' };
const TYPE_EMOJI      = { Hot: '🔥', Warm: '🟡', Cold: '🔵' };

function buildTable(leads, cols, actions = true, selectable = false, rowClickFn = null) {
  if (!leads.length) return emptyState('No leads found');

  const colDefs = {
    factory_number:   ['#',          l => l.factory_number   || '—'],
    factory_name:     [T('entity'),  l => l.factory_name     || '—'],
    // Factory keeps its historic short header 'Person' (T('person') would be
    // the longer 'Person in Charge'); every other business shows its own term.
    person_in_charge: [biz().key === 'factory' ? 'Person' : T('person'), l => l.person_in_charge || '—'],
    contact:          ['Contact',    l => l.contact          || '—'],
    product:          [T('product'), l => { const n = leadProductNames(l); if (!n.length) return '—';
                                            const shown = escHtml(n.slice(0, 2).join(', '));
                                            return n.length > 2 ? `${shown} <span class="more-badge" title="${escAttr(n.join(', '))}">+${n.length - 2}</span>` : shown; }],
    quantity:         ['Qty',        l => l.quantity         || '—'],
    rate:             ['Rate',       l => l.rate             || '—'],
    stage:            ['Stage',      l => stageBadge(l)],
    follow_up:        ['Follow Up',  l => l.follow_up        || '—'],
    area:             [T('area'),    l => l.area             || '—'],
    notes:            ['Notes',      l => l.notes            || '—'],
    last_updated:     ['Updated',    l => l.last_updated     || '—'],
    lead_type:        ['Type',       l => l.lead_type ? `${TYPE_EMOJI[l.lead_type] || ''} ${l.lead_type}` : '—'],
    created_by:       ['Added By',   l => l.created_by       || '—'],
    lists:            ['Lists',      l => tagChips(l.lists)],
  };

  const heads = cols.map(c => {
    const label = colDefs[c] ? colDefs[c][0] : c;
    const arrow = state.sortKey === c ? (state.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="sortable" onclick="sortBy('${c}')">${escHtml(label)}${arrow}</th>`;
  }).join('');

  const allSel = leads.length && leads.every(l => state.selectedLeads.has(Number(l.rowIndex)));
  const selHead = selectable
    ? `<th class="sel-col"><input type="checkbox" ${allSel ? 'checked' : ''} onchange="toggleAllLeadsSelect(this.checked)" title="Select all"></th>`
    : '';

  const rows = leads.map(l => {
    const rowClass = TYPE_ROW_CLASS[l.lead_type] || '';
    const selCell = selectable
      ? `<td class="sel-col" onclick="event.stopPropagation()"><input type="checkbox" class="lead-sel" ${state.selectedLeads.has(Number(l.rowIndex)) ? 'checked' : ''} onchange="toggleLeadSelect(${l.rowIndex}, this.checked)"></td>`
      : '';
    const cells = selCell + cols.map(c => `<td>${colDefs[c] ? colDefs[c][1](l) : (l[c] || '—')}</td>`).join('');
    let act = '';
    if (actions && state.role !== 'guest') {
      const canEdit   = state.role === 'admin' || l.can_edit !== false;
      const canDelete = state.role === 'admin';
      const btns = [
        canEdit
          ? `<button class="action-btn" onclick="openEditModal(${l.rowIndex})">Edit</button>`
          : `<button class="action-btn" title="Ask the owner for edit access" onclick="requestLeadAccess(${l.rowIndex})">🔑 Request</button>`,
        canDelete ? `<button class="action-btn del" onclick="confirmDelete(${l.rowIndex}, '${escAttr(l.factory_name || l.factory_number)}')">Del</button>` : '',
      ].filter(Boolean).join('');
      act = `<td onclick="event.stopPropagation()"><div class="table-actions">${btns}</div></td>`;
    } else if (actions) {
      act = '<td>—</td>';
    }
    const rowAttrs = rowClickFn
      ? ` class="${rowClass} row-clickable" onclick="${rowClickFn}(${l.rowIndex})" tabindex="0" onkeydown="if(event.key==='Enter'){${rowClickFn}(${l.rowIndex})}"`
      : ` class="${rowClass}"`;
    return `<tr${rowAttrs}>${cells}${act}</tr>`;
  }).join('');

  const actHead = actions ? '<th>Actions</th>' : '';
  return `<div class="table-scroll"><table class="crm-table"><thead><tr>${selHead}${heads}${actHead}</tr></thead><tbody>${rows}</tbody></table></div>`;
}

// Fallback palette for lists created without an explicit colour
const LIST_PALETTE = ['#6366f1','#0ea5e9','#10b981','#f59e0b','#ef4444','#8b5cf6','#ec4899','#14b8a6','#f97316','#64748b'];
function listColor(t) {
  if (t && t.color) return t.color;
  const id = t && t.id ? Number(t.id) : 0;
  return LIST_PALETTE[Math.abs(id) % LIST_PALETTE.length];
}
function tagChips(lists) {
  if (!lists || !lists.length) return '<span class="muted">—</span>';
  return '<div class="tag-chips">' + lists.map(t => {
    const c = listColor(t);
    return `<span class="tag-chip" style="background:color-mix(in srgb, ${c} 14%, transparent);color:${c};border-color:color-mix(in srgb, ${c} 34%, transparent)">${escHtml(t.name)}</span>`;
  }).join('') + '</div>';
}

function emptyState(msg = 'No data') {
  return `<div class="empty-state"><div class="empty-state-icon">◎</div><p>${msg}</p></div>`;
}

function escAttr(v) {
  return String(v || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// ============================================================
//  Dashboard
// ============================================================
function renderDashHero() {
  const name = (localStorage.getItem('crm_user') || '').trim();
  const first = name ? name.split(/[\s._]/)[0].replace(/^\w/, c => c.toUpperCase()) : '';
  const hour = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false });
  const h = parseInt(hour, 10);
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const emoji = h < 12 ? '☀️' : h < 17 ? '👋' : '🌙';
  const greetEl = document.getElementById('dash-greeting');
  if (greetEl) greetEl.innerHTML = `${part}${first ? ', ' + escHtml(first) : ''} ${emoji}`;

  // Live subline from data
  const sub = document.getElementById('dash-subline');
  if (sub) {
    const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric' });
    let overdue = 0, dueToday = 0;
    for (const l of state.leads) {
      const fu = String(l.follow_up || '').trim();
      if (!fu || l.stage === 'Lost') continue;
      const parts = fu.split(/[\/\-]/);
      if (parts.length < 3) continue;
      const d = new Date(+parts[2], +parts[1] - 1, +parts[0]); d.setHours(0,0,0,0);
      const t = new Date(); t.setHours(0,0,0,0);
      if (d < t) overdue++; else if (d.getTime() === t.getTime()) dueToday++;
    }
    const bits = [];
    if (dueToday) bits.push(`<a class="hero-link" role="button" tabindex="0" onclick="state.fuFilter='today';navigate('followups')"><b class="hero-hot">${dueToday}</b> follow-up${dueToday>1?'s':''} due today</a>`);
    if (overdue)  bits.push(`<a class="hero-link" role="button" tabindex="0" onclick="state.fuFilter='overdue';navigate('followups')"><b class="hero-warn">${overdue}</b> overdue</a>`);
    sub.innerHTML = bits.length
      ? `${today} · ${bits.join(' · ')}`
      : `${today} · You're all caught up — no follow-ups pending. 🎉`;
  }
}

function renderDashboard() {
  const s = state.stats;
  if (!s || !s.by_stage) return;

  renderDashHero();

  const winRate = s.won + s.lost > 0 ? Math.round((s.won / (s.won + s.lost)) * 100) : 0;
  const ICONS = {
    total: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    active: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
    won: '<path d="M20 6 9 17l-5-5"/>',
    lost: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
  };
  const card = (accent, key, label, value, sub) => {
    const group = key === 'total' ? '' : key;   // total → all leads
    return `
    <div class="stat-card stat-${accent} stat-clickable" role="button" tabindex="0"
         title="View ${label.toLowerCase()} in Leads"
         onclick="dashFilter('${group}')"
         onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();dashFilter('${group}')}">
      <div class="stat-top">
        <span class="stat-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[key]}</svg></span>
        <span class="stat-label">${label}</span>
      </div>
      <div class="stat-value">${value}</div>
      <div class="stat-sub">${sub} ›</div>
    </div>`;
  };

  document.getElementById('stat-cards').innerHTML =
    card('blue',  'total',  'Total Leads', s.total,  'All time') +
    card('amber', 'active', 'Active',      s.active, 'In pipeline') +
    card('green', 'won',    'Won',         s.won,    `${winRate}% win rate`) +
    card('red',   'lost',   stageLabel('Lost'), s.lost, `${s.won + s.lost ? Math.round(s.lost / (s.won + s.lost) * 100) : 0}% loss rate`);

  // Pipeline by Stage — doughnut with center total. Colors/data stay keyed by
  // the canonical stage string; only the displayed labels array is relabeled.
  const stageKeys = Object.keys(s.by_stage);
  renderChart('chart-stage', 'doughnut',
    stageKeys.map(stageLabel),
    Object.values(s.by_stage),
    stageKeys.map(k => STAGE_COLORS[k] || '#94a3b8'),
    { centerText: { value: s.total, label: 'leads' } }
  );

  // Leads by Product — horizontal bar sorted by count
  const prodEntries = Object.entries(s.by_product || {}).sort(([,a],[,b]) => b - a);
  renderChart('chart-product', 'hbar',
    prodEntries.map(([k]) => k),
    prodEntries.map(([,v]) => v),
    ['#3b82f6','#8b5cf6','#10b981','#f59e0b','#ef4444','#06b6d4','#6366f1','#14b8a6']
  );

  // Monthly Lead Trend — line chart
  const monthly = getMonthlyTrend();
  const monthlyCard = document.getElementById('chart-monthly')?.closest('.card');
  if (monthly.labels.length) {
    if (monthlyCard) monthlyCard.style.display = '';
    renderChart('chart-monthly', 'line', monthly.labels, monthly.data, ['#3b82f6'],
      { label: 'Leads Added' });
  } else if (monthlyCard) {
    monthlyCard.style.display = 'none';
  }

  // Lead Type — doughnut
  const lt       = s.by_lead_type || {};
  const ltOrder  = ['Hot','Warm','Cold','Unset'];
  const ltLabels = ltOrder.filter(t => lt[t]);
  const ltData   = ltLabels.map(t => lt[t]);
  const ltColors = { Hot: '#ef4444', Warm: '#f59e0b', Cold: '#3b82f6', Unset: '#94a3b8' };
  const ltCard   = document.getElementById('chart-leadtype')?.closest('.card');
  if (ltLabels.length) {
    if (ltCard) ltCard.style.display = '';
    renderChart('chart-leadtype', 'doughnut', ltLabels, ltData,
      ltLabels.map(t => ltColors[t]),
      { centerText: { value: ltData.reduce((a,b) => a+b, 0), label: 'categorised' } }
    );
  } else if (ltCard) {
    ltCard.style.display = 'none';
  }

  // Recent leads table
  const recent = [...state.leads].reverse().slice(0, 8);
  const recentCols = state.role === 'admin'
    ? ['factory_number','factory_name','product','stage','follow_up','created_by']
    : ['factory_number','factory_name','product','stage','follow_up'];
  document.getElementById('recent-table').innerHTML = buildTable(recent, recentCols, true);
}

function renderChart(id, type, labels, data, colors, opts = {}) {
  const ctx = document.getElementById(id);
  if (!ctx) return;
  // chart.js is lazy-loaded — if it isn't in yet, fetch it and redraw when ready.
  if (typeof Chart === 'undefined') {
    ensureChart().then(() => renderChart(id, type, labels, data, colors, opts)).catch(() => {});
    return;
  }

  // Skip the expensive destroy+recreate when nothing changed (e.g. a 60s
  // auto-refresh that returned identical numbers) — keep the existing chart.
  const sig = JSON.stringify([type, labels, data, colors, opts.centerText || null, opts.label || null]);
  const existing = state.charts[id];
  if (existing && existing.__sig === sig) return;
  if (existing) { existing.destroy(); delete state.charts[id]; }

  const isHBar    = type === 'hbar';
  const isLine    = type === 'line';
  const chartType = isHBar ? 'bar' : type;

  try {
  state.charts[id] = new Chart(ctx, {
    type: chartType,
    data: {
      labels,
      datasets: [{
        label:           opts.label || 'Count',
        data,
        backgroundColor: isLine
          ? 'rgba(59,130,246,0.08)'
          : colors.slice(0, data.length),
        borderColor:     chartType === 'doughnut' ? '#ffffff'
          : isLine ? '#3b82f6' : 'transparent',
        borderWidth:     chartType === 'doughnut' ? 2 : isLine ? 2.5 : 0,
        borderRadius:    chartType === 'bar' ? 5 : 0,
        fill:            isLine,
        tension:         isLine ? 0.4 : 0,
        pointRadius:     isLine ? 4 : 0,
        pointBackgroundColor: '#3b82f6',
        pointBorderColor:     '#fff',
        pointBorderWidth:     2,
        pointHoverRadius:     isLine ? 6 : 0,
      }],
    },
    options: {
      indexAxis:            isHBar ? 'y' : 'x',
      responsive:           true,
      maintainAspectRatio:  false,
      animation:            { duration: 700, easing: 'easeOutQuart' },
      cutout:               chartType === 'doughnut' ? '65%' : undefined,
      plugins: {
        legend: {
          display:  chartType === 'doughnut',
          position: 'right',
          labels: {
            font: { size: 11, family: 'Inter' },
            boxWidth: 10, padding: 14, usePointStyle: true,
          },
        },
        tooltip: {
          backgroundColor: '#1e293b',
          titleFont:  { size: 12, family: 'Inter', weight: '600' },
          bodyFont:   { size: 12, family: 'Inter' },
          padding: 10, cornerRadius: 8, displayColors: false,
          callbacks: opts.tooltipCallbacks || {},
        },
        doughnutCenter: opts.centerText
          ? { enabled: true, ...opts.centerText }
          : { enabled: false },
      },
      scales: chartType !== 'doughnut' ? {
        x: {
          grid:  { display: isHBar, color: '#f1f5f9' },
          ticks: { font: { size: 11, family: 'Inter' } },
          border: { display: false },
          beginAtZero: true,
        },
        y: {
          grid:  { display: !isHBar, color: '#f1f5f9' },
          ticks: { font: { size: 11, family: 'Inter' } },
          border: { display: false },
          beginAtZero: !isHBar,
        },
      } : {},
    },
  });
  if (state.charts[id]) state.charts[id].__sig = sig;   // remember for skip-when-unchanged
  } catch (err) { console.error('Chart render failed for ' + id, err); }
}

// ============================================================
//  Leads page
// ============================================================
function renderLeads() {
  renderAiToggle('leads');
  renderAiPanel('leads');
  populateFilters();
  renderLeadsView();
}

// ============================================================
//  Database page (team reference bank)
// ============================================================
async function renderDatabase() {
  const wrap = document.getElementById('db-table-wrap');
  // Only show the "Loading…" placeholder on the FIRST load — on a re-open/refresh
  // keep the current table on screen so it never flashes/jumps under the user.
  const firstLoad = !state.dbLeads.length;
  if (wrap && firstLoad) wrap.innerHTML = '<div class="empty-state" style="padding:26px">Loading the Database…</div>';
  try {
    const q = 'bucket=database' + (state.activeOrgId ? '&teamId=' + encodeURIComponent(state.activeOrgId) : '');
    state.dbLeads = await apiFetch('/api/leads?' + q);
  } catch (err) {
    state.dbLeads = [];
    if (wrap) wrap.innerHTML = emptyState('Could not load the Database: ' + escHtml(err.message));
    return;
  }
  // Keep any selection that still exists (don't wipe it on a refresh).
  const stillHere = new Set(state.dbLeads.map(l => Number(l.rowIndex)));
  for (const id of [...state.dbSelected]) if (!stillHere.has(id)) state.dbSelected.delete(id);
  renderDatabaseTable();
}

function dbFilteredLeads() {
  const q = (state.dbSearch || '').toLowerCase();
  if (!q) return state.dbLeads;
  return state.dbLeads.filter(l => {
    const hay = [l.factory_number, l.factory_name, l.person_in_charge, l.area,
      leadProductNames(l).join(' ')].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

function renderDatabaseTable() {
  const wrap = document.getElementById('db-table-wrap');
  if (!wrap) return;
  const leads = dbFilteredLeads();
  if (!state.dbLeads.length) {
    wrap.innerHTML = emptyState('Your Database is empty. Use “⬆ Import to Database”, or send working leads here from a lead’s editor.');
    updateDbCopyBtn();
    return;
  }
  if (!leads.length) { wrap.innerHTML = emptyState('No database leads match your search.'); updateDbCopyBtn(); return; }

  const rows = leads.map(l => {
    const checked = state.dbSelected.has(Number(l.rowIndex)) ? 'checked' : '';
    const prods = leadProductNames(l);
    const prodCell = prods.length ? escHtml(prods.slice(0, 2).join(', ')) + (prods.length > 2 ? ` <span class="more-badge">+${prods.length - 2}</span>` : '') : '—';
    return `<tr>
      <td class="db-check-col"><input type="checkbox" class="db-check" value="${l.rowIndex}" ${checked} onchange="toggleDbSelect(${l.rowIndex}, this.checked)"></td>
      <td>${escHtml(l.factory_number || '—')}</td>
      <td>${escHtml(l.factory_name || '—')}</td>
      <td>${escHtml(l.person_in_charge || '—')}</td>
      <td>${escHtml(l.contact || '—')}</td>
      <td>${prodCell}</td>
      <td>${escHtml(l.area || '—')}</td>
      <td><div class="table-actions">
        <button class="action-btn" onclick="copyOneToWorking(${l.rowIndex})" title="Copy into your working leads (stays here too)">→ Copy</button>
        <button class="action-btn del" onclick="deleteOneFromDb(${l.rowIndex})" title="Permanently remove this from the Database">Delete</button>
      </div></td>
    </tr>`;
  }).join('');

  const allChecked = leads.length && leads.every(l => state.dbSelected.has(Number(l.rowIndex)));
  wrap.innerHTML = `<div class="table-scroll"><table class="crm-table">
    <thead><tr>
      <th class="db-check-col"><input type="checkbox" ${allChecked ? 'checked' : ''} onchange="toggleDbSelectAll(this.checked)"></th>
      <th>#</th><th>${escHtml(T('entity'))}</th><th>Person</th><th>Contact</th><th>Product</th><th>Area</th><th></th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
  updateDbCopyBtn();
}

function toggleDbSelect(id, on) {
  if (on) state.dbSelected.add(Number(id)); else state.dbSelected.delete(Number(id));
  updateDbCopyBtn();
}
function toggleDbSelectAll(on) {
  const leads = dbFilteredLeads();
  if (on) leads.forEach(l => state.dbSelected.add(Number(l.rowIndex)));
  else    leads.forEach(l => state.dbSelected.delete(Number(l.rowIndex)));
  renderDatabaseTable();
}
function updateDbCopyBtn() {
  const n = state.dbSelected.size;
  const copyBtn = document.getElementById('btn-db-copy-selected');
  if (copyBtn) {
    copyBtn.disabled = !n;
    copyBtn.textContent = n ? `Copy ${n} selected → Working leads` : 'Copy selected → Working leads';
  }
  const delBtn = document.getElementById('btn-db-delete-selected');
  if (delBtn) {
    delBtn.disabled = !n;
    delBtn.textContent = n ? `🗑 Delete ${n} selected` : '🗑 Delete selected';
  }
}

async function copyDbLeads(ids) {
  if (!ids.length) return;
  try {
    const res = await apiFetch('/api/leads/copy-to-working' + orgQuery(), {
      method: 'POST', body: JSON.stringify({ lead_ids: ids }),
    });
    await loadLeads();   // working sheet now has the copies
    toast(`Copied ${res.copied} lead${res.copied === 1 ? '' : 's'} into your working leads`);
    state.dbSelected = new Set();
    renderDatabaseTable();
  } catch (err) { toast(err.message, 'error'); }
}
function copyOneToWorking(id) { copyDbLeads([Number(id)]); }
function copySelectedToWorking() { copyDbLeads([...state.dbSelected]); }

// Permanently remove Database (reference bank) leads — unlike the working
// sheet's "move to Database", there's no send-back once this runs.
async function deleteDbLeads(ids) {
  if (!ids.length) return;
  if (!confirm(`Permanently delete ${ids.length} lead${ids.length === 1 ? '' : 's'} from the Database? This cannot be undone.`)) return;
  try {
    // Batch past the server's 1000-per-request cap so "select all → delete"
    // works in one click no matter how large the Database is.
    const CHUNK = 900;
    let deleted = 0, denied = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const res = await apiFetch('/api/leads/bulk-delete' + orgQuery(), {
        method: 'POST', body: JSON.stringify({ lead_ids: ids.slice(i, i + CHUNK) }),
      });
      deleted += res.deleted || 0;
      denied  += res.denied  || 0;
    }
    state.dbLeads = state.dbLeads.filter(l => !ids.includes(Number(l.rowIndex)));
    state.dbSelected = new Set();
    renderDatabaseTable();
    const extra = denied ? ` (${denied} skipped — no permission)` : '';
    toast(`Deleted ${deleted} lead${deleted === 1 ? '' : 's'} from the Database${extra}`, deleted ? 'success' : 'warning');
  } catch (err) { toast(err.message, 'error'); }
}
function deleteOneFromDb(id) { deleteDbLeads([Number(id)]); }
function deleteSelectedFromDb() { deleteDbLeads([...state.dbSelected]); }

// Send a working lead down into the team Database (declutter the working sheet).
async function moveLeadToDatabase(rowIndex) {
  if (!confirm('Move this lead into the team Database (out of your working sheet)? You can copy it back anytime.')) return;
  try {
    await apiFetch('/api/leads/move-to-database' + orgQuery(), {
      method: 'POST', body: JSON.stringify({ lead_ids: [Number(rowIndex)] }),
    });
    closeModal();
    await loadLeads();
    if (state.page === 'leads') renderLeadsView();
    toast('Moved to the Database');
  } catch (err) { toast(err.message, 'error'); }
}

// One-time Proper-Case pass over the caller's editable working leads.
// One-click cleanup for already-imported leads: Proper-Case names/areas AND snap
// every product onto the catalog — the same normalisation new imports get, but
// applied to the leads already in your working sheet. Only touches leads you can
// edit, and only fields that actually change.
async function cleanupImportedLeads() {
  if (!confirm(`Clean up your leads?\n\n• Proper-Case the ${T('entity').toLowerCase()} name, person and area (mixed-case you typed by hand stays)\n• Snap each product onto your Products catalog\n\nOnly the leads you can edit are changed.`)) return;
  const btn = document.getElementById('btn-cleanup');
  if (btn) { btn.disabled = true; btn.textContent = '✨ Cleaning…'; }
  try {
    const updates = [];
    for (const l of state.leads) {
      if (l.can_edit === false) continue;
      const upd = { id: l.rowIndex };
      let changed = false;

      const fn = toProperCase(l.factory_name);     if (fn !== (l.factory_name || ''))     { upd.factory_name = fn; changed = true; }
      const pn = toProperCase(l.person_in_charge); if (pn !== (l.person_in_charge || '')) { upd.person_in_charge = pn; changed = true; }
      const ar = toProperCase(l.area);             if (ar !== (l.area || ''))             { upd.area = ar; changed = true; }

      // Normalise every item's product against the catalog (fallback: tidied raw).
      const items = (l.items && l.items.length)
        ? l.items
        : (l.product ? [{ product: l.product, quantity: l.quantity, rate: l.rate }] : []);
      const normItems = items.map(it => ({
        product:  normImportProduct(it.product) || tidyProductText(it.product),
        quantity: it.quantity || '',
        rate:     it.rate || '',
      }));
      const itemsChanged = normItems.some((it, i) => it.product !== (items[i].product || ''));
      const newPrimary   = normItems.length ? normItems[0].product : (l.product || '');
      if (itemsChanged || newPrimary !== (l.product || '')) {
        upd.product = newPrimary;
        upd.items   = normItems;
        changed = true;
      }
      if (changed) updates.push(upd);
    }

    if (!updates.length) { toast('Everything already looks clean'); return; }
    const res = await apiFetch('/api/leads/bulk-fix' + orgQuery(), {
      method: 'POST', body: JSON.stringify({ updates }),
    });
    await loadLeads();
    if (state.page === 'leads') { populateFilters(); renderLeadsView(); }
    toast(res.changed ? `Cleaned up ${res.changed} lead${res.changed === 1 ? '' : 's'}` : 'Everything already looks clean');
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '✨ Clean up'; }
  }
}

function populateFilters() {
  const stageEl   = document.getElementById('filter-stage');
  const productEl = document.getElementById('filter-product');
  const stages    = uniqueValues('stage');
  // Products come from every item on every lead PLUS the curated catalog, so the
  // filter covers multi-product leads and products you've defined but not used yet.
  const products  = [...new Set([
    ...state.leads.flatMap(leadProductNames),
    ...(state.myProducts || []).map(p => p.name),
  ].filter(Boolean))].sort();
  // value stays the canonical stage string (what filteredLeads() compares
  // against); only the visible option text is relabeled.
  stageEl.innerHTML   = '<option value="">All Stages</option>'   + stages.map(s => `<option value="${escAttr(s)}" ${s===state.filterStage?'selected':''}>${escHtml(stageLabel(s))}</option>`).join('');
  productEl.innerHTML = '<option value="">All Products</option>' + products.map(p => `<option ${p===state.filterProduct?'selected':''}>${escHtml(p)}</option>`).join('');

  // Division filter — only shown once the catalog defines divisions.
  const divEl = document.getElementById('filter-division');
  if (divEl) {
    const divisions = catalogDivisions();
    divEl.style.display = divisions.length ? '' : 'none';
    if (divisions.length) {
      divEl.innerHTML = '<option value="">All Divisions</option>' +
        divisions.map(d => `<option ${d===state.filterDivision?'selected':''}>${escHtml(d)}</option>`).join('');
    } else if (state.filterDivision) {
      state.filterDivision = '';
    }
  }

  // Salesman filter — for admins, or team views with multiple owners
  const salesEl  = document.getElementById('filter-salesman');
  if (salesEl) {
    const salesmen = uniqueValues('created_by');
    const show = (state.role === 'admin' || (state.activeOrgId && salesmen.length > 1)) && salesmen.length > 0;
    salesEl.style.display = show ? '' : 'none';
    if (show) {
      salesEl.innerHTML = '<option value="">All Salesmen</option>' +
        salesmen.map(s => `<option ${s===state.filterSalesman?'selected':''}>${escHtml(s)}</option>`).join('');
    } else if (state.filterSalesman) {
      state.filterSalesman = '';
    }
  }

  // List (tag) filter — shown whenever the user has any lists
  const listEl = document.getElementById('filter-list');
  if (listEl) {
    const lists = state.myLists || [];
    const show  = lists.length > 0;
    listEl.style.display = show ? '' : 'none';
    if (show) {
      listEl.innerHTML = '<option value="">All Lists</option>' +
        lists.map(l => `<option value="${l.id}" ${String(l.id)===String(state.filterList)?'selected':''}>${escHtml(l.name)}${l.count?` (${l.count})`:''}</option>`).join('') +
        `<option value="__none__" ${state.filterList==='__none__'?'selected':''}>— No list —</option>`;
    } else if (state.filterList) {
      state.filterList = '';
    }
  }
}

// Jump from a dashboard KPI card into the Leads page, scoped to that group.
function dashFilter(group) {
  state.filterGroup = group;
  state.filterStage = '';          // group supersedes any exact-stage filter
  navigate('leads');
}

function clearGroupFilter() {
  state.filterGroup = '';
  renderLeadsView();
}

// 'lost' is routed through stageLabel() since it names the canonical Lost
// stage bucket — computed fresh (not a module-level const) so it always
// reflects the active business profile, even though no business type
// currently overrides 'Lost'.
function groupLabel(group) {
  if (group === 'lost') return stageLabel('Lost');
  return { active: 'Active', won: 'Won' }[group] || group;
}

function renderGroupChip() {
  const host = document.getElementById('leads-active-filter');
  if (!host) return;
  if (!state.filterGroup) { host.innerHTML = ''; return; }
  // On the Active group, offer a jump to the Pipeline board (the visual view of
  // the same in-pipeline leads).
  const pipeLink = state.filterGroup === 'active'
    ? `<button type="button" class="chip-link" onclick="navigate('pipeline')">Open Pipeline →</button>`
    : '';
  host.innerHTML = `
    <span class="active-filter-chip">
      Showing <b>${escHtml(groupLabel(state.filterGroup))}</b>
      <button type="button" onclick="clearGroupFilter()" aria-label="Clear filter">✕</button>
    </span>${pipeLink}`;
}

function renderLeadsView() {
  renderGroupChip();
  const leads = filteredLeads();
  // Phones can't fit the full 13-column table — it runs off the right edge and
  // you have to slide sideways to read anything. On the drawer/phone layout show
  // a compact, fits-on-screen set; a tap still opens the full lead detail.
  const narrow = window.matchMedia('(max-width: 640px)').matches;
  let cols;
  if (narrow) {
    cols = ['factory_name', 'contact', 'stage', 'lead_type'];
  } else {
    // Admins (and team views) see whose lead each row is
    cols = ['factory_number','factory_name','person_in_charge','contact','product','quantity','rate','stage','lead_type','follow_up','area'];
    if (state.role === 'admin' || state.activeOrgId) cols.push('created_by');
    // Show the Lists column once any list exists (or any lead is tagged)
    if (state.myLists.length || state.leads.some(l => (l.list_ids || []).length)) cols.push('lists');
  }
  const tableWrap  = document.getElementById('leads-table-wrap');
  const cardsWrap  = document.getElementById('leads-cards-wrap');
  const kanbanWrap = document.getElementById('leads-kanban-wrap');
  tableWrap.classList.add('hidden');
  cardsWrap.classList.add('hidden');
  kanbanWrap.classList.add('hidden');
  // keep the view toggle in sync (state.view can be set programmatically)
  document.querySelectorAll('.view-toggle .toggle-btn').forEach(b =>
    b.classList.toggle('active', b.dataset.view === state.view));

  // Bulk-select is offered on the table view for users who can delete leads.
  // On phones we drop it (and the Actions column below) so the four data columns
  // fit the screen without a sideways slide — a row tap opens the full detail
  // sheet, which has Edit / stage / delete.
  const selectable = canBulkDeleteLeads() && state.view === 'table' && !narrow;
  if (!selectable && state.selectedLeads.size) state.selectedLeads.clear();

  if (state.view === 'cards') {
    cardsWrap.classList.remove('hidden');
    cardsWrap.innerHTML = buildCards(leads);
  } else if (state.view === 'kanban') {
    kanbanWrap.classList.remove('hidden');
    kanbanWrap.innerHTML = buildKanban(leads, true);
  } else {
    tableWrap.classList.remove('hidden');
    // Drop any selected ids no longer in view (filters/search changed).
    const visible = new Set(leads.map(l => Number(l.rowIndex)));
    for (const id of [...state.selectedLeads]) if (!visible.has(id)) state.selectedLeads.delete(id);
    tableWrap.innerHTML = buildTable(leads, cols, !narrow, selectable, 'openLeadDetail');
  }
  renderBulkBar();
}

// Only users who can actually delete leads get the select/bulk-delete UI
// (admins today — matching the per-row "Del" button; the server re-checks).
function canBulkDeleteLeads() {
  return state.role === 'admin';
}

function toggleLeadSelect(id, on) {
  if (on) state.selectedLeads.add(Number(id)); else state.selectedLeads.delete(Number(id));
  renderBulkBar();
  // keep the header "select all" box in sync without a full re-render
  const shown = filteredLeads().map(l => Number(l.rowIndex));
  const all = shown.length && shown.every(x => state.selectedLeads.has(x));
  const head = document.querySelector('#leads-table-wrap .sel-col input');
  if (head) head.checked = all;
}

function toggleAllLeadsSelect(on) {
  const shown = filteredLeads().map(l => Number(l.rowIndex));
  if (on) shown.forEach(x => state.selectedLeads.add(x));
  else    shown.forEach(x => state.selectedLeads.delete(x));
  renderLeadsView();
}

function clearLeadSelection() {
  state.selectedLeads.clear();
  renderLeadsView();
}

// Floating action bar shown while leads are selected on the table.
function renderBulkBar() {
  let bar = document.getElementById('leads-bulk-bar');
  const n = state.selectedLeads.size;
  if (!n || !canBulkDeleteLeads() || state.view !== 'table') { if (bar) bar.remove(); return; }
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'leads-bulk-bar';
    bar.className = 'leads-bulk-bar';
    document.body.appendChild(bar);
  }
  bar.innerHTML = `
    <span class="bulk-count">${n} selected</span>
    <button class="btn btn-ghost btn-sm" onclick="clearLeadSelection()">Clear</button>
    <button class="btn btn-danger btn-sm" onclick="bulkDeleteSelected()">🗑 Delete ${n}</button>`;
}

async function bulkDeleteSelected() {
  const ids = [...state.selectedLeads];
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} selected lead${ids.length === 1 ? '' : 's'}? This cannot be undone.`)) return;
  const bar = document.getElementById('leads-bulk-bar');
  if (bar) bar.querySelectorAll('button').forEach(b => b.disabled = true);
  try {
    // The server caps each request at 1000, so send in batches — this lets a
    // "select all → delete" clear the whole sheet in one click for a fresh import.
    const CHUNK = 900;
    let deleted = 0, denied = 0;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const res = await apiFetch('/api/leads/bulk-delete' + orgQuery(), {
        method: 'POST', body: JSON.stringify({ lead_ids: ids.slice(i, i + CHUNK) }),
      });
      deleted += res.deleted || 0;
      denied  += res.denied  || 0;
    }
    state.selectedLeads.clear();
    await loadLeads();
    if (state.stats) { try { await loadStats(); } catch (_) {} }
    renderLeads();
    const extra = denied ? ` (${denied} skipped — no permission)` : '';
    toast(`Deleted ${deleted} lead${deleted === 1 ? '' : 's'}${extra}`, deleted ? 'success' : 'warning');
  } catch (err) {
    toast(err.message, 'error');
    if (bar) bar.querySelectorAll('button').forEach(b => b.disabled = false);
  }
}

// A readable, stacked card per lead — far easier than the wide side-by-side
// table on a phone/tablet. Tap a card to edit.
function buildCards(leads) {
  if (!leads.length) return emptyState('No leads match your filters.');
  const showOwner = state.role === 'admin' || !!state.activeOrgId;
  const cards = leads.map(l => {
    const typeCls  = TYPE_CARD_CLASS[l.lead_type] || '';
    const typeTag  = l.lead_type ? `<span class="lead-card-type">${TYPE_EMOJI[l.lead_type] || ''} ${escHtml(l.lead_type)}</span>` : '';
    const stageCol = STAGE_COLORS[l.stage] || '#64748b';
    const c        = (l.contacts && l.contacts[0]) || { person_name: l.person_in_charge, contact: l.contact };
    const person   = [c.person_name, c.contact].filter(Boolean).map(escHtml).join(' · ');
    // All items on the lead, one chip per product (multi-product friendly).
    const itemLines = leadItemLines(l);
    const prod = itemLines.length
      ? itemLines.map(t => `<span class="lead-item-chip">${escHtml(t)}</span>`).join('')
      : '';
    const line = (icon, val, clip) => val ? `<div class="lead-card-line${clip ? ' lead-card-line-clip' : ''}"><span>${icon}</span> ${val}</div>` : '';
    return `
      <div class="lead-card ${typeCls}" onclick="openLeadDetail(${l.rowIndex})" tabindex="0"
           onkeydown="if(event.key==='Enter'){openLeadDetail(${l.rowIndex})}">
        <div class="lead-card-head">
          <div class="lead-card-name">${String(l.visibility) === 'private' ? '<span title="Hidden from the team">🙈</span> ' : ''}${escHtml(l.factory_name || l.factory_number || '—')}</div>
          ${typeTag}
        </div>
        ${l.factory_number && l.factory_name ? `<div class="lead-card-num">${escHtml(l.factory_number)}</div>` : ''}
        ${line('👤', person, true)}
        ${line('📦', prod)}
        ${line('📍', escHtml(l.area || ''), true)}
        ${line('📅', l.follow_up ? escHtml(l.follow_up) : '')}
        ${showOwner ? line('🙋', escHtml(l.created_by || ''), true) : ''}
        <div class="lead-card-foot">
          ${state.role === 'guest'
            ? `<span class="lead-card-stage" style="--stg:${stageCol}">${escHtml(l.stage ? stageLabel(l.stage) : '—')}</span>`
            : `<button type="button" class="lead-card-stage lead-card-stage-btn" style="--stg:${stageCol}" title="Tap to change stage"
                 onclick="event.stopPropagation(); openStagePicker(${l.rowIndex})">${escHtml(l.stage ? stageLabel(l.stage) : '—')} ▾</button>`}
        </div>
      </div>`;
  }).join('');
  return `<div class="lead-cards">${cards}</div>`;
}

// ============================================================
//  Lead detail — tap any lead to see everything at a glance
//  (read-first; notes are editable inline, stage is one tap to change)
// ============================================================
function findLead(rowIndex) {
  return state.leads.find(x => String(x.rowIndex) === String(rowIndex))
      || (state.dbLeads || []).find(x => String(x.rowIndex) === String(rowIndex));
}

function openLeadDetail(rowIndex) {
  const l = findLead(rowIndex);
  if (!l) return;
  closeLeadDetail();

  const canEdit  = state.role !== 'guest' && (state.role === 'admin' || l.can_edit !== false);
  const contacts = (l.contacts && l.contacts.length)
    ? l.contacts
    : ((l.person_in_charge || l.contact) ? [{ person_name: l.person_in_charge, contact: l.contact }] : []);
  const items = (l.items && l.items.length)
    ? l.items
    : (l.product ? [{ product: l.product, quantity: l.quantity, rate: l.rate }] : []);

  const stagePills = Object.keys(STAGE_NUMBERS).map(s => {
    const col = STAGE_COLORS[s] || '#64748b';
    const active = l.stage === s;
    return `<button class="ld-stage-pill ${active ? 'active' : ''}" data-stage="${escAttr(s)}" style="--stg:${col}"
      ${canEdit ? `onclick="setLeadStage(${l.rowIndex}, '${escAttr(s)}')"` : 'disabled'}>${escHtml(stageLabel(s))}</button>`;
  }).join('');

  const contactRows = contacts.length ? contacts.map(c => {
    const name  = escHtml(c.person_name || '—');
    const desig = c.designation ? `<span class="ld-desig">${escHtml(c.designation)}</span>` : '';
    const num   = c.contact ? escHtml(c.contact) : '';
    const tel   = c.contact ? `<a href="${escHtml(telHref(c.contact))}" class="ld-tel" title="Call" onclick="event.stopPropagation()">📞</a>` : '';
    const wa    = c.contact ? `<a href="${escHtml(waHref(c.contact, c.person_name))}" class="ld-wa" title="WhatsApp" target="_blank" rel="noopener" onclick="event.stopPropagation()">💬</a>` : '';
    return `<div class="ld-contact"><span class="ld-c-name">${name}</span>${desig}<span class="ld-c-num">${num}</span><span class="ld-c-acts">${tel}${wa}</span></div>`;
  }).join('') : '<div class="ld-empty">No contact added</div>';

  const itemRows = items.length ? items.map(it => {
    const p = escHtml(it.product || '—');
    const q = it.quantity ? `<span class="ld-i-q">${escHtml(it.quantity)}</span>` : '';
    const r = it.rate ? `<span class="ld-i-r">@ ${escHtml(it.rate)}</span>` : '';
    // Tapping a product jumps to the Leads list filtered to that product.
    const jump = it.product
      ? ` role="button" tabindex="0" title="Show all ${escAttr(T('entity').toLowerCase())}s with this ${escAttr(T('product').toLowerCase())}"
          onclick="jumpToProduct('${escAttr(it.product)}')"
          onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();jumpToProduct('${escAttr(it.product)}')}"` : '';
    return `<div class="ld-item${it.product ? ' ld-jump' : ''}"${jump}><span class="ld-i-p">${p}</span><span class="ld-i-meta">${q}${r}</span></div>`;
  }).join('') : '';

  const notes = l.notes ? escHtml(l.notes) : '';
  const lists = (l.lists && l.lists.length)
    ? '<div class="tag-chips">' + l.lists.map(t => {
        const c = listColor(t);
        return `<button type="button" class="tag-chip" style="background:color-mix(in srgb, ${c} 14%, transparent);color:${c};border-color:color-mix(in srgb, ${c} 34%, transparent)"
          title="Show this list in Leads" onclick="jumpToList('${escAttr(String(t.id))}')">${escHtml(t.name)}</button>`;
      }).join('') + '</div>'
    : '';
  const meta  = [
    l.lead_type ? `<div class="ld-field"><span class="ld-k">Type</span><span class="ld-v">${TYPE_EMOJI[l.lead_type] || ''} ${escHtml(l.lead_type)}</span></div>` : '',
    l.area      ? `<div class="ld-field"><span class="ld-k">${escHtml(T('area'))}</span><span class="ld-v">📍 ${escHtml(l.area)}</span></div>` : '',
    l.follow_up ? `<div class="ld-field"><span class="ld-k">Follow-up</span><span class="ld-v"><a class="ld-jump-link" role="button" tabindex="0" title="Open Follow-ups" onclick="jumpToFollowups()">📅 ${escHtml(l.follow_up)}</a></span></div>` : '',
    l.created_by? `<div class="ld-field"><span class="ld-k">Added by</span><span class="ld-v"><a class="ld-jump-link" role="button" tabindex="0" title="Show their leads" onclick="jumpToSalesman('${escAttr(l.created_by)}')">${escHtml(l.created_by)}</a></span></div>` : '',
  ].filter(Boolean).join('');

  const notesBlock = canEdit
    ? `<textarea id="ld-notes-input" class="ld-notes-input" placeholder="Add a note for quick reference…">${notes}</textarea>
       <div class="ld-notes-actions"><button class="btn btn-primary btn-sm ld-notes-save" onclick="saveLeadNotes(${l.rowIndex})">Save note</button></div>`
    : `<div class="ld-notes-view">${notes || '<span class="ld-empty">No notes</span>'}</div>`;

  const html = `
  <div class="lead-detail-overlay" id="lead-detail-overlay" onclick="if(event.target===this)closeLeadDetail()">
    <div class="lead-detail" role="dialog" aria-modal="true" aria-label="Lead details">
      <div class="ld-head">
        <div class="ld-title">
          <div class="ld-name">${String(l.visibility) === 'private' ? '🙈 ' : ''}${escHtml(l.factory_name || l.factory_number || '—')}</div>
          ${l.factory_number && l.factory_name ? `<div class="ld-num">${escHtml(l.factory_number)}</div>` : ''}
        </div>
        <button class="ld-close" onclick="closeLeadDetail()" aria-label="Close">✕</button>
      </div>
      <div class="ld-body">
        <div class="ld-section">
          <div class="ld-label">Stage${canEdit ? ' <span class="ld-hint">— tap to change</span>' : ''}</div>
          <div class="ld-stages">${stagePills}</div>
        </div>
        ${meta ? `<div class="ld-grid">${meta}</div>` : ''}
        ${contacts.length ? `<div class="ld-section">
          <div class="ld-label">Contacts</div>
          ${contactRows}
        </div>` : ''}
        ${items.length ? `<div class="ld-section">
          <div class="ld-label">Products</div>
          ${itemRows}
        </div>` : ''}
        ${lists ? `<div class="ld-section"><div class="ld-label">Lists</div>${lists}</div>` : ''}
        <div class="ld-section">
          <div class="ld-label">📸 ${escHtml(T('entity'))} pics</div>
          <div id="ld-photos" class="ld-photos"><div class="ld-empty">Loading…</div></div>
          ${canEdit ? `<button class="btn btn-secondary btn-sm ld-photo-add" onclick="capturePhotoForLead(${l.rowIndex})">📷 Add ${escHtml(T('entity').toLowerCase())} pic</button>` : ''}
        </div>
        ${(canEdit || notes) ? `<div class="ld-section">
          <div class="ld-label">📝 Notes</div>
          ${notesBlock}
        </div>` : ''}
      </div>
      <div class="ld-foot">
        ${canEdit ? `<button class="btn btn-ghost" onclick="closeLeadDetail(); openEditModal(${l.rowIndex});">✎ Edit full lead</button>` : ''}
        <button class="btn btn-primary" onclick="closeLeadDetail()">Done</button>
      </div>
    </div>
  </div>`;

  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstElementChild);
  document.addEventListener('keydown', ldEscHandler);
  loadLeadPhotos(l.rowIndex);   // async — fills the Factory pics section
}

function ldEscHandler(e) { if (e.key === 'Escape') closeLeadDetail(); }
function closeLeadDetail() {
  const o = document.getElementById('lead-detail-overlay');
  if (o) o.remove();
  document.removeEventListener('keydown', ldEscHandler);
}

// Quick-jump from the lead-detail sheet → the relevant filtered screen. Clear the
// other lead filters first so the jump lands on a clean, predictable view.
function _resetLeadFilters() {
  state.search = ''; state.filterStage = ''; state.filterProduct = '';
  state.filterDivision = ''; state.filterSalesman = ''; state.filterGroup = ''; state.filterList = '';
  const gs = document.getElementById('global-search'); if (gs) gs.value = '';
}
function jumpToList(id)    { closeLeadDetail(); _resetLeadFilters(); state.filterList    = String(id); navigate('leads'); }
function jumpToSalesman(n) { closeLeadDetail(); _resetLeadFilters(); state.filterSalesman = n;         navigate('leads'); }
function jumpToProduct(n)  { closeLeadDetail(); _resetLeadFilters(); state.filterProduct  = n;         navigate('leads'); }
function jumpToFollowups() { closeLeadDetail(); state.fuFilter = 'all'; navigate('followups'); }

// Update just the active-pill highlight inside an open detail sheet without
// rebuilding it (so an unsaved note in the textarea isn't lost on a stage tap).
function refreshLeadDetailStages(activeStage) {
  const cont = document.querySelector('#lead-detail-overlay .ld-stages');
  if (!cont) return;
  cont.querySelectorAll('.ld-stage-pill').forEach(b =>
    b.classList.toggle('active', b.dataset.stage === activeStage));
}

// One-tap stage change — optimistic (updates the UI immediately, rolls back on
// failure). Shared by the detail sheet, the stage picker, and (via updateLead)
// mirrors the kanban drag path.
async function setLeadStage(rowIndex, newStage) {
  const l = state.leads.find(x => String(x.rowIndex) === String(rowIndex));
  if (!l || l.stage === newStage) return;
  const prevStage = l.stage, prevNum = l.stage_number;
  l.stage = newStage;
  l.stage_number = STAGE_NUMBERS[newStage] ?? '';
  refreshLeadDetailStages(newStage);
  renderPage(state.page);
  try {
    await updateLead(rowIndex, { ...l });
    toast(`Stage → ${stageLabel(newStage)}`);
    try { await loadStats(); if (state.page === 'dashboard') renderDashboard(); } catch (_) {}
  } catch (err) {
    l.stage = prevStage; l.stage_number = prevNum;   // rollback
    refreshLeadDetailStages(prevStage);
    renderPage(state.page);
    toast('Stage update failed: ' + err.message, 'error');
  }
}

async function saveLeadNotes(rowIndex) {
  const l = state.leads.find(x => String(x.rowIndex) === String(rowIndex));
  if (!l) return;
  const ta = document.getElementById('ld-notes-input');
  if (!ta) return;
  const val = ta.value;
  const btn = document.querySelector('#lead-detail-overlay .ld-notes-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  try {
    await updateLead(rowIndex, { ...l, notes: val });
    l.notes = val;
    toast('Note saved');
    if (btn) { btn.textContent = 'Saved ✓'; setTimeout(() => { if (btn) { btn.disabled = false; btn.textContent = 'Save note'; } }, 1200); }
    renderPage(state.page);
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Save note'; }
    toast('Could not save note: ' + err.message, 'error');
  }
}

// Compact "change stage" sheet opened by tapping a stage badge in any list.
function openStagePicker(rowIndex) {
  const l = state.leads.find(x => String(x.rowIndex) === String(rowIndex));
  if (!l || state.role === 'guest') return;
  closeStagePicker();
  const pills = Object.keys(STAGE_NUMBERS).map(s => {
    const col = STAGE_COLORS[s] || '#64748b';
    const active = l.stage === s;
    return `<button class="sp-pill ${active ? 'active' : ''}" style="--stg:${col}"
      onclick="closeStagePicker(); setLeadStage(${rowIndex}, '${escAttr(s)}');">${escHtml(stageLabel(s))}</button>`;
  }).join('');
  const html = `
  <div class="stage-picker-overlay" id="stage-picker-overlay" onclick="if(event.target===this)closeStagePicker()">
    <div class="stage-picker" role="dialog" aria-modal="true">
      <div class="sp-head">Move <b>${escHtml(l.factory_name || l.factory_number || 'lead')}</b> to…</div>
      <div class="sp-pills">${pills}</div>
      <button class="btn btn-ghost btn-sm sp-cancel" onclick="closeStagePicker()">Cancel</button>
    </div>
  </div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstElementChild);
  document.addEventListener('keydown', spEscHandler);
}
function spEscHandler(e) { if (e.key === 'Escape') closeStagePicker(); }
function closeStagePicker() {
  const o = document.getElementById('stage-picker-overlay');
  if (o) o.remove();
  document.removeEventListener('keydown', spEscHandler);
}

// ============================================================
//  Factory pics — one-tap camera capture attached to a lead.
//  Uses a native `capture` file input (the OS camera app handles the
//  permission + shutter), downscales client-side, and stores the JPEG as a
//  data-URL in Postgres so it persists across Render redeploys.
// ============================================================
async function loadLeadPhotos(rowIndex) {
  const box = document.getElementById('ld-photos');
  if (!box) return;
  // Demo/unsaved leads have no real row id — nothing to fetch, don't 500.
  if (!Number.isInteger(Number(rowIndex))) { box.innerHTML = `<div class="ld-empty">No ${escHtml(T('entity').toLowerCase())} pics yet.</div>`; return; }
  try {
    const photos = await apiFetch(`/api/leads/${rowIndex}/photos` + orgQuery());
    if (!photos.length) { box.innerHTML = `<div class="ld-empty">No ${escHtml(T('entity').toLowerCase())} pics yet.</div>`; return; }
    const canDel = state.role !== 'guest';
    // Read the data-URL from the <img>'s own src at click time rather than
    // inlining the (hundreds-of-KB base64) string into an onclick attribute.
    box.innerHTML = photos.map(p => `<div class="ld-photo">
        <img src="${escAttr(p.file_path)}" alt="${escAttr(p.caption || 'Factory pic')}" loading="lazy" onclick="viewLeadPhoto(this.src)" />
        ${canDel ? `<button class="ld-photo-del" title="Delete" onclick="event.stopPropagation(); deleteLeadPhoto(${rowIndex}, ${p.id})">✕</button>` : ''}
      </div>`).join('');
  } catch (err) {
    box.innerHTML = `<div class="ld-empty">Couldn't load pics: ${escHtml(err.message)}</div>`;
  }
}

function capturePhotoForLead(rowIndex) {
  // A fresh input each time so re-selecting the same file still fires change.
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.setAttribute('capture', 'environment');   // rear camera on phones
  input.style.display = 'none';
  input.onchange = () => {
    const file = input.files && input.files[0];
    input.remove();
    if (file) handleLeadPhotoFile(rowIndex, file);
  };
  document.body.appendChild(input);
  input.click();
}

// Downscale/compress before upload so a phone's 4–12MP photo becomes a small
// (~1600px, quality .72) JPEG the DB can hold comfortably.
function downscaleImageFile(file, maxDim = 1600, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      if (Math.max(width, height) > maxDim) {
        const s = maxDim / Math.max(width, height);
        width = Math.round(width * s); height = Math.round(height * s);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);   // flatten any alpha
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('That file is not a readable image')); };
    img.src = url;
  });
}

async function handleLeadPhotoFile(rowIndex, file) {
  if (!/^image\//.test(file.type)) { toast('Please choose a photo', 'error'); return; }
  const btn = document.querySelector('.ld-photo-add');
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Uploading…'; }
  try {
    const dataUrl = await downscaleImageFile(file);
    await apiFetch(`/api/leads/${rowIndex}/photos` + orgQuery(), {
      method: 'POST',
      // Stored caption stays a fixed string regardless of business type (display-only sweep — not a UI label).
      body: JSON.stringify({ image: dataUrl, caption: 'Factory pic' }),
    });
    toast(`${T('entity')} pic saved`);
    await loadLeadPhotos(rowIndex);
  } catch (err) {
    toast('Could not save pic: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label || `📷 Add ${T('entity').toLowerCase()} pic`; }
  }
}

async function deleteLeadPhoto(rowIndex, photoId) {
  if (!confirm(`Delete this ${T('entity').toLowerCase()} pic? This cannot be undone.`)) return;
  try {
    await apiFetch(`/api/leads/${rowIndex}/photos/${photoId}` + orgQuery(), { method: 'DELETE' });
    toast('Pic deleted');
    await loadLeadPhotos(rowIndex);
  } catch (err) { toast('Could not delete: ' + err.message, 'error'); }
}

// Full-screen viewer for a tapped pic.
function viewLeadPhoto(src) {
  const ov = document.createElement('div');
  ov.className = 'photo-viewer';
  ov.onclick = () => ov.remove();
  ov.innerHTML = `<img src="${escAttr(src)}" alt="${escHtml(T('entity'))} pic" /><button class="photo-viewer-close" aria-label="Close">✕</button>`;
  document.body.appendChild(ov);
}

// ============================================================
//  Pipeline page
// ============================================================
function renderPipeline() {
  const stageOrder = ['New Lead','Sample Required','Sample Sent','Quotation','Negotiation','Order Won','Repeat Customer','Lost'];
  document.getElementById('pipeline-summary').innerHTML = stageOrder.map(s => {
    const count = state.leads.filter(l => l.stage === s).length;
    const color = STAGE_COLORS[s] || '#64748b';
    return `<div class="pipeline-stat">
      <div class="pipeline-stat-num" style="color:${color}">${count}</div>
      <div class="pipeline-stat-label">${escHtml(stageLabel(s))}</div>
    </div>`;
  }).join('');
  document.getElementById('pipeline-kanban').innerHTML = buildKanban(state.leads, false);
}

// ============================================================
//  Kanban with drag-and-drop
// ============================================================
let dragRowIndex = null;

function buildKanban(leads, draggable = false) {
  const stageOrder = ['New Lead','Sample Required','Sample Sent','Quotation','Negotiation','Order Won','Repeat Customer','Lost'];
  return stageOrder.map(s => {
    const color = STAGE_COLORS[s] || '#64748b';
    const cards = leads.filter(l => l.stage === s);
    const cardHtml = cards.length
      ? cards.map(l => {
          const cardClass = TYPE_CARD_CLASS[l.lead_type] || '';
          const typeTag   = l.lead_type ? `<span class="kanban-type-tag">${TYPE_EMOJI[l.lead_type] || ''} ${escHtml(l.lead_type)}</span>` : '';
          return `
          <div class="kanban-card ${cardClass}"
               ${draggable ? `draggable="true" ondragstart="dragStart(event,${l.rowIndex})"` : ''}
               onclick="openLeadDetail(${l.rowIndex})">
            <div class="kanban-card-name">${escHtml(l.factory_name || l.factory_number || '—')} ${typeTag}</div>
            <div class="kanban-card-meta">${(() => { const n = leadProductNames(l); return n.length ? escHtml(n.slice(0,2).join(', ')) + (n.length > 2 ? ` +${n.length-2}` : '') : ''; })()}</div>
            ${l.follow_up ? `<div class="kanban-card-meta" style="margin-top:4px">📅 ${escHtml(l.follow_up)}</div>` : ''}
            ${l.area ? `<div class="kanban-card-meta">📍 ${escHtml(l.area)}</div>` : ''}
          </div>`;
        }).join('')
      : `<div style="padding:10px;color:#94a3b8;font-size:12px;text-align:center">Empty</div>`;

    const dropAttrs = draggable
      ? `ondragover="dragOver(event)" ondrop="dropCard(event,'${s}')" ondragenter="dragEnter(event)" ondragleave="dragLeave(event)"`
      : '';

    return `<div class="kanban-col">
      <div class="kanban-col-header" style="background:${color}">
        ${escHtml(stageLabel(s))} <span class="kanban-col-count">${cards.length}</span>
      </div>
      <div class="kanban-cards" ${dropAttrs}>${cardHtml}</div>
    </div>`;
  }).join('');
}

function dragStart(event, rowIndex) {
  dragRowIndex = rowIndex;
  event.dataTransfer.effectAllowed = 'move';
}

function dragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
}

function dragEnter(event) {
  event.currentTarget.classList.add('drag-over');
}

function dragLeave(event) {
  event.currentTarget.classList.remove('drag-over');
}

async function dropCard(event, newStage) {
  event.preventDefault();
  event.currentTarget.classList.remove('drag-over');
  if (!dragRowIndex) return;
  const lead = state.leads.find(l => String(l.rowIndex) === String(dragRowIndex));
  dragRowIndex = null;
  if (!lead || lead.stage === newStage) return;

  const stageNum = STAGE_NUMBERS[newStage] ?? '';
  try {
    await updateLead(lead.rowIndex, { ...lead, stage: newStage, stage_number: stageNum });
    toast(`Moved to ${stageLabel(newStage)}`);
    await refresh();
  } catch (err) {
    toast('Stage update failed: ' + err.message, 'error');
  }
}

// ============================================================
//  Today — the daily worklist (what needs action right now)
// ============================================================
function renderToday() {
  // Greeting (same time-of-day logic as the dashboard hero).
  const name  = (localStorage.getItem('crm_user') || '').trim();
  const first = name ? name.split(/[\s._]/)[0].replace(/^\w/, c => c.toUpperCase()) : '';
  const h     = parseInt(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }), 10);
  const part  = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const emoji = h < 12 ? '☀️' : h < 17 ? '👋' : '🌙';
  const g = document.getElementById('today-greeting');
  if (g) g.innerHTML = `${part}${first ? ', ' + escHtml(first) : ''} ${emoji}`;

  const today  = fuToday();
  const active = state.leads.filter(l => l.follow_up && l.stage !== 'Lost');
  const overdue  = active.filter(l => { const d = parseDMY(l.follow_up); return d && d <  today; });
  const dueToday = active.filter(l => { const d = parseDMY(l.follow_up); return d && d.getTime() === today.getTime(); });
  const upcoming = active.filter(l => { const d = parseDMY(l.follow_up); return d && d >  today; });

  const sub = document.getElementById('today-subline');
  if (sub) {
    const dateStr = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'long', day: '2-digit', month: 'short' });
    const n = overdue.length + dueToday.length;
    sub.innerHTML = n
      ? `${dateStr} · <b>${n}</b> ${n === 1 ? 'lead needs' : 'leads need'} a follow-up now`
      : `${dateStr} · You're all caught up — nothing due. 🎉`;
  }

  // Quick-jump chips → the relevant filtered screen.
  const s = state.stats || {};
  const quick = document.getElementById('today-quick');
  if (quick) {
    quick.innerHTML =
      todayChip('📋', overdue.length + dueToday.length, 'Due now',   "state.fuFilter='overdue'; navigate('followups')", overdue.length + dueToday.length ? 'hot' : '') +
      todayChip('🔜', upcoming.length,                  'Upcoming',  "state.fuFilter='week'; navigate('followups')", '') +
      todayChip('🎯', s.active ?? '—',                  'In pipeline', "dashFilter('active')", '') +
      todayChip('🏆', s.won ?? '—',                     'Won',       "dashFilter('won')", '');
  }

  // Body — actionable follow-ups (overdue first, then today), reusing the same
  // Call/WhatsApp/Snooze/Done action cards as the Follow-ups screen.
  const actionable = [...overdue, ...dueToday].sort((a, b) => (parseDMY(a.follow_up) || 0) - (parseDMY(b.follow_up) || 0));
  const body = document.getElementById('today-body');
  if (body) {
    body.innerHTML = actionable.length
      ? buildFollowupCards(actionable)
      : `<div class="today-clear"><div class="today-clear-emoji">🎉</div>
           <div>Nothing needs a follow-up right now.</div>
           <button class="btn btn-ghost btn-sm" onclick="navigate('leads')">Browse all ${escHtml(T('entity').toLowerCase())}s →</button>
         </div>`;
  }
}
function todayChip(icon, value, label, onclick, tone) {
  return `<button type="button" class="today-chip${tone === 'hot' ? ' today-chip-hot' : ''}" onclick="${onclick}">
    <span class="today-chip-ico">${icon}</span>
    <span class="today-chip-val">${escHtml(String(value))}</span>
    <span class="today-chip-lbl">${escHtml(label)}</span>
  </button>`;
}

// ============================================================
//  Follow-ups page
// ============================================================
function renderFollowups() {
  // Keep the filter pills in sync (the Today screen / dashboard can set
  // state.fuFilter before navigating here, so the active pill must reflect
  // state, not just clicks).
  document.querySelectorAll('.followup-filters .pill').forEach(p =>
    p.classList.toggle('active', p.dataset.fu === state.fuFilter));
  const now   = new Date();
  now.setHours(0, 0, 0, 0);
  const week  = new Date(now);
  week.setDate(week.getDate() + 7);

  function parseDate(str) {
    if (!str) return null;
    // Support dd/MM/yyyy from sheet
    const parts = String(str).split('/');
    if (parts.length === 3) {
      const d = new Date(parts[2].slice(0,4), parseInt(parts[1],10)-1, parseInt(parts[0],10));
      return isNaN(d.getTime()) ? null : d;
    }
    // Fallback: try native parse
    const d = new Date(str);
    return isNaN(d.getTime()) ? null : d;
  }

  let filtered = state.leads.filter(l => l.follow_up);
  if (state.fuFilter === 'overdue') {
    filtered = filtered.filter(l => { const d = parseDate(l.follow_up); return d && d < now; });
  } else if (state.fuFilter === 'today') {
    filtered = filtered.filter(l => { const d = parseDate(l.follow_up); return d && d.toDateString() === now.toDateString(); });
  } else if (state.fuFilter === 'week') {
    filtered = filtered.filter(l => { const d = parseDate(l.follow_up); return d && d >= now && d <= week; });
  }
  filtered.sort((a,b) => {
    const da = parseDate(a.follow_up), db = parseDate(b.follow_up);
    return (da || 0) - (db || 0);
  });

  document.getElementById('followup-table').innerHTML = filtered.length
    ? buildFollowupCards(filtered)
    : emptyState('No follow-ups for this filter');
}

// ── Follow-up action cards ──────────────────────────────────
// The follow-up screen is a "who do I contact today" worklist, so each row is a
// card with one-tap actions: Call, WhatsApp, Snooze (push the date), Done (clear
// the reminder). Tapping the card body still opens the full lead detail.
function parseDMY(str) {
  if (!str) return null;
  const p = String(str).split('/');
  if (p.length === 3) {
    const d = new Date(+p[2].slice(0, 4), (+p[1]) - 1, +p[0]);
    d.setHours(0, 0, 0, 0);
    return isNaN(d.getTime()) ? null : d;
  }
  const d = new Date(str);
  if (isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}
function fuToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function fmtDMY(d) {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}
// The contact to dial/message: the lead's primary (person_in_charge + l.contact),
// else the first contact-row that actually has a number — paired with THAT row's
// own name so a WhatsApp greeting always matches the number being opened.
function fuPhoneContact(l) {
  if (l.contact) return { raw: l.contact, name: l.person_in_charge || '' };
  const c = (l.contacts || []).find(x => x && x.contact);
  return c ? { raw: c.contact, name: c.person_name || l.person_in_charge || '' }
           : { raw: '', name: '' };
}
function telHref(raw) {
  const d = String(raw || '').replace(/[^\d+]/g, '');
  return d ? 'tel:' + d : '';
}
// wa.me needs a full international number. Numbers here are India-local (the app
// is ₹ / en-IN / IST), so a bare 10-digit number gets +91; anything already
// carrying a country code (11–13 digits) is left as-is.
function waHref(raw, person) {
  let d = String(raw || '').replace(/\D/g, '').replace(/^0+/, '');
  if (!d) return '';
  if (d.length === 10) d = '91' + d;
  const txt = person ? '?text=' + encodeURIComponent('Hi ' + person + ', ') : '';
  return 'https://wa.me/' + d + txt;
}

// Inline note editing right on the follow-up card — no need to open the detail
// sheet. View shows a snippet (or "＋ Add note"); tapping opens a textarea.
function fuNoteViewHtml(l) {
  const full = l.notes ? String(l.notes) : '';
  const snip = full ? escHtml(full.slice(0, 90)) + (full.length > 90 ? '…' : '') : '';
  return full
    ? `<div class="fu-note fu-note-clickable" role="button" tabindex="0" title="Edit note"
         onclick="fuEditNote(${l.rowIndex})" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();fuEditNote(${l.rowIndex})}">📝 <span class="fu-note-txt">${snip}</span><span class="fu-note-pen">✏️</span></div>`
    : `<button type="button" class="fu-note-add" onclick="fuEditNote(${l.rowIndex})">＋ Add note</button>`;
}
function fuNoteRefresh(rowIndex) {
  const wrap = document.getElementById(`fu-note-${rowIndex}`);
  const l = state.leads.find(x => String(x.rowIndex) === String(rowIndex));
  if (wrap && l) wrap.innerHTML = fuNoteViewHtml(l);
}
function fuEditNote(rowIndex) {
  const wrap = document.getElementById(`fu-note-${rowIndex}`);
  const l = state.leads.find(x => String(x.rowIndex) === String(rowIndex));
  if (!wrap || !l) return;
  wrap.innerHTML = `
    <textarea class="fu-note-input" id="fu-note-input-${rowIndex}" rows="2" placeholder="Add a note…"
      onkeydown="if(event.key==='Enter'&&(event.metaKey||event.ctrlKey)){event.preventDefault();fuSaveNote(${rowIndex})}">${escHtml(l.notes || '')}</textarea>
    <div class="fu-note-actions">
      <button type="button" class="btn btn-primary btn-sm" onclick="fuSaveNote(${rowIndex})">Save</button>
      <button type="button" class="btn btn-ghost btn-sm" onclick="fuNoteRefresh(${rowIndex})">Cancel</button>
    </div>`;
  const ta = document.getElementById(`fu-note-input-${rowIndex}`);
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}
async function fuSaveNote(rowIndex) {
  const l  = state.leads.find(x => String(x.rowIndex) === String(rowIndex));
  const ta = document.getElementById(`fu-note-input-${rowIndex}`);
  if (!l || !ta) return;
  const val = ta.value.trim();
  const prev = l.notes || '';
  if (val === prev) { fuNoteRefresh(rowIndex); return; }
  l.notes = val;
  fuNoteRefresh(rowIndex);                 // optimistic
  try {
    await updateLead(rowIndex, { ...l, notes: val });
    toast('Note saved');
  } catch (err) {
    l.notes = prev; fuNoteRefresh(rowIndex);
    toast('Could not save note: ' + err.message, 'error');
  }
}

function buildFollowupCards(leads) {
  const today = fuToday();
  const cards = leads.map(l => {
    const d = parseDMY(l.follow_up);
    let dueClass = 'fu-future', dueLabel = escHtml(l.follow_up || '—');
    if (d) {
      const diff = Math.round((d - today) / 86400000);
      if      (diff < 0)   { dueClass = 'fu-overdue'; dueLabel = `Overdue ${-diff}d`; }
      else if (diff === 0) { dueClass = 'fu-today';   dueLabel = 'Today'; }
      else if (diff === 1) { dueClass = 'fu-soon';    dueLabel = 'Tomorrow'; }
      else if (diff <= 7)  { dueClass = 'fu-soon';    dueLabel = `In ${diff}d`; }
      else                 { dueClass = 'fu-future';  dueLabel = escHtml(l.follow_up); }
    }
    const name = escHtml(l.factory_name || l.factory_number || '—');
    const sub  = [
      (l.factory_number && l.factory_name) ? escHtml(l.factory_number) : '',
      escHtml(l.person_in_charge || ''),
    ].filter(Boolean).join(' · ');
    const pc   = fuPhoneContact(l);
    const tel  = telHref(pc.raw);
    const wa   = waHref(pc.raw, pc.name);
    const prods = leadProductNames(l).slice(0, 2).join(', ');
    const mid  = [stageBadge(l), prods ? escHtml(prods) : ''].filter(Boolean).join('<span class="fu-dot">·</span>');
    return `
    <div class="fu-card ${dueClass}" role="button" tabindex="0"
         onclick="openLeadDetail(${l.rowIndex})"
         onkeydown="if((event.key==='Enter'||event.key===' ')&&event.target===event.currentTarget){event.preventDefault();openLeadDetail(${l.rowIndex})}">
      <div class="fu-card-top">
        <div class="fu-card-id">
          <div class="fu-name">${name}</div>
          ${sub ? `<div class="fu-sub">${sub}</div>` : ''}
        </div>
        <div class="fu-due ${dueClass}">${dueLabel}</div>
      </div>
      <div class="fu-card-mid">${mid}</div>
      <div class="fu-note-wrap" id="fu-note-${l.rowIndex}" onclick="event.stopPropagation()">${fuNoteViewHtml(l)}</div>
      <div class="fu-actions" onclick="event.stopPropagation()">
        ${tel ? `<a class="fu-act fu-call" href="${escHtml(tel)}">📞 Call</a>`
              : `<span class="fu-act fu-call fu-disabled" title="No phone number">📞 Call</span>`}
        ${wa  ? `<a class="fu-act fu-wa" href="${escHtml(wa)}" target="_blank" rel="noopener">💬 WhatsApp</a>`
              : `<span class="fu-act fu-wa fu-disabled" title="No phone number">💬 WhatsApp</span>`}
        <button class="fu-act fu-snoozebtn" onclick="openSnoozeMenu(${l.rowIndex}, event)">⏰ Snooze</button>
        <button class="fu-act fu-donebtn" onclick="followupDone(${l.rowIndex})">✅ Done</button>
      </div>
    </div>`;
  }).join('');
  return `<div class="fu-list">${cards}</div>`;
}

// Clear the reminder — the lead stays, it just drops off the follow-up worklist.
async function followupDone(rowIndex) {
  const l = state.leads.find(x => String(x.rowIndex) === String(rowIndex));
  if (!l) return;
  const prev = l.follow_up;
  if (!prev) return;
  l.follow_up = '';
  renderPage(state.page);                 // optimistic — card leaves the list
  try {
    await updateLead(rowIndex, { ...l, follow_up: '' });
    toast('Follow-up marked done ✓');
    try { await loadStats(); } catch (_) {}
  } catch (err) {
    l.follow_up = prev; renderPage(state.page);
    toast('Could not update: ' + err.message, 'error');
  }
}

// Push (or pull) the follow-up to a specific day.
async function setFollowupDate(rowIndex, dmy) {
  const l = state.leads.find(x => String(x.rowIndex) === String(rowIndex));
  if (!l || !dmy) return;
  const prev = l.follow_up;
  l.follow_up = dmy;
  renderPage(state.page);
  try {
    await updateLead(rowIndex, { ...l, follow_up: dmy });
    toast('Follow-up → ' + dmy);
  } catch (err) {
    l.follow_up = prev; renderPage(state.page);
    toast('Could not reschedule: ' + err.message, 'error');
  }
}
function snoozeFollowup(rowIndex, days) {
  const base = fuToday();
  base.setDate(base.getDate() + days);
  closeSnoozeMenu();
  setFollowupDate(rowIndex, fmtDMY(base));
}
function snoozeToPicked(rowIndex, isoVal) {
  if (!isoVal) return;
  closeSnoozeMenu();
  setFollowupDate(rowIndex, isoToddmmyyyy(isoVal));
}
function openSnoozeMenu(rowIndex, ev) {
  if (ev) ev.stopPropagation();
  closeSnoozeMenu();
  const minIso = fmtDMY(fuToday()).split('/').reverse().join('-');   // today as yyyy-mm-dd
  const html = `
  <div class="up-overlay" id="fu-snooze" onclick="if(event.target===this)closeSnoozeMenu()">
    <div class="up-box fu-snooze-box" role="dialog" aria-modal="true" aria-label="Reschedule follow-up">
      <button class="up-close" onclick="closeSnoozeMenu()" aria-label="Close">✕</button>
      <div class="up-head"><div class="up-kicker">Follow-up</div><h2 class="up-title">⏰ Reschedule to…</h2></div>
      <div class="fu-snooze-opts">
        <button class="fu-snooze-opt" onclick="snoozeFollowup(${rowIndex}, 1)">Tomorrow</button>
        <button class="fu-snooze-opt" onclick="snoozeFollowup(${rowIndex}, 3)">In 3 days</button>
        <button class="fu-snooze-opt" onclick="snoozeFollowup(${rowIndex}, 7)">Next week</button>
        <button class="fu-snooze-opt" onclick="snoozeFollowup(${rowIndex}, 14)">In 2 weeks</button>
      </div>
      <div class="fu-snooze-pick">
        <label for="fu-snooze-date">Or pick a date</label>
        <input type="date" id="fu-snooze-date" min="${minIso}" onchange="snoozeToPicked(${rowIndex}, this.value)">
      </div>
    </div>
  </div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstElementChild);
  // Focus + Escape-to-close, matching every other overlay in the app.
  _snoozeOpener = (ev && ev.currentTarget) || document.activeElement;
  document.addEventListener('keydown', snoozeEscHandler);
  document.querySelector('#fu-snooze .fu-snooze-opt')?.focus();
}
let _snoozeOpener = null;
function snoozeEscHandler(e) { if (e.key === 'Escape') closeSnoozeMenu(); }
function closeSnoozeMenu() {
  const el = document.getElementById('fu-snooze');
  if (!el) return;
  el.remove();
  document.removeEventListener('keydown', snoozeEscHandler);
  if (_snoozeOpener && typeof _snoozeOpener.focus === 'function') _snoozeOpener.focus();
  _snoozeOpener = null;
}

// ============================================================
//  Reports page
// ============================================================
function renderReports() {
  const s = state.stats;
  if (!s || !s.by_stage) return;

  // Conversion Funnel — horizontal bar with % in tooltip. Keys stay canonical
  // for the by_stage/STAGE_COLORS lookups; only the chart's labels are relabeled.
  const stageOrder   = ['New Lead','Sample Required','Sample Sent','Quotation','Negotiation','Order Won','Repeat Customer','Lost'];
  const funnelKeys   = stageOrder.filter(st => s.by_stage[st]);
  const funnelLabels = funnelKeys.map(stageLabel);
  const funnelData   = funnelKeys.map(st => s.by_stage[st]);
  const funnelTotal  = funnelData.reduce((a,b) => a + b, 0);
  renderChart('chart-funnel', 'hbar', funnelLabels, funnelData,
    funnelKeys.map(st => STAGE_COLORS[st] || '#94a3b8'),
    {
      label: 'Leads',
      tooltipCallbacks: {
        label: ctx => ` ${ctx.raw} leads  (${funnelTotal ? Math.round(ctx.raw / funnelTotal * 100) : 0}% of pipeline)`,
      },
    }
  );

  // Product Mix — doughnut
  const prodLabels = Object.keys(s.by_product || {});
  const prodData   = prodLabels.map(k => s.by_product[k]);
  renderChart('chart-mix', 'doughnut', prodLabels, prodData,
    ['#3b82f6','#8b5cf6','#10b981','#f59e0b','#ef4444','#06b6d4'],
    { centerText: { value: prodLabels.length, label: 'products' } }
  );

  // Revenue by Product — horizontal bar, ₹ formatted tooltip
  const rev        = s.by_product_revenue || {};
  const revEntries = Object.entries(rev).filter(([,v]) => v > 0).sort(([,a],[,b]) => b - a);
  if (revEntries.length) {
    renderChart('chart-revenue', 'hbar',
      revEntries.map(([k]) => k),
      revEntries.map(([,v]) => Math.round(v)),
      ['#10b981','#3b82f6','#8b5cf6','#f59e0b','#ef4444','#06b6d4'],
      {
        label: 'Revenue (₹)',
        tooltipCallbacks: {
          label: ctx => ` ₹${Number(ctx.raw).toLocaleString('en-IN')}`,
        },
      }
    );
  }

  // Area Distribution — horizontal bar
  const areaDist = getAreaDistribution();
  const areaCard = document.getElementById('chart-area')?.closest('.card');
  if (areaDist.length) {
    if (areaCard) areaCard.style.display = '';
    renderChart('chart-area', 'hbar',
      areaDist.map(([k]) => k),
      areaDist.map(([,v]) => v),
      ['#6366f1','#3b82f6','#8b5cf6','#10b981','#f59e0b','#ef4444','#06b6d4','#14b8a6']
    );
  } else if (areaCard) {
    areaCard.style.display = 'none';
  }

  // Win / Loss summary
  const rate = s.total ? Math.round((s.won / s.total) * 100) : 0;
  const fu   = computeFollowupStats();
  document.getElementById('win-loss-summary').innerHTML = `
    <div class="win-loss-grid">
      <div class="wl-cell">
        <div class="wl-num wl-green">${s.won}</div>
        <div class="wl-label">Won (${escHtml(stageLabel('Order Won'))} + Repeat)</div>
      </div>
      <div class="wl-cell">
        <div class="wl-num wl-red">${s.lost}</div>
        <div class="wl-label">${escHtml(stageLabel('Lost'))}</div>
      </div>
      <div class="wl-cell">
        <div class="wl-num wl-amber">${rate}%</div>
        <div class="wl-label">Win Rate</div>
      </div>
      <div class="wl-cell">
        <div class="wl-num wl-blue">${fu.rate}%</div>
        <div class="wl-label">Follow-up Success (${fu.successful}/${fu.total})</div>
      </div>
    </div>`;
}

function computeFollowupStats() {
  const today = new Date();
  today.setHours(0,0,0,0);

  const past = state.leads.filter(l => {
    if (!l.follow_up) return false;
    const parts = String(l.follow_up).split('/');
    if (parts.length < 3) return false;
    const d = new Date(parts[2].slice(0,4), parseInt(parts[1],10)-1, parseInt(parts[0],10));
    d.setHours(0,0,0,0);
    return !isNaN(d.getTime()) && d < today;
  });

  const successful = past.filter(l => {
    const n = parseInt(l.stage_number, 10);
    return !isNaN(n) && n >= 2 && n !== 0;
  });

  const rate = past.length ? Math.round((successful.length / past.length) * 100) : 0;
  return { total: past.length, successful: successful.length, rate };
}

function getMonthlyTrend() {
  const counts = {};
  for (const l of state.leads) {
    if (!l.last_updated) continue;
    const parts = l.last_updated.split('/');
    if (parts.length < 3) continue;
    const key = `${parts[1].padStart(2,'0')}/${parts[2].slice(0,4)}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort(([a],[b]) => {
    const [am, ay] = a.split('/');
    const [bm, by] = b.split('/');
    return new Date(ay, am - 1) - new Date(by, bm - 1);
  });
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return {
    labels: sorted.map(([k]) => { const [m, y] = k.split('/'); return `${months[parseInt(m,10)-1]} ${y}`; }),
    data:   sorted.map(([,v]) => v),
  };
}

function getAreaDistribution() {
  const counts = {};
  for (const l of state.leads) {
    const area = (l.area || '').trim();
    if (!area) continue;
    counts[area] = (counts[area] || 0) + 1;
  }
  return Object.entries(counts).sort(([,a],[,b]) => b - a).slice(0, 8);
}

// ============================================================
//  Team page (admin only)
// ============================================================
async function renderTeam() {
  if (state.role !== 'admin') {
    document.getElementById('team-table').innerHTML = emptyState('Admin access required');
    return;
  }
  try {
    const users      = await apiFetch('/api/users');
    const myId       = parseInt(localStorage.getItem('crm_user_id') || '0', 10);
    const adminCount = users.filter(u => u.role === 'admin').length;
    const header = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px">
        <span style="font-size:15px;font-weight:600;color:var(--text)">Manage Team (${users.length})</span>
        <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">
          <button class="action-btn" title="Force every account to set a new password on next login — existing passwords/PINs still work to sign in, they just can't skip past the new-password step" onclick="requireAllPasswordChange()">🔒 Require Password Change (All)</button>
          <button class="btn btn-primary" style="font-size:13px;padding:6px 14px" onclick="openAddMemberModal()">+ Add Member</button>
        </div>
      </div>`;
    if (!users.length) {
      document.getElementById('team-table').innerHTML = header + emptyState('No team members yet. Add one above, or ask salespeople to use Create Account on the login page.');
      return;
    }
    const rows = users.map(u => {
      const isSelf     = u.id === myId;
      const isLastAdmin = u.role === 'admin' && adminCount <= 1;
      const nm = escAttr(u.display_name);
      const roleSel = `
        <select class="team-role-select" ${isLastAdmin ? 'disabled title="Promote another admin before changing the last admin"' : ''}
                onchange="changeUserRole(${u.id}, this.value, '${nm}')">
          <option value="sales" ${u.role === 'sales' ? 'selected' : ''}>Sales</option>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
        </select>`;
      const desig = `<input type="text" class="team-desig-input" value="${escAttr(u.designation || '')}"
                       placeholder="—" maxlength="60" onchange="changeUserDesignation(${u.id}, this.value)" />`;
      const area = `<input type="text" class="team-area-input" value="${escAttr(u.default_area || '')}"
                       placeholder="—" maxlength="60" title="Default area — pre-fills when this salesperson adds a lead"
                       onchange="changeUserArea(${u.id}, this.value)" />`;
      const pinBadge = u.has_password ? '' :
        `<span class="badge badge-3" title="Signs in with PIN — will be asked to set a password" style="margin-left:6px">PIN only</span>`;
      const pendingBadge = u.must_change_password ?
        `<span class="badge badge-4" title="Will be asked to set a new password next time they sign in" style="margin-left:6px">⏳ Reset pending</span>` : '';
      const requireBtn = `<button class="action-btn" onclick="toggleMustChangePassword(${u.id}, ${u.must_change_password ? 'true' : 'false'}, '${nm}')">${u.must_change_password ? 'Cancel Reset' : 'Require Reset'}</button>`;
      return `
      <tr>
        <td style="font-weight:500">${escAttr(u.display_name)}${isSelf ? ' <span style="color:var(--text-muted);font-size:11px">(you)</span>' : ''}${pinBadge}${pendingBadge}</td>
        <td>${roleSel}</td>
        <td>${desig}</td>
        <td>${area}</td>
        <td style="color:var(--text-muted);font-size:12px">${u.created_at ? u.created_at.split(' ')[0] : '—'}</td>
        <td style="display:flex;gap:6px;align-items:center;white-space:nowrap">
          <button class="action-btn" onclick="openResetPasswordModal(${u.id}, '${nm}')">Reset Password</button>
          ${requireBtn}
          ${isSelf ? '' : `<button class="action-btn del" onclick="removeTeamMember(${u.id}, '${nm}')">Remove</button>`}
        </td>
      </tr>`;
    }).join('');
    document.getElementById('team-table').innerHTML = header + `
      <div class="table-scroll"><table class="crm-table">
        <thead><tr>
          <th>Name</th><th>Role</th><th>Designation</th><th>Area</th><th>Joined</th><th>Action</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <p style="margin-top:10px;font-size:12px;color:var(--text-muted)">Salespeople can self-register via the <b>Create Account</b> link on the login page. <b>Area</b> pre-fills when that person adds a lead; they can still change it. Only admins can change roles.</p>
      <div id="ai-vocab-container"></div>`;
    renderVocabAdmin();
  } catch (err) {
    document.getElementById('team-table').innerHTML = emptyState('Failed to load team: ' + err.message);
  }
}

async function changeUserRole(id, role, name) {
  const label = role === 'admin' ? 'Admin' : 'Sales';
  if (!confirm(`Change ${name}'s role to ${label}?`)) { renderTeam(); return; }
  try {
    await apiFetch(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify({ role }) });
    toast(`${name} is now ${label}`, 'success');
    renderTeam();
  } catch (err) {
    toast(err.message, 'error');
    renderTeam();   // revert the dropdown to the server's truth
  }
}

async function changeUserDesignation(id, value) {
  try {
    await apiFetch(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify({ designation: value }) });
    toast('Designation saved', 'success');
  } catch (err) {
    toast(err.message, 'error');
    renderTeam();
  }
}

async function changeUserArea(id, value) {
  try {
    await apiFetch(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify({ default_area: value }) });
    toast('Area allocated', 'success');
  } catch (err) {
    toast(err.message, 'error');
    renderTeam();
  }
}

async function toggleMustChangePassword(id, currentlyPending, name) {
  const willRequire = !currentlyPending;
  const msg = willRequire
    ? `Require ${name} to set a new password next time they sign in? Their current password/PIN still works to log in — they just can't skip past the new-password step.`
    : `Cancel the pending password reset for ${name}?`;
  if (!confirm(msg)) return;
  try {
    await apiFetch(`/api/users/${id}`, { method: 'PATCH', body: JSON.stringify({ must_change_password: willRequire }) });
    toast(willRequire ? `${name} will be asked to set a new password` : `Reset cancelled for ${name}`, 'success');
    renderTeam();
  } catch (err) {
    toast(err.message, 'error');
    renderTeam();
  }
}

async function requireAllPasswordChange() {
  if (!confirm('Require EVERY team member — including admins — to set a new password next time they sign in?\n\nNobody is locked out: everyone keeps their current password/PIN to log in, they just can\'t skip past the new-password step afterward.')) return;
  try {
    const res = await apiFetch('/api/users/require-password-change-all', { method: 'POST' });
    toast(`Password reset required for ${res.count} account${res.count === 1 ? '' : 's'}`, 'success');
    renderTeam();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function openResetPasswordModal(userId, userName) {
  let overlay = document.getElementById('reset-pw-overlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'reset-pw-overlay';
  overlay.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;background:rgba(0,0,0,0.55);z-index:1000;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML = `
    <div style="background:var(--card-bg);border-radius:12px;padding:24px;width:340px;max-width:95vw;box-shadow:0 8px 32px rgba(0,0,0,0.4)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <h3 style="margin:0;font-size:15px;color:var(--text)">Reset Password — ${escHtml(userName)}</h3>
        <button onclick="document.getElementById('reset-pw-overlay').remove()" class="icon-btn">✕</button>
      </div>
      <p style="font-size:12px;color:var(--text-muted);margin:0 0 14px;line-height:1.5">Set a temporary password and share it with ${escHtml(userName)}. They can change it from their profile after signing in.</p>
      <div class="form-group" style="margin-bottom:12px">
        <label>New Password <span style="font-weight:400;color:var(--text-muted)">(min 8 chars)</span></label>
        <input id="rpw-pw" type="password" placeholder="min 8 chars, letters + numbers" style="width:100%" autofocus />
      </div>
      <div class="form-group" style="margin-bottom:16px">
        <label>Confirm Password</label>
        <input id="rpw-pw2" type="password" placeholder="Re-enter password" style="width:100%" />
      </div>
      <p id="rpw-error" style="color:var(--danger);font-size:13px;margin:0 0 12px;min-height:18px"></p>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-ghost" onclick="document.getElementById('reset-pw-overlay').remove()">Cancel</button>
        <button class="btn btn-primary" id="rpw-btn" onclick="submitResetPassword(${userId}, '${escAttr(userName)}')">Set Password</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

async function submitResetPassword(userId, userName) {
  const pw    = document.getElementById('rpw-pw').value;
  const pw2   = document.getElementById('rpw-pw2').value;
  const errEl = document.getElementById('rpw-error');
  const btn   = document.getElementById('rpw-btn');
  errEl.textContent = '';
  const pwErr = getPasswordError(pw);
  if (pwErr)          { errEl.textContent = pwErr; return; }
  if (pw !== pw2)     { errEl.textContent = 'Passwords do not match'; return; }
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    await apiFetch(`/api/users/${userId}/password`, { method: 'PATCH', body: JSON.stringify({ password: pw }) });
    document.getElementById('reset-pw-overlay').remove();
    toast(`Password reset for ${userName}. Share it with them securely.`, 'success');
  } catch (err) {
    errEl.textContent = err.message;
    btn.disabled = false; btn.textContent = 'Set Password';
  }
}

async function removeTeamMember(id, name) {
  if (!confirm(`Remove "${name}" from team? They will lose dashboard access.`)) return;
  try {
    await apiFetch(`/api/users/${id}`, { method: 'DELETE' });
    toast(`${name} removed`);
    renderTeam();
  } catch (err) {
    toast('Remove failed: ' + err.message, 'error');
  }
}

function openAddMemberModal() {
  let overlay = document.getElementById('add-member-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'add-member-overlay';
    overlay.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;background:rgba(0,0,0,0.55);z-index:1000;display:flex;align-items:center;justify-content:center';
    overlay.innerHTML = `
      <div style="background:var(--card);border-radius:12px;padding:24px;width:340px;max-width:95vw;box-shadow:0 8px 32px rgba(0,0,0,0.4)">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px">
          <h3 style="margin:0;font-size:16px;color:var(--text)">Add Team Member</h3>
          <button onclick="document.getElementById('add-member-overlay').remove()" class="icon-btn">✕</button>
        </div>
        <div class="form-group" style="margin-bottom:12px">
          <label>Name</label>
          <input id="am-name" type="text" placeholder="e.g. Raj Kumar" style="width:100%" />
        </div>
        <div class="form-group" style="margin-bottom:12px">
          <label>PIN <span style="font-weight:400;color:var(--text-muted)">(4–6 digits)</span></label>
          <input id="am-pin" type="password" placeholder="••••••" inputmode="numeric" maxlength="6" style="width:100%" />
        </div>
        <div class="form-group" style="margin-bottom:16px">
          <label>Role</label>
          <select id="am-role" style="width:100%;padding:8px;border-radius:6px;border:1px solid var(--border);background:var(--input-bg);color:var(--text)">
            <option value="sales">Sales</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <p id="am-error" style="color:var(--danger);font-size:13px;margin:0 0 10px;min-height:18px"></p>
        <div id="am-success" style="display:none;background:var(--success-bg,#0a2a1a);border:1px solid var(--success);border-radius:8px;padding:10px 12px;margin-bottom:12px;font-size:13px;color:var(--success)"></div>
        <div style="display:flex;gap:8px;justify-content:flex-end">
          <button class="btn btn-ghost" onclick="document.getElementById('add-member-overlay').remove()">Cancel</button>
          <button class="btn btn-primary" onclick="submitAddMember()">Create Login</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
  } else {
    overlay.style.display = 'flex';
    document.getElementById('am-name').value = '';
    document.getElementById('am-pin').value  = '';
    document.getElementById('am-role').value = 'sales';
    document.getElementById('am-error').textContent = '';
    document.getElementById('am-success').style.display = 'none';
  }
}

async function submitAddMember() {
  const name  = document.getElementById('am-name').value.trim();
  const pin   = document.getElementById('am-pin').value.trim();
  const role  = document.getElementById('am-role').value;
  const errEl = document.getElementById('am-error');
  const sucEl = document.getElementById('am-success');
  errEl.textContent = '';
  sucEl.style.display = 'none';
  if (name.length < 2)          { errEl.textContent = 'Name must be at least 2 characters'; return; }
  if (!/^\d{4,6}$/.test(pin))   { errEl.textContent = 'PIN must be 4–6 digits'; return; }
  try {
    await apiFetch('/api/users', { method: 'POST', body: JSON.stringify({ name, pin, role }) });
    sucEl.innerHTML = `<b>${escAttr(name)}</b> created!<br>Login: <b>${escAttr(name)}</b> &nbsp;|&nbsp; PIN: <b>${escAttr(pin)}</b><br><span style="font-size:11px;opacity:0.8">Share these credentials with them</span>`;
    sucEl.style.display = 'block';
    document.getElementById('am-name').value = '';
    document.getElementById('am-pin').value  = '';
    renderTeam();
  } catch (err) {
    errEl.textContent = err.message;
  }
}

// ============================================================
//  Profile Modal
// ============================================================
async function openProfileModal() {
  document.getElementById('p-pin').value  = '';
  document.getElementById('p-pin2').value = '';
  document.getElementById('profile-error').textContent = '';
  document.getElementById('p-default-area').value = localStorage.getItem('crm_default_area') || '';
  try {
    const me = await apiFetch('/api/users/me');
    state.me = me;
    document.getElementById('p-name').value = me.display_name || '';
    // Server value wins — default area follows the account across devices
    if (me.default_area != null && me.default_area !== '') {
      document.getElementById('p-default-area').value = me.default_area;
      localStorage.setItem('crm_default_area', me.default_area);
    }
  } catch (_) {
    document.getElementById('p-name').value = localStorage.getItem('crm_user') || '';
  }
  renderProfileBizFields();
  const referBox = document.getElementById('profile-refer');
  if (referBox) {
    referBox.classList.toggle('hidden', state.role === 'guest');
    if (state.role !== 'guest') loadReferralBlock('profile-refer', 'profile-refer-link', 'profile-refer-meta');
  }
  updateBubbleToggleLabel();
  const _codesAdmin = document.getElementById('settings-codes-admin');
  if (_codesAdmin) _codesAdmin.classList.toggle('hidden', state.role !== 'admin');
  const _codeMsg = document.getElementById('settings-code-msg'); if (_codeMsg) _codeMsg.textContent = '';
  const _codeInput = document.getElementById('settings-code-input'); if (_codeInput) _codeInput.value = '';
  document.getElementById('profile-modal-overlay').classList.remove('hidden');
}

function closeProfileModal() {
  document.getElementById('profile-modal-overlay').classList.add('hidden');
}

// Business-type picker inside the Profile modal — this is the PERSONAL
// workspace's profile (state.me), independent of whatever team is active.
function renderProfileBizFields() {
  const sel = document.getElementById('profile-biz');
  if (!sel) return;
  const type = (state.me && BUSINESS_KEYS.includes(state.me.business_type)) ? state.me.business_type : 'factory';
  sel.innerHTML = BUSINESS_KEYS.map(k =>
    `<option value="${k}" ${k === type ? 'selected' : ''}>${escHtml(BUSINESS_TYPES[k].icon + ' ' + BUSINESS_TYPES[k].label)}</option>`
  ).join('');
  let custom = {};
  try { custom = (state.me && state.me.business_custom) ? JSON.parse(state.me.business_custom) : {}; } catch (_) {}
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)) custom = {};   // JSON.parse('null') hazard
  const cBase = BUSINESS_TYPES.custom;
  document.getElementById('profile-biz-entity').value  = custom.entity  || cBase.entity;
  document.getElementById('profile-biz-code').value    = custom.code    || cBase.terms.code;
  document.getElementById('profile-biz-name').value    = custom.name    || cBase.terms.name;
  document.getElementById('profile-biz-person').value  = custom.person  || cBase.terms.person;
  document.getElementById('profile-biz-product').value = custom.product || cBase.terms.product;
  document.getElementById('profile-biz-area').value    = custom.area    || cBase.terms.area;
  // Plural: blank means "derive from entity" (resolveBizProfile falls back to
  // the entity word) — the placeholder just suggests the obvious form.
  const pluralEl = document.getElementById('profile-biz-plural');
  if (pluralEl) {
    pluralEl.value = custom.entityPlural || '';
    pluralEl.placeholder = (custom.entity || cBase.entity) + 's';
  }
  // Optional stage renames — blank input = keep the canonical name.
  const stageOv = (custom.stages && typeof custom.stages === 'object' && !Array.isArray(custom.stages)) ? custom.stages : {};
  document.querySelectorAll('#profile-biz-custom .profile-biz-stage').forEach(inp => {
    inp.value = typeof stageOv[inp.dataset.stage] === 'string' ? stageOv[inp.dataset.stage] : '';
  });
  toggleProfileBizCustom();
}

function toggleProfileBizCustom() {
  const sel = document.getElementById('profile-biz');
  const wrap = document.getElementById('profile-biz-custom');
  if (sel && wrap) wrap.classList.toggle('hidden', sel.value !== 'custom');
}

async function handleProfileSubmit(e) {
  e.preventDefault();
  const name  = document.getElementById('p-name').value.trim();
  const pin   = document.getElementById('p-pin').value.trim();
  const pin2  = document.getElementById('p-pin2').value.trim();
  const errEl = document.getElementById('profile-error');
  errEl.textContent = '';
  if (!name) { errEl.textContent = 'Name cannot be empty'; return; }
  if (pin && pin !== pin2) { errEl.textContent = 'PINs do not match'; return; }
  if (pin && !/^\d{4,6}$/.test(pin)) { errEl.textContent = 'PIN must be 4–6 digits'; return; }
  const defaultArea = document.getElementById('p-default-area').value.trim();
  localStorage.setItem('crm_default_area', defaultArea);
  const businessType = document.getElementById('profile-biz')?.value || 'factory';
  const cBase = BUSINESS_TYPES.custom;
  let businessCustom = null;
  if (businessType === 'custom') {
    const bc = {
      entity:  (document.getElementById('profile-biz-entity').value  || '').trim() || cBase.entity,
      code:    (document.getElementById('profile-biz-code').value    || '').trim() || cBase.terms.code,
      name:    (document.getElementById('profile-biz-name').value    || '').trim() || cBase.terms.name,
      person:  (document.getElementById('profile-biz-person').value  || '').trim() || cBase.terms.person,
      product: (document.getElementById('profile-biz-product').value || '').trim() || cBase.terms.product,
      area:    (document.getElementById('profile-biz-area').value    || '').trim() || cBase.terms.area,
    };
    const plural = (document.getElementById('profile-biz-plural')?.value || '').trim();
    if (plural) bc.entityPlural = plural.slice(0, 30);
    // Stage renames: only non-blank entries, keys exactly canonical, ≤30 chars.
    // Omitting `stages` entirely (all blank) clears any previous overrides.
    const stages = {};
    document.querySelectorAll('#profile-biz-custom .profile-biz-stage').forEach(inp => {
      const v = (inp.value || '').trim();
      if (v && STAGE_NUMBERS[inp.dataset.stage] !== undefined) stages[inp.dataset.stage] = v.slice(0, 30);
    });
    if (Object.keys(stages).length) bc.stages = stages;
    businessCustom = JSON.stringify(bc);
  }
  try {
    const result = await apiFetch('/api/users/me/profile', {
      method: 'PATCH',
      body: JSON.stringify({ display_name: name, default_area: defaultArea, ...(pin ? { pin } : {}) }),
    });
    if (result.token) {
      localStorage.setItem('crm_token', result.token);
      localStorage.setItem('crm_user',  result.username);
      localStorage.setItem('crm_role',  result.role);
      state.role = result.role;
    }
    // The server preserves the existing business_custom when businessCustom is
    // omitted (switching away from 'custom' doesn't erase saved terms), and
    // echoes back the authoritative values — trust its response as-is rather
    // than re-deriving business_custom locally.
    const bizResult = await apiFetch('/api/me/business', {
      method: 'PATCH',
      body: JSON.stringify({ businessType, ...(businessCustom ? { businessCustom } : {}) }),
    });
    state.me = { ...(state.me || {}), ...(bizResult || {}) };
    applyRoleUI();
    closeProfileModal();
    toast('Profile updated!');
    renderPage(state.page);
  } catch (err) {
    errEl.textContent = err.message;
  }
}

// ============================================================
//  Lead Access — sharing & requesting
// ============================================================
async function requestLeadAccess(rowIndex) {
  const lead = state.leads.find(l => String(l.rowIndex) === String(rowIndex));
  const name = lead ? (lead.factory_name || lead.factory_number || `Lead #${rowIndex}`) : `Lead #${rowIndex}`;
  const message = prompt(`Request edit access to "${name}" from ${lead?.created_by || 'the owner'}?\n\nOptional message:`, '');
  if (message === null) return;
  try {
    await apiFetch(`/api/leads/${rowIndex}/request-access`, { method: 'POST', body: JSON.stringify({ message }) });
    toast('Access request sent to the lead owner');
  } catch (err) { toast(err.message, 'error'); }
}

async function grantAccess(leadId, userName) {
  try {
    await apiFetch(`/api/leads/${leadId}/access`, { method: 'POST', body: JSON.stringify({ user_display_name: userName }) });
    toast(`Access granted to ${userName}`);
    openEditModal(leadId);
  } catch (err) { toast('Failed: ' + err.message, 'error'); }
}

async function revokeAccess(leadId, userName) {
  try {
    await apiFetch(`/api/leads/${leadId}/access/${encodeURIComponent(userName)}`, { method: 'DELETE' });
    toast(`Access revoked from ${userName}`);
    openEditModal(leadId);
  } catch (err) { toast('Failed: ' + err.message, 'error'); }
}

// ============================================================
//  Modal — Add / Edit
// ============================================================
const FIELDS = ['factory_number','factory_name','stage','follow_up','area','notes','lead_type'];

// ── Contacts editor ──────────────────────────────────────────
function renderContactsEditor(contacts) {
  const editor = document.getElementById('contacts-editor');
  if (!editor) return;
  const rows = (contacts && contacts.length)
    ? contacts.map(c => ({ person_name: c.person_name || '', contact: c.contact || '', designation: c.designation || '' }))
    : [{ person_name: '', contact: '', designation: '' }];
  const personPh = escHtml(T('person'));
  editor.innerHTML = rows.map((c, i) => `
    <div class="contact-row" data-idx="${i}">
      <input type="text" class="c-name" placeholder="${personPh}" value="${escAttr(c.person_name)}" />
      <input type="tel" class="c-phone" placeholder="Phone" value="${escAttr(c.contact)}" />
      <input type="text" class="c-desig" placeholder="Role (optional)" value="${escAttr(c.designation)}" />
      ${i > 0 ? `<button type="button" class="remove-contact" onclick="removeContactRow(this)">✕</button>` : '<span class="contact-row-spacer"></span>'}
    </div>`).join('');
}

function addContactRow() {
  const editor = document.getElementById('contacts-editor');
  if (!editor) return;
  const idx = editor.querySelectorAll('.contact-row').length;
  const div = document.createElement('div');
  div.className = 'contact-row';
  div.dataset.idx = idx;
  div.innerHTML = `
    <input type="text" class="c-name" placeholder="${escHtml(T('person'))}" value="" />
    <input type="tel" class="c-phone" placeholder="Phone" value="" />
    <input type="text" class="c-desig" placeholder="Role (optional)" value="" />
    <button type="button" class="remove-contact" onclick="removeContactRow(this)">✕</button>`;
  editor.appendChild(div);
}

function removeContactRow(btn) {
  btn.closest('.contact-row').remove();
}

function collectContacts() {
  const rows = document.querySelectorAll('#contacts-editor .contact-row');
  const contacts = [];
  rows.forEach(row => {
    const name  = row.querySelector('.c-name')?.value.trim() || '';
    const phone = row.querySelector('.c-phone')?.value.trim() || '';
    const desig = row.querySelector('.c-desig')?.value.trim() || '';
    if (name || phone) contacts.push({ person_name: name, contact: phone, designation: desig });
  });
  return contacts;
}

// ── Items editor (multi-product) ──────────────────────────────
const PRODUCT_OPTIONS = ['Hotmelt','Rubber Adhesive','Solvent','Latex','BC','Toluene','R6','MEK','PU Adhesive','Silicon','Other'];

function productSelect(selected = '') {
  const catalog = state.myProducts || [];
  // Options come from the team's catalog when it exists; otherwise the built-in
  // defaults. Always keep the row's current value selectable (legacy/imported
  // products that aren't in the catalog).
  let names = catalog.length ? [...new Set([...catalog.map(p => p.name), 'Other'])] : PRODUCT_OPTIONS.slice();
  if (selected && !names.some(n => n.toLowerCase() === selected.toLowerCase())) names = [selected, ...names];

  // Group by division when the catalog defines them, so long lists stay navigable.
  if (catalog.length && catalogDivisions().length) {
    const byDiv = {}, loose = [];
    for (const n of names) {
      const p = catalog.find(x => x.name === n);
      if (p && p.division) (byDiv[p.division] = byDiv[p.division] || []).push(n);
      else loose.push(n);
    }
    let html = '<option value="">Select…</option>';
    for (const div of Object.keys(byDiv).sort()) {
      html += `<optgroup label="${escAttr(div)}">` +
        byDiv[div].map(n => `<option${n === selected ? ' selected' : ''}>${escHtml(n)}</option>`).join('') +
        '</optgroup>';
    }
    if (loose.length) html += loose.map(n => `<option${n === selected ? ' selected' : ''}>${escHtml(n)}</option>`).join('');
    return `<select class="i-product">${html}</select>`;
  }

  return `<select class="i-product">
    <option value="">Select…</option>
    ${names.map(p => `<option${p === selected ? ' selected' : ''}>${escHtml(p)}</option>`).join('')}
  </select>`;
}

function renderItemsEditor(items) {
  const editor = document.getElementById('items-editor');
  if (!editor) return;
  const rows = (items && items.length)
    ? items.map(i => ({ product: i.product || '', quantity: i.quantity || '', rate: i.rate || '' }))
    : [{ product: '', quantity: '', rate: '' }];
  editor.innerHTML = rows.map((item, i) => `
    <div class="item-row" data-idx="${i}">
      ${productSelect(item.product)}
      <input type="text" class="i-qty"  placeholder="Qty"  value="${escAttr(item.quantity)}" />
      <input type="text" class="i-rate" placeholder="Rate" value="${escAttr(item.rate)}" />
      ${i > 0 ? `<button type="button" class="remove-item" onclick="removeItemRow(this)">✕</button>` : '<span class="item-row-spacer"></span>'}
    </div>`).join('');
}

function addItemRow() {
  const editor = document.getElementById('items-editor');
  if (!editor) return;
  const idx = editor.querySelectorAll('.item-row').length;
  const div = document.createElement('div');
  div.className = 'item-row';
  div.dataset.idx = idx;
  div.innerHTML = `
    ${productSelect()}
    <input type="text" class="i-qty"  placeholder="Qty"  value="" />
    <input type="text" class="i-rate" placeholder="Rate" value="" />
    <button type="button" class="remove-item" onclick="removeItemRow(this)">✕</button>`;
  editor.appendChild(div);
}

function removeItemRow(btn) {
  btn.closest('.item-row').remove();
}

function collectItems() {
  const rows = document.querySelectorAll('#items-editor .item-row');
  const items = [];
  rows.forEach(row => {
    const product  = row.querySelector('.i-product')?.value.trim() || '';
    const quantity = row.querySelector('.i-qty')?.value.trim()     || '';
    const rate     = row.querySelector('.i-rate')?.value.trim()    || '';
    if (product || quantity || rate) items.push({ product, quantity, rate });
  });
  return items;
}

function openAddModal() {
  // Factory keeps the historic 'Add Lead'; other businesses say their entity
  // word ('Add Shop', 'Add Student', …). textContent → safe for custom terms.
  document.getElementById('modal-title').textContent =
    biz().key === 'factory' ? 'Add Lead' : 'Add ' + T('entity');
  document.getElementById('f-row').value = '';
  FIELDS.forEach(f => {
    const el = document.getElementById('f-' + f);
    if (el) el.value = '';
  });
  // Pre-fill default area if set in profile
  const defaultArea = localStorage.getItem('crm_default_area') || '';
  if (defaultArea) {
    const areaEl = document.getElementById('f-area');
    if (areaEl) areaEl.value = defaultArea;
  }
  renderContactsEditor([]);
  renderItemsEditor([]);
  renderLeadListsEditor([]);
  renderLeadDestSelect();   // "Save to" — only shown when the user has a team
  const accessSection = document.getElementById('modal-access-section');
  if (accessSection) accessSection.style.display = 'none';
  const moveBtn = document.getElementById('btn-move-database');
  if (moveBtn) moveBtn.style.display = 'none';   // add-mode: nothing to move yet
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function openEditModal(rowIndex) {
  const lead = state.leads.find(l => String(l.rowIndex) === String(rowIndex));
  if (!lead) return;
  document.getElementById('modal-title').textContent =
    biz().key === 'factory' ? 'Edit Lead' : 'Edit ' + T('entity');
  document.getElementById('f-row').value = rowIndex;
  // "Save to" is an add-time choice only — a lead's team isn't changed from here.
  const destSection = document.getElementById('modal-dest-section');
  if (destSection) destSection.style.display = 'none';
  // Offer "Send to Database" only for existing working leads the user can move.
  const moveBtn = document.getElementById('btn-move-database');
  if (moveBtn) {
    const canMove = lead.can_edit !== false && (lead.bucket || 'working') === 'working';
    moveBtn.style.display = canMove ? '' : 'none';
    moveBtn.onclick = () => moveLeadToDatabase(rowIndex);
  }
  FIELDS.forEach(f => {
    const el = document.getElementById('f-' + f);
    if (!el) return;
    if (f === 'follow_up') { el.value = ddmmyyyyToISO(lead[f] || ''); }
    else { el.value = lead[f] || ''; }
  });
  renderContactsEditor(lead.contacts || []);
  const itemsToEdit = (lead.items && lead.items.length)
    ? lead.items
    : (lead.product ? [{ product: lead.product, quantity: lead.quantity, rate: lead.rate }] : []);
  renderItemsEditor(itemsToEdit);
  renderLeadListsEditor(lead.list_ids || []);
  document.getElementById('modal-overlay').classList.remove('hidden');

  // Activity timeline
  if (document.getElementById('lead-timeline-content')) loadLeadTimeline(rowIndex);

  // Sharing section — lead owner or admin can share with teammates
  const accessSection = document.getElementById('modal-access-section');
  const accessList    = document.getElementById('modal-access-list');
  const me            = localStorage.getItem('crm_user') || '';
  const canShare      = state.role !== 'guest' && (state.role === 'admin' || lead.created_by === me);
  if (canShare && accessSection) {
    accessSection.style.display = '';
    accessList.innerHTML = '<em style="color:var(--text-muted);font-size:12px">Loading…</em>';
    Promise.all([apiFetch(`/api/leads/${rowIndex}/access`), loadShareCandidates()]).then(([access, names]) => {
      const grantedNames = new Set(access.map(a => a.user_display_name));
      if (!names.length) {
        accessList.innerHTML = '<em style="color:var(--text-muted);font-size:12px">No teammates to share with yet</em>';
        return;
      }
      accessList.innerHTML = names.map(n => `
        <div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border)">
          <span style="flex:1;font-size:13px">${escHtml(n)}</span>
          ${grantedNames.has(n)
            ? `<span style="font-size:11px;color:var(--success);margin-right:4px">✓ Has access</span><button class="action-btn del" style="font-size:11px" onclick="revokeAccess(${rowIndex},'${escAttr(n)}')">Revoke</button>`
            : `<button class="action-btn" style="font-size:11px" onclick="grantAccess(${rowIndex},'${escAttr(n)}')">Share</button>`}
        </div>`).join('');
    }).catch(err => {
      accessList.innerHTML = `<em style="color:var(--danger);font-size:12px">${err.message}</em>`;
    });
  } else if (accessSection) {
    accessSection.style.display = 'none';
  }

  // Hide-from-team toggle — same permission as sharing (owner or admin).
  const hideSection = document.getElementById('modal-hide-section');
  const hideToggle  = document.getElementById('f-hide-toggle');
  if (hideSection && hideToggle) {
    if (canShare) {
      hideSection.style.display = '';
      hideToggle.checked = String(lead.visibility) === 'private';
      hideToggle.dataset.row = rowIndex;
    } else {
      hideSection.style.display = 'none';
    }
  }
}

async function toggleLeadVisibility(hidden) {
  const toggle = document.getElementById('f-hide-toggle');
  const row = toggle?.dataset.row;
  if (!row) return;
  try {
    await apiFetch(`/api/leads/${row}/visibility`, { method: 'PATCH', body: JSON.stringify({ hidden: !!hidden }) });
    // reflect it in local state so the badge/list update without a full reload
    const lead = state.leads.find(l => String(l.rowIndex) === String(row));
    if (lead) lead.visibility = hidden ? 'private' : 'team';
    toast(hidden ? 'Hidden from the team' : 'Visible to the team', 'success');
    renderLeadsView();
  } catch (err) {
    toast('Could not update: ' + err.message, 'error');
    if (toggle) toggle.checked = !hidden;   // revert
  }
}

// Who can this lead be shared with? Team members in org mode,
// all users for admins, otherwise the public username directory.
async function loadShareCandidates() {
  const me = localStorage.getItem('crm_user') || '';
  if (state.activeOrgId) {
    const members = await apiFetch(`/api/teams/${state.activeOrgId}/members`, {
      headers: { 'X-Team-ID': String(state.activeOrgId) },
    });
    return members.filter(m => m.status === 'active').map(m => m.display_name).filter(n => n && n !== me);
  }
  if (state.role === 'admin') {
    const users = await apiFetch('/api/users');
    return users.map(u => u.display_name).filter(n => n && n !== me);
  }
  const names = await apiFetch('/api/users/names');
  return names.filter(n => n && n !== me);
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
}

// ============================================================
//  Lead lists (tags)
// ============================================================
let _editorListIds = new Set();

function renderLeadListsEditor(selectedIds) {
  _editorListIds = new Set((selectedIds || []).map(String));
  _paintLeadListsEditor();
}
function _paintLeadListsEditor() {
  const box = document.getElementById('lead-lists-editor');
  if (!box) return;
  const lists = state.myLists || [];
  const chips = lists.map(l => {
    const on = _editorListIds.has(String(l.id));
    const c  = listColor(l);
    const style = on ? `background:color-mix(in srgb, ${c} 18%, transparent);color:${c};border-color:${c}` : '';
    return `<button type="button" class="list-toggle ${on ? 'on' : ''}" style="${style}" onclick="toggleEditorList('${l.id}')">
      <span class="list-dot" style="background:${c}"></span>${escHtml(l.name)}${on ? ' ✓' : ''}</button>`;
  }).join('');
  box.innerHTML =
    (lists.length ? `<div class="list-toggle-wrap">${chips}</div>` : '<span class="muted" style="font-size:12px">No lists yet.</span>') +
    `<button type="button" class="list-new-inline" onclick="newListInline()">＋ New list</button>`;
}
function toggleEditorList(id) {
  id = String(id);
  if (_editorListIds.has(id)) _editorListIds.delete(id); else _editorListIds.add(id);
  _paintLeadListsEditor();
}
async function newListInline() {
  const name = prompt('New list name:');
  if (name == null || !name.trim()) return;
  try {
    const list = await apiFetch('/api/lead-lists' + orgQuery(), { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    await loadLists();
    _editorListIds.add(String(list.id));
    _paintLeadListsEditor();
    populateFilters();
    toast(`List "${list.name}" created`);
  } catch (err) { toast(err.message, 'error'); }
}

// ── Manage Lists modal ───────────────────────────────────────
function openListsModal() {
  if (state.role === 'guest') { toast('Create an account to use lists', 'warning'); return; }
  document.getElementById('lists-modal-error').textContent = '';
  document.getElementById('new-list-name').value = '';
  const team  = state.myTeams.find(t => String(t.id) === String(state.activeOrgId));
  document.getElementById('lists-modal-scope').textContent =
    team ? `Shared across ${team.name} — everyone on the team can use these` : 'Your personal lists';
  // Show which list this session's new leads are filed into, with a Change link.
  const sessRow = document.getElementById('lists-session-row');
  const sessLbl = document.getElementById('lists-session-label');
  if (sessRow && sessLbl) {
    const nm = activeListName();
    sessLbl.innerHTML = nm
      ? `New leads this session → <b>${escHtml(nm)}</b>`
      : 'New leads this session aren’t filed into any list';
    sessRow.style.display = '';
  }
  renderListsManageBody();
  renderListsBulkRow();
  document.getElementById('lists-modal-overlay').classList.remove('hidden');
  loadLists().then(() => { renderListsManageBody(); renderListsBulkRow(); });
}
function closeListsModal() {
  document.getElementById('lists-modal-overlay').classList.add('hidden');
}

// The "Add all shown leads to a list" quick-file row inside the Lists modal.
// Lets you retroactively file leads (e.g. a batch you imported without picking a
// list) into one — it acts on exactly the leads currently shown on the Leads
// page, so any active filter narrows the batch.
function renderListsBulkRow() {
  const row     = document.getElementById('lists-bulk-row');
  const sel     = document.getElementById('lists-bulk-select');
  const label   = document.getElementById('lists-bulk-label');
  const nameInp = document.getElementById('lists-bulk-newname');
  if (!row || !sel || !label) return;

  const shown = (state.page === 'leads') ? filteredLeads() : [];
  if (!shown.length) { row.style.display = 'none'; return; }
  row.style.display = '';

  const filtered = !!(state.search || state.filterStage || state.filterProduct ||
                      state.filterSalesman || state.filterGroup || state.filterList);
  const n = shown.length;
  label.textContent = filtered
    ? `Add the ${n} lead${n === 1 ? '' : 's'} shown now to a list`
    : `Add all ${n} lead${n === 1 ? '' : 's'} to a list`;

  const lists = state.myLists || [];
  const prev  = sel.value;
  sel.innerHTML = lists.map(l => `<option value="${l.id}">${escHtml(l.name)}</option>`).join('') +
    '<option value="__new__">＋ New list…</option>';
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
  if (nameInp) { nameInp.style.display = sel.value === '__new__' ? '' : 'none'; }
}

function onListsBulkChange(v) {
  const inp = document.getElementById('lists-bulk-newname');
  if (!inp) return;
  const isNew = v === '__new__';
  inp.style.display = isNew ? '' : 'none';
  if (isNew) setTimeout(() => inp.focus(), 0);
}

async function assignShownToList() {
  const sel   = document.getElementById('lists-bulk-select');
  const errEl = document.getElementById('lists-modal-error');
  const btn   = document.getElementById('lists-bulk-btn');
  if (!sel) return;
  errEl.textContent = '';

  const shown   = (state.page === 'leads') ? filteredLeads() : [];
  const leadIds = shown.map(l => l.rowIndex).filter(v => v != null);
  if (!leadIds.length) { errEl.textContent = 'No leads shown to add'; return; }

  const isNew   = sel.value === '__new__';
  const newName = (document.getElementById('lists-bulk-newname')?.value || '').trim();
  if (!sel.value)          { errEl.textContent = 'Choose a list'; return; }
  if (isNew && !newName)   { errEl.textContent = 'Enter a name for the new list'; return; }

  btn.disabled = true; btn.textContent = 'Adding…';
  try {
    let listId = sel.value;
    if (isNew) {
      const created = await apiFetch('/api/lead-lists' + orgQuery(), {
        method: 'POST', body: JSON.stringify({ name: newName }),
      });
      listId = created?.id;
    }
    const res = await apiFetch(`/api/lead-lists/${listId}/add-leads` + orgQuery(), {
      method: 'POST', body: JSON.stringify({ lead_ids: leadIds }),
    });
    await loadLeads();                 // refresh tags + list counts
    renderListsManageBody();
    renderListsBulkRow();
    populateFilters();
    renderLeadsView();
    toast(res.added
      ? `Filed ${res.added} lead${res.added === 1 ? '' : 's'} into the list`
      : 'Those leads were already in the list', res.added ? 'success' : 'warning');
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Add all';
  }
}

function renderListsManageBody() {
  const box = document.getElementById('lists-manage-body');
  if (!box) return;
  const lists = state.myLists || [];
  if (!lists.length) { box.innerHTML = '<div class="empty-state" style="padding:22px">No lists yet — create one above.</div>'; return; }
  box.innerHTML = lists.map(l => {
    const c = listColor(l);
    return `<div class="list-manage-row">
      <span class="list-dot" style="background:${c}"></span>
      <span class="list-manage-name">${escHtml(l.name)}</span>
      <span class="list-manage-count">${l.count || 0} lead${l.count === 1 ? '' : 's'}</span>
      <button class="action-btn" onclick="renameListPrompt(${l.id})">Rename</button>
      <button class="action-btn del" onclick="deleteListConfirm(${l.id}, '${escAttr(l.name)}')">Delete</button>
    </div>`;
  }).join('');
}
async function createListFromModal() {
  const nameEl  = document.getElementById('new-list-name');
  const colorEl = document.getElementById('new-list-color');
  const errEl   = document.getElementById('lists-modal-error');
  errEl.textContent = '';
  const name = nameEl.value.trim();
  if (!name) { errEl.textContent = 'Enter a list name'; return; }
  try {
    await apiFetch('/api/lead-lists' + orgQuery(), { method: 'POST', body: JSON.stringify({ name, color: colorEl.value }) });
    nameEl.value = '';
    await loadLists();
    renderListsManageBody(); populateFilters(); renderLeadsView();
    toast(`List "${name}" created`);
  } catch (err) { errEl.textContent = err.message; }
}
async function renameListPrompt(id) {
  const list = (state.myLists || []).find(l => String(l.id) === String(id));
  const name = prompt('Rename list:', list ? list.name : '');
  if (name == null) return;
  if (!name.trim()) { toast('Name cannot be empty', 'error'); return; }
  try {
    await apiFetch(`/api/lead-lists/${id}`, { method: 'PATCH', body: JSON.stringify({ name: name.trim() }) });
    await loadLists();
    renderListsManageBody(); populateFilters(); renderLeadsView();
    toast('List renamed');
  } catch (err) { toast(err.message, 'error'); }
}
async function deleteListConfirm(id, name) {
  if (!confirm(`Delete list "${name}"? The leads stay, but they lose this tag.`)) return;
  try {
    await apiFetch(`/api/lead-lists/${id}`, { method: 'DELETE' });
    if (String(state.filterList) === String(id)) state.filterList = '';
    await loadLists();
    renderListsManageBody(); populateFilters(); renderLeadsView();
    toast('List deleted');
  } catch (err) { toast(err.message, 'error'); }
}

// ── Products catalog ("major items") manager ──────────────────
function openProductsModal() {
  if (state.role === 'guest') { toast('Create an account to manage products', 'warning'); return; }
  document.getElementById('products-modal-error').textContent = '';
  ['new-product-name', 'new-product-division', 'new-product-aliases'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  const team = state.myTeams.find(t => String(t.id) === String(state.activeOrgId));
  document.getElementById('products-modal-scope').textContent =
    team ? `Shared across ${team.name} — everyone on the team uses these items` : 'Your personal product list';
  renderProductsManageBody();
  document.getElementById('products-modal-overlay').classList.remove('hidden');
  loadProducts().then(renderProductsManageBody);
}
function closeProductsModal() {
  document.getElementById('products-modal-overlay').classList.add('hidden');
}
function refreshDivisionSuggestions() {
  const dl = document.getElementById('division-suggestions');
  if (dl) dl.innerHTML = catalogDivisions().map(d => `<option value="${escAttr(d)}"></option>`).join('');
}
// Ids ticked in the products modal's bulk-delete selection.
var _selectedProductIds = new Set();
function renderProductsManageBody() {
  const box = document.getElementById('products-manage-body');
  if (!box) return;
  refreshDivisionSuggestions();
  _selectedProductIds.clear();               // selection resets whenever the list changes
  const products = state.myProducts || [];
  const bulkBar = document.getElementById('products-bulk-bar');
  if (!products.length) {
    box.innerHTML = '<div class="empty-state" style="padding:22px">No products yet — add your major items above.</div>';
    if (bulkBar) bulkBar.classList.add('hidden');
    return;
  }
  if (bulkBar) bulkBar.classList.remove('hidden');
  // Group by division for a tidy, filterable view.
  const groups = {};
  for (const p of products) (groups[p.division || 'Uncategorised'] = groups[p.division || 'Uncategorised'] || []).push(p);
  box.innerHTML = Object.keys(groups).sort().map(div => `
    <div class="product-group-title">${escHtml(div)}</div>
    ${groups[div].map(p => `
      <div class="list-manage-row">
        <input type="checkbox" class="product-pick" data-pid="${p.id}" onclick="toggleProductPick(${p.id}, this.checked)" />
        <span class="list-manage-name">${escHtml(p.name)}</span>
        ${p.aliases ? `<span class="product-aliases" title="Alias spellings the importer reads">${escHtml(p.aliases)}</span>` : ''}
        ${p.created_at ? `<span class="product-added" title="When this item was added">added ${escHtml(String(p.created_at).split(' ')[0])}</span>` : ''}
        <button class="action-btn" onclick="editProductPrompt(${p.id})">Edit</button>
        <button class="action-btn del" onclick="deleteProductConfirm(${p.id}, '${escAttr(p.name)}')">Delete</button>
      </div>`).join('')}
  `).join('');
  const selAll = document.getElementById('products-select-all');
  if (selAll) selAll.checked = false;
  updateProductBulkBar();
}
function toggleProductPick(id, on) {
  if (on) _selectedProductIds.add(String(id)); else _selectedProductIds.delete(String(id));
  updateProductBulkBar();
}
function toggleSelectAllProducts(on) {
  _selectedProductIds.clear();
  document.querySelectorAll('#products-manage-body .product-pick').forEach(cb => {
    cb.checked = on;
    if (on) _selectedProductIds.add(String(cb.dataset.pid));
  });
  updateProductBulkBar();
}
function updateProductBulkBar() {
  const n = _selectedProductIds.size;
  const countEl = document.getElementById('products-bulk-count');
  if (countEl) countEl.textContent = n ? `${n} selected` : 'Tick the items to remove';
  const btn = document.querySelector('#products-bulk-bar .btn-danger');
  if (btn) btn.disabled = !n;
}
async function bulkDeleteProducts() {
  const ids = [..._selectedProductIds];
  if (!ids.length) { toast('Tick the products you want to remove', 'warning'); return; }
  if (!confirm(`Remove ${ids.length} product${ids.length === 1 ? '' : 's'} from your catalog? Existing leads keep their items — this only clears them from the list.`)) return;
  try {
    const r = await apiFetch('/api/products/bulk-delete' + orgQuery(), {
      method: 'POST',
      body: JSON.stringify({ ids }),
    });
    await loadProducts();
    renderProductsManageBody(); populateFilters(); renderLeadsView();
    toast(`Removed ${r.deleted} product${r.deleted === 1 ? '' : 's'}`);
  } catch (err) { toast(err.message, 'error'); }
}
async function createProductFromModal() {
  const nameEl = document.getElementById('new-product-name');
  const divEl  = document.getElementById('new-product-division');
  const aliEl  = document.getElementById('new-product-aliases');
  const errEl  = document.getElementById('products-modal-error');
  errEl.textContent = '';
  const name = nameEl.value.trim();
  if (!name) { errEl.textContent = 'Enter an item name'; return; }
  try {
    await apiFetch('/api/products' + orgQuery(), {
      method: 'POST',
      body: JSON.stringify({ name, division: divEl.value.trim(), aliases: aliEl.value.trim() }),
    });
    nameEl.value = ''; aliEl.value = '';   // keep division for fast multi-add in the same division
    await loadProducts();
    renderProductsManageBody(); populateFilters(); renderLeadsView();
    toast(`Added "${name}"`);
    nameEl.focus();
  } catch (err) { errEl.textContent = err.message; }
}
async function editProductPrompt(id) {
  const p = (state.myProducts || []).find(x => String(x.id) === String(id));
  if (!p) return;
  const name = prompt('Item name:', p.name);
  if (name == null) return;
  if (!name.trim()) { toast('Name cannot be empty', 'error'); return; }
  const division = prompt('Division (category):', p.division || '');
  if (division == null) return;
  const aliases = prompt('Aliases (comma-separated spellings the importer reads):', p.aliases || '');
  if (aliases == null) return;
  try {
    await apiFetch(`/api/products/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: name.trim(), division: division.trim(), aliases: aliases.trim() }),
    });
    await loadProducts();
    renderProductsManageBody(); populateFilters(); renderLeadsView();
    toast('Product updated');
  } catch (err) { toast(err.message, 'error'); }
}
async function deleteProductConfirm(id, name) {
  if (!confirm(`Remove "${name}" from your product list? Existing leads keep their items — this only removes it from the catalog.`)) return;
  try {
    await apiFetch(`/api/products/${id}`, { method: 'DELETE' });
    await loadProducts();
    renderProductsManageBody(); populateFilters(); renderLeadsView();
    toast('Product removed');
  } catch (err) { toast(err.message, 'error'); }
}

// ── Fix Product Data (AI cleanup) — admin ─────────────────────
var _cleanupItems = [];   // var (not let): hoisted functions below reference it
function openProductCleanup() {
  if (state.role !== 'admin') { toast('Admins only', 'warning'); return; }
  document.getElementById('cleanup-error').textContent = '';
  document.getElementById('product-cleanup-overlay').classList.remove('hidden');
  document.getElementById('cleanup-body').innerHTML =
    '<div class="empty-state" style="padding:24px">Scanning your product data… (asks the AI once)</div>';
  loadProducts().then(scanProductCleanup);
}
function closeProductCleanup() {
  document.getElementById('product-cleanup-overlay').classList.add('hidden');
}

async function scanProductCleanup() {
  const body = document.getElementById('cleanup-body');
  try {
    const res = await apiFetch('/api/products/cleanup-scan' + orgQuery());
    _cleanupItems = res.items || [];
    renderCleanupBody();
  } catch (err) {
    body.innerHTML = emptyState('Could not scan: ' + escHtml(err.message));
  }
}

function renderCleanupBody() {
  const body = document.getElementById('cleanup-body');
  if (!_cleanupItems.length) {
    body.innerHTML = '<div class="empty-state" style="padding:24px">🎉 Everything matches your catalog — nothing to fix.</div>';
    return;
  }
  const catalog = state.myProducts || [];
  const catOptions = catalog.length
    ? catalog.map(p => `<option value="${p.id}">${escHtml(p.name)}${p.division ? ` (${escHtml(p.division)})` : ''}</option>`).join('')
    : '<option value="">— no products in catalog —</option>';

  body.innerHTML = _cleanupItems.map((it, i) => {
    const sugg = (it.suggestions || []).map((s, si) => `
      <label class="cleanup-opt">
        <input type="radio" name="cl-${i}" value="create:${si}">
        <span>Create <b>${escHtml(s.name)}</b>${s.division ? ` <span class="cleanup-div">(${escHtml(s.division)})</span>` : ''} <span class="cleanup-badge">AI</span></span>
      </label>`).join('');
    return `<div class="cleanup-card" data-idx="${i}">
      <div class="cleanup-raw">“${escHtml(it.raw)}” <span class="cleanup-count">${it.count} lead${it.count === 1 ? '' : 's'}</span></div>
      ${sugg}
      <label class="cleanup-opt">
        <input type="radio" name="cl-${i}" value="map">
        <span>Map to existing: <select class="cleanup-map-sel" onchange="this.closest('.cleanup-card').querySelector('input[value=map]').checked=true">${catOptions}</select></span>
      </label>
      <label class="cleanup-opt">
        <input type="radio" name="cl-${i}" value="keep" checked>
        <span>Keep original “${escHtml(it.raw)}”</span>
      </label>
    </div>`;
  }).join('');

  // Pre-select the AI's "map to existing" pick where it proposed one.
  _cleanupItems.forEach((it, i) => {
    if (!it.aiMap) return;
    const prod = catalog.find(p => p.name.toLowerCase() === String(it.aiMap).toLowerCase());
    if (!prod) return;
    const card = body.querySelector(`.cleanup-card[data-idx="${i}"]`);
    const sel  = card?.querySelector('.cleanup-map-sel');
    if (sel) sel.value = String(prod.id);
    const mapRadio = card?.querySelector('input[value="map"]');
    if (mapRadio) mapRadio.checked = true;
  });
}

async function applyCleanup() {
  const body = document.getElementById('cleanup-body');
  const decisions = [];
  _cleanupItems.forEach((it, i) => {
    const card = body.querySelector(`.cleanup-card[data-idx="${i}"]`);
    if (!card) return;
    const chosen = card.querySelector(`input[name="cl-${i}"]:checked`);
    const v = chosen ? chosen.value : 'keep';
    if (v === 'map') {
      const pid = card.querySelector('.cleanup-map-sel')?.value;
      decisions.push(pid ? { raw: it.raw, action: 'map', productId: Number(pid) } : { raw: it.raw, action: 'keep' });
    } else if (v.startsWith('create:')) {
      const s = it.suggestions[Number(v.split(':')[1])];
      decisions.push(s ? { raw: it.raw, action: 'create', name: s.name, division: s.division || '' } : { raw: it.raw, action: 'keep' });
    } else {
      decisions.push({ raw: it.raw, action: 'keep' });
    }
  });
  const btn = document.getElementById('cleanup-apply-btn');
  btn.disabled = true; btn.textContent = 'Applying…';
  try {
    const res = await apiFetch('/api/products/cleanup-apply' + orgQuery(), {
      method: 'POST', body: JSON.stringify({ decisions }),
    });
    await loadProducts(); await loadLeads();
    if (state.page === 'leads') { populateFilters(); renderLeadsView(); }
    closeProductCleanup();
    toast(`Applied — ${res.mapped} mapped, ${res.created} created, ${res.kept} kept (${res.rowsChanged} leads updated)`);
  } catch (err) {
    document.getElementById('cleanup-error').textContent = err.message;
  } finally {
    btn.disabled = false; btn.textContent = 'Apply all';
  }
}

async function handleFormSubmit(e) {
  e.preventDefault();
  const row  = document.getElementById('f-row').value;
  const data = {};
  FIELDS.forEach(f => {
    const el = document.getElementById('f-' + f);
    if (!el) return;
    if (f === 'follow_up') {
      data[f] = isoToddmmyyyy(el.value.trim());
    } else {
      data[f] = el.value.trim();
    }
  });
  data.stage_number = STAGE_NUMBERS[data.stage] ?? '';
  data.contacts = collectContacts();
  data.items    = collectItems();
  if (data.items.length) {
    data.product  = data.items[0].product;
    data.quantity = data.items[0].quantity;
    data.rate     = data.items[0].rate;
  }

  const btn = document.getElementById('btn-save-lead');
  btn.disabled    = true;
  btn.textContent = 'Saving…';

  try {
    let savedRow = row ? parseInt(row) : null;
    if (row) {
      await updateLead(parseInt(row), data);
      toast(biz().key==='factory' ? 'Lead updated successfully' : T('entity')+' updated successfully');
    } else {
      const result = await createLead(data);
      if (result && result.conflict) {
        toast(`Duplicate: ${result.message}`, 'error');
        return;
      }
      savedRow = result && result.rowIndex;
      toast(biz().key==='factory' ? 'Lead added successfully' : T('entity')+' added successfully');
    }
    // Persist list (tag) memberships for this lead
    if (savedRow) {
      await apiFetch(`/api/leads/${savedRow}/lists` + orgQuery(), {
        method: 'PUT',
        body: JSON.stringify({ list_ids: [..._editorListIds].map(Number) }),
      }).catch(() => {});
    }
    closeModal();
    await refresh();
  } catch (err) {
    toast('Save failed: ' + err.message, 'error');
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Save Lead';
  }
}

// ============================================================
//  Delete
// ============================================================
async function confirmDelete(row, name) {
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  try {
    await deleteLead(row);
    toast(biz().key==='factory' ? 'Lead deleted' : T('entity')+' deleted');
    await refresh();
  } catch (err) {
    toast('Delete failed: ' + err.message, 'error');
  }
}

// ============================================================
//  Refresh
// ============================================================
async function refresh() {
  const btn = document.getElementById('btn-refresh');
  btn.textContent = '↻';
  try {
    await loadLeads();
    lastRefreshed = new Date();
    updateRefreshLabel();
    renderPage(state.page);
  } catch (err) {
    toast('Failed to load data: ' + err.message, 'error');
  } finally {
    btn.textContent = '↺';
  }
}

// ============================================================
//  Event Wiring
// ============================================================
// ============================================================
//  Theme
// ============================================================
function applyAccent(accent) {
  if (accent) {
    document.documentElement.setAttribute('data-accent', accent);
    localStorage.setItem('crm_accent', accent);
  } else {
    document.documentElement.removeAttribute('data-accent');
    localStorage.removeItem('crm_accent');
  }
  document.querySelectorAll('.palette-dot').forEach(d => {
    d.classList.toggle('active', d.dataset.accent === accent);
  });
  if (state.page === 'dashboard' && state.stats) renderDashboard();
  if (state.page === 'reports'   && state.stats) renderReports();
}

function toggleTheme() {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('crm_theme', next);
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = next === 'dark' ? '☀' : '🌙';
  if (state.page === 'dashboard' && state.stats) renderDashboard();
  if (state.page === 'reports'   && state.stats) renderReports();
}

function initTheme() {
  const savedMode   = localStorage.getItem('crm_theme')  || 'light';
  const savedAccent = localStorage.getItem('crm_accent') || '';
  document.documentElement.setAttribute('data-theme', savedMode);
  if (savedAccent) document.documentElement.setAttribute('data-accent', savedAccent);
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = savedMode === 'dark' ? '☀' : '🌙';
  document.querySelectorAll('.palette-dot').forEach(d => {
    d.classList.toggle('active', d.dataset.accent === savedAccent);
  });
}

// True when the sidebar behaves as an off-canvas drawer (hamburger opens it
// over an overlay) rather than an inline column collapsed to an icon rail.
// Must match the CSS drawer breakpoint in style.css:
//   `@media (max-width: 1024px), (max-height: 500px) and (orientation: landscape)`
// i.e. all phones AND tablets in portrait (≤1024px wide) — a tablet or rotated
// phone can be 700–1024px wide but is still a touch screen where an inline
// sidebar would eat a third of the viewport. >1024px keeps the inline sidebar.
function isDrawerLayout() {
  return window.innerWidth <= 1024 ||
    (window.innerHeight <= 500 && window.matchMedia('(orientation: landscape)').matches);
}

function wireEvents() {
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.addEventListener('click', () => {
      navigate(el.dataset.page);
      if (isDrawerLayout()) {
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('sidebar-overlay').classList.remove('visible');
      }
    });
  });

  document.querySelectorAll('[data-page]:not(.nav-item)').forEach(el => {
    el.addEventListener('click', e => {
      if (el.tagName === 'A') { e.preventDefault(); navigate(el.dataset.page); }
    });
  });

  // Mobile bottom nav — thumb-reachable primary actions (phones only).
  document.querySelectorAll('#bottom-nav .bn-item[data-page]').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.page));
  });
  document.getElementById('bn-add')?.addEventListener('click', () => {
    if (state.aiMode && state.aiMode[state.page]) document.getElementById(`ai-input-${state.page}`)?.focus();
    else openAddModal();
  });
  document.getElementById('bn-more')?.addEventListener('click', () => {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebar-overlay').classList.add('visible');
  });

  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (isDrawerLayout()) {
      sidebar.classList.toggle('open');
      overlay.classList.toggle('visible');
    } else {
      sidebar.classList.toggle('collapsed');
    }
  });

  document.getElementById('sidebar-overlay').addEventListener('click', () => {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('visible');
  });

  document.getElementById('global-search').addEventListener('input', e => {
    state.search = e.target.value;
    // Debounce: re-render once the user pauses, not on every keystroke (a full
    // list rebuild per key froze large datasets).
    if (state.page !== 'leads') return;
    clearTimeout(_leadsSearchDebounce);
    _leadsSearchDebounce = setTimeout(renderLeadsView, 200);
  });

  document.getElementById('btn-add-lead').addEventListener('click', () => {
    if (state.aiMode[state.page]) {
      document.getElementById(`ai-input-${state.page}`)?.focus();
    } else {
      openAddModal();
    }
  });
  document.getElementById('btn-refresh').addEventListener('click', refresh);
  document.getElementById('btn-export').addEventListener('click', exportCSV);
  document.getElementById('btn-import')?.addEventListener('click', openImportModal);
  document.getElementById('btn-manage-lists')?.addEventListener('click', openListsModal);
  document.getElementById('filter-salesman')?.addEventListener('change', e => {
    state.filterSalesman = e.target.value;
    renderLeadsView();
  });
  document.getElementById('filter-list')?.addEventListener('change', e => {
    state.filterList = e.target.value;
    renderLeadsView();
  });
  document.getElementById('lists-modal-overlay')?.addEventListener('click', e => {
    if (e.target === document.getElementById('lists-modal-overlay')) closeListsModal();
  });
  document.getElementById('new-list-name')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); createListFromModal(); }
  });
  document.getElementById('products-modal-overlay')?.addEventListener('click', e => {
    if (e.target === document.getElementById('products-modal-overlay')) closeProductsModal();
  });
  ['new-product-name', 'new-product-aliases']?.forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); createProductFromModal(); }
    });
  });
  document.getElementById('btn-theme').addEventListener('click', toggleTheme);
  document.querySelectorAll('.palette-dot').forEach(dot => {
    dot.addEventListener('click', () => applyAccent(dot.dataset.accent));
  });

  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('btn-cancel-modal').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('modal-overlay')) closeModal();
  });

  document.getElementById('lead-form').addEventListener('submit', handleFormSubmit);

  document.getElementById('filter-stage').addEventListener('change', e => {
    state.filterStage = e.target.value;
    renderLeadsView();
  });

  document.getElementById('filter-product').addEventListener('change', e => {
    state.filterProduct = e.target.value;
    renderLeadsView();
  });
  document.getElementById('filter-division')?.addEventListener('change', e => {
    state.filterDivision = e.target.value;
    renderLeadsView();
  });
  document.getElementById('btn-manage-products')?.addEventListener('click', openProductsModal);
  document.getElementById('btn-cleanup')?.addEventListener('click', cleanupImportedLeads);
  document.getElementById('btn-db-import')?.addEventListener('click', openImportToDatabase);
  document.getElementById('btn-db-copy-selected')?.addEventListener('click', copySelectedToWorking);
  document.getElementById('btn-db-delete-selected')?.addEventListener('click', deleteSelectedFromDb);
  document.getElementById('db-search')?.addEventListener('input', e => {
    state.dbSearch = e.target.value;
    clearTimeout(_dbSearchDebounce);
    _dbSearchDebounce = setTimeout(renderDatabaseTable, 200);
  });

  document.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.view = btn.dataset.view;
      localStorage.setItem('crm_leads_view', state.view);   // remember the choice
      document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderLeadsView();
    });
  });
  // Default to the readable Cards view on phones (wide table is hard to scan);
  // respect a saved preference on any device.
  const savedView = localStorage.getItem('crm_leads_view');
  state.view = savedView || (window.innerWidth < 700 ? 'cards' : 'table');

  document.querySelectorAll('.pill[data-fu]').forEach(pill => {
    pill.addEventListener('click', () => {
      state.fuFilter = pill.dataset.fu;
      document.querySelectorAll('.pill[data-fu]').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      renderFollowups();
    });
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
  });

  document.getElementById('login-form').addEventListener('submit', handleLogin);
  document.getElementById('register-form').addEventListener('submit', handleRegister);
  renderPinStrength('pin-setup-input', 'pin-setup-strength');
  // Security modal ESC to close
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeSecurityModal(); closePinSetupModal(); }
  });
  // Auto-focus pin input when pin-unlock screen is visible (tap to wake keyboard)
  document.getElementById('pin-unlock-screen')?.addEventListener('click', () => {
    document.getElementById('pin-input')?.focus();
  });

  // Profile modal
  document.getElementById('profile-form').addEventListener('submit', handleProfileSubmit);
  document.getElementById('profile-modal-close').addEventListener('click', closeProfileModal);
  document.getElementById('btn-cancel-profile').addEventListener('click', closeProfileModal);
  document.getElementById('profile-modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('profile-modal-overlay')) closeProfileModal();
  });
}

// ============================================================
//  Init
// ============================================================
// ── Organisation / workspace switcher ─────────────────────────
async function loadMyTeams() {
  if (state.role === 'guest') { state.myTeams = []; return; }
  try { state.myTeams = await apiFetch('/api/my/teams'); }
  // Blip-safe: this now runs every 60s from the auto-refresh tick, so a
  // transient network failure must NOT wipe state.myTeams — leave it as-is
  // and skip the stale-org guard + applyDefaultWorkspace below (they'd
  // otherwise misread the empty array as "no teams" and yank the user back
  // to Personal / reset their workspace on a blip).
  // EXCEPTION: on the very FIRST load (before the default workspace has ever
  // been applied) still run applyDefaultWorkspace — otherwise a Render cold-start
  // 502 on this first fetch leaves an admin silently scoped to a stale saved team
  // (crm_org_id) while the switcher says "All leads", so they can't see everything.
  catch (_) { if (!_defaultWorkspaceApplied) applyDefaultWorkspace(); return; }
  // Drop a saved org the user is no longer part of
  if (state.activeOrgId && !state.myTeams.some(t => String(t.id) === String(state.activeOrgId))) {
    state.activeOrgId = '';
    localStorage.removeItem('crm_org_id');
  }
  applyDefaultWorkspace();
}

// Default workspace on sign-in:
//  • Admins land on the global "All leads" view (activeOrgId '') so they see
//    every salesperson's data — a single team would hide leads entered elsewhere.
//  • Salespeople who belong to a team default into it, so their new leads merge
//    into the shared team pool. Their solo leads stay reachable under "Personal".
// BOTH defaults fire ONCE per sign-in — loadMyTeams() now runs mid-session
// (workspace visits, joins/leaves, and the 60s auto-refresh tick) and must not
// yank anyone out of a workspace they deliberately chose: neither an admin who
// switched into a team, nor a salesperson who explicitly switched to Personal
// (which would otherwise snap back to their first team within a minute).
let _defaultWorkspaceApplied = false;
function applyDefaultWorkspace() {
  if (_defaultWorkspaceApplied) return;
  _defaultWorkspaceApplied = true;
  if (state.role === 'admin') {
    state.activeOrgId = '';
    localStorage.removeItem('crm_org_id');
    return;
  }
  if (!state.activeOrgId && state.myTeams.length) {
    state.activeOrgId = String(state.myTeams[0].id);
    localStorage.setItem('crm_org_id', state.activeOrgId);
    localStorage.setItem('ws_team_id', state.activeOrgId);
  }
}

function renderOrgSwitcher() {
  const el = document.getElementById('org-switcher');
  if (!el) return;
  if (state.role === 'guest') { el.classList.add('hidden'); el.innerHTML = ''; return; }
  el.classList.remove('hidden');
  // For admins the "no team" option is the global view of everyone's leads.
  const personalLabel = state.role === 'admin' ? '🗂 All leads (everyone)' : '👤 Personal (my leads)';
  el.innerHTML = `
    <select id="org-select" title="Switch workspace" onchange="switchOrg(this.value)">
      <option value="">${personalLabel}</option>
      ${state.myTeams.map(t => {
        const icon = (BUSINESS_TYPES[t.business_type] || BUSINESS_TYPES.factory).icon;
        return `<option value="${t.id}" ${String(t.id) === String(state.activeOrgId) ? 'selected' : ''}>${icon} ${escHtml(t.name)}</option>`;
      }).join('')}
      <option value="__discover__">🔍 Find / create a team…</option>
    </select>`;
}

async function switchOrg(id) {
  // Not a real workspace — open the "find / create a team" prompt instead.
  if (id === '__discover__') { renderOrgSwitcher(); openTeamsDiscover(); return; }
  state.activeOrgId = id || '';
  // Persist the chosen team for THIS session's reloads — but NOT for admins:
  // their default is always the global "All leads" view, so a saved team would
  // (a) reopen them scoped to one team and (b) risk the cold-start-blip trap.
  // ws_team_id (the AI "Save to" hint) is still remembered so an admin can view
  // everything while new leads pool into their team.
  if (id) {
    if (state.role !== 'admin') localStorage.setItem('crm_org_id', id);
    localStorage.setItem('ws_team_id', id);
  } else {
    localStorage.removeItem('crm_org_id');
  }
  // Entering a team makes it your default "Save to" for new leads. Switching to
  // Personal/All-leads leaves the last team destination intact (so an admin can
  // view everything while new leads still pool into their team).
  if (id) setLeadDest(id);
  const team = state.myTeams.find(t => String(t.id) === String(id));
  toast(team ? `Workspace: ${team.name} · new leads save here` : 'Personal workspace');
  try {
    await loadLeads();
    lastRefreshed = new Date();
    renderPage(state.page);
  } catch (err) { toast(err.message, 'error'); }
}

// After ANY team-membership change (create / join / leave / approval) the
// header switcher, state.myTeams and the visible leads must all agree — one
// helper so no flow can forget a piece. Pass a team id to also switch into it,
// '' to switch to Personal, or omit to keep the current workspace.
async function refreshTeamsEverywhere(switchToId) {
  await loadMyTeams();
  renderOrgSwitcher();
  if (switchToId !== undefined) await switchOrg(switchToId == null ? '' : String(switchToId));
}

async function initApp() {
  touchActivity();   // any successful entry (login/unlock/auto) resets the idle timer
  try {
    await consumePendingInvite();   // invite link → auto-join right after auth
    await loadMyTeams();
    renderOrgSwitcher();
    // Sync profile prefs (default area) from the server, non-blocking
    if (state.role !== 'guest') {
      apiFetch('/api/users/me').then(me => {
        state.me = me;
        if (me?.default_area) localStorage.setItem('crm_default_area', me.default_area);
      }).catch(() => {});
    }
    await loadLeads();
    lastRefreshed = new Date();
    navigate('dashboard');
    applyRoleUI();
    updateSecurityButtons();    // show/hide the "Set PIN" shortcut for this device
    refreshAiBubbleVisibility(); // reveal the floating AI bubble (unless hidden)
    loadPlan();                 // Lite/Pro entitlement → sidebar badge + gating
    document.getElementById('btn-codes')?.classList.toggle('hidden', state.role !== 'admin');
    startPresenceHeartbeat();   // "who's online" for the Team Hub
    startAutoRefresh();
    initSocket();
    maybeShowTeamsDiscover();   // nudge team-less users to join a public team
    maybePromptActiveList();    // ask which list today's new leads are filed into
  } catch (err) {
    if (err.message.includes('401') || err.message.includes('Session expired')) {
      showLoginPage();
    } else {
      toast('Could not connect to server. Is it running?', 'error');
    }
    console.error(err);
  }
}

// ============================================================
//  Plan / Pro entitlement (Lite vs Pro) — trial, upgrade, codes
// ============================================================
const PRICE_INDIVIDUAL = 500;   // ₹/month
const PRICE_TEAM_SEAT  = 299;   // ₹/month per person

function isPro() { return !!(state.plan && state.plan.isPro); }

async function loadPlan() {
  try { state.plan = await apiFetch('/api/me/plan'); }
  catch (_) { state.plan = { isPro: false, plan: 'lite', daysLeft: 0 }; }
  renderPlanBadge();
  return state.plan;
}

// Gate a Pro-only feature. Returns true if allowed; otherwise opens the upgrade
// screen and returns false. Use: `if (!requirePro('Team chat')) return;`
function requirePro(featureName) {
  if (isPro()) return true;
  openUpgradeModal(featureName);
  return false;
}

// Small plan chip in the sidebar: trial countdown, Pro, or an Upgrade nudge.
function renderPlanBadge() {
  const el = document.getElementById('plan-badge');
  if (!el) return;
  const p = state.plan || {};
  if (state.role === 'guest') { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  if (p.plan === 'admin') { el.className = 'plan-badge is-pro'; el.innerHTML = '<span>✦ Pro</span><small>dev</small>'; el.onclick = openCodesModal; return; }
  if (p.isPro && p.kind === 'trial') {
    el.className = 'plan-badge is-trial';
    el.innerHTML = `<span>✦ Pro trial</span><small>${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'} left</small>`;
  } else if (p.isPro && p.kind === 'referral') {
    el.className = 'plan-badge is-trial';
    el.innerHTML = `<span>✦ Pro · gift</span><small>${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'} left</small>`;
  } else if (p.isPro) {
    el.className = 'plan-badge is-pro';
    el.innerHTML = `<span>✦ Pro</span><small>${p.daysLeft != null ? p.daysLeft + 'd left' : 'active'}</small>`;
  } else {
    el.className = 'plan-badge is-lite';
    el.innerHTML = '<span>Lite</span><small>Upgrade →</small>';
  }
  el.onclick = openUpgradeModal;
}

function openUpgradeModal(feature) {
  closeUpgradeModal();
  const p = state.plan || {};
  const trialLine = p.kind === 'trial' && p.isPro
    ? `<div class="up-trial">You're on the free trial — <b>${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'} left</b>.</div>`
    : (p.plan === 'lite' && p.proUntil ? `<div class="up-trial up-ended">Your Pro trial has ended.</div>` : '');
  const featLine = (typeof feature === 'string' && feature)
    ? `<div class="up-feat">🔒 <b>${escHtml(feature)}</b> is a Pro feature.</div>` : '';
  // Team owners/admins/managers of the active workspace can pay for the whole
  // team's seats, not just themselves — offer both options instead of one.
  const team = state.activeOrgId ? (state.myTeams || []).find(t => String(t.id) === String(state.activeOrgId)) : null;
  const canTeamPay = !!(team && ['owner', 'admin', 'manager'].includes(team.role));
  const payHtml = canTeamPay
    ? `<div class="up-pay-row">
         <button class="btn btn-primary up-pay" onclick="startProCheckout('individual')">Pay ₹${PRICE_INDIVIDUAL}/mo — Individual</button>
         <button class="btn btn-primary up-pay" onclick="startProCheckout('team')">Pay ₹${PRICE_TEAM_SEAT} × seats — Team</button>
       </div>`
    : `<button class="btn btn-primary up-pay" onclick="startProCheckout('individual')">Pay online · ₹${PRICE_INDIVIDUAL}/mo</button>`;
  // "Invite & earn" — guests have no account to share a code from, so they never see it.
  const referHtml = state.role === 'guest' ? '' : `
      <div class="up-refer" id="up-refer">
        <div class="up-refer-title">🎁 Invite &amp; earn</div>
        <p class="up-refer-sub">Friends who sign up with your link get 2 months of Pro free — you get +14 days per signup (max 10/yr).</p>
        <div class="up-refer-row">
          <input type="text" id="up-refer-link" class="up-refer-input" readonly value="Loading your link…" onclick="this.select()" />
          <button type="button" class="btn btn-ghost btn-sm" onclick="copyReferLink('up-refer-link')">Copy</button>
        </div>
        <div class="up-refer-meta" id="up-refer-meta"></div>
      </div>`;
  const html = `
  <div class="up-overlay" id="upgrade-modal" onclick="if(event.target===this)closeUpgradeModal()">
    <div class="up-box" role="dialog" aria-modal="true" aria-label="Upgrade to Pro">
      <button class="up-close" onclick="closeUpgradeModal()" aria-label="Close">✕</button>
      <div class="up-head">
        <div class="up-kicker">Dive Pro</div>
        <h2 class="up-title">Unlock the Team Hub</h2>
        <p class="up-sub">Tasks, team chat, activity feed, presence &amp; leaderboards — everything your team needs to work together.</p>
      </div>
      ${featLine}${trialLine}
      <div class="up-plans">
        <div class="up-plan">
          <div class="up-plan-name">Individual</div>
          <div class="up-price">₹${PRICE_INDIVIDUAL}<span>/month</span></div>
          <div class="up-plan-note">For a solo rep.</div>
        </div>
        <div class="up-plan up-plan-best">
          <div class="up-badge">Best for teams</div>
          <div class="up-plan-name">Team</div>
          <div class="up-price">₹${PRICE_TEAM_SEAT}<span>/person·mo</span></div>
          <div class="up-plan-note">Every seat on your team.</div>
        </div>
      </div>
      <ul class="up-list">
        <li>Assign tasks &amp; leads to teammates with due dates</li>
        <li>Real-time team chat with history</li>
        <li>Live activity feed &amp; who's online</li>
        <li>Leaderboard &amp; monthly targets</li>
      </ul>
      <div class="up-actions">
        ${payHtml}
        <div class="up-code">
          <input id="up-code-input" placeholder="Have an access code?" autocomplete="off" />
          <button class="btn btn-secondary" onclick="redeemProCode()">Redeem</button>
        </div>
        <div id="up-code-msg" class="up-msg"></div>
      </div>
      ${referHtml}
    </div>
  </div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstElementChild);
  document.addEventListener('keydown', upEscHandler);
  setTimeout(() => document.getElementById('up-code-input')?.focus(), 120);
  if (state.role !== 'guest') loadReferralBlock('up-refer', 'up-refer-link', 'up-refer-meta');
}
function upEscHandler(e) { if (e.key === 'Escape') closeUpgradeModal(); }
function closeUpgradeModal() {
  document.getElementById('upgrade-modal')?.remove();
  document.removeEventListener('keydown', upEscHandler);
}

// ── Razorpay checkout ────────────────────────────────────────
// Lazily loads the Razorpay checkout script at most once — the promise itself
// is cached (not just re-derived from the DOM) so concurrent callers share the
// same in-flight load, and it's only ever requested once /api/pay/config says
// payments are enabled.
let _razorpayScriptPromise = null;
function loadRazorpayScript() {
  if (!_razorpayScriptPromise) {
    _razorpayScriptPromise = new Promise((resolve, reject) => {
      if (window.Razorpay) return resolve();
      const el = document.createElement('script');
      el.src = 'https://checkout.razorpay.com/v1/checkout.js';
      el.onload  = () => resolve();
      el.onerror = () => { _razorpayScriptPromise = null; reject(new Error('Could not load the payment library — check your connection.')); };
      document.head.appendChild(el);
    });
  }
  return _razorpayScriptPromise;
}

async function startProCheckout(plan) {
  const chosenPlan = plan === 'team' ? 'team' : 'individual';
  let cfg;
  try { cfg = await apiFetch('/api/pay/config'); }
  catch (_) { cfg = { enabled: false }; }
  if (!cfg.enabled) {
    toast("Online payment isn't set up yet — redeem an access code below, or contact support.", 'warning');
    return;
  }
  try {
    const { orderId, amount, currency, keyId, description } = await apiFetch('/api/pay/order', {
      method: 'POST',
      body: JSON.stringify({ plan: chosenPlan, teamId: chosenPlan === 'team' ? state.activeOrgId : undefined }),
    });
    await loadRazorpayScript();
    new Razorpay({
      key: keyId,
      order_id: orderId,
      amount, currency,
      name: 'Dive',
      description,
      prefill: { name: localStorage.getItem('crm_user') || '' },
      theme: { color: '#6366f1' },
      handler: async (resp) => {
        try {
          await apiFetch('/api/pay/verify', { method: 'POST', body: JSON.stringify(resp) });
          toast('✦ Pro active — payment successful!', 'success');
          await loadPlan();
          closeUpgradeModal();
          renderPage(state.page);
        } catch (e) {
          toast('Payment received but verification failed — contact support with your payment ID.', 'error');
        }
      },
      modal: { ondismiss: () => toast('Payment cancelled') },
    }).open();
  } catch (err) {
    toast(err.message, 'error');
  }
}

// Shared "invite & earn" populate: fetches the caller's referral link + credit
// count and fills the given elements; hides the whole box on any error (e.g.
// payments/referrals not configured yet). Used by both the upgrade modal and
// the profile modal — guests never call this (no account to share a code from).
async function loadReferralBlock(boxId, linkId, metaId) {
  const box = document.getElementById(boxId);
  if (!box) return;
  box.classList.remove('hidden');
  try {
    const { code, creditedCount, cap } = await apiFetch('/api/pay/referral');
    const linkEl = document.getElementById(linkId);
    if (linkEl) linkEl.value = `${location.origin}/?ref=${encodeURIComponent(code)}`;
    const metaEl = document.getElementById(metaId);
    if (metaEl) metaEl.textContent = `${creditedCount}/${cap} credited this year`;
  } catch (_) {
    box.classList.add('hidden');
  }
}

function copyReferLink(inputId) {
  const el = document.getElementById(inputId);
  if (!el || !el.value) return;
  navigator.clipboard?.writeText(el.value).then(() => toast('Invite link copied!'), () => toast('Copy failed', 'error'));
}

async function redeemProCode() {
  const input = document.getElementById('up-code-input');
  const msg   = document.getElementById('up-code-msg');
  const code  = (input?.value || '').trim();
  if (msg) msg.textContent = '';
  if (!code) { if (msg) { msg.className = 'up-msg err'; msg.textContent = 'Enter a code first.'; } return; }
  try {
    const res = await apiFetch('/api/plan/redeem', { method: 'POST', body: JSON.stringify({ code }) });
    state.plan = res.plan;
    renderPlanBadge();
    if (msg) { msg.className = 'up-msg ok'; msg.textContent = `Unlocked! +${res.added_days} days of Pro.`; }
    toast('Pro unlocked 🎉', 'success');
    setTimeout(() => { closeUpgradeModal(); applyRoleUI(); renderPage(state.page); }, 900);
  } catch (err) {
    if (msg) { msg.className = 'up-msg err'; msg.textContent = err.message || 'Could not redeem that code.'; }
  }
}

// Same redeem flow, driven from the Settings (profile) modal's own inputs.
async function redeemAccessFromSettings() {
  const input = document.getElementById('settings-code-input');
  const msg   = document.getElementById('settings-code-msg');
  const code  = (input?.value || '').trim();
  if (msg) msg.textContent = '';
  if (!code) { if (msg) { msg.className = 'up-msg err'; msg.textContent = 'Enter a code first.'; } return; }
  try {
    const res = await apiFetch('/api/plan/redeem', { method: 'POST', body: JSON.stringify({ code }) });
    state.plan = res.plan;
    renderPlanBadge();
    if (msg) { msg.className = 'up-msg ok'; msg.textContent = `Unlocked! +${res.added_days} days of Pro.`; }
    toast('Pro unlocked 🎉', 'success');
    if (input) input.value = '';
    applyRoleUI();
    renderPage(state.page);
  } catch (err) {
    if (msg) { msg.className = 'up-msg err'; msg.textContent = err.message || 'Could not redeem that code.'; }
  }
}

// ── Dev access-code panel (admin only) ──────────────────────
async function openCodesModal() {
  if (state.role !== 'admin') return;
  closeUpgradeModal();
  document.getElementById('codes-modal')?.remove();
  const html = `
  <div class="up-overlay" id="codes-modal" onclick="if(event.target===this)this.remove()">
    <div class="up-box codes-box" role="dialog" aria-modal="true" aria-label="Access codes">
      <button class="up-close" onclick="document.getElementById('codes-modal').remove()" aria-label="Close">✕</button>
      <div class="up-head"><div class="up-kicker">Dev panel</div><h2 class="up-title">Access codes</h2>
      <p class="up-sub">Generate a code, share it with whoever paid, they redeem it to unlock Pro.</p></div>
      <div class="codes-new">
        <input id="cc-days" type="number" min="1" value="30" title="Days of Pro" />
        <input id="cc-uses" type="number" min="1" value="1" title="How many people can use it" />
        <input id="cc-label" placeholder="Label (e.g. Acme Corp)" />
        <button class="btn btn-primary" onclick="createCode()">Generate</button>
      </div>
      <div id="codes-list" class="codes-list"><div class="ld-empty">Loading…</div></div>
    </div>
  </div>`;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap.firstElementChild);
  loadCodes();
}
async function loadCodes() {
  const box = document.getElementById('codes-list');
  if (!box) return;
  try {
    const codes = await apiFetch('/api/admin/codes');
    box.innerHTML = codes.length ? codes.map(c => `
      <div class="code-row">
        <button class="code-val" title="Tap to copy" onclick="copyText('${escAttr(c.code)}')">${escHtml(c.code)}</button>
        <span class="code-meta">${c.days}d · ${c.uses}/${c.max_uses} used${c.label ? ' · ' + escHtml(c.label) : ''}</span>
        <button class="code-del" title="Delete" onclick="deleteCode(${c.id})">✕</button>
      </div>`).join('') : '<div class="ld-empty">No codes yet — generate one above.</div>';
  } catch (err) { box.innerHTML = `<div class="ld-empty">${escHtml(err.message)}</div>`; }
}
async function createCode() {
  const days = document.getElementById('cc-days')?.value;
  const maxUses = document.getElementById('cc-uses')?.value;
  const label = document.getElementById('cc-label')?.value;
  try {
    const res = await apiFetch('/api/admin/codes', { method: 'POST', body: JSON.stringify({ days, max_uses: maxUses, label }) });
    toast(`Code ${res.code.code} created`, 'success');
    const lbl = document.getElementById('cc-label'); if (lbl) lbl.value = '';
    loadCodes();
  } catch (err) { toast(err.message, 'error'); }
}
async function deleteCode(id) {
  if (!confirm('Delete this code? People who already redeemed it keep their Pro.')) return;
  try { await apiFetch('/api/admin/codes/' + id, { method: 'DELETE' }); loadCodes(); }
  catch (err) { toast(err.message, 'error'); }
}
function copyText(t) {
  navigator.clipboard?.writeText(t).then(() => toast('Copied: ' + t), () => toast('Copy failed', 'error'));
}

// ============================================================
//  Team Hub (Pro) — tasks · activity · chat · leaderboard
//  A team-scoped collaboration space. Gated behind Pro + team
//  membership; every call carries ?teamId=<hubState.teamId>.
// ============================================================
const hubState = { teamId: '', tab: 'tasks', members: [], tasks: [], chatPoll: null, lastMsgId: 0, loaded: {} };

function me() { return localStorage.getItem('crm_user') || ''; }

// Which team the Hub operates on: the active workspace, else the first team.
function hubResolveTeamId() {
  if (state.activeOrgId) return String(state.activeOrgId);
  const t = (state.myTeams || [])[0];
  return t ? String(t.id) : '';
}
function hubTeamObj() {
  return (state.myTeams || []).find(t => String(t.id) === String(hubState.teamId)) || null;
}
function hubQuery(extra) {
  const q = new URLSearchParams();
  if (hubState.teamId) q.set('teamId', hubState.teamId);
  for (const k in (extra || {})) q.set(k, extra[k]);
  const s = q.toString();
  return s ? '?' + s : '';
}
const hubApi = (path, opts) => apiFetch(path + hubQuery(), opts);

// ── Entry point ───────────────────────────────────────────────
function renderHub() {
  const gate = document.getElementById('hub-gate');
  const main = document.getElementById('hub-main');
  if (!gate || !main) return;
  const show = (which) => {
    gate.classList.toggle('hidden', which !== 'gate');
    main.classList.toggle('hidden', which !== 'main');
  };

  if (state.role === 'guest') {
    gate.innerHTML = hubGateCard('👋', 'Sign in to use the Team Hub',
      'The Team Hub is where your sales team assigns tasks, chats and tracks who’s winning.',
      'Create an account', "showLoginPage()");
    return show('gate');
  }

  hubState.teamId = hubResolveTeamId();
  if (!hubState.teamId) {
    gate.innerHTML = hubGateCard('🏢', 'Create or join a team first',
      'The Team Hub works across your team. Set up a workspace, invite your reps, then come back here.',
      'Go to Workspace', "navigate('workspace')");
    return show('gate');
  }

  if (!isPro()) {
    gate.innerHTML = hubGateCard('✦', 'Team Hub is a Pro feature',
      'Assign tasks & leads, chat with your team in real time, see a live activity feed and a sales leaderboard.',
      'Unlock Pro', "openUpgradeModal('Team Hub')", true);
    return show('gate');
  }

  show('main');
  const t = hubTeamObj();
  const nm = (t && t.name) || 'Your team';
  document.getElementById('hub-team-name').textContent = nm;
  document.getElementById('hub-team-avatar').textContent = (nm.trim()[0] || '?').toUpperCase();
  document.getElementById('hub-team-meta').textContent = t ? `@${t.handle || 'team'}` : '';
  hubLoadMembers();
  hubLoadPresence();
  hubShowTab(hubState.tab || 'tasks');
}

function hubGateCard(icon, title, sub, btnLabel, onclick, pro) {
  return `<div class="hub-gate-card">
    <div class="hub-gate-icon ${pro ? 'is-pro' : ''}">${icon}</div>
    <h2 class="hub-gate-title">${escHtml(title)}</h2>
    <p class="hub-gate-sub">${escHtml(sub)}</p>
    <button class="btn btn-primary" onclick="${onclick}">${escHtml(btnLabel)}</button>
  </div>`;
}

async function hubLoadMembers() {
  try {
    const rows = await apiFetch(`/api/teams/${hubState.teamId}/members`, { headers: { 'X-Team-ID': String(hubState.teamId) } });
    hubState.members = rows.filter(m => m.status === 'active').map(m => m.display_name).filter(Boolean);
  } catch (_) { hubState.members = []; }
  // Patch the already-rendered assignee select in place (preserve selection).
  const sel = document.getElementById('hub-task-assignee');
  if (sel) {
    const cur = sel.value;
    sel.innerHTML = ['<option value="">Assign to…</option>']
      .concat(hubState.members.map(n => `<option value="${escAttr(n)}">${escHtml(n)}</option>`)).join('');
    sel.value = cur;
  }
}

async function hubLoadPresence() {
  const el = document.getElementById('hub-online');
  if (!el) return;
  try {
    const board = await hubApi('/api/team/leaderboard');
    hubState._board = board;
    const online = board.filter(p => p.online);
    const dots = online.slice(0, 6).map(p =>
      `<span class="hub-ava" title="${escAttr(p.name)}">${escHtml((p.name.trim()[0] || '?').toUpperCase())}</span>`).join('');
    el.innerHTML = online.length
      ? `${dots}<span class="hub-online-txt">${online.length} online</span>`
      : `<span class="hub-online-txt hub-online-none">No one online</span>`;
  } catch (_) { el.innerHTML = ''; }
}

// ── Tab switching ─────────────────────────────────────────────
function hubShowTab(tab) {
  hubState.tab = tab;
  document.querySelectorAll('#hub-tabs .hub-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ['tasks', 'activity', 'chat', 'board'].forEach(t =>
    document.getElementById('hub-panel-' + t)?.classList.toggle('hidden', t !== tab));
  if (tab !== 'chat') hubStopChatPoll();
  if (tab === 'tasks')    renderHubTasks();
  if (tab === 'activity') renderHubActivity();
  if (tab === 'chat')     renderHubChat();
  if (tab === 'board')    renderHubBoard();
}

// ── Tasks board ───────────────────────────────────────────────
const HUB_COLS = [
  { key: 'open',  label: 'To do' },
  { key: 'doing', label: 'In progress' },
  { key: 'done',  label: 'Done' },
];
const hubToday = () => new Date().toISOString().slice(0, 10);

async function renderHubTasks() {
  const panel = document.getElementById('hub-panel-tasks');
  if (!panel) return;
  const memberOpts = ['<option value="">Assign to…</option>']
    .concat(hubState.members.map(n => `<option value="${escAttr(n)}">${escHtml(n)}</option>`)).join('');
  panel.innerHTML = `
    <div class="hub-newtask">
      <input id="hub-task-title" placeholder="Add a task for the team…" maxlength="200"
        onkeydown="if(event.key==='Enter')hubAddTask()" />
      <select id="hub-task-assignee">${memberOpts}</select>
      <input id="hub-task-due" type="date" title="Due date" />
      <button class="btn btn-primary" onclick="hubAddTask()">Add</button>
    </div>
    <div id="hub-reminder"></div>
    <div id="hub-board" class="hub-board"><div class="ld-empty">Loading tasks…</div></div>`;
  try {
    hubState.tasks = await hubApi('/api/tasks');
    hubDrawBoard();
  } catch (err) {
    if (!hubHandleGate(err))
      document.getElementById('hub-board').innerHTML = `<div class="ld-empty">${escHtml(err.message)}</div>`;
  }
}

function hubDrawBoard() {
  const board = document.getElementById('hub-board');
  if (!board) return;
  const tasks = hubState.tasks || [];
  const open = tasks.filter(t => t.status !== 'done').length;
  const badge = document.getElementById('hub-badge-tasks');
  if (badge) { badge.textContent = open; badge.classList.toggle('hidden', !open); }
  hubDrawReminder(tasks);
  board.innerHTML = HUB_COLS.map(col => {
    const list = tasks.filter(t => (t.status || 'open') === col.key);
    return `<div class="hub-col">
      <div class="hub-col-head">${col.label}<span class="hub-col-n">${list.length}</span></div>
      <div class="hub-col-body">
        ${list.length ? list.map(hubTaskCard).join('') : '<div class="hub-col-empty">—</div>'}
      </div>
    </div>`;
  }).join('');
}

// Personal reminder banner: your open + overdue tasks, from the loaded board.
function hubDrawReminder(tasks) {
  const box = document.getElementById('hub-reminder');
  if (!box) return;
  const mine = me().toLowerCase();
  const my = (tasks || []).filter(t => t.status !== 'done' && String(t.assignee || '').toLowerCase() === mine);
  if (!my.length) { box.innerHTML = ''; return; }
  const overdue = my.filter(t => t.due_at && t.due_at < hubToday()).length;
  box.innerHTML = `<div class="hub-reminder${overdue ? ' has-overdue' : ''}">
    <span class="hub-reminder-ico">📌</span>
    <span><b>${my.length}</b> task${my.length === 1 ? '' : 's'} assigned to you${overdue ? ` · <b class="hub-reminder-over">${overdue} overdue</b>` : ''}</span>
  </div>`;
}

function hubTaskCard(t) {
  const overdue = t.status !== 'done' && t.due_at && t.due_at < hubToday();
  const chips = [];
  // Lead-reference chip wears the hub team's own business icon (🏪 for a
  // retail team, 🎓 for coaching, …) — 🏭 only as the fallback.
  const bizIcon = (BUSINESS_TYPES[hubTeamObj()?.business_type] || BUSINESS_TYPES.factory).icon || '🏭';
  if (t.assignee)   chips.push(`<span class="hub-chip">👤 ${escHtml(t.assignee)}</span>`);
  if (t.due_at)     chips.push(`<span class="hub-chip ${overdue ? 'is-overdue' : ''}">📅 ${escHtml(t.due_at)}</span>`);
  if (t.lead_label) chips.push(`<span class="hub-chip">${bizIcon} ${escHtml(t.lead_label)}</span>`);
  let moves = '';
  if (t.status === 'open')  moves = `<button onclick="hubMoveTask(${t.id},'doing')">Start ▸</button><button onclick="hubMoveTask(${t.id},'done')">✓</button>`;
  if (t.status === 'doing') moves = `<button onclick="hubMoveTask(${t.id},'open')">◂ Back</button><button onclick="hubMoveTask(${t.id},'done')">✓ Done</button>`;
  if (t.status === 'done')  moves = `<button onclick="hubMoveTask(${t.id},'doing')">↩ Reopen</button>`;
  return `<div class="hub-task${t.status === 'done' ? ' is-done' : ''}">
    <div class="hub-task-title">${escHtml(t.title)}</div>
    ${chips.length ? `<div class="hub-task-meta">${chips.join('')}</div>` : ''}
    <div class="hub-task-actions">${moves}<button class="hub-task-del" title="Delete" onclick="hubDeleteTask(${t.id})">🗑</button></div>
  </div>`;
}

async function hubAddTask() {
  const titleEl = document.getElementById('hub-task-title');
  const title = (titleEl?.value || '').trim();
  if (!title) { titleEl?.focus(); return; }
  const assignee = document.getElementById('hub-task-assignee')?.value || '';
  const due_at   = document.getElementById('hub-task-due')?.value || '';
  try {
    const res = await hubApi('/api/tasks', { method: 'POST', body: JSON.stringify({ title, assignee, due_at }) });
    hubState.tasks.unshift(res.task);
    if (titleEl) titleEl.value = '';
    const d = document.getElementById('hub-task-due'); if (d) d.value = '';
    hubDrawBoard();
    toast('Task added', 'success');
  } catch (err) { if (!hubHandleGate(err)) toast(err.message, 'error'); }
}

async function hubMoveTask(id, status) {
  try {
    const res = await hubApi('/api/tasks/' + id, { method: 'PATCH', body: JSON.stringify({ status }) });
    const i = hubState.tasks.findIndex(t => String(t.id) === String(id));
    if (i >= 0 && res.task) hubState.tasks[i] = res.task;
    hubDrawBoard();
  } catch (err) { if (!hubHandleGate(err)) toast(err.message, 'error'); }
}

async function hubDeleteTask(id) {
  if (!confirm('Delete this task?')) return;
  try {
    await hubApi('/api/tasks/' + id, { method: 'DELETE' });
    hubState.tasks = hubState.tasks.filter(t => String(t.id) !== String(id));
    hubDrawBoard();
  } catch (err) { if (!hubHandleGate(err)) toast(err.message, 'error'); }
}

// ── Activity feed ─────────────────────────────────────────────
const HUB_VERBS = {
  created:      { icon: '➕', text: 'added lead' },
  stage_change: { icon: '🔄', text: 'moved' },
  edit:         { icon: '✏️', text: 'edited' },
  shared:       { icon: '🤝', text: 'shared' },
  hidden:       { icon: '🙈', text: 'hid' },
  unhidden:     { icon: '👁', text: 'unhid' },
  imported:     { icon: '📥', text: 'imported leads' },
  task_created: { icon: '📝', text: 'created task' },
  task_done:    { icon: '✅', text: 'completed task' },
};

async function renderHubActivity() {
  const panel = document.getElementById('hub-panel-activity');
  if (!panel) return;
  panel.innerHTML = `<div class="ld-empty">Loading activity…</div>`;
  try {
    const items = await hubApi('/api/team/activity');
    if (!items.length) { panel.innerHTML = `<div class="hub-empty">No team activity yet. Add a lead or a task to get started.</div>`; return; }
    panel.innerHTML = `<div class="hub-feed">${items.map(hubActivityRow).join('')}</div>`;
  } catch (err) { if (!hubHandleGate(err)) panel.innerHTML = `<div class="ld-empty">${escHtml(err.message)}</div>`; }
}

function hubActivityRow(a) {
  const v = HUB_VERBS[a.verb] || { icon: '•', text: a.verb };
  const who = escHtml(a.actor || 'Someone');
  const label = a.label ? ` <b>${escHtml(a.label)}</b>` : '';
  const extra = a.source === 'lead' && a.text && (a.verb === 'stage_change')
    ? ` <span class="hub-feed-extra">${escHtml(a.text)}</span>` : '';
  return `<div class="hub-feed-row">
    <span class="hub-feed-ico">${v.icon}</span>
    <div class="hub-feed-body"><span class="hub-feed-txt">${who} ${escHtml(v.text)}${label}${extra}</span>
    <span class="hub-feed-time">${hubTimeAgo(a.created_at)}</span></div>
  </div>`;
}

// ── Chat ──────────────────────────────────────────────────────
function renderHubChat() {
  const panel = document.getElementById('hub-panel-chat');
  if (!panel) return;
  panel.innerHTML = `
    <div class="hub-chat">
      <div id="hub-chat-msgs" class="hub-chat-msgs"><div class="ld-empty">Loading…</div></div>
      <div class="hub-chat-compose">
        <textarea id="hub-chat-input" rows="1" placeholder="Message your team…"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();hubSendMessage();}"></textarea>
        <button class="btn btn-primary" onclick="hubSendMessage()">Send</button>
      </div>
    </div>`;
  hubState.lastMsgId = 0;
  hubLoadMessages(true);
  hubStartChatPoll();
}

async function hubLoadMessages(initial) {
  try {
    const q = hubQuery(hubState.lastMsgId ? { after: hubState.lastMsgId } : null);
    const msgs = await apiFetch('/api/team/messages' + q);
    hubRenderMessages(msgs, !initial);
  } catch (err) {
    if (initial && !hubHandleGate(err)) {
      const box = document.getElementById('hub-chat-msgs');
      if (box) box.innerHTML = `<div class="ld-empty">${escHtml(err.message)}</div>`;
    }
  }
}

function hubRenderMessages(msgs, append) {
  const box = document.getElementById('hub-chat-msgs');
  if (!box) return;
  if (!append) box.innerHTML = '';
  if (!append && !msgs.length) { box.innerHTML = `<div class="hub-empty">No messages yet — say hi 👋</div>`; return; }
  const mine = me().toLowerCase();
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  // Dedupe by id when appending: a send can race the 4s poll and both deliver
  // the same message. Full reloads (append=false) still render everything.
  const seen = hubState.lastMsgId;
  const fresh = append ? msgs.filter(m => m.id > seen) : msgs;
  const frag = fresh.map(m => {
    if (m.id > hubState.lastMsgId) hubState.lastMsgId = m.id;
    const isMine = String(m.sender || '').toLowerCase() === mine;
    return `<div class="hub-msg${isMine ? ' mine' : ''}">
      ${isMine ? '' : `<div class="hub-msg-who">${escHtml(m.sender)}</div>`}
      <div class="hub-msg-bubble">${escHtml(m.body).replace(/\n/g, '<br>')}</div>
      <div class="hub-msg-time">${hubClock(m.created_at)}</div>
    </div>`;
  }).join('');
  const empty = box.querySelector('.hub-empty'); if (empty) box.innerHTML = '';
  box.insertAdjacentHTML('beforeend', frag);
  if (!append || atBottom) box.scrollTop = box.scrollHeight;
}

async function hubSendMessage() {
  const input = document.getElementById('hub-chat-input');
  const body = (input?.value || '').trim();
  if (!body) return;
  input.value = '';
  try {
    const res = await hubApi('/api/team/messages', { method: 'POST', body: JSON.stringify({ body }) });
    if (res.message) hubRenderMessages([res.message], true);
  } catch (err) { if (!hubHandleGate(err)) { toast(err.message, 'error'); if (input) input.value = body; } }
}

function hubStartChatPoll() {
  hubStopChatPoll();
  hubState.chatPoll = setInterval(() => { if (state.page === 'hub' && hubState.tab === 'chat') hubLoadMessages(false); }, 4000);
}
function hubStopChatPoll() {
  if (hubState.chatPoll) { clearInterval(hubState.chatPoll); hubState.chatPoll = null; }
}

// ── Leaderboard + presence ────────────────────────────────────
async function renderHubBoard() {
  const panel = document.getElementById('hub-panel-board');
  if (!panel) return;
  panel.innerHTML = `<div class="ld-empty">Loading leaderboard…</div>`;
  try {
    const board = await hubApi('/api/team/leaderboard');
    hubState._board = board;
    if (!board.length) { panel.innerHTML = `<div class="hub-empty">No teammates yet.</div>`; return; }
    const medal = i => ['🥇', '🥈', '🥉'][i] || `${i + 1}`;
    panel.innerHTML = `
      <div class="hub-lead-note">Score = leads + hot×2 + tasks done×3</div>
      <div class="hub-lead">
        ${board.map((p, i) => `
          <div class="hub-lead-row${i < 3 ? ' top' : ''}">
            <div class="hub-lead-rank">${medal(i)}</div>
            <div class="hub-lead-who">
              <span class="hub-ava sm ${p.online ? 'on' : ''}">${escHtml((p.name.trim()[0] || '?').toUpperCase())}</span>
              <div><div class="hub-lead-name">${escHtml(p.name)}${p.online ? '<span class="hub-live-dot" title="Online"></span>' : ''}</div>
              <div class="hub-lead-sub">${p.total} leads · ${p.hot} hot · ${p.done} done</div></div>
            </div>
            <div class="hub-lead-score">${p.score}</div>
          </div>`).join('')}
      </div>`;
  } catch (err) { if (!hubHandleGate(err)) panel.innerHTML = `<div class="ld-empty">${escHtml(err.message)}</div>`; }
}

// ── Shared helpers ────────────────────────────────────────────
// If a call 402s (Pro lapsed mid-session), re-render the gate. Returns true if handled.
function hubHandleGate(err) {
  if (err && /pro required|402/i.test(err.message || '')) {
    state.plan = { isPro: false, plan: 'lite', daysLeft: 0 };
    renderPlanBadge();
    renderHub();
    return true;
  }
  return false;
}

function hubTimeAgo(ts) {
  const d = new Date(ts).getTime();
  if (!d) return '';
  const s = Math.floor((Date.now() - d) / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
  const days = Math.floor(h / 24); if (days < 7) return days + 'd ago';
  return new Date(ts).toLocaleDateString();
}
function hubClock(ts) {
  const d = new Date(ts);
  return isNaN(d) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// Presence heartbeat — every logged-in client pings so "who's online" stays live.
let presenceTimer = null;
function startPresenceHeartbeat() {
  if (state.role === 'guest') return;
  const ping = () => apiFetch('/api/presence', { method: 'POST' }).catch(() => {});
  ping();
  if (presenceTimer) clearInterval(presenceTimer);
  presenceTimer = setInterval(() => { if (document.visibilityState === 'visible') ping(); }, 90000);
}

async function init() {
  initTheme();
  wireEvents();
  initChatViewport();
  initAiBubble();
  initInstallPrompt();
  initIdleLock();           // heartbeat + re-lock after a long idle gap
  capturePendingInvite();   // park ?join=CODE so it survives the login/register wall
  // Show overlay while we check auth state
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  await checkAndShowAuth();
}

// ============================================================
//  Floating AI assistant bubble — draggable launcher for the AI chat.
//  Tap to open chat, drag to reposition (position persists), drag onto the
//  "Remove" zone to hide it; re-enable from the sidebar. Visibility +
//  position are saved in localStorage so it stays how the user left it.
// ============================================================
const AI_BUBBLE_HIDDEN_KEY = 'crm_ai_bubble_hidden';
const AI_BUBBLE_POS_KEY     = 'crm_ai_bubble_pos';

function bubbleHidden() { return localStorage.getItem(AI_BUBBLE_HIDDEN_KEY) === '1'; }

// Viewport size — clientWidth/Height are more reliable than innerWidth/Height
// (which some embedded/automation contexts report as 0, breaking the clamp).
function bubbleVW() { return document.documentElement.clientWidth  || window.innerWidth  || 360; }
function bubbleVH() { return document.documentElement.clientHeight || window.innerHeight || 640; }

function applyBubblePosition() {
  const bubble = document.getElementById('ai-bubble');
  if (!bubble) return;
  let pos = null;
  try { pos = JSON.parse(localStorage.getItem(AI_BUBBLE_POS_KEY)); } catch (_) {}
  const m = 8, w = bubble.offsetWidth || 56, h = bubble.offsetHeight || 56;
  if (pos && typeof pos.left === 'number') {
    // Re-clamp to the current viewport (handles rotation / smaller screens).
    const left = Math.max(m, Math.min(bubbleVW() - w - m, pos.left));
    const top  = Math.max(m, Math.min(bubbleVH() - h - m, pos.top));
    bubble.style.left = left + 'px'; bubble.style.top = top + 'px';
    bubble.style.right = 'auto'; bubble.style.bottom = 'auto';
  } else {
    // Default: bottom-right, lifted above the mobile bottom nav.
    bubble.style.left = ''; bubble.style.top = '';
    bubble.style.right = '16px';
    bubble.style.bottom = (bubbleVW() <= 640 ? 88 : 24) + 'px';
  }
}

function saveBubblePosition() {
  const bubble = document.getElementById('ai-bubble');
  if (!bubble) return;
  const r = bubble.getBoundingClientRect();
  localStorage.setItem(AI_BUBBLE_POS_KEY, JSON.stringify({ left: Math.round(r.left), top: Math.round(r.top) }));
}

function updateBubbleToggleLabel() {
  const txt = bubbleHidden() ? '💬 Show AI assistant' : '💬 Hide AI assistant';
  ['btn-toggle-bubble', 'settings-bubble-toggle'].forEach(id => {
    const b = document.getElementById(id); if (b) b.textContent = txt;
  });
}

function showAiBubble() {
  localStorage.setItem(AI_BUBBLE_HIDDEN_KEY, '0');
  document.getElementById('ai-bubble')?.classList.remove('hidden');
  applyBubblePosition();
  updateBubbleToggleLabel();
}
function hideAiBubble() {
  localStorage.setItem(AI_BUBBLE_HIDDEN_KEY, '1');
  document.getElementById('ai-bubble')?.classList.add('hidden');
  updateBubbleToggleLabel();
  toast('AI bubble hidden — turn it back on from Settings');
}
function toggleAiBubble() { bubbleHidden() ? showAiBubble() : hideAiBubble(); }

// Called once after login to reveal the bubble unless the user hid it. (The
// bubble lives inside #app, so the login screen hides it automatically.)
function refreshAiBubbleVisibility() {
  const bubble = document.getElementById('ai-bubble');
  if (!bubble) return;
  bubble.classList.toggle('hidden', bubbleHidden());
  applyBubblePosition();
  updateBubbleToggleLabel();
}

function initAiBubble() {
  const bubble = document.getElementById('ai-bubble');
  const trash  = document.getElementById('ai-bubble-trash');
  if (!bubble) return;
  applyBubblePosition();
  updateBubbleToggleLabel();

  let start = null, moved = false;
  const overTrash = (x, y) => {
    if (!trash) return false;
    const t = trash.getBoundingClientRect();
    return x >= t.left && x <= t.right && y >= t.top && y <= t.bottom;
  };
  const onMove = (e) => {
    if (!start) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (!moved && Math.abs(dx) + Math.abs(dy) > 6) { moved = true; document.body.classList.add('bubble-dragging'); }
    if (!moved) return;
    const m = 8, w = bubble.offsetWidth, h = bubble.offsetHeight;
    const left = Math.max(m, Math.min(bubbleVW() - w - m, start.left + dx));
    const top  = Math.max(m, Math.min(bubbleVH() - h - m, start.top + dy));
    bubble.style.left = left + 'px'; bubble.style.top = top + 'px';
    bubble.style.right = 'auto'; bubble.style.bottom = 'auto';
    if (trash) trash.classList.toggle('hot', overTrash(e.clientX, e.clientY));
  };
  const onUp = (e) => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    bubble.classList.remove('grabbing');
    document.body.classList.remove('bubble-dragging');
    if (trash) trash.classList.remove('hot');
    const wasMoved = moved, s = start; start = null; moved = false;
    if (!wasMoved) { navigate('chat'); return; }              // a tap → open chat
    if (s && overTrash(e.clientX, e.clientY)) { hideAiBubble(); return; }  // dropped on Remove
    saveBubblePosition();
  };
  bubble.addEventListener('pointerdown', (e) => {
    if (e.button != null && e.button !== 0) return;
    const rect = bubble.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, left: rect.left, top: rect.top };
    moved = false;
    bubble.classList.add('grabbing');
    try { bubble.setPointerCapture(e.pointerId); } catch (_) {}
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
  // Keep it on-screen after rotation / resize.
  window.addEventListener('resize', () => { if (!bubbleHidden()) applyBubblePosition(); });
}

// ── PWA install ("Add to Home Screen") ──────────────────────
let _deferredInstall = null;
function initInstallPrompt() {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); _deferredInstall = e;
    document.getElementById('btn-install-app')?.classList.remove('hidden');
  });
  window.addEventListener('appinstalled', () => {
    _deferredInstall = null;
    document.getElementById('btn-install-app')?.classList.add('hidden');
    toast('Installed! You can open Dive from your home screen now.');
  });
}
async function installApp() {
  if (_deferredInstall) {
    _deferredInstall.prompt();
    try { await _deferredInstall.userChoice; } catch (_) {}
    _deferredInstall = null;
    document.getElementById('btn-install-app')?.classList.add('hidden');
    return;
  }
  // iOS/Safari has no install event — guide the manual flow.
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  toast(isIOS ? 'Tap the Share icon, then “Add to Home Screen”.'
              : 'Use your browser menu → “Install app” / “Add to Home Screen”.', 'info');
}

// ============================================================
//  Biometric — Register (called from sidebar after login)
// ============================================================
async function enableBiometric() {
  const btn = document.getElementById('btn-enable-biometric');
  btn.disabled    = true;
  btn.textContent = '🔐 Setting up…';
  try {
    const token = localStorage.getItem('crm_token');

    // Step 1: get options from server
    const optRes = await fetch('/api/webauthn/register-options', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
    });
    if (!optRes.ok) throw new Error((await optRes.json()).error);
    const options = await optRes.json();

    // Step 2: browser prompts for biometric (fingerprint / Face ID)
    const credential = await SimpleWebAuthnBrowser.startRegistration(options);

    // Step 3: verify with server
    const verRes = await fetch('/api/webauthn/register-verify', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(credential),
    });
    const verData = await verRes.json();
    if (!verRes.ok) throw new Error(verData.error);

    // Save flag so login page shows the biometric button
    const name = localStorage.getItem('crm_user') || '';
    localStorage.setItem('biometric_enabled', name);

    btn.textContent = '🔐 Biometric Active';
    toast('Biometric login enabled! You can now sign in with your fingerprint.', 'success');
  } catch (err) {
    btn.disabled    = false;
    btn.textContent = '🔐 Enable Biometric Login';
    if (err.name === 'NotAllowedError') {
      toast('Biometric prompt was cancelled.', 'error');
    } else {
      toast('Biometric setup failed: ' + err.message, 'error');
    }
  }
}

// ============================================================
//  Biometric — Authenticate (called from login screen button)
// ============================================================
async function loginWithBiometric() {
  // This button lives on both the full login screen and the welcome-back
  // unlock screen — write status to whichever one is currently visible.
  const onUnlock = getComputedStyle(document.getElementById('pin-unlock-screen')).display !== 'none';
  const btn   = document.getElementById(onUnlock ? 'pin-unlock-biometric' : 'btn-biometric-login');
  const errEl = document.getElementById(onUnlock ? 'pin-error' : 'login-error');
  btn.disabled    = true;
  btn.textContent = '🔐 Waiting for biometric…';
  errEl.textContent = '';
  try {
    // Step 1: get challenge from server
    const optRes = await fetch('/api/webauthn/auth-options', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
    });
    if (!optRes.ok) throw new Error((await optRes.json()).error);
    const { sessionId, ...options } = await optRes.json();

    // Step 2: browser shows biometric / passkey picker
    const credential = await SimpleWebAuthnBrowser.startAuthentication(options);

    // Step 3: verify with server, get JWT
    const verRes = await fetch('/api/webauthn/auth-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ credential, sessionId }),
    });
    const data = await verRes.json();
    if (!verRes.ok) throw new Error(data.error);

    // Logged in — same flow as password login
    localStorage.setItem('crm_token', data.token);
    localStorage.setItem('crm_role',  data.role);
    localStorage.setItem('crm_user',  data.username);
    state.role = data.role;
    hideLoginPage();
    await initApp();
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      errEl.textContent = 'Biometric prompt was cancelled.';
    } else {
      errEl.textContent = err.message || 'Biometric login failed.';
    }
  } finally {
    btn.disabled    = false;
    btn.textContent = '🔐 Use Biometric / Fingerprint';
  }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  // Auto-refresh onto a new deploy: the SW is cache-first, so when a new version
  // ships (new sw.js → skipWaiting → clients.claim) the controller changes. On a
  // real UPDATE (there was already a controller at load) we reload ONCE so the
  // user picks up the fresh app.js/CSS instead of running a stale cached bundle.
  // The first-ever install (no prior controller) does NOT reload.
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }   // first install — nothing to refresh
    if (window.__swReloaded) return;
    window.__swReloaded = true;
    window.location.reload();
  });
}

// ============================================================
//  CHAT — In-app lead parser (replaces Telegram bot flow)
// ============================================================

const CHAT_PRODUCTS = [
  { label: 'Hotmelt', icon: '🟠' }, { label: 'Latex', icon: '🟡' },
  { label: 'BC', icon: '🔵' },      { label: 'Toluene', icon: '🧪' },
  { label: 'R6', icon: '🔶' },      { label: 'MEK', icon: '🧴' },
  { label: 'PU Adhesive', icon: '🟣' }, { label: 'Silicon', icon: '⚪' },
];

// ── Mobile keyboard: keep chat pinned above keyboard ─────
function setupChatViewport() {
  if (!window.visualViewport || window._chatVpSetup) return;
  window._chatVpSetup = true;
  const adjust = () => {
    if (state.page !== 'chat') return;
    const container = document.querySelector('.chat-container');
    if (!container) return;
    const topbarH = document.getElementById('topbar')?.offsetHeight || 60;
    container.style.height = (window.visualViewport.height - topbarH) + 'px';
    const box = document.getElementById('chat-messages');
    if (box) box.scrollTop = box.scrollHeight;
  };
  window.visualViewport.addEventListener('resize', adjust);
}

function chatFocusInput() {
  setupChatViewport();
  setTimeout(() => {
    const input = document.getElementById('chat-input');
    input?.focus();
    const box = document.getElementById('chat-messages');
    if (box) box.scrollTop = box.scrollHeight;
  }, 50);
}

// ── Chip insert ──────────────────────────────────────────
function chatInsertChip(text) {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const cur = input.value.trimEnd();
  input.value = cur ? cur + ' ' + text : text;
  input.focus();
  input.selectionStart = input.selectionEnd = input.value.length;
  chatInputChanged(input.value);
}

// ── Product autocomplete ─────────────────────────────────
function chatInputChanged(val) {
  const ac = document.getElementById('chat-autocomplete');
  if (!ac) return;
  if (aiMode === 'assistant') { ac.className = 'chat-autocomplete'; return; }
  const words = val.trimEnd().split(/\s+/);
  const last  = words[words.length - 1].toLowerCase();
  if (last.length < 2) { ac.className = 'chat-autocomplete'; return; }

  // Products first, then the user's own factories / contacts / areas —
  // the AI suggests what YOU usually type.
  const seen = new Set();
  const matches = [];
  for (const p of CHAT_PRODUCTS) {
    if (p.label.toLowerCase().startsWith(last) && p.label.toLowerCase() !== last) {
      matches.push({ icon: p.icon, label: p.label });
      seen.add(p.label.toLowerCase());
    }
  }
  for (const l of state.leads) {
    if (matches.length >= 6) break;
    const cands = [
      ['🏭', l.factory_number], ['🏢', l.factory_name],
      ['👤', l.person_in_charge], ['📍', l.area],
    ];
    for (const [icon, v] of cands) {
      const s = String(v || '').trim();
      const sl = s.toLowerCase();
      if (!s || sl === last || seen.has(sl)) continue;
      if (sl.startsWith(last) || sl.split(/\s+/).some(w => w.startsWith(last))) {
        matches.push({ icon, label: s });
        seen.add(sl);
        if (matches.length >= 6) break;
      }
    }
  }

  if (!matches.length) { ac.className = 'chat-autocomplete'; return; }
  ac.innerHTML = matches.slice(0, 6).map(m =>
    `<div class="chat-ac-item" onmousedown="chatSelectProduct('${escAttr(m.label)}')">
       <span class="chat-ac-icon">${m.icon}</span>${escHtml(m.label)}
     </div>`
  ).join('');
  ac.className = 'chat-autocomplete open';
}

function chatSelectProduct(product) {
  const input = document.getElementById('chat-input');
  if (!input) return;
  const words = input.value.trimEnd().split(/\s+/);
  words[words.length - 1] = product;
  input.value = words.join(' ') + ' ';
  input.focus();
  input.selectionStart = input.selectionEnd = input.value.length;
  document.getElementById('chat-autocomplete').className = 'chat-autocomplete';
}

function chatAppendMessage(role, html) {
  const box = document.getElementById('chat-messages');
  if (!box) return;
  const div = document.createElement('div');
  div.className = 'chat-msg ' + role;
  div.innerHTML = html;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

function chatReplaceLastBot(html) {
  const box = document.getElementById('chat-messages');
  if (!box) return;
  const bots = box.querySelectorAll('.chat-msg.bot');
  const last = bots[bots.length - 1];
  if (last) last.innerHTML = html;
  box.scrollTop = box.scrollHeight;
}

// Enter key sends, Shift+Enter adds newline; blur hides autocomplete
document.addEventListener('DOMContentLoaded', () => {
  const ci = document.getElementById('chat-input');
  ci?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); chatSend(); }
    if (e.key === 'Escape') document.getElementById('chat-autocomplete').className = 'chat-autocomplete';
  });
  ci?.addEventListener('blur', () => {
    // short delay so onmousedown on ac item fires first
    setTimeout(() => { document.getElementById('chat-autocomplete').className = 'chat-autocomplete'; }, 150);
  });
});

function escHtml(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ============================================================
//  WORKSPACE
// ============================================================

const ws = {
  activeTeam:   null,   // { id, name, handle, team_code, invite_code, role, ... }
  myTeams:      [],
};

function wsTeamApiFetch(path, opts = {}) {
  if (!ws.activeTeam) return Promise.reject(new Error('No active team'));
  const headers = { 'Content-Type': 'application/json' };
  const token = localStorage.getItem('crm_token');
  if (token) headers['Authorization'] = 'Bearer ' + token;
  headers['X-Team-ID'] = String(ws.activeTeam.id);
  return fetch(path, { headers, ...opts, headers })
    .then(async r => {
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || `${r.status}`);
      return d;
    });
}

async function renderWorkspace() {
  // Load my teams — through loadMyTeams() so the global state.myTeams, the
  // stale-workspace guard and the header org switcher stay in sync with what
  // this page shows (visiting Workspace also picks up an approval that
  // happened while you were away).
  try {
    await loadMyTeams();
    ws.myTeams = state.myTeams || [];
    renderOrgSwitcher();
  } catch (_) { ws.myTeams = []; }

  if (!ws.myTeams.length) {
    // Not in any team yet — show hero + create/join UI
    document.getElementById('ws-no-team').classList.remove('hidden');
    document.getElementById('ws-team').classList.add('hidden');
    document.getElementById('ws-panel-search').classList.add('hidden');
    document.getElementById('ws-panel-create').classList.add('hidden');
    document.getElementById('ws-panel-join').classList.add('hidden');
    wsRenderCreate(); // pre-render create form
    wsRenderSearch(); // pre-render search
    return;
  }

  // Pick first active team (or last used)
  const savedId = localStorage.getItem('ws_team_id');
  ws.activeTeam = ws.myTeams.find(t => t.id === parseInt(savedId, 10)) || ws.myTeams[0];
  localStorage.setItem('ws_team_id', ws.activeTeam.id);

  document.getElementById('ws-no-team').classList.add('hidden');
  document.getElementById('ws-team').classList.remove('hidden');
  document.getElementById('ws-panel-search').classList.add('hidden');
  document.getElementById('ws-panel-create').classList.add('hidden');
  document.getElementById('ws-panel-join').classList.add('hidden');

  wsFillBanner();
  wsApplyRoleVisibility();
  wsShowTab('overview');
}

function wsFillBanner() {
  const t = ws.activeTeam;
  // This team's OWN business profile — never biz(), which follows the
  // workspace you're currently viewing (Personal vs whatever team is active).
  const p = resolveBizProfile(t.business_type, t.business_custom);
  document.getElementById('ws-team-avatar').textContent = (t.name || '?')[0].toUpperCase();
  document.getElementById('ws-team-name').textContent   = t.name;
  document.getElementById('ws-team-meta').textContent   =
    `@${t.handle}  ·  ${t.team_code}  ·  Your role: ${t.role}  ·  ${p.icon} ${p.label}`;
}

function wsApplyRoleVisibility() {
  const isAdmin = ['owner', 'admin'].includes(ws.activeTeam?.role);
  document.querySelectorAll('.ws-tab-admin').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });
}

function wsShowTab(tab) {
  // Hide all panels
  document.querySelectorAll('.ws-panel').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.ws-tab').forEach(t => t.classList.remove('active'));
  // Highlight tab button
  const btn = document.querySelector(`.ws-tab[data-tab="${tab}"]`);
  if (btn) btn.classList.add('active');

  const panelId = `ws-panel-${tab}`;
  const panel   = document.getElementById(panelId);
  if (panel) panel.classList.remove('hidden');

  if (tab === 'overview')  wsRenderOverview();
  if (tab === 'members')   wsRenderMembers();
  if (tab === 'requests')  wsRenderRequests();
  if (tab === 'settings')  wsRenderSettings();
  if (tab === 'search')    wsRenderSearch();
  if (tab === 'create')    wsRenderCreate();
  if (tab === 'join')      wsRenderJoin();
}

// ── Overview ─────────────────────────────────────────────────

function wsRenderOverview() {
  const t    = ws.activeTeam;
  const link = `${location.origin}?join=${t.invite_code}`;
  document.getElementById('ws-panel-overview').innerHTML = `
    <div class="ws-cards">
      <div class="ws-info-card">
        <h3>Team Info</h3>
        <div class="ws-info-row"><span>Name</span><b>${escHtml(t.name)}</b></div>
        <div class="ws-info-row"><span>Handle</span><b>@${escHtml(t.handle)}</b></div>
        <div class="ws-info-row"><span>Team ID</span><b>${escHtml(t.team_code)}</b></div>
        <div class="ws-info-row"><span>Your role</span><b class="ws-role-badge ws-role-${t.role}">${t.role}</b></div>
      </div>
      <div class="ws-info-card">
        <h3>Invite Code</h3>
        <div class="ws-invite-code" id="ws-inv-code">${escHtml(t.invite_code)}</div>
        <button class="btn btn-ghost btn-sm" onclick="wsCopyInvite()">Copy Code</button>
        <button class="btn btn-ghost btn-sm" onclick="wsCopyLink()">Copy Link</button>
        ${['owner','admin'].includes(t.role) ? `<button class="btn btn-ghost btn-sm" onclick="wsRegenInvite()">Regenerate</button>` : ''}
        <div class="ws-invite-link" id="ws-inv-link" style="font-size:11px;color:var(--text-muted);margin-top:8px;word-break:break-all">${escHtml(link)}</div>
        <p style="font-size:11.5px;color:var(--text-muted);margin-top:8px">🎁 New members who join with this invite get 2 months of Dive Pro free.</p>
      </div>
    </div>`;
}

function wsCopyInvite() {
  navigator.clipboard?.writeText(ws.activeTeam.invite_code).then(() => toast('Invite code copied!'), () => toast('Copy failed', 'error'));
}

function wsCopyLink() {
  const link = `${location.origin}?join=${ws.activeTeam.invite_code}`;
  navigator.clipboard?.writeText(link).then(() => toast('Invite link copied!'), () => toast('Copy failed', 'error'));
}

async function wsRegenInvite() {
  if (!confirm('Regenerate invite code? The old code will stop working.')) return;
  try {
    const { invite_code } = await wsTeamApiFetch(`/api/teams/${ws.activeTeam.id}/invite/regenerate`, { method: 'POST' });
    ws.activeTeam.invite_code = invite_code;
    ws.myTeams.find(t => t.id === ws.activeTeam.id).invite_code = invite_code;
    wsRenderOverview();
    toast('Invite code regenerated!');
  } catch (err) { toast(err.message, 'error'); }
}

// ── Members ───────────────────────────────────────────────────

async function wsRenderMembers() {
  const panel = document.getElementById('ws-panel-members');
  panel.innerHTML = `<div style="padding:20px;color:var(--text-muted)">Loading members…</div>`;
  try {
    const members = await wsTeamApiFetch(`/api/teams/${ws.activeTeam.id}/members`);
    const isAdmin = ['owner', 'admin'].includes(ws.activeTeam.role);
    const rows = members.map(m => {
      const roleOpts = ['owner','admin','manager','sales','viewer'];
      const roleSelect = isAdmin && m.role !== 'owner'
        ? `<select class="ws-role-select" onchange="wsChangeMemberRole(${m.user_id}, this.value)">
             ${roleOpts.filter(r => r !== 'owner').map(r =>
               `<option value="${r}" ${m.role === r ? 'selected' : ''}>${r}</option>`
             ).join('')}
           </select>`
        : `<span class="ws-role-badge ws-role-${m.role}">${m.role}</span>`;

      const actions = isAdmin && m.role !== 'owner'
        ? `<button class="action-btn del" onclick="wsRemoveMember(${m.user_id}, '${escAttr(m.display_name)}')">Remove</button>`
        : '—';

      const statusBadge = m.status === 'active'
        ? `<span style="color:var(--success)">● Active</span>`
        : `<span style="color:var(--text-muted)">● ${m.status}</span>`;

      return `<tr>
        <td style="font-weight:500">${escHtml(m.display_name)}</td>
        <td>${roleSelect}</td>
        <td>${statusBadge}</td>
        <td style="font-size:12px;color:var(--text-muted)">${m.joined_at ? m.joined_at.split(' ')[0] : '—'}</td>
        <td>${actions}</td>
      </tr>`;
    }).join('');

    panel.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <span style="font-size:15px;font-weight:600">${members.length} Member${members.length !== 1 ? 's' : ''}</span>
        ${isAdmin ? `<button class="btn btn-primary btn-sm" onclick="wsShowTab('search')">+ Add Members</button>` : ''}
      </div>
      <div class="card">
        <div class="table-scroll"><table class="crm-table">
          <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Joined</th><th>Action</th></tr></thead>
          <tbody>${rows}</tbody>
        </table></div>
      </div>`;
  } catch (err) { panel.innerHTML = `<div class="ws-error">${escHtml(err.message)}</div>`; }
}

async function wsChangeMemberRole(userId, role) {
  try {
    await wsTeamApiFetch(`/api/teams/${ws.activeTeam.id}/members/${userId}`, {
      method: 'PATCH', body: JSON.stringify({ role }),
    });
    toast(`Role updated to ${role}`);
  } catch (err) { toast(err.message, 'error'); wsRenderMembers(); }
}

async function wsRemoveMember(userId, name) {
  if (!confirm(`Remove "${name}" from the team?`)) return;
  try {
    await wsTeamApiFetch(`/api/teams/${ws.activeTeam.id}/members/${userId}`, { method: 'DELETE' });
    toast(`${name} removed`);
    wsRenderMembers();
  } catch (err) { toast(err.message, 'error'); }
}

// ── Requests ──────────────────────────────────────────────────

async function wsRenderRequests() {
  const panel = document.getElementById('ws-panel-requests');
  panel.innerHTML = `<div style="padding:20px;color:var(--text-muted)">Loading requests…</div>`;
  const isAdmin = ['owner', 'admin'].includes(ws.activeTeam?.role) || state.role === 'admin';

  let joinRequests = [];
  let leadReqs = { incoming: [], outgoing: [] };
  try {
    [joinRequests, leadReqs] = await Promise.all([
      isAdmin ? wsTeamApiFetch(`/api/teams/${ws.activeTeam.id}/requests`).catch(() => []) : Promise.resolve([]),
      apiFetch('/api/lead-requests').catch(() => ({ incoming: [], outgoing: [] })),
    ]);
  } catch (err) {
    panel.innerHTML = `<div class="ws-error">${escHtml(err.message)}</div>`;
    return;
  }

  const pendingJoin     = joinRequests.filter(r => r.status === 'pending');
  const pendingIncoming = (leadReqs.incoming || []).filter(r => r.status === 'pending');

  // Badge = pending join requests + pending lead requests for me
  const badge = document.getElementById('ws-req-badge');
  const badgeCount = pendingJoin.length + pendingIncoming.length;
  if (badge) {
    if (badgeCount) { badge.textContent = badgeCount; badge.classList.remove('hidden'); }
    else            { badge.classList.add('hidden'); }
  }

  const leadReqRow = (r, incoming) => `
    <tr>
      <td style="font-weight:500">${escHtml(r.factory_name || r.factory_number || ('Lead #' + r.lead_id))}</td>
      <td>${escHtml(incoming ? r.requester : (r.owner || '—'))}</td>
      <td style="color:var(--text-muted);font-size:12px">${escHtml(r.message || '—')}</td>
      <td><span class="ws-status-badge ws-status-${r.status}">${r.status}</span></td>
      <td>
        ${incoming && r.status === 'pending' ? `
          <button class="action-btn" onclick="wsReviewLeadRequest(${r.id}, 'approved')">Approve</button>
          <button class="action-btn del" onclick="wsReviewLeadRequest(${r.id}, 'rejected')">Reject</button>
        ` : '—'}
      </td>
    </tr>`;

  const leadReqTable = (rows, incoming) => rows.length ? `
    <div class="card" style="margin-bottom:20px">
      <div class="table-scroll"><table class="crm-table">
        <thead><tr><th>Lead</th><th>${incoming ? 'Requested by' : 'Owner'}</th><th>Message</th><th>Status</th><th>Action</th></tr></thead>
        <tbody>${rows.map(r => leadReqRow(r, incoming)).join('')}</tbody>
      </table></div>
    </div>`
    : `<div style="padding:14px 4px 20px;color:var(--text-muted);font-size:13px">None yet.</div>`;

  const joinRows = joinRequests.map(r => `
    <tr>
      <td style="font-weight:500">${escHtml(r.user_name)}</td>
      <td style="color:var(--text-muted);font-size:12px">${escHtml(r.message || '—')}</td>
      <td><span class="ws-status-badge ws-status-${r.status}">${r.status}</span></td>
      <td style="font-size:12px;color:var(--text-muted)">${(r.created_at || '').split(' ')[0]}</td>
      <td>
        ${r.status === 'pending' ? `
          <button class="action-btn" onclick="wsReviewRequest(${r.id}, 'approved')">Approve</button>
          <button class="action-btn del" onclick="wsReviewRequest(${r.id}, 'rejected')">Reject</button>
        ` : '—'}
      </td>
    </tr>`).join('');

  panel.innerHTML = `
    <h3 style="font-size:14px;font-weight:600;margin-bottom:10px">🔑 Lead Access — Requests for your leads
      ${pendingIncoming.length ? `<span class="ws-badge">${pendingIncoming.length}</span>` : ''}</h3>
    ${leadReqTable(leadReqs.incoming || [], true)}
    <h3 style="font-size:14px;font-weight:600;margin-bottom:10px">📤 Lead Access — Your requests</h3>
    ${leadReqTable(leadReqs.outgoing || [], false)}
    ${isAdmin ? `
      <h3 style="font-size:14px;font-weight:600;margin-bottom:10px">👥 Team Join Requests
        ${pendingJoin.length ? `<span class="ws-badge">${pendingJoin.length}</span>` : ''}</h3>
      ${joinRequests.length ? `
        <div class="card">
          <div class="table-scroll"><table class="crm-table">
            <thead><tr><th>Name</th><th>Message</th><th>Status</th><th>Requested</th><th>Action</th></tr></thead>
            <tbody>${joinRows}</tbody>
          </table></div>
        </div>`
      : `<div style="padding:14px 4px;color:var(--text-muted);font-size:13px">No join requests yet.</div>`}
    ` : ''}`;
}

async function wsReviewLeadRequest(requestId, status) {
  try {
    await apiFetch(`/api/lead-requests/${requestId}`, {
      method: 'PATCH', body: JSON.stringify({ status }),
    });
    toast(status === 'approved' ? 'Access granted!' : 'Request rejected');
    wsRenderRequests();
  } catch (err) { toast(err.message, 'error'); }
}

async function wsReviewRequest(requestId, status) {
  try {
    await wsTeamApiFetch(`/api/teams/${ws.activeTeam.id}/requests/${requestId}`, {
      method: 'PATCH', body: JSON.stringify({ status }),
    });
    toast(status === 'approved' ? 'Request approved!' : 'Request rejected');
    wsRenderRequests();
  } catch (err) { toast(err.message, 'error'); }
}

// ── Search ────────────────────────────────────────────────────

function wsRenderSearch() {
  const panel = document.getElementById('ws-panel-search');
  panel.innerHTML = `
    <div class="ws-search-wrap">
      <h3 style="margin-bottom:16px;font-size:16px;font-weight:600">Find a Team</h3>
      <div style="display:flex;gap:8px;margin-bottom:20px">
        <input id="ws-search-input" type="text" class="ws-input" placeholder="Team name, @handle, or TEAM-XXXXX"
          onkeydown="if(event.key==='Enter')wsDoSearch()" style="flex:1" />
        <button class="btn btn-primary" onclick="wsDoSearch()">Search</button>
      </div>
      <div id="ws-search-results"></div>

      <div class="ws-divider">or join with an invite code</div>
      <div style="display:flex;gap:8px;margin-top:16px">
        <input id="ws-inv-input" type="text" class="ws-input" placeholder="Enter invite code" style="flex:1"
          onkeydown="if(event.key==='Enter')wsJoinByCode()" />
        <button class="btn btn-primary" onclick="wsJoinByCode()">Join</button>
      </div>
      <p id="ws-join-err" class="login-error"></p>
    </div>`;

  // A parked invite code (from a ?join= link) pre-fills the box as a fallback —
  // normally consumePendingInvite() already used it right after sign-in.
  const autoCode = pendingInviteCode();
  if (autoCode) document.getElementById('ws-inv-input').value = autoCode;
}

async function wsDoSearch() {
  const q = document.getElementById('ws-search-input').value.trim();
  if (q.length < 2) return;
  const resultsEl = document.getElementById('ws-search-results');
  resultsEl.innerHTML = `<div style="color:var(--text-muted)">Searching…</div>`;
  try {
    const teams = await apiFetch(`/api/teams/search?q=${encodeURIComponent(q)}`);
    if (!teams.length) { resultsEl.innerHTML = `<div style="color:var(--text-muted)">No teams found.</div>`; return; }
    resultsEl.innerHTML = teams.map(t => `
      <div class="ws-search-result">
        <div class="ws-search-avatar">${(t.name||'?')[0].toUpperCase()}</div>
        <div class="ws-search-info">
          <div class="ws-search-name">${escHtml(t.name)}</div>
          <div class="ws-search-meta">@${escHtml(t.handle)} · ${t.member_count} members · Owner: ${escHtml(t.owner_name)}</div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="wsRequestJoin(${t.id}, '${escAttr(t.name)}')">Request Join</button>
      </div>`).join('');
  } catch (err) { resultsEl.innerHTML = `<div class="ws-error">${escHtml(err.message)}</div>`; }
}

async function wsJoinByCode() {
  const code  = (document.getElementById('ws-inv-input').value || '').trim();
  const errEl = document.getElementById('ws-join-err');
  errEl.textContent = '';
  if (!code) { errEl.textContent = 'Enter an invite code'; return; }
  try {
    const { team } = await apiFetch('/api/teams/join', { method: 'POST', body: JSON.stringify({ invite_code: code }) });
    toast(`Joined ${team.name}! Welcome to the team.`, 'success');
    await refreshTeamsEverywhere(team.id);   // switcher + leads follow immediately
    await renderWorkspace();
  } catch (err) { errEl.textContent = err.message; }
}

async function wsRequestJoin(teamId, teamName) {
  try {
    const { auto_approved } = await apiFetch(`/api/teams/${teamId}/request`, { method: 'POST', body: JSON.stringify({ message: '' }) });
    if (auto_approved) {
      toast(`Joined ${teamName}! Welcome.`, 'success');
      await refreshTeamsEverywhere(teamId);
      await renderWorkspace();
    } else {
      toast(`Join request sent to ${teamName}. Waiting for approval.`);
    }
  } catch (err) { toast(err.message, 'error'); }
}

// ── Discover Teams: prompt new users to join a public team ────
function dismissTeamsDiscover() {
  document.getElementById('teams-discover-overlay')?.classList.add('hidden');
  sessionStorage.setItem('crm_teams_prompt_shown', '1');
}

async function openTeamsDiscover() {
  const overlay = document.getElementById('teams-discover-overlay');
  const list    = document.getElementById('td-list');
  if (!overlay || !list) return;
  overlay.classList.remove('hidden');
  list.innerHTML = '<div class="td-empty">Loading teams…</div>';
  try {
    const teams = await apiFetch('/api/teams/public');
    const mine  = new Set((state.myTeams || []).map(t => String(t.id)));
    const joinable = (teams || []).filter(t => !mine.has(String(t.id)));
    if (!joinable.length) {
      list.innerHTML = '<div class="td-empty">No public teams to join yet — create your own below.</div>';
      return;
    }
    list.innerHTML = joinable.map(t => `
      <div class="td-team">
        <div class="td-avatar">${escHtml((t.name || '?')[0].toUpperCase())}</div>
        <div class="td-info">
          <div class="td-name">${escHtml(t.name)}</div>
          <div class="td-meta">@${escHtml(t.handle)} · ${t.member_count} member${t.member_count === 1 ? '' : 's'}${t.owner_name ? ' · ' + escHtml(t.owner_name) : ''}</div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="discoverRequestJoin(${t.id}, '${escAttr(t.name)}', this)">${t.auto_approve ? 'Join' : 'Request'}</button>
      </div>`).join('');
  } catch (e) {
    list.innerHTML = `<div class="td-empty" style="color:var(--danger)">${escHtml(e.message)}</div>`;
  }
}

async function discoverRequestJoin(teamId, name, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  try {
    const { auto_approved } = await apiFetch(`/api/teams/${teamId}/request`, { method: 'POST', body: JSON.stringify({ message: '' }) });
    if (auto_approved) {
      toast(`Joined ${name}! New leads will save here.`, 'success');
      dismissTeamsDiscover();
      await refreshTeamsEverywhere(teamId);   // view it + make it the Save-to default
    } else {
      toast(`Request sent to ${name} — waiting for the admin to approve.`, 'success');
      if (btn) btn.textContent = 'Requested ✓';
    }
  } catch (e) {
    toast(e.message, 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Request'; }
  }
}

// Auto-prompt a signed-in user who isn't in any team yet, once per session,
// but only if there are public teams they could actually join.
async function maybeShowTeamsDiscover() {
  if (state.role === 'guest') return;
  if ((state.myTeams || []).length) return;
  if (sessionStorage.getItem('crm_teams_prompt_shown')) return;
  try {
    const teams = await apiFetch('/api/teams/public');
    if (teams && teams.length) openTeamsDiscover();
  } catch (_) {}
  sessionStorage.setItem('crm_teams_prompt_shown', '1');
}

// ── Create ────────────────────────────────────────────────────

function wsRenderCreate() {
  const panel = document.getElementById('ws-panel-create');
  panel.innerHTML = `
    <div class="ws-search-wrap">
      <h3 style="margin-bottom:4px;font-size:16px;font-weight:600">Create a Team</h3>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:20px">Your workspace where all leads and members are organized.</p>
      <div class="form-group" style="margin-bottom:12px">
        <label>Team Name</label>
        <input id="ws-create-name" type="text" class="ws-input" placeholder="e.g. ABC Steels" />
      </div>
      <div class="form-group" style="margin-bottom:16px">
        <label>Handle <span style="font-weight:400;color:var(--text-muted)">(unique, like @abcsteels)</span></label>
        <div style="display:flex;gap:6px;align-items:center">
          <span style="color:var(--text-muted)">@</span>
          <input id="ws-create-handle" type="text" class="ws-input" placeholder="abcsteels" style="flex:1"
            oninput="this.value=this.value.toLowerCase().replace(/[^a-z0-9_]/g,'')" />
        </div>
      </div>
      <div class="form-group" style="margin-bottom:16px">
        <label>Business Type</label>
        <select id="ws-create-biz" class="ws-input">
          ${BUSINESS_KEYS.map(k => `<option value="${k}" ${k === 'factory' ? 'selected' : ''}>${escHtml(BUSINESS_TYPES[k].icon + ' ' + BUSINESS_TYPES[k].label)}</option>`).join('')}
        </select>
        <p style="font-size:12px;color:var(--text-muted);margin:6px 0 0;line-height:1.4">You can change this anytime in Settings.</p>
      </div>
      <p id="ws-create-err" class="login-error"></p>
      <button class="btn btn-primary" onclick="wsCreateTeam()">Create Team</button>
    </div>`;
}

async function wsCreateTeam() {
  const name         = (document.getElementById('ws-create-name').value   || '').trim();
  const handle       = (document.getElementById('ws-create-handle').value || '').trim();
  const businessType = document.getElementById('ws-create-biz')?.value || 'factory';
  const errEl        = document.getElementById('ws-create-err');
  errEl.textContent = '';
  if (name.length < 2)   { errEl.textContent = 'Team name must be at least 2 characters'; return; }
  if (handle.length < 3) { errEl.textContent = 'Handle must be at least 3 characters'; return; }
  try {
    const team = await apiFetch('/api/teams', { method: 'POST', body: JSON.stringify({ name, handle, businessType }) });
    toast(`Team "${name}" created!`, 'success');
    await refreshTeamsEverywhere(team && team.id);   // switcher + leads follow immediately
    await renderWorkspace();
  } catch (err) { errEl.textContent = err.message; }
}

// ── Settings ──────────────────────────────────────────────────

function wsRenderSettings() {
  const t = ws.activeTeam;
  const bizType = BUSINESS_KEYS.includes(t.business_type) ? t.business_type : 'factory';
  let bizCustom = {};
  try { bizCustom = t.business_custom ? JSON.parse(t.business_custom) : {}; } catch (_) {}
  if (!bizCustom || typeof bizCustom !== 'object' || Array.isArray(bizCustom)) bizCustom = {};   // JSON.parse('null') hazard
  const stageOv = (bizCustom.stages && typeof bizCustom.stages === 'object' && !Array.isArray(bizCustom.stages)) ? bizCustom.stages : {};
  const cBase = BUSINESS_TYPES.custom;
  document.getElementById('ws-panel-settings').innerHTML = `
    <div class="ws-search-wrap">
      <h3 style="margin-bottom:16px;font-size:16px;font-weight:600">Team Settings</h3>
      <div class="form-group" style="margin-bottom:12px">
        <label>Team Name</label>
        <input id="ws-set-name" type="text" class="ws-input" value="${escHtml(t.name)}" />
      </div>
      <div class="form-group" style="margin-bottom:12px">
        <label>Handle</label>
        <input id="ws-set-handle" type="text" class="ws-input" value="${escHtml(t.handle)}"
          oninput="this.value=this.value.toLowerCase().replace(/[^a-z0-9_]/g,'')" />
      </div>
      <div class="form-group" style="margin-bottom:12px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="ws-set-public" ${t.public_search ? 'checked' : ''} />
          Allow public search (others can find and request to join)
        </label>
      </div>
      <div class="form-group" style="margin-bottom:20px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="ws-set-auto" ${t.auto_approve ? 'checked' : ''} />
          Auto-approve join requests (no manual approval needed)
        </label>
      </div>
      <div class="form-group" style="margin-bottom:20px">
        <label>Business Type</label>
        <select id="ws-set-biz" class="ws-input" onchange="wsToggleBizCustom()">
          ${BUSINESS_KEYS.map(k => `<option value="${k}" ${k === bizType ? 'selected' : ''}>${escHtml(BUSINESS_TYPES[k].icon + ' ' + BUSINESS_TYPES[k].label)}</option>`).join('')}
        </select>
        <p style="font-size:12px;color:var(--text-muted);margin:6px 0 0;line-height:1.4">Changes the words Dive uses — what a lead is called, field names and stage names. Data is never changed.</p>
        <div id="ws-set-biz-custom" class="biz-custom-grid ${bizType === 'custom' ? '' : 'hidden'}">
          <div class="form-group">
            <label>What do you call a lead?</label>
            <input id="ws-set-biz-entity" type="text" class="ws-input" value="${escHtml(bizCustom.entity || cBase.entity)}" />
          </div>
          <div class="form-group">
            <label>Plural (e.g. Members)</label>
            <input id="ws-set-biz-plural" type="text" class="ws-input" placeholder="${escHtml((bizCustom.entity || cBase.entity) + 's')}" value="${escHtml(bizCustom.entityPlural || '')}" />
          </div>
          <div class="form-group">
            <label>Code field</label>
            <input id="ws-set-biz-code" type="text" class="ws-input" value="${escHtml(bizCustom.code || cBase.terms.code)}" />
          </div>
          <div class="form-group">
            <label>Name field</label>
            <input id="ws-set-biz-name" type="text" class="ws-input" value="${escHtml(bizCustom.name || cBase.terms.name)}" />
          </div>
          <div class="form-group">
            <label>Person field</label>
            <input id="ws-set-biz-person" type="text" class="ws-input" value="${escHtml(bizCustom.person || cBase.terms.person)}" />
          </div>
          <div class="form-group">
            <label>Product field</label>
            <input id="ws-set-biz-product" type="text" class="ws-input" value="${escHtml(bizCustom.product || cBase.terms.product)}" />
          </div>
          <div class="form-group">
            <label>Area field</label>
            <input id="ws-set-biz-area" type="text" class="ws-input" value="${escHtml(bizCustom.area || cBase.terms.area)}" />
          </div>
          <p style="grid-column:1/-1;font-size:12px;color:var(--text-muted);margin:8px 0 0;line-height:1.4">Rename pipeline stages (optional — blank keeps the standard name)</p>
          ${Object.keys(STAGE_NUMBERS).map(canon => `
          <div class="form-group">
            <label>${escHtml(canon)}</label>
            <input type="text" class="ws-input ws-set-biz-stage" data-stage="${escHtml(canon)}" placeholder="${escHtml(canon)}" value="${escHtml(typeof stageOv[canon] === 'string' ? stageOv[canon] : '')}" />
          </div>`).join('')}
        </div>
      </div>
      <p id="ws-set-err" class="login-error"></p>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" onclick="wsSaveSettings()">Save Settings</button>
      </div>
    </div>`;
}

function wsToggleBizCustom() {
  const sel  = document.getElementById('ws-set-biz');
  const wrap = document.getElementById('ws-set-biz-custom');
  if (sel && wrap) wrap.classList.toggle('hidden', sel.value !== 'custom');
}

async function wsSaveSettings() {
  const name         = (document.getElementById('ws-set-name').value   || '').trim();
  const handle       = (document.getElementById('ws-set-handle').value || '').trim();
  const publicSearch = document.getElementById('ws-set-public').checked;
  const autoApprove  = document.getElementById('ws-set-auto').checked;
  const businessType = document.getElementById('ws-set-biz').value;
  const errEl        = document.getElementById('ws-set-err');
  errEl.textContent  = '';
  if (name.length < 2)   { errEl.textContent = 'Name too short'; return; }
  if (handle.length < 3) { errEl.textContent = 'Handle too short'; return; }
  const cBase = BUSINESS_TYPES.custom;
  let businessCustom = null;
  if (businessType === 'custom') {
    const bc = {
      entity:  (document.getElementById('ws-set-biz-entity').value  || '').trim() || cBase.entity,
      code:    (document.getElementById('ws-set-biz-code').value    || '').trim() || cBase.terms.code,
      name:    (document.getElementById('ws-set-biz-name').value    || '').trim() || cBase.terms.name,
      person:  (document.getElementById('ws-set-biz-person').value  || '').trim() || cBase.terms.person,
      product: (document.getElementById('ws-set-biz-product').value || '').trim() || cBase.terms.product,
      area:    (document.getElementById('ws-set-biz-area').value    || '').trim() || cBase.terms.area,
    };
    const plural = (document.getElementById('ws-set-biz-plural')?.value || '').trim();
    if (plural) bc.entityPlural = plural.slice(0, 30);
    // Stage renames: only non-blank entries, keys exactly canonical, ≤30 chars.
    // Omitting `stages` entirely (all blank) clears any previous overrides.
    const stages = {};
    document.querySelectorAll('#ws-set-biz-custom .ws-set-biz-stage').forEach(inp => {
      const v = (inp.value || '').trim();
      if (v && STAGE_NUMBERS[inp.dataset.stage] !== undefined) stages[inp.dataset.stage] = v.slice(0, 30);
    });
    if (Object.keys(stages).length) bc.stages = stages;
    businessCustom = JSON.stringify(bc);
  }
  try {
    await wsTeamApiFetch(`/api/teams/${ws.activeTeam.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name, handle, publicSearch, autoApprove, businessType, ...(businessCustom ? { businessCustom } : {}) }),
    });
    ws.activeTeam.name            = name;
    ws.activeTeam.handle          = handle;
    ws.activeTeam.public_search   = publicSearch;
    ws.activeTeam.auto_approve    = autoApprove;
    ws.activeTeam.business_type = businessType;
    // The server preserves the existing business_custom when the PATCH omits it
    // (switching away from 'custom' doesn't erase saved terms) — only overwrite
    // the local copy when we actually sent a fresh value.
    if (businessType === 'custom') ws.activeTeam.business_custom = businessCustom;
    // Keep the header switcher's / state.myTeams' copy of this team in sync too.
    const inList = (state.myTeams || []).find(mt => String(mt.id) === String(ws.activeTeam.id));
    if (inList) {
      inList.business_type = businessType;
      if (businessType === 'custom') inList.business_custom = businessCustom;
    }
    wsFillBanner();
    toast('Settings saved!', 'success');
    renderPage(state.page);   // refresh any visible labels driven by the new business type
  } catch (err) { errEl.textContent = err.message; }
}

// ── Leave team ────────────────────────────────────────────────

async function wsLeaveTeam() {
  if (!confirm(`Leave "${ws.activeTeam.name}"? You'll need an invite to rejoin.`)) return;
  try {
    const leftId = String(ws.activeTeam.id);
    await wsTeamApiFetch(`/api/teams/${leftId}/leave`, { method: 'POST' });
    ws.activeTeam = null;
    localStorage.removeItem('ws_team_id');
    // New leads must not keep targeting a team you just left.
    if (localStorage.getItem('crm_lead_dest') === leftId) localStorage.removeItem('crm_lead_dest');
    toast('Left team');
    // If you were viewing that team, fall back to Personal; otherwise just resync.
    await refreshTeamsEverywhere(String(state.activeOrgId) === leftId ? '' : undefined);
    await renderWorkspace();
  } catch (err) { toast(err.message, 'error'); }
}

// ============================================================
//  SESSIONS & DEVICES management (Profile modal tabs)
// ============================================================
async function openSecurityPanel() {
  const modal = document.getElementById('security-modal');
  if (modal) { modal.classList.remove('hidden'); await loadSecurityTabs(); }
}

function closeSecurityModal() {
  const modal = document.getElementById('security-modal');
  if (modal) modal.classList.add('hidden');
}

async function loadSecurityTabs() {
  showSecurityTab('sessions');
}

function showSecurityTab(tab) {
  document.querySelectorAll('.sec-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  document.querySelectorAll('.sec-panel').forEach(p => p.classList.toggle('hidden', p.dataset.tab !== tab));
  if (tab === 'sessions')     loadSessionsList();
  if (tab === 'devices')      loadDevicesList();
  if (tab === 'security-log') loadSecurityLog();
}

async function loadSessionsList() {
  const el = document.getElementById('sessions-list');
  if (!el) return;
  el.innerHTML = '<p class="sec-loading">Loading…</p>';
  try {
    const sessions = await apiFetch('/api/sessions');
    if (!sessions.length) { el.innerHTML = '<p class="sec-empty">No active sessions.</p>'; return; }
    el.innerHTML = sessions.map(s => `
      <div class="sec-row${s.current ? ' sec-row-current' : ''}">
        <div class="sec-row-icon">${s.device_type === 'mobile' ? '📱' : '🖥'}</div>
        <div class="sec-row-info">
          <div class="sec-row-title">${escHtml(s.device_name || s.browser || 'Unknown')} ${s.current ? '<span class="sec-badge">Current</span>' : ''}</div>
          <div class="sec-row-meta">${escHtml(s.os || '')} · ${escHtml(s.ip_address || '')} · Last active ${fmtRelTime(s.last_active_at)}</div>
        </div>
        ${!s.current ? `<button class="btn btn-ghost btn-sm" onclick="revokeSession('${escHtml(s.id)}')">Revoke</button>` : ''}
      </div>
    `).join('');
  } catch (e) { el.innerHTML = `<p class="sec-error">${escHtml(e.message)}</p>`; }
}

async function revokeSession(id) {
  if (!confirm('Revoke this session?')) return;
  try { await apiFetch(`/api/sessions/${id}`, { method: 'DELETE' }); loadSessionsList(); toast('Session revoked'); }
  catch (e) { toast(e.message, 'error'); }
}

async function revokeAllSessions() {
  if (!confirm('Log out all other devices?')) return;
  try { await apiFetch('/api/sessions', { method: 'DELETE' }); loadSessionsList(); toast('All other sessions revoked'); }
  catch (e) { toast(e.message, 'error'); }
}

async function loadDevicesList() {
  const el = document.getElementById('devices-list');
  if (!el) return;
  el.innerHTML = '<p class="sec-loading">Loading…</p>';
  try {
    const devices = await apiFetch('/api/devices');
    const myDevId = localStorage.getItem('crm_device_id');
    if (!devices.length) { el.innerHTML = '<p class="sec-empty">No trusted devices.</p>'; return; }
    el.innerHTML = devices.map(d => `
      <div class="sec-row">
        <div class="sec-row-icon">${d.device_type === 'mobile' ? '📱' : '🖥'}</div>
        <div class="sec-row-info">
          <div class="sec-row-title">${escHtml(d.device_name)} ${d.id === myDevId ? '<span class="sec-badge">This device</span>' : ''}</div>
          <div class="sec-row-meta">${escHtml(d.browser)} · ${escHtml(d.os)} · ${fmtRelTime(d.last_active_at)}</div>
        </div>
        <button class="btn btn-ghost btn-sm sec-danger" onclick="removeDevice('${escHtml(d.id)}')">Remove</button>
      </div>
    `).join('');
  } catch (e) { el.innerHTML = `<p class="sec-error">${escHtml(e.message)}</p>`; }
}

async function removeDevice(id) {
  if (!confirm('Remove this trusted device? Its sessions and PIN will be revoked.')) return;
  try {
    await apiFetch(`/api/devices/${id}`, { method: 'DELETE' });
    if (id === localStorage.getItem('crm_device_id')) {
      localStorage.removeItem('crm_device_id');
      localStorage.removeItem('crm_device_trusted');
      localStorage.removeItem('crm_device_has_pin');
    }
    loadDevicesList(); toast('Device removed');
  } catch (e) { toast(e.message, 'error'); }
}

async function loadSecurityLog() {
  const el = document.getElementById('security-log-list');
  if (!el) return;
  el.innerHTML = '<p class="sec-loading">Loading…</p>';
  try {
    const events = await apiFetch('/api/security-log?limit=30');
    if (!events.length) { el.innerHTML = '<p class="sec-empty">No security events yet.</p>'; return; }
    const icons = {
      login_success: '✅', login_failed: '⚠️', logout: '🚪', logout_all: '🚪',
      pin_created: '🔐', pin_unlock: '🔓', pin_failed: '❌', device_removed: '🗑',
      session_revoked: '🔒', password_changed: '🔑', token_reuse_attack: '🚨',
    };
    el.innerHTML = events.map(ev => `
      <div class="sec-log-row">
        <span class="sec-log-icon">${icons[ev.event] || '📋'}</span>
        <div class="sec-log-info">
          <div class="sec-log-event">${escHtml(ev.event.replace(/_/g, ' '))}</div>
          <div class="sec-log-meta">${fmtRelTime(ev.created_at)} · ${escHtml(ev.ip_address || 'unknown IP')}</div>
        </div>
      </div>
    `).join('');
  } catch (e) { el.innerHTML = `<p class="sec-error">${escHtml(e.message)}</p>`; }
}

function fmtRelTime(ts) {
  if (!ts) return 'unknown';
  const diff = Date.now() - new Date(ts).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60)    return 'just now';
  if (s < 3600)  return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

// ── Password strength indicator ───────────────────────────────
function checkPasswordStrength(val) {
  const checks = {
    length:   val.length >= 6,
    upper:    /[A-Z]/.test(val),
    lower:    /[a-z]/.test(val),
    digit:    /\d/.test(val),
  };
  const score = Object.values(checks).filter(Boolean).length;
  return { score, checks, label: ['', 'Weak', 'Fair', 'Good', 'Strong'][score] || 'Strong' };
}

function renderPinStrength(inputId, barId) {
  const input = document.getElementById(inputId);
  const bar   = document.getElementById(barId);
  if (!input || !bar) return;
  input.addEventListener('input', () => {
    const val = input.value;
    if (!val) { bar.innerHTML = ''; return; }
    const { score, label } = checkPasswordStrength(val);
    const colors = ['','#ef4444','#f59e0b','#10b981','#3b82f6'];
    bar.innerHTML = `
      <div class="strength-bar">
        <div class="strength-fill" style="width:${score*25}%;background:${colors[score]||'#10b981'}"></div>
      </div>
      <span class="strength-label" style="color:${colors[score]||'#10b981'}">${label}</span>`;
  });
}

init();

// ============================================================
//  AI ENTRY MODE
// ============================================================

// ── Toggle ────────────────────────────────────────────────────
function toggleAiMode(page) {
  state.aiMode[page] = !state.aiMode[page];
  localStorage.setItem(`crm_ai_mode_${page}`, String(state.aiMode[page]));
  renderPage(page);
}

function renderAiToggle(page) {
  const bar = document.getElementById(`ai-toggle-bar-${page}`);
  if (!bar) return;
  const on = state.aiMode[page];
  bar.innerHTML = `
    <div class="ai-toggle-wrap">
      <span class="ai-toggle-icon">✦</span>
      <span class="ai-toggle-label">AI Entry Mode</span>
      <button class="ai-toggle-btn ${on ? 'active' : ''}" onclick="toggleAiMode('${page}')">
        ${on ? 'ON' : 'OFF'}
      </button>
      ${on ? '<span class="ai-toggle-hint">Type naturally or tap 🎤 to add data via AI</span>' : ''}
    </div>`;
}

// ── Panel render ──────────────────────────────────────────────
function renderAiPanel(page) {
  const panel = document.getElementById(`ai-panel-${page}`);
  if (!panel) return;
  const on = state.aiMode[page];
  panel.style.display = on ? '' : 'none';
  if (!on) {
    panel.dataset.initialized = 'false';
    return;
  }
  if (panel.dataset.initialized === 'true') return; // keep existing messages when re-rendering page
  panel.dataset.initialized = 'true';
  panel.innerHTML = `
    <div class="ai-panel-chips">
      <span class="chat-chip chip-hot" onclick="aiChipSend('${page}','Hot lead')">🔥 Hot</span>
      <span class="chat-chip chip-warm" onclick="aiChipSend('${page}','Warm lead')">🟡 Warm</span>
      <span class="chat-chip chip-cold" onclick="aiChipSend('${page}','Cold lead')">🔵 Cold</span>
      <span class="chat-chip" onclick="aiChipSend('${page}','follow up')">📅 Follow-up</span>
      <span class="chat-chip" onclick="aiChipSend('${page}','order won')">✅ Won</span>
    </div>
    <div id="ai-panel-${page}-messages" class="ai-panel-messages"></div>
    <div class="ai-panel-input-row">
      <textarea id="ai-input-${page}" rows="2"
        placeholder="Type naturally… e.g. ${escAttr(biz().example)}"></textarea>
      <button class="ai-mic-btn" id="ai-mic-btn-${page}" onclick="startVoiceCapture('${page}')" title="Voice input">🎤</button>
      <button class="btn btn-primary" style="padding:0 14px;height:38px;border-radius:10px" onclick="aiPanelSend('${page}')">Send</button>
    </div>`;
  const ta = document.getElementById(`ai-input-${page}`);
  ta?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); aiPanelSend(page); }
  });
}

function aiChipSend(page, text) {
  const ta = document.getElementById(`ai-input-${page}`);
  if (ta) ta.value = text;
  aiPanelSend(page);
}

// ── Message helpers ───────────────────────────────────────────
function aiMsgAppend(page, role, html) {
  const box = document.getElementById(`ai-panel-${page}-messages`);
  if (!box) return null;
  const div = document.createElement('div');
  div.className = 'chat-msg ' + role;
  div.innerHTML = html;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

function aiMsgReplaceLast(page, html) {
  const box = document.getElementById(`ai-panel-${page}-messages`);
  if (!box) return;
  const bots = box.querySelectorAll('.chat-msg.bot');
  const last = bots[bots.length - 1];
  if (last) last.innerHTML = html;
  else aiMsgAppend(page, 'bot', html);
  box.scrollTop = box.scrollHeight;
}

// ── Panel send ────────────────────────────────────────────────
async function aiPanelSend(page) {
  const ta   = document.getElementById(`ai-input-${page}`);
  const text = (ta?.value || '').trim();
  if (!text) return;
  ta.value = '';
  const teamId = ws?.activeTeam?.id || null;
  aiMsgAppend(page, 'user', escHtml(text));
  aiMsgAppend(page, 'bot', '⏳ AI is thinking…');
  try {
    const data = await apiFetch('/api/parse', {
      method: 'POST',
      body: JSON.stringify({ text, teamId: teamId ? parseInt(teamId, 10) : undefined }),
    });
    aiMsgReplaceLast(page, buildAiPreview(data, page));
  } catch (err) {
    aiMsgReplaceLast(page, '❌ ' + escHtml(err.message || 'Parse failed'));
  }
}

// ── Confidence ────────────────────────────────────────────────
function computeConfidence(parsed) {
  const conf = Object.assign({}, parsed._confidence || {});
  if (parsed.factory_number && /^[A-Za-z]{1,3}\d+$/.test(parsed.factory_number))
    conf.factory_number = Math.max(conf.factory_number || 0, 0.85);
  if (parsed.contact && /^\d{10}$/.test((parsed.contact || '').replace(/\D/g, '')))
    conf.contact = 0.99;
  if (!parsed.items || !parsed.items.length) {
    conf.items = 0;
  }
  return conf;
}

function confClass(val) {
  if (val === undefined || val === null) return '';
  if (val >= 0.8) return 'conf-green';
  if (val >= 0.5) return 'conf-yellow';
  return 'conf-red';
}

function confDotColor(val) {
  if (val === undefined || val === null) return 'var(--border)';
  if (val >= 0.8) return 'var(--success)';
  if (val >= 0.5) return 'var(--warning)';
  return 'var(--danger)';
}

// ── Editable preview card ─────────────────────────────────────
function buildAiPreview({ parsed, action, existingRow }, page) {
  const uuid = 'ai_' + Math.random().toString(36).slice(2, 10);
  const p    = parsed || {};
  const conf = computeConfidence(p);
  window._aiParsedData[uuid] = { parsed: JSON.parse(JSON.stringify(p)), action, existingRow, page };

  const actionLabel = action === 'UPDATE' ? '🔄 Update lead' : '➕ New lead';
  const typeFor = t => p.lead_type === t ? `active-${t.toLowerCase()}` : '';

  const fieldRow = (label, field, value, confVal) => `
    <div class="ai-field-row">
      <span class="ai-field-label">${escHtml(label)}</span>
      <input class="ai-field-input ${confClass(confVal)}" value="${escAttr(value || '')}"
        onchange="aiFieldChange('${uuid}','${field}',this.value)" />
      <span class="ai-conf-dot" title="${confVal !== undefined ? Math.round((confVal||0)*100)+'% confident' : ''}"
        style="background:${confDotColor(confVal)}"></span>
    </div>`;

  // Canonical stage set (the STAGE_NUMBERS keys). An explicit value= keeps the
  // submitted <select> value as the canonical string, while stageLabel() shows
  // the relabeled text for non-factory business types.
  const stageOptions = ['New Lead','Sample Required','Sample Sent','Quotation','Negotiation','Order Won','Repeat Customer','Lost']
    .map(s => `<option value="${escAttr(s)}" ${p.stage === s ? 'selected' : ''}>${escHtml(stageLabel(s))}</option>`).join('');

  const itemsHtml = (p.items || []).map((it, i) => `
    <div class="ai-item-row" id="${uuid}-item-${i}">
      <input placeholder="Product" value="${escAttr(it.product||'')}" onchange="aiItemChange('${uuid}',${i},'product',this.value)" />
      <input placeholder="Qty" style="max-width:70px" value="${escAttr(it.quantity||'')}" onchange="aiItemChange('${uuid}',${i},'quantity',this.value)" />
      <input placeholder="Rate" style="max-width:70px" value="${escAttr(it.rate||'')}" onchange="aiItemChange('${uuid}',${i},'rate',this.value)" />
      <button class="ai-item-remove" onclick="aiRemoveItem('${uuid}',${i})">✕</button>
    </div>`).join('');

  const lowConfFields = Object.entries(conf).filter(([,v]) => v < 0.5).map(([k]) => k);
  const suggestion = lowConfFields.length
    ? `<div class="ai-suggestion">⚠ Low confidence on <b>${lowConfFields.join(', ')}</b> — please verify before saving.</div>`
    : '';

  return `
    <div class="ai-preview-card" id="${uuid}">
      <div class="ai-preview-header">
        <span class="ai-action-badge">${actionLabel}</span>
        <div class="ai-lead-type-pills">
          <button class="ai-type-pill ${typeFor('Hot')}" onclick="aiSetLeadType('${uuid}','Hot')">🔥 Hot</button>
          <button class="ai-type-pill ${typeFor('Warm')}" onclick="aiSetLeadType('${uuid}','Warm')">🟡 Warm</button>
          <button class="ai-type-pill ${typeFor('Cold')}" onclick="aiSetLeadType('${uuid}','Cold')">🔵 Cold</button>
        </div>
      </div>
      ${fieldRow(T('code'), 'factory_number', p.factory_number, conf.factory_number)}
      ${fieldRow(T('entity'), 'factory_name', p.factory_name, conf.factory_name)}
      ${fieldRow('Contact', 'person_in_charge', p.person_in_charge, conf.person_in_charge)}
      ${fieldRow('Phone', 'contact', p.contact, conf.contact)}
      ${fieldRow('Area', 'area', p.area, conf.area)}
      ${fieldRow('Follow-up', 'follow_up', p.follow_up, conf.follow_up)}
      <div class="ai-field-row">
        <span class="ai-field-label">Stage</span>
        <select class="ai-field-select" onchange="aiFieldChange('${uuid}','stage',this.value)">
          ${stageOptions}
        </select>
        <span class="ai-conf-dot" style="background:${confDotColor(conf.stage)}"></span>
      </div>
      ${fieldRow('Notes', 'notes', p.notes, conf.notes)}
      <div class="ai-items-section">
        <div class="ai-items-label">Products</div>
        <div id="${uuid}-items">${itemsHtml}</div>
        <button class="ai-add-item" onclick="aiAddItem('${uuid}')">+ Add product</button>
      </div>
      ${suggestion}
      <div class="ai-preview-actions">
        <button class="btn btn-primary" style="font-size:13px;padding:5px 14px" onclick="aiConfirmFromCard('${uuid}')">✅ Save</button>
        <button class="btn" style="font-size:13px;padding:5px 14px" onclick="aiClearCard('${uuid}')">✕ Cancel</button>
      </div>
    </div>`;
}

// ── Preview card field editing ────────────────────────────────
function aiFieldChange(uuid, field, value) {
  if (!window._aiParsedData?.[uuid]) return;
  window._aiParsedData[uuid].parsed[field] = value;
}

function aiSetLeadType(uuid, type) {
  if (!window._aiParsedData?.[uuid]) return;
  window._aiParsedData[uuid].parsed.lead_type = type;
  const card = document.getElementById(uuid);
  if (!card) return;
  card.querySelectorAll('.ai-type-pill').forEach(btn => {
    btn.className = 'ai-type-pill';
    if (btn.textContent.includes(type)) btn.classList.add(`active-${type.toLowerCase()}`);
  });
}

function aiItemChange(uuid, idx, field, value) {
  const d = window._aiParsedData?.[uuid];
  if (!d) return;
  if (!d.parsed.items) d.parsed.items = [];
  if (!d.parsed.items[idx]) d.parsed.items[idx] = {};
  d.parsed.items[idx][field] = value;
}

function aiRemoveItem(uuid, idx) {
  const d = window._aiParsedData?.[uuid];
  if (!d) return;
  d.parsed.items.splice(idx, 1);
  const el = document.getElementById(`${uuid}-item-${idx}`);
  el?.remove();
}

function aiAddItem(uuid) {
  const d = window._aiParsedData?.[uuid];
  if (!d) return;
  if (!d.parsed.items) d.parsed.items = [];
  const idx = d.parsed.items.length;
  d.parsed.items.push({ product: '', quantity: '', rate: '' });
  const container = document.getElementById(`${uuid}-items`);
  if (!container) return;
  const row = document.createElement('div');
  row.className = 'ai-item-row';
  row.id = `${uuid}-item-${idx}`;
  row.innerHTML = `
    <input placeholder="Product" onchange="aiItemChange('${uuid}',${idx},'product',this.value)" />
    <input placeholder="Qty" style="max-width:70px" onchange="aiItemChange('${uuid}',${idx},'quantity',this.value)" />
    <input placeholder="Rate" style="max-width:70px" onchange="aiItemChange('${uuid}',${idx},'rate',this.value)" />
    <button class="ai-item-remove" onclick="aiRemoveItem('${uuid}',${idx})">✕</button>`;
  container.appendChild(row);
  row.querySelector('input')?.focus();
}

function aiClearCard(uuid) {
  document.getElementById(uuid)?.closest('.chat-msg')?.remove();
  delete window._aiParsedData[uuid];
}

// ── Confirm & save ────────────────────────────────────────────
async function aiConfirmFromCard(uuid) {
  const d = window._aiParsedData?.[uuid];
  if (!d) return;
  const { parsed, action, existingRow, page } = d;

  const payload = {
    factory_number:   parsed.factory_number   || '',
    factory_name:     parsed.factory_name     || '',
    person_in_charge: parsed.person_in_charge || '',
    contact:          parsed.contact          || '',
    product:          parsed.items?.[0]?.product   || parsed.product   || '',
    quantity:         parsed.items?.[0]?.quantity  || parsed.quantity  || '',
    rate:             parsed.items?.[0]?.rate      || parsed.rate      || '',
    stage:            parsed.stage            || 'New Lead',
    stage_number:     STAGE_NUMBERS[parsed.stage] ?? (parsed.stage_number || 1),
    follow_up:        parsed.follow_up        || '',
    area:             parsed.area             || '',
    notes:            parsed.notes            || '',
    lead_type:        parsed.lead_type        || 'Cold',
    items:            parsed.items            || [],
    contacts:         [],
  };

  const saveBtn = document.querySelector(`#${uuid} .btn-primary`);
  if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

  try {
    let savedId;
    if (action === 'UPDATE' && existingRow != null && existingRow !== -1) {
      await apiFetch(`/api/leads/${existingRow}`, { method: 'PUT', body: JSON.stringify(payload) });
      savedId = existingRow;
    } else {
      // Route through createLead so AI-saved leads land in the same "Save to"
      // team as everything else, instead of always Personal.
      const result = await createLead(payload);
      savedId = result?.rowIndex;
    }

    logAiAudit(savedId, action, 'text', '', JSON.stringify(payload));

    aiClearCard(uuid);
    const summary = [];
    if (action === 'ADD') summary.push(`✓ Lead Added — <b>${escHtml(payload.factory_name || payload.factory_number || 'new lead')}</b>`);
    if (action === 'UPDATE') summary.push(`✓ Lead Updated — <b>${escHtml(payload.factory_name || payload.factory_number)}</b>`);
    if (payload.follow_up) summary.push(`✓ Follow-up: ${escHtml(payload.follow_up)}`);
    if (payload.stage) summary.push(`✓ Stage: ${escHtml(payload.stage)}`);
    aiMsgAppend(page || 'leads', 'bot', `<div class="ai-summary">${summary.map(s => `<div class="ai-summary-item">${s}</div>`).join('')}</div>`);

    await loadLeads();
    await loadStats();
    renderPage(state.page);
  } catch (err) {
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '✅ Save'; }
    aiMsgAppend(page || 'leads', 'bot', '❌ Save failed: ' + escHtml(err.message));
  }
}

function logAiAudit(leadId, action, inputType, rawInput, parsedJson) {
  const teamId = ws?.activeTeam?.id || null;
  apiFetch('/api/ai-audit', {
    method: 'POST',
    body: JSON.stringify({ leadId, action, inputType, rawInput, parsedJson, teamId }),
  }).catch(() => {});
}

// ── Voice input ───────────────────────────────────────────────
let _aiMediaRecorder = null;
let _aiAudioChunks   = [];

async function startVoiceCapture(page) {
  const btn = document.getElementById(`ai-mic-btn-${page}`);
  if (_aiMediaRecorder && _aiMediaRecorder.state === 'recording') {
    _aiMediaRecorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime   = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
                 : MediaRecorder.isTypeSupported('audio/ogg')  ? 'audio/ogg' : '';
    _aiMediaRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    _aiAudioChunks   = [];
    _aiMediaRecorder.ondataavailable = e => { if (e.data.size > 0) _aiAudioChunks.push(e.data); };
    _aiMediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      if (btn) btn.classList.remove('recording');
      aiMsgAppend(page, 'user', '🎤 [Voice message]');
      aiMsgAppend(page, 'bot', '⏳ Transcribing…');
      const usedMime = _aiMediaRecorder.mimeType || mime || 'audio/webm';
      const blob   = new Blob(_aiAudioChunks, { type: usedMime });
      const reader = new FileReader();
      reader.onloadend = async () => {
        const b64 = reader.result.split(',')[1];
        try {
          const data = await apiFetch('/api/parse/voice', {
            method: 'POST',
            body: JSON.stringify({ audioBase64: b64, mimeType: usedMime }),
          });
          aiMsgReplaceLast(page, buildAiPreview(data, page));
        } catch (err) {
          aiMsgReplaceLast(page, '❌ ' + escHtml(err.message || 'Voice parse failed'));
        }
      };
      reader.readAsDataURL(blob);
    };
    _aiMediaRecorder.start();
    if (btn) btn.classList.add('recording');
  } catch (err) {
    toast('Microphone access denied. Please allow mic in browser settings.', 'error');
  }
}

// ── Vocabulary admin ──────────────────────────────────────────
async function renderVocabAdmin() {
  const container = document.getElementById('ai-vocab-container');
  if (!container || state.role !== 'admin') return;
  try {
    const rows = await apiFetch('/api/vocab');
    const listHtml = rows.length
      ? rows.map(r => `
          <div class="ai-vocab-row">
            <span>${escHtml(r.alias)}</span>
            <span class="ai-vocab-arrow">→</span>
            <span class="ai-vocab-canonical">${escHtml(r.canonical)}</span>
            ${r.created_by ? `<span style="font-size:11px;color:var(--text-muted);margin-left:4px">by ${escHtml(r.created_by)}</span>` : ''}
            <button class="ai-vocab-delete" onclick="deleteVocabAlias(${r.id})" title="Delete">✕</button>
          </div>`).join('')
      : '<div style="color:var(--text-muted);font-size:13px">No aliases yet.</div>';
    container.innerHTML = `
      <div class="ai-vocab-section">
        <h4>✦ AI Vocabulary Aliases</h4>
        <p style="font-size:12px;color:var(--text-muted);margin-bottom:10px">Teach the AI company-specific words. E.g. "party" → "customer", "bora" → "bag".</p>
        <div class="ai-vocab-list" id="ai-vocab-list">${listHtml}</div>
        <div class="ai-vocab-add">
          <input id="vocab-alias" placeholder='Word (e.g. "party")' />
          <input id="vocab-canonical" placeholder='Means (e.g. "customer")' />
          <button class="btn btn-primary" style="font-size:13px;padding:6px 14px" onclick="addVocabAlias()">Add</button>
        </div>
      </div>`;
  } catch (err) {
    container.innerHTML = `<div style="color:var(--danger);font-size:13px;margin-top:12px">Failed to load vocabulary: ${escHtml(err.message)}</div>`;
  }
}

async function addVocabAlias() {
  const alias     = document.getElementById('vocab-alias')?.value.trim();
  const canonical = document.getElementById('vocab-canonical')?.value.trim();
  if (!alias || !canonical) { toast('Both fields required', 'error'); return; }
  try {
    await apiFetch('/api/vocab', { method: 'POST', body: JSON.stringify({ alias, canonical }) });
    toast(`Alias "${alias}" → "${canonical}" added`);
    renderVocabAdmin();
  } catch (err) { toast('Failed: ' + err.message, 'error'); }
}

async function deleteVocabAlias(id) {
  if (!confirm('Remove this vocabulary alias?')) return;
  try {
    await apiFetch(`/api/vocab/${id}`, { method: 'DELETE' });
    toast('Alias removed');
    renderVocabAdmin();
  } catch (err) { toast('Failed: ' + err.message, 'error'); }
}

// ============================================================
//  AI UNDERSTANDING ENGINE — Card UI
// ============================================================

// Current AI mode: 'understanding' | 'assistant' | 'command'. Command is the
// default — most users open the chat to DO something ("add …", "set stage …"),
// so it's the primary entry point; Understanding/Assistant are one tap away.
let aiMode = 'command';
let _chatInited = false;
const _modeGreeted = {};

// Per-mode composer placeholder / greeting / quick-chips. A FUNCTION — not a
// module-load-time const — because the command mode's copy references
// T('entity'); it must be re-evaluated against whatever business profile is
// ACTIVE right now (Personal vs team, and that team's business_type) so
// switching workspace/business type is reflected without a page reload.
function chatModeInfo(mode) {
  // Factory keeps the legacy word "party" — today's command wording is the
  // regression oracle (and the server's replies match it). Every other
  // business speaks its own entity word ('shop', 'doctor / chemist', …).
  const entity     = biz().key === 'factory' ? 'party' : T('entity').toLowerCase();
  const entityHtml = escHtml(entity);                  // custom entity terms are user text — escape before innerHTML
  const info = {
    understanding: {
      ph: 'Type, speak 🎤 or snap 📷 a business card…',
      chips: null, // keep the default product chips
    },
    assistant: {
      ph: 'Ask about your pipeline… e.g. "kitne hot leads hain?"',
      hello: '💬 <b>Assistant</b> — ask me anything about your leads:<br>counts, follow-ups due, pipeline, revenue, who to call today.',
      chips: [
        ['🔥 Hot leads?',        'How many hot leads do I have and which ones?'],
        ['📅 Due today',         'Which follow-ups are due today or overdue?'],
        ['🏆 Pipeline summary',  'Give me a quick pipeline summary by stage'],
        ['💰 Revenue potential', 'What is my revenue potential by product?'],
        ['🎯 Who to call?',      'Who should I call first today and why?'],
      ],
    },
    command: {
      ph: `e.g. "add ${entity} Sharma Traders Rakeshji 98765…" or "set M277 stage to won"`,
      hello: `⚡ <b>Command</b> — tell me what to do and I'll do it:<br>• <code>add ${entityHtml} M901 Sharma Traders Rakeshji 9876543210 hotmelt 500@120 hot, surat</code><br>• <code>set M277 stage to won</code> · <code>follow up F12 next week</code><br>• <code>mark D2 hot</code> · <code>add note to M277: visited today</code> · <code>find surat leads</code>`,
      chips: [
        [`➕ Add ${entityHtml}`, `add ${entity} `],
        ['📊 Set stage',   'set  stage to '],
        ['📅 Follow-up',   'follow up  tomorrow'],
        ['🌡 Temperature', 'mark  hot'],
        ['📝 Add note',    'add note to : '],
        ['🔍 Find',        'find '],
      ],
    },
  };
  return info[mode];
}

function renderChatChips(mode) {
  const bar = document.getElementById('chat-chips-bar');
  if (!bar) return;
  const info = chatModeInfo(mode);
  if (!info?.chips) { // restore default understanding chips
    const base = `
      <button class="chat-chip chip-hot"  onclick="chatInsertChip('hot')">🔴 Hot</button>
      <button class="chat-chip chip-warm" onclick="chatInsertChip('warm')">🟡 Warm</button>
      <button class="chat-chip chip-cold" onclick="chatInsertChip('cold')">🔵 Cold</button>
      <button class="chat-chip" onclick="chatInsertChip('follow up')">📅 Follow-up</button>`;
    // Product quick-chips: the workspace's own catalog when it has one; the
    // legacy chemical set only for factory (fresh install stays unchanged);
    // no product row at all for other businesses without a catalog.
    const catalogNames = (state.myProducts || []).map(p => p && p.name).filter(Boolean).slice(0, 8);
    let prodChips = '';
    if (catalogNames.length) {
      prodChips = `
      <span class="chip-divider">|</span>` + catalogNames.map(n => `
      <button class="chat-chip" onclick="chatInsertChip('${escAttr(n)}')">${escHtml(n)}</button>`).join('');
    } else if (biz().key === 'factory') {
      prodChips = `
      <span class="chip-divider">|</span>
      <button class="chat-chip" onclick="chatInsertChip('hotmelt')">Hotmelt</button>
      <button class="chat-chip" onclick="chatInsertChip('latex')">Latex</button>
      <button class="chat-chip" onclick="chatInsertChip('bc')">BC</button>
      <button class="chat-chip" onclick="chatInsertChip('toluene')">Toluene</button>
      <button class="chat-chip" onclick="chatInsertChip('r6')">R6</button>
      <button class="chat-chip" onclick="chatInsertChip('mek')">MEK</button>
      <button class="chat-chip" onclick="chatInsertChip('pu adhesive')">PU Adhesive</button>
      <button class="chat-chip" onclick="chatInsertChip('silicon')">Silicon</button>`;
    }
    bar.innerHTML = base + prodChips;
    return;
  }
  bar.innerHTML = info.chips.map(([label, text]) =>
    `<button class="chat-chip" onclick="chatChipAction('${escAttr(text)}')">${label}</button>`
  ).join('');
}

function chatChipAction(text) {
  const input = document.getElementById('chat-input');
  if (!input) return;
  if (aiMode === 'assistant') { input.value = text; chatSend(); return; }
  // command chips are templates — put in the box for the user to complete
  input.value = text;
  input.focus();
  const gap = text.indexOf('  ');
  if (gap !== -1) input.setSelectionRange(gap + 1, gap + 1);
  else input.setSelectionRange(text.length, text.length);
}
let aiSession = null; // { sessionId, originalText, parsed, confidence }

function setAiMode(mode) {
  aiMode = mode;
  document.querySelectorAll('.ai-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  const box = document.getElementById('chat-messages');
  const cardArea = document.getElementById('ai-card-area');
  if (!box || !cardArea) return;
  if (mode === 'understanding') { box.style.display = 'none'; cardArea.style.display = ''; }
  else                          { box.style.display = ''; cardArea.style.display = 'none'; }

  const info = chatModeInfo(mode);
  const input = document.getElementById('chat-input');
  if (input && info?.ph) input.placeholder = info.ph;
  renderChatChips(mode);
  if (info?.hello && !_modeGreeted[mode]) {
    _modeGreeted[mode] = true;
    chatAppendMessage('bot', info.hello);
  }
}

function confBadgeClass(conf) {
  if (conf === undefined || conf === null) return 'conf-badge low';
  if (conf >= 0.85) return 'conf-badge high';
  if (conf >= 0.70) return 'conf-badge mid';
  return 'conf-badge low';
}

function confLabel(conf) {
  if (conf === undefined || conf === null) return '?';
  return Math.round(conf * 100) + '%';
}

function renderUnderstandingCard(data) {
  const { parsed, confidence, substitutions, model, latency, needsClarification, clarification, existingRow, sessionId } = data;
  aiSession = { sessionId, originalText: aiSession?.originalText || '', parsed, confidence, clarification, existingRow: (existingRow !== undefined ? existingRow : aiSession?.existingRow) };

  const cardArea = document.getElementById('ai-card-area');
  if (!cardArea) return;

  const FIELD_LABELS = {
    factory_number: T('code'), factory_name: biz().key === 'factory' ? 'Business' : T('entity'), person_in_charge: 'Contact',
    contact: 'Phone', stage: 'Stage', follow_up: 'Follow-up', area: 'Area',
    notes: 'Notes', lead_type: 'Lead Type',
  };

  const SHOW_FIELDS = ['factory_number', 'factory_name', 'person_in_charge', 'contact', 'lead_type', 'stage', 'follow_up', 'area', 'notes'];

  // NOTE: the 'stage' value cell intentionally stays the raw canonical string,
  // not stageLabel(val) — it's contenteditable and aiFieldCorrected() treats any
  // blur where the text differs from parsed.stage as a user correction, which
  // would silently overwrite the canonical stage with the display label the
  // instant a non-factory business type relabels it. Only the (non-editable)
  // field label is business-term aware.
  const fieldsHtml = SHOW_FIELDS.map(f => {
    const val  = parsed[f] || '';
    const conf = confidence?.[f];
    const cls  = confBadgeClass(conf);
    if (!val && !conf) return '';
    return `<tr>
      <td class="ai-card-label">${escHtml(FIELD_LABELS[f] || f)}</td>
      <td class="ai-card-value"><span class="ai-field-val" data-field="${f}" contenteditable="true"
          onblur="aiFieldCorrected('${f}', this)">${escHtml(val || '—')}</span></td>
      <td><span class="${cls}" title="Confidence">${confLabel(conf)}</span></td>
    </tr>`;
  }).filter(Boolean).join('');

  const itemsHtml = (parsed.items || []).map((it, i) =>
    `<tr>
      <td class="ai-card-label">Product ${i + 1}</td>
      <td class="ai-card-value">${escHtml(it.product || '—')} &nbsp;
        <span style="color:var(--text-muted)">${escHtml(it.quantity || '')} ${it.rate ? '@ ₹' + escHtml(it.rate) : ''}</span></td>
      <td><span class="conf-badge high">—</span></td>
    </tr>`
  ).join('');

  const subsHtml = substitutions?.length
    ? `<div class="ai-subs">Substituted: ${substitutions.map(s => `<b>${escHtml(s.from)}</b> → <b>${escHtml(s.to)}</b>`).join(', ')}</div>`
    : '';

  const srcHtml = parsed._transcript
    ? `<div class="ai-transcript">🎤 Heard: “${escHtml(String(parsed._transcript).slice(0, 300))}”</div>`
    : parsed._image_text
      ? `<div class="ai-transcript">📷 Read: ${escHtml(String(parsed._image_text).slice(0, 300))}</div>`
      : '';

  const learnBits = [];
  if (data.learning?.corrections) learnBits.push(`${data.learning.corrections} learned correction${data.learning.corrections > 1 ? 's' : ''}`);
  if (data.learning?.vocab)       learnBits.push(`${data.learning.vocab} vocabulary term${data.learning.vocab > 1 ? 's' : ''}`);
  if (data.learning?.profiled)    learnBits.push('your habits');
  const learnHtml = learnBits.length
    ? `<div class="ai-learn-badge" title="This parse was personalised using what the AI has learned about you">📚 Personalised with ${learnBits.join(' · ')}</div>`
    : '';
  const metaHtml = `<div class="ai-meta">${model || 'Gemini'} · ${latency ? latency + 'ms' : '—'}</div>`;

  let actionHtml;
  if (needsClarification && clarification) {
    actionHtml = renderClarificationPanel(clarification);
  } else {
    // Tell the user clearly whether saving will UPDATE a matched lead or ADD a
    // brand-new one, and label the confirm button to match.
    const isUpdate = existingRow != null && existingRow !== -1;
    const noun     = biz().key === 'factory' ? 'lead' : T('entity').toLowerCase();
    const match    = isUpdate ? state.leads.find(x => String(x.rowIndex) === String(existingRow)) : null;
    const matchNm  = match ? (match.factory_name || match.factory_number || '') : '';
    const banner   = isUpdate
      ? `<div class="ai-match-banner is-update">🔄 Matches an existing ${escHtml(noun)}${matchNm ? ': <b>' + escHtml(matchNm) + '</b>' : ''} — saving updates it.</div>`
      : `<div class="ai-match-banner is-new">🆕 No matching ${escHtml(noun)} found — add it as new?</div>`;
    const primary  = isUpdate ? '🔄 Update' : '➕ Add new ' + escHtml(noun);
    actionHtml = `
      ${banner}
      <div class="ai-card-footer">
        <button class="btn btn-primary" onclick="aiConfirmSave()">${primary}</button>
        <button class="btn btn-ghost" onclick="aiEditAll()">✏️ Edit All</button>
        <button class="btn btn-ghost" onclick="aiClearUnderstandingCard()">✕ Clear</button>
      </div>`;
  }

  cardArea.innerHTML = `
    <div class="ai-card">
      <div class="ai-card-header">
        <span class="ai-card-title">🧠 AI Understood</span>
        <button class="btn btn-ghost btn-xs" onclick="aiClearUnderstandingCard()">↩ Ask Again</button>
      </div>
      ${srcHtml}
      ${subsHtml}
      <table class="ai-card-table">
        ${fieldsHtml}
        ${itemsHtml}
      </table>
      ${actionHtml}
      ${learnHtml}
      ${metaHtml}
    </div>`;
}

function renderClarificationPanel(clarification) {
  const optsHtml = clarification.options?.length
    ? `<div class="clarify-options">${clarification.options.map(o =>
        `<button class="clarify-chip" onclick="aiAnswerClarification('${escAttr(o)}')">${escHtml(o)}</button>`
      ).join('')}</div>`
    : '';
  return `
    <div class="clarify-panel">
      <div class="clarify-question">❓ ${escHtml(clarification.question)}</div>
      <div class="clarify-why">${escHtml(clarification.whyAsked)}</div>
      ${optsHtml}
      <div class="clarify-input-row">
        <input id="clarify-answer-input" type="text" placeholder="Type your answer…" class="clarify-input"
          onkeydown="if(event.key==='Enter')aiAnswerClarification(this.value)" />
        <button class="btn btn-primary btn-sm" onclick="aiAnswerClarification(document.getElementById('clarify-answer-input').value)">Submit</button>
      </div>
    </div>`;
}

async function aiFieldCorrected(field, el) {
  const correctedValue = el.textContent.trim();
  if (!aiSession || correctedValue === (aiSession.parsed[field] || '—')) return;
  const originalValue = aiSession.parsed[field] || '';
  aiSession.parsed[field] = correctedValue;
  try {
    const resp = await apiFetch('/api/ai/correct', { method: 'POST', body: JSON.stringify({
      sessionId: aiSession.sessionId, field,
      originalValue, correctedValue, rawInput: aiSession.originalText,
      teamId: state.activeOrgId || null,
    }) });
    if (resp?.learned) {
      toast(`📚 Learned: "${resp.alias}" means "${resp.canonical}" — I'll apply this automatically from now on.`);
    }
  } catch (_) {}
}

async function aiAnswerClarification(answer) {
  if (!answer || !answer.trim()) return;
  const cardArea = document.getElementById('ai-card-area');
  if (cardArea) cardArea.innerHTML = `<div class="ai-thinking">🧠 Thinking… <span class="ai-dots">…</span></div>`;
  try {
    const data = await apiFetch('/api/ai/clarify', {
      method: 'POST',
      body: JSON.stringify({
        sessionId: aiSession?.sessionId,
        field: aiSession?.clarification?.field,
        answer: answer.trim(),
        originalText: aiSession?.originalText || '',
      }),
    });
    renderUnderstandingCard(data);
  } catch (err) {
    if (cardArea) cardArea.innerHTML = `<div class="ai-error">❌ ${escHtml(err.message)}</div>`;
  }
}

async function aiConfirmSave() {
  if (!aiSession?.parsed) return;
  const parsed = aiSession.parsed;
  const payload = {
    factory_number:   parsed.factory_number  || '',
    factory_name:     parsed.factory_name    || '',
    person_in_charge: parsed.person_in_charge || '',
    contact:          parsed.contact         || '',
    stage:            parsed.stage           || '',
    stage_number:     STAGE_NUMBERS[parsed.stage] ?? (parsed.stage_number || 0),
    follow_up:        parsed.follow_up       || '',
    area:             parsed.area            || '',
    notes:            parsed.notes           || '',
    lead_type:        parsed.lead_type       || 'Cold',
    items:            parsed.items           || [],
    contacts:         [],
  };
  if (payload.items.length) {
    payload.product  = payload.items[0].product;
    payload.quantity = payload.items[0].quantity;
    payload.rate     = payload.items[0].rate;
  }
  try {
    // Check for existing lead
    const existingRow = aiSession.existingRow;
    if (existingRow && existingRow !== -1) {
      await apiFetch(`/api/leads/${existingRow}`, { method: 'PUT', body: JSON.stringify(payload) });
      toast(biz().key==='factory' ? 'Lead updated' : T('entity')+' updated');
    } else {
      // Route through createLead (NOT a bare POST) so an AI-chat lead lands in
      // the same "Save to" workspace + session list as every other new lead —
      // otherwise it silently went to Personal and vanished from a team view.
      const result = await createLead(payload);
      if (result?.conflict) { toast(`Duplicate: ${result.message}`, 'error'); return; }
      toast(biz().key==='factory' ? 'Lead saved' : T('entity')+' saved');
    }
    aiClearUnderstandingCard();
    await loadLeads(); await loadStats(); renderPage(state.page);
  } catch (err) { toast('Save failed: ' + err.message, 'error'); }
}

function aiEditAll() {
  if (!aiSession?.parsed) return;
  closeModal();
  openEditModalFromParsed(aiSession.parsed);
}

function openEditModalFromParsed(parsed) {
  document.getElementById('modal-title').textContent =
    biz().key === 'factory' ? 'Edit Lead' : 'Edit ' + T('entity');
  document.getElementById('f-row').value = aiSession?.existingRow || '';
  FIELDS.forEach(f => {
    const el = document.getElementById('f-' + f);
    if (!el) return;
    if (f === 'follow_up') el.value = ddmmyyyyToISO(parsed[f] || '');
    else el.value = parsed[f] || '';
  });
  renderItemsEditor(parsed.items || []);
  renderContactsEditor([]);
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function aiClearUnderstandingCard() {
  const cardArea = document.getElementById('ai-card-area');
  if (cardArea) cardArea.innerHTML = `<div class="ai-empty">💬 Type a lead above and AI will parse it here.</div>`;
  aiSession = null;
  const input = document.getElementById('chat-input');
  if (input) { input.value = ''; input.focus(); }
}

// ── Chat: voice input (understanding mode aware) ─────────────
let _chatRecorder = null;
let _chatChunks   = [];

async function chatVoiceCapture() {
  const btn = document.getElementById('chat-mic-btn');
  if (_chatRecorder && _chatRecorder.state === 'recording') { _chatRecorder.stop(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm'
               : MediaRecorder.isTypeSupported('audio/ogg')  ? 'audio/ogg' : '';
    _chatRecorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
    _chatChunks = [];
    _chatRecorder.ondataavailable = e => { if (e.data.size > 0) _chatChunks.push(e.data); };
    _chatRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      btn?.classList.remove('recording');
      const usedMime = _chatRecorder.mimeType || mime || 'audio/webm';
      const blob = new Blob(_chatChunks, { type: usedMime });
      const reader = new FileReader();
      reader.onloadend = async () => {
        const b64 = reader.result.split(',')[1];
        setAiMode('understanding');
        const cardArea = document.getElementById('ai-card-area');
        if (cardArea) cardArea.innerHTML = `<div class="ai-thinking">🎤 Transcribing & understanding…</div>`;
        try {
          const data = await apiFetch('/api/ai/understand/voice', {
            method: 'POST',
            body: JSON.stringify({ audioBase64: b64, mimeType: usedMime, teamId: state.activeOrgId || null }),
          });
          aiSession = { originalText: data.transcript || '' };
          const match = await findMatchForParsed(data.parsed);
          aiSession.existingRow = match;
          data.existingRow = match;
          renderUnderstandingCard(data);
        } catch (err) {
          if (cardArea) cardArea.innerHTML = `<div class="ai-error">❌ ${escHtml(err.message)}</div>`;
        }
      };
      reader.readAsDataURL(blob);
    };
    _chatRecorder.start();
    btn?.classList.add('recording');
    toast('Recording… tap 🎤 again to stop', 'success');
  } catch (_) {
    toast('Microphone access denied. Please allow mic in browser settings.', 'error');
  }
}

// ── Chat: image input (business card / signboard / note) ─────
async function chatImageSelected(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  setAiMode('understanding');
  const cardArea = document.getElementById('ai-card-area');
  if (cardArea) cardArea.innerHTML = `<div class="ai-thinking">📷 Reading the photo…</div>`;
  try {
    const { base64, mimeType } = await downscaleImage(file, 1600, 0.85);
    const caption = (document.getElementById('chat-input')?.value || '').trim();
    const data = await apiFetch('/api/ai/understand/image', {
      method: 'POST',
      body: JSON.stringify({ imageBase64: base64, mimeType, caption, teamId: state.activeOrgId || null }),
    });
    aiSession = { originalText: data.imageText || caption || '' };
    const match = await findMatchForParsed(data.parsed);
    aiSession.existingRow = match;
    data.existingRow = match;
    renderUnderstandingCard(data);
  } catch (err) {
    if (cardArea) cardArea.innerHTML = `<div class="ai-error">❌ ${escHtml(err.message)}</div>`;
  }
}

// Downscale to keep uploads fast (phone photos can be 5-10 MB)
function downscaleImage(file, maxDim = 1600, quality = 0.85) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      resolve({ base64: dataUrl.split(',')[1], mimeType: 'image/jpeg' });
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read the image file')); };
    img.src = url;
  });
}

// Match parsed fields against loaded leads (same rule as the server)
async function findMatchForParsed(parsed) {
  try {
    if (!state.leads.length) await loadLeads();
    const pNum  = String(parsed?.factory_number || '').trim().toLowerCase();
    const pName = String(parsed?.factory_name   || '').trim().toLowerCase();
    for (const l of state.leads) {
      const rNum  = String(l.factory_number || '').trim().toLowerCase();
      const rName = String(l.factory_name   || '').trim().toLowerCase();
      if (pNum && pNum === rNum) return l.rowIndex;
      if (!pNum && pName && pName === rName) return l.rowIndex;
    }
  } catch (_) {}
  return -1;
}

// ── Assistant mode: data-aware Q&A ────────────────────────────
let _assistantHistory = [];

function mdLite(text) {
  let s = escHtml(String(text || ''));
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  s = s.replace(/^\s*[-*]\s+/gm, '• ');
  return s.replace(/\n/g, '<br>');
}

async function assistantSend(text) {
  chatAppendMessage('user', escHtml(text));
  chatAppendMessage('bot', '💭 Thinking…');
  try {
    const data = await apiFetch('/api/ai/assistant', {
      method: 'POST',
      body: JSON.stringify({ message: text, history: _assistantHistory.slice(-8), teamId: state.activeOrgId || null }),
    });
    _assistantHistory.push({ role: 'user', text }, { role: 'assistant', text: data.reply });
    chatReplaceLastBot(mdLite(data.reply));
  } catch (err) {
    chatReplaceLastBot('❌ ' + escHtml(err.message || 'Assistant unavailable'));
  }
}

// ── Command mode: execute natural-language commands ───────────
// server messages use <b> for emphasis — re-allow just that tag after escaping
function cmdHtml(msg) {
  return escHtml(String(msg || '')).replace(/&lt;b&gt;/g, '<b>').replace(/&lt;\/b&gt;/g, '</b>');
}
function cmdFindResults(results) {
  if (!results || !results.length) return '';
  return '<br>' + results.map(r =>
    `• <b>${escHtml(r.factory_number || '—')}</b> ${escHtml(r.factory_name || '')} — ${escHtml(r.stage ? stageLabel(r.stage) : '—')}${r.lead_type ? ' · ' + escHtml(r.lead_type) : ''}${r.follow_up ? ' · FU ' + escHtml(r.follow_up) : ''}`
  ).join('<br>');
}

// Step 1 — preview: parse + validate on the server WITHOUT writing, then let
// the user Confirm / Edit / Cancel before anything actually changes. Each
// preview is self-contained: the command is encoded into its own buttons so an
// older preview never runs a newer command.
async function commandSend(text) {
  chatAppendMessage('user', escHtml(text));
  chatAppendMessage('bot', '⚡ Reading…');
  try {
    const data = await apiFetch('/api/ai/command', {
      method: 'POST',
      body: JSON.stringify({ command: text, teamId: state.activeOrgId || null, destTeamId: getLeadDest() || null, preview: true }),
    });

    // FIND is read-only — just show the matches, no confirmation needed.
    if (data.action === 'find') {
      chatReplaceLastBot(cmdHtml(data.message) + cmdFindResults(data.results));
      return;
    }

    // A confirmable mutating action — show what it WILL do + action buttons.
    if (data.preview) {
      chatReplaceLastBot(
        `<div class="cmd-confirm-q">Confirm this?</div>${cmdHtml(data.message)}` +
        `<div class="cmd-confirm-actions">
           <button class="btn btn-primary" onclick="confirmCommand(this,'${encodeURIComponent(text)}')">✅ Confirm</button>
           <button class="btn btn-ghost" onclick="editCommand(this,'${encodeURIComponent(text)}')">✏️ Edit</button>
           <button class="btn btn-ghost" onclick="cancelCommand(this)">Cancel</button>
         </div>`);
      return;
    }

    // ok:false — a clarification the AI needs; nothing to confirm.
    chatReplaceLastBot(cmdHtml(data.message) || '⚠️ Could not do that');
  } catch (err) {
    chatReplaceLastBot('❌ ' + escHtml(err.message || 'Command failed'));
  }
}

// Step 2 — confirm: actually run the command encoded in the clicked bubble.
async function confirmCommand(btn, enc) {
  const text = decodeURIComponent(enc);
  const bubble = btn.closest('.chat-msg');
  if (!text || !bubble) return;
  bubble.innerHTML = '⚡ Working…';
  try {
    const data = await apiFetch('/api/ai/command', {
      method: 'POST',
      body: JSON.stringify({ command: text, teamId: state.activeOrgId || null, destTeamId: getLeadDest() || null }),
    });
    let html = cmdHtml(data.message || (data.ok ? '✅ Done' : '⚠️ Could not do that'));
    if (data.action === 'find') html += cmdFindResults(data.results);
    bubble.innerHTML = html;
    if (data.ok && data.action !== 'find') {
      await loadLeads().catch(() => {});
    }
  } catch (err) {
    bubble.innerHTML = '❌ ' + escHtml(err.message || 'Command failed');
  }
}

function editCommand(btn, enc) {
  const text = decodeURIComponent(enc);
  const input = document.getElementById('chat-input');
  if (input) { input.value = text; input.focus(); chatInputChanged?.(text); }
  const bubble = btn.closest('.chat-msg');
  if (bubble) bubble.innerHTML = '✏️ Edit your command above, then send it again.';
}

function cancelCommand(btn) {
  const bubble = btn.closest('.chat-msg');
  if (bubble) bubble.innerHTML = 'Okay — cancelled, nothing was changed.';
}

// Enhanced chatSend — routes based on current AI mode
async function chatSend() {
  if (aiMode !== 'understanding') {
    const input = document.getElementById('chat-input');
    const text  = (input?.value || '').trim();
    if (!text) return;
    input.value = '';
    document.getElementById('chat-autocomplete').className = 'chat-autocomplete';
    return aiMode === 'assistant' ? assistantSend(text) : commandSend(text);
  }

  const input = document.getElementById('chat-input');
  const text  = (input?.value || '').trim();
  if (!text) return;

  const cardArea = document.getElementById('ai-card-area');
  if (cardArea) cardArea.innerHTML = `<div class="ai-thinking">🧠 Parsing with AI…</div>`;
  aiSession = { originalText: text };

  try {
    const data = await apiFetch('/api/ai/understand', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    if (input) input.value = '';
    if (data.error) {
      if (cardArea) cardArea.innerHTML = `<div class="ai-error">⚠️ ${escHtml(data.error)}</div>`;
      return;
    }
    aiSession.existingRow = data.existingRow;
    renderUnderstandingCard(data);
  } catch (err) {
    if (cardArea) cardArea.innerHTML = `<div class="ai-error">❌ ${escHtml(err.message)}</div>`;
  }
}

// ============================================================
//  ACTIVITY TIMELINE
// ============================================================

async function loadLeadTimeline(leadId) {
  const el = document.getElementById('lead-timeline-content');
  if (!el) return;
  el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px">Loading…</div>';
  try {
    const activities = await apiFetch(`/api/leads/${leadId}/activities`);
    if (!activities.length) { el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px">No activity yet.</div>'; return; }
    const ICONS = { created: '✨', edit: '✏️', stage_change: '📊', visit: '📍', call: '📞', note: '📝', won: '🏆', lost: '❌', sample: '🧪' };
    el.innerHTML = activities.map(a => `
      <div class="activity-item">
        <span class="activity-icon">${ICONS[a.activity_type] || '◎'}</span>
        <div class="activity-body">
          <div class="activity-desc">${escHtml(a.description || a.activity_type)}</div>
          <div class="activity-meta">${escHtml(a.performed_by)} · ${new Date(a.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
        </div>
      </div>`).join('');
  } catch (err) {
    el.innerHTML = `<div style="color:var(--danger);font-size:12px;padding:12px">${escHtml(err.message)}</div>`;
  }
}

// (timeline loading happens inside openEditModal itself)

// ============================================================
//  ADMIN AI DEBUG CONSOLE
// ============================================================

async function renderAiDebugPage() {
  const page = document.getElementById('page-ai-debug');
  if (!page) return;

  page.innerHTML = `
    <div style="padding:20px">
      <h2 style="margin-bottom:16px">🧠 AI Debug Console</h2>
      <div id="ai-debug-content">
        <div style="color:var(--text-muted)">Loading sessions…</div>
      </div>
    </div>`;

  try {
    const log = await apiFetch('/api/ai/debug?limit=50');
    const content = document.getElementById('ai-debug-content');
    if (!log || !log.length) { content.innerHTML = '<div style="color:var(--text-muted)">No AI sessions yet.</div>'; return; }
    content.innerHTML = `
      <table class="debug-table">
        <thead>
          <tr>
            <th>Time</th><th>User</th><th>Input Type</th><th>Model</th><th>Avg Conf</th><th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${log.map((row, i) => {
            const parsed = (() => { try { return typeof row.parsed_json === 'string' ? JSON.parse(row.parsed_json) : row.parsed_json; } catch { return {}; } })();
            const conf   = parsed?._confidence || {};
            const vals   = Object.values(conf).filter(v => typeof v === 'number');
            const avg    = vals.length ? (vals.reduce((a, b) => a + b, 0) / vals.length * 100).toFixed(0) : '—';
            const confCls = avg === '—' ? '' : avg >= 85 ? 'conf-high' : avg >= 70 ? 'conf-mid' : 'conf-low';
            const ts = row.created_at ? new Date(row.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
            return `<tr onclick="toggleDebugRow(${i})" style="cursor:pointer">
              <td style="font-size:11px;color:var(--text-muted)">${ts}</td>
              <td>${escHtml(row.performed_by || row.username || '—')}</td>
              <td>${escHtml(row.input_type || 'text')}</td>
              <td style="font-size:11px">${escHtml(row.model || '—')}</td>
              <td><span class="${confCls}" style="font-weight:600">${avg}%</span></td>
              <td>${escHtml(row.action || '—')}</td>
            </tr>
            <tr id="debug-detail-${i}" class="debug-detail hidden">
              <td colspan="6">
                <div class="debug-detail-box">
                  <div><b>Raw input:</b> ${escHtml(row.raw_input || '—')}</div>
                  <div style="margin-top:8px"><b>Parsed JSON:</b></div>
                  <pre class="debug-json">${escHtml(JSON.stringify(parsed, null, 2))}</pre>
                </div>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  } catch (err) {
    const content = document.getElementById('ai-debug-content');
    if (content) content.innerHTML = `<div style="color:var(--danger)">${escHtml(err.message)}</div>`;
  }
}

function toggleDebugRow(i) {
  const el = document.getElementById(`debug-detail-${i}`);
  if (el) el.classList.toggle('hidden');
}

// (ai-debug page hook lives in the main renderPage above)

// ============================================================
//  DEPARTMENT UI (Workspace Members tab extension)
// ============================================================

async function renderDepartmentSection(teamId) {
  let el = document.getElementById('ws-dept-section');
  if (!el) {
    const membersPanel = document.getElementById('ws-panel-members');
    if (!membersPanel) return;
    el = document.createElement('div');
    el.id = 'ws-dept-section';
    el.className = 'dept-section';
    membersPanel.appendChild(el);
  }
  el.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px">Loading departments…</div>';
  try {
    const depts = await apiFetch(`/api/teams/${teamId}/departments`);
    const isAdmin = ['owner', 'admin'].includes(state.teamRole || '');
    el.innerHTML = `
      <div class="dept-header">
        <h3 class="dept-title">Departments</h3>
        ${isAdmin ? `<button class="btn btn-ghost btn-sm" onclick="showCreateDeptForm(${teamId})">+ New</button>` : ''}
      </div>
      <div id="dept-create-form" class="hidden" style="margin-bottom:12px">
        <input id="dept-name-input" type="text" placeholder="Department name…" class="form-input" style="width:200px;margin-right:8px"/>
        <button class="btn btn-primary btn-sm" onclick="createDept(${teamId})">Create</button>
        <button class="btn btn-ghost btn-sm" onclick="document.getElementById('dept-create-form').classList.add('hidden')">Cancel</button>
      </div>
      ${depts.length ? depts.map(d => `
        <div class="dept-item">
          <span class="dept-name">${escHtml(d.name)}</span>
          <span class="dept-meta">${d.member_count || 0} members${d.manager_name ? ' · ' + escHtml(d.manager_name) : ''}</span>
          ${isAdmin ? `<button class="btn btn-ghost btn-xs" onclick="archiveDept(${teamId},${d.id})">Archive</button>` : ''}
        </div>`).join('')
      : '<div style="color:var(--text-muted);font-size:13px;margin-top:8px">No departments yet.</div>'}`;
  } catch (err) {
    el.innerHTML = `<div style="color:var(--danger);font-size:12px">${escHtml(err.message)}</div>`;
  }
}

function showCreateDeptForm(teamId) {
  document.getElementById('dept-create-form')?.classList.remove('hidden');
  document.getElementById('dept-name-input')?.focus();
}

async function createDept(teamId) {
  const name = document.getElementById('dept-name-input')?.value.trim();
  if (!name) return;
  try {
    await apiFetch(`/api/teams/${teamId}/departments`, { method: 'POST', body: JSON.stringify({ name }) });
    toast(`Department "${name}" created`);
    renderDepartmentSection(teamId);
  } catch (err) { toast(err.message, 'error'); }
}

async function archiveDept(teamId, deptId) {
  if (!confirm('Archive this department?')) return;
  try {
    await apiFetch(`/api/teams/${teamId}/departments/${deptId}`, { method: 'DELETE' });
    toast('Department archived');
    renderDepartmentSection(teamId);
  } catch (err) { toast(err.message, 'error'); }
}
