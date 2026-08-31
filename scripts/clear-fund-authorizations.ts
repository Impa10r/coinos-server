// List (and optionally clear) every UNCLAIMED authorization, either on one
// fund or across every fund this app has a record of. take() opportunistically
// claims the first unclaimed authorization it finds on the target fund
// before doing the caller's actual requested withdrawal — that claim debits
// the AUTHORIZATION'S OWN CREATOR (not the caller), so a stale/unrelated
// authorization left on a fund can abort an otherwise-legitimate /take call
// (e.g. the creator being frozen/evicted, or the global freeze flag being
// on) before the real withdrawal ever runs.
//
// Read-only by default. Pass --apply to actually delete every unclaimed
// authorization found (fund:<id>:authorizations entry + the
// authorization:<id> record) — safe: an authorization only reserves a
// future funding claim, it never held or moved money on its own.
//
// Usage:
//   bun scripts/clear-fund-authorizations.ts <fund-id>            # one fund
//   bun scripts/clear-fund-authorizations.ts <fund-id> --apply
//   bun scripts/clear-fund-authorizations.ts --all                # every fund
//   bun scripts/clear-fund-authorizations.ts --all --apply
//
// Run inside the app container so it picks up $lib/db / $config:
//   docker exec -it app bun scripts/clear-fund-authorizations.ts --all

import { db, scan } from "$lib/db";
import { getUser } from "$lib/utils";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const all = argv.includes("--all");
const fundId = argv.find((a) => !a.startsWith("--"));

if (!all && !fundId) {
  console.error("usage: bun scripts/clear-fund-authorizations.ts <fund-id> [--apply]");
  console.error("       bun scripts/clear-fund-authorizations.ts --all [--apply]");
  process.exit(1);
}

// Same fund-id enumeration as scripts/audit-fund-names.ts.
async function allFundIds(): Promise<string[]> {
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
  return [...ids];
}

const fundIds = all ? await allFundIds() : [fundId as string];

let totalFound = 0;
let totalCleared = 0;

for (const id of fundIds) {
  const authIds = (await db.lRange(`fund:${id}:authorizations`, 0, -1)) || [];
  if (!authIds.length) continue;

  const rows: any[] = [];
  for (const authId of authIds) {
    const a: any = await db.get(`authorization:${authId}`);
    const auth = a ? JSON.parse(a) : null;
    if (!auth || auth.claimed) continue;
    const creator: any = await getUser(auth.uid);
    rows.push({ authId, auth, creator });
  }
  if (!rows.length) continue;

  totalFound += rows.length;
  console.log(`fund ${id} — ${rows.length} unclaimed authorization(s):`);
  for (const { authId, auth, creator } of rows) {
    console.log(
      `  ${authId}  created by ${creator?.username ?? auth.uid}  fiat=${auth.fiat} ${auth.currency}  amount=${auth.amount}`,
    );
  }

  if (apply) {
    for (const { authId } of rows) {
      await db.lRem(`fund:${id}:authorizations`, 0, authId);
      await db.del(`authorization:${authId}`);
      totalCleared++;
    }
    console.log(`  cleared.`);
  }
  console.log();
}

if (!totalFound) {
  console.log(all ? "No unclaimed authorizations found on any fund." : `No authorizations recorded on fund ${fundId}.`);
} else if (!apply) {
  console.log(`Dry run — ${totalFound} unclaimed authorization(s) found, nothing deleted. Re-run with --apply to clear them.`);
} else {
  console.log(`Done — cleared ${totalCleared} unclaimed authorization(s).`);
}
