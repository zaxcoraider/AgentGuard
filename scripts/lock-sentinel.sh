#!/usr/bin/env bash
# Locks Sentinel's vault for good, then proves on testnet that even its owner can't loosen it.
# IRREVERSIBLE: after lock_rules() nobody can change the policy or allowlist, add agent keys,
# approve held payments or withdraw. Anyone can still deposit; the owner can still pause, deny, revoke.
# Usage: bash scripts/lock-sentinel.sh   (signs as the owner, agentguard.testnet, from the near CLI keychain)
set -u
VAULT=sentinel.agentguard.testnet
OWNER=agentguard.testnet
NET="network-config testnet"

call() { # method json-args -> prints tx id or the contract's refusal
  near contract call-function as-transaction "$VAULT" "$1" json-args "$2" prepaid-gas '30 Tgas' attached-deposit '1 yoctoNEAR' \
    sign-as "$OWNER" $NET sign-with-keychain send 2>&1 | grep -oE "Transaction ID: [A-Za-z0-9]+|Smart contract panicked: [^\"]*" | head -1
}
view() { # read-only call via RPC; prints the JSON result on one line
  curl -s https://rpc.testnet.fastnear.com -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$VAULT\",\"method_name\":\"$1\",\"args_base64\":\"e30=\"}}" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(Buffer.from(JSON.parse(d).result.result).toString()))'
}

if [ "$(view is_locked)" = "true" ]; then echo "Already locked."; else
  echo "Locking $VAULT ..."; call lock_rules '{}'
fi
echo "is_locked: $(view is_locked)"
echo
echo "Owner tries to allowlist an attacker (must be refused):"
echo "  $(call add_to_allowlist '{"accounts":["agentguard-evil.testnet"]}')"
echo "Owner tries to withdraw 1 NEAR (must be refused):"
echo "  $(call withdraw '{"amount":"1000000000000000000000000"}')"
echo "Allowlist now: $(view get_allowlist)"
