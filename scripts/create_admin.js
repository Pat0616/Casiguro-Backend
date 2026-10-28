// backend/scripts/create_admin.js
// Creates an active admin account from the command line. A fresh install needs this: self-registration only creates
// pending employees, and only an admin can approve them. Also usable to recover a system with no working admin.
//   npm run create-admin
//   npm run create-admin -- --name "Juan Dela Cruz" --email juan@example.com --contact 09171234567
// The password is always asked for (hidden), so it never ends up in shell history.
import crypto from "crypto";
import readline from "readline";
import { stdin, stdout } from "process";
import { Writable } from "stream";
import bcrypt from "bcryptjs";
import pool from "../database/db.js";
import { logAudit } from "../utils/auditLog.js";
import { parseRegistration } from "../utils/accountFields.js";

function readFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const match = argv[i].match(/^--(name|email|contact)$/);
    if (match && argv[i + 1] !== undefined) flags[match[1]] = argv[++i];
  }
  return flags;
}

// readline echoes through this stream, which goes quiet while a password is typed
let muted = false;
const output = new Writable({
  write(chunk, encoding, callback) {
    if (!muted) stdout.write(chunk, encoding);
    callback();
  },
});
const rl = readline.createInterface({ input: stdin, output, terminal: Boolean(stdin.isTTY) });
// The line iterator buffers, so answers piped in all at once aren't lost
const lines = rl[Symbol.asyncIterator]();

async function ask(question, { hidden = false } = {}) {
  stdout.write(question);
  muted = hidden;
  try {
    const { value, done } = await lines.next();
    if (done) throw new Error("Input ended before every question was answered.");
    return value;
  } finally {
    if (hidden) {
      muted = false;
      stdout.write("\n");
    }
  }
}

const flags = readFlags(process.argv.slice(2));
let conn;
try {
  const full_name = flags.name ?? (await ask("Full name: "));
  const email = flags.email ?? (await ask("Email: "));
  const contact_number = flags.contact ?? (await ask("Contact number: "));
  const password = await ask("Password (8+ characters, a letter and a number): ", { hidden: true });
  const confirm = await ask("Confirm password: ", { hidden: true });

  if (password !== confirm) throw new Error("The passwords don't match.");
  const { fields, error } = parseRegistration({ full_name, email, contact_number, password });
  if (error) throw new Error(error);

  conn = await pool.getConnection();
  const [existing] = await conn.query("SELECT role, status FROM users WHERE LOWER(email) = ?", [fields.email]);
  if (existing.length > 0) {
    throw new Error(
      `${fields.email} already has an account (${existing[0].role}, ${existing[0].status}). ` +
        "To make an existing account an admin, use Promote on the Accounts page."
    );
  }

  const [[{ admins }]] = await conn.query("SELECT COUNT(*) AS admins FROM users WHERE role = 'admin' AND status = 'active'");
  if (admins > 0) {
    const answer = await ask(`${admins} active admin account(s) already exist. Create another admin? (y/N) `);
    if (!/^y(es)?$/i.test(answer.trim())) throw new Error("Cancelled, no account created.");
  }

  const id = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(fields.password, 10);
  await conn.beginTransaction();
  await conn.query(
    `INSERT INTO users (id, full_name, email, contact_number, password, role, status, approved_at, status_changed_at)
     VALUES (?, ?, ?, ?, ?, 'admin', 'active', NOW(), NOW())`,
    [id, fields.full_name, fields.email, fields.contact_number, passwordHash]
  );
  await logAudit(conn, null, {
    actor: { id, full_name: fields.full_name, role: "admin" },
    action: "account.create_admin",
    category: "account",
    entityType: "user",
    entityId: id,
    entityLabel: fields.email,
    description: "Admin account created from the command line (create-admin script)",
  });
  await conn.commit();

  console.log(`Admin ${fields.email} created. Sign in at the app's login page.`);
} catch (error) {
  if (conn) await conn.rollback().catch(() => {});
  console.error(`Could not create the admin: ${error.message}`);
  process.exitCode = 1;
} finally {
  rl.close();
  conn?.release();
  await pool.end();
}
