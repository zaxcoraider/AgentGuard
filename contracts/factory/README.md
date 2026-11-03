# AgentGuard Factory

Creates [AgentGuard vaults](../vault) that nobody can override, including the factory admin and the person who created them.

`create_vault(name, owner?, policy, allowlist?)`, with at least 1 NEAR attached, creates `<name>.<factory>` in **one atomic batch**:

1. `CreateAccount` + `Transfer`: all of the deposit goes into the vault
2. `UseGlobalContract` **by code hash**: the vault runs immutable code. Nobody can ever change what a vault runs (a hash, unlike an account-based global contract, cannot be redeployed)
3. `FunctionCall new(owner, policy, allowlist, registry)`

**There is no `AddKey` action.** The vault is born without a full-access key. Its only keys will be the function-call agent keys its owner adds with `add_agent`, and each of them can only call `request_payment`. Nobody can sign a plain transfer out of the vault, deploy other code to it, or delete it.

If any step fails, the batch is rolled back and `on_vault_created` refunds the deposit to the creator.

Because a vault on global code stores only ~0.5 KB, creating one costs almost nothing beyond the deposit, which stays the owner's money inside the vault.

## Methods
- `create_vault(name, owner?, policy, allowlist?)`: payable, ≥ 1 NEAR. `owner` defaults to the caller. Name: 1–32 characters
- Views: `get_vault(vault)`, `get_vaults(from_index?, limit?)`, `get_vaults_by_owner(owner)`, `get_vault_count`, `vault_account_for(name)`, `get_vault_code_hash`, `get_registry`, `get_admin`
- Admin: `set_vault_code_hash`, `set_registry`. These only affect **vaults created later**. An existing vault keeps its code hash forever, and only its own owner can change its registry (until `lock_rules()`)
- `migrate(vault_code_hash, registry?)`: state upgrade from factory v1 (private)

New vaults use the factory's shared [registry](../registry) by default.

## Build and test
```sh
cargo near build non-reproducible-wasm
cargo test            # 14 unit tests + 6 sandbox tests (local NEAR node; builds the vault and factory wasm itself)
```

Live on testnet as `agentguard.testnet`: see [`deployments/testnet.json`](../../deployments/testnet.json) and [`docs/TESTNET-RESULTS.md`](../../docs/TESTNET-RESULTS.md).
