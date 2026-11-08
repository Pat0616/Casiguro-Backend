// backend/scripts/migrate_password_reset.js
// Change password + forgot password. Adds users.password_changed_at (sessions issued before it are rejected) and the
// password_resets table that holds a forgot-password code (one per user). Safe to re-run.
import pool from "../database/db.js";

const conn = await pool.getConnection();
try {
  const [columns] = await conn.query("DESCRIBE `users`");
  if (columns.some((entry) => entry.Field === "password_changed_at")) {
    console.log("users.password_changed_at already exists.");
  } else {
    await conn.query("ALTER TABLE `users` ADD COLUMN `password_changed_at` TIMESTAMP NULL AFTER last_login_at");
    console.log("Added users.password_changed_at");
  }

  // Same collation as users, or the foreign key (and joins) fail with "Illegal mix of collations"
  const [[{ usersCollation }]] = await conn.query(
    "SELECT TABLE_COLLATION AS usersCollation FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'"
  );
  const charset = usersCollation.split("_")[0];

  await conn.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      user_id CHAR(36) PRIMARY KEY,
      code_hash CHAR(64) NOT NULL,
      expires_at DATETIME NOT NULL,
      attempts INT NOT NULL DEFAULT 0,
      send_count INT NOT NULL DEFAULT 1,
      window_started_at DATETIME NOT NULL,
      last_sent_at DATETIME NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT fk_password_resets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=${charset} COLLATE=${usersCollation}
  `);

  console.log("Password reset migration completed.");
} catch (error) {
  console.error("Password reset migration failed:", error);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
