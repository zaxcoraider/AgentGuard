# AgentGuard Vault

An on-chain spending firewall for one AI agent (or a few). The vault account holds the money. The agent only holds a **function-call key that can call `request_payment` and nothing else**, so it cannot sign a transfer. Every request is checked here, in the contract, against the owner's rules. A hacked or prompt-injected agent can ask for anything; the contract decides.

Vaults made by the [factory](../factory) run immutable code (a global contract, by hash) and are born **without any full-access key**.

## What `request_payment(recipient, amount, memo?)` returns

The checks run in this order. The first one that hits decides.

| Result | Reason | When |
|---|---|---|
| `blocked` | `vault_paused` | owner paused the vault |
| `blocked` | `cannot_pay_self` | recipient is the vault itself |
| `blocked` | `over_per_payment_limit` | amount > `max_per_payment` |
| `blocked` | `over_daily_limit` | would go over `daily_limit` in the rolling 24h window |
| `blocked` | `insufficient_funds` | balance minus the 0.5 NEAR storage reserve is too low |
| `blocked` | `registry_unavailable` | the shared registry didn't answer (**fails closed**) |
| `blocked` | `recipient_flagged` | flagged in the shared registry |
| `blocked` | `recipient_not_allowlisted` | not on the allowlist and `unknown_recipient = block` |
| `pending` | `unknown_recipient` | not on the allowlist and `unknown_recipient = require_approval` |
| `pending` | `recipient_reported` | one report in the registry, not yet flagged |
| `pending` | `over_approval_threshold` | amount > `approval_threshold` |
| `pending` | `repeat_payment` | same recipient and amount within 10 minutes ("it failed, please retry" trick) |
| `pending` | `flagged_for_review` | the agent asked for review itself (`force_review`) |
| `blocked` | `too_many_pending` | 20 approvals already open (stops spamming the owner) |
| `paid` | | everything else: sent now |

A blocked payment is a normal result, not a panic, so it stays in on-chain history and stats. Pending payments expire after `pending_ttl_ns`.

## Methods

**Agent** (its function-call key): `request_payment`.

**Owner** (1 yoctoNEAR attached): `approve(id)`, `deny(id)`, `set_policy`, `add_to_allowlist`, `remove_from_allowlist`, `add_agent(public_key, label, gas_allowance?)`, `revoke_agent`, `set_paused`, `withdraw(amount)`, `set_registry`, `lock_rules()`.

**Anyone**: `deposit()` (payable; extra JSON args like `{memo}` are ignored, which [Sentinel's paid checks](../../packages/sentinel) use as a payment tag), and the views `get_owner`, `get_policy`, `get_registry`, `is_locked`, `get_allowlist`, `get_agents`, `get_payment(id)`, `get_pending`, `get_history(before?, limit?)`, `get_stats`.

### `lock_rules()`: a one-way switch
After it, nobody, owner included, can loosen the vault: no `set_policy`, allowlist changes, `set_registry`, `add_agent`, `approve` or `withdraw`. Stricter actions still work: `deny`, `remove_from_allowlist`, `revoke_agent`, and `set_paused` (pausing blocks everything; unpausing only returns to the locked rules). Pending payments can only be denied or expire. This is what makes "try to rob Sentinel" a fair game.

## Policy
```json
{
  "max_per_payment": "1000000000000000000000000",
  "daily_limit": "3000000000000000000000000",
  "approval_threshold": "500000000000000000000000",
  "unknown_recipient": "require_approval",
  "pending_ttl_ns": "86400000000000"
}
```
Amounts are in yoctoNEAR (1 NEAR = 10^24). `unknown_recipient` is `block` or `require_approval`.

## Build and test
```sh
cargo near build non-reproducible-wasm
cargo test            # 43 unit tests + 1 sandbox test (local NEAR node)
```

Live on testnet: see [`deployments/testnet.json`](../../deployments/testnet.json) and [`docs/TESTNET-RESULTS.md`](../../docs/TESTNET-RESULTS.md).
