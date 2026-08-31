// List (and optionally clear) every UNCLAIMED authorization on a fund.
// take() opportunistically claims the first unclaimed authorization it
// finds on the target fund before doing the caller's actual requested
// withdrawal — that claim debits the AUTHORIZATION'S OWN CREATOR (not the
// caller), so a stale/unrelated authorization left on a fund can abort an
// otherwise-legitimate /take call (e.g. the creator being frozen/evicted,
// or the global freeze flag being on) before the real withdrawal ever runs.
//
// Read-only by default. Pass --apply to actually delete every unclaimed
// authorization found (fund:<id>:authorizations entry + the
// authorization:<id> record) — safe: an authorization only reserves a
// future funding claim, it never held or moved money on its own.
//
// Usage:
//   bun scripts/clear-fund-authorizations.ts <fund-id>
//   bun scripts/clear-fund-authorizations.ts <fund-id> --apply
//
// Run inside the app container so it picks up $lib/db / $config:
//   docker exec -it app bun scripts/clear-fund-authorizations.ts <fund-id> --apply

import { db } from "$lib/db";
import { getUser } from "$lib/utils";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const fundId = argv.find((a) => !a.startsWith("--"));

if (!fundId) {
  console.error("usage: bun scripts/clear-fund-authorizations.ts <fund-id> [--apply]");
  process.exit(1);
}

const authIds = (await db.lRange(`fund:${fundId}:authorizations`, 0, -1)) || [];
if (!authIds.length) {
  console.log(`No authorizations recorded on fund ${fundId}.`);
  process.exit(0);
}

const rows: any[] = [];
for (const authId of authIds) {
  const a: any = await db.get(`authorization:${authId}`);
  const auth = a ? JSON.parse(a) : null;
  if (!auth || auth.claimed) continue;
  const creator: any = await getUser(auth.uid);
  rows.push({ authId, auth, creator });
}

if (!rows.length) {
  console.log(`${authIds.length} authorization(s) on fund ${fundId}, all already claimed — nothing blocking.`);
  process.exit(0);
}

console.log(`${rows.length} unclaimed authorization(s) on fund ${fundId}:\n`);
for (const { authId, auth, creator } of rows) {
  console.log(
    `  ${authId}  created by ${creator?.username ?? auth.uid}  fiat=${auth.fiat} ${auth.currency}  amount=${auth.amount}`,
  );
}

if (!apply) {
  console.log(`\nDry run — nothing deleted. Re-run with --apply to delete all ${rows.length} above.`);
  process.exit(0);
}

for (const { authId } of rows) {
  await db.lRem(`fund:${fundId}:authorizations`, 0, authId);
  await db.del(`authorization:${authId}`);
  console.log(`DELETED ${authId}`);
}
console.log(`\nDone — cleared ${rows.length} unclaimed authorization(s) from fund ${fundId}.`);
