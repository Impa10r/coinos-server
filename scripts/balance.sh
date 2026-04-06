#!/usr/bin/env bash
# Usage: ./scripts/balance.sh <user-uuid>
# Looks up the current TigerBeetle balance for a user account.

set -euo pipefail

UUID="${1:?Usage: $0 <user-uuid>}"
INT=$(python3 -c "print(int('${UUID//-/}', 16))")

docker exec app bun -e "
const { createClient } = require('tigerbeetle-node');
const { lookup } = require('node:dns/promises');
(async () => {
  const { address: ip } = await lookup('tb');
  const c = createClient({ cluster_id: 0n, replica_addresses: [\`\${ip}:3000\`] });
  const MSATS = 1_000_000n;
  const id = ${INT}n;
  const [acct] = await c.lookupAccounts([id]);
  if (!acct) { console.error('Account not found: $UUID'); process.exit(1); }
  const micro = acct.credits_posted - acct.debits_posted;
  const sats = Number(micro / MSATS);
  console.log('Account: $UUID');
  console.log('Balance: ' + sats + ' sats');
  console.log('  credits_posted: ' + acct.credits_posted);
  console.log('  debits_posted:  ' + acct.debits_posted);
  console.log('  (microsats net): ' + micro);
  c.destroy();
})();
" 2>/dev/null
