#!/usr/bin/env node
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(rootDir, "public");
const swaggerUiDir = path.join(rootDir, "node_modules", "swagger-ui-dist");

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
    verificationTimeoutMs: Number(env.VERIFICATION_TIMEOUT_MS ?? 0),
    rateLimitMax: Number(env.RATE_LIMIT_MAX || 10_000),
    rateLimitWindowMs: Number(env.RATE_LIMIT_WINDOW_MS || 86_400_000),
    globalRateLimitMax: Number(env.GLOBAL_RATE_LIMIT_MAX || 10_000),
    globalRateLimitWindowMs: Number(env.GLOBAL_RATE_LIMIT_WINDOW_MS || 86_400_000),
    dailyRateLimitMax: Number(env.DAILY_RATE_LIMIT_MAX || 10_000),
    dailyRateLimitWindowMs: Number(env.DAILY_RATE_LIMIT_WINDOW_MS || 86_400_000),
    captureDailyRateLimitMax: Number(env.CAPTURE_DAILY_RATE_LIMIT_MAX || 10_000),
    stateFile: path.resolve(env.RATE_LIMIT_STATE_FILE || path.join(rootDir, ".tmp/rate-limit-state.json")),
    cacheDir: path.resolve(env.CACHE_DIR || path.join(rootDir, ".tmp/capture-cache")),
    cacheTtlMs: Number(env.CACHE_TTL_MS || 172_800_000),
    captureDelayMinMs: Number(env.CAPTURE_DELAY_MIN_MS || 4_640),
    captureDelayMaxMs: Number(env.CAPTURE_DELAY_MAX_MS || 5_640),
    batchDir: path.resolve(env.BATCH_DIR || path.join(rootDir, ".tmp/batches")),
    batchMaxUrls: Number(env.BATCH_MAX_URLS || 10_000),
    batchRequestMaxBytes: Number(env.BATCH_REQUEST_MAX_BYTES || 33_554_432),
    batchStartIntervalMs: Number(env.BATCH_START_INTERVAL_MS || 8_640),
    batchMinimumSleepMs: Number(env.BATCH_MINIMUM_SLEEP_MS || 4_640),
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
  if (!Number.isFinite(args.verificationTimeoutMs) || (args.verificationTimeoutMs !== 0 && args.verificationTimeoutMs < 5_000)) {
    throw new Error("Verification timeout must be 0 (unlimited) or at least 5000ms");
  }
  if (!Number.isInteger(args.rateLimitMax) || args.rateLimitMax < 1) throw new Error("Rate limit must be a positive integer");
  if (!Number.isFinite(args.rateLimitWindowMs) || args.rateLimitWindowMs < 1_000) throw new Error("Rate-limit window must be at least 1000ms");
  if (!Number.isInteger(args.globalRateLimitMax) || args.globalRateLimitMax < 1) throw new Error("Global rate limit must be a positive integer");
  if (!Number.isFinite(args.globalRateLimitWindowMs) || args.globalRateLimitWindowMs < 1_000) throw new Error("Global rate-limit window must be at least 1000ms");
  if (!Number.isInteger(args.dailyRateLimitMax) || args.dailyRateLimitMax < 1) throw new Error("Daily rate limit must be a positive integer");
  if (!Number.isFinite(args.dailyRateLimitWindowMs) || args.dailyRateLimitWindowMs < 1_000) throw new Error("Daily rate-limit window must be at least 1000ms");
  if (!Number.isInteger(args.captureDailyRateLimitMax) || args.captureDailyRateLimitMax < 1) throw new Error("Daily capture limit must be a positive integer");
  if (!Number.isFinite(args.cacheTtlMs) || args.cacheTtlMs < 1_000) throw new Error("Cache TTL must be at least 1000ms");
  if (!Number.isFinite(args.captureDelayMinMs) || args.captureDelayMinMs < 0) throw new Error("Minimum capture delay cannot be negative");
  if (!Number.isFinite(args.captureDelayMaxMs) || args.captureDelayMaxMs < args.captureDelayMinMs) throw new Error("Maximum capture delay must be at least the minimum");
  if (!Number.isInteger(args.batchMaxUrls) || args.batchMaxUrls < 1) throw new Error("Batch URL limit must be a positive integer");
  if (!Number.isInteger(args.batchRequestMaxBytes) || args.batchRequestMaxBytes < 1_024) throw new Error("Batch request size limit must be at least 1024 bytes");
  if (!Number.isFinite(args.batchStartIntervalMs) || args.batchStartIntervalMs < 1_000) throw new Error("Batch start interval must be at least 1000ms");
  if (!Number.isFinite(args.batchMinimumSleepMs) || args.batchMinimumSleepMs < 0) throw new Error("Batch minimum sleep cannot be negative");
  if (args.allowHosts.length === 0) throw new Error("At least one allowed host is required");
  return args;
}

export function createRollingRateLimiter(maxRequests, windowMs, initialEvents = []) {
  let events = initialEvents.filter((timestamp) => Number.isFinite(timestamp)).sort((a, b) => a - b);
  const prune = (now) => {
    const cutoff = now - windowMs;
    let firstCurrent = 0;
    while (firstCurrent < events.length && events[firstCurrent] <= cutoff) firstCurrent += 1;
    if (firstCurrent > 0) events = events.slice(firstCurrent);
  };
  return {
    consume(now = Date.now()) {
      prune(now);
      if (events.length >= maxRequests) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((events[0] + windowMs - now) / 1_000))
        };
      }
      events.push(now);
      return { allowed: true, remaining: maxRequests - events.length, retryAfterSeconds: 0 };
    },
    snapshot(now = Date.now()) {
      prune(now);
      return [...events];
    }
  };
}

export function randomDelayMs(minMs, maxMs, random = Math.random) {
  return Math.floor(minMs + random() * (maxMs - minMs + 1));
}

export function nextBatchCaptureAt(startedAt, finishedAt, startIntervalMs, minimumSleepMs) {
  return Math.max(startedAt + startIntervalMs, finishedAt + minimumSleepMs);
}

function cachePath(cacheDir, targetUrl) {
  const key = crypto.createHash("sha256").update(targetUrl).digest("hex");
  return path.join(cacheDir, `${key}.html`);
}

export function createHtmlCache(cacheDir, ttlMs) {
  let lastPruneAt = 0;
  const prune = async (now = Date.now()) => {
    let entries;
    try {
      entries = await fs.readdir(cacheDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return 0;
      throw error;
    }
    let removed = 0;
    await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".html")).map(async (entry) => {
      const file = path.join(cacheDir, entry.name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat && now - stat.mtimeMs > ttlMs) {
        await fs.unlink(file).catch(() => {});
        removed += 1;
      }
    }));
    lastPruneAt = now;
    return removed;
  };
  return {
    async get(targetUrl, now = Date.now()) {
      const file = cachePath(cacheDir, targetUrl);
      try {
        const stat = await fs.stat(file);
        if (now - stat.mtimeMs > ttlMs) {
          await fs.unlink(file).catch(() => {});
          return null;
        }
        return await fs.readFile(file, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },
    async set(targetUrl, html) {
      await fs.mkdir(cacheDir, { recursive: true });
      if (Date.now() - lastPruneAt >= 3_600_000) await prune();
      const file = cachePath(cacheDir, targetUrl);
      const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporary, html, "utf8");
      await fs.rename(temporary, file);
    },
    prune
  };
}

async function readRateLimitState(stateFile) {
  try {
    const parsed = JSON.parse(await fs.readFile(stateFile, "utf8"));
    return {
      requests: Array.isArray(parsed.requests) ? parsed.requests : [],
      captures: Array.isArray(parsed.captures) ? parsed.captures : []
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { requests: [], captures: [] };
    throw new Error(`Cannot read rate-limit state: ${error?.message || error}`);
  }
}

function createRateLimitStateWriter(stateFile, requestLimiter, captureLimiter) {
  let writeQueue = Promise.resolve();
  return () => {
    writeQueue = writeQueue.then(async () => {
      await fs.mkdir(path.dirname(stateFile), { recursive: true });
      const temporary = `${stateFile}.${process.pid}.tmp`;
      const state = JSON.stringify({
        requests: requestLimiter.snapshot(),
        captures: captureLimiter.snapshot()
      });
      await fs.writeFile(temporary, state, "utf8");
      await fs.rename(temporary, stateFile);
    });
    return writeQueue;
  };
}

export function createRateLimiter(maxRequests, windowMs) {
  const clients = new Map();
  return {
    consume(key, now = Date.now()) {
      const current = clients.get(key);
      if (!current || now >= current.resetAt) {
        clients.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, remaining: maxRequests - 1, retryAfterSeconds: 0 };
      }
      if (current.count >= maxRequests) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1_000))
        };
      }
      current.count += 1;
      return { allowed: true, remaining: maxRequests - current.count, retryAfterSeconds: 0 };
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

export function parseDistinctBatchUrls(input, allowHosts, maxUrls = 10_000) {
  if (!Array.isArray(input)) throw new Error("Batch request must include a urls array");
  if (input.length < 1) throw new Error("Batch request must include at least one URL");
  if (input.length > maxUrls) throw new Error(`Batch request cannot exceed ${maxUrls.toLocaleString("en-US")} URLs`);
  const urls = input.map((value) => parseAndValidateTargetUrl(value, allowHosts));
  if (new Set(urls).size !== urls.length) throw new Error("Batch URLs must be distinct");
  return urls;
}

export function outputFilename(targetUrl) {
  const parsed = new URL(targetUrl);
  const query = parsed.searchParams.get("_nkw") || parsed.pathname.split("/").filter(Boolean).pop() || parsed.hostname;
  const slug = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72) || "capture";
  const soldSuffix = parsed.searchParams.get("LH_Sold") === "1" ? "-sold" : "";
  return `${slug}${soldSuffix}.html`;
}

export function isInteractiveBlock(title, body, url) {
  return /security measure|sign in or register|verification required/i.test(title)
    || /verify yourself|verify you are human|pardon our interruption|robot check|captcha/i.test(body)
    || /signin\.ebay\.com|\/splashui\/captcha/i.test(url);
}

export function minimumCaptureLength(targetUrl) {
  const parsed = new URL(targetUrl);
  return /\/sch(?:\/|$)/i.test(parsed.pathname) ? 250_000 : 25_000;
}

async function waitForCaptureReady(page, targetUrl, args) {
  const minimumLength = minimumCaptureLength(targetUrl);
  await page.waitForFunction(
    (minimum) => (document.documentElement?.outerHTML.length || 0) >= minimum,
    minimumLength,
    { timeout: args.navTimeoutMs }
  );
}

async function captureStablePageContent(page, targetUrl, args) {
  let lastError;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await page.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => {});
    await waitForManualVerification(page, args);
    await waitForCaptureReady(page, targetUrl, args);
    if (args.settleMs > 0) await page.waitForTimeout(args.settleMs);

    try {
      const html = await page.content();
      // eBay can redirect after DOMContentLoaded, so inspect again immediately
      // before returning a sign-in or verification page as the requested HTML.
      await waitForManualVerification(page, args);
      if (page.url().includes("signin.ebay.com")) continue;
      if (html.length < minimumCaptureLength(targetUrl)) continue;
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
  const deadline = args.verificationTimeoutMs === 0 ? null : Date.now() + args.verificationTimeoutMs;
  while (isInteractiveBlock(state.title, state.body, state.url)) {
    if (deadline !== null && Date.now() >= deadline) {
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
      return captureStablePageContent(page, targetUrl, args);
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
  res.setHeader("access-control-expose-headers", "content-disposition, retry-after, x-source-url, x-bytes, x-cache, x-rate-limit-policy");
  res.setHeader("vary", "Origin");
}

async function readJson(req, maxBytes = 262_144) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("Request is too large");
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
    "/reference/pikachu-vmax-promo-sold.html": ["reference/pikachu-vmax-promo-sold.html", "text/html; charset=utf-8"],
    "/api/docs": ["api-docs.html", "text/html; charset=utf-8"],
    "/api/docs/": ["api-docs.html", "text/html; charset=utf-8"],
    "/api/openapi.json": ["openapi.json", "application/json; charset=utf-8"]
  };
  const entry = files[pathname];
  const swaggerAssets = {
    "/api/docs/swagger-ui.css": ["swagger-ui.css", "text/css; charset=utf-8"],
    "/api/docs/swagger-ui-bundle.js": ["swagger-ui-bundle.js", "text/javascript; charset=utf-8"]
  };
  const swaggerEntry = swaggerAssets[pathname];
  if (!entry && !swaggerEntry) return false;
  const body = await fs.readFile(path.join(swaggerEntry ? swaggerUiDir : publicDir, (swaggerEntry || entry)[0]));
  res.writeHead(200, { "content-type": (swaggerEntry || entry)[1], "cache-control": "no-store" });
  res.end(body);
  return true;
}

function batchMetaPath(batchDir, batchId) {
  return path.join(batchDir, `${batchId}.json`);
}

function batchProgressPath(batchDir, batchId) {
  return path.join(batchDir, `${batchId}.ndjson`);
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), "utf8");
  await fs.rename(temporary, file);
}

async function readBatchProgress(batchDir, batchId) {
  try {
    const lines = (await fs.readFile(batchProgressPath(batchDir, batchId), "utf8"))
      .split("\n")
      .filter(Boolean);
    return lines.map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function appendBatchProgress(batchDir, batchId, event) {
  await fs.appendFile(batchProgressPath(batchDir, batchId), `${JSON.stringify(event)}\n`, "utf8");
}

async function readBatchMeta(batchDir, batchId) {
  try {
    return JSON.parse(await fs.readFile(batchMetaPath(batchDir, batchId), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function batchSummary(meta, events, includeItems = true) {
  const byIndex = new Map(events.map((event) => [event.index, event]));
  const completed = events.filter((event) => event.status === "complete").length;
  const failed = events.filter((event) => event.status === "failed").length;
  const summary = {
    id: meta.id,
    status: meta.status,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    total: meta.urls.length,
    completed,
    failed,
    remaining: meta.urls.length - completed - failed,
    pacing: {
      targetStartIntervalMs: meta.batchStartIntervalMs,
      minimumSleepAfterCaptureMs: meta.batchMinimumSleepMs
    },
    statusUrl: `/api/batches/${meta.id}`
  };
  if (meta.pauseReason) summary.pauseReason = meta.pauseReason;
  if (includeItems) {
    summary.items = meta.urls.map((url, index) => {
      const event = byIndex.get(index);
      return {
        index,
        url,
        status: event?.status || "queued",
        ...(event?.error ? { error: event.error } : {}),
        ...(event?.status === "complete" ? { resultUrl: `/api/batches/${meta.id}/results/${index}` } : {})
      };
    });
  }
  return summary;
}

export async function runServer(args, { session: injectedSession } = {}) {
  const session = injectedSession || await createCaptureSession(args);
  const persistedRates = await readRateLimitState(args.stateFile);
  const clientRateLimiter = createRateLimiter(args.rateLimitMax, args.rateLimitWindowMs);
  const globalRateLimiter = createRateLimiter(args.globalRateLimitMax, args.globalRateLimitWindowMs);
  const requestDailyRateLimiter = createRollingRateLimiter(args.dailyRateLimitMax, args.dailyRateLimitWindowMs, persistedRates.requests);
  const captureDailyRateLimiter = createRollingRateLimiter(args.captureDailyRateLimitMax, args.dailyRateLimitWindowMs, persistedRates.captures);
  const persistRates = createRateLimitStateWriter(args.stateFile, requestDailyRateLimiter, captureDailyRateLimiter);
  const cache = createHtmlCache(args.cacheDir, args.cacheTtlMs);
  await cache.prune();
  const rateLimitPolicy = `requests ${args.dailyRateLimitMax}/${Math.round(args.dailyRateLimitWindowMs / 1_000)}s; captures ${args.globalRateLimitMax}/${Math.round(args.globalRateLimitWindowMs / 1_000)}s and ${args.captureDailyRateLimitMax}/${Math.round(args.dailyRateLimitWindowMs / 1_000)}s`;
  let captureInFlight = false;
  let nextCaptureAllowedAt = 0;
  let activeBatch = null;
  let batchRun = Promise.resolve();

  const persistBatchMeta = async (meta) => {
    meta.updatedAt = new Date().toISOString();
    await writeJsonAtomic(batchMetaPath(args.batchDir, meta.id), meta);
  };

  const processBatch = async (meta) => {
    activeBatch = meta;
    meta.status = "processing";
    delete meta.pauseReason;
    await persistBatchMeta(meta);
    const existingEvents = await readBatchProgress(args.batchDir, meta.id);
    const finishedIndexes = new Set(existingEvents.map((event) => event.index));
    let nextBatchStartAt = 0;

    for (let index = 0; index < meta.urls.length; index += 1) {
      if (finishedIndexes.has(index)) continue;
      const targetUrl = meta.urls[index];
      const cachedHtml = await cache.get(targetUrl);
      if (cachedHtml !== null) {
        await appendBatchProgress(args.batchDir, meta.id, {
          index,
          status: "complete",
          bytes: Buffer.byteLength(cachedHtml),
          cached: true,
          completedAt: new Date().toISOString()
        });
        continue;
      }

      const waitMs = Math.max(0, nextBatchStartAt - Date.now());
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

      let captureRate = captureDailyRateLimiter.consume();
      if (!captureRate.allowed) {
        await new Promise((resolve) => setTimeout(resolve, captureRate.retryAfterSeconds * 1_000));
        captureRate = captureDailyRateLimiter.consume();
      }
      await persistRates();
      if (!captureRate.allowed) throw new Error("Daily capture limiter did not reopen after Retry-After");

      const startedAt = Date.now();
      captureInFlight = true;
      try {
        const html = await session.captureRawHtml(targetUrl);
        await cache.set(targetUrl, html);
        await appendBatchProgress(args.batchDir, meta.id, {
          index,
          status: "complete",
          bytes: Buffer.byteLength(html),
          cached: false,
          completedAt: new Date().toISOString()
        });
      } catch (error) {
        const message = String(error?.message || error);
        if (/eBay authentication is required/i.test(message)) {
          meta.status = "paused";
          meta.pauseReason = message;
          await persistBatchMeta(meta);
          return;
        }
        await appendBatchProgress(args.batchDir, meta.id, {
          index,
          status: "failed",
          error: message,
          completedAt: new Date().toISOString()
        });
      } finally {
        const finishedAt = Date.now();
        nextBatchStartAt = nextBatchCaptureAt(
          startedAt,
          finishedAt,
          args.batchStartIntervalMs,
          args.batchMinimumSleepMs
        );
        captureInFlight = false;
      }
    }

    meta.status = "complete";
    await persistBatchMeta(meta);
    activeBatch = null;
  };

  const startBatch = (meta) => {
    batchRun = batchRun.then(() => processBatch(meta)).catch(async (error) => {
      meta.status = "paused";
      meta.pauseReason = String(error?.message || error);
      await persistBatchMeta(meta).catch(() => {});
    });
    return batchRun;
  };

  await fs.mkdir(args.batchDir, { recursive: true });
  const storedBatchFiles = (await fs.readdir(args.batchDir)).filter((name) => name.endsWith(".json"));
  for (const name of storedBatchFiles.sort()) {
    const meta = await readBatchMeta(args.batchDir, name.slice(0, -5));
    if (meta && ["queued", "processing", "paused"].includes(meta.status)) {
      activeBatch = meta;
      if (meta.status !== "paused") startBatch(meta);
      break;
    }
  }

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

      if (req.method === "POST" && requestUrl.pathname === "/api/batches") {
        if (activeBatch && ["queued", "processing", "paused"].includes(activeBatch.status)) {
          res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify({
            error: "A batch is already active.",
            batchId: activeBatch.id,
            statusUrl: `/api/batches/${activeBatch.id}`
          }));
          return;
        }
        const body = await readJson(req, args.batchRequestMaxBytes);
        const urls = parseDistinctBatchUrls(body.urls, args.allowHosts, args.batchMaxUrls);
        const now = new Date().toISOString();
        const meta = {
          id: crypto.randomUUID(),
          status: "queued",
          createdAt: now,
          updatedAt: now,
          urls,
          batchStartIntervalMs: args.batchStartIntervalMs,
          batchMinimumSleepMs: args.batchMinimumSleepMs
        };
        await persistBatchMeta(meta);
        activeBatch = meta;
        startBatch(meta);
        res.writeHead(202, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(batchSummary(meta, [], false)));
        return;
      }

      const batchStatusMatch = requestUrl.pathname.match(/^\/api\/batches\/([0-9a-f-]+)$/i);
      if (req.method === "GET" && batchStatusMatch) {
        const meta = await readBatchMeta(args.batchDir, batchStatusMatch[1]);
        if (!meta) {
          res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ error: "Batch not found" }));
          return;
        }
        const events = await readBatchProgress(args.batchDir, meta.id);
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify(batchSummary(meta, events)));
        return;
      }

      const batchResultsFeedMatch = requestUrl.pathname.match(/^\/api\/batches\/([0-9a-f-]+)\/results$/i);
      if (req.method === "GET" && batchResultsFeedMatch) {
        const meta = await readBatchMeta(args.batchDir, batchResultsFeedMatch[1]);
        if (!meta) {
          res.writeHead(404, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify({ error: "Batch not found" }));
          return;
        }
        const after = Number(requestUrl.searchParams.get("after") ?? -1);
        const requestedLimit = Number(requestUrl.searchParams.get("limit") ?? 100);
        if (!Number.isInteger(after) || after < -1 || !Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 1_000) {
          res.writeHead(400, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify({ error: "after must be an integer of -1 or greater; limit must be between 1 and 1000" }));
          return;
        }
        const events = (await readBatchProgress(args.batchDir, meta.id))
          .filter((event) => event.index > after)
          .sort((a, b) => a.index - b.index);
        const page = events.slice(0, requestedLimit);
        const items = page.map((event) => ({
          index: event.index,
          url: meta.urls[event.index],
          status: event.status,
          ...(event.error ? { error: event.error } : {}),
          ...(event.status === "complete" ? { resultUrl: `/api/batches/${meta.id}/results/${event.index}` } : {})
        }));
        res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({
          batchId: meta.id,
          status: meta.status,
          after,
          nextCursor: page.length > 0 ? page.at(-1).index : after,
          hasMore: events.length > page.length,
          items
        }));
        return;
      }

      const batchResultMatch = requestUrl.pathname.match(/^\/api\/batches\/([0-9a-f-]+)\/results\/(\d+)$/i);
      if (req.method === "GET" && batchResultMatch) {
        const meta = await readBatchMeta(args.batchDir, batchResultMatch[1]);
        const index = Number(batchResultMatch[2]);
        if (!meta || !Number.isInteger(index) || index < 0 || index >= meta.urls.length) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("Batch result not found");
          return;
        }
        const events = await readBatchProgress(args.batchDir, meta.id);
        const event = events.find((entry) => entry.index === index && entry.status === "complete");
        const html = event ? await cache.get(meta.urls[index]) : null;
        if (html === null) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
          res.end(event ? "Batch result has expired" : "Batch result is not ready");
          return;
        }
        const filename = outputFilename(meta.urls[index]);
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          "cache-control": "no-store",
          "x-source-url": meta.urls[index],
          "x-bytes": String(Buffer.byteLength(html))
        });
        res.end(html);
        return;
      }

      const batchResumeMatch = requestUrl.pathname.match(/^\/api\/batches\/([0-9a-f-]+)\/resume$/i);
      if (req.method === "POST" && batchResumeMatch) {
        const meta = await readBatchMeta(args.batchDir, batchResumeMatch[1]);
        if (!meta || meta.status !== "paused" || activeBatch?.id !== meta.id) {
          res.writeHead(409, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
          res.end(JSON.stringify({ error: "Only the currently paused batch can be resumed." }));
          return;
        }
        startBatch(meta);
        res.writeHead(202, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
        res.end(JSON.stringify({ id: meta.id, status: "processing", statusUrl: `/api/batches/${meta.id}` }));
        return;
      }

      if ((req.method === "POST" || req.method === "GET") && requestUrl.pathname === "/api/fetch") {
        res.setHeader("x-rate-limit-policy", rateLimitPolicy);
        const clientIp = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown")
          .split(",")[0]
          .trim();
        const input = req.method === "POST" ? (await readJson(req)).url : requestUrl.searchParams.get("url");
        const targetUrl = parseAndValidateTargetUrl(input, args.allowHosts);

        const requestRate = requestDailyRateLimiter.consume();
        await persistRates();
        if (!requestRate.allowed) {
          res.writeHead(429, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "retry-after": String(requestRate.retryAfterSeconds)
          });
          res.end("Daily API request limit reached. Retry after the indicated delay.");
          return;
        }

        const cachedHtml = await cache.get(targetUrl);
        if (cachedHtml !== null) {
          const filename = outputFilename(targetUrl);
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
            "cache-control": "no-store",
            "x-cache": "HIT",
            "x-source-url": targetUrl,
            "x-bytes": String(Buffer.byteLength(cachedHtml))
          });
          res.end(cachedHtml);
          return;
        }

        if (activeBatch && ["queued", "processing", "paused"].includes(activeBatch.status)) {
          res.writeHead(429, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "retry-after": String(Math.ceil(args.batchStartIntervalMs / 1_000))
          });
          res.end("A batch is active. Retry after it completes or use the batch status endpoint.");
          return;
        }

        if (captureInFlight) {
          res.writeHead(429, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "retry-after": "10"
          });
          res.end("A capture is already running. Retry after 10 seconds.");
          return;
        }

        const rates = [
          clientRateLimiter.consume(clientIp),
          globalRateLimiter.consume("all"),
          captureDailyRateLimiter.consume()
        ];
        await persistRates();
        const blockedRate = rates.find((rate) => !rate.allowed);
        if (blockedRate) {
          res.writeHead(429, {
            "content-type": "text/plain; charset=utf-8",
            "cache-control": "no-store",
            "retry-after": String(blockedRate.retryAfterSeconds)
          });
          res.end("Capture rate limit reached. Retry after the indicated delay.");
          return;
        }

        captureInFlight = true;
        let html;
        try {
          const waitMs = Math.max(0, nextCaptureAllowedAt - Date.now());
          if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
          html = await session.captureRawHtml(targetUrl);
          await cache.set(targetUrl, html);
        } finally {
          nextCaptureAllowedAt = Date.now() + randomDelayMs(args.captureDelayMinMs, args.captureDelayMaxMs);
          captureInFlight = false;
        }
        const filename = outputFilename(targetUrl);
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
          "cache-control": "no-store",
          "x-cache": "MISS",
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
      const clientError = /valid URL|not allowed|HTTP|JSON|too large|Batch request|Batch URLs|cannot exceed/i.test(message);
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
