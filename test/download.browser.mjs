import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const publicDir = path.join(root, "public");
const expectedPath = path.join(root, "reference/ebay-full-html/pikachu-vmax-promo-sold.html");
const testUrl = "https://www.ebay.com/sch/183454/i.html?_from=R40&_dmd=1&_nkw=pikachu+vmax+promo&rt=nc&LH_Sold=1";
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};

function digest(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

const server = http.createServer(async (req, res) => {
  try {
    const requestPath = new URL(req.url || "/", "http://127.0.0.1").pathname;
    const relative = requestPath === "/" ? "index.html" : requestPath.slice(1);
    const filePath = path.resolve(publicDir, relative);
    if (!filePath.startsWith(`${publicDir}${path.sep}`)) throw new Error("Not found");
    const body = await fs.readFile(filePath);
    res.writeHead(200, { "content-type": mime[path.extname(filePath)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

let browser;
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ acceptDownloads: true });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil: "networkidle" });
  const screenshotPath = path.join(root, ".tmp/pikachu-acceptance.png");
  await fs.mkdir(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath, fullPage: true });

  await page.locator("#url-input").fill(testUrl);
  assert.equal(await page.locator("#fetch-button").isEnabled(), true);

  const downloadPromise = page.waitForEvent("download");
  await page.locator("#fetch-button").click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  const [actual, expected] = await Promise.all([fs.readFile(downloadPath), fs.readFile(expectedPath)]);

  assert.equal(download.suggestedFilename(), "pikachu-vmax-promo-sold.html");
  assert.equal(actual.length, expected.length);
  assert.equal(digest(actual), digest(expected));
  assert.equal(await page.locator("#url-input").inputValue(), "");
  assert.equal(await page.locator("#fetch-button").isDisabled(), true);
  assert.deepEqual(consoleErrors, []);

  console.log(JSON.stringify({
    passed: true,
    filename: download.suggestedFilename(),
    bytes: actual.length,
    sha256: digest(actual),
    inputCleared: true,
    fetchDisabled: true,
    screenshot: screenshotPath
  }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
