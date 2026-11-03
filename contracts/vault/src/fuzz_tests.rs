//! Property-based fuzzing of the vault, with no extra dependencies.
//!
//! Thousands of seeded random sequences mix: agent payment requests (any recipient, any
//! amount, including over every limit), registry answers (clear / reported / flagged / no
//! answer), failed transfers, time jumps, and owner actions (rules, allowlist, pause,
//! approve, deny, withdraw, lock). After EVERY step the invariants below must hold.
//!
//! What an agent can never do, whatever it sends:
//!   1. get a payment `paid` above the per-payment cap or the approval threshold,
//!   2. get a payment `paid` to someone not on the allowlist,
//!   3. push the rolling 24h total of payouts over the daily limit by itself,
//!   4. get paid to a recipient the registry flagged, or when the registry didn't answer,
//!   5. get anything paid (or even held) while the vault is paused, or pay the vault itself,
//!   6. repeat the same recipient + amount within 10 minutes without the owner.
//! What nobody can do after `lock_rules()`:
//!   7. change the rules, add to the allowlist, change the registry, add an agent key,
//!      approve a held payment or withdraw. Every such call panics and changes nothing.
//! Bookkeeping:
//!   8. total paid / paid count / blocked count match an independent ledger, and no more
//!      than MAX_PENDING payments are ever waiting.
//!
//! Runs: FUZZ_RUNS (default 25, ~30 s) sequences x FUZZ_STEPS (default 200) steps.
//! Full run: FUZZ_RUNS=300 cargo test --lib fuzz -- --nocapture  (60,000 steps, ~6 min).
use super::*;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};
use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};

const NEAR: u128 = 10u128.pow(24);
const MIN: u64 = 60 * 1_000_000_000;

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        // xorshift64*
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545F4914F6CDD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }
}

fn acct(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn vault_id() -> AccountId {
    acct("vault.agentguard.testnet")
}
fn owner() -> AccountId {
    acct("owner.testnet")
}
fn registry() -> AccountId {
    acct("registry.agentguard.testnet")
}
fn agent_pk() -> PublicKey {
    "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap()
}
fn other_pk() -> PublicKey {
    "ed25519:DcA2MzgpJbrUATQLLceocVckhhAqrkingax4oJ9kZ847".parse().unwrap()
}
const RECIPIENTS: [&str; 6] = ["shop.testnet", "api.testnet", "evil.testnet", "stranger.testnet", "owner.testnet", "vault.agentguard.testnet"];

fn ctx(predecessor: AccountId, pk: PublicKey, deposit: u128, ts: u64, promise: Option<PromiseResult>) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(vault_id())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .signer_account_pk(pk)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(NearToken::from_yoctonear(100 * NEAR))
        .block_timestamp(ts);
    match promise {
        Some(r) => testing_env!(b.build(), test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![r]),
        None => testing_env!(b.build()),
    }
}

/// Amounts on a 0.05 NEAR grid, so repeats and exact-limit cases actually happen.
fn amount(rng: &mut Rng) -> NearToken {
    NearToken::from_yoctonear((1 + rng.below(80)) as u128 * NEAR / 20)
}

fn random_policy(rng: &mut Rng) -> Policy {
    let max = (1 + rng.below(60)) as u128 * NEAR / 20; // 0.05 .. 3
    let daily = max * (1 + rng.below(6)) as u128;
    let threshold = max * rng.below(101) as u128 / 100;
    Policy {
        max_per_payment: NearToken::from_yoctonear(max),
        daily_limit: NearToken::from_yoctonear(daily),
        approval_threshold: NearToken::from_yoctonear(threshold),
        unknown_recipient: if rng.chance(50) { UnknownRecipient::Block } else { UnknownRecipient::RequireApproval },
        pending_ttl_ns: U64((1 + rng.below(48)) * 60 * MIN),
    }
}

/// An independent ledger of money that left (or is leaving) the vault.
#[derive(Default)]
struct Ledger {
    /// payment id -> (time recorded, amount); removed again if the transfer fails.
    spends: HashMap<u64, (u64, NearToken)>,
    total: u128,
    count: u64,
    blocked: u64,
}
impl Ledger {
    fn window(&self, now: u64) -> u128 {
        let cutoff = now.saturating_sub(24 * 60 * MIN);
        self.spends.values().filter(|(t, _)| *t > cutoff).map(|(_, a)| a.as_yoctonear()).sum()
    }
    fn add(&mut self, id: u64, ts: u64, a: NearToken) {
        self.spends.insert(id, (ts, a));
        self.total += a.as_yoctonear();
        self.count += 1;
    }
}

fn owner_call<T>(v: &mut Vault, ts: u64, f: impl FnOnce(&mut Vault) -> T) -> Result<T, String> {
    ctx(owner(), other_pk(), 1, ts, None);
    catch_unwind(AssertUnwindSafe(|| f(v))).map_err(|e| {
        e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()
    })
}

/// How often each path was exercised, so a passing run is not a hollow one.
#[derive(Default, Debug)]
struct Seen {
    paid: u64,
    held: u64,
    blocked: u64,
    approved: u64,
    denied: u64,
    failed_transfers: u64,
    locks: u64,
    refused_after_lock: u64,
}

fn run(seed: u64, steps: usize, seen: &mut Seen) {
    let mut rng = Rng(seed.wrapping_mul(0x9E3779B97F4A7C15) | 1);
    let mut ts: u64 = 1_000_000;
    // A fresh blockchain per sequence: testing_env! carries storage over between calls.
    let mut b = VMContextBuilder::new();
    b.current_account_id(vault_id()).predecessor_account_id(vault_id()).block_timestamp(ts);
    near_sdk::env::set_blockchain_interface(near_sdk::MockedBlockchain::new(
        b.build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        vec![],
        Default::default(),
        Default::default(),
        None,
    ));
    ctx(vault_id(), other_pk(), 0, ts, None);
    let mut v = Vault::new(owner(), random_policy(&mut rng), Some(vec![acct("shop.testnet")]), Some(registry()));
    if let Err(e) = owner_call(&mut v, ts, |v| {
        let _ = v.add_agent(agent_pk(), "agent".into(), None);
    }) {
        panic!("seed {seed}: add_agent at setup failed: {e}");
    }
    let mut led = Ledger::default();
    let mut locked = false;
    let fail = |step: usize, msg: String| -> ! { panic!("seed {seed} step {step}: {msg}") };

    for step in 0..steps {
        ts += match rng.below(10) {
            0..=5 => rng.below(3 * MIN),        // seconds to minutes: repeats and bursts
            6..=8 => rng.below(2 * 60 * MIN),   // up to 2 hours
            _ => rng.below(30 * 60 * MIN),      // up to 30 hours: windows roll over
        } + 1;

        match rng.below(100) {
            // ── the agent asks to pay (the attacker's only move) ──
            0..=59 => {
                let to = acct(RECIPIENTS[rng.below(RECIPIENTS.len() as u64) as usize]);
                let amt = amount(&mut rng);
                let force = rng.chance(5);
                let answer = match (to.as_str(), rng.below(100)) {
                    (_, 0..=4) => Err(PromiseError::Failed), // registry didn't answer
                    ("evil.testnet", _) => Ok(RegistryView { status: RegistryStatus::Flagged }),
                    ("stranger.testnet", 0..=49) => Ok(RegistryView { status: RegistryStatus::Reported }),
                    (_, 5..=9) => Ok(RegistryView { status: RegistryStatus::Dismissed }),
                    _ => Ok(RegistryView { status: RegistryStatus::Clear }),
                };
                // State the decision must respect, read BEFORE the call.
                let policy = v.get_policy().clone();
                let paused = v.get_stats().paused;
                let allowlisted = v.get_allowlist().contains(&&to);
                let window_before = led.window(ts);
                let cutoff = ts.saturating_sub(10 * MIN);
                let live_pending: Vec<Payment> =
                    v.get_pending().into_iter().filter(|p| ts <= p.created_at.0 + policy.pending_ttl_ns.0).cloned().collect();
                let repeat = led.spends.iter().any(|(id, (t, a))| {
                    *t > cutoff && *a == amt && v.get_payment(U64(*id)).is_some_and(|p| p.recipient == to && p.created_at.0 > cutoff)
                }) || live_pending.iter().any(|p| p.recipient == to && p.amount == amt && p.created_at.0 > cutoff);
                let registry_bad = matches!(answer, Err(_)) || matches!(&answer, Ok(r) if r.status == RegistryStatus::Flagged);
                let reported = matches!(&answer, Ok(r) if r.status == RegistryStatus::Reported);

                ctx(vault_id(), agent_pk(), 0, ts, None);
                let r = v.on_registry_checked("agent".into(), to.clone(), amt, String::new(), force, answer);
                let id = r.id.0;
                match r.status {
                    Status::Paid => {
                        if amt > policy.max_per_payment { fail(step, format!("paid {amt} over the per-payment cap {}", policy.max_per_payment)); }
                        if amt > policy.approval_threshold { fail(step, format!("paid {amt} over the approval threshold without the owner")); }
                        if !allowlisted { fail(step, format!("paid {to}, which is not allowlisted")); }
                        if window_before + amt.as_yoctonear() > policy.daily_limit.as_yoctonear() { fail(step, "agent pushed 24h payouts over the daily limit".into()); }
                        if registry_bad || reported { fail(step, format!("paid {to} although the registry said no (or didn't answer)")); }
                        if paused { fail(step, "paid while paused".into()); }
                        if to == vault_id() { fail(step, "the vault paid itself".into()); }
                        if repeat { fail(step, format!("repeat of {to} {amt} within 10 minutes paid without the owner")); }
                        if force { fail(step, "paid although the agent asked for review".into()); }
                        led.add(id, ts, amt);
                        seen.paid += 1;
                    }
                    Status::Pending => {
                        seen.held += 1;
                        if paused || registry_bad || to == vault_id() || amt > policy.max_per_payment {
                            fail(step, format!("held instead of blocked: {to} {amt} paused={paused}"));
                        }
                    }
                    Status::Blocked => {
                        led.blocked += 1;
                        seen.blocked += 1;
                    }
                    s => fail(step, format!("request returned {s:?}")),
                }
            }
            // ── a transfer fails: the vault must roll it back ──
            60..=64 => {
                if let Some(&id) = led.spends.keys().nth(rng.below(led.spends.len().max(1) as u64) as usize) {
                    ctx(vault_id(), other_pk(), 0, ts, Some(PromiseResult::Failed));
                    v.on_payment_settled(U64(id));
                    let (_, a) = led.spends.remove(&id).unwrap();
                    led.total -= a.as_yoctonear();
                    led.count -= 1;
                    seen.failed_transfers += 1;
                    if v.get_payment(U64(id)).map(|p| p.status) != Some(Status::Failed) { fail(step, format!("failed transfer {id} not marked failed")); }
                }
            }
            // ── the owner ──
            65..=74 => {
                let pend: Vec<u64> = v.get_pending().iter().map(|p| p.id.0).collect();
                if let Some(&id) = pend.get(rng.below(pend.len().max(1) as u64) as usize) {
                    let amt = v.get_payment(U64(id)).unwrap().amount;
                    let res = owner_call(&mut v, ts, |v| v.approve(U64(id)));
                    match (locked, res) {
                        (true, Ok(_)) => fail(step, "approve worked after lock_rules".into()),
                        (false, Ok(Status::Approved)) => {
                            led.add(id, ts, amt);
                            seen.approved += 1;
                        }
                        (true, Err(_)) => seen.refused_after_lock += 1,
                        (false, Ok(Status::Expired)) => {}
                        (false, other) => fail(step, format!("approve before lock gave {:?}", other.map(|s| format!("{s:?}")))),
                    }
                }
            }
            75..=79 => {
                let pend: Vec<u64> = v.get_pending().iter().map(|p| p.id.0).collect();
                if let Some(&id) = pend.get(rng.below(pend.len().max(1) as u64) as usize) {
                    // Denying only makes the vault stricter: it must work locked or not.
                    if let Err(e) = owner_call(&mut v, ts, |v| v.deny(U64(id))) { fail(step, format!("deny failed: {e}")); }
                    seen.denied += 1;
                }
            }
            80..=83 => {
                let p = random_policy(&mut rng);
                let json = |p: &Policy| near_sdk::serde_json::to_string(p).unwrap();
                let before = json(v.get_policy());
                let res = owner_call(&mut v, ts, |v| v.set_policy(p.clone()));
                if locked && (res.is_ok() || json(v.get_policy()) != before) { fail(step, "rules changed after lock_rules".into()); }
                if locked { seen.refused_after_lock += 1; }
                if let (false, Err(e)) = (locked, &res) { fail(step, format!("set_policy with a valid policy failed: {e}")); }
            }
            84..=86 => {
                let a = acct(RECIPIENTS[rng.below(4) as usize]);
                let before: Vec<AccountId> = v.get_allowlist().into_iter().cloned().collect();
                let res = owner_call(&mut v, ts, |v| v.add_to_allowlist(vec![a.clone()]));
                if locked && (res.is_ok() || v.get_allowlist().len() != before.len()) { fail(step, format!("allowlist grew after lock_rules ({a})")); }
                if locked { seen.refused_after_lock += 1; }
            }
            87..=88 => {
                let a = acct(RECIPIENTS[rng.below(4) as usize]);
                // Removing is stricter: allowed even when locked.
                if let Err(e) = owner_call(&mut v, ts, |v| v.remove_from_allowlist(vec![a.clone()])) { fail(step, format!("remove_from_allowlist failed: {e}")); }
            }
            89..=91 => {
                let p = !v.get_stats().paused;
                if let Err(e) = owner_call(&mut v, ts, |v| v.set_paused(p)) { fail(step, format!("set_paused failed: {e}")); }
            }
            92..=93 => {
                let res = owner_call(&mut v, ts, |v| {
                    let _ = v.withdraw(NearToken::from_yoctonear(NEAR / 10));
                });
                if locked && res.is_ok() { fail(step, "withdraw worked after lock_rules".into()); }
                if locked { seen.refused_after_lock += 1; }
            }
            94..=95 => {
                let before = v.get_registry().cloned();
                let res = owner_call(&mut v, ts, |v| v.set_registry(None));
                if locked && (res.is_ok() || v.get_registry().cloned() != before) { fail(step, "registry changed after lock_rules".into()); }
                if !locked && res.is_ok() {
                    if let Err(e) = owner_call(&mut v, ts, |v| v.set_registry(Some(registry()))) { fail(step, format!("re-setting the registry failed: {e}")); }
                }
            }
            96..=97 => {
                let res = owner_call(&mut v, ts, |v| {
                    let _ = v.add_agent(other_pk(), "second".into(), None);
                });
                if locked && res.is_ok() { fail(step, "add_agent worked after lock_rules".into()); }
                if !locked && res.is_ok() {
                    let _ = owner_call(&mut v, ts, |v| {
                        let _ = v.revoke_agent(other_pk());
                    });
                }
            }
            _ => {
                if !locked && rng.chance(40) {
                    if let Err(e) = owner_call(&mut v, ts, |v| v.lock_rules()) { fail(step, format!("lock_rules failed: {e}")); }
                    locked = true;
                    seen.locks += 1;
                }
            }
        }

        // ── invariants after every step ──
        let s = v.get_stats();
        if s.locked != locked { fail(step, "lock state flipped".into()); }
        if s.total_paid.as_yoctonear() != led.total { fail(step, format!("total_paid {} != ledger {}", s.total_paid.as_yoctonear(), led.total)); }
        if s.paid_count.0 != led.count { fail(step, format!("paid_count {} != ledger {}", s.paid_count.0, led.count)); }
        if s.blocked_count.0 != led.blocked { fail(step, format!("blocked_count {} != ledger {}", s.blocked_count.0, led.blocked)); }
        if s.pending_count > MAX_PENDING { fail(step, format!("{} payments pending (max {MAX_PENDING})", s.pending_count)); }
    }
}

#[test]
fn fuzz_vault_invariants() {
    let runs: u64 = std::env::var("FUZZ_RUNS").ok().and_then(|s| s.parse().ok()).unwrap_or(25);
    let steps: usize = std::env::var("FUZZ_STEPS").ok().and_then(|s| s.parse().ok()).unwrap_or(200);
    // Locked-vault calls are expected to panic; keep the output readable.
    let hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));
    let mut seen = Seen::default();
    let result = catch_unwind(AssertUnwindSafe(|| {
        for seed in 0..runs {
            run(seed, steps, &mut seen);
        }
    }));
    std::panic::set_hook(hook);
    if let Err(e) = result {
        let msg = e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
        panic!("invariant broken: {msg}");
    }
    println!("fuzz: {runs} sequences x {steps} steps, all invariants held. Exercised: {seen:?}");
    // A run that never reached these paths would prove nothing.
    assert!(seen.paid > 0 && seen.held > 0 && seen.blocked > 0 && seen.approved > 0 && seen.failed_transfers > 0 && seen.locks > 0 && seen.refused_after_lock > 0, "fuzz did not exercise every path: {seen:?}");
}
