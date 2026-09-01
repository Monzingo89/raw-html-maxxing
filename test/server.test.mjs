import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bearerTokenMatches, createHtmlCache, createRateLimiter, createRollingRateLimiter, htmlCacheStats, isAuthenticationFailure, isInteractiveBlock, latestBatchEvents, minimumCaptureLength, nextBatchCaptureAt, normalizeFailure, outputFilename, parseAndValidateTargetUrl, parseArgs, parseDistinctBatchUrls, randomDelayMs, retryDelayMs, runServer } from "../src/server.mjs";

test("accepts eBay and its subdomains", () => {
  assert.equal(
    parseAndValidateTargetUrl("https://www.ebay.com/sch/i.html?_nkw=charizard", ["ebay.com"]),
    "https://www.ebay.com/sch/i.html?_nkw=charizard"
  );
});

test("rejects lookalike, unsupported, and malformed URLs", () => {
  assert.throws(() => parseAndValidateTargetUrl("https://ebay.com.attacker.test", ["ebay.com"]), /not allowed/);
  assert.throws(() => parseAndValidateTargetUrl("file:///etc/passwd", ["ebay.com"]), /HTTP/);
  assert.throws(() => parseAndValidateTargetUrl("not a url", ["ebay.com"]), /valid URL/);
});

test("accepts only distinct allowed URLs in a bounded batch", () => {
  const urls = [
    "https://www.ebay.com/sch/i.html?_nkw=pikachu",
    "https://www.ebay.com/sch/i.html?_nkw=charizard"
  ];
  assert.deepEqual(parseDistinctBatchUrls(urls, ["ebay.com"], 2), urls);
  assert.throws(() => parseDistinctBatchUrls([urls[0], urls[0]], ["ebay.com"], 2), /distinct/);
  assert.throws(() => parseDistinctBatchUrls([...urls, "https://www.ebay.com/itm/1"], ["ebay.com"], 2), /cannot exceed/);
});

test("creates a safe descriptive HTML filename", () => {
  const name = outputFilename("https://www.ebay.com/sch/i.html?_nkw=Pikachu%20VMAX%20Promo&LH_Sold=1");
  assert.equal(name, "pikachu-vmax-promo-sold.html");
  assert.doesNotMatch(name, /[/:]/);
  assert.equal(outputFilename("https://www.ebay.com/sch/i.html?_nkw=Charizard"), "charizard.html");
});

test("environment and CLI options are parsed", () => {
  const args = parseArgs(["--headless", "--port=9000"], {
    ALLOW_HOSTS: "ebay.com",
    GLOBAL_RATE_LIMIT_MAX: "12",
    DAILY_RATE_LIMIT_MAX: "1000",
    CAPTURE_DAILY_RATE_LIMIT_MAX: "300",
    LOGIN_RETRY_DELAY_MS: "180000",
    ADMIN_STATUS_TOKEN: "admin-test-token"
  });
  assert.equal(args.headless, true);
  assert.equal(args.port, 9000);
  assert.equal(args.globalRateLimitMax, 12);
  assert.equal(args.dailyRateLimitMax, 1000);
  assert.equal(args.captureDailyRateLimitMax, 300);
  assert.equal(args.loginRetryDelayMs, 180_000);
  assert.equal(args.verificationTimeoutMs, 0);
  assert.equal(args.adminStatusToken, "admin-test-token");
  assert.deepEqual(args.allowHosts, ["ebay.com"]);
});

test("admin bearer tokens use exact constant-time matching", () => {
  assert.equal(bearerTokenMatches("Bearer admin-test-token", "admin-test-token"), true);
  assert.equal(bearerTokenMatches("Bearer wrong", "admin-test-token"), false);
  assert.equal(bearerTokenMatches("", "admin-test-token"), false);
  assert.equal(bearerTokenMatches("Bearer anything", ""), false);
});

test("HTML cache stats count only HTML files and bytes", async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "raw-html-cache-stats-test-"));
  try {
    await fs.writeFile(path.join(cacheDir, "one.html"), "1234");
    await fs.writeFile(path.join(cacheDir, "ignore.json"), "123456");
    assert.deepEqual(await htmlCacheStats(cacheDir), { files: 1, bytes: 4 });
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

test("rolling limiter retains only events within the trailing window", () => {
  const limiter = createRollingRateLimiter(2, 1_000, [0]);
  assert.deepEqual(limiter.consume(999), { allowed: true, remaining: 0, retryAfterSeconds: 0 });
  assert.deepEqual(limiter.consume(999), { allowed: false, remaining: 0, retryAfterSeconds: 1 });
  assert.deepEqual(limiter.consume(1_000), { allowed: true, remaining: 0, retryAfterSeconds: 0 });
  assert.deepEqual(limiter.snapshot(1_000), [999, 1_000]);
});

test("rolling daily limiter accepts 10,000 requests and rejects request 10,001", () => {
  const limiter = createRollingRateLimiter(10_000, 86_400_000);
  for (let index = 0; index < 10_000; index += 1) {
    assert.equal(limiter.consume(index).allowed, true);
  }
  assert.equal(limiter.consume(10_000).allowed, false);
  assert.equal(limiter.consume(86_400_000).allowed, true);
});

test("HTML cache returns exact content until its TTL expires", async () => {
  const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "raw-html-cache-test-"));
  try {
    const cache = createHtmlCache(cacheDir, 1_000);
    const url = "https://www.ebay.com/sch/i.html?_nkw=pikachu";
    await cache.set(url, "<!DOCTYPE html><html>cached</html>");
    const now = (await fs.stat(path.join(cacheDir, (await fs.readdir(cacheDir))[0]))).mtimeMs;
    assert.equal(await cache.get(url, now + 999), "<!DOCTYPE html><html>cached</html>");
    assert.equal(await cache.get(url, now + 1_001), null);
  } finally {
    await fs.rm(cacheDir, { recursive: true, force: true });
  }
});

test("capture delay stays within its inclusive configured range", () => {
  assert.equal(randomDelayMs(1_000, 3_000, () => 0), 1_000);
  assert.equal(randomDelayMs(1_000, 3_000, () => 0.999999), 3_000);
});

test("batch pacing fills an 8.64-second slot and always sleeps at least 4.64 seconds", () => {
  assert.equal(nextBatchCaptureAt(0, 3_000, 8_640, 4_640), 8_640);
  assert.equal(nextBatchCaptureAt(0, 4_000, 8_640, 4_640), 8_640);
  assert.equal(nextBatchCaptureAt(0, 5_000, 8_640, 4_640), 9_640);
});

test("retry helpers group variable errors and retain only the latest item event", () => {
  assert.equal(normalizeFailure("Timeout 90000 at https://www.ebay.com/item/123456"), "Timeout <n> at <url>");
  assert.equal(retryDelayMs(1, 1_000, 10_000), 1_000);
  assert.equal(retryDelayMs(9, 1_000, 10_000), 10_000);
  assert.deepEqual(latestBatchEvents([
    { index: 1, status: "retrying", attempt: 1 },
    { index: 0, status: "complete" },
    { index: 1, status: "complete", attempt: 2 }
  ]), [
    { index: 0, status: "complete" },
    { index: 1, status: "complete", attempt: 2 }
  ]);
});

test("POST returns HTML and caches an identical URL for 24 hours", async () => {
  const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "raw-html-server-test-"));
  let captures = 0;
  const html = "<!DOCTYPE html><html><body>rendered result</body></html>";
  const session = {
    async captureRawHtml() {
      captures += 1;
      return html;
    },
    async close() {}
  };
  const args = parseArgs([], {
    HOST: "127.0.0.1",
    PORT: "8787",
    ALLOW_HOSTS: "ebay.com",
    RATE_LIMIT_MAX: "30",
    GLOBAL_RATE_LIMIT_MAX: "30",
    DAILY_RATE_LIMIT_MAX: "1",
    CAPTURE_DAILY_RATE_LIMIT_MAX: "300",
    CACHE_DIR: path.join(temporaryDir, "cache"),
    RATE_LIMIT_STATE_FILE: path.join(temporaryDir, "rates.json"),
    CAPTURE_DELAY_MIN_MS: "0",
    CAPTURE_DELAY_MAX_MS: "0"
  });
  args.port = 0;
  const server = await runServer(args, { session });
  const port = server.address().port;
  const url = "https://www.ebay.com/sch/i.html?_nkw=pikachu&LH_Sold=1";
  try {
    const request = () => fetch(`http://127.0.0.1:${port}/api/fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url })
    });
    const first = await request();
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("x-cache"), "MISS");
    assert.match(first.headers.get("content-disposition"), /pikachu-sold\.html/);
    assert.equal(await first.text(), html);

    const second = await request();
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("x-cache"), "HIT");
    assert.equal(await second.text(), html);
    assert.equal(captures, 1);

    const blockedDistinct = await fetch(`http://127.0.0.1:${port}/api/fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://www.ebay.com/sch/i.html?_nkw=charizard" })
    });
    assert.equal(blockedDistinct.status, 429);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(temporaryDir, { recursive: true, force: true });
  }
});

test("admin status is private and returns operational data without cookie values", async () => {
  const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "raw-html-admin-status-test-"));
  const session = {
    async captureRawHtml() { return "<!DOCTYPE html><html>captured</html>"; },
    async getSessionStatus() { return { persistentProfile: true, cookieCount: 7 }; },
    async close() {}
  };
  const args = parseArgs([], {
    HOST: "127.0.0.1",
    PORT: "8787",
    ALLOW_HOSTS: "ebay.com",
    ADMIN_STATUS_TOKEN: "admin-test-token",
    INSTANCE_NAME: "test-vm",
    CACHE_DIR: path.join(temporaryDir, "cache"),
    RATE_LIMIT_STATE_FILE: path.join(temporaryDir, "rates.json"),
    BATCH_DIR: path.join(temporaryDir, "batches"),
    RETRY_QUEUE_FILE: path.join(temporaryDir, "retry.json")
  });
  args.port = 0;
  const server = await runServer(args, { session });
  const port = server.address().port;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/admin/status`)).status, 401);
    const response = await fetch(`http://127.0.0.1:${port}/api/admin/status`, {
      headers: { authorization: "Bearer admin-test-token" }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.instanceName, "test-vm");
    assert.equal(body.html.files, 0);
    assert.deepEqual(body.usage.requests, { used: 0, limit: 10_000 });
    assert.equal(body.browserSession.cookieCount, 7);
    assert.equal(JSON.stringify(body).includes("cookieValue"), false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(temporaryDir, { recursive: true, force: true });
  }
});

test("batch submission returns immediately and exposes completed HTML", async () => {
  const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "raw-html-batch-test-"));
  const html = "<!DOCTYPE html><html><body>batch result</body></html>";
  const session = {
    async captureRawHtml() { return html; },
    async close() {}
  };
  const args = parseArgs([], {
    HOST: "127.0.0.1",
    PORT: "8787",
    ALLOW_HOSTS: "ebay.com",
    RATE_LIMIT_MAX: "10000",
    GLOBAL_RATE_LIMIT_MAX: "10000",
    DAILY_RATE_LIMIT_MAX: "10000",
    CAPTURE_DAILY_RATE_LIMIT_MAX: "10000",
    CACHE_DIR: path.join(temporaryDir, "cache"),
    RATE_LIMIT_STATE_FILE: path.join(temporaryDir, "rates.json"),
    BATCH_DIR: path.join(temporaryDir, "batches"),
    BATCH_START_INTERVAL_MS: "1000",
    BATCH_MINIMUM_SLEEP_MS: "0"
  });
  args.port = 0;
  const server = await runServer(args, { session });
  const port = server.address().port;
  try {
    const submitted = await fetch(`http://127.0.0.1:${port}/api/batches`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ urls: ["https://www.ebay.com/sch/i.html?_nkw=pikachu"] })
    });
    assert.equal(submitted.status, 202);
    const accepted = await submitted.json();
    assert.equal(accepted.total, 1);

    let status;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      status = await (await fetch(`http://127.0.0.1:${port}${accepted.statusUrl}`)).json();
      if (status.status === "complete") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(status.status, "complete");
    assert.equal(status.completed, 1);
    const feed = await (await fetch(`http://127.0.0.1:${port}/api/batches/${accepted.id}/results?after=-1`)).json();
    assert.equal(feed.nextCursor, 0);
    assert.equal(feed.items.length, 1);
    assert.equal(feed.items[0].html, html);
    assert.equal("resultUrl" in feed.items[0], false);
    const emptyFeed = await (await fetch(`http://127.0.0.1:${port}/api/batches/${accepted.id}/results?after=0`)).json();
    assert.deepEqual(emptyFeed.items, []);
    assert.equal(emptyFeed.nextCursor, 0);
    const result = await fetch(`http://127.0.0.1:${port}${status.items[0].resultUrl}`);
    assert.equal(result.status, 200);
    assert.equal(await result.text(), html);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(temporaryDir, { recursive: true, force: true });
  }
});

test("failed browser captures stop the browser and accept requests during recovery", async () => {
  const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "raw-html-retry-test-"));
  const retryQueueFile = path.join(temporaryDir, "retry-queue.json");
  let stops = 0;
  const session = {
    async captureRawHtml() { throw new Error("upstream temporarily unavailable 503"); },
    async stop() { stops += 1; },
    async close() {}
  };
  const args = parseArgs([], {
    HOST: "127.0.0.1",
    PORT: "8787",
    ALLOW_HOSTS: "ebay.com",
    CACHE_DIR: path.join(temporaryDir, "cache"),
    RATE_LIMIT_STATE_FILE: path.join(temporaryDir, "rates.json"),
    RETRY_QUEUE_FILE: retryQueueFile,
    RETRY_BASE_DELAY_MS: "60000",
    RETRY_MAX_DELAY_MS: "60000",
    LOGIN_RETRY_DELAY_MS: "60000",
    LOGIN_STATE_FILE: path.join(temporaryDir, "recovery.json"),
    CAPTURE_DELAY_MIN_MS: "0",
    CAPTURE_DELAY_MAX_MS: "0",
    ALERT_STATE_FILE: path.join(temporaryDir, "alerts.json")
  });
  args.port = 0;
  const server = await runServer(args, { session });
  const port = server.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/fetch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://www.ebay.com/sch/i.html?_nkw=retry-test" })
    });
    assert.equal(response.status, 202);
    assert.ok(response.headers.get("x-retry-id"));
    const body = await response.json();
    assert.equal(body.status, "restarting_browser");
    assert.equal(body.message, "Please Wait, Restarting Browser");
    assert.equal(stops, 1);
    const queue = JSON.parse(await fs.readFile(retryQueueFile, "utf8"));
    assert.equal(queue.length, 1);
    assert.equal(queue[0].attempts, 1);
    for (const keyword of ["retry-test-two", "retry-test-three"]) {
      const grouped = await fetch(`http://127.0.0.1:${port}/api/fetch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: `https://www.ebay.com/sch/i.html?_nkw=${keyword}` })
      });
      assert.equal(grouped.status, 202);
    }
    const groupedQueue = JSON.parse(await fs.readFile(retryQueueFile, "utf8"));
    assert.equal(groupedQueue.length, 3);
    const outbox = await fs.readFile(`${args.alertStateFile}.outbox.ndjson`, "utf8");
    assert.match(outbox, /headed-browser-recovery/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(temporaryDir, { recursive: true, force: true });
  }
});

test("login loss pauses for three minutes, accepts incoming work, and resumes it in order", async () => {
  const temporaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "raw-html-login-pause-test-"));
  const attemptedUrls = [];
  let firstAttempt = true;
  let starts = 0;
  let stops = 0;
  const session = {
    async captureRawHtml(url) {
      attemptedUrls.push(url);
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error("eBay authentication is required on the capture server. Complete verification through Screen Sharing.");
      }
      return `<!DOCTYPE html><html><body>${url}</body></html>`;
    },
    async start() { starts += 1; },
    async stop() { stops += 1; },
    async close() {}
  };
  const args = parseArgs([], {
    HOST: "127.0.0.1",
    PORT: "8787",
    ALLOW_HOSTS: "ebay.com",
    RATE_LIMIT_MAX: "30",
    GLOBAL_RATE_LIMIT_MAX: "30",
    DAILY_RATE_LIMIT_MAX: "30",
    CAPTURE_DAILY_RATE_LIMIT_MAX: "30",
    CACHE_DIR: path.join(temporaryDir, "cache"),
    RATE_LIMIT_STATE_FILE: path.join(temporaryDir, "rates.json"),
    RETRY_QUEUE_FILE: path.join(temporaryDir, "retry.json"),
    LOGIN_STATE_FILE: path.join(temporaryDir, "login.json"),
    ALERT_STATE_FILE: path.join(temporaryDir, "alerts.json"),
    LOGIN_RETRY_DELAY_MS: "1000",
    RETRY_BASE_DELAY_MS: "1000",
    RETRY_MAX_DELAY_MS: "1000",
    CAPTURE_DELAY_MIN_MS: "0",
    CAPTURE_DELAY_MAX_MS: "0"
  });
  args.port = 0;
  const server = await runServer(args, { session });
  const port = server.address().port;
  const urls = [
    "https://www.ebay.com/sch/i.html?_nkw=login-pause-one",
    "https://www.ebay.com/sch/i.html?_nkw=login-pause-two"
  ];
  const request = (url) => fetch(`http://127.0.0.1:${port}/api/fetch`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url })
  });
  try {
    const stopped = await request(urls[0]);
    assert.equal(stopped.status, 202);
    assert.equal((await stopped.json()).message, "Please Wait, Logging In");

    const acceptedWhilePaused = await request(urls[1]);
    assert.equal(acceptedWhilePaused.status, 202);
    assert.equal((await acceptedWhilePaused.json()).status, "waiting_for_login");
    assert.equal(attemptedUrls.length, 1);

    let resumed;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      resumed = await request(urls[1]);
      if (resumed.status === 200) break;
    }
    assert.equal(resumed.status, 200);
    assert.match(resumed.headers.get("x-cache"), /^(HIT|MISS)$/);
    assert.deepEqual(attemptedUrls, [urls[0], urls[0], urls[1]]);
    assert.equal(stops, 1);
    assert.equal(starts, 1);
    const loginState = JSON.parse(await fs.readFile(args.loginStateFile, "utf8"));
    assert.equal(loginState.active, false);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await fs.rm(temporaryDir, { recursive: true, force: true });
  }
});

test("rate limiter resets after its window", () => {
  const limiter = createRateLimiter(2, 1_000);
  assert.deepEqual(limiter.consume("client", 0), { allowed: true, remaining: 1, retryAfterSeconds: 0 });
  assert.deepEqual(limiter.consume("client", 1), { allowed: true, remaining: 0, retryAfterSeconds: 0 });
  assert.equal(limiter.consume("client", 2).allowed, false);
  assert.equal(limiter.consume("client", 1_000).allowed, true);
});

test("recognizes eBay sign-in and verification pages", () => {
  assert.equal(isInteractiveBlock("Sign in or Register | eBay", "", "https://signin.ebay.com/ws/eBayISAPI.dll"), true);
  assert.equal(isInteractiveBlock("Pikachu VMAX Promo for sale | eBay", "Results", "https://www.ebay.com/sch/i.html"), false);
});

test("distinguishes authentication loss from infrastructure failures", () => {
  assert.equal(isAuthenticationFailure(new Error("eBay authentication is required on the capture server")), true);
  assert.equal(isAuthenticationFailure(new Error("page.goto: Target page, context or browser has been closed")), false);
  assert.equal(isAuthenticationFailure(new Error("ENOSPC: no space left on device")), false);
});

test("requires a fully hydrated DOM for eBay search captures", () => {
  assert.equal(minimumCaptureLength("https://www.ebay.com/sch/i.html?_nkw=pikachu"), 250_000);
  assert.equal(minimumCaptureLength("https://www.ebay.com/itm/123456789"), 25_000);
});
