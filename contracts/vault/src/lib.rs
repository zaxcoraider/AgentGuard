//! AgentGuard Vault — an onchain spending firewall for AI agents.
//!
//! The vault account holds the funds. AI agents never get a key that can move
//! funds directly: each agent holds a *function-call access key* on the vault
//! account that may only call `request_payment`. Every request is checked
//! against the owner's policy inside this contract, so a hacked or
//! prompt-injected agent cannot spend outside the rules.
//!
//! Outcomes of `request_payment`:
//! - `paid`    — within policy, transferred immediately
//! - `pending` — needs the owner's approval (`approve` / `deny`)
//! - `blocked` — violates policy; recorded onchain (not a panic) so blocked
//!   attempts stay visible in history and stats

use near_sdk::json_types::U64;
use near_sdk::store::{IterableMap, IterableSet, LookupMap};
use near_sdk::{
    AccountId, Allowance, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PublicKey,
    assert_one_yocto, env, near, require,
};

/// Rolling spend window for the daily limit.
const DAY_NS: u64 = 24 * 60 * 60 * 1_000_000_000;
/// How many payment records we keep onchain (older ones are pruned).
const MAX_HISTORY: u64 = 300;
/// Max open approvals at once (stops an attacker from spamming the owner).
const MAX_PENDING: u32 = 20;
const MAX_MEMO_LEN: usize = 256;
const MAX_LABEL_LEN: usize = 64;
/// NEAR kept aside so the vault never spends the balance it needs for storage.
const STORAGE_RESERVE: NearToken = NearToken::from_millinear(500);
/// Default gas allowance for an agent key (pays the agent's tx fees).
const DEFAULT_AGENT_ALLOWANCE: NearToken = NearToken::from_millinear(250);
const GAS_FOR_SETTLE: Gas = Gas::from_tgas(10);
const AGENT_METHOD: &str = "request_payment";

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Allowlist,
    Agents,
    History,
    Pending,
}

/// What to do when an agent pays a recipient that is not on the allowlist.
#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum UnknownRecipient {
    Block,
    RequireApproval,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Policy {
    /// Hard cap per payment. Above this is always blocked.
    pub max_per_payment: NearToken,
    /// Hard cap on total spent in any rolling 24h window.
    pub daily_limit: NearToken,
    /// Payments above this (but within the hard caps) wait for owner approval.
    pub approval_threshold: NearToken,
    /// Behaviour for recipients that are not allowlisted.
    pub unknown_recipient: UnknownRecipient,
    /// Pending approvals expire after this many nanoseconds.
    pub pending_ttl_ns: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Paid,
    Pending,
    Blocked,
    Approved,
    Denied,
    Expired,
    Failed,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Payment {
    pub id: U64,
    pub agent: String,
    pub recipient: AccountId,
    pub amount: NearToken,
    pub memo: String,
    pub status: Status,
    pub reason: Option<String>,
    pub created_at: U64,
    pub resolved_at: Option<U64>,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Agent {
    pub public_key: PublicKey,
    pub label: String,
    pub active: bool,
    pub added_at: U64,
}

/// Returned to the agent from `request_payment`.
#[near(serializers = [json])]
#[derive(Debug)]
pub struct PaymentResult {
    pub id: U64,
    pub status: Status,
    pub reason: Option<String>,
}

#[near(serializers = [json])]
pub struct Stats {
    pub balance: NearToken,
    pub available: NearToken,
    pub spent_24h: NearToken,
    pub total_paid: NearToken,
    pub paid_count: U64,
    pub blocked_count: U64,
    pub blocked_amount: NearToken,
    pub pending_count: u32,
    pub paused: bool,
}

#[near(event_json(standard = "agentguard"))]
pub enum Event {
    #[event_version("1.0.0")]
    PaymentPaid { id: U64, recipient: AccountId, amount: NearToken, agent: String },
    #[event_version("1.0.0")]
    PaymentPending { id: U64, recipient: AccountId, amount: NearToken, agent: String, reason: String },
    #[event_version("1.0.0")]
    PaymentBlocked { id: U64, recipient: AccountId, amount: NearToken, agent: String, reason: String },
    #[event_version("1.0.0")]
    PaymentResolved { id: U64, status: Status },
    #[event_version("1.0.0")]
    PolicyUpdated { policy: Policy },
    #[event_version("1.0.0")]
    AgentAdded { public_key: PublicKey, label: String },
    #[event_version("1.0.0")]
    AgentRevoked { public_key: PublicKey },
    #[event_version("1.0.0")]
    Paused { paused: bool },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner: AccountId,
    policy: Policy,
    paused: bool,
    allowlist: IterableSet<AccountId>,
    agents: IterableMap<PublicKey, Agent>,
    history: LookupMap<u64, Payment>,
    pending: IterableSet<u64>,
    next_id: u64,
    /// (timestamp_ns, payment_id, amount) of spends inside the rolling 24h window.
    spends: Vec<(u64, u64, NearToken)>,
    total_paid: NearToken,
    paid_count: u64,
    blocked_count: u64,
    blocked_amount: NearToken,
}

#[near]
impl Vault {
    #[init]
    pub fn new(owner: AccountId, policy: Policy, allowlist: Option<Vec<AccountId>>) -> Self {
        Self::validate_policy(&policy);
        let mut set = IterableSet::new(StorageKey::Allowlist);
        for a in allowlist.unwrap_or_default() {
            set.insert(a);
        }
        Self {
            owner,
            policy,
            paused: false,
            allowlist: set,
            agents: IterableMap::new(StorageKey::Agents),
            history: LookupMap::new(StorageKey::History),
            pending: IterableSet::new(StorageKey::Pending),
            next_id: 0,
            spends: Vec::new(),
            total_paid: NearToken::from_yoctonear(0),
            paid_count: 0,
            blocked_count: 0,
            blocked_amount: NearToken::from_yoctonear(0),
        }
    }

    // ───────────────────────── Agent entrypoint ─────────────────────────

    /// The ONLY method an agent key can call. Must be signed by a registered,
    /// active agent key on this vault account.
    pub fn request_payment(
        &mut self,
        recipient: AccountId,
        amount: NearToken,
        memo: Option<String>,
        force_review: Option<bool>,
    ) -> PaymentResult {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "Only agent keys on this vault can request payments"
        );
        let pk = env::signer_account_pk();
        let agent = self
            .agents
            .get(&pk)
            .filter(|a| a.active)
            .unwrap_or_else(|| env::panic_str("Unknown or revoked agent key"))
            .label
            .clone();
        require!(amount.as_yoctonear() > 0, "Amount must be positive");
        let memo = memo.unwrap_or_default();
        require!(memo.len() <= MAX_MEMO_LEN, "Memo too long");

        self.prune_spends();
        self.expire_stale_pending();

        let verdict = self.evaluate(&recipient, amount, force_review.unwrap_or(false));
        let id = self.next_id;
        self.next_id += 1;
        let mut payment = Payment {
            id: U64(id),
            agent: agent.clone(),
            recipient: recipient.clone(),
            amount,
            memo,
            status: Status::Blocked,
            reason: None,
            created_at: U64(env::block_timestamp()),
            resolved_at: None,
        };

        let result = match verdict {
            Verdict::Block(reason) => {
                payment.status = Status::Blocked;
                payment.reason = Some(reason.clone());
                payment.resolved_at = Some(U64(env::block_timestamp()));
                self.blocked_count += 1;
                self.blocked_amount = self.blocked_amount.saturating_add(amount);
                Event::PaymentBlocked { id: U64(id), recipient, amount, agent, reason: reason.clone() }
                    .emit();
                PaymentResult { id: U64(id), status: Status::Blocked, reason: Some(reason) }
            }
            Verdict::Review(reason) => {
                payment.status = Status::Pending;
                payment.reason = Some(reason.clone());
                self.pending.insert(id);
                Event::PaymentPending { id: U64(id), recipient, amount, agent, reason: reason.clone() }
                    .emit();
                PaymentResult { id: U64(id), status: Status::Pending, reason: Some(reason) }
            }
            Verdict::Pay => {
                payment.status = Status::Paid;
                payment.resolved_at = Some(U64(env::block_timestamp()));
                self.record_spend(id, amount);
                Event::PaymentPaid { id: U64(id), recipient: recipient.clone(), amount, agent }.emit();
                self.send(id, recipient, amount);
                PaymentResult { id: U64(id), status: Status::Paid, reason: None }
            }
        };

        self.history.insert(id, payment);
        self.prune_history(id);
        result
    }

    // ───────────────────────── Owner methods ─────────────────────────

    /// Approve a pending payment. Owner overrides the approval threshold and
    /// the daily limit, but never the available balance. Returns the final
    /// status (`approved`, or `expired` if the request timed out).
    #[payable]
    pub fn approve(&mut self, id: U64) -> Status {
        self.assert_owner();
        let mut p = self.take_pending(id.0);
        if self.is_expired(&p) {
            self.resolve(&mut p, Status::Expired);
            self.history.insert(id.0, p);
            return Status::Expired;
        }
        require!(p.amount <= self.available(), "Insufficient vault balance");
        self.prune_spends();
        self.record_spend(id.0, p.amount);
        self.resolve(&mut p, Status::Approved);
        let (recipient, amount) = (p.recipient.clone(), p.amount);
        self.history.insert(id.0, p);
        self.send(id.0, recipient, amount);
        Status::Approved
    }

    #[payable]
    pub fn deny(&mut self, id: U64) {
        self.assert_owner();
        let mut p = self.take_pending(id.0);
        self.resolve(&mut p, Status::Denied);
        self.history.insert(id.0, p);
    }

    #[payable]
    pub fn set_policy(&mut self, policy: Policy) {
        self.assert_owner();
        Self::validate_policy(&policy);
        self.policy = policy.clone();
        Event::PolicyUpdated { policy }.emit();
    }

    #[payable]
    pub fn add_to_allowlist(&mut self, accounts: Vec<AccountId>) {
        self.assert_owner();
        for a in accounts {
            self.allowlist.insert(a);
        }
    }

    #[payable]
    pub fn remove_from_allowlist(&mut self, accounts: Vec<AccountId>) {
        self.assert_owner();
        for a in accounts {
            self.allowlist.remove(&a);
        }
    }

    /// Register an agent and add its function-call key to this vault account.
    /// The key can only call `request_payment` on this contract.
    #[payable]
    pub fn add_agent(&mut self, public_key: PublicKey, label: String, gas_allowance: Option<NearToken>) -> Promise {
        self.assert_owner();
        require!(!label.is_empty() && label.len() <= MAX_LABEL_LEN, "Invalid label");
        require!(!self.agents.contains_key(&public_key), "Agent key already registered");
        let allowance = Allowance::limited(gas_allowance.unwrap_or(DEFAULT_AGENT_ALLOWANCE))
            .unwrap_or_else(|| env::panic_str("Gas allowance must be positive"));
        self.agents.insert(
            public_key.clone(),
            Agent { public_key: public_key.clone(), label: label.clone(), active: true, added_at: U64(env::block_timestamp()) },
        );
        Event::AgentAdded { public_key: public_key.clone(), label }.emit();
        Promise::new(env::current_account_id()).add_access_key_allowance(
            public_key,
            allowance,
            env::current_account_id(),
            AGENT_METHOD,
        )
    }

    /// Revoke an agent: mark inactive and delete its key from the account.
    #[payable]
    pub fn revoke_agent(&mut self, public_key: PublicKey) -> Promise {
        self.assert_owner();
        let agent = self
            .agents
            .get_mut(&public_key)
            .unwrap_or_else(|| env::panic_str("Unknown agent key"));
        require!(agent.active, "Agent already revoked");
        agent.active = false;
        Event::AgentRevoked { public_key: public_key.clone() }.emit();
        Promise::new(env::current_account_id()).delete_key(public_key)
    }

    /// Kill switch: while paused, every agent request is blocked.
    #[payable]
    pub fn set_paused(&mut self, paused: bool) {
        self.assert_owner();
        self.paused = paused;
        Event::Paused { paused }.emit();
    }

    #[payable]
    pub fn withdraw(&mut self, amount: NearToken) -> Promise {
        self.assert_owner();
        require!(amount <= self.available(), "Insufficient vault balance");
        Promise::new(self.owner.clone()).transfer(amount)
    }

    /// Anyone can top up the vault.
    #[payable]
    pub fn deposit(&mut self) {}

    // ───────────────────────── Callbacks ─────────────────────────

    #[private]
    pub fn on_payment_settled(&mut self, id: U64) -> bool {
        let ok = env::promise_result_checked(0, 0).is_ok();
        if !ok && let Some(mut p) = self.history.get(&id.0).cloned() {
            // Undo the spend: it never left the vault.
            self.unrecord_spend(id.0, p.amount);
            p.status = Status::Failed;
            p.reason = Some("transfer_failed".into());
            p.resolved_at = Some(U64(env::block_timestamp()));
            self.history.insert(id.0, p);
            Event::PaymentResolved { id, status: Status::Failed }.emit();
        }
        ok
    }

    // ───────────────────────── Views ─────────────────────────

    pub fn get_owner(&self) -> &AccountId {
        &self.owner
    }

    pub fn get_policy(&self) -> &Policy {
        &self.policy
    }

    pub fn get_allowlist(&self) -> Vec<&AccountId> {
        self.allowlist.iter().collect()
    }

    pub fn get_agents(&self) -> Vec<&Agent> {
        self.agents.values().collect()
    }

    pub fn get_payment(&self, id: U64) -> Option<&Payment> {
        self.history.get(&id.0)
    }

    pub fn get_pending(&self) -> Vec<&Payment> {
        self.pending.iter().filter_map(|id| self.history.get(id)).collect()
    }

    /// Newest first. `before` = exclusive upper id bound (for paging).
    pub fn get_history(&self, before: Option<U64>, limit: Option<u32>) -> Vec<&Payment> {
        let limit = limit.unwrap_or(50).min(100) as usize;
        let start = before.map(|b| b.0).unwrap_or(self.next_id).min(self.next_id);
        let floor = self.next_id.saturating_sub(MAX_HISTORY);
        (floor..start).rev().filter_map(|id| self.history.get(&id)).take(limit).collect()
    }

    pub fn get_stats(&self) -> Stats {
        let cutoff = env::block_timestamp().saturating_sub(DAY_NS);
        let spent_24h = self
            .spends
            .iter()
            .filter(|(t, _, _)| *t > cutoff)
            .fold(NearToken::from_yoctonear(0), |acc, (_, _, a)| acc.saturating_add(*a));
        Stats {
            balance: env::account_balance(),
            available: self.available(),
            spent_24h,
            total_paid: self.total_paid,
            paid_count: U64(self.paid_count),
            blocked_count: U64(self.blocked_count),
            blocked_amount: self.blocked_amount,
            pending_count: self.pending.len(),
            paused: self.paused,
        }
    }

    // ───────────────────────── Internals ─────────────────────────

    fn evaluate(&self, recipient: &AccountId, amount: NearToken, force_review: bool) -> Verdict {
        let p = &self.policy;
        if self.paused {
            return Verdict::Block("vault_paused".into());
        }
        if *recipient == env::current_account_id() {
            return Verdict::Block("cannot_pay_self".into());
        }
        if amount > p.max_per_payment {
            return Verdict::Block("over_per_payment_limit".into());
        }
        if self.spent_in_window().saturating_add(amount) > p.daily_limit {
            return Verdict::Block("over_daily_limit".into());
        }
        if amount > self.available() {
            return Verdict::Block("insufficient_funds".into());
        }
        let allowlisted = self.allowlist.contains(recipient);
        let review_reason = if !allowlisted {
            match p.unknown_recipient {
                UnknownRecipient::Block => return Verdict::Block("recipient_not_allowlisted".into()),
                UnknownRecipient::RequireApproval => Some("unknown_recipient"),
            }
        } else if amount > p.approval_threshold {
            Some("over_approval_threshold")
        } else if force_review {
            Some("flagged_for_review")
        } else {
            None
        };
        match review_reason {
            None => Verdict::Pay,
            Some(_) if self.pending.len() >= MAX_PENDING => Verdict::Block("too_many_pending".into()),
            Some(r) => Verdict::Review(r.into()),
        }
    }

    fn send(&mut self, id: u64, recipient: AccountId, amount: NearToken) {
        self.total_paid = self.total_paid.saturating_add(amount);
        self.paid_count += 1;
        Promise::new(recipient)
            .transfer(amount)
            .then(Self::ext(env::current_account_id()).with_static_gas(GAS_FOR_SETTLE).on_payment_settled(U64(id)))
            .detach();
    }

    fn available(&self) -> NearToken {
        let storage = env::storage_byte_cost().saturating_mul(env::storage_usage() as u128);
        env::account_balance()
            .saturating_sub(storage)
            .saturating_sub(STORAGE_RESERVE)
    }

    fn spent_in_window(&self) -> NearToken {
        self.spends.iter().fold(NearToken::from_yoctonear(0), |acc, (_, _, a)| acc.saturating_add(*a))
    }

    fn record_spend(&mut self, id: u64, amount: NearToken) {
        self.spends.push((env::block_timestamp(), id, amount));
    }

    fn unrecord_spend(&mut self, id: u64, amount: NearToken) {
        self.spends.retain(|(_, sid, _)| *sid != id);
        self.total_paid = self.total_paid.saturating_sub(amount);
        self.paid_count = self.paid_count.saturating_sub(1);
    }

    fn prune_spends(&mut self) {
        let cutoff = env::block_timestamp().saturating_sub(DAY_NS);
        self.spends.retain(|(t, _, _)| *t > cutoff);
    }

    fn is_expired(&self, p: &Payment) -> bool {
        env::block_timestamp() > p.created_at.0.saturating_add(self.policy.pending_ttl_ns.0)
    }

    /// Mark timed-out approvals as expired (bounded by MAX_PENDING).
    fn expire_stale_pending(&mut self) {
        let stale: Vec<u64> = self
            .pending
            .iter()
            .copied()
            .filter(|id| self.history.get(id).map(|p| self.is_expired(p)).unwrap_or(true))
            .collect();
        for id in stale {
            self.pending.remove(&id);
            if let Some(mut p) = self.history.get(&id).cloned() {
                self.resolve(&mut p, Status::Expired);
                self.history.insert(id, p);
            }
        }
    }

    fn prune_history(&mut self, newest: u64) {
        if newest >= MAX_HISTORY {
            let old = newest - MAX_HISTORY;
            self.pending.remove(&old);
            self.history.remove(&old);
        }
    }

    fn take_pending(&mut self, id: u64) -> Payment {
        require!(self.pending.remove(&id), "No pending payment with this id");
        self.history
            .get(&id)
            .cloned()
            .unwrap_or_else(|| env::panic_str("Payment record missing"))
    }

    fn resolve(&mut self, p: &mut Payment, status: Status) {
        p.status = status;
        p.resolved_at = Some(U64(env::block_timestamp()));
        Event::PaymentResolved { id: p.id, status }.emit();
    }

    fn assert_owner(&self) {
        // 1 yoctoNEAR forces a full-access key signature (wallet confirmation).
        assert_one_yocto();
        require!(env::predecessor_account_id() == self.owner, "Only the owner can do this");
    }

    fn validate_policy(p: &Policy) {
        require!(p.approval_threshold <= p.max_per_payment, "approval_threshold must be <= max_per_payment");
        require!(p.max_per_payment <= p.daily_limit, "max_per_payment must be <= daily_limit");
        require!(p.pending_ttl_ns.0 > 0, "pending_ttl_ns must be positive");
    }
}

enum Verdict {
    Pay,
    Review(String),
    Block(String),
}

#[cfg(test)]
mod tests;
