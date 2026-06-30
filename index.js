require('dotenv').config();
const http    = require('http');
const express = require('express');
const { Server } = require('socket.io');
const axios   = require('axios');
const crypto  = require('crypto');
const fs      = require('fs');
const { v4: uuidv4 } = require('uuid');
const path    = require('path');
const cache   = require('./cache');
const db      = require('./db');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const app        = express();
const httpServer = http.createServer(app);
const io         = new Server(httpServer);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
//  SOCKET.IO — Live Agent Location Relay
// ============================================================
const agentLocations = {};

io.on('connection', (socket) => {
  // Send existing positions snapshot to new dashboard client
  if (Object.keys(agentLocations).length) {
    socket.emit('agents-snapshot', agentLocations);
  }

  socket.on('update-agent-location', ({ agentId, lat, lng, name, accuracy }) => {
    if (!agentId || lat == null || lng == null) return;
    agentLocations[agentId] = { agentId, lat, lng, name: name || agentId, accuracy: accuracy || 0, ts: Date.now() };
    io.emit('agent-moved', agentLocations[agentId]);
  });
});

// Serve uploaded factory photos
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
app.use('/uploads', express.static(uploadsDir));

const {
  TELEGRAM_TOKEN,
  GEMINI_API_KEY,
  WEBHOOK_URL,
  PORT = 3000,
  ADMIN_USER = 'admin',
  ADMIN_PASS = 'admin123',
  SALES_USER = 'sales',
  SALES_PASS = 'sales123',
  JWT_SECRET = 'crm_default_secret_change_me',
} = process.env;

const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

// ============================================================
//  AUTH — token sign / verify
// ============================================================
function signToken(username, role) {
  const expiry  = Date.now() + 24 * 60 * 60 * 1000;
  const payload = `${username}:${role}:${expiry}`;
  const sig     = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('hex');
  return Buffer.from(payload).toString('base64') + '.' + sig;
}

function verifyToken(token) {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot < 0) return null;
  const b64 = token.slice(0, dot);
  const sig  = token.slice(dot + 1);
  let payload;
  try { payload = Buffer.from(b64, 'base64').toString(); } catch { return null; }
  const expected = crypto.createHmac('sha256', JWT_SECRET).update(payload).digest('hex');
  if (sig !== expected) return null;
  const parts = payload.split(':');
  if (parts.length < 3) return null;
  const expiry = parseInt(parts[2], 10);
  if (Date.now() > expiry) return null;
  return { username: parts[0], role: parts[1] };
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  const user = verifyToken(header.slice(7));
  if (!user) return res.status(401).json({ error: 'Invalid or expired token' });
  req.user = user;
  next();
}

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// ============================================================
//  LOGIN
// ============================================================
app.post('/api/login', async (req, res) => {
  const { username, password, pin } = req.body || {};

  // Try env-based admin/sales login first
  if (username === ADMIN_USER && password === ADMIN_PASS)
    return res.json({ token: signToken(username, 'admin'), role: 'admin', username });
  if (username === SALES_USER && password === SALES_PASS)
    return res.json({ token: signToken(username, 'sales'), role: 'sales', username });

  // Try PIN-based user login (salespeople registered via /register)
  const pinToCheck = pin || password;
  if (username && pinToCheck) {
    const user = await db.verifyUserPin(username, pinToCheck);
    if (user) return res.json({ token: signToken(user.display_name, user.role), role: user.role, username: user.display_name });
  }

  res.status(401).json({ error: 'Invalid username or password' });
});

// ============================================================
//  TELEGRAM WEBHOOK (no auth — Telegram calls this directly)
// ============================================================
app.post('/webhook', async (req, res) => {
  res.status(200).send('OK');
  try {
    const update = req.body;
    const uidKey = 'uid_' + String(update.update_id);
    if (cache.get(uidKey)) return;
    cache.put(uidKey, '1', 300);
    if (update.callback_query)       await handleCallback(update.callback_query);
    else if (update.message?.voice)  await handleVoice(update.message);
    else if (update.message?.photo)  await handlePhoto(update.message);
    else if (update.message?.text)   await handleMessage(update.message);
  } catch (err) {
    console.error('Webhook error:', err.message);
  }
});

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

    const parsed = await callGeminiWithAudio(audioBase64);
    if (!parsed) {
      await sendTelegram('sendMessage', {
        chat_id: chatId, parse_mode: 'HTML',
        text: '⚠️ Could not process voice note. Please <b>type</b> the lead info instead.',
      });
      return;
    }

    const { existingRow, action } = await findExistingLead(parsed);
    if (!parsed.stage && action === 'ADD') { parsed.stage = 'New Lead'; parsed.stage_number = 1; }

    const uuid = uuidv4();
    cache.put('data_' + uuid, JSON.stringify({ parsed, existingRow, action, createdBy }), 600);

    await sendTelegram('sendMessage', {
      chat_id:      chatId,
      text:         '🎤 ' + buildPreview(parsed, action, existingRow),
      parse_mode:   'HTML',
      reply_markup: confirmEditKeyboard(uuid, parsed.lead_type),
    });
  } catch (err) {
    console.error('Voice handler error:', err.message);
    await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ Failed to process voice. Try sending as text.' });
  }
}

async function callGeminiWithAudio(audioBase64) {
  const voicePrompt = CRM_SYSTEM_PROMPT + '\n\nThe user sent a VOICE NOTE. First transcribe the audio, then extract CRM fields. Return ONLY the JSON.';
  for (const model of ['gemini-2.0-flash', 'gemini-2.0-flash-lite']) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const res = await axios.post(url, {
        system_instruction: { parts: [{ text: voicePrompt }] },
        contents: [{
          role: 'user',
          parts: [
            { inline_data: { mime_type: 'audio/ogg', data: audioBase64 } },
            { text: 'Transcribe and extract CRM lead data as JSON.' },
          ],
        }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 768, responseMimeType: 'application/json' },
      });
      let raw = res.data.candidates[0].content.parts[0].text.trim()
        .replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/\s*```$/i,'').trim();
      console.log('✅ Voice parsed via', model);
      return JSON.parse(raw);
    } catch (err) {
      const code = err.response?.data?.error?.code;
      if (code === 429 || code === 404) { console.warn(`⚠️ Gemini ${model} unavailable (${code}) for voice`); continue; }
      console.error('Gemini voice error:', err.response?.data || err.message);
    }
  }
  return null;
}

// ============================================================
//  PHOTO HANDLER
// ============================================================
async function handlePhoto(message) {
  const chatId  = message.chat.id;
  const photos  = message.photo;
  const largest = photos[photos.length - 1];
  const fileId  = largest.file_id;
  const caption = message.caption || '';
  const telegramUserId = String(message.from?.id || chatId);
  const registeredUser = db.getUserByTelegramId(telegramUserId);

  const photoSession = cache.get('photo_for_' + chatId);
  if (photoSession) {
    const { leadId } = JSON.parse(photoSession);
    cache.remove('photo_for_' + chatId);
    await savePhotoForLead(chatId, fileId, leadId, caption, registeredUser?.display_name || '');
    return;
  }

  cache.put('photo_pending_' + chatId, JSON.stringify({ fileId, caption, uploadedBy: registeredUser?.display_name || '' }), 300);
  await sendTelegram('sendMessage', {
    chat_id: chatId,
    text: '📷 Photo received! Which factory is this for?\nSend factory number or name:',
  });
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
//  MESSAGE HANDLER
// ============================================================
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

async function handleMessage(message) {
  const chatId = message.chat.id;
  const text   = message.text.trim();
  const telegramUserId = String(message.from?.id || chatId);

  // ── Registration session ──
  const registerSession = cache.get('register_' + chatId);
  if (registerSession) {
    const sess = JSON.parse(registerSession);
    if (sess.step === 0) {
      const name = text.trim();
      if (name.length < 2) {
        await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ Name too short. Try again:' });
        return;
      }
      cache.put('register_' + chatId, JSON.stringify({ step: 1, name }), 300);
      await sendTelegram('sendMessage', { chat_id: chatId, text: `👍 Hi ${name}! Now set a 4-6 digit PIN:` });
      return;
    }
    if (sess.step === 1) {
      const pin = text.trim();
      if (!/^\d{4,6}$/.test(pin)) {
        await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ PIN must be 4-6 digits only. Try again:' });
        return;
      }
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

  // ── Change PIN session ──
  const changePinSession = cache.get('changepin_' + chatId);
  if (changePinSession) {
    const pin = text.trim();
    if (!/^\d{4,6}$/.test(pin)) {
      await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ PIN must be 4-6 digits. Try again:' });
      return;
    }
    const { userId } = JSON.parse(changePinSession);
    await db.updateUserPin(userId, pin);
    cache.remove('changepin_' + chatId);
    await sendTelegram('sendMessage', { chat_id: chatId, text: '✅ PIN updated successfully!' });
    return;
  }

  // ── Edit All session ──
  const editAllSession = cache.get('editall_' + chatId);
  if (editAllSession) {
    const sess = JSON.parse(editAllSession);
    const { uuid, fieldIndex } = sess;
    const cached = cache.get('data_' + uuid);
    if (!cached) { cache.remove('editall_' + chatId); return; }
    const data = JSON.parse(cached);

    const field = EDITALL_FIELDS[fieldIndex];
    if (text !== '.') {
      if (field.key === 'items') {
        const items = parseItemsText(text);
        if (items.length) {
          data.parsed.items = items;
          data.parsed.product  = items[0].product;
          data.parsed.quantity = items[0].quantity;
          data.parsed.rate     = items[0].rate;
        }
      } else if (field.key === 'stage') {
        const stageResult = parseStageInput(text);
        data.parsed.stage        = stageResult.stage;
        data.parsed.stage_number = stageResult.stage_number;
      } else if (field.key === 'follow_up') {
        data.parsed.follow_up = parseDateInput(text);
      } else if (field.key === 'lead_type') {
        const tl = text.toLowerCase();
        data.parsed.lead_type = tl.includes('hot') ? 'Hot' : tl.includes('warm') ? 'Warm' : tl.includes('cold') ? 'Cold' : data.parsed.lead_type;
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
        chat_id:      chatId,
        text:         '✅ All fields done! Review and confirm:\n\n' + buildPreview(data.parsed, data.action, data.existingRow),
        parse_mode:   'HTML',
        reply_markup: confirmEditKeyboard(uuid, data.parsed.lead_type),
      });
    }
    return;
  }

  // ── Custom follow-up date session ──
  const fuCustomSession = cache.get('fudate_custom_' + chatId);
  if (fuCustomSession) {
    const { fuUuid, rowIndex, messageId: fuMsgId } = JSON.parse(fuCustomSession);
    cache.remove('fudate_custom_' + chatId);
    const dateStr = parseDateInput(text);
    await db.updateLead(rowIndex, { follow_up: dateStr });
    await sendTelegram('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `✅ Follow-up set: <b>${esc(dateStr)}</b>` });
    try { await sendTelegram('editMessageText', { chat_id: chatId, message_id: fuMsgId, text: `✅ Follow-up set: <b>${esc(dateStr)}</b>`, parse_mode: 'HTML' }); } catch (_) {}
    cache.remove('fudate_' + fuUuid);
    // Broadcast to team (bid system) for Hot/Warm leads
    { const _leads = await db.getLeads(); const fl = _leads.find(l => l.rowIndex === String(rowIndex)); if (fl && ['Hot','Warm'].includes(fl.lead_type)) broadcastFollowUpAvailable(rowIndex, dateStr).catch(() => {}); }
    return;
  }

  // ── Photo pending session ──
  const photoPendingSession = cache.get('photo_pending_' + chatId);
  if (photoPendingSession) {
    const { fileId, caption, uploadedBy } = JSON.parse(photoPendingSession);
    const leads = await db.getLeads();
    const q     = text.toLowerCase();
    const found = leads.find(l =>
      String(l.factory_number || '').toLowerCase() === q ||
      String(l.factory_name   || '').toLowerCase().includes(q)
    );
    if (!found) {
      await sendTelegram('sendMessage', { chat_id: chatId, parse_mode: 'HTML', text: `🔍 No lead found for "<b>${esc(text)}</b>". Try factory number (e.g. M277):` });
      return;
    }
    cache.remove('photo_pending_' + chatId);
    await savePhotoForLead(chatId, fileId, Number(found.rowIndex), caption, uploadedBy);
    return;
  }

  // ── Field edit session ──
  const editSession = cache.get('edit_' + chatId);
  if (editSession) {
    const { uuid, field, messageId } = JSON.parse(editSession);
    cache.remove('edit_' + chatId);
    const cached = cache.get('data_' + uuid);
    if (cached) {
      const data = JSON.parse(cached);
      data.parsed[field] = text;
      if (field === 'stage') {
        const sr = parseStageInput(text);
        data.parsed.stage        = sr.stage;
        data.parsed.stage_number = sr.stage_number;
      }
      cache.put('data_' + uuid, JSON.stringify(data), 600);
      await sendTelegram('editMessageText', {
        chat_id:      chatId,
        message_id:   messageId,
        text:         buildPreview(data.parsed, data.action, data.existingRow),
        parse_mode:   'HTML',
        reply_markup: confirmEditKeyboard(uuid, data.parsed.lead_type),
      });
    }
    return;
  }

  // ── Commands ──
  if (text === '/start') {
    await sendTelegram('sendMessage', {
      chat_id: chatId, parse_mode: 'HTML',
      text: [
        '👋 <b>CRM Bot Ready</b>',
        '',
        '<b>Add/Update a lead:</b>',
        '<code>M277 Ramesh Industries Sureshji hotmelt 500@120, solvent 200@80 hot</code>',
        '',
        '🎤 <b>Voice:</b> Send a voice note with lead details',
        '📷 <b>Photo:</b> Send a factory photo and specify the lead',
        '',
        '<b>Commands:</b>',
        '/find &lt;name or factory #&gt;',
        '/lead &lt;factory #&gt;',
        '/followups',
        '/register  — create your salesperson account',
        '/changepin — update your PIN',
        '/stage &lt;factory #&gt; &lt;0-7&gt;',
        '/delete &lt;factory #&gt;',
        '',
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
    if (!user) {
      await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ You need to /register first.' });
      return;
    }
    cache.put('changepin_' + chatId, JSON.stringify({ userId: user.id }), 300);
    await sendTelegram('sendMessage', { chat_id: chatId, text: '🔐 Enter your new 4-6 digit PIN:' });
    return;
  }

  if (text.startsWith('/find ')) { await handleFind(chatId, text.slice(6).trim()); return; }
  if (text.startsWith('/lead ')) { await handleLeadCard(chatId, text.slice(6).trim()); return; }
  if (text === '/followups')      { await handleFollowups(chatId); return; }

  if (text.startsWith('/stage ')) {
    const parts = text.slice(7).trim().split(/\s+/);
    if (parts.length < 2) { await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ Usage: /stage M277 6' }); return; }
    await handleStageUpdate(chatId, parts[0], parseInt(parts[1], 10));
    return;
  }

  if (text.startsWith('/delete ')) {
    await handleDeleteLead(chatId, text.slice(8).trim());
    return;
  }

  // ── Natural language → Gemini → confirm ──
  const registeredUser = await db.getUserByTelegramId(telegramUserId);
  const createdBy = registeredUser ? registeredUser.display_name : '';

  const parsed = await callGemini(text);
  if (!parsed) {
    await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ Could not parse. Try again with more detail.' });
    return;
  }

  const { existingRow, action, leads: _allLeads } = await findExistingLead(parsed);

  if (!parsed.stage) {
    if (action === 'ADD') {
      parsed.stage = 'New Lead'; parsed.stage_number = 1;
    } else {
      const existingLead = _allLeads.find(l => l.rowIndex === String(existingRow));
      if (existingLead) { parsed.stage = existingLead.stage || 'New Lead'; parsed.stage_number = existingLead.stage_number != null ? existingLead.stage_number : 1; }
    }
  }

  const uuid = uuidv4();
  cache.put('data_' + uuid, JSON.stringify({ parsed, existingRow, action, createdBy }), 600);

  await sendTelegram('sendMessage', {
    chat_id:      chatId,
    text:         buildPreview(parsed, action, existingRow),
    parse_mode:   'HTML',
    reply_markup: confirmEditKeyboard(uuid, parsed.lead_type),
  });
}

// ── Format multiple contacts for Telegram display ────────────
function formatContacts(lead) {
  const contacts = (lead.contacts || []).filter(c => c.person_name || c.contact);
  if (!contacts.length) return `👤 ${esc(lead.person_in_charge || '—')}  📞 ${esc(lead.contact || '—')}`;
  if (contacts.length === 1) return `👤 ${esc(contacts[0].person_name || '—')}  📞 ${esc(contacts[0].contact || '—')}`;
  return contacts.map((c, i) =>
    `${i === 0 ? '👤' : '   '} ${esc(c.person_name || '—')} — 📞 ${esc(c.contact || '—')}${c.designation ? ` <i>(${esc(c.designation)})</i>` : ''}`
  ).join('\n');
}

// ============================================================
//  COMMAND HANDLERS
// ============================================================
async function handleFind(chatId, query) {
  if (!query) { await sendTelegram('sendMessage', { chat_id: chatId, text: '⚠️ Usage: /find M277 or /find Factory Name' }); return; }
  const leads   = await db.getLeads();
  const q       = query.toLowerCase();
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
    const typeEmoji = { Hot: '🔥', Warm: '🟡', Cold: '🔵' }[l.lead_type] || '';
    lines.push('');
    lines.push(`${idx + 1}. <b>${esc(l.factory_number)} — ${esc(l.factory_name)}</b> ${typeEmoji}`);
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

const STAGE_NAMES = { 0:'Lost', 1:'New Lead', 2:'Sample Required', 3:'Sample Sent', 4:'Quotation', 5:'Negotiation', 6:'Order Won', 7:'Repeat Customer' };

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
//  CALLBACK HANDLER
// ============================================================
async function handleCallback(callbackQuery) {
  const cbId      = callbackQuery.id;
  const chatId    = callbackQuery.message.chat.id;
  const messageId = callbackQuery.message.message_id;
  const cbData    = callbackQuery.data;

  await sendTelegram('answerCallbackQuery', { callback_query_id: cbId });

  // ── Claim follow-up (bid system) ──
  if (cbData.startsWith('CLAIM_')) {
    const leadId = parseInt(cbData.replace('CLAIM_', ''), 10);
    const telegramUserId = String(callbackQuery.from?.id || chatId);
    const user = await db.getUserByTelegramId(telegramUserId);
    const claimerName = user ? user.display_name : (callbackQuery.from?.first_name || 'Someone');
    const result = await db.claimFollowUp(leadId, claimerName);
    if (result.ok) {
      const claimLeads = await db.getLeads();
      const lead = claimLeads.find(l => l.rowIndex === String(leadId));
      const factName = lead ? esc(lead.factory_name || lead.factory_number) : `Lead #${leadId}`;
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
        text: `✅ <b>You claimed the follow-up for ${factName}!</b>\n\nIt's now assigned to you. Update after the visit.` });
    } else if (result.alreadyClaimed) {
      const claimLeads = await db.getLeads();
      const lead = claimLeads.find(l => l.rowIndex === String(leadId));
      const factName = lead ? esc(lead.factory_name || lead.factory_number) : `Lead #${leadId}`;
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
        text: `⚡ <b>Already claimed by ${esc(result.claimedBy)}</b>\n\n${factName} — want to request it?`,
        reply_markup: { inline_keyboard: [[{ text: '📬 Request Follow-up', callback_data: `REQFU_${leadId}_${claimerName}` }]] },
      });
    }
    return;
  }

  // ── Request follow-up reassignment ──
  if (cbData.startsWith('REQFU_')) {
    const parts = cbData.replace('REQFU_', '').split('_');
    const leadId = parseInt(parts[0], 10);
    const requesterName = parts.slice(1).join('_');
    const reqfuLeads = await db.getLeads();
    const lead = reqfuLeads.find(l => l.rowIndex === String(leadId));
    const factName = lead ? esc(lead.factory_name || lead.factory_number) : `Lead #${leadId}`;
    const currentAssignee = lead ? esc(lead.assigned_to || '—') : '—';
    // Notify admin
    const allUsers = await db.getAllUsers();
    const adminUser = allUsers.find(u => u.role === 'admin' && u.telegram_user_id);
    if (adminUser) {
      await sendTelegram('sendMessage', {
        chat_id: adminUser.telegram_user_id, parse_mode: 'HTML',
        text: `📬 <b>${esc(requesterName)}</b> is requesting the follow-up for <b>${factName}</b>\n\n👤 Currently assigned to: <b>${currentAssignee}</b>`,
        reply_markup: { inline_keyboard: [[{ text: `✅ Reassign to ${esc(requesterName)}`, callback_data: `REASSIGN_${leadId}_${requesterName}` }]] },
      }).catch(() => {});
    }
    await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
      text: `📬 <b>Request sent!</b> Admin has been notified.\n\n${factName} — you'll get a message if it's reassigned to you.` });
    return;
  }

  // ── Admin reassigns follow-up ──
  if (cbData.startsWith('REASSIGN_')) {
    const parts = cbData.replace('REASSIGN_', '').split('_');
    const leadId = parseInt(parts[0], 10);
    const newAssignee = parts.slice(1).join('_');
    const reassignLeads = await db.getLeads();
    const lead = reassignLeads.find(l => l.rowIndex === String(leadId));
    const factName = lead ? esc(lead.factory_name || lead.factory_number) : `Lead #${leadId}`;
    const result = await db.reassignFollowUp(leadId, newAssignee);
    if (result.ok) {
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, parse_mode: 'HTML',
        text: `✅ <b>Reassigned to ${esc(newAssignee)}</b>\n\n${factName} follow-up is now with ${esc(newAssignee)}.` });
      // Notify the new assignee
      const allUsers = await db.getAllUsers();
      const assigneeUser = allUsers.find(u => u.display_name === newAssignee && u.telegram_user_id);
      if (assigneeUser) {
        await sendTelegram('sendMessage', {
          chat_id: assigneeUser.telegram_user_id, parse_mode: 'HTML',
          text: `✅ <b>Follow-up assigned to you!</b>\n\n🏭 <b>${factName}</b>\n\nAdmin has reassigned this follow-up to you. Update after your visit.`,
        }).catch(() => {});
      }
    }
    return;
  }

  // ── Cancel ──
  if (cbData.startsWith('CANCEL_')) {
    cache.remove('edit_' + chatId);
    cache.remove('editall_' + chatId);
    await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '❌ <b>Cancelled.</b> No changes saved.', parse_mode: 'HTML' });
    return;
  }

  // ── Temperature buttons (Hot / Warm / Cold) ──
  if (cbData.startsWith('TEMP_')) {
    const rest    = cbData.replace('TEMP_', '');
    const sep     = rest.indexOf('_');
    const tempType = rest.slice(0, sep);       // 'Hot' | 'Warm' | 'Cold'
    const uuid    = rest.slice(sep + 1);
    const cached  = cache.get('data_' + uuid);
    if (!cached) { await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '⏰ <b>Session expired.</b> Please send again.', parse_mode: 'HTML' }); return; }
    const data = JSON.parse(cached);
    data.parsed.lead_type = tempType;
    cache.put('data_' + uuid, JSON.stringify(data), 600);
    await sendTelegram('editMessageText', {
      chat_id:      chatId,
      message_id:   messageId,
      text:         buildPreview(data.parsed, data.action, data.existingRow),
      parse_mode:   'HTML',
      reply_markup: confirmEditKeyboard(uuid, tempType),
    });
    return;
  }

  // ── Follow-up date buttons ──
  if (cbData.startsWith('FUDATE_')) {
    const rest   = cbData.replace('FUDATE_', '');
    const sep    = rest.indexOf('_');
    const type   = rest.slice(0, sep);
    const fuUuid = rest.slice(sep + 1);
    const cached = cache.get('fudate_' + fuUuid);
    if (!cached) { await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '⏰ <b>Session expired.</b>', parse_mode: 'HTML' }); return; }
    const { rowIndex } = JSON.parse(cached);

    if (type === 'skip') {
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '📅 No follow-up date set. You can add one later via Edit.', parse_mode: 'HTML' });
      cache.remove('fudate_' + fuUuid);
      return;
    }
    if (type === 'custom') {
      cache.put('fudate_custom_' + chatId, JSON.stringify({ fuUuid, rowIndex, messageId }), 300);
      await sendTelegram('sendMessage', { chat_id: chatId, text: '📅 Type the follow-up date:\n(dd/MM/yyyy or e.g. "15 July", "next week")' });
      return;
    }

    const offsets = { tomorrow: 1, '2days': 2, nextweek: 7, '2weeks': 14 };
    const dateStr = dateIST(offsets[type] || 1);
    await db.updateLead(rowIndex, { follow_up: dateStr });
    await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: `✅ Follow-up set: <b>${dateStr}</b>`, parse_mode: 'HTML' });
    cache.remove('fudate_' + fuUuid);
    // Broadcast to team (bid system) for Hot/Warm leads
    { const _fl = await db.getLeads(); const fl = _fl.find(l => l.rowIndex === String(rowIndex)); if (fl && ['Hot','Warm'].includes(fl.lead_type)) broadcastFollowUpAvailable(rowIndex, dateStr).catch(() => {}); }
    return;
  }

  // ── Edit All guided flow ──
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

  // ── Edit: show field selector ──
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

  // ── Back: return to confirm keyboard ──
  if (cbData.startsWith('BACK_')) {
    const uuid = cbData.replace('BACK_', '');
    cache.remove('edit_' + chatId);
    const cached = cache.get('data_' + uuid);
    const lt = cached ? JSON.parse(cached).parsed?.lead_type : '';
    await sendTelegram('editMessageReplyMarkup', {
      chat_id: chatId, message_id: messageId,
      reply_markup: confirmEditKeyboard(uuid, lt),
    });
    return;
  }

  // ── Field: user picked a field to edit ──
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

  // ── Confirm ──
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
      } else {
        const result = await db.addLead(parsed, createdBy);
        if (result.conflict) {
          await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: `⚠️ <b>Duplicate:</b> ${esc(result.message)}`, parse_mode: 'HTML' });
          return;
        }
        savedRowIndex = result.rowIndex;
        await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: `✅ <b>Added!</b> New entry for <b>${esc(parsed.factory_name || parsed.factory_number)}</b> saved.`, parse_mode: 'HTML' });
      }
    } catch (err) {
      console.error('DB write error:', err.message);
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '🚨 <b>Write failed.</b> Check server logs.', parse_mode: 'HTML' });
      return;
    }
    cache.remove('data_' + uuid);

    // Offer follow-up date if Hot/Warm and no date set
    if (['Hot', 'Warm'].includes(parsed.lead_type) && !parsed.follow_up && savedRowIndex) {
      const fuUuid = uuidv4();
      cache.put('fudate_' + fuUuid, JSON.stringify({ rowIndex: savedRowIndex }), 600);
      const typeLabel = parsed.lead_type === 'Hot' ? '🔥 Hot' : '🟡 Warm';
      await sendTelegram('sendMessage', {
        chat_id: chatId, parse_mode: 'HTML',
        text: `📅 <b>${typeLabel} lead</b> — set a follow-up date?`,
        reply_markup: {
          inline_keyboard: [
            [
              { text: 'Tomorrow',   callback_data: 'FUDATE_tomorrow_'  + fuUuid },
              { text: 'In 2 Days',  callback_data: 'FUDATE_2days_'     + fuUuid },
              { text: 'Next Week',  callback_data: 'FUDATE_nextweek_'  + fuUuid },
            ],
            [
              { text: 'In 2 Weeks', callback_data: 'FUDATE_2weeks_'   + fuUuid },
              { text: '📅 Custom',  callback_data: 'FUDATE_custom_'   + fuUuid },
              { text: 'Skip',       callback_data: 'FUDATE_skip_'     + fuUuid },
            ],
          ],
        },
      });
    }
    return;
  }

  // ── Stage update confirm ──
  if (cbData.startsWith('STAGE_')) {
    const uuid   = cbData.replace('STAGE_', '');
    const cached = cache.get('stage_' + uuid);
    if (!cached) { await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '⏰ <b>Session expired.</b>', parse_mode: 'HTML' }); return; }
    const { rowIndex, stageNum, stageName, factoryNum, factoryName } = JSON.parse(cached);
    try {
      await db.updateLead(rowIndex, { stage: stageName, stage_number: String(stageNum) });
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: `✅ <b>Stage Updated!</b>\n<b>${esc(factoryNum)} — ${esc(factoryName)}</b>\nNow: <b>${stageName} (#${stageNum})</b>`, parse_mode: 'HTML' });
    } catch (err) {
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '🚨 <b>Failed to update stage.</b>', parse_mode: 'HTML' });
    }
    cache.remove('stage_' + uuid);
    return;
  }

  // ── Delete confirm ──
  if (cbData.startsWith('DELETE_')) {
    const uuid   = cbData.replace('DELETE_', '');
    const cached = cache.get('del_' + uuid);
    if (!cached) { await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '⏰ <b>Session expired.</b>', parse_mode: 'HTML' }); return; }
    const { rowIndex, factoryNum, factoryName } = JSON.parse(cached);
    try {
      await db.deleteLead(rowIndex);
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: `🗑️ <b>Deleted!</b>\n<b>${esc(factoryNum)} — ${esc(factoryName)}</b> removed.`, parse_mode: 'HTML' });
    } catch (err) {
      await sendTelegram('editMessageText', { chat_id: chatId, message_id: messageId, text: '🚨 <b>Failed to delete.</b>', parse_mode: 'HTML' });
    }
    cache.remove('del_' + uuid);
    return;
  }
}

// ============================================================
//  WEB API — protected by authMiddleware
// ============================================================
app.get('/api/leads', authMiddleware, async (req, res) => {
  try {
    const leads = req.user.role === 'admin' ? await db.getLeads() : await db.getLeadsForUser(req.user.username);
    res.json(leads);
  }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/leads', authMiddleware, async (req, res) => {
  try {
    const result = await db.addLead(req.body, req.user?.username || '');
    if (result.conflict) return res.status(409).json(result);
    res.json(result);
  }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.put('/api/leads/:row', authMiddleware, async (req, res) => {
  try { res.json(await db.updateLead(parseInt(req.params.row, 10), req.body)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/leads/:row', authMiddleware, adminOnly, async (req, res) => {
  try { res.json(await db.deleteLead(parseInt(req.params.row, 10))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const leads = req.user.role === 'admin' ? await db.getLeads() : await db.getLeadsForUser(req.user.username);
    const byStage = {}, byProduct = {}, byProductRevenue = {};
    let won = 0, lost = 0;
    for (const l of leads) {
      const s = l.stage || 'Unknown';
      byStage[s] = (byStage[s] || 0) + 1;
      const items = l.items?.length ? l.items : [{ product: l.product, quantity: l.quantity, rate: l.rate }];
      for (const it of items) {
        const p = it.product || 'Unknown';
        byProduct[p]        = (byProduct[p]        || 0) + 1;
        byProductRevenue[p] = (byProductRevenue[p] || 0) + (parseFloat(it.quantity) || 0) * (parseFloat(it.rate) || 0);
      }
      if (l.stage_number === '6' || l.stage_number === '7') won++;
      if (l.stage_number === '0') lost++;
    }
    const by_lead_type = leads.reduce((acc, l) => { const t = l.lead_type || 'Unset'; acc[t] = (acc[t] || 0) + 1; return acc; }, {});
    res.json({ total: leads.length, active: leads.length - won - lost, won, lost, by_stage: byStage, by_product: byProduct, by_product_revenue: byProductRevenue, by_lead_type });
  }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Pin factory location on map ──────────────────────────────
app.patch('/api/leads/:row/location', authMiddleware, async (req, res) => {
  const { lat, lng } = req.body || {};
  if (lat == null || lng == null) return res.status(400).json({ error: 'lat and lng required' });
  if (isNaN(parseFloat(lat)) || isNaN(parseFloat(lng))) return res.status(400).json({ error: 'Invalid coordinates' });
  try {
    res.json(await db.updateLeadCoords(parseInt(req.params.row, 10), lat, lng));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Smart Route Optimization via OSRM ────────────────────────
//
// PostgreSQL/PostGIS equivalent query (if migrating):
//   SELECT id, factory_number, factory_name, person_in_charge,
//          ST_Y(location::geometry) AS lat,
//          ST_X(location::geometry) AS lng
//   FROM   factories
//   WHERE  id = ANY($1::int[])
//     AND  location IS NOT NULL;
//
// Current SQLite version handled via db.getLeadCoordinates(ids).
//
app.post('/api/route/optimize', authMiddleware, async (req, res) => {
  try {
    const { factory_ids, start_location } = req.body || {};

    if (!Array.isArray(factory_ids) || factory_ids.length < 1)
      return res.status(400).json({ error: 'Provide at least one factory_id.' });
    if (!start_location?.lat || !start_location?.lng)
      return res.status(400).json({ error: 'start_location { lat, lng } is required.' });

    // 1. Fetch factory coordinates
    const rows    = await db.getLeadCoordinates(factory_ids);
    const valid   = rows.filter(r => r.lat && r.lng && !isNaN(+r.lat) && !isNaN(+r.lng));
    const skipped = rows.filter(r => !r.lat || !r.lng || isNaN(+r.lat) || isNaN(+r.lng));

    if (!valid.length)
      return res.status(400).json({
        error: 'None of the selected factories have map coordinates. Pin them on the map first.',
        skipped: skipped.map(f => ({ id: f.id, name: f.factory_name })),
      });

    // 2. Build OSRM coordinate string — OSRM expects lng,lat (not lat,lng)
    //    waypoints[0] = agent start, waypoints[1..n] = factories
    const coords = [
      `${+start_location.lng},${+start_location.lat}`,
      ...valid.map(f => `${+f.lng},${+f.lat}`),
    ].join(';');

    const osrmUrl =
      `http://router.project-osrm.org/trip/v1/driving/${coords}` +
      `?roundtrip=true&source=first&geometries=geojson&annotations=false`;

    const { data } = await axios.get(osrmUrl, { timeout: 20000 });
    if (data.code !== 'Ok')
      throw new Error(`OSRM: ${data.code}${data.message ? ' — ' + data.message : ''}`);

    const trip          = data.trips[0];
    const osrmWaypoints = data.waypoints; // indexed by INPUT order

    // 3. Determine optimized visit sequence
    //    osrmWaypoints[i].waypoint_index = position in the optimized trip
    //    slice(1) drops the start-location entry (waypoints[0])
    const stops = osrmWaypoints
      .slice(1)
      .map((wp, i) => ({ pos: wp.waypoint_index, factory: valid[i] }))
      .sort((a, b) => a.pos - b.pos)
      .map((s, i) => ({
        order:          i + 1,
        factory_id:     s.factory.id,
        factory_number: s.factory.factory_number,
        factory_name:   s.factory.factory_name,
        person:         s.factory.person_in_charge,
        lat:            +s.factory.lat,
        lng:            +s.factory.lng,
      }));

    res.json({
      route: {
        geometry:     trip.geometry,
        distance_km:  (trip.distance / 1000).toFixed(1),
        duration_min: Math.round(trip.duration / 60),
      },
      stops,
      skipped: skipped.map(f => ({ id: f.id, name: f.factory_name })),
    });

  } catch (err) {
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT')
      return res.status(504).json({ error: 'OSRM timed out. Try again.' });
    console.error('Route optimize:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Photos API
app.get('/api/leads/:id/photos', authMiddleware, async (req, res) => {
  try { res.json(await db.getPhotos(parseInt(req.params.id, 10))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Users API (admin only)
app.get('/api/users', authMiddleware, adminOnly, async (req, res) => {
  try { res.json(await db.getAllUsers()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/users/:id', authMiddleware, adminOnly, async (req, res) => {
  try { res.json(await db.deleteUser(parseInt(req.params.id, 10))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/users/me/pin', authMiddleware, async (req, res) => {
  const { pin } = req.body || {};
  if (!pin || !/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be 4-6 digits' });
  const user = await db.getUserByName(req.user.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(await db.updateUserPin(user.id, pin));
});

// Profile — get current user info
app.get('/api/users/me', authMiddleware, async (req, res) => {
  const user = await db.getUserByName(req.user.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { id, display_name, role, telegram_user_id, created_at } = user;
  res.json({ id, display_name, role, telegram_user_id, created_at });
});

// Profile — update name and/or PIN (returns fresh token if name changed)
app.patch('/api/users/me/profile', authMiddleware, async (req, res) => {
  const { display_name, pin } = req.body || {};
  const user = await db.getUserByName(req.user.username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  let newName = user.display_name;
  if (display_name && display_name.trim() && display_name.trim() !== user.display_name) {
    const result = await db.updateUserName(user.id, display_name.trim());
    if (!result.ok) return res.status(400).json({ error: result.message });
    newName = display_name.trim();
  }
  if (pin) {
    if (!/^\d{4,6}$/.test(String(pin))) return res.status(400).json({ error: 'PIN must be 4-6 digits' });
    await db.updateUserPin(user.id, pin);
  }
  const newToken = signToken(newName, user.role);
  res.json({ ok: true, token: newToken, username: newName, role: user.role });
});

// Lead access — admin manages which salespeople can see a lead
app.get('/api/leads/:id/access', authMiddleware, adminOnly, async (req, res) => {
  try { res.json(await db.getLeadAccess(parseInt(req.params.id, 10))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/leads/:id/access', authMiddleware, adminOnly, async (req, res) => {
  const { user_display_name } = req.body || {};
  if (!user_display_name) return res.status(400).json({ error: 'user_display_name required' });
  try { res.json(await db.grantLeadAccess(parseInt(req.params.id, 10), user_display_name, req.user.username)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/leads/:id/access/:name', authMiddleware, adminOnly, async (req, res) => {
  try { res.json(await db.revokeLeadAccess(parseInt(req.params.id, 10), decodeURIComponent(req.params.name))); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Claim a follow-up (bid system)
app.post('/api/leads/:id/claim', authMiddleware, async (req, res) => {
  try { res.json(await db.claimFollowUp(parseInt(req.params.id, 10), req.user.username)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================
//  WEBAUTHN — Biometric login
//  Set RP_ID + ORIGIN in .env when accessing from a mobile device
//  on your LAN (e.g. RP_ID=192.168.1.100, ORIGIN=http://192.168.1.100:3000)
// ============================================================
const RP_NAME = 'SalesCRM';
const RP_ID   = process.env.RP_ID   || 'localhost';
const ORIGIN  = process.env.ORIGIN  || `http://localhost:${PORT}`;

// 1. Get registration options (challenge) — user must be logged in
app.post('/api/webauthn/register-options', authMiddleware, async (req, res) => {
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const existing = await db.getWebAuthnCred(user.id);
    const options  = await generateRegistrationOptions({
      rpName:          RP_NAME,
      rpID:            RP_ID,
      userID:          String(user.id),
      userName:        user.display_name,
      userDisplayName: user.display_name,
      timeout:         60000,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey:      'required',
        userVerification: 'preferred',
      },
      excludeCredentials: existing ? [{
        id:   Buffer.from(existing.credentialID, 'base64url'),
        type: 'public-key',
      }] : [],
    });

    cache.put(`wa_reg_${user.id}`, options.challenge, 120);
    res.json(options);
  } catch (err) {
    console.error('WebAuthn register-options:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 2. Verify registration and save credential
app.post('/api/webauthn/register-verify', authMiddleware, async (req, res) => {
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const expectedChallenge = cache.get(`wa_reg_${user.id}`);
    if (!expectedChallenge) return res.status(400).json({ error: 'Challenge expired — try again.' });

    const verification = await verifyRegistrationResponse({
      response:          req.body,
      expectedChallenge,
      expectedOrigin:    ORIGIN,
      expectedRPID:      RP_ID,
    });

    if (!verification.verified) return res.status(400).json({ error: 'Verification failed' });

    const { credentialID, credentialPublicKey, counter } = verification.registrationInfo;
    await db.saveWebAuthnCred(user.id, {
      credentialID:        Buffer.from(credentialID).toString('base64url'),
      credentialPublicKey: Buffer.from(credentialPublicKey).toString('base64url'),
      counter,
      transports: req.body.response?.transports || [],
    });

    cache.remove(`wa_reg_${user.id}`);
    res.json({ ok: true });
  } catch (err) {
    console.error('WebAuthn register-verify:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 3. Get authentication options (public — no login required)
app.post('/api/webauthn/auth-options', async (req, res) => {
  try {
    const sessionId = crypto.randomBytes(16).toString('hex');
    const options   = await generateAuthenticationOptions({
      rpID:              RP_ID,
      timeout:           60000,
      allowCredentials:  [],        // empty = discoverable (passkey picker)
      userVerification:  'preferred',
    });

    cache.put(`wa_auth_${sessionId}`, options.challenge, 120);
    res.json({ ...options, sessionId });
  } catch (err) {
    console.error('WebAuthn auth-options:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// 4. Verify authentication and return JWT
app.post('/api/webauthn/auth-verify', async (req, res) => {
  try {
    const { credential, sessionId } = req.body;
    if (!credential || !sessionId) return res.status(400).json({ error: 'Missing credential or sessionId' });

    const expectedChallenge = cache.get(`wa_auth_${sessionId}`);
    if (!expectedChallenge) return res.status(400).json({ error: 'Challenge expired — try again.' });

    const user = await db.getUserByWebAuthnCredId(credential.id);
    if (!user) return res.status(400).json({ error: 'No biometric registered for this device. Log in with your PIN first and enable biometric.' });

    const cred = await db.getWebAuthnCred(user.id);

    const verification = await verifyAuthenticationResponse({
      response:          credential,
      expectedChallenge,
      expectedOrigin:    ORIGIN,
      expectedRPID:      RP_ID,
      authenticator: {
        credentialID:        Buffer.from(cred.credentialID, 'base64url'),
        credentialPublicKey: Buffer.from(cred.credentialPublicKey, 'base64url'),
        counter:             cred.counter,
        transports:          cred.transports || [],
      },
    });

    if (!verification.verified) return res.status(400).json({ error: 'Biometric check failed' });

    // Update replay-attack counter
    cred.counter = verification.authenticationInfo.newCounter;
    await db.saveWebAuthnCred(user.id, cred);
    cache.remove(`wa_auth_${sessionId}`);

    res.json({
      token:    signToken(user.display_name, user.role),
      role:     user.role,
      username: user.display_name,
    });
  } catch (err) {
    console.error('WebAuthn auth-verify:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  WEBHOOK SETUP ROUTE
// ============================================================
app.get('/setup', async (req, res) => {
  if (!TELEGRAM_TOKEN || !WEBHOOK_URL) return res.status(400).json({ error: 'TELEGRAM_TOKEN or WEBHOOK_URL not set in .env' });
  try {
    await axios.get(`${TELEGRAM_API}/deleteWebhook?drop_pending_updates=true`);
    const set = await axios.post(`${TELEGRAM_API}/setWebhook`, { url: `${WEBHOOK_URL}/webhook` });
    res.json({ status: '✅ Webhook set', ok: set.data.ok, description: set.data.description });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
//  GEMINI SYSTEM PROMPT — smarter field identification
// ============================================================
const CRM_SYSTEM_PROMPT = `You are a CRM data extraction AI for an adhesive sales team in India. Your ONLY output must be a single raw JSON object — no markdown, no code fences, no explanation.

FIELD IDENTIFICATION RULES:

FACTORY NUMBER: An alphanumeric code starting with 1-3 letters followed by digits (M277, F12, D5, B100, AB3). Always appears first or near the start of the message. This is NOT a person name and NOT a factory name. Examples: M277, F3, D12, AB100.

FACTORY NAME: The business/company name — often ends with words like "Industries", "Traders", "Enterprises", "Works", "Pvt", "Ltd", "Co", "Manufacturing", "Plastics", "Footwear", OR is a place name + industry type. Appears AFTER the factory number. Examples: "Ramesh Industries", "Surat Plastics", "Om Traders".

PERSON IN CHARGE: The human contact at the factory — typically a first name or full name, often followed by honorifics like "ji", "bhai", "sahab", "sir". Appears AFTER factory name. NOT the factory name itself. Examples: "Rameshji", "Suresh bhai", "Amit sahab", "Rajesh".

ITEMS: Extract as an array. Each item has product, quantity (with unit), and rate (number only, strip ₹ symbol).
- Products: "hotmelt"/"htmlt"/"hotmolt" → "Hotmelt"; "rubber adhesive"/"rubad"/"rub ad" → "Rubber Adhesive"; "solvent"/"solv" → "Solvent"; "latex"/"ltx" → "Latex"
- Multiple items separated by commas, slashes, "and", "plus", "&"
- Format: [{"product":"Hotmelt","quantity":"500 kg","rate":"120"}]
- If only one item, still use array format

LEAD TYPE: "hot"/"urgent"/"priority"/"ready to buy"/"confirmed" → "Hot"; "warm"/"maybe"/"considering"/"thinking"/"interested" → "Warm"; "cold"/"not interested"/"dormant"/"inactive"/"later" → "Cold". If not mentioned → "".

FOLLOW UP: Any date mention — "next week", "15 july", "monday", "15/07", convert to dd/MM/yyyy where possible. "next week" = 7 days from now. Leave empty if no date mentioned.

AREA: Extract any city, district, region, or location (e.g. "Mumbai", "Surat", "Bhiwandi", "Delhi NCR"). Title Case. Leave empty if none.

STAGE MAPPING: New Lead→1, Sample Required→2, Sample Sent→3, Quotation→4, Negotiation→5, Order Won→6, Repeat Customer→7, Lost→0. If no stage mentioned → stage:"", stage_number:null.

NAME FORMATTING: Title Case. Name ending in "g" often means "ji" (Amitg → Amitji).

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
  "items": [{"product": "", "quantity": "", "rate": ""}]
}`;

async function callGemini(userText) {
  for (const model of ['gemini-2.0-flash', 'gemini-2.0-flash-lite']) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
      const res = await axios.post(url, {
        system_instruction: { parts: [{ text: CRM_SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 768, responseMimeType: 'application/json' },
      });
      let raw = res.data.candidates[0].content.parts[0].text.trim()
        .replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/\s*```$/i,'').trim();
      console.log('✅ Gemini parsed via', model);
      const parsed = JSON.parse(raw);
      // Normalize items
      if (!Array.isArray(parsed.items) || !parsed.items.length) {
        parsed.items = parsed.product ? [{ product: parsed.product, quantity: parsed.quantity || '', rate: parsed.rate || '' }] : [];
      }
      return parsed;
    } catch (err) {
      const code = err.response?.data?.error?.code;
      if (code === 429 || code === 404) { console.warn(`⚠️ Gemini ${model} unavailable (${code})`); continue; }
      console.error('Gemini error:', err.response?.data || err.message);
    }
  }
  console.warn('⚠️ Gemini quota exhausted — using local parser');
  return localParse(userText);
}

// ============================================================
//  LOCAL FALLBACK PARSER
// ============================================================
function localParse(text) {
  const t  = text.trim();
  const tl = t.toLowerCase();

  // Factory number: 1-3 letters + digits at word boundary
  const factNumMatch = t.match(/\b([A-Za-z]{1,3}\d+)\b/);
  const factory_number = factNumMatch ? factNumMatch[1].toUpperCase() : '';

  // Extract items (multi-product support)
  const items = parseLocalItems(tl);
  const product  = items.length ? items[0].product  : '';
  const quantity = items.length ? items[0].quantity : '';
  const rate     = items.length ? items[0].rate     : '';

  // Stage
  const stagePatterns = [
    { keys: ['lost','cancelled','cancel','rejected','no deal'],           name: 'Lost',              num: 0 },
    { keys: ['new lead'],                                                  name: 'New Lead',          num: 1 },
    { keys: ['sample required','sample req','need sample','send sample'],  name: 'Sample Required',   num: 2 },
    { keys: ['sample sent','sent sample','sample dispatched'],             name: 'Sample Sent',       num: 3 },
    { keys: ['quotation','quote','pricing','price sent'],                  name: 'Quotation',         num: 4 },
    { keys: ['negotiation','negotiating','discussing'],                    name: 'Negotiation',       num: 5 },
    { keys: ['order won','won','confirmed','deal done','order confirmed'],  name: 'Order Won',         num: 6 },
    { keys: ['repeat','reorder','re-order','repeat customer'],             name: 'Repeat Customer',   num: 7 },
  ];
  let stage = '', stage_number = null;
  for (const { keys, name, num } of stagePatterns) {
    if (keys.some(k => tl.includes(k))) { stage = name; stage_number = num; break; }
  }

  // Follow-up date
  const fuMatch = t.match(/follow[\s-]?up\s+(.+?)(?:\s+(?:for|in|at|by|and|,|$))/i)
                || t.match(/follow[\s-]?up\s+(.+)$/i);
  const follow_up = fuMatch ? fuMatch[1].trim() : '';

  // Area
  const cities = ['mumbai','delhi','surat','ahmedabad','pune','bangalore','bengaluru','hyderabad',
    'chennai','kolkata','jaipur','lucknow','bhopal','indore','nagpur','vadodara',
    'bhiwandi','thane','navi mumbai','noida','gurgaon','gurugram','faridabad'];
  let area = '';
  for (const city of cities) {
    if (tl.includes(city)) { area = city.replace(/\b\w/g, c => c.toUpperCase()); break; }
  }

  // Factory name: words between factory_number and known keywords
  let factory_name = '';
  if (factory_number) {
    const afterNum = t.slice(t.toUpperCase().indexOf(factory_number) + factory_number.length).trim();
    const stopWords = ['follow','rate','₹','rs','kg','ltr','ton','hotmelt','htmlt','solvent','latex','rubad',
      'new lead','sample','quotation','negotiation','order','lost','repeat', quantity.split(' ')[0]].filter(Boolean);
    const stopRe = new RegExp('\\b(' + stopWords.join('|') + ')\\b', 'i');
    const m = afterNum.match(stopRe);
    const raw = m ? afterNum.slice(0, m.index).trim() : afterNum.split(/\s{2,}/)[0].trim();
    // Grab first 1-4 words — likely factory name
    const words = raw.split(/\s+/).slice(0, 4);
    // Detect person suffix (ji/bhai/sahab) to trim factory name
    const personIdx = words.findIndex(w => /ji$|bhai$|sahab$|sir$/i.test(w));
    factory_name = (personIdx > 0 ? words.slice(0, personIdx) : words).join(' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  // Person in charge: word ending in ji/bhai/sahab, or second name group after factory name
  let person_in_charge = '';
  const personMatch = t.match(/\b(\w+(?:ji|bhai|sahab|sir))\b/i);
  if (personMatch) person_in_charge = personMatch[1].replace(/\b\w/g, c => c.toUpperCase());

  // Lead type
  const typePatterns = [
    { keys: ['hot lead','hot ','urgent','priority','ready to buy'], type: 'Hot' },
    { keys: ['warm lead','warm ','maybe','considering','thinking'],  type: 'Warm' },
    { keys: ['cold lead','cold ','not interested','dormant'],        type: 'Cold' },
  ];
  let lead_type = '';
  for (const { keys, type } of typePatterns) {
    if (keys.some(k => tl.includes(k))) { lead_type = type; break; }
  }
  // Simple keyword check as fallback
  if (!lead_type) {
    if (/\bhot\b/i.test(t))  lead_type = 'Hot';
    else if (/\bwarm\b/i.test(t)) lead_type = 'Warm';
    else if (/\bcold\b/i.test(t)) lead_type = 'Cold';
  }

  console.log('📌 Local parser:', { factory_number, factory_name, person_in_charge, items, stage, follow_up, area, lead_type });
  return { factory_number, factory_name, person_in_charge, contact:'', product, quantity, rate, stage, follow_up, notes:'', area, stage_number, lead_type, items };
}

function parseLocalItems(tl) {
  const productMap = {
    'rubber adhesive': 'Rubber Adhesive',
    'rub ad': 'Rubber Adhesive',
    'rubad':  'Rubber Adhesive',
    'hotmelt':'Hotmelt',
    'hotmolt':'Hotmelt',
    'htmlt':  'Hotmelt',
    'hmelt':  'Hotmelt',
    'solvent':'Solvent',
    'solv':   'Solvent',
    'latex':  'Latex',
    'ltx':    'Latex',
  };

  const items  = [];
  let lastPos  = 0;

  // Find all product occurrences in order
  const productOccurrences = [];
  for (const [alias, name] of Object.entries(productMap)) {
    let pos = tl.indexOf(alias, 0);
    while (pos !== -1) {
      productOccurrences.push({ pos, alias, name });
      pos = tl.indexOf(alias, pos + 1);
    }
  }
  productOccurrences.sort((a, b) => a.pos - b.pos);

  // Deduplicate: remove longer match if shorter alias already matched at same position
  const seen = new Set();
  const uniqueOccurrences = productOccurrences.filter(o => {
    const key = o.pos;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (const { pos, alias, name } of uniqueOccurrences) {
    if (pos < lastPos) continue;
    const after = tl.slice(pos + alias.length);

    // Quantity: first number after product
    const qtyMatch = after.match(/[\s@x×:]*(\d+(?:\.\d+)?)\s*(kg|ltr|liter|ton|pcs|bags?)?/i);
    const quantity = qtyMatch ? qtyMatch[1] + (qtyMatch[2] ? ' ' + qtyMatch[2] : '') : '';

    // Rate: after @, ₹, rs, or second number
    const rateMatch = after.match(/[@₹]\s*(\d+(?:\.\d+)?)/i)
                    || after.match(/(?:rs\.?|rate[:\s]+)\s*(\d+(?:\.\d+)?)/i)
                    || (qtyMatch ? after.slice((qtyMatch.index || 0) + qtyMatch[0].length).match(/[\s@×:]*(\d+(?:\.\d+)?)/) : null);
    const rate = rateMatch ? rateMatch[1] : '';

    items.push({ product: name, quantity, rate: rate ? '₹' + rate : '' });
    lastPos = pos + alias.length + (qtyMatch ? qtyMatch[0].length : 0);
  }

  return items;
}

// ============================================================
//  HELPERS
// ============================================================
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
  const action = existingRow !== -1 ? 'UPDATE' : 'ADD';
  return { existingRow, action, leads };
}

function dateIST(offsetDays = 0) {
  const now = new Date();
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000) + now.getTimezoneOffset() * 60000);
  ist.setDate(ist.getDate() + offsetDays);
  const dd   = String(ist.getDate()).padStart(2, '0');
  const mm   = String(ist.getMonth() + 1).padStart(2, '0');
  const yyyy = ist.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function parseDateInput(text) {
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(text)) return text;
  const tl = text.toLowerCase();
  if (/next week/i.test(tl))    return dateIST(7);
  if (/tomorrow/i.test(tl))     return dateIST(1);
  if (/in 2 days/i.test(tl))   return dateIST(2);
  if (/in 2 weeks/i.test(tl))  return dateIST(14);
  if (/next month/i.test(tl))  return dateIST(30);
  // Try native parse
  const parsed = new Date(text);
  if (!isNaN(parsed.getTime())) {
    return `${String(parsed.getDate()).padStart(2,'0')}/${String(parsed.getMonth()+1).padStart(2,'0')}/${parsed.getFullYear()}`;
  }
  return text;
}

function parseItemsText(text) {
  const productAliases = {
    'rubber adhesive': 'Rubber Adhesive', 'rub ad': 'Rubber Adhesive', 'rubad': 'Rubber Adhesive',
    'hotmelt': 'Hotmelt', 'hotmolt': 'Hotmelt', 'htmlt': 'Hotmelt', 'hmelt': 'Hotmelt',
    'solvent': 'Solvent', 'solv': 'Solvent',
    'latex': 'Latex', 'ltx': 'Latex',
  };

  const parts = text.split(/[,;]/).map(s => s.trim()).filter(Boolean);
  const items = [];

  for (const part of parts) {
    const pl = part.toLowerCase();
    let productName = '';
    for (const [alias, name] of Object.entries(productAliases)) {
      if (pl.includes(alias)) { productName = name; break; }
    }

    const tokens = part.trim().split(/\s+/);
    if (!productName && tokens.length >= 1) {
      productName = tokens[0].replace(/\b\w/g, c => c.toUpperCase());
    }

    const nums = part.match(/\d+(?:\.\d+)?/g) || [];
    const quantity = nums[0] || '';
    const rate     = nums[1] ? '₹' + nums[1] : '';

    items.push({ product: productName, quantity, rate });
  }
  return items;
}

function parseStageInput(text) {
  const n = parseInt(text, 10);
  if (!isNaN(n) && n >= 0 && n <= 7) return { stage: STAGE_NAMES[n], stage_number: n };
  const nameMap = { 'new lead':1,'sample required':2,'sample req':2,'sample sent':3,'quotation':4,'negotiation':5,'order won':6,'won':6,'repeat customer':7,'repeat':7,'lost':0 };
  const match = nameMap[text.toLowerCase().trim()];
  if (match !== undefined) return { stage: STAGE_NAMES[match], stage_number: match };
  return { stage: text, stage_number: null };
}

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
    chat_id:    chatId,
    parse_mode: 'HTML',
    text: `${progress} ✏️ <b>${field.label}</b>\n<i>Current: ${esc(String(currentVal))}</i>\n\n${field.hint}\n\n<code>.</code> to keep current`,
  });
}

function buildPreview(p, action, existingRow) {
  const actionTag    = action === 'UPDATE' ? `🔄 <b>UPDATE</b> — Row ${existingRow}` : '🆕 <b>NEW ENTRY</b>';
  const stageDisplay = p.stage ? esc(p.stage) + (p.stage_number != null ? ` (#${p.stage_number})` : '') : '—';
  const typeEmoji    = { Hot: '🔥', Warm: '🟡', Cold: '🔵' };
  const typeDisplay  = p.lead_type ? (typeEmoji[p.lead_type] || '') + ' ' + esc(p.lead_type) : '—';

  const itemsList = p.items && p.items.length
    ? p.items
    : (p.product ? [{ product: p.product, quantity: p.quantity, rate: p.rate }] : []);

  const itemsBlock = itemsList.length
    ? '\n' + itemsList.map((it, i) => `   ${i + 1}. ${esc(it.product)} × ${esc(it.quantity)} @ ₹${esc(it.rate)}`).join('\n')
    : '\n   —';

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
      [
        { text: hot,  callback_data: 'TEMP_Hot_'  + uuid },
        { text: warm, callback_data: 'TEMP_Warm_' + uuid },
        { text: cold, callback_data: 'TEMP_Cold_' + uuid },
      ],
      [
        { text: '✅ Confirm',  callback_data: 'CONFIRM_'  + uuid },
        { text: '✏️ Edit All', callback_data: 'EDITALL_'  + uuid },
        { text: '❌ Cancel',   callback_data: 'CANCEL_'   + uuid },
      ],
    ],
  };
}

// Broadcast a follow-up opportunity to all team members (bid system)
async function broadcastFollowUpAvailable(leadId, dateStr) {
  const leads = await db.getLeads();
  const lead  = leads.find(l => l.rowIndex === String(leadId));
  if (!lead) return;
  const users = await db.getAllUsers();
  const typeEmoji = { Hot: '🔥', Warm: '🟡', Cold: '🔵' }[lead.lead_type] || '';
  const text = [
    `📅 <b>Follow-up Available ${typeEmoji}</b>`,
    '',
    `🏭 <b>${esc(lead.factory_name || lead.factory_number)}</b>`,
    formatContacts(lead),
    `📅 Date: <b>${esc(dateStr)}</b>  📊 ${esc(lead.stage || '—')}`,
    '',
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

async function sendTelegram(method, params) {
  try { await axios.post(`${TELEGRAM_API}/${method}`, params); }
  catch (err) { console.error(`Telegram.${method}:`, err.response?.data || err.message); }
}

function esc(v) {
  if (v === undefined || v === null || String(v).trim() === '') return '—';
  return String(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ============================================================
//  POLLING — auto-starts when WEBHOOK_URL is not set
// ============================================================
function usePolling() {
  return !WEBHOOK_URL || WEBHOOK_URL.includes('your-domain');
}

async function startPolling() {
  try { await axios.get(`${TELEGRAM_API}/deleteWebhook?drop_pending_updates=true`); } catch (_) {}
  console.log('   Bot status  : 🟢 Listening via long-poll\n');
  let offset  = 0;
  let backoff = 3000;
  while (true) {
    try {
      const res = await axios.get(`${TELEGRAM_API}/getUpdates`, {
        params: { offset, timeout: 30, allowed_updates: ['message', 'callback_query'] },
        timeout: 35000,
      });
      backoff = 3000;
      const updates = res.data.result || [];
      for (const update of updates) {
        offset = update.update_id + 1;
        try {
          if (update.callback_query)       await handleCallback(update.callback_query);
          else if (update.message?.voice)  await handleVoice(update.message);
          else if (update.message?.photo)  await handlePhoto(update.message);
          else if (update.message?.text)   await handleMessage(update.message);
        } catch (err) { console.error('Poll update error:', err.message); }
      }
    } catch (err) {
      const msg = err.message || '';
      if (!msg.includes('ENOTFOUND') && !msg.includes('ECONNRESET') && !msg.includes('ECONNABORTED')) {
        console.error('Poll error:', msg);
      } else if (backoff >= 30000) {
        console.warn(`⚠️ Network issue — retrying in ${backoff / 1000}s...`);
      }
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60000);
    }
  }
}

// ── Health check (required by Hugging Face Spaces) ──────────
app.get('/health', (_req, res) => res.status(200).send('OK'));

// ============================================================
//  START
// ============================================================
async function startServer() {
  await db.initSchema();
  await db.seedAdminUser(ADMIN_USER, ADMIN_PASS);

  httpServer.listen(PORT, () => {
    console.log(`\n🚀 SalesCRM running at http://localhost:${PORT}`);
    console.log(`   Database    : MySQL (Aiven)`);
    console.log(`   Admin login : ${ADMIN_USER} / ${ADMIN_PASS}`);

    if (usePolling()) {
      console.log('   Mode        : POLLING (no webhook URL set)');
      startPolling();
    } else {
      console.log(`   Webhook     : POST /webhook`);
      console.log(`   Setup       : GET  /setup\n`);
    }
  });
}

startServer().catch(err => {
  console.error('🚨 Failed to start:', err.message);
  process.exit(1);
});
