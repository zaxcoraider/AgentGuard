#!/usr/bin/env node
// Generate an ed25519 key pair for an AgentGuard agent and save it where the
// near CLI's legacy keychain looks: ~/.near-credentials/<network>/<vault>.json
// Prints ONLY the public key. The private key never leaves that file.
//
// Usage: node scripts/gen-agent-key.mjs <vault-account-id> [testnet|mainnet]
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [vault, network = "testnet"] = process.argv.slice(2);
if (!vault) {
  console.error("usage: node scripts/gen-agent-key.mjs <vault-account-id> [testnet|mainnet]");
  process.exit(1);
}

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(bytes) {
  let n = BigInt("0x" + (Buffer.from(bytes).toString("hex") || "0"));
  let out = "";
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ format: "jwk" }).x;
const seed = privateKey.export({ format: "jwk" }).d;
const pubBytes = Buffer.from(pub, "base64url");
const seedBytes = Buffer.from(seed, "base64url");

const public_key = "ed25519:" + base58(pubBytes);
// NEAR's secret key format is base58(seed || public key), 64 bytes.
const private_key = "ed25519:" + base58(Buffer.concat([seedBytes, pubBytes]));

const dir = join(homedir(), ".near-credentials", network);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const file = join(dir, `${vault}.json`);
if (existsSync(file)) {
  console.error(`Refusing to overwrite existing key file ${file}`);
  process.exit(1);
}
writeFileSync(file, JSON.stringify({ account_id: vault, public_key, private_key }, null, 2) + "\n", { mode: 0o600 });
console.log(public_key);
