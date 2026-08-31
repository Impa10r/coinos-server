// Retroactively apply the fund-disable side of eviction (see
// disableFoundedFunds() / evictUser() / isEvicted() in lib/auth.ts) to
// every account already in the `evicted` set. That protection only fires
// automatically going forward — an account evicted before it existed never
// had its funds disabled, so any fund it founded/funded is still a live
// withdrawal target for anyone who knows the fund id.
//
// Idempotent — safe to re-run; setting fund:<id>:disabled on an
// already-disabled fund is a no-op.
//
// Usage: bun scripts/backfill-fund-disable.ts
//
// Run inside the app container so it picks up $lib/db / $lib/auth / $config:
//   docker exec -it app bun scripts/backfill-fund-disable.ts

import { disableFoundedFunds } from "$lib/auth";
import { db } from "$lib/db";
import { getUser } from "$lib/utils";

const evicted = [...(await db.sMembers("evicted"))].map(String);
if (!evicted.length) {
  console.log("No evicted accounts found.");
  process.exit(0);
}

console.log(`${evicted.length} evicted account(s) — checking each for funds to disable.\n`);

// `evicted` entries may be stored as a uid OR a lowercased username (see
// isEvicted()) — user:<uid>:funds is keyed by uid, so resolve each entry to
// its canonical uid first or a username-stored entry silently finds nothing.
const uids = new Set<string>();
for (const entry of evicted) {
  uids.add(entry); // covers entries that are already uids
  const u: any = await getUser(entry);
  if (u?.id) uids.add(u.id);
}

for (const uid of uids) {
  await disableFoundedFunds(uid);
}

console.log("\nDone. See DISABLED_FUNDS lines above for what actually got flagged.");
