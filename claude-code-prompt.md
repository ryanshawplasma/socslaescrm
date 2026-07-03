# Prompt for Claude Code

Copy everything below the line into Claude Code.

---

Work through this in two parts: PART A (fixes) first, then PART B (new feature). Make each change minimal, don't refactor unrelated code, and run the app after each part to confirm nothing breaks.

## PART A — Fixes

### Security (do first)

1. `db.js:15` — change `ssl: { rejectUnauthorized: false }` to proper cert verification (`rejectUnauthorized: true`). If the Aiven CA cert is needed, read it from an env var `DB_CA_CERT`.
2. `index.js:21-23` — remove the hardcoded `admin123` fallback for `ADMIN_PASS`. If `ADMIN_PASS` or `JWT_SECRET` is unset in production (`NODE_ENV=production`), exit with an error at startup instead of falling back to defaults. Same for the `crm_default_secret_change_me` fallback in `middleware/auth.js:8` and `routes/auth.js:183`.
3. `db.js:1417` — the `locked_until` value is interpolated into the SQL string in `verifyDevicePin()`. Parameterize it properly.
4. `routes/auth.js` — the POST `/pin-unlock` endpoint (~line 246) has no rate limiting. Apply the existing `loginLimiter` (or an equivalent limiter) to it.

### Bugs

5. `db.js:1413-1417` + `routes/auth.js:262` — PIN lockout triggers at >=5 failed attempts but the client message says "5 attempts remaining". Fix so the threshold and messaging agree (lock at 5, message counts down correctly).
6. `middleware/auth.js:130` `requireLeadAccess` — calls `next()` when `leadId` is missing. Return 400 instead.

### Code quality

7. `db.js` — replace all silent `.catch(() => {})` handlers (lines ~782, 789, 907, 913, 1442 and any others) with `.catch(err => console.warn(...))` including context of what failed.
8. `routes/auth.js:6` — routes use the raw `pool` directly (lines 201, 254, 276-279, 297, 378). Move these queries into named functions in `db.js` and call those instead.
9. `db.js` `getLeads()` (~516-553) — add optional limit/offset pagination params, defaulting to current behavior so nothing breaks.
10. `index.js:29` — drop the global JSON body limit from 25mb to 5mb; apply a larger per-route limit only where imports/uploads need it.
11. `index.js:32-38` — add a Content-Security-Policy header: `default-src 'self'`; adjust script-src/style-src only as needed for existing frontend deps (check `public/index.html` for CDN usage first).
12. `routes/auth.js` `getWebAuthnConfig` (~400-420) — prefer explicit `RP_ID` and `ORIGIN` env vars over inferring from request headers; only fall back to inference in development.
13. `Dockerfile:1` — pin the base image to a specific node 20 LTS patch version.

Do NOT touch `.env` values. After PART A, list anything that requires new env vars so I can set them.

## PART B — AI product normalization feature

There is a canonical `products` table (`db.js` ~line 496) and a `GeminiProvider` in `routes/ai.js`. Imported data has messy product strings ("hyd", "latex", "hotmelt") that should map to canonical products.

1. New table `product_aliases` (`raw_text` TEXT lowercase-unique, `product_id` REF products, `source` TEXT 'ai'|'manual'|'keep-original', `created_at`). Add helpers in `db.js`: `getAliases()`, `saveAlias()`, `resolveProducts(rawStrings[])` — resolves via exact product name match, then alias table, returns `{ resolved: {raw: product}, unresolved: [raw] }`.

2. In POST `/api/leads/import` (`routes/leads.js:206`): before `importLeads`, collect unique product strings from rows/items, call `resolveProducts()`. For unresolved strings, make ONE Gemini call: pass the canonical product list + unresolved strings, ask for JSON mapping each string to a product name or "unknown". Validate the response — only accept product names that exist in the catalog. Save accepted mappings as aliases (source 'ai'). Rewrite product fields in rows to canonical names before insert. Return in the API response: `{ normalized: count, unmatched: [strings left as-is] }` so the UI can show "12 products auto-matched, 2 need review". Import must still succeed if Gemini fails — fall back to raw strings.

3. For strings the AI maps to "unknown", the same Gemini call returns 1-3 suggested options per string: e.g. "latex" → `[{ name: "Latex Adhesive", division: "Adhesives" }, { name: "Latex", division: "Raw Materials" }]`. Store in a `product_suggestions` table (`raw_text`, `suggestions` JSONB, `count`, `status` pending/resolved/ignored). Imported rows always keep their raw string until an admin decides.

4. New admin endpoints:
   - GET `/api/products/cleanup-scan`: scans distinct `lead_items.product` and `leads.product` values not matching canonical names/aliases, groups by value with counts, includes AI-suggested mappings (one batched Gemini call).
   - POST `/api/products/cleanup-apply`: takes `[{raw, action, productId?}]` where action is 'map' (existing product), 'create' (new product from suggestion), or 'keep' (keep original). Updates matching `lead_items`/`leads` rows for 'map'/'create', saves aliases accordingly. Admin-only, log via `logAiAction`.

5. Frontend (`public/app.js` + `index.html`):
   - After import, show the normalization summary ("12 auto-matched, 2 need review").
   - Add a "Fix Product Data" admin screen. Each unmatched string shows as a card with radio options:
     - ( ) Suggestion 1 — "Latex Adhesive" (Adhesives) [AI]
     - ( ) Suggestion 2 — "Latex" (Raw Materials) [AI]
     - ( ) Map to existing product… [catalog dropdown]
     - (•) Keep original "latex" ← default selection
   - Picking a suggestion inserts it into `products` + saves alias + updates rows. "Keep original" marks it resolved so it never nags again, and saves it as its own alias (source 'keep-original') so future imports of that string stay unchanged silently. Include an "Apply all" button that applies whatever is selected on each card.

Rules: Gemini prompts must demand strict JSON, temperature 0. The AI may only PICK from the catalog or SUGGEST new entries — it must never insert into `products` without explicit admin action. Nothing in existing data is ever changed without an explicit choice; the default is always keep-original.
