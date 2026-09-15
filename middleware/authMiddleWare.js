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
      "SELECT id, full_name, email, role FROM users WHERE id = ?",
      [decoded.id]
    );

    if (rows.length === 0) {
      return res.status(401).json({ message: "User account no longer exists" });
    }

    req.user = rows[0];
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