// Find and (optionally) delete every user that ever touched ark:
//   - has an account with type === "ark"
//   - has any arkaddr:* mapping pointing at them
//   - has any payment record with type === "ark"
//
// Authorized cleanup only — destructive. Defaults to dry-run.
//
// Usage:
//   bun scripts/nuke-ark-users.ts                  # dry-run, list candidates
//   bun scripts/nuke-ark-users.ts --confirm        # actually delete
//   bun scripts/nuke-ark-users.ts --include-payments  # also flag users with ark payment records (slower scan)
//
// Mirrors users.deleteUser scope: removes user:<id>, user:<username>,
// user:<pubkey>, account:<id>, <id>:accounts, <id>:apps, follows/followers
// counters. Does NOT touch <id>:payments, <id>:invoices, or TigerBeetle
// balance accounts — handle those separately if needed.

import { db } from "$lib/db";

const args = new Set(process.argv.slice(2));
const dryRun = !args.has("--confirm");
const includePayments = args.has("--include-payments");

const uids = new Set<string>();

const reasons: Record<string, string[]> = {};
const noteReason = (uid: string, reason: string) => {
  if (!reasons[uid]) reasons[uid] = [];
  reasons[uid].push(reason);
};

console.log("scanning arkaddr:* …");
for await (const key of (db as any).scanIterator({ MATCH: "arkaddr:*", COUNT: 200 })) {
  const raw = await db.get(String(key));
  if (!raw) continue;
  try {
    const { uid } = JSON.parse(String(raw));
    if (uid) {
      uids.add(uid);
      noteReason(uid, `arkaddr ${String(key).slice(8, 40)}…`);
    }
  } catch {}
}

console.log("scanning account:* …");
for await (const key of (db as any).scanIterator({ MATCH: "account:*", COUNT: 200 })) {
  const raw = await db.get(String(key));
  if (!raw) continue;
  try {
    const acc = JSON.parse(String(raw));
    if (acc?.type === "ark" && acc?.uid) {
      uids.add(acc.uid);
      noteReason(acc.uid, `account:${acc.id} type=ark`);
    }
  } catch {}
}

if (includePayments) {
  console.log("scanning payment:* (slow) …");
  // arkReceive stores credits as payment records with the *invoice's* type
  // (lightning/bitcoin/liquid) but a UUID hash. Real credits of those types
  // always carry a bolt11 / address / 64-hex txid, never a UUID.
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const fraudTypes = new Set(["lightning", "bolt12", "bitcoin", "liquid"]);

  for await (const key of (db as any).scanIterator({ MATCH: "payment:*", COUNT: 500 })) {
    if (String(key).split(":").length !== 2) continue; // skip payment:<aid>:<hash> reverse mappings
    const raw = await db.get(String(key));
    if (!raw) continue;
    try {
      const p = JSON.parse(String(raw));
      if (!p?.uid) continue;
      const isArkType = p.type === "ark";
      const looksFraud =
        fraudTypes.has(p.type) && typeof p.hash === "string" && uuidRe.test(p.hash);
      if (!isArkType && !looksFraud) continue;
      uids.add(p.uid);
      if (!reasons[p.uid]?.some((r) => r.startsWith("payment"))) {
        noteReason(
          p.uid,
          looksFraud ? `payment:${p.id} (${p.type} +${p.amount} UUID hash)` : `payment:${p.id}`,
        );
      }
    } catch {}
  }
}

console.log(`found ${uids.size} user(s) tied to ark`);

const candidates: {
  uid: string;
  username: string | null;
  pubkey: string | null;
  reasons: string[];
}[] = [];
for (const uid of uids) {
  const raw = await db.get(`user:${uid}`);
  if (!raw) {
    candidates.push({ uid, username: null, pubkey: null, reasons: reasons[uid] ?? [] });
    continue;
  }
  const u = JSON.parse(String(raw));
  candidates.push({
    uid,
    username: u.username ?? null,
    pubkey: u.pubkey ?? null,
    reasons: reasons[uid] ?? [],
  });
}

candidates.sort((a, b) => (a.username ?? "").localeCompare(b.username ?? ""));

console.log();
for (const c of candidates) {
  console.log(`  ${c.username ?? "(no user record)"}  uid=${c.uid}  ${c.reasons.join(", ")}`);
}

if (dryRun) {
  console.log();
  console.log("DRY RUN — no users deleted. Re-run with --confirm to delete.");
  process.exit(0);
}

console.log();
console.log("deleting…");

let deleted = 0;
for (const c of candidates) {
  try {
    const m = db.multi();
    const appKeys = await db.sMembers(`${c.uid}:apps`);
    for (const k of appKeys) m.del(`app:${k}`);

    m.del(`user:${c.uid}`).del(`account:${c.uid}`).del(`${c.uid}:accounts`).del(`${c.uid}:apps`);

    if (c.username) m.del(`user:${c.username}`);
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

console.log();
console.log(`done — ${deleted} of ${candidates.length} users deleted`);
console.log(
  "Reminder: payment records, invoices, and TigerBeetle balance accounts were NOT touched.",
);
process.exit(0);
