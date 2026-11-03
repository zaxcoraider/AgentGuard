# AgentGuard

**An on-chain spending firewall for AI agents on NEAR, and Sentinel, an AI agent that lives on one and invites you to rob it.**

An AI agent that can pay is one prompt injection away from paying the wrong person. AgentGuard moves the rules out of the agent and into a NEAR contract:

- The money sits in a **vault account that has no full-access key**. It was born without one, from immutable code ([factory](contracts/factory)).
- The agent holds only a **function-call key that can call `request_payment`**. It can ask; it cannot pay.
- The **vault contract decides**: `paid`, `pending` (a human approves) or `blocked`, using per-payment and daily caps, an allowlist, a 10-minute repeat-payment hold, and a **shared scam registry** that it checks on every payment and that fails closed ([vault](contracts/vault), [registry](contracts/registry)).
- After `lock_rules()`, **not even the owner** can loosen the rules or withdraw.

**Sentinel** ([packages/sentinel](packages/sentinel)) is the proof: a real AI agent whose treasury is an AgentGuard vault. It pays for its own thinking on-chain, earns by selling "is this address safe to pay?" checks to other agents over HTTP 402, and anyone can chat with it and try to talk it into paying them. Fooling the AI is level 1. Getting the money out is level 2, and the contract says no.

Any MCP agent (Claude, Codex, ...) can use a vault through the [MCP server](packages/mcp).

**Try to rob Sentinel: https://sentinel-47ip.onrender.com** (NEAR testnet)

## Try it: do X, see Y

Everything runs against NEAR **testnet**. Ids are in [`deployments/testnet.json`](deployments/testnet.json), and every claim has a tx link in [`docs/TESTNET-RESULTS.md`](docs/TESTNET-RESULTS.md).

Needs Rust + [`cargo-near`](https://github.com/near/cargo-near) for the contracts and Node ≥ 20 for the packages. No keys are needed for anything in this section.

**1. Run the contract tests** → 70 unit tests, plus sandbox tests on a local NEAR node:
```sh
cd contracts/vault && cargo test      # 43 unit + 1 sandbox
cd ../factory && cargo test           # 14 unit + 6 sandbox (vault born with no full-access key, rollback + refund)
cd ../registry && cargo test          # 13 unit
```

**2. See that a vault has no full-access key** → only function-call keys limited to `request_payment`:
```sh
curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"sentinel.agentguard.testnet"}}'
```

**3. See the shared registry flag a scammer** → `"status":"flagged"`:
```sh
curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"call_function","finality":"final","account_id":"registry.agentguard.testnet","method_name":"get_status","args_base64":"'$(printf '{"account":"agentguard-evil.testnet"}' | base64)'"}}' \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(Buffer.from(JSON.parse(d).result.result).toString()))'
```

**4. Run the TypeScript tests** → MCP server 16, Sentinel 22 (no network: scripted model, fake vault, recorded tx shapes, a real recorded NEAR AI attestation):
```sh
cd packages/mcp && npm install && npm test
cd ../sentinel && npm install && npm test
```

**5. Ask the MCP server about a vault** (read-only, no key needed) → policy, balance, `block` for the flagged account and for the lookalike `agentguard-sh0p.testnet`:
```sh
cd packages/mcp && npm run build && AGENTGUARD_VAULT=demo2.agentguard.testnet npx tsx scripts/live-demo.ts
```
Without the demo agent key, the read-only tools work and `agentguard_pay` returns an error saying the key is missing.

## What's in the repo

| Path | What |
|---|---|
| [`contracts/vault`](contracts/vault) | The firewall. Decision table of every `paid` / `pending` / `blocked` reason, `lock_rules()` |
| [`contracts/factory`](contracts/factory) | Creates vaults on immutable global code, with no `AddKey`; rollback + refund |
| [`contracts/registry`](contracts/registry) | Shared scam registry: report, flag, curator dismiss |
| [`packages/mcp`](packages/mcp) | MCP server, 7 tools: pay, check address, balance, policy, payment status, history, buy Sentinel's paid check |
| [`packages/sentinel`](packages/sentinel) | Sentinel: chat API, metabolism heartbeat, paid checks over HTTP 402 |
| [`scripts`](scripts) | Make an agent key; prove on testnet what that key can and can't do |

## Status (honest)

| Feature | Status |
|---|---|
| Vault, factory, registry on testnet | ✅ working, tx links in `docs/TESTNET-RESULTS.md` |
| A vault with no full-access key, on immutable code | ✅ testnet |
| Shared registry blocks a flagged recipient, fails closed | ✅ testnet |
| MCP server (stdio) | ✅ tested live on testnet |
| Sentinel: chat, pays for its thinking, prompt-injected payment blocked on-chain | ✅ live at https://sentinel-47ip.onrender.com (testnet) |
| Sentinel earns: paid checks over HTTP 402 in native NEAR, verified on-chain by Sentinel | ✅ live (testnet). x402-shaped, but our own NEAR scheme, not an official x402 network |
| `lock_rules()` on Sentinel's vault | ✅ locked on testnet; the owner's attempts to allowlist an attacker and withdraw were refused (`docs/TESTNET-RESULTS.md` §11) |
| Public Sentinel page + hosted server | ✅ https://sentinel-47ip.onrender.com (Render) |
| TEE attestation verified in code | ✅ Sentinel checks NEAR AI Cloud's Intel TDX quotes (dcap-qvl), the nonce + signer binding, the config measurement and NVIDIA GPU attestation (NRAS), then the signature on each reply over the exact bytes. Not done: RTMR3 event-log replay, image provenance, NRAS JWT signature, TLS binding |
| Mainnet | ❌ testnet only |

## License
MIT
