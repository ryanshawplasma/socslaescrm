'use strict';

const express = require('express');
const axios   = require('axios');
const { v4: uuidv4 } = require('uuid');
const db      = require('../db');
const cache   = require('../cache');
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

PHONE NUMBERS: normalise to digits (keep +91 prefix if present), strip spaces/dashes. A 10-digit number is a contact, NOT a quantity or rate.

EXAMPLES (input → key outputs):
1. "M277 Ramesh Industries Sureshji 9876543210 hotmelt 500kg @120 aur solvent 200 ltr 80 rupay, kal follow up, surat, garam lead hai"
   → factory_number:"M277", factory_name:"Ramesh Industries", person_in_charge:"Sureshji", contact:"9876543210",
     items:[{"product":"Hotmelt","quantity":"500 kg","rate":"120"},{"product":"Solvent","quantity":"200 ltr","rate":"80"}],
     follow_up:<tomorrow as dd/MM/yyyy>, area:"Surat", lead_type:"Hot"
2. "om traders ke mehul bhai ko quotation bhej diya, next week baat karenge"
   → factory_name:"Om Traders", person_in_charge:"Mehul bhai", stage:"Quotation", stage_number:4, follow_up:<today+7 as dd/MM/yyyy>
3. "F12 sample pasand nahi aaya, nahi chahiye unko"
   → factory_number:"F12", lead_type:"Cold", notes:"Did not like the sample"

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

// ── Prompt helpers ────────────────────────────────────────────
function todayISTLabel() {
  return new Date().toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata', weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

function buildSystemPrompt(vocab = [], extra = '') {
  let prompt = CRM_SYSTEM_PROMPT +
    `\n\nTODAY'S DATE: ${todayISTLabel()} (dd/MM/yyyy, IST timezone). Resolve ALL relative dates against this: ` +
    `"kal"/"tomorrow" = today+1 day, "parso" = today+2, "next week" = today+7, "in 2 weeks" = today+14, ` +
    `a weekday name = the NEXT occurrence of that weekday. Always output follow_up as dd/MM/yyyy.`;
  if (vocab.length) {
    prompt += '\n\nCOMPANY VOCABULARY (treat as exact synonyms during extraction):\n' +
      vocab.map(v => `"${v.alias}" → "${v.canonical}"`).join('; ');
  }
  if (extra) prompt += '\n\n' + extra;
  return prompt;
}

// ── Per-user learning context (cached 5 min) ──────────────────
// Feeds the user's past corrections and habits back into the prompt so
// the AI adapts to how each person actually types and talks.
async function buildUserLearningContext(username, teamId) {
  if (!username) return { text: '', corrections: 0, profiled: false };
  const cacheKey = `learn_${username}_${teamId || 0}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  let corrections = [], style = null;
  try {
    const user = await db.getUserByName(username);
    [corrections, style] = await Promise.all([
      db.getLearnedCorrections(user?.id || null, teamId ? parseInt(teamId, 10) : null).catch(() => []),
      db.getUserStyleStats(username).catch(() => null),
    ]);
  } catch (_) {}

  const parts = [];
  if (corrections.length) {
    parts.push('LEARNED FROM THIS USER\'S PAST CORRECTIONS (apply these automatically when you see the left value):\n' +
      corrections.map(c => `"${c.original_value}" → "${c.corrected_value}" (${c.field_name}, corrected ${c.times}×)`).join('\n'));
  }
  if (style && style.total >= 3) {
    const prods = (style.products || []).map(p => `${p.product}(${p.n})`).join(', ');
    const areas = (style.areas || []).map(a => a.area).join(', ');
    parts.push(`THIS USER'S HABITS (${style.total} leads): ` +
      (prods ? `usually sells ${prods}. ` : '') +
      (areas ? `Usual areas: ${areas}. ` : '') +
      'Prefer these interpretations when the input is ambiguous.');
  }

  const out = { text: parts.join('\n\n'), corrections: corrections.length, profiled: !!(style && style.total >= 3) };
  cache.put(cacheKey, out, 300);
  return out;
}

// Tolerant JSON extraction: strips code fences, falls back to the
// first balanced {...} block if the model added prose around it.
function parseModelJson(raw) {
  let text = String(raw || '').trim()
    .replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(text); } catch {}
  const start = text.indexOf('{');
  if (start === -1) throw new Error('No JSON in model output');
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') { depth--; if (depth === 0) return JSON.parse(text.slice(start, i + 1)); }
  }
  throw new Error('Unbalanced JSON in model output');
}

function normaliseItems(parsed) {
  if (!Array.isArray(parsed.items) || !parsed.items.length) {
    parsed.items = parsed.product
      ? [{ product: parsed.product, quantity: parsed.quantity || '', rate: parsed.rate || '' }]
      : [];
  }
  return parsed;
}

// ── GeminiProvider class ──────────────────────────────────────
class GeminiProvider {
  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY;
    // Newest first; older models are automatic fallbacks on 404/429/503
    this.models = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash'];
  }

  async _call(model, systemPrompt, parts, opts = {}) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`;
    const generationConfig = {
      temperature:      opts.temperature ?? 0.1,
      maxOutputTokens:  opts.maxOutputTokens ?? 2000,
      responseMimeType: opts.responseMimeType ?? 'application/json',
    };
    // 2.5 models burn output tokens on internal "thinking" by default,
    // which truncates the JSON — disable it for fast extraction.
    if (model.startsWith('gemini-2.5')) generationConfig.thinkingConfig = { thinkingBudget: 0 };
    const res = await axios.post(url, {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts }],
      generationConfig,
    }, { timeout: 45000 });
    return res.data.candidates[0].content.parts[0].text;
  }

  async _generateWithFallback(systemPrompt, parts, maxOutputTokens, label) {
    for (const model of this.models) {
      const t0 = Date.now();
      try {
        const raw = await this._call(model, systemPrompt, parts, { maxOutputTokens });
        const parsed = normaliseItems(parseModelJson(raw));
        return { parsed, model, latency: Date.now() - t0 };
      } catch (err) {
        const code = err.response?.data?.error?.code;
        if ([400, 404, 429, 503].includes(code)) { console.warn(`⚠️ Gemini ${label} ${model} (${code})`); continue; }
        console.error(`Gemini ${label} error:`, err.response?.data?.error?.message || err.message);
      }
    }
    return null;
  }

  // Free-form text generation (assistant replies, not JSON extraction)
  async generateText(systemPrompt, userText, maxOutputTokens = 1200) {
    for (const model of this.models) {
      const t0 = Date.now();
      try {
        const raw = await this._call(model, systemPrompt, [{ text: userText }],
          { maxOutputTokens, responseMimeType: 'text/plain', temperature: 0.4 });
        return { text: String(raw || '').trim(), model, latency: Date.now() - t0 };
      } catch (err) {
        const code = err.response?.data?.error?.code;
        if ([400, 404, 429, 503].includes(code)) { console.warn(`⚠️ Gemini assistant ${model} (${code})`); continue; }
        console.error('Gemini assistant error:', err.response?.data?.error?.message || err.message);
      }
    }
    return null;
  }

  async generate(userText, vocab = [], extra = '') {
    return this._generateWithFallback(buildSystemPrompt(vocab, extra), [{ text: userText }], 2000, 'text');
  }

  async generateFromAudio(audioBase64, mimeType = 'audio/ogg', vocab = [], extra = '') {
    const voicePrompt = buildSystemPrompt(vocab, extra) +
      '\n\nThe user sent a VOICE NOTE — it may be in Hindi, English, or Hinglish (mixed). ' +
      'First transcribe the audio carefully (keep product names and numbers exact), then extract CRM fields from the transcription. ' +
      'Add a "_transcript" key to the JSON containing your exact transcription of the audio.';
    return this._generateWithFallback(voicePrompt, [
      { inline_data: { mime_type: mimeType, data: audioBase64 } },
      { text: 'Transcribe and extract CRM lead data as JSON (include "_transcript").' },
    ], 2500, 'voice');
  }

  async generateFromImage(imageBase64, mimeType = 'image/jpeg', caption = '', vocab = [], extra = '') {
    const imagePrompt = buildSystemPrompt(vocab, extra) +
      '\n\nThe user sent a PHOTO — it may be a business card, shop/factory signboard, letterhead, product label, ' +
      'or a handwritten note (possibly in Hindi/Devanagari). Read ALL text in the image and extract CRM fields from it. ' +
      'Business cards: the company name → factory_name, the person\'s name → person_in_charge, phone → contact, city → area. ' +
      'Add a "_image_text" key to the JSON containing the raw text you could read in the image.';
    const parts = [{ inline_data: { mime_type: mimeType, data: imageBase64 } }];
    parts.push({ text: caption
      ? `User's caption (extra context, may contain fields too): ${caption}\nExtract CRM lead data as JSON (include "_image_text").`
      : 'Extract CRM lead data from this photo as JSON (include "_image_text").' });
    return this._generateWithFallback(imagePrompt, parts, 2500, 'image');
  }

  // Map spreadsheet columns → CRM fields for the importer. Returns
  // { mapping:[fieldOrEmpty per column], model } or null on failure.
  async mapImport(headers, sampleRows, products = []) {
    const sys = `You map spreadsheet columns to a CRM's fields for an adhesive sales team in India. Output ONLY a single raw JSON object — no markdown, no code fences.

CRM FIELDS and their meaning:
- factory_number: a short alphanumeric party/lead code (e.g. M277, F12, D5).
- factory_name: the company / business / party / firm name.
- person_in_charge: the contact person's name (proprietor/owner/concerned person).
- contact: a phone / mobile / whatsapp number.
- product: the product / item / material being sold.
- quantity: amount with unit (e.g. "500 kg").
- rate: price per unit (a number).
- stage: the sales stage / status / deal stage.
- follow_up: a date (next visit / follow-up).
- area: city / region / district / location / zone.
- notes: remarks / comments / description / anything else.
- lead_type: the temperature / priority (Hot, Warm, Cold).
- created_by: the salesman / salesperson / executive name (ONLY if a column clearly lists staff who own the lead).

RULES:
- For EACH input column, choose the single best-fitting CRM field, or "" if it fits none.
- Do NOT map two different columns to the same field — if two compete, keep the stronger one and set the other to "".
- Use the sample values (not just the header text) to decide. A column of phone numbers is "contact" even if titled oddly.
- Return exactly one entry per column, in the same order.

Return ONLY: {"mapping": ["field-or-empty", ...], "notes": ""}`;

    const productHint = products && products.length
      ? `\n\nKNOWN PRODUCTS (helps recognise a product column): ${products.slice(0, 60).join(', ')}.`
      : '';
    const sample = (sampleRows || []).slice(0, 5)
      .map(r => headers.map((h, i) => `${h}=${String(r[i] ?? '').slice(0, 30)}`).join(' | '))
      .join('\n');
    const user = `COLUMNS (in order):\n${headers.map((h, i) => `[${i}] "${h}"`).join('\n')}${productHint}\n\nSAMPLE ROWS:\n${sample}\n\nReturn the JSON with a "mapping" array of exactly ${headers.length} entries.`;

    for (const model of this.models) {
      try {
        const raw = await this._call(model, sys, [{ text: user }], { maxOutputTokens: 900 });
        const parsed = parseModelJson(raw);
        if (Array.isArray(parsed.mapping)) return { mapping: parsed.mapping, model };
      } catch (err) {
        const code = err.response?.data?.error?.code;
        if ([400, 404, 429, 503].includes(code)) { console.warn(`⚠️ Gemini import-map ${model} (${code})`); continue; }
        console.error('Gemini import-map error:', err.response?.data?.error?.message || err.message);
      }
    }
    return null;
  }

  // Map messy product strings to the catalog, or "unknown" + 1-3 NEW-product
  // suggestions. Strict JSON, temperature 0. The AI may only PICK a catalog name
  // or SUGGEST new ones — it never writes anything itself.
  async resolveProducts(catalogNames, rawStrings) {
    const sys = `You clean up product names for an adhesive / chemicals sales business. Output ONLY a single raw JSON object — no markdown, no code fences.

CATALOG — the ONLY valid product names you may use in "map":
${catalogNames.length ? catalogNames.map(n => '- ' + n).join('\n') : '(the catalog is currently empty)'}

For EACH input string decide:
- If it clearly refers to one of the catalog products (exact match, an obvious alias, abbreviation, or misspelling), set "map" to that EXACT catalog name, copied verbatim.
- Otherwise set "map" to "unknown" and propose 1-3 NEW products it could become, each with a short "division" (category). NEVER invent a catalog name in "map".

Return ONLY:
{"results":[{"raw":"<input string>","map":"<exact catalog name>|unknown","suggestions":[{"name":"<proposed product>","division":"<category>"}]}]}
Every input string must appear exactly once. Use "suggestions":[] when map is a catalog name.`;
    const user = `Input strings:\n${(rawStrings || []).map(s => '- ' + s).join('\n')}`;
    for (const model of this.models) {
      try {
        const raw = await this._call(model, sys, [{ text: user }], { maxOutputTokens: 1800, temperature: 0 });
        const parsed = parseModelJson(raw);
        if (Array.isArray(parsed.results)) return { results: parsed.results, model };
      } catch (err) {
        const code = err.response?.data?.error?.code;
        if ([400, 404, 429, 503].includes(code)) { console.warn(`⚠️ Gemini resolveProducts ${model} (${code})`); continue; }
        console.error('Gemini resolveProducts error:', err.response?.data?.error?.message || err.message);
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
async function runUnderstandingPipeline(text, teamId, username, sessionId) {
  const t0 = Date.now();

  // 1. Preprocessing (personal vocab is keyed by numeric user id)
  const user = username ? await db.getUserByName(username).catch(() => null) : null;
  const [teamVocab, personalVocab] = await Promise.all([
    teamId ? db.getVocab(teamId) : [],
    user?.id ? db.getPersonalVocab(user.id) : [],
  ]);
  const { cleanedText, substitutions } = preprocessInput(text, teamVocab, personalVocab);

  // 2. CRM context + per-user learning context
  const [crmContext, learning] = await Promise.all([
    buildCRMContext(cleanedText, teamId),
    buildUserLearningContext(username, teamId),
  ]);
  const augmented = crmContext ? `${cleanedText}\n\n[CRM CONTEXT]\n${crmContext}` : cleanedText;

  // 3. Gemini
  const result = await gemini.generate(augmented, [], learning.text);
  if (!result) {
    return { error: 'Could not parse — try again with more detail.', fallback: localParse(cleanedText) };
  }

  const { parsed, model, latency } = result;
  const confidence = parsed._confidence || {};

  // 4. Clarification check
  const clarification = clarificationEngine(parsed, confidence);

  // 5. Audit log
  db.logAiAction(null, 'understand', 'text', text, parsed, username, teamId).catch(() => {});

  return {
    sessionId,
    parsed,
    confidence,
    substitutions,
    model,
    latency: Date.now() - t0,
    needsClarification: !!clarification,
    clarification,
    learning: { corrections: learning.corrections, profiled: learning.profiled, vocab: teamVocab.length + personalVocab.length },
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
    const [vocab, learning] = await Promise.all([
      db.getVocab(teamId || null).catch(() => []),
      buildUserLearningContext(req.user.username, teamId),
    ]);
    const audioResult = await gemini.generateFromAudio(audioBase64, mimeType, vocab, learning.text);
    if (!audioResult) return res.status(422).json({ error: 'Could not parse audio — try speaking more clearly or use text instead.' });

    const { parsed, model, latency } = audioResult;
    const confidence    = parsed._confidence || {};
    const clarification = clarificationEngine(parsed, confidence);
    const sessionId     = uuidv4();

    db.logAiAction(null, 'understand_voice', 'voice', parsed._transcript || 'audio', parsed, req.user.username, teamId).catch(() => {});

    res.json({
      sessionId, parsed, confidence, substitutions: [], model, latency,
      transcript: parsed._transcript || '',
      needsClarification: !!clarification, clarification,
    });
  } catch (err) { next(err); }
});

// ── POST /api/ai/understand/image ────────────────────────────
router.post('/ai/understand/image', authMiddleware, async (req, res, next) => {
  const { imageBase64, mimeType = 'image/jpeg', caption = '', teamId } = req.body || {};
  if (!imageBase64) return res.status(400).json({ error: 'imageBase64 required' });
  try {
    const [vocab, learning] = await Promise.all([
      db.getVocab(teamId || null).catch(() => []),
      buildUserLearningContext(req.user.username, teamId),
    ]);
    const imgResult = await gemini.generateFromImage(imageBase64, mimeType, String(caption).slice(0, 500), vocab, learning.text);
    if (!imgResult) return res.status(422).json({ error: 'Could not read the image — try a clearer, well-lit photo.' });

    const { parsed, model, latency } = imgResult;
    const confidence    = parsed._confidence || {};
    const clarification = clarificationEngine(parsed, confidence);
    const sessionId     = uuidv4();

    db.logAiAction(null, 'understand_image', 'image', parsed._image_text || 'image', parsed, req.user.username, teamId).catch(() => {});

    res.json({
      sessionId, parsed, confidence, substitutions: [], model, latency,
      imageText: parsed._image_text || '',
      needsClarification: !!clarification, clarification,
    });
  } catch (err) { next(err); }
});

// ── POST /api/import/ai-map — AI maps spreadsheet columns → CRM fields ──
const IMPORT_MAP_FIELDS = new Set([
  'factory_number', 'factory_name', 'person_in_charge', 'contact', 'product',
  'quantity', 'rate', 'stage', 'follow_up', 'area', 'notes', 'lead_type', 'created_by',
]);
router.post('/import/ai-map', authMiddleware, async (req, res, next) => {
  const headers = Array.isArray(req.body?.headers) ? req.body.headers.map(h => String(h || '')) : [];
  const rows    = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!headers.length) return res.status(400).json({ error: 'headers required' });
  if (headers.length > 60) return res.status(400).json({ error: 'Too many columns for AI mapping' });
  try {
    // Products in the caller's context help the AI recognise a product column.
    let products = [];
    try {
      const teamId = parseInt(req.body?.teamId, 10) || null;
      products = (await db.getProductsForContext(req.user.username, teamId)).map(p => p.name);
    } catch (_) {}

    const result = await gemini.mapImport(headers, rows, products);
    if (!result) return res.status(502).json({ error: 'AI mapping is unavailable right now — map the columns manually.' });

    // Only accept known field names, and never let two columns claim the same field.
    const used = new Set();
    const mapping = headers.map((_, i) => {
      const f = String(result.mapping[i] || '').trim();
      if (!IMPORT_MAP_FIELDS.has(f) || used.has(f)) return '';
      used.add(f);
      return f;
    });
    db.logAiAction(null, 'import_map', 'file', headers.join(', '), { mapping }, req.user.username, null).catch(() => {});
    res.json({ mapping, model: result.model });
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

// ── POST /api/ai/correct — log correction + auto-learn ────────
const LEARNABLE_FIELDS = ['factory_name', 'person_in_charge', 'area', 'product', 'factory_number'];

router.post('/ai/correct', authMiddleware, async (req, res, next) => {
  const { sessionId, field, originalValue, correctedValue, rawInput, teamId } = req.body || {};
  if (!field || correctedValue === undefined) return res.status(400).json({ error: 'field and correctedValue required' });
  try {
    const user = await db.getUserByName(req.user.username);
    await db.logCorrection(sessionId, field, originalValue, correctedValue, rawInput, user?.id, teamId);

    // Auto-learn: the same fix made twice becomes a personal vocab rule
    let learned = false;
    const orig = String(originalValue || '').trim();
    const corr = String(correctedValue || '').trim();
    if (user && LEARNABLE_FIELDS.includes(field) &&
        orig && corr && orig.toLowerCase() !== corr.toLowerCase() &&
        orig.length <= 40 && corr.length <= 60) {
      const times = await db.countSameCorrection(user.id, field, orig, corr).catch(() => 0);
      if (times >= 2) {
        await db.addPersonalVocab(user.id, orig, corr).catch(() => {});
        cache.remove(`learn_${req.user.username}_${teamId || 0}`);
        cache.remove(`learn_${req.user.username}_0`);
        learned = true;
      }
    }
    res.json({ ok: true, learned, alias: learned ? orig : undefined, canonical: learned ? corr : undefined });
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

// ============================================================
//  IN-APP ASSISTANT — answers questions about the user's CRM data
// ============================================================
const { leadsForRequest } = require('./leads');

function parseFuDate(s) {
  const m = String(s || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
}

function buildAssistantContext(leads) {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  now.setHours(0, 0, 0, 0);
  let overdue = 0, dueToday = 0;
  for (const l of leads) {
    const d = parseFuDate(l.follow_up);
    if (!d || l.stage === 'Lost') continue;
    if (d < now) overdue++;
    else if (d.getTime() === now.getTime()) dueToday++;
  }
  const lines = leads.slice(0, 120).map(l => {
    const items = (l.items || []).map(i => `${i.product} ${i.quantity}${i.rate ? '@₹' + i.rate : ''}`).join(' + ');
    return [
      l.factory_number || '—', l.factory_name || '—', l.person_in_charge || '',
      l.stage || '', l.lead_type || '', 'FU:' + (l.follow_up || '—'),
      l.area || '', items, l.created_by ? 'by ' + l.created_by : '',
    ].filter(Boolean).join(' | ');
  });
  return `\n\nCRM SNAPSHOT — ${leads.length} leads visible to this user ` +
    `(${overdue} overdue follow-ups, ${dueToday} due today).\n` +
    `Each line: number | name | person | stage | type | follow-up | area | items | owner\n` +
    lines.join('\n').slice(0, 9000);
}

const ASSISTANT_PROMPT_BASE =
`You are the built-in assistant of SalesCRM, used by an adhesive sales team in India.
Answer questions about the user's CRM data below: counts, pipelines, follow-ups, who to call today, revenue potential (quantity × rate), best next actions.
Rules:
- Answer ONLY from the CRM snapshot. If the data doesn't contain the answer, say so.
- Be concise: a short sentence or a list of at most 10 rows. Use the user's language (English or Hinglish).
- Format with plain text, **bold** for emphasis, and "- " bullets. No tables, no HTML, no markdown headers.
- If asked to change or add data, reply that they can use ⚡ Command mode (e.g. "add party Sharma Traders Rakeshji 98765…" or "set M277 stage to won").
- Dates are dd/MM/yyyy.`;

router.post('/ai/assistant', authMiddleware, async (req, res, next) => {
  const { message, history = [], teamId } = req.body || {};
  if (!message || !String(message).trim()) return res.status(400).json({ error: 'message required' });
  try {
    let leads = [];
    try { leads = await leadsForRequest({ user: req.user, query: { teamId: teamId || '' } }); } catch (_) {}
    const sys = ASSISTANT_PROMPT_BASE +
      `\n\nTODAY: ${todayISTLabel()} (dd/MM/yyyy, IST).` +
      buildAssistantContext(leads);

    const convo = (Array.isArray(history) ? history.slice(-8) : [])
      .map(h => `${h.role === 'user' ? 'User' : 'Assistant'}: ${String(h.text || '').slice(0, 600)}`)
      .concat(`User: ${String(message).slice(0, 1200)}`)
      .join('\n');

    const result = await gemini.generateText(sys, convo);
    if (!result || !result.text) return res.status(422).json({ error: 'Assistant is unavailable right now — try again in a minute.' });

    db.logAiAction(null, 'assistant', 'text', String(message).slice(0, 500),
      { reply: result.text.slice(0, 1500) }, req.user.username, teamId).catch(() => {});
    res.json({ reply: result.text, model: result.model, latency: result.latency });
  } catch (err) { next(err); }
});

// ============================================================
//  COMMAND MODE — natural-language commands that execute
// ============================================================
const COMMAND_PROMPT =
`You convert one natural-language CRM command (English or Hinglish) into a JSON action.
Actions:
- "create_lead": add a NEW party/lead — triggers like "add party …", "new party …", "create lead …", "nayi party …", "party add karo", or a message that is clearly introducing a brand-new customer with their details.
- "update_stage": change an existing lead's stage. Map to: New Lead=1, Sample Required=2, Sample Sent=3, Quotation=4, Negotiation=5, Order Won=6 ("won"/"jeet gaye"), Repeat Customer=7, Lost=0 ("lost"/"cancel"/"nahi chahiye").
- "set_followup": set follow-up date (resolve relative dates; output dd/MM/yyyy).
- "set_lead_type": set temperature Hot/Warm/Cold ("garam"=Hot, "thanda"=Cold).
- "add_note": append a note to the lead.
- "find": search leads ("query" = search text).
- "unsupported": anything else (deleting, creating users, bulk changes…) — set "reason".
"target" = the factory number (e.g. M277) or factory name mentioned.
Return ONLY JSON:
{"action":"","target":"","stage":"","stage_number":null,"date":"","lead_type":"","note":"","query":"","reason":""}`;

const STAGE_BY_NUM = { 0: 'Lost', 1: 'New Lead', 2: 'Sample Required', 3: 'Sample Sent', 4: 'Quotation', 5: 'Negotiation', 6: 'Order Won', 7: 'Repeat Customer' };

router.post('/ai/command', authMiddleware, async (req, res, next) => {
  const { command, teamId, preview, destTeamId } = req.body || {};
  // preview:true → parse + validate + resolve the target, but DON'T write.
  // The client shows the interpreted action for the user to Confirm or Edit,
  // then re-sends (preview omitted) to actually execute it.
  const isPreview = !!preview;
  if (!command || !String(command).trim()) return res.status(400).json({ error: 'command required' });
  // Guests can't mutate — catch obvious add/create commands before spending AI quota
  if (req.user.role === 'guest' && /\b(add|create|new|nayi|naya)\s+(party|lead|customer)\b/i.test(String(command))) {
    return res.status(403).json({ error: 'demo_only', message: 'Create an account to save data' });
  }
  try {
    const result = await gemini._generateWithFallback(
      COMMAND_PROMPT + `\nTODAY: ${todayISTLabel()} (dd/MM/yyyy, IST).`,
      [{ text: String(command).slice(0, 600) }], 600, 'command');
    if (!result) return res.status(422).json({ error: 'Could not understand the command — try rephrasing.' });
    const cmd = result.parsed || {};

    let leads = [];
    try { leads = await leadsForRequest({ user: req.user, query: { teamId: teamId || '' } }); } catch (_) {}

    // FIND — search and return matches
    if (cmd.action === 'find') {
      const q = String(cmd.query || cmd.target || '').toLowerCase().trim();
      const matches = leads.filter(l =>
        [l.factory_number, l.factory_name, l.person_in_charge, l.area]
          .some(v => String(v || '').toLowerCase().includes(q))
      ).slice(0, 5);
      return res.json({
        ok: true, action: 'find',
        message: matches.length ? `Found ${matches.length} lead${matches.length > 1 ? 's' : ''}:` : `No leads matching "${q}".`,
        results: matches.map(l => ({
          rowIndex: l.rowIndex, factory_number: l.factory_number, factory_name: l.factory_name,
          person_in_charge: l.person_in_charge, stage: l.stage, lead_type: l.lead_type, follow_up: l.follow_up,
        })),
      });
    }

    // CREATE — add a new party/lead from the command text
    if (cmd.action === 'create_lead') {
      if (req.user.role === 'guest') return res.status(403).json({ error: 'demo_only', message: 'Create an account to save data' });

      // Reuse the full understanding pipeline (vocab, learning, CRM context)
      const cleaned = String(command).replace(/^\s*(add|create|new|nayi|naya)\s+(party|lead|customer)\b[:,\s]*/i, '').trim();
      const understanding = await runUnderstandingPipeline(cleaned || String(command), teamId, req.user.username, uuidv4());
      const parsed = understanding.parsed || understanding.fallback;
      if (!parsed || (!parsed.factory_number && !parsed.factory_name)) {
        return res.json({ ok: false, message: 'What is the party\'s name or factory number? Try: "add party M901 Sharma Traders Rakeshji 9876543210 hotmelt 500@120 hot, surat"' });
      }

      const payload = {
        factory_number:   parsed.factory_number   || '',
        factory_name:     parsed.factory_name     || '',
        person_in_charge: parsed.person_in_charge || '',
        contact:          parsed.contact          || '',
        stage:            parsed.stage            || 'New Lead',
        stage_number:     parsed.stage_number != null ? parsed.stage_number : 1,
        follow_up:        parsed.follow_up        || '',
        area:             parsed.area             || '',
        notes:            parsed.notes            || '',
        lead_type:        parsed.lead_type        || '',
        items:            Array.isArray(parsed.items) ? parsed.items : [],
        team_id:          teamId ? parseInt(teamId, 10) : null,
      };
      // Honor the user's "Save to" default for where the new lead is stored,
      // but only if they're actually an active member of that team.
      if (destTeamId) {
        const actor  = await db.getUserByName(req.user.username).catch(() => null);
        const member = actor && await db.getTeamMember(parseInt(destTeamId, 10), actor.id).catch(() => null);
        if (member && member.status === 'active') payload.team_id = parseInt(destTeamId, 10);
      }
      if (payload.items.length) {
        payload.product  = payload.items[0].product;
        payload.quantity = payload.items[0].quantity;
        payload.rate     = payload.items[0].rate;
      }
      // No area mentioned → fall back to the user's default area
      if (!payload.area) {
        const creator = await db.getUserByName(req.user.username).catch(() => null);
        if (creator?.default_area) payload.area = creator.default_area;
      }

      if (isPreview) {
        const pv = [`Add party <b>${payload.factory_name || payload.factory_number}</b>`];
        if (payload.person_in_charge) pv.push(`👤 ${payload.person_in_charge}`);
        if (payload.items.length)     pv.push(`📦 ${payload.items.map(i => `${i.product} ${i.quantity}${i.rate ? '@₹' + i.rate : ''}`).join(', ')}`);
        if (payload.lead_type)        pv.push(`🌡 ${payload.lead_type}`);
        if (payload.follow_up)        pv.push(`📅 FU ${payload.follow_up}`);
        if (payload.area)             pv.push(`📍 ${payload.area}`);
        return res.json({ ok: true, preview: true, action: 'create_lead', message: pv.join(' · ') });
      }

      const result = await db.addLead(payload, req.user.username);
      if (result.conflict) {
        return res.json({ ok: false, message: `⚠️ ${result.message} — that party already exists (row ${result.rowIndex}). Say "find ${payload.factory_number || payload.factory_name}" to see it.` });
      }

      db.logLeadActivity(result.rowIndex, payload.team_id, 'created',
        `Party added via AI command by ${req.user.username}`, {}, req.user.username).catch(() => {});
      db.logAiAction(result.rowIndex, 'command_create', 'text', String(command).slice(0, 500), parsed, req.user.username, teamId).catch(() => {});

      const bits = [`✅ Party added: <b>${payload.factory_name || payload.factory_number}</b>`];
      if (payload.person_in_charge) bits.push(`👤 ${payload.person_in_charge}`);
      if (payload.items.length)     bits.push(`📦 ${payload.items.map(i => `${i.product} ${i.quantity}${i.rate ? '@₹' + i.rate : ''}`).join(', ')}`);
      if (payload.lead_type)        bits.push(`🌡 ${payload.lead_type}`);
      if (payload.follow_up)        bits.push(`📅 FU ${payload.follow_up}`);
      return res.json({ ok: true, action: 'create_lead', message: bits.join(' · '), rowIndex: result.rowIndex });
    }

    if (cmd.action === 'unsupported' || !['update_stage', 'set_followup', 'set_lead_type', 'add_note'].includes(cmd.action)) {
      return res.json({ ok: false, message: cmd.reason || 'I can add a party, update stage, set follow-up, change temperature, or add a note. Deleting must be done from the Leads table.' });
    }

    // Locate the target lead among the user's visible leads
    const target = String(cmd.target || '').toLowerCase().trim();
    if (!target) return res.json({ ok: false, message: 'Which lead? Mention the factory number or name (e.g. "set M277 stage to won").' });
    const lead = leads.find(l => String(l.factory_number || '').toLowerCase() === target)
      || leads.find(l => String(l.factory_name || '').toLowerCase().includes(target));
    if (!lead) return res.json({ ok: false, message: `No lead found for "${cmd.target}" in your view.` });
    if (req.user.role === 'guest') return res.status(403).json({ error: 'demo_only', message: 'Create an account to save data' });
    if (lead.can_edit === false) return res.json({ ok: false, message: `You don't have edit access to ${lead.factory_name || lead.factory_number}. Use 🔑 Request on the Leads page.` });

    const rowIndex = parseInt(lead.rowIndex, 10);
    const label = lead.factory_name || lead.factory_number;
    let update = {}, message = '';

    if (cmd.action === 'update_stage') {
      const num = cmd.stage_number != null ? Number(cmd.stage_number) : null;
      const stage = STAGE_BY_NUM[num] || cmd.stage;
      if (!stage) return res.json({ ok: false, message: 'Which stage? (New Lead, Sample Sent, Quotation, Negotiation, Order Won, Lost…)' });
      update = { stage, stage_number: String(num ?? (Object.entries(STAGE_BY_NUM).find(([, s]) => s === stage)?.[0] ?? '')) };
      message = `✅ ${label} → stage <b>${stage}</b>`;
    } else if (cmd.action === 'set_followup') {
      if (!/^\d{2}\/\d{2}\/\d{4}$/.test(cmd.date || '')) return res.json({ ok: false, message: 'Which date? Try "follow up M277 tomorrow" or a dd/MM/yyyy date.' });
      update = { follow_up: cmd.date };
      message = `✅ ${label} → follow-up <b>${cmd.date}</b>`;
    } else if (cmd.action === 'set_lead_type') {
      if (!['Hot', 'Warm', 'Cold'].includes(cmd.lead_type)) return res.json({ ok: false, message: 'Which temperature — Hot, Warm, or Cold?' });
      update = { lead_type: cmd.lead_type };
      message = `✅ ${label} → <b>${cmd.lead_type}</b> lead`;
    } else if (cmd.action === 'add_note') {
      const note = String(cmd.note || '').trim();
      if (!note) return res.json({ ok: false, message: 'What should the note say?' });
      const existing = String(lead.notes || '').trim();
      update = { notes: existing ? `${existing} | ${note}` : note };
      message = `✅ Note added to ${label}`;
    }

    if (isPreview) {
      // Strip the "done" tick — this is a proposal, not a result yet.
      return res.json({ ok: true, preview: true, action: cmd.action, message: message.replace(/^✅\s*/, ''), rowIndex });
    }

    await db.updateLead(rowIndex, update);
    db.logLeadActivity(rowIndex, lead.team_id || null, 'edit',
      `Via AI command by ${req.user.username}: ${String(command).slice(0, 120)}`, {}, req.user.username).catch(() => {});
    db.logAiAction(rowIndex, 'command', 'text', String(command).slice(0, 500), cmd, req.user.username, teamId).catch(() => {});

    res.json({ ok: true, action: cmd.action, message, rowIndex });
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
    const vocab  = await db.getVocab(null).catch(() => []);
    const result = await gemini.generateFromAudio(audioBase64, mimeType, vocab);
    if (!result) return res.status(422).json({ error: 'Could not parse audio — try speaking more clearly or use text instead.' });
    const { parsed } = result;
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
