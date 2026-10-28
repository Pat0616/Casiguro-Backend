// backend/utils/mailer.js
// Outgoing email through a Gmail account (SMTP + App Password). Configure in .env:
//   MAIL_USER=casiguro.system@gmail.com
//   MAIL_APP_PASSWORD=<16-character Google App Password, no spaces>
//   MAIL_FROM_NAME=Casiguro Enterprises
// Without MAIL_USER the message is printed to the server console instead (development only).
import nodemailer from "nodemailer";

let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_APP_PASSWORD },
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

// Tells an admin their account was deactivated, so a wrongful lock-out doesn't go unnoticed
export async function sendAccountDeactivatedEmail(to, name, { byName, reason, at = new Date() }) {
  const firstName = String(name).trim().split(/\s+/)[0] || "there";
  const when = at.toLocaleString("en-US", {
    timeZone: "Asia/Manila",
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
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

// Sends through Gmail, or prints `consoleNote` when mail isn't configured (development)
async function sendMail({ to, subject, text, html, consoleNote }) {
  if (!process.env.MAIL_USER || !process.env.MAIL_APP_PASSWORD) {
    console.warn(`[mailer] MAIL_USER / MAIL_APP_PASSWORD not set; not sending. ${consoleNote}`);
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
