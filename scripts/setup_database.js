// backend/scripts/setup_database.js
// Fresh install: creates the database named DB_NAME in .env and applies schema.sql. Safe to re-run: every table is
// CREATE TABLE IF NOT EXISTS, so existing tables and their data are left as they are. No demo data is inserted.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

const dbName = process.env.DB_NAME;
if (!dbName || !/^\w+$/.test(dbName)) {
  console.error("Set DB_NAME in .env (letters, digits and underscores only) before running db:setup.");
  process.exit(1);
}

const schemaPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "schema.sql");
// schema.sql names its own database for manual imports; the one from .env is used instead
const schema = fs
  .readFileSync(schemaPath, "utf8")
  .replace(/^CREATE DATABASE[\s\S]*?;/m, "")
  .replace(/^USE\s+\w+\s*;/m, "");

// The pool in database/db.js needs the database to exist, so connect to the server first
const conn = await mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  multipleStatements: true,
});

const listTables = async () => {
  const [rows] = await conn.query("SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?", [dbName]);
  return new Set(rows.map((row) => row.name));
};

try {
  await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.query(`USE \`${dbName}\``);

  const before = await listTables();
  await conn.query(schema);
  const after = await listTables();

  const created = [...after].filter((name) => !before.has(name)).sort();
  const existing = [...before].sort();
  console.log(`Database "${dbName}" is set up.`);
  console.log(`Created (${created.length}): ${created.join(", ") || "none"}`);
  console.log(`Already existed (${existing.length}): ${existing.join(", ") || "none"}`);
  if (existing.length > 0) {
    console.log("Existing tables are not altered. For an older database run the npm run migrate:* scripts.");
  }
  console.log("Next: npm run create-admin to make the first admin account.");
} catch (error) {
  console.error("Database setup failed:", error.message);
  process.exitCode = 1;
} finally {
  await conn.end();
}
