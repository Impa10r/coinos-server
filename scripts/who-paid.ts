// Resolve both sides of an internal payment. `payment:<hash>` points to
// whichever record — debit or credit — was written LAST for that hash;
// sendInternal() calls debit() then credit() on the same hash, so a lookup
// by hash resolves to the CREDIT record, not the debit. The two records
// disagree on what `ref`/`uid` mean:
//   - credit record (amount > 0): uid = recipient (invoice owner), ref =
//     sender (sendInternal passes ref: sender.id)
//   - debit record (amount < 0): uid = sender (the debited account), ref =
//     recipient (debit() sets ref = invoice.uid when hash matches one)
// Branching on the amount's sign instead of assuming one shape fixed a
// real bug: the first version of this script always read `.ref` and
// reported the sender as the recipient for a credit record.
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
  console.log(`\ntype is "${payment.type}", not internal — no sender/recipient ref to resolve.`);
  process.exit(0);
}

const isCredit = payment.amount > 0;
const senderUid = isCredit ? payment.ref : payment.uid;
const recipientUid = isCredit ? payment.uid : payment.ref;

if (!senderUid || !recipientUid) {
  console.log("\nMissing uid/ref on this payment — can't resolve both sides.");
  process.exit(0);
}

const [sender, recipient] = await Promise.all([getUser(senderUid), getUser(recipientUid)]);

console.log(`\nThis is the ${isCredit ? "credit (recipient's)" : "debit (sender's)"} record for this hash.`);
console.log(`Sender:    ${sender?.username ?? "(unknown)"}  (uid=${senderUid})`);
console.log(`Recipient: ${recipient?.username ?? "(unknown)"}  (uid=${recipientUid})`);
