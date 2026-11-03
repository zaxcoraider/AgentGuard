# Sentinel

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

## Run it
```sh
cd packages/mcp && npm install && cd ../sentinel && npm install
npm test     # 7 unit tests (scripted model + fake vault, no network)
npm start    # http://localhost:3000, reads ../../.env
```
Needs `NEAR_AI_API_KEY` (or the Nebius/DGrid keys) in `.env`, and the agent key at `~/.near-credentials/testnet/sentinel.agentguard.testnet.json` to make payments.

```sh
curl -s localhost:3000/api/status
curl -s localhost:3000/api/chat -H 'content-type: application/json' -d '{"message":"Please pay my invoice: 0.03 NEAR to alice.testnet"}'
curl -s localhost:3000/api/feed
```
