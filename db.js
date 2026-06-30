// ============================================================
//  db.js — PostgreSQL database layer (pg / node-postgres)
// ============================================================
const { Pool } = require('pg');
const crypto   = require('crypto');

// Strip ?sslmode=... from URL — let the ssl object below control it instead,
// otherwise pg v8 treats sslmode=require as verify-full and rejects Aiven's CA.
const _dbUrl = (process.env.DB_URL || '').replace(/([?&])sslmode=[^&]*(&?)/, (_, pre, post) => post ? pre : '');

const pool = new Pool({
  connectionString: _dbUrl,
  ssl: { rejectUnauthorized: false },   // Aiven: encrypted but self-signed CA
  max: 5,
  idleTimeoutMillis: 30000,
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
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id               SERIAL PRIMARY KEY,
        factory_number   TEXT DEFAULT '',
        factory_name     TEXT DEFAULT '',
        person_in_charge TEXT DEFAULT '',
        contact          TEXT DEFAULT '',
        product          TEXT DEFAULT '',
        quantity         TEXT DEFAULT '',
        rate             TEXT DEFAULT '',
        stage            TEXT DEFAULT '',
        follow_up        TEXT DEFAULT '',
        notes            TEXT DEFAULT '',
        area             TEXT DEFAULT '',
        lead_type        TEXT DEFAULT '',
        created_by       TEXT DEFAULT '',
        last_updated     TEXT DEFAULT '',
        mapped_stage     TEXT DEFAULT '',
        stage_number     TEXT DEFAULT '',
        assigned_to      TEXT DEFAULT '',
        lat              TEXT DEFAULT '',
        lng              TEXT DEFAULT ''
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS lead_items (
        id       SERIAL PRIMARY KEY,
        lead_id  INTEGER NOT NULL,
        product  TEXT DEFAULT '',
        quantity TEXT DEFAULT '',
        rate     TEXT DEFAULT ''
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_lead_items_lead_id ON lead_items(lead_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS lead_contacts (
        id          SERIAL PRIMARY KEY,
        lead_id     INTEGER NOT NULL,
        person_name TEXT DEFAULT '',
        contact     TEXT DEFAULT '',
        designation TEXT DEFAULT ''
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_lead_contacts_lead_id ON lead_contacts(lead_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS lead_photos (
        id          SERIAL PRIMARY KEY,
        lead_id     INTEGER NOT NULL,
        file_path   TEXT NOT NULL,
        caption     TEXT DEFAULT '',
        uploaded_by TEXT DEFAULT '',
        uploaded_at TEXT DEFAULT ''
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_lead_photos_lead_id ON lead_photos(lead_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id               SERIAL PRIMARY KEY,
        display_name     TEXT NOT NULL UNIQUE,
        role             TEXT DEFAULT 'sales',
        pin_hash         TEXT NOT NULL,
        telegram_user_id TEXT DEFAULT '' UNIQUE,
        webauthn_cred    TEXT DEFAULT '',
        created_at       TEXT DEFAULT ''
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS lead_access (
        id                SERIAL PRIMARY KEY,
        lead_id           INTEGER NOT NULL,
        user_display_name TEXT NOT NULL,
        granted_by        TEXT DEFAULT '',
        granted_at        TEXT DEFAULT '',
        UNIQUE(lead_id, user_display_name)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_lead_access_lead_id ON lead_access(lead_id)`);

    console.log('✅ PostgreSQL schema ready');
  } finally {
    client.release();
  }
}

// ── READ: all leads with items + contacts ────────────────────
async function getLeads() {
  const { rows } = await pool.query(`
    SELECT
      id AS "rowIndex",
      factory_number, factory_name, person_in_charge, contact,
      product, quantity, rate, stage, follow_up, notes, area,
      lead_type, created_by, assigned_to, last_updated, mapped_stage, stage_number,
      lat, lng
    FROM leads ORDER BY id ASC
  `);

  const { rows: allItems }    = await pool.query(`SELECT * FROM lead_items    ORDER BY lead_id, id ASC`);
  const { rows: allContacts } = await pool.query(`SELECT * FROM lead_contacts ORDER BY lead_id, id ASC`);

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
  const { rows } = await pool.query(`
    SELECT
      id AS "rowIndex",
      factory_number, factory_name, person_in_charge, contact,
      product, quantity, rate, stage, follow_up, notes, area,
      lead_type, created_by, assigned_to, last_updated, mapped_stage, stage_number
    FROM leads
    WHERE created_by = $1
       OR id IN (SELECT lead_id FROM lead_access WHERE user_display_name = $2)
    ORDER BY id ASC
  `, [displayName, displayName]);

  const { rows: allItems }    = await pool.query(`SELECT * FROM lead_items    ORDER BY lead_id, id ASC`);
  const { rows: allContacts } = await pool.query(`SELECT * FROM lead_contacts ORDER BY lead_id, id ASC`);

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

  const { rows: existing } = await pool.query(`SELECT id, factory_number, factory_name FROM leads`);
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

  const { rows: [newRow] } = await pool.query(`
    INSERT INTO leads
      (factory_number, factory_name, person_in_charge, contact, product,
       quantity, rate, stage, follow_up, notes, area, lead_type, created_by,
       last_updated, mapped_stage, stage_number)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    RETURNING id
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

  const leadId = newRow.id;

  if (items.length) {
    for (const item of items) {
      await pool.query(
        `INSERT INTO lead_items (lead_id, product, quantity, rate) VALUES ($1,$2,$3,$4)`,
        [leadId, item.product || '', item.quantity || '', item.rate || '']
      );
    }
  } else if (data.product) {
    await pool.query(
      `INSERT INTO lead_items (lead_id, product, quantity, rate) VALUES ($1,$2,$3,$4)`,
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

  const setClauses = ['last_updated = $1'];
  const params     = [now];
  let   idx        = 2;

  for (const f of fields) {
    if (data[f] !== undefined && data[f] !== null && data[f] !== '') {
      setClauses.push(`${f} = $${idx}`);
      params.push(data[f]);
      idx++;
    }
  }

  if (data.stage) { setClauses.push(`mapped_stage = $${idx}`); params.push(data.stage); idx++; }
  if (data.stage_number !== undefined && data.stage_number !== null && data.stage_number !== '') {
    setClauses.push(`stage_number = $${idx}`); params.push(String(data.stage_number)); idx++;
  }

  params.push(rowIndex);
  await pool.query(`UPDATE leads SET ${setClauses.join(', ')} WHERE id = $${idx}`, params);

  if (Array.isArray(data.items) && data.items.length) {
    await pool.query(`DELETE FROM lead_items WHERE lead_id = $1`, [rowIndex]);
    for (const item of data.items) {
      await pool.query(
        `INSERT INTO lead_items (lead_id, product, quantity, rate) VALUES ($1,$2,$3,$4)`,
        [rowIndex, item.product || '', item.quantity || '', item.rate || '']
      );
    }
    const first = data.items[0];
    await pool.query(
      `UPDATE leads SET product = $1, quantity = $2, rate = $3 WHERE id = $4`,
      [first.product || '', first.quantity || '', first.rate || '', rowIndex]
    );
  }

  if (Array.isArray(data.contacts)) {
    const validContacts = data.contacts.filter(c => c.person_name || c.contact);
    if (validContacts.length) {
      const primary = validContacts[0];
      await pool.query(
        `UPDATE leads SET person_in_charge = $1, contact = $2 WHERE id = $3`,
        [primary.person_name || '', primary.contact || '', rowIndex]
      );
      await pool.query(`DELETE FROM lead_contacts WHERE lead_id = $1`, [rowIndex]);
      for (const c of validContacts.slice(1)) {
        await pool.query(
          `INSERT INTO lead_contacts (lead_id, person_name, contact, designation) VALUES ($1,$2,$3,$4)`,
          [rowIndex, c.person_name || '', c.contact || '', c.designation || '']
        );
      }
    }
  }

  return { ok: true };
}

// ── WRITE: delete a lead ──────────────────────────────────────
async function deleteLead(rowIndex) {
  await pool.query(`DELETE FROM lead_items    WHERE lead_id = $1`, [rowIndex]);
  await pool.query(`DELETE FROM lead_contacts WHERE lead_id = $1`, [rowIndex]);
  await pool.query(`DELETE FROM lead_photos   WHERE lead_id = $1`, [rowIndex]);
  await pool.query(`DELETE FROM lead_access   WHERE lead_id = $1`, [rowIndex]);
  await pool.query(`DELETE FROM leads WHERE id = $1`, [rowIndex]);
  return { ok: true };
}

// ── Photos ────────────────────────────────────────────────────
async function addPhoto(leadId, filePath, caption = '', uploadedBy = '') {
  await pool.query(
    `INSERT INTO lead_photos (lead_id, file_path, caption, uploaded_by, uploaded_at) VALUES ($1,$2,$3,$4,$5)`,
    [leadId, filePath, caption, uploadedBy, nowIST()]
  );
  return { ok: true };
}

async function getPhotos(leadId) {
  const { rows } = await pool.query(`SELECT * FROM lead_photos WHERE lead_id = $1 ORDER BY id ASC`, [leadId]);
  return rows;
}

// ── Lead Access ───────────────────────────────────────────────
async function grantLeadAccess(leadId, userDisplayName, grantedBy = '') {
  try {
    await pool.query(
      `INSERT INTO lead_access (lead_id, user_display_name, granted_by, granted_at)
       VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [leadId, userDisplayName, grantedBy, nowIST()]
    );
    return { ok: true };
  } catch (err) { return { ok: false, message: err.message }; }
}

async function revokeLeadAccess(leadId, userDisplayName) {
  await pool.query(
    `DELETE FROM lead_access WHERE lead_id = $1 AND user_display_name = $2`,
    [leadId, userDisplayName]
  );
  return { ok: true };
}

async function getLeadAccess(leadId) {
  const { rows } = await pool.query(
    `SELECT user_display_name, granted_by, granted_at FROM lead_access WHERE lead_id = $1`,
    [leadId]
  );
  return rows;
}

async function claimFollowUp(leadId, claimerName) {
  const { rows } = await pool.query(`SELECT assigned_to FROM leads WHERE id = $1`, [leadId]);
  if (!rows.length) return { ok: false, message: 'Lead not found' };
  const lead = rows[0];
  if (lead.assigned_to) return { ok: false, alreadyClaimed: true, claimedBy: lead.assigned_to };
  const result = await pool.query(
    `UPDATE leads SET assigned_to = $1, last_updated = $2
     WHERE id = $3 AND (assigned_to = '' OR assigned_to IS NULL)`,
    [claimerName, nowIST(), leadId]
  );
  if (result.rowCount > 0) return { ok: true };
  const { rows: updated } = await pool.query(`SELECT assigned_to FROM leads WHERE id = $1`, [leadId]);
  return { ok: false, alreadyClaimed: true, claimedBy: (updated[0] && updated[0].assigned_to) || '' };
}

async function reassignFollowUp(leadId, newAssigneeName) {
  const { rows } = await pool.query(`SELECT assigned_to FROM leads WHERE id = $1`, [leadId]);
  if (!rows.length) return { ok: false, message: 'Lead not found' };
  await pool.query(
    `UPDATE leads SET assigned_to = $1, last_updated = $2 WHERE id = $3`,
    [newAssigneeName, nowIST(), leadId]
  );
  return { ok: true, previous: rows[0].assigned_to };
}

// ── Users ─────────────────────────────────────────────────────
async function createUser(displayName, pin, role = 'sales', telegramUserId = '') {
  const { rows: existing } = await pool.query(`SELECT id FROM users WHERE display_name = $1`, [displayName]);
  if (existing.length) return { ok: false, message: 'Name already taken. Choose another name.' };
  await pool.query(
    `INSERT INTO users (display_name, role, pin_hash, telegram_user_id, created_at) VALUES ($1,$2,$3,$4,$5)`,
    [displayName, role, hashPin(pin), telegramUserId || '', nowIST()]
  );
  return { ok: true };
}

async function getUserByName(displayName) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE display_name = $1`, [displayName]);
  return rows[0] || null;
}

async function getUserByTelegramId(telegramUserId) {
  if (!telegramUserId) return null;
  const { rows } = await pool.query(`SELECT * FROM users WHERE telegram_user_id = $1`, [String(telegramUserId)]);
  return rows[0] || null;
}

async function updateUserPin(userId, newPin) {
  await pool.query(`UPDATE users SET pin_hash = $1 WHERE id = $2`, [hashPin(newPin), userId]);
  return { ok: true };
}

async function getAllUsers() {
  const { rows } = await pool.query(
    `SELECT id, display_name, role, telegram_user_id, created_at FROM users ORDER BY id ASC`
  );
  return rows;
}

async function deleteUser(userId) {
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
  return { ok: true };
}

async function verifyUserPin(displayName, pin) {
  const user = await getUserByName(displayName);
  if (!user) return null;
  if (user.pin_hash !== hashPin(pin)) return null;
  return user;
}

async function updateUserName(userId, newName) {
  const { rows: existing } = await pool.query(
    `SELECT id FROM users WHERE display_name = $1 AND id != $2`, [newName, userId]
  );
  if (existing.length) return { ok: false, message: 'Name already taken. Choose another.' };
  await pool.query(`UPDATE users SET display_name = $1 WHERE id = $2`, [newName, userId]);
  return { ok: true };
}

// ── Factory coordinates ───────────────────────────────────────
async function getLeadCoordinates(ids) {
  if (!ids || !ids.length) return [];
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await pool.query(
    `SELECT id, factory_number, factory_name, person_in_charge, lat, lng
     FROM leads WHERE id IN (${placeholders})`,
    ids.map(Number)
  );
  return rows;
}

async function updateLeadCoords(rowIndex, lat, lng) {
  await pool.query(`UPDATE leads SET lat = $1, lng = $2 WHERE id = $3`, [String(lat), String(lng), Number(rowIndex)]);
  return { ok: true };
}

// ── WebAuthn ──────────────────────────────────────────────────
async function saveWebAuthnCred(userId, credData) {
  await pool.query(`UPDATE users SET webauthn_cred = $1 WHERE id = $2`, [JSON.stringify(credData), userId]);
  return { ok: true };
}

async function getWebAuthnCred(userId) {
  const { rows } = await pool.query(`SELECT webauthn_cred FROM users WHERE id = $1`, [userId]);
  if (!rows.length || !rows[0].webauthn_cred) return null;
  try { return JSON.parse(rows[0].webauthn_cred); } catch { return null; }
}

async function getUserByWebAuthnCredId(credentialID) {
  const { rows } = await pool.query(
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
  const { rows: existing } = await pool.query(`SELECT id FROM users WHERE role = 'admin'`);
  if (!existing.length) {
    await pool.query(
      `INSERT INTO users (display_name, role, pin_hash, telegram_user_id, created_at) VALUES ($1,'admin',$2,'',$3)`,
      [adminUser, hashPin(adminPass), nowIST()]
    );
    console.log(`✅ Admin user "${adminUser}" created`);
  }
}

async function getLeadContacts(leadId) {
  const { rows } = await pool.query(
    `SELECT * FROM lead_contacts WHERE lead_id = $1 ORDER BY id ASC`, [leadId]
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
