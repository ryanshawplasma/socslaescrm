'use strict';

// ============================================================
//  Outbound email — SMTP, deliberately provider-agnostic.
//
//  Every mail provider worth using speaks SMTP (Gmail app passwords, Brevo,
//  Zoho, SendGrid, Mailgun, Resend, Postmark…), so one implementation covers
//  all of them and switching provider is an env change, not a code change.
//
//  Env-gated exactly like routes/pay.js: with no SMTP_* vars set the app boots
//  and behaves normally, mail just isn't delivered. That keeps a missing
//  credential from turning into a 500 on the password-reset path.
//
//  Required to actually send:
//    SMTP_HOST   e.g. smtp.gmail.com | smtp-relay.brevo.com | smtp.resend.com
//    SMTP_PORT   587 (STARTTLS) or 465 (implicit TLS)
//    SMTP_USER   the SMTP username the provider gives you
//    SMTP_PASS   the SMTP password / API key / Gmail app password
//  Optional:
//    SMTP_FROM   "Dive <no-reply@yourdomain.com>" — defaults to SMTP_USER
// ============================================================

let _nodemailer = null;
let _transport  = null;

function mailConfig() {
  const host = (process.env.SMTP_HOST || '').trim();
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').trim();
  const port = parseInt(process.env.SMTP_PORT || '587', 10) || 587;
  const from = (process.env.SMTP_FROM || '').trim() || (user ? `Dive <${user}>` : '');
  return { host, port, user, pass, from };
}

function isMailConfigured() {
  const c = mailConfig();
  return !!(c.host && c.user && c.pass);
}

function getTransport() {
  if (_transport) return _transport;
  const c = mailConfig();
  if (!c.host || !c.user || !c.pass) return null;
  if (!_nodemailer) _nodemailer = require('nodemailer');
  _transport = _nodemailer.createTransport({
    host: c.host,
    port: c.port,
    // 465 is implicit TLS; 587 upgrades via STARTTLS. Getting this backwards is
    // the single most common SMTP misconfiguration, so derive it rather than
    // asking for yet another env var.
    secure: c.port === 465,
    auth: { user: c.user, pass: c.pass },
  });
  return _transport;
}

/**
 * Send one message. Never throws — callers are on user-facing paths where a mail
 * outage must not become a failed request. Returns {sent, reason}.
 */
async function sendMail({ to, subject, html, text }) {
  const c = mailConfig();
  const transport = getTransport();
  if (!transport) {
    // Not configured. Say so plainly in the log so the cause is obvious rather
    // than looking like silent mail loss.
    console.warn('[mail] not configured (set SMTP_HOST/SMTP_USER/SMTP_PASS) — skipped:', subject);
    return { sent: false, reason: 'not_configured' };
  }
  try {
    await transport.sendMail({ from: c.from, to, subject, html, text });
    console.log('[mail] sent:', subject, '->', maskEmail(to));
    return { sent: true };
  } catch (err) {
    console.error('[mail] send failed:', err && err.message);
    return { sent: false, reason: 'send_failed' };
  }
}

// Never log a full address — these end up in Render's log retention.
function maskEmail(e) {
  const s = String(e || '');
  const at = s.indexOf('@');
  if (at < 1) return '***';
  return `${s[0]}***${s.slice(at)}`;
}

// ── Templates ────────────────────────────────────────────────
// Inline styles only: every mail client strips <style> blocks, and several
// (Outlook, Gmail's clipper) mangle anything clever. Plain-text alternative is
// always included — some clients show it, and spam filters look for it.

function passwordResetEmail({ displayName, link, minutes }) {
  const safeName = escapeHtml(displayName || 'there');
  const safeLink = escapeHtml(link);
  const html = `
<div style="margin:0;padding:24px;background:#F4F8FC;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border:1px solid #E2E8F0;border-radius:14px;overflow:hidden;">
    <div style="background:linear-gradient(135deg,#56C0F5,#0270C4);padding:20px 24px;">
      <div style="color:#ffffff;font-size:19px;font-weight:700;letter-spacing:-.3px;">Dive</div>
    </div>
    <div style="padding:26px 24px;">
      <p style="margin:0 0 14px;font-size:16px;color:#0B2338;">Hi ${safeName},</p>
      <p style="margin:0 0 20px;font-size:14px;line-height:1.6;color:#475569;">
        We got a request to reset your Dive password. Tap the button below to choose a new one.
        This link works once and expires in ${minutes} minutes.
      </p>
      <p style="margin:0 0 22px;">
        <a href="${safeLink}"
           style="display:inline-block;background:#0C8CE9;color:#ffffff;text-decoration:none;
                  font-size:15px;font-weight:600;padding:13px 26px;border-radius:10px;">
          Reset my password
        </a>
      </p>
      <p style="margin:0 0 8px;font-size:12.5px;color:#64748B;">
        Button not working? Paste this into your browser:
      </p>
      <p style="margin:0 0 22px;font-size:12.5px;word-break:break-all;">
        <a href="${safeLink}" style="color:#0C8CE9;">${safeLink}</a>
      </p>
      <p style="margin:0;font-size:12.5px;line-height:1.6;color:#64748B;border-top:1px solid #E2E8F0;padding-top:16px;">
        Didn't ask for this? You can ignore this email — your password stays as it is,
        and the link above will expire on its own.
      </p>
    </div>
  </div>
</div>`.trim();

  const text = [
    `Hi ${displayName || 'there'},`,
    '',
    'We got a request to reset your Dive password.',
    `Open this link to choose a new one (works once, expires in ${minutes} minutes):`,
    '',
    link,
    '',
    "Didn't ask for this? Ignore this email — your password stays as it is.",
  ].join('\n');

  return { subject: 'Reset your Dive password', html, text };
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { sendMail, isMailConfigured, passwordResetEmail, maskEmail };
