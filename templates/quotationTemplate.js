// backend/templates/quotationTemplate.js
// HTML for the printable PRICE QUOTATION (A4 landscape), rendered to PDF by utils/pdfRenderer.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const COMPANY = {
  name: "CASIGURO ENTERPRISES, INC.",
  address: "#6 & 7 Marem Building, Corner Jb Alegre Street & Habana Street, Casiguran, Sorsogon",
  contact: "Contact Nos.: 09688817969/09203757810   E-mail add: casiguro.printingservices@gmail.com",
};

const MIN_ITEM_ROWS = 8;

// The brand logo (swoosh + "CASIGURO ENTERPRISES, INC." title) shared with the frontend.
// Both repos sit side by side, so the backend reads it straight from the frontend's public folder.
const LOGO_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../casiguro-app/public/CasiguroEnterpriseLogo.png"
);

// Where the artwork sits inside the 500x500 PNG (the rest is transparent padding), used to crop it
const LOGO_CROP = { imageSize: 500, x: 41, y: 161, width: 418, height: 178 };

// Read on every render so a replaced logo file shows up without restarting the server
function loadLogoDataUri() {
  if (!fs.existsSync(LOGO_FILE)) return null;
  return `data:image/png;base64,${fs.readFileSync(LOGO_FILE).toString("base64")}`;
}

// CSS that crops the padded square PNG to just its artwork. The image is absolutely positioned so it can't
// stretch the box past the artwork's aspect ratio; percentages keep it sharp at any width.
function logoCropCss() {
  const { imageSize, x, y, width, height } = LOGO_CROP;
  const pct = (n, of) => `${((n / of) * 100).toFixed(3)}%`;
  return `
  .logo { position: relative; width: 250px; aspect-ratio: ${width} / ${height}; overflow: hidden; flex-shrink: 0; }
  .logo img { position: absolute; width: ${pct(imageSize, width)}; left: -${pct(x, width)}; top: -${pct(y, height)}; }`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// YYYY-MM-DD -> MM/DD/YYYY
function formatDocDate(iso) {
  if (!iso) return "";
  const [y, m, d] = String(iso).slice(0, 10).split("-");
  return `${m}/${d}/${y}`;
}

function formatMoney(n) {
  return Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Unit cost shows whole numbers without decimals (e.g. 348), like the paper form
function formatUnitCost(n) {
  return Number(n || 0).toLocaleString("en-PH", { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

// Brand palette sampled from the logo swoosh; navy carries headings and prints well in grayscale
const BRAND = {
  navy: "#0f2e52",
  cyan: "#1ba6e4",
  magenta: "#e4007c",
  purple: "#b67fc0",
  yellow: "#ffe100",
  ink: "#1e293b",
  muted: "#64748b",
  line: "#cbd5e1",
  hairline: "#e2e8f0",
  tint: "#f8fafc",
};

/**
 * @param {object} data
 * @param {object} data.quotation  quoteNo, customerName, contactNumber, totalAmount, validUntil
 * @param {object[]} data.items    itemName, selectedVariant, quantity, finalUnitPrice, subtotal
 * @param {object|null} data.order converted order's soaNo, soaDate, prNo, poNo, siOrNo, siOrDate, drNo, drDate
 */
export function renderQuotationHtml({ quotation, items, order }) {
  const logo = loadLogoDataUri();
  const doc = order || {};

  const clientFields = [
    ["CLIENT NAME:", quotation.customerName],
    ["ADDRESS:", ""],
    ["CONTACT PERSON:", ""],
    ["CONTACT NO.:", quotation.contactNumber],
  ];
  const soaFields = [
    ["SOA NO.:", doc.soaNo],
    ["SOA DATE:", formatDocDate(doc.soaDate)],
    ["P.R. NO.:", doc.prNo],
    ["P.O. NO.:", doc.poNo],
  ];
  const receiptFields = [
    ["S.I. NO./O.R. NO.:", doc.siOrNo],
    ["S.I./O.R. DATE:", formatDocDate(doc.siOrDate)],
    ["D.R. NO.:", doc.drNo],
    ["D.R. DATE:", formatDocDate(doc.drDate)],
  ];
  const fieldRows = (fields) =>
    fields
      .map(([label, value]) => `<div class="field"><span class="label">${label}</span><span class="value">${escapeHtml(value)}</span></div>`)
      .join("");

  const rowCount = Math.max(MIN_ITEM_ROWS, items.length);
  const itemRows = Array.from({ length: rowCount }, (_, i) => {
    const it = items[i];
    if (!it) {
      return `<tr class="empty"><td class="c">${i + 1}</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`;
    }
    return `<tr>
      <td class="c">${i + 1}</td>
      <td></td>
      <td class="item">${escapeHtml(it.itemName)}</td>
      <td class="c">${escapeHtml(it.selectedVariant || "")}</td>
      <td class="c num">${escapeHtml(it.quantity)}</td>
      <td class="r num">${formatUnitCost(it.finalUnitPrice)}</td>
      <td class="r num">${formatMoney(it.subtotal)}</td>
    </tr>`;
  }).join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Price Quotation ${escapeHtml(quotation.quoteNo)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI", Calibri, Arial, sans-serif; font-size: 9.5pt; color: ${BRAND.ink}; }
  .items tr, .closing { break-inside: avoid; }
  .brand-bar { height: 6px; background: linear-gradient(90deg, ${BRAND.magenta}, ${BRAND.purple} 35%, ${BRAND.yellow} 65%, ${BRAND.cyan}); }
  .brand-bar.thin { height: 3px; }
  .content { padding: 10px 22px 12px; }

  .letterhead { display: flex; flex-direction: column; align-items: center; gap: 3px; text-align: center; }
  ${logoCropCss()}
  .logo-fallback { font-weight: 700; font-size: 18pt; color: ${BRAND.cyan}; }
  .company-lines { font-size: 7.5pt; line-height: 1.55; color: ${BRAND.muted}; }

  .title { display: flex; align-items: center; gap: 14px; margin: 8px 0 10px; }
  .title::before, .title::after { content: ""; flex: 1; height: 1px; background: ${BRAND.line}; }
  .title h1 { margin: 0; font-size: 17pt; font-weight: 800; letter-spacing: 4px; color: ${BRAND.navy}; }
  .title .ref { display: block; margin-top: 1px; text-align: center; font-size: 7.5pt; letter-spacing: .5px; color: ${BRAND.muted}; }

  .info { display: grid; grid-template-columns: 1.45fr 1fr 1fr; gap: 10px; margin-bottom: 10px; }
  .panel { border: 1px solid ${BRAND.hairline}; border-radius: 5px; padding: 4px 10px 6px; background: #fff; }
  .panel.tinted { background: ${BRAND.tint}; }
  .field { display: flex; align-items: flex-end; gap: 6px; min-height: 19px; border-bottom: 1px solid ${BRAND.hairline}; }
  .field:last-child { border-bottom: none; }
  .field .label { flex-shrink: 0; font-size: 7.5pt; font-weight: 700; letter-spacing: .3px; color: ${BRAND.muted}; padding-bottom: 2px; }
  .field .value { flex: 1; font-size: 9.5pt; font-weight: 600; color: ${BRAND.ink}; padding-bottom: 1px; }
  .panel:first-child .field .label { width: 98px; }
  .panel:not(:first-child) .field .label { width: 100px; }

  .items { width: 100%; border-collapse: separate; border-spacing: 0; border: 1px solid ${BRAND.line}; border-radius: 5px; overflow: hidden; }
  .items th { background: ${BRAND.navy}; color: #fff; font-size: 7.5pt; font-weight: 700; letter-spacing: .6px; padding: 5px 6px; text-align: center; }
  .items td { padding: 0 8px; height: 19px; font-size: 9pt; border-top: 1px solid ${BRAND.hairline}; border-left: 1px solid ${BRAND.hairline}; }
  .items td:first-child { border-left: none; }
  .items tbody tr:nth-child(even) td { background: ${BRAND.tint}; }
  .items td.c { text-align: center; }
  .items td.r { text-align: right; }
  .items td.item { font-weight: 600; }
  .items .num { font-variant-numeric: tabular-nums; }
  .items tr.empty td.c { color: #cbd5e1; }

  .total-row { display: flex; justify-content: flex-end; margin-top: 8px; }
  .total { display: flex; align-items: center; gap: 18px; padding: 6px 14px; border-radius: 5px;
    background: #eaf6fd; border-left: 4px solid ${BRAND.cyan}; }
  .total .label { font-size: 8pt; font-weight: 700; letter-spacing: 1px; color: ${BRAND.navy}; }
  .total .amount { font-size: 13pt; font-weight: 800; color: ${BRAND.navy}; font-variant-numeric: tabular-nums; }

  .signatures { display: flex; justify-content: space-between; padding: 18px 40px 0; }
  .sig { width: 300px; }
  .sig .heading { font-size: 7.5pt; font-weight: 700; letter-spacing: .6px; color: ${BRAND.muted}; }
  .sig .name { margin-top: 26px; min-height: 15px; text-align: center; font-size: 9.5pt; font-weight: 700; color: ${BRAND.ink}; }
  .sig .line { border-top: 1px solid ${BRAND.ink}; margin-top: 2px; padding-top: 3px; text-align: center;
    font-size: 7pt; font-weight: 600; letter-spacing: .5px; color: ${BRAND.muted}; }

  .footer { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; margin-top: 14px; padding-top: 6px;
    border-top: 1px solid ${BRAND.hairline}; font-size: 7pt; color: ${BRAND.muted}; }
  .footer .note { font-style: italic; }
  .footer .validity { flex-shrink: 0; font-weight: 600; color: ${BRAND.navy}; }
</style>
</head>
<body>
  <div class="sheet">
    <div class="brand-bar"></div>
    <div class="content">
      <div class="letterhead">
        ${logo
          ? `<div class="logo"><img src="${logo}" alt="${escapeHtml(COMPANY.name)}"></div>`
          : `<div class="logo-fallback">${escapeHtml(COMPANY.name)}</div>`}
        <div class="company-lines">${escapeHtml(COMPANY.address)}<br>${escapeHtml(COMPANY.contact)}</div>
      </div>

      <div class="title">
        <div>
          <h1>PRICE QUOTATION</h1>
          ${quotation.quoteNo ? `<span class="ref">Ref. No. ${escapeHtml(quotation.quoteNo)}</span>` : ""}
        </div>
      </div>

      <div class="info">
        <div class="panel">${fieldRows(clientFields)}</div>
        <div class="panel tinted">${fieldRows(soaFields)}</div>
        <div class="panel tinted">${fieldRows(receiptFields)}</div>
      </div>

      <table class="items">
        <colgroup>
          <col style="width:5%"><col style="width:11%"><col style="width:33%"><col style="width:11%">
          <col style="width:11%"><col style="width:13%"><col style="width:16%">
        </colgroup>
        <thead>
          <tr><th>NO.</th><th>DATE (mm/dd/yy)</th><th>ITEM/DESCRIPTION</th><th>SIZE/UNIT</th><th>QUANTITY</th><th>UNIT COST</th><th>AMOUNT</th></tr>
        </thead>
        <tbody>
          ${itemRows}
        </tbody>
      </table>

      <div class="total-row">
        <div class="total">
          <span class="label">TOTAL AMOUNT</span>
          <span class="amount">₱ ${formatMoney(quotation.totalAmount)}</span>
        </div>
      </div>

      <div class="closing">
      <div class="signatures">
        <div class="sig">
          <div class="heading">PREPARED BY:</div>
          <!-- Left blank: the preparer writes their name and signs by hand -->
          <div class="name"></div>
          <div class="line">PRINT NAME AND SIGNATURE</div>
        </div>
        <div class="sig">
          <div class="heading">RECEIVED BY:</div>
          <div class="name"></div>
          <div class="line">PRINT NAME AND SIGNATURE</div>
        </div>
      </div>

      <div class="footer">
        <span class="note">For any questions and further clarifications, feel free to contact us. We look forward to our continued relationship!</span>
        ${quotation.validUntil ? `<span class="validity">This quotation is valid until ${formatDocDate(quotation.validUntil)}.</span>` : ""}
      </div>
      </div>
    </div>
    <div class="brand-bar thin"></div>
  </div>
</body>
</html>`;
}
