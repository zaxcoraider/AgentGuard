# Testnet results (2026-11-03)

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

## What this does not prove yet
- The owner (`agentguard-user.testnet`) can still change the policy, approve payments and withdraw. That is intended: it is their money. A "lock the rules" option for Sentinel's vault is planned.
- The 0.25 NEAR gas allowance limits how many requests one agent key can make. When it runs out, the owner adds a new key.
