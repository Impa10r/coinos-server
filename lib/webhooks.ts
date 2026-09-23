import got from "got";
import { l, err } from "$lib/logging";

export const callWebhook = async (invoice, payment) => {
  try {
    if (!invoice || !payment) return;

    const { address, received, text, webhook, secret } = invoice;

    if (webhook) {
      const { amount, confirmed, hash, memo } = payment;

      l("calling webhook", webhook, amount, hash, address, text);
      const res = await got.post(webhook, {
        json: {
          address,
          amount,
          confirmed,
          hash,
          memo,
          received,
          text,
          secret,
        },
        // TLS verification stays ON. This body carries `secret` — the shared
        // value the merchant uses to authenticate the notification — so with
        // rejectUnauthorized:false any party able to intercept the connection
        // could present its own certificate, harvest the secret, and then
        // forge "payment received" callbacks to that merchant for ever after.
        //
        // A merchant on a self-signed or expired certificate now fails here
        // instead, which the catch below logs. The payment itself is
        // unaffected — this is only the notification.
      });
      return res;
    }
  } catch (e: any) {
    // Name the URL: a TLS failure here means a specific merchant stopped
    // receiving notifications, and "problem calling webhook" alone gave
    // nothing to act on.
    err("problem calling webhook", invoice?.webhook, e.message);
  }
};
