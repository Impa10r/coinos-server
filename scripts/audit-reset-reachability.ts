// Can these accounts actually recover a password?
//
// forgot() mails a reset link to the address in `email:<addr>` — so an account
// with no verified email has NO recovery path. Invalidating its password would
// lock the holder out of a custodial wallet, which is worse than whatever the
// reset was meant to fix. Run this before deciding to force any reset.
//
// Usage:
//   bun scripts/audit-reset-reachability.ts                 # whole user base
//   bun scripts/audit-reset-reachability.ts names.txt       # one username per line
//
// Inside the app container:
//   docker exec app sh -c 'cd /home/bun/app && bun scripts/audit-reset-reachability.ts'

import { db, g, scan } from "$lib/db";
import { getUser } from "$lib/utils";

const file = process.argv[2];

const names: string[] | null = file
  ? (await Bun.file(file).text())
      .split("\n")
      .map((l) => l.trim().replace(/^"|"$/g, ""))
      .filter(Boolean)
  : null;

let checked = 0;
let reachable = 0;
let unverified = 0;
let noEmail = 0;
let missing = 0;
const stranded: string[] = [];

const inspect = (u: any) => {
  checked++;
  if (!u?.email) {
    noEmail++;
    stranded.push(u?.username ?? "(unknown)");
  } else if (!u.verified) {
    unverified++;
    stranded.push(u.username);
  } else {
    reachable++;
  }
};

if (names) {
  for (const n of names) {
    const u = await getUser(n);
    if (!u) {
      missing++;
      continue;
    }
    inspect(u);
  }
} else {
  // Collect the canonical keys first, then fetch in concurrent batches. One
  // round trip per key is fine for a handful of named accounts and far too
  // slow for a whole user base — the first version of this ran for minutes
  // with no output and looked hung.
  const keys: string[] = [];
  for await (const k of scan("user:*")) {
    const id = (k as string).slice("user:".length);
    // Anchored, not a prefix test. `user:*` also matches sub-keys like
    // `user:<uuid>:funds`, which is a SET — and `<uuid>:funds` still starts
    // with 8 hex and a dash, so a prefix test let it through and db.get() then
    // died with WRONGTYPE, taking the whole scan with it. Match a complete
    // uuid and nothing else; that also skips the username and pubkey pointers.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) continue;
    keys.push(k as string);
  }
  console.error(`  ${keys.length} user records to check...`);

  const BATCH = 500;
  for (let i = 0; i < keys.length; i += BATCH) {
    const slice = keys.slice(i, i + BATCH);
    const users = await Promise.all(
      // One odd key must not end the audit.
      slice.map((k) => g(k).catch(() => null)),
    );
    for (const u of users) {
      if (!u || typeof u !== "object") continue;
      inspect(u);
    }
    console.error(`  ${Math.min(i + BATCH, keys.length)}/${keys.length}`);
  }
}

const pct = (n: number) => (checked ? `${((n / checked) * 100).toFixed(1)}%` : "—");

console.log("═".repeat(60));
console.log(`  RESET REACHABILITY — ${names ? `${names.length} named accounts` : "all users"}`);
console.log("═".repeat(60));
console.log(`  checked ................ ${checked}`);
if (missing) console.log(`  not found .............. ${missing}`);
console.log(`  reachable by email ..... ${reachable}  (${pct(reachable)})`);
console.log(`  email, not verified .... ${unverified}  (${pct(unverified)})`);
console.log(`  no email at all ........ ${noEmail}  (${pct(noEmail)})`);
console.log("");
console.log(`  Forcing a reset would strand ${unverified + noEmail} account(s) with no`);
console.log("  recovery path. forgot() only mails an address in email:<addr>.");
if (stranded.length) {
  console.log("");
  console.log("  stranded:");
  for (const n of stranded.slice(0, 40)) console.log(`    ${n}`);
  if (stranded.length > 40) console.log(`    ... and ${stranded.length - 40} more`);
}
console.log("═".repeat(60));

await db.quit();
