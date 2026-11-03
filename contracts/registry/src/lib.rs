//! AgentGuard Registry: a shared blocklist of accounts that tried to scam AI agents.
//!
//! Anyone can `report(account, reason, evidence)` with a small deposit that pays
//! for the storage. Status of an account:
//! - `clear`     no reports
//! - `reported`  one reporter so far. AgentGuard vaults hold payments to it for the owner
//! - `flagged`   2+ distinct reporters, or confirmed by a curator. Vaults block payments to it
//! - `dismissed` a curator reviewed it and cleared it. New reports no longer change it
//!
//! Reports can only make a vault stricter (hold or block), never let a payment
//! through, so a griefing report can at worst make a payment wait for its owner,
//! and a curator can dismiss it.

use near_sdk::json_types::U64;
use near_sdk::store::{IterableSet, LookupMap};
use near_sdk::{AccountId, BorshStorageKey, NearToken, PanicOnDefault, env, near, require};

/// Pays for the storage of one report (~0.3 KB).
pub const REPORT_DEPOSIT: NearToken = NearToken::from_millinear(10);
const FLAG_AT_REPORTERS: usize = 2;
const MAX_REPORTS_PER_ACCOUNT: usize = 10;
const MAX_REASON_LEN: usize = 256;
const MAX_EVIDENCE_LEN: usize = 512;

#[derive(BorshStorageKey)]
#[near]
enum StorageKey {
    Entries,
    Curators,
    Flagged,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Clear,
    Reported,
    Flagged,
    Dismissed,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Report {
    pub reporter: AccountId,
    pub reason: String,
    /// A link or tx hash showing what happened (e.g. the blocked payment).
    pub evidence: String,
    pub at: U64,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Entry {
    pub status: Status,
    pub reports: Vec<Report>,
    /// Curator who confirmed or dismissed, if any.
    pub reviewed_by: Option<AccountId>,
    pub updated_at: U64,
}

/// What vaults and agents read before paying someone.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct StatusView {
    pub account: AccountId,
    pub status: Status,
    pub report_count: u32,
}

#[near(event_json(standard = "agentguard_registry"))]
pub enum Event {
    #[event_version("1.0.0")]
    Reported { account: AccountId, reporter: AccountId, reason: String, evidence: String, status: Status },
    #[event_version("1.0.0")]
    Reviewed { account: AccountId, curator: AccountId, status: Status },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    admin: AccountId,
    curators: IterableSet<AccountId>,
    entries: LookupMap<AccountId, Entry>,
    /// Currently flagged accounts, for listing.
    flagged: IterableSet<AccountId>,
    report_count: u64,
}

#[near]
impl Registry {
    #[init]
    pub fn new(curators: Option<Vec<AccountId>>) -> Self {
        let admin = env::predecessor_account_id();
        let mut set = IterableSet::new(StorageKey::Curators);
        set.insert(admin.clone());
        for c in curators.unwrap_or_default() {
            set.insert(c);
        }
        Self {
            admin,
            curators: set,
            entries: LookupMap::new(StorageKey::Entries),
            flagged: IterableSet::new(StorageKey::Flagged),
            report_count: 0,
        }
    }

    /// Report an account. Attach 0.01 NEAR (storage). One report per reporter per account.
    #[payable]
    pub fn report(&mut self, account: AccountId, reason: String, evidence: Option<String>) -> StatusView {
        require!(env::attached_deposit() >= REPORT_DEPOSIT, "Attach 0.01 NEAR to pay for the report's storage");
        let reporter = env::predecessor_account_id();
        require!(reporter != account, "You cannot report yourself");
        require!(!reason.is_empty() && reason.len() <= MAX_REASON_LEN, "Reason must be 1-256 characters");
        let evidence = evidence.unwrap_or_default();
        require!(evidence.len() <= MAX_EVIDENCE_LEN, "Evidence must be at most 512 characters");

        let now = U64(env::block_timestamp());
        let mut entry = self.entries.get(&account).cloned().unwrap_or(Entry {
            status: Status::Clear,
            reports: Vec::new(),
            reviewed_by: None,
            updated_at: now,
        });
        require!(!entry.reports.iter().any(|r| r.reporter == reporter), "You already reported this account");
        require!(entry.reports.len() < MAX_REPORTS_PER_ACCOUNT, "This account already has the maximum number of reports");

        entry.reports.push(Report { reporter: reporter.clone(), reason: reason.clone(), evidence: evidence.clone(), at: now });
        entry.updated_at = now;
        // A curator's decision stands; reports don't override it.
        if entry.reviewed_by.is_none() {
            entry.status =
                if entry.reports.len() >= FLAG_AT_REPORTERS { Status::Flagged } else { Status::Reported };
        }
        self.set_entry(account.clone(), entry);
        self.report_count += 1;
        let view = self.get_status(account.clone());
        Event::Reported { account, reporter, reason, evidence, status: view.status }.emit();
        view
    }

    /// Curator: confirm an account is a scammer (flag it now).
    pub fn confirm(&mut self, account: AccountId) -> StatusView {
        self.review(account, Status::Flagged)
    }

    /// Curator: clear an account after review. Later reports won't flag it.
    pub fn dismiss(&mut self, account: AccountId) -> StatusView {
        self.review(account, Status::Dismissed)
    }

    pub fn add_curator(&mut self, account: AccountId) {
        self.assert_admin();
        self.curators.insert(account);
    }

    pub fn remove_curator(&mut self, account: AccountId) {
        self.assert_admin();
        require!(account != self.admin, "The admin stays a curator");
        self.curators.remove(&account);
    }

    // ───────────────────────── Views ─────────────────────────

    pub fn get_status(&self, account: AccountId) -> StatusView {
        match self.entries.get(&account) {
            Some(e) => StatusView { account, status: e.status, report_count: e.reports.len() as u32 },
            None => StatusView { account, status: Status::Clear, report_count: 0 },
        }
    }

    pub fn get_entry(&self, account: AccountId) -> Option<&Entry> {
        self.entries.get(&account)
    }

    pub fn get_flagged(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<&AccountId> {
        let limit = limit.unwrap_or(50).min(100) as usize;
        self.flagged.iter().skip(from_index.unwrap_or(0) as usize).take(limit).collect()
    }

    pub fn get_curators(&self) -> Vec<&AccountId> {
        self.curators.iter().collect()
    }

    pub fn get_report_count(&self) -> U64 {
        U64(self.report_count)
    }

    pub fn get_flagged_count(&self) -> u32 {
        self.flagged.len()
    }

    // ───────────────────────── Internals ─────────────────────────

    fn review(&mut self, account: AccountId, status: Status) -> StatusView {
        let curator = env::predecessor_account_id();
        require!(self.curators.contains(&curator), "Only a curator can do this");
        let now = U64(env::block_timestamp());
        let mut entry = self.entries.get(&account).cloned().unwrap_or(Entry {
            status: Status::Clear,
            reports: Vec::new(),
            reviewed_by: None,
            updated_at: now,
        });
        entry.status = status;
        entry.reviewed_by = Some(curator.clone());
        entry.updated_at = now;
        self.set_entry(account.clone(), entry);
        Event::Reviewed { account: account.clone(), curator, status }.emit();
        self.get_status(account)
    }

    fn set_entry(&mut self, account: AccountId, entry: Entry) {
        if entry.status == Status::Flagged {
            self.flagged.insert(account.clone());
        } else {
            self.flagged.remove(&account);
        }
        self.entries.insert(account, entry);
    }

    fn assert_admin(&self) {
        require!(env::predecessor_account_id() == self.admin, "Only the registry admin can do this");
    }
}

#[cfg(test)]
mod tests;
