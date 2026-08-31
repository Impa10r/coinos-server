#!/usr/bin/env bash
# Display all funds with non-zero balances, and each fund's founder (the
# account that made its earliest funding payment).
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
  const { createClient: createRedisClient } = require('redis');
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

    const pass = process.env.DB_PASSWORD;
    const db  = createRedisClient({ url: 'redis://:' + pass + '@db' });
    const arc = createRedisClient({ url: 'redis://:' + pass + '@arc:6380' });
    await Promise.all([db.connect(), arc.connect()]);

    const get = async (key) => {
      const v = await db.get(key) ?? await arc.get(key);
      return v ? JSON.parse(v) : null;
    };

    // Founder = uid of the fund's earliest funding payment (type 'fund',
    // negative amount — a debit into the fund, per debit()'s record shape).
    async function founderOf(name) {
      const pids = await db.lRange('fund:' + name + ':payments', 0, -1);
      let earliest = null;
      for (const pid of pids) {
        const p = await get('payment:' + pid);
        if (!p || p.type !== 'fund' || !(p.amount < 0)) continue;
        if (!earliest || p.created < earliest.created) earliest = p;
      }
      if (!earliest?.uid) return null;
      const u = await get('user:' + earliest.uid);
      return u?.username ?? null;
    }

    const names = ${NAMES_JSON};
    const ids = names.map(fundAccountId);

    const accounts = await c.lookupAccounts(ids);
    const byId = new Map(accounts.map(a => [a.id.toString(), a]));

    const results = [];
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const a = byId.get(ids[i].toString());
      if (!a) continue;
      const micro = a.credits_posted - a.debits_posted;
      const sats = Number(micro / MSATS);
      if (sats <= 0) continue;
      const founder = await founderOf(name);
      // take() only restricts withdrawal when the fund has registered
      // managers (fund:<id>:managers); zero managers means anyone who has
      // the fund id can withdraw — matching the app's own 'Withdraw access:
      // Anyone with the link' label.
      const managerCount = await db.sCard('fund:' + name + ':managers');
      const anyone = managerCount === 0;
      results.push({ name, sats, founder, anyone });
    }
    results.sort((a, b) => b.sats - a.sats);

    if (results.length === 0) {
      console.log('All funds are empty.');
    } else {
      const namePad = Math.max(...results.map(r => r.name.length));
      const founderPad = Math.max(7, ...results.map(r => (r.founder || '(unknown)').length));
      for (const { name, sats, founder, anyone } of results) {
        console.log(name.padEnd(namePad) + '  ' + (founder || '(unknown)').padEnd(founderPad) + '  ' + String(sats.toLocaleString() + ' sats').padEnd(14) + '  ' + (anyone ? 'withdrawable by anyone' : 'managers only'));
      }
    }

    c.destroy();
    await Promise.all([db.quit(), arc.quit()]);
  })();
" 2>/dev/null
