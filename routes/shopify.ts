import { db, g } from "$lib/db";
import { err, l, warn } from "$lib/logging";
import { bail, getInvoice, getPayment } from "$lib/utils";
import got from "got";

const query = `mutation orderMarkAsPaid($input: OrderMarkAsPaidInput!) {
  orderMarkAsPaid(input: $input) {
    order { id }
    userErrors {
      field
      message
    }
  }
}`;

// This endpoint is coinos calling ITSELF. The storefront script served at
// coinos-ui /[username]/shopify.js creates the invoice with
//
//     webhook: https://<host>/api/shopify/<Shopify.checkout.order_id>
//
// so lib/webhooks.ts callWebhook() posts here when that invoice is paid. It is
// therefore unauthenticated by construction — the shopper has no account — and
// it acts with the merchant's stored Shopify admin token.
//
// It used to take the caller entirely on trust: `hash` from the body named any
// payment, `:id` from the path named any order, and nothing tied the two
// together. Reproduced on regtest — an unauthenticated POST carrying a payment
// hash belonging to a Shopify-connected merchant sent orderMarkAsPaid for an
// order id of the caller's choosing, under that merchant's token. Only a
// nonexistent store stopped it. A merchant's goods ship for a payment that was
// never made against that order, and one hash was reusable for every order in
// the shop.
//
// The binding that was missing is already in the data: the invoice's own
// webhook url carries the order id it was created for. So a payment may only
// mark the order its invoice named.
export default async (c) => {
  const id = c.req.param("id");
  try {
    const { hash } = await c.req.json();
    if (typeof hash !== "string" || !hash) return bail(c, "hash required", 400);

    const p = await getPayment(hash);
    if (!p) return bail(c, "payment not found", 404);

    // The order must be the one this payment's invoice was raised for. An
    // attacker can set `webhook` when creating an invoice (POST /invoice takes
    // `optional` auth), but only on an invoice they had raised — and then they
    // must actually pay it, for the amount the order is due. That is the
    // merchant getting paid, which is the point.
    const invoice = await getInvoice(hash);
    const expected = `/shopify/${id}`;
    if (!invoice?.webhook?.endsWith(expected)) {
      warn("shopify order/payment mismatch", id, hash?.slice(0, 20));
      return bail(c, "payment does not match this order", 403);
    }

    // Unconfirmed means nothing has settled yet.
    if (!p.confirmed) return bail(c, "payment not confirmed", 409);

    // One payment marks one order, once. Without this a retried webhook — or a
    // replayed request — re-issues the mutation.
    if (!(await db.set(`shopify:marked:${id}`, hash, { NX: true })))
      return c.json({ ok: true, already: true });

    const user = await g(`user:${p.uid}`);
    if (!user?.shopifyStore || !user?.shopifyToken)
      return bail(c, "shopify not connected", 409);

    l("marking shopify order paid", id, user.username, p.id, user.shopifyStore);

    try {
      const r = await got
        .post(`https://${user.shopifyStore}.myshopify.com/admin/api/2023-07/graphql.json`, {
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": user.shopifyToken,
          },
          json: {
            query,
            variables: { input: { id: `gid://shopify/Order/${id}` } },
          },
        })
        .json();

      l("shopify success", r);
      return c.json(r);
    } catch (e: any) {
      // Release the single-use claim so a genuine retry can still succeed —
      // otherwise a transient Shopify error burns the order permanently.
      await db.del(`shopify:marked:${id}`);
      throw e;
    }
  } catch (e: any) {
    // Returned, not just logged. The old handler fell off the end of its catch,
    // so a failed mutation produced no Response at all and Hono answered
    // "Context is not finalized".
    err("problem marking shopify order as paid", id, e.message);
    return bail(c, "could not mark order paid", 502);
  }
};
