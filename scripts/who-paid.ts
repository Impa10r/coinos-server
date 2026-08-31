// Resolve the recipient of an internal payment. An internal debit's `ref`
// field is the recipient's uid (set in debit(): ref = invoice.uid, when the
// debited hash matches a known invoice) — this just follows that chain and
// prints who it was.
//
// Usage: pass either the payment's hash (a bolt11 string, on-chain txid:vout,
// or fund id — whatever "hash/id" showed) or its payment id (a uuid).
//   bun scripts/who-paid.ts <hash-or-payment-id>
//
// Run inside the app container so it picks up $lib/db / $config:
//   docker exec -it app bun scripts/who-paid.ts lnbc10n1p4f2vqp...

import { getPayment, getUser } from "$lib/utils";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: bun scripts/who-paid.ts <hash-or-payment-id>");
  process.exit(1);
}

const payment: any = await getPayment(arg);
if (!payment) {
  console.error(`No payment found for "${arg}"`);
  process.exit(1);
}

console.log("payment:", JSON.stringify(payment, null, 2));

if (payment.type !== "internal") {
  console.log(`\ntype is "${payment.type}", not internal — no recipient ref to resolve.`);
  process.exit(0);
}

if (!payment.ref) {
  console.log("\nNo ref on this payment — recipient unknown (invoice may have been deleted).");
  process.exit(0);
}

const recipient = await getUser(payment.ref);
if (!recipient) {
  console.log(`\nref=${payment.ref} but no matching user record.`);
  process.exit(0);
}

console.log(`\nPaid to: ${recipient.username}  (uid=${recipient.id})`);
