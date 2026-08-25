import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHtmlCache, createRateLimiter, createRollingRateLimiter, isInteractiveBlock, minimumCaptureLength, outputFilename, parseAndValidateTargetUrl, parseArgs, randomDelayMs, runServer } from "../src/server.mjs";

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
    CAPTURE_DAILY_RATE_LIMIT_MAX: "300"
  });
  assert.equal(args.headless, true);
  assert.equal(args.port, 9000);
  assert.equal(args.globalRateLimitMax, 12);
  assert.equal(args.dailyRateLimitMax, 1000);
  assert.equal(args.captureDailyRateLimitMax, 300);
  assert.deepEqual(args.allowHosts, ["ebay.com"]);
});

test("rolling limiter retains only events within the trailing window", () => {
  const limiter = createRollingRateLimiter(2, 1_000, [0]);
  assert.deepEqual(limiter.consume(999), { allowed: true, remaining: 0, retryAfterSeconds: 0 });
  assert.deepEqual(limiter.consume(999), { allowed: false, remaining: 0, retryAfterSeconds: 1 });
  assert.deepEqual(limiter.consume(1_000), { allowed: true, remaining: 0, retryAfterSeconds: 0 });
  assert.deepEqual(limiter.snapshot(1_000), [999, 1_000]);
});

test("rolling daily limiter accepts 1,000 requests and rejects request 1,001", () => {
  const limiter = createRollingRateLimiter(1_000, 86_400_000);
  for (let index = 0; index < 1_000; index += 1) {
    assert.equal(limiter.consume(index).allowed, true);
  }
  assert.equal(limiter.consume(1_000).allowed, false);
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
    DAILY_RATE_LIMIT_MAX: "1000",
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

test("requires a fully hydrated DOM for eBay search captures", () => {
  assert.equal(minimumCaptureLength("https://www.ebay.com/sch/i.html?_nkw=pikachu"), 250_000);
  assert.equal(minimumCaptureLength("https://www.ebay.com/itm/123456789"), 25_000);
});
