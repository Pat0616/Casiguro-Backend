// backend/controllers/customerController.js
import pool from "../database/db.js";

// GET /api/customers
export async function getCustomers(req, res) {
  try {
    const [rows] = await pool.query(`
      SELECT
        id,
        full_name AS name,
        COALESCE(contact_number, '') AS contactNumber
      FROM customers
      ORDER BY full_name ASC
    `);

    res.json(rows);
  } catch (err) {
    console.error("getCustomers error:", err);
    res.status(500).json({ message: "Failed to fetch customers" });
  }
}
