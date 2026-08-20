// Full incident-response revocation: delete every app:<pubkey> NWC
// connection record (both the primary store and the archive fallback) and
// drop it from its owner's <uid>:apps set. Unlike purge-app-secrets.ts
// (which only strips the secret field), this makes the connection's pubkey
// unrecognized by lib/nwc.ts — g(`app:${pubkey}`) returns null and the
// request fails with "pubkey not found" — so a secret an attacker already
// holds can no longer authenticate at all, regardless of the stored secret
// field. Users must create fresh connections afterward.
//
// Authorized incident response only — irreversible. Defaults to dry-run.
//
// Usage:
//   bun scripts/revoke-all-apps.ts            # dry-run
//   bun scripts/revoke-all-apps.ts --confirm  # actually revoke everything
//
// Run inside the app container so it picks up $lib/db config:
//   docker exec -it app bun scripts/revoke-all-apps.ts --confirm

import { archive, db, g, ga } from "$lib/db";

const dryRun = !process.argv.includes("--confirm");

async function collect(client: typeof db, get: (k: string) => Promise<any>) {
  const apps: { key: string; uid?: string; pubkey?: string }[] = [];
  for await (const batch of client.scanIterator({ MATCH: "app:*" })) {
    for (const key of batch as unknown as string[]) {
      let app: any;
      try {
        app = await get(key);
      } catch (e: any) {
        console.error(`  FAILED to read ${key}: ${e.message}`);
        continue;
      }
      if (!app || typeof app !== "object") continue;
      apps.push({ key, uid: app.uid, pubkey: app.pubkey });
    }
  }
  return apps;
}

console.log("scanning db (primary)...");
const dbApps = await collect(db, g);
console.log("scanning arc (archive)...");
const arcApps = await collect(archive, ga);

const byKey = new Map<string, { uid?: string; pubkey?: string }>();
for (const a of [...dbApps, ...arcApps]) byKey.set(a.key, a);

console.log(
  `\nfound ${byKey.size} unique app records (db=${dbApps.length}, arc=${arcApps.length})`,
);

if (dryRun) {
  for (const [key, a] of byKey) console.log(`  would revoke ${key} uid=${a.uid ?? "?"}`);
  console.log("\nDRY RUN — nothing revoked. Re-run with --confirm to revoke everything.");
  process.exit(0);
}

console.log("\nrevoking…");

let revoked = 0;
for (const [key, a] of byKey) {
  try {
    const m = db.multi().del(key);
    if (a.uid && a.pubkey) m.sRem(`${a.uid}:apps`, a.pubkey);
    await m.exec();
    await archive.del(key);
    revoked++;
  } catch (e: any) {
    console.error(`  FAILED to revoke ${key}: ${e.message}`);
  }
}

console.log(`\ndone — ${revoked} of ${byKey.size} connections revoked`);
console.log("Affected users will see an empty connection list and must reconnect.");
process.exit(0);
