import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHtmlCache, createRateLimiter, createRollingRateLimiter, isInteractiveBlock, minimumCaptureLength, nextBatchCaptureAt, outputFilename, parseAndValidateTargetUrl, parseArgs, parseDistinctBatchUrls, randomDelayMs, runServer } from "../src/server.mjs";

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
    CAPTURE_DAILY_RATE_LIMIT_MAX: "300"
  });
  assert.equal(args.headless, true);
  assert.equal(args.port, 9000);
  assert.equal(args.globalRateLimitMax, 12);
  assert.equal(args.dailyRateLimitMax, 1000);
  assert.equal(args.captureDailyRateLimitMax, 300);
  assert.equal(args.verificationTimeoutMs, 0);
  assert.deepEqual(args.allowHosts, ["ebay.com"]);
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
