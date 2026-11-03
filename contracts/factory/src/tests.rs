use super::*;
use near_sdk::test_utils::{VMContextBuilder, get_logs};
use near_sdk::{PromiseResult, RuntimeFeesConfig, test_vm_config, testing_env};

fn factory_id() -> AccountId {
    "agentguard.testnet".parse().unwrap()
}
fn admin() -> AccountId {
    "admin.testnet".parse().unwrap()
}
fn user() -> AccountId {
    "user.testnet".parse().unwrap()
}
fn hash() -> Base58CryptoHash {
    "4reLvkAWfqk5fsqio1KLudk46cqRz9erQdaHkWZKMJDZ".parse().unwrap()
}
fn policy() -> Policy {
    Policy {
        max_per_payment: NearToken::from_near(2),
        daily_limit: NearToken::from_near(5),
        approval_threshold: NearToken::from_near(1),
        unknown_recipient: UnknownRecipient::RequireApproval,
        pending_ttl_ns: U64(86_400_000_000_000),
    }
}

fn ctx(predecessor: AccountId, deposit: NearToken) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(factory_id())
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .attached_deposit(deposit)
        .account_balance(NearToken::from_near(50));
    testing_env!(b.build());
}

fn callback_ctx(result: PromiseResult) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(factory_id())
        .predecessor_account_id(factory_id())
        .account_balance(NearToken::from_near(50));
    testing_env!(b.build(), test_vm_config(), RuntimeFeesConfig::test(), Default::default(), vec![result]);
}

fn setup() -> Factory {
    ctx(admin(), NearToken::from_yoctonear(0));
    Factory::new(hash())
}

#[test]
fn init_stores_admin_and_hash() {
    let f = setup();
    assert_eq!(f.get_admin(), &admin());
    assert_eq!(String::from(&f.get_vault_code_hash()), String::from(&hash()));
    assert_eq!(f.get_vault_count(), 0);
}

#[test]
fn vault_account_is_subaccount_of_factory() {
    let f = setup();
    assert_eq!(f.vault_account_for("sentinel".into()).as_str(), "sentinel.agentguard.testnet");
}

#[test]
fn create_vault_returns_promise() {
    let mut f = setup();
    ctx(user(), NearToken::from_near(2));
    let _ = f.create_vault("sentinel".into(), None, policy(), None);
    // Recorded only after the callback confirms success.
    assert_eq!(f.get_vault_count(), 0);
}

#[test]
#[should_panic(expected = "Attach at least 1 NEAR")]
fn create_vault_requires_min_deposit() {
    let mut f = setup();
    ctx(user(), NearToken::from_millinear(500));
    let _ = f.create_vault("sentinel".into(), None, policy(), None);
}

#[test]
#[should_panic(expected = "Name may only use")]
fn rejects_dots_in_name() {
    let mut f = setup();
    ctx(user(), NearToken::from_near(2));
    let _ = f.create_vault("a.b".into(), None, policy(), None);
}

#[test]
#[should_panic(expected = "Name may only use")]
fn rejects_uppercase_name() {
    let mut f = setup();
    ctx(user(), NearToken::from_near(2));
    let _ = f.create_vault("Sentinel".into(), None, policy(), None);
}

#[test]
#[should_panic(expected = "Name must be 1-32 characters")]
fn rejects_long_name() {
    let mut f = setup();
    ctx(user(), NearToken::from_near(2));
    let _ = f.create_vault("a".repeat(33), None, policy(), None);
}

#[test]
fn successful_callback_records_vault() {
    let mut f = setup();
    let vault: AccountId = "sentinel.agentguard.testnet".parse().unwrap();
    callback_ctx(PromiseResult::Successful(vec![]));
    assert!(f.on_vault_created(vault.clone(), user(), user(), NearToken::from_near(2)));
    let info = f.get_vault(vault.clone()).unwrap();
    assert_eq!(info.owner, user());
    assert_eq!(f.get_vault_count(), 1);
    assert_eq!(f.get_vaults_by_owner(user()).len(), 1);
    assert!(get_logs().iter().any(|l| l.contains("vault_created")));
}

#[test]
fn failed_callback_refunds_and_records_nothing() {
    let mut f = setup();
    let vault: AccountId = "sentinel.agentguard.testnet".parse().unwrap();
    callback_ctx(PromiseResult::Failed);
    assert!(!f.on_vault_created(vault.clone(), user(), user(), NearToken::from_near(2)));
    assert!(f.get_vault(vault).is_none());
    assert!(get_logs().iter().any(|l| l.contains("vault_create_failed")));
}

#[test]
#[should_panic(expected = "A vault with this name already exists")]
fn duplicate_name_rejected() {
    let mut f = setup();
    let vault: AccountId = "sentinel.agentguard.testnet".parse().unwrap();
    callback_ctx(PromiseResult::Successful(vec![]));
    f.on_vault_created(vault, user(), user(), NearToken::from_near(2));
    ctx(user(), NearToken::from_near(2));
    let _ = f.create_vault("sentinel".into(), None, policy(), None);
}

#[test]
#[should_panic(expected = "Only the factory admin")]
fn only_admin_can_change_code_hash() {
    let mut f = setup();
    ctx(user(), NearToken::from_yoctonear(0));
    f.set_vault_code_hash(hash());
}

#[test]
fn admin_can_point_new_vaults_at_new_code() {
    let mut f = setup();
    ctx(admin(), NearToken::from_yoctonear(0));
    let h2: Base58CryptoHash = "5mjCHp8mt5XjHqLEYDGz7Y5nJwL2CSNVwDiPXo1H1dRY".parse().unwrap();
    f.set_vault_code_hash(h2);
    assert_eq!(String::from(&f.get_vault_code_hash()), String::from(&h2));
}
