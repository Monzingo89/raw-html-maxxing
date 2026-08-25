import test from "node:test";
import assert from "node:assert/strict";
import { createRateLimiter, isInteractiveBlock, minimumCaptureLength, outputFilename, parseAndValidateTargetUrl, parseArgs } from "../src/server.mjs";

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
    DAILY_RATE_LIMIT_MAX: "100"
  });
  assert.equal(args.headless, true);
  assert.equal(args.port, 9000);
  assert.equal(args.globalRateLimitMax, 12);
  assert.equal(args.dailyRateLimitMax, 100);
  assert.deepEqual(args.allowHosts, ["ebay.com"]);
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
