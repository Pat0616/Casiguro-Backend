// backend/utils/pdfRenderer.js
import puppeteer from "puppeteer";

// One shared headless browser; each PDF gets its own page. Relaunched if Chrome exits.
// Chrome holds roughly 150–250 MB, so on a small server it is closed after PDF_BROWSER_IDLE_MS without a render
// (default 5 minutes; 0 keeps it open). The next PDF then takes a second or two longer while Chrome starts.
const IDLE_MS = Number(process.env.PDF_BROWSER_IDLE_MS ?? 5 * 60 * 1000);

let browserPromise = null;
let activeRenders = 0;
let idleTimer = null;

function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch({
        headless: true,
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote", "--disable-extensions"],
      })
      .then((browser) => {
        browser.on("disconnected", () => {
          browserPromise = null;
        });
        return browser;
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

export async function closePdfBrowser() {
  clearTimeout(idleTimer);
  const pending = browserPromise;
  browserPromise = null;
  if (!pending) return;
  try {
    const browser = await pending;
    await browser.close();
  } catch {
    // already gone
  }
}

function scheduleIdleClose() {
  clearTimeout(idleTimer);
  if (!(IDLE_MS > 0)) return;
  idleTimer = setTimeout(() => {
    if (activeRenders === 0) closePdfBrowser();
  }, IDLE_MS);
  idleTimer.unref();
}

export async function renderPdf(html, { landscape = false } = {}) {
  clearTimeout(idleTimer);
  activeRenders += 1;
  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    try {
      await page.setContent(html, { waitUntil: "load" });
      const pdf = await page.pdf({
        format: "A4",
        landscape,
        printBackground: true,
        margin: { top: "10mm", right: "10mm", bottom: "10mm", left: "10mm" },
      });
      return Buffer.from(pdf);
    } finally {
      await page.close();
    }
  } finally {
    activeRenders -= 1;
    if (activeRenders === 0) scheduleIdleClose();
  }
}
