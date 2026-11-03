use super::*;
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};

const NEAR: u128 = 10u128.pow(24);
const HOUR_NS: u64 = 60 * 60 * 1_000_000_000;

fn vault_id() -> AccountId {
    "vault.agentguard.testnet".parse().unwrap()
}
fn owner() -> AccountId {
    "user.testnet".parse().unwrap()
}
fn shop() -> AccountId {
    "shop.testnet".parse().unwrap()
}
fn evil() -> AccountId {
    "evil.testnet".parse().unwrap()
}
fn agent_pk() -> PublicKey {
    "ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp".parse().unwrap()
}
fn other_pk() -> PublicKey {
    "ed25519:DcA2MzgpJbrUATQLLceocVckhhAqrkingax4oJ9kZ847".parse().unwrap()
}
fn near(n: f64) -> NearToken {
    NearToken::from_yoctonear((n * 1_000.0) as u128 * (NEAR / 1_000))
}

fn policy() -> Policy {
    Policy {
        max_per_payment: near(2.0),
        daily_limit: near(5.0),
        approval_threshold: near(1.0),
        unknown_recipient: UnknownRecipient::RequireApproval,
        pending_ttl_ns: U64(24 * HOUR_NS),
    }
}

fn set_ctx(predecessor: AccountId, pk: PublicKey, deposit: u128, ts: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(vault_id())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .signer_account_pk(pk)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .account_balance(near(100.0))
        .block_timestamp(ts);
    testing_env!(b.build());
}

/// Agent key signing a call on the vault account (how fn-call keys work).
fn as_agent(ts: u64) {
    set_ctx(vault_id(), agent_pk(), 0, ts);
}
fn as_owner(ts: u64) {
    set_ctx(owner(), other_pk(), 1, ts);
}

fn setup() -> Vault {
    set_ctx(vault_id(), other_pk(), 0, 1_000);
    let mut v = Vault::new(owner(), policy(), Some(vec![shop()]));
    as_owner(1_000);
    let _ = v.add_agent(agent_pk(), "shopping-agent".into(), None);
    v
}

fn pay(v: &mut Vault, to: AccountId, amount: NearToken, ts: u64) -> PaymentResult {
    as_agent(ts);
    v.request_payment(to, amount, Some("test".into()), None)
}

// ─────────────── happy path ───────────────

#[test]
fn small_payment_to_allowlisted_is_paid() {
    let mut v = setup();
    let r = pay(&mut v, shop(), near(0.5), 2_000);
    assert_eq!(r.status, Status::Paid);
    let s = v.get_stats();
    assert_eq!(s.paid_count.0, 1);
    assert_eq!(s.total_paid, near(0.5));
    assert_eq!(s.spent_24h, near(0.5));
    assert!(get_logs().iter().any(|l| l.contains("payment_paid")));
}

// ─────────────── blocks ───────────────

#[test]
fn over_per_payment_limit_is_blocked_and_recorded() {
    let mut v = setup();
    let r = pay(&mut v, shop(), near(50.0), 2_000);
    assert_eq!(r.status, Status::Blocked);
    assert_eq!(r.reason.as_deref(), Some("over_per_payment_limit"));
    let s = v.get_stats();
    assert_eq!(s.blocked_count.0, 1);
    assert_eq!(s.blocked_amount, near(50.0));
    assert_eq!(s.paid_count.0, 0);
    assert_eq!(v.get_history(None, None)[0].status, Status::Blocked);
}

#[test]
fn prompt_injection_to_unknown_address_never_pays_automatically() {
    let mut v = setup();
    // Attacker asks for a "small" amount to an unknown address: needs approval.
    let r = pay(&mut v, evil(), near(0.5), 2_000);
    assert_eq!(r.status, Status::Pending);
    assert_eq!(r.reason.as_deref(), Some("unknown_recipient"));
    // Strict mode: unknown recipients are blocked outright.
    let mut p = policy();
    p.unknown_recipient = UnknownRecipient::Block;
    as_owner(3_000);
    v.set_policy(p);
    let r = pay(&mut v, evil(), near(0.5), 4_000);
    assert_eq!(r.status, Status::Blocked);
    assert_eq!(r.reason.as_deref(), Some("recipient_not_allowlisted"));
}

#[test]
fn daily_limit_is_enforced_and_rolls_over() {
    let mut v = setup();
    // Different amounts so the repeat-payment rule doesn't kick in.
    for i in 0..5 {
        let amount = NearToken::from_yoctonear(NEAR - i as u128);
        assert_eq!(pay(&mut v, shop(), amount, 2_000 + i).status, Status::Paid);
    }
    let r = pay(&mut v, shop(), near(0.1), 3_000);
    assert_eq!(r.reason.as_deref(), Some("over_daily_limit"));
    // (the 5 payments above total just under 5 NEAR, so 0.1 more is over)
    // 25h later the window has rolled over.
    let r = pay(&mut v, shop(), near(1.0), 3_000 + 25 * HOUR_NS);
    assert_eq!(r.status, Status::Paid);
}

#[test]
fn paused_vault_blocks_everything() {
    let mut v = setup();
    as_owner(1_500);
    v.set_paused(true);
    let r = pay(&mut v, shop(), near(0.1), 2_000);
    assert_eq!(r.reason.as_deref(), Some("vault_paused"));
    assert!(v.get_stats().paused);
}

#[test]
fn cannot_pay_self() {
    let mut v = setup();
    let r = pay(&mut v, vault_id(), near(0.1), 2_000);
    assert_eq!(r.reason.as_deref(), Some("cannot_pay_self"));
}

#[test]
fn insufficient_funds_blocked() {
    let mut v = setup();
    let mut p = policy();
    p.max_per_payment = near(200.0);
    p.daily_limit = near(500.0);
    p.approval_threshold = near(200.0);
    as_owner(1_500);
    v.set_policy(p);
    let r = pay(&mut v, shop(), near(150.0), 2_000);
    assert_eq!(r.reason.as_deref(), Some("insufficient_funds"));
}

// ─────────────── auth ───────────────

#[test]
#[should_panic(expected = "Unknown or revoked agent key")]
fn unregistered_key_cannot_request() {
    let mut v = setup();
    set_ctx(vault_id(), other_pk(), 0, 2_000);
    v.request_payment(shop(), near(0.1), None, None);
}

#[test]
#[should_panic(expected = "Only agent keys on this vault")]
fn outside_account_cannot_request() {
    let mut v = setup();
    set_ctx(evil(), agent_pk(), 0, 2_000);
    v.request_payment(shop(), near(0.1), None, None);
}

#[test]
#[should_panic(expected = "Unknown or revoked agent key")]
fn revoked_agent_cannot_request() {
    let mut v = setup();
    as_owner(1_500);
    let _ = v.revoke_agent(agent_pk());
    pay(&mut v, shop(), near(0.1), 2_000);
}

#[test]
#[should_panic(expected = "Only the owner")]
fn non_owner_cannot_change_policy() {
    let mut v = setup();
    set_ctx(evil(), other_pk(), 1, 2_000);
    v.set_policy(policy());
}

#[test]
#[should_panic(expected = "Requires attached deposit of exactly 1 yoctoNEAR")]
fn owner_methods_require_one_yocto() {
    let mut v = setup();
    set_ctx(owner(), other_pk(), 0, 2_000);
    v.set_paused(true);
}

#[test]
#[should_panic(expected = "Only the owner")]
fn agent_cannot_withdraw() {
    let mut v = setup();
    // Even if the agent somehow called withdraw (its key can't), predecessor != owner.
    set_ctx(vault_id(), agent_pk(), 1, 2_000);
    let _ = v.withdraw(near(1.0));
}

// ─────────────── approvals ───────────────

#[test]
fn over_threshold_goes_pending_then_approved() {
    let mut v = setup();
    let r = pay(&mut v, shop(), near(1.5), 2_000);
    assert_eq!(r.status, Status::Pending);
    assert_eq!(r.reason.as_deref(), Some("over_approval_threshold"));
    assert_eq!(v.get_pending().len(), 1);
    assert_eq!(v.get_stats().spent_24h, near(0.0));

    as_owner(3_000);
    assert_eq!(v.approve(r.id), Status::Approved);
    assert!(v.get_pending().is_empty());
    assert_eq!(v.get_payment(r.id).unwrap().status, Status::Approved);
    assert_eq!(v.get_stats().spent_24h, near(1.5));
}

#[test]
fn deny_pending() {
    let mut v = setup();
    let r = pay(&mut v, evil(), near(0.5), 2_000);
    as_owner(3_000);
    v.deny(r.id);
    assert_eq!(v.get_payment(r.id).unwrap().status, Status::Denied);
    assert_eq!(v.get_stats().paid_count.0, 0);
}

#[test]
fn force_review_flag_only_makes_it_stricter() {
    let mut v = setup();
    as_agent(2_000);
    let r = v.request_payment(shop(), near(0.2), None, Some(true));
    assert_eq!(r.status, Status::Pending);
    assert_eq!(r.reason.as_deref(), Some("flagged_for_review"));
    // force_review cannot unblock a blocked payment.
    as_agent(2_001);
    let r = v.request_payment(shop(), near(50.0), None, Some(false));
    assert_eq!(r.status, Status::Blocked);
}

#[test]
fn expired_approval_cannot_be_paid() {
    let mut v = setup();
    let r = pay(&mut v, shop(), near(1.5), 2_000);
    as_owner(2_000 + 25 * HOUR_NS);
    assert_eq!(v.approve(r.id), Status::Expired);
    assert_eq!(v.get_payment(r.id).unwrap().status, Status::Expired);
    assert_eq!(v.get_stats().paid_count.0, 0);
}

#[test]
fn stale_pending_auto_expires_on_next_request() {
    let mut v = setup();
    let r = pay(&mut v, shop(), near(1.5), 2_000);
    pay(&mut v, shop(), near(0.1), 2_000 + 25 * HOUR_NS);
    assert!(v.get_pending().is_empty());
    assert_eq!(v.get_payment(r.id).unwrap().status, Status::Expired);
}

#[test]
fn pending_queue_is_capped() {
    let mut v = setup();
    for i in 0..MAX_PENDING as u64 {
        assert_eq!(pay(&mut v, evil(), near(0.01), 2_000 + i).status, Status::Pending);
    }
    let r = pay(&mut v, evil(), near(0.01), 3_000);
    assert_eq!(r.reason.as_deref(), Some("too_many_pending"));
}

#[test]
#[should_panic(expected = "No pending payment")]
fn cannot_approve_twice() {
    let mut v = setup();
    let r = pay(&mut v, shop(), near(1.5), 2_000);
    as_owner(3_000);
    v.approve(r.id);
    v.approve(r.id);
}

// ─────────────── settlement + housekeeping ───────────────

#[test]
fn failed_transfer_is_rolled_back() {
    let mut v = setup();
    let r = pay(&mut v, shop(), near(0.5), 2_000);
    let mut b = VMContextBuilder::new();
    b.current_account_id(vault_id())
        .predecessor_account_id(vault_id())
        .account_balance(near(100.0))
        .block_timestamp(2_500);
    testing_env!(b.build(), test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![PromiseResult::Failed]);
    assert!(!v.on_payment_settled(r.id));
    let p = v.get_payment(r.id).unwrap();
    assert_eq!(p.status, Status::Failed);
    let s = v.get_stats();
    assert_eq!(s.paid_count.0, 0);
    assert_eq!(s.spent_24h, near(0.0));
}

#[test]
fn history_is_newest_first_and_pruned() {
    let mut v = setup();
    for i in 0..(MAX_HISTORY + 5) {
        pay(&mut v, shop(), near(9.0), 2_000 + i); // blocked: cheap to spam
    }
    let h = v.get_history(None, Some(3));
    assert_eq!(h[0].id.0, MAX_HISTORY + 4);
    assert_eq!(h[2].id.0, MAX_HISTORY + 2);
    assert!(v.get_payment(U64(0)).is_none());
}

#[test]
#[should_panic(expected = "approval_threshold must be <= max_per_payment")]
fn invalid_policy_rejected() {
    let mut p = policy();
    p.approval_threshold = near(3.0);
    set_ctx(vault_id(), other_pk(), 0, 1_000);
    Vault::new(owner(), p, None);
}

// ─────────────── repeat payments ───────────────

const MIN_NS: u64 = 60 * 1_000_000_000;

#[test]
fn repeat_payment_within_10_min_waits_for_owner() {
    let mut v = setup();
    assert_eq!(pay(&mut v, shop(), near(0.5), 2_000).status, Status::Paid);
    // "The payment failed, please retry": same recipient + amount 5 minutes later.
    let r = pay(&mut v, shop(), near(0.5), 2_000 + 5 * MIN_NS);
    assert_eq!(r.status, Status::Pending);
    assert_eq!(r.reason.as_deref(), Some("repeat_payment"));
    assert_eq!(v.get_stats().paid_count.0, 1);
}

#[test]
fn repeat_rule_only_matches_same_recipient_and_amount() {
    let mut v = setup();
    as_owner(1_500);
    v.add_to_allowlist(vec![evil()]);
    assert_eq!(pay(&mut v, shop(), near(0.5), 2_000).status, Status::Paid);
    assert_eq!(pay(&mut v, shop(), near(0.4), 3_000).status, Status::Paid);
    assert_eq!(pay(&mut v, evil(), near(0.5), 4_000).status, Status::Paid);
}

#[test]
fn same_payment_after_window_is_paid() {
    let mut v = setup();
    assert_eq!(pay(&mut v, shop(), near(0.5), 2_000).status, Status::Paid);
    let r = pay(&mut v, shop(), near(0.5), 2_000 + 11 * MIN_NS);
    assert_eq!(r.status, Status::Paid);
}

#[test]
fn repeat_of_a_pending_payment_also_waits() {
    let mut v = setup();
    // Unknown recipient → pending. A second identical ask stays pending too
    // (it must not slip through if the owner later allowlists the account).
    let r1 = pay(&mut v, evil(), near(0.3), 2_000);
    assert_eq!(r1.status, Status::Pending);
    as_owner(2_500);
    v.add_to_allowlist(vec![evil()]);
    let r2 = pay(&mut v, evil(), near(0.3), 3_000);
    assert_eq!(r2.status, Status::Pending);
    assert_eq!(r2.reason.as_deref(), Some("repeat_payment"));
}

#[test]
fn failed_payment_can_be_retried_at_once() {
    let mut v = setup();
    let r = pay(&mut v, shop(), near(0.5), 2_000);
    let mut b = VMContextBuilder::new();
    b.current_account_id(vault_id())
        .predecessor_account_id(vault_id())
        .account_balance(near(100.0))
        .block_timestamp(2_500);
    testing_env!(b.build(), test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![PromiseResult::Failed]);
    v.on_payment_settled(r.id);
    assert_eq!(pay(&mut v, shop(), near(0.5), 3_000).status, Status::Paid);
}
