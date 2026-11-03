# Testnet results (2026-11-03)

Sections 1–4: vault v1. Section 5: vault v2 with the shared registry.

Everything here happened on NEAR **testnet** and can be checked on the explorer. Ids: [deployments/testnet.json](../deployments/testnet.json).

## 1. Vault code is immutable

The vault wasm was published once as a **global contract by hash**: `AFhugPmntEUbiDTWsC1RKAJ1T686RV9DpMzWFMRxQQjv` ([tx](https://testnet.nearblocks.io/txns/6apkVZAwkuz2gQp9QNx6S7EvVKxPXZQhrRfrwYGJQJHo)). Code referenced by hash can never change. The factory `agentguard.testnet` ([tx](https://testnet.nearblocks.io/txns/99TQhpBuaTtcT9GVRAeDxNauUfpfSnJ1X2i39DJ4qAtF)) creates every vault on that hash.

## 2. A vault is born with no keys

`create_vault` made `demo.agentguard.testnet` for owner `agentguard-user.testnet` with 3 NEAR ([tx](https://testnet.nearblocks.io/txns/AB358ZxZAZ3kWKJ26rhmZ9aSxQCTTxwDfMm58LmVibCV)). Right after creation:

```text
view_account:         global_contract_hash = AFhugPmntEUbiDTWsC1RKAJ1T686RV9DpMzWFMRxQQjv, storage_usage = 524
view_access_key_list: { "keys": [] }
```

The owner then added one agent key ([tx](https://testnet.nearblocks.io/txns/Eq5QgBkNw4ZpTNRWgupqjLWrH9awAU53updkesWs2U48)). It is now the only key on the vault:

```text
ed25519:TbhDorExjY7934FFsRZ5WmyUHdhwkCrWfvQF3ktkXre
FunctionCall { method_names: ["request_payment"], receiver_id: "demo.agentguard.testnet", allowance: 0.25 NEAR }
```

Check it yourself:

```sh
near account list-keys demo.agentguard.testnet network-config testnet now
```

## 3. The policy on real payments

Policy: max 1 NEAR per payment, 3 NEAR per 24h, over 0.5 NEAR needs approval, unknown recipients need approval. Allowlist: `agentguard-shop.testnet`.

| # | Agent asks | Result | Reason | Tx |
|---|---|---|---|---|
| 0 | 0.2 NEAR to the shop | **paid** | | [HZ86…](https://testnet.nearblocks.io/txns/HZ863cQASZhAChgaBKxC8TZLJmGLx4b7F1Lq2xbi4RMs) |
| 1 | the same 0.2 NEAR again ("payment failed, retry") | **pending** | `repeat_payment` | [DGoY…](https://testnet.nearblocks.io/txns/DGoYvmL2UBnooG7dGomBAMQCA8koc7BwcmbYpxksk8Ke) |
| 2 | 0.3 NEAR to the attacker (prompt injection) | **pending** | `unknown_recipient` | [3tYk…](https://testnet.nearblocks.io/txns/3tYkLzeWeErS6zWgA1EZwUadBMUMu3Ae1aqhtmMGn4Bo) |
| 3 | 2 NEAR (drain attempt) | **blocked** | `over_per_payment_limit` | [HsDC…](https://testnet.nearblocks.io/txns/HsDCHas9rMDyxa23mLSzimf7Nqt65UQGpZhDq419ubqC) |
| 4 | 0.7 NEAR to the shop | **pending** | `over_approval_threshold` | [2gps…](https://testnet.nearblocks.io/txns/2gpsgGgxhNxL7nPvXTJ6xENtvoBke2ztpTk3MVJNcpQf) |
| | owner approves #4 | **approved**, paid | | [FbA4…](https://testnet.nearblocks.io/txns/FbA4Eyzw4c88jYbJoTnRdpLqS43SqA4xfzn9zpvcYCQU) |
| | owner denies #2 and #1 | **denied** | | [7pmw…](https://testnet.nearblocks.io/txns/7pmwwZ7S8BbKasCxSbusFiVruGiw4rPdDZMvHM1eGeAC), [9gXb…](https://testnet.nearblocks.io/txns/9gXbFvxcPW6KLz5Dxo1ebUyxWFZxs8xLvScxnHwKUpiN) |

After this: 2 payments paid (0.9 NEAR), 1 blocked (2 NEAR), 0 pending. The attacker received nothing.

```sh
near contract call-function as-read-only demo.agentguard.testnet get_stats json-args {} network-config testnet now
```

## 4. What the agent key cannot do

`scripts/prove-agent-key.sh` tries every dangerous action with the agent's key. It only counts a PASS when NEAR refuses for a permission reason (rate limits and other errors are retried, then reported as UNSURE).

```text
PASS  send NEAR straight to the attacker  -> refused: requires a full permission access key
PASS  call withdraw  -> refused: method name <withdraw> isn't allowed by the access key
PASS  change the policy  -> refused: method name <set_policy> isn't allowed by the access key
PASS  allowlist the attacker  -> refused: method name <add_to_allowlist> isn't allowed by the access key
PASS  approve its own pending payment  -> refused: method name <approve> isn't allowed by the access key
PASS  unpause / pause the vault  -> refused: method name <set_paused> isn't allowed by the access key
PASS  add a second agent key  -> refused: method name <add_agent> isn't allowed by the access key
PASS  attach a deposit to request_payment  -> refused: deposit with a function call action is not allowed
PASS  call a different contract  -> refused: doesn't match the access key
PASS  add a full-access key  -> refused: requires a full permission access key
PASS  deploy new code  -> refused: requires a full permission access key
PASS  delete the vault (send all to attacker)  -> refused: requires a full permission access key

Result: 12 PASS, 0 FAIL, 0 UNSURE
(near CLI checks each transaction against the key's on-chain permission before sending;
 the same limits are enforced by the NEAR runtime, see contracts/*/tests/sandbox.rs)
```

The near CLI checks each transaction against the key's permission (read from the chain) before sending it. The NEAR runtime enforces the same limits for transactions that are sent anyway: `contracts/vault/tests/sandbox.rs` and `contracts/factory/tests/sandbox.rs` send them to a local node and check that they fail.

## 5. Shared registry: one vault's attacker is blocked everywhere (vault v2)

Vault code v2 (`BBUDpRJDfVgX6UFAFQjhb9rUMoS58Fq99kpVa6zeZjzA`, [publish tx](https://testnet.nearblocks.io/txns/5iieo4HZ3EWwvF4UncmUFeEFij6gdz9PXyzrUcQZsryT)) asks the shared registry `registry.agentguard.testnet` ([deploy tx](https://testnet.nearblocks.io/txns/HZNUVfJ8d1KBqb7jHhjDcugnTJ3YHk58PvLALq26s4Yf)) about the recipient before every payment. The factory was upgraded in place ([tx](https://testnet.nearblocks.io/txns/GP957JvBLEsfwK7C4fnKA4PDoiJrd7mhBPn53427XBur)): new vaults get v2 and the registry; `demo` keeps its v1 code forever.

To make the point, `demo2.agentguard.testnet` **allowlists the attacker**. The registry still stops it:

| Step | Result | Tx |
|---|---|---|
| Agent pays the attacker 0.1 NEAR (no reports yet, allowlisted) | **paid** | [Ehtm…](https://testnet.nearblocks.io/txns/EhtMoPs1a1K6sgrBnNsE4uoHQ9Fk2JwUhT3Mz4HzGqx7) |
| `agentguard-user` reports it, with evidence | registry: `reported` | [6WVg…](https://testnet.nearblocks.io/txns/6WVgorTZUrwfgUgApNoaE3d4W1hqQPoJDFDiHceB9mcU) |
| Agent pays the attacker 0.11 NEAR | **pending**, `recipient_reported` | [28dd…](https://testnet.nearblocks.io/txns/28dd4rPvBq7DGCo249doF2v2koSR8kdmqmpB5jK9Pk3c) |
| `agentguard-shop` reports it too (2nd distinct reporter) | registry: `flagged` | [86hr…](https://testnet.nearblocks.io/txns/86hreVpehjX2dLGvmRy3r9eR9SChG9keT3bDKiBe6rsz) |
| Agent pays the attacker 0.12 NEAR | **blocked**, `recipient_flagged` | [AdDc…](https://testnet.nearblocks.io/txns/AdDcNid9765X4ejghfHsub7tt5wVER6EJsLtdSw5pwZ3) |
| Agent pays the shop 0.1 NEAR | **paid** | [8QuF…](https://testnet.nearblocks.io/txns/8QuFXwGXjwsQeRs9hxtDFfd6HgzcvmJEdr2wkZSbzLZZ) |

```sh
near contract call-function as-read-only registry.agentguard.testnet get_entry json-args '{"account":"agentguard-evil.testnet"}' network-config testnet now
```

If the registry can't answer, the vault blocks the payment (`registry_unavailable`). That is tested on a local node in `contracts/factory/tests/sandbox.rs` (`missing_registry_fails_closed`), as is `lock_rules()` (`locked_vault_cannot_be_loosened_or_drained_by_owner`).

How flagging works: any account can report (0.01 NEAR storage deposit, one report per reporter). 1 report → `reported` (payments wait for the owner). 2 distinct reporters or a curator → `flagged` (blocked). A curator can `dismiss`, and new reports don't override that. Reports can only make a vault stricter, so a false report at worst makes a payment wait.

## What this does not prove yet
- The owner (`agentguard-user.testnet`) can still change the policy, approve payments and withdraw on these demo vaults. That is intended: it is their money. Vault v2 adds `lock_rules()`, after which nobody, including the owner, can loosen it (tested on a local node; used for Sentinel's vault).
- Sybil reports: two throwaway accounts can flag an account. Curators can dismiss, and a flag only blocks payments to that account (it can't move funds).
- The 0.25 NEAR gas allowance limits how many requests one agent key can make. When it runs out, the owner adds a new key.
