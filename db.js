// ============================================================
//  db.js — PostgreSQL database layer (pg / node-postgres)
// ============================================================
const { Pool } = require('pg');
const crypto   = require('crypto');
const { BUSINESS_KEYS, sanitizeCustomStages } = require('./business-types');

// pg v8.13+ changed SSL: sslmode=require now maps to verify-full unless uselibpqcompat is set.
// Strip original sslmode, then add uselibpqcompat=true&sslmode=require so pg uses libpq
// semantics where 'require' = encrypt only, no cert chain verification (needed for Aiven).
let _dbUrl = (process.env.DB_URL || '').replace(/([?&])sslmode=[^&]*(&?)/g, (_, pre, post) => post ? pre : '');
_dbUrl += (_dbUrl.includes('?') ? '&' : '?') + 'uselibpqcompat=true&sslmode=require';

// TLS: when the Aiven CA cert is provided (DB_CA_CERT), verify the server
// certificate fully (rejectUnauthorized: true). Without it we can only encrypt,
// not verify — so we keep the connection working but warn loudly. Set DB_CA_CERT
// (the Aiven project CA, PEM) to enable full verification.
const _dbCaCert = process.env.DB_CA_CERT;
let _dbSsl;
if (_dbCaCert) {
  _dbSsl = { rejectUnauthorized: true, ca: _dbCaCert };
} else {
  if (process.env.NODE_ENV === 'production') {
    console.warn('⚠️  DB_CA_CERT is not set — the database TLS connection is encrypted but NOT certificate-verified. Set DB_CA_CERT (Aiven CA cert) to enable full verification.');
  }
  _dbSsl = { rejectUnauthorized: false };
}

const pool = new Pool({
  connectionString: _dbUrl,
  ssl: _dbSsl,
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
    await client.query(`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_telegram_user_id_key`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    // Convert any empty-string telegram_user_id to NULL so the partial index works
    await client.query(`UPDATE users SET telegram_user_id = NULL WHERE telegram_user_id = ''`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    // Partial unique index: only enforce uniqueness for real (non-null) Telegram IDs
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_users_telegram_id
      ON users(telegram_user_id)
      WHERE telegram_user_id IS NOT NULL
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));

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
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS team_id     INTEGER REFERENCES teams(id)`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS visibility  TEXT DEFAULT 'team'`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS designation TEXT DEFAULT ''`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    // bucket: 'working' = the active pipeline (working sheet); 'database' = the
    // team's separate reference bank / staging pool, hidden from working views.
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS bucket      TEXT DEFAULT 'working'`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`CREATE INDEX IF NOT EXISTS idx_leads_bucket ON leads(bucket)`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    // Entry date for the "Date Added" column. Added WITHOUT a default so existing
    // rows stay NULL (shown as "—" — we don't know their real entry date) rather
    // than all backfilling to the migration moment; new inserts get NOW() via the
    // default set immediately after. getLeads/getLeadsForUser select this column.
    await client.query(`ALTER TABLE leads ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`ALTER TABLE leads ALTER COLUMN created_at SET DEFAULT NOW()`).catch(e => console.warn('[db] non-fatal:', e && e.message));

    // ── Auth system tables ─────────────────────────────────────
    // Extend users with email, mobile, lockout fields
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS mobile TEXT`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS default_area TEXT DEFAULT ''`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    // Real account password (primary credential). PIN becomes device quick-unlock,
    // so it is no longer mandatory at the column level.
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash TEXT`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`ALTER TABLE users ALTER COLUMN pin_hash DROP NOT NULL`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_attempts SMALLINT DEFAULT 0`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    // Free-text job title shown on the Team page (e.g. "Regional Manager").
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS designation TEXT DEFAULT ''`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    // Admin-forced password reset: the account keeps whatever credential it
    // already had (password or PIN) so nobody is locked out, but the next
    // successful login is intercepted by the same blocking "set a password"
    // step used for legacy-PIN migration, before the app becomes usable.
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT FALSE`).catch(e => console.warn('[db] non-fatal:', e && e.message));

    // ── Pro entitlement (Lite vs Pro) ──────────────────────────
    // pro_until = when Pro access ends (trial or paid); plan_kind = trial|code|individual|team.
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS pro_until TIMESTAMPTZ`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_kind TEXT DEFAULT ''`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    // Give every account a 14-day Pro trial the first time this ships. Idempotent:
    // only rows with no pro_until yet are touched, so it never re-grants on reboot.
    await client.query(`UPDATE users SET pro_until = NOW() + INTERVAL '14 days', plan_kind = 'trial' WHERE pro_until IS NULL`).catch(e => console.warn('[db] non-fatal:', e && e.message));

    // ── Business type (per-team + per-user "what kind of business") ─────
    // Relabels display words + primes the AI vocabulary; NEVER changes the
    // stored field names. Default 'factory' everywhere so existing data and
    // users behave exactly as before. 'custom' carries user-defined terms in
    // business_custom as a JSON string.
    await client.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS business_type   TEXT DEFAULT 'factory'`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`ALTER TABLE teams ADD COLUMN IF NOT EXISTS business_custom TEXT DEFAULT ''`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS business_type   TEXT DEFAULT 'factory'`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS business_custom TEXT DEFAULT ''`).catch(e => console.warn('[db] non-fatal:', e && e.message));

    // Dev-assigned access codes: redeem one to extend Pro by `days`.
    await client.query(`
      CREATE TABLE IF NOT EXISTS access_codes (
        id          SERIAL PRIMARY KEY,
        code        TEXT UNIQUE NOT NULL,
        days        INTEGER NOT NULL DEFAULT 30,
        label       TEXT DEFAULT '',
        max_uses    INTEGER DEFAULT 1,
        uses        INTEGER DEFAULT 0,
        created_by  TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`
      CREATE TABLE IF NOT EXISTS access_code_redemptions (
        id          SERIAL PRIMARY KEY,
        code        TEXT NOT NULL,
        user_id     INTEGER NOT NULL,
        redeemed_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(code, user_id)
      )
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));

    // ── Monetization: Razorpay payments + Referral program ────
    // Payments ledger: one row per Razorpay order. order_id is UNIQUE so a
    // verify call settles exactly one order, idempotently.
    await client.query(`
      CREATE TABLE IF NOT EXISTS payments (
        id           BIGSERIAL PRIMARY KEY,
        user_id      INTEGER NOT NULL,
        team_id      INTEGER,
        plan_kind    TEXT NOT NULL,
        seats        INTEGER DEFAULT 1,
        amount_paise INTEGER NOT NULL,
        order_id     TEXT UNIQUE NOT NULL,
        payment_id   TEXT DEFAULT '',
        status       TEXT DEFAULT 'created',
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        paid_at      TIMESTAMPTZ
      )
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id)`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    // granted_at stamps the moment Pro was actually granted for this order — the
    // single-flip guard (markPaymentGranted) that makes the grant idempotent and
    // a transient grant failure recoverable, independent of the paid flip.
    await client.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS granted_at TIMESTAMPTZ`).catch(e => console.warn('[db] non-fatal:', e && e.message));

    // Referral code lives on the user row (lazily generated). Partial-unique so
    // many NULLs coexist while every real code stays one-of-a-kind.
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_users_referral_code
      ON users(referral_code) WHERE referral_code IS NOT NULL AND referral_code != ''
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));

    // Referral ledger: one row per referred signup. credited = whether the
    // referrer actually earned their +14 days (a guard can decline it).
    await client.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        id               BIGSERIAL PRIMARY KEY,
        referrer_user_id INTEGER,
        referred_user_id INTEGER NOT NULL,
        code             TEXT NOT NULL,
        source           TEXT NOT NULL DEFAULT 'referral',
        credited         BOOLEAN DEFAULT FALSE,
        created_at       TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals(referrer_user_id)`).catch(e => console.warn('[db] non-fatal:', e && e.message));

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email
      ON users(LOWER(email)) WHERE email IS NOT NULL AND email != ''
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_users_mobile
      ON users(mobile) WHERE mobile IS NOT NULL AND mobile != ''
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));

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
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id) WHERE NOT revoked`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_exp  ON sessions(expires_at)`).catch(e => console.warn('[db] non-fatal:', e && e.message));

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
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`CREATE INDEX IF NOT EXISTS idx_rt_family ON refresh_tokens(family)`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    // Timestamp of when a token was marked used — lets rotation tell a genuine
    // replay-attack (an old token resurfacing much later) apart from two
    // legitimate concurrent refresh calls racing on the same still-fresh token
    // (e.g. two apiFetch calls firing together right as the access token expires).
    await client.query(`ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS used_at TIMESTAMPTZ`).catch(e => console.warn('[db] non-fatal:', e && e.message));

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
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`CREATE INDEX IF NOT EXISTS idx_td_user ON trusted_devices(user_id)`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_td_fingerprint
      ON trusted_devices(user_id, fingerprint_hash)
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));

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
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));

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
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`CREATE INDEX IF NOT EXISTS idx_sl_user ON security_logs(user_id, created_at DESC) WHERE user_id IS NOT NULL`).catch(e => console.warn('[db] non-fatal:', e && e.message));

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
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));

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
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`CREATE INDEX IF NOT EXISTS idx_departments_team ON departments(team_id)`).catch(e => console.warn('[db] non-fatal:', e && e.message));

    await client.query(`
      CREATE TABLE IF NOT EXISTS department_members (
        id            SERIAL PRIMARY KEY,
        department_id INTEGER REFERENCES departments(id) ON DELETE CASCADE,
        user_id       INTEGER REFERENCES users(id) ON DELETE CASCADE,
        joined_at     TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(department_id, user_id)
      )
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));

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
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`CREATE INDEX IF NOT EXISTS idx_user_perms ON user_permissions(user_id, team_id)`).catch(e => console.warn('[db] non-fatal:', e && e.message));

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
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`CREATE INDEX IF NOT EXISTS idx_lead_activities_lead ON lead_activities(lead_id, created_at DESC)`).catch(e => console.warn('[db] non-fatal:', e && e.message));

    // ── New: Team tasks (assign a to-do / lead to a teammate) ──
    await client.query(`
      CREATE TABLE IF NOT EXISTS team_tasks (
        id          BIGSERIAL PRIMARY KEY,
        team_id     INTEGER,
        title       TEXT NOT NULL,
        assignee    TEXT DEFAULT '',
        created_by  TEXT NOT NULL,
        lead_id     INTEGER,
        lead_label  TEXT DEFAULT '',
        due_at      TEXT DEFAULT '',
        status      TEXT DEFAULT 'open',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`CREATE INDEX IF NOT EXISTS idx_team_tasks_team ON team_tasks(team_id, status)`).catch(e => console.warn('[db] non-fatal:', e && e.message));

    // ── Team Hub (Pro): chat messages ─────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS team_messages (
        id          BIGSERIAL PRIMARY KEY,
        team_id     INTEGER NOT NULL,
        sender      TEXT NOT NULL,
        body        TEXT DEFAULT '',
        kind        TEXT DEFAULT 'msg',
        created_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`CREATE INDEX IF NOT EXISTS idx_team_messages_team ON team_messages(team_id, id DESC)`).catch(e => console.warn('[db] non-fatal:', e && e.message));

    // ── Team Hub (Pro): unified activity feed (non-lead events) ─
    await client.query(`
      CREATE TABLE IF NOT EXISTS team_activity (
        id           BIGSERIAL PRIMARY KEY,
        team_id      INTEGER NOT NULL,
        actor        TEXT NOT NULL,
        verb         TEXT NOT NULL,
        object_type  TEXT DEFAULT '',
        object_label TEXT DEFAULT '',
        meta         JSONB DEFAULT '{}',
        created_at   TIMESTAMPTZ DEFAULT NOW()
      )
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`CREATE INDEX IF NOT EXISTS idx_team_activity_team ON team_activity(team_id, created_at DESC)`).catch(e => console.warn('[db] non-fatal:', e && e.message));

    // Presence: last time a user pinged the server (for "who's online").
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`).catch(e => console.warn('[db] non-fatal:', e && e.message));

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
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`CREATE INDEX IF NOT EXISTS idx_lead_history_lead ON lead_history(lead_id, changed_at DESC)`).catch(e => console.warn('[db] non-fatal:', e && e.message));

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
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));

    // ── New: Lead share requests (teammates request access) ────
    await client.query(`
      CREATE TABLE IF NOT EXISTS lead_share_requests (
        id          SERIAL PRIMARY KEY,
        lead_id     INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        team_id     INTEGER,
        requester   TEXT NOT NULL,
        owner       TEXT DEFAULT '',
        message     TEXT DEFAULT '',
        status      TEXT DEFAULT 'pending',
        reviewed_by TEXT DEFAULT '',
        created_at  TIMESTAMPTZ DEFAULT NOW(),
        updated_at  TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(lead_id, requester)
      )
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`CREATE INDEX IF NOT EXISTS idx_lsr_owner ON lead_share_requests(owner, status)`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`CREATE INDEX IF NOT EXISTS idx_lsr_requester ON lead_share_requests(requester)`).catch(e => console.warn('[db] non-fatal:', e && e.message));

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
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`CREATE INDEX IF NOT EXISTS idx_ai_corrections_team ON ai_corrections(team_id, created_at DESC)`).catch(e => console.warn('[db] non-fatal:', e && e.message));

    // ── Lead lists (tags) — a lead can carry many lists; lists are either
    //    personal (team_id NULL, scoped to owner) or shared across a team.
    await client.query(`
      CREATE TABLE IF NOT EXISTS lead_lists (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL,
        color      TEXT DEFAULT '',
        team_id    INTEGER,
        owner      TEXT DEFAULT '',
        created_at TEXT DEFAULT ''
      )
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`CREATE INDEX IF NOT EXISTS idx_lead_lists_team  ON lead_lists(team_id)`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`CREATE INDEX IF NOT EXISTS idx_lead_lists_owner ON lead_lists(LOWER(owner))`).catch(e => console.warn('[db] non-fatal:', e && e.message));

    await client.query(`
      CREATE TABLE IF NOT EXISTS lead_list_items (
        list_id INTEGER NOT NULL,
        lead_id INTEGER NOT NULL,
        PRIMARY KEY (list_id, lead_id)
      )
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`CREATE INDEX IF NOT EXISTS idx_lead_list_items_lead ON lead_list_items(lead_id)`).catch(e => console.warn('[db] non-fatal:', e && e.message));

    // ── Products catalog ("major items") — the canonical product list the team
    //    curates. Each product belongs to a division (category, e.g. Adhesives)
    //    and may carry extra alias spellings the importer/AI reads. Scoped like
    //    lead_lists: team-shared when team_id is set, else personal to owner.
    await client.query(`
      CREATE TABLE IF NOT EXISTS products (
        id         SERIAL PRIMARY KEY,
        name       TEXT NOT NULL,
        division   TEXT DEFAULT '',
        aliases    TEXT DEFAULT '',
        team_id    INTEGER,
        owner      TEXT DEFAULT '',
        created_at TEXT DEFAULT ''
      )
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`CREATE INDEX IF NOT EXISTS idx_products_team  ON products(team_id)`).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`CREATE INDEX IF NOT EXISTS idx_products_owner ON products(LOWER(owner))`).catch(e => console.warn('[db] non-fatal:', e && e.message));

    // ── Product aliases — raw import strings mapped to a canonical product.
    //    source: 'ai' (Gemini matched), 'manual' (admin mapped), 'keep-original'
    //    (admin chose to keep the raw string; product_id is NULL). raw_text is
    //    lowercase-unique so a string is only ever decided once.
    await client.query(`
      CREATE TABLE IF NOT EXISTS product_aliases (
        id         SERIAL PRIMARY KEY,
        raw_text   TEXT NOT NULL,
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        source     TEXT DEFAULT 'ai',
        created_at TEXT DEFAULT ''
      )
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_product_aliases_raw ON product_aliases(LOWER(raw_text))`).catch(e => console.warn('[db] non-fatal:', e && e.message));

    // ── Product suggestions — unmatched strings awaiting an admin decision, with
    //    the AI's 1-3 proposed new products (JSONB). status: pending/resolved/ignored.
    await client.query(`
      CREATE TABLE IF NOT EXISTS product_suggestions (
        id          SERIAL PRIMARY KEY,
        raw_text    TEXT NOT NULL,
        suggestions JSONB DEFAULT '[]',
        count       INTEGER DEFAULT 0,
        status      TEXT DEFAULT 'pending',
        created_at  TEXT DEFAULT ''
      )
    `).catch(e => console.warn('[db] non-fatal:', e && e.message));
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_product_suggestions_raw ON product_suggestions(LOWER(raw_text))`).catch(e => console.warn('[db] non-fatal:', e && e.message));

    console.log('✅ PostgreSQL schema ready');
  } finally {
    client.release();
  }
}

// ── READ: all leads with items + contacts ────────────────────
// limit/offset are optional — omitting them keeps the original "return every
// lead" behaviour so existing callers (stats, leadsForRequest) are unchanged.
async function getLeads(limit = null, offset = 0) {
  const params = [];
  let paging = '';
  if (limit != null) { params.push(Number(limit), Number(offset)); paging = ' LIMIT $1 OFFSET $2'; }
  const { rows } = await pool.query(`
    SELECT
      id AS "rowIndex",
      factory_number, factory_name, person_in_charge, contact, designation,
      product, quantity, rate, stage, follow_up, notes, area,
      lead_type, created_by, assigned_to, last_updated, created_at, mapped_stage, stage_number,
      lat, lng, COALESCE(bucket,'working') AS bucket
    FROM leads ORDER BY id ASC${paging}
  `, params);

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
    out.items = itemsByLead[r.rowIndex] || (out.product ? [{ product: out.product, quantity: out.quantity, rate: out.rate }] : []);
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
      lead_type, created_by, assigned_to, last_updated, created_at, mapped_stage, stage_number,
      COALESCE(bucket,'working') AS bucket
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
    out.items = itemsByLead[r.rowIndex] || (out.product ? [{ product: out.product, quantity: out.quantity, rate: out.rate }] : []);
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
  // Database (reference bank) leads are not part of the active pipeline.
  const leads = (await getLeads()).filter(l => (l.bucket || 'working') === 'working');
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
  const bucket = data.bucket === 'database' ? 'database' : 'working';

  // Dedupe within the SAME bucket only — a working lead may mirror a Database
  // entry (that's exactly what "copy to my leads" produces).
  const owner = (createdBy || data.created_by || '').trim();
  const { rows: existing } = await pool.query(
    `SELECT id, factory_number, factory_name FROM leads
       WHERE COALESCE(bucket,'working')=$1
         AND team_id IS NOT DISTINCT FROM $2
         AND ($2 IS NOT NULL OR LOWER(created_by)=LOWER($3))`,
    [bucket, data.team_id || null, owner]);
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
       last_updated, mapped_stage, stage_number, team_id, bucket)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
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
    bucket,
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

// ── WRITE: bulk import (Excel / Google Sheets) ───────────────
// Loads existing factory numbers/names ONCE, then inserts row by row,
// skipping duplicates (against the DB and within the file itself).
async function importLeads(rows, defaultCreatedBy, teamId, listId, bucket = 'working') {
  const dest = bucket === 'database' ? 'database' : 'working';
  // Dedupe only within the destination bucket — importing into the Database
  // never collides with the working sheet and vice-versa.
  const { rows: existing } = await pool.query(
    `SELECT factory_number, factory_name, created_by FROM leads
       WHERE COALESCE(bucket,'working')=$1 AND team_id IS NOT DISTINCT FROM $2`,
    [dest, teamId || null]);
  const sets = new Map();
  const bucketFor = (o) => { const key = teamId ? '' : String(o || '').trim().toLowerCase(); if (!sets.has(key)) sets.set(key, { nums: new Set(), names: new Set() }); return sets.get(key); };
  for (const e of existing) { const b = bucketFor(e.created_by); const n = String(e.factory_number||'').trim().toLowerCase(); if (n) b.nums.add(n); const m = String(e.factory_name||'').trim().toLowerCase(); if (m) b.names.add(m); }

  const now = nowIST();
  let added = 0;
  const skipped = [];

  for (let i = 0; i < rows.length; i++) {
    const r    = rows[i] || {};
    const num  = String(r.factory_number || '').trim();
    const name = String(r.factory_name   || '').trim();
    if (!num && !name) { skipped.push({ row: i + 1, reason: 'no factory name or number' }); continue; }

    const createdBy = String(r.created_by || '').trim() || defaultCreatedBy;
    const b = bucketFor(createdBy);
    const numKey = num.toLowerCase(), nameKey = name.toLowerCase();
    if (numKey && b.nums.has(numKey))            { skipped.push({ row: i + 1, reason: `duplicate factory number "${num}"` }); continue; }
    if (!numKey && nameKey && b.names.has(nameKey)) { skipped.push({ row: i + 1, reason: `duplicate factory name "${name}"` }); continue; }
    const { rows: [newRow] } = await pool.query(`
      INSERT INTO leads
        (factory_number, factory_name, person_in_charge, contact, designation, product,
         quantity, rate, stage, follow_up, notes, area, lead_type, created_by,
         last_updated, mapped_stage, stage_number, team_id, bucket)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      RETURNING id
    `, [
      num, name,
      String(r.person_in_charge || '').trim(),
      String(r.contact || '').trim(),
      '',
      String(r.product || '').trim(),
      String(r.quantity || '').trim(),
      String(r.rate || '').trim(),
      String(r.stage || '').trim(),
      String(r.follow_up || '').trim(),
      String(r.notes || '').trim(),
      String(r.area || '').trim(),
      String(r.lead_type || '').trim(),
      createdBy, now,
      String(r.stage || '').trim(),
      r.stage_number != null && r.stage_number !== '' ? String(r.stage_number) : '',
      teamId || null,
      dest,
    ]);

    // Persist every product as its own line item. A multi-product import row
    // arrives with items[] (one per product); a single-product row falls back to
    // the flat product/quantity/rate columns. Either way each item becomes a
    // lead_items row so the multi-product display/filters see all of them.
    const importItems = Array.isArray(r.items) && r.items.length
      ? r.items
      : (r.product ? [{ product: r.product, quantity: r.quantity, rate: r.rate }] : []);
    for (const it of importItems) {
      const p = String((it && it.product) || '').trim();
      if (!p) continue;
      await pool.query(
        `INSERT INTO lead_items (lead_id, product, quantity, rate) VALUES ($1,$2,$3,$4)`,
        [newRow.id, p, String((it && it.quantity) || '').trim(), String((it && it.rate) || '').trim()]
      ).catch(e => console.warn('[db] non-fatal:', e && e.message));
    }

    if (listId) {
      await pool.query(
        `INSERT INTO lead_list_items (list_id, lead_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
        [listId, newRow.id]
      ).catch(e => console.warn('[db] non-fatal:', e && e.message));
    }

    if (numKey) b.nums.add(numKey);
    if (nameKey) b.names.add(nameKey);
    added++;
  }

  return { added, skipped, total: rows.length };
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
    if (data[f] !== undefined && data[f] !== null) {
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

  if (Array.isArray(data.items)) {
    await pool.query(`DELETE FROM lead_items WHERE lead_id = $1`, [rowIndex]);
    for (const item of data.items) {
      await pool.query(
        `INSERT INTO lead_items (lead_id, product, quantity, rate) VALUES ($1,$2,$3,$4)`,
        [rowIndex, item.product || '', item.quantity || '', item.rate || '']
      );
    }
    const first = data.items[0] || { product: '', quantity: '', rate: '' };
    await pool.query(
      `UPDATE leads SET product = $1, quantity = $2, rate = $3 WHERE id = $4`,
      [first.product || '', first.quantity || '', first.rate || '', rowIndex]
    );
  }

  if (Array.isArray(data.contacts)) {
    const validContacts = data.contacts.filter(c => c.person_name || c.contact);
    const primary = validContacts[0] || { person_name: '', contact: '', designation: '' };
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

// ── Database bucket: copy / move / light field update ─────────
// Copy Database (reference) leads into the working sheet. Originals stay put —
// the Database is a permanent reference bank. Each copy carries the items and
// contacts, and is owned by whoever pulled it in.
async function copyLeadsToWorking(leadIds, createdBy, teamId) {
  const ids = [...new Set((leadIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return { copied: 0, ids: [] };
  const now = nowIST();
  const newIds = [];
  for (const id of ids) {
    const { rows: [src] } = await pool.query(
      `SELECT * FROM leads WHERE id=$1 AND COALESCE(bucket,'working')='database'`, [id]);
    if (!src) continue;
    const { rows: [nw] } = await pool.query(`
      INSERT INTO leads
        (factory_number, factory_name, person_in_charge, contact, designation, product,
         quantity, rate, stage, follow_up, notes, area, lead_type, created_by,
         last_updated, mapped_stage, stage_number, team_id, bucket)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'working')
      RETURNING id
    `, [
      src.factory_number || '', src.factory_name || '', src.person_in_charge || '',
      src.contact || '', src.designation || '', src.product || '', src.quantity || '',
      src.rate || '', src.stage || '', src.follow_up || '', src.notes || '', src.area || '',
      src.lead_type || '', createdBy || src.created_by || '', now,
      src.mapped_stage || src.stage || '', src.stage_number || '', teamId || src.team_id || null,
    ]);
    const { rows: items } = await pool.query(
      `SELECT product, quantity, rate FROM lead_items WHERE lead_id=$1`, [id]);
    for (const it of items) {
      await pool.query(`INSERT INTO lead_items (lead_id, product, quantity, rate) VALUES ($1,$2,$3,$4)`,
        [nw.id, it.product || '', it.quantity || '', it.rate || '']).catch(e => console.warn('[db] non-fatal:', e && e.message));
    }
    const { rows: contacts } = await pool.query(
      `SELECT person_name, contact, designation FROM lead_contacts WHERE lead_id=$1`, [id]);
    for (const c of contacts) {
      await pool.query(`INSERT INTO lead_contacts (lead_id, person_name, contact, designation) VALUES ($1,$2,$3,$4)`,
        [nw.id, c.person_name || '', c.contact || '', c.designation || '']).catch(e => console.warn('[db] non-fatal:', e && e.message));
    }
    newIds.push(nw.id);
  }
  return { copied: newIds.length, ids: newIds };
}

// Flip leads between the working sheet and the Database (declutter / stash).
async function moveLeadsBucket(leadIds, bucket) {
  const dest = bucket === 'database' ? 'database' : 'working';
  const ids  = [...new Set((leadIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return 0;
  const { rowCount } = await pool.query(
    `UPDATE leads SET bucket=$1 WHERE id=ANY($2)`, [dest, ids]);
  return rowCount || 0;
}

// Update only the name/area text fields (used by the "Tidy formatting" pass),
// without disturbing items, contacts or history.
async function updateLeadFields(id, fields) {
  const allowed = ['factory_name', 'person_in_charge', 'area'];
  const sets = [], vals = [];
  for (const k of allowed) {
    if (fields[k] != null) { vals.push(String(fields[k])); sets.push(`${k}=$${vals.length}`); }
  }
  if (!sets.length) return { ok: false };
  vals.push(Number(id));
  await pool.query(`UPDATE leads SET ${sets.join(', ')} WHERE id=$${vals.length}`, vals);
  return { ok: true };
}

// Set a lead's primary product and (optionally) replace its item rows — used by
// the "clean up imported leads" pass to normalise products onto the catalog.
async function setLeadProducts(id, product, items) {
  await pool.query(`UPDATE leads SET product=$1 WHERE id=$2`, [String(product || ''), Number(id)]);
  if (Array.isArray(items)) {
    await pool.query(`DELETE FROM lead_items WHERE lead_id=$1`, [Number(id)]);
    for (const it of items) {
      if (!it || !it.product) continue;
      await pool.query(
        `INSERT INTO lead_items (lead_id, product, quantity, rate) VALUES ($1,$2,$3,$4)`,
        [Number(id), String(it.product), String(it.quantity || ''), String(it.rate || '')]);
    }
  }
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

async function deletePhoto(photoId) {
  const r = await pool.query(`DELETE FROM lead_photos WHERE id = $1 RETURNING lead_id`, [photoId]);
  return { ok: true, deleted: r.rowCount || 0, leadId: r.rows[0] && r.rows[0].lead_id };
}

async function getPhotoById(photoId) {
  const { rows } = await pool.query(`SELECT * FROM lead_photos WHERE id = $1`, [photoId]);
  return rows[0] || null;
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
async function createUser(displayName, pin, role = 'sales', telegramUserId = '', password = '') {
  const { rows: existing } = await pool.query(`SELECT id FROM users WHERE display_name ILIKE $1`, [displayName]);
  if (existing.length) return { ok: false, message: 'Name already taken. Choose another name.' };
  const pinHash      = pin      ? await bcrypt.hash(String(pin), 10)      : null;
  const passwordHash = password ? await bcrypt.hash(String(password), 10) : null;
  await pool.query(
    `INSERT INTO users (display_name, role, pin_hash, password_hash, telegram_user_id, created_at, pro_until, plan_kind)
     VALUES ($1,$2,$3,$4,$5,$6, NOW() + INTERVAL '${TRIAL_DAYS} days', 'trial')`,
    [displayName, role, pinHash, passwordHash, telegramUserId || null, nowIST()]
  );
  return { ok: true };
}

// Verify a real account password (primary credential).
async function verifyUserPassword(displayName, password) {
  const user = await getUserByName(displayName);
  if (!user || !user.password_hash) return null;
  const valid = await bcrypt.compare(String(password || ''), user.password_hash);
  return valid ? user : null;
}

// Set / change a user's password. Successfully setting one always clears any
// pending forced-reset flag — that's the whole point of the flow.
async function setUserPassword(userId, password) {
  const hash = await bcrypt.hash(String(password), 10);
  await pool.query(`UPDATE users SET password_hash = $1, must_change_password = FALSE WHERE id = $2`, [hash, userId]);
  return { ok: true };
}

// Admin-forced reset for one account: doesn't touch the existing credential,
// just flags it so the next successful login is intercepted by the blocking
// set-password step.
async function setMustChangePassword(userId, value) {
  await pool.query(`UPDATE users SET must_change_password = $1 WHERE id = $2`, [!!value, userId]);
  return { ok: true };
}

// Bulk version — flags every account (admins included). Returns how many rows
// were touched so the caller can confirm the scope of what just happened.
async function setMustChangePasswordForAll() {
  const { rowCount } = await pool.query(`UPDATE users SET must_change_password = TRUE`);
  return { ok: true, count: rowCount };
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
    `SELECT id, display_name, role, telegram_user_id, created_at,
            COALESCE(designation, '')  AS designation,
            COALESCE(default_area, '') AS default_area,
            (password_hash IS NOT NULL) AS has_password,
            COALESCE(must_change_password, FALSE) AS must_change_password
       FROM users ORDER BY id ASC`
  );
  return rows;
}

// Change a user's global role. Callers must guard the last-admin case.
async function setUserRole(userId, role) {
  const safe = ['admin', 'sales'].includes(role) ? role : 'sales';
  await pool.query(`UPDATE users SET role = $1 WHERE id = $2`, [safe, userId]);
  return { ok: true };
}

async function setUserDesignation(userId, designation) {
  await pool.query(`UPDATE users SET designation = $1 WHERE id = $2`,
    [String(designation || '').slice(0, 60), userId]);
  return { ok: true };
}

// Set a user's Personal-workspace business type + custom terms. businessType is
// validated against BUSINESS_KEYS (falls back to 'factory'); the custom JSON is
// stored verbatim as a string (caller caps its length).
async function setUserBusiness(userId, businessType, businessCustomJsonString) {
  const type = BUSINESS_KEYS.includes(businessType) ? businessType : 'factory';
  // Normalise (never trust the caller pre-stringified it), and clear custom
  // terms outright for non-custom types so they can't silently resurrect if
  // the user picks 'custom' again later.
  const custom = type === 'custom' ? normBusinessCustom(businessCustomJsonString) : '';
  await pool.query(`UPDATE users SET business_type = $2, business_custom = $3 WHERE id = $1`,
    [userId, type, custom]);
  return { ok: true };
}

// How many active admins exist — used to protect against demoting the last one.
async function getAdminCount() {
  const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin'`);
  return rows[0]?.n || 0;
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

async function updateUserDefaultArea(userId, area) {
  await pool.query(`UPDATE users SET default_area = $1 WHERE id = $2`, [String(area || '').trim(), userId]);
  return { ok: true };
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

// Two apiFetch calls firing at once right as the access token expires (e.g. the
// 60s auto-refresh's Promise.all([loadLeads(), loadStats()])) can both present
// the SAME still-fresh refresh token. Tolerating that as a normal (if slightly
// wasteful) double-rotation — rather than nuking the session — is what actually
// keeps "remember this device" working; a session should only die for a REAL
// stolen/replayed token showing up well after it was already rotated.
const REUSE_GRACE_MS = 10_000;

async function rotateRefreshToken(rawToken) {
  const hash = sha256(rawToken);
  const { rows } = await pool.query(`SELECT * FROM refresh_tokens WHERE token_hash = $1`, [hash]);
  const rt = rows[0];
  if (!rt) throw Object.assign(new Error('Invalid refresh token'), { status: 401 });
  // A revoked session (e.g. from an earlier reuse-attack response, or an
  // explicit logout-all) is dead regardless of any individual token's used/
  // used_at state — checked here, not just by the /api/auth/refresh route, so
  // rotateRefreshToken() is safe to call directly and can't be tricked by a
  // sibling token whose used_at happens to look "fresh".
  const session = await getSessionById(rt.session_id);
  if (!session || session.revoked)
    throw Object.assign(new Error('Session revoked'), { status: 401 });
  if (rt.used) {
    const usedMsAgo = rt.used_at ? Date.now() - new Date(rt.used_at).getTime() : Infinity;
    if (usedMsAgo > REUSE_GRACE_MS) {
      // Well outside the race window — treat as a genuine reuse/replay attack:
      // revoke the entire token family + session.
      await pool.query(`UPDATE refresh_tokens SET used = TRUE, used_at = COALESCE(used_at, NOW()) WHERE family = $1`, [rt.family]);
      await pool.query(`UPDATE sessions SET revoked = TRUE WHERE id = $1`, [rt.session_id]);
      await logSecurity(null, 'token_reuse_attack', { family: rt.family }, '', '', rt.session_id, null);
      throw Object.assign(new Error('Token reuse detected — session revoked for security'), { status: 401 });
    }
    // Within the grace window — almost certainly a benign concurrent-request
    // race, not an attack. Issue another rotation from the same family instead
    // of revoking; harmless if it produces a short-lived unused sibling token.
  } else {
    if (new Date(rt.expires_at) < new Date())
      throw Object.assign(new Error('Refresh token expired'), { status: 401 });
    // Mark old as used
    await pool.query(`UPDATE refresh_tokens SET used = TRUE, used_at = NOW() WHERE id = $1`, [rt.id]);
  }
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

const PIN_LOCK_AT      = 5;    // lock after this many consecutive wrong PINs
const PIN_HARD_LOCK_AT = 10;   // longer lock after this many

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
    // Lock exactly when the threshold is reached (not one attempt later), and
    // report it as 'locked' so the message matches the threshold. locked_until
    // is parameterised — never string-interpolated.
    const lockMinutes = newAttempts >= PIN_HARD_LOCK_AT ? 60
      : (newAttempts >= PIN_LOCK_AT ? 30 : 0);
    if (lockMinutes > 0) {
      await pool.query(
        `UPDATE device_pins SET failed_attempts = $1, locked_until = NOW() + make_interval(mins => $2) WHERE id = $3`,
        [newAttempts, lockMinutes, dp.id]);
      return { ok: false, reason: 'locked', lockMinutes };
    }
    await pool.query(`UPDATE device_pins SET failed_attempts = $1 WHERE id = $2`, [newAttempts, dp.id]);
    return { ok: false, reason: 'wrong_pin', attemptsLeft: Math.max(0, PIN_LOCK_AT - newAttempts) };
  }
  await pool.query(`UPDATE device_pins SET failed_attempts = 0, locked_until = NULL WHERE id = $1`, [dp.id]);
  return { ok: true };
}

async function hasDevicePin(userId, deviceId) {
  const { rows } = await pool.query(
    `SELECT id FROM device_pins WHERE user_id = $1 AND device_id = $2`, [userId, deviceId]
  );
  return rows.length > 0;
}

// ── Small auth lookups (kept out of the route layer) ─────────
async function getUserById(id) {
  const { rows } = await pool.query(`SELECT * FROM users WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function deleteDevicePin(userId, deviceId) {
  await pool.query(`DELETE FROM device_pins WHERE user_id = $1 AND device_id = $2`, [userId, deviceId]);
  return { ok: true };
}

async function revokeSessionsForDevice(deviceId, userId) {
  await pool.query(`UPDATE sessions SET revoked = TRUE WHERE device_id = $1 AND user_id = $2`, [deviceId, userId]);
  return { ok: true };
}

// The (unused, unexpired, non-revoked) session behind a raw refresh token —
// used by pin-check to greet a remembered device without exposing SQL to routes.
async function getActiveRefreshSession(rawToken) {
  const { rows } = await pool.query(
    `SELECT rt.session_id, s.user_id
       FROM refresh_tokens rt JOIN sessions s ON s.id = rt.session_id
      WHERE rt.token_hash = $1 AND NOT rt.used AND rt.expires_at > NOW() AND NOT s.revoked`,
    [sha256(rawToken)]);
  return rows[0] || null;
}

// ── Security log ──────────────────────────────────────────────
async function logSecurity(userId, event, detail, ip, ua, sessionId, deviceId) {
  await pool.query(`
    INSERT INTO security_logs (user_id, event, detail, ip_address, user_agent, session_id, device_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [userId || null, event, JSON.stringify(detail || {}),
     (ip || '').slice(0, 100), (ua || '').slice(0, 500),
     sessionId || null, deviceId || null]
  ).catch(e => console.warn('[db] non-fatal:', e && e.message)); // never let logging break the request
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
    `SELECT t.id, t.name, t.handle, t.team_code, t.business_type, t.business_custom, u.display_name AS owner_name,
       (SELECT COUNT(*) FROM team_members WHERE team_id=t.id AND status='active')::int AS member_count
     FROM teams t LEFT JOIN users u ON t.owner_id=u.id
     WHERE t.public_search=true
       AND (LOWER(t.name) LIKE $1 OR LOWER(t.handle) LIKE $1 OR LOWER(t.team_code) LIKE $1)
     ORDER BY member_count DESC LIMIT 20`, [q]
  );
  return rows;
}

// List public (discoverable) teams — for the new-user "join a team" prompt.
async function getPublicTeams(limit = 12) {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.handle, t.team_code, t.auto_approve, t.business_type, t.business_custom, u.display_name AS owner_name,
       (SELECT COUNT(*) FROM team_members WHERE team_id=t.id AND status='active')::int AS member_count
     FROM teams t LEFT JOIN users u ON t.owner_id=u.id
     WHERE t.public_search=true
     ORDER BY member_count DESC, t.id ASC LIMIT $1`, [Math.min(parseInt(limit, 10) || 12, 50)]
  );
  return rows;
}

// Normalise a business_custom value for storage: accept an object or a JSON
// string. Only the known custom-term fields are kept, each clamped to 60
// chars; unknown keys are dropped and the result is re-stringified. An
// optional `stages` relabel map rides along, sanitized by sanitizeCustomStages
// (canonical stage keys only, labels ≤30 chars) and omitted when empty.
// Capping per-FIELD (not the serialized blob) means a long value can never
// truncate the JSON mid-string and silently drop every other term on read. The
// final slice is a belt, not the mechanism — 7 fields × 60 chars plus 8 stage
// labels × 30 can't reach it.
const BUSINESS_CUSTOM_FIELDS = ['entity', 'entityPlural', 'code', 'name', 'person', 'product', 'area'];
function normBusinessCustom(v) {
  if (v === undefined || v === null || v === '') return '';
  let obj;
  if (typeof v === 'string') {
    try { obj = JSON.parse(v); } catch (_) { return ''; }
  } else {
    obj = v;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return '';
  const out = {};
  for (const key of BUSINESS_CUSTOM_FIELDS) {
    const val = obj[key];
    if (val === undefined || val === null) continue;
    const s = String(val).slice(0, 60);
    if (s) out[key] = s;
  }
  const stages = sanitizeCustomStages(obj.stages);
  if (Object.keys(stages).length) out.stages = stages;
  if (!Object.keys(out).length) return '';
  let str;
  try { str = JSON.stringify(out); } catch (_) { return ''; }
  return str.slice(0, 2000);
}

async function updateTeam(id, { name, handle, publicSearch, autoApprove, businessType, businessCustom }) {
  const sets = []; const vals = []; let i = 1;
  if (name         !== undefined) { sets.push(`name=$${i++}`);          vals.push(name); }
  if (handle       !== undefined) { sets.push(`handle=$${i++}`);        vals.push(handle.replace(/^@/, '')); }
  if (publicSearch !== undefined) { sets.push(`public_search=$${i++}`); vals.push(publicSearch); }
  if (autoApprove  !== undefined) { sets.push(`auto_approve=$${i++}`);  vals.push(autoApprove); }
  // business type: only persist a recognised key; custom terms stored as JSON.
  const settingType = businessType !== undefined && BUSINESS_KEYS.includes(businessType);
  if (settingType) {
    sets.push(`business_type=$${i++}`);   vals.push(businessType);
  }
  // Single SET on business_custom (Postgres rejects assigning a column twice):
  // switching TO a non-custom type always clears stale custom terms in the
  // same write, so they can't silently resurrect if 'custom' is picked again
  // later; otherwise fall through to a normal (possibly untouched) update.
  if (businessCustom !== undefined || (settingType && businessType !== 'custom')) {
    const custom = (settingType && businessType !== 'custom') ? '' : normBusinessCustom(businessCustom);
    sets.push(`business_custom=$${i++}`); vals.push(custom);
  }
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
       t.business_type, t.business_custom,
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

// Team leads. When `memberNames` (an array of lowercased display names) is
// passed — only for team managers/admins — the result ALSO includes leads those
// members created in their Personal workspace (team_id IS NULL), so a manager
// sees every lead of their people, not just the ones tagged to the team.
// Regular members call this with no memberNames and see only team-tagged leads.
async function getLeadsByTeam(teamId, memberNames = null) {
  const includePersonal = Array.isArray(memberNames) && memberNames.length > 0;
  const where  = includePersonal
    ? `WHERE team_id=$1 OR (team_id IS NULL AND LOWER(created_by) = ANY($2::text[]))`
    : `WHERE team_id=$1`;
  const params = includePersonal ? [teamId, memberNames] : [teamId];
  const { rows } = await pool.query(`
    SELECT id AS "rowIndex", factory_number, factory_name, person_in_charge, contact, designation,
      product, quantity, rate, stage, follow_up, notes, area,
      lead_type, created_by, assigned_to, last_updated, created_at, mapped_stage, stage_number,
      lat, lng, team_id, visibility, COALESCE(bucket,'working') AS bucket
    FROM leads ${where} ORDER BY id ASC`, params
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
    out.items    = itemMap[r.rowIndex] || (out.product ? [{ product: out.product, quantity: out.quantity, rate: out.rate }] : []);
    const extras = contactMap[r.rowIndex] || [];
    out.contacts = [
      { id: 'primary', person_name: out.person_in_charge || '', contact: out.contact || '', designation: out.designation || '' },
      ...extras,
    ];
    out.extraContacts = extras;
    return out;
  });
}

// ── Lead lists (tags) ────────────────────────────────────────
// Context: teamId truthy → shared team lists; else personal lists for `owner`.
async function getListsForContext(owner, teamId) {
  const { rows } = teamId
    ? await pool.query(
        `SELECT id, name, color, team_id, owner, created_at
         FROM lead_lists WHERE team_id=$1 ORDER BY LOWER(name)`, [teamId])
    : await pool.query(
        `SELECT id, name, color, team_id, owner, created_at
         FROM lead_lists WHERE team_id IS NULL AND LOWER(owner)=LOWER($1) ORDER BY LOWER(name)`, [owner || '']);
  if (!rows.length) return [];
  const ids = rows.map(r => r.id);
  const { rows: counts } = await pool.query(
    `SELECT list_id, COUNT(*)::int AS n FROM lead_list_items WHERE list_id=ANY($1) GROUP BY list_id`, [ids]);
  const cmap = {};
  for (const c of counts) cmap[c.list_id] = c.n;
  return rows.map(r => ({
    id: r.id, name: r.name || '', color: r.color || '',
    team_id: r.team_id, owner: r.owner || '', count: cmap[r.id] || 0,
  }));
}

async function getListById(id) {
  const { rows } = await pool.query(`SELECT * FROM lead_lists WHERE id=$1`, [id]);
  return rows[0] || null;
}

async function createList(name, color, owner, teamId) {
  const { rows } = await pool.query(
    `INSERT INTO lead_lists (name, color, team_id, owner, created_at)
     VALUES ($1,$2,$3,$4,$5) RETURNING id, name, color, team_id, owner`,
    [String(name || '').trim().slice(0, 60), String(color || '').slice(0, 20), teamId || null, owner || '', nowIST()]
  );
  return { ...rows[0], count: 0 };
}

async function renameList(id, name, color) {
  const sets = [];
  const vals = [];
  if (name != null)  { vals.push(String(name).trim().slice(0, 60)); sets.push(`name=$${vals.length}`); }
  if (color != null) { vals.push(String(color).slice(0, 20));       sets.push(`color=$${vals.length}`); }
  if (!sets.length) return getListById(id);
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE lead_lists SET ${sets.join(', ')} WHERE id=$${vals.length} RETURNING id, name, color, team_id, owner`, vals);
  return rows[0] || null;
}

async function deleteList(id) {
  await pool.query(`DELETE FROM lead_list_items WHERE list_id=$1`, [id]);
  await pool.query(`DELETE FROM lead_lists WHERE id=$1`, [id]);
}

// ── Products catalog ("major items") ─────────────────────────
// Scoped like lead_lists: team-shared when teamId is set, else personal.
async function getProductsForContext(owner, teamId) {
  const { rows } = teamId
    ? await pool.query(
        `SELECT id, name, division, aliases, team_id, owner, created_at
         FROM products WHERE team_id=$1 ORDER BY LOWER(division), LOWER(name)`, [teamId])
    : await pool.query(
        `SELECT id, name, division, aliases, team_id, owner, created_at
         FROM products WHERE team_id IS NULL AND LOWER(owner)=LOWER($1)
         ORDER BY LOWER(division), LOWER(name)`, [owner || '']);
  return rows.map(r => ({
    id: r.id, name: r.name || '', division: r.division || '',
    aliases: r.aliases || '', team_id: r.team_id, owner: r.owner || '',
    created_at: r.created_at || '',
  }));
}

async function getProductById(id) {
  const { rows } = await pool.query(`SELECT * FROM products WHERE id=$1`, [id]);
  return rows[0] || null;
}

async function createProduct(name, division, aliases, owner, teamId) {
  const { rows } = await pool.query(
    `INSERT INTO products (name, division, aliases, team_id, owner, created_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, division, aliases, team_id, owner`,
    [String(name || '').trim().slice(0, 80), String(division || '').trim().slice(0, 60),
     String(aliases || '').trim().slice(0, 400), teamId || null, owner || '', nowIST()]);
  return rows[0];
}

async function updateProduct(id, { name, division, aliases }) {
  const sets = [], vals = [];
  if (name != null)     { vals.push(String(name).trim().slice(0, 80));     sets.push(`name=$${vals.length}`); }
  if (division != null) { vals.push(String(division).trim().slice(0, 60)); sets.push(`division=$${vals.length}`); }
  if (aliases != null)  { vals.push(String(aliases).trim().slice(0, 400)); sets.push(`aliases=$${vals.length}`); }
  if (!sets.length) return getProductById(id);
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE products SET ${sets.join(', ')} WHERE id=$${vals.length}
     RETURNING id, name, division, aliases, team_id, owner`, vals);
  return rows[0] || null;
}

async function deleteProduct(id) {
  await pool.query(`DELETE FROM products WHERE id=$1`, [id]);
}

// Bulk-remove catalog items, but only ones inside the caller's context (their
// own team or their personal list) so a request can never delete another team's
// products. Returns the number of rows actually removed.
async function deleteProductsScoped(ids, owner, teamId) {
  const clean = [...new Set((ids || []).map(n => parseInt(n, 10)).filter(Boolean))];
  if (!clean.length) return 0;
  const r = teamId
    ? await pool.query(`DELETE FROM products WHERE id = ANY($1) AND team_id=$2`, [clean, teamId])
    : await pool.query(
        `DELETE FROM products WHERE id = ANY($1) AND team_id IS NULL AND LOWER(owner)=LOWER($2)`,
        [clean, owner || '']);
  return r.rowCount || 0;
}

// ── Product aliases + AI resolution ──────────────────────────
async function getAliases() {
  const { rows } = await pool.query(
    `SELECT a.id, a.raw_text, a.product_id, a.source, p.name AS product_name
       FROM product_aliases a LEFT JOIN products p ON p.id = a.product_id`);
  return rows;
}

// Upsert an alias for a raw string. productId null = "keep original" decision.
async function saveAlias(rawText, productId, source = 'ai') {
  const raw = String(rawText || '').trim();
  if (!raw) return null;
  const { rows } = await pool.query(
    `INSERT INTO product_aliases (raw_text, product_id, source, created_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (LOWER(raw_text)) DO UPDATE
       SET product_id = EXCLUDED.product_id, source = EXCLUDED.source
     RETURNING id`,
    [raw, productId || null, source, nowIST()]);
  return rows[0] || null;
}

// Resolve raw product strings against a context's catalog + the alias table.
// Returns { resolved: {raw: canonicalName}, unresolved: [raw] }. A 'keep-original'
// alias resolves to itself (no change, never flagged for review).
async function resolveProducts(rawStrings, owner, teamId) {
  const uniq = [...new Set((rawStrings || []).map(s => String(s || '').trim()).filter(Boolean))];
  const resolved = {}, unresolved = [];
  if (!uniq.length) return { resolved, unresolved };

  const catalog = await getProductsForContext(owner, teamId);
  const nameByLower = {};
  for (const p of catalog) nameByLower[p.name.toLowerCase()] = p.name;

  const { rows: aliases } = await pool.query(
    `SELECT LOWER(a.raw_text) AS k, a.source, p.name AS product_name
       FROM product_aliases a LEFT JOIN products p ON p.id = a.product_id`);
  const aliasByLower = {};
  for (const a of aliases) aliasByLower[a.k] = a;

  for (const raw of uniq) {
    const lower = raw.toLowerCase();
    if (nameByLower[lower]) { resolved[raw] = nameByLower[lower]; continue; }   // already canonical
    const a = aliasByLower[lower];
    if (a) {
      if (a.source === 'keep-original' || !a.product_name) resolved[raw] = raw; // intentionally kept
      else resolved[raw] = a.product_name;
      continue;
    }
    unresolved.push(raw);
  }
  return { resolved, unresolved };
}

// Rewrite every lead_items.product and leads.product cell matching `raw`
// (case-insensitive) to the canonical name. Returns rows touched.
async function rewriteProductValue(raw, canonical) {
  const r1 = await pool.query(`UPDATE lead_items SET product=$1 WHERE LOWER(product)=LOWER($2)`, [canonical, raw]);
  const r2 = await pool.query(`UPDATE leads      SET product=$1 WHERE LOWER(product)=LOWER($2)`, [canonical, raw]);
  return (r1.rowCount || 0) + (r2.rowCount || 0);
}

// Persist/refresh an unmatched string + its AI suggestions for admin review.
async function upsertSuggestion(rawText, suggestions, addCount = 0) {
  const raw = String(rawText || '').trim();
  if (!raw) return;
  await pool.query(
    `INSERT INTO product_suggestions (raw_text, suggestions, count, status, created_at)
     VALUES ($1,$2,$3,'pending',$4)
     ON CONFLICT (LOWER(raw_text)) DO UPDATE
       SET suggestions = EXCLUDED.suggestions,
           count = product_suggestions.count + EXCLUDED.count,
           status = CASE WHEN product_suggestions.status='resolved' THEN 'resolved' ELSE 'pending' END`,
    [raw, JSON.stringify(suggestions || []), addCount, nowIST()]);
}

async function getPendingSuggestions() {
  const { rows } = await pool.query(
    `SELECT raw_text, suggestions, count FROM product_suggestions WHERE status='pending' ORDER BY count DESC, raw_text`);
  return rows;
}

async function setSuggestionStatus(rawText, status) {
  await pool.query(`UPDATE product_suggestions SET status=$1 WHERE LOWER(raw_text)=LOWER($2)`, [status, String(rawText || '')]);
}

// Distinct product strings currently in use (items + primary), with counts.
async function distinctProductValues() {
  const { rows } = await pool.query(`
    SELECT product AS value, COUNT(*)::int AS n FROM (
      SELECT product FROM lead_items WHERE COALESCE(product,'') <> ''
      UNION ALL
      SELECT product FROM leads WHERE COALESCE(product,'') <> ''
    ) t GROUP BY product`);
  return rows;
}

// Replace a lead's memberships, but only within the given scope of list ids
// (so tagging in the personal view can't wipe the lead's team tags, or vice-versa).
async function setLeadListMemberships(leadId, listIds, scopeListIds) {
  const scope = (scopeListIds || []).map(Number);
  const wanted = (listIds || []).map(Number).filter(id => scope.includes(id));
  if (scope.length) {
    await pool.query(`DELETE FROM lead_list_items WHERE lead_id=$1 AND list_id=ANY($2)`, [leadId, scope]);
  }
  for (const listId of wanted) {
    await pool.query(
      `INSERT INTO lead_list_items (list_id, lead_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [listId, leadId]);
  }
  return wanted;
}

// Additively file many leads into one list (used by "assign all shown to a
// list"). Never removes existing memberships. Returns how many rows were newly
// added (duplicates are ignored via the primary key).
async function addLeadsToList(listId, leadIds) {
  const ids = [...new Set((leadIds || []).map(Number).filter(Boolean))];
  if (!ids.length) return 0;
  const { rowCount } = await pool.query(
    `INSERT INTO lead_list_items (list_id, lead_id)
       SELECT $1, x FROM unnest($2::int[]) AS x
       ON CONFLICT DO NOTHING`,
    [Number(listId), ids]);
  return rowCount || 0;
}

// leadId → [{id,name,color}] for the lists visible in the given context.
async function getListMembershipsForLeads(leadIds, owner, teamId) {
  if (!leadIds || !leadIds.length) return {};
  const ids = leadIds.map(Number);
  const { rows } = teamId
    ? await pool.query(
        `SELECT li.lead_id, l.id, l.name, l.color
         FROM lead_list_items li JOIN lead_lists l ON l.id=li.list_id
         WHERE li.lead_id=ANY($1) AND l.team_id=$2`, [ids, teamId])
    : await pool.query(
        `SELECT li.lead_id, l.id, l.name, l.color
         FROM lead_list_items li JOIN lead_lists l ON l.id=li.list_id
         WHERE li.lead_id=ANY($1) AND l.team_id IS NULL AND LOWER(l.owner)=LOWER($2)`, [ids, owner || '']);
  const map = {};
  for (const r of rows) {
    (map[r.lead_id] = map[r.lead_id] || []).push({ id: r.id, name: r.name || '', color: r.color || '' });
  }
  return map;
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
  ).catch(e => console.warn('[db] non-fatal:', e && e.message));
}

// ── Lead security helpers ─────────────────────────────────────
async function getLeadById(id) {
  const { rows } = await pool.query(`SELECT * FROM leads WHERE id=$1`, [id]);
  return rows[0] || null;
}

// 'team' = visible to everyone in the team; 'private' = hidden from other
// salespeople (still visible to the owner and team managers/admins).
async function setLeadVisibility(rowIndex, visibility) {
  const v = visibility === 'private' ? 'private' : 'team';
  await pool.query(`UPDATE leads SET visibility=$1 WHERE id=$2`, [v, rowIndex]);
  return { ok: true, visibility: v };
}

async function userHasLeadAccess(leadId, username) {
  const { rows } = await pool.query(
    `SELECT 1 FROM lead_access WHERE lead_id=$1 AND user_display_name=$2`, [leadId, username]
  );
  return rows.length > 0;
}

async function getAccessibleLeadIds(username) {
  const { rows } = await pool.query(
    `SELECT lead_id FROM lead_access WHERE user_display_name=$1`, [username]
  );
  return new Set(rows.map(r => r.lead_id));
}

// ── Lead share requests ───────────────────────────────────────
async function createLeadShareRequest(leadId, teamId, requester, owner, message = '') {
  const { rows } = await pool.query(
    `INSERT INTO lead_share_requests (lead_id, team_id, requester, owner, message)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (lead_id, requester) DO UPDATE
       SET status='pending', message=EXCLUDED.message, owner=EXCLUDED.owner,
           team_id=EXCLUDED.team_id, reviewed_by='', updated_at=NOW()
     RETURNING *`,
    [leadId, teamId || null, requester, owner || '', message]
  );
  return rows[0];
}

async function getLeadShareRequestById(id) {
  const { rows } = await pool.query(`SELECT * FROM lead_share_requests WHERE id=$1`, [id]);
  return rows[0] || null;
}

async function getIncomingLeadRequests(username, isAdmin = false) {
  const cond = isAdmin ? '' : 'WHERE r.owner = $1';
  const vals = isAdmin ? [] : [username];
  const { rows } = await pool.query(
    `SELECT r.*, l.factory_number, l.factory_name
     FROM lead_share_requests r JOIN leads l ON l.id = r.lead_id
     ${cond} ORDER BY r.created_at DESC LIMIT 100`, vals
  );
  return rows;
}

async function getOutgoingLeadRequests(username) {
  const { rows } = await pool.query(
    `SELECT r.*, l.factory_number, l.factory_name
     FROM lead_share_requests r JOIN leads l ON l.id = r.lead_id
     WHERE r.requester = $1 ORDER BY r.created_at DESC LIMIT 100`, [username]
  );
  return rows;
}

async function reviewLeadShareRequest(id, status, reviewedBy) {
  await pool.query(
    `UPDATE lead_share_requests SET status=$1, reviewed_by=$2, updated_at=NOW() WHERE id=$3`,
    [status, reviewedBy || '', id]
  );
}

// ── Lead activity timeline ────────────────────────────────────
async function logLeadActivity(leadId, teamId, activityType, description, metadata, performedBy) {
  await pool.query(
    `INSERT INTO lead_activities (lead_id, team_id, activity_type, description, metadata, performed_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [leadId, teamId || null, activityType, description || '', JSON.stringify(metadata || {}), performedBy]
  ).catch(e => console.warn('[db] non-fatal:', e && e.message));
}

async function getLeadActivities(leadId) {
  const { rows } = await pool.query(
    `SELECT id, activity_type, description, metadata, performed_by, created_at
     FROM lead_activities WHERE lead_id=$1 ORDER BY created_at DESC`,
    [leadId]
  );
  return rows;
}

// ── Team tasks ────────────────────────────────────────────────
const TASK_STATUSES = ['open', 'doing', 'done'];

async function createTask(t) {
  const status = TASK_STATUSES.includes(t.status) ? t.status : 'open';
  const { rows } = await pool.query(
    `INSERT INTO team_tasks (team_id, title, assignee, created_by, lead_id, lead_label, due_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [t.teamId || null, String(t.title).trim(), String(t.assignee || '').trim(), t.createdBy,
     t.leadId || null, String(t.leadLabel || '').trim(), String(t.dueAt || '').trim(), status]
  );
  return rows[0];
}

// Team board (all tasks for a team) or, when teamId is null, the caller's own
// personal tasks (created_by = owner, no team).
async function getTasks(teamId, owner) {
  const { rows } = teamId
    ? await pool.query(`SELECT * FROM team_tasks WHERE team_id=$1 ORDER BY created_at DESC`, [teamId])
    : await pool.query(`SELECT * FROM team_tasks WHERE team_id IS NULL AND LOWER(created_by)=LOWER($1) ORDER BY created_at DESC`, [owner || '']);
  return rows;
}

async function getTaskById(id) {
  const { rows } = await pool.query(`SELECT * FROM team_tasks WHERE id=$1`, [parseInt(id, 10) || 0]);
  return rows[0] || null;
}

async function updateTask(id, fields) {
  const allowed = ['title', 'assignee', 'lead_id', 'lead_label', 'due_at', 'status'];
  const sets = [], vals = [];
  for (const k of allowed) {
    if (fields[k] === undefined) continue;
    if (k === 'status' && !TASK_STATUSES.includes(fields[k])) continue;
    sets.push(`${k}=$${sets.length + 1}`);
    vals.push(k === 'lead_id' ? (fields[k] || null) : fields[k]);
  }
  if (!sets.length) return getTaskById(id);
  vals.push(parseInt(id, 10) || 0);
  const { rows } = await pool.query(
    `UPDATE team_tasks SET ${sets.join(', ')}, updated_at=NOW() WHERE id=$${vals.length} RETURNING *`, vals);
  return rows[0] || null;
}

async function deleteTask(id) {
  const r = await pool.query(`DELETE FROM team_tasks WHERE id=$1`, [parseInt(id, 10) || 0]);
  return { ok: true, deleted: r.rowCount || 0 };
}

// ── Team Hub: chat ────────────────────────────────────────────
async function addTeamMessage(teamId, sender, body, kind) {
  const { rows } = await pool.query(
    `INSERT INTO team_messages (team_id, sender, body, kind) VALUES ($1,$2,$3,$4) RETURNING *`,
    [teamId, String(sender || '').trim(), String(body || '').slice(0, 4000), kind || 'msg']);
  return rows[0];
}
async function getTeamMessages(teamId, afterId, limit) {
  const after = parseInt(afterId, 10) || 0;
  const lim = Math.max(1, Math.min(200, parseInt(limit, 10) || 80));
  if (after) {
    const { rows } = await pool.query(
      `SELECT * FROM team_messages WHERE team_id=$1 AND id>$2 ORDER BY id ASC LIMIT $3`, [teamId, after, lim]);
    return rows;
  }
  // Newest `lim`, returned oldest-first for natural chat order.
  const { rows } = await pool.query(
    `SELECT * FROM (SELECT * FROM team_messages WHERE team_id=$1 ORDER BY id DESC LIMIT $2) t ORDER BY id ASC`,
    [teamId, lim]);
  return rows;
}

// ── Team Hub: activity feed ───────────────────────────────────
// Non-lead events (tasks, chat milestones) live in team_activity; lead events
// already live in lead_activities. getTeamActivity merges + normalises both.
async function logTeamActivity(teamId, actor, verb, objectType, objectLabel, meta) {
  if (!teamId) return;
  await pool.query(
    `INSERT INTO team_activity (team_id, actor, verb, object_type, object_label, meta)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [teamId, String(actor || '').trim(), verb, objectType || '', String(objectLabel || '').slice(0, 200),
     JSON.stringify(meta || {})]).catch(e => console.warn('[db] non-fatal:', e && e.message));
}
async function getTeamActivity(teamId, limit) {
  const lim = Math.max(1, Math.min(120, parseInt(limit, 10) || 60));
  const [teamRows, leadRows] = await Promise.all([
    pool.query(`SELECT actor, verb, object_type, object_label, created_at
                  FROM team_activity WHERE team_id=$1 ORDER BY created_at DESC LIMIT $2`, [teamId, lim]),
    pool.query(`SELECT la.performed_by AS actor, la.activity_type AS verb, la.description,
                       l.factory_name, l.factory_number, la.created_at
                  FROM lead_activities la LEFT JOIN leads l ON l.id = la.lead_id
                 WHERE la.team_id=$1 ORDER BY la.created_at DESC LIMIT $2`, [teamId, lim]),
  ]);
  const items = [];
  for (const r of teamRows.rows) items.push({
    actor: r.actor, verb: r.verb, objectType: r.object_type, label: r.object_label,
    created_at: r.created_at, source: 'team',
  });
  for (const r of leadRows.rows) {
    const label = (r.factory_name || r.factory_number || '').toString().trim();
    items.push({ actor: r.actor, verb: r.verb, objectType: 'lead', label,
      text: r.description, created_at: r.created_at, source: 'lead' });
  }
  items.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return items.slice(0, lim);
}

// ── Team Hub: presence + leaderboard ──────────────────────────
async function touchLastSeen(userId) {
  if (!userId) return;
  await pool.query(`UPDATE users SET last_seen_at=NOW() WHERE id=$1`, [userId])
    .catch(e => console.warn('[db] non-fatal:', e && e.message));
}
async function getTeamPresence(teamId) {
  const { rows } = await pool.query(
    `SELECT u.display_name AS name, u.last_seen_at,
            (u.last_seen_at IS NOT NULL AND u.last_seen_at > NOW() - INTERVAL '3 minutes') AS online
       FROM team_members tm JOIN users u ON u.id=tm.user_id
      WHERE tm.team_id=$1 AND tm.status='active'`, [teamId]);
  return rows;
}
// Sales leaderboard from the team's leads + completed tasks. Transparent scoring:
// total leads + hot*2 + tasksDone*3, ranked desc.
async function getTeamLeaderboard(teamId) {
  const [leadAgg, taskAgg, presence] = await Promise.all([
    pool.query(
      `SELECT created_by AS name,
              COUNT(*) AS total,
              COUNT(*) FILTER (WHERE LOWER(COALESCE(lead_type,'')) LIKE 'hot%') AS hot
         FROM leads WHERE team_id=$1 AND COALESCE(created_by,'') <> ''
        GROUP BY created_by`, [teamId]),
    pool.query(
      `SELECT assignee AS name, COUNT(*) AS done
         FROM team_tasks WHERE team_id=$1 AND status='done' AND COALESCE(assignee,'') <> ''
        GROUP BY assignee`, [teamId]),
    getTeamPresence(teamId),
  ]);
  const map = {};
  const key = n => String(n || '').trim().toLowerCase();
  for (const m of presence) if (m.name) map[key(m.name)] = { name: m.name, total: 0, hot: 0, done: 0, online: !!m.online };
  for (const r of leadAgg.rows) {
    const k = key(r.name); if (!k) continue;
    map[k] = map[k] || { name: r.name, total: 0, hot: 0, done: 0, online: false };
    map[k].total = parseInt(r.total, 10) || 0;
    map[k].hot   = parseInt(r.hot, 10) || 0;
  }
  for (const r of taskAgg.rows) {
    const k = key(r.name); if (!k) continue;
    map[k] = map[k] || { name: r.name, total: 0, hot: 0, done: 0, online: false };
    map[k].done = parseInt(r.done, 10) || 0;
  }
  const list = Object.values(map).map(p => ({ ...p, score: p.total + p.hot * 2 + p.done * 3 }));
  list.sort((a, b) => b.score - a.score || b.total - a.total);
  return list;
}

// ── Pro entitlement + access codes ────────────────────────────
const TRIAL_DAYS = 14;

// Derive a user's plan from their row. Global admins (the dev) are always Pro.
function entitlementOf(user) {
  if (!user) return { isPro: false, plan: 'lite', proUntil: null, daysLeft: 0 };
  if (String(user.role) === 'admin') return { isPro: true, plan: 'admin', proUntil: null, daysLeft: null };
  const until = user.pro_until ? new Date(user.pro_until).getTime() : 0;
  const now = Date.now();
  if (until > now) {
    return { isPro: true, plan: user.plan_kind || 'pro', proUntil: user.pro_until,
             daysLeft: Math.ceil((until - now) / 86400000), kind: user.plan_kind || 'pro' };
  }
  return { isPro: false, plan: 'lite', proUntil: user.pro_until || null, daysLeft: 0, kind: user.plan_kind || '' };
}

// Extend a user's Pro window by N days from the later of now / current expiry.
async function extendUserPro(userId, days, planKind) {
  const { rows } = await pool.query(
    `UPDATE users
        SET pro_until = GREATEST(COALESCE(pro_until, NOW()), NOW()) + ($2 || ' days')::interval,
            plan_kind = $3
      WHERE id = $1
      RETURNING pro_until`,
    [userId, String(parseInt(days, 10) || 0), planKind || 'code']);
  return rows[0] ? rows[0].pro_until : null;
}

async function createAccessCode({ code, days, label, maxUses, createdBy }) {
  const { rows } = await pool.query(
    `INSERT INTO access_codes (code, days, label, max_uses, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [String(code).toUpperCase(), parseInt(days, 10) || 30, String(label || '').slice(0, 120),
     parseInt(maxUses, 10) || 1, createdBy || '']);
  return rows[0];
}
async function getAccessCodes() {
  const { rows } = await pool.query(`SELECT * FROM access_codes ORDER BY created_at DESC`);
  return rows;
}
async function deleteAccessCode(id) {
  const r = await pool.query(`DELETE FROM access_codes WHERE id=$1`, [parseInt(id, 10) || 0]);
  return { ok: true, deleted: r.rowCount || 0 };
}

// Redeem a code for a user: validate remaining uses, block double-redeem, extend Pro.
async function redeemAccessCode(rawCode, userId) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return { ok: false, error: 'Enter a code' };
  const { rows } = await pool.query(`SELECT * FROM access_codes WHERE UPPER(code)=$1`, [code]);
  const rec = rows[0];
  if (!rec) return { ok: false, error: 'That code isn’t valid' };
  if (rec.uses >= rec.max_uses) return { ok: false, error: 'This code has already been used up' };
  try {
    await pool.query(`INSERT INTO access_code_redemptions (code, user_id) VALUES ($1,$2)`, [rec.code, userId]);
  } catch (e) {
    return { ok: false, error: 'You’ve already redeemed this code' };
  }
  await pool.query(`UPDATE access_codes SET uses = uses + 1 WHERE id=$1`, [rec.id]);
  const proUntil = await extendUserPro(userId, rec.days, 'code');
  return { ok: true, days: rec.days, proUntil };
}

// ── Payments (Razorpay orders ledger) ─────────────────────────
async function createPayment(row) {
  const r = row || {};
  const { rows } = await pool.query(
    `INSERT INTO payments (user_id, team_id, plan_kind, seats, amount_paise, order_id, payment_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING *`,
    [
      parseInt(r.user_id, 10),
      r.team_id != null && r.team_id !== '' ? parseInt(r.team_id, 10) : null,
      String(r.plan_kind || ''),
      parseInt(r.seats, 10) || 1,
      parseInt(r.amount_paise, 10) || 0,
      String(r.order_id || ''),
      String(r.payment_id || ''),
      String(r.status || 'created'),
    ]);
  return rows[0];
}

async function getPaymentByOrderId(orderId) {
  const { rows } = await pool.query(`SELECT * FROM payments WHERE order_id = $1`, [String(orderId || '')]);
  return rows[0] || null;
}

// Idempotent settle: only a still-unpaid order flips to 'paid' (WHERE status <>
// 'paid'), so a repeated verify can never rewrite paid_at / payment_id or open
// the door to a second grant.
async function markPaymentPaid(orderId, paymentId) {
  const { rows } = await pool.query(
    `UPDATE payments
        SET status = 'paid', payment_id = $2, paid_at = NOW()
      WHERE order_id = $1 AND status <> 'paid'
      RETURNING *`,
    [String(orderId || ''), String(paymentId || '')]);
  return rows[0] || null;
}

// Single-flip grant guard: only the caller that flips granted_at NULL→NOW() gets
// a row back, so the Pro grant runs exactly once even across concurrent verify
// retries. Decoupled from markPaymentPaid so a paid-but-ungranted order can still
// be completed on a later retry.
async function markPaymentGranted(orderId) {
  const { rows } = await pool.query(
    `UPDATE payments
        SET granted_at = NOW()
      WHERE order_id = $1 AND granted_at IS NULL
      RETURNING *`,
    [String(orderId || '')]);
  return rows[0] || null;
}

// ── Referral program ──────────────────────────────────────────
// Pure code generator: 'DIVE-' + 6 chars from A–Z0–9, seeded by crypto random
// bytes. The DB unique index is the real collision backstop. Exported so it can
// be unit-tested in isolation.
function genReferralCode() {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const bytes = crypto.randomBytes(6);
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return 'DIVE-' + s;
}

// Return the user's referral code, generating + persisting one on first read.
// Retries on the (astronomically rare) unique collision, max 5 attempts.
async function getOrCreateReferralCode(userId) {
  const uid = parseInt(userId, 10);
  if (!uid) return null;
  const { rows } = await pool.query(`SELECT referral_code FROM users WHERE id = $1`, [uid]);
  if (!rows.length) return null;
  const existing = rows[0].referral_code;
  if (existing && String(existing).trim()) return existing;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = genReferralCode();
    try {
      const { rows: upd } = await pool.query(
        `UPDATE users SET referral_code = $1
          WHERE id = $2 AND (referral_code IS NULL OR referral_code = '')
          RETURNING referral_code`, [code, uid]);
      if (upd.length) return upd[0].referral_code;
      // Set concurrently by another request — return whatever is stored now.
      const { rows: cur } = await pool.query(`SELECT referral_code FROM users WHERE id = $1`, [uid]);
      return cur.length ? cur[0].referral_code : null;
    } catch (e) {
      // 23505 = unique_violation: this code is taken, try a fresh one.
      if (e && e.code === '23505' && attempt < 4) continue;
      throw e;
    }
  }
  return null;
}

async function findUserByReferralCode(code) {
  const c = String(code || '').trim();
  if (!c) return null;
  const { rows } = await pool.query(`SELECT * FROM users WHERE UPPER(referral_code) = UPPER($1)`, [c]);
  return rows[0] || null;
}

// How many referrals this user has been CREDITED for in the trailing year — the
// cap (10) is enforced against this count.
async function countCreditedReferrals(referrerUserId) {
  const uid = parseInt(referrerUserId, 10);
  if (!uid) return 0;
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM referrals
      WHERE referrer_user_id = $1 AND credited = TRUE
        AND created_at > NOW() - INTERVAL '365 days'`, [uid]);
  return rows[0] ? rows[0].n : 0;
}

async function createReferral(row) {
  const r = row || {};
  const { rows } = await pool.query(
    `INSERT INTO referrals (referrer_user_id, referred_user_id, code, source, credited)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [
      r.referrer_user_id != null ? parseInt(r.referrer_user_id, 10) : null,
      parseInt(r.referred_user_id, 10),
      String(r.code || ''),
      String(r.source || 'referral'),
      !!r.credited,
    ]);
  return rows[0];
}

// Bump Pro by N days WITHOUT overwriting an existing plan_kind — only labels it
// 'referral' when the account had no plan label yet. Used for referrer credit.
async function extendUserProDaysPreservingKind(userId, days) {
  const uid = parseInt(userId, 10);
  if (!uid) return null;
  const { rows } = await pool.query(
    `UPDATE users
        SET pro_until = GREATEST(COALESCE(pro_until, NOW()), NOW()) + ($2 || ' days')::interval,
            plan_kind = CASE WHEN plan_kind IS NULL OR plan_kind = '' THEN 'referral' ELSE plan_kind END
      WHERE id = $1
      RETURNING pro_until`,
    [uid, String(parseInt(days, 10) || 0)]);
  return rows[0] ? rows[0].pro_until : null;
}

// Orchestrates the referral grant for a just-created account. Best-effort and
// self-contained (it swallows its own errors) so a referral hiccup can NEVER
// break registration. Returns { referralApplied, referralDays }: referralApplied
// is true only when the code resolved and the new user's 60-day grant was
// written (which REPLACES the 14-day trial). Mirrors the referral spec's steps
// 1–4; the caller adds step 5 (surfacing referralApplied/referralDays in its
// response). The self-referral fingerprint guard runs only when a fingerprint is
// supplied — /register sends one (public/app.js getDeviceFingerprint()), so the
// device check below is active.
async function applyRegistrationReferral({ newUserId, newUserName, code, fingerprint } = {}) {
  const result = { referralApplied: false, referralDays: 0 };
  try {
    const raw = String(code || '').trim().slice(0, 40);
    if (!raw) return result;

    let referredId = newUserId != null ? parseInt(newUserId, 10) : null;
    if (!referredId && newUserName) {
      const u = await getUserByName(newUserName);
      referredId = u ? u.id : null;
    }
    if (!referredId) return result;

    // 1. Resolve the code → referrer + source (referral code first, then team invite).
    let referrerId = null, source = null;
    const refUser = await findUserByReferralCode(raw);
    if (refUser) { referrerId = refUser.id; source = 'referral'; }
    else {
      const team = await getTeamByInviteCode(raw);
      if (team) { referrerId = team.owner_id || null; source = 'team_invite'; }
    }
    if (!source) return result; // unresolved → skip silently

    // 2. New user gets 60 days — REPLACES the default trial (absolute, not additive).
    await pool.query(
      `UPDATE users SET pro_until = NOW() + INTERVAL '60 days', plan_kind = 'referral' WHERE id = $1`,
      [referredId]);
    result.referralApplied = true;
    result.referralDays = 60;

    // 3. Referrer credit (+14 days), gated by: referrer exists & isn't the new
    //    user, under the yearly cap, and (when a fingerprint is supplied) the
    //    signup isn't from the referrer's own device.
    let credited = false;
    if (referrerId && referrerId !== referredId) {
      const count = await countCreditedReferrals(referrerId);
      if (count < 10) {
        let selfDevice = false;
        if (fingerprint) {
          try { selfDevice = !!(await getDeviceByFingerprint(referrerId, fingerprint)); }
          catch (_) { selfDevice = false; }
        }
        if (!selfDevice) {
          await extendUserProDaysPreservingKind(referrerId, 14);
          credited = true;
        }
      }
    }

    // 4. Record the referral (credited reflects whether step 3 granted).
    await createReferral({ referrer_user_id: referrerId, referred_user_id: referredId, code: raw, source, credited });
  } catch (e) {
    console.warn('[db] referral non-fatal:', e && e.message);
  }
  return result;
}

// ── Field-level edit history ──────────────────────────────────
async function logLeadHistory(leadId, changedBy, fieldName, oldValue, newValue, teamId) {
  await pool.query(
    `INSERT INTO lead_history (lead_id, changed_by, field_name, old_value, new_value, team_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [leadId, changedBy, fieldName, String(oldValue ?? ''), String(newValue ?? ''), teamId || null]
  ).catch(e => console.warn('[db] non-fatal:', e && e.message));
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

async function getDepartmentById(id) {
  const { rows } = await pool.query(`SELECT * FROM departments WHERE id=$1`, [id]);
  return rows[0] || null;
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
  ).catch(e => console.warn('[db] non-fatal:', e && e.message));
}

// How many times has this user made this exact correction?
async function countSameCorrection(userId, fieldName, originalValue, correctedValue) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM ai_corrections
     WHERE user_id = $1 AND field_name = $2
       AND LOWER(original_value) = LOWER($3) AND LOWER(corrected_value) = LOWER($4)`,
    [userId, fieldName, originalValue, correctedValue]
  );
  return rows[0]?.n || 0;
}

// Recurring corrections (2+ times) for this user/team — fed back into the prompt
async function getLearnedCorrections(userId, teamId) {
  const { rows } = await pool.query(
    `SELECT field_name, original_value, corrected_value, COUNT(*)::int AS times
     FROM ai_corrections
     WHERE original_value <> '' AND corrected_value <> ''
       AND LOWER(original_value) <> LOWER(corrected_value)
       AND (($1::int IS NOT NULL AND user_id = $1) OR ($2::int IS NOT NULL AND team_id = $2))
     GROUP BY field_name, original_value, corrected_value
     HAVING COUNT(*) >= 2
     ORDER BY times DESC LIMIT 25`,
    [userId || null, teamId || null]
  );
  return rows;
}

// The user's own habits: what they sell, where they operate
async function getUserStyleStats(username) {
  const { rows: products } = await pool.query(
    `SELECT li.product, COUNT(*)::int AS n
     FROM lead_items li JOIN leads l ON l.id = li.lead_id
     WHERE l.created_by = $1 AND li.product <> ''
     GROUP BY li.product ORDER BY n DESC LIMIT 5`, [username]);
  const { rows: areas } = await pool.query(
    `SELECT area, COUNT(*)::int AS n FROM leads
     WHERE created_by = $1 AND area <> ''
     GROUP BY area ORDER BY n DESC LIMIT 3`, [username]);
  const { rows: [counts] } = await pool.query(
    `SELECT COUNT(*)::int AS total FROM leads WHERE created_by = $1`, [username]);
  return { products, areas, total: counts?.total || 0 };
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
  getLeads, getLeadsForUser, getLeadsByTeam, getStats, addLead, updateLead, deleteLead, importLeads,
  copyLeadsToWorking, moveLeadsBucket, updateLeadFields, setLeadProducts,
  addPhoto, getPhotos, deletePhoto, getPhotoById, getLeadContacts,
  createTask, getTasks, getTaskById, updateTask, deleteTask,
  addTeamMessage, getTeamMessages, logTeamActivity, getTeamActivity,
  touchLastSeen, getTeamPresence, getTeamLeaderboard,
  entitlementOf, extendUserPro, createAccessCode, getAccessCodes, deleteAccessCode, redeemAccessCode,
  // Monetization: Razorpay payments + referral program
  createPayment, getPaymentByOrderId, markPaymentPaid, markPaymentGranted,
  genReferralCode, getOrCreateReferralCode, findUserByReferralCode,
  countCreditedReferrals, createReferral, extendUserProDaysPreservingKind,
  applyRegistrationReferral,
  grantLeadAccess, revokeLeadAccess, getLeadAccess, claimFollowUp, reassignFollowUp,
  createUser, getUserByName, getUserByTelegramId, updateUserPin, updateUserName, updateUserDefaultArea,
  getAllUsers, deleteUser, verifyUserPin, verifyUserPassword, setUserPassword, seedAdminUser,
  setUserRole, setUserDesignation, setUserBusiness, normBusinessCustom, getAdminCount,
  setMustChangePassword, setMustChangePasswordForAll,
  saveWebAuthnCred, getWebAuthnCred, getUserByWebAuthnCredId,
  getLeadCoordinates, updateLeadCoords,
  // Team workspace
  createTeam, getTeamById, getTeamByHandle, getTeamByInviteCode, searchTeams, getPublicTeams,
  updateTeam, regenerateInviteCode,
  getTeamMembers, getTeamMember, addTeamMember, updateTeamMember, removeTeamMember, getUserTeams,
  createJoinRequest, getJoinRequests, updateJoinRequest, getJoinRequestByUserTeam,
  // Auth system
  getUserByCredential, incrementFailedAttempts, resetFailedAttempts,
  createSession, getSessionById, revokeSession, revokeAllUserSessions, listUserSessions,
  issueRefreshToken, rotateRefreshToken,
  trustDevice, getDeviceByFingerprint, getDeviceById, listUserDevices, removeDevice, renameDevice, touchDevice,
  setupDevicePin, verifyDevicePin, hasDevicePin,
  getUserById, deleteDevicePin, revokeSessionsForDevice, getActiveRefreshSession,
  logSecurity, getUserSecurityLog,
  // AI Entry Mode
  getVocab, addVocab, deleteVocab, logAiAction,
  // Lead lists (tags)
  getListsForContext, getListById, createList, renameList, deleteList,
  setLeadListMemberships, getListMembershipsForLeads, addLeadsToList,
  getProductsForContext, getProductById, createProduct, updateProduct, deleteProduct, deleteProductsScoped,
  getAliases, saveAlias, resolveProducts, rewriteProductValue,
  upsertSuggestion, getPendingSuggestions, setSuggestionStatus, distinctProductValues,
  // Lead security
  getLeadById, setLeadVisibility, userHasLeadAccess, getAccessibleLeadIds,
  // Lead share requests
  createLeadShareRequest, getLeadShareRequestById,
  getIncomingLeadRequests, getOutgoingLeadRequests, reviewLeadShareRequest,
  // Activity timeline + history
  logLeadActivity, getLeadActivities, logLeadHistory, getLeadHistory,
  // Departments
  getDepartments, getDepartmentById, createDepartment, updateDepartment, archiveDepartment,
  getDepartmentMembers, addDepartmentMember, removeDepartmentMember,
  // Granular permissions
  getUserPermissions, grantPermission, revokePermission,
  // Personal vocab
  getPersonalVocab, addPersonalVocab, deletePersonalVocab,
  // AI learning + debug
  logCorrection, getAIDebugLog,
  countSameCorrection, getLearnedCorrections, getUserStyleStats,
  // CRM search
  searchBusinesses, searchContacts,
  bcrypt,
};
