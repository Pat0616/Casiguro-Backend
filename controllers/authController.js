// controllers/authController.js
import bcrypt from "bcryptjs";
import pool from "../database/db.js"; // import your pool directly
import { generateToken } from "../utils/generateToken.js";

// REGISTER
export async function register(req, res) {
  try {
    const { full_name, email, password, role  } = req.body;
    // Check if username exists
    const [existingRows] = await pool.query(
      "SELECT * FROM users WHERE full_name = ?",
      [full_name],
    );
    if (existingRows.length > 0) {
      return res.status(400).json({ message: "Full name already taken" });
    }
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);
    // Insert user
    const [result] = await pool.query(
      "INSERT INTO users (full_name, email, password, role) VALUES (?, ?, ?, ?)",
      [full_name, email, hashedPassword, role],
    );
    res.status(201).json({
      message: "Registered successfully",
      user: { id: result.insertId, full_name, email, role },
    });
  } catch (err) {
    console.error("Register error:", err);
    res.status(500).json({ message: "Server error" });
  }
}

// LOGIN
export async function login(req, res) {
  try {
    const { email, password } = req.body;
    const [rows] = await pool.query(
      "SELECT * FROM users WHERE email = ?",
      [email],
    );
    const user = rows[0];
    if (!user) return res.status(400).json({ message: "Invalid credentials" });
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch)
      return res.status(400).json({ message: "Invalid credentials" });
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

// LOGOUT
export function logout(req, res) {
  res.clearCookie("token");
  res.json({ message: "Logged out" });
}

// GET CURRENT USER
export async function getMe(req, res) {
  try {
    if (!req.user)
      return res.status(401).json({ message: "Not authenticated" });
    const [rows] = await pool.query(
      "SELECT id, full_name, email, role FROM users WHERE id = ?",
      [req.user.id],
    );
    const user = rows[0];
    res.json(user);
  } catch (err) {
    console.error("GetMe error:", err);
    res.status(500).json({ message: "Server error" });
  }
}