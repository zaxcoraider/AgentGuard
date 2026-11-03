import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { Wallet } from "ethers";
import { TeeVerifier, bindsAddressAndNonce, bindsConfig, type QuoteResult } from "../src/tee.ts";

const fx = JSON.parse(readFileSync(new URL("./fixtures/near-ai-attestation.json", import.meta.url), "utf8"));
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test("real NEAR AI quote: report_data binds the model's signing address and our nonce", () => {
  const m = fx.model_report;
  assert.deepEqual(bindsAddressAndNonce(m.quote_report_data, m.signing_address, m.signing_algo, fx.nonce), { address: true, nonce: true });
  const g = fx.gateway_report;
  assert.deepEqual(bindsAddressAndNonce(g.quote_report_data, g.signing_address, g.signing_algo, fx.nonce), { address: true, nonce: true });
});

test("real NEAR AI quote: a different nonce or signer does not bind", () => {
  const m = fx.model_report;
  assert.equal(bindsAddressAndNonce(m.quote_report_data, m.signing_address, "ecdsa", "00".repeat(32)).nonce, false);
  assert.equal(bindsAddressAndNonce(m.quote_report_data, "0x" + "11".repeat(20), "ecdsa", fx.nonce).address, false);
});

test("real NEAR AI quote: MRCONFIGID measures the exact app_compose", () => {
  assert.equal(bindsConfig(fx.model_report.quote_mr_config_id, fx.model_report.app_compose), true);
  assert.equal(bindsConfig(fx.gateway_report.quote_mr_config_id, fx.gateway_report.app_compose), true);
  assert.equal(bindsConfig(fx.model_report.quote_mr_config_id, fx.model_report.app_compose + " "), false, "one changed byte fails");
});

// ---- the whole flow, with Intel and NVIDIA mocked (their real answers are covered above) ----

const MODEL = "test/model";

function harness(opts: { tdx?: string; gpu?: boolean; sig?: (req: string, res: string) => Promise<object | null> } = {}) {
  const modelWallet = Wallet.createRandom();
  const gatewayWallet = Wallet.createRandom();
  let nonce = "";
  const reportData = (addr: string) => addr.slice(2).toLowerCase().padEnd(64, "0") + nonce;
  const quotes: Record<string, QuoteResult> = {};
  const fetchImpl = (async (input: URL | string) => {
    const u = new URL(String(input));
    if (u.pathname.endsWith("/attestation/report")) {
      nonce = u.searchParams.get("nonce")!;
      const compose = '{"docker_compose_file":"x"}';
      const mr = `01${sha(compose)}${"00".repeat(15)}`;
      quotes.gw = { status: opts.tdx ?? "UpToDate", reportData: reportData(gatewayWallet.address), mrConfigId: mr };
      quotes.model = { status: opts.tdx ?? "UpToDate", reportData: reportData(modelWallet.address), mrConfigId: mr };
      return new Response(JSON.stringify({
        gateway_attestation: { signing_address: gatewayWallet.address, signing_algo: "ecdsa", intel_quote: "gw", request_nonce: nonce, info: { tcb_info: { app_compose: compose } } },
        model_attestations: [{ signing_address: modelWallet.address, signing_algo: "ecdsa", intel_quote: "model", request_nonce: nonce, nvidia_payload: JSON.stringify({ nonce, arch: "HOPPER", evidence_list: [] }), info: { tcb_info: JSON.stringify({ app_compose: compose }) } }],
      }));
    }
    if (u.pathname.includes("/signature/")) {
      const body = await opts.sig?.(lastReq, lastRes);
      return body ? new Response(JSON.stringify(body)) : new Response("{}", { status: 404 });
    }
    throw new Error("unexpected " + u);
  }) as typeof fetch;
  let lastReq = "";
  let lastRes = "";
  const v = new TeeVerifier({ baseUrl: "http://near-ai/v1", apiKey: "k", model: MODEL, fetchImpl, verifyQuote: async (q) => quotes[q], verifyGpu: async () => opts.gpu ?? true });
  return {
    v,
    modelWallet,
    gatewayWallet,
    setBytes(req: string, res: string) {
      lastReq = req;
      lastRes = res;
    },
  };
}

test("attestation passes when quote, bindings, config and GPU all check out", async () => {
  const { v, modelWallet } = harness();
  const a = await v.attest();
  assert.equal(a.ok, true);
  assert.deepEqual(a.verified_signers, [modelWallet.address.toLowerCase()]);
  assert.equal(a.models[0].gpu?.arch, "HOPPER");
});

test("attestation fails on a bad TDX status or a negative NVIDIA verdict", async () => {
  assert.equal((await harness({ tdx: "Revoked" }).v.attest()).ok, false);
  const gpuBad = await harness({ gpu: false }).v.attest();
  assert.equal(gpuBad.ok, false);
  assert.deepEqual(gpuBad.verified_signers, []);
});

test("a reply signed by the attested model over the exact bytes is verified", async () => {
  const h = harness({ sig: async (req, res) => ({ text: `${MODEL}:${sha(req)}:${sha(res)}`, signature: await h.modelWallet.signMessage(`${MODEL}:${sha(req)}:${sha(res)}`), signing_address: h.modelWallet.address, signing_algo: "ecdsa", signature_kind: "provider_tee" }) });
  const before = await h.v.attest();
  h.setBytes('{"model":"test/model"}', '{"id":"chat-1"}');
  const r = await h.v.verifyReply("chat-1", '{"model":"test/model"}', '{"id":"chat-1"}', before);
  assert.equal(r.status, "verified");
});

test("tampered bytes, a gateway-only signature, or an unknown signer are not verified", async () => {
  const stranger = Wallet.createRandom();
  const make = (wallet: { address: string; signMessage(m: string): Promise<string> }, kind: string) => async (req: string, res: string) => {
    const text = `${MODEL}:${sha(req)}:${sha(res)}`;
    return { text, signature: await wallet.signMessage(text), signing_address: wallet.address, signing_algo: "ecdsa", signature_kind: kind };
  };
  let h = harness({ sig: (q, s) => make(h.modelWallet, "provider_tee")(q, s) });
  let before = await h.v.attest();
  h.setBytes("req", "res");
  assert.equal((await h.v.verifyReply("c", "req", "res-tampered", before)).status, "failed", "response bytes changed");

  h = harness({ sig: (q, s) => make(h.gatewayWallet, "gateway")(q, s) });
  before = await h.v.attest();
  h.setBytes("req", "res");
  assert.equal((await h.v.verifyReply("c", "req", "res", before)).status, "failed", "gateway signature is not model evidence");

  h = harness({ sig: (q, s) => make(stranger, "provider_tee")(q, s) });
  before = await h.v.attest();
  h.setBytes("req", "res");
  const r = await h.v.verifyReply("c", "req", "res", before);
  assert.equal(r.status, "failed");
  assert.match((r as { reason: string }).reason, /not a model we verified/);
});

test("no attestation before the reply, or no signature found: unavailable, never verified", async () => {
  const h = harness({ sig: async () => null });
  assert.equal((await h.v.verifyReply("c", "a", "b", null)).status, "unavailable");
  const before = await h.v.attest();
  assert.equal((await h.v.verifyReply("c", "a", "b", before, 1)).status, "unavailable");
});
