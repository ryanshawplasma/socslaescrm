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

async function tryRefreshToken() {
  const rt = localStorage.getItem('crm_refresh_token');
  if (!rt) return false;
  try {
    const res  = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt }),
    });
    if (!res.ok) { clearTokens(); return false; }
    const data = await res.json();
    storeTokens(data.accessToken, data.refreshToken);
    if (data.username) localStorage.setItem('crm_user', data.username);
    if (data.role)     { localStorage.setItem('crm_role', data.role); state.role = data.role; }
    return true;
  } catch { return false; }
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
async function loadLoginUserChips() {
  try {
    const names = await fetch('/api/users/names').then(r => r.ok ? r.json() : []);
    const wrap  = document.getElementById('login-user-chips');
    if (!names.length) { wrap.classList.add('hidden'); return; }
    wrap.innerHTML = names.map(n =>
      `<button type="button" class="user-chip" onclick="selectUserChip(${JSON.stringify(n)})">${escHtml(n)}</button>`
    ).join('');
    wrap.classList.remove('hidden');
  } catch (_) {}
}

function selectUserChip(name) {
  document.getElementById('login-username').value = name;
  document.getElementById('login-password').value = '';
  document.getElementById('login-password').focus();
  document.getElementById('login-error').textContent = '';
  updateCredentialLabel(name);
}

function updateCredentialLabel(val) {
  const lbl = document.getElementById('credential-type-label');
  if (lbl) lbl.textContent = detectCredentialType(val);
}

function showForgotPin(e) {
  if (e) e.preventDefault();
  const box = document.getElementById('forgot-pin-box');
  box.style.display = box.style.display === 'none' ? '' : 'none';
}

function showLoginPage() {
  // Hide PIN unlock, show login screen
  document.getElementById('pin-unlock-screen').style.display = 'none';
  document.getElementById('login-screen').style.display      = '';
  document.getElementById('register-screen').style.display   = 'none';
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  loadLoginUserChips();
  if (window.SimpleWebAuthnBrowser?.browserSupportsWebAuthn())
    document.getElementById('biometric-login-section').classList.remove('hidden');
}

function hideLoginPage() {
  document.getElementById('login-overlay').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  applyRoleUI();
}

function applyRoleUI() {
  const isAdmin = state.role === 'admin';
  document.querySelectorAll('.admin-only').forEach(el => el.style.display = isAdmin ? '' : 'none');
  const userEl = document.getElementById('current-user');
  const name   = localStorage.getItem('crm_user') || '';
  if (userEl) userEl.textContent = `${name} (${state.role || '?'})`;
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

async function logout() {
  clearInterval(autoRefreshTimer);
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
  state.role = null;
  showLoginPage();
}

function switchAccount() {
  clearInterval(autoRefreshTimer);
  clearTokens();
  localStorage.removeItem('crm_role');
  localStorage.removeItem('crm_user');
  localStorage.removeItem('crm_user_id');
  localStorage.removeItem('crm_session_id');
  localStorage.removeItem('crm_device_trusted');
  localStorage.removeItem('crm_device_id');
  localStorage.removeItem('crm_device_has_pin');
  state.role = null;
  document.getElementById('pin-unlock-screen').style.display = 'none';
  showLoginScreen();
}

// ── PIN Unlock screen ─────────────────────────────────────────
async function checkAndShowAuth() {
  // Resume guest/demo session if still valid
  const guestToken = localStorage.getItem('crm_access');
  if (localStorage.getItem('crm_role') === 'guest' && guestToken) {
    state.role = 'guest';
    hideLoginPage();
    showDemoBanner();
    await initApp();
    return;
  }

  const rt          = localStorage.getItem('crm_refresh_token');
  const deviceId    = localStorage.getItem('crm_device_id');
  const devicePin   = localStorage.getItem('crm_device_has_pin') === 'true';
  const savedUser   = localStorage.getItem('crm_user');

  if (rt && deviceId && devicePin && savedUser) {
    // Check with server if PIN still valid for this device
    try {
      const res  = await fetch('/api/auth/pin-check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt, deviceId }),
      });
      const data = await res.json();
      if (res.ok && data.hasPIN) {
        showPinUnlockScreen(data.username || savedUser);
        return;
      }
    } catch (_) {}
  }

  // No PIN → try silent refresh
  if (rt) {
    const ok = await tryRefreshToken();
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

function showPinUnlockScreen(username) {
  document.getElementById('pin-unlock-name').textContent   = username || 'Welcome back';
  document.getElementById('pin-unlock-avatar').textContent = (username || '?')[0].toUpperCase();
  document.getElementById('pin-dots').innerHTML = '';
  document.getElementById('pin-input').value   = '';
  document.getElementById('pin-error').textContent = '';
  document.getElementById('pin-unlock-screen').style.display = '';
  document.getElementById('login-screen').style.display      = 'none';
  document.getElementById('register-screen').style.display   = 'none';
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  setTimeout(() => document.getElementById('pin-input').focus(), 100);
}

function pinInputChanged(val) {
  const dots    = document.getElementById('pin-dots');
  const len     = Math.min(val.length, 6);
  dots.innerHTML = Array.from({ length: 6 }, (_, i) =>
    `<div class="pin-dot${i < len ? ' filled' : ''}"></div>`
  ).join('');
}

async function submitPinUnlock() {
  const pin      = document.getElementById('pin-input').value.trim();
  const deviceId = localStorage.getItem('crm_device_id');
  const rt       = localStorage.getItem('crm_refresh_token');
  const errEl    = document.getElementById('pin-error');
  const btn      = document.getElementById('pin-unlock-btn');
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
  localStorage.setItem('crm_user',    username);
  localStorage.setItem('crm_role',    loginData.role);
  localStorage.setItem('crm_user_id', String(loginData.userId || ''));
  localStorage.setItem('crm_session_id', loginData.sessionId || '');
  state.role = loginData.role;

  if (deviceId) {
    localStorage.setItem('crm_device_id',      deviceId);
    localStorage.setItem('crm_device_trusted', 'true');
    localStorage.setItem('crm_device_has_pin', String(hasPIN));
  }

  hideLoginPage();

  // If trusted device and no PIN yet — offer PIN setup
  if (deviceTrusted && !hasPIN) {
    setTimeout(() => showPinSetupModal(deviceId), 500);
  }

  await initApp();
}

// ── PIN Setup modal ───────────────────────────────────────────
function showPinSetupModal(deviceId) {
  const modal = document.getElementById('pin-setup-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.dataset.deviceId = deviceId || '';
  document.getElementById('pin-setup-input').value   = '';
  document.getElementById('pin-setup-input2').value  = '';
  document.getElementById('pin-setup-error').textContent = '';
}

function closePinSetupModal() {
  const modal = document.getElementById('pin-setup-modal');
  if (modal) modal.classList.add('hidden');
}

async function submitPinSetup() {
  const pin    = document.getElementById('pin-setup-input').value.trim();
  const pin2   = document.getElementById('pin-setup-input2').value.trim();
  const errEl  = document.getElementById('pin-setup-error');
  const deviceId = document.getElementById('pin-setup-modal').dataset.deviceId;
  errEl.textContent = '';
  if (!/^\d{4,6}$/.test(pin))  { errEl.textContent = 'PIN must be 4–6 digits'; return; }
  if (pin !== pin2)             { errEl.textContent = 'PINs do not match'; return; }
  try {
    const res = await apiFetch('/api/auth/pin-setup', {
      method: 'POST',
      body: JSON.stringify({ pin, deviceId }),
    });
    localStorage.setItem('crm_device_has_pin', 'true');
    closePinSetupModal();
    toast('Quick-unlock PIN set! Use it next time you open the app.', 'success');
  } catch (err) {
    errEl.textContent = err.message || 'Failed to set PIN';
  }
}

function showRegisterScreen(e) {
  if (e) e.preventDefault();
  document.getElementById('login-screen').style.display    = 'none';
  document.getElementById('register-screen').style.display = '';
  document.getElementById('register-error').textContent    = '';
}

function showLoginScreen(e) {
  if (e) e.preventDefault();
  document.getElementById('register-screen').style.display = 'none';
  document.getElementById('login-screen').style.display    = '';
  document.getElementById('login-error').textContent       = '';
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
    localStorage.setItem('crm_user',    'Guest');
    localStorage.setItem('crm_role',    'guest');
    localStorage.removeItem('crm_refresh');
    localStorage.removeItem('crm_session');
    document.getElementById('login-overlay').classList.add('hidden');
    showDemoBanner();
    await init();
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
    <a href="#" onclick="(function(){localStorage.removeItem('crm_access');localStorage.removeItem('crm_role');location.reload();})()" style="color:#fff;font-weight:600;margin-left:10px;text-decoration:underline">Create Account →</a>
    <button onclick="this.parentElement.remove()" style="background:none;border:none;color:#fff;float:right;cursor:pointer;font-size:16px;line-height:1">✕</button>
  `;
  b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#e67e22;color:#fff;padding:10px 16px;font-size:13px;display:flex;align-items:center;gap:6px;';
  document.body.prepend(b);
}

async function handleRegister(e) {
  e.preventDefault();
  const name  = document.getElementById('reg-name').value.toLowerCase().trim();
  const pin   = document.getElementById('reg-pin').value.trim();
  const pin2  = document.getElementById('reg-pin2').value.trim();
  const errEl = document.getElementById('register-error');
  const btn   = document.getElementById('register-btn');
  errEl.textContent = '';
  const fmtErr = getUsernameFormatError(name);
  if (fmtErr)                    { errEl.textContent = fmtErr; return; }
  if (!/^\d{4,6}$/.test(pin))   { errEl.textContent = 'PIN must be 4–6 digits'; return; }
  if (pin !== pin2)              { errEl.textContent = 'PINs do not match'; return; }
  btn.disabled    = true;
  btn.textContent = 'Creating…';
  try {
    const mobile = (document.getElementById('reg-mobile')?.value || '').trim();
    const regRes  = await fetch('/api/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, pin, mobile }),
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
    const fingerprint = getDeviceFingerprint();
    const deviceMeta  = getDeviceMeta();
    const loginRes  = await fetch('/api/auth/login', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ credential: name, password: pin, fingerprint, trustDevice: true, deviceMeta }),
    });
    const loginData = await loginRes.json();
    if (!loginRes.ok) throw new Error(loginData.error || 'Login failed after registration');
    toast('Welcome ' + name + '! Account created.', 'success');
    await offerDeviceSetup(loginData);
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
      if (res.status === 423) errEl.textContent = data.error;
      else errEl.textContent = data.error || 'Login failed';
      return;
    }
    await offerDeviceSetup(data);
  } catch (err) {
    errEl.textContent = (err instanceof TypeError && err.message.toLowerCase().includes('fetch'))
      ? 'Server is starting up, please try again in 30 seconds.'
      : err.message;
  } finally {
    btn.disabled    = false;
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
      clearTokens();
      localStorage.removeItem('crm_role');
      localStorage.removeItem('crm_user');
      state.role = null;
      showLoginPage();
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
  pipeline: 'Pipeline', followups: 'Follow-ups', reports: 'Reports', team: 'Team', map: 'Map', chat: 'Chat',
  workspace: 'Workspace',
};

function navigate(page) {
  state.page = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const pageEl = document.getElementById(`page-${page}`);
  if (pageEl) pageEl.classList.add('active');
  document.querySelector(`[data-page="${page}"]`)?.classList.add('active');
  document.getElementById('page-title').textContent = PAGE_TITLES[page] || page;
  // Chat page needs edge-to-edge layout (no content padding)
  document.getElementById('content')?.classList.toggle('chat-mode', page === 'chat');
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
  if (page === 'chat')       chatFocusInput();
  if (page === 'workspace')  renderWorkspace();
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
  renderAiToggle('leads');
  renderAiPanel('leads');
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
  renderAiToggle('followups');
  renderAiPanel('followups');
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
    const header = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <span style="font-size:15px;font-weight:600;color:var(--text)">Team Members (${users.length})</span>
        <button class="btn btn-primary" style="font-size:13px;padding:6px 14px" onclick="openAddMemberModal()">+ Add Member</button>
      </div>`;
    if (!users.length) {
      document.getElementById('team-table').innerHTML = header + emptyState('No team members yet. Add one above or ask salespeople to use /register in the bot.');
      return;
    }
    const rows = users.map(u => `
      <tr>
        <td style="font-weight:500">${escAttr(u.display_name)}</td>
        <td><span class="badge ${u.role === 'admin' ? 'badge-6' : 'badge-3'}">${u.role}</span></td>
        <td style="color:${u.telegram_user_id ? 'var(--success)' : 'var(--text-muted)'}">
          ${u.telegram_user_id ? '✓ Linked' : '— Not linked'}
        </td>
        <td style="color:var(--text-muted);font-size:12px">${u.created_at ? u.created_at.split(' ')[0] : '—'}</td>
        <td style="display:flex;gap:6px;align-items:center">
          ${u.role !== 'admin'
            ? `<button class="action-btn" onclick="openResetPinModal(${u.id}, '${escAttr(u.display_name)}')">Reset PIN</button>
               <button class="action-btn del" onclick="removeTeamMember(${u.id}, '${escAttr(u.display_name)}')">Remove</button>`
            : '<span style="color:var(--text-muted);font-size:12px">—</span>'}
        </td>
      </tr>`).join('');
    document.getElementById('team-table').innerHTML = header + `
      <table class="crm-table">
        <thead><tr>
          <th>Name</th><th>Role</th><th>Telegram Bot</th><th>Joined</th><th>Action</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top:10px;font-size:12px;color:var(--text-muted)">Salespeople can also self-register via the <b>Create Account</b> link on the login page, or using <b>/register</b> in the Telegram bot.</p>
      <div id="ai-vocab-container"></div>`;
    renderVocabAdmin();
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

function openResetPinModal(userId, userName) {
  let overlay = document.getElementById('reset-pin-overlay');
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.id = 'reset-pin-overlay';
  overlay.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;background:rgba(0,0,0,0.55);z-index:1000;display:flex;align-items:center;justify-content:center';
  overlay.innerHTML = `
    <div style="background:var(--card-bg);border-radius:12px;padding:24px;width:320px;max-width:95vw;box-shadow:0 8px 32px rgba(0,0,0,0.4)">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <h3 style="margin:0;font-size:15px;color:var(--text)">Reset PIN — ${escHtml(userName)}</h3>
        <button onclick="document.getElementById('reset-pin-overlay').remove()" class="icon-btn">✕</button>
      </div>
      <div class="form-group" style="margin-bottom:12px">
        <label>New PIN <span style="font-weight:400;color:var(--text-muted)">(4–6 digits)</span></label>
        <input id="rp-pin" type="password" placeholder="••••••" inputmode="numeric" maxlength="6" style="width:100%" autofocus />
      </div>
      <div class="form-group" style="margin-bottom:16px">
        <label>Confirm PIN</label>
        <input id="rp-pin2" type="password" placeholder="••••••" inputmode="numeric" maxlength="6" style="width:100%" />
      </div>
      <p id="rp-error" style="color:var(--danger);font-size:13px;margin:0 0 12px;min-height:18px"></p>
      <div style="display:flex;gap:8px;justify-content:flex-end">
        <button class="btn btn-ghost" onclick="document.getElementById('reset-pin-overlay').remove()">Cancel</button>
        <button class="btn btn-primary" id="rp-btn" onclick="submitResetPin(${userId}, '${escAttr(userName)}')">Set PIN</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

async function submitResetPin(userId, userName) {
  const pin   = document.getElementById('rp-pin').value.trim();
  const pin2  = document.getElementById('rp-pin2').value.trim();
  const errEl = document.getElementById('rp-error');
  const btn   = document.getElementById('rp-btn');
  errEl.textContent = '';
  if (!/^\d{4,6}$/.test(pin)) { errEl.textContent = 'PIN must be 4–6 digits'; return; }
  if (pin !== pin2)            { errEl.textContent = 'PINs do not match'; return; }
  btn.disabled    = true;
  btn.textContent = 'Saving…';
  try {
    await apiFetch(`/api/users/${userId}/pin`, { method: 'PATCH', body: JSON.stringify({ pin }) });
    document.getElementById('reset-pin-overlay').remove();
    toast(`PIN reset for ${userName}. Share the new PIN with them.`, 'success');
  } catch (err) {
    errEl.textContent = err.message;
    btn.disabled    = false;
    btn.textContent = 'Set PIN';
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
  const defaultArea = document.getElementById('p-default-area').value.trim();
  localStorage.setItem('crm_default_area', defaultArea);
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
const FIELDS = ['factory_number','factory_name','stage','follow_up','area','notes','lead_type'];

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

// ── Items editor (multi-product) ──────────────────────────────
const PRODUCT_OPTIONS = ['Hotmelt','Rubber Adhesive','Solvent','Latex','BC','Toluene','R6','MEK','PU Adhesive','Silicon','Other'];

function productSelect(selected = '') {
  return `<select class="i-product">
    <option value="">Select…</option>
    ${PRODUCT_OPTIONS.map(p => `<option${p === selected ? ' selected' : ''}>${p}</option>`).join('')}
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
  document.getElementById('modal-title').textContent = 'Add Lead';
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
  const itemsToEdit = (lead.items && lead.items.length)
    ? lead.items
    : (lead.product ? [{ product: lead.product, quantity: lead.quantity, rate: lead.rate }] : []);
  renderItemsEditor(itemsToEdit);
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

  document.getElementById('btn-add-lead').addEventListener('click', () => {
    if (state.aiMode[state.page]) {
      document.getElementById(`ai-input-${state.page}`)?.focus();
    } else {
      openAddModal();
    }
  });
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
  document.getElementById('register-form').addEventListener('submit', handleRegister);
  renderPinStrength('reg-pin', 'reg-pin-strength');
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
  // Show overlay while we check auth state
  document.getElementById('login-overlay').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  await checkAndShowAuth();
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
  const words = val.trimEnd().split(/\s+/);
  const last  = words[words.length - 1].toLowerCase();
  if (last.length < 2) { ac.className = 'chat-autocomplete'; return; }
  const matches = CHAT_PRODUCTS.filter(p =>
    p.label.toLowerCase().startsWith(last) && p.label.toLowerCase() !== last
  );
  if (!matches.length) { ac.className = 'chat-autocomplete'; return; }
  ac.innerHTML = matches.map(m =>
    `<div class="chat-ac-item" onmousedown="chatSelectProduct('${m.label}')">
       <span class="chat-ac-icon">${m.icon}</span>${m.label}
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

// ── Edit parsed — put data back into input for correction ─
function chatEditParsed(parsedJson, msgEl) {
  const parsed = JSON.parse(parsedJson);
  const parts = [];
  if (parsed.factory_number)   parts.push(parsed.factory_number);
  if (parsed.factory_name)     parts.push(parsed.factory_name);
  if (parsed.person_in_charge) parts.push(parsed.person_in_charge);
  if (parsed.area)             parts.push(parsed.area);
  (parsed.items || []).forEach(it => {
    let s = it.product || '';
    if (it.quantity) s += ' ' + it.quantity;
    if (it.rate)     s += '@' + it.rate;
    if (s.trim()) parts.push(s.trim());
  });
  if (parsed.lead_type && parsed.lead_type !== 'Cold') parts.push(parsed.lead_type.toLowerCase());
  if (parsed.follow_up) parts.push('follow up ' + parsed.follow_up);
  if (parsed.notes)     parts.push(parsed.notes);

  // remove the preview bubble
  if (msgEl) msgEl.remove();

  const input = document.getElementById('chat-input');
  if (input) {
    input.value = parts.join(' ');
    input.focus();
    input.selectionStart = input.selectionEnd = input.value.length;
  }
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

function buildChatPreview({ parsed, action, existingRow }) {
  const p = parsed;
  const itemsHtml = (p.items || []).map(it =>
    `<div class="chat-item-row">
      <span class="chat-item-product">${it.product || '—'}</span>
      <span>${it.quantity || '—'}</span>
      ${it.rate ? `<span>@ ₹${it.rate}</span>` : ''}
    </div>`
  ).join('') || '<div style="color:var(--text-muted)">No items detected</div>';

  const badgeColor = p.lead_type === 'Hot' ? '#ef4444' : p.lead_type === 'Warm' ? '#f59e0b' : '#3b82f6';
  const actionLabel = action === 'UPDATE' ? '🔄 Update existing lead' : '➕ New lead';

  return `
    <div class="chat-preview-card">
      <div class="chat-preview-header">
        <span class="chat-preview-action">${actionLabel}</span>
        ${p.lead_type ? `<span class="chat-preview-badge" style="background:${badgeColor}">${p.lead_type}</span>` : ''}
      </div>
      <table class="chat-preview-table">
        <tr><td>Factory #</td><td><b>${p.factory_number || '—'}</b></td></tr>
        <tr><td>Factory</td><td><b>${p.factory_name || '—'}</b></td></tr>
        ${p.person_in_charge ? `<tr><td>Contact</td><td>${p.person_in_charge}</td></tr>` : ''}
        ${p.area ? `<tr><td>Area</td><td>${p.area}</td></tr>` : ''}
        ${p.stage ? `<tr><td>Stage</td><td>${p.stage}</td></tr>` : ''}
        ${p.follow_up ? `<tr><td>Follow-up</td><td>${p.follow_up}</td></tr>` : ''}
      </table>
      <div class="chat-preview-items">${itemsHtml}</div>
      <div class="chat-preview-actions">
        <button class="btn-primary" onclick="chatConfirm(${JSON.stringify({ parsed: p, action, existingRow }).replace(/"/g, '&quot;')})">✅ Confirm</button>
        <button class="btn-secondary" onclick="chatEditParsed('${JSON.stringify(p).replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/"/g,'&quot;')}', this.closest('.chat-msg'))">✏️ Edit</button>
        <button class="btn-secondary" onclick="this.closest('.chat-msg').remove()">✕</button>
      </div>
    </div>`;
}

async function chatSend() {
  const input = document.getElementById('chat-input');
  const text  = (input?.value || '').trim();
  if (!text) return;
  input.value = '';
  document.getElementById('chat-autocomplete').className = 'chat-autocomplete';

  chatAppendMessage('user', escHtml(text));
  chatAppendMessage('bot', '⏳ Parsing…');

  try {
    const data = await apiFetch('/api/parse', { method: 'POST', body: JSON.stringify({ text }) });
    chatReplaceLastBot(buildChatPreview(data));
  } catch (err) {
    chatReplaceLastBot('❌ ' + (err.message || 'Error parsing lead'));
  }
}

async function chatConfirm({ parsed, action, existingRow }) {
  const payload = {
    factory_number:  parsed.factory_number  || '',
    factory_name:    parsed.factory_name    || '',
    person_in_charge: parsed.person_in_charge || '',
    contact:         parsed.contact         || '',
    product:         parsed.items?.[0]?.product  || parsed.product  || '',
    quantity:        parsed.items?.[0]?.quantity || parsed.quantity || '',
    rate:            parsed.items?.[0]?.rate     || parsed.rate     || '',
    stage:           parsed.stage           || '',
    stage_number:    parsed.stage_number    || 0,
    follow_up:       parsed.follow_up       || '',
    area:            parsed.area            || '',
    notes:           parsed.notes           || '',
    lead_type:       parsed.lead_type       || 'Cold',
    items:           parsed.items           || [],
    contacts:        [],
  };

  try {
    if (action === 'UPDATE' && existingRow != null && existingRow !== -1) {
      await apiFetch(`/api/leads/${existingRow}`, { method: 'PUT', body: JSON.stringify(payload) });
    } else {
      await apiFetch('/api/leads', { method: 'POST', body: JSON.stringify(payload) });
    }

    chatAppendMessage('bot', `✅ Lead <b>${escHtml(payload.factory_name || payload.factory_number || 'saved')}</b> ${action === 'UPDATE' ? 'updated' : 'added'} successfully!`);
    await loadLeads();
    await loadStats();
    renderPage(state.page);
  } catch (err) {
    chatAppendMessage('bot', '❌ Save failed: ' + escHtml(err.message));
  }
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
  // Load my teams
  try {
    ws.myTeams = await apiFetch('/api/my/teams');
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
  document.getElementById('ws-team-avatar').textContent = (t.name || '?')[0].toUpperCase();
  document.getElementById('ws-team-name').textContent   = t.name;
  document.getElementById('ws-team-meta').textContent   =
    `@${t.handle}  ·  ${t.team_code}  ·  Your role: ${t.role}`;
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
      </div>
    </div>`;
}

function wsCopyInvite() {
  navigator.clipboard?.writeText(ws.activeTeam.invite_code);
  toast('Invite code copied!');
}

function wsCopyLink() {
  const link = `${location.origin}?join=${ws.activeTeam.invite_code}`;
  navigator.clipboard?.writeText(link);
  toast('Invite link copied!');
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
      <div class="card" style="overflow:auto">
        <table class="crm-table">
          <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Joined</th><th>Action</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
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
  try {
    const requests = await wsTeamApiFetch(`/api/teams/${ws.activeTeam.id}/requests`);
    const pending  = requests.filter(r => r.status === 'pending');
    // Update badge
    const badge = document.getElementById('ws-req-badge');
    if (pending.length) { badge.textContent = pending.length; badge.classList.remove('hidden'); }
    else                { badge.classList.add('hidden'); }

    if (!requests.length) {
      panel.innerHTML = `<div style="padding:30px;text-align:center;color:var(--text-muted)">No join requests yet.</div>`;
      return;
    }

    const rows = requests.map(r => `
      <tr>
        <td style="font-weight:500">${escHtml(r.user_name)}</td>
        <td style="color:var(--text-muted);font-size:12px">${r.message || '—'}</td>
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
      <div style="margin-bottom:14px;font-size:15px;font-weight:600">${pending.length} Pending · ${requests.length} Total</div>
      <div class="card" style="overflow:auto">
        <table class="crm-table">
          <thead><tr><th>Name</th><th>Message</th><th>Status</th><th>Requested</th><th>Action</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch (err) { panel.innerHTML = `<div class="ws-error">${escHtml(err.message)}</div>`; }
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
        <input id="ws-inv-input" type="text" class="ws-input" placeholder="Enter invite code" style="flex:1" />
        <button class="btn btn-primary" onclick="wsJoinByCode()">Join</button>
      </div>
      <p id="ws-join-err" class="login-error"></p>
    </div>`;

  // If URL has ?join=code, auto-fill
  const params = new URLSearchParams(location.search);
  const autoCode = params.get('join');
  if (autoCode) {
    document.getElementById('ws-inv-input').value = autoCode;
    history.replaceState({}, '', location.pathname);
  }
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
    await renderWorkspace();
  } catch (err) { errEl.textContent = err.message; }
}

async function wsRequestJoin(teamId, teamName) {
  try {
    const { auto_approved } = await apiFetch(`/api/teams/${teamId}/request`, { method: 'POST', body: JSON.stringify({ message: '' }) });
    if (auto_approved) {
      toast(`Joined ${teamName}! Welcome.`, 'success');
      await renderWorkspace();
    } else {
      toast(`Join request sent to ${teamName}. Waiting for approval.`);
    }
  } catch (err) { toast(err.message, 'error'); }
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
      <p id="ws-create-err" class="login-error"></p>
      <button class="btn btn-primary" onclick="wsCreateTeam()">Create Team</button>
    </div>`;
}

async function wsCreateTeam() {
  const name   = (document.getElementById('ws-create-name').value   || '').trim();
  const handle = (document.getElementById('ws-create-handle').value || '').trim();
  const errEl  = document.getElementById('ws-create-err');
  errEl.textContent = '';
  if (name.length < 2)   { errEl.textContent = 'Team name must be at least 2 characters'; return; }
  if (handle.length < 3) { errEl.textContent = 'Handle must be at least 3 characters'; return; }
  try {
    await apiFetch('/api/teams', { method: 'POST', body: JSON.stringify({ name, handle }) });
    toast(`Team "${name}" created!`, 'success');
    await renderWorkspace();
  } catch (err) { errEl.textContent = err.message; }
}

// ── Settings ──────────────────────────────────────────────────

function wsRenderSettings() {
  const t = ws.activeTeam;
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
      <p id="ws-set-err" class="login-error"></p>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" onclick="wsSaveSettings()">Save Settings</button>
      </div>
    </div>`;
}

async function wsSaveSettings() {
  const name         = (document.getElementById('ws-set-name').value   || '').trim();
  const handle       = (document.getElementById('ws-set-handle').value || '').trim();
  const publicSearch = document.getElementById('ws-set-public').checked;
  const autoApprove  = document.getElementById('ws-set-auto').checked;
  const errEl        = document.getElementById('ws-set-err');
  errEl.textContent  = '';
  if (name.length < 2)   { errEl.textContent = 'Name too short'; return; }
  if (handle.length < 3) { errEl.textContent = 'Handle too short'; return; }
  try {
    await wsTeamApiFetch(`/api/teams/${ws.activeTeam.id}`, {
      method: 'PATCH', body: JSON.stringify({ name, handle, publicSearch, autoApprove }),
    });
    ws.activeTeam.name         = name;
    ws.activeTeam.handle       = handle;
    ws.activeTeam.public_search = publicSearch;
    ws.activeTeam.auto_approve  = autoApprove;
    wsFillBanner();
    toast('Settings saved!', 'success');
  } catch (err) { errEl.textContent = err.message; }
}

// ── Leave team ────────────────────────────────────────────────

async function wsLeaveTeam() {
  if (!confirm(`Leave "${ws.activeTeam.name}"? You'll need an invite to rejoin.`)) return;
  try {
    await wsTeamApiFetch(`/api/teams/${ws.activeTeam.id}/leave`, { method: 'POST' });
    ws.activeTeam = null;
    localStorage.removeItem('ws_team_id');
    toast('Left team');
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
        placeholder="Type naturally… e.g. M99 Kapoor Shoes hotmelt 500 bags @120 hot follow up Friday"></textarea>
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
      <span class="ai-field-label">${label}</span>
      <input class="ai-field-input ${confClass(confVal)}" value="${escAttr(value || '')}"
        onchange="aiFieldChange('${uuid}','${field}',this.value)" />
      <span class="ai-conf-dot" title="${confVal !== undefined ? Math.round((confVal||0)*100)+'% confident' : ''}"
        style="background:${confDotColor(confVal)}"></span>
    </div>`;

  const stageOptions = ['New Lead','Prospecting','Demo Scheduled','Negotiation','Order Placed','Order Won','Repeat Customer','Lost']
    .map(s => `<option ${p.stage === s ? 'selected' : ''}>${escHtml(s)}</option>`).join('');

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
      ${fieldRow('Factory #', 'factory_number', p.factory_number, conf.factory_number)}
      ${fieldRow('Factory', 'factory_name', p.factory_name, conf.factory_name)}
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
    stage_number:     parsed.stage_number     || 1,
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
      const result = await apiFetch('/api/leads', { method: 'POST', body: JSON.stringify(payload) });
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
