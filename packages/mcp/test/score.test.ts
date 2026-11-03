import { test } from "node:test";
import assert from "node:assert/strict";
import { score, lookalikes, type AddressFacts } from "../src/score.ts";
import { nearToYocto, yoctoToNear } from "../src/units.ts";

const base: AddressFacts = {
  account: "agentguard-shop.testnet",
  exists: true,
  isContract: false,
  registryStatus: "clear",
  registryReasons: [],
  allowlisted: true,
  allowlist: ["agentguard-shop.testnet"],
};

test("allowlisted + clear = allow", () => {
  assert.equal(score(base).verdict, "allow");
});

test("flagged in registry = block, with the reason", () => {
  const r = score({ ...base, registryStatus: "flagged", registryReasons: ["fake refund request"] });
  assert.equal(r.verdict, "block");
  assert.match(r.reasons[0], /fake refund request/);
});

test("reported = warn", () => {
  assert.equal(score({ ...base, registryStatus: "reported", registryReasons: ["x"] }).verdict, "warn");
});

test("registry unreachable = warn, never allow", () => {
  assert.equal(score({ ...base, registryStatus: "unknown" }).verdict, "warn");
});

test("nonexistent account = block", () => {
  const r = score({ ...base, account: "nobody-here.testnet", exists: false, allowlisted: false });
  assert.equal(r.verdict, "block");
});

test("unknown recipient = warn", () => {
  assert.equal(score({ ...base, account: "stranger.testnet", allowlisted: false }).verdict, "warn");
});

test("lookalike of a trusted name = block", () => {
  for (const fake of ["agentguard-sh0p.testnet", "agentguard-shopp.testnet", "agentguard-sihop.testnet"]) {
    const r = score({ ...base, account: fake, allowlisted: false });
    assert.equal(r.verdict, "block", fake);
    assert.match(r.reasons.join(" "), /looks like trusted account agentguard-shop.testnet/);
  }
  assert.deepEqual(lookalikes("rnarket.testnet", ["market.testnet"]), ["market.testnet"]);
  assert.deepEqual(lookalikes("completely-different.testnet", ["market.testnet"]), []);
});

test("NEAR <-> yocto conversion is exact", () => {
  assert.equal(nearToYocto("1"), "1000000000000000000000000");
  assert.equal(nearToYocto("0.25"), "250000000000000000000000");
  assert.equal(nearToYocto("0.000000000000000000000001"), "1");
  assert.equal(yoctoToNear("1580302787133883500000004"), "1.580302787133883500000004");
  assert.equal(yoctoToNear("500000000000000000000000"), "0.5");
  for (const bad of ["-1", "1e3", "abc", "0", "0.0000000000000000000000001", ""]) {
    assert.throws(() => nearToYocto(bad), bad);
  }
});

test("with no vault to judge by, an unlisted clean account is allowed", () => {
  const r = score({ account: "shop.testnet", exists: true, isContract: false, registryStatus: "clear", registryReasons: [], allowlisted: false, allowlist: [], hasAllowlist: false });
  assert.equal(r.verdict, "allow");
});
