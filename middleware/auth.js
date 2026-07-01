'use strict';

const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const db     = require('../db');

const JWT_SECRET  = process.env.JWT_SECRET || 'crm_default_secret_change_me';
const ACCESS_TTL  = '15m';

// ── Token helpers ─────────────────────────────────────────────
function signAccessToken(userId, username, role, sessionId) {
  return jwt.sign(
    { sub: String(userId), username, role, sid: sessionId, jti: uuidv4() },
    JWT_SECRET,
    { expiresIn: ACCESS_TTL }
  );
}

function signToken(username, role) {
  return signAccessToken(0, username, role, null);
}

function verifyLegacyToken(token) {
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const b64  = token.slice(0, dot);
  const sig  = token.slice(dot + 1);
  let payload;
  try { payload = Buffer.from(b64, 'base64').toString(); } catch { return null; }
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('hex');
  if (sig !== expected) return null;
  const parts = payload.split(':');
  if (parts.length < 3) return null;
  if (Date.now() > parseInt(parts[2], 10)) return null;
  return { username: parts[0], role: parts[1] };
}

function verifyAccessToken(token) {
  if (!token) return null;
  try {
    const p = jwt.verify(token, JWT_SECRET);
    return { userId: p.sub, username: p.username, role: p.role, sessionId: p.sid };
  } catch {}
  const legacy = verifyLegacyToken(token);
  if (legacy) return { userId: null, username: legacy.username, role: legacy.role, sessionId: null };
  return null;
}

// ── UA helpers ────────────────────────────────────────────────
function parseBrowser(ua) {
  if (!ua) return 'Unknown';
  if (/Edg\//.test(ua))     return 'Edge';
  if (/OPR\//.test(ua))     return 'Opera';
  if (/Chrome\//.test(ua))  return 'Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua))  return 'Safari';
  return 'Browser';
}

function parseOS(ua) {
  if (!ua) return 'Unknown';
  if (/Windows NT 10/.test(ua))  return 'Windows 11/10';
  if (/Windows/.test(ua))        return 'Windows';
  if (/Android/.test(ua))        return 'Android';
  if (/iPhone|iPad/.test(ua))    return 'iOS';
  if (/Mac OS X/.test(ua))       return 'macOS';
  if (/Linux/.test(ua))          return 'Linux';
  return 'Unknown OS';
}

function parseDeviceName(ua) {
  return `${parseBrowser(ua)} on ${parseOS(ua)}`;
}

function getIP(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip || '';
}

// ── Core middleware ───────────────────────────────────────────
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const user = verifyAccessToken(header.slice(7));
  if (!user) return res.status(401).json({ error: 'token_expired' });
  req.user = user;
  next();
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

function noGuest(req, res, next) {
  if (req.user?.role === 'guest') {
    return res.status(403).json({ error: 'demo_only', message: 'Create an account to save data' });
  }
  next();
}

// ── Team middleware ───────────────────────────────────────────
async function teamMemberMiddleware(req, res, next) {
  const teamId = parseInt(req.headers['x-team-id'], 10);
  if (!teamId) return res.status(400).json({ error: 'X-Team-ID header required' });
  const user = await db.getUserByName(req.user.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const member = await db.getTeamMember(teamId, user.id);
  if (!member || member.status !== 'active') {
    return res.status(403).json({ error: 'Not an active member of this team' });
  }
  req.teamId   = teamId;
  req.teamRole = member.role;
  req.dbUser   = user;
  next();
}

function teamAdminMiddleware(req, res, next) {
  if (!['owner', 'admin'].includes(req.teamRole)) {
    return res.status(403).json({ error: 'Team admin access required' });
  }
  next();
}

// ── Security fix: validate lead ownership before mutations ────
async function requireLeadAccess(req, res, next) {
  const leadId = parseInt(req.params.row || req.params.id, 10);
  if (!leadId) return next();
  try {
    const lead = await db.getLeadById(leadId);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    if (req.user.role === 'admin') {
      if (lead.team_id && req.teamId && lead.team_id !== req.teamId) {
        return res.status(403).json({ error: 'Forbidden: lead belongs to another team' });
      }
      return next();
    }

    const hasAccess = lead.created_by === req.user.username ||
      await db.userHasLeadAccess(leadId, req.user.username);
    if (!hasAccess) return res.status(403).json({ error: 'Forbidden' });
    next();
  } catch (err) {
    next(err);
  }
}

// ── Granular permissions ──────────────────────────────────────
const PERMISSIONS = {
  VIEW_OWN_LEADS:   'view_own_leads',
  VIEW_TEAM_LEADS:  'view_team_leads',
  EDIT_OWN_LEADS:   'edit_own_leads',
  EDIT_TEAM_LEADS:  'edit_team_leads',
  DELETE_LEADS:     'delete_leads',
  EXPORT_DATA:      'export_data',
  MANAGE_TEAM:      'manage_team',
  MANAGE_USERS:     'manage_users',
  APPROVE_AI:       'approve_ai_vocab',
  VIEW_REPORTS:     'view_reports',
};

const ROLE_DEFAULTS = {
  owner:   Object.values(PERMISSIONS),
  admin:   ['view_own_leads','view_team_leads','edit_own_leads','edit_team_leads','delete_leads','manage_team','manage_users','view_reports'],
  manager: ['view_own_leads','view_team_leads','edit_own_leads','edit_team_leads','view_reports'],
  sales:   ['view_own_leads','edit_own_leads'],
  viewer:  ['view_own_leads'],
};

function requirePermission(code) {
  return async (req, res, next) => {
    const role = req.teamRole || req.user?.role;
    if (ROLE_DEFAULTS[role]?.includes(code)) return next();
    if (req.dbUser && req.teamId) {
      const custom = await db.getUserPermissions(req.dbUser.id, req.teamId).catch(() => []);
      if (custom.includes(code)) return next();
    }
    res.status(403).json({ error: `Permission required: ${code}` });
  };
}

module.exports = {
  signAccessToken, signToken, verifyAccessToken,
  parseBrowser, parseOS, parseDeviceName, getIP,
  authMiddleware, adminOnly, noGuest,
  teamMemberMiddleware, teamAdminMiddleware,
  requireLeadAccess, requirePermission,
  PERMISSIONS, ROLE_DEFAULTS,
};
