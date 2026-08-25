// Find every account:<id> record with type "liquid" — non-custodial vaults
// that sendNonCustodial can't safely handle (Bitcoin-only address
// derivation and esplora calls; see routes/users.ts createAccount, which
// now rejects new ones). Read-only — just reports what exists.
//
// Usage:
//   docker exec -it app bun scripts/scan-liquid-accounts.ts

import { db, g } from "$lib/db";

let scanned = 0;
const hits: { id: string; uid?: string; username?: string; pubkey?: string; fingerprint?: string }[] =
  [];

for await (const batch of db.scanIterator({ MATCH: "account:*" })) {
  for (const key of batch as unknown as string[]) {
    scanned++;
    let account: any;
    try {
      account = await g(key);
    } catch (e: any) {
      console.error(`  FAILED to read ${key}: ${e.message}`);
      continue;
    }
    if (!account || account.type !== "liquid") continue;

    let username: string | undefined;
    if (account.uid) {
      const user = await g(`user:${account.uid}`).catch(() => null);
      username = user?.username;
    }

    hits.push({
      id: account.id,
      uid: account.uid,
      username,
      pubkey: account.pubkey,
      fingerprint: account.fingerprint,
    });
  }
}

console.log(`scanned=${scanned} liquid-vaults-found=${hits.length}\n`);
for (const h of hits) {
  console.log(
    `  account:${h.id}  uid=${h.uid ?? "?"}  username=${h.username ?? "?"}  ` +
      `pubkey=${h.pubkey ?? "?"}  fingerprint=${h.fingerprint ?? "?"}`,
  );
}

process.exit(0);
