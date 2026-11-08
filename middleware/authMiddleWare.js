// backend/middleware/authMiddleWare.js
import jwt from "jsonwebtoken";
import pool from "../database/db.js";

export async function protect(req, res, next) {
  const token = req.cookies?.token;
  if (!token) {
    return res.status(401).json({ message: "Not authorized: No token provided" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || "default_jwt_secret_casiguro_2026");
    const [rows] = await pool.query(
      "SELECT id, full_name, email, role, status, UNIX_TIMESTAMP(password_changed_at) AS pw_changed FROM users WHERE id = ?",
      [decoded.id]
    );

    if (rows.length === 0) {
      return res.status(401).json({ message: "User account no longer exists" });
    }

    // Checked on every request, so deactivating an account signs it out immediately
    if (rows[0].status !== "active") {
      res.clearCookie("token");
      return res.status(401).json({ message: "This account is no longer active. Please contact an administrator." });
    }

    // A password change or reset signs out every session that started before it
    const { pw_changed, ...user } = rows[0];
    if (pw_changed && decoded.iat < Number(pw_changed)) {
      res.clearCookie("token");
      return res.status(401).json({ message: "Your password was changed. Please sign in again." });
    }

    req.user = user;
    next();
  } catch (err) {
    console.error("Auth middleware error:", err.message);
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}

export function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") {
    return res.status(403).json({ message: "Access forbidden: Requires Administrator privileges" });
  }
  next();
}