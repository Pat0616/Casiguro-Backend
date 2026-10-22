// backend/scripts/migrate_accounts_audit.js
// Account approval workflow + per-account audit logs. Safe to re-run.
// - users: contact number, status (pending/active/rejected/deactivated), review/status metadata, last login.
//   Accounts that already exist are marked active; new registrations default to pending.
// - audit_logs: append-only (UPDATE/DELETE are blocked by triggers).
import pool from "../database/db.js";

async function getColumns(conn, table) {
  const [columns] = await conn.query(`DESCRIBE \`${table}\``);
  return new Set(columns.map((entry) => entry.Field));
}

const conn = await pool.getConnection();
try {
  const userColumns = await getColumns(conn, "users");
  const addUserColumn = async (column, definition) => {
    if (userColumns.has(column)) return;
    await conn.query(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
    console.log(`Added users.${column}`);
  };

  await addUserColumn("contact_number", "VARCHAR(50) NULL AFTER email");
  if (!userColumns.has("status")) {
    // Existing accounts were already in use, so they start active; the default then switches to pending
    await conn.query("ALTER TABLE users ADD COLUMN status VARCHAR(20) NOT NULL DEFAULT 'active' AFTER role");
    await conn.query("ALTER TABLE users ALTER COLUMN status SET DEFAULT 'pending'");
    await conn.query(
      "ALTER TABLE users ADD CONSTRAINT chk_users_status CHECK (status IN ('pending', 'active', 'rejected', 'deactivated'))"
    );
    console.log("Added users.status (existing accounts set to active)");
  }
  await addUserColumn("approved_by", "CHAR(36) NULL AFTER status");
  await addUserColumn("approved_at", "TIMESTAMP NULL AFTER approved_by");
  await addUserColumn("status_changed_by", "CHAR(36) NULL AFTER approved_at");
  await addUserColumn("status_changed_at", "TIMESTAMP NULL AFTER status_changed_by");
  await addUserColumn("status_reason", "TEXT NULL AFTER status_changed_at");
  await addUserColumn("last_login_at", "TIMESTAMP NULL AFTER status_reason");

  // audit_logs.user_id is compared with users.id, so both must share a collation regardless of the server default
  const [[{ usersCollation }]] = await conn.query(
    "SELECT TABLE_COLLATION AS usersCollation FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'"
  );
  const charset = usersCollation.split("_")[0];

  await conn.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      user_id CHAR(36) NULL,
      user_name VARCHAR(150) NULL,
      user_role VARCHAR(20) NULL,
      action VARCHAR(60) NOT NULL,
      category VARCHAR(30) NOT NULL,
      entity_type VARCHAR(40) NULL,
      entity_id VARCHAR(64) NULL,
      entity_label VARCHAR(150) NULL,
      description TEXT NOT NULL,
      changes JSON NULL,
      ip_address VARCHAR(64) NULL,
      user_agent VARCHAR(255) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_audit_logs_user_time (user_id, created_at),
      INDEX idx_audit_logs_category (category)
    ) ENGINE=InnoDB DEFAULT CHARSET=${charset} COLLATE=${usersCollation}
  `);

  const [[{ auditCollation }]] = await conn.query(
    "SELECT TABLE_COLLATION AS auditCollation FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_logs'"
  );
  if (auditCollation !== usersCollation) {
    await conn.query(`ALTER TABLE audit_logs CONVERT TO CHARACTER SET ${charset} COLLATE ${usersCollation}`);
    console.log(`Converted audit_logs from ${auditCollation} to ${usersCollation} to match users`);
  }

  const [triggers] = await conn.query("SHOW TRIGGERS WHERE `Table` = 'audit_logs'");
  const existing = new Set(triggers.map((t) => t.Trigger));
  if (!existing.has("trg_audit_logs_no_update")) {
    await conn.query(
      "CREATE TRIGGER trg_audit_logs_no_update BEFORE UPDATE ON audit_logs FOR EACH ROW " +
        "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only'"
    );
  }
  if (!existing.has("trg_audit_logs_no_delete")) {
    await conn.query(
      "CREATE TRIGGER trg_audit_logs_no_delete BEFORE DELETE ON audit_logs FOR EACH ROW " +
        "SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit_logs is append-only'"
    );
  }

  console.log("Accounts & audit log migration completed.");
} catch (error) {
  console.error("Accounts & audit log migration failed:", error);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
