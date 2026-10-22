// backend/scripts/migrate_soa_numbers.js
// Replaces orders.ref_no (TXN-YYYY-XXXX) with SOA numbers (YYYY-MM-N) and adds the optional
// reference document columns. Existing orders are numbered by creation date. Safe to re-run.
import pool from "../database/db.js";

async function getColumns(conn, table) {
  const [columns] = await conn.query(`DESCRIBE \`${table}\``);
  return new Map(columns.map((entry) => [entry.Field, entry]));
}

async function addColumnIfMissing(conn, table, column, definition) {
  const columns = await getColumns(conn, table);
  if (columns.has(column)) return;
  await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  console.log(`Added ${table}.${column}`);
}

const conn = await pool.getConnection();
try {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS soa_counters (
      period CHAR(7) PRIMARY KEY,
      last_seq INT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB
  `);

  await addColumnIfMissing(conn, "orders", "soa_no", "VARCHAR(20) NULL AFTER id");
  await addColumnIfMissing(conn, "orders", "soa_date", "DATE NULL AFTER soa_no");
  await addColumnIfMissing(conn, "orders", "pr_no", "VARCHAR(50) NULL AFTER soa_date");
  await addColumnIfMissing(conn, "orders", "po_no", "VARCHAR(50) NULL AFTER pr_no");
  await addColumnIfMissing(conn, "orders", "si_or_no", "VARCHAR(50) NULL AFTER po_no");
  await addColumnIfMissing(conn, "orders", "si_or_date", "DATE NULL AFTER si_or_no");
  await addColumnIfMissing(conn, "orders", "dr_no", "VARCHAR(50) NULL AFTER si_or_date");
  await addColumnIfMissing(conn, "orders", "dr_date", "DATE NULL AFTER dr_no");

  // Number every order that doesn't have an SOA yet, oldest first, continuing each month's counter
  await conn.beginTransaction();
  const [counterRows] = await conn.query("SELECT period, last_seq FROM soa_counters FOR UPDATE");
  const counters = new Map(counterRows.map((row) => [row.period, Number(row.last_seq)]));

  const [orders] = await conn.query(`
    SELECT id, DATE_FORMAT(created_at, '%Y-%m-%d') AS createdDate
    FROM orders
    WHERE soa_no IS NULL
    ORDER BY created_at ASC, date_ordered ASC, id ASC
    FOR UPDATE
  `);

  for (const order of orders) {
    const period = order.createdDate.slice(0, 7);
    const seq = (counters.get(period) || 0) + 1;
    counters.set(period, seq);
    const soaNo = `${period}-${seq}`;

    await conn.query("UPDATE orders SET soa_no = ?, soa_date = ? WHERE id = ?", [soaNo, order.createdDate, order.id]);
    await conn.query("UPDATE notifications SET order_ref = ? WHERE order_id = ?", [soaNo, order.id]);
  }

  for (const [period, lastSeq] of counters) {
    await conn.query(
      "INSERT INTO soa_counters (period, last_seq) VALUES (?, ?) ON DUPLICATE KEY UPDATE last_seq = VALUES(last_seq)",
      [period, lastSeq]
    );
  }
  await conn.commit();
  console.log(`Assigned SOA numbers to ${orders.length} orders.`);

  // Every order is numbered now: enforce the constraints and retire the old reference number
  const columns = await getColumns(conn, "orders");
  if (columns.get("soa_no").Null === "YES") {
    await conn.query("ALTER TABLE orders MODIFY soa_no VARCHAR(20) NOT NULL, MODIFY soa_date DATE NOT NULL");
    console.log("Made orders.soa_no and orders.soa_date required.");
  }

  const [soaIndexes] = await conn.query("SHOW INDEX FROM orders WHERE Column_name = 'soa_no' AND Non_unique = 0");
  if (soaIndexes.length === 0) {
    await conn.query("ALTER TABLE orders ADD UNIQUE INDEX soa_no (soa_no), ADD INDEX idx_orders_soa_date (soa_date)");
    console.log("Added unique index on orders.soa_no.");
  }

  if (columns.has("ref_no")) {
    await conn.query("ALTER TABLE orders DROP COLUMN ref_no");
    console.log("Dropped orders.ref_no.");
  }

  console.log("SOA number migration completed.");
} catch (error) {
  await conn.rollback();
  console.error("SOA number migration failed:", error);
  process.exitCode = 1;
} finally {
  conn.release();
  await pool.end();
}
