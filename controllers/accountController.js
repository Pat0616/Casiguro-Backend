// backend/controllers/accountController.js
// ADMIN-ONLY ACCOUNT MANAGEMENT: registration approval, deactivation, admin promotion, per-account audit logs
import bcrypt from "bcryptjs";
import pool from "../database/db.js";
import { AUDIT_CATEGORIES, logAudit } from "../utils/auditLog.js";
import { emitAccountChanged } from "../websocket/socket.js";

export const PROMOTE_CONFIRMATION_PHRASE = "Confirm Account Admin For Casiguro";
const MAX_REASON_LENGTH = 500;
const AUDIT_PAGE_SIZE = 50;

const ACCOUNT_SELECT = `
  SELECT
    u.id,
    u.full_name AS fullName,
    u.email,
    COALESCE(u.contact_number, '') AS contactNumber,
    u.role,
    u.status,
    u.created_at AS registeredAt,
    u.approved_at AS approvedAt,
    approver.full_name AS approvedBy,
    u.status_changed_at AS statusChangedAt,
    changer.full_name AS statusChangedBy,
    u.status_reason AS statusReason,
    u.last_login_at AS lastLoginAt,
    (SELECT COUNT(*) FROM audit_logs a WHERE a.user_id = u.id) AS auditCount
  FROM users u
  LEFT JOIN users approver ON approver.id = u.approved_by
  LEFT JOIN users changer ON changer.id = u.status_changed_by
`;

async function fetchAccount(db, id) {
  const [rows] = await db.query(`${ACCOUNT_SELECT} WHERE u.id = ?`, [id]);
  return rows[0] || null;
}

function cleanReason(raw) {
  const reason = String(raw || "").trim();
  return reason ? reason.slice(0, MAX_REASON_LENGTH) : null;
}

// Loads the target with a row lock and applies the shared guards. Returns the user row or sends the error response.
async function loadTargetForChange(conn, req, res, { allowedStatuses, actionLabel }) {
  const { id } = req.params;
  if (id === req.user.id) {
    res.status(400).json({ message: `You can't ${actionLabel} your own account.` });
    return null;
  }
  const [rows] = await conn.query("SELECT * FROM users WHERE id = ? FOR UPDATE", [id]);
  const target = rows[0];
  if (!target) {
    res.status(404).json({ message: "Account not found" });
    return null;
  }
  if (!allowedStatuses.includes(target.status)) {
    res.status(409).json({ message: `This account is ${target.status}, so it can't be ${actionLabel}d.` });
    return null;
  }
  return target;
}

// GET /api/accounts
export async function getAccounts(req, res) {
  try {
    const [rows] = await pool.query(`${ACCOUNT_SELECT} ORDER BY FIELD(u.status, 'pending', 'active', 'deactivated', 'rejected'), u.created_at DESC`);
    res.json(rows.map((row) => ({ ...row, auditCount: Number(row.auditCount) })));
  } catch (err) {
    console.error("getAccounts error:", err);
    res.status(500).json({ message: "Failed to fetch accounts" });
  }
}

// GET /api/accounts/pending-count
export async function getPendingCount(req, res) {
  try {
    const [rows] = await pool.query("SELECT COUNT(*) AS pendingCount FROM users WHERE status = 'pending'");
    res.json({ pendingCount: Number(rows[0].pendingCount) });
  } catch (err) {
    console.error("getPendingCount error:", err);
    res.status(500).json({ message: "Failed to fetch pending registrations" });
  }
}

// Shared runner for approve / reject / deactivate / reactivate
async function changeStatus(req, res, { allowedStatuses, newStatus, actionLabel, auditAction, describe, reasonRequired = false }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const target = await loadTargetForChange(conn, req, res, { allowedStatuses, actionLabel });
    if (!target) {
      await conn.rollback();
      return;
    }

    const reason = cleanReason(req.body?.reason);
    if (reasonRequired && !reason) {
      await conn.rollback();
      return res.status(400).json({ message: "Please give a reason." });
    }

    const approving = newStatus === "active" && target.status === "pending";
    await conn.query(
      `UPDATE users SET
        status = ?,
        status_changed_by = ?,
        status_changed_at = NOW(),
        status_reason = ?
        ${approving ? ", approved_by = ?, approved_at = NOW()" : ""}
      WHERE id = ?`,
      approving ? [newStatus, req.user.id, reason, req.user.id, target.id] : [newStatus, req.user.id, reason, target.id]
    );

    await logAudit(conn, req, {
      action: auditAction,
      category: "account",
      entityType: "user",
      entityId: target.id,
      entityLabel: target.full_name,
      description: describe(target, reason),
      changes: { status: { from: target.status, to: newStatus } },
    });
    await conn.commit();

    emitAccountChanged({ userId: target.id, status: newStatus });
    res.json(await fetchAccount(pool, target.id));
  } catch (err) {
    await conn.rollback();
    console.error(`${auditAction} error:`, err);
    res.status(500).json({ message: "Failed to update the account" });
  } finally {
    conn.release();
  }
}

// PATCH /api/accounts/:id/approve
export function approveAccount(req, res) {
  return changeStatus(req, res, {
    allowedStatuses: ["pending"],
    newStatus: "active",
    actionLabel: "approve",
    auditAction: "account.approve",
    describe: (t) => `Approved the registration of ${t.full_name} (${t.email})`,
  });
}

// PATCH /api/accounts/:id/reject  { reason? }
export function rejectAccount(req, res) {
  return changeStatus(req, res, {
    allowedStatuses: ["pending"],
    newStatus: "rejected",
    actionLabel: "reject",
    auditAction: "account.reject",
    describe: (t, reason) => `Rejected the registration of ${t.full_name} (${t.email})${reason ? `: ${reason}` : ""}`,
  });
}

// PATCH /api/accounts/:id/deactivate  { reason? }
// Self-deactivation is refused, so the acting admin always remains: the last admin can never be locked out.
export function deactivateAccount(req, res) {
  return changeStatus(req, res, {
    allowedStatuses: ["active"],
    newStatus: "deactivated",
    actionLabel: "deactivate",
    auditAction: "account.deactivate",
    describe: (t, reason) => `Deactivated ${t.role} account ${t.full_name} (${t.email})${reason ? `: ${reason}` : ""}`,
  });
}

// PATCH /api/accounts/:id/reactivate
export function reactivateAccount(req, res) {
  return changeStatus(req, res, {
    allowedStatuses: ["deactivated"],
    newStatus: "active",
    actionLabel: "reactivate",
    auditAction: "account.reactivate",
    describe: (t) => `Reactivated ${t.role} account ${t.full_name} (${t.email})`,
  });
}

// POST /api/accounts/:id/promote  { confirmation, password }
// Requires the exact confirmation phrase and the acting admin's own password; failed attempts are logged too.
export async function promoteToAdmin(req, res) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const target = await loadTargetForChange(conn, req, res, { allowedStatuses: ["active"], actionLabel: "promote" });
    if (!target) {
      await conn.rollback();
      return;
    }
    if (target.role === "admin") {
      await conn.rollback();
      return res.status(409).json({ message: "This account is already an admin." });
    }

    const confirmation = String(req.body?.confirmation || "").trim();
    const [selfRows] = await conn.query("SELECT password FROM users WHERE id = ?", [req.user.id]);
    const passwordOk = await bcrypt.compare(String(req.body?.password || ""), selfRows[0]?.password || "");
    const phraseOk = confirmation === PROMOTE_CONFIRMATION_PHRASE;

    if (!phraseOk || !passwordOk) {
      await conn.rollback();
      // Logged outside the rolled-back transaction so the failed attempt is kept
      await logAudit(pool, req, {
        action: "account.promote_failed",
        category: "account",
        entityType: "user",
        entityId: target.id,
        entityLabel: target.full_name,
        description: `Failed attempt to promote ${target.full_name} to admin (${!passwordOk ? "wrong password" : "confirmation phrase did not match"})`,
      });
      return res.status(400).json({
        message: !phraseOk ? "The confirmation phrase doesn't match." : "Your password is incorrect.",
      });
    }

    await conn.query("UPDATE users SET role = 'admin', status_changed_by = ?, status_changed_at = NOW() WHERE id = ?", [
      req.user.id,
      target.id,
    ]);
    await logAudit(conn, req, {
      action: "account.promote",
      category: "account",
      entityType: "user",
      entityId: target.id,
      entityLabel: target.full_name,
      description: `Promoted ${target.full_name} (${target.email}) from employee to admin`,
      changes: { role: { from: "employee", to: "admin" } },
    });
    await conn.commit();

    emitAccountChanged({ userId: target.id, status: target.status });
    res.json(await fetchAccount(pool, target.id));
  } catch (err) {
    await conn.rollback();
    console.error("promoteToAdmin error:", err);
    res.status(500).json({ message: "Failed to promote the account" });
  } finally {
    conn.release();
  }
}

// Builds WHERE clause + params for audit log filters: ?category=&from=YYYY-MM-DD&to=YYYY-MM-DD
function auditFilters(req) {
  const where = ["user_id = ?"];
  const params = [req.params.id];
  const { category, from, to } = req.query;
  if (category && AUDIT_CATEGORIES.includes(category)) {
    where.push("category = ?");
    params.push(category);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(from || "")) {
    where.push("created_at >= ?");
    params.push(`${from} 00:00:00`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(to || "")) {
    where.push("created_at <= ?");
    params.push(`${to} 23:59:59`);
  }
  return { where: where.join(" AND "), params };
}

function parseChanges(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

const AUDIT_COLUMNS = `
  id, action, category, entity_type AS entityType, entity_id AS entityId, entity_label AS entityLabel,
  description, changes, ip_address AS ipAddress, user_agent AS userAgent, created_at AS createdAt
`;

// GET /api/accounts/:id/audit-logs?category=&from=&to=&before=<id>
// Newest first, paged by id cursor ("before") so new entries arriving don't shift pages.
export async function getAccountAuditLogs(req, res) {
  try {
    const account = await fetchAccount(pool, req.params.id);
    if (!account) return res.status(404).json({ message: "Account not found" });

    const { where, params } = auditFilters(req);
    const before = Number(req.query.before);
    const cursorWhere = Number.isFinite(before) && before > 0 ? " AND id < ?" : "";
    const [rows] = await pool.query(
      `SELECT ${AUDIT_COLUMNS} FROM audit_logs WHERE ${where}${cursorWhere} ORDER BY id DESC LIMIT ?`,
      [...params, ...(cursorWhere ? [before] : []), AUDIT_PAGE_SIZE + 1]
    );

    const hasMore = rows.length > AUDIT_PAGE_SIZE;
    const entries = rows.slice(0, AUDIT_PAGE_SIZE).map((row) => ({ ...row, id: Number(row.id), changes: parseChanges(row.changes) }));
    res.json({ entries, nextCursor: hasMore ? entries[entries.length - 1].id : null });
  } catch (err) {
    console.error("getAccountAuditLogs error:", err);
    res.status(500).json({ message: "Failed to fetch audit logs" });
  }
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  // Prefix formula-looking cells so spreadsheets don't execute them
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

// GET /api/accounts/:id/audit-logs/export  (same filters, CSV, all matching rows)
export async function exportAccountAuditLogs(req, res) {
  try {
    const account = await fetchAccount(pool, req.params.id);
    if (!account) return res.status(404).json({ message: "Account not found" });

    const { where, params } = auditFilters(req);
    const [rows] = await pool.query(`SELECT ${AUDIT_COLUMNS} FROM audit_logs WHERE ${where} ORDER BY id DESC`, params);

    const header = ["Date & time", "Category", "Action", "Description", "Record", "Changes", "IP address"];
    const lines = rows.map((row) => {
      const changes = parseChanges(row.changes);
      const changeText = changes
        ? Object.entries(changes).map(([field, c]) => `${field}: ${c?.from ?? "—"} → ${c?.to ?? "—"}`).join("; ")
        : "";
      return [row.createdAt, row.category, row.action, row.description, row.entityLabel, changeText, row.ipAddress].map(csvCell).join(",");
    });

    await logAudit(pool, req, {
      action: "account.audit_export",
      category: "account",
      entityType: "user",
      entityId: account.id,
      entityLabel: account.fullName,
      description: `Exported the audit log of ${account.fullName} (${rows.length} entries)`,
    });

    const filename = `audit-log-${account.fullName}`.replace(/[^\w.-]+/g, "_") + ".csv";
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${filename}"` });
    res.send("﻿" + [header.join(","), ...lines].join("\r\n")); // BOM so Excel reads UTF-8 (₱, accents)
  } catch (err) {
    console.error("exportAccountAuditLogs error:", err);
    res.status(500).json({ message: "Failed to export audit logs" });
  }
}
