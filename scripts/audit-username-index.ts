// Find accounts whose username -> uid pointer is missing, and optionally
// rebuild it.
//
// Every account is stored twice: the record at `user:<uid>` (JSON, carries
// .username) and a pointer at `user:<username>` holding the uid. Login,
// lnurl/lightning-address resolution, `uid <name>`, contacts lookup and
// "username taken" checks all go through the POINTER. If it goes missing the
// record still works for anyone holding a session token (payments keep
// flowing, the app looks normal) but the account is unreachable by name and
// its owner can never log in again with a password.
//
// Known cause: the username-change path in routes/users.ts used to `db.del`
// the OLD pointer up front and only write the new one ~70 lines later, at the
// end of the handler. Anything throwing in between (bad `destination`, a
// password-hash failure, a dropped connection) left the account with NO
// pointer at all, since the record kept whichever username was current. Fixed
// by deferring that del until after the write — this script repairs accounts
// orphaned before the fix.
//
// A pointer that exists but points at a DIFFERENT uid is reported separately
// and never touched: that's a name genuinely owned by another account, and
// rewriting it would hand one user's address to another.
//
// Read-only by default. Pass --apply to write the missing pointers.
//
// Usage (inside the app container, for $lib/db / $config):
//   docker exec -it app bun scripts/audit-username-index.ts
//   docker exec -it app bun scripts/audit-username-index.ts --apply

import { db, g, scan } from "$lib/db";

const apply = process.argv.includes("--apply");

const isUid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s);
const norm = (s: string) => s.replace(/\s/g, "").toLowerCase();

let records = 0;
const missing: { uid: string; name: string; bal: number }[] = [];
const conflict: { uid: string; name: string; owner: string }[] = [];
const nameless: string[] = [];

for await (const key of scan("user:*")) {
  const uid = String(key).slice("user:".length);
  if (!isUid(uid)) continue; // pointer key (username or pubkey), not a record
  records++;

  const user = await g(key as string);
  if (!user || typeof user === "string") continue;
  if (!user.username) {
    nameless.push(uid);
    continue;
  }

  const name = norm(String(user.username));
  const pointer = await db.get(`user:${name}`);

  if (pointer === uid) continue;

  if (pointer) {
    conflict.push({ uid, name, owner: String(pointer) });
    continue;
  }

  const bal = Number(await db.get(`balance:${uid}`)) || 0;
  missing.push({ uid, name, bal });

  if (apply) await db.set(`user:${name}`, uid);
}

console.log(`scanned ${records} account records`);

if (nameless.length) {
  console.log(`\n${nameless.length} record(s) with no username at all (not repairable here):`);
  for (const uid of nameless.slice(0, 20)) console.log(`  ${uid}`);
}

if (conflict.length) {
  console.log(`\n${conflict.length} record(s) whose name is held by ANOTHER uid — NOT touched:`);
  for (const c of conflict) console.log(`  ${c.name.padEnd(26)} record ${c.uid}  pointer -> ${c.owner}`);
}

if (!missing.length) {
  console.log("\nno missing username pointers");
} else {
  console.log(`\n${missing.length} account(s) with a MISSING username pointer${apply ? " (repaired)" : ""}:`);
  for (const m of missing)
    console.log(`  ${m.name.padEnd(26)} ${String(m.bal).padStart(12)} sats  ${m.uid}`);
  if (!apply) console.log("\nrerun with --apply to write these pointers");
}

process.exit(0);
