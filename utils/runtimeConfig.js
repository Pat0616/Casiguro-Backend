// backend/utils/runtimeConfig.js
// Settings that differ between local development and the deployed server, read once from .env.
//   NODE_ENV=production   Secure cookies (HTTPS only) that also work when the frontend is on another site.
//   CLIENT_ORIGIN         Frontend URL(s) allowed by CORS and Socket.IO; several are separated by commas.
//   COOKIE_SAMESITE       Overrides the cookie's SameSite (strict | lax | none).
//   TRUST_PROXY           Set when a reverse proxy (Caddy/Nginx) sits in front, so req.ip is the visitor's address.
import dotenv from "dotenv";

dotenv.config();

export const isProduction = process.env.NODE_ENV === "production";

export const clientOrigins = (process.env.CLIENT_ORIGIN || "http://localhost:5173")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);

// Production defaults to SameSite=None so a frontend on another domain (e.g. Vercel) still sends the cookie.
// Browsers only accept SameSite=None together with Secure, which needs HTTPS.
const sameSite = (process.env.COOKIE_SAMESITE?.trim().toLowerCase() || (isProduction ? "none" : "strict"));
if (!["strict", "lax", "none"].includes(sameSite)) {
  throw new Error(`COOKIE_SAMESITE must be strict, lax or none, got "${process.env.COOKIE_SAMESITE}".`);
}

export const authCookieOptions = {
  httpOnly: true,
  secure: isProduction || sameSite === "none",
  sameSite,
  path: "/",
};

// Express "trust proxy": a hop count ("1"), "true", or an address list like "loopback". Unset = no proxy.
export function trustProxySetting() {
  const value = process.env.TRUST_PROXY?.trim();
  if (!value) return false;
  if (/^\d+$/.test(value)) return Number(value);
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  return value;
}

if (isProduction && (process.env.JWT_SECRET || "").length < 32) {
  throw new Error("JWT_SECRET must be at least 32 characters in production.");
}
