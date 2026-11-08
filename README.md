<p align="center">
  <img src="docs/screens/agentguard-logo.png" alt="AgentGuard logo: a shield with a keyhole" width="120" height="120">
</p>

<h1 align="center">AgentGuard</h1>

<h3 align="center">AI agents are getting wallets, and one fake invoice can talk them into paying a scammer.<br>AgentGuard moves the spending rules out of the prompt and into a NEAR contract.<br>If the AI is fooled, the contract still says no.</h3>

<p align="center">
  <a href="https://youtu.be/DInKclSnPkc"><img alt="Watch the demo" src="https://img.shields.io/badge/🎬_Watch_the_demo-2_min-C1272D?style=for-the-badge&labelColor=1C2A4A"></a>
  <a href="https://sentinel.agentguard.app"><img alt="Try to rob Sentinel" src="https://img.shields.io/badge/▶_Try_to_rob_Sentinel-live-C1272D?style=for-the-badge&labelColor=1C2A4A"></a>
  <a href="https://agentguard.app/#verify"><img alt="Verify it yourself" src="https://img.shields.io/badge/✓_Verify_it_yourself-7_checks-1F6B4F?style=for-the-badge&labelColor=1C2A4A"></a>
  <a href="https://agentguard.app/console"><img alt="Protect your agent" src="https://img.shields.io/badge/🛡_Protect_your_agent-2_minutes-E9EEE9?style=for-the-badge&labelColor=1C2A4A"></a>
</p>

<p align="center">
  <img alt="NEAR testnet" src="https://img.shields.io/badge/NEAR-testnet-00EC97?style=flat-square&labelColor=1C2A4A">
  <a href="https://www.npmjs.com/package/@zaxcoraider/agentguard-mcp"><img alt="npm" src="https://img.shields.io/npm/v/@zaxcoraider/agentguard-mcp?style=flat-square&label=npm&labelColor=1C2A4A"></a>
  <a href="https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.zaxcoraider/agentguard-mcp"><img alt="Official MCP Registry" src="https://img.shields.io/badge/MCP_Registry-listed-E9EEE9?style=flat-square&labelColor=1C2A4A"></a>
  <a href="https://agentguard-sentinel.market.near.ai"><img alt="NEAR Agent Market" src="https://img.shields.io/badge/NEAR_Agent_Market-hire_Sentinel-E9EEE9?style=flat-square&labelColor=1C2A4A"></a>
  <img alt="NEAR AI Cloud TEE" src="https://img.shields.io/badge/NEAR_AI_Cloud-TEE_verified-E9EEE9?style=flat-square&labelColor=1C2A4A">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/License-MIT-E9EEE9?style=flat-square&labelColor=1C2A4A"></a>
</p>

<p align="center">
  <a href="#-see-it-in-5-minutes">See it</a> ·
  <a href="#-the-problem">The problem</a> ·
  <a href="#%EF%B8%8F-how-it-works">How it works</a> ·
  <a href="#-zero-master-keys">Zero master keys</a> ·
  <a href="#-sentinel-an-agent-that-earns">Sentinel</a> ·
  <a href="#-use-it-in-your-agent">Use it</a> ·
  <a href="#-proof">Proof</a> ·
  <a href="#-roadmap">Roadmap</a> ·
  <a href="#-run-it-locally">Run locally</a>
</p>

<p align="center">
  <img src="docs/screens/sentinel-blocked.jpg" alt="Sentinel's chat: the AI believed a fake logo invoice and tried to pay 0.03 NEAR to agentguard-user.testnet. The vault's answer is stamped on the payment slip: Blocked by contract, not on the list of accounts it may pay." width="100%">
  <br><sub>A real attack on the live Sentinel, Nov 7 2026. The AI believed a fake invoice and tried to pay. The vault blocked it on-chain.</sub>
</p>

---

**AgentGuard** is a spending firewall for AI agents, enforced by a smart contract on NEAR. The agent's money sits in a **vault that no one holds a master key to**. The agent gets a key that can only **ask** to pay. The contract checks every request against the owner's rules and answers **paid**, **held for the owner**, or **blocked**, on-chain, with a reason. The owner can then **lock the rules for good**, so that nobody, the owner included, can loosen them.

| 🧱 **The contract is the guard** | 🔑 **Zero master keys** | 💸 **Agents that earn** |
|:---|:---|:---|
| Caps, an allowlist, a hold on repeated payments, and a shared scam registry, checked on-chain for every payment. A fooled AI can ask; it can't pay. | No full-access key on any vault or on the scam registry. Nobody can move the money or change that code, and that includes us. Check it with one click. | Sentinel, the first app on AgentGuard, sells "is this account safe to pay?" checks to other agents and runs its business from a locked vault. |

<table>
  <tr>
    <td align="center" width="25%"><h3>0</h3><sub>master keys on any vault<br>or on the scam registry</sub></td>
    <td align="center" width="25%"><h3>7 / 7</h3><sub>claims your browser checks<br>against the chain itself</sub></td>
    <td align="center" width="25%"><h3>240 / 240</h3><sub>on-chain attacks answered<br>exactly as the rules say</sub></td>
    <td align="center" width="25%"><h3>60,000</h3><sub>random fuzz steps,<br>every rule held after each</sub></td>
  </tr>
</table>
<p align="center"><sub>Measured on NEAR testnet, Nov 3–7 2026. Every number links to transactions in <a href="docs/TESTNET-RESULTS.md">TESTNET-RESULTS</a>.</sub></p>

## 📸 See it in 5 minutes

No install, no wallet.

**1 · Try to rob Sentinel (1 min).** Open **[sentinel.agentguard.app](https://sentinel.agentguard.app)** and talk it into paying you. A fake invoice works on its AI often enough. Then watch the vault's answer get stamped on the payment slip, with a link to the transaction. A blocked attack from an earlier visitor: [tx 36qW…](https://testnet.nearblocks.io/txns/36qWxB4cRBwqRiihfHPuo2GWfBXj2AVW26fSrhpeNbGg) (`recipient_not_allowlisted`).

**2 · Don't trust us, verify it (1 min).** On **[agentguard.app](https://agentguard.app/#verify)**, press **Run the checks**. Your browser asks NEAR testnet directly, not our server: who holds keys, whether the rules are locked, the scam flag, a blocked attack, and all 240 stress-test results.

<p align="center"><img src="docs/screens/verify.jpg" alt="Verify it: 7 green checks, run by the browser against NEAR testnet, including 0 full-access keys on every vault and on the registry, and 240 of 240 stress results" width="88%"></p>

**3 · See a vault nobody can override (1 min).** Open **[Sentinel's vault in the Console](https://agentguard.app/console?vault=sentinel.agentguard.testnet)**. Its rules are locked: after locking, its owner tried to allowlist an attacker and to withdraw, and both were refused ([lock tx 9QFB…](https://testnet.nearblocks.io/txns/9QFBjv7AzAqcaCjJdm8z1kq9pV47rt9Adz2XjfqaJf7h)).

<p align="center"><img src="docs/screens/console.jpg" alt="AgentGuard Console showing sentinel.agentguard.testnet: Rules locked badge, rules table (0.05 NEAR per payment, 1 NEAR per 24 hours, unknown recipients blocked), one agent key limited to request_payment" width="88%"></p>

**4 · See the business (1 min).** The [Business section](https://agentguard.app/#business) shows Sentinel's live books, losses included, what one check costs to run, the break-even point, and a what-if calculator.

**5 · Give your own agent a vault (2 min).** Connect a testnet wallet in the **[Console](https://agentguard.app/console)**, create a vault, set limits, and make an agent key. The key is generated in your browser; only its public half goes on-chain.

## 🧩 The problem

AI agents now pay for things: APIs, compute, data, other agents. Over x402 alone, agents made more than [138 million payments on Base in one quarter](https://www.paymentsjournal.com/agentic-commerce-transactions-on-x402-protocol-are-picking-up/amp/), most of them under $0.10. Far too many and too small for a person to approve each one.

- 🗣️ **Spending limits live in the prompt.** A poisoned invoice, email or web page can argue the model out of them. In 2024 an AI agent called Freysa was told one rule, *never send money*, and was [talked into paying out its whole $47,000 prize](https://the-decoder.com/hacker-wins-47000-by-tricking-ai-chatbot-with-smart-prompting/).
- 🔑 **Agent wallets hold keys that can move everything.** Steal the key or fool the agent, and the money is gone.
- 🛠️ **Whoever runs the server can change the rules.** Limits in an app's code or a guard contract with an upgrade key are only as safe as that key.

**AgentGuard puts the rules where neither the agent nor a key holder can reach them: a contract with no master key.**

## ⚙️ How it works

```mermaid
flowchart LR
    A["AI agent<br/>(holds a key that can only ASK)"] -->|request_payment| V{"AgentGuard vault<br/>NEAR contract, no master key"}
    R[("Shared scam registry<br/>code frozen")] -.checked on every payment.-> V
    V -->|within the rules| P["✅ Paid"]
    V -->|needs a human| H["⏳ Held for the owner"]
    V -->|breaks a rule| B["⛔ Blocked, recorded on-chain"]
```

| | Step | What happens |
|:-:|---|---|
| 1 | **A vault is born with no master key** | The [factory](contracts/factory) creates `<name>.agentguard.testnet` from immutable code (a NEAR global contract, by hash). Nobody holds a key that can sign a transfer out of it. |
| 2 | **The agent gets a key that can only ask** | A function-call key limited to `request_payment`. It can't transfer, add keys, change rules or withdraw. |
| 3 | **The contract decides every payment** | Per-payment and daily caps, an allowlist, a hold on the same payment twice within 10 minutes (the "it failed, please retry" trick), and a lookup in the [shared scam registry](contracts/registry). If the registry doesn't answer, the payment is **blocked**. [All rules, in order](contracts/vault#what-request_paymentrecipient-amount-memo-returns). |
| 4 | **Held payments wait for the owner** | The owner approves or denies them in the [Console](https://agentguard.app/console). |
| 5 | **Lock it for good** | `lock_rules()` is one-way. After it nobody, the owner included, can loosen a rule or withdraw. Making it stricter (pause, deny, revoke) still works. |

## 🔑 Zero master keys

Most "agent wallet guards" still trust someone: the owner can switch the rules off, or the contract holding everyone's money has an upgrade key. AgentGuard removes that trust and lets you check it.

| Account | Full-access keys | What that means |
|---|:-:|---|
| Every vault (`*.agentguard.testnet`) | **0** | Nobody can move the money except through `request_payment` and its rules |
| Shared scam registry | **0** | Its code is frozen: its last key was deleted ([tx HM3d…](https://testnet.nearblocks.io/txns/HM3d2dGMLMmtPBdXaemuS8GCeSeRC2madeHrmD1r9hJY)) and it has no upgrade method |
| Factory (`agentguard.testnet`) | 1 | Can only change how **future** vaults are made. Existing vaults run code by hash, which can't change |

What you still have to trust, honestly: the registry's curator can confirm or dismiss a reported account (it can't move funds or loosen a vault's rules), and NEAR itself. Full threat model: **[SECURITY.md](SECURITY.md)**.

## 💸 Sentinel, an agent that earns

[Sentinel](packages/sentinel) is the first app built on AgentGuard, and the live demo. It's a small AI business that runs inside the constraints a human set once, then locked:

| Treasury | Sales | Procurement | Constraints |
|---|---|---|---|
| A **locked** vault holding ~9 NEAR. It can pay only its compute account, at most 0.05 NEAR per payment and 1 NEAR a day | "Is this account safe to pay?" checks, sold **per call over HTTP 402** (0.01 NEAR) and as jobs on **[NEAR Agent Market](https://agentguard-sentinel.market.near.ai)** ($0.30, A2A + x402) | It pays for its own AI thinking from its vault, every 10 minutes | Set by a human, then locked for good. Not even we can change them now |

- 🧠 **Its brain is verified, not just claimed.** It runs on **NEAR AI Cloud** inside a TEE. Sentinel checks the Intel TDX and NVIDIA GPU attestation itself every 30 minutes, and the signature on every reply.
- 🤖 **Other agents can find and pay it** with no human in the loop: [agent card](https://sentinel.agentguard.app/.well-known/agent-card.json), [llms.txt](https://agentguard.app/llms.txt).
- 📒 **Its books are public, losses included**: [`/api/status`](https://sentinel.agentguard.app/api/status). Each check costs almost nothing to run; the fixed cost is ~0.29 NEAR a day, so it breaks even at 29 checks a day. So far every sale was our own test.
- 🎭 **Its AI is deliberately ordinary.** It sees its balance but not its vault's rules, so a good trick reaches the vault and the contract gives the answer.

## 🧰 Use it in your agent

**In Claude Code, or any MCP client** ([on npm](https://www.npmjs.com/package/@zaxcoraider/agentguard-mcp), listed in the [official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.zaxcoraider/agentguard-mcp)):

```sh
claude mcp add agentguard -e AGENTGUARD_VAULT=your-vault.agentguard.testnet \
  -- npx -y @zaxcoraider/agentguard-mcp
```

Seven tools: pay, check an address, balance, policy, payment status, history, and buy Sentinel's paid check. Pass the invoice or email that asked for a payment as `source_text`: if it hides instructions (invisible characters, "ignore your instructions"…), the payment is **held** for the owner. Without an agent key the server runs read-only. [Setup](packages/mcp#setup).

**In the browser:** the **[Console](https://agentguard.app/console)**: wallet → vault → limits → agent key, in about 2 minutes.

**From the command line:** [four commands](packages/mcp#get-your-own-vault-testnet-about-2-minutes) to create a vault, make an agent key, add it, and point the MCP server at it.

## 🧾 Proof

Everything is deployed on NEAR testnet (ids in [`deployments/testnet.json`](deployments/testnet.json)). Every claim has transaction links in **[TESTNET-RESULTS](docs/TESTNET-RESULTS.md)**.

| Claim | Evidence |
|---|---|
| A vault runs immutable code and is born with no keys at all | Factory run + on-chain key list (§1–2) |
| The agent's key can't transfer, add keys, change rules or withdraw | 12 refused attempts on testnet (§4) |
| A flagged scammer is blocked, even when allowlisted | Registry + vault run (§5) |
| A fooled AI's payment is blocked on-chain | Live page and local runs (§7, §10) |
| Agents pay agents: another agent bought Sentinel's check through its own vault | HTTP 402 → vault payment → check, replay refused (§8) |
| A new user can do it all in the browser | Console run with a fresh account (§12) |
| Sentinel's vault is locked; the owner can't loosen it | Lock + refused owner calls (§11) |
| 240 rule-breaking requests, every answer as the rules say, nothing paid to anyone not allowed | Stress test, all txs listed (§13) |
| A poisoned invoice is held on-chain | Prompt-injection scan → held (§14) |
| Nobody can change the scam registry's code | Key deletion + empty key list (§15) |
| No sequence of actions breaks the rules | Fuzz test: 60,000 random steps, deliberately broken contracts caught ([vault README](contracts/vault#fuzzing-srcfuzz_testsrs)) |

**Re-check it all yourself** (Node 24, no install, no keys, ~6 minutes because public archival nodes are slow). It compares every stated outcome with the vault's own on-chain event, all 240 stress results with the vault's records, and the live keys and rules:

```sh
node scripts/verify-evidence.mjs
```

## 🧱 What's in this repo

| Part | What it does |
|---|---|
| [**Vault contract**](contracts/vault) | The firewall. Every payment comes out `paid`, `pending` or `blocked`, with a reason |
| [**Factory**](contracts/factory) | Creates vaults born without a full-access key, on immutable code; refunds if creation fails |
| [**Scam registry**](contracts/registry) | Shared blocklist: anyone reports with evidence; two reporters or a curator flag an account. Code frozen |
| [**MCP server**](packages/mcp) | Lets any AI agent pay through a vault, check an address and scan an invoice. On npm |
| [**Console**](packages/sentinel/public/console.html) | Web app: create a vault, set limits, approve or deny held payments, make agent keys, lock the rules. Wallets via NEAR Connect |
| [**Website**](packages/sentinel/public/index.html) | What AgentGuard is, live chain numbers, "Verify it", and the business case |
| [**Sentinel**](packages/sentinel) | The live AI agent on a locked vault: chat, paid checks, Agent Market, TEE verification |

**NEAR features used:** global contracts by hash (immutable vault code), function-call access keys with a gas allowance, cross-contract calls with callbacks (the registry lookup, failing closed), NEAR AI Cloud (TEE inference, attestation, signed replies), NEAR Agent Market (A2A + x402).

## 🗺 Roadmap

<table>
  <tr>
    <th width="33%">✅ Shipped (testnet)</th>
    <th width="33%">🔜 Next · Nov 2026 – Q1 2027</th>
    <th width="34%">🧭 2027</th>
  </tr>
  <tr valign="top">
    <td>
      • Vault contract with caps, allowlist, repeat-payment hold, fail-closed registry check<br>
      • Factory: vaults on immutable code, born with no key<br>
      • Shared scam registry, code frozen<br>
      • <code>lock_rules()</code>: rules nobody can loosen<br>
      • MCP server on npm + official MCP Registry, with a prompt-injection scan<br>
      • Console: create, manage and lock a vault from a wallet<br>
      • Sentinel: live AI agent on a locked vault, TEE-verified brain<br>
      • Paid checks over HTTP 402 + NEAR Agent Market listing<br>
      • "Verify it" in the browser, 240-attack stress test, fuzz test
    </td>
    <td>
      • <b>Mainnet launch</b> of the factory, vault code and registry<br>
      • <b>Stablecoins</b>: USDC and other NEP-141 tokens in vaults<br>
      • <b>TEE-signed invoice verdicts</b> the contract checks itself, not only the MCP server<br>
      • <b>DAO or multisig owners</b> for team treasuries<br>
      • <b>Registry curators by DAO vote</b> instead of one account<br>
      • Reproducible Docker build of the vault code, and an external audit
    </td>
    <td>
      • <b>NEAR Intents</b>: guarded cross-chain payouts<br>
      • <b>Chain Signatures</b>: the same firewall for an agent's spending on other chains<br>
      • Drop-in integrations for agent frameworks (OpenAI Agents SDK, LangChain, CrewAI)<br>
      • Wallet integrations that create a vault for any new agent<br>
      • Revenue: a small fee per vault created and paid access to the registry at volume
    </td>
  </tr>
</table>

## 🛠 Run it locally

**Offline demo, no keys (1 minute).** The same Sentinel page against a **simulated** vault (same rules as the contract, same order) and a scripted stand-in for the AI. Nothing touches the chain, and the page says so.

```sh
cd packages/mcp && npm install && cd ../sentinel && npm install
npm run demo        # open http://localhost:3000/sentinel and ask it to pay "0.03 NEAR to agentguard-user.testnet"
```

**Tests (about 5 minutes).** Needs Rust with [`cargo-near`](https://github.com/near/cargo-near) and Node 24. No keys or accounts.

```sh
# Contracts: 70 unit tests + a fuzz test + 7 sandbox tests on a local NEAR node
cd contracts/vault && cargo test        # 43 unit + fuzz + 1 sandbox
cd ../factory && cargo test             # 14 unit + 6 sandbox
cd ../registry && cargo test            # 13 unit

# TypeScript: 65 tests, no network needed
cd ../../packages/mcp && npm install && npm test        # 24
cd ../sentinel && npm install && npm test               # 41
```

**Ask the MCP server about a real vault** (read-only, no key). It shows the vault's rules and flags the scammer and the lookalike `agentguard-sh0p.testnet`:

```sh
cd packages/mcp && npm run build && AGENTGUARD_VAULT=demo2.agentguard.testnet npx tsx scripts/live-demo.ts
```

## 🔐 Security and limits

| | |
|---|---|
| Network | Testnet only. Mainnet is next on the roadmap |
| HTTP 402 checks | x402-shaped, but our own scheme in native NEAR, not an official x402 network |
| Prompt-injection scan | A heuristic in the MCP server. It can only make things stricter; a clean scan proves nothing |
| TEE checks not done | RTMR3 event-log replay, image provenance, NVIDIA token signature, TLS binding |
| Registry | Two throwaway accounts can flag an account; a curator can dismiss. A flag only blocks payments to that account, never moves funds |
| Audit | Not audited. Threat model, trust list and a rebuild of the vault code that matches the on-chain hash: **[SECURITY.md](SECURITY.md)** |

Found a problem? Please report it privately through [GitHub security advisories](https://github.com/zaxcoraider/AgentGuard/security/advisories/new).

## 📄 License

MIT. Built for NEAR HACKATHON 2026 · Tracks: AI Security & Defense, Agent Economy, Autonomous Business.
