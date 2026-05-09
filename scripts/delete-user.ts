// Delete one or more users by username or uid.
// Authorized cleanup only — destructive. Defaults to dry-run.
//
// Usage:
//   bun scripts/delete-user.ts <username|uid> [<username|uid> …]            # dry-run
//   bun scripts/delete-user.ts <username|uid> [<username|uid> …] --confirm  # actually delete
//
// Mirrors users.deleteUser scope: removes user:<id>, user:<username>,
// user:<pubkey>, account:<id>, <id>:accounts, <id>:apps, follows/followers
// counters, and all app:<key> entries.
//
// Does NOT touch <id>:payments, <id>:invoices, or TigerBeetle balance
// accounts. Run inside the app container so it picks up $lib/db config:
//   docker exec -it app bun scripts/delete-user.ts alice 06401f5a-... --confirm

import { db } from "$lib/db";

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const argv = process.argv.slice(2);
const dryRun = !argv.includes("--confirm");
const inputs = argv.filter((a) => !a.startsWith("--")).map((u) => u.toLowerCase().trim());

if (inputs.length === 0) {
  console.error("Usage: bun scripts/delete-user.ts <username|uid> [...] [--confirm]");
  process.exit(1);
}

const candidates: {
  username: string | null;
  uid: string;
  pubkey: string | null;
  appKeys: string[];
}[] = [];

for (const input of inputs) {
  let uid: string | null = null;

  if (uuidRe.test(input)) {
    uid = input;
  } else {
    const uidRaw = await db.get(`user:${input}`);
    if (uidRaw) {
      try {
        uid = JSON.parse(String(uidRaw));
      } catch {
        uid = String(uidRaw);
      }
    }
  }

  if (!uid) {
    console.log(`  ${input}: NOT FOUND`);
    continue;
  }

  const raw = await db.get(`user:${uid}`);
  const u = raw ? JSON.parse(String(raw)) : null;
  const appKeys = [...(await db.sMembers(`${uid}:apps`))].map(String);
  const username = u?.username?.toLowerCase() ?? (uuidRe.test(input) ? null : input);

  if (!u && !appKeys.length && !(await db.exists(`${uid}:accounts`))) {
    console.log(`  ${input}: no user record, accounts, or apps for uid=${uid} — skipping`);
    continue;
  }

  candidates.push({
    username,
    uid,
    pubkey: u?.pubkey ?? null,
    appKeys,
  });
  console.log(
    `  ${input}: uid=${uid} username=${username ?? "(none)"} pubkey=${u?.pubkey ?? "(none)"} apps=${appKeys.length}`,
  );
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

    if (c.username) m.del(`user:${c.username}`);
    m.del(`user:${c.uid}`).del(`account:${c.uid}`).del(`${c.uid}:accounts`).del(`${c.uid}:apps`);

    if (c.pubkey) {
      m.del(`user:${c.pubkey}`)
        .del(`${c.pubkey}:follows:n`)
        .del(`${c.pubkey}:followers:n`)
        .del(`${c.pubkey}:pubkeys`);
    }

    await m.exec();
    deleted++;
    console.log(`  deleted ${c.username ?? c.uid}`);
  } catch (e: any) {
    console.error(`  FAILED ${c.username ?? c.uid}: ${e.message}`);
  }
}

console.log(`\ndone — ${deleted} of ${candidates.length} users deleted`);
console.log(
  "Reminder: payment records, invoices, and TigerBeetle balance accounts were NOT touched.",
);
process.exit(0);
