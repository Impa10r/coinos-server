// Rename every non-UUID (guessable/human-typed) fund to a fresh random
// UUID. Fund ids double as unguessable capability tokens (see the UUID
// check on new-fund creation in routes/payments.ts) — a fund created
// before that check existed can still be drained by anyone who knows or
// guesses its old, short/human-readable id. This retires the old id:
// moves its full TigerBeetle balance to a new UUID-named fund account,
// copies its managers/payments/authorizations bookkeeping, records
// fund:rotated:<old> -> new (the mapping GET /fund/:id already knows how
// to follow for an authenticated manager — see fund() in
// routes/payments.ts), and updates every manager's user:<uid>:funds set.
//
// The old fund's TigerBeetle account is drained to 0, not deleted (there
// is no "delete account" operation in TigerBeetle) — getFundBalance(old)
// then returns 0, not null, so GET /fund/:old's automatic null-triggered
// redirect to the new id won't fire on its own; fund:rotated:<old> is
// still recorded for reference. The security property that actually
// matters — the old id can no longer be used to extract money — holds
// regardless of whether that auto-redirect fires.
//
// Read-only by default (lists what WOULD be renamed, matching
// scripts/audit-fund-names.ts's enumeration). Pass --apply to perform the
// migration for every flagged fund, or --apply <old-fund-id> for just one.
//
// Run inside the app container so it picks up $lib/db / $lib/tb / $config:
//   docker exec -it app bun scripts/rotate-weird-fund-names.ts
//   docker exec -it app bun scripts/rotate-weird-fund-names.ts --apply
//   docker exec -it app bun scripts/rotate-weird-fund-names.ts --apply <old-fund-id>

import { randomUUID } from "crypto";
import { db, scan } from "$lib/db";
import { getFundBalance, initTigerBeetle, tbFundCredit, tbFundDebit } from "$lib/tb";
import { validate as isUuid } from "uuid";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const only = argv.find((a) => !a.startsWith("--"));

await initTigerBeetle();

// Same enumeration as scripts/audit-fund-names.ts.
const ids = new Set<string>();
for (const pattern of ["fund:*:managers", "fund:*:payments", "fund:*:authorizations"]) {
  const suffix = pattern.split(":").pop();
  for await (const key of scan(pattern)) {
    const keyStr = String(key);
    const id = keyStr.slice("fund:".length, keyStr.length - `:${suffix}`.length);
    if (id) ids.add(id);
  }
}
for await (const key of scan("user:*:funds")) {
  const members = await db.sMembers(key);
  for (const id of members) ids.add(String(id));
}

let targets = [...ids].filter((id) => !isUuid(id));
if (only) targets = targets.filter((id) => id === only);

if (!targets.length) {
  console.log(
    only ? `"${only}" is not a flagged non-UUID fund.` : "No non-UUID funds found — nothing to rotate.",
  );
  process.exit(0);
}

console.log(`${targets.length} non-UUID fund(s) ${apply ? "will be" : "would be"} rotated:\n`);

for (const oldId of targets) {
  const balance = (await getFundBalance(oldId)) ?? 0;
  const newId = randomUUID();
  console.log(`  ${oldId}  (balance=${balance})  ->  ${newId}`);

  if (!apply) continue;

  const [managersRaw, payments, authorizations] = await Promise.all([
    db.sMembers(`fund:${oldId}:managers`),
    db.lRange(`fund:${oldId}:payments`, 0, -1),
    db.lRange(`fund:${oldId}:authorizations`, 0, -1),
  ]);
  const managers = [...managersRaw].map(String);

  if (managers.length) await db.sAdd(`fund:${newId}:managers`, managers);
  if (payments.length) await db.rPush(`fund:${newId}:payments`, payments);
  if (authorizations.length) await db.rPush(`fund:${newId}:authorizations`, authorizations);

  if (balance > 0) {
    const debited = await tbFundDebit(oldId, balance, "rotation: failed to drain old fund");
    if (debited?.err) {
      console.error(`  FAILED to drain ${oldId}: ${debited.err} — skipping this fund, no changes applied to it.`);
      continue;
    }
    await tbFundCredit(newId, balance);
  }

  await db.set(`fund:rotated:${oldId}`, newId);

  for (const uid of managers) {
    await Promise.all([db.sRem(`user:${uid}:funds`, oldId), db.sAdd(`user:${uid}:funds`, newId)]);
  }

  console.log(`  done: ${oldId} -> ${newId}  (${managers.length} manager(s) updated, balance moved: ${balance})`);
}

if (!apply) {
  console.log(
    `\nDry run — no changes made. Re-run with --apply to migrate all ${targets.length} fund(s) above (or --apply <old-id> for just one).`,
  );
}
