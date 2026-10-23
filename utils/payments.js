// backend/utils/payments.js
// Payment log. Each down payment, payment or EWT (withholding tax) is one row in `payments`; rows are never deleted,
// a mistake is voided instead. orders.amount_paid / balance / payment_status are derived from the non-voided rows
// by recalcOrderPayments, which is the only code that writes those columns.
import crypto from "crypto";
import pool from "../database/db.js";
import { isValidIsoDate } from "./orderDocuments.js";

export const PAYMENT_TYPES = ["down_payment", "payment", "ewt"];
export const PAYMENT_METHODS = ["cash", "gcash", "check", "bank_transfer"];

export const PAYMENT_TYPE_LABELS = { down_payment: "Down payment", payment: "Payment", ewt: "EWT" };
export const PAYMENT_METHOD_LABELS = { cash: "Cash", gcash: "GCash", check: "Check", bank_transfer: "Bank transfer" };

const MAX_TEXT = { referenceNo: 100, checkBank: 100, orNo: 50, note: 500 };

function formatCurrency(n) {
  return "₱" + Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const toCents = (n) => Math.round(Number(n) * 100);

function optionalText(body, key, label) {
  const raw = body[key];
  if (raw == null || (typeof raw === "string" && !raw.trim())) return { value: null };
  if (typeof raw !== "string") return { error: `${label} must be text` };
  const value = raw.trim();
  if (value.length > MAX_TEXT[key]) return { error: `${label} must be ${MAX_TEXT[key]} characters or fewer` };
  return { value };
}

/**
 * Validates a payment from a request body against the order's open balance.
 * Body: { paymentType, method, amount, receivedOn?, referenceNo?, checkBank?, checkDate?, orNo?, note? }
 * Returns { fields } or { error }.
 */
export function parsePaymentInput(body = {}, balance) {
  const paymentType = body.paymentType || "payment";
  if (!PAYMENT_TYPES.includes(paymentType)) return { error: "Invalid payment type" };

  // EWT is tax withheld by the client, not money handed over, so it has no method
  const method = paymentType === "ewt" ? null : body.method;
  if (paymentType !== "ewt" && !PAYMENT_METHODS.includes(method)) return { error: "Choose a payment method" };

  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { error: "Amount must be greater than 0" };
  if (Math.abs(amount * 100 - toCents(amount)) > 1e-6) {
    return { error: "Amount can have at most 2 decimal places" };
  }
  if (toCents(amount) > toCents(balance)) {
    return { error: `Amount is more than the remaining balance of ${formatCurrency(balance)}` };
  }

  let receivedOn = null; // null → today (database clock, Asia/Manila)
  if (body.receivedOn != null && body.receivedOn !== "") {
    if (typeof body.receivedOn !== "string" || !isValidIsoDate(body.receivedOn)) return { error: "Date received must be a valid date" };
    receivedOn = body.receivedOn;
  }

  const fields = { paymentType, method, amount: toCents(amount) / 100, receivedOn };
  for (const [key, label] of [
    ["referenceNo", paymentType === "ewt" ? "2307 certificate no." : method === "check" ? "Check no." : "Reference no."],
    ["checkBank", "Bank"],
    ["orNo", "OR no."],
    ["note", "Note"],
  ]) {
    const { value, error } = optionalText(body, key, label);
    if (error) return { error };
    fields[key] = value;
  }

  fields.checkDate = null;
  if (method === "check") {
    if (!fields.referenceNo) return { error: "Check no. is required for check payments" };
    if (body.checkDate) {
      if (typeof body.checkDate !== "string" || !isValidIsoDate(body.checkDate)) return { error: "Check date must be a valid date" };
      fields.checkDate = body.checkDate;
    }
  } else {
    fields.checkBank = null;
  }
  return { fields };
}

export async function insertPayment(conn, orderId, fields, userId) {
  const id = crypto.randomUUID();
  await conn.query(
    `INSERT INTO payments (
      id, order_id, payment_type, method, amount, received_on,
      reference_no, check_bank, check_date, or_no, note, created_by
    ) VALUES (?, ?, ?, ?, ?, COALESCE(?, CURDATE()), ?, ?, ?, ?, ?, ?)`,
    [
      id, orderId, fields.paymentType, fields.method, fields.amount, fields.receivedOn,
      fields.referenceNo, fields.checkBank, fields.checkDate, fields.orNo, fields.note, userId,
    ]
  );
  return id;
}

// Recomputes the order's money columns from its non-voided payments. Call inside the same transaction as the change.
export async function recalcOrderPayments(conn, orderId) {
  const [[order]] = await conn.query(
    `SELECT CAST(o.total_price AS DOUBLE) AS totalPrice,
      CAST(COALESCE((SELECT SUM(amount) FROM payments WHERE order_id = o.id AND voided_at IS NULL), 0) AS DOUBLE) AS paid
    FROM orders o WHERE o.id = ?`,
    [orderId]
  );
  const total = toCents(order.totalPrice);
  const paid = toCents(order.paid);
  const amountPaid = Math.min(paid, total) / 100;
  const balance = Math.max(total - paid, 0) / 100;
  const paymentStatus = paid <= 0 ? "unpaid" : paid < total ? "partial" : "paid";
  await conn.query("UPDATE orders SET amount_paid = ?, balance = ?, payment_status = ? WHERE id = ?", [
    amountPaid,
    balance,
    paymentStatus,
    orderId,
  ]);
  return { totalPrice: total / 100, amountPaid, balance, paymentStatus };
}

// "Down payment ₱1,000.00 via GCash (ref 12345)" for notifications and audit entries
export function describePayment(p) {
  const type = PAYMENT_TYPE_LABELS[p.paymentType] || "Payment";
  const via = p.method ? ` via ${PAYMENT_METHOD_LABELS[p.method]}` : "";
  const ref = p.referenceNo ? ` (${p.method === "check" ? "check no." : p.paymentType === "ewt" ? "2307 no." : "ref"} ${p.referenceNo})` : "";
  return `${type} ${formatCurrency(p.amount)}${via}${ref}`;
}

export const PAYMENT_SELECT = `
  SELECT
    p.id,
    p.order_id AS orderId,
    p.payment_type AS paymentType,
    p.method,
    CAST(p.amount AS DOUBLE) AS amount,
    p.received_on AS receivedOn,
    p.reference_no AS referenceNo,
    p.check_bank AS checkBank,
    p.check_date AS checkDate,
    p.or_no AS orNo,
    p.note,
    p.voided_at AS voidedAt,
    COALESCE(vu.full_name, '') AS voidedByName,
    p.void_reason AS voidReason,
    COALESCE(cu.full_name, '') AS createdByName,
    p.created_at AS createdAt
  FROM payments p
  LEFT JOIN users cu ON p.created_by = cu.id
  LEFT JOIN users vu ON p.voided_by = vu.id
`;

// Batch-loads payments (voided included, oldest first) onto orders as `payments`
export async function attachPaymentsToOrders(orders) {
  if (!orders || orders.length === 0) return orders || [];
  const [rows] = await pool.query(`${PAYMENT_SELECT} WHERE p.order_id IN (?) ORDER BY p.received_on ASC, p.created_at ASC`, [
    orders.map((o) => o.id),
  ]);
  const byOrder = {};
  for (const row of rows) (byOrder[row.orderId] ||= []).push(row);
  return orders.map((o) => ({ ...o, payments: byOrder[o.id] || [] }));
}
