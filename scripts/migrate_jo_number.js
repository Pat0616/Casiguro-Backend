// backend/scripts/migrate_jo_number.js
// Adds orders.jo_no, the Job Order No typed in by staff (shown in the sales Excel's J.O. NO. column). Safe to re-run.
import pool from "../database/db.js";

const conn = await pool.getConnection();
try {
  const [columns] = await conn.query("DESCRIBE `orders`");
  if (columns.some((entry) => entry.Field === "jo_no")) {
    console.log("orders.jo_no already exists, nothing to do.");
  } else {
    await conn.query("ALTER TABLE `orders` ADD COLUMN `jo_no` VARCHAR(50) NULL AFTER po_no");
    console.log("Added orders.jo_no");
  }
  console.log("J.O. number migration completed.");
} catch (error) {
  console.error("J.O. number migration failed:", error);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
