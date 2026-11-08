// controllers/authController.js
import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import pool from "../database/db.js"; // import your pool directly
import { generateToken } from "../utils/generateToken.js";
import { logAudit, logAuditSafely } from "../utils/auditLog.js";
import { emitAccountChanged } from "../websocket/socket.js";
import { sendPasswordChangedEmail, sendPasswordResetCode, sendVerificationCode } from "../utils/mailer.js";
import { EMAIL_PATTERN, parseRegistration, validatePassword } from "../utils/accountFields.js";

const BLOCKED_LOGIN_MESSAGES = {
  pending: "Your account is awaiting admin approval. You can sign in once an administrator approves it.",
  rejected: "Your registration was not approved. Please contact an administrator.",
  deactivated: "This account has been deactivated. Please contact an administrator.",
};

// ---------------------------------------------------------------------------------------------------------------
// REGISTRATION — public sign-up in two steps. /register/start emails a 6-digit code; /register/verify checks it and
// only then creates the pending employee, so every request an admin sees has a confirmed email address.
// ---------------------------------------------------------------------------------------------------------------
const CODE_TTL_MINUTES = 10;
const RESEND_COOLDOWN_SECONDS = 60;
const MAX_CODE_ATTEMPTS = 5;
const MAX_CODES_PER_HOUR = 5;

// "2026-10-22 23:15:00" → "10/22/2026"
const toDocDate = (value) => {
  const [y, m, d] = String(value || "").slice(0, 10).split("-");
  return y ? `${m}/${d}/${y}` : "";
};

// Why an email can't start a new request, based on the account that already uses it
function existingAccountMessage(user) {
  switch (user.status) {
    case "rejected":
      return `This email's registration was not approved${user.status_changed_at ? ` on ${toDocDate(user.status_changed_at)}` : ""}. Please contact an administrator.`;
    case "pending":
      return "A request with this email is already waiting for admin approval.";
    case "deactivated":
      return "This account has been deactivated. Please contact an administrator.";
    default:
      return "This email already has an account. Please sign in.";
  }
}

// `key` is the email for registration and "reset:<user id>" for password resets, so one code can't serve the other
const hashCode = (key, code) =>
  crypto.createHash("sha256").update(`${key}:${code}:${process.env.JWT_SECRET || ""}`).digest("hex");

const newCode = () => String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");

async function findVerification(db, email) {
  const [rows] = await db.query(
    `SELECT *,
      expires_at < NOW() AS expired,
      TIMESTAMPDIFF(SECOND, last_sent_at, NOW()) AS seconds_since_sent,
      window_started_at < NOW() - INTERVAL 1 HOUR AS window_over
    FROM email_verifications WHERE email = ?`,
    [email]
  );
  return rows[0] || null;
}

// Rate limits shared by start (re-submitting the form) and resend. Returns an error message or null.
function sendLimitError(row) {
  if (!row) return null;
  if (row.seconds_since_sent < RESEND_COOLDOWN_SECONDS) {
    return `Please wait ${RESEND_COOLDOWN_SECONDS - row.seconds_since_sent} seconds before requesting another code.`;
  }
  if (!row.window_over && row.send_count >= MAX_CODES_PER_HOUR) {
    return "Too many codes requested for this email. Please try again in an hour.";
  }
  return null;
}

// Nodemailer error codes that mean the server can't reach the mail service at all
const MAIL_NETWORK_ERRORS = new Set(["ECONNECTION", "ETIMEDOUT", "ESOCKET", "EDNS"]);

// Runs `send` (which emails the code). On failure, answers the request and returns false. Problems with the server's
// own mail settings get a message the user can act on (tell an admin) instead of one blaming their address.
async function emailCode(res, send) {
  try {
    await send();
    return true;
  } catch (err) {
    if (err.code === "EAUTH") {
      console.error(
        "Verification email failed: Gmail rejected MAIL_USER / MAIL_APP_PASSWORD in .env. " +
          "MAIL_APP_PASSWORD must be a 16-letter Google App Password (needs 2-Step Verification), not the account password. " +
          "Restart the server after changing .env.",
        `(${err.responseCode ?? ""} ${err.response ?? err.message})`
      );
      res.status(503).json({ message: "Email sending isn't set up correctly. Please contact an administrator." });
    } else if (MAIL_NETWORK_ERRORS.has(err.code)) {
      console.error("Verification email failed: could not reach the mail server.", err.code, err.message);
      res.status(503).json({ message: "We couldn't reach the email service. Please try again in a few minutes." });
    } else {
      console.error("Verification email failed:", err);
      res.status(502).json({ message: "We couldn't send the verification email. Check the address and try again." });
    }
    return false;
  }
}

// POST /api/auth/register/start — validate, refuse emails already in use, email a code. No account is created yet.
export async function startRegistration(req, res) {
  try {
    const { fields, error } = parseRegistration(req.body);
    if (error) return res.status(400).json({ message: error });
    const { full_name, email, contact_number, password } = fields;

    const [users] = await pool.query("SELECT status, status_changed_at FROM users WHERE LOWER(email) = ?", [email]);
    if (users.length > 0) return res.status(409).json({ message: existingAccountMessage(users[0]) });

    const existing = await findVerification(pool, email);
    const limitError = sendLimitError(existing);
    if (limitError) return res.status(429).json({ message: limitError });

    const code = newCode();
    if (!(await emailCode(res, () => sendVerificationCode(email, full_name, code, CODE_TTL_MINUTES)))) return;

    const passwordHash = await bcrypt.hash(password, 10);
    const sameWindow = existing && !existing.window_over;
    await pool.query(
      `INSERT INTO email_verifications
        (email, code_hash, full_name, contact_number, password_hash, expires_at, attempts, send_count, window_started_at, last_sent_at)
      VALUES (?, ?, ?, ?, ?, NOW() + INTERVAL ? MINUTE, 0, ?, ${sameWindow ? "?" : "NOW()"}, NOW())
      ON DUPLICATE KEY UPDATE
        code_hash = VALUES(code_hash), full_name = VALUES(full_name), contact_number = VALUES(contact_number),
        password_hash = VALUES(password_hash), expires_at = VALUES(expires_at), attempts = 0,
        send_count = VALUES(send_count), window_started_at = VALUES(window_started_at), last_sent_at = NOW()`,
      [
        email, hashCode(email, code), full_name, contact_number, passwordHash, CODE_TTL_MINUTES,
        sameWindow ? existing.send_count + 1 : 1,
        ...(sameWindow ? [existing.window_started_at] : []),
      ]
    );
    // Housekeeping: abandoned sign-ups
    await pool.query("DELETE FROM email_verifications WHERE expires_at < NOW() - INTERVAL 1 DAY");

    res.status(202).json({
      message: `We sent a 6-digit code to ${email}.`,
      email,
      expiresInMinutes: CODE_TTL_MINUTES,
      resendAfterSeconds: RESEND_COOLDOWN_SECONDS,
    });
  } catch (err) {
    console.error("startRegistration error:", err);
    res.status(500).json({ message: "Server error" });
  }
}

// POST /api/auth/register/resend — new code for a sign-up that was already started
export async function resendRegistrationCode(req, res) {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const existing = await findVerification(pool, email);
    if (!existing) return res.status(404).json({ message: "No sign-up in progress for this email. Please fill in the form again." });
    const limitError = sendLimitError(existing);
    if (limitError) return res.status(429).json({ message: limitError });

    const code = newCode();
    if (!(await emailCode(res, () => sendVerificationCode(email, existing.full_name, code, CODE_TTL_MINUTES)))) return;

    const sameWindow = !existing.window_over;
    await pool.query(
      `UPDATE email_verifications SET
        code_hash = ?, expires_at = NOW() + INTERVAL ? MINUTE, attempts = 0, last_sent_at = NOW(),
        send_count = ?, window_started_at = ${sameWindow ? "window_started_at" : "NOW()"}
      WHERE email = ?`,
      [hashCode(email, code), CODE_TTL_MINUTES, sameWindow ? existing.send_count + 1 : 1, email]
    );
    res.json({ message: `We sent a new code to ${email}.`, expiresInMinutes: CODE_TTL_MINUTES, resendAfterSeconds: RESEND_COOLDOWN_SECONDS });
  } catch (err) {
    console.error("resendRegistrationCode error:", err);
    res.status(500).json({ message: "Server error" });
  }
}

// POST /api/auth/register/verify — check the code, then create the pending employee for admin approval
export async function verifyRegistration(req, res) {
  const conn = await pool.getConnection();
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const code = String(req.body.code || "").trim();
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ message: "Enter the 6-digit code from the email." });

    await conn.beginTransaction();
    const [lockRows] = await conn.query("SELECT email FROM email_verifications WHERE email = ? FOR UPDATE", [email]);
    const pending = lockRows.length > 0 ? await findVerification(conn, email) : null;
    if (!pending) {
      await conn.rollback();
      return res.status(404).json({ message: "No sign-up in progress for this email. Please fill in the form again." });
    }
    if (pending.expired || pending.attempts >= MAX_CODE_ATTEMPTS) {
      await conn.rollback();
      return res.status(410).json({ message: "This code has expired. Please request a new one." });
    }

    const expected = Buffer.from(pending.code_hash, "hex");
    const given = Buffer.from(hashCode(email, code), "hex");
    if (!crypto.timingSafeEqual(expected, given)) {
      await conn.query("UPDATE email_verifications SET attempts = attempts + 1 WHERE email = ?", [email]);
      await conn.commit();
      const left = MAX_CODE_ATTEMPTS - pending.attempts - 1;
      return res.status(400).json({
        message: left > 0 ? `Incorrect code. ${left} ${left === 1 ? "try" : "tries"} left.` : "Incorrect code. Please request a new one.",
      });
    }

    // The email may have been registered by someone else while this code was outstanding
    const [users] = await conn.query("SELECT status, status_changed_at FROM users WHERE LOWER(email) = ?", [email]);
    if (users.length > 0) {
      await conn.query("DELETE FROM email_verifications WHERE email = ?", [email]);
      await conn.commit();
      return res.status(409).json({ message: existingAccountMessage(users[0]) });
    }

    const id = crypto.randomUUID();
    const { full_name, contact_number, password_hash: hashedPassword } = pending;
    // role and status are fixed server-side; anything the client sends for them is ignored
    await conn.query(
      "INSERT INTO users (id, full_name, email, contact_number, password, role, status) VALUES (?, ?, ?, ?, ?, 'employee', 'pending')",
      [id, full_name, email, contact_number, hashedPassword]
    );
    await conn.query("DELETE FROM email_verifications WHERE email = ?", [email]);
    await logAudit(conn, req, {
      actor: { id, full_name, role: "employee" },
      action: "account.register",
      category: "account",
      entityType: "user",
      entityId: id,
      entityLabel: email,
      description: `Registered an account (${email}, email verified); awaiting admin approval`,
    });
    await conn.commit();

    emitAccountChanged({ userId: id, status: "pending" });
    res.status(201).json({
      message: "Registration submitted. An administrator needs to approve your account before you can sign in.",
      user: { id, full_name, email, role: "employee", status: "pending" },
    });
  } catch (err) {
    await conn.rollback();
    console.error("verifyRegistration error:", err);
    res.status(500).json({ message: "Server error" });
  } finally {
    conn.release();
  }
}

function setAuthCookie(res, userId) {
  res.cookie("token", generateToken({ id: userId }), {
    httpOnly: true,
    secure: false, // set true in production with HTTPS
    sameSite: "strict",
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
  });
}

// LOGIN
export async function login(req, res) {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const [rows] = await pool.query("SELECT * FROM users WHERE LOWER(email) = ?", [email]);
    const user = rows[0];

    if (!user) {
      await logAuditSafely(pool, req, {
        actor: { id: null, full_name: null, role: null },
        action: "auth.login_failed",
        category: "auth",
        entityLabel: email,
        description: `Failed sign-in for unknown email ${email || "(blank)"}`,
      });
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const actor = { id: user.id, full_name: user.full_name, role: user.role };
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      await logAuditSafely(pool, req, {
        actor,
        action: "auth.login_failed",
        category: "auth",
        entityLabel: user.email,
        description: "Failed sign-in attempt (wrong password)",
      });
      return res.status(400).json({ message: "Invalid credentials" });
    }

    // Status is only revealed after the password is verified, so it can't be used to probe which emails exist
    if (user.status !== "active") {
      await logAuditSafely(pool, req, {
        actor,
        action: "auth.login_blocked",
        category: "auth",
        entityLabel: user.email,
        description: `Sign-in blocked: account is ${user.status}`,
      });
      return res.status(403).json({ message: BLOCKED_LOGIN_MESSAGES[user.status] || "This account cannot sign in." });
    }

    await pool.query("UPDATE users SET last_login_at = NOW() WHERE id = ?", [user.id]);
    await logAuditSafely(pool, req, {
      actor,
      action: "auth.login",
      category: "auth",
      entityLabel: user.email,
      description: "Signed in",
    });

    setAuthCookie(res, user.id);
    res.json({
      message: "Login successful",
      user: { id: user.id, full_name: user.full_name, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ message: "Server error" });
  }
}

// LOGOUT — not behind `protect` so an expired session can still clear its cookie; logged when the token is valid
export async function logout(req, res) {
  const token = req.cookies?.token;
  if (token) {
    try {
      const { id } = jwt.verify(token, process.env.JWT_SECRET);
      const [rows] = await pool.query("SELECT id, full_name, role FROM users WHERE id = ?", [id]);
      if (rows[0]) {
        await logAuditSafely(pool, req, { actor: rows[0], action: "auth.logout", category: "auth", description: "Signed out" });
      }
    } catch {
      // expired or invalid token: nothing to attribute the sign-out to
    }
  }
  res.clearCookie("token");
  res.json({ message: "Logged out" });
}

// GET CURRENT USER
export async function getMe(req, res) {
  try {
    if (!req.user)
      return res.status(401).json({ message: "Not authenticated" });
    const [rows] = await pool.query(
      "SELECT id, full_name, email, contact_number, role, status FROM users WHERE id = ?",
      [req.user.id],
    );
    const user = rows[0];
    res.json(user);
  } catch (err) {
    console.error("GetMe error:", err);
    res.status(500).json({ message: "Server error" });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// PASSWORD: change (signed in, needs the current password) and forgot (emailed 6-digit code, same limits as
// registration). Both set users.password_changed_at, and `protect` rejects every session issued before it.
// ---------------------------------------------------------------------------------------------------------------
const RESET_SENT_MESSAGE = "If an active account uses this email, we sent a 6-digit code to it.";
const INVALID_RESET_MESSAGE = "This code is invalid or has expired. Please request a new one.";

async function findReset(db, userId) {
  const [rows] = await db.query(
    `SELECT *,
      expires_at < NOW() AS expired,
      TIMESTAMPDIFF(SECOND, last_sent_at, NOW()) AS seconds_since_sent,
      window_started_at < NOW() - INTERVAL 1 HOUR AS window_over
    FROM password_resets WHERE user_id = ?`,
    [userId]
  );
  return rows[0] || null;
}

// Stores the new password. The time comes from Node's clock (same as the JWT `iat`), so the session issued right
// after a change is never older than the change, even if the DB clock is off. Sessions from the same second survive.
async function savePassword(conn, userId, newPassword) {
  const hash = await bcrypt.hash(newPassword, 10);
  await conn.query("UPDATE users SET password = ?, password_changed_at = FROM_UNIXTIME(?) WHERE id = ?", [
    hash,
    Math.floor(Date.now() / 1000),
    userId,
  ]);
  await conn.query("DELETE FROM password_resets WHERE user_id = ?", [userId]);
}

const notifyPasswordChanged = (user, via) =>
  sendPasswordChangedEmail(user.email, user.full_name, { via }).catch((err) =>
    console.error("Password changed email failed:", err.message)
  );

// POST /api/auth/change-password: the signed-in user's own password. This browser gets a fresh session.
export async function changePassword(req, res) {
  const conn = await pool.getConnection();
  try {
    const currentPassword = String(req.body.currentPassword || "");
    const newPassword = String(req.body.newPassword || "");
    const [rows] = await conn.query("SELECT password FROM users WHERE id = ?", [req.user.id]);

    if (!(await bcrypt.compare(currentPassword, rows[0].password))) {
      await logAuditSafely(pool, req, {
        action: "auth.password_change_failed",
        category: "auth",
        entityLabel: req.user.email,
        description: "Failed password change (wrong current password)",
      });
      return res.status(400).json({ message: "Your current password is incorrect." });
    }
    const passwordError = validatePassword(newPassword);
    if (passwordError) return res.status(400).json({ message: passwordError });
    if (await bcrypt.compare(newPassword, rows[0].password)) {
      return res.status(400).json({ message: "Choose a password different from your current one." });
    }

    await conn.beginTransaction();
    await savePassword(conn, req.user.id, newPassword);
    await logAudit(conn, req, {
      action: "auth.password_change",
      category: "auth",
      entityLabel: req.user.email,
      description: "Changed password; other sessions signed out",
    });
    await conn.commit();

    setAuthCookie(res, req.user.id);
    notifyPasswordChanged(req.user, "change");
    res.json({ message: "Password changed. Any other devices signed in to this account have been signed out." });
  } catch (err) {
    await conn.rollback();
    console.error("changePassword error:", err);
    res.status(500).json({ message: "Server error" });
  } finally {
    conn.release();
  }
}

// POST /api/auth/forgot-password/start: emails a code to an active account. Also used to resend.
// The reply is the same whether or not the email belongs to an active account, so it can't be used to find accounts.
export async function startPasswordReset(req, res) {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    if (!EMAIL_PATTERN.test(email)) return res.status(400).json({ message: "Enter a valid email address." });
    const sent = { message: RESET_SENT_MESSAGE, expiresInMinutes: CODE_TTL_MINUTES, resendAfterSeconds: RESEND_COOLDOWN_SECONDS };

    const [users] = await pool.query("SELECT id, full_name, email, role, status FROM users WHERE LOWER(email) = ?", [email]);
    const user = users[0];
    if (!user || user.status !== "active") return res.status(202).json(sent);

    const existing = await findReset(pool, user.id);
    const limitError = sendLimitError(existing);
    if (limitError) return res.status(429).json({ message: limitError });

    const code = newCode();
    if (!(await emailCode(res, () => sendPasswordResetCode(user.email, user.full_name, code, CODE_TTL_MINUTES)))) return;

    const sameWindow = existing && !existing.window_over;
    await pool.query(
      `INSERT INTO password_resets (user_id, code_hash, expires_at, attempts, send_count, window_started_at, last_sent_at)
      VALUES (?, ?, NOW() + INTERVAL ? MINUTE, 0, ?, ${sameWindow ? "?" : "NOW()"}, NOW())
      ON DUPLICATE KEY UPDATE
        code_hash = VALUES(code_hash), expires_at = VALUES(expires_at), attempts = 0,
        send_count = VALUES(send_count), window_started_at = VALUES(window_started_at), last_sent_at = NOW()`,
      [
        user.id, hashCode(`reset:${user.id}`, code), CODE_TTL_MINUTES,
        sameWindow ? existing.send_count + 1 : 1,
        ...(sameWindow ? [existing.window_started_at] : []),
      ]
    );
    // Housekeeping: codes nobody used
    await pool.query("DELETE FROM password_resets WHERE expires_at < NOW() - INTERVAL 1 DAY");
    await logAuditSafely(pool, req, {
      actor: { id: user.id, full_name: user.full_name, role: user.role },
      action: "auth.password_reset_request",
      category: "auth",
      entityLabel: user.email,
      description: "Requested a password reset code",
    });

    res.status(202).json(sent);
  } catch (err) {
    console.error("startPasswordReset error:", err);
    res.status(500).json({ message: "Server error" });
  }
}

// POST /api/auth/forgot-password/reset: check the code and set the new password. Does not sign the user in.
export async function resetPassword(req, res) {
  const conn = await pool.getConnection();
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const code = String(req.body.code || "").trim();
    const newPassword = String(req.body.newPassword || "");
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ message: "Enter the 6-digit code from the email." });
    // Checked before the code, so a weak password doesn't use up a try
    const passwordError = validatePassword(newPassword);
    if (passwordError) return res.status(400).json({ message: passwordError });

    await conn.beginTransaction();
    const [users] = await conn.query("SELECT id, full_name, email, role, status FROM users WHERE LOWER(email) = ?", [email]);
    const user = users[0];
    const [lockRows] = user
      ? await conn.query("SELECT user_id FROM password_resets WHERE user_id = ? FOR UPDATE", [user.id])
      : [[]];
    const pending = lockRows.length > 0 ? await findReset(conn, user.id) : null;
    // Unknown email, no code requested, or an account that was deactivated since: all look the same
    if (!pending || user.status !== "active") {
      await conn.rollback();
      return res.status(400).json({ message: INVALID_RESET_MESSAGE });
    }
    if (pending.expired || pending.attempts >= MAX_CODE_ATTEMPTS) {
      await conn.rollback();
      return res.status(410).json({ message: "This code has expired. Please request a new one." });
    }

    const expected = Buffer.from(pending.code_hash, "hex");
    const given = Buffer.from(hashCode(`reset:${user.id}`, code), "hex");
    if (!crypto.timingSafeEqual(expected, given)) {
      await conn.query("UPDATE password_resets SET attempts = attempts + 1 WHERE user_id = ?", [user.id]);
      await conn.commit();
      const left = MAX_CODE_ATTEMPTS - pending.attempts - 1;
      return res.status(400).json({
        message: left > 0 ? `Incorrect code. ${left} ${left === 1 ? "try" : "tries"} left.` : "Incorrect code. Please request a new one.",
      });
    }

    await savePassword(conn, user.id, newPassword);
    await logAudit(conn, req, {
      actor: { id: user.id, full_name: user.full_name, role: user.role },
      action: "auth.password_reset",
      category: "auth",
      entityLabel: user.email,
      description: "Reset password with an emailed code; all sessions signed out",
    });
    await conn.commit();

    notifyPasswordChanged(user, "reset");
    res.json({ message: "Your password has been reset. Sign in with your new password." });
  } catch (err) {
    await conn.rollback();
    console.error("resetPassword error:", err);
    res.status(500).json({ message: "Server error" });
  } finally {
    conn.release();
  }
}
