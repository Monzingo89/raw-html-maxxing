#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { URL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function requireWorkspaceDependency(name) {
  try {
    return require(name);
  } catch {
    return require(
      path.resolve(process.cwd(), "apps", "vcv", "node_modules", name),
    );
  }
}

function resolveChromium() {
  try {
    const playwright = requireWorkspaceDependency("playwright");
    if (playwright?.chromium) return playwright.chromium;
  } catch {
    // fall through
  }
  const playwrightTest = requireWorkspaceDependency("@playwright/test");
  if (playwrightTest?.chromium) return playwrightTest.chromium;
  throw new Error(
    "Could not resolve Playwright chromium. Install playwright or @playwright/test.",
  );
}

function parseArgs(argv) {
  const args = {
    server: false,
    port: 8787,
    host: "127.0.0.1",
    url: null,
    outFile: null,
    headless: false,
    browserChannel: "chrome",
    userDataDir: path.resolve(
      process.cwd(),
      ".tmp/ebay-playwright-profile-html-capture",
    ),
    navTimeoutMs: 90_000,
    settleMs: 1_000,
    allowHosts: ["ebay.com", "www.ebay.com"],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--server") args.server = true;
    else if (token === "--port") args.port = Number(argv[++i]);
    else if (token.startsWith("--port="))
      args.port = Number(token.slice("--port=".length));
    else if (token === "--host") args.host = String(argv[++i] || args.host);
    else if (token.startsWith("--host="))
      args.host = String(token.slice("--host=".length));
    else if (token === "--url") args.url = String(argv[++i] || "").trim();
    else if (token.startsWith("--url="))
      args.url = String(token.slice("--url=".length)).trim();
    else if (token === "--out-file")
      args.outFile = String(argv[++i] || "").trim();
    else if (token.startsWith("--out-file="))
      args.outFile = String(token.slice("--out-file=".length)).trim();
    else if (token === "--headed") args.headless = false;
    else if (token === "--headless") args.headless = true;
    else if (token === "--browser-channel")
      args.browserChannel = String(argv[++i] || args.browserChannel);
    else if (token.startsWith("--browser-channel="))
      args.browserChannel = String(token.slice("--browser-channel=".length));
    else if (token === "--user-data-dir")
      args.userDataDir = path.resolve(
        process.cwd(),
        String(argv[++i] || "").trim(),
      );
    else if (token.startsWith("--user-data-dir="))
      args.userDataDir = path.resolve(
        process.cwd(),
        String(token.slice("--user-data-dir=".length)).trim(),
      );
    else if (token === "--nav-timeout-ms")
      args.navTimeoutMs = Number(argv[++i]);
    else if (token.startsWith("--nav-timeout-ms="))
      args.navTimeoutMs = Number(token.slice("--nav-timeout-ms=".length));
    else if (token === "--settle-ms") args.settleMs = Number(argv[++i]);
    else if (token.startsWith("--settle-ms="))
      args.settleMs = Number(token.slice("--settle-ms=".length));
    else if (token === "--allow-hosts") {
      args.allowHosts = String(argv[++i] || "")
        .split(",")
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
    } else if (token.startsWith("--allow-hosts=")) {
      args.allowHosts = String(token.slice("--allow-hosts=".length))
        .split(",")
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean);
    }
  }

  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65_535) {
    throw new Error("--port must be an integer between 1 and 65535");
  }
  if (!Number.isFinite(args.navTimeoutMs) || args.navTimeoutMs < 10_000) {
    throw new Error("--nav-timeout-ms must be >= 10000");
  }
  if (!Number.isFinite(args.settleMs) || args.settleMs < 0) {
    throw new Error("--settle-ms must be >= 0");
  }
  if (!Array.isArray(args.allowHosts) || args.allowHosts.length === 0) {
    throw new Error("--allow-hosts must include at least one host");
  }

  return args;
}

function printHelp() {
  console.log(`
Usage:
  node tools/scripts/quick-grade/rag/ebay-capture-sold-html.mjs --server [options]
  node tools/scripts/quick-grade/rag/ebay-capture-sold-html.mjs --url <https://...> --out-file <file.html> [options]

Purpose:
  Capture and return FULL raw HTML for eBay sold-search pages using a persistent browser profile.
  HTML is returned/written exactly as produced by page.content() (no post-processing).

Options:
  --server                       Run HTTP server mode (endpoint: GET /?url=<encoded_url>)
  --url <url>                    One-shot capture URL
  --out-file <path>              One-shot output HTML file path
  --host <host>                  Server bind host (default: 127.0.0.1)
  --port <port>                  Server port (default: 8787)
  --headed | --headless          Browser mode (default: headed)
  --browser-channel <name>       Browser channel (default: chrome)
  --user-data-dir <path>         Persistent profile dir
  --nav-timeout-ms <ms>          Navigation timeout (default: 90000)
  --settle-ms <ms>               Wait after navigation before capture (default: 1000)
  --allow-hosts <h1,h2,...>      Allowed URL hosts (default: ebay.com,www.ebay.com)

Examples:
  node tools/scripts/quick-grade/rag/ebay-capture-sold-html.mjs --server --port 8787 --headed
  node tools/scripts/quick-grade/rag/ebay-capture-sold-html.mjs --url "https://www.ebay.com/sch/183454/i.html?_from=R40&_dmd=1&_nkw=pikachu+vmax+promo&rt=nc&LH_Sold=1" --out-file data/quick-grade/testing/ebay-psa/raw-sold-page.html --headed
`);
}

function parseAndValidateTargetUrl(input, allowHosts) {
  let parsed;
  try {
    parsed = new URL(String(input || ""));
  } catch {
    throw new Error("Invalid URL");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http/https URLs are allowed");
  }

  const host = parsed.hostname.toLowerCase();
  const allowed = allowHosts.some((h) => host === h || host.endsWith(`.${h}`));
  if (!allowed) {
    throw new Error(`Host not allowed: ${host}`);
  }

  return parsed.toString();
}

function isEbayInteractiveBlock(pageTitle, bodyPreview, pageUrl) {
  return (
    /security measure|sign in or register|verification required/i.test(
      pageTitle,
    ) ||
    /verify yourself|verify you are human|pardon our interruption|robot check|captcha/i.test(
      bodyPreview,
    ) ||
    /signin\.ebay\.com|\/splashui\/captcha/i.test(pageUrl)
  );
}

async function waitForManualVerificationIfNeeded(page) {
  let title = String(await page.title().catch(() => "")).trim();
  let bodyPreview = String(
    await page
      .locator("body")
      .innerText()
      .catch(() => ""),
  ).slice(0, 2000);
  let currentUrl = String(page.url?.() ?? "");

  if (!isEbayInteractiveBlock(title, bodyPreview, currentUrl)) return;

  console.log(
    "[ebay-html-capture] eBay sign-in/verification required; complete it in the opened browser window.",
  );

  while (isEbayInteractiveBlock(title, bodyPreview, currentUrl)) {
    await page.waitForTimeout(2_000);
    title = String(await page.title().catch(() => "")).trim();
    bodyPreview = String(
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    ).slice(0, 2000);
    currentUrl = String(page.url?.() ?? "");
  }
}

async function createCaptureSession(args) {
  const chromium = resolveChromium();

  const context = await chromium.launchPersistentContext(args.userDataDir, {
    headless: args.headless,
    channel: args.browserChannel,
    viewport: { width: 1600, height: 1200 },
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36",
  });

  const page = context.pages()[0] || (await context.newPage());

  let inFlight = Promise.resolve();

  async function captureRawHtml(targetUrl) {
    const run = async () => {
      await page.goto(targetUrl, {
        waitUntil: "domcontentloaded",
        timeout: args.navTimeoutMs,
      });
      await page
        .waitForLoadState("domcontentloaded", { timeout: args.navTimeoutMs })
        .catch(() => undefined);

      await waitForManualVerificationIfNeeded(page);

      if (args.settleMs > 0) {
        await page.waitForTimeout(args.settleMs);
      }

      // IMPORTANT: unaltered HTML payload from browser DOM serialization.
      return page.content();
    };

    // Serialize requests to avoid page/context collisions.
    const next = inFlight.then(run, run);
    inFlight = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async function close() {
    await context.close();
  }

  return { captureRawHtml, close };
}

async function runOneShot(args) {
  if (!args.url) throw new Error("--url is required for one-shot mode");
  if (!args.outFile)
    throw new Error("--out-file is required for one-shot mode");

  const targetUrl = parseAndValidateTargetUrl(args.url, args.allowHosts);
  const session = await createCaptureSession(args);
  try {
    const html = await session.captureRawHtml(targetUrl);
    const outputPath = path.resolve(process.cwd(), args.outFile);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, html, "utf8");
    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: "one-shot",
          url: targetUrl,
          outFile: outputPath,
          bytes: Buffer.byteLength(html, "utf8"),
          headless: args.headless,
          browserChannel: args.browserChannel,
          userDataDir: args.userDataDir,
        },
        null,
        2,
      ),
    );
  } finally {
    await session.close();
  }
}

async function runServer(args) {
  const session = await createCaptureSession(args);

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("Missing request URL");
        return;
      }

      const requestUrl = new URL(req.url, `http://${args.host}:${args.port}`);
      const target = requestUrl.searchParams.get("url");

      if (!target) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("Query parameter 'url' is required");
        return;
      }

      const targetUrl = parseAndValidateTargetUrl(target, args.allowHosts);
      const html = await session.captureRawHtml(targetUrl);

      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-source-url": targetUrl,
        "x-bytes": String(Buffer.byteLength(html, "utf8")),
      });
      res.end(html);
    } catch (error) {
      const message = String(error?.message || error);
      res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      res.end(message);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.port, args.host, resolve);
  });

  console.log(
    `[ebay-html-capture] listening on http://${args.host}:${args.port} (GET /?url=<encoded_url>)`,
  );
  console.log(
    `[ebay-html-capture] allow-hosts=${args.allowHosts.join(",")} headless=${args.headless} channel=${args.browserChannel}`,
  );

  const shutdown = async (signal) => {
    console.log(`[ebay-html-capture] received ${signal}; shutting down...`);
    await new Promise((resolve) => server.close(resolve));
    await session.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    shutdown("SIGINT").catch((error) => {
      console.error(
        `[ebay-html-capture] shutdown error: ${error?.message || error}`,
      );
      process.exit(1);
    });
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM").catch((error) => {
      console.error(
        `[ebay-html-capture] shutdown error: ${error?.message || error}`,
      );
      process.exit(1);
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    return;
  }

  const args = parseArgs(argv);

  if (args.server) {
    await runServer(args);
    return;
  }

  await runOneShot(args);
}

main().catch((error) => {
  console.error(`[ebay-html-capture] ${error?.message || error}`);
  process.exit(1);
});
