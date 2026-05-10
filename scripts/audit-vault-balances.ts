// Walk every bitcoin vault account and compare coinos's displayed
// balance (sum of payment records) against the real on-chain balance
// (bitcoind sub-wallet getbalance). Any account where coinos > actual
// had its payment list tampered with, almost certainly via the
// pre-fix arkVaultReceive / arkSync vector.
//
// Usage:
//   bun scripts/audit-vault-balances.ts                    # show all vaults
//   bun scripts/audit-vault-balances.ts --tainted-only     # only print mismatches
//
// Run inside the app container so it picks up $lib/db / $config:
//   docker exec -it app bun scripts/audit-vault-balances.ts --tainted-only

import config from "$config";
import { db, scan } from "$lib/db";
import rpc from "@coinos/rpc";

const argv = new Set(process.argv.slice(2));
const taintedOnly = argv.has("--tainted-only");

const SATS = 100_000_000;

type Row = {
  aid: string;
  uid: string;
  username: string | null;
  coinos: number;
  actual: number | null;
  diff: number | null;
  note: string;
};

const rows: Row[] = [];

console.log("scanning account:* …");

for await (const key of scan("account:*")) {
  const raw = await db.get(String(key));
  if (!raw) continue;

  let acc: any;
  try {
    acc = JSON.parse(String(raw));
  } catch {
    continue;
  }

  // include any account that was created as a bitcoin sub-wallet,
  // regardless of whether pubkey/fingerprint/seed are populated.
  const isBitcoinSub = acc?.type === "bitcoin" || acc?.pubkey || acc?.seed;
  if (!isBitcoinSub) continue;

  const aid = acc.id;
  const uid = acc.uid;
  if (!aid) continue;

  // sum coinos's payment records for this account
  const paymentIds = (await db.lRange(`${aid}:payments`, 0, -1)) as string[];
  let coinos = 0;
  for (const pid of paymentIds) {
    const praw = await db.get(`payment:${pid}`);
    if (!praw) continue;
    try {
      const p = JSON.parse(String(praw));
      if (p?.confirmed === false) continue; // skip unconfirmed
      coinos += (p.amount ?? 0) - (p.fee ?? 0);
    } catch {}
  }

  // ask bitcoind for the actual sub-wallet balance
  let actual: number | null = null;
  let note = "";
  try {
    const subwallet = rpc({ ...config.bitcoin, wallet: aid });
    const btc = await (subwallet as any).getBalance();
    actual = Math.round(btc * SATS);
  } catch (e: any) {
    note = `bitcoind: ${e.message?.split("\n")[0] ?? e}`;
  }

  // resolve username
  let username: string | null = null;
  if (uid) {
    const uraw = await db.get(`user:${uid}`);
    if (uraw) {
      try {
        username = JSON.parse(String(uraw)).username ?? null;
      } catch {}
    }
  }

  const diff = actual === null ? null : coinos - actual;

  rows.push({ aid, uid, username, coinos, actual, diff, note });
}

const tainted = rows.filter((r) => r.diff !== null && r.diff > 0);
const display = taintedOnly ? tainted : rows;

display.sort((a, b) => (b.diff ?? 0) - (a.diff ?? 0));

const fmt = (n: number | null) => (n === null ? "?" : n.toLocaleString());

console.log();
console.log(
  `${"account".padEnd(38)}  ${"user".padEnd(20)}  ${"coinos".padStart(15)}  ${"actual".padStart(15)}  ${"diff".padStart(15)}  note`,
);
console.log("-".repeat(120));
for (const r of display) {
  console.log(
    `${r.aid.padEnd(38)}  ${(r.username ?? "(?)").padEnd(20)}  ${fmt(r.coinos).padStart(15)}  ${fmt(r.actual).padStart(15)}  ${fmt(r.diff).padStart(15)}  ${r.note}`,
  );
}

const totalDiff = tainted.reduce((s, r) => s + (r.diff ?? 0), 0);
console.log();
console.log(`scanned ${rows.length} vault accounts; ${tainted.length} tainted (coinos > actual)`);
console.log(`total phantom credit across vaults: ${totalDiff.toLocaleString()} sats`);

process.exit(0);
