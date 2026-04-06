#!/usr/bin/env bash
# Usage: ./scripts/balance.sh <user-uuid>
# Looks up the current TigerBeetle balance for a user account.

set -euo pipefail

UUID="${1:?Usage: $0 <user-uuid>}"

TMP=$(mktemp /tmp/balance.XXXXXX.mjs)
trap 'rm -f "$TMP"' EXIT

cat > "$TMP" <<'JSEOF'
import { createClient } from "tigerbeetle-node";
import { lookup } from "node:dns/promises";

const uuid = process.env.UUID;
const { address: tbIp } = await lookup("tb").catch(() => ({ address: "127.0.0.1" }));
const client = createClient({ cluster_id: 0n, replica_addresses: [`${tbIp}:3000`] });

const hex = uuid.replace(/-/g, "");
const id = BigInt("0x" + hex);
const MSATS = 1_000_000n;
const mask = (1n << 128n) - 1n;

const accounts = await client.lookupAccounts([id & mask]);
if (accounts.length === 0) {
  console.error("Account not found:", uuid);
  process.exit(1);
}

const acct = accounts[0];
const micro = BigInt(acct.credits_posted) - BigInt(acct.debits_posted);
const sats = Number(micro / MSATS);

console.log("Account:", uuid);
console.log("Balance: " + sats + " sats");
console.log("  credits_posted:", acct.credits_posted.toString());
console.log("  debits_posted: ", acct.debits_posted.toString());
console.log("  (microsats net):", micro.toString());

client.destroy();
JSEOF

docker cp "$TMP" app:/tmp/balance.mjs
docker exec -e UUID="$UUID" app bun run /tmp/balance.mjs
