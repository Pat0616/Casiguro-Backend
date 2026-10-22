// backend/templates/quotationTemplate.js
// HTML for the printable PRICE QUOTATION (A4 landscape), rendered to PDF by utils/pdfRenderer.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const COMPANY = {
  name: "Casiguro",
  suffix: "ENTERPRISES INC,",
  address: "#6 & 7 Marem Building, Corner Jb Alegre Street & Habana Street, Casiguran, Sorsogon",
  contact: "Contact Nos.: 09688817969/09203757810   E-mail add: casiguro.printingservices@gmail.com",
};

const MIN_ITEM_ROWS = 8;
const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "assets");
const LOGO_TYPES = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml" };

// Drop a file named casiguro-logo.(png|jpg|jpeg|svg) into templates/assets to replace the text placeholder.
// Read on every render so a new logo shows up without restarting the server.
function loadLogoDataUri() {
  for (const [ext, mime] of Object.entries(LOGO_TYPES)) {
    const file = path.join(ASSETS_DIR, `casiguro-logo${ext}`);
    if (fs.existsSync(file)) {
      return `data:${mime};base64,${fs.readFileSync(file).toString("base64")}`;
    }
  }
  return null;
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

/**
 * @param {object} data
 * @param {object} data.quotation  quoteNo, customerName, contactNumber, totalAmount, preparedBy
 * @param {object[]} data.items    itemName, selectedVariant, quantity, finalUnitPrice, subtotal
 * @param {object|null} data.order converted order's soaNo, soaDate, prNo, poNo, siOrNo, siOrDate, drNo, drDate
 */
export function renderQuotationHtml({ quotation, items, order }) {
  const logo = loadLogoDataUri();
  const doc = order || {};

  const infoRows = [
    ["CLIENT NAME:", quotation.customerName, "SOA NO.:", doc.soaNo, "S.I. NO./O.R. NO.:", doc.siOrNo],
    ["ADDRESS:", "", "SOA DATE:", formatDocDate(doc.soaDate), "S.I./O.R. DATE:", formatDocDate(doc.siOrDate)],
    ["CONTACT PERSON:", "", "P.R. NO.:", doc.prNo, "D.R. NO.:", doc.drNo],
    ["CONTACT NO.:", quotation.contactNumber, "P.O. NO.:", doc.poNo, "D.R. DATE:", formatDocDate(doc.drDate)],
  ];

  const rowCount = Math.max(MIN_ITEM_ROWS, items.length);
  const itemRows = Array.from({ length: rowCount }, (_, i) => {
    const it = items[i];
    if (!it) {
      return `<tr><td class="c">${i + 1}</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`;
    }
    return `<tr>
      <td class="c">${i + 1}</td>
      <td></td>
      <td class="c">${escapeHtml(it.itemName)}</td>
      <td class="c">${escapeHtml(it.selectedVariant || "")}</td>
      <td class="c">${escapeHtml(it.quantity)}</td>
      <td class="r">${formatUnitCost(it.finalUnitPrice)}</td>
      <td class="r">${formatMoney(it.subtotal)}</td>
    </tr>`;
  }).join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Price Quotation ${escapeHtml(quotation.quoteNo)}</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Calibri, Arial, sans-serif; font-size: 10.5pt; color: #000; }
  .sheet { border: 1.5px solid #000; padding: 0 0 6px; }

  .letterhead { display: flex; align-items: center; justify-content: center; gap: 14px; padding: 12px 16px 4px; }
  .logo-slot { width: 220px; height: 64px; display: flex; align-items: center; justify-content: center; }
  .logo-slot img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .logo-placeholder { font-family: "Brush Script MT", "Segoe Script", cursive; font-style: italic; font-weight: 700;
    font-size: 34pt; color: #1f4e9c; letter-spacing: .5px; }
  .company-suffix { font-family: "Courier New", monospace; font-size: 19pt; color: #2b4f9e; }
  .company-lines { font-size: 7.5pt; text-align: center; line-height: 1.5; margin-top: -2px; }
  h1 { font-family: "Arial Black", Arial, sans-serif; font-size: 18pt; text-align: center; margin: 8px 0 6px; letter-spacing: .3px; }

  .info { width: 100%; border-collapse: collapse; border-top: 1.5px solid #000; }
  .info td { padding: 1px 4px; font-weight: 700; font-size: 9.5pt; height: 16px; white-space: nowrap; }
  .info .client { width: 52%; border-bottom: 1px solid #000; }
  .info .client span { font-weight: 700; }
  .info .lbl { width: 11%; }
  .info .val { width: 12.5%; border-bottom: 1px solid #000; font-weight: 400; text-align: left; }
  .info .gap { width: 1%; }

  .items { width: 100%; border-collapse: collapse; margin-top: 4px; }
  .items th, .items td { border: 1px solid #000; padding: 1px 5px; height: 16px; font-size: 9.5pt; }
  .items th { font-weight: 700; text-align: center; border-top: 1.5px solid #000; border-bottom: 1.5px solid #000; }
  .items td.c { text-align: center; }
  .items td.r { text-align: right; }
  .items .total td { border: none; font-weight: 700; padding-top: 3px; }
  .items .total .amount { border-bottom: 3px double #000; text-align: right; }

  .signatures { display: flex; justify-content: space-between; padding: 40px 110px 0 50px; font-weight: 700; font-size: 9.5pt; }
  .sig { display: flex; flex-direction: column; }
  .sig .name { margin-top: 30px; padding-left: 14px; font-weight: 400; min-height: 14px; }
  .sig .line { border-top: 1px solid #000; margin-top: 2px; padding-top: 2px; white-space: nowrap; }
  .sig.prepared .line { width: 400px; }
  .sig.received { width: 200px; }
  .note { font-size: 7pt; font-style: italic; padding: 22px 4px 0; }
</style>
</head>
<body>
  <div class="sheet">
    <div class="letterhead">
      <div class="logo-slot">
        ${logo ? `<img src="${logo}" alt="Casiguro">` : `<span class="logo-placeholder">${escapeHtml(COMPANY.name)}</span>`}
      </div>
      <div>
        <div class="company-suffix">${escapeHtml(COMPANY.suffix)}</div>
        <div class="company-lines">${escapeHtml(COMPANY.address)}<br>${escapeHtml(COMPANY.contact)}</div>
      </div>
    </div>
    <h1>PRICE QUOTATION</h1>

    <table class="info">
      ${infoRows
        .map(
          ([clientLabel, clientValue, midLabel, midValue, rightLabel, rightValue]) => `<tr>
        <td class="client">${clientLabel} <span>${escapeHtml(clientValue)}</span></td>
        <td class="gap"></td>
        <td class="lbl">${midLabel}</td>
        <td class="val">${escapeHtml(midValue)}</td>
        <td class="gap"></td>
        <td class="lbl">${rightLabel}</td>
        <td class="val">${escapeHtml(rightValue)}</td>
      </tr>`
        )
        .join("")}
    </table>

    <table class="items">
      <colgroup>
        <col style="width:4.5%"><col style="width:11%"><col style="width:33%"><col style="width:11.5%">
        <col style="width:13%"><col style="width:13%"><col style="width:14%">
      </colgroup>
      <thead>
        <tr><th>NO.</th><th>DATE (mm/dd/yy)</th><th>ITEM/DESCRIPTION</th><th>SIZE/UNIT</th><th>QUANTITY</th><th>UNIT COST</th><th>AMOUNT</th></tr>
      </thead>
      <tbody>
        ${itemRows}
        <tr class="total">
          <td colspan="5"></td>
          <td class="r">TOTAL AMOUNT</td>
          <td class="amount">${formatMoney(quotation.totalAmount)}</td>
        </tr>
      </tbody>
    </table>

    <div class="signatures">
      <div class="sig prepared">
        <span>PREPARED BY:</span>
        <span class="name">${escapeHtml((quotation.preparedBy || "").toUpperCase())}</span>
        <span class="line">PRINT NAME AND SIGNATURE</span>
      </div>
      <div class="sig received">
        <span>RECEIVED BY:</span>
        <span class="name"></span>
        <span class="line">PRINT NAME AND SIGNATURE</span>
      </div>
    </div>

    <div class="note">For any questions and further clarifications, feel free to contact us. We look forward to our continued relationship!</div>
  </div>
</body>
</html>`;
}
