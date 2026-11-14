// backend/utils/mailer.js
// Outgoing email (sign-up and password reset codes, account notices). The first one configured in .env is used:
//   Resend (needs a domain; HTTPS):
//     RESEND_API_KEY=re_...   MAIL_FROM=no-reply@<domain verified in Resend>
//   Gmail API (production on DigitalOcean; HTTPS, no domain needed):
//     MAIL_USER=<gmail address>   GMAIL_CLIENT_ID=...   GMAIL_CLIENT_SECRET=...   GMAIL_REFRESH_TOKEN=...
//   Gmail SMTP (local development; blocked on DigitalOcean):
//     MAIL_USER=<gmail address>   MAIL_APP_PASSWORD=<16-character Google App Password>
//   MAIL_FROM_NAME=Casiguro Enterprises (display name, all of them)
// With neither, the message is printed to the server console instead (development only).
import nodemailer from "nodemailer";

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_APP_PASSWORD },
      // Fail fast instead of hanging the request for minutes when SMTP is blocked (DigitalOcean blocks it by default)
      connectionTimeout: 15000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
  }
  return transporter;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export async function sendVerificationCode(to, name, code, expiresInMinutes) {
  const firstName = String(name).trim().split(/\s+/)[0] || "there";
  const subject = `${code} is your Casiguro verification code`;
  const text =
    `Hi ${firstName},\n\n` +
    `Your verification code is ${code}. It expires in ${expiresInMinutes} minutes.\n\n` +
    `Enter it on the registration page to send your account request to an administrator.\n` +
    `If you didn't request this, you can ignore this email.\n\n` +
    `Casiguro Enterprises Inc. — Transaction Management System`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#0f172a">
      <div style="height:6px;background:linear-gradient(90deg,#0ea5e9,#db2777,#facc15)"></div>
      <h2 style="color:#1e3a8a;margin:24px 0 8px">Verify your email</h2>
      <p>Hi ${escapeHtml(firstName)},</p>
      <p>Use this code to finish your account request for the Casiguro Transaction Management System:</p>
      <p style="font-size:32px;font-weight:bold;letter-spacing:8px;background:#f1f5f9;border-radius:12px;padding:16px;text-align:center;margin:24px 0">${code}</p>
      <p>It expires in <strong>${expiresInMinutes} minutes</strong>. After you enter it, an administrator will review your request.</p>
      <p style="color:#64748b;font-size:13px">If you didn't request this, you can ignore this email.</p>
      <p style="color:#94a3b8;font-size:12px;margin-top:32px">Casiguro Enterprises Inc.</p>
    </div>`;

  await sendMail({ to, subject, text, html, consoleNote: `Verification code for ${to}: ${code}` });
}

export async function sendPasswordResetCode(to, name, code, expiresInMinutes) {
  const firstName = String(name).trim().split(/\s+/)[0] || "there";
  const subject = `${code} is your Casiguro password reset code`;
  const text =
    `Hi ${firstName},\n\n` +
    `Your password reset code is ${code}. It expires in ${expiresInMinutes} minutes.\n\n` +
    `Enter it on the Forgot Password page to choose a new password.\n` +
    `If you didn't ask to reset your password, you can ignore this email; your password stays the same.\n\n` +
    `Casiguro Enterprises Inc. — Transaction Management System`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#0f172a">
      <div style="height:6px;background:linear-gradient(90deg,#0ea5e9,#db2777,#facc15)"></div>
      <h2 style="color:#1e3a8a;margin:24px 0 8px">Reset your password</h2>
      <p>Hi ${escapeHtml(firstName)},</p>
      <p>Use this code to choose a new password for the Casiguro Transaction Management System:</p>
      <p style="font-size:32px;font-weight:bold;letter-spacing:8px;background:#f1f5f9;border-radius:12px;padding:16px;text-align:center;margin:24px 0">${code}</p>
      <p>It expires in <strong>${expiresInMinutes} minutes</strong>.</p>
      <p style="color:#64748b;font-size:13px">If you didn't ask to reset your password, you can ignore this email; your password stays the same.</p>
      <p style="color:#94a3b8;font-size:12px;margin-top:32px">Casiguro Enterprises Inc.</p>
    </div>`;

  await sendMail({ to, subject, text, html, consoleNote: `Password reset code for ${to}: ${code}` });
}

// Confirms a password change or reset, so someone who didn't do it finds out
export async function sendPasswordChangedEmail(to, name, { via, at = new Date() }) {
  const firstName = String(name).trim().split(/\s+/)[0] || "there";
  const when = manilaTime(at);
  const how = via === "reset" ? "reset with a code sent to this email" : "changed from inside the system";
  const subject = "Your Casiguro password was changed";
  const text =
    `Hi ${firstName},\n\n` +
    `The password for your Casiguro Transaction Management System account was ${how} on ${when} (Manila time). ` +
    `Other devices that were signed in have been signed out.\n\n` +
    `If this wasn't you, reset your password with "Forgot Password?" on the sign-in page and tell an administrator.\n\n` +
    `Casiguro Enterprises Inc. — Transaction Management System`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#0f172a">
      <div style="height:6px;background:linear-gradient(90deg,#0ea5e9,#db2777,#facc15)"></div>
      <h2 style="color:#1e3a8a;margin:24px 0 8px">Your password was changed</h2>
      <p>Hi ${escapeHtml(firstName)},</p>
      <p>The password for your Casiguro Transaction Management System account was ${how} on
        <strong>${escapeHtml(when)}</strong> (Manila time). Other devices that were signed in have been signed out.</p>
      <p style="background:#f1f5f9;border-radius:12px;padding:12px 16px;margin:20px 0">If this wasn't you, reset your password with
        <strong>Forgot Password?</strong> on the sign-in page and tell an administrator.</p>
      <p style="color:#94a3b8;font-size:12px;margin-top:32px">Casiguro Enterprises Inc.</p>
    </div>`;

  await sendMail({ to, subject, text, html, consoleNote: `Password ${via} notice for ${to}` });
}

const manilaTime = (at) =>
  at.toLocaleString("en-US", {
    timeZone: "Asia/Manila",
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

// Tells an admin their account was deactivated, so a wrongful lock-out doesn't go unnoticed
export async function sendAccountDeactivatedEmail(to, name, { byName, reason, at = new Date() }) {
  const firstName = String(name).trim().split(/\s+/)[0] || "there";
  const when = manilaTime(at);
  const subject = "Your Casiguro admin account was deactivated";
  const text =
    `Hi ${firstName},\n\n` +
    `Your admin account in the Casiguro Transaction Management System was deactivated by ${byName} on ${when} (Manila time).\n\n` +
    `Reason: ${reason}\n\n` +
    `You can no longer sign in. If this wasn't expected, contact another administrator; any admin can reactivate the account.\n\n` +
    `Casiguro Enterprises Inc. — Transaction Management System`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#0f172a">
      <div style="height:6px;background:linear-gradient(90deg,#0ea5e9,#db2777,#facc15)"></div>
      <h2 style="color:#be123c;margin:24px 0 8px">Your admin account was deactivated</h2>
      <p>Hi ${escapeHtml(firstName)},</p>
      <p>Your admin account in the Casiguro Transaction Management System was deactivated by
        <strong>${escapeHtml(byName)}</strong> on <strong>${escapeHtml(when)}</strong> (Manila time).</p>
      <p style="background:#f1f5f9;border-radius:12px;padding:12px 16px;margin:20px 0"><strong>Reason:</strong> ${escapeHtml(reason)}</p>
      <p>You can no longer sign in. If this wasn't expected, contact another administrator; any admin can reactivate the account.</p>
      <p style="color:#94a3b8;font-size:12px;margin-top:32px">Casiguro Enterprises Inc.</p>
    </div>`;

  await sendMail({ to, subject, text, html, consoleNote: `Deactivation notice for ${to}: by ${byName}, reason "${reason}"` });
}

// Resend (https://resend.com) sends over HTTPS, so it works on hosts that block SMTP ports (DigitalOcean).
// MAIL_FROM must use a domain verified in Resend; without one only the test sender onboarding@resend.dev works,
// and it can only deliver to the Resend account's own email address.
const RESEND_TEST_SENDER = "onboarding@resend.dev";

async function sendWithResend({ to, subject, text, html }) {
  const fromName = process.env.MAIL_FROM_NAME || "Casiguro Enterprises";
  const fromAddress = process.env.MAIL_FROM?.trim() || RESEND_TEST_SENDER;
  let response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `${fromName} <${fromAddress}>`, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    throw new Error(`Resend request failed: ${err.name === "TimeoutError" ? "timed out" : err.message}`);
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`Resend rejected the email (${response.status}): ${body.message || response.statusText}`);
  }
}

// Gmail API: sends as MAIL_USER through Google's HTTPS API, so it works where SMTP ports are blocked (DigitalOcean)
// and needs no domain. GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET come from a Google Cloud OAuth client; the refresh token
// from `npm run gmail:auth` (signed in as MAIL_USER). See DEPLOYMENT.md "Email with the Gmail API".
const gmailApiConfigured = () =>
  Boolean(process.env.GMAIL_CLIENT_ID?.trim() && process.env.GMAIL_CLIENT_SECRET?.trim() && process.env.GMAIL_REFRESH_TOKEN?.trim());

let gmailAccessToken = null; // { token, expiresAt }

async function getGmailAccessToken() {
  if (gmailAccessToken && Date.now() < gmailAccessToken.expiresAt) return gmailAccessToken.token;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.GMAIL_CLIENT_ID.trim(),
      client_secret: process.env.GMAIL_CLIENT_SECRET.trim(),
      refresh_token: process.env.GMAIL_REFRESH_TOKEN.trim(),
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    const hint =
      body.error === "invalid_grant"
        ? " The refresh token was revoked or expired (an OAuth app left in \"Testing\" expires them after 7 days). Publish the app and run npm run gmail:auth again."
        : "";
    const reason = String(body.error_description || body.error || response.status).replace(/\.$/, "");
    throw new Error(`Gmail sign-in failed: ${reason}.${hint}`);
  }
  // Renew a minute early so a token never expires mid-request
  gmailAccessToken = { token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in || 3600) - 60) * 1000 };
  return gmailAccessToken.token;
}

// Builds the raw email (headers, text + HTML parts) without sending it
const mimeBuilder = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "unix" });

async function sendWithGmailApi({ from, to, subject, text, html }) {
  const { message } = await mimeBuilder.sendMail({ from, to, subject, text, html });
  const send = (token) =>
    fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ raw: message.toString("base64url") }),
      signal: AbortSignal.timeout(15000),
    });
  let response = await send(await getGmailAccessToken());
  if (response.status === 401) {
    gmailAccessToken = null; // token revoked early: get a fresh one and try once more
    response = await send(await getGmailAccessToken());
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(`Gmail API rejected the email (${response.status}): ${body.error?.message || response.statusText}`);
  }
}

// Picks the first configured way: Resend, Gmail API, Gmail SMTP; with none, prints `consoleNote` (development)
async function sendMail({ to, subject, text, html, consoleNote }) {
  if (process.env.RESEND_API_KEY?.trim()) {
    await sendWithResend({ to, subject, text, html });
    return;
  }
  if (gmailApiConfigured()) {
    if (!process.env.MAIL_USER) throw new Error("MAIL_USER (the Gmail address that authorized the app) is not set.");
    const from = `"${process.env.MAIL_FROM_NAME || "Casiguro Enterprises"}" <${process.env.MAIL_USER}>`;
    await sendWithGmailApi({ from, to, subject, text, html });
    return;
  }
  if (!process.env.MAIL_USER || !process.env.MAIL_APP_PASSWORD) {
    console.warn(`[mailer] No email sender configured in .env; not sending. ${consoleNote}`);
    return;
  }
  await getTransporter().sendMail({
    from: `"${process.env.MAIL_FROM_NAME || "Casiguro Enterprises"}" <${process.env.MAIL_USER}>`,
    to,
    subject,
    text,
    html,
  });
}
