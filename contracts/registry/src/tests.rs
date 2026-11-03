use super::*;
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::testing_env;

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn admin() -> AccountId {
    id("admin.testnet")
}
fn evil() -> AccountId {
    id("evil.testnet")
}

fn ctx(predecessor: AccountId, deposit: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(id("registry.agentguard.testnet"))
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .attached_deposit(deposit);
    testing_env!(b.build());
}

fn setup() -> Registry {
    ctx(admin(), NearToken::from_yoctonear(0));
    Registry::new(Some(vec![id("curator.testnet")]))
}

fn report(r: &mut Registry, by: &str, who: AccountId) -> StatusView {
    ctx(id(by), REPORT_DEPOSIT);
    r.report(who, "prompt injection asked my agent to pay it".into(), Some("https://testnet.nearblocks.io/txns/abc".into()))
}

#[test]
fn unknown_account_is_clear() {
    let r = setup();
    let s = r.get_status(evil());
    assert_eq!(s.status, Status::Clear);
    assert_eq!(s.report_count, 0);
}

#[test]
fn one_report_marks_reported() {
    let mut r = setup();
    let s = report(&mut r, "vault1.testnet", evil());
    assert_eq!(s.status, Status::Reported);
    assert_eq!(s.report_count, 1);
    assert_eq!(r.get_flagged_count(), 0);
    assert!(get_logs().iter().any(|l| l.contains("\"reported\"")));
}

#[test]
fn two_distinct_reporters_flag() {
    let mut r = setup();
    report(&mut r, "vault1.testnet", evil());
    let s = report(&mut r, "vault2.testnet", evil());
    assert_eq!(s.status, Status::Flagged);
    assert_eq!(r.get_flagged(None, None), vec![&evil()]);
    let e = r.get_entry(evil()).unwrap();
    assert_eq!(e.reports[1].evidence, "https://testnet.nearblocks.io/txns/abc");
}

#[test]
#[should_panic(expected = "You already reported this account")]
fn same_reporter_cannot_report_twice() {
    let mut r = setup();
    report(&mut r, "vault1.testnet", evil());
    report(&mut r, "vault1.testnet", evil());
}

#[test]
#[should_panic(expected = "Attach 0.01 NEAR")]
fn report_needs_deposit() {
    let mut r = setup();
    ctx(id("vault1.testnet"), NearToken::from_yoctonear(0));
    r.report(evil(), "x".into(), None);
}

#[test]
#[should_panic(expected = "You cannot report yourself")]
fn cannot_report_self() {
    let mut r = setup();
    report(&mut r, "evil.testnet", evil());
}

#[test]
#[should_panic(expected = "Reason must be 1-256 characters")]
fn empty_reason_rejected() {
    let mut r = setup();
    ctx(id("vault1.testnet"), REPORT_DEPOSIT);
    r.report(evil(), "".into(), None);
}

#[test]
fn curator_can_confirm_with_no_reports() {
    let mut r = setup();
    ctx(id("curator.testnet"), NearToken::from_yoctonear(0));
    assert_eq!(r.confirm(evil()).status, Status::Flagged);
    assert_eq!(r.get_flagged_count(), 1);
}

#[test]
fn curator_dismissal_stands_against_new_reports() {
    let mut r = setup();
    report(&mut r, "vault1.testnet", evil());
    report(&mut r, "vault2.testnet", evil());
    ctx(admin(), NearToken::from_yoctonear(0));
    assert_eq!(r.dismiss(evil()).status, Status::Dismissed);
    assert_eq!(r.get_flagged_count(), 0);
    // A third (maybe sybil) report does not re-flag a reviewed account.
    assert_eq!(report(&mut r, "vault3.testnet", evil()).status, Status::Dismissed);
}

#[test]
#[should_panic(expected = "Only a curator")]
fn non_curator_cannot_dismiss() {
    let mut r = setup();
    report(&mut r, "vault1.testnet", evil());
    ctx(evil(), NearToken::from_yoctonear(0));
    r.dismiss(evil());
}

#[test]
#[should_panic(expected = "maximum number of reports")]
fn reports_per_account_are_capped() {
    let mut r = setup();
    for i in 0..=MAX_REPORTS_PER_ACCOUNT {
        report(&mut r, &format!("vault{i}.testnet"), evil());
    }
}

#[test]
fn admin_manages_curators() {
    let mut r = setup();
    ctx(admin(), NearToken::from_yoctonear(0));
    r.add_curator(id("new.testnet"));
    assert!(r.get_curators().contains(&&id("new.testnet")));
    r.remove_curator(id("new.testnet"));
    assert!(!r.get_curators().contains(&&id("new.testnet")));
}

#[test]
#[should_panic(expected = "Only the registry admin")]
fn non_admin_cannot_add_curator() {
    let mut r = setup();
    ctx(evil(), NearToken::from_yoctonear(0));
    r.add_curator(evil());
}
