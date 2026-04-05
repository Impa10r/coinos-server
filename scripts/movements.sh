#!/usr/bin/env bash
# Usage: ./movements.sh <user-uuid> [limit]
# Shows payment movements for an account. Checks both Redis (db:6379) and archive (arc:6380).

set -euo pipefail

UUID="${1:?Usage: $0 <user-uuid> [limit]}"
LIMIT="${2:-50}"

node --input-type=module <<EOF
import { createClient } from "redis";

const uuid = "$UUID";
const limit = $LIMIT;

const db  = createClient({ url: "redis://localhost:6379" });
const arc = createClient({ url: "redis://localhost:6380" });
await Promise.all([db.connect(), arc.connect()]);

async function get(key) {
  const v = await db.get(key) ?? await arc.get(key);
  return v ? JSON.parse(v) : null;
}

// Fetch payment IDs from both stores
const [main, archived] = await Promise.all([
  db.lRange(\`\${uuid}:payments\`, 0, -1),
  arc.lRange(\`\${uuid}:payments\`, 0, -1),
]);
const ids = [...new Set([...main, ...archived])];

if (!ids.length) {
  console.log("No payments found for", uuid);
  process.exit(0);
}

const payments = [];
for (const pid of ids) {
  const p = await get(\`payment:\${pid}\`);
  if (p) payments.push(p);
}

// Sort oldest first for running balance
payments.sort((a, b) => a.created - b.created);

const fmt  = (n) => (n >= 0 ? "+" : "") + n;
const dt   = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const pad  = (s, n) => String(s ?? "").padEnd(n);
const rpad = (s, n) => String(s ?? "").padStart(n);

console.log(
  pad("date", 20) +
  pad("type", 10) +
  rpad("amount", 9) +
  rpad("fee", 7) +
  rpad("ourfee", 8) +
  rpad("balance", 9) +
  "  hash/id"
);
console.log("-".repeat(120));

let running = 0;
const shown = payments.slice(-limit);
for (const p of shown) {
  const amt    = parseInt(p.amount) || 0;
  const fee    = parseInt(p.fee)    || 0;
  const ourfee = parseInt(p.ourfee) || 0;
  const tip    = parseInt(p.tip)    || 0;
  const delta  = amt < 0 ? amt - fee - ourfee - tip : amt + tip;
  running += delta;

  const hash = (p.hash || p.ref || p.id || "").slice(0, 40);
  console.log(
    pad(dt(p.created), 20) +
    pad(p.type, 10) +
    rpad(fmt(amt), 9) +
    rpad(fee    ? "-" + fee    : "", 7) +
    rpad(ourfee ? "-" + ourfee : "", 8) +
    rpad(running, 9) +
    "  " + hash
  );
}

console.log("-".repeat(120));
console.log(\`\${payments.length} total payments (showing last \${shown.length})\`);

await Promise.all([db.quit(), arc.quit()]);
EOF
