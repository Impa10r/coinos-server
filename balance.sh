#!/usr/bin/env bash
# Usage: ./balance.sh <user-uuid>
# Looks up the current TigerBeetle balance for a user account.

set -euo pipefail

UUID="${1:?Usage: $0 <user-uuid>}"

# Convert UUID to 128-bit integer (same logic as uuidToBigInt in tb.ts)
HEX="${UUID//-/}"
ACCOUNT_ID=$(python3 -c "print(int('$HEX', 16))")

node --input-type=module <<EOF
import { createClient } from "tigerbeetle-node";

const clusterId = 0n;
const replicaAddresses = ["127.0.0.1:3001"];

const client = createClient({ cluster_id: clusterId, replica_addresses: replicaAddresses });

const uuid = "$UUID";
const hex = uuid.replace(/-/g, "");
const id = BigInt("0x" + hex);
const MSATS = 1_000_000n;

const accounts = await client.lookupAccounts([id]);
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
EOF
