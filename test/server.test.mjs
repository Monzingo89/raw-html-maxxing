import test from "node:test";
import assert from "node:assert/strict";
import { outputFilename, parseAndValidateTargetUrl, parseArgs } from "../src/server.mjs";

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
  const name = outputFilename("https://www.ebay.com/sch/i.html?_nkw=Pikachu%20VMAX%20Promo");
  assert.match(name, /^pikachu-vmax-promo-.*\.html$/);
  assert.doesNotMatch(name, /[/:]/);
});

test("environment and CLI options are parsed", () => {
  const args = parseArgs(["--headless", "--port=9000"], { ALLOW_HOSTS: "ebay.com" });
  assert.equal(args.headless, true);
  assert.equal(args.port, 9000);
  assert.deepEqual(args.allowHosts, ["ebay.com"]);
});
