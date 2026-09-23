import { l, err } from "$lib/logging";
import { safePost } from "$lib/safe-fetch";

export const callWebhook = async (invoice, payment) => {
  try {
    if (!invoice || !payment) return;

    const { address, received, text, webhook, secret } = invoice;

    if (webhook) {
      const { amount, confirmed, hash, memo } = payment;

      l("calling webhook", webhook, amount, hash, address, text);
      // TLS verification stays on, and the host is validated before connect.
      //
      // This body carries `secret` — the value the merchant uses to
      // authenticate the notification — so the previous got.post() with
      // `rejectUnauthorized: false` let anyone able to intercept the
      // connection present their own certificate, take the secret, and forge
      // "payment received" callbacks to that merchant afterwards. A merchant
      // on a self-signed or expired certificate now fails here instead, which
      // the catch below logs; the payment itself is unaffected.
      //
      // safePost, not a bare POST. The webhook url is set by whoever created
      // the invoice, and POST /invoice takes `optional` auth — so anyone can
      // point one at an internal address and trigger the request by paying
      // the invoice a single sat. safePost resolves the host first, refuses
      // loopback/private/link-local/metadata targets, connects to the IP it
      // validated so a rebind can't slip past, and re-checks every redirect.
      const res = await safePost(
        webhook,
        {
          address,
          amount,
          confirmed,
          hash,
          memo,
          received,
          text,
          secret,
        },
      );
      return res;
    }
  } catch (e: any) {
    // Name the URL: a TLS failure here means a specific merchant stopped
    // receiving notifications, and "problem calling webhook" alone gave
    // nothing to act on.
    err("problem calling webhook", invoice?.webhook, e.message);
  }
};
