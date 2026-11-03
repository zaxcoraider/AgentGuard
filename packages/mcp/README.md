# AgentGuard MCP server

Lets any MCP agent (Claude Code, Claude Desktop, Codex, ...) pay on NEAR through an **AgentGuard vault**. The agent holds only a function-call key that can *ask* the vault to pay. The vault contract decides on-chain: `paid`, `pending` (waits for the human owner) or `blocked`. A prompt-injected agent can ask for anything; the contract still says no.

## Tools

| Tool | What it does |
|---|---|
| `agentguard_pay` | Ask the vault to pay `recipient` `amount_near`. Returns `paid` / `pending` / `blocked`, the reason and the tx link |
| `agentguard_check_address` | "Is this address safe to pay?" Shared scam registry, account exists, is a contract, on the allowlist, lookalike names. Returns `allow` / `warn` / `block` + reasons |
| `agentguard_balance` | Balance, available, spent in 24h, paid / blocked / pending counts |
| `agentguard_policy` | Per-payment cap, 24h limit, approval threshold, allowlist, registry, locked |
| `agentguard_payment_status` | One payment by id (e.g. did the owner approve it?) |
| `agentguard_history` | Recent payment requests, including blocked ones |
| `agentguard_sentinel_check` | Buys Sentinel's paid check over HTTP 402: pays the price through **your** vault (your rules apply; never above `max_price_near`, default 0.02), retries with `X-PAYMENT`, returns the check + tx. Set `SENTINEL_URL` |

## Setup

```sh
cd packages/mcp
npm install
npm run build
```

Configuration (environment variables):

| Variable | Default | Meaning |
|---|---|---|
| `AGENTGUARD_VAULT` | (required) | Your vault, e.g. `demo2.agentguard.testnet` |
| `NEAR_NETWORK` | `testnet` | `testnet` or `mainnet` |
| `AGENTGUARD_AGENT_KEY` | read from file | The agent's `ed25519:...` function-call key |
| `AGENTGUARD_KEY_FILE` | `~/.near-credentials/<network>/<vault>.json` | Where to read the key if the variable above is not set (created by `scripts/gen-agent-key.mjs`) |
| `NEAR_RPC_URL` | FastNEAR public RPC | Override the RPC endpoint |

Without a key the server still runs, read-only.

### Claude Code

```sh
claude mcp add agentguard -e AGENTGUARD_VAULT=demo2.agentguard.testnet -- node /absolute/path/to/packages/mcp/dist/index.js
```

Then ask Claude: *"Check if agentguard-evil.testnet is safe to pay, then pay agentguard-shop.testnet 0.05 NEAR for coffee."*

### Any MCP client (JSON config)

```json
{
  "mcpServers": {
    "agentguard": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp/dist/index.js"],
      "env": { "AGENTGUARD_VAULT": "demo2.agentguard.testnet", "NEAR_NETWORK": "testnet" }
    }
  }
}
```

## Try it without an agent

```sh
npm test                       # 8 unit tests: scoring, lookalikes, NEAR amount math
npx tsx scripts/live-demo.ts   # starts the server over stdio and calls every tool on testnet
```

`live-demo.ts` needs the agent key for `demo2.agentguard.testnet` to make payments. Without it, the read-only tools still work and `agentguard_pay` returns an error saying the key is missing.

Expected (recorded 2026-11-03):

```text
agentguard_check_address agentguard-evil.testnet -> block: flagged in the shared AgentGuard registry: ...
agentguard_check_address agentguard-sh0p.testnet -> block: does not exist; looks like trusted account agentguard-shop.testnet
agentguard_pay agentguard-shop.testnet 0.05     -> paid
agentguard_pay agentguard-evil.testnet 0.2      -> blocked, recipient_flagged
agentguard_pay agentguard-shop.testnet 5        -> blocked, over_per_payment_limit
```

## What the agent can't do

The key is limited by NEAR itself to `request_payment` on the vault. It cannot transfer NEAR, call owner methods (withdraw, set_policy, approve, ...), attach deposits, call other contracts, add keys, deploy code or delete the account. Proof on testnet: `scripts/prove-agent-key.sh` (12/12 refused) and `docs/TESTNET-RESULTS.md` in the repo root.

`agentguard_check_address` is advice for the agent. The rules that matter run in the vault contract, whatever the agent decides.
