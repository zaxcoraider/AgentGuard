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
    _sandbox: near_sandbox::Sandbox,
}

fn build(manifest: &str) -> testresult::TestResult<Vec<u8>> {
    let opts = cargo_near_build::BuildOpts { manifest_path: Some(manifest.into()), ..Default::default() };
    let path = cargo_near_build::build_with_cli(opts)?;
    Ok(std::fs::read(path)?)
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
    let root = env!("CARGO_MANIFEST_DIR");
    let vault_wasm = build(&format!("{root}/../vault/Cargo.toml"))?;
    let factory_wasm = build(&format!("{root}/Cargo.toml"))?;

    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let genesis = Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
    let mk = |n: &str| -> AccountId { n.parse().unwrap() };
    let (factory, user, shop) = (mk("factory.sandbox"), mk("user.sandbox"), mk("shop.sandbox"));
    for id in [&factory, &user, &shop] {
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

    // 2. Deploy the factory, pointing at that hash.
    near_api::Contract::deploy(factory.clone())
        .use_code(factory_wasm)
        .with_init_call("new", json!({ "vault_code_hash": code_hash }))?
        .with_signer(genesis.clone())
        .send_to(&net)
        .await?
        .assert_success();

    Ok(Env { net, genesis, factory, user, shop, code_hash, _sandbox: sandbox })
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
