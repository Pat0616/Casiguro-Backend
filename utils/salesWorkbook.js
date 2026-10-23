// backend/utils/salesWorkbook.js
// Builds the sales export workbook. Sheet 1 mirrors Casiguro's own "SALES MONITORING" spreadsheet so the
// accountant can keep using their layout; sheet 2 is a summary of the same rows.
import ExcelJS from "exceljs";

const MONTHS = [
  "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
  "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER",
];

// Zero shows as "-", like their sheet
const MONEY = '#,##0.00;-#,##0.00;"-"';
const DATE = "dd-mmm-yy";
const BORDER = { style: "thin", color: { argb: "FFBFBFBF" } };
const ALL_BORDERS = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFD9E1F2" } };
const CANCELLED_FONT = { color: { argb: "FF9CA3AF" }, italic: true };

// Column order and headers follow their sheet. J.O. NO. is the SOA No. As in their sheet, BALANCE is what was
// left after the down payment (TOTAL − DP); anything still unpaid today is noted in REMARKS.
// CASH holds every non-check payment (cash, GCash, bank transfer); the method is noted in REMARKS like they do.
const MONITORING_COLUMNS = [
  { header: "DATE", key: "date", width: 12, numFmt: DATE },
  { header: "CLIENT", key: "client", width: 38 },
  { header: "TOTAL", key: "total", width: 14, numFmt: MONEY, sum: true },
  { header: "DP", key: "dp", width: 12, numFmt: MONEY, sum: true },
  { header: "BALANCE", key: "balance", width: 14, numFmt: MONEY, sum: true },
  { header: "CASH", key: "cash", width: 14, numFmt: MONEY, sum: true },
  { header: "EWT", key: "ewt", width: 10, numFmt: MONEY, sum: true },
  { header: "CHECK", key: "check", width: 14, numFmt: MONEY, sum: true },
  { header: "CHECK NO.", key: "checkNo", width: 14 },
  { header: "J.O. NO.", key: "joNo", width: 13 },
  { header: "OR NO.", key: "orNo", width: 12 },
  { header: "S.I. NO.", key: "siNo", width: 11 },
  { header: "REMARKS", key: "remarks", width: 34 },
];

const METHOD_REMARKS = { gcash: "GCASH", bank_transfer: "BANK TRANSFER" };

// "YYYY-MM-DD" (mysql dateStrings) → Date at UTC midnight, which ExcelJS writes as that calendar day
function toExcelDate(value) {
  const [y, m, d] = String(value).slice(0, 10).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

const round2 = (n) => Math.round(n * 100) / 100;
const peso = (n) => n.toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const isCancelled = (order) => order.status === "cancelled";

export function periodLabel({ mode, year, month }) {
  return mode === "year" ? `JANUARY-DECEMBER ${year}` : `${MONTHS[month - 1]} ${year}`;
}

// Splits an order's non-voided payments into their sheet's columns
function paymentColumns(order) {
  const sums = { dp: 0, cash: 0, check: 0, ewt: 0 };
  const checkNos = [];
  const orNos = [];
  const notes = new Set();
  for (const p of order.payments || []) {
    if (p.paymentType === "ewt") sums.ewt += p.amount;
    else if (p.paymentType === "down_payment") sums.dp += p.amount;
    else if (p.method === "check") sums.check += p.amount;
    else sums.cash += p.amount;

    if (p.method === "check" && p.referenceNo) checkNos.push(p.referenceNo);
    if (p.orNo) orNos.push(p.orNo);
    if (METHOD_REMARKS[p.method]) notes.add(`PAID ${METHOD_REMARKS[p.method]}`);
    if (p.paymentType !== "ewt" && !p.method) notes.add("METHOD NOT RECORDED");
  }
  return { ...sums, checkNos, orNos: [...new Set(orNos)], notes: [...notes] };
}

function monitoringValues(order) {
  const base = {
    date: toExcelDate(order.dateOrdered),
    client: (order.customerName || "WALK-IN").toUpperCase(),
    joNo: order.soaNo,
    siNo: order.siOrNo || null,
  };
  if (isCancelled(order)) {
    return { ...base, remarks: `CANCELLED${order.cancelReason ? `: ${order.cancelReason}` : ""}` };
  }
  const cols = paymentColumns(order);
  const outstanding = round2(order.totalPrice - order.amountPaid);
  const remarks = [...cols.notes];
  if (outstanding > 0) remarks.push(`${order.amountPaid > 0 ? "PARTIAL" : "UNPAID"} - BAL ${peso(outstanding)}`);
  return {
    ...base,
    total: order.totalPrice,
    dp: cols.dp || null,
    balance: round2(order.totalPrice - cols.dp),
    cash: cols.cash || null,
    ewt: cols.ewt || null,
    check: cols.check || null,
    checkNo: cols.checkNos.join(", ") || null,
    orNo: cols.orNos.join(", ") || null,
    remarks: remarks.join("; ") || null,
  };
}

function addTitle(sheet, lines, lastCol) {
  lines.forEach((text, i) => {
    const row = sheet.getRow(i + 1);
    row.getCell(1).value = text;
    row.getCell(1).font = { bold: true, size: i === 0 ? 13 : 11 };
    sheet.mergeCells(i + 1, 1, i + 1, lastCol);
  });
}

function styleHeader(row) {
  row.eachCell((cell) => {
    cell.font = { bold: true };
    cell.fill = HEADER_FILL;
    cell.border = ALL_BORDERS;
    cell.alignment = { horizontal: "center", vertical: "middle" };
  });
  row.height = 18;
}

function addMonitoringSheet(workbook, rows, period) {
  const sheet = workbook.addWorksheet("Sales Monitoring", {
    pageSetup: { orientation: "landscape", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  const lastCol = MONITORING_COLUMNS.length;
  addTitle(sheet, ["CASIGURO ENTERPRISES INC.", `SALES MONITORING ${period.year}`, periodLabel(period)], lastCol);

  const HEADER_ROW = 5;
  MONITORING_COLUMNS.forEach((col, i) => {
    sheet.getColumn(i + 1).width = col.width;
  });
  const header = sheet.getRow(HEADER_ROW);
  header.values = MONITORING_COLUMNS.map((c) => c.header);
  styleHeader(header);

  const columnTotals = {};
  rows.forEach((order, i) => {
    const values = monitoringValues(order);
    const row = sheet.getRow(HEADER_ROW + 1 + i);
    MONITORING_COLUMNS.forEach((col, c) => {
      const cell = row.getCell(c + 1);
      cell.value = values[col.key] ?? null;
      if (col.numFmt) cell.numFmt = col.numFmt;
      if (col.sum) columnTotals[col.key] = (columnTotals[col.key] || 0) + (values[col.key] || 0);
      cell.border = ALL_BORDERS;
      if (isCancelled(order)) cell.font = CANCELLED_FONT;
    });
  });

  // SUBTOTAL(9, …) ignores rows hidden by the autofilter, so the totals follow whatever is filtered
  const firstData = HEADER_ROW + 1;
  const lastData = HEADER_ROW + Math.max(rows.length, 1);
  const totalRow = sheet.getRow(lastData + 1);
  totalRow.getCell(2).value = "TOTAL";
  MONITORING_COLUMNS.forEach((col, c) => {
    const cell = totalRow.getCell(c + 1);
    if (col.sum) {
      const letter = sheet.getColumn(c + 1).letter;
      cell.value = { formula: `SUBTOTAL(9,${letter}${firstData}:${letter}${lastData})`, result: round2(columnTotals[col.key] || 0) };
      cell.numFmt = col.numFmt;
    }
    cell.font = { bold: true };
    cell.border = { top: { style: "thin" }, bottom: { style: "double" } };
  });

  sheet.autoFilter = { from: { row: HEADER_ROW, column: 1 }, to: { row: lastData, column: lastCol } };
  sheet.views = [{ state: "frozen", ySplit: HEADER_ROW }];
  sheet.pageSetup.printTitlesRow = `${HEADER_ROW}:${HEADER_ROW}`;
}

function addTable(sheet, startRow, headers, data, formats) {
  const header = sheet.getRow(startRow);
  header.values = headers;
  styleHeader(header);
  data.forEach((values, i) => {
    const row = sheet.getRow(startRow + 1 + i);
    values.forEach((value, c) => {
      const cell = row.getCell(c + 1);
      cell.value = value;
      if (formats[c]) cell.numFmt = formats[c];
      cell.border = ALL_BORDERS;
    });
  });
  return startRow + data.length + 1;
}

// Sales figures exclude cancelled orders. "Paid" includes EWT, which settles the balance without cash changing hands.
function addSummarySheet(workbook, rows, period) {
  const sheet = workbook.addWorksheet("Summary", {
    pageSetup: { orientation: "portrait", paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });
  [34, 12, 16, 16, 16].forEach((width, i) => {
    sheet.getColumn(i + 1).width = width;
  });
  addTitle(sheet, ["CASIGURO ENTERPRISES INC.", "SALES SUMMARY", periodLabel(period)], 5);

  const active = rows.filter((o) => !isCancelled(o));
  const sales = active.reduce((s, o) => s + o.totalPrice, 0);
  const paid = active.reduce((s, o) => s + o.amountPaid, 0);
  const ewt = active.reduce((s, o) => s + paymentColumns(o).ewt, 0);
  const totals = [
    ["Orders", active.length, null],
    ["Total Sales", round2(sales), MONEY],
    ["Collected (cash, GCash, bank, check)", round2(paid - ewt), MONEY],
    ["EWT Withheld by Clients", round2(ewt), MONEY],
    ["Outstanding Balance", round2(sales - paid), MONEY],
    ["Fully Paid Orders", active.filter((o) => o.paymentStatus === "paid").length, null],
    ["Cancelled Orders", rows.length - active.length, null],
  ];
  totals.forEach(([label, value, fmt], i) => {
    const row = sheet.getRow(5 + i);
    row.getCell(1).value = label;
    row.getCell(1).font = { bold: true };
    row.getCell(2).value = value;
    if (fmt) row.getCell(2).numFmt = fmt;
    row.getCell(2).alignment = { horizontal: "right" };
    sheet.mergeCells(5 + i, 2, 5 + i, 3);
  });

  // Per month for a yearly export, per day for a monthly one
  const buckets = period.mode === "year"
    ? MONTHS.map((name, i) => ({ label: name[0] + name.slice(1).toLowerCase(), match: (d) => Number(d.slice(5, 7)) === i + 1 }))
    : Array.from({ length: new Date(period.year, period.month, 0).getDate() }, (_, i) => ({
        label: toExcelDate(`${period.year}-${period.month}-${i + 1}`),
        match: (d) => Number(d.slice(8, 10)) === i + 1,
      }));
  const breakdown = buckets.map(({ label, match }) => {
    const inBucket = active.filter((o) => match(o.dateOrdered));
    const bucketSales = inBucket.reduce((s, o) => s + o.totalPrice, 0);
    const bucketPaid = inBucket.reduce((s, o) => s + o.amountPaid, 0);
    return [label, inBucket.length, round2(bucketSales), round2(bucketPaid), round2(bucketSales - bucketPaid)];
  });
  let next = 5 + totals.length + 1;
  sheet.getRow(next).getCell(1).value = period.mode === "year" ? "SALES BY MONTH" : "SALES BY DAY";
  sheet.getRow(next).getCell(1).font = { bold: true };
  next = addTable(
    sheet,
    next + 1,
    [period.mode === "year" ? "MONTH" : "DATE", "ORDERS", "SALES", "PAID", "BALANCE"],
    [...breakdown, ["TOTAL", active.length, round2(sales), round2(paid), round2(sales - paid)]],
    [period.mode === "year" ? null : DATE, null, MONEY, MONEY, MONEY]
  );
  sheet.getRow(next - 1).font = { bold: true };

  const byClient = new Map();
  active.forEach((o) => {
    const name = (o.customerName || "WALK-IN").toUpperCase();
    const entry = byClient.get(name) || { orders: 0, sales: 0, paid: 0 };
    entry.orders += 1;
    entry.sales += o.totalPrice;
    entry.paid += o.amountPaid;
    byClient.set(name, entry);
  });
  const topClients = [...byClient.entries()]
    .sort((a, b) => b[1].sales - a[1].sales)
    .slice(0, 10)
    .map(([name, e]) => [name, e.orders, round2(e.sales), round2(e.paid), round2(e.sales - e.paid)]);
  next += 1;
  sheet.getRow(next).getCell(1).value = "TOP CLIENTS";
  sheet.getRow(next).getCell(1).font = { bold: true };
  addTable(sheet, next + 1, ["CLIENT", "ORDERS", "SALES", "PAID", "BALANCE"], topClients, [null, null, MONEY, MONEY, MONEY]);
}

// rows: orders in the period (cancelled included), sorted, each with its non-voided `payments`.
// period: { mode: "year" | "month", year: number, month?: number }
export function buildSalesWorkbook(rows, period) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Casiguro Transaction Management System";
  workbook.created = new Date();
  // Excel recomputes the SUBTOTAL formulas on open instead of trusting the cached results
  workbook.calcProperties.fullCalcOnLoad = true;
  addMonitoringSheet(workbook, rows, period);
  addSummarySheet(workbook, rows, period);
  return workbook;
}
