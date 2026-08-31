// Evict every account that received a payout (via /take) from a fund
// created or managed by an already-evicted account. When an account is
// evicted for a compromised credential or abuse, any fund it created or
// co-manages is suspect, and anyone who received money FROM that fund may
// be a money-mule accomplice or at minimum needs review before their
// balance is trusted further.
//
// A fund counts as tainted two ways:
//   - creator: its earliest funding payment (a debit, type "fund", negative
//     amount — from POST /payments' `fund` branch) was made by an evicted
//     account. fund:<id>:payments has no reliable "first" via redis list
//     order alone (both funding debits and payout credits share the list),
//     so this picks the minimum `created` timestamp among the fund's debit
//     records.
//   - managed: any of the fund's current managers (fund:<id>:managers) is
//     evicted — co-managers effectively control the fund even if they
//     weren't the original funder.
//
// Read-only by default — lists what WOULD be evicted. Pass --apply to
// actually evict, via lib/auth.ts's evictUser() (same evicted+blacklist
// sets isEvicted()/debit() check — see that file for why both matter). No
// IP is banned here: there's no live request/IP tied to a historical payout.
//
// Run inside the app container so it picks up $lib/db / $lib/auth / $config:
//   docker exec -it app bun scripts/evict-fund-payout-recipients.ts
//   docker exec -it app bun scripts/evict-fund-payout-recipients.ts --apply

import { evictUser } from "$lib/auth";
import { db, scan } from "$lib/db";
import { getPayment, getUser } from "$lib/utils";

const argv = new Set(process.argv.slice(2));
const apply = argv.has("--apply");
const asJson = argv.has("--json");

const evictedRaw = [...(await db.sMembers("evicted"))].map(String);
if (!evictedRaw.length) {
  console.log("No evicted accounts found — nothing to check.");
  process.exit(0);
}

// `evicted` entries may be stored as a uid OR a lowercased username (see
// isEvicted()) — resolve each to a canonical uid so it can be matched
// against fund managers/funders, which are stored by uid.
const evictedUids = new Set<string>(evictedRaw);
for (const entry of evictedRaw) {
  const u = await getUser(entry);
  if (u?.id) evictedUids.add(u.id);
}

// Every fund id this app has a record of (same enumeration as
// scripts/audit-fund-names.ts).
const fundIds = new Set<string>();
for (const pattern of ["fund:*:managers", "fund:*:payments", "fund:*:authorizations"]) {
  const suffix = pattern.split(":").pop();
  for await (const key of scan(pattern)) {
    const keyStr = String(key);
    const id = keyStr.slice("fund:".length, keyStr.length - `:${suffix}`.length);
    if (id) fundIds.add(id);
  }
}
for await (const key of scan("user:*:funds")) {
  const members = await db.sMembers(key);
  for (const id of members) fundIds.add(String(id));
}

const suspectFunds = new Map<string, string>(); // fundId -> reason

for (const id of fundIds) {
  const managers = [...(await db.sMembers(`fund:${id}:managers`))].map(String);
  if (managers.some((m) => evictedUids.has(m))) {
    suspectFunds.set(id, "managed by an evicted account");
    continue;
  }

  const pids = (await db.lRange(`fund:${id}:payments`, 0, -1)) || [];
  let earliest: any = null;
  for (const pid of pids) {
    const p: any = await getPayment(pid);
    if (!p || p.type !== "fund" || !(p.amount < 0)) continue; // a funding debit
    if (!earliest || p.created < earliest.created) earliest = p;
  }
  if (earliest?.uid && evictedUids.has(earliest.uid)) {
    suspectFunds.set(id, "created by an evicted account");
  }
}

if (!suspectFunds.size) {
  console.log(`${fundIds.size} fund(s) checked, none created or managed by an evicted account.`);
  process.exit(0);
}

// For each suspect fund, walk its payment list for payout records — a
// credit FROM the fund: positive amount, ref pointing at the fund id
// (matches take()'s credit({ aid: user.id, ref: id, type: "fund", ... })).
const recipients = new Map<string, Set<string>>(); // uid -> fund ids that paid them

for (const fundId of suspectFunds.keys()) {
  const pids = (await db.lRange(`fund:${fundId}:payments`, 0, -1)) || [];
  for (const pid of pids) {
    const p: any = await getPayment(pid);
    if (!p || p.type !== "fund" || p.ref !== fundId || !(p.amount > 0)) continue;
    const recipientUid = p.aid || p.uid;
    if (!recipientUid || evictedUids.has(recipientUid)) continue; // already evicted
    if (!recipients.has(recipientUid)) recipients.set(recipientUid, new Set());
    recipients.get(recipientUid)!.add(fundId);
  }
}

if (!recipients.size) {
  console.log(
    `${suspectFunds.size} fund(s) created/managed by an evicted account, but no not-yet-evicted payout recipients found.`,
  );
  process.exit(0);
}

const rows = await Promise.all(
  [...recipients.entries()].map(async ([uid, funds]) => ({
    uid,
    user: await getUser(uid),
    funds: [...funds].map((id) => `${id} (${suspectFunds.get(id)})`),
  })),
);

if (asJson) {
  console.log(
    JSON.stringify(
      {
        suspectFunds: Object.fromEntries(suspectFunds),
        recipients: rows.map((r) => ({ uid: r.uid, username: r.user?.username, funds: r.funds })),
        applied: apply,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`${suspectFunds.size} fund(s) created or managed by an evicted account.`);
  console.log(`${rows.length} account(s) received a payout and are not yet evicted:\n`);
  for (const { uid, user, funds } of rows) {
    console.log(`  ${user?.username ?? "(unknown)"}  uid=${uid}  paid from: ${funds.join(", ")}`);
  }
}

if (!apply) {
  console.log(`\nDry run — no accounts were evicted. Re-run with --apply to evict all ${rows.length} listed above.`);
  process.exit(0);
}

for (const { uid, user, funds } of rows) {
  if (!user) {
    console.log(`SKIPPED uid=${uid} (user record not found)`);
    continue;
  }
  await evictUser(user, `paid from fund(s) created/managed by evicted account: ${funds.join(", ")}`);
  console.log(`EVICTED ${user.username}`);
}
console.log(`\nDone — evicted ${rows.length} account(s).`);
