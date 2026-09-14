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
      const id = v4();
      await s(`cash:${id}`, token);
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
      const { uid: ref } = await getInvoice(id);

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
