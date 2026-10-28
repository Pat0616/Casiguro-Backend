// backend/controllers/reportController.js
import pool from "../database/db.js";
import { buildSalesWorkbook } from "../utils/salesWorkbook.js";
import { attachPaymentsToOrders } from "../utils/payments.js";

// GET /api/reports/sales.xlsx?mode=year|month&year=YYYY&month=M
// Orders belong to the period of their order date (date_ordered), paid or not, like the business's own sheet.
export async function exportSalesExcel(req, res) {
  try {
    const mode = req.query.mode === "month" ? "month" : req.query.mode === "year" ? "year" : null;
    const year = Number(req.query.year);
    const month = Number(req.query.month);
    if (!mode) {
      return res.status(400).json({ message: "mode must be 'year' or 'month'" });
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ message: "Invalid year" });
    }
    if (mode === "month" && (!Number.isInteger(month) || month < 1 || month > 12)) {
      return res.status(400).json({ message: "Invalid month" });
    }

    const pad = (n) => String(n).padStart(2, "0");
    const [from, to] = mode === "year"
      ? [`${year}-01-01`, `${year + 1}-01-01`]
      : [`${year}-${pad(month)}-01`, month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`];

    // Within a day, order by SOA sequence (YYYY-MM-N) so rows keep the order they were created in
    const [orders] = await pool.query(
      `SELECT
        o.id,
        o.soa_no AS soaNo,
        o.jo_no AS joNo,
        o.si_or_no AS siOrNo,
        COALESCE(c.full_name, '') AS customerName,
        CAST(o.total_price AS DOUBLE) AS totalPrice,
        CAST(o.amount_paid AS DOUBLE) AS amountPaid,
        o.payment_status AS paymentStatus,
        o.status,
        o.cancel_reason AS cancelReason,
        o.date_ordered AS dateOrdered
      FROM orders o
      LEFT JOIN customers c ON o.customer_id = c.id
      WHERE o.date_ordered >= ? AND o.date_ordered < ?
      ORDER BY o.date_ordered ASC, o.soa_date ASC,
        CAST(SUBSTRING_INDEX(o.soa_no, '-', -1) AS UNSIGNED) ASC`,
      [from, to]
    );
    const rows = (await attachPaymentsToOrders(orders)).map((o) => ({
      ...o,
      payments: o.payments.filter((p) => !p.voidedAt),
    }));

    const period = { mode, year, month: mode === "month" ? month : undefined };
    const buffer = await buildSalesWorkbook(rows, period).xlsx.writeBuffer();
    const filename = `Casiguro_Sales_${mode === "year" ? year : `${year}-${pad(month)}`}.xlsx`;

    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": buffer.length,
      "Cache-Control": "no-store",
    });
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("exportSalesExcel error:", err);
    res.status(500).json({ message: "Failed to generate sales report" });
  }
}
