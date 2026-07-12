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
  },
  retail: {
    icon: '🏪', label: 'Retail & Shops',
    entity: 'Shop', entityPlural: 'Shops',
    terms: { code: 'Shop Code', name: 'Shop Name', person: 'Owner',
             product: 'Item', area: 'Locality' },
    stages: { 'New Lead': 'New Shop', 'Sample Required': 'Sample Asked', 'Sample Sent': 'Sample Given',
              'Order Won': 'Order Won', 'Repeat Customer': 'Repeat Buyer' },
    aiHint: 'a supplier selling to retail shops (kirana, electronics, apparel); leads are shops, contacts are shop owners',
  },
  distribution: {
    icon: '📦', label: 'Distribution / Wholesale',
    entity: 'Party', entityPlural: 'Parties',
    terms: { code: 'Party Code', name: 'Party Name', person: 'Contact Person',
             product: 'Product', area: 'Area' },
    stages: { 'New Lead': 'New Party', 'Quotation': 'Rates Shared' },
    aiHint: 'a distributor/wholesaler/trading business; leads are parties/dealers buying stock',
  },
  construction: {
    icon: '🏗️', label: 'Construction & Real Estate',
    entity: 'Site', entityPlural: 'Sites',
    terms: { code: 'Site Code', name: 'Site / Builder Name', person: 'Site Contact',
             product: 'Material / Service', area: 'Location' },
    stages: { 'New Lead': 'New Enquiry', 'Sample Required': 'Site Visit Planned', 'Sample Sent': 'Site Visit Done',
              'Quotation': 'Proposal Sent', 'Order Won': 'Deal Closed', 'Repeat Customer': 'Repeat Client' },
    aiHint: 'a construction/real-estate business; leads are sites, builders, projects or property buyers',
  },
  pharma: {
    icon: '💊', label: 'Pharma & Medical',
    entity: 'Doctor / Chemist', entityPlural: 'Doctors & Chemists',
    terms: { code: 'Code', name: 'Doctor / Chemist Name', person: 'Contact Person',
             product: 'Brand / Product', area: 'Territory' },
    stages: { 'New Lead': 'New Doctor', 'Sample Required': 'Samples Asked', 'Sample Sent': 'Samples Given',
              'Quotation': 'Rate List Sent', 'Order Won': 'Prescribing', 'Repeat Customer': 'Regular Prescriber' },
    aiHint: 'a pharma/medical field-sales business; leads are doctors, chemists, clinics and hospitals; products are medicine brands',
  },
  services: {
    icon: '💼', label: 'Services & Agencies',
    entity: 'Client', entityPlural: 'Clients',
    terms: { code: 'Client Code', name: 'Client / Company Name', person: 'Contact Person',
             product: 'Service', area: 'Area' },
    stages: { 'New Lead': 'New Enquiry', 'Sample Required': 'Demo Requested', 'Sample Sent': 'Demo Done',
              'Quotation': 'Proposal Sent', 'Order Won': 'Contract Won', 'Repeat Customer': 'Retainer Client' },
    aiHint: 'a services business/agency (IT, marketing, consulting); leads are client companies; products are services',
  },
  logistics: {
    icon: '🚚', label: 'Logistics & Transport',
    entity: 'Client', entityPlural: 'Clients',
    terms: { code: 'Client Code', name: 'Client / Company Name', person: 'Contact Person',
             product: 'Route / Service', area: 'Zone' },
    stages: { 'New Lead': 'New Enquiry', 'Sample Required': 'Trial Asked', 'Sample Sent': 'Trial Shipment Done',
              'Quotation': 'Rates Shared', 'Order Won': 'Contract Won', 'Repeat Customer': 'Regular Client' },
    aiHint: 'a logistics/transport business; leads are shipper clients; products are routes and freight services',
  },
  education: {
    icon: '🎓', label: 'Education & Coaching',
    entity: 'Student', entityPlural: 'Students',
    terms: { code: 'Enquiry #', name: 'Student / Parent Name', person: 'Parent / Guardian',
             product: 'Course', area: 'Locality' },
    stages: { 'New Lead': 'New Enquiry', 'Sample Required': 'Demo Class Asked', 'Sample Sent': 'Demo Class Done',
              'Quotation': 'Fees Quoted', 'Negotiation': 'Follow-up', 'Order Won': 'Admitted', 'Repeat Customer': 'Renewed' },
    aiHint: 'an education/coaching institute; leads are student or parent enquiries; products are courses/batches',
  },
  hospitality: {
    icon: '🏨', label: 'Hotels & Restaurants',
    entity: 'Outlet', entityPlural: 'Outlets',
    terms: { code: 'Outlet Code', name: 'Hotel / Restaurant Name', person: 'Manager / Owner',
             product: 'Product', area: 'Area' },
    stages: { 'New Lead': 'New Outlet', 'Sample Required': 'Sample Asked', 'Sample Sent': 'Tasting / Sample Done',
              'Quotation': 'Rates Shared', 'Repeat Customer': 'Regular Buyer' },
    aiHint: 'a supplier selling to hotels, restaurants, cafes and caterers (HoReCa); leads are outlets',
  },
  agro: {
    icon: '🌾', label: 'Agro & Farm Inputs',
    entity: 'Dealer', entityPlural: 'Dealers',
    terms: { code: 'Dealer Code', name: 'Dealer / Farmer Name', person: 'Contact Person',
             product: 'Product', area: 'Village / Area' },
    stages: { 'New Lead': 'New Dealer', 'Sample Required': 'Demo Asked', 'Sample Sent': 'Field Demo Done',
              'Quotation': 'Rates Shared', 'Repeat Customer': 'Repeat Dealer' },
    aiHint: 'an agri-inputs business (seeds, fertilizer, pesticides, equipment); leads are dealers and farmers',
  },
  finance: {
    icon: '💰', label: 'Finance & Insurance',
    entity: 'Client', entityPlural: 'Clients',
    terms: { code: 'Client Code', name: 'Client Name', person: 'Contact Person',
             product: 'Product / Policy', area: 'Area' },
    stages: { 'Sample Required': 'Documents Requested', 'Sample Sent': 'Proposal Shared',
              'Quotation': 'Quote Shared', 'Order Won': 'Policy Issued', 'Repeat Customer': 'Renewal Client' },
    aiHint: 'a finance/insurance business (loans, policies, investments); leads are client prospects; products are financial products/policies',
  },
  custom: {
    icon: '⚙️', label: 'Custom',
    entity: 'Lead', entityPlural: 'Leads',
    terms: { code: 'Code', name: 'Name', person: 'Contact Person',
             product: 'Product', area: 'Area' },
    stages: {},
    aiHint: 'a general sales business; leads are prospects',
  },
};

const BUSINESS_KEYS = Object.keys(BUSINESS_TYPES);

// Resolve a profile: valid type key + custom-term overrides merged in (custom
// terms only apply to the 'custom' type). Always safe — unknown/missing keys
// fall back to 'factory' so nothing existing ever changes behaviour.
function resolveBusinessProfile(type, customJson) {
  const key = BUSINESS_KEYS.includes(type) ? type : 'factory';
  const base = BUSINESS_TYPES[key];
  if (key !== 'custom') return { key, ...base };
  let custom = {};
  try { custom = typeof customJson === 'string' ? JSON.parse(customJson || '{}') : (customJson || {}); } catch (_) {}
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
  };
}

// A short vocabulary block injected into the AI parsing prompts so extraction
// understands this business's words WITHOUT changing the JSON field contract.
function businessVocabPrompt(profile) {
  const p = profile || BUSINESS_TYPES.factory;
  const t = p.terms;
  return [
    `BUSINESS CONTEXT: The user runs ${p.aiHint || 'a sales business'}.`,
    `In their language a lead is called a "${p.entity}". Map their words onto the SAME JSON fields as always:`,
    `- factory_number = the ${t.code} (short alphanumeric lead/party code)`,
    `- factory_name = the ${t.name} (the ${p.entity.toLowerCase()}'s name)`,
    `- person_in_charge = the ${t.person}`,
    `- product = the ${t.product}`,
    `- area = the ${t.area}`,
    `Never rename the JSON keys — only interpret the user's ${p.entity.toLowerCase()}-related wording into them.`,
  ].join('\n');
}

module.exports = { BUSINESS_TYPES, BUSINESS_KEYS, CANON_STAGES, resolveBusinessProfile, businessVocabPrompt };
