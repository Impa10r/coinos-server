import config from "$config";
import { db, g, gf, s } from "$lib/db";
import { generate } from "$lib/invoices";
import { err } from "$lib/logging";
import { bail, fail, fields, getAccount, getInvoice, getUser } from "$lib/utils";
import rpc from "@coinos/rpc";

export default {
  async get(c) {
    try {
      const id = c.req.param("id");
      if (id === "undefined") fail("invalid id");
      const invoice = await getInvoice(id);

      if (invoice) {
        invoice.secret = undefined;
        invoice.user = await getUser(invoice.uid, fields);
        invoice.account = await getAccount(invoice.aid);

        invoice.items ||= [];
      }
      if (invoice) return c.json(invoice);
      else fail("invoice not found");
    } catch (e) {
      return bail(c, e.message);
    }
  },

  async create(c) {
    const body = await c.req.json();
    let user = c.get("user");
    // Copy rather than mutate the parsed body's invoice object directly —
    // Bun/JavaScriptCore has thrown "Attempted to assign to readonly
    // property" here on some requests, implying the parsed JSON result can
    // come back non-extensible under some condition; a shallow copy sidesteps
    // that regardless of the exact cause.
    const invoice = { ...body.invoice };

    if (body.user) user = body.user;
    if (!user) return bail(c, "user not provided");
    invoice.own = c.get("user")?.username === user.username;

    try {
      const result = await generate({ invoice, user });
      return c.json(result);
    } catch (e) {
      console.trace();
      console.log(e);
      err("problem generating invoice", c.get("user")?.username, body.user?.username, e.message);
      return bail(c, e.message);
    }
  },

  async update(c) {
    try {
      const id = c.req.param("id");
      const body = await c.req.json();
      const { tip, webhook, secret, received: _received } = body.invoice;

      let invoice = await gf(`invoice:${id}`);
      if (!invoice) fail("invoice not found");
      const user = await g(`user:${invoice.uid}`);

      if (typeof tip !== "undefined") {
        const t = Number.parseInt(tip);
        if (!Number.isSafeInteger(t) || t < 0 || t > 2_100_000_000_000_000)
          fail("Invalid tip");
        // Defense-in-depth: never change the tip once the invoice is paid/
        // settled. The primary mint guard is on the credit side (it uses the
        // tip the sender was actually debited); this stops post-settlement
        // tampering. The endpoint stays open by design — payers set tips on
        // merchants' invoices before paying — so we do NOT require ownership.
        if (invoice.received > 0 || invoice.settled)
          fail("Invoice already settled");
        invoice.tip = t;
      }

      if (webhook && secret) {
        if (invoice.uid !== c.get("user")?.id) fail("Unauthorized");
        invoice.webhook = webhook;
        invoice.secret = secret;
      }

      invoice = await generate({ invoice, user });

      await s(`invoice:${id}`, invoice);

      return c.json(invoice);
    } catch (e) {
      return bail(c, e.message);
    }
  },

  async list(c) {
    const user = c.get("user");
    const { id } = user;
    let invoices = await db.lRange(`${id}:invoices`, 0, -1);
    invoices = (await Promise.all(invoices.map((i) => getInvoice(i)))).filter(Boolean);
    return c.json(invoices);
  },

  async sign(c) {
    try {
      const body = await c.req.json();
      const { address, message, type = "bitcoin" } = body;
      const node = rpc(config[type]);

      if (config[type].walletpass)
        await node.walletPassphrase(config[type].walletpass, config[type].walletpassSeconds);

      const signature = await node.signMessage({ address, message });
      return c.json({ signature });
    } catch (e) {
      return bail(c, e.message);
    }
  },
};
