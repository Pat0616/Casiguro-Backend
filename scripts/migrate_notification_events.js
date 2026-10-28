// backend/scripts/migrate_notification_events.js
// Adds notifications.event (the exact action, e.g. payment.void, so each kind gets its own icon) and fills it in for
// older notifications by matching the message text they were created with. Rows no rule matches stay NULL and keep
// the icon of their broad type. Safe to re-run: only rows with no event are touched.
import pool from "../database/db.js";

// First matching rule wins; patterns mirror the messages written by the order/quotation/payment controllers
// (plus a few wordings from before the payment log existed)
const RULES = [
  ["payment.void", "message LIKE 'Voided %'"],
  ["payment.down_payment", "message LIKE 'Down payment %' AND message LIKE '% recorded for %'"],
  ["payment.ewt", "message LIKE 'EWT %' AND message LIKE '% recorded for %'"],
  ["payment.record", "(message LIKE 'Payment %' AND message LIKE '% recorded for %') OR message LIKE 'Amount Paid changed%'"],
  ["order.documents_update", "message LIKE 'Reference documents updated%'"],
  ["order.create_from_quotation", "message LIKE 'Quotation % accepted and converted%'"],
  ["order.create", "message LIKE 'New % Order created%'"],
  ["order.cancel", "message LIKE '% was cancelled:%'"],
  ["order.completed", "message LIKE '%production status changed from % to Completed (%'"],
  ["order.ready", "message LIKE '%production status changed from % to Ready for Pickup (%'"],
  ["order.in_production", "message LIKE '%production status changed from % to In Production (%' OR message LIKE 'Quantity Completed changed%'"],
  ["order.pending", "message LIKE '%production status changed from % to Pending (%'"],
  ["order.update", "message LIKE 'Unit Price changed%'"],
];

const conn = await pool.getConnection();
try {
  const [columns] = await conn.query("SHOW COLUMNS FROM notifications LIKE 'event'");
  if (columns.length === 0) {
    await conn.query("ALTER TABLE notifications ADD COLUMN event VARCHAR(60) NULL AFTER notification_type");
    console.log("Added notifications.event");
  }

  await conn.beginTransaction();
  for (const [event, condition] of RULES) {
    const [result] = await conn.query(`UPDATE notifications SET event = ? WHERE event IS NULL AND (${condition})`, [event]);
    if (result.affectedRows > 0) console.log(`${event}: ${result.affectedRows}`);
  }
  await conn.commit();

  const [[{ unmatched }]] = await conn.query("SELECT COUNT(*) AS unmatched FROM notifications WHERE event IS NULL");
  console.log(`Notification event migration completed. ${unmatched} notification(s) left without an event (they keep their type icon).`);
} catch (error) {
  await conn.rollback().catch(() => {});
  console.error("Notification event migration failed:", error);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
