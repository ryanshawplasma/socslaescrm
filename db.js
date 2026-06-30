// ============================================================
//  db.js — MySQL database layer (mysql2/promise)
// ============================================================
const mysql  = require('mysql2/promise');
const crypto = require('crypto');

const pool = mysql.createPool({
  uri:              process.env.DB_URL,
  ssl:              { rejectUnauthorized: true },
  connectionLimit:  5,
  waitForConnections: true,
  timezone:         '+00:00',
});

// ── Helpers ─────────────────────────────────────────────────
function nowIST() {
  return new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).replace(',', '');
}

function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

// ── Schema init ──────────────────────────────────────────────
async function initSchema() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        factory_number   VARCHAR(255) DEFAULT '',
        factory_name     VARCHAR(255) DEFAULT '',
        person_in_charge VARCHAR(255) DEFAULT '',
        contact          VARCHAR(255) DEFAULT '',
        product          VARCHAR(255) DEFAULT '',
        quantity         VARCHAR(255) DEFAULT '',
        rate             VARCHAR(255) DEFAULT '',
        stage            VARCHAR(255) DEFAULT '',
        follow_up        VARCHAR(255) DEFAULT '',
        notes            TEXT         DEFAULT '',
        area             VARCHAR(255) DEFAULT '',
        lead_type        VARCHAR(255) DEFAULT '',
        created_by       VARCHAR(255) DEFAULT '',
        last_updated     VARCHAR(255) DEFAULT '',
        mapped_stage     VARCHAR(255) DEFAULT '',
        stage_number     VARCHAR(50)  DEFAULT '',
        assigned_to      VARCHAR(255) DEFAULT '',
        lat              VARCHAR(50)  DEFAULT '',
        lng              VARCHAR(50)  DEFAULT ''
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS lead_items (
        id       INT AUTO_INCREMENT PRIMARY KEY,
        lead_id  INT NOT NULL,
        product  VARCHAR(255) DEFAULT '',
        quantity VARCHAR(255) DEFAULT '',
        rate     VARCHAR(255) DEFAULT '',
        INDEX idx_lead_items_lead_id (lead_id)
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS lead_contacts (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        lead_id     INT NOT NULL,
        person_name VARCHAR(255) DEFAULT '',
        contact     VARCHAR(255) DEFAULT '',
        designation VARCHAR(255) DEFAULT '',
        INDEX idx_lead_contacts_lead_id (lead_id)
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS lead_photos (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        lead_id     INT NOT NULL,
        file_path   TEXT NOT NULL,
        caption     TEXT DEFAULT '',
        uploaded_by VARCHAR(255) DEFAULT '',
        uploaded_at VARCHAR(255) DEFAULT '',
        INDEX idx_lead_photos_lead_id (lead_id)
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id               INT AUTO_INCREMENT PRIMARY KEY,
        display_name     VARCHAR(255) NOT NULL,
        role             VARCHAR(50)  DEFAULT 'sales',
        pin_hash         VARCHAR(255) NOT NULL,
        telegram_user_id VARCHAR(255) DEFAULT '',
        webauthn_cred    TEXT         DEFAULT '',
        created_at       VARCHAR(255) DEFAULT '',
        UNIQUE KEY uq_display_name (display_name),
        UNIQUE KEY uq_telegram_user_id (telegram_user_id)
      )
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS lead_access (
        id                INT AUTO_INCREMENT PRIMARY KEY,
        lead_id           INT NOT NULL,
        user_display_name VARCHAR(255) NOT NULL,
        granted_by        VARCHAR(255) DEFAULT '',
        granted_at        VARCHAR(255) DEFAULT '',
        UNIQUE KEY uq_lead_access (lead_id, user_display_name),
        INDEX idx_lead_access_lead_id (lead_id)
      )
    `);

    console.log('✅ MySQL schema ready');
  } finally {
    conn.release();
  }
}

// ── READ: all leads with items + contacts ────────────────────
async function getLeads() {
  const [rows] = await pool.execute(`
    SELECT
      id AS rowIndex,
      factory_number, factory_name, person_in_charge, contact,
      product, quantity, rate, stage, follow_up, notes, area,
      lead_type, created_by, assigned_to, last_updated, mapped_stage, stage_number,
      lat, lng
    FROM leads ORDER BY id ASC
  `);

  const [allItems]    = await pool.execute(`SELECT * FROM lead_items    ORDER BY lead_id, id ASC`);
  const [allContacts] = await pool.execute(`SELECT * FROM lead_contacts ORDER BY lead_id, id ASC`);

  const itemsByLead = {};
  for (const item of allItems) {
    if (!itemsByLead[item.lead_id]) itemsByLead[item.lead_id] = [];
    itemsByLead[item.lead_id].push({ product: item.product || '', quantity: item.quantity || '', rate: item.rate || '' });
  }

  const extraContactsByLead = {};
  for (const c of allContacts) {
    if (!extraContactsByLead[c.lead_id]) extraContactsByLead[c.lead_id] = [];
    extraContactsByLead[c.lead_id].push({ id: c.id, person_name: c.person_name || '', contact: c.contact || '', designation: c.designation || '' });
  }

  return rows.map(r => {
    const out = {};
    for (const [k, v] of Object.entries(r)) out[k] = v == null ? '' : String(v);
    out.items = itemsByLead[r.rowIndex] || [];
    const extras = extraContactsByLead[r.rowIndex] || [];
    out.contacts = [
      { id: 'primary', person_name: out.person_in_charge || '', contact: out.contact || '', designation: '' },
      ...extras,
    ];
    return out;
  });
}

// ── READ: leads for a specific salesperson ────────────────────
async function getLeadsForUser(displayName) {
  const [rows] = await pool.execute(`
    SELECT
      id AS rowIndex,
      factory_number, factory_name, person_in_charge, contact,
      product, quantity, rate, stage, follow_up, notes, area,
      lead_type, created_by, assigned_to, last_updated, mapped_stage, stage_number
    FROM leads
    WHERE created_by = ?
       OR id IN (SELECT lead_id FROM lead_access WHERE user_display_name = ?)
    ORDER BY id ASC
  `, [displayName, displayName]);

  const [allItems]    = await pool.execute(`SELECT * FROM lead_items    ORDER BY lead_id, id ASC`);
  const [allContacts] = await pool.execute(`SELECT * FROM lead_contacts ORDER BY lead_id, id ASC`);

  const itemsByLead = {};
  for (const item of allItems) {
    if (!itemsByLead[item.lead_id]) itemsByLead[item.lead_id] = [];
    itemsByLead[item.lead_id].push({ product: item.product || '', quantity: item.quantity || '', rate: item.rate || '' });
  }

  const extraContactsByLead = {};
  for (const c of allContacts) {
    if (!extraContactsByLead[c.lead_id]) extraContactsByLead[c.lead_id] = [];
    extraContactsByLead[c.lead_id].push({ id: c.id, person_name: c.person_name || '', contact: c.contact || '', designation: c.designation || '' });
  }

  return rows.map(r => {
    const out = {};
    for (const [k, v] of Object.entries(r)) out[k] = v == null ? '' : String(v);
    out.items = itemsByLead[r.rowIndex] || [];
    const extras = extraContactsByLead[r.rowIndex] || [];
    out.contacts = [
      { id: 'primary', person_name: out.person_in_charge || '', contact: out.contact || '', designation: '' },
      ...extras,
    ];
    return out;
  });
}

// ── READ: aggregate stats ─────────────────────────────────────
async function getStats() {
  const leads = await getLeads();
  const byStage = {}, byProduct = {}, byProductRevenue = {};
  let won = 0, lost = 0;

  for (const l of leads) {
    const s = l.stage || 'Unknown';
    byStage[s] = (byStage[s] || 0) + 1;

    const items = l.items && l.items.length
      ? l.items
      : [{ product: l.product, quantity: l.quantity, rate: l.rate }];

    for (const item of items) {
      const p    = item.product || 'Unknown';
      const qty  = parseFloat(item.quantity) || 0;
      const rate = parseFloat(item.rate)     || 0;
      byProduct[p]        = (byProduct[p]        || 0) + 1;
      byProductRevenue[p] = (byProductRevenue[p] || 0) + qty * rate;
    }

    if (l.stage_number === '6' || l.stage_number === '7') won++;
    if (l.stage_number === '0') lost++;
  }

  return {
    total: leads.length, active: leads.length - won - lost,
    won, lost,
    by_stage:           byStage,
    by_product:         byProduct,
    by_product_revenue: byProductRevenue,
  };
}

// ── WRITE: add a new lead ─────────────────────────────────────
async function addLead(data, createdBy = '') {
  const pNum  = String(data.factory_number || '').trim().toLowerCase();
  const pName = String(data.factory_name   || '').trim().toLowerCase();

  const [existing] = await pool.execute(`SELECT id, factory_number, factory_name FROM leads`);
  for (const row of existing) {
    const rNum  = String(row.factory_number || '').trim().toLowerCase();
    const rName = String(row.factory_name   || '').trim().toLowerCase();
    if (pNum && rNum && pNum === rNum)
      return { ok: false, conflict: true, rowIndex: row.id, message: 'Factory number already exists' };
    if (!pNum && pName && rName && pName === rName)
      return { ok: false, conflict: true, rowIndex: row.id, message: 'Factory name already exists' };
  }

  const now   = nowIST();
  const items = Array.isArray(data.items) && data.items.length ? data.items : [];
  const flat  = items.length ? items[0] : data;

  const [info] = await pool.execute(`
    INSERT INTO leads
      (factory_number, factory_name, person_in_charge, contact, product,
       quantity, rate, stage, follow_up, notes, area, lead_type, created_by,
       last_updated, mapped_stage, stage_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    data.factory_number   || '',
    data.factory_name     || '',
    data.person_in_charge || '',
    data.contact          || '',
    flat.product          || '',
    flat.quantity         || '',
    flat.rate             || '',
    data.stage            || '',
    data.follow_up        || '',
    data.notes            || '',
    data.area             || '',
    data.lead_type        || '',
    createdBy || data.created_by || '',
    now,
    data.stage            || '',
    data.stage_number != null ? String(data.stage_number) : '',
  ]);

  const leadId = info.insertId;

  if (items.length) {
    for (const item of items) {
      await pool.execute(
        `INSERT INTO lead_items (lead_id, product, quantity, rate) VALUES (?, ?, ?, ?)`,
        [leadId, item.product || '', item.quantity || '', item.rate || '']
      );
    }
  } else if (data.product) {
    await pool.execute(
      `INSERT INTO lead_items (lead_id, product, quantity, rate) VALUES (?, ?, ?, ?)`,
      [leadId, data.product || '', data.quantity || '', data.rate || '']
    );
  }

  return { ok: true, rowIndex: leadId };
}

// ── WRITE: update an existing lead ───────────────────────────
async function updateLead(rowIndex, data) {
  const now = nowIST();

  const fields = [
    'factory_number', 'factory_name', 'person_in_charge', 'contact',
    'product', 'quantity', 'rate', 'stage', 'follow_up', 'notes', 'area',
    'lead_type', 'created_by',
  ];

  const setClauses = ['last_updated = ?'];
  const params     = [now];

  for (const f of fields) {
    if (data[f] !== undefined && data[f] !== null && data[f] !== '') {
      setClauses.push(`${f} = ?`);
      params.push(data[f]);
    }
  }

  if (data.stage) { setClauses.push('mapped_stage = ?'); params.push(data.stage); }
  if (data.stage_number !== undefined && data.stage_number !== null && data.stage_number !== '') {
    setClauses.push('stage_number = ?');
    params.push(String(data.stage_number));
  }

  params.push(rowIndex);
  await pool.execute(`UPDATE leads SET ${setClauses.join(', ')} WHERE id = ?`, params);

  if (Array.isArray(data.items) && data.items.length) {
    await pool.execute(`DELETE FROM lead_items WHERE lead_id = ?`, [rowIndex]);
    for (const item of data.items) {
      await pool.execute(
        `INSERT INTO lead_items (lead_id, product, quantity, rate) VALUES (?, ?, ?, ?)`,
        [rowIndex, item.product || '', item.quantity || '', item.rate || '']
      );
    }
    const first = data.items[0];
    await pool.execute(
      `UPDATE leads SET product = ?, quantity = ?, rate = ? WHERE id = ?`,
      [first.product || '', first.quantity || '', first.rate || '', rowIndex]
    );
  }

  if (Array.isArray(data.contacts)) {
    const validContacts = data.contacts.filter(c => c.person_name || c.contact);
    if (validContacts.length) {
      const primary = validContacts[0];
      await pool.execute(
        `UPDATE leads SET person_in_charge = ?, contact = ? WHERE id = ?`,
        [primary.person_name || '', primary.contact || '', rowIndex]
      );
      await pool.execute(`DELETE FROM lead_contacts WHERE lead_id = ?`, [rowIndex]);
      for (const c of validContacts.slice(1)) {
        await pool.execute(
          `INSERT INTO lead_contacts (lead_id, person_name, contact, designation) VALUES (?, ?, ?, ?)`,
          [rowIndex, c.person_name || '', c.contact || '', c.designation || '']
        );
      }
    }
  }

  return { ok: true };
}

// ── WRITE: delete a lead ──────────────────────────────────────
async function deleteLead(rowIndex) {
  await pool.execute(`DELETE FROM lead_items    WHERE lead_id = ?`, [rowIndex]);
  await pool.execute(`DELETE FROM lead_contacts WHERE lead_id = ?`, [rowIndex]);
  await pool.execute(`DELETE FROM lead_photos   WHERE lead_id = ?`, [rowIndex]);
  await pool.execute(`DELETE FROM lead_access   WHERE lead_id = ?`, [rowIndex]);
  await pool.execute(`DELETE FROM leads WHERE id = ?`, [rowIndex]);
  return { ok: true };
}

// ── Photos ────────────────────────────────────────────────────
async function addPhoto(leadId, filePath, caption = '', uploadedBy = '') {
  await pool.execute(
    `INSERT INTO lead_photos (lead_id, file_path, caption, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?)`,
    [leadId, filePath, caption, uploadedBy, nowIST()]
  );
  return { ok: true };
}

async function getPhotos(leadId) {
  const [rows] = await pool.execute(`SELECT * FROM lead_photos WHERE lead_id = ? ORDER BY id ASC`, [leadId]);
  return rows;
}

// ── Lead Access ───────────────────────────────────────────────
async function grantLeadAccess(leadId, userDisplayName, grantedBy = '') {
  try {
    await pool.execute(
      `INSERT IGNORE INTO lead_access (lead_id, user_display_name, granted_by, granted_at) VALUES (?, ?, ?, ?)`,
      [leadId, userDisplayName, grantedBy, nowIST()]
    );
    return { ok: true };
  } catch (err) { return { ok: false, message: err.message }; }
}

async function revokeLeadAccess(leadId, userDisplayName) {
  await pool.execute(
    `DELETE FROM lead_access WHERE lead_id = ? AND user_display_name = ?`,
    [leadId, userDisplayName]
  );
  return { ok: true };
}

async function getLeadAccess(leadId) {
  const [rows] = await pool.execute(
    `SELECT user_display_name, granted_by, granted_at FROM lead_access WHERE lead_id = ?`,
    [leadId]
  );
  return rows;
}

async function claimFollowUp(leadId, claimerName) {
  const [rows] = await pool.execute(`SELECT assigned_to FROM leads WHERE id = ?`, [leadId]);
  if (!rows.length) return { ok: false, message: 'Lead not found' };
  const lead = rows[0];
  if (lead.assigned_to) return { ok: false, alreadyClaimed: true, claimedBy: lead.assigned_to };
  const [info] = await pool.execute(
    `UPDATE leads SET assigned_to = ?, last_updated = ? WHERE id = ? AND (assigned_to = '' OR assigned_to IS NULL)`,
    [claimerName, nowIST(), leadId]
  );
  if (info.affectedRows > 0) return { ok: true };
  const [updated] = await pool.execute(`SELECT assigned_to FROM leads WHERE id = ?`, [leadId]);
  return { ok: false, alreadyClaimed: true, claimedBy: (updated[0] && updated[0].assigned_to) || '' };
}

async function reassignFollowUp(leadId, newAssigneeName) {
  const [rows] = await pool.execute(`SELECT assigned_to FROM leads WHERE id = ?`, [leadId]);
  if (!rows.length) return { ok: false, message: 'Lead not found' };
  await pool.execute(
    `UPDATE leads SET assigned_to = ?, last_updated = ? WHERE id = ?`,
    [newAssigneeName, nowIST(), leadId]
  );
  return { ok: true, previous: rows[0].assigned_to };
}

// ── Users ─────────────────────────────────────────────────────
async function createUser(displayName, pin, role = 'sales', telegramUserId = '') {
  const [existing] = await pool.execute(`SELECT id FROM users WHERE display_name = ?`, [displayName]);
  if (existing.length) return { ok: false, message: 'Name already taken. Choose another name.' };
  await pool.execute(
    `INSERT INTO users (display_name, role, pin_hash, telegram_user_id, created_at) VALUES (?, ?, ?, ?, ?)`,
    [displayName, role, hashPin(pin), telegramUserId || '', nowIST()]
  );
  return { ok: true };
}

async function getUserByName(displayName) {
  const [rows] = await pool.execute(`SELECT * FROM users WHERE display_name = ?`, [displayName]);
  return rows[0] || null;
}

async function getUserByTelegramId(telegramUserId) {
  if (!telegramUserId) return null;
  const [rows] = await pool.execute(`SELECT * FROM users WHERE telegram_user_id = ?`, [String(telegramUserId)]);
  return rows[0] || null;
}

async function updateUserPin(userId, newPin) {
  await pool.execute(`UPDATE users SET pin_hash = ? WHERE id = ?`, [hashPin(newPin), userId]);
  return { ok: true };
}

async function getAllUsers() {
  const [rows] = await pool.execute(
    `SELECT id, display_name, role, telegram_user_id, created_at FROM users ORDER BY id ASC`
  );
  return rows;
}

async function deleteUser(userId) {
  await pool.execute(`DELETE FROM users WHERE id = ?`, [userId]);
  return { ok: true };
}

async function verifyUserPin(displayName, pin) {
  const user = await getUserByName(displayName);
  if (!user) return null;
  if (user.pin_hash !== hashPin(pin)) return null;
  return user;
}

async function updateUserName(userId, newName) {
  const [existing] = await pool.execute(
    `SELECT id FROM users WHERE display_name = ? AND id != ?`, [newName, userId]
  );
  if (existing.length) return { ok: false, message: 'Name already taken. Choose another.' };
  await pool.execute(`UPDATE users SET display_name = ? WHERE id = ?`, [newName, userId]);
  return { ok: true };
}

// ── Factory coordinates ───────────────────────────────────────
async function getLeadCoordinates(ids) {
  if (!ids || !ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const [rows] = await pool.execute(
    `SELECT id, factory_number, factory_name, person_in_charge, lat, lng
     FROM leads WHERE id IN (${placeholders})`,
    ids.map(Number)
  );
  return rows;
}

async function updateLeadCoords(rowIndex, lat, lng) {
  await pool.execute(`UPDATE leads SET lat = ?, lng = ? WHERE id = ?`, [String(lat), String(lng), Number(rowIndex)]);
  return { ok: true };
}

// ── WebAuthn ──────────────────────────────────────────────────
async function saveWebAuthnCred(userId, credData) {
  await pool.execute(`UPDATE users SET webauthn_cred = ? WHERE id = ?`, [JSON.stringify(credData), userId]);
  return { ok: true };
}

async function getWebAuthnCred(userId) {
  const [rows] = await pool.execute(`SELECT webauthn_cred FROM users WHERE id = ?`, [userId]);
  if (!rows.length || !rows[0].webauthn_cred) return null;
  try { return JSON.parse(rows[0].webauthn_cred); } catch { return null; }
}

async function getUserByWebAuthnCredId(credentialID) {
  const [rows] = await pool.execute(
    `SELECT * FROM users WHERE webauthn_cred != '' AND webauthn_cred IS NOT NULL`
  );
  for (const user of rows) {
    try {
      const cred = JSON.parse(user.webauthn_cred);
      if (cred && cred.credentialID === credentialID) return user;
    } catch (_) {}
  }
  return null;
}

async function seedAdminUser(adminUser, adminPass) {
  const [existing] = await pool.execute(`SELECT id FROM users WHERE role = 'admin'`);
  if (!existing.length) {
    await pool.execute(
      `INSERT INTO users (display_name, role, pin_hash, telegram_user_id, created_at) VALUES (?, 'admin', ?, '', ?)`,
      [adminUser, hashPin(adminPass), nowIST()]
    );
    console.log(`✅ Admin user "${adminUser}" created in users table`);
  }
}

async function getLeadContacts(leadId) {
  const [rows] = await pool.execute(
    `SELECT * FROM lead_contacts WHERE lead_id = ? ORDER BY id ASC`, [leadId]
  );
  return rows;
}

module.exports = {
  initSchema,
  getLeads, getLeadsForUser, getStats, addLead, updateLead, deleteLead,
  addPhoto, getPhotos, getLeadContacts,
  grantLeadAccess, revokeLeadAccess, getLeadAccess, claimFollowUp, reassignFollowUp,
  createUser, getUserByName, getUserByTelegramId, updateUserPin, updateUserName,
  getAllUsers, deleteUser, verifyUserPin, seedAdminUser,
  saveWebAuthnCred, getWebAuthnCred, getUserByWebAuthnCredId,
  getLeadCoordinates, updateLeadCoords,
};
