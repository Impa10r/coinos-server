// Find invoices that BOTH nodes settled — i.e. paid twice.
//
// The LND fallback in lib/payments.ts used to fire on any xpay rejection,
// including a timeout, which is not a terminal failure: CLN splits into parts
// and "Timed out after N attempts" means it stopped RETRYING, not that its
// HTLCs resolved. Paying via LND while a CLN part was still in flight let the
// recipient settle both. Confirmed on 397d8714… — 85,011 sats delivered on a
// 43,000 sat invoice, with only the LND leg reaching the ledger, so the
// overspend came straight out of the hot wallet.
//
// b8bbf131 stopped it happening again. This finds the ones that already did.
//
// Method: every payment_hash CLN reports as `complete` in listsendpays,
// intersected with every payment_hash LND reports as SUCCEEDED. A hash on one
// node only is normal — that's just which node paid it. A hash on BOTH is a
// double settlement, since a single invoice needs exactly one.
//
// Read-only. Nothing here writes to redis, the ledger, or either node.
//
// Usage (inside the app container, for $config / $lib):
//   docker exec -it app bun scripts/audit-double-settled.ts
//   docker exec -it app bun scripts/audit-double-settled.ts --json

import config from "$config";
import { db, g } from "$lib/db";
import ln from "$lib/ln";
import fs from "fs";

const asJson = process.argv.includes("--json");
const log = (...a: any[]) => !asJson && console.log(...a);

const sat = (msat: number) => Math.round(msat / 1000);
const fmt = (n: number) => n.toLocaleString("en-US");

// ---- CLN: every part it settled, grouped by payment_hash ----
log("reading cln listsendpays…");
const { payments: sendpays } = (await ln.listsendpays()) as any;

type Leg = { delivered: number; sent: number; bolt11?: string; at?: number };
const clnPaid = new Map<string, Leg>();

for (const p of sendpays || []) {
  if (p.status !== "complete") continue;
  const leg = clnPaid.get(p.payment_hash) || { delivered: 0, sent: 0 };
  // Sum across parts: one MPP payment settles as several sendpay rows.
  leg.delivered += Number(p.amount_msat) || 0;
  leg.sent += Number(p.amount_sent_msat) || 0;
  leg.bolt11 ||= p.bolt11;
  leg.at = Math.max(leg.at || 0, Number(p.completed_at) || 0);
  clnPaid.set(p.payment_hash, leg);
}
log(`  ${clnPaid.size} payment hash(es) settled by cln`);

// ---- LND: every payment it settled ----
// lib/lnd.ts's listpays() caps at max_payments=50, so go direct and paginate.
const lndConfig = (config as any).lnd;
if (!lndConfig?.url) {
  console.log("No LND configured — nothing to cross-check. (config.lnd.url unset)");
  process.exit(0);
}

const headers = {
  "Grpc-Metadata-macaroon": fs.readFileSync(lndConfig.macaroon).toString("hex"),
  "Content-Type": "application/json",
};
const tlsCert = fs.readFileSync(lndConfig.tlsCert);

log("reading lnd payments…");
const lndPaid = new Map<string, Leg>();
let offset = "0";
let page = 0;

while (true) {
  const url = `${lndConfig.url}/v1/payments?include_incomplete=true&max_payments=1000&index_offset=${offset}`;
  // @ts-ignore — Bun's fetch takes a tls option
  const res = await fetch(url, { headers, tls: { ca: tlsCert } });
  const body: any = await res.json();
  if (body.error || body.code) {
    console.error("lnd request failed:", JSON.stringify(body.message ?? body.error));
    process.exit(1);
  }

  const batch = body.payments || [];
  for (const p of batch) {
    if (p.status !== "SUCCEEDED" && p.status !== 2) continue;
    const value = Number(p.value_msat) || 0;
    const fee = Number(p.fee_msat) || 0;
    lndPaid.set(p.payment_hash, {
      delivered: value,
      sent: value + fee,
      at: Math.round(Number(p.creation_time_ns || 0) / 1e9) || undefined,
    });
  }

  page++;
  const next = String(body.last_index_offset ?? "0");
  if (!batch.length || next === offset) break;
  offset = next;
  if (page > 200) {
    console.error("stopping after 200 pages — unexpected pagination loop");
    break;
  }
}
log(`  ${lndPaid.size} payment hash(es) settled by lnd`);

// ---- Intersection ----
const findings: any[] = [];

for (const [hash, cln] of clnPaid) {
  const lnd = lndPaid.get(hash);
  if (!lnd) continue;

  const bolt11 = cln.bolt11;
  // The coinos payment record is keyed by bolt11 (debit() passes the bolt11 as
  // `hash`), via a payment:<bolt11> -> id pointer.
  let record: any = null;
  if (bolt11) {
    try {
      let pid: any = await g(`payment:${bolt11}`);
      if (pid?.id) pid = pid.id;
      if (typeof pid === "string") record = await g(`payment:${pid}`);
    } catch {}
  }

  const delivered = cln.delivered + lnd.delivered;
  const sent = cln.sent + lnd.sent;
  // The invoice is whichever leg paid it in full; each leg alone should equal
  // the invoice amount, so the larger is the invoice and the rest is overspend.
  const invoice = Math.max(cln.delivered, lnd.delivered);

  findings.push({
    payment_hash: hash,
    bolt11,
    at: new Date((cln.at || lnd.at || 0) * 1000).toISOString(),
    invoice_sats: sat(invoice),
    cln_delivered_sats: sat(cln.delivered),
    lnd_delivered_sats: sat(lnd.delivered),
    delivered_sats: sat(delivered),
    sent_sats: sat(sent),
    overspend_sats: sat(sent - invoice),
    ledger_payment_id: record?.id ?? null,
    ledger_debited_sats: record ? Math.abs(Number(record.amount) || 0) : null,
    user: record?.uid ?? null,
  });
}

findings.sort((a, b) => (a.at < b.at ? -1 : 1));

if (asJson) {
  console.log(JSON.stringify({ findings, total: findings.length }, null, 2));
  process.exit(0);
}

console.log();
if (!findings.length) {
  console.log(
    `No double settlements found across ${clnPaid.size} cln and ${lndPaid.size} lnd settled payments.`,
  );
  process.exit(0);
}

let totalOverspend = 0;
console.log(`${findings.length} invoice(s) settled by BOTH nodes:\n`);
for (const f of findings) {
  totalOverspend += f.overspend_sats;
  console.log(`  ${f.at}  ${f.payment_hash}`);
  console.log(
    `    invoice ${fmt(f.invoice_sats)} sats  |  cln delivered ${fmt(f.cln_delivered_sats)}  +  lnd delivered ${fmt(f.lnd_delivered_sats)}  =  ${fmt(f.delivered_sats)}`,
  );
  console.log(
    `    sent from our node ${fmt(f.sent_sats)} sats  |  OVERSPEND ${fmt(f.overspend_sats)} sats`,
  );
  console.log(
    `    ledger: ${f.ledger_payment_id ? `${f.ledger_payment_id} debited ${fmt(f.ledger_debited_sats)} sats from ${f.user}` : "no payment record found"}`,
  );
  console.log();
}

console.log(`Total overspend: ${fmt(totalOverspend)} sats`);
console.log(
  "\nThe debit shown is what the SENDER was charged — correct in each case, since\n" +
    "they owed the invoice once. The overspend is the operator's loss: it left the\n" +
    "hot wallet with no corresponding ledger entry.",
);

await db.quit().catch(() => {});
process.exit(0);
