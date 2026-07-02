// ============================================================
//  db.js — PostgreSQL database layer (pg / node-postgres)
// ============================================================
const { Pool } = require('pg');
const crypto   = require('crypto');

// pg v8.13+ changed SSL: sslmode=require now maps to verify-full unless uselibpqcompat is set.
// Strip original sslmode, then add uselibpqcompat=true&sslmode=require so pg uses libpq
// semantics where 'require' = encrypt only, no cert chain verification (needed for Aiven).
let _dbUrl = (process.env.DB_URL || '').replace(/([?&])sslmode=[^&]*(&?)/g, (_, pre, post) => post ? pre : '');
_dbUrl += (_dbUrl.includes('?') ? '&' : '?') + 'uselibpqcompat=true&sslmode=require';

const pool = new Pool({
  connectionString: _dbUrl,
  ssl: { rejectUnauthorized: false },
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

// ── Helpers ─────────────────────────────────────────────────
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

function sha256(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex');
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
        telegram_user_id TEXT DEFAULT NULL,
        webauthn_cred    TEXT DEFAULT '',
        created_at       TEXT DEFAULT ''
      )
    `);
    // Migration: drop the UNIQUE constraint on telegram_user_id so multiple
    // web-registered users (who have no Telegram ID) can coexist.
    // PostgreSQL auto-names the constraint <table>_<col>_key.
    await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_telegram_user_id_key`).catch(() => {});
    // Convert any empty-string telegram_user_id to NULL so the partial index works
    await client.query(`UPDATE users SET telegram_user_id = NULL WHERE telegram_user_id = ''`).catch(() => {});
    // Partial unique index: only enforce uniqueness for real (non-null) Telegram IDs
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_users_telegram_id
      ON users(telegram_user_id)
      WHERE telegram_user_id IS NOT NULL
    `).catch(() => {});

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

    // ── Team Workspace tables ──────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id            SERIAL PRIMARY KEY,
        name          TEXT NOT NULL,
        handle        TEXT UNIQUE NOT NULL,
        team_code     TEXT UNIQUE NOT NULL,
        owner_id      INTEGER REFERENCES users(id),
        invite_code   TEXT UNIQUE,
        public_search BOOLEAN DEFAULT true,
        auto_approve  BOOLEAN DEFAULT false,
        created_at    TEXT
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_teams_handle   ON teams(LOWER(handle))`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_teams_code     ON teams(team_code)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS team_members (
        id        SERIAL PRIMARY KEY,
        team_id   INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        role      TEXT NOT NULL DEFAULT 'sales',
        status    TEXT NOT NULL DEFAULT 'active',
        joined_at TEXT,
        UNIQUE(team_id, user_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS team_invitations (
        id         SERIAL PRIMARY KEY,
        team_id    INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        code       TEXT UNIQUE NOT NULL,
        created_by INTEGER REFERENCES users(id),
        expires_at TEXT,
        max_uses   INTEGER,
        use_count  INTEGER DEFAULT 0,
        created_at TEXT
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS join_requests (
        id          SERIAL PRIMARY KEY,
        team_id     INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        status      TEXT DEFAULT 'pending',
        message     TEXT DEFAULT '',
        reviewed_by INTEGER REFERENCES users(id),
        created_at  TEXT,
        updated_at  TEXT,
        UNIQUE(team_id, user_id)
      )
    `);

    // Add team context columns to leads (safe – idempotent)
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS team_id     INTEGER REFERENCES teams(id)`).catch(() => {});
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS visibility  TEXT DEFAULT 'team'`).catch(() => {});
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS designation TEXT DEFAULT ''`).catch(() => {});

    // ── Auth system tables ─────────────────────────────────────
    // Extend users with email, mobile, lockout fields
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`).catch(() => {});
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile TEXT`).catch(() => {});
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_attempts SMALLINT DEFAULT 0`).catch(() => {});
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ`).catch(() => {});
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`).catch(() => {});

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email
      ON users(LOWER(email)) WHERE email IS NOT NULL AND email != ''
    `).catch(() => {});
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_users_mobile
      ON users(mobile) WHERE mobile IS NOT NULL AND mobile != ''
    `).catch(() => {});

    // Sessions: one row per active login (any device)
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id             TEXT PRIMARY KEY,
        user_id        INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id      TEXT,
        ip_address     TEXT DEFAULT '',
        user_agent     TEXT DEFAULT '',
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        last_active_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at     TIMESTAMPTZ NOT NULL,
        revoked        BOOLEAN DEFAULT FALSE
      )
    `).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id) WHERE NOT revoked`).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at)`).catch(() => {});

    // Refresh tokens: rotated on every use, family-based reuse detection
    await client.query(`
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        id          TEXT PRIMARY KEY,
        session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        token_hash  TEXT NOT NULL UNIQUE,
        family      TEXT NOT NULL,
        used        BOOLEAN DEFAULT FALSE,
        issued_at   TIMESTAMPTZ DEFAULT NOW(),
        expires_at  TIMESTAMPTZ NOT NULL
      )
    `).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rt_family ON refresh_tokens(family)`).catch(() => {});

    // Trusted devices: "remember me" devices
    await client.query(`
      CREATE TABLE IF NOT EXISTS trusted_devices (
        id               TEXT PRIMARY KEY,
        user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_name      TEXT DEFAULT 'Unknown Device',
        browser          TEXT DEFAULT '',
        os               TEXT DEFAULT '',
        device_type      TEXT DEFAULT 'unknown',
        fingerprint_hash TEXT NOT NULL,
        ip_address       TEXT DEFAULT '',
        trusted_at       TIMESTAMPTZ DEFAULT NOW(),
        last_active_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_td_user ON trusted_devices(user_id)`).catch(() => {});
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_td_fingerprint
      ON trusted_devices(user_id, fingerprint_hash)
    `).catch(() => {});

    // Device PINs: quick unlock PIN per (user, device)
    await client.query(`
      CREATE TABLE IF NOT EXISTS device_pins (
        id              TEXT PRIMARY KEY,
        user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        device_id       TEXT NOT NULL REFERENCES trusted_devices(id) ON DELETE CASCADE,
        pin_hash        TEXT NOT NULL,
        failed_attempts SMALLINT DEFAULT 0,
        locked_until    TIMESTAMPTZ,
        created_at      TIMESTAMPTZ DEFAULT NOW(),
        updated_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, device_id)
      )
    `).catch(() => {});

    // Security audit log
    await client.query(`
      CREATE TABLE IF NOT EXISTS security_logs (
        id         BIGSERIAL PRIMARY KEY,
        user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
        event      TEXT NOT NULL,
        detail     TEXT DEFAULT '{}',
        ip_address TEXT DEFAULT '',
        user_agent TEXT DEFAULT '',
        session_id TEXT,
        device_id  TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sl_user ON security_logs(user_id, created_at DESC) WHERE user_id IS NOT NULL`).catch(() => {});

    // ── AI Entry Mode tables ───────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_vocab (
        id         SERIAL PRIMARY KEY,
        team_id    INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        alias      TEXT NOT NULL,
        canonical  TEXT NOT NULL,
        created_by TEXT DEFAULT '',
        created_at TEXT DEFAULT ''
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ai_vocab_team ON ai_vocab(team_id)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_audit_log (
        id          BIGSERIAL PRIMARY KEY,
        lead_id     INTEGER REFERENCES leads(id) ON DELETE SET NULL,
        action      TEXT NOT NULL,
        input_type  TEXT DEFAULT 'text',
        raw_input   TEXT DEFAULT '',
        parsed_json TEXT DEFAULT '{}',
        saved_by    TEXT DEFAULT '',
        team_id     INTEGER REFERENCES teams(id) ON DELETE SET NULL,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});

    // ── New: Departments (sub-teams within workspace) ──────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS departments (
        id           SERIAL PRIMARY KEY,
        team_id      INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        name         TEXT NOT NULL,
        description  TEXT DEFAULT '',
        manager_id   INTEGER REFERENCES users(id),
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        archived_at  TIMESTAMPTZ,
        UNIQUE(team_id, name)
      )
    `).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_departments_team ON departments(team_id)`).catch(() => {});

    await client.query(`
      CREATE TABLE IF NOT EXISTS department_members (
        id            SERIAL PRIMARY KEY,
        department_id INTEGER REFERENCES departments(id) ON DELETE CASCADE,
        user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
        joined_at     TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(department_id, user_id)
      )
    `).catch(() => {});

    // ── New: Granular permissions ──────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_permissions (
        id              SERIAL PRIMARY KEY,
        user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
        team_id         INTEGER REFERENCES teams(id) ON DELETE CASCADE,
        permission_code TEXT NOT NULL,
        granted_by      INTEGER REFERENCES users(id),
        granted_at      TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, team_id, permission_code)
      )
    `).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_user_perms ON user_permissions(user_id, team_id)`).catch(() => {});

    // ── New: Lead activity timeline ────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS lead_activities (
        id            BIGSERIAL PRIMARY KEY,
        lead_id       INTEGER REFERENCES leads(id) ON DELETE CASCADE,
        team_id       INTEGER,
        activity_type TEXT NOT NULL,
        description   TEXT DEFAULT '',
        metadata      JSONB DEFAULT '{}',
        performed_by  TEXT NOT NULL,
        created_at    TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_lead_activities_lead ON lead_activities(lead_id, created_at DESC)`).catch(() => {});

    // ── New: Field-level edit history ──────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS lead_history (
        id          BIGSERIAL PRIMARY KEY,
        lead_id     INTEGER REFERENCES leads(id) ON DELETE CASCADE,
        changed_by  TEXT NOT NULL,
        changed_at  TIMESTAMPTZ DEFAULT NOW(),
        field_name  TEXT NOT NULL,
        old_value   TEXT DEFAULT '',
        new_value   TEXT DEFAULT '',
        team_id     INTEGER
      )
    `).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_lead_history_lead ON lead_history(lead_id, changed_at DESC)`).catch(() => {});

    // ── New: Personal vocabulary (per-user AI aliases) ─────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS personal_vocab (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
        alias      TEXT NOT NULL,
        canonical  TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, alias)
      )
    `).catch(() => {});

    // ── New: AI corrections (learning engine) ──────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_corrections (
        id              SERIAL PRIMARY KEY,
        session_id      TEXT DEFAULT '',
        field_name      TEXT DEFAULT '',
        original_value  TEXT DEFAULT '',
        corrected_value TEXT DEFAULT '',
        raw_input       TEXT DEFAULT '',
        user_id         INTEGER REFERENCES users(id),
        team_id         INTEGER,
        created_at      TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(() => {});
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ai_corrections_team ON ai_corrections(team_id, created_at DESC)`).catch(() => {});

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
      factory_number, factory_name, person_in_charge, contact, designation,
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
      { id: 'primary', person_name: out.person_in_charge || '', contact: out.contact || '', designation: out.designation || '' },
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
      factory_number, factory_name, person_in_charge, contact, designation,
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
      { id: 'primary', person_name: out.person_in_charge || '', contact: out.contact || '', designation: out.designation || '' },
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

  // Resolve primary contact: prefer top-level fields, fall back to contacts[0]
  const primaryContact = (Array.isArray(data.contacts) && data.contacts.length)
    ? data.contacts[0] : null;
  const personInCharge = data.person_in_charge || (primaryContact && primaryContact.person_name) || '';
  const contactNum     = data.contact          || (primaryContact && primaryContact.contact)     || '';
  const designation    = data.designation      || (primaryContact && primaryContact.designation) || '';

  const { rows: [newRow] } = await pool.query(`
    INSERT INTO leads
      (factory_number, factory_name, person_in_charge, contact, designation, product,
       quantity, rate, stage, follow_up, notes, area, lead_type, created_by,
       last_updated, mapped_stage, stage_number, team_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    RETURNING id
  `, [
    data.factory_number || '',
    data.factory_name   || '',
    personInCharge,
    contactNum,
    designation,
    flat.product        || '',
    flat.quantity       || '',
    flat.rate           || '',
    data.stage          || '',
    data.follow_up      || '',
    data.notes          || '',
    data.area           || '',
    data.lead_type      || '',
    createdBy || data.created_by || '',
    now,
    data.stage          || '',
    data.stage_number != null ? String(data.stage_number) : '',
    data.team_id        || null,
  ]);

  const leadId = newRow.id;

  if (items.length) {
    for (const item of items) {
      await pool.query(
        `INSERT INTO lead_items (lead_id, product, quantity, rate) VALUES ($1,$2,$3,$4)`,
        [leadId, item.product || '', item.quantity || '', item.rate || '']
      );
    }
  } else if (data.product || flat.product) {
    await pool.query(
      `INSERT INTO lead_items (lead_id, product, quantity, rate) VALUES ($1,$2,$3,$4)`,
      [leadId, flat.product || '', flat.quantity || '', flat.rate || '']
    );
  }

  // Extra contacts (index 1+)
  if (Array.isArray(data.contacts) && data.contacts.length > 1) {
    for (const c of data.contacts.slice(1)) {
      if (c.person_name || c.contact) {
        await pool.query(
          `INSERT INTO lead_contacts (lead_id, person_name, contact, designation) VALUES ($1,$2,$3,$4)`,
          [leadId, c.person_name || '', c.contact || '', c.designation || '']
        );
      }
    }
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
        `UPDATE leads SET person_in_charge = $1, contact = $2, designation = $3 WHERE id = $4`,
        [primary.person_name || '', primary.contact || '', primary.designation || '', rowIndex]
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
  const { rows: existing } = await pool.query(`SELECT id FROM users WHERE display_name ILIKE $1`, [displayName]);
  if (existing.length) return { ok: false, message: 'Name already taken. Choose another name.' };
  const pinHash = await bcrypt.hash(String(pin), 10);
  await pool.query(
    `INSERT INTO users (display_name, role, pin_hash, telegram_user_id, created_at) VALUES ($1,$2,$3,$4,$5)`,
    [displayName, role, pinHash, telegramUserId || null, nowIST()]
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
  const pinHash = await bcrypt.hash(String(newPin), 10);
  await pool.query(`UPDATE users SET pin_hash = $1 WHERE id = $2`, [pinHash, userId]);
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
  const pinStr = String(pin);
  // bcrypt hash (new): starts with $2b$ or $2a$
  if (user.pin_hash && user.pin_hash.startsWith('$2')) {
    const valid = await bcrypt.compare(pinStr, user.pin_hash);
    return valid ? user : null;
  }
  // SHA-256 (legacy): migrate on successful login
  if (user.pin_hash === hashPin(pinStr)) {
    const newHash = await bcrypt.hash(pinStr, 10);
    await pool.query(`UPDATE users SET pin_hash = $1 WHERE id = $2`, [newHash, user.id]);
    return user;
  }
  return null;
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
    const pinHash = await bcrypt.hash(String(adminPass), 10);
    await pool.query(
      `INSERT INTO users (display_name, role, pin_hash, telegram_user_id, created_at) VALUES ($1,'admin',$2,NULL,$3)`,
      [adminUser, pinHash, nowIST()]
    );
    console.log(`✅ Admin user "${adminUser}" created`);
  }
}

// ── Auth: credential detection ────────────────────────────────
async function getUserByCredential(credential) {
  const c = credential.trim();
  // Email detection
  if (c.includes('@')) {
    const { rows } = await pool.query(`SELECT * FROM users WHERE LOWER(email) = LOWER($1)`, [c]);
    if (rows[0]) return rows[0];
  }
  // Mobile detection (digits + optional + prefix)
  const mobile = c.replace(/[\s\-\(\)]/g, '');
  if (/^\+?\d{10,15}$/.test(mobile)) {
    const { rows } = await pool.query(`SELECT * FROM users WHERE mobile = $1`, [mobile]);
    if (rows[0]) return rows[0];
  }
  // Username (case-insensitive, also catches email-as-username fallback)
  const { rows } = await pool.query(`SELECT * FROM users WHERE LOWER(display_name) = LOWER($1)`, [c]);
  return rows[0] || null;
}

async function incrementFailedAttempts(userId) {
  await pool.query(`
    UPDATE users
    SET failed_attempts = COALESCE(failed_attempts, 0) + 1,
        locked_until = CASE
          WHEN COALESCE(failed_attempts, 0) + 1 >= 10 THEN NOW() + interval '1 hour'
          WHEN COALESCE(failed_attempts, 0) + 1 >= 5  THEN NOW() + interval '15 minutes'
          ELSE locked_until
        END
    WHERE id = $1`, [userId]);
}

async function resetFailedAttempts(userId) {
  await pool.query(
    `UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = NOW() WHERE id = $1`,
    [userId]
  );
}

// ── Auth: sessions ────────────────────────────────────────────
async function createSession(userId, deviceId, ip, ua) {
  const id = uuidv4();
  const { rows } = await pool.query(`
    INSERT INTO sessions (id, user_id, device_id, ip_address, user_agent, expires_at)
    VALUES ($1,$2,$3,$4,$5, NOW() + interval '30 days') RETURNING *`,
    [id, userId, deviceId || null, ip || '', (ua || '').slice(0, 500)]
  );
  return rows[0];
}

async function getSessionById(id) {
  const { rows } = await pool.query(`SELECT * FROM sessions WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function revokeSession(id) {
  await pool.query(`UPDATE sessions SET revoked = TRUE WHERE id = $1`, [id]);
  await pool.query(`UPDATE refresh_tokens SET used = TRUE WHERE session_id = $1`, [id]);
}

async function revokeAllUserSessions(userId, exceptId) {
  const cond = exceptId ? `AND id != $2` : '';
  const vals = exceptId ? [userId, exceptId] : [userId];
  await pool.query(`UPDATE sessions SET revoked = TRUE WHERE user_id = $1 AND NOT revoked ${cond}`, vals);
}

async function touchSession(id) {
  await pool.query(`UPDATE sessions SET last_active_at = NOW() WHERE id = $1`, [id]);
}

async function listUserSessions(userId) {
  const { rows } = await pool.query(`
    SELECT s.id, s.device_id, s.ip_address, s.user_agent, s.created_at, s.last_active_at, s.expires_at,
           td.device_name, td.browser, td.os, td.device_type
    FROM sessions s LEFT JOIN trusted_devices td ON td.id = s.device_id
    WHERE s.user_id = $1 AND NOT s.revoked AND s.expires_at > NOW()
    ORDER BY s.last_active_at DESC`, [userId]
  );
  return rows;
}

// ── Auth: refresh tokens ──────────────────────────────────────
async function issueRefreshToken(sessionId) {
  const raw    = crypto.randomBytes(48).toString('base64url');
  const hash   = sha256(raw);
  const family = uuidv4();
  await pool.query(`
    INSERT INTO refresh_tokens (id, session_id, token_hash, family, expires_at)
    VALUES ($1,$2,$3,$4, NOW() + interval '30 days')`,
    [uuidv4(), sessionId, hash, family]
  );
  return raw;
}

async function rotateRefreshToken(rawToken) {
  const hash = sha256(rawToken);
  const { rows } = await pool.query(`SELECT * FROM refresh_tokens WHERE token_hash = $1`, [hash]);
  const rt = rows[0];
  if (!rt) throw Object.assign(new Error('Invalid refresh token'), { status: 401 });
  if (rt.used) {
    // Reuse attack: revoke entire token family + session
    await pool.query(`UPDATE refresh_tokens SET used = TRUE WHERE family = $1`, [rt.family]);
    await pool.query(`UPDATE sessions SET revoked = TRUE WHERE id = $1`, [rt.session_id]);
    await logSecurity(null, 'token_reuse_attack', { family: rt.family }, '', '', rt.session_id, null);
    throw Object.assign(new Error('Token reuse detected — session revoked for security'), { status: 401 });
  }
  if (new Date(rt.expires_at) < new Date())
    throw Object.assign(new Error('Refresh token expired'), { status: 401 });
  // Mark old as used
  await pool.query(`UPDATE refresh_tokens SET used = TRUE WHERE id = $1`, [rt.id]);
  // Issue new in same family
  const newRaw  = crypto.randomBytes(48).toString('base64url');
  const newHash = sha256(newRaw);
  await pool.query(`
    INSERT INTO refresh_tokens (id, session_id, token_hash, family, expires_at)
    VALUES ($1,$2,$3,$4, NOW() + interval '30 days')`,
    [uuidv4(), rt.session_id, newHash, rt.family]
  );
  await touchSession(rt.session_id);
  return { sessionId: rt.session_id, newRaw };
}

// ── Auth: trusted devices ─────────────────────────────────────
async function trustDevice(userId, fingerprint, meta) {
  const { name = 'Unknown Device', browser = '', os = '', type = 'unknown', ip = '' } = meta || {};
  const { rows } = await pool.query(`
    INSERT INTO trusted_devices (id, user_id, fingerprint_hash, device_name, browser, os, device_type, ip_address)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (user_id, fingerprint_hash) DO UPDATE
      SET device_name = EXCLUDED.device_name, last_active_at = NOW(), ip_address = EXCLUDED.ip_address
    RETURNING *`,
    [uuidv4(), userId, fingerprint, name, browser, os, type, ip]
  );
  return rows[0];
}

async function getDeviceByFingerprint(userId, fingerprint) {
  const { rows } = await pool.query(
    `SELECT * FROM trusted_devices WHERE user_id = $1 AND fingerprint_hash = $2`, [userId, fingerprint]
  );
  return rows[0] || null;
}

async function getDeviceById(deviceId, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM trusted_devices WHERE id = $1 AND user_id = $2`, [deviceId, userId]
  );
  return rows[0] || null;
}

async function listUserDevices(userId) {
  const { rows } = await pool.query(
    `SELECT * FROM trusted_devices WHERE user_id = $1 ORDER BY last_active_at DESC`, [userId]
  );
  return rows;
}

async function removeDevice(deviceId, userId) {
  await pool.query(`DELETE FROM device_pins WHERE device_id = $1 AND user_id = $2`, [deviceId, userId]);
  await pool.query(`DELETE FROM trusted_devices WHERE id = $1 AND user_id = $2`, [deviceId, userId]);
  return { ok: true };
}

async function renameDevice(deviceId, userId, name) {
  await pool.query(`UPDATE trusted_devices SET device_name = $1 WHERE id = $2 AND user_id = $3`, [name, deviceId, userId]);
  return { ok: true };
}

async function touchDevice(deviceId) {
  await pool.query(`UPDATE trusted_devices SET last_active_at = NOW() WHERE id = $1`, [deviceId]);
}

// ── Auth: device PINs ─────────────────────────────────────────
async function setupDevicePin(userId, deviceId, pin) {
  const hash = await bcrypt.hash(String(pin), 10);
  await pool.query(`
    INSERT INTO device_pins (id, user_id, device_id, pin_hash)
    VALUES ($1,$2,$3,$4)
    ON CONFLICT (user_id, device_id) DO UPDATE
      SET pin_hash = EXCLUDED.pin_hash, failed_attempts = 0, locked_until = NULL, updated_at = NOW()`,
    [uuidv4(), userId, deviceId, hash]
  );
  return { ok: true };
}

async function verifyDevicePin(userId, deviceId, pin) {
  const { rows } = await pool.query(
    `SELECT * FROM device_pins WHERE user_id = $1 AND device_id = $2`, [userId, deviceId]
  );
  const dp = rows[0];
  if (!dp) return { ok: false, reason: 'no_pin' };
  if (dp.locked_until && new Date(dp.locked_until) > new Date())
    return { ok: false, reason: 'locked', until: dp.locked_until };
  const valid = await bcrypt.compare(String(pin), dp.pin_hash);
  if (!valid) {
    const newAttempts = (dp.failed_attempts || 0) + 1;
    const lockedUntil = newAttempts >= 10
      ? `NOW() + interval '1 hour'`
      : newAttempts >= 5 ? `NOW() + interval '30 minutes'` : null;
    if (lockedUntil) {
      await pool.query(`UPDATE device_pins SET failed_attempts=$1, locked_until=${lockedUntil} WHERE id=$2`, [newAttempts, dp.id]);
    } else {
      await pool.query(`UPDATE device_pins SET failed_attempts=$1 WHERE id=$2`, [newAttempts, dp.id]);
    }
    return { ok: false, reason: 'wrong_pin', attemptsLeft: Math.max(0, 5 - newAttempts) };
  }
  await pool.query(`UPDATE device_pins SET failed_attempts=0, locked_until=NULL WHERE id=$1`, [dp.id]);
  return { ok: true };
}

async function hasDevicePin(userId, deviceId) {
  const { rows } = await pool.query(
    `SELECT id FROM device_pins WHERE user_id = $1 AND device_id = $2`, [userId, deviceId]
  );
  return rows.length > 0;
}

// ── Security log ──────────────────────────────────────────────
async function logSecurity(userId, event, detail, ip, ua, sessionId, deviceId) {
  await pool.query(`
    INSERT INTO security_logs (user_id, event, detail, ip_address, user_agent, session_id, device_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [userId || null, event, JSON.stringify(detail || {}),
     (ip || '').slice(0, 100), (ua || '').slice(0, 500),
     sessionId || null, deviceId || null]
  ).catch(() => {}); // never let logging break the request
}

async function getUserSecurityLog(userId, limit = 50) {
  const { rows } = await pool.query(`
    SELECT id, event, detail, ip_address, user_agent, session_id, device_id, created_at
    FROM security_logs WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

async function getLeadContacts(leadId) {
  const { rows } = await pool.query(
    `SELECT * FROM lead_contacts WHERE lead_id = $1 ORDER BY id ASC`, [leadId]
  );
  return rows;
}

// ============================================================
//  TEAM WORKSPACE
// ============================================================

function generateTeamCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = 'TEAM-';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function generateInviteCode(len = 10) {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  let c = '';
  for (let i = 0; i < len; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

async function createTeam(name, handle, ownerId) {
  const teamCode = generateTeamCode();
  const invCode  = generateInviteCode();
  const { rows } = await pool.query(
    `INSERT INTO teams (name, handle, team_code, owner_id, invite_code, created_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [name.trim(), handle.toLowerCase().replace(/^@/, ''), teamCode, ownerId, invCode, nowIST()]
  );
  const team = rows[0];
  await pool.query(
    `INSERT INTO team_members (team_id, user_id, role, status, joined_at) VALUES ($1,$2,'owner','active',$3)`,
    [team.id, ownerId, nowIST()]
  );
  return team;
}

async function getTeamById(id) {
  const { rows } = await pool.query(
    `SELECT t.*, u.display_name AS owner_name,
       (SELECT COUNT(*) FROM team_members WHERE team_id=t.id AND status='active')::int AS member_count
     FROM teams t LEFT JOIN users u ON t.owner_id=u.id WHERE t.id=$1`, [id]
  );
  return rows[0] || null;
}

async function getTeamByHandle(handle) {
  const { rows } = await pool.query(
    `SELECT t.*, u.display_name AS owner_name,
       (SELECT COUNT(*) FROM team_members WHERE team_id=t.id AND status='active')::int AS member_count
     FROM teams t LEFT JOIN users u ON t.owner_id=u.id WHERE LOWER(t.handle)=LOWER($1)`,
    [handle.replace(/^@/, '')]
  );
  return rows[0] || null;
}

async function getTeamByInviteCode(code) {
  const { rows } = await pool.query(`SELECT * FROM teams WHERE invite_code=$1`, [code]);
  return rows[0] || null;
}

async function searchTeams(query) {
  const q = `%${query.toLowerCase()}%`;
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.handle, t.team_code, u.display_name AS owner_name,
       (SELECT COUNT(*) FROM team_members WHERE team_id=t.id AND status='active')::int AS member_count
     FROM teams t LEFT JOIN users u ON t.owner_id=u.id
     WHERE t.public_search=true
       AND (LOWER(t.name) LIKE $1 OR LOWER(t.handle) LIKE $1 OR LOWER(t.team_code) LIKE $1)
     ORDER BY member_count DESC LIMIT 20`, [q]
  );
  return rows;
}

async function updateTeam(id, { name, handle, publicSearch, autoApprove }) {
  const sets = []; const vals = []; let i = 1;
  if (name         !== undefined) { sets.push(`name=$${i++}`);          vals.push(name); }
  if (handle       !== undefined) { sets.push(`handle=$${i++}`);        vals.push(handle.replace(/^@/, '')); }
  if (publicSearch !== undefined) { sets.push(`public_search=$${i++}`); vals.push(publicSearch); }
  if (autoApprove  !== undefined) { sets.push(`auto_approve=$${i++}`);  vals.push(autoApprove); }
  if (!sets.length) return;
  vals.push(id);
  await pool.query(`UPDATE teams SET ${sets.join(',')} WHERE id=$${i}`, vals);
}

async function regenerateInviteCode(teamId) {
  const code = generateInviteCode();
  await pool.query(`UPDATE teams SET invite_code=$1 WHERE id=$2`, [code, teamId]);
  return code;
}

async function getTeamMembers(teamId) {
  const { rows } = await pool.query(
    `SELECT tm.id, tm.team_id, tm.role, tm.status, tm.joined_at,
       u.id AS user_id, u.display_name, u.telegram_user_id
     FROM team_members tm JOIN users u ON u.id=tm.user_id
     WHERE tm.team_id=$1
     ORDER BY CASE tm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1
       WHEN 'manager' THEN 2 WHEN 'sales' THEN 3 ELSE 4 END, tm.joined_at ASC`,
    [teamId]
  );
  return rows;
}

async function getTeamMember(teamId, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM team_members WHERE team_id=$1 AND user_id=$2`, [teamId, userId]
  );
  return rows[0] || null;
}

async function addTeamMember(teamId, userId, role = 'sales', status = 'active') {
  const { rows } = await pool.query(
    `INSERT INTO team_members (team_id, user_id, role, status, joined_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (team_id, user_id) DO UPDATE SET status=EXCLUDED.status, role=EXCLUDED.role, joined_at=EXCLUDED.joined_at
     RETURNING *`,
    [teamId, userId, role, status, nowIST()]
  );
  return rows[0];
}

async function updateTeamMember(teamId, userId, { role, status }) {
  const sets = []; const vals = []; let i = 1;
  if (role   !== undefined) { sets.push(`role=$${i++}`);   vals.push(role); }
  if (status !== undefined) { sets.push(`status=$${i++}`); vals.push(status); }
  if (!sets.length) return;
  vals.push(teamId, userId);
  await pool.query(`UPDATE team_members SET ${sets.join(',')} WHERE team_id=$${i} AND user_id=$${i+1}`, vals);
}

async function removeTeamMember(teamId, userId) {
  await pool.query(`DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, [teamId, userId]);
}

async function getUserTeams(userId) {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.handle, t.team_code, t.invite_code, t.auto_approve,
       tm.role, tm.status, tm.joined_at
     FROM teams t JOIN team_members tm ON tm.team_id=t.id
     WHERE tm.user_id=$1 AND tm.status='active'
     ORDER BY tm.joined_at ASC`,
    [userId]
  );
  return rows;
}

async function createJoinRequest(teamId, userId, message = '') {
  const { rows } = await pool.query(
    `INSERT INTO join_requests (team_id, user_id, message, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$4)
     ON CONFLICT (team_id, user_id) DO UPDATE SET status='pending', message=EXCLUDED.message, updated_at=EXCLUDED.created_at
     RETURNING *`,
    [teamId, userId, message, nowIST()]
  );
  return rows[0];
}

async function getJoinRequests(teamId, status = null) {
  const cond  = status ? `AND jr.status=$2` : '';
  const vals  = status ? [teamId, status]   : [teamId];
  const { rows } = await pool.query(
    `SELECT jr.*, u.display_name AS user_name
     FROM join_requests jr JOIN users u ON u.id=jr.user_id
     WHERE jr.team_id=$1 ${cond} ORDER BY jr.created_at DESC`, vals
  );
  return rows;
}

async function updateJoinRequest(id, status, reviewedBy) {
  await pool.query(
    `UPDATE join_requests SET status=$1, reviewed_by=$2, updated_at=$3 WHERE id=$4`,
    [status, reviewedBy, nowIST(), id]
  );
}

async function getJoinRequestByUserTeam(teamId, userId) {
  const { rows } = await pool.query(
    `SELECT * FROM join_requests WHERE team_id=$1 AND user_id=$2`, [teamId, userId]
  );
  return rows[0] || null;
}

async function getLeadsByTeam(teamId) {
  const { rows } = await pool.query(`
    SELECT id AS "rowIndex", factory_number, factory_name, person_in_charge, contact, designation,
      product, quantity, rate, stage, follow_up, notes, area,
      lead_type, created_by, assigned_to, last_updated, mapped_stage, stage_number,
      lat, lng, team_id, visibility
    FROM leads WHERE team_id=$1 ORDER BY id ASC`, [teamId]
  );
  if (!rows.length) return [];
  const ids = rows.map(r => r.rowIndex);
  const { rows: allItems }    = await pool.query(`SELECT * FROM lead_items    WHERE lead_id=ANY($1) ORDER BY lead_id,id ASC`, [ids]);
  const { rows: allContacts } = await pool.query(`SELECT * FROM lead_contacts WHERE lead_id=ANY($1) ORDER BY lead_id,id ASC`, [ids]);
  const itemMap = {}; const contactMap = {};
  for (const it of allItems)    { (itemMap[it.lead_id]    = itemMap[it.lead_id]    || []).push({ product: it.product||'', quantity: it.quantity||'', rate: it.rate||'' }); }
  for (const ct of allContacts) { (contactMap[ct.lead_id] = contactMap[ct.lead_id] || []).push({ id: ct.id, person_name: ct.person_name||'', contact: ct.contact||'', designation: ct.designation||'' }); }
  return rows.map(r => {
    const out = {};
    for (const [k, v] of Object.entries(r)) out[k] = v == null ? '' : String(v);
    out.items    = itemMap[r.rowIndex] || [];
    const extras = contactMap[r.rowIndex] || [];
    out.contacts = [
      { id: 'primary', person_name: out.person_in_charge || '', contact: out.contact || '', designation: out.designation || '' },
      ...extras,
    ];
    out.extraContacts = extras;
    return out;
  });
}

// ── AI Vocabulary (aliases) ──────────────────────────────────
async function getVocab(teamId) {
  const { rows } = await pool.query(
    `SELECT id, alias, canonical, team_id, created_by
     FROM ai_vocab
     WHERE team_id IS NULL OR team_id = $1
     ORDER BY team_id NULLS FIRST`,
    [teamId || null]
  );
  return rows;
}

async function addVocab(alias, canonical, teamId, createdBy) {
  const { rows } = await pool.query(
    `INSERT INTO ai_vocab (alias, canonical, team_id, created_by, created_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [alias.trim().toLowerCase(), canonical.trim(), teamId || null, createdBy || '', nowIST()]
  );
  return rows[0];
}

async function deleteVocab(id) {
  await pool.query(`DELETE FROM ai_vocab WHERE id=$1`, [id]);
}

async function logAiAction(leadId, action, inputType, rawInput, parsedJson, savedBy, teamId) {
  await pool.query(
    `INSERT INTO ai_audit_log (lead_id, action, input_type, raw_input, parsed_json, saved_by, team_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [leadId || null, action, inputType || 'text', rawInput || '', parsedJson || '{}', savedBy || '', teamId || null]
  ).catch(() => {});
}

// ── Lead security helpers ─────────────────────────────────────
async function getLeadById(id) {
  const { rows } = await pool.query(`SELECT * FROM leads WHERE id=$1`, [id]);
  return rows[0] || null;
}

async function userHasLeadAccess(leadId, username) {
  const { rows } = await pool.query(
    `SELECT 1 FROM lead_access WHERE lead_id=$1 AND user_display_name=$2`, [leadId, username]
  );
  return rows.length > 0;
}

// ── Lead activity timeline ────────────────────────────────────
async function logLeadActivity(leadId, teamId, activityType, description, metadata, performedBy) {
  await pool.query(
    `INSERT INTO lead_activities (lead_id, team_id, activity_type, description, metadata, performed_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [leadId, teamId || null, activityType, description || '', JSON.stringify(metadata || {}), performedBy]
  ).catch(() => {});
}

async function getLeadActivities(leadId) {
  const { rows } = await pool.query(
    `SELECT id, activity_type, description, metadata, performed_by, created_at
     FROM lead_activities WHERE lead_id=$1 ORDER BY created_at DESC`,
    [leadId]
  );
  return rows;
}

// ── Field-level edit history ──────────────────────────────────
async function logLeadHistory(leadId, changedBy, fieldName, oldValue, newValue, teamId) {
  await pool.query(
    `INSERT INTO lead_history (lead_id, changed_by, field_name, old_value, new_value, team_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [leadId, changedBy, fieldName, String(oldValue ?? ''), String(newValue ?? ''), teamId || null]
  ).catch(() => {});
}

async function getLeadHistory(leadId) {
  const { rows } = await pool.query(
    `SELECT id, changed_by, changed_at, field_name, old_value, new_value
     FROM lead_history WHERE lead_id=$1 ORDER BY changed_at DESC`,
    [leadId]
  );
  return rows;
}

// ── Departments ───────────────────────────────────────────────
async function getDepartments(teamId) {
  const { rows } = await pool.query(
    `SELECT d.*, u.display_name AS manager_name,
       (SELECT COUNT(*) FROM department_members WHERE department_id=d.id)::int AS member_count
     FROM departments d LEFT JOIN users u ON u.id=d.manager_id
     WHERE d.team_id=$1 AND d.archived_at IS NULL ORDER BY d.created_at ASC`,
    [teamId]
  );
  return rows;
}

async function createDepartment(teamId, name, managerId) {
  const { rows } = await pool.query(
    `INSERT INTO departments (team_id, name, manager_id) VALUES ($1,$2,$3) RETURNING *`,
    [teamId, name.trim(), managerId || null]
  );
  return rows[0];
}

async function updateDepartment(id, { name, description, managerId }) {
  const sets = []; const vals = []; let i = 1;
  if (name        !== undefined) { sets.push(`name=$${i++}`);        vals.push(name); }
  if (description !== undefined) { sets.push(`description=$${i++}`); vals.push(description); }
  if (managerId   !== undefined) { sets.push(`manager_id=$${i++}`);  vals.push(managerId); }
  if (!sets.length) return;
  vals.push(id);
  await pool.query(`UPDATE departments SET ${sets.join(',')} WHERE id=$${i}`, vals);
}

async function archiveDepartment(id) {
  await pool.query(`UPDATE departments SET archived_at=NOW() WHERE id=$1`, [id]);
}

async function getDepartmentMembers(deptId) {
  const { rows } = await pool.query(
    `SELECT dm.*, u.display_name, u.telegram_user_id
     FROM department_members dm JOIN users u ON u.id=dm.user_id
     WHERE dm.department_id=$1 ORDER BY dm.joined_at ASC`,
    [deptId]
  );
  return rows;
}

async function addDepartmentMember(deptId, userId) {
  await pool.query(
    `INSERT INTO department_members (department_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
    [deptId, userId]
  );
}

async function removeDepartmentMember(deptId, userId) {
  await pool.query(
    `DELETE FROM department_members WHERE department_id=$1 AND user_id=$2`, [deptId, userId]
  );
}

// ── Granular permissions ──────────────────────────────────────
async function getUserPermissions(userId, teamId) {
  const { rows } = await pool.query(
    `SELECT permission_code FROM user_permissions WHERE user_id=$1 AND team_id=$2`,
    [userId, teamId]
  );
  return rows.map(r => r.permission_code);
}

async function grantPermission(userId, teamId, code, grantedBy) {
  await pool.query(
    `INSERT INTO user_permissions (user_id, team_id, permission_code, granted_by)
     VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
    [userId, teamId, code, grantedBy || null]
  );
}

async function revokePermission(userId, teamId, code) {
  await pool.query(
    `DELETE FROM user_permissions WHERE user_id=$1 AND team_id=$2 AND permission_code=$3`,
    [userId, teamId, code]
  );
}

// ── Personal vocabulary ───────────────────────────────────────
async function getPersonalVocab(userId) {
  const { rows } = await pool.query(
    `SELECT id, alias, canonical, created_at FROM personal_vocab WHERE user_id=$1 ORDER BY id ASC`,
    [userId]
  );
  return rows;
}

async function addPersonalVocab(userId, alias, canonical) {
  const { rows } = await pool.query(
    `INSERT INTO personal_vocab (user_id, alias, canonical)
     VALUES ($1,$2,$3) ON CONFLICT (user_id, alias) DO UPDATE SET canonical=EXCLUDED.canonical RETURNING id`,
    [userId, alias.trim().toLowerCase(), canonical.trim()]
  );
  return rows[0];
}

async function deletePersonalVocab(id, userId) {
  await pool.query(`DELETE FROM personal_vocab WHERE id=$1 AND user_id=$2`, [id, userId]);
}

// ── AI corrections (learning engine) ─────────────────────────
async function logCorrection(sessionId, fieldName, originalValue, correctedValue, rawInput, userId, teamId) {
  await pool.query(
    `INSERT INTO ai_corrections (session_id, field_name, original_value, corrected_value, raw_input, user_id, team_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [sessionId || '', fieldName || '', originalValue || '', correctedValue || '', rawInput || '', userId || null, teamId || null]
  ).catch(() => {});
}

async function getAIDebugLog(teamId, limit = 50) {
  const { rows } = await pool.query(
    `SELECT id, lead_id, action, input_type, raw_input, saved_by, parsed_json, created_at
     FROM ai_audit_log
     WHERE team_id=$1 OR $1 IS NULL
     ORDER BY created_at DESC LIMIT $2`,
    [teamId || null, limit]
  );
  return rows;
}

// ── CRM search for AI context ─────────────────────────────────
async function searchBusinesses(query, teamId) {
  const q = `%${query.toLowerCase()}%`;
  const { rows } = await pool.query(
    `SELECT id, factory_number, factory_name, person_in_charge, stage, last_updated
     FROM leads
     WHERE (LOWER(factory_number) LIKE $1 OR LOWER(factory_name) LIKE $1)
       AND (team_id=$2 OR $2 IS NULL)
     ORDER BY last_updated DESC LIMIT 3`,
    [q, teamId || null]
  );
  return rows;
}

async function searchContacts(query, teamId) {
  const q = `%${query.toLowerCase()}%`;
  const { rows } = await pool.query(
    `SELECT id, factory_name, person_in_charge, contact, stage
     FROM leads
     WHERE LOWER(person_in_charge) LIKE $1
       AND (team_id=$2 OR $2 IS NULL)
     ORDER BY last_updated DESC LIMIT 3`,
    [q, teamId || null]
  );
  return rows;
}

module.exports = {
  pool,
  initSchema,
  getLeads, getLeadsForUser, getLeadsByTeam, getStats, addLead, updateLead, deleteLead,
  addPhoto, getPhotos, getLeadContacts,
  grantLeadAccess, revokeLeadAccess, getLeadAccess, claimFollowUp, reassignFollowUp,
  createUser, getUserByName, getUserByTelegramId, updateUserPin, updateUserName,
  getAllUsers, deleteUser, verifyUserPin, seedAdminUser,
  saveWebAuthnCred, getWebAuthnCred, getUserByWebAuthnCredId,
  getLeadCoordinates, updateLeadCoords,
  // Team workspace
  createTeam, getTeamById, getTeamByHandle, getTeamByInviteCode, searchTeams,
  updateTeam, regenerateInviteCode,
  getTeamMembers, getTeamMember, addTeamMember, updateTeamMember, removeTeamMember, getUserTeams,
  createJoinRequest, getJoinRequests, updateJoinRequest, getJoinRequestByUserTeam,
  // Auth system
  getUserByCredential, incrementFailedAttempts, resetFailedAttempts,
  createSession, getSessionById, revokeSession, revokeAllUserSessions, listUserSessions,
  issueRefreshToken, rotateRefreshToken,
  trustDevice, getDeviceByFingerprint, getDeviceById, listUserDevices, removeDevice, renameDevice, touchDevice,
  setupDevicePin, verifyDevicePin, hasDevicePin,
  logSecurity, getUserSecurityLog,
  // AI Entry Mode
  getVocab, addVocab, deleteVocab, logAiAction,
  // Lead security
  getLeadById, userHasLeadAccess,
  // Activity timeline + history
  logLeadActivity, getLeadActivities, logLeadHistory, getLeadHistory,
  // Departments
  getDepartments, createDepartment, updateDepartment, archiveDepartment,
  getDepartmentMembers, addDepartmentMember, removeDepartmentMember,
  // Granular permissions
  getUserPermissions, grantPermission, revokePermission,
  // Personal vocab
  getPersonalVocab, addPersonalVocab, deletePersonalVocab,
  // AI learning + debug
  logCorrection, getAIDebugLog,
  // CRM search
  searchBusinesses, searchContacts,
  bcrypt,
};
