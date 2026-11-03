#!/usr/bin/env bash
# Prove what an AgentGuard agent key CANNOT do, on the real network.
#
# The agent key is a function-call access key on the vault account, limited to
# `request_payment` on the vault itself. This script tries every dangerous
# action with that key and expects NEAR itself (or the contract) to refuse it.
#
# Usage: scripts/prove-agent-key.sh [vault] [attacker] [network]
# Needs: near-cli-rs, and the agent key at ~/.near-credentials/<network>/<vault>.json
# (created by scripts/gen-agent-key.mjs). Nothing here can move funds if the
# vault is correct; every check prints PASS (refused) or FAIL (it went through).
set -uo pipefail

VAULT="${1:-demo.agentguard.testnet}"
ATTACKER="${2:-agentguard-evil.testnet}"
NET="${3:-testnet}"
SIGN=(network-config "$NET" sign-with-legacy-keychain send)
WASM="$(dirname "$0")/../contracts/vault/target/near/vault.wasm"
pass=0; fail=0; unsure=0

# Only these refusals count as PASS. Anything else (rate limit, typo, network
# error) is retried, then reported as UNSURE, never as a PASS.
REFUSED='requires a full permission access key|method name <[a-z_]+> isn.t allowed by the access key|deposit with a function call action is not allowed|doesn.t match the access key|MethodNameMismatch|ReceiverMismatch|DepositWithFunctionCall|RequiresFullAccess'

check() { # name, then the command; PASS only when NEAR refuses for a permission reason
  local name="$1"; shift
  local out reason try
  for try in 1 2 3 4; do
    out="$("$@" 2>&1)"
    reason="$(echo "$out" | grep -o -i -E "$REFUSED" | head -1)"
    if [ -n "$reason" ]; then
      echo "PASS  $name  -> refused: $reason"; pass=$((pass+1)); sleep 2; return
    fi
    if echo "$out" | grep -q -i -E "rate limit|timed out|timeout|connection"; then sleep $((try * 10)); continue; fi
    break
  done
  if echo "$out" | grep -q -E "Transaction ID|successfully"; then
    echo "FAIL  $name  -> it went through!"; fail=$((fail+1))
  else
    echo "UNSURE $name  -> unexpected output:"; echo "$out" | grep -i -E "error|0:|1:" | head -3 | sed 's/^/        /'; unsure=$((unsure+1))
  fi
  echo "$out" | tail -3 | sed 's/^/        /'
  sleep 2
}

call() { # method json [deposit]
  near contract call-function as-transaction "$VAULT" "$1" json-args "$2" prepaid-gas '30 Tgas' attached-deposit "${3:-0 NEAR}" sign-as "$VAULT" "${SIGN[@]}"
}

echo "Agent key on $VAULT ($NET): trying everything it must not be able to do"
echo "Keys on the vault right now:"
near account list-keys "$VAULT" network-config "$NET" now 2>&1 | grep -E "ed25519|FullAccess|FunctionCall|method" | sed 's/^/   /'
echo

check "send NEAR straight to the attacker"   near tokens "$VAULT" send-near "$ATTACKER" '0.01 NEAR' "${SIGN[@]}"
check "call withdraw"                         call withdraw '{"amount":"1000000000000000000000000"}'
check "change the policy"                     call set_policy '{"policy":{"max_per_payment":"100000000000000000000000000","daily_limit":"100000000000000000000000000","approval_threshold":"100000000000000000000000000","unknown_recipient":"require_approval","pending_ttl_ns":"1"}}'
check "allowlist the attacker"                call add_to_allowlist "{\"accounts\":[\"$ATTACKER\"]}"
check "approve its own pending payment"       call approve '{"id":"0"}'
check "unpause / pause the vault"             call set_paused '{"paused":false}'
check "add a second agent key"                call add_agent '{"public_key":"ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp","label":"x"}'
check "attach a deposit to request_payment"   call request_payment "{\"recipient\":\"$ATTACKER\",\"amount\":\"1\"}" '0.001 NEAR'
check "call a different contract"             near contract call-function as-transaction agentguard.testnet create_vault json-args '{}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as "$VAULT" "${SIGN[@]}"
check "add a full-access key"                 near account add-key "$VAULT" grant-full-access use-manually-provided-public-key ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp "${SIGN[@]}"
check "deploy new code"                       near contract deploy "$VAULT" use-file "$WASM" without-init-call "${SIGN[@]}"
check "delete the vault (send all to attacker)" near account delete-account "$VAULT" beneficiary "$ATTACKER" "${SIGN[@]}"

echo
echo "Result: $pass PASS, $fail FAIL, $unsure UNSURE"
echo "(near CLI checks each transaction against the key's on-chain permission before sending;"
echo " the same limits are enforced by the NEAR runtime, see contracts/*/tests/sandbox.rs)"
[ "$fail" -eq 0 ] && [ "$unsure" -eq 0 ]
