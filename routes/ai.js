'use strict';

const express = require('express');
const axios   = require('axios');
const { v4: uuidv4 } = require('uuid');
const db      = require('../db');
const { authMiddleware, adminOnly } = require('../middleware/auth');

const router = express.Router();

// ── System Prompt ─────────────────────────────────────────────
const CRM_SYSTEM_PROMPT = `You are a CRM data extraction AI for an adhesive sales team in India. Your ONLY output must be a single raw JSON object — no markdown, no code fences, no explanation.

FIELD IDENTIFICATION RULES:

FACTORY NUMBER: An alphanumeric code starting with 1-3 letters followed by digits (M277, F12, D5, B100, AB3). Always appears first or near the start of the message. This is NOT a person name and NOT a factory name. Examples: M277, F3, D12, AB100.

FACTORY NAME: The business/company name — often ends with words like "Industries", "Traders", "Enterprises", "Works", "Pvt", "Ltd", "Co", "Manufacturing", "Plastics", "Footwear", OR is a place name + industry type. Appears AFTER the factory number. Examples: "Ramesh Industries", "Surat Plastics", "Om Traders".

PERSON IN CHARGE: The human contact at the factory — typically a first name or full name, often followed by honorifics like "ji", "bhai", "sahab", "sir". Appears AFTER factory name. NOT the factory name itself. Examples: "Rameshji", "Suresh bhai", "Amit sahab", "Rajesh".

ITEMS: Extract as an array. Each item has product, quantity (with unit), and rate (number only, strip ₹ symbol).
- Products (all aliases recognised): "hotmelt"/"htmlt"/"hotmolt"/"hm" → "Hotmelt"; "rubber adhesive"/"rubad"/"rub ad"/"ra" → "Rubber Adhesive"; "solvent"/"solv"/"solv ad"/"sa" → "Solvent"; "latex"/"ltx" → "Latex"; "bc" → "BC"; "toluene"/"tol" → "Toluene"; "r6" → "R6"; "mek" → "MEK"; "pu adhesive"/"pu ad"/"puad"/"pu" → "PU Adhesive"; "silicon"/"silicone"/"sil" → "Silicon"
- Multiple items in ONE message: each product follows the pattern — product name → quantity → rate.
- Rate indicators: "@", "at", "rate", "₹", "rs", "pr", "per", "/kg", "/ltr"
- Format: [{"product":"Hotmelt","quantity":"500 kg","rate":"120"}]
- If only one item, still use array format. If no product found, use empty array [].

LEAD TYPE: "hot"/"urgent"/"priority"/"ready to buy"/"confirmed"/"pakka"/"fix" → "Hot"; "warm"/"maybe"/"soch raha"/"considering"/"thinking"/"interested"/"dekhte hain" → "Warm"; "cold"/"not interested"/"baad mein"/"dormant"/"inactive"/"later"/"nahi chahiye" → "Cold". If not mentioned → "".

FOLLOW UP: Any date mention — "next week", "15 july", "monday", "15/07", "kal", "parso", convert to dd/MM/yyyy. Leave empty if no date mentioned.

AREA: Extract any city, district, region, or location. Title Case. Leave empty if none.

STAGE MAPPING: New Lead→1, Sample Required→2, Sample Sent→3, Quotation→4, Negotiation→5, Order Won→6, Repeat Customer→7, Lost→0. If no stage mentioned → stage:"", stage_number:null.

NOTES: Put anything that doesn't fit other fields into notes.

Also include a "_confidence" key in your JSON output: an object mapping each extracted field name to a float 0.0–1.0 indicating extraction confidence. Use 0.9+ if the value appears literally in the input, 0.5–0.9 if inferred, below 0.5 if guessed or absent.

Return ONLY this JSON (no extra fields):
{
  "factory_number": "",
  "factory_name": "",
  "person_in_charge": "",
  "contact": "",
  "stage": "",
  "stage_number": null,
  "follow_up": "",
  "area": "",
  "notes": "",
  "lead_type": "",
  "items": [{"product": "", "quantity": "", "rate": ""}],
  "_confidence": {}
}`;

// ── GeminiProvider class ──────────────────────────────────────
class GeminiProvider {
  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY;
    this.models = ['gemini-2.0-flash', 'gemini-2.0-flash-lite'];
  }

  async generate(userText, vocab = []) {
    let prompt = CRM_SYSTEM_PROMPT;
    if (vocab.length) {
      prompt += '\n\nCOMPANY VOCABULARY (treat as exact synonyms during extraction):\n' +
        vocab.map(v => `"${v.alias}" → "${v.canonical}"`).join('; ');
    }

    for (const model of this.models) {
      const t0 = Date.now();
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`;
        const res = await axios.post(url, {
          system_instruction: { parts: [{ text: prompt }] },
          contents: [{ role: 'user', parts: [{ text: userText }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 900, responseMimeType: 'application/json' },
        });
        let raw = res.data.candidates[0].content.parts[0].text.trim()
          .replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/\s*```$/i,'').trim();
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.items) || !parsed.items.length) {
          parsed.items = parsed.product ? [{ product: parsed.product, quantity: parsed.quantity || '', rate: parsed.rate || '' }] : [];
        }
        return { parsed, model, latency: Date.now() - t0 };
      } catch (err) {
        const code = err.response?.data?.error?.code;
        if (code === 429 || code === 404 || code === 503) { console.warn(`⚠️ Gemini ${model} (${code})`); continue; }
        console.error('Gemini error:', err.response?.data || err.message);
      }
    }
    return null;
  }

  async generateFromAudio(audioBase64, mimeType = 'audio/ogg') {
    const voicePrompt = CRM_SYSTEM_PROMPT + '\n\nThe user sent a VOICE NOTE. First transcribe the audio, then extract CRM fields. Return ONLY the JSON.';
    for (const model of this.models) {
      const t0 = Date.now();
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`;
        const res = await axios.post(url, {
          system_instruction: { parts: [{ text: voicePrompt }] },
          contents: [{
            role: 'user',
            parts: [
              { inline_data: { mime_type: mimeType, data: audioBase64 } },
              { text: 'Transcribe and extract CRM lead data as JSON.' },
            ],
          }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 1500, responseMimeType: 'application/json' },
        });
        let raw = res.data.candidates[0].content.parts[0].text.trim()
          .replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/\s*```$/i,'').trim();
        const parsed = JSON.parse(raw);
        return { parsed, model, latency: Date.now() - t0 };
      } catch (err) {
        const code = err.response?.data?.error?.code;
        if (code === 429 || code === 503 || code === 400 || code === 404) { console.warn(`⚠️ Gemini voice ${model} (${code})`); continue; }
        console.error('Gemini voice error:', err.response?.data || err.message);
      }
    }
    return null;
  }
}

const gemini = new GeminiProvider();

// ── Preprocessing ─────────────────────────────────────────────
function preprocessInput(text, teamVocab = [], personalVocab = []) {
  let cleanedText = text.trim();
  const substitutions = [];

  const allVocab = [
    ...teamVocab.map(v => ({ ...v, source: 'team' })),
    ...personalVocab.map(v => ({ ...v, source: 'personal' })),
  ];

  for (const entry of allVocab) {
    const re = new RegExp(`\\b${entry.alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    if (re.test(cleanedText)) {
      cleanedText = cleanedText.replace(re, entry.canonical);
      substitutions.push({ from: entry.alias, to: entry.canonical, source: entry.source });
    }
  }

  return { cleanedText, substitutions };
}

// ── CRM Context Builder ───────────────────────────────────────
async function buildCRMContext(cleanedText, teamId) {
  if (!teamId) return null;
  try {
    const [businesses, contacts] = await Promise.all([
      db.searchBusinesses(cleanedText, teamId),
      db.searchContacts(cleanedText, teamId),
    ]);
    if (!businesses.length && !contacts.length) return null;
    const lines = [];
    if (businesses.length) {
      lines.push('KNOWN BUSINESSES (for context):');
      businesses.forEach(b => lines.push(`  ${b.factory_number} — ${b.factory_name}`));
    }
    if (contacts.length) {
      lines.push('KNOWN CONTACTS:');
      contacts.forEach(c => lines.push(`  ${c.person_in_charge} at ${c.factory_name || c.factory_number}`));
    }
    return lines.join('\n').slice(0, 600);
  } catch { return null; }
}

// ── Clarification Engine ──────────────────────────────────────
function clarificationEngine(fields, confidence, threshold = 0.70) {
  const PRIORITY = ['factory_number', 'factory_name', 'person_in_charge', 'items', 'lead_type', 'follow_up', 'stage'];
  const QUESTIONS = {
    factory_number:   { q: 'What is the factory number for this lead?', why: 'The factory number is our primary identifier — I couldn\'t find a clear one in your message.' },
    factory_name:     { q: 'What is the factory or business name?', why: 'I couldn\'t identify a clear company name in your message.' },
    person_in_charge: { q: 'Who is the contact person at this factory?', why: 'I didn\'t catch the person\'s name clearly.' },
    items:            { q: 'What product and quantity are we talking about?', why: 'The product details weren\'t clear enough for me to extract accurately.' },
    lead_type:        { q: 'How hot is this lead — Hot, Warm, or Cold?', why: 'I couldn\'t determine the lead temperature from your message.', options: ['Hot', 'Warm', 'Cold'] },
    follow_up:        { q: 'When should we follow up on this lead?', why: 'No follow-up date was mentioned.', options: ['Tomorrow', 'Next Week', 'In 2 Weeks'] },
    stage:            { q: 'What stage is this lead at?', why: 'The sales stage wasn\'t clearly mentioned.', options: ['New Lead', 'Sample Sent', 'Quotation', 'Negotiation', 'Order Won'] },
  };

  for (const field of PRIORITY) {
    const conf = confidence?.[field];
    if (conf !== undefined && conf < threshold && fields[field] !== undefined) {
      const info = QUESTIONS[field];
      if (!info) continue;
      return {
        field,
        question: info.q,
        whyAsked: info.why,
        options:  info.options || [],
        currentValue: fields[field],
        confidence: conf,
      };
    }
  }
  return null;
}

// ── Full Understanding Pipeline ───────────────────────────────
async function runUnderstandingPipeline(text, teamId, userId, sessionId) {
  const t0 = Date.now();

  // 1. Preprocessing
  const [teamVocab, personalVocab] = await Promise.all([
    teamId ? db.getVocab(teamId) : [],
    userId ? db.getPersonalVocab(userId) : [],
  ]);
  const { cleanedText, substitutions } = preprocessInput(text, teamVocab, personalVocab);

  // 2. CRM context
  const crmContext = await buildCRMContext(cleanedText, teamId);
  const augmented  = crmContext ? `${cleanedText}\n\n[CRM CONTEXT]\n${crmContext}` : cleanedText;

  // 3. Gemini
  const result = await gemini.generate(augmented, []);
  if (!result) {
    return { error: 'Could not parse — try again with more detail.', fallback: localParse(cleanedText) };
  }

  const { parsed, model, latency } = result;
  const confidence = parsed._confidence || {};

  // 4. Clarification check
  const clarification = clarificationEngine(parsed, confidence);

  // 5. Audit log
  db.logAiAction(null, 'understand', 'text', text, parsed, userId, teamId, {
    sessionId, model, latency: Date.now() - t0, substitutions, confidence,
  }).catch(() => {});

  return {
    sessionId,
    parsed,
    confidence,
    substitutions,
    model,
    latency: Date.now() - t0,
    needsClarification: !!clarification,
    clarification,
  };
}

// ── POST /api/ai/understand ───────────────────────────────────
router.post('/ai/understand', authMiddleware, async (req, res, next) => {
  const { text, teamId } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  try {
    const sessionId = uuidv4();
    const userId    = req.user.username;
    const result    = await runUnderstandingPipeline(text, teamId, userId, sessionId);
    if (result.error) return res.status(422).json(result);
    res.json(result);
  } catch (err) { next(err); }
});

// ── POST /api/ai/understand/voice ────────────────────────────
router.post('/ai/understand/voice', authMiddleware, async (req, res, next) => {
  const { audioBase64, mimeType = 'audio/webm', teamId } = req.body || {};
  if (!audioBase64) return res.status(400).json({ error: 'audioBase64 required' });
  try {
    const audioResult = await gemini.generateFromAudio(audioBase64, mimeType);
    if (!audioResult) return res.status(422).json({ error: 'Could not parse audio — try speaking more clearly or use text instead.' });

    const { parsed, model, latency } = audioResult;
    if (!Array.isArray(parsed.items) || !parsed.items.length) {
      parsed.items = parsed.product ? [{ product: parsed.product, quantity: parsed.quantity || '', rate: parsed.rate || '' }] : [];
    }
    const confidence    = parsed._confidence || {};
    const clarification = clarificationEngine(parsed, confidence);
    const sessionId     = uuidv4();

    db.logAiAction(null, 'understand_voice', 'voice', 'audio', parsed, req.user.username, teamId, {
      sessionId, model, latency,
    }).catch(() => {});

    res.json({ sessionId, parsed, confidence, substitutions: [], model, latency, needsClarification: !!clarification, clarification });
  } catch (err) { next(err); }
});

// ── POST /api/ai/clarify — answer clarification and re-run ────
router.post('/ai/clarify', authMiddleware, async (req, res, next) => {
  const { sessionId, field, answer, originalText, teamId } = req.body || {};
  if (!originalText || !field || !answer) return res.status(400).json({ error: 'originalText, field, answer required' });
  try {
    const augmented = `${originalText}\n[Clarification for ${field}: ${answer}]`;
    const result    = await runUnderstandingPipeline(augmented, teamId, req.user.username, sessionId || uuidv4());
    res.json(result);
  } catch (err) { next(err); }
});

// ── POST /api/ai/correct — log correction for learning ────────
router.post('/ai/correct', authMiddleware, async (req, res, next) => {
  const { sessionId, field, originalValue, correctedValue, rawInput, teamId } = req.body || {};
  if (!field || correctedValue === undefined) return res.status(400).json({ error: 'field and correctedValue required' });
  try {
    const user = await db.getUserByName(req.user.username);
    await db.logCorrection(sessionId, field, originalValue, correctedValue, rawInput, user?.id, teamId);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── GET /api/ai/debug — admin debug console ───────────────────
router.get('/ai/debug', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    const teamId = req.query.teamId ? parseInt(req.query.teamId, 10) : null;
    const limit  = Math.min(parseInt(req.query.limit || '50', 10), 200);
    const log    = await db.getAIDebugLog(teamId, limit);
    res.json(log);
  } catch (err) { next(err); }
});

// ── POST /api/parse (alias — Telegram bot uses this) ─────────
router.post('/parse', authMiddleware, async (req, res, next) => {
  const { text, teamId } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text required' });
  try {
    const vocab  = teamId ? await db.getVocab(teamId) : [];
    const result = await gemini.generate(text, vocab);
    const parsed = result ? result.parsed : localParse(text);
    const leads  = await db.getLeads();
    const pNum   = String(parsed.factory_number || '').trim().toLowerCase();
    const pName  = String(parsed.factory_name   || '').trim().toLowerCase();
    let existingRow = -1;
    for (const l of leads) {
      const rNum  = String(l.factory_number || '').trim().toLowerCase();
      const rName = String(l.factory_name   || '').trim().toLowerCase();
      if (pNum && pNum === rNum) { existingRow = l.rowIndex; break; }
      if (!pNum && pName && pName === rName) { existingRow = l.rowIndex; break; }
    }
    res.json({ parsed, action: existingRow !== -1 ? 'UPDATE' : 'ADD', existingRow });
  } catch (err) { next(err); }
});

// ── POST /api/parse/voice (alias) ────────────────────────────
router.post('/parse/voice', authMiddleware, async (req, res, next) => {
  const { audioBase64, mimeType = 'audio/webm' } = req.body || {};
  if (!audioBase64) return res.status(400).json({ error: 'audioBase64 required' });
  try {
    const result = await gemini.generateFromAudio(audioBase64, mimeType);
    if (!result) return res.status(422).json({ error: 'Could not parse audio — try speaking more clearly or use text instead.' });
    const { parsed } = result;
    if (!Array.isArray(parsed.items) || !parsed.items.length) {
      parsed.items = parsed.product ? [{ product: parsed.product, quantity: parsed.quantity || '', rate: parsed.rate || '' }] : [];
    }
    const leads = await db.getLeads();
    const pNum  = String(parsed.factory_number || '').trim().toLowerCase();
    let existingRow = -1;
    for (const l of leads) {
      if (pNum && pNum === String(l.factory_number || '').trim().toLowerCase()) { existingRow = l.rowIndex; break; }
    }
    res.json({ parsed, action: existingRow !== -1 ? 'UPDATE' : 'ADD', existingRow });
  } catch (err) { next(err); }
});

// ── AI Audit log ──────────────────────────────────────────────
router.post('/ai-audit', authMiddleware, async (req, res) => {
  const { leadId, action, inputType, rawInput, parsedJson, teamId } = req.body || {};
  db.logAiAction(leadId, action, inputType, rawInput, parsedJson, req.user.username, teamId).catch(() => {});
  res.json({ ok: true });
});

// ── Vocab endpoints ───────────────────────────────────────────
router.get('/vocab', authMiddleware, async (req, res, next) => {
  try {
    const teamId = req.query.teamId ? parseInt(req.query.teamId, 10) : null;
    res.json(await db.getVocab(teamId));
  } catch (err) { next(err); }
});

router.post('/vocab', authMiddleware, adminOnly, async (req, res, next) => {
  const { alias, canonical, teamId } = req.body || {};
  if (!alias || !canonical) return res.status(400).json({ error: 'alias and canonical required' });
  try {
    const row = await db.addVocab(alias, canonical, teamId || null, req.user.username);
    res.json({ ok: true, id: row.id });
  } catch (err) { next(err); }
});

router.delete('/vocab/:id', authMiddleware, adminOnly, async (req, res, next) => {
  try {
    await db.deleteVocab(parseInt(req.params.id, 10));
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Personal vocab endpoints ──────────────────────────────────
router.get('/vocab/personal', authMiddleware, async (req, res, next) => {
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(await db.getPersonalVocab(user.id));
  } catch (err) { next(err); }
});

router.post('/vocab/personal', authMiddleware, async (req, res, next) => {
  const { alias, canonical } = req.body || {};
  if (!alias || !canonical) return res.status(400).json({ error: 'alias and canonical required' });
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const row = await db.addPersonalVocab(user.id, alias, canonical);
    res.json({ ok: true, id: row.id });
  } catch (err) { next(err); }
});

router.delete('/vocab/personal/:id', authMiddleware, async (req, res, next) => {
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await db.deletePersonalVocab(parseInt(req.params.id, 10), user.id);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// ── Local fallback parser (exported for Telegram bot reuse) ───
function localParse(text) {
  const t  = text.trim();
  const tl = t.toLowerCase();

  const factNumMatch = t.match(/\b([A-Za-z]{1,3}\d+)\b/);
  const factory_number = factNumMatch ? factNumMatch[1].toUpperCase() : '';

  const productMap = {
    'rubber adhesive':'Rubber Adhesive','rub ad':'Rubber Adhesive','rubad':'Rubber Adhesive','ra':'Rubber Adhesive',
    'hotmelt':'Hotmelt','hotmolt':'Hotmelt','htmlt':'Hotmelt','hmelt':'Hotmelt','hm':'Hotmelt',
    'solvent':'Solvent','solv':'Solvent','solv ad':'Solvent','sa':'Solvent',
    'latex':'Latex','ltx':'Latex',
    'bc':'BC','toluene':'Toluene','tol':'Toluene',
    'r6':'R6','mek':'MEK',
    'pu adhesive':'PU Adhesive','pu ad':'PU Adhesive','puad':'PU Adhesive','pu':'PU Adhesive',
    'silicon':'Silicon','silicone':'Silicon','sil':'Silicon',
  };

  const stagePatterns = [
    { keys: ['lost','cancelled'], name: 'Lost', num: 0 },
    { keys: ['new lead'], name: 'New Lead', num: 1 },
    { keys: ['sample required','sample req'], name: 'Sample Required', num: 2 },
    { keys: ['sample sent','sent sample'], name: 'Sample Sent', num: 3 },
    { keys: ['quotation','quote'], name: 'Quotation', num: 4 },
    { keys: ['negotiation','negotiating'], name: 'Negotiation', num: 5 },
    { keys: ['order won','won','confirmed'], name: 'Order Won', num: 6 },
    { keys: ['repeat','reorder'], name: 'Repeat Customer', num: 7 },
  ];
  let stage = '', stage_number = null;
  for (const { keys, name, num } of stagePatterns) {
    if (keys.some(k => tl.includes(k))) { stage = name; stage_number = num; break; }
  }

  const fuMatch = t.match(/follow[\s-]?up\s+(.+?)(?:\s+(?:for|in|at|by|and|,|$))/i) || t.match(/follow[\s-]?up\s+(.+)$/i);
  const follow_up = fuMatch ? fuMatch[1].trim() : '';

  const cities = ['mumbai','delhi','surat','ahmedabad','pune','bangalore','bengaluru','hyderabad','chennai','kolkata','bhiwandi','thane'];
  let area = '';
  for (const city of cities) { if (tl.includes(city)) { area = city.replace(/\b\w/g, c => c.toUpperCase()); break; } }

  let lead_type = '';
  if (/\bhot\b/i.test(t)) lead_type = 'Hot';
  else if (/\bwarm\b/i.test(t)) lead_type = 'Warm';
  else if (/\bcold\b/i.test(t)) lead_type = 'Cold';

  const personMatch = t.match(/\b(\w+(?:ji|bhai|sahab|sir))\b/i);
  const person_in_charge = personMatch ? personMatch[1].replace(/\b\w/g, c => c.toUpperCase()) : '';

  // Extract first matching product
  let product = '', quantity = '', rate = '';
  for (const [alias, name] of Object.entries(productMap)) {
    const idx = tl.indexOf(alias);
    if (idx !== -1) {
      product = name;
      const after = tl.slice(idx + alias.length);
      const qm = after.match(/[\s@]*(\d+(?:\.\d+)?)\s*(kg|ltr|ton|pcs)?/i);
      if (qm) { quantity = qm[1] + (qm[2] ? ' ' + qm[2] : ''); }
      const rm = after.match(/[@₹]\s*(\d+(?:\.\d+)?)/i);
      if (rm) rate = rm[1];
      break;
    }
  }

  const items = product ? [{ product, quantity, rate }] : [];

  return { factory_number, factory_name: '', person_in_charge, contact: '', product, quantity, rate,
    stage, stage_number, follow_up, notes: '', area, lead_type, items, _confidence: {} };
}

module.exports = router;
module.exports.localParse = localParse;
module.exports.gemini = gemini;
module.exports.CRM_SYSTEM_PROMPT = CRM_SYSTEM_PROMPT;
