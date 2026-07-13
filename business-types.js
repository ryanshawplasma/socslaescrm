'use strict';

// ============================================================
//  business-types.js — the business-profile registry (server copy)
//  Dive works for many businesses, not just factories. A team (or a user's
//  Personal workspace) picks ONE of these types; it changes the words the app
//  uses (what a lead is called, field labels, pipeline stage names) and the
//  vocabulary the AI parser is primed with. IT NEVER CHANGES THE SCHEMA:
//  factory_number/factory_name/... stay the storage field names for every
//  business — these are display + prompt layers only.
//
//  The client keeps a mirrored copy in public/app.js (BUSINESS_TYPES) — if you
//  edit terms here, update the client copy too.
// ============================================================

// Canonical pipeline stages (stored in leads.stage) — every business relabels
// these for DISPLAY only; the stored values never change.
const CANON_STAGES = ['New Lead', 'Sample Required', 'Sample Sent', 'Quotation',
                      'Negotiation', 'Order Won', 'Repeat Customer', 'Lost'];

const BUSINESS_TYPES = {
  factory: {
    icon: '🏭', label: 'Manufacturing / Factories',
    entity: 'Factory', entityPlural: 'Factories',
    terms: { code: 'Factory #', name: 'Factory / Party Name', person: 'Person in Charge',
             product: 'Product', area: 'Area' },
    stages: {},   // the original — no relabels
    aiHint: 'a manufacturer selling to factories and industrial parties; leads are factories/parties',
    example: 'M99 Kapoor Shoes, Rameshji, 9876543210 — hotmelt 500kg @120, follow up Tuesday',
  },
  retail: {
    icon: '🏪', label: 'Retail & Shops',
    entity: 'Shop', entityPlural: 'Shops',
    terms: { code: 'Shop Code', name: 'Shop Name', person: 'Owner',
             product: 'Item', area: 'Locality' },
    stages: { 'New Lead': 'New Shop', 'Sample Required': 'Sample Asked', 'Sample Sent': 'Sample Given',
              'Quotation': 'Rates Shared', 'Order Won': 'Order Won', 'Repeat Customer': 'Repeat Buyer' },
    aiHint: 'a supplier selling to retail shops (kirana, electronics, apparel); leads are shops, contacts are shop owners',
    example: 'Sharma General Store, Ramesh bhai, 9876543210 — 20 boxes soap, follow up Tuesday',
  },
  distribution: {
    icon: '📦', label: 'Distribution / Wholesale',
    entity: 'Party', entityPlural: 'Parties',
    terms: { code: 'Party Code', name: 'Party Name', person: 'Contact Person',
             product: 'Product', area: 'Area' },
    stages: { 'New Lead': 'New Party', 'Quotation': 'Rates Shared' },
    aiHint: 'a distributor/wholesaler/trading business; leads are parties/dealers buying stock',
    example: 'Om Traders, Mehul bhai, 9876543210 — 50 cartons biscuits, rates shared, follow up Monday',
  },
  construction: {
    icon: '🏗️', label: 'Construction & Real Estate',
    entity: 'Site', entityPlural: 'Sites',
    terms: { code: 'Site Code', name: 'Site / Builder Name', person: 'Site Contact',
             product: 'Material / Service', area: 'Location' },
    stages: { 'New Lead': 'New Enquiry', 'Sample Required': 'Site Visit Planned', 'Sample Sent': 'Site Visit Done',
              'Quotation': 'Proposal Sent', 'Order Won': 'Booking Done', 'Repeat Customer': 'Repeat Client' },
    aiHint: 'a construction/real-estate business; leads are sites, builders, projects or property buyers',
    example: 'Skyline Builders site at Baner, Anil, 9876543210 — cement + waterproofing quote, site visit Friday',
  },
  pharma: {
    icon: '💊', label: 'Pharma & Medical',
    entity: 'Doctor / Chemist', entityPlural: 'Doctors & Chemists',
    terms: { code: 'Doctor Code', name: 'Doctor / Chemist Name', person: 'Contact Person',
             product: 'Brand / Product', area: 'Territory' },
    stages: { 'New Lead': 'New Doctor', 'Sample Required': 'Samples Asked', 'Sample Sent': 'Samples Given',
              'Quotation': 'Rate List Sent', 'Order Won': 'Prescribing', 'Repeat Customer': 'Regular Prescriber' },
    aiHint: 'a pharma/medical field-sales business; leads are doctors, chemists, clinics and hospitals; products are medicine brands; reps may say RCPA, POB, PTR/PTS or "rate list" — treat these as sample/order/rate-sharing activity, not new fields',
    example: 'Dr Mehta, Apollo Clinic Andheri, 9876543210 — wants samples of Azithro 250, visit Tuesday',
  },
  services: {
    icon: '💼', label: 'Services & Agencies',
    entity: 'Client', entityPlural: 'Clients',
    terms: { code: 'Client Code', name: 'Client / Company Name', person: 'Contact Person',
             product: 'Service', area: 'Area' },
    stages: { 'New Lead': 'New Enquiry', 'Sample Required': 'Demo Requested', 'Sample Sent': 'Demo Done',
              'Quotation': 'Proposal Sent', 'Order Won': 'Contract Won', 'Repeat Customer': 'Retainer Client' },
    aiHint: 'a services business/agency (IT, marketing, consulting); leads are client companies; products are services',
    example: 'Nexus Tech, Priya, 9876543210 — website + SEO proposal, demo Friday',
  },
  logistics: {
    icon: '🚚', label: 'Logistics & Transport',
    entity: 'Client', entityPlural: 'Clients',
    terms: { code: 'Client Code', name: 'Client / Company Name', person: 'Contact Person',
             product: 'Route / Service', area: 'Zone' },
    stages: { 'New Lead': 'New Enquiry', 'Sample Required': 'Trial Asked', 'Sample Sent': 'Trial Shipment Done',
              'Quotation': 'Rates Shared', 'Order Won': 'Contract Won', 'Repeat Customer': 'Regular Client' },
    aiHint: 'a logistics/transport business; leads are shipper clients; products are routes and freight services',
    example: 'Kwality Foods, Arjun, 9876543210 — Mumbai–Delhi weekly route, trial shipment Monday',
  },
  education: {
    icon: '🎓', label: 'Education & Coaching',
    entity: 'Student', entityPlural: 'Students',
    terms: { code: 'Enquiry No.', name: 'Student Name', person: 'Parent / Guardian',
             product: 'Course', area: 'Locality' },
    stages: { 'New Lead': 'New Enquiry', 'Sample Required': 'Demo Class Asked', 'Sample Sent': 'Demo Class Done',
              'Quotation': 'Fees Quoted', 'Negotiation': 'Counselling', 'Order Won': 'Admitted', 'Repeat Customer': 'Renewed' },
    aiHint: 'an education/coaching institute; leads are student or parent enquiries; products are courses/batches',
    example: 'Aarav Sharma, father Rajesh, 9876543210 — Class 10 maths enquiry, demo class Saturday',
  },
  hospitality: {
    icon: '🏨', label: 'Hotels & Restaurants',
    entity: 'Outlet', entityPlural: 'Outlets',
    terms: { code: 'Outlet Code', name: 'Hotel / Restaurant Name', person: 'Manager / Owner',
             product: 'Product', area: 'Area' },
    stages: { 'New Lead': 'New Outlet', 'Sample Required': 'Sample Asked', 'Sample Sent': 'Tasting / Sample Done',
              'Quotation': 'Rates Shared', 'Repeat Customer': 'Regular Buyer' },
    aiHint: 'a supplier selling to hotels, restaurants, cafes and caterers (HoReCa); leads are outlets',
    example: 'Cafe Blue Terrace, manager Rohit, 9876543210 — monthly coffee supply, tasting Thursday',
  },
  agro: {
    icon: '🌾', label: 'Agro & Farm Inputs',
    entity: 'Dealer', entityPlural: 'Dealers',
    terms: { code: 'Dealer Code', name: 'Dealer / Farmer Name', person: 'Contact Person',
             product: 'Product', area: 'Village / Area' },
    stages: { 'New Lead': 'New Dealer', 'Sample Required': 'Demo Asked', 'Sample Sent': 'Field Demo Done',
              'Quotation': 'Rates Shared', 'Repeat Customer': 'Repeat Dealer' },
    aiHint: 'an agri-inputs business (seeds, fertilizer, pesticides, equipment); leads are dealers and farmers',
    example: 'Kisan Agro Center, Balu bhai, 9876543210 — 100 bags urea, field demo Monday',
  },
  finance: {
    icon: '💰', label: 'Finance & Insurance',
    entity: 'Client', entityPlural: 'Clients',
    terms: { code: 'Client Code', name: 'Client Name', person: 'Contact Person',
             product: 'Product / Policy', area: 'Area' },
    stages: { 'New Lead': 'New Enquiry', 'Sample Required': 'Quote Shared', 'Sample Sent': 'Proposal Shared',
              'Quotation': 'Documents Requested', 'Order Won': 'Policy Issued', 'Repeat Customer': 'Renewal Client' },
    aiHint: 'a finance/insurance business (loans, policies, investments); leads are client prospects; products are financial products/policies',
    example: 'Suresh Patel, 9876543210 — term insurance 1Cr quote, documents pending, call Wednesday',
  },
  custom: {
    icon: '⚙️', label: 'Custom',
    entity: 'Lead', entityPlural: 'Leads',
    terms: { code: 'Code', name: 'Name', person: 'Contact Person',
             product: 'Product', area: 'Area' },
    stages: {},
    aiHint: 'a general sales business; leads are prospects',
    example: 'New lead: name, contact, what they want, follow-up day',
  },
};

const BUSINESS_KEYS = Object.keys(BUSINESS_TYPES);

// Sanitize a custom stage-relabel map (business_custom.stages): only canonical
// stage names (CANON_STAGES) may be keys — others are dropped — and values
// become trimmed display labels capped at 30 chars, empties dropped. Returns a
// plain object (possibly empty). Shared by the WRITE path (db.normBusinessCustom)
// and applied again defensively at READ time in resolveBusinessProfile, since
// the DB may hold pre-sanitization blobs.
function sanitizeCustomStages(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const canon of CANON_STAGES) {
    const val = raw[canon];
    if (val === undefined || val === null) continue;
    const s = String(val).trim().slice(0, 30);
    if (s) out[canon] = s;
  }
  return out;
}

// Resolve a profile: valid type key + custom-term overrides merged in (custom
// terms only apply to the 'custom' type). Always safe — unknown/missing keys
// fall back to 'factory' so nothing existing ever changes behaviour.
function resolveBusinessProfile(type, customJson) {
  const key = BUSINESS_KEYS.includes(type) ? type : 'factory';
  const base = BUSINESS_TYPES[key];
  if (key !== 'custom') return { key, ...base };
  let custom = {};
  try { custom = typeof customJson === 'string' ? JSON.parse(customJson || '{}') : (customJson || {}); } catch (_) {}
  // Guard against poisoned rows (e.g. a stored "null" string parses to JS null,
  // not {}) so custom is ALWAYS a plain object — otherwise custom.entity below
  // throws and the caller silently reverts the whole profile to factory.
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)) custom = {};
  return {
    key, ...base,
    entity: String(custom.entity || base.entity).slice(0, 30),
    entityPlural: String(custom.entityPlural || custom.entity || base.entityPlural).slice(0, 30),
    terms: {
      code:    String(custom.code    || base.terms.code).slice(0, 30),
      name:    String(custom.name    || base.terms.name).slice(0, 40),
      person:  String(custom.person  || base.terms.person).slice(0, 30),
      product: String(custom.product || base.terms.product).slice(0, 30),
      area:    String(custom.area    || base.terms.area).slice(0, 30),
    },
    // Optional user-defined stage relabels (display only — stored stage values
    // never change). Sanitized defensively here too, not just on write.
    stages: sanitizeCustomStages(custom.stages),
  };
}

// Words that may stand in for "party" in a typed command trigger for this
// profile ("add shop …", "new doctor …", "create gym member …"): the full
// entity phrase, its plural, and each word of the phrase (split on / & ,) —
// lowercased, deduped, length-capped and REGEX-ESCAPED (custom entities are
// user input; unescaped metacharacters would break or abuse the RegExp).
// The literal fallbacks party|lead|customer stay ALWAYS-ON at the call site,
// so the factory profile's behaviour is byte-identical to before.
function entityTriggerWords(profile) {
  const p = profile || BUSINESS_TYPES.factory;
  const raw = [p.entity, p.entityPlural, ...String(p.entity || '').split(/[\/&,]/)]
    .map(s => String(s || '').trim().toLowerCase())
    .filter(w => w && w.length >= 3 && w.length <= 30);
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...new Set(raw)].map(esc);
}

// Strip newlines/backticks and collapse whitespace before a profile string is
// interpolated into an AI prompt. entity + the 5 terms can be user-supplied
// (the 'custom' business type) and must stay single-line inside the prompt —
// aiHint is registry-fixed (never user input) so it's left as-is.
function sanitizePromptTerm(s) {
  return String(s || '').replace(/[\r\n`]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// A short vocabulary block injected into the AI parsing prompts so extraction
// understands this business's words WITHOUT changing the JSON field contract.
function businessVocabPrompt(profile) {
  const p = profile || BUSINESS_TYPES.factory;
  const t = p.terms;
  const entity  = sanitizePromptTerm(p.entity);
  const code    = sanitizePromptTerm(t.code);
  const name    = sanitizePromptTerm(t.name);
  const person  = sanitizePromptTerm(t.person);
  const product = sanitizePromptTerm(t.product);
  const area    = sanitizePromptTerm(t.area);
  return [
    `BUSINESS CONTEXT: The user runs ${p.aiHint || 'a sales business'}.`,
    `In their language a lead is called a "${entity}". Map their words onto the SAME JSON fields as always:`,
    `- factory_number = the ${code} (short alphanumeric lead/party code)`,
    `- factory_name = the ${name} (the ${entity.toLowerCase()}'s name)`,
    `- person_in_charge = the ${person}`,
    `- product = the ${product}`,
    `- area = the ${area}`,
    `Never rename the JSON keys — only interpret the user's ${entity.toLowerCase()}-related wording into them.`,
  ].join('\n');
}

module.exports = { BUSINESS_TYPES, BUSINESS_KEYS, CANON_STAGES, resolveBusinessProfile, businessVocabPrompt, entityTriggerWords, sanitizeCustomStages };
