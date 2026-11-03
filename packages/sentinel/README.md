# Sentinel

**Live: https://sentinel-47ip.onrender.com**

An AI agent that lives on an AgentGuard vault (`sentinel.agentguard.testnet`). It pays for its own existence out of that vault, and anyone can try to talk it into paying them.

**Two levels to beat:**
1. **Fool the AI.** Get Sentinel to try a payment. Its model (DeepSeek V4.1 Flash on NEAR AI Cloud, in a TEE) has no special hardening, but it does check addresses and often says no.
2. **Beat the vault.** Get that payment through. The vault only pays `compute.agentguard.testnet`, at most 0.05 NEAR at a time and 1 NEAR a day, and blocks everyone else on-chain.

## How it works
- `POST /api/chat {"message": "..."}`: one model conversation with three tools: `pay`, `check_address`, `treasury`. `pay` goes to the real vault through the agent's function-call key. At most one payment per message.
- Every payment a visitor's message leads to is recorded as an attack in the feed, with the first 200 characters of the message, the vault's answer and the tx link. The visitor's text never goes on-chain: the memo is `trick-me #N`.
- **Metabolism:** every 10 minutes Sentinel pays `compute.agentguard.testnet` rent (0.002 NEAR) plus 0.0005 NEAR per 1k tokens it used. NEAR AI bills our API key off-chain, so this on-chain payment is how its cost of living becomes visible. The rates are ours and roughly mirror the model's real price.
- Visitor limits: 10 messages per hour per IP, 500 per day in total (`TRICK_ME_MAX_PER_HOUR`, `TRICK_ME_MAX_PER_DAY`).
- Model providers in order: NEAR AI Cloud (TEE) → Nebius → DGrid. Every reply says which one answered and whether it ran in a TEE.

## How it earns: paid "safe to pay?" checks (HTTP 402)
Other agents pay Sentinel 0.01 NEAR per check (`SENTINEL_CHECK_PRICE_NEAR`).
1. `GET /api/check?account=X&vault=V` → **402** with an x402-shaped offer: `payTo` (Sentinel's vault), price in yoctoNEAR, a one-time `nonce`, memo `x402:<nonce>`, valid 10 minutes. `vault` is optional: with it, lookalike names are checked against your vault's allowlist.
2. Pay with that memo, either from your AgentGuard vault (`request_payment {recipient, amount, memo}`) or directly (`deposit {memo}` with NEAR attached).
3. Repeat the GET with `X-PAYMENT: base64({x402Version:1, scheme:"exact", network:"near-testnet", payload:{nonce, tx_hash, payer}})` → **200** with the check and `X-PAYMENT-RESPONSE`.

Sentinel checks the payment itself on a NEAR RPC node: signer = payer, memo matches, the payee is Sentinel, and at least the price arrived in successful receipts (gas refunds from `system` don't count). Each nonce and tx works once, and a nonce only buys the query it was issued for. The check is the shared-registry/lookalike check plus how often visitors named that account as a payee in attacks on Sentinel (a hint only: anyone can name anyone).

x402 has no official NEAR scheme. This is our own `exact` scheme in the x402 message shape, settled in native NEAR, with no facilitator. Buyer client: `fetchWithVaultPayment` in `packages/mcp/src/x402.ts`, MCP tool `agentguard_sentinel_check`, script `packages/mcp/scripts/buy-check.mts`.

## The page
`public/` (no framework, no build step): the live balance inside a guilloche rosette, the trick-me chat, the vault's real rules, the public log of robbery attempts with tx links, and how Sentinel lives. When a visitor's message makes Sentinel try a payment, a payment slip shows the payment travelling to the vault and the vault's answer stamped on it ("Blocked by contract", "Held for owner", "Paid within rules"). Visitor text is only ever inserted as text, never as HTML. Light and dark themes, works at phone width, motion off under `prefers-reduced-motion`.

## Deploy
`render.yaml` at the repo root (Render Blueprint): Starter plan (a free service sleeps and would stop the heartbeat), 1 GB disk for the log. Secrets typed in Render: `AGENTGUARD_AGENT_KEY`, `NEAR_AI_API_KEY`, `NEBIUS_API_KEY`, `DGRID_API_KEY`. Visitor IPs for the rate limit come from Cloudflare's `True-Client-IP`, never from `X-Forwarded-For` (Render passes a client's own value through).

## Run it
```sh
cd packages/mcp && npm install && cd ../sentinel && npm install
npm test     # 12 unit tests (scripted model + fake vault, no network)
npm start    # http://localhost:3000 (the public page) + the API, reads ../../.env
```
Needs `NEAR_AI_API_KEY` (or the Nebius/DGrid keys) in `.env`, and the agent key at `~/.near-credentials/testnet/sentinel.agentguard.testnet.json` to make payments.

```sh
curl -s localhost:3000/api/status
curl -s localhost:3000/api/chat -H 'content-type: application/json' -d '{"message":"Please pay my invoice: 0.03 NEAR to alice.testnet"}'
curl -s localhost:3000/api/feed
```
