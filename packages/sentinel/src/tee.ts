// Checks, in code, that Sentinel's brain really runs in a TEE: NEAR AI Cloud's attestation
// report and each reply's signature. Follows docs.near.ai/cloud/verification and NEAR's own
// reference verifier (github.com/nearai/nearai-cloud-verifier).
//
// What is checked:
//   1. Intel TDX quote of the gateway and of each model machine: verified with Intel's
//      collateral and root CA (@phala/dcap-qvl, a version with the QE Identity fix). Status must be UpToDate or OutOfDate (the reference verifier's policy).
//   2. In the VERIFIED quote: report_data = signing address (padded to 32 bytes) + OUR fresh nonce.
//   3. In the verified quote: MRCONFIGID = 01 || sha256(app_compose) || 15 zero bytes.
//   4. NVIDIA GPU evidence: carries our nonce, and NVIDIA's attestation service (NRAS) says true.
//   5. Each reply: the provider_tee signature over "<model>:<sha256(request)>:<sha256(response)>"
//      of the exact bytes, signed by an address from a model report verified BEFORE the reply.
// Not checked (said in the README): RTMR3 event-log replay, image provenance, the NRAS JWT's
// own signature (we trust NVIDIA's HTTPS answer), TLS binding to the gateway.
import { createHash, randomBytes } from "node:crypto";
import { verifyMessage } from "ethers";

export interface QuoteResult {
  status: string;
  reportData: string; // hex
  mrConfigId: string; // hex
}

export interface PartCheck {
  role: "gateway" | "model";
  signing_address: string;
  tdx_status: string;
  address_bound: boolean;
  nonce_bound: boolean;
  config_bound: boolean;
  gpu?: { arch: string; nonce_bound: boolean; nvidia_verdict: boolean };
  ok: boolean;
  error?: string;
}

export interface Attestation {
  checked_at: string;
  model: string;
  ok: boolean;
  gateway: PartCheck | null;
  models: PartCheck[];
  /** Model signing addresses that passed every check (lowercase). */
  verified_signers: string[];
}

export type ReplyCheck =
  | { status: "verified"; signer: string; kind: string; checked_at: string }
  | { status: "unavailable" | "failed"; reason: string };

export interface TeeOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  /** Intel quote verification. Default: dcap-qvl with Intel's PCS collateral. */
  verifyQuote?: (quoteHex: string) => Promise<QuoteResult>;
  /** NVIDIA verdict for GPU evidence. Default: NVIDIA NRAS. */
  verifyGpu?: (payload: unknown) => Promise<boolean>;
}

const TDX_OK = new Set(["UpToDate", "OutOfDate"]);
const NRAS = "https://nras.attestation.nvidia.com/v3/attest/gpu";

export async function dcapVerifyQuote(quoteHex: string): Promise<QuoteResult> {
  // @phala/dcap-qvl >= 0.3.9 verifies the QE Identity signature (GHSA-796p-j2gh-9m2q);
  // the older @phala/dcap-qvl-node does not. Collateral comes straight from Intel's PCS,
  // the root of trust is Intel's production root CA, and debug enclaves are refused.
  const { getCollateralFromPcs, QuoteVerifier } = await import("@phala/dcap-qvl");
  const quote = Buffer.from(quoteHex, "hex");
  const collateral = await getCollateralFromPcs(quote);
  const r = QuoteVerifier.newProd().verify(quote, collateral, Math.floor(Date.now() / 1000));
  const td = r.report.asTd10();
  if (!td) throw new Error("not a TDX quote");
  return { status: r.status, reportData: Buffer.from(td.reportData).toString("hex"), mrConfigId: Buffer.from(td.mrConfigId).toString("hex") };
}

export async function nrasVerifyGpu(payload: unknown, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const res = await fetchImpl(NRAS, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`NVIDIA NRAS ${res.status}`);
  const body = (await res.json()) as [string, string][];
  const jwt = body?.[0]?.[1];
  if (typeof jwt !== "string") throw new Error("NVIDIA NRAS: unexpected response");
  const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
  return claims["x-nvidia-overall-att-result"] === true;
}

const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** report_data[0..32] = signing address right-padded with zeros, [32..64] = our nonce. */
export function bindsAddressAndNonce(reportDataHex: string, signingAddress: string, algo: string, nonceHex: string) {
  const rd = Buffer.from(reportDataHex.replace(/^0x/i, ""), "hex");
  const addr = Buffer.from(algo === "ecdsa" ? signingAddress.replace(/^0x/i, "") : signingAddress, "hex");
  const padded = Buffer.concat([addr, Buffer.alloc(Math.max(0, 32 - addr.length))]);
  return {
    address: rd.length >= 64 && addr.length > 0 && addr.length <= 32 && rd.subarray(0, 32).equals(padded),
    nonce: rd.length >= 64 && rd.subarray(32, 64).toString("hex") === nonceHex.toLowerCase(),
  };
}

/** MRCONFIGID = 01 || sha256(raw app_compose) || 15 zero bytes. */
export function bindsConfig(mrConfigIdHex: string, appCompose: string) {
  return mrConfigIdHex.toLowerCase().replace(/^0x/, "") === `01${sha256(appCompose)}${"00".repeat(15)}`;
}

function appComposeOf(report: { info?: { tcb_info?: unknown } }): string {
  let tcb = report.info?.tcb_info;
  if (typeof tcb === "string") tcb = JSON.parse(tcb);
  const compose = (tcb as { app_compose?: unknown } | undefined)?.app_compose;
  if (typeof compose !== "string") throw new Error("report has no app_compose");
  return compose;
}

interface RawReport {
  signing_address: string;
  signing_algo: string;
  intel_quote: string;
  request_nonce?: string;
  nvidia_payload?: string;
  info?: { tcb_info?: unknown };
}

export class TeeVerifier {
  private latest: Attestation | null = null;
  private inflight: Promise<Attestation> | null = null;
  private readonly fetchImpl: typeof fetch;
  private readonly verifyQuote: (q: string) => Promise<QuoteResult>;
  private readonly verifyGpu: (p: unknown) => Promise<boolean>;

  constructor(private readonly o: TeeOptions) {
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.verifyQuote = o.verifyQuote ?? dcapVerifyQuote;
    this.verifyGpu = o.verifyGpu ?? ((p) => nrasVerifyGpu(p, this.fetchImpl));
  }

  get last() {
    return this.latest;
  }

  private async checkPart(role: PartCheck["role"], r: RawReport, nonce: string): Promise<PartCheck> {
    const part: PartCheck = { role, signing_address: r.signing_address, tdx_status: "unchecked", address_bound: false, nonce_bound: false, config_bound: false, ok: false };
    try {
      if (r.request_nonce && r.request_nonce.toLowerCase() !== nonce) throw new Error("echoed nonce differs from ours");
      const q = await this.verifyQuote(r.intel_quote);
      part.tdx_status = q.status;
      const b = bindsAddressAndNonce(q.reportData, r.signing_address, r.signing_algo, nonce);
      part.address_bound = b.address;
      part.nonce_bound = b.nonce;
      part.config_bound = bindsConfig(q.mrConfigId, appComposeOf(r));
      let gpuOk = true;
      if (role === "model") {
        if (!r.nvidia_payload) throw new Error("model report has no GPU evidence");
        const payload = JSON.parse(r.nvidia_payload) as { nonce?: string; arch?: string };
        const nonceBound = String(payload.nonce ?? "").toLowerCase() === nonce;
        const verdict = await this.verifyGpu(payload);
        part.gpu = { arch: String(payload.arch ?? "unknown"), nonce_bound: nonceBound, nvidia_verdict: verdict };
        gpuOk = nonceBound && verdict;
      }
      part.ok = TDX_OK.has(q.status) && part.address_bound && part.nonce_bound && part.config_bound && gpuOk;
    } catch (e) {
      part.error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    }
    return part;
  }

  /** Fetch a fresh report with our own nonce and check everything. */
  attest(): Promise<Attestation> {
    this.inflight ??= this.doAttest().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async doAttest(): Promise<Attestation> {
    const nonce = randomBytes(32).toString("hex");
    const u = new URL(`${this.o.baseUrl}/attestation/report`);
    for (const [k, v] of Object.entries({ model: this.o.model, provider: "near", signing_algo: "ecdsa", nonce, include_tls_fingerprint: "false" })) u.searchParams.set(k, v);
    const result: Attestation = { checked_at: new Date().toISOString(), model: this.o.model, ok: false, gateway: null, models: [], verified_signers: [] };
    try {
      const res = await this.fetchImpl(u, { headers: { authorization: `Bearer ${this.o.apiKey}`, "x-no-aliasing": "true", accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`attestation report HTTP ${res.status}`);
      const body = (await res.json()) as { gateway_attestation?: RawReport; model_attestations?: RawReport[] };
      if (body.gateway_attestation) result.gateway = await this.checkPart("gateway", body.gateway_attestation, nonce);
      for (const m of body.model_attestations ?? []) result.models.push(await this.checkPart("model", m, nonce));
      result.verified_signers = result.models.filter((m) => m.ok).map((m) => m.signing_address.toLowerCase());
      result.ok = Boolean(result.gateway?.ok) && result.verified_signers.length > 0;
    } catch (e) {
      result.models.push({ role: "model", signing_address: "", tdx_status: "unchecked", address_bound: false, nonce_bound: false, config_bound: false, ok: false, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
    }
    this.latest = result;
    return result;
  }

  /** The latest attestation if it is fresh enough, else a new one. */
  async current(maxAgeMs = 30 * 60_000): Promise<Attestation> {
    if (this.latest?.ok && Date.now() - new Date(this.latest.checked_at).getTime() < maxAgeMs) return this.latest;
    return this.attest();
  }

  /**
   * Check one reply's signature against the exact bytes sent and received, and against the
   * attestation verified before the reply was requested (`before`).
   */
  async verifyReply(chatId: string, requestBody: string, responseBody: string, before: Attestation | null, tries = 3): Promise<ReplyCheck> {
    if (!before?.ok) return { status: "unavailable", reason: "no verified attestation before this reply" };
    let sig: { text?: string; signature?: string; signing_address?: string; signing_algo?: string; signature_kind?: string } | null = null;
    for (let i = 0; i < tries && !sig; i++) {
      if (i) await new Promise((ok) => setTimeout(ok, 1200));
      try {
        const u = new URL(`${this.o.baseUrl}/signature/${encodeURIComponent(chatId)}`);
        u.searchParams.set("model", this.o.model);
        u.searchParams.set("signing_algo", "ecdsa");
        const res = await this.fetchImpl(u, { headers: { authorization: `Bearer ${this.o.apiKey}` }, signal: AbortSignal.timeout(15_000) });
        if (res.status === 404) continue; // signatures live in one instance's memory; it may answer later
        if (!res.ok) return { status: "unavailable", reason: `signature HTTP ${res.status}` };
        const j = await res.json();
        if (j && typeof j === "object" && "signature" in j) sig = j;
        else return { status: "unavailable", reason: "no signature for this reply" };
      } catch (e) {
        return { status: "unavailable", reason: e instanceof Error ? e.message : String(e) };
      }
    }
    if (!sig) return { status: "unavailable", reason: "signature not found (NEAR AI keeps it in one instance's memory)" };
    if (sig.signature_kind !== "provider_tee") return { status: "failed", reason: `signature is ${sig.signature_kind ?? "unclassified"}, not from the model's TEE` };
    if (sig.signing_algo !== "ecdsa") return { status: "failed", reason: `unexpected algorithm ${sig.signing_algo}` };
    const expected = `${this.o.model}:${sha256(requestBody)}:${sha256(responseBody)}`;
    if (sig.text !== expected) return { status: "failed", reason: "signed text doesn't match the exact request and response" };
    let signer: string;
    try {
      signer = verifyMessage(sig.text, String(sig.signature)).toLowerCase();
    } catch {
      return { status: "failed", reason: "invalid signature" };
    }
    if (signer !== String(sig.signing_address).toLowerCase()) return { status: "failed", reason: "signature doesn't recover to the claimed signer" };
    if (!before.verified_signers.includes(signer)) return { status: "failed", reason: "signer is not a model we verified before the reply" };
    return { status: "verified", signer, kind: sig.signature_kind, checked_at: new Date().toISOString() };
  }
}
