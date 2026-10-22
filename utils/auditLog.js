// backend/utils/auditLog.js
// Per-account audit trail. Every entry belongs to the account that performed the action.

export const AUDIT_CATEGORIES = ["auth", "account", "order", "payment", "quotation", "catalog"];

function clientIp(req) {
  const forwarded = req?.headers?.["x-forwarded-for"];
  const ip = (typeof forwarded === "string" && forwarded.split(",")[0].trim()) || req?.ip || req?.socket?.remoteAddress || null;
  return ip ? ip.replace(/^::ffff:/, "") : null;
}

/**
 * Field-level diff for the `changes` column: { field: { from, to } }, only for values that differ.
 * Values are compared as strings so DECIMAL/number/date-string mismatches don't create noise.
 */
export function diffFields(before, after, fields) {
  const changes = {};
  for (const field of fields) {
    const from = before?.[field] ?? null;
    const to = after?.[field] ?? null;
    if (String(from ?? "") !== String(to ?? "")) changes[field] = { from, to };
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

/**
 * Write one audit entry. Pass a transaction connection as `db` so the entry commits or rolls back with the action.
 * @param {import("mysql2/promise").Pool | import("mysql2/promise").PoolConnection} db
 * @param {object} req          Express request (for IP / user agent and, by default, the acting user)
 * @param {object} entry
 * @param {{id, full_name, role}} [entry.actor]  defaults to req.user
 */
export async function logAudit(db, req, { actor, action, category, entityType, entityId, entityLabel, description, changes }) {
  const user = actor || req?.user || {};
  await db.query(
    `INSERT INTO audit_logs (
      user_id, user_name, user_role, action, category,
      entity_type, entity_id, entity_label, description, changes, ip_address, user_agent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      user.id || null,
      user.full_name || null,
      user.role || null,
      action,
      category,
      entityType || null,
      entityId != null ? String(entityId) : null,
      entityLabel ? String(entityLabel).slice(0, 150) : null,
      description,
      changes ? JSON.stringify(changes) : null,
      clientIp(req),
      req?.headers?.["user-agent"] ? String(req.headers["user-agent"]).slice(0, 255) : null,
    ]
  );
}

// For events outside a transaction (sign-ins): never let a logging failure break the request itself
export async function logAuditSafely(db, req, entry) {
  try {
    await logAudit(db, req, entry);
  } catch (err) {
    console.error("Audit log write failed:", entry.action, err.message);
  }
}
