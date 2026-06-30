// ============================================================
//  State
// ============================================================
const state = {
  leads:       [],
  stats:       null,
  page:        'dashboard',
  role:        localStorage.getItem('crm_role') || null,
  search:      '',
  filterStage: '',
  filterProduct: '',
  view:        'table',
  fuFilter:    'overdue',
  sortKey:     '',
  sortDir:     'asc',
  charts:      {},
};

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

// ── Doughnut center-text plugin ──────────────────────────────
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

// ============================================================
//  AUTH
// ============================================================
function showLoginPage() {
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  // Show biometric button if the browser supports it
  if (window.SimpleWebAuthnBrowser?.browserSupportsWebAuthn()) {
    document.getElementById('biometric-login-section').classList.remove('hidden');
  }
}

function hideLoginPage() {
  document.getElementById('login-overlay').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  applyRoleUI();
}

function applyRoleUI() {
  const isAdmin = state.role === 'admin';
  document.querySelectorAll('.admin-only').forEach(el => {
    el.style.display = isAdmin ? '' : 'none';
  });
  const userEl = document.getElementById('current-user');
  const name   = localStorage.getItem('crm_user') || '';
  if (userEl) userEl.textContent = `${name} (${state.role || '?'})`;
  // Show "Enable Biometric" in sidebar if supported and not yet enabled
  if (window.SimpleWebAuthnBrowser?.browserSupportsWebAuthn()) {
    const bioBtn = document.getElementById('btn-enable-biometric');
    if (bioBtn) {
      const alreadyEnabled = localStorage.getItem('biometric_enabled') === name;
      bioBtn.classList.toggle('hidden', alreadyEnabled);
      bioBtn.textContent = alreadyEnabled ? '🔐 Biometric Active' : '🔐 Enable Biometric Login';
      bioBtn.disabled = alreadyEnabled;
    }
  }
}

function logout() {
  clearInterval(autoRefreshTimer);
  localStorage.removeItem('crm_token');
  localStorage.removeItem('crm_role');
  localStorage.removeItem('crm_user');
  state.role = null;
  showLoginPage();
}

async function handleLogin(e) {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value.trim();
  const errEl    = document.getElementById('login-error');
  const btn      = document.getElementById('login-btn');
  errEl.textContent = '';
  btn.disabled      = true;
  btn.textContent   = 'Logging in…';

  try {
    const res = await fetch('/api/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const d = await res.json();
      throw new Error(d.error || 'Login failed');
    }
    const data = await res.json();
    localStorage.setItem('crm_token', data.token);
    localStorage.setItem('crm_role',  data.role);
    localStorage.setItem('crm_user',  data.username);
    state.role = data.role;
    hideLoginPage();
    await initApp();
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Log In';
  }
}

// ============================================================
//  API
// ============================================================
async function apiFetch(path, opts = {}) {
  const token = localStorage.getItem('crm_token');
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;

  const res = await fetch(path, { headers, ...opts, headers });
  if (res.status === 401) {
    localStorage.removeItem('crm_token');
    localStorage.removeItem('crm_role');
    localStorage.removeItem('crm_user');
    showLoginPage();
    throw new Error('Session expired. Please log in again.');
  }
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${res.status}`);
  return res.json();
}

async function loadLeads()  { state.leads = await apiFetch('/api/leads'); }
async function loadStats()  { state.stats = await apiFetch('/api/stats'); }
async function createLead(data) { return apiFetch('/api/leads', { method: 'POST', body: JSON.stringify(data) }); }
async function updateLead(row, data) { return apiFetch(`/api/leads/${row}`, { method: 'PUT', body: JSON.stringify(data) }); }
async function deleteLead(row) { return apiFetch(`/api/leads/${row}`, { method: 'DELETE' }); }

// ============================================================
//  Auto-refresh
// ============================================================
let autoRefreshTimer = null;
let lastRefreshed    = null;
let refreshLabelTimer = null;

function startAutoRefresh() {
  autoRefreshTimer = setInterval(async () => {
    try {
      await Promise.all([loadLeads(), loadStats()]);
      lastRefreshed = new Date();
      renderPage(state.page);
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
  const header = [...cols, 'extra_contacts'].join(',');
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
  dashboard: 'Dashboard', leads: 'Leads',
  pipeline: 'Pipeline', followups: 'Follow-ups', reports: 'Reports', team: 'Team', map: 'Map',
};

function navigate(page) {
  state.page = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const pageEl = document.getElementById(`page-${page}`);
  if (pageEl) pageEl.classList.add('active');
  document.querySelector(`[data-page="${page}"]`)?.classList.add('active');
  document.getElementById('page-title').textContent = PAGE_TITLES[page] || page;
  renderPage(page);
}

function renderPage(page) {
  if (page === 'dashboard')  renderDashboard();
  if (page === 'leads')      renderLeads();
  if (page === 'pipeline')   renderPipeline();
  if (page === 'followups')  renderFollowups();
  if (page === 'reports')    renderReports();
  if (page === 'team')       renderTeam();
  if (page === 'map')        renderMap();
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
  const popup = `<b>${name || agentId}</b><br>Live Location ${accuracyText}`;
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
function renderMap() {
  if (_leafletMap) {
    _leafletMap.invalidateSize();
    Object.values(agentData).forEach(a => upsertAgentMarker(a));
    renderFactoryChecklist();
    return;
  }

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
          <span style="color:#64748b;font-size:12px">${l.factory_number} · ${l.stage || '—'}</span><br>
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
    container.innerHTML = '<p class="route-hint">No factories in CRM yet.</p>';
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
  toast(`Click on the map to place the pin for "${name}"`);
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
      .bindPopup(`<b>Stop ${stop.order}: ${stop.factory_name}</b><br>${stop.factory_number}<br>${stop.person||''}`)
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
          <div class="stop-name">${s.factory_name || s.factory_number}</div>
          <div class="stop-detail">${s.factory_number}${s.person ? ' · ' + s.person : ''}</div>
        </div>
      </div>
    `).join('');

    if (result.skipped?.length)
      toast(`${result.skipped.length} factory skipped (no coordinates)`, 'warning');

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
  const n     = String(lead.stage_number ?? '');
  const label = lead.stage || '—';
  return `<span class="badge badge-${n}">${label}</span>`;
}

function filteredLeads() {
  const q = state.search.toLowerCase();
  let leads = state.leads.filter(l => {
    const allContactText = (l.contacts || []).map(c => `${c.person_name} ${c.contact}`).join(' ');
    const matchSearch = !q || [l.factory_number, l.factory_name, l.product, allContactText]
      .some(v => String(v).toLowerCase().includes(q));
    const matchStage   = !state.filterStage   || l.stage   === state.filterStage;
    const matchProduct = !state.filterProduct || l.product === state.filterProduct;
    return matchSearch && matchStage && matchProduct;
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

function buildTable(leads, cols, actions = true) {
  if (!leads.length) return emptyState('No leads found');

  const colDefs = {
    factory_number:   ['#',          l => l.factory_number   || '—'],
    factory_name:     ['Factory',    l => l.factory_name     || '—'],
    person_in_charge: ['Person',     l => l.person_in_charge || '—'],
    contact:          ['Contact',    l => l.contact          || '—'],
    product:          ['Product',    l => l.product          || '—'],
    quantity:         ['Qty',        l => l.quantity         || '—'],
    rate:             ['Rate',       l => l.rate             || '—'],
    stage:            ['Stage',      l => stageBadge(l)],
    follow_up:        ['Follow Up',  l => l.follow_up        || '—'],
    area:             ['Area',       l => l.area             || '—'],
    notes:            ['Notes',      l => l.notes            || '—'],
    last_updated:     ['Updated',    l => l.last_updated     || '—'],
    lead_type:        ['Type',       l => l.lead_type ? `${TYPE_EMOJI[l.lead_type] || ''} ${l.lead_type}` : '—'],
    created_by:       ['Added By',   l => l.created_by       || '—'],
  };

  const heads = cols.map(c => {
    const label = colDefs[c] ? colDefs[c][0] : c;
    const arrow = state.sortKey === c ? (state.sortDir === 'asc' ? ' ▲' : ' ▼') : '';
    return `<th class="sortable" onclick="sortBy('${c}')">${label}${arrow}</th>`;
  }).join('');

  const rows = leads.map(l => {
    const rowClass = TYPE_ROW_CLASS[l.lead_type] || '';
    const cells = cols.map(c => `<td>${colDefs[c] ? colDefs[c][1](l) : (l[c] || '—')}</td>`).join('');
    const act   = actions ? `<td>
      <div class="table-actions admin-only" style="display:${state.role === 'admin' ? '' : 'none'}">
        <button class="action-btn" onclick="openEditModal(${l.rowIndex})">Edit</button>
        <button class="action-btn del" onclick="confirmDelete(${l.rowIndex}, '${escAttr(l.factory_name || l.factory_number)}')">Del</button>
      </div>
    </td>` : '';
    return `<tr class="${rowClass}">${cells}${act}</tr>`;
  }).join('');

  const actHead = actions ? '<th>Actions</th>' : '';
  return `<table class="crm-table"><thead><tr>${heads}${actHead}</tr></thead><tbody>${rows}</tbody></table>`;
}

function emptyState(msg = 'No data') {
  return `<div class="empty-state"><div class="empty-state-icon">◎</div><p>${msg}</p></div>`;
}

function escAttr(v) {
  return String(v || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

// ============================================================
//  Dashboard
// ============================================================
function renderDashboard() {
  const s = state.stats;
  if (!s || !s.by_stage) return;

  document.getElementById('stat-cards').innerHTML = `
    <div class="stat-card stat-accent-blue">
      <div class="stat-label">Total Leads</div>
      <div class="stat-value">${s.total}</div>
      <div class="stat-sub">All time</div>
    </div>
    <div class="stat-card stat-accent-amber">
      <div class="stat-label">Active</div>
      <div class="stat-value">${s.active}</div>
      <div class="stat-sub">In pipeline</div>
    </div>
    <div class="stat-card stat-accent-green">
      <div class="stat-label">Won</div>
      <div class="stat-value">${s.won}</div>
      <div class="stat-sub">Order Won + Repeat</div>
    </div>
    <div class="stat-card stat-accent-red">
      <div class="stat-label">Lost</div>
      <div class="stat-value">${s.lost}</div>
      <div class="stat-sub">Marked Lost</div>
    </div>
  `;

  // Pipeline by Stage — doughnut with center total
  renderChart('chart-stage', 'doughnut',
    Object.keys(s.by_stage),
    Object.values(s.by_stage),
    Object.keys(s.by_stage).map(k => STAGE_COLORS[k] || '#94a3b8'),
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
  document.getElementById('recent-table').innerHTML = buildTable(
    recent, ['factory_number','factory_name','product','stage','follow_up'], true
  );
}

function renderChart(id, type, labels, data, colors, opts = {}) {
  const ctx = document.getElementById(id);
  if (!ctx) return;
  if (state.charts[id]) { state.charts[id].destroy(); delete state.charts[id]; }

  const isHBar    = type === 'hbar';
  const isLine    = type === 'line';
  const chartType = isHBar ? 'bar' : type;

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
}

// ============================================================
//  Leads page
// ============================================================
function renderLeads() {
  populateFilters();
  renderLeadsView();
}

function populateFilters() {
  const stageEl   = document.getElementById('filter-stage');
  const productEl = document.getElementById('filter-product');
  const stages    = uniqueValues('stage');
  const products  = uniqueValues('product');
  stageEl.innerHTML   = '<option value="">All Stages</option>'   + stages.map(s => `<option ${s===state.filterStage?'selected':''}>${s}</option>`).join('');
  productEl.innerHTML = '<option value="">All Products</option>' + products.map(p => `<option ${p===state.filterProduct?'selected':''}>${p}</option>`).join('');
}

function renderLeadsView() {
  const leads = filteredLeads();
  if (state.view === 'table') {
    document.getElementById('leads-table-wrap').classList.remove('hidden');
    document.getElementById('leads-kanban-wrap').classList.add('hidden');
    document.getElementById('leads-table-wrap').innerHTML = buildTable(
      leads,
      ['factory_number','factory_name','person_in_charge','contact','product','quantity','rate','stage','lead_type','follow_up','area'],
      true
    );
  } else {
    document.getElementById('leads-table-wrap').classList.add('hidden');
    document.getElementById('leads-kanban-wrap').classList.remove('hidden');
    document.getElementById('leads-kanban-wrap').innerHTML = buildKanban(leads, true);
  }
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
      <div class="pipeline-stat-label">${s}</div>
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
          const typeTag   = l.lead_type ? `<span class="kanban-type-tag">${TYPE_EMOJI[l.lead_type] || ''} ${l.lead_type}</span>` : '';
          return `
          <div class="kanban-card ${cardClass}"
               ${draggable ? `draggable="true" ondragstart="dragStart(event,${l.rowIndex})"` : ''}
               onclick="openEditModal(${l.rowIndex})">
            <div class="kanban-card-name">${l.factory_name || l.factory_number || '—'} ${typeTag}</div>
            <div class="kanban-card-meta">${l.product || ''} ${l.quantity ? '· ' + l.quantity : ''}</div>
            ${l.follow_up ? `<div class="kanban-card-meta" style="margin-top:4px">📅 ${l.follow_up}</div>` : ''}
            ${l.area ? `<div class="kanban-card-meta">📍 ${l.area}</div>` : ''}
          </div>`;
        }).join('')
      : `<div style="padding:10px;color:#94a3b8;font-size:12px;text-align:center">Empty</div>`;

    const dropAttrs = draggable
      ? `ondragover="dragOver(event)" ondrop="dropCard(event,'${s}')" ondragenter="dragEnter(event)" ondragleave="dragLeave(event)"`
      : '';

    return `<div class="kanban-col">
      <div class="kanban-col-header" style="background:${color}">
        ${s} <span class="kanban-col-count">${cards.length}</span>
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
    toast(`Moved to ${newStage}`);
    await refresh();
  } catch (err) {
    toast('Stage update failed: ' + err.message, 'error');
  }
}

// ============================================================
//  Follow-ups page
// ============================================================
function renderFollowups() {
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
    ? buildTable(filtered, ['factory_number','factory_name','person_in_charge','product','stage','follow_up','notes'], true)
    : emptyState('No follow-ups for this filter');
}

// ============================================================
//  Reports page
// ============================================================
function renderReports() {
  const s = state.stats;
  if (!s || !s.by_stage) return;

  // Conversion Funnel — horizontal bar with % in tooltip
  const stageOrder   = ['New Lead','Sample Required','Sample Sent','Quotation','Negotiation','Order Won','Repeat Customer','Lost'];
  const funnelLabels = stageOrder.filter(st => s.by_stage[st]);
  const funnelData   = funnelLabels.map(st => s.by_stage[st]);
  const funnelTotal  = funnelData.reduce((a,b) => a + b, 0);
  renderChart('chart-funnel', 'hbar', funnelLabels, funnelData,
    funnelLabels.map(st => STAGE_COLORS[st] || '#94a3b8'),
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
        <div class="wl-label">Won (Order Won + Repeat)</div>
      </div>
      <div class="wl-cell">
        <div class="wl-num wl-red">${s.lost}</div>
        <div class="wl-label">Lost</div>
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
    const users = await apiFetch('/api/users');
    if (!users.length) {
      document.getElementById('team-table').innerHTML = emptyState('No team members registered yet. Ask salespeople to use /register in the bot.');
      return;
    }
    const rows = users.map(u => `
      <tr>
        <td>${escAttr(u.display_name)}</td>
        <td><span class="badge ${u.role === 'admin' ? 'badge-6' : 'badge-3'}">${u.role}</span></td>
        <td>${u.telegram_user_id ? '✅ Linked' : '—'}</td>
        <td>${u.created_at || '—'}</td>
        <td>
          ${u.role !== 'admin' ? `<button class="action-btn del" onclick="removeTeamMember(${u.id}, '${escAttr(u.display_name)}')">Remove</button>` : ''}
        </td>
      </tr>`).join('');
    document.getElementById('team-table').innerHTML = `
      <table class="crm-table">
        <thead><tr>
          <th>Name</th><th>Role</th><th>Telegram</th><th>Joined</th><th>Actions</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  } catch (err) {
    document.getElementById('team-table').innerHTML = emptyState('Failed to load team: ' + err.message);
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

// ============================================================
//  Profile Modal
// ============================================================
async function openProfileModal() {
  document.getElementById('p-pin').value  = '';
  document.getElementById('p-pin2').value = '';
  document.getElementById('profile-error').textContent = '';
  try {
    const me = await apiFetch('/api/users/me');
    document.getElementById('p-name').value = me.display_name || '';
  } catch (_) {
    document.getElementById('p-name').value = localStorage.getItem('crm_user') || '';
  }
  document.getElementById('profile-modal-overlay').classList.remove('hidden');
}

function closeProfileModal() {
  document.getElementById('profile-modal-overlay').classList.add('hidden');
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
  try {
    const result = await apiFetch('/api/users/me/profile', {
      method: 'PATCH',
      body: JSON.stringify({ display_name: name, ...(pin ? { pin } : {}) }),
    });
    if (result.token) {
      localStorage.setItem('crm_token', result.token);
      localStorage.setItem('crm_user',  result.username);
      localStorage.setItem('crm_role',  result.role);
      state.role = result.role;
    }
    applyRoleUI();
    closeProfileModal();
    toast('Profile updated!');
  } catch (err) {
    errEl.textContent = err.message;
  }
}

// ============================================================
//  Lead Access (admin grants/revokes salesperson access)
// ============================================================
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
const FIELDS = ['factory_number','factory_name','product','quantity','rate','stage','follow_up','area','notes','lead_type'];

// ── Contacts editor ──────────────────────────────────────────
function renderContactsEditor(contacts) {
  const editor = document.getElementById('contacts-editor');
  if (!editor) return;
  const rows = (contacts && contacts.length)
    ? contacts.map(c => ({ person_name: c.person_name || '', contact: c.contact || '', designation: c.designation || '' }))
    : [{ person_name: '', contact: '', designation: '' }];
  editor.innerHTML = rows.map((c, i) => `
    <div class="contact-row" data-idx="${i}">
      <input type="text" class="c-name" placeholder="Person name" value="${escAttr(c.person_name)}" />
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
    <input type="text" class="c-name" placeholder="Person name" value="" />
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

function openAddModal() {
  document.getElementById('modal-title').textContent = 'Add Lead';
  document.getElementById('f-row').value = '';
  FIELDS.forEach(f => {
    const el = document.getElementById('f-' + f);
    if (el) el.value = '';
  });
  renderContactsEditor([]);
  const accessSection = document.getElementById('modal-access-section');
  if (accessSection) accessSection.style.display = 'none';
  document.getElementById('modal-overlay').classList.remove('hidden');
}

function openEditModal(rowIndex) {
  const lead = state.leads.find(l => String(l.rowIndex) === String(rowIndex));
  if (!lead) return;
  document.getElementById('modal-title').textContent = 'Edit Lead';
  document.getElementById('f-row').value = rowIndex;
  FIELDS.forEach(f => {
    const el = document.getElementById('f-' + f);
    if (!el) return;
    if (f === 'follow_up') { el.value = ddmmyyyyToISO(lead[f] || ''); }
    else { el.value = lead[f] || ''; }
  });
  renderContactsEditor(lead.contacts || []);
  document.getElementById('modal-overlay').classList.remove('hidden');

  // Admin: load team access section
  const accessSection = document.getElementById('modal-access-section');
  const accessList    = document.getElementById('modal-access-list');
  if (state.role === 'admin' && accessSection) {
    accessSection.style.display = '';
    accessList.innerHTML = '<em style="color:var(--text-muted);font-size:12px">Loading…</em>';
    Promise.all([apiFetch(`/api/leads/${rowIndex}/access`), apiFetch('/api/users')]).then(([access, users]) => {
      const salespeople  = users.filter(u => u.role !== 'admin');
      const grantedNames = new Set(access.map(a => a.user_display_name));
      if (!salespeople.length) {
        accessList.innerHTML = '<em style="color:var(--text-muted);font-size:12px">No salespeople registered yet</em>';
        return;
      }
      accessList.innerHTML = salespeople.map(u => `
        <div style="display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid var(--border)">
          <span style="flex:1;font-size:13px">${escAttr(u.display_name)}</span>
          ${grantedNames.has(u.display_name)
            ? `<span style="font-size:11px;color:var(--success);margin-right:4px">✓ Has access</span><button class="action-btn del" style="font-size:11px" onclick="revokeAccess(${rowIndex},'${escAttr(u.display_name)}')">Revoke</button>`
            : `<button class="action-btn" style="font-size:11px" onclick="grantAccess(${rowIndex},'${escAttr(u.display_name)}')">Grant</button>`}
        </div>`).join('');
    }).catch(err => {
      accessList.innerHTML = `<em style="color:var(--danger);font-size:12px">${err.message}</em>`;
    });
  } else if (accessSection) {
    accessSection.style.display = 'none';
  }
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
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

  const btn = document.getElementById('btn-save-lead');
  btn.disabled    = true;
  btn.textContent = 'Saving…';

  try {
    if (row) {
      await updateLead(parseInt(row), data);
      toast('Lead updated successfully');
    } else {
      const result = await createLead(data);
      if (result && result.conflict) {
        toast(`Duplicate: ${result.message}`, 'error');
        return;
      }
      toast('Lead added successfully');
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
    toast('Lead deleted');
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
    await Promise.all([loadLeads(), loadStats()]);
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

function wireEvents() {
  document.querySelectorAll('.nav-item[data-page]').forEach(el => {
    el.addEventListener('click', () => {
      navigate(el.dataset.page);
      if (window.innerWidth <= 640) {
        document.getElementById('sidebar').classList.remove('open');
        document.getElementById('sidebar-overlay').classList.remove('visible');
      }
    });
  });

  document.querySelectorAll('[data-page]').forEach(el => {
    el.addEventListener('click', e => {
      if (el.tagName === 'A') { e.preventDefault(); navigate(el.dataset.page); }
    });
  });

  document.getElementById('sidebar-toggle').addEventListener('click', () => {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('sidebar-overlay');
    if (window.innerWidth <= 640) {
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
    if (state.page === 'leads') renderLeadsView();
  });

  document.getElementById('btn-add-lead').addEventListener('click', openAddModal);
  document.getElementById('btn-refresh').addEventListener('click', refresh);
  document.getElementById('btn-export').addEventListener('click', exportCSV);
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

  document.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.view = btn.dataset.view;
      document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderLeadsView();
    });
  });

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

  // Profile modal
  document.getElementById('profile-form').addEventListener('submit', handleProfileSubmit);
  document.getElementById('profile-modal-close').addEventListener('click', closeProfileModal);
  document.getElementById('btn-cancel-profile').addEventListener('click', closeProfileModal);
  document.getElementById('profile-modal-overlay').addEventListener('click', e => {
    if (e.target === document.getElementById('profile-modal-overlay')) closeProfileModal();
  });

  // Team nav (admin only — shown/hidden via applyRoleUI)
  const teamNav = document.querySelector('[data-page="team"]');
  if (teamNav) teamNav.addEventListener('click', () => navigate('team'));
}

// ============================================================
//  Init
// ============================================================
async function initApp() {
  try {
    await Promise.all([loadLeads(), loadStats()]);
    lastRefreshed = new Date();
    navigate('dashboard');
    applyRoleUI();
    startAutoRefresh();
    initSocket();
  } catch (err) {
    if (err.message.includes('401') || err.message.includes('Session expired')) {
      showLoginPage();
    } else {
      toast('Could not connect to server. Is it running?', 'error');
    }
    console.error(err);
  }
}

async function init() {
  initTheme();
  wireEvents();
  const token = localStorage.getItem('crm_token');
  if (!token) {
    showLoginPage();
    return;
  }
  state.role = localStorage.getItem('crm_role') || 'sales';
  hideLoginPage();
  await initApp();
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
  const btn   = document.getElementById('btn-biometric-login');
  const errEl = document.getElementById('login-error');
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
}

init();
