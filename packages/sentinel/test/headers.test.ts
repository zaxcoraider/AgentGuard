import { test } from "node:test";
import assert from "node:assert/strict";
import { CONSOLE_CSP, STRICT_CSP, staticHeaders } from "../src/headers.ts";

test("pages can't be framed and don't sniff types", () => {
  for (const f of ["/p/index.html", "/p/sentinel.html", "/p/console.html"]) {
    const h = staticHeaders(f);
    assert.equal(h["x-frame-options"], "DENY");
    assert.equal(h["x-content-type-options"], "nosniff");
    assert.match(h["content-security-policy"], /frame-ancestors 'none'/);
  }
});

test("website and Sentinel get the strict policy, the Console the wallet-safe one", () => {
  assert.equal(staticHeaders("/p/index.html")["content-security-policy"], STRICT_CSP);
  assert.equal(staticHeaders("/p/sentinel.html")["content-security-policy"], STRICT_CSP);
  assert.equal(staticHeaders("/p/console.html")["content-security-policy"], CONSOLE_CSP);
  assert.equal(staticHeaders("/p/app.js")["content-security-policy"], undefined);
});

test("strict policy allows no inline or third-party scripts", () => {
  const script = STRICT_CSP.split("; ").find((d) => d.startsWith("script-src"));
  assert.equal(script, "script-src 'self'");
  assert.doesNotMatch(STRICT_CSP, /unsafe-eval/);
});

test("discovery files (agent card, llms.txt) are readable cross-origin; pages and scripts are not", () => {
  assert.equal(staticHeaders("/p/.well-known/agent-card.json")["access-control-allow-origin"], "*");
  assert.equal(staticHeaders("/p/llms.txt")["access-control-allow-origin"], "*");
  assert.equal(staticHeaders("/p/index.html")["access-control-allow-origin"], undefined);
  assert.equal(staticHeaders("/p/app.js")["access-control-allow-origin"], undefined);
});
