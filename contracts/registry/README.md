# AgentGuard Registry

A shared blocklist of accounts that tried to scam AI agents. Every AgentGuard vault with a registry asks it about the recipient **on every payment** (a cross-contract view). If the registry doesn't answer, the vault blocks the payment: it fails closed.

| Status | Meaning | What vaults do |
|---|---|---|
| `clear` | no reports | normal rules |
| `reported` | one reporter so far | hold the payment for the owner (`pending`) |
| `flagged` | 2+ distinct reporters, or confirmed by a curator | **block** |
| `dismissed` | a curator reviewed and cleared it; later reports no longer change it | normal rules |

Reports can only make a vault **stricter** (hold or block), never let a payment through. So a griefing report can at worst make a payment wait for its owner, and a curator can dismiss it.

## Methods
- `report(account, reason, evidence?)`: attach 0.01 NEAR (pays for storage). One report per reporter per account, at most 10 per account, no self-reports. Reason ≤ 256 chars, evidence ≤ 512
- Curators: `confirm(account)` (flag now), `dismiss(account)`
- Admin: `add_curator`, `remove_curator`
- Views: `get_status(account)`, `get_entry(account)` (all reports), `get_flagged(from_index?, limit?)`, `get_flagged_count`, `get_report_count`, `get_curators`

## Known limits
- Sybil: two throwaway accounts (0.02 NEAR) can flag an account. Curators can dismiss it, and a flag can only block payments to that account; it cannot move anyone's funds.
- Sentinel does **not** report accounts automatically from its public chat: anyone could name any account and get it flagged.

## Build and test
```sh
cargo near build non-reproducible-wasm
cargo test            # 13 unit tests
```

Live on testnet as `registry.agentguard.testnet` (curators: itself and `agentguard.testnet`).
