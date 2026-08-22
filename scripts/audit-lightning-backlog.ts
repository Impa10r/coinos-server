import { db } from "$lib/db";
import ln from "$lib/ln";
import { getInvoice, getPayment, getUser } from "$lib/utils";

const max = Number(process.argv[2] || 10_000);
const stored = Number((await db.get("pay_index")) || 0);
let cursor = stored;
const rows: any[] = [];

for (let i = 0; i < max; i++) {
  let settled: any;
  try {
    settled = await ln.waitanyinvoice(cursor, 1);
  } catch (e: any) {
    if (Number(e?.code ?? e?.errno) === 904) break;
    throw e;
  }

  if (!settled?.pay_index || Number(settled.pay_index) <= cursor) break;
  cursor = Number(settled.pay_index);

  const mintOwned =
    typeof settled.label === "string" && settled.label.startsWith("lbl");
  const paymentRequest = settled.bolt11 || settled.bolt12;
  const invoiceKey = settled.bolt11 || settled.local_offer_id || settled.bolt12;
  const invoice = mintOwned ? null : await getInvoice(invoiceKey);
  const payment = paymentRequest ? await getPayment(paymentRequest) : null;
  const user = invoice?.uid ? await getUser(invoice.uid) : null;
  const claim = settled.payment_preimage
    ? await db.get(`credited:${settled.payment_preimage}`)
    : null;

  rows.push({
    payIndex: cursor,
    amountSats: Math.round(Number(settled.amount_received_msat || 0) / 1000),
    mintOwned,
    invoiceFound: !!invoice,
    paymentFound: !!payment,
    claimFound: !!claim,
    username: user?.username,
    autowithdraw: !!user?.autowithdraw,
  });
}

const coinos = rows.filter((row) => !row.mintOwned);
const actionable = coinos.filter(
  (row) => row.invoiceFound && !row.paymentFound && !row.claimFound,
);

console.log(
  JSON.stringify(
    {
      storedPayIndex: stored,
      latestPayIndex: cursor,
      backlog: rows.length,
      mintOwned: rows.filter((row) => row.mintOwned).length,
      coinos: coinos.length,
      alreadyProcessed: coinos.filter((row) => row.paymentFound).length,
      missingInvoice: coinos.filter((row) => !row.invoiceFound).length,
      claimedWithoutPayment: coinos.filter(
        (row) => row.claimFound && !row.paymentFound,
      ).length,
      actionable: actionable.length,
      actionableSats: actionable.reduce(
        (total, row) => total + row.amountSats,
        0,
      ),
      autowithdraw: actionable.filter((row) => row.autowithdraw).length,
      rows,
    },
    null,
    2,
  ),
);

process.exit(0);
