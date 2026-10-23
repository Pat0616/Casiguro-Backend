// backend/scripts/migrate_email_verifications.js
// Email verification for self-registration: a request reaches the admin only after the applicant enters the code
// sent to their email. Rows hold the pending sign-up until then (one per email). Safe to re-run.
import pool from "../database/db.js";

const conn = await pool.getConnection();
try {
  const [[{ usersCollation }]] = await conn.query(
    "SELECT TABLE_COLLATION AS usersCollation FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'"
  );
  const charset = usersCollation.split("_")[0];

  await conn.query(`
    CREATE TABLE IF NOT EXISTS email_verifications (
      email VARCHAR(150) PRIMARY KEY,
      code_hash CHAR(64) NOT NULL,
      full_name VARCHAR(150) NOT NULL,
      contact_number VARCHAR(50) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      expires_at DATETIME NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      send_count INT NOT NULL DEFAULT 1,
      window_started_at DATETIME NOT NULL,
      last_sent_at DATETIME NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=${charset} COLLATE=${usersCollation}
  `);

  console.log("Email verification migration completed.");
} catch (error) {
  console.error("Email verification migration failed:", error);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
