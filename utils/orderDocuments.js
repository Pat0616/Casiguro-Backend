// backend/utils/orderDocuments.js

// Optional reference documents attached to an order (request key -> column)
export const DOCUMENT_COLUMNS = {
  prNo: "pr_no",
  poNo: "po_no",
  joNo: "jo_no",
  siOrNo: "si_or_no",
  siOrDate: "si_or_date",
  drNo: "dr_no",
  drDate: "dr_date",
};

export const DOCUMENT_LABELS = {
  prNo: "PR No",
  poNo: "PO No",
  joNo: "J.O. No",
  siOrNo: "SI/OR No",
  siOrDate: "SI/OR Date",
  drNo: "DR No",
  drDate: "DR Date",
};

const DATE_KEYS = new Set(["siOrDate", "drDate"]);
const MAX_NUMBER_LENGTH = 50;

export function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// Reads the document fields present in a request body. Blank values become null.
// Keys missing from the body are left out so callers can apply partial updates.
export function parseDocumentFields(body = {}) {
  const fields = {};
  for (const key of Object.keys(DOCUMENT_COLUMNS)) {
    if (!(key in body)) continue;
    const raw = body[key];
    if (raw == null || (typeof raw === "string" && !raw.trim())) {
      fields[key] = null;
      continue;
    }
    if (typeof raw !== "string") {
      return { error: `${DOCUMENT_LABELS[key]} must be text` };
    }
    const value = raw.trim();
    if (DATE_KEYS.has(key)) {
      if (!isValidIsoDate(value)) return { error: `${DOCUMENT_LABELS[key]} must be a valid date` };
    } else if (value.length > MAX_NUMBER_LENGTH) {
      return { error: `${DOCUMENT_LABELS[key]} must be ${MAX_NUMBER_LENGTH} characters or fewer` };
    }
    fields[key] = value;
  }
  return { fields };
}

// SOA numbers restart every month: YYYY-MM-N, e.g. 2026-04-36 is the 36th order created in April 2026.
// The upsert locks that month's counter row until the caller's transaction ends, so concurrent orders
// never share a number, and a rolled-back order gives its number back.
// The database clock decides the date so new orders agree with the backfilled created_at dates.
export async function generateSoaNumber(conn) {
  const [[{ today }]] = await conn.query("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS today");
  const period = today.slice(0, 7);
  await conn.query(
    `INSERT INTO soa_counters (period, last_seq) VALUES (?, LAST_INSERT_ID(1))
     ON DUPLICATE KEY UPDATE last_seq = LAST_INSERT_ID(last_seq + 1)`,
    [period]
  );
  const [[{ seq }]] = await conn.query("SELECT LAST_INSERT_ID() AS seq");
  return { soaNo: `${period}-${seq}`, soaDate: today };
}
