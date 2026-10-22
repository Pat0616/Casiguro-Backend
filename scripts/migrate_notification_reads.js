// backend/scripts/migrate_notification_reads.js
// Moves notification read state from the shared notifications.read_at column to per-user
// notification_reads rows. The old column doesn't record who read a notification, so anything
// already marked read is kept read for every existing user. Safe to re-run.
import pool from "../database/db.js";

const conn = await pool.getConnection();
try {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS notification_reads (
      notification_id CHAR(36) NOT NULL,
      user_id CHAR(36) NOT NULL,
      read_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (notification_id, user_id),
      CONSTRAINT fk_notification_reads_notification
        FOREIGN KEY (notification_id) REFERENCES notifications(id) ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_notification_reads_user
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE ON UPDATE CASCADE,
      INDEX idx_notification_reads_user_id (user_id)
    ) ENGINE=InnoDB
  `);

  const [columns] = await conn.query("SHOW COLUMNS FROM notifications LIKE 'read_at'");
  if (columns.length > 0) {
    const [result] = await conn.query(`
      INSERT IGNORE INTO notification_reads (notification_id, user_id, read_at)
      SELECT n.id, u.id, n.read_at
      FROM notifications n
      CROSS JOIN users u
      WHERE n.read_at IS NOT NULL
    `);
    console.log(`Copied existing read state into ${result.affectedRows} per-user rows.`);

    await conn.query("ALTER TABLE notifications DROP COLUMN read_at");
    console.log("Dropped notifications.read_at.");
  }

  console.log("Notification reads migration completed.");
} catch (error) {
  console.error("Notification reads migration failed:", error);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
