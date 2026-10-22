// controllers/authController.js
import bcrypt from "bcryptjs";
import crypto from "crypto";
import jwt from "jsonwebtoken";
import pool from "../database/db.js"; // import your pool directly
import { generateToken } from "../utils/generateToken.js";
import { logAudit, logAuditSafely } from "../utils/auditLog.js";
import { emitAccountChanged } from "../websocket/socket.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTACT_PATTERN = /^\+?[\d\s()-]{7,20}$/;

const BLOCKED_LOGIN_MESSAGES = {
  pending: "Your account is awaiting admin approval. You can sign in once an administrator approves it.",
  rejected: "Your registration was not approved. Please contact an administrator.",
  deactivated: "This account has been deactivated. Please contact an administrator.",
};

// REGISTER — public sign-up. Always creates a pending employee; an admin must approve it before it can sign in.
export async function register(req, res) {
  const conn = await pool.getConnection();
  try {
    const full_name = String(req.body.full_name || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const contact_number = String(req.body.contact_number || "").trim();
    const password = String(req.body.password || "");

    if (full_name.length < 2 || full_name.length > 150) {
      return res.status(400).json({ message: "Enter your full name." });
    }
    if (!EMAIL_PATTERN.test(email) || email.length > 150) {
      return res.status(400).json({ message: "Enter a valid email address." });
    }
    if (!CONTACT_PATTERN.test(contact_number)) {
      return res.status(400).json({ message: "Enter a valid contact number." });
    }
    if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
      return res.status(400).json({ message: "Password must be at least 8 characters and include a letter and a number." });
    }

    await conn.beginTransaction();
    const [existingRows] = await conn.query("SELECT id FROM users WHERE LOWER(email) = ?", [email]);
    if (existingRows.length > 0) {
      await conn.rollback();
      return res.status(409).json({ message: "An account with this email already exists." });
    }

    const id = crypto.randomUUID();
    const hashedPassword = await bcrypt.hash(password, 10);
    // role and status are fixed server-side; anything the client sends for them is ignored
    await conn.query(
      "INSERT INTO users (id, full_name, email, contact_number, password, role, status) VALUES (?, ?, ?, ?, ?, 'employee', 'pending')",
      [id, full_name, email, contact_number, hashedPassword]
    );
    await logAudit(conn, req, {
      actor: { id, full_name, role: "employee" },
      action: "account.register",
      category: "account",
      entityType: "user",
      entityId: id,
      entityLabel: email,
      description: `Registered an account (${email}); awaiting admin approval`,
    });
    await conn.commit();

    emitAccountChanged({ userId: id, status: "pending" });
    res.status(201).json({
      message: "Registration submitted. An administrator needs to approve your account before you can sign in.",
      user: { id, full_name, email, role: "employee", status: "pending" },
    });
  } catch (err) {
    await conn.rollback();
    console.error("Register error:", err);
    res.status(500).json({ message: "Server error" });
  } finally {
    conn.release();
  }
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

    const token = generateToken({ id: user.id });
    // Send cookie
    res.cookie("token", token, {
      httpOnly: true,
      secure: false, // set true in production with HTTPS
      sameSite: "strict",
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });
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
