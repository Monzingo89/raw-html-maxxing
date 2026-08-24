#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(rootDir, "public");

function booleanFrom(value, fallback) {
  if (value === undefined) return fallback;
  return /^(1|true|yes)$/i.test(String(value));
}

export function parseArgs(argv, env = process.env) {
  const args = {
    server: true,
    port: Number(env.PORT || 8787),
    host: env.HOST || "127.0.0.1",
    url: null,
    outFile: null,
    headless: booleanFrom(env.HEADLESS, false),
    browserChannel: env.BROWSER_CHANNEL || "chrome",
    userDataDir: path.resolve(env.USER_DATA_DIR || path.join(rootDir, ".tmp/browser-profile")),
    navTimeoutMs: Number(env.NAV_TIMEOUT_MS || 90_000),
    settleMs: Number(env.SETTLE_MS || 1_000),
    verificationTimeoutMs: Number(env.VERIFICATION_TIMEOUT_MS || 60_000),
    rateLimitMax: Number(env.RATE_LIMIT_MAX || 30),
    rateLimitWindowMs: Number(env.RATE_LIMIT_WINDOW_MS || 3_600_000),
    allowHosts: String(env.ALLOW_HOSTS || "ebay.com,www.ebay.com")
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
    corsOrigins: String(env.CORS_ORIGIN || "*")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--server") args.server = true;
    else if (token === "--url") {
      args.url = String(argv[++index] || "").trim();
      args.server = false;
    } else if (token.startsWith("--url=")) {
      args.url = token.slice(6).trim();
      args.server = false;
    } else if (token === "--out-file") args.outFile = String(argv[++index] || "").trim();
    else if (token.startsWith("--out-file=")) args.outFile = token.slice(11).trim();
    else if (token === "--host") args.host = String(argv[++index] || args.host);
    else if (token.startsWith("--host=")) args.host = token.slice(7);
    else if (token === "--port") args.port = Number(argv[++index]);
    else if (token.startsWith("--port=")) args.port = Number(token.slice(7));
    else if (token === "--headed") args.headless = false;
    else if (token === "--headless") args.headless = true;
    else if (token === "--browser-channel") args.browserChannel = String(argv[++index]);
    else if (token.startsWith("--browser-channel=")) args.browserChannel = token.slice(18);
    else if (token === "--user-data-dir") args.userDataDir = path.resolve(String(argv[++index]));
    else if (token.startsWith("--user-data-dir=")) args.userDataDir = path.resolve(token.slice(16));
    else if (token === "--nav-timeout-ms") args.navTimeoutMs = Number(argv[++index]);
    else if (token.startsWith("--nav-timeout-ms=")) args.navTimeoutMs = Number(token.slice(17));
    else if (token === "--settle-ms") args.settleMs = Number(argv[++index]);
    else if (token.startsWith("--settle-ms=")) args.settleMs = Number(token.slice(12));
    else if (token === "--allow-hosts") args.allowHosts = String(argv[++index]).split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
    else if (token.startsWith("--allow-hosts=")) args.allowHosts = token.slice(14).split(",").map((value) => value.trim().toLowerCase()).filter(Boolean);
  }

  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65_535) throw new Error("Port must be between 1 and 65535");
  if (!Number.isFinite(args.navTimeoutMs) || args.navTimeoutMs < 10_000) throw new Error("Navigation timeout must be at least 10000ms");
  if (!Number.isFinite(args.settleMs) || args.settleMs < 0) throw new Error("Settle time cannot be negative");
  if (!Number.isFinite(args.verificationTimeoutMs) || args.verificationTimeoutMs < 5_000) throw new Error("Verification timeout must be at least 5000ms");
  if (!Number.isInteger(args.rateLimitMax) || args.rateLimitMax < 1) throw new Error("Rate limit must be a positive integer");
  if (!Number.isFinite(args.rateLimitWindowMs) || args.rateLimitWindowMs < 1_000) throw new Error("Rate-limit window must be at least 1000ms");
  if (args.allowHosts.length === 0) throw new Error("At least one allowed host is required");
  return args;
}

export function createRateLimiter(maxRequests, windowMs) {
  const clients = new Map();
  return {
    consume(key, now = Date.now()) {
      const current = clients.get(key);
      if (!current || now >= current.resetAt) {
        clients.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, retryAfterSeconds: 0 };
      }
      if (current.count >= maxRequests) {
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1_000))
        };
      }
      current.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }
  };
}

export function parseAndValidateTargetUrl(input, allowHosts) {
  let parsed;
  try {
    parsed = new URL(String(input || ""));
  } catch {
    throw new Error("Enter a valid URL");
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error("Only HTTP and HTTPS URLs are allowed");
  const host = parsed.hostname.toLowerCase();
  const allowed = allowHosts.some((entry) => host === entry || host.endsWith(`.${entry}`));
  if (!allowed) throw new Error(`Host not allowed: ${host}`);
  return parsed.toString();
}

export function outputFilename(targetUrl) {
  const parsed = new URL(targetUrl);
  const query = parsed.searchParams.get("_nkw") || parsed.pathname.split("/").filter(Boolean).pop() || parsed.hostname;
  const slug = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72) || "capture";
  return `${slug}-${new Date().toISOString().replace(/[:.]/g, "-")}.html`;
}

export function isInteractiveBlock(title, body, url) {
  return /security measure|sign in or register|verification required/i.test(title)
    || /verify yourself|verify you are human|pardon our interruption|robot check|captcha/i.test(body)
    || /signin\.ebay\.com|\/splashui\/captcha/i.test(url);
}

async function captureStablePageContent(page, args) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
    await waitForManualVerification(page, args);
    if (args.settleMs > 0) await page.waitForTimeout(args.settleMs);

    try {
      const html = await page.content();
      // eBay can redirect after DOMContentLoaded, so inspect again immediately
      // before returning a sign-in or verification page as the requested HTML.
      await waitForManualVerification(page, args);
      if (page.url().includes("signin.ebay.com")) continue;
      return html;
    } catch (error) {
      lastError = error;
      if (!/navigating|changing the content/i.test(String(error?.message || error))) throw error;
      await page.waitForTimeout(1_000);
    }
  }
  throw lastError || new Error("The eBay page did not finish navigating");
}

async function waitForManualVerification(page, args) {
  const inspect = async () => ({
    title: String(await page.title().catch(() => "")),
    body: String(await page.locator("body").innerText().catch(() => "")).slice(0, 2_000),
    url: String(page.url())
  });
  let state = await inspect();
  if (!isInteractiveBlock(state.title, state.body, state.url)) return;
  if (args.headless) throw new Error("eBay authentication is required on the capture server.");
  console.log("[raw-html] Complete eBay verification in the opened browser window.");
  const deadline = Date.now() + args.verificationTimeoutMs;
  while (isInteractiveBlock(state.title, state.body, state.url)) {
    if (Date.now() >= deadline) {
      throw new Error("eBay authentication is required on the capture server. Please contact the site operator.");
    }
    await page.waitForTimeout(2_000);
    state = await inspect();
  }
}

export async function createCaptureSession(args) {
  const launchOptions = {
    headless: args.headless,
    viewport: { width: 1600, height: 1200 },
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36"
  };
  if (args.browserChannel && args.browserChannel !== "chromium") launchOptions.channel = args.browserChannel;

  const context = await chromium.launchPersistentContext(args.userDataDir, launchOptions);
  const page = context.pages()[0] || await context.newPage();
  let queue = Promise.resolve();

  const captureRawHtml = (targetUrl) => {
    const capture = async () => {
      await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: args.navTimeoutMs });
      return captureStablePageContent(page, args);
    };
    const result = queue.then(capture, capture);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };

  return { captureRawHtml, close: () => context.close() };
}

function corsOrigin(req, allowedOrigins) {
  if (allowedOrigins.includes("*")) return "*";
  const origin = req.headers.origin || "";
  return allowedOrigins.includes(origin) ? origin : "";
}

function setCors(req, res, allowedOrigins) {
  const origin = corsOrigin(req, allowedOrigins);
  if (origin) res.setHeader("access-control-allow-origin", origin);
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-expose-headers", "content-disposition, x-source-url, x-bytes");
  res.setHeader("vary", "Origin");
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 262_144) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

async function serveStatic(pathname, res) {
  const files = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/index.html": ["index.html", "text/html; charset=utf-8"],
    "/styles.css": ["styles.css", "text/css; charset=utf-8"],
    "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    "/config.js": ["config.js", "text/javascript; charset=utf-8"],
    "/favicon.ico": ["favicon.ico", "image/x-icon"],
    "/reference/pikachu-vmax-promo-sold.html": ["reference/pikachu-vmax-promo-sold.html", "text/html; charset=utf-8"]
  };
  const entry = files[pathname];
  if (!entry) return false;
  const body = await fs.readFile(path.join(publicDir, entry[0]));
  res.writeHead(200, { "content-type": entry[1], "cache-control": "no-store" });
  res.end(body);
  return true;
}

export async function runServer(args) {
  const session = await createCaptureSession(args);
  const rateLimiter = createRateLimiter(args.rateLimitMax, args.rateLimitWindowMs);
  const server = http.createServer(async (req, res) => {
    setCors(req, res, args.corsOrigins);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      const requestUrl = new URL(req.url || "/", `http://${args.host}:${args.port}`);
      if (req.method === "GET" && requestUrl.pathname === "/api/health") {
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if ((req.method === "POST" || req.method === "GET") && requestUrl.pathname === "/api/fetch") {
        const clientIp = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown")
          .split(",")[0]
          .trim();
        const rate = rateLimiter.consume(clientIp);
        if (!rate.allowed) {
          res.writeHead(429, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "retry-after": String(rate.retryAfterSeconds)
          });
          res.end("Too many captures. Try again later.");
          return;
        }
        const input = req.method === "POST" ? (await readJson(req)).url : requestUrl.searchParams.get("url");
        const targetUrl = parseAndValidateTargetUrl(input, args.allowHosts);
        const html = await session.captureRawHtml(targetUrl);
        const filename = outputFilename(targetUrl);
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          "cache-control": "no-store",
          "x-source-url": targetUrl,
          "x-bytes": String(Buffer.byteLength(html))
        });
        res.end(html);
        return;
      }

      if (req.method === "GET" && await serveStatic(requestUrl.pathname, res)) return;
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
    } catch (error) {
      const message = String(error?.message || error);
      const authRequired = /eBay authentication is required/i.test(message);
      const clientError = /valid URL|not allowed|HTTP|JSON|too large/i.test(message);
      res.writeHead(authRequired ? 503 : clientError ? 400 : 500, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
      res.end(message);
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(args.port, args.host, resolve);
  });
  console.log(`[raw-html] listening on http://${args.host}:${args.port}`);

  const shutdown = async (signal) => {
    console.log(`[raw-html] ${signal}; shutting down`);
    await new Promise((resolve) => server.close(resolve));
    await session.close();
  };
  process.once("SIGINT", () => shutdown("SIGINT").finally(() => process.exit(0)));
  process.once("SIGTERM", () => shutdown("SIGTERM").finally(() => process.exit(0)));
  return server;
}

async function runOneShot(args) {
  if (!args.url || !args.outFile) throw new Error("One-shot mode requires --url and --out-file");
  const targetUrl = parseAndValidateTargetUrl(args.url, args.allowHosts);
  const session = await createCaptureSession(args);
  try {
    const html = await session.captureRawHtml(targetUrl);
    const outputPath = path.resolve(args.outFile);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, html, "utf8");
    console.log(JSON.stringify({ ok: true, url: targetUrl, outFile: outputPath, bytes: Buffer.byteLength(html) }, null, 2));
  } finally {
    await session.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.server) await runServer(args);
  else await runOneShot(args);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(`[raw-html] ${error?.message || error}`);
    process.exit(1);
  });
}
