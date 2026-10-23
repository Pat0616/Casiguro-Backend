// backend/scripts/migrate_payments.js
// Payment log + order cancellation. Safe to re-run.
// - payments: one row per down payment / payment / EWT entry. Rows are never deleted; mistakes are voided.
//   orders.amount_paid, balance and payment_status are derived from the non-voided rows (utils/payments.js).
// - orders: status 'cancelled' + who/when/why.
// - Repairs: total_price = sum of the order's item subtotals (updateOrder used to overwrite it with
//   quantity × first item's price). Orders that already had money recorded get one backfilled payment
//   ("Recorded before payment logging"); orders marked paid are backfilled for their full total (decided with the client).
import pool from "../database/db.js";

const BACKFILL_NOTE = "Recorded before payment logging";

async function getColumns(conn, table) {
  const [columns] = await conn.query(`DESCRIBE \`${table}\``);
  return new Set(columns.map((entry) => entry.Field));
}

const conn = await pool.getConnection();
try {
  // payments.order_id / created_by / voided_by reference orders.id and users.id, so the collations must match
  const [[{ ordersCollation }]] = await conn.query(
    "SELECT TABLE_COLLATION AS ordersCollation FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'"
  );
  const charset = ordersCollation.split("_")[0];

  // An older payments definition (payment_method / received_at) may exist in dev databases; replace it only if empty
  const [paymentTables] = await conn.query("SHOW TABLES LIKE 'payments'");
  if (paymentTables.length > 0 && !(await getColumns(conn, "payments")).has("payment_type")) {
    const [[{ count }]] = await conn.query("SELECT COUNT(*) AS count FROM payments");
    if (count > 0) throw new Error("payments uses the old layout and has rows; migrate them by hand first");
    await conn.query("DROP TABLE payments");
    console.log("Dropped the empty old-layout payments table");
  }

  await conn.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id CHAR(36) PRIMARY KEY,
      order_id CHAR(36) NOT NULL,
      payment_type VARCHAR(20) NOT NULL DEFAULT 'payment',
      method VARCHAR(20) NULL,
      amount DECIMAL(12,2) NOT NULL,
      received_on DATE NOT NULL,
      reference_no VARCHAR(100) NULL,
      check_bank VARCHAR(100) NULL,
      check_date DATE NULL,
      or_no VARCHAR(50) NULL,
      note TEXT NULL,
      voided_at TIMESTAMP NULL,
      voided_by CHAR(36) NULL,
      void_reason TEXT NULL,
      created_by CHAR(36) NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT chk_payments_type CHECK (payment_type IN ('down_payment', 'payment', 'ewt')),
      CONSTRAINT chk_payments_method CHECK (method IS NULL OR method IN ('cash', 'gcash', 'check', 'bank_transfer')),
      CONSTRAINT chk_payments_amount CHECK (amount > 0),
      CONSTRAINT fk_payments_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT fk_payments_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
      CONSTRAINT fk_payments_voided_by FOREIGN KEY (voided_by) REFERENCES users(id) ON DELETE SET NULL ON UPDATE CASCADE,
      INDEX idx_payments_order_id (order_id),
      INDEX idx_payments_received_on (received_on)
    ) ENGINE=InnoDB DEFAULT CHARSET=${charset} COLLATE=${ordersCollation}
  `);

  // Order cancellation
  const orderColumns = await getColumns(conn, "orders");
  const addOrderColumn = async (column, definition) => {
    if (orderColumns.has(column)) return;
    await conn.query(`ALTER TABLE orders ADD COLUMN ${column} ${definition}`);
    console.log(`Added orders.${column}`);
  };
  await addOrderColumn("cancelled_at", "TIMESTAMP NULL AFTER date_completed");
  await addOrderColumn("cancelled_by", "CHAR(36) NULL AFTER cancelled_at");
  await addOrderColumn("cancel_reason", "TEXT NULL AFTER cancelled_by");

  const [checks] = await conn.query(
    `SELECT CHECK_CLAUSE AS clause FROM information_schema.CHECK_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'chk_orders_status'`
  );
  if (!checks.some((c) => c.clause.includes("cancelled"))) {
    if (checks.length > 0) await conn.query("ALTER TABLE orders DROP CONSTRAINT chk_orders_status");
    await conn.query(
      "ALTER TABLE orders ADD CONSTRAINT chk_orders_status CHECK (status IN ('pending', 'in_production', 'ready', 'completed', 'cancelled'))"
    );
    console.log("orders.status now allows 'cancelled'");
  }

  // Schema changes above auto-commit; the data repair below is all-or-nothing
  await conn.beginTransaction();

  // Repair totals from the items
  const [totalFix] = await conn.query(`
    UPDATE orders o
    JOIN (SELECT order_id, SUM(subtotal) AS items_total FROM order_items GROUP BY order_id) i ON i.order_id = o.id
    SET o.total_price = i.items_total
    WHERE o.total_price <> i.items_total
  `);
  console.log(`Corrected total_price on ${totalFix.affectedRows} order(s)`);

  // Backfill a payment for orders that had money recorded before the log existed
  const [toBackfill] = await conn.query(`
    SELECT o.id, o.soa_no, o.total_price, o.amount_paid, o.payment_status,
      COALESCE(o.date_completed, o.date_ordered) AS received_on, o.updated_by, o.created_by
    FROM orders o
    WHERE NOT EXISTS (SELECT 1 FROM payments p WHERE p.order_id = o.id)
      AND (o.amount_paid > 0 OR o.payment_status = 'paid')
      AND o.total_price > 0
  `);
  for (const order of toBackfill) {
    const total = Number(order.total_price);
    const amount = order.payment_status === "paid" ? total : Math.min(Number(order.amount_paid), total);
    if (amount <= 0) continue;
    await conn.query(
      `INSERT INTO payments (id, order_id, payment_type, method, amount, received_on, note, created_by)
       VALUES (UUID(), ?, 'payment', NULL, ?, ?, ?, ?)`,
      [order.id, amount, order.received_on, BACKFILL_NOTE, order.updated_by || order.created_by]
    );
    console.log(`Backfilled ${amount.toFixed(2)} on SOA ${order.soa_no} (was ${Number(order.amount_paid).toFixed(2)} paid, ${order.payment_status})`);
  }

  // amount_paid / balance / payment_status now follow the log
  const [recalc] = await conn.query(`
    UPDATE orders o
    LEFT JOIN (
      SELECT order_id, SUM(amount) AS paid FROM payments WHERE voided_at IS NULL GROUP BY order_id
    ) p ON p.order_id = o.id
    SET
      o.amount_paid = LEAST(COALESCE(p.paid, 0), o.total_price),
      o.balance = GREATEST(o.total_price - COALESCE(p.paid, 0), 0),
      o.payment_status = CASE
        WHEN COALESCE(p.paid, 0) <= 0 THEN 'unpaid'
        WHEN COALESCE(p.paid, 0) < o.total_price THEN 'partial'
        ELSE 'paid'
      END
  `);
  console.log(`Recomputed payment fields (${recalc.changedRows} order(s) changed)`);

  await conn.commit();
  console.log("Payments migration completed.");
} catch (error) {
  await conn.rollback().catch(() => undefined);
  console.error("Payments migration failed:", error);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
