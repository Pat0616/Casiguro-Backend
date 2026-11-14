// backend/database/config.js
// Connection settings shared by the app pool (db.js) and scripts that connect before the database exists.
// Local XAMPP needs only DB_HOST/USER/PASSWORD/NAME. A hosted MySQL (e.g. Aiven) also needs DB_PORT and SSL:
//   DB_SSL_CA  path to the provider's CA certificate (ca.pem), or the PEM text itself. Verifies the server.
//   DB_SSL=true  encrypts without a CA (server not verified; use only if you can't supply the CA).
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const backendDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

const readCa = (value) => {
  if (value.includes("-----BEGIN CERTIFICATE-----")) return value.replace(/\\n/g, "\n");
  const caPath = path.isAbsolute(value) ? value : path.join(backendDir, value);
  if (!fs.existsSync(caPath)) {
    throw new Error(`DB_SSL_CA file not found: ${caPath}`);
  }
  return fs.readFileSync(caPath, "utf8");
};

const sslOptions = () => {
  const ca = process.env.DB_SSL_CA?.trim();
  if (ca) return { ca: readCa(ca), rejectUnauthorized: true };
  if (/^(1|true|yes)$/i.test(process.env.DB_SSL?.trim() ?? "")) {
    console.warn("DB_SSL is on without DB_SSL_CA: the connection is encrypted but the server certificate is not verified.");
    return { rejectUnauthorized: false };
  }
  return undefined;
};

// Every session runs in Manila time: CURDATE()/NOW() decide SOA numbers and dates, and hosted servers default to UTC.
// DB_TIMEZONE overrides it (an offset like +08:00, or a zone name if the server has time zone tables loaded).
export const sessionTimeZone = process.env.DB_TIMEZONE?.trim() || "+08:00";

export const connectionOptions = () => {
  const port = process.env.DB_PORT?.trim();
  if (port && !/^\d+$/.test(port)) {
    throw new Error(`DB_PORT must be a number, got "${port}".`);
  }
  const ssl = sslOptions();
  return {
    host: process.env.DB_HOST,
    port: port ? Number(port) : 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    connectTimeout: 15000,
    ...(ssl ? { ssl } : {}),
  };
};
