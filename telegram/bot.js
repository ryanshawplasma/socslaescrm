'use strict';

const axios  = require('axios');
const fs     = require('fs');
const path   = require('path');
const { v4: uuidv4 } = require('uuid');
const db     = require('../db');
const cache  = require('../cache');
const { gemini, localParse } = require('../routes/ai');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_API   = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const uploadsDir     = path.join(__dirname, '..', 'uploads');

// ── HTML escaping ─────────────────────────────────────────────
function esc(v) {
  if (v === undefined || v === null || String(v).trim() === '') return '—';
  return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Date helpers ──────────────────────────────────────────────
function dateIST(offsetDays = 0) {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000) + now.getTimezoneOffset() * 60000);
  ist.setDate(ist.getDate() + offsetDays);
  const dd   = String(ist.getDate()).padStart(2, '0');
  const mm   = String(ist.getMonth() + 1).padStart(2, '0');
  const yyyy = ist.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function todayIST() {
  return new Date().toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric',
  });
}

function nowHHMM() {
  return new Date().toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  }).trim();
}

function parseDateInput(text) {
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(text)) return text;
  const tl = text.toLowerCase();
  if (/next week/i.test(tl))   return dateIST(7);
  if (/tomorrow/i.test(tl))    return dateIST(1);
  if (/in 2 days/i.test(tl))  return dateIST(2);
  if (/in 2 weeks/i.test(tl)) return dateIST(14);
  if (/next month/i.test(tl)) return dateIST(30);
  const parsed = new Date(text);
  if (!isNaN(parsed.getTime())) {
    return `${String(parsed.getDate()).padStart(2,'0')}/${String(parsed.getMonth()+1).padStart(2,'0')}/${parsed.getFullYear()}`;
  }
  return text;
}

function parseFollowUpDate(s) {
  if (!s) return null;
  const [d, m, y] = s.split('/');
  if (!d || !m || !y) return null;
  return new Date(Number(y), Number(m) - 1, Number(d));
}

const STAGE_NAMES = { 0:'Lost', 1:'New Lead', 2:'Sample Required', 3:'Sample Sent', 4:'Quotation', 5:'Negotiation', 6:'Order Won', 7:'Repeat Customer' };

function parseStageInput(text) {
  const n = parseInt(text, 10);
  if (!isNaN(n) && n >= 0 && n <= 7) return { stage: STAGE_NAMES[n], stage_number: n };
  const nameMap = { 'new lead':1,'sample required':2,'sample req':2,'sample sent':3,'quotation':4,'negotiation':5,'order won':6,'won':6,'repeat customer':7,'repeat':7,'lost':0 };
  const match = nameMap[text.toLowerCase().trim()];
  if (match !== undefined) return { stage: STAGE_NAMES[match], stage_number: match };
  return { stage: text, stage_number: null };
}

function parseItemsText(text) {
  const productAliases = {
    'rubber adhesive':'Rubber Adhesive','rub ad':'Rubber Adhesive','rubad':'Rubber Adhesive',
    'hotmelt':'Hotmelt','hotmolt':'Hotmelt','htmlt':'Hotmelt','hmelt':'Hotmelt',
    'solvent':'Solvent','solv':'Solvent','latex':'Latex','ltx':'Latex',
  };
  const parts = text.split(/[,;]/).map(s => s.trim()).filter(Boolean);
  return parts.map(part => {
    const pl = part.toLowerCase();
    let productName = '';
    for (const [alias, name] of Object.entries(productAliases)) {
      if (pl.includes(alias)) { productName = name; break; }
    }
    const tokens = part.trim().split(/\s+/);
    if (!productName && tokens.length >= 1) productName = tokens[0].replace(/\b\w/g, c => c.toUpperCase());
    const nums = part.match(/\d+(?:\.\d+)?/g) || [];
    return { product: productName, quantity: nums[0] || '', rate: nums[1] ? '₹' + nums[1] : '' };
  });
}

// ── Telegram send ─────────────────────────────────────────────
async function sendTelegram(method, params) {
  try { await axios.post(`${TELEGRAM_API}/${method}`, params); }
  catch (err) { console.error(`Telegram.${method}:`, err.response?.data || err.message); }
}

// ── Format contacts ───────────────────────────────────────────
function formatContacts(lead) {
  const contacts = (lead.contacts || []).filter(c => c.person_name || c.contact);
  if (!contacts.length) return `👤 ${esc(lead.person_in_charge || '—')}  📞 ${esc(lead.contact || '—')}`;
  if (contacts.length === 1) return `👤 ${esc(contacts[0].person_name || '—')}  📞 ${esc(contacts[0].contact || '—')}`;
  return contacts.map((c, i) =>
    `${i === 0 ? '👤' : '   '} ${esc(c.person_name || '—')} — 📞 ${esc(c.contact || '—')}${c.designation ? ` <i>(${esc(c.designation)})</i>` : ''}`
  ).join('\n');
}

// ── Find existing lead ────────────────────────────────────────
async function findExistingLead(parsed) {
  const leads = await db.getLeads();
  const pNum  = String(parsed.factory_number || '').trim().toLowerCase();
  const pName = String(parsed.factory_name   || '').trim().toLowerCase();
  let existingRow = -1;
  for (const lead of leads) {
    const rNum  = String(lead.factory_number || '').trim().toLowerCase();
    const rName = String(lead.factory_name   || '').trim().toLowerCase();
    if (pNum && pNum === rNum)             { existingRow = lead.rowIndex; break; }
    if (!pNum && pName && pName === rName) { existingRow = lead.rowIndex; break; }
  }
  return { existingRow, action: existingRow !== -1 ? 'UPDATE' : 'ADD', leads };
}

// ── Build Telegram preview ────────────────────────────────────
function buildPreview(p, action, existingRow) {
  const actionTag    = action === 'UPDATE' ? `🔄 <b>UPDATE</b> — Row ${existingRow}` : '🆕 <b>NEW ENTRY</b>';
  const stageDisplay = p.stage ? esc(p.stage) + (p.stage_number != null ? ` (#${p.stage_number})` : '') : '—';
  const typeEmoji    = { Hot: '🔥', Warm: '🟡', Cold: '🔵' };
  const typeDisplay  = p.lead_type ? (typeEmoji[p.lead_type] || '') + ' ' + esc(p.lead_type) : '—';
  const itemsList    = p.items && p.items.length ? p.items : (p.product ? [{ product: p.product, quantity: p.quantity, rate: p.rate }] : []);
  const itemsBlock   = itemsList.length ? '\n' + itemsList.map((it, i) => `   ${i + 1}. ${esc(it.product)} × ${esc(it.quantity)} @ ₹${esc(it.rate)}`).join('\n') : '\n   —';

  return [
    '📋 <b>CRM Entry Preview</b>', actionTag, '━━━━━━━━━━━━━━━━━━━━',
    `🏭 <b>Factory #:</b>   ${esc(p.factory_number)}`,
    `🏢 <b>Factory:</b>     ${esc(p.factory_name)}`,
    `👤 <b>Person:</b>      ${esc(p.person_in_charge)}`,
    `📞 <b>Contact:</b>     ${esc(p.contact)}`,
    `📦 <b>Items:</b>${itemsBlock}`,
    `📊 <b>Stage:</b>       ${stageDisplay}`,
    `🌡️ <b>Lead Type:</b>   ${typeDisplay}`,
    `📅 <b>Follow Up:</b>   ${esc(p.follow_up)}`,
    `📝 <b>Notes:</b>       ${esc(p.notes)}`,
    `🗺️ <b>Area:</b>        ${esc(p.area)}`,
    '━━━━━━━━━━━━━━━━━━━━',
  ].join('\n');
}

function confirmEditKeyboard(uuid, currentLeadType = '') {
  const hot  = currentLeadType === 'Hot'  ? '🔥 Hot ✓'  : '🔥 Hot';
  const warm = currentLeadType === 'Warm' ? '🟡 Warm ✓' : '🟡 Warm';
  const cold = currentLeadType === 'Cold' ? '🔵 Cold ✓' : '🔵 Cold';
  return {
    inline_keyboard: [
      [{ text: hot, callback_data: 'TEMP_Hot_' + uuid }, { text: warm, callback_data: 'TEMP_Warm_' + uuid }, { text: cold, callback_data: 'TEMP_Cold_' + uuid }],
      [{ text: '✅ Confirm', callback_data: 'CONFIRM_' + uuid }, { text: '✏️ Edit All', callback_data: 'EDITALL_' + uuid }, { text: '❌ Cancel', callback_data: 'CANCEL_' + uuid }],
    ],
  };
}

// ── EDITALL field definitions ─────────────────────────────────
const EDITALL_FIELDS = [
  { key: 'factory_number',   label: 'Factory #',       hint: 'e.g. M277' },
  { key: 'factory_name',     label: 'Factory Name',    hint: 'e.g. Ramesh Industries' },
  { key: 'person_in_charge', label: 'Person in Charge', hint: 'e.g. Rameshji' },
  { key: 'contact',          label: 'Contact #',       hint: '10-digit phone number' },
  { key: 'items',            label: 'Items',           hint: 'Hotmelt 500 120, Solvent 200 80\n(product quantity rate, comma-separated)' },
  { key: 'stage',            label: 'Stage',           hint: '1=New Lead 2=Sample Req 3=Sample Sent\n4=Quotation 5=Negotiation 6=Won 7=Repeat 0=Lost' },
  { key: 'follow_up',        label: 'Follow-up Date',  hint: 'dd/MM/yyyy or "next week", "tomorrow"' },
  { key: 'area',             label: 'Area',            hint: 'e.g. Mumbai, Surat, Bhiwandi' },
  { key: 'notes',            label: 'Notes',           hint: 'Any additional notes' },
  { key: 'lead_type',        label: 'Lead Type',       hint: 'hot / warm / cold' },
];

async function sendEditAllFieldPrompt(chatId, parsed, fieldIndex) {
  const field = EDITALL_FIELDS[fieldIndex];
  let currentVal = '';
  if (field.key === 'items') {
    const items = parsed.items && parsed.items.length ? parsed.items : (parsed.product ? [{ product: parsed.product, quantity: parsed.quantity, rate: parsed.rate }] : []);
    currentVal = items.length ? items.map(i => `${i.product} ${i.quantity} ${i.rate}`).join(', ') : '—';
  } else {
    currentVal = parsed[field.key] || '—';
  }
  const progress = `[${fieldIndex + 1}/${EDITALL_FIELDS.length}]`;
  await sendTelegram('sendMessage', {
    chat_id: chatId, parse_mode: 'HTML',
    text: `${progress} ✏️ <b>${field.label}</b>\n<i>Current: ${esc(String(currentVal))}</i>\n\n${field.hint}\n\n<code>.</code> to keep current`,
  });
}

// ── Notify Order Won ──────────────────────────────────────────
async function notifyOrderWon(lead, byUser) {
  try {
    const items = (lead.items || []).map(i => `${i.product} ${i.quantity}${i.rate ? ' @₹' + i.rate : ''}`).join(', ');
    const text = [
      `🏆 <b>Order Won!</b>`, '',
      `🏭 <b>${esc(lead.factory_name || lead.factory_number)}</b>`,
      items     ? `📦 ${esc(items)}`     : '',
      lead.area ? `📍 ${esc(lead.area)}` : '',
      `👤 Closed by: <b>${esc(byUser)}</b>`,
    ].filter(Boolean).join('\n');
    await sendToAllTelegram(text);
  } catch (_) {}
}

async function sendToAllTelegram(text, opts = {}) {
  const users = await db.getAllUsers();
  for (const u of users) {
    if (!u.telegram_user_id) continue;
    try { await sendTelegram('sendMessage', { chat_id: u.telegram_user_id, text, parse_mode: 'HTML', ...opts }); }
    catch (_) {}
  }
}

async function broadcastFollowUpAvailable(leadId, dateStr) {
  const leads = await db.getLeads();
  const lead  = leads.find(l => l.rowIndex === String(leadId));
  if (!lead) return;
  const users = await db.getAllUsers();
  const typeEmoji = { Hot: '🔥', Warm: '🟡', Cold: '🔵' }[lead.lead_type] || '';
  const text = [
    `📅 <b>Follow-up Available ${typeEmoji}</b>`, '',
    `🏭 <b>${esc(lead.factory_name || lead.factory_number)}</b>`,
    formatContacts(lead),
    `📅 Date: <b>${esc(dateStr)}</b>  📊 ${esc(lead.stage || '—')}`, '',
    '✋ First to tap below handles this follow-up:',
  ].join('\n');
  for (const u of users) {
    if (!u.telegram_user_id) continue;
    try {
      await sendTelegram('sendMessage', {
        chat_id: u.telegram_user_id, text, parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[{ text: '✋ Claim this follow-up', callback_data: 'CLAIM_' + leadId }]] },
      });
    } catch (_) {}
  }
}

// ============================================================
//  VOICE HANDLER
// ============================================================
async function handleVoice(message) {
  const chatId = message.chat.id;
  const fileId = message.voice.file_id;
  const telegramUserId = String(message.from?.id || chatId);
  const registeredUser = await db.getUserByTelegramId(telegramUserId);
  const createdBy = registeredUser ? registeredUser.display_name : '';

  await sendTelegram('sendMessage', { chat_id: chatId, text: '🎤 Processing your voice note...' });

  try {
    const fileRes   = await axios.get(`${TELEGRAM_API}/getFile`, { params: { file_id: fileId } });
    const filePath  = fileRes.data.result.file_path;
    const fileUrl   = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
    const audioRes  = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const audioBase64 = Buffer.from(audioRes.data).toString('base64');

    console.log(`🎤 Voice: ${(audioRes.data.byteLength / 1024).toFixed(1)} KB downloaded`);

    const result = await gemini.generateFromAudio(audioBase64);
    if (!result) {
      await sendTelegram('sendMessage', {
        chat_id: chatId, parse_mode: 'HTML',
        text: '⚠️ Voice note could not be processed. Try a <b>shorter voice note</b> or <b>type</b> the info instead.',
      });
      return;
    }

    const { parsed } = result;
    const { existingRow, action } = await findExistingLead(parsed);
    if (!parsed.stage && action === 'ADD') { parsed.stage = 'New Lead'; parsed.stage_number = 1; }

    const uuid = uuidv4();
    cache.put('data_' + uuid, JSON.stringify({ parsed, existingRow, action, createdBy }), 600);

    await sendTelegram('sendMessage', {
      chat_id: chatId, text: '🎤 ' + buildPreview(parsed, action, existingRow),
      parse_mode: 'HTML', reply_markup: confirmEditKeyboard(uuid, parsed.lead_type),
    });
  } catch (err) {
    console.error('Voice handler error:', err.message);
    await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ Failed to process voice. Try sending as text.' });
  }
}

// ============================================================
//  PHOTO HANDLER
// ============================================================
async function handlePhoto(message) {
  const chatId = message.chat.id;
  const photos = message.photo;
  const largest = photos[photos.length - 1];
  const fileId  = largest.file_id;
  const caption = message.caption || '';
  const telegramUserId = String(message.from?.id || chatId);
  const registeredUser = await db.getUserByTelegramId(telegramUserId);

  const photoSession = cache.get('photo_for_' + chatId);
  if (photoSession) {
    const { leadId } = JSON.parse(photoSession);
    cache.remove('photo_for_' + chatId);
    await savePhotoForLead(chatId, fileId, leadId, caption, registeredUser?.display_name || '');
    return;
  }

  cache.put('photo_pending_' + chatId, JSON.stringify({ fileId, caption, uploadedBy: registeredUser?.display_name || '' }), 300);
  await sendTelegram('sendMessage', { chat_id: chatId, text: '📷 Photo received! Which factory is this for?\nSend factory number or name:' });
}

async function savePhotoForLead(chatId, fileId, leadId, caption, uploadedBy) {
  try {
    const fileRes  = await axios.get(`${TELEGRAM_API}/getFile`, { params: { file_id: fileId } });
    const filePath = fileRes.data.result.file_path;
    const fileUrl  = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
    const imgData  = await axios.get(fileUrl, { responseType: 'arraybuffer' });
    const fileName = `${leadId}_${Date.now()}.jpg`;
    fs.writeFileSync(path.join(uploadsDir, fileName), Buffer.from(imgData.data));
    await db.addPhoto(leadId, `/uploads/${fileName}`, caption, uploadedBy);
    await sendTelegram('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `✅ Photo saved for lead #${leadId}. View in dashboard.` });
  } catch (err) {
    console.error('Photo save error:', err.message);
    await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ Failed to save photo.' });
  }
}

// ============================================================
//  COMMAND HANDLERS
// ============================================================
async function handleFind(chatId, query) {
  if (!query) { await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ Usage: /find M277 or /find Factory Name' }); return; }
  const leads = await db.getLeads();
  const q     = query.toLowerCase();
  const matches = [];
  for (const l of leads) {
    const num       = String(l.factory_number || '').toLowerCase();
    const name      = String(l.factory_name   || '').toLowerCase();
    const allPeople = (l.contacts || []).map(c => c.person_name).join(' ').toLowerCase();
    if (num === q || name.includes(q) || allPeople.includes(q)) { matches.push(l); if (matches.length >= 5) break; }
  }
  if (!matches.length) { await sendTelegram('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `🔍 No leads found for "<b>${esc(query)}</b>".` }); return; }
  const lines = [`🔍 <b>${matches.length} result(s) for "${esc(query)}":</b>`];
  matches.forEach((l, idx) => {
    const te = { Hot: '🔥', Warm: '🟡', Cold: '🔵' }[l.lead_type] || '';
    lines.push('', `${idx + 1}. <b>${esc(l.factory_number)} — ${esc(l.factory_name)}</b> ${te}`);
    lines.push(`   ${formatContacts(l)}`);
    lines.push(`   📊 ${esc(l.stage)}  📅 ${esc(l.follow_up)}`);
  });
  await sendTelegram('sendMessage', { chat_id: chatId, text: lines.join('\n'), parse_mode: 'HTML' });
}

async function handleLeadCard(chatId, query) {
  if (!query) { await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ Usage: /lead M277' }); return; }
  const leads = await db.getLeads();
  const q     = query.toLowerCase();
  const found = leads.find(l =>
    String(l.factory_number || '').toLowerCase() === q ||
    String(l.factory_name   || '').toLowerCase().includes(q)
  );
  if (!found) { await sendTelegram('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `🔍 No lead found for "<b>${esc(query)}</b>".` }); return; }
  const stageDisplay = found.stage ? esc(found.stage) + (found.stage_number ? ` (#${found.stage_number})` : '') : '—';
  const typeEmoji    = { Hot: '🔥', Warm: '🟡', Cold: '🔵' };
  const typeDisplay  = found.lead_type ? (typeEmoji[found.lead_type] || '') + ' ' + esc(found.lead_type) : '—';
  const itemsLines   = (found.items || []).map((it, i) => `   ${i+1}. ${esc(it.product)} × ${esc(it.quantity)} @ ₹${esc(it.rate)}`);
  await sendTelegram('sendMessage', {
    chat_id: chatId, parse_mode: 'HTML',
    text: [
      `📋 <b>Lead Card — Row ${found.rowIndex}</b>`,
      '━━━━━━━━━━━━━━━━━━━━',
      `🏭 <b>Factory #:</b>    ${esc(found.factory_number)}`,
      `🏢 <b>Factory Name:</b> ${esc(found.factory_name)}`,
      `👥 <b>Contacts:</b>`,
      ...((found.contacts || []).filter(c => c.person_name || c.contact).length
        ? (found.contacts || []).filter(c => c.person_name || c.contact).map((c, i) =>
            `   ${i + 1}. ${esc(c.person_name || '—')} — 📞 ${esc(c.contact || '—')}${c.designation ? ` <i>(${esc(c.designation)})</i>` : ''}`)
        : [`   👤 ${esc(found.person_in_charge || '—')}  📞 ${esc(found.contact || '—')}`]),
      `📦 <b>Items:</b>`,
      ...itemsLines,
      `📊 <b>Stage:</b>        ${stageDisplay}`,
      `🌡️ <b>Lead Type:</b>    ${typeDisplay}`,
      `📅 <b>Follow Up:</b>    ${esc(found.follow_up)}`,
      `📝 <b>Notes:</b>        ${esc(found.notes)}`,
      `🗺️ <b>Area:</b>         ${esc(found.area)}`,
      found.created_by ? `👨‍💼 <b>Added by:</b>     ${esc(found.created_by)}` : '',
      `🕐 <b>Updated:</b>      ${esc(found.last_updated)}`,
      '━━━━━━━━━━━━━━━━━━━━',
    ].filter(Boolean).join('\n'),
  });
}

async function handleFollowups(chatId) {
  const leads = await db.getLeads();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const overdue = [], todayList = [];
  for (const l of leads) {
    const fuStr = String(l.follow_up || '').trim();
    if (!fuStr) continue;
    const parts = fuStr.split(/[\/\-]/);
    if (parts.length < 3) continue;
    const fuDate = new Date(parseInt(parts[2].length === 2 ? '20' + parts[2] : parts[2], 10), parseInt(parts[1], 10) - 1, parseInt(parts[0], 10));
    fuDate.setHours(0, 0, 0, 0);
    if (isNaN(fuDate.getTime())) continue;
    if (fuDate < today) overdue.push(l);
    else if (fuDate.getTime() === today.getTime()) todayList.push(l);
  }
  if (!overdue.length && !todayList.length) { await sendTelegram('sendMessage', { chat_id: chatId, text: '✅ No follow-ups due today or overdue.' }); return; }
  const lines = ['📅 <b>Follow-Up Report</b>', '━━━━━━━━━━━━━━━━━━━━'];
  if (overdue.length) {
    lines.push(`\n🔴 <b>Overdue (${overdue.length})</b>`);
    overdue.forEach((l, i) => {
      const te = { Hot: '🔥', Warm: '🟡', Cold: '🔵' }[l.lead_type] || '';
      lines.push(`${i + 1}. <b>${esc(l.factory_number)} — ${esc(l.factory_name)}</b> ${te} (${esc(l.stage)})`);
      lines.push(`   ${formatContacts(l)}  📅 ${esc(l.follow_up)}`);
    });
  }
  if (todayList.length) {
    lines.push(`\n🟡 <b>Due Today (${todayList.length})</b>`);
    todayList.forEach((l, i) => {
      const te = { Hot: '🔥', Warm: '🟡', Cold: '🔵' }[l.lead_type] || '';
      lines.push(`${i + 1}. <b>${esc(l.factory_number)} — ${esc(l.factory_name)}</b> ${te}`);
      lines.push(`   ${formatContacts(l)}`);
    });
  }
  await sendTelegram('sendMessage', { chat_id: chatId, text: lines.join('\n'), parse_mode: 'HTML' });
}

async function handleStageUpdate(chatId, factoryNum, stageNum) {
  if (isNaN(stageNum) || stageNum < 0 || stageNum > 7) {
    await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ Stage must be 0–7.\n\n0=Lost  1=New Lead  2=Sample Required\n3=Sample Sent  4=Quotation  5=Negotiation\n6=Order Won  7=Repeat Customer' });
    return;
  }
  const leads = await db.getLeads();
  const found = leads.find(l => String(l.factory_number || '').toLowerCase() === factoryNum.toLowerCase());
  if (!found) { await sendTelegram('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `🔍 No lead with factory number <b>${esc(factoryNum)}</b>.` }); return; }
  const stageName = STAGE_NAMES[stageNum];
  const uuid      = uuidv4();
  cache.put('stage_' + uuid, JSON.stringify({ rowIndex: found.rowIndex, stageNum, stageName, factoryNum, factoryName: found.factory_name }), 300);
  await sendTelegram('sendMessage', {
    chat_id: chatId, parse_mode: 'HTML',
    text: `📊 <b>Stage Update</b>\n\n<b>${esc(factoryNum)} — ${esc(found.factory_name)}</b>\nNew stage: <b>${stageName} (#${stageNum})</b>\n\nConfirm?`,
    reply_markup: { inline_keyboard: [[{ text: '✅ Confirm', callback_data: 'STAGE_' + uuid }, { text: '❌ Cancel', callback_data: 'CANCEL_' + uuid }]] },
  });
}

async function handleDeleteLead(chatId, factoryNum) {
  if (!factoryNum) { await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ Usage: /delete M277' }); return; }
  const leads = await db.getLeads();
  const found = leads.find(l => String(l.factory_number || '').toLowerCase() === factoryNum.toLowerCase());
  if (!found) { await sendTelegram('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `🔍 No lead with factory number <b>${esc(factoryNum)}</b>.` }); return; }
  const uuid = uuidv4();
  cache.put('del_' + uuid, JSON.stringify({ rowIndex: found.rowIndex, factoryNum, factoryName: found.factory_name }), 300);
  await sendTelegram('sendMessage', {
    chat_id: chatId, parse_mode: 'HTML',
    text: `🗑️ <b>Delete Lead</b>\n\n<b>${esc(factoryNum)} — ${esc(found.factory_name)}</b> (Row ${found.rowIndex})\n\n⚠️ This cannot be undone. Confirm?`,
    reply_markup: { inline_keyboard: [[{ text: '🗑️ Yes, Delete', callback_data: 'DELETE_' + uuid }, { text: '❌ Cancel', callback_data: 'CANCEL_' + uuid }]] },
  });
}

// ============================================================
//  MESSAGE HANDLER
// ============================================================
async function handleMessage(message) {
  const chatId = message.chat.id;
  const text   = message.text.trim();
  const telegramUserId = String(message.from?.id || chatId);

  // Registration session
  const registerSession = cache.get('register_' + chatId);
  if (registerSession) {
    const sess = JSON.parse(registerSession);
    if (sess.step === 0) {
      const name = text.trim();
      if (name.length < 2) { await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ Name too short. Try again:' }); return; }
      cache.put('register_' + chatId, JSON.stringify({ step: 1, name }), 300);
      await sendTelegram('sendMessage', { chat_id: chatId, text: `👍 Hi ${name}! Now set a 4-6 digit PIN:` });
      return;
    }
    if (sess.step === 1) {
      const pin = text.trim();
      if (!/^\d{4,6}$/.test(pin)) { await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ PIN must be 4-6 digits only. Try again:' }); return; }
      const result = await db.createUser(sess.name, pin, 'sales', telegramUserId);
      cache.remove('register_' + chatId);
      if (!result.ok) {
        await sendTelegram('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `⚠️ ${esc(result.message)}\n\nUse /register to try a different name.` });
      } else {
        await sendTelegram('sendMessage', {
          chat_id: chatId, parse_mode: 'HTML',
          text: `✅ <b>Registered as ${esc(sess.name)}!</b>\n\nLog into the dashboard with:\n• Name: <b>${esc(sess.name)}</b>\n• PIN: <b>${pin}</b>\n\nYour leads will be tagged with your name. 🎉`,
        });
      }
      return;
    }
  }

  // Change PIN session
  const changePinSession = cache.get('changepin_' + chatId);
  if (changePinSession) {
    const pin = text.trim();
    if (!/^\d{4,6}$/.test(pin)) { await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ PIN must be 4-6 digits. Try again:' }); return; }
    const { userId } = JSON.parse(changePinSession);
    await db.updateUserPin(userId, pin);
    cache.remove('changepin_' + chatId);
    await sendTelegram('sendMessage', { chat_id: chatId, text: '✅ PIN updated successfully!' });
    return;
  }

  // Edit All session
  const editAllSession = cache.get('editall_' + chatId);
  if (editAllSession) {
    const sess = JSON.parse(editAllSession);
    const { uuid, fieldIndex } = sess;
    const cached = cache.get('data_' + uuid);
    if (!cached) { cache.remove('editall_' + chatId); return; }
    const data  = JSON.parse(cached);
    const field = EDITALL_FIELDS[fieldIndex];
    if (text !== '.') {
      if (field.key === 'items') {
        const items = parseItemsText(text);
        if (items.length) { data.parsed.items = items; data.parsed.product = items[0].product; data.parsed.quantity = items[0].quantity; data.parsed.rate = items[0].rate; }
      } else if (field.key === 'stage') {
        const sr = parseStageInput(text); data.parsed.stage = sr.stage; data.parsed.stage_number = sr.stage_number;
      } else if (field.key === 'follow_up') {
        data.parsed.follow_up = parseDateInput(text);
      } else if (field.key === 'lead_type') {
        const tl2 = text.toLowerCase();
        data.parsed.lead_type = tl2.includes('hot') ? 'Hot' : tl2.includes('warm') ? 'Warm' : tl2.includes('cold') ? 'Cold' : data.parsed.lead_type;
      } else {
        data.parsed[field.key] = text;
      }
    }
    cache.put('data_' + uuid, JSON.stringify(data), 600);
    const nextIndex = fieldIndex + 1;
    if (nextIndex < EDITALL_FIELDS.length) {
      cache.put('editall_' + chatId, JSON.stringify({ uuid, fieldIndex: nextIndex }), 600);
      await sendEditAllFieldPrompt(chatId, data.parsed, nextIndex);
    } else {
      cache.remove('editall_' + chatId);
      await sendTelegram('sendMessage', {
        chat_id: chatId, text: '✅ All fields done! Review and confirm:\n\n' + buildPreview(data.parsed, data.action, data.existingRow),
        parse_mode: 'HTML', reply_markup: confirmEditKeyboard(uuid, data.parsed.lead_type),
      });
    }
    return;
  }

  // Custom follow-up date session
  const fuCustomSession = cache.get('fudate_custom_' + chatId);
  if (fuCustomSession) {
    const { fuUuid, rowIndex, messageId: fuMsgId } = JSON.parse(fuCustomSession);
    cache.remove('fudate_custom_' + chatId);
    const dateStr = parseDateInput(text);
    await db.updateLead(rowIndex, { follow_up: dateStr });
    await sendTelegram('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `✅ Follow-up set: <b>${esc(dateStr)}</b>` });
    try { await sendTelegram('editMessageText', { chat_id: chatId, message_id: fuMsgId, text: `✅ Follow-up set: <b>${esc(dateStr)}</b>`, parse_mode: 'HTML' }); } catch (_) {}
    cache.remove('fudate_' + fuUuid);
    { const _leads = await db.getLeads(); const fl = _leads.find(l => l.rowIndex === String(rowIndex)); if (fl && ['Hot','Warm'].includes(fl.lead_type)) broadcastFollowUpAvailable(rowIndex, dateStr).catch(() => {}); }
    return;
  }

  // Photo pending session
  const photoPendingSession = cache.get('photo_pending_' + chatId);
  if (photoPendingSession) {
    const { fileId, caption, uploadedBy } = JSON.parse(photoPendingSession);
    const leads = await db.getLeads();
    const q     = text.toLowerCase();
    const found = leads.find(l =>
      String(l.factory_number || '').toLowerCase() === q ||
      String(l.factory_name   || '').toLowerCase().includes(q)
    );
    if (!found) { await sendTelegram('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `🔍 No lead found for "<b>${esc(text)}</b>". Try factory number (e.g. M277):` }); return; }
    cache.remove('photo_pending_' + chatId);
    await savePhotoForLead(chatId, fileId, Number(found.rowIndex), caption, uploadedBy);
    return;
  }

  // Field edit session
  const editSession = cache.get('edit_' + chatId);
  if (editSession) {
    const { uuid, field, messageId } = JSON.parse(editSession);
    cache.remove('edit_' + chatId);
    const cached = cache.get('data_' + uuid);
    if (cached) {
      const data = JSON.parse(cached);
      data.parsed[field] = text;
      if (field === 'stage') { const sr = parseStageInput(text); data.parsed.stage = sr.stage; data.parsed.stage_number = sr.stage_number; }
      cache.put('data_' + uuid, JSON.stringify(data), 600);
      await sendTelegram('editMessageText', {
        chat_id: chatId, message_id: messageId,
        text: buildPreview(data.parsed, data.action, data.existingRow),
        parse_mode: 'HTML', reply_markup: confirmEditKeyboard(uuid, data.parsed.lead_type),
      });
    }
    return;
  }

  // Commands
  if (text === '/start') {
    await sendTelegram('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: [
        '👋 <b>CRM Bot Ready</b>', '',
        '<b>Add/Update a lead:</b>',
        '<code>M277 Ramesh Industries Sureshji hotmelt 500@120, solvent 200@80 hot</code>', '',
        '🎤 <b>Voice:</b> Send a voice note with lead details',
        '📷 <b>Photo:</b> Send a factory photo and specify the lead', '',
        '<b>Commands:</b>',
        '/find &lt;name or factory #&gt;', '/lead &lt;factory #&gt;', '/followups',
        '/register  — create your salesperson account', '/changepin — update your PIN',
        '/stage &lt;factory #&gt; &lt;0-7&gt;', '/delete &lt;factory #&gt;', '',
        '<b>Stages:</b> 1=New Lead  2=Sample Req  3=Sample Sent',
        '4=Quotation  5=Negotiation  6=Won  7=Repeat  0=Lost',
      ].join('\n'),
    });
    return;
  }

  if (text === '/register') {
    const existingUser = await db.getUserByTelegramId(telegramUserId);
    if (existingUser) {
      await sendTelegram('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `✅ Already registered as <b>${esc(existingUser.display_name)}</b>.\n\nUse /changepin to update your PIN.` });
      return;
    }
    cache.put('register_' + chatId, JSON.stringify({ step: 0 }), 300);
    await sendTelegram('sendMessage', { chat_id: chatId, text: '👤 What is your name? (This will be your login for the dashboard)' });
    return;
  }

  if (text === '/changepin') {
    const user = await db.getUserByTelegramId(telegramUserId);
    if (!user) { await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ You need to /register first.' }); return; }
    cache.put('changepin_' + chatId, JSON.stringify({ userId: user.id }), 300);
    await sendTelegram('sendMessage', { chat_id: chatId, text: '🔐 Enter your new 4-6 digit PIN:' });
    return;
  }

  if (text.startsWith('/find '))   { await handleFind(chatId, text.slice(6).trim()); return; }
  if (text.startsWith('/lead '))   { await handleLeadCard(chatId, text.slice(6).trim()); return; }
  if (text === '/followups')        { await handleFollowups(chatId); return; }

  if (text.startsWith('/stage ')) {
    const parts = text.slice(7).trim().split(/\s+/);
    if (parts.length < 2) { await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ Usage: /stage M277 6' }); return; }
    await handleStageUpdate(chatId, parts[0], parseInt(parts[1], 10));
    return;
  }

  if (text.startsWith('/delete ')) { await handleDeleteLead(chatId, text.slice(8).trim()); return; }

  // Natural language → Gemini → confirm
  const registeredUser = await db.getUserByTelegramId(telegramUserId);
  const createdBy = registeredUser ? registeredUser.display_name : '';

  const result = await gemini.generate(text);
  const parsed = result ? result.parsed : localParse(text);
  if (!parsed) { await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ Could not parse. Try again with more detail.' }); return; }

  const { existingRow, action, leads: _allLeads } = await findExistingLead(parsed);
  if (!parsed.stage) {
    if (action === 'ADD') { parsed.stage = 'New Lead'; parsed.stage_number = 1; }
    else {
      const existingLead = _allLeads.find(l => l.rowIndex === String(existingRow));
      if (existingLead) { parsed.stage = existingLead.stage || 'New Lead'; parsed.stage_number = existingLead.stage_number != null ? existingLead.stage_number : 1; }
    }
  }

  const uuid = uuidv4();
  cache.put('data_' + uuid, JSON.stringify({ parsed, existingRow, action, createdBy }), 600);
  await sendTelegram('sendMessage', {
    chat_id: chatId, text: buildPreview(parsed, action, existingRow),
    parse_mode: 'HTML', reply_markup: confirmEditKeyboard(uuid, parsed.lead_type),
  });
}

// ============================================================
//  CALLBACK HANDLER
// ============================================================
async function handleCallback(callbackQuery) {
  const cbId      = callbackQuery.id;
  const chatId    = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const cbData    = callbackQuery.data;

  await sendTelegram('answerCallbackQuery', { callback_query_id: cbId });

  if (cbData.startsWith('CLAIM_')) {
    const leadId = parseInt(cbData.replace('CLAIM_', ''), 10);
    const telegramUserId = String(callbackQuery.from?.id || chatId);
    const user = await db.getUserByTelegramId(telegramUserId);
    const claimerName = user ? user.display_name : (callbackQuery.from?.first_name || 'Someone');
    const result = await db.claimFollowUp(leadId, claimerName);
    if (result.ok) {
      const lead = (await db.getLeads()).find(l => l.rowIndex === String(leadId));
      const factName = lead ? esc(lead.factory_name || lead.factory_number) : `Lead #${leadId}`;
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', text: `✅ <b>You claimed the follow-up for ${factName}!</b>\n\nIt's now assigned to you. Update after the visit.` });
    } else if (result.alreadyClaimed) {
      const lead = (await db.getLeads()).find(l => l.rowIndex === String(leadId));
      const factName = lead ? esc(lead.factory_name || lead.factory_number) : `Lead #${leadId}`;
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
        text: `⚡ <b>Already claimed by ${esc(result.claimedBy)}</b>\n\n${factName} — want to request it?`,
        reply_markup: { inline_keyboard: [[{ text: '📬 Request Follow-up', callback_data: `REQFU_${leadId}_${claimerName}` }]] },
      });
    }
    return;
  }

  if (cbData.startsWith('REQFU_')) {
    const parts = cbData.replace('REQFU_', '').split('_');
    const leadId = parseInt(parts[0], 10);
    const requesterName = parts.slice(1).join('_');
    const lead = (await db.getLeads()).find(l => l.rowIndex === String(leadId));
    const factName = lead ? esc(lead.factory_name || lead.factory_number) : `Lead #${leadId}`;
    const currentAssignee = lead ? esc(lead.assigned_to || '—') : '—';
    const allUsers = await db.getAllUsers();
    const adminUser = allUsers.find(u => u.role === 'admin' && u.telegram_user_id);
    if (adminUser) {
      await sendTelegram('sendMessage', {
        chat_id: adminUser.telegram_user_id, parse_mode: 'HTML',
        text: `📬 <b>${esc(requesterName)}</b> is requesting the follow-up for <b>${factName}</b>\n\n👤 Currently assigned to: <b>${currentAssignee}</b>`,
        reply_markup: { inline_keyboard: [[{ text: `✅ Reassign to ${esc(requesterName)}`, callback_data: `REASSIGN_${leadId}_${requesterName}` }]] },
      }).catch(() => {});
    }
    await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', text: `📬 <b>Request sent!</b> Admin has been notified.\n\n${factName} — you'll get a message if it's reassigned to you.` });
    return;
  }

  if (cbData.startsWith('REASSIGN_')) {
    const parts = cbData.replace('REASSIGN_', '').split('_');
    const leadId = parseInt(parts[0], 10);
    const newAssignee = parts.slice(1).join('_');
    const lead = (await db.getLeads()).find(l => l.rowIndex === String(leadId));
    const factName = lead ? esc(lead.factory_name || lead.factory_number) : `Lead #${leadId}`;
    const result = await db.reassignFollowUp(leadId, newAssignee);
    if (result.ok) {
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', text: `✅ <b>Reassigned to ${esc(newAssignee)}</b>\n\n${factName} follow-up is now with ${esc(newAssignee)}.` });
      const allUsers = await db.getAllUsers();
      const assigneeUser = allUsers.find(u => u.display_name === newAssignee && u.telegram_user_id);
      if (assigneeUser) {
        await sendTelegram('sendMessage', { chat_id: assigneeUser.telegram_user_id, parse_mode: 'HTML', text: `✅ <b>Follow-up assigned to you!</b>\n\n🏭 <b>${factName}</b>\n\nAdmin has reassigned this follow-up to you. Update after your visit.` }).catch(() => {});
      }
    }
    return;
  }

  if (cbData.startsWith('CANCEL_')) {
    cache.remove('edit_' + chatId); cache.remove('editall_' + chatId);
    await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '❌ <b>Cancelled.</b> No changes saved.', parse_mode: 'HTML' });
    return;
  }

  if (cbData.startsWith('TEMP_')) {
    const rest = cbData.replace('TEMP_', '');
    const sep  = rest.indexOf('_');
    const tempType = rest.slice(0, sep);
    const uuid     = rest.slice(sep + 1);
    const cached   = cache.get('data_' + uuid);
    if (!cached) { await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '⏰ <b>Session expired.</b> Please send again.', parse_mode: 'HTML' }); return; }
    const data = JSON.parse(cached);
    data.parsed.lead_type = tempType;
    cache.put('data_' + uuid, JSON.stringify(data), 600);
    await sendTelegram('editMessageText', {
      chat_id: chatId, message_id: messageId,
      text: buildPreview(data.parsed, data.action, data.existingRow),
      parse_mode: 'HTML', reply_markup: confirmEditKeyboard(uuid, tempType),
    });
    return;
  }

  if (cbData.startsWith('FUDATE_')) {
    const rest   = cbData.replace('FUDATE_', '');
    const sep    = rest.indexOf('_');
    const type   = rest.slice(0, sep);
    const fuUuid = rest.slice(sep + 1);
    const cached = cache.get('fudate_' + fuUuid);
    if (!cached) { await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '⏰ <b>Session expired.</b>', parse_mode: 'HTML' }); return; }
    const { rowIndex } = JSON.parse(cached);
    if (type === 'skip') { await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '📅 No follow-up date set. You can add one later via Edit.', parse_mode: 'HTML' }); cache.remove('fudate_' + fuUuid); return; }
    if (type === 'custom') { cache.put('fudate_custom_' + chatId, JSON.stringify({ fuUuid, rowIndex, messageId }), 300); await sendTelegram('sendMessage', { chat_id: chatId, text: '📅 Type the follow-up date:\n(dd/MM/yyyy or e.g. "15 July", "next week")' }); return; }
    const offsets = { tomorrow: 1, '2days': 2, nextweek: 7, '2weeks': 14 };
    const dateStr = dateIST(offsets[type] || 1);
    await db.updateLead(rowIndex, { follow_up: dateStr });
    await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: `✅ Follow-up set: <b>${dateStr}</b>`, parse_mode: 'HTML' });
    cache.remove('fudate_' + fuUuid);
    { const _fl = await db.getLeads(); const fl = _fl.find(l => l.rowIndex === String(rowIndex)); if (fl && ['Hot','Warm'].includes(fl.lead_type)) broadcastFollowUpAvailable(rowIndex, dateStr).catch(() => {}); }
    return;
  }

  if (cbData.startsWith('EDITALL_')) {
    const uuid   = cbData.replace('EDITALL_', '');
    const cached = cache.get('data_' + uuid);
    if (!cached) { await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '⏰ <b>Session expired.</b>', parse_mode: 'HTML' }); return; }
    const data = JSON.parse(cached);
    cache.put('editall_' + chatId, JSON.stringify({ uuid, fieldIndex: 0 }), 600);
    await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '✏️ <b>Edit All — Step by step</b>\n\nSend <code>.</code> to keep the current value for any field.', parse_mode: 'HTML' });
    await sendEditAllFieldPrompt(chatId, data.parsed, 0);
    return;
  }

  if (cbData.startsWith('EDIT_')) {
    const uuid   = cbData.replace('EDIT_', '');
    const cached = cache.get('data_' + uuid);
    if (!cached) { await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '⏰ <b>Session expired.</b>', parse_mode: 'HTML' }); return; }
    await sendTelegram('editMessageReplyMarkup', {
      chat_id: chatId, message_id: messageId,
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏭 Factory #', callback_data: 'FIELD_' + uuid + '_factory_number' }, { text: '🏢 Name', callback_data: 'FIELD_' + uuid + '_factory_name' }],
          [{ text: '👤 Person',    callback_data: 'FIELD_' + uuid + '_person_in_charge' }, { text: '📞 Contact', callback_data: 'FIELD_' + uuid + '_contact' }],
          [{ text: '📦 Product',   callback_data: 'FIELD_' + uuid + '_product' }, { text: '🔢 Quantity', callback_data: 'FIELD_' + uuid + '_quantity' }],
          [{ text: '💰 Rate',      callback_data: 'FIELD_' + uuid + '_rate' }, { text: '📊 Stage', callback_data: 'FIELD_' + uuid + '_stage' }],
          [{ text: '📅 Follow Up', callback_data: 'FIELD_' + uuid + '_follow_up' }, { text: '🗺️ Area', callback_data: 'FIELD_' + uuid + '_area' }],
          [{ text: '📝 Notes',     callback_data: 'FIELD_' + uuid + '_notes' }, { text: '🌡️ Lead Type', callback_data: 'FIELD_' + uuid + '_lead_type' }],
          [{ text: '◀️ Back',      callback_data: 'BACK_' + uuid }],
        ],
      },
    });
    return;
  }

  if (cbData.startsWith('BACK_')) {
    const uuid = cbData.replace('BACK_', '');
    cache.remove('edit_' + chatId);
    const cached = cache.get('data_' + uuid);
    const lt = cached ? JSON.parse(cached).parsed?.lead_type : '';
    await sendTelegram('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: confirmEditKeyboard(uuid, lt) });
    return;
  }

  if (cbData.startsWith('FIELD_')) {
    const rest  = cbData.replace('FIELD_', '');
    const uuid  = rest.slice(0, 36);
    const field = rest.slice(37);
    const fieldLabels = {
      factory_number: 'Factory #', factory_name: 'Factory Name',
      person_in_charge: 'Person in Charge', contact: 'Contact',
      product: 'Product', quantity: 'Quantity', rate: 'Rate',
      stage: 'Stage (1-7 or name)', follow_up: 'Follow Up (dd/MM/yyyy)',
      area: 'Area', notes: 'Notes', lead_type: 'Lead Type (Hot / Warm / Cold)',
    };
    cache.put('edit_' + chatId, JSON.stringify({ uuid, field, messageId }), 300);
    await sendTelegram('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `✏️ Type the new value for <b>${fieldLabels[field] || field}</b>:` });
    return;
  }

  if (cbData.startsWith('CONFIRM_')) {
    const uuid   = cbData.replace('CONFIRM_', '');
    const cached = cache.get('data_' + uuid);
    if (!cached) { await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '⏰ <b>Session expired.</b> Please send again.', parse_mode: 'HTML' }); return; }
    const { parsed, existingRow, action, createdBy = '' } = JSON.parse(cached);
    let savedRowIndex = existingRow;
    try {
      if (action === 'UPDATE' && existingRow > 0) {
        await db.updateLead(existingRow, parsed);
        await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: `✅ <b>Updated!</b> Row ${existingRow} — <b>${esc(parsed.factory_name || parsed.factory_number)}</b>`, parse_mode: 'HTML' });
        if (parsed.stage === 'Order Won') notifyOrderWon(parsed, createdBy).catch(() => {});
      } else {
        const result = await db.addLead(parsed, createdBy);
        if (result.conflict) { await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: `⚠️ <b>Duplicate:</b> ${esc(result.message)}`, parse_mode: 'HTML' }); return; }
        savedRowIndex = result.rowIndex;
        await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: `✅ <b>Added!</b> New entry for <b>${esc(parsed.factory_name || parsed.factory_number)}</b> saved.`, parse_mode: 'HTML' });
        if (parsed.stage === 'Order Won') notifyOrderWon(parsed, createdBy).catch(() => {});
      }
    } catch (err) {
      console.error('DB write error:', err.message);
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '🚨 <b>Write failed.</b> Check server logs.', parse_mode: 'HTML' });
      return;
    }
    cache.remove('data_' + uuid);

    if (['Hot', 'Warm'].includes(parsed.lead_type) && !parsed.follow_up && savedRowIndex) {
      const fuUuid = uuidv4();
      cache.put('fudate_' + fuUuid, JSON.stringify({ rowIndex: savedRowIndex }), 600);
      const typeLabel = parsed.lead_type === 'Hot' ? '🔥 Hot' : '🟡 Warm';
      await sendTelegram('sendMessage', {
        chat_id: chatId, parse_mode: 'HTML',
        text: `📅 <b>${typeLabel} lead</b> — set a follow-up date?`,
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Tomorrow', callback_data: 'FUDATE_tomorrow_' + fuUuid }, { text: 'In 2 Days', callback_data: 'FUDATE_2days_' + fuUuid }, { text: 'Next Week', callback_data: 'FUDATE_nextweek_' + fuUuid }],
            [{ text: 'In 2 Weeks', callback_data: 'FUDATE_2weeks_' + fuUuid }, { text: '📅 Custom', callback_data: 'FUDATE_custom_' + fuUuid }, { text: 'Skip', callback_data: 'FUDATE_skip_' + fuUuid }],
          ],
        },
      });
    }
    return;
  }

  if (cbData.startsWith('STAGE_')) {
    const uuid   = cbData.replace('STAGE_', '');
    const cached = cache.get('stage_' + uuid);
    if (!cached) { await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '⏰ <b>Session expired.</b>', parse_mode: 'HTML' }); return; }
    const { rowIndex, stageNum, stageName, factoryNum, factoryName } = JSON.parse(cached);
    try {
      await db.updateLead(rowIndex, { stage: stageName, stage_number: String(stageNum) });
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: `✅ <b>Stage Updated!</b>\n<b>${esc(factoryNum)} — ${esc(factoryName)}</b>\nNow: <b>${stageName} (#${stageNum})</b>`, parse_mode: 'HTML' });
      if (stageName === 'Order Won') {
        const lead = (await db.getLeads()).find(l => l.rowIndex === String(rowIndex));
        if (lead) notifyOrderWon(lead, '').catch(() => {});
      }
    } catch {
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '🚨 <b>Failed to update stage.</b>', parse_mode: 'HTML' });
    }
    cache.remove('stage_' + uuid);
    return;
  }

  if (cbData.startsWith('DELETE_')) {
    const uuid   = cbData.replace('DELETE_', '');
    const cached = cache.get('del_' + uuid);
    if (!cached) { await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '⏰ <b>Session expired.</b>', parse_mode: 'HTML' }); return; }
    const { rowIndex, factoryNum, factoryName } = JSON.parse(cached);
    try {
      await db.deleteLead(rowIndex);
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: `🗑️ <b>Deleted!</b>\n<b>${esc(factoryNum)} — ${esc(factoryName)}</b> removed.`, parse_mode: 'HTML' });
    } catch {
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '🚨 <b>Failed to delete.</b>', parse_mode: 'HTML' });
    }
    cache.remove('del_' + uuid);
    return;
  }
}

// ============================================================
//  DAILY BRIEFINGS
// ============================================================
const _briefingSent = { morning: '', evening: '' };

async function sendMorningBriefing() {
  try {
    const leads   = await db.getLeads();
    const today   = todayIST();
    const todayD  = parseFollowUpDate(today);
    const active  = leads.filter(l => l.stage !== 'Lost');
    const hot     = active.filter(l => l.lead_type === 'Hot');
    const warm    = active.filter(l => l.lead_type === 'Warm');
    const dueToday = active.filter(l => l.follow_up === today);
    const overdue  = active.filter(l => { if (!l.follow_up) return false; const d = parseFollowUpDate(l.follow_up); return d && d < todayD; });
    const lines = [`🌅 <b>Good Morning! Daily Briefing</b>`, `📅 ${today}`, ``, `📊 <b>Pipeline</b>  🔥 Hot: <b>${hot.length}</b>  🟡 Warm: <b>${warm.length}</b>  📋 Total: <b>${active.length}</b>`];
    if (dueToday.length) {
      lines.push(``, `📅 <b>Follow-ups Due Today (${dueToday.length})</b>`);
      dueToday.slice(0, 8).forEach(l => { const e = { Hot: '🔥', Warm: '🟡', Cold: '🔵' }[l.lead_type] || '◎'; lines.push(`${e} ${esc(l.factory_name || l.factory_number)} — ${esc(l.stage || '—')}`); });
      if (dueToday.length > 8) lines.push(`   …and ${dueToday.length - 8} more`);
    }
    if (overdue.length) {
      lines.push(``, `⚠️ <b>Overdue Follow-ups (${overdue.length})</b>`);
      overdue.slice(0, 5).forEach(l => { lines.push(`◎ ${esc(l.factory_name || l.factory_number)} — was due ${esc(l.follow_up)}`); });
      if (overdue.length > 5) lines.push(`   …and ${overdue.length - 5} more`);
    }
    if (!dueToday.length && !overdue.length) lines.push(``, `✅ No follow-ups due today — have a great day!`);
    await sendToAllTelegram(lines.join('\n'));
    console.log('📅 Morning briefing sent');
  } catch (err) { console.error('Morning briefing error:', err.message); }
}

async function sendEveningBriefing() {
  try {
    const leads = await db.getLeads();
    const today = todayIST();
    const todayLeads = leads.filter(l => (l.last_updated || '').startsWith(today));
    const ordersWon  = todayLeads.filter(l => l.stage === 'Order Won');
    const lines = [`🌆 <b>End of Day Summary</b>`, `📅 ${today}`, ``, `📦 Leads touched today: <b>${todayLeads.length}</b>  |  🏆 Orders Won: <b>${ordersWon.length}</b>`];
    if (ordersWon.length) {
      lines.push(``, `🏆 <b>Orders Won Today</b>`);
      ordersWon.forEach(l => { const items = (l.items || []).map(i => `${i.product} ${i.quantity}`.trim()).filter(Boolean).join(', '); lines.push(`✅ <b>${esc(l.factory_name || l.factory_number)}</b>${items ? ' — ' + esc(items) : ''}`); });
    }
    if (todayLeads.length) {
      lines.push(``, `📋 <b>Activity</b>`);
      todayLeads.slice(0, 10).forEach(l => { const e = { Hot: '🔥', Warm: '🟡', Cold: '🔵' }[l.lead_type] || '◎'; lines.push(`${e} ${esc(l.factory_name || l.factory_number)} → ${esc(l.stage || '—')} <i>${esc(l.created_by || '')}</i>`); });
      if (todayLeads.length > 10) lines.push(`   …and ${todayLeads.length - 10} more`);
    } else { lines.push(``, `No leads were updated today.`); }
    await sendToAllTelegram(lines.join('\n'));
    console.log('🌆 Evening briefing sent');
  } catch (err) { console.error('Evening briefing error:', err.message); }
}

function startDailyBriefings() {
  setInterval(async () => {
    const hhmm = nowHHMM();
    const today = todayIST();
    if (hhmm === '09:00' && _briefingSent.morning !== today) { _briefingSent.morning = today; await sendMorningBriefing(); }
    if (hhmm === '19:00' && _briefingSent.evening !== today) { _briefingSent.evening = today; await sendEveningBriefing(); }
  }, 60000);
  console.log('   Briefings   : ⏰ 9:00 AM & 7:00 PM IST');
}

module.exports = { handleMessage, handleCallback, handleVoice, handlePhoto, startDailyBriefings, sendTelegram, notifyOrderWon };
