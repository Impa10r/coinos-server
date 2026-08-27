// boltz-recover-stuck.ts — auto-recover boltz submarine swaps whose Lightning
// payment got stuck, using the stubborn peer-force payer (pay-hard.ts).
//
// Background: boltz-backend pays a submarine swap's destination invoice with
// CLN's basic `pay` and gives up after a few minutes. To inbound-scarce exchange
// destinations (fixedfloat), that leaves the user's on-chain funds locked and the
// swap stuck at `invoice.pending` — exactly what happened 2026-08-27. pay-hard's
// peer-force strategy completes those. After the invoice is paid on bcln, boltz
// reconciles (picks up the preimage and claims the lockup) on its next restart;
// if it hasn't within a grace period, we restart it once.
//
// Runs on a cron from the coinos-server host (reaches cl locally and bcln/boltz
// on cs via ssh). Quiet unless it finds a stuck swap. Log: ~/boltz-recover.log
//
// Usage: bun scripts/boltz-recover-stuck.ts   (add --dry to detect+probe only)
import { execSync } from "child_process";
import { appendFileSync, writeFileSync } from "fs";

const DRY = process.argv.includes("--dry");
const LOG = "/home/adam/boltz-recover.log";
const PAYHARD = "/home/adam/coinos-server/scripts/pay-hard.ts";
const BUN = "/home/adam/.bun/bin/bun";
const STUCK_MIN = 10;         // only touch swaps idle at least this long (don't race boltz)
const MAX_PER_RUN = 5;        // safety cap
const BCLN = "docker exec bcln lightning-cli --lightning-dir=/app/lightning";

const sh = (c: string) => { try { return execSync(c, { encoding: "utf8", maxBuffer: 1e8 }); } catch (e: any) { return (e.stdout || "") + (e.stderr || ""); } };
const log = (m: string) => { const line = `[${new Date().toISOString()}] ${m}`; try { appendFileSync(LOG, line + "\n"); } catch {} console.log(line); };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// run a SQL query against boltz-postgres on cs (query via stdin -> no quoting hell)
function psql(query: string): string[] {
  writeFileSync("/tmp/boltz_recover_q.sql", query);
  const out = sh(`ssh -o ConnectTimeout=15 cs 'docker exec -i boltz-postgres psql -U boltz -d boltz -tAF"|"' < /tmp/boltz_recover_q.sql`);
  return out.trim().split("\n").filter(Boolean);
}
const bcln = (sub: string) => sh(`ssh -o ConnectTimeout=15 cs '${BCLN} ${sub}'`);

// ---- find stuck submarine swaps ----
// `swaps` = submarine swaps (user locks on-chain, boltz pays the LN invoice).
const rows = psql(
  `select id, invoice from swaps ` +
  `where status='invoice.pending' and "lockupTransactionId" is not null and invoice is not null ` +
  `and "updatedAt" < now() - interval '${STUCK_MIN} minutes' ` +
  `order by "updatedAt" asc limit ${MAX_PER_RUN}`,
).map((l) => { const [id, invoice] = l.split("|"); return { id, invoice }; });

if (!rows.length) process.exit(0); // quiet: nothing stuck
log(`found ${rows.length} stuck submarine swap(s): ${rows.map((r) => r.id).join(", ")}`);

const paidIds: string[] = [];
for (const { id, invoice } of rows) {
  // skip expired invoices — those are a refund case, not ours to force
  let dec: any = null;
  try { dec = JSON.parse(bcln(`decode ${invoice}`)); } catch {}
  if (dec?.created_at && dec?.expiry && Date.now() / 1000 > dec.created_at + dec.expiry) {
    log(`  ${id}: invoice expired — skipping (refund path)`);
    continue;
  }

  if (DRY) {
    const out = sh(`${BUN} ${PAYHARD} ${invoice} --node=bcln --dry`);
    log(`  ${id}: [dry] ${out.trim().split("\n").pop()}`);
    continue;
  }

  log(`  ${id}: running pay-hard…`);
  const out = sh(`${BUN} ${PAYHARD} ${invoice} --node=bcln --maxfee=6000`);
  const last = out.trim().split("\n").pop() || "";
  const paid = /🎉 PAID|already paid|xpay succeeded/.test(out);
  log(`    → ${last}`);
  if (paid) paidIds.push(id);
}

// ---- reconcile: make boltz claim the lockups for swaps we just paid ----
if (paidIds.length && !DRY) {
  await sleep(45_000); // give boltz a chance to notice on its own
  const still = psql(
    `select id from swaps where id in (${paidIds.map((i) => `'${i}'`).join(",")}) and status='invoice.pending'`,
  );
  if (still.length) {
    log(`boltz did not auto-reconcile ${still.length} paid swap(s) [${still.join(",")}] — restarting boltz to claim`);
    sh(`ssh -o ConnectTimeout=20 cs 'docker restart boltz'`);
    await sleep(20_000);
    const after = psql(`select id, status from swaps where id in (${paidIds.map((i) => `'${i}'`).join(",")})`);
    log(`  post-restart status: ${after.join(" ; ")}`);
  } else {
    log(`boltz reconciled all ${paidIds.length} paid swap(s) on its own`);
  }
}
process.exit(0);
