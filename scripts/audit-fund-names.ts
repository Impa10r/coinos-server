// Audit fund ids/names. A legitimate fund id is a v4 UUID the client
// generates with crypto.randomUUID() — the id doubles as an unguessable
// capability token (anyone holding it can fund/withdraw/manage that fund),
// so a short or human-typed name defeats that unguessability. This lists
// every fund id this app has a record of, flags the non-UUID ones, and
// reports each one's TigerBeetle balance, manager count, and payment count.
//
// Deliberately read-only — no delete option. A non-UUID fund can still hold
// real TigerBeetle balance; removing its redis bookkeeping would orphan
// that balance (make it unreachable) rather than safely resolving it. See
// the printed summary for what to do with anything flagged.
//
// Fund ids are gathered from every `fund:<id>:managers` / `fund:<id>:payments`
// / `fund:<id>:authorizations` key (SCAN, never KEYS) plus every member of
// every `user:<uid>:funds` set, so a fund missing one of those records (e.g.
// a bearer fund with no managers) is still found via the others.
//
// Usage:
//   bun scripts/audit-fund-names.ts               # human report
//   bun scripts/audit-fund-names.ts --json         # machine-readable
//   bun scripts/audit-fund-names.ts --flagged-only # only print non-UUID funds
//
// Run inside the app container so it picks up $lib/db / $lib/tb / $config:
//   docker exec -it app bun scripts/audit-fund-names.ts --flagged-only

import { db, scan } from "$lib/db";
import { getFundBalance, initTigerBeetle } from "$lib/tb";
import { validate as isUuid } from "uuid";

const argv = new Set(process.argv.slice(2));
const asJson = argv.has("--json");
const flaggedOnly = argv.has("--flagged-only");

await initTigerBeetle();

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

type Row = {
  id: string;
  valid: boolean;
  balance: number | null;
  managers: number;
  payments: number;
};

const rows: Row[] = [];
for (const id of ids) {
  const [balance, managers, payments] = await Promise.all([
    getFundBalance(id),
    db.sCard(`fund:${id}:managers`),
    db.lLen(`fund:${id}:payments`),
  ]);
  rows.push({ id, valid: isUuid(id), balance, managers: Number(managers), payments: Number(payments) });
}

rows.sort((a, b) => Number(a.valid) - Number(b.valid) || (b.balance ?? 0) - (a.balance ?? 0));

const flagged = rows.filter((r) => !r.valid);
const output = flaggedOnly ? flagged : rows;

if (asJson) {
  console.log(JSON.stringify({ total: rows.length, flagged: flagged.length, funds: output }, null, 2));
} else {
  console.log(`${rows.length} fund id(s) found, ${flagged.length} non-UUID.\n`);
  for (const r of output) {
    console.log(
      `${r.valid ? "  ok " : "FLAG "}${r.id}` +
        `  balance=${r.balance ?? "none"}` +
        `  managers=${r.managers}` +
        `  payments=${r.payments}`,
    );
  }
  if (flagged.length) {
    console.log(
      `\n${flagged.length} flagged fund(s) above. Each still has a real TigerBeetle ` +
        `balance if "balance" isn't "none" — decide per-fund whether to freeze it ` +
        `(block further use pending contact with its managers/depositors) or ` +
        `refund/sweep the balance before touching any records. This script does ` +
        `not delete anything.`,
    );
  }
}
