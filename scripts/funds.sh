#!/usr/bin/env bash
# Display all funds with non-zero balances.
# Usage: ./scripts/funds.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
[ -f "$SCRIPT_DIR/../.env" ] && set -a && source "$SCRIPT_DIR/../.env" && set +a

# Collect all fund names from Redis (union of all user:*:funds sets)
FUND_NAMES=$(docker exec db valkey-cli -a "${DB_PASSWORD:?Set DB_PASSWORD in .env}" --no-auth-warning \
  EVAL "
    local keys = redis.call('KEYS', 'user:*:funds')
    local names = {}
    for _, k in ipairs(keys) do
      local members = redis.call('SMEMBERS', k)
      for _, m in ipairs(members) do
        names[m] = true
      end
    end
    local result = {}
    for name, _ in pairs(names) do
      table.insert(result, name)
    end
    return result
  " 0 2>/dev/null)

if [ -z "$FUND_NAMES" ]; then
  echo "No funds found."
  exit 0
fi

# Convert newline-separated names to a JSON array string for Bun
NAMES_JSON=$(echo "$FUND_NAMES" | python3 -c "
import sys, json
names = [l.strip() for l in sys.stdin if l.strip()]
print(json.dumps(names))
")

docker exec app bun -e "
  const { createClient } = require('tigerbeetle-node');
  const { lookup } = require('node:dns/promises');
  const { createHash } = require('crypto');

  const MSATS = 1_000_000n;
  const MASK128 = (1n << 128n) - 1n;

  function fundAccountId(name) {
    const hash = createHash('sha256').update('fund:' + name).digest('hex');
    return (BigInt('0x' + hash.slice(0, 32)) ^ (6n << 64n)) & MASK128;
  }

  (async () => {
    const { address: ip } = await lookup('tb');
    const c = createClient({ cluster_id: 0n, replica_addresses: [\`\${ip}:3000\`] });

    const names = ${NAMES_JSON};
    const ids = names.map(fundAccountId);

    const accounts = await c.lookupAccounts(ids);
    const byId = new Map(accounts.map(a => [a.id.toString(), a]));

    const results = names
      .map((name, i) => {
        const a = byId.get(ids[i].toString());
        if (!a) return null;
        const micro = a.credits_posted - a.debits_posted;
        const sats = Number(micro / MSATS);
        return { name, sats };
      })
      .filter(r => r && r.sats > 0)
      .sort((a, b) => b.sats - a.sats);

    if (results.length === 0) {
      console.log('All funds are empty.');
    } else {
      const pad = Math.max(...results.map(r => r.name.length));
      for (const { name, sats } of results) {
        console.log(name.padEnd(pad) + '  ' + sats.toLocaleString() + ' sats');
      }
    }

    c.destroy();
  })();
" 2>/dev/null
