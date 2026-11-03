//! AgentGuard Factory: creates AgentGuard vaults that nobody can override.
//!
//! Each vault is a new sub-account `<name>.<factory>` created in one atomic batch:
//! 1. `CreateAccount` + `Transfer` (the creator's deposit funds the vault)
//! 2. `UseGlobalContract` by **code hash**: the vault code is immutable. No one,
//!    including the factory admin, can ever change the code a vault runs.
//! 3. `FunctionCall new(owner, policy, allowlist)`
//!
//! There is **no `AddKey` action**: the vault account is born without any
//! full-access key. The only keys it will ever have are the function-call agent
//! keys its owner adds through `add_agent` (each limited to `request_payment`).
//! Nobody can sign a plain transfer out of the vault, deploy new code, or delete it.
//!
//! If any step fails, the whole batch is rolled back and the deposit is refunded
//! to the creator in `on_vault_created`.
//!
//! New vaults are pointed at the factory's shared `registry` (blocklist) by
//! default. The vault owner can change that until they call `lock_rules()`.

use near_sdk::json_types::{Base58CryptoHash, U64};
use near_sdk::serde_json::json;
use near_sdk::store::IterableMap;
use near_sdk::{
    AccountId, BorshStorageKey, CryptoHash, Gas, NearToken, PanicOnDefault, Promise, env, near, require,
};

/// Minimum deposit to create a vault. Covers the vault's own state storage and
/// its 0.5 NEAR storage reserve, with room left to spend.
pub const MIN_VAULT_DEPOSIT: NearToken = NearToken::from_near(1);
const GAS_FOR_INIT: Gas = Gas::from_tgas(30);
const GAS_FOR_CALLBACK: Gas = Gas::from_tgas(15);
const MAX_NAME_LEN: usize = 32;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Vaults,
}

/// Mirrors the vault's `Policy` (validated again by the vault's `new`).
#[near(serializers = [json])]
#[derive(Clone, Debug)]
#[serde(rename_all = "snake_case")]
pub enum UnknownRecipient {
    Block,
    RequireApproval,
}

#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub struct Policy {
    pub max_per_payment: NearToken,
    pub daily_limit: NearToken,
    pub approval_threshold: NearToken,
    pub unknown_recipient: UnknownRecipient,
    pub pending_ttl_ns: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct VaultInfo {
    pub vault: AccountId,
    pub owner: AccountId,
    pub code_hash: Base58CryptoHash,
    pub created_at: U64,
}

#[near(event_json(standard = "agentguard_factory"))]
pub enum Event {
    #[event_version("1.0.0")]
    VaultCreated { vault: AccountId, owner: AccountId, code_hash: Base58CryptoHash },
    #[event_version("1.0.0")]
    VaultCreateFailed { vault: AccountId, refunded_to: AccountId, amount: NearToken },
    #[event_version("1.0.0")]
    CodeHashUpdated { code_hash: Base58CryptoHash },
    #[event_version("1.0.0")]
    RegistryUpdated { registry: Option<AccountId> },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Factory {
    /// Can point *future* vaults at a new code hash. Has no power over existing vaults.
    admin: AccountId,
    vault_code_hash: CryptoHash,
    vaults: IterableMap<AccountId, VaultInfo>,
    /// Shared blocklist new vaults use by default.
    registry: Option<AccountId>,
}

/// State layout before `registry` was added (v1, Nov 3).
#[near]
struct FactoryV1 {
    admin: AccountId,
    vault_code_hash: CryptoHash,
    vaults: IterableMap<AccountId, VaultInfo>,
}

#[near]
impl Factory {
    /// `vault_code_hash`: hash of the vault wasm already published as a global
    /// contract (by hash).
    #[init]
    pub fn new(vault_code_hash: Base58CryptoHash, registry: Option<AccountId>) -> Self {
        Self {
            admin: env::predecessor_account_id(),
            vault_code_hash: vault_code_hash.into(),
            vaults: IterableMap::new(StorageKey::Vaults),
            registry,
        }
    }

    /// Upgrade v1 state (no registry field) after deploying new factory code.
    #[private]
    #[init(ignore_state)]
    pub fn migrate(vault_code_hash: Base58CryptoHash, registry: Option<AccountId>) -> Self {
        let old: FactoryV1 = env::state_read().unwrap_or_else(|| env::panic_str("No v1 state to migrate"));
        Self { admin: old.admin, vault_code_hash: vault_code_hash.into(), vaults: old.vaults, registry }
    }

    /// Create `<name>.<factory>` owned by `owner` (default: the caller).
    /// Attach at least 1 NEAR; all of it goes into the new vault.
    #[payable]
    pub fn create_vault(
        &mut self,
        name: String,
        owner: Option<AccountId>,
        policy: Policy,
        allowlist: Option<Vec<AccountId>>,
    ) -> Promise {
        let deposit = env::attached_deposit();
        require!(deposit >= MIN_VAULT_DEPOSIT, "Attach at least 1 NEAR to fund the vault");
        let vault = Self::vault_account(&name);
        require!(!self.vaults.contains_key(&vault), "A vault with this name already exists");
        let creator = env::predecessor_account_id();
        let owner = owner.unwrap_or_else(|| creator.clone());
        require!(owner != vault, "A vault cannot own itself");

        let args = json!({
            "owner": owner,
            "policy": policy,
            "allowlist": allowlist.unwrap_or_default(),
            "registry": self.registry,
        })
            .to_string()
            .into_bytes();

        // No add_full_access_key / add_access_key here, on purpose.
        Promise::new(vault.clone())
            .create_account()
            .transfer(deposit)
            .use_global_contract(self.vault_code_hash)
            .function_call("new", args, NearToken::from_yoctonear(0), GAS_FOR_INIT)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_FOR_CALLBACK)
                    .on_vault_created(vault, owner, creator, deposit),
            )
    }

    #[private]
    pub fn on_vault_created(
        &mut self,
        vault: AccountId,
        owner: AccountId,
        creator: AccountId,
        deposit: NearToken,
    ) -> bool {
        if env::promise_result_checked(0, 0).is_ok() {
            let code_hash: Base58CryptoHash = self.vault_code_hash.into();
            self.vaults.insert(
                vault.clone(),
                VaultInfo { vault: vault.clone(), owner: owner.clone(), code_hash, created_at: U64(env::block_timestamp()) },
            );
            Event::VaultCreated { vault, owner, code_hash }.emit();
            true
        } else {
            // The batch was rolled back, so the deposit came back to the factory.
            Event::VaultCreateFailed { vault, refunded_to: creator.clone(), amount: deposit }.emit();
            Promise::new(creator).transfer(deposit).detach();
            false
        }
    }

    /// Point *new* vaults at a new code hash. Existing vaults keep their code forever.
    pub fn set_vault_code_hash(&mut self, vault_code_hash: Base58CryptoHash) {
        require!(env::predecessor_account_id() == self.admin, "Only the factory admin can do this");
        self.vault_code_hash = vault_code_hash.into();
        Event::CodeHashUpdated { code_hash: vault_code_hash }.emit();
    }

    /// Default registry for *new* vaults.
    pub fn set_registry(&mut self, registry: Option<AccountId>) {
        require!(env::predecessor_account_id() == self.admin, "Only the factory admin can do this");
        self.registry = registry.clone();
        Event::RegistryUpdated { registry }.emit();
    }

    // ───────────────────────── Views ─────────────────────────

    pub fn get_registry(&self) -> Option<&AccountId> {
        self.registry.as_ref()
    }

    pub fn get_vault_code_hash(&self) -> Base58CryptoHash {
        self.vault_code_hash.into()
    }

    pub fn get_admin(&self) -> &AccountId {
        &self.admin
    }

    pub fn get_vault(&self, vault: AccountId) -> Option<&VaultInfo> {
        self.vaults.get(&vault)
    }

    pub fn get_vault_count(&self) -> u32 {
        self.vaults.len()
    }

    pub fn get_vaults(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<&VaultInfo> {
        let from = from_index.unwrap_or(0) as usize;
        let limit = limit.unwrap_or(50).min(100) as usize;
        self.vaults.values().skip(from).take(limit).collect()
    }

    pub fn get_vaults_by_owner(&self, owner: AccountId) -> Vec<&VaultInfo> {
        self.vaults.values().filter(|v| v.owner == owner).collect()
    }

    /// The account a vault called `name` would get.
    pub fn vault_account_for(&self, name: String) -> AccountId {
        Self::vault_account(&name)
    }

    // ───────────────────────── Internals ─────────────────────────

    fn vault_account(name: &str) -> AccountId {
        require!(!name.is_empty() && name.len() <= MAX_NAME_LEN, "Name must be 1-32 characters");
        require!(
            name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-' || b == b'_'),
            "Name may only use a-z, 0-9, - and _"
        );
        format!("{name}.{}", env::current_account_id())
            .parse()
            .unwrap_or_else(|_| env::panic_str("Invalid vault name"))
    }
}

#[cfg(test)]
mod tests;
