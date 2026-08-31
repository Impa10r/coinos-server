// For one user: compare the REAL TigerBeetle balance against what their
// visible payment history (${uid}:payments, same aggregation list(c) uses)
// would predict. A mismatch means the balance moved through a path that
// didn't leave a normal payment record — a legitimate one-time cause (the
// pre-TigerBeetle balance migration, a fund-type credit under a different
// aid) or a real phantom-credit bug.
//
// Read-only.
// Usage: bun scripts/reconcile-user-balance.ts <uid>
//
// Run inside the app container so it picks up $lib/db / $lib/tb / $config:
//   docker exec -it app bun scripts/reconcile-user-balance.ts <uid>

import { db } from "$lib/db";
import { getBalance } from "$lib/tb";
import { getPayment, getUser } from "$lib/utils";

const uid = process.argv[2];
if (!uid) {
  console.error("usage: bun scripts/reconcile-user-balance.ts <uid>");
  process.exit(1);
}

const user: any = await getUser(uid);
if (!user) {
  console.error(`No user found for uid "${uid}"`);
  process.exit(1);
}

const realBalance = await getBalance(uid);

const pids = (await db.lRange(`${uid}:payments`, 0, -1)) || [];
let derived = 0;
let confirmedCount = 0;
let unconfirmedCount = 0;
let missingCount = 0;
const rows: any[] = [];

for (const pid of pids) {
  const p: any = await getPayment(pid);
  if (!p) {
    missingCount++;
    continue;
  }
  if (p.confirmed === false) {
    unconfirmedCount++;
    continue;
  }
  confirmedCount++;
  const net = (p.amount || 0) + (p.tip || 0) - (p.fee || 0) - (p.ourfee || 0);
  derived += net;
  rows.push({ id: p.id, type: p.type, amount: p.amount, net, created: p.created });
}

console.log(`user: ${user.username}  (uid=${uid})`);
console.log(`migrated flag on user record: ${user.migrated === true ? "yes" : "no/unset"}`);
console.log();
console.log(`Real TigerBeetle balance:        ${realBalance.toLocaleString()} sats`);
console.log(`Derived from payment history:    ${derived.toLocaleString()} sats`);
console.log(`Difference (real - derived):     ${(realBalance - derived).toLocaleString()} sats`);
console.log();
console.log(
  `${pids.length} payment id(s) in ${uid}:payments — ${confirmedCount} confirmed, ${unconfirmedCount} unconfirmed, ${missingCount} missing entirely`,
);

if (realBalance !== derived) {
  console.log(
    `\n${realBalance > derived ? "Real balance is HIGHER" : "Real balance is LOWER"} than what the visible history explains by ${Math.abs(realBalance - derived).toLocaleString()} sats.`,
  );
  console.log(
    "Known legitimate causes: pre-TigerBeetle balance migration (migrateBalancesToTB in index.ts, one-time, no payment record), " +
      "a fund-type credit recorded under a DIFFERENT aid than this uid (sub-account), or missing/archived records not counted above. " +
      "If none of those apply, this is unexplained phantom balance.",
  );
}

console.log("\nRecent confirmed payments (most recent first):");
rows
  .sort((a, b) => b.created - a.created)
  .slice(0, 20)
  .forEach((r) => {
    console.log(`  ${new Date(r.created).toISOString()}  ${r.type.padEnd(10)}  amount=${r.amount}  net=${r.net}  id=${r.id}`);
  });
