#!/usr/bin/env bash
# Freezes the shared scam registry's code for good: deletes the last full-access key of
# registry.agentguard.testnet. After this nobody (us included) can redeploy or change its code.
# IRREVERSIBLE. What keeps working: reports, flags, and curator review by agentguard.testnet
# (which has its own key). What stops for good: the registry admin (the registry account itself)
# can no longer add or remove curators. The contract has no self-upgrade method, so the code is
# frozen once the key is gone.
# Usage: bash scripts/freeze-registry.sh   (signs as the registry from the near CLI keychain)
set -u
REG=registry.agentguard.testnet
NET="network-config testnet"
RPC=https://rpc.testnet.fastnear.com

rpc() { curl -s "$RPC" -H 'content-type: application/json' -d "$1"; }
keys() {
  rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$REG\"}}" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const k=JSON.parse(d).result.keys;console.log(k.map(x=>x.public_key+" ("+(x.access_key.permission==="FullAccess"?"full access":"limited")+")").join(", ")||"none")})'
}
code_hash() {
  rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_account\",\"finality\":\"final\",\"account_id\":\"$REG\"}}" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(JSON.parse(d).result.code_hash))'
}
view() { # method, base64 args
  rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$REG\",\"method_name\":\"$1\",\"args_base64\":\"$2\"}}" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>console.log(Buffer.from(JSON.parse(d).result.result).toString()))'
}

echo "Registry:  $REG"
echo "Code hash: $(code_hash)"
echo "Keys now:  $(keys)"
echo "Curators:  $(view get_curators e30=)"
echo
KEY=$(rpc "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"query\",\"params\":{\"request_type\":\"view_access_key_list\",\"finality\":\"final\",\"account_id\":\"$REG\"}}" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const k=JSON.parse(d).result.keys.filter(x=>x.access_key.permission==="FullAccess");console.log(k.map(x=>x.public_key).join(","))})')
if [ -z "$KEY" ]; then echo "No full-access key left: already frozen."; exit 0; fi

echo "This deletes $KEY from $REG. It can NEVER be undone."
printf 'Type FREEZE to continue: '
read -r answer
[ "$answer" = "FREEZE" ] || { echo "Stopped. Nothing changed."; exit 1; }

near account delete-keys "$REG" public-keys "$KEY" $NET sign-with-keychain send 2>&1 \
  | grep -oE "Transaction ID: [A-Za-z0-9]+|Error.*" | head -3
sleep 3
echo
echo "After:"
echo "Keys now:  $(keys)"
echo "Code hash: $(code_hash)   (same as before)"
echo "Curators:  $(view get_curators e30=)"
echo "Registry still answers: agentguard-evil.testnet -> $(view get_status "$(printf '{"account":"agentguard-evil.testnet"}' | base64)")"
