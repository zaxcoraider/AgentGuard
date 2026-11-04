//! End-to-end test on a local NEAR sandbox node with the real wasm files.
//! Proves the factory's core claim: a vault is created on immutable code (global
//! contract by hash) and is born with ZERO access keys. After the owner adds an
//! agent, the only key on the vault is a function-call key for `request_payment`.

use near_api::{AccountId, NearToken, NetworkConfig, Signer};
use near_sdk::serde_json::{Value, json};
use std::sync::Arc;

struct Env {
    net: NetworkConfig,
    genesis: Arc<Signer>,
    factory: AccountId,
    user: AccountId,
    shop: AccountId,
    code_hash: String,
    registry: AccountId,
    _sandbox: near_sandbox::Sandbox,
}

fn build(manifest: &str) -> testresult::TestResult<Vec<u8>> {
    let opts = cargo_near_build::BuildOpts { manifest_path: Some(manifest.into()), ..Default::default() };
    let path = cargo_near_build::build_with_cli(opts)?;
    Ok(std::fs::read(path)?)
}

/// Builds the vault and factory wasm once for all tests. The tests run in parallel, and
/// on a fresh clone several `cargo near` builds into the same target dir would race.
/// Returns (vault, factory, registry).
fn wasm() -> &'static (Vec<u8>, Vec<u8>, Vec<u8>) {
    static WASM: std::sync::OnceLock<(Vec<u8>, Vec<u8>, Vec<u8>)> = std::sync::OnceLock::new();
    WASM.get_or_init(|| {
        let root = env!("CARGO_MANIFEST_DIR");
        let vault = build(&format!("{root}/../vault/Cargo.toml")).expect("build vault wasm");
        let factory = build(&format!("{root}/Cargo.toml")).expect("build factory wasm");
        let registry = build(&format!("{root}/../registry/Cargo.toml")).expect("build registry wasm");
        (vault, factory, registry)
    })
}

fn policy(approval_near: u128) -> Value {
    json!({
        "max_per_payment": NearToken::from_near(2).as_yoctonear().to_string(),
        "daily_limit": NearToken::from_near(5).as_yoctonear().to_string(),
        "approval_threshold": NearToken::from_near(approval_near).as_yoctonear().to_string(),
        "unknown_recipient": "require_approval",
        "pending_ttl_ns": (24u64 * 3600 * 1_000_000_000).to_string(),
    })
}

async fn balance(env: &Env, id: &AccountId) -> NearToken {
    near_api::Account(id.clone()).tokens().near_balance().fetch_from(&env.net).await.unwrap().total
}

async fn setup() -> testresult::TestResult<Env> {
    setup_with(None).await
}

/// `registry`: Some(true) = deploy a real registry and use it; Some(false) =
/// point vaults at an account with no registry code (to test fail-closed).
async fn setup_with(registry: Option<bool>) -> testresult::TestResult<Env> {
    let (vault_wasm, factory_wasm, registry_wasm) = wasm();

    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let genesis = Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
    let mk = |n: &str| -> AccountId { n.parse().unwrap() };
    let (factory, user, shop, reg) = (mk("factory.sandbox"), mk("user.sandbox"), mk("shop.sandbox"), mk("registry.sandbox"));
    for id in [&factory, &user, &shop, &reg] {
        sandbox.create_account(id.clone()).initial_balance(NearToken::from_near(100)).send().await?;
    }

    // 1. Publish the vault code once, as an immutable global contract (by hash).
    near_api::Contract::deploy_global_contract_code(vault_wasm.clone())
        .as_hash()
        .with_signer(factory.clone(), genesis.clone())
        .send_to(&net)
        .await?
        .assert_success();
    let code_hash = near_api::types::CryptoHash::hash(&vault_wasm).to_string();

    if registry == Some(true) {
        near_api::Contract::deploy(reg.clone())
            .use_code(registry_wasm.clone())
            .with_init_call("new", json!({}))?
            .with_signer(genesis.clone())
            .send_to(&net)
            .await?
            .assert_success();
    }
    let registry_arg = if registry.is_some() { json!(reg) } else { json!(null) };

    // 2. Deploy the factory, pointing at that hash.
    near_api::Contract::deploy(factory.clone())
        .use_code(factory_wasm.clone())
        .with_init_call("new", json!({ "vault_code_hash": code_hash, "registry": registry_arg }))?
        .with_signer(genesis.clone())
        .send_to(&net)
        .await?
        .assert_success();

    Ok(Env { net, genesis, factory, user, shop, code_hash, registry: reg, _sandbox: sandbox })
}

async fn create_vault(env: &Env, name: &str, approval_near: u128) -> near_api::types::transaction::result::TransactionResult {
    near_api::Contract(env.factory.clone())
        .call_function(
            "create_vault",
            json!({ "name": name, "policy": policy(approval_near), "allowlist": [env.shop] }),
        )
        .transaction()
        .deposit(NearToken::from_near(2))
        .gas(near_api::types::NearGas::from_tgas(100))
        .with_signer(env.user.clone(), env.genesis.clone())
        .send_to(&env.net)
        .await
        .unwrap()
}

async fn keys(env: &Env, id: &AccountId) -> Vec<String> {
    near_api::Account(id.clone())
        .list_keys()
        .fetch_from(&env.net)
        .await
        .unwrap()
        .data
        .iter()
        .map(|(pk, ak)| format!("{pk} {:?}", ak.permission))
        .collect()
}

#[tokio::test]
async fn factory_creates_keyless_vault_on_immutable_code() -> testresult::TestResult<()> {
    let env = setup().await?;
    let vault: AccountId = format!("sentinel.{}", env.factory).parse()?;

    // Create a vault through the factory.
    let res = create_vault(&env, "sentinel", 1).await;
    let ok: bool = res.assert_success().json()?;
    assert!(ok, "factory callback reported failure");

    // The vault exists, runs the global code by hash, and has NO access keys.
    let view = near_api::Account(vault.clone()).view().fetch_from(&env.net).await?.data;
    println!("vault account: {view:?}");
    match &view.contract_state {
        near_api::types::account::ContractState::GlobalHash(h) => assert_eq!(h.to_string(), env.code_hash),
        other => panic!("vault should use the global contract by hash, got {other:?}"),
    }
    assert!(keys(&env, &vault).await.is_empty(), "vault must be born without any key");
    assert!(view.amount >= NearToken::from_millinear(1_900), "deposit should fund the vault");

    // The vault works and is owned by the creator.
    let owner: String = near_api::Contract(vault.clone()).call_function("get_owner", ()).read_only().fetch_from(&env.net).await?.data;
    assert_eq!(owner, env.user.as_str());
    let info: Value = near_api::Contract(env.factory.clone())
        .call_function("get_vault", json!({ "vault": vault }))
        .read_only()
        .fetch_from(&env.net)
        .await?
        .data;
    assert_eq!(info["owner"], env.user.as_str());
    assert_eq!(info["code_hash"], env.code_hash);

    // Owner adds an agent: the ONLY key is now a function-call key for request_payment.
    let agent_sk = near_api::signer::generate_secret_key()?;
    let agent = Signer::from_secret_key(agent_sk.clone())?;
    near_api::Contract(vault.clone())
        .call_function("add_agent", json!({ "public_key": agent_sk.public_key().to_string(), "label": "sentinel" }))
        .transaction()
        .deposit(NearToken::from_yoctonear(1))
        .with_signer(env.user.clone(), env.genesis.clone())
        .send_to(&env.net)
        .await?
        .assert_success();
    let ks = keys(&env, &vault).await;
    println!("vault keys after add_agent: {ks:?}");
    assert_eq!(ks.len(), 1);
    assert!(ks[0].contains("FunctionCall") && ks[0].contains("request_payment") && !ks[0].contains("FullAccess"));

    // The agent can pay the allowlisted shop through the policy.
    let shop_before = balance(&env, &env.shop).await;
    let r: Value = near_api::Contract(vault.clone())
        .call_function(
            "request_payment",
            json!({ "recipient": env.shop, "amount": NearToken::from_millinear(300).as_yoctonear().to_string() }),
        )
        .transaction()
        .with_signer(vault.clone(), agent.clone())
        .send_to(&env.net)
        .await?
        .assert_success()
        .json()?;
    assert_eq!(r["status"], "paid", "{r}");
    let shop_after = balance(&env, &env.shop).await;
    assert_eq!(shop_after.as_yoctonear() - shop_before.as_yoctonear(), NearToken::from_millinear(300).as_yoctonear());

    // The agent key cannot send a plain transfer out of the vault.
    let transfer = near_api::Tokens::account(vault.clone())
        .send_to(env.shop.clone())
        .near(NearToken::from_near(1))
        .with_signer(agent.clone())
        .send_to(&env.net)
        .await;
    assert!(
        transfer.is_err() || transfer.unwrap().into_result().is_err(),
        "a function-call key must not be able to transfer NEAR"
    );
    Ok(())
}

#[tokio::test]
async fn bad_policy_rolls_back_and_refunds() -> testresult::TestResult<()> {
    let env = setup().await?;
    let vault: AccountId = format!("broken.{}", env.factory).parse()?;
    let before = balance(&env, &env.user).await;

    // approval_threshold (3) > max_per_payment (2): the vault's `new` panics.
    let res = create_vault(&env, "broken", 3).await;
    let ok: bool = res.assert_success().json()?;
    assert!(!ok, "factory should report the failure");

    assert!(near_api::Account(vault).view().fetch_from(&env.net).await.is_err(), "vault account must not exist");
    let after = balance(&env, &env.user).await;
    let lost = before.as_yoctonear() - after.as_yoctonear();
    assert!(lost < NearToken::from_millinear(50).as_yoctonear(), "only gas should be spent, lost {lost} yocto");
    Ok(())
}

#[tokio::test]
async fn duplicate_vault_name_is_rejected() -> testresult::TestResult<()> {
    let env = setup().await?;
    create_vault(&env, "sentinel", 1).await.assert_success();
    let second = create_vault(&env, "sentinel", 1).await;
    assert!(second.into_result().is_err(), "second vault with the same name must fail");
    Ok(())
}

async fn add_agent(env: &Env, vault: &AccountId) -> testresult::TestResult<Arc<Signer>> {
    let sk = near_api::signer::generate_secret_key()?;
    owner_call(env, vault, "add_agent", json!({ "public_key": sk.public_key().to_string(), "label": "sentinel" })).await?.assert_success();
    Ok(Signer::from_secret_key(sk)?)
}

async fn owner_call(env: &Env, vault: &AccountId, method: &str, args: Value) -> testresult::TestResult<near_api::types::transaction::result::TransactionResult> {
    Ok(near_api::Contract(vault.clone())
        .call_function(method, args)
        .transaction()
        .deposit(NearToken::from_yoctonear(1))
        .with_signer(env.user.clone(), env.genesis.clone())
        .send_to(&env.net)
        .await?)
}

async fn agent_pay(env: &Env, vault: &AccountId, agent: &Arc<Signer>, to: &AccountId, milli: u128) -> Value {
    near_api::Contract(vault.clone())
        .call_function("request_payment", json!({ "recipient": to, "amount": NearToken::from_millinear(milli).as_yoctonear().to_string() }))
        .transaction()
        .gas(near_api::types::NearGas::from_tgas(100))
        .with_signer(vault.clone(), agent.clone())
        .send_to(&env.net)
        .await
        .unwrap()
        .assert_success()
        .json()
        .unwrap()
}

async fn report(env: &Env, reporter: &AccountId, who: &AccountId) -> Value {
    near_api::Contract(env.registry.clone())
        .call_function("report", json!({ "account": who, "reason": "prompt injection tried to make an agent pay it", "evidence": "sandbox" }))
        .transaction()
        .deposit(NearToken::from_millinear(10))
        .with_signer(reporter.clone(), env.genesis.clone())
        .send_to(&env.net)
        .await
        .unwrap()
        .assert_success()
        .json()
        .unwrap()
}

#[tokio::test]
async fn shared_registry_blocks_flagged_accounts_onchain() -> testresult::TestResult<()> {
    let env = setup_with(Some(true)).await?;
    create_vault(&env, "sentinel", 1).await.assert_success();
    let vault: AccountId = format!("sentinel.{}", env.factory).parse()?;
    let reg: Option<String> = near_api::Contract(vault.clone()).call_function("get_registry", ()).read_only().fetch_from(&env.net).await?.data;
    assert_eq!(reg.as_deref(), Some(env.registry.as_str()), "factory should give new vaults the registry");
    let agent = add_agent(&env, &vault).await?;

    // Clear recipient: paid after the registry lookup.
    let r = agent_pay(&env, &vault, &agent, &env.shop, 100).await;
    assert_eq!(r["status"], "paid", "{r}");

    // One report: payments to it now wait for the owner (even though it's allowlisted).
    let r1 = report(&env, &env.user, &env.shop).await;
    assert_eq!(r1["status"], "reported");
    let r = agent_pay(&env, &vault, &agent, &env.shop, 120).await;
    assert_eq!((r["status"].as_str(), r["reason"].as_str()), (Some("pending"), Some("recipient_reported")), "{r}");

    // A second, different reporter flags it: blocked on-chain.
    let r2 = report(&env, &env.factory, &env.shop).await;
    assert_eq!(r2["status"], "flagged");
    let r = agent_pay(&env, &vault, &agent, &env.shop, 130).await;
    assert_eq!((r["status"].as_str(), r["reason"].as_str()), (Some("blocked"), Some("recipient_flagged")), "{r}");
    Ok(())
}

#[tokio::test]
async fn missing_registry_fails_closed() -> testresult::TestResult<()> {
    // Vaults point at registry.sandbox, which has no contract code.
    let env = setup_with(Some(false)).await?;
    create_vault(&env, "sentinel", 1).await.assert_success();
    let vault: AccountId = format!("sentinel.{}", env.factory).parse()?;
    let agent = add_agent(&env, &vault).await?;
    let shop_before = balance(&env, &env.shop).await;
    let r = agent_pay(&env, &vault, &agent, &env.shop, 100).await;
    assert_eq!((r["status"].as_str(), r["reason"].as_str()), (Some("blocked"), Some("registry_unavailable")), "{r}");
    assert_eq!(balance(&env, &env.shop).await, shop_before);
    Ok(())
}

#[tokio::test]
async fn locked_vault_cannot_be_loosened_or_drained_by_owner() -> testresult::TestResult<()> {
    let env = setup().await?;
    create_vault(&env, "sentinel", 1).await.assert_success();
    let vault: AccountId = format!("sentinel.{}", env.factory).parse()?;
    let agent = add_agent(&env, &vault).await?;
    owner_call(&env, &vault, "lock_rules", json!({})).await?.assert_success();
    let locked: bool = near_api::Contract(vault.clone()).call_function("is_locked", ()).read_only().fetch_from(&env.net).await?.data;
    assert!(locked);

    for (method, args) in [
        ("withdraw", json!({ "amount": NearToken::from_millinear(500).as_yoctonear().to_string() })),
        ("set_policy", json!({ "policy": policy(2) })),
        ("add_to_allowlist", json!({ "accounts": [env.user] })),
        ("set_registry", json!({ "registry": null })),
    ] {
        let res = owner_call(&env, &vault, method, args).await?;
        assert!(res.into_result().is_err(), "{method} must fail on a locked vault");
    }
    // Still pays inside the locked rules.
    let r = agent_pay(&env, &vault, &agent, &env.shop, 100).await;
    assert_eq!(r["status"], "paid", "{r}");
    Ok(())
}
