'use strict';

// ============================================================
//  routes/pay.js — Monetization: Razorpay checkout + referrals
// ------------------------------------------------------------
//  Ships DISABLED until the owner sets RAZORPAY_KEY_ID and
//  RAZORPAY_KEY_SECRET. Keys are read ONLY from process.env; the
//  secret is used solely to sign/verify and to authenticate the
//  order call — it is NEVER logged or returned in any response.
//  Mounted under /api by index.js, so paths here omit the prefix.
// ============================================================

const express = require('express');
const crypto  = require('crypto');
const axios   = require('axios');
const db      = require('../db');
const { authMiddleware, noGuest } = require('../middleware/auth');

const router = express.Router();

// Monthly prices, in rupees. Paise (×100) is what Razorpay charges.
const PRICE_INDIVIDUAL = 500; // ₹/month, single account
const PRICE_TEAM_SEAT  = 299; // ₹/month per active seat
const GRANT_DAYS       = 30;  // a paid month of Pro

// Read credentials fresh each call so nothing is cached in a const that could
// later be logged, and so enabling/rotating keys needs only a restart.
function keyId()      { return process.env.RAZORPAY_KEY_ID     || ''; }
function keySecret()  { return process.env.RAZORPAY_KEY_SECRET || ''; }
function payEnabled() { return !!(keyId() && keySecret()); }

const NOT_CONFIGURED = 'Online payment is not configured yet — use an access code or contact support.';
const GENERIC_ORDER_FAIL = 'Could not start the payment. Please try again in a moment.';

// Verify a Razorpay checkout signature: HMAC-SHA256(order_id|payment_id) keyed
// by the secret, compared in constant time. Length-checked first so
// timingSafeEqual never throws on a mismatched-length forgery. Exported for the
// self-test harness (it exercises the real verify math without hitting Razorpay).
function verifyRazorpaySignature(orderId, paymentId, signature) {
  const expected = crypto.createHmac('sha256', keySecret())
    .update(String(orderId) + '|' + String(paymentId))
    .digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature || ''), 'utf8');
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); }
  catch (_) { return false; }
}

// ── GET /api/pay/config ───────────────────────────────────────
// Public-by-design config for the client. keyId is publishable; the secret is
// never included. Returned even when disabled so the UI can hide/soften pay CTAs.
router.get('/pay/config', authMiddleware, (req, res) => {
  const enabled = payEnabled();
  res.json({
    enabled,
    keyId: enabled ? keyId() : '',
    prices: { individual: PRICE_INDIVIDUAL, teamSeat: PRICE_TEAM_SEAT },
  });
});

// ── POST /api/pay/order ───────────────────────────────────────
// Create a Razorpay order for an individual or team subscription.
// Body: { plan: 'individual' | 'team', teamId? }
router.post('/pay/order', authMiddleware, noGuest, async (req, res, next) => {
  if (!payEnabled()) return res.status(503).json({ error: NOT_CONFIGURED });
  const { plan, teamId } = req.body || {};
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });

    let seats = 1;
    let amountPaise;
    let teamIdVal = null;
    let description;

    if (plan === 'team') {
      const tid = parseInt(teamId, 10);
      if (!tid) return res.status(400).json({ error: 'teamId is required for a team plan' });
      const team = await db.getTeamById(tid);
      if (!team) return res.status(404).json({ error: 'Team not found' });
      // Only an active owner/admin/manager may pay for the team (mirrors the
      // team-lead management role set used elsewhere in the app).
      const member = await db.getTeamMember(tid, user.id);
      if (!member || member.status !== 'active' || !['owner', 'admin', 'manager'].includes(member.role)) {
        return res.status(403).json({ error: 'Only an active team owner, admin, or manager can pay for the team' });
      }
      const members = await db.getTeamMembers(tid);
      seats = members.filter(m => m.status === 'active').length;
      if (seats < 1) return res.status(400).json({ error: 'This team has no active members to bill for' });
      amountPaise = seats * PRICE_TEAM_SEAT * 100;
      teamIdVal = tid;
      description = `Dive Pro Team — ${seats} seats × ${GRANT_DAYS} days`;
    } else if (plan === 'individual') {
      seats = 1;
      amountPaise = PRICE_INDIVIDUAL * 100;
      description = `Dive Pro — ${GRANT_DAYS} days`;
    } else {
      return res.status(400).json({ error: 'plan must be "individual" or "team"' });
    }

    // Create the order at Razorpay. Basic-auth with key_id:key_secret.
    let order;
    try {
      const resp = await axios.post('https://api.razorpay.com/v1/orders', {
        amount: amountPaise,
        currency: 'INR',
        receipt: 'dive_' + Date.now(),
        notes: {
          username: user.display_name,
          plan,
          teamId: teamIdVal ? String(teamIdVal) : '',
        },
      }, {
        auth: { username: keyId(), password: keySecret() },
        timeout: 20000,
      });
      order = resp.data;
    } catch (e) {
      // Log Razorpay's own error body/message server-side — never the secret
      // (e.config would carry the auth, so we deliberately do NOT log the error object).
      const detail = e && e.response ? JSON.stringify(e.response.data) : (e && e.message) || 'unknown';
      console.error('[pay] Razorpay order creation failed:', detail);
      return res.status(502).json({ error: GENERIC_ORDER_FAIL });
    }
    if (!order || !order.id) {
      console.error('[pay] Razorpay returned no order id');
      return res.status(502).json({ error: GENERIC_ORDER_FAIL });
    }

    await db.createPayment({
      user_id: user.id,
      team_id: teamIdVal,
      plan_kind: plan,
      seats,
      amount_paise: amountPaise,
      order_id: order.id,
      status: 'created',
    });

    res.json({
      orderId: order.id,
      amount: amountPaise,
      currency: 'INR',
      keyId: keyId(),
      description,
    });
  } catch (err) { next(err); }
});

// ── POST /api/pay/verify ──────────────────────────────────────
// Verify a completed checkout and grant Pro. Body:
// { razorpay_order_id, razorpay_payment_id, razorpay_signature }
router.post('/pay/verify', authMiddleware, noGuest, async (req, res, next) => {
  if (!payEnabled()) return res.status(503).json({ error: NOT_CONFIGURED });
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ error: 'Missing payment verification fields' });
  }
  try {
    // 1. Signature must verify BEFORE we trust or grant anything.
    if (!verifyRazorpaySignature(razorpay_order_id, razorpay_payment_id, razorpay_signature)) {
      return res.status(400).json({ error: 'Payment verification failed' });
    }

    // 2. The order must exist and belong to the caller.
    const payment = await db.getPaymentByOrderId(razorpay_order_id);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (payment.user_id !== user.id) {
      return res.status(403).json({ error: 'This payment belongs to another account' });
    }

    // 3. Idempotent: an already-settled order grants nothing further.
    if (payment.status === 'paid') {
      return res.json({ success: true, plan: payment.plan_kind, daysAdded: GRANT_DAYS, alreadyProcessed: true });
    }

    // 4. Settle first (atomic, single-flip), then grant. markPaymentPaid only
    //    returns a row for the caller that actually flips created→paid, so a
    //    concurrent second verify gets null here and grants nothing — no double
    //    grant. Worst case is paid-but-under-granted (recoverable), never double.
    const settled = await db.markPaymentPaid(razorpay_order_id, razorpay_payment_id);
    if (!settled) {
      return res.json({ success: true, plan: payment.plan_kind, daysAdded: GRANT_DAYS, alreadyProcessed: true });
    }

    if (payment.plan_kind === 'team' && payment.team_id) {
      const members = await db.getTeamMembers(payment.team_id);
      for (const m of members.filter(x => x.status === 'active')) {
        try { await db.extendUserPro(m.user_id, GRANT_DAYS, 'team'); }
        catch (e) { console.warn('[pay] grant skipped for member', m.user_id, e && e.message); }
      }
    } else {
      await db.extendUserPro(user.id, GRANT_DAYS, 'individual');
    }

    res.json({ success: true, plan: payment.plan_kind, daysAdded: GRANT_DAYS });
  } catch (err) { next(err); }
});

// ── GET /api/pay/referral ─────────────────────────────────────
// The caller's referral code + how many credited referrals they have (cap 10).
// Lazily generates+persists the code on first read.
router.get('/pay/referral', authMiddleware, noGuest, async (req, res, next) => {
  try {
    const user = await db.getUserByName(req.user.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const code = await db.getOrCreateReferralCode(user.id);
    const creditedCount = await db.countCreditedReferrals(user.id);
    res.json({ code: code || '', creditedCount, cap: 10 });
  } catch (err) { next(err); }
});

module.exports = router;
// Exposed for the offline self-test harness (no network / Razorpay needed).
module.exports.verifyRazorpaySignature = verifyRazorpaySignature;
module.exports.payEnabled = payEnabled;
