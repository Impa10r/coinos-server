// Delete one or more users by username.
// Authorized cleanup only — destructive. Defaults to dry-run.
//
// Usage:
//   bun scripts/delete-user.ts <username> [<username> …]            # dry-run
//   bun scripts/delete-user.ts <username> [<username> …] --confirm   # actually delete
//
// Mirrors users.deleteUser scope: removes user:<id>, user:<username>,
// user:<pubkey>, account:<id>, <id>:accounts, <id>:apps, follows/followers
// counters, and all app:<key> entries.
//
// Does NOT touch <id>:payments, <id>:invoices, or TigerBeetle balance
// accounts. Run inside the app container so it picks up $lib/db config:
//   docker exec -it app bun scripts/delete-user.ts alice bob --confirm

import { db } from "$lib/db";

const argv = process.argv.slice(2);
const dryRun = !argv.includes("--confirm");
const usernames = argv.filter((a) => !a.startsWith("--")).map((u) => u.toLowerCase().trim());

if (usernames.length === 0) {
  console.error("Usage: bun scripts/delete-user.ts <username> [<username> …] [--confirm]");
  process.exit(1);
}

const candidates: {
  username: string;
  uid: string | null;
  pubkey: string | null;
  appKeys: string[];
}[] = [];

for (const username of usernames) {
  const uidRaw = await db.get(`user:${username}`);
  if (!uidRaw) {
    console.log(`  ${username}: NOT FOUND`);
    continue;
  }
  // user:<username> stores the uid JSON-stringified, so it comes back quoted.
  let uid: string;
  try {
    uid = JSON.parse(String(uidRaw));
  } catch {
    uid = String(uidRaw);
  }
  const raw = await db.get(`user:${uid}`);
  const u = raw ? JSON.parse(String(raw)) : null;
  const appKeys = [...(await db.sMembers(`${uid}:apps`))].map(String);
  candidates.push({
    username,
    uid,
    pubkey: u?.pubkey ?? null,
    appKeys,
  });
  console.log(`  ${username}: uid=${uid} pubkey=${u?.pubkey ?? "(none)"} apps=${appKeys.length}`);
}

if (candidates.length === 0) {
  console.log("\nNo users to delete.");
  process.exit(0);
}

if (dryRun) {
  console.log("\nDRY RUN — no users deleted. Re-run with --confirm to delete.");
  process.exit(0);
}

console.log("\ndeleting…");

let deleted = 0;
for (const c of candidates) {
  try {
    const m = db.multi();
    for (const k of c.appKeys) m.del(`app:${k}`);

    m.del(`user:${c.username}`)
      .del(`user:${c.uid}`)
      .del(`account:${c.uid}`)
      .del(`${c.uid}:accounts`)
      .del(`${c.uid}:apps`);

    if (c.pubkey) {
      m.del(`user:${c.pubkey}`)
        .del(`${c.pubkey}:follows:n`)
        .del(`${c.pubkey}:followers:n`)
        .del(`${c.pubkey}:pubkeys`);
    }

    await m.exec();
    deleted++;
    console.log(`  deleted ${c.username}`);
  } catch (e: any) {
    console.error(`  FAILED ${c.username}: ${e.message}`);
  }
}

console.log(`\ndone — ${deleted} of ${candidates.length} users deleted`);
console.log(
  "Reminder: payment records, invoices, and TigerBeetle balance accounts were NOT touched.",
);
process.exit(0);
