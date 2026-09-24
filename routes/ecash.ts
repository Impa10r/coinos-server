import { db, g, s } from "$lib/db";
import { check, claim, get, mint } from "$lib/ecash";
import { l, warn } from "$lib/logging";
import { credit, debit } from "$lib/payments";
import { emit } from "$lib/sockets";
import { tbDebit } from "$lib/tb";
import { bail, fail, getClientIp, getInvoice } from "$lib/utils";
import { getEncodedToken } from "@cashu/cashu-ts";
import { v4 } from "uuid";

import { PaymentType } from "$lib/types";
const { ecash: type } = PaymentType;

Error.stackTraceLimit = 100;

// A stored token is the target of an /ecash/<id> link, which people do share,
// so this is long enough to stay useful and short enough to be a bound. Real
// tokens are a few hundred bytes; 16KB leaves room for a many-proof token
// without leaving room for an abusive one.
const CASH_TTL = 30 * 24 * 60 * 60;
const MAX_TOKEN = 16 * 1024;

const sendCash = async ({ amount, user }) => {
  const id = v4();
  const hash = v4();

  const p = await debit({ hash, amount, user, type });
  const token = await mint(parseInt(amount));
  p.memo = id;
  const { id: pid } = p;
  await s(`payment:${pid}`, p);
  s(`cash:${id}`, token);

  return { id, token, pid };
};

export default {
  async save(c) {
    const { token } = await c.req.json();
    try {
      // Unauthenticated, and it writes to redis — so it needs its own bounds.
      // It had none: any body, any size (Bun's default cap is 128MB and
      // nothing lowers it), stored forever. That is an anonymous write
      // primitive into the main database, and on an instance with no mint
      // nothing can ever read the keys back. lnurl pointer keys reached ~45%
      // of the database before they were given a TTL (442b4cfe); these have
      // the same absence of expiry with none of the size discipline.
      //
      // The UI only ever posts a string starting with "cashu" (lib/parse.ts),
      // so require that much rather than accepting anything at all.
      if (typeof token !== "string" || !token.startsWith("cashu"))
        fail("not a cashu token");
      if (token.length > MAX_TOKEN) fail("token too large");

      const id = v4();
      await s(`cash:${id}`, token, CASH_TTL);
      return c.json({ id });
    } catch (e) {
      warn("cash save failed", getClientIp(c) ?? "unknown", e.message);
      return bail(c, e.message);
    }
  },

  async get(c) {
    const id = c.req.param("id");
    try {
      const token = await get(id);
      // Unset id — the common case when someone is walking ids rather than
      // following a link they were given. This used to fall through to
      // check(null) and surface cashu-ts's "null is not an object (evaluating
      // 'n.startsWith')" as a 500, which says nothing to the caller and less
      // to us.
      if (!token) {
        l("cash miss", id, getClientIp(c) ?? "unknown");
        return c.json({ error: "Not found" }, 404);
      }
      const status = await check(token);
      return c.json({ token, status });
    } catch (e) {
      // Context, because this route is unauthenticated and every failure here
      // used to log as a bare library message with no route, id, or caller.
      warn("cash get failed", id, getClientIp(c) ?? "unknown", e.message);
      return bail(c, e.message);
    }
  },

  async claim(c) {
    const { token } = await c.req.json();
    const user = c.get("user");
    try {
      const amount = await claim(token);

      const hash = v4();
      const { currency, id: uid } = user;
      const rates = await g("rates");
      await s(`invoice:${hash}`, {
        currency,
        id: hash,
        hash,
        rate: rates[currency],
        uid,
        received: 0,
      });

      await credit({ hash, amount, ref: user.id, type });

      return c.json({ ok: true });
    } catch (e) {
      warn("cash claim failed", user?.username, e.message);
      return bail(c, e.message);
    }
  },

  async mint(c) {
    const body = await c.req.json();
    const user = c.get("user");
    const amount = parseInt(body.amount);
    // Disabled. fail() here escaped to app.onError as an "unhandled error"
    // 500; say so properly instead. The line below is unreachable.
    return c.json({ error: "Minting is disabled" }, 503);
    return c.json(await sendCash({ amount, user }));
  },

  async melt(c) {
    const body = await c.req.json();
    const user = c.get("user");
    let { amount, bolt11: hash, preimage } = body;
    try {
      amount = Math.round(amount / 1000);
      // A negative (or NaN) amount here is a direct ledger-inflation primitive.
      // tbDebit's sufficiency check is `balance - frozen < total`, which any
      // non-negative balance passes trivially against a negative total, and the
      // stored record gets `amount: -amount` — so -N books a credit of N. The
      // caller gate below limits this to the mint service account, but that
      // account is not a trust boundary we want the ledger's integrity resting
      // on. Mirror the check debit() makes in lib/payments.ts; this is the only
      // tbDebit call site that lacked one.
      if (!Number.isFinite(amount) || amount <= 0)
        fail("Amount must be greater than zero");
      const ref = preimage;
      const { lightning: type } = PaymentType;
      if (user.username !== "mint") fail("unauthorized");
      const { id: uid, currency } = user;
      const ourfee = await tbDebit(uid, uid, type, amount || 0, 0, 0, 0, 0, "Insufficient funds");

      const rates = await g("rates");
      const rate = rates[currency];

      if ((ourfee as any).err) fail((ourfee as any).err);

      const id = v4();
      const p = {
        id,
        amount: -amount,
        hash,
        ourfee,
        uid,
        confirmed: true,
        rate,
        currency,
        type,
        ref,
        created: Date.now(),
      };

      await s(`payment:${hash}`, id);
      await s(`payment:${id}`, p);
      await db.lPush(`${uid}:payments`, id);

      l(user.username, "sent", type, amount);
      emit(user.id, "payment", p);

      return c.json(p);
    } catch (e) {
      return bail(c, e.message);
    }
  },

  async receive(c) {
    try {
      const body = await c.req.json();
      const { id, proofs, mint, memo } = body;

      // getInvoice() returns null for an id that doesn't exist, and
      // destructuring that threw "Cannot destructure property 'uid' from null"
      // — an opaque 500 on an unauthenticated route, seen in production. Same
      // omission get() had, answered the same way.
      const invoice = await getInvoice(id);
      if (!invoice) {
        l("ecash receive miss", id, getClientIp(c) ?? "unknown");
        return c.json({ error: "Not found" }, 404);
      }
      const { uid: ref } = invoice;

      const amount = await claim(
        getEncodedToken({
          mint,
          proofs,
        }),
      );

      await credit({ hash: id, amount, memo, ref, type });

      return c.json({ id });
    } catch (e) {
      warn("ecash receive failed", c.req.param("id"), getClientIp(c) ?? "unknown", e.message);
      return bail(c, e.message);
    }
  },
};
