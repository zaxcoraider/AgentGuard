//! End-to-end test on a local NEAR sandbox node with the real wasm.
//! Proves the core security claim: an agent's function-call key can request
//! payments, but the NEAR runtime itself refuses any other method (withdraw,
//! set_policy, ...), and the contract enforces the policy on every request.

use near_api::{AccountId, NearToken, NetworkConfig, Signer};
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::json;
use std::sync::Arc;

#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
struct PaymentResult {
    id: String,
    status: String,
    reason: Option<String>,
}

#[derive(Deserialize, Debug)]
#[serde(crate = "near_sdk::serde")]
struct Stats {
    paid_count: String,
    blocked_count: String,
    pending_count: u32,
}

struct Env {
    net: NetworkConfig,
    genesis: Arc<Signer>,
    vault: AccountId,
    owner: AccountId,
    shop: AccountId,
    evil: AccountId,
    _sandbox: near_sandbox::Sandbox,
}

async fn balance(env: &Env, id: &AccountId) -> NearToken {
    near_api::Account(id.clone()).tokens().near_balance().fetch_from(&env.net).await.unwrap().total
}

async fn setup(wasm: Vec<u8>) -> testresult::TestResult<Env> {
    let sandbox = near_sandbox::Sandbox::start_sandbox().await?;
    let net = NetworkConfig::from_rpc_url("sandbox", sandbox.rpc_addr.parse()?);
    let genesis = Signer::from_secret_key(near_sandbox::config::DEFAULT_GENESIS_ACCOUNT_PRIVATE_KEY.parse()?)?;
    let mk = |n: &str| -> AccountId { n.parse().unwrap() };
    let (vault, owner, shop, evil) = (mk("vault.sandbox"), mk("owner.sandbox"), mk("shop.sandbox"), mk("evil.sandbox"));
    for id in [&vault, &owner, &shop, &evil] {
        sandbox.create_account(id.clone()).initial_balance(NearToken::from_near(20)).send().await?;
    }
    near_api::Contract::deploy(vault.clone())
        .use_code(wasm)
        .with_init_call(
            "new",
            json!({
                "owner": owner,
                "allowlist": [shop],
                "policy": {
                    "max_per_payment": NearToken::from_near(2).as_yoctonear().to_string(),
                    "daily_limit": NearToken::from_near(5).as_yoctonear().to_string(),
                    "approval_threshold": NearToken::from_near(1).as_yoctonear().to_string(),
                    "unknown_recipient": "require_approval",
                    "pending_ttl_ns": (24u64 * 3600 * 1_000_000_000).to_string(),
                }
            }),
        )?
        .with_signer(genesis.clone())
        .send_to(&net)
        .await?
        .assert_success();
    Ok(Env { net, genesis, vault, owner, shop, evil, _sandbox: sandbox })
}

async fn request(env: &Env, agent: &Arc<Signer>, to: &AccountId, near_milli: u128) -> PaymentResult {
    near_api::Contract(env.vault.clone())
        .call_function(
            "request_payment",
            json!({"recipient": to, "amount": NearToken::from_millinear(near_milli).as_yoctonear().to_string(), "memo": "sandbox"}),
        )
        .transaction()
        .with_signer(env.vault.clone(), agent.clone())
        .send_to(&env.net)
        .await
        .unwrap()
        .assert_success()
        .json()
        .unwrap()
}

async fn owner_call(env: &Env, method: &str, args: near_sdk::serde_json::Value) -> testresult::TestResult<()> {
    near_api::Contract(env.vault.clone())
        .call_function(method, args)
        .transaction()
        .deposit(NearToken::from_yoctonear(1))
        .with_signer(env.owner.clone(), env.genesis.clone())
        .send_to(&env.net)
        .await?
        .assert_success();
    Ok(())
}

#[tokio::test]
async fn agent_key_is_fenced_by_runtime_and_policy() -> testresult::TestResult<()> {
    let wasm_path = cargo_near_build::build_with_cli(Default::default())?;
    let env = setup(std::fs::read(wasm_path)?).await?;

    // Owner registers an agent: the vault adds a fn-call key to its own account.
    let agent_sk = near_api::signer::generate_secret_key()?;
    let agent = Signer::from_secret_key(agent_sk.clone())?;
    owner_call(&env, "add_agent", json!({"public_key": agent_sk.public_key().to_string(), "label": "demo-agent"})).await?;

    // 1. Small payment to allowlisted shop → paid, shop really receives it.
    let shop_before = balance(&env, &env.shop).await;
    let r = request(&env, &agent, &env.shop, 500).await;
    assert_eq!(r.status, "paid", "{r:?}");
    let shop_after = balance(&env, &env.shop).await;
    assert_eq!(shop_after.as_yoctonear() - shop_before.as_yoctonear(), NearToken::from_millinear(500).as_yoctonear());

    // 2. Prompt-injected drain attempt → blocked onchain, attacker gets nothing.
    let evil_before = balance(&env, &env.evil).await;
    let r = request(&env, &agent, &env.evil, 15_000).await;
    assert_eq!(r.status, "blocked");
    assert_eq!(r.reason.as_deref(), Some("over_per_payment_limit"));
    assert_eq!(balance(&env, &env.evil).await, evil_before);

    // 3. Unknown recipient → pending; owner denies → attacker gets nothing.
    let r = request(&env, &agent, &env.evil, 300).await;
    assert_eq!(r.status, "pending");
    owner_call(&env, "deny", json!({"id": r.id})).await?;
    assert_eq!(balance(&env, &env.evil).await, evil_before);

    // 4. Over approval threshold → pending; owner approves → paid.
    let r = request(&env, &agent, &env.shop, 1_500).await;
    assert_eq!(r.status, "pending");
    owner_call(&env, "approve", json!({"id": r.id})).await?;
    assert!(balance(&env, &env.shop).await > shop_after);

    // 5. The agent key CANNOT call anything else: the NEAR runtime rejects it
    //    before the contract even runs (key is limited to request_payment).
    for (method, args) in [
        ("withdraw", json!({"amount": NearToken::from_near(5).as_yoctonear().to_string()})),
        ("set_paused", json!({"paused": false})),
        ("add_to_allowlist", json!({"accounts": [env.evil]})),
    ] {
        let res = near_api::Contract(env.vault.clone())
            .call_function(method, args)
            .transaction()
            .with_signer(env.vault.clone(), agent.clone())
            .send_to(&env.net)
            .await;
        let rejected = match res {
            Err(_) => true,
            Ok(r) => r.into_result().is_err(),
        };
        assert!(rejected, "agent key must not be able to call {method}");
    }

    // 6. Owner revokes the agent → its key is deleted; further requests fail.
    owner_call(&env, "revoke_agent", json!({"public_key": agent_sk.public_key().to_string()})).await?;
    let res = near_api::Contract(env.vault.clone())
        .call_function("request_payment", json!({"recipient": env.shop, "amount": "1"}))
        .transaction()
        .with_signer(env.vault.clone(), agent.clone())
        .send_to(&env.net)
        .await;
    assert!(match res { Err(_) => true, Ok(r) => r.into_result().is_err() }, "revoked key must not work");

    let stats: Stats = near_api::Contract(env.vault.clone())
        .call_function("get_stats", ())
        .read_only()
        .fetch_from(&env.net)
        .await?
        .data;
    assert_eq!(stats.paid_count, "2");
    assert_eq!(stats.blocked_count, "1");
    assert_eq!(stats.pending_count, 0);
    Ok(())
}
