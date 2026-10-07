import pool from "../database/db.js";

async function addColumnIfMissing(table, column, definition) {
  const [columns] = await pool.query(`DESCRIBE \`${table}\``);
  if (columns.some((entry) => entry.Field === column)) return;
  await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
  console.log(`Added ${table}.${column}`);
}

try {
  await addColumnIfMissing("products", "variants", "JSON NULL");
  await addColumnIfMissing("quotation_items", "variant_snapshot", "VARCHAR(150) NULL");
  await addColumnIfMissing("order_items", "variant_snapshot", "VARCHAR(150) NULL");
  console.log("Catalog options migration completed.");
} catch (error) {
  console.error("Catalog options migration failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
