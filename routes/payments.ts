import config from "$config";
import api from "$lib/api";
import { evictUser, requirePin } from "$lib/auth";
import { archive, db, g, gf, gfAll, s, sa } from "$lib/db";
import { getTx } from "$lib/esplora";
import { generate, getUserOffer } from "$lib/invoices";
import { replay } from "$lib/lightning";
import ln from "$lib/ln";
import { err, l, shortError, warn } from "$lib/logging";
import mqtt from "$lib/mqtt";
import {
  build,
  completePayment,
  credit,
  debit,
  processWatchedTx,
  sendInternal,
  sendLightning,
  sendOnchain,
  sendUsdt,
  syncBitcoinVault,
} from "$lib/payments";
import { emit } from "$lib/sockets";
import {
  getBalance,
  getCredit,
  getFundBalance,
  tbConfirm,
  tbDebit,
  tbFundCredit,
  tbFundDebit,
} from "$lib/tb";
import { PaymentType } from "$lib/types";
import { SATS, bail, fail, fields, getClientIp, getInvoice, getPayment, getUser, pick, sats } from "$lib/utils";
import rpc from "@coinos/rpc";
import { timingSafeEqual } from "crypto";
import got from "got";
import { v4, validate as isUuid } from "uuid";

const lq = rpc(config.liquid);

// Constant-time compare — avoids leaking a byte-by-byte match position via
// response timing on secret/signature checks.
const safeEqual = (a: string, b: string) => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA as any, bufB as any);
};

export default {
  async info(c) {
    return c.json(await ln.getinfo());
  },

  async create(c) {
    let body;
    try {
      body = await c.req.json();
    } catch {
      return bail(c, "Invalid request body");
    }
    const user = c.get("user");

    let { amount, hash, fee, fund, memo, payreq, aid, retryFor } = body;
    const balance = await getBalance(user.id);

    try {
      // Reject non-string payreq/hash up front. A client sending a number/object
      // here otherwise reaches a decoder that calls `.startsWith` on it and throws
      // an opaque "n.startsWith is not a function" (logged bare via the catch
      // below). A malformed *string* is fine — it fails later with a clear error.
      if (payreq != null && typeof payreq !== "string")
        fail("Invalid payment request");
      if (hash != null && typeof hash !== "string") fail("Invalid invoice");

      if (typeof amount !== "undefined") {
        amount = Number.parseInt(amount);
        if (amount < 0 || amount > SATS || Number.isNaN(amount)) fail("Invalid amount");
      }

      if (typeof retryFor !== "undefined") {
        retryFor = Number.parseInt(retryFor);
        if (Number.isNaN(retryFor) || retryFor < 5 || retryFor > 300) {
          fail("retryFor must be 5–300 seconds");
        }
      }

      await requirePin({ body, user });

      let p;

      const invoice = await getInvoice(payreq || hash);
      const recipient = invoice ? await getUser(invoice.uid) : undefined;
      if (payreq) {
        if (invoice && recipient.username !== "mint") {
          if (invoice.aid === (aid || user.id)) fail("Cannot send to self");
          hash = payreq;
          if (!amount) ({ amount } = invoice);
        } else {
          p = await sendLightning({ user, pr: payreq, amount, fee, memo, retryFor });
        }
      }

      if (!p) {
        if (hash) {
          const recipientAccount = invoice?.aid ? await g(`account:${invoice.aid}`) : null;
          if (recipientAccount?.pubkey || recipientAccount?.seed) {
            p = await sendOnchain({
              amount: amount || invoice.amount,
              address: invoice.hash,
              user,
            });
          } else {
            p = await sendInternal({
              invoice,
              amount,
              memo,
              recipient,
              sender: user,
            });
          }
        } else if (fund) {
          // Fund ids are meant to be unguessable capability tokens (anyone
          // holding the id can fund/withdraw/manage it) — the client always
          // generates one via crypto.randomUUID(). A non-UUID id here means
          // either a client bug or a client hand-typing a guessable/short
          // name, which defeats that unguessability property. Only gate
          // brand-new funds (an existing fund, however it got its id, keeps
          // working) — getFundBalance() returns null iff the TigerBeetle
          // fund account hasn't been created yet.
          const isNewFund = (await getFundBalance(fund)) === null;
          if (!isUuid(fund) && isNewFund) {
            const ip = getClientIp(c);
            err(`SECURITY: non-uuid fund name "${fund}" by ${user.username}`);
            await evictUser(user, `non-uuid fund name: ${fund}`, ip);
            fail("Invalid fund name");
          }
          // Per-fund kill-switch — see authorize()/take() in this file. Set
          // automatically when the fund's founder is evicted; block adding
          // MORE money to it too, not just withdrawing. Whitelisted callers
          // (trusted ops accounts) are exempt so a fund can still be swept/
          // cleaned up deliberately, same exemption debit()'s own frozen/
          // limit checks already give them.
          if (await g(`fund:${fund}:disabled`)) {
            const whitelisted = await db.sIsMember("whitelist", user.username?.toLowerCase().trim());
            if (!whitelisted) fail("This fund has been disabled");
          }
          // Freeze only blocks ESTABLISHING a brand-new fund, not funding an
          // existing one — take()/authorize() (gift-link claims, adding to a
          // fund someone's already sharing) stay unaffected by a freeze, since
          // those are ordinary use of funds that already exist, not new
          // exposure being created. Whitelisted accounts are exempt.
          if (isNewFund && ((await g("hardfreeze")) || (await g("freeze")))) {
            const whitelisted = await db.sIsMember("whitelist", user.username?.toLowerCase().trim());
            if (!whitelisted) fail("Fund creation temporarily disabled");
          }
          p = await debit({
            hash: v4(),
            amount,
            memo: fund,
            user,
            type: PaymentType.fund,
          });
          await tbFundCredit(fund, amount);
          await db.lPush(`fund:${fund}:payments`, p.id);
          await db.sAdd(`user:${user.id}:funds`, fund);
          l("funded fund", fund);
        }
      }

      return c.json(p);
    } catch (e) {
      // One line, with the reason attached to the context. The separate
      // err(shortError(e.message)) that used to follow logged the bare
      // message with no user, amount, or invoice — at error level, so a
      // routine freeze rejection read as "Problem sending payment" with
      // nothing to tie it to. payreq is a full bolt11 (~700 chars) and was
      // printed in full on every attempt; last 8, as elsewhere.
      warn(
        user.username,
        "payment failed",
        amount,
        balance,
        hash,
        payreq?.slice(-8),
        shortError(e.message),
      );
      return bail(c, e.message);
    }
  },

  async list(c) {
    const user = c.get("user");
    try {
      let { id } = user;
      let aid = c.req.query("aid");
      const start = c.req.query("start");
      const end = c.req.query("end");
      let limit = c.req.query("limit");
      let offset = c.req.query("offset");
      const received = c.req.query("received");

      if (!aid || aid === "undefined") aid = id;

      const index = await db.lPos(`${id}:accounts`, aid);
      if (index === null) fail("unauthorized");

      limit = Number.parseInt(limit);
      offset = Number.parseInt(offset) || 0;

      const range = !limit || received || start || end ? -1 : limit - 1;
      const listKey = `${aid || id}:payments`;
      let payments = (await db.lRange(listKey, 0, range)) || [];

      if (range === -1) {
        const archived = (await archive.lRange(listKey, 0, -1)) || [];
        payments = [...new Set([...payments, ...archived])];
      } else if (limit) {
        const needed = Math.max(0, limit + offset - payments.length);
        if (needed > 0) {
          const archived = (await archive.lRange(listKey, 0, limit + offset - 1)) || [];
          payments = [...new Set([...payments, ...archived])];
        }
      }

      // Note: a missing payment is only logged, never removed from the list
      // (upstream 13372a9e) — a transient lookup miss (e.g. archive-fallback
      // lag) previously caused permanent, silent data loss when it deleted
      // the reference from listKey.
      const paymentKeys = payments.map((pid) => `payment:${pid}`);
      const fetched = await gfAll(paymentKeys);

      const validPayments: any[] = [];

      for (let i = 0; i < fetched.length; i++) {
        const p = fetched[i];
        if (!p) {
          warn("user", id, "missing payment", payments[i]);
          continue;
        }
        if (p.revertedDuplicate) continue;
        if (received && p.amount < 0) continue;
        if (p.created < start || p.created > end) continue;
        validPayments.push(p);
      }

      const internalRefs = [
        ...new Set(
          validPayments.filter((p) => p.type === PaymentType.internal && p.ref).map((p) => p.ref),
        ),
      ];

      if (internalRefs.length) {
        const userKeys = internalRefs.map((ref) => `user:${ref}`);
        const users = await gfAll(userKeys);
        const userMap = new Map<string, any>();
        for (let i = 0; i < internalRefs.length; i++) {
          let u = users[i];
          if (typeof u === "string") u = await g(`user:${u}`);
          if (u) userMap.set(internalRefs[i], fields ? pick(u, fields) : u);
        }
        for (const p of validPayments) {
          if (p.type === PaymentType.internal && p.ref) p.with = userMap.get(p.ref);
        }
      }

      payments = validPayments.sort((a, b) => b.created - a.created);

      const fn = (a, b) => ({
        ...a,
        [b.currency]: {
          tips: (a[b.currency] ? a[b.currency].tips : 0) + (b.tip || 0),
          fiatTips: (
            Number.parseFloat(a[b.currency] ? a[b.currency].fiatTips : 0) +
            ((b.tip || 0) * b.rate) / SATS
          ).toFixed(2),
          sats:
            (a[b.currency] ? a[b.currency].sats : 0) +
            (b.amount || 0) +
            (b.tip || 0) -
            (b.fee || 0) -
            (b.ourfee || 0),
          fiat: (
            Number.parseFloat(a[b.currency] ? a[b.currency].fiat : 0) +
            (((b.amount || 0) +
              ((b.amount > 0 ? b.tip : -b.tip) || 0) -
              (b.fee || 0) -
              (b.ourfee || 0)) *
              b.rate) /
              SATS
          ).toFixed(2),
        },
      });

      const incoming = payments.filter((p: any) => p.amount > 0).reduce(fn, {});
      const outgoing = payments.filter((p: any) => p.amount < 0).reduce(fn, {});

      const { length: count } = payments;
      if (limit) payments = payments.slice(offset, offset + limit);

      return c.json({ payments, count, incoming, outgoing });
    } catch (e: any) {
      warn("problem listing payments", user?.username, e.message);
      return bail(c, e.message);
    }
  },

  async get(c) {
    try {
      const hash = c.req.param("hash");
      const p = await getPayment(hash);
      if (p?.type === PaymentType.internal) p.with = await getUser(p.ref, fields);
      if (p?.type === PaymentType.fund) p.with = await getUser(p.uid, fields);
      return c.json(p);
    } catch (e) {
      console.log(e);
      err("failed to get payment", e.message);
      return bail(c, e.message);
    }
  },

  async parse(c) {
    const body = await c.req.json();
    const { payreq } = body;
    const user = c.get("user");
    try {
      const hour = 1000 * 60 * 60;
      let nodes = await g("nodes");
      const { last } = nodes || {};

      if (!last || last > Date.now() - hour) {
        ({ nodes } = await ln.listnodes());
        nodes.last = Date.now();
        await s("nodes", nodes);
      }

      const decoded = await ln.decode(payreq);

      let amount_msat;
      let payee;

      if (decoded.type === "bolt12 offer") {
        ({ offer_amount_msat: amount_msat } = decoded);
        payee = decoded.offer_issuer_id || decoded.offer_node_id;
      } else if (decoded.type.includes("bolt12")) {
        ({ invoice_amount_msat: amount_msat, invoice_node_id: payee } = decoded);
      } else ({ amount_msat, payee } = decoded);

      const node = nodes.find((n) => n.nodeid === payee);
      const alias = node ? node.alias : (payee || "").substr(0, 12);

      const amount = Math.round((amount_msat || 0) / 1000);
      let ourfee = Math.round(amount * config.fee[PaymentType.lightning]);
      const creditBal = await getCredit(user.id, "lightning");
      const covered = Math.min(creditBal, ourfee) || 0;
      ourfee -= covered;

      return c.json({
        alias,
        amount,
        ourfee,
        type: decoded.type,
        description: decoded.offer_description || decoded.description,
      });
    } catch (e) {
      console.log(e);
      err("problem parsing", e.message);
      return bail(c, e.message);
    }
  },

  async funds(c) {
    const user = c.get("user");
    const fundIds = [...(await db.sMembers(`user:${user.id}:funds`))].map(String);

    const funds = await Promise.all(
      fundIds.map(async (id) => {
        const amount = await getFundBalance(id);
        if (amount === null) return null;
        const managers = [...((await db.sMembers(`fund:${id}:managers`)) as string[])];
        return { id, amount, managed: managers.includes(user.id), managers: managers.length };
      }),
    );

    return c.json(funds.filter(Boolean));
  },

  async fund(c) {
    try {
      const id = c.req.param("id");
      let amount = await getFundBalance(id);
      let fid = id;

      // A rotated fund no longer exists at its OLD id (security fix 2026-08-25:
      // fund secret uids were rotated to invalidate an exfiltrated id list). Serve
      // the new fund ONLY to an authenticated MANAGER of it — never anonymously or
      // to a non-owner. An open old->new redirect would defeat the rotation, since
      // the attacker holds the leaked OLD ids; gating on manager membership means a
      // replayed old id reveals nothing unless you already control the fund. The
      // route's `optional` auth populates c.get("user") without requiring it.
      // Bearer funds (no managers) are intentionally not recoverable this way.
      if (amount === null) {
        const rotatedTo = await g(`fund:rotated:${id}`);
        const uid = c.get("user")?.id;
        if (rotatedTo && uid && (await db.sIsMember(`fund:${rotatedTo}:managers`, uid))) {
          fid = rotatedTo;
          amount = await getFundBalance(rotatedTo);
        }
      }

      if (amount === null) return bail(c, "fund not found");

      let payments = (await db.lRange(`fund:${fid}:payments`, 0, -1)) || [];
      payments = await Promise.all(payments.map((hash) => gf(`payment:${hash}`)));
      // Filter out stale/missing payment ids BEFORE looking up .user on each —
      // a dangling id in fund:<id>:payments resolves to null here, and
      // assigning p.user on a null payment crashed with "null is not an
      // object (evaluating 'p.uid')".
      payments = payments.filter((p) => p);

      await Promise.all(payments.map(async (p: any) => (p.user = await getUser(p.uid, fields))));

      const authIds = (await db.lRange(`fund:${fid}:authorizations`, 0, -1)) || [];
      const allAuths = await Promise.all(authIds.map((authId) => g(`authorization:${authId}`)));
      const authorizations = allAuths.filter((a) => a && !a.claimed);
      return c.json({
        amount,
        authorizations,
        payments,
        ...(fid !== id ? { id: fid, rotatedFrom: id } : {}),
      });
    } catch (e: any) {
      err("problem fetching fund", c.req.param("id"), e.message);
      return bail(c, e.message);
    }
  },

  async authorize(c) {
    const user = c.get("user");
    try {
      // Kill-switch for the fund/authorize/take mechanism (SECURITY 2026-08-25:
      // the /take fund-claim path could pay out unbacked balance). Set redis
      // `fund:disabled` to fail all fund authorizations closed while the
      // mechanism is audited/rewritten.
      if (await g("fund:disabled")) fail("Fund transfers temporarily disabled");

      const { id: uid } = user;
      const body = await c.req.json();
      const { id, fiat, currency, amount } = body;

      // Per-fund kill-switch: set automatically (see lib/auth.ts's
      // evictUser()/isEvicted()) when the fund's founder is evicted, since a
      // fund's own balance check has no other way to know that. Whitelisted
      // callers are exempt — see the same check in create()'s fund branch.
      if (await g(`fund:${id}:disabled`)) {
        const whitelisted = await db.sIsMember("whitelist", user.username?.toLowerCase().trim());
        if (!whitelisted) fail("This fund has been disabled");
      }

      const managers = [...(await db.sMembers(`fund:${id}:managers`))];
      if (managers.length && !managers.includes(uid)) fail("Unauthorized");

      // The authorization's fiat/currency is the ONLY ceiling on how much a later
      // /take can pull from the authorizer (cap = sats(fiat / rates[currency])).
      // Reject a NaN/zero/non-finite rate or a non-positive fiat so the ceiling
      // can never be turned into an astronomically large or non-finite value.
      const rates = await g("rates");
      const rate = Number(rates?.[currency]);
      const fiatAmount = Number(fiat);
      if (!Number.isFinite(rate) || rate <= 0) fail("Invalid currency");
      if (!Number.isFinite(fiatAmount) || fiatAmount <= 0) fail("Invalid amount");

      const authId = v4();
      const authorization = {
        authId,
        fundId: id,
        uid,
        currency,
        fiat: fiatAmount,
        amount: Number.parseInt(amount) || 0,
        created: Date.now(),
      };

      await s(`authorization:${authId}`, authorization);
      await db.lPush(`fund:${id}:authorizations`, authId);
      return c.json({ authId });
    } catch (e: any) {
      warn("problem authorizing fund", user?.username, e.message);
      return bail(c, e.message);
    }
  },

  async listAuthorizations(c) {
    const id = c.req.param("id");
    const authIds = (await db.lRange(`fund:${id}:authorizations`, 0, -1)) || [];
    const allAuths = await Promise.all(authIds.map((authId) => g(`authorization:${authId}`)));
    const authorizations = allAuths.filter((a) => a && !a.claimed);
    return c.json(authorizations);
  },

  async deleteAuthorization(c) {
    const user = c.get("user");
    try {
      const id = c.req.param("id");
      const authId = c.req.param("authId");

      const managers = [...(await db.sMembers(`fund:${id}:managers`))];
      if (managers.length && !managers.includes(user.id)) fail("Unauthorized");

      const authorization = await g(`authorization:${authId}`);
      if (!authorization || authorization.fundId !== id) return bail(c, "Authorization not found");
      if (authorization.claimed) return bail(c, "Authorization already claimed");

      await db.lRem(`fund:${id}:authorizations`, 0, authId);
      await db.del(`authorization:${authId}`);
      return c.json({});
    } catch (e: any) {
      warn("problem deleting fund authorization", user?.username, e.message);
      return bail(c, e.message);
    }
  },

  async take(c) {
    const body = await c.req.json();
    const user = c.get("user");
    let { id, amount, invoice: iid, authId } = body;
    try {
      // Kill-switch — see authorize().
      if (await g("fund:disabled")) fail("Fund transfers temporarily disabled");
      // Per-fund kill-switch — see authorize(). Whitelisted callers are
      // exempt so a tainted fund can still be deliberately swept/cleaned up.
      if (await g(`fund:${id}:disabled`)) {
        const whitelisted = await db.sIsMember("whitelist", user.username?.toLowerCase().trim());
        if (!whitelisted) fail("This fund has been disabled");
      }

      amount = Number.parseInt(amount);
      if (!Number.isFinite(amount) || amount <= 0) fail("Invalid amount");

      const rates = await g("rates");

      if (!iid) {
        const inv = await generate({
          invoice: { amount, type: "lightning" },
          user,
        });
        iid = inv.id;
      }

      let authorization;
      if (authId) {
        authorization = await g(`authorization:${authId}`);
        if (authorization && authorization.fundId !== id) authorization = null;
      } else {
        const authIds = (await db.lRange(`fund:${id}:authorizations`, 0, -1)) || [];
        for (const aid of authIds) {
          const auth = await g(`authorization:${aid}`);
          if (auth && !auth.claimed) {
            authorization = auth;
            authId = aid;
            break;
          }
        }
      }

      if (authorization && !authorization.claimed) {
        const { currency, fiat } = authorization;
        // Bound the take to the authorized fiat value using a VALIDATED fiat
        // rate. A non-finite/zero rate or a crypto-denominated authorization
        // (rate ~1) would otherwise make sats(fiat / rate) an astronomically
        // large ceiling, defeating the cap (the drain vector).
        const rate = Number(rates?.[currency]);
        const fiatAmount = Number(fiat);
        if (!Number.isFinite(rate) || rate <= 0)
          fail("Invalid authorization currency");
        if (!Number.isFinite(fiatAmount) || fiatAmount <= 0)
          fail("Invalid authorization amount");
        const cap = sats(fiatAmount / rate);
        if (!Number.isFinite(cap) || cap <= 0) fail("Invalid authorization");
        amount = Math.min(amount, cap);
        if (!Number.isFinite(amount) || amount <= 0) fail("Invalid amount");

        // Atomic single-use claim. The read above is not a lock: concurrent
        // POST /take for the same authorization all pass the `!claimed` gate and,
        // without an atomic gate, each would debit the authorizer and fund the
        // pool — redeeming a single-use authorization N times (COINOS-3). SET NX
        // lets exactly one caller win the claim; the rest skip the funding.
        const claimed = await db.set(`authorization:${authId}:claimed`, user.id, {
          NX: true,
        });
        if (claimed) {
          // Mark the record claimed only once the funding has actually landed,
          // and release the claim if it throws — otherwise a failed funding
          // (an insufficient balance, a server limit) burns the authorization
          // permanently: the key is set, the fund never gets the money, and
          // every later /take skips the funding block.
          try {
            const sender = await getUser(authorization.uid);
            if (!sender) fail("authorizer not found");

            const { hash } = await generate({
              invoice: { amount, type: "lightning" },
              user: sender,
            });

            const { id: pid } = await debit({
              hash,
              amount,
              memo: id,
              user: sender,
              type: PaymentType.fund,
            });

            await tbFundCredit(id, amount);
            await db.lPush(`fund:${id}:payments`, pid);
            await db.sAdd(`user:${sender.id}:funds`, id);

            authorization.claimed = true;
            await s(`authorization:${authId}`, authorization);
            l("funded fund", id);
          } catch (e) {
            await db.del(`authorization:${authId}:claimed`);
            throw e;
          }
        }
      }

      const managers = [...(await db.sMembers(`fund:${id}:managers`))];
      if (managers.length && !managers.includes(user.id)) fail("Unauthorized");

      const result: any = await tbFundDebit(id, amount, "Insufficient funds");
      if (result.err) fail(result.err);

      const payment = await credit({
        aid: user.id,
        hash: iid,
        amount,
        memo: id,
        ref: id,
        type: PaymentType.fund,
      });

      await db.lPush(`fund:${id}:payments`, payment.id);
      await db.sAdd(`user:${user.id}:funds`, id);

      return c.json(payment);
    } catch (e) {
      warn("problem withdrawing from fund", user.username, e.message);
      return bail(c, e.message);
    }
  },

  async managers(c) {
    const name = c.req.param("name");

    const ids = [...(await db.sMembers(`fund:${name}:managers`))];

    const managers = (await Promise.all(ids.map(async (id) => await getUser(id, fields)))).filter(
      Boolean,
    );

    return c.json(managers);
  },

  async addManager(c) {
    const user = c.get("user");
    try {
      const body = await c.req.json();
      const { id, username } = body;

      const k = `fund:${id}:managers`;

      let managers: any[] = [...(await db.sMembers(k))];
      if (managers.length) {
        if (!managers.includes(user.id)) fail("Unauthorized");
      } else {
        // No managers yet usually means this call is establishing a brand-new
        // fund (the caller becomes its founding manager) — same unguessable-id
        // requirement as the /payments fund-creation path above. But a fund
        // can also predate that requirement or legitimately have real balance
        // with no manager registered yet (a "bearer" fund) — only reject when
        // BOTH signals agree this fund has never existed at all, so a
        // grandfathered non-UUID fund can still register its first manager.
        if (!isUuid(id) && (await getFundBalance(id)) === null) {
          const ip = getClientIp(c);
          err(`SECURITY: non-uuid fund name "${id}" by ${user.username}`);
          await evictUser(user, `non-uuid fund name: ${id}`, ip);
          fail("Invalid fund name");
        }
        await db.sAdd(k, user.id);
      }

      const u = await getUser(username, fields);
      if (!u) fail("User not found");
      const { id: uid } = u;

      await db.sAdd(k, uid);

      const ids = [...(await db.sMembers(k))];
      if (!managers.length)
        managers = await Promise.all(ids.map(async (id) => await getUser(id, fields)));

      return c.json(managers);
    } catch (e: any) {
      warn("problem adding fund manager", user?.username, e.message);
      return bail(c, e.message);
    }
  },

  async deleteManager(c) {
    try {
      const name = c.req.param("name");
      const body = await c.req.json();
      const { id: uid } = body;
      const user = c.get("user");

      const k = `fund:${name}:managers`;
      let managers: any[] = [...(await db.sMembers(k))];

      if (managers.length) {
        if (!managers.includes(user.id)) fail("Unauthorized");
      }

      await db.sRem(k, uid);

      const ids = [...(await db.sMembers(k))];
      managers = await Promise.all(ids.map(async (id) => await getUser(id, fields)));

      return c.json(managers);
    } catch (e: any) {
      warn("problem deleting fund manager", e.message);
      return bail(c, e.message);
    }
  },

  async confirm(c) {
    const body = await c.req.json();
    const { txid, type, secret } = body;
    // bitcoind/elementsd's walletnotify substitutes %w with a shell-quoted
    // value, so the JSON body can arrive with literal surrounding quotes
    // (e.g. "'boltz'" instead of "boltz"). Strip them defensively.
    const wallet = String(body.wallet ?? "").replace(/^['"]|['"]$/g, "");

    if (type !== PaymentType.liquid && type !== PaymentType.bitcoin) return c.json({});

    // walletnotify is global to the daemon — it fires for every wallet
    // on the node, not just ours. Silently ignore wallets we don't manage,
    // otherwise we'd try (and fail) to RPC into wallets like 'boltz',
    // 'peerswap', etc.
    const ourWallet = (config as any)[type]?.wallet;
    if (ourWallet && wallet && wallet !== ourWallet) return c.json({});

    try {
      // Was checked against config.adminpass — the same credential that
      // grants admin login/impersonation and controls /freeze. walletnotify
      // puts this secret on a shell command line in bitcoin.conf (visible
      // via `ps` while it runs) and sends it over plain HTTP; it must never
      // double as the admin password.
      if (!config.txWebhookSecret || !safeEqual(secret || "", config.txWebhookSecret))
        fail("unauthorized");

      const node = rpc({ ...config[type], wallet });
      let tx;
      try {
        tx = await node.getTransaction(txid);
      } catch (e: any) {
        // RPC_WALLET_NOT_FOUND (-18): wallet was unloaded between
        // walletnotify-fire and our call. Attempt loadwallet once and retry.
        const notLoaded = e?.code === -18 || /not loaded|does not exist/i.test(e?.message || "");
        if (!notLoaded) throw e;

        warn(`confirm: wallet "${wallet}" not loaded, attempting loadwallet`);
        const { host, port, user, password } = (config as any)[type];
        const token = btoa(`${user}:${password}`);
        const loadRes = await fetch(`http://${host}:${port}/`, {
          method: "POST",
          headers: { authorization: `Basic ${token}` },
          body: JSON.stringify({ method: "loadwallet", params: [wallet] }),
        }).then((r) => r.json());
        // -4 / "already loaded" means it just got loaded by someone else — fine.
        if (
          loadRes?.error &&
          loadRes.error.code !== -4 &&
          !/already loaded/i.test(loadRes.error.message || "")
        ) {
          throw loadRes.error;
        }
        tx = await node.getTransaction(txid);
      }
      const { confirmations, details } = tx;

      // Change-recredit guard (2026-08-18). If our own wallet contributed inputs
      // to this transaction, a "send" detail is present. In that case every
      // receive output is our own CHANGE or an internal move — never an external
      // deposit — so it must not be credited: doing so mints phantom balance
      // (the withdrawal-change re-credit exploit that drove the L-C creep). A
      // genuine coinos->coinos transfer is settled off-chain in the send path
      // (credit() resolves getInvoice(hash) and books an internal transfer), so
      // an on-chain receive funded by our own spend is only ever change.
      const weSpent = details.some((d: any) => d.category === "send");

      for (const { address, amount, asset, category, vout } of details) {
        if (!address) continue;
        if (category === "send") continue;

        let isUsdt = false;
        if (type === PaymentType.liquid) {
          const isLbtc = asset === config.liquid.btc;
          isUsdt = asset === (config.liquid as any).usdt;
          if (!isLbtc && !isUsdt) continue;
        }
        // Bitcoin tx details have no `asset` field — every non-send output
        // is a BTC receive, nothing to filter.

        // See weSpent above: a receive output on a transaction our wallet funded
        // is change, not a deposit. Skip it so we never re-credit our own funds.
        // Log the blocked amount as a tripwire: sums the phantom credit prevented
        // and surfaces any continued exploitation attempts.
        if (weSpent) {
          if (sats(amount) >= 300)
            warn("blocked change re-credit", txid, vout, sats(amount), address);
          continue;
        }

        const p = await getPayment(`${txid}:${vout}`);

        if (!p) {
          await getInvoice(address);

          let creditAmount: number;
          let extraFields: Record<string, any> = {};

          if (isUsdt) {
            const rates = await g("rates");
            let walkRate = 0;
            try {
              const book = (await got(
                "https://api-pub.bitfinex.com/v2/book/tBTCUST/P0?len=25",
              ).json()) as [number, number, number][];
              const asks = book
                .filter(([, , a]) => a < 0)
                .map(([p, , a]) => [p, Math.abs(a)] as [number, number])
                .sort((a, b) => a[0] - b[0]); // ascending: cheapest asks first
              let usdtFilled = 0;
              let btcTotal = 0;
              for (const [price, btcSize] of asks) {
                const usdtTake = Math.min(price * btcSize, amount - usdtFilled);
                btcTotal += usdtTake / price;
                usdtFilled += usdtTake;
                if (usdtFilled >= amount) break;
              }
              if (btcTotal > 0) walkRate = usdtFilled / btcTotal;
            } catch (e) {
              err("bitfinex book error", e.message);
            }
            const usdtRate = walkRate || rates["USD"];
            const effectiveRate = usdtRate * (1 + (config.fee as any).usdt);
            creditAmount = Math.round((amount / effectiveRate) * SATS);
            extraFields = {
              assetAmount: amount,
              assetType: "USDT",
            };
            l("usdt received", amount, "USDT →", creditAmount, "sats after fee");
          } else {
            creditAmount = sats(amount);
          }

          if (creditAmount < 300) continue;

          const lockKey = `lock:${txid}:${vout}`;
          const locked = await db.setNX(lockKey, "1");
          if (!locked) continue;
          await db.expire(lockKey, 60);

          await credit({
            hash: address,
            amount: creditAmount,
            ref: `${txid}:${vout}`,
            type,
            ...extraFields,
          });
        } else if (confirmations >= 1) {
          // Atomic guard against concurrent /confirm callers double-crediting:
          // walletnotify, catchUp, and bulk sweeps can all fire for the same
          // txid:vout in parallel. Without this, two callers can each read
          // p.confirmed=false and each run the multi() that increments balance.
          const lockKey = `confirmlock:${txid}:${vout}`;
          const acquired = await db.set(lockKey, "1", { NX: true, EX: 60 });
          if (!acquired) continue;

          if (p.confirmed) {
            await db.del(lockKey);
            continue;
          }

          const invoice = await getInvoice(address);
          if (!invoice) {
            await db.del(lockKey);
            continue;
          }

          p.confirmed = true;
          invoice.received += Number.parseInt(invoice.pending);
          invoice.pending = 0;

          l("confirming", p.id, p.amount);

          await tbConfirm(p.aid || p.uid, p.amount);

          await db
            .multi()
            .set(`invoice:${invoice.id}`, JSON.stringify(invoice))
            .set(`payment:${p.id}`, JSON.stringify(p))
            .exec();

          // Mirror the now-confirmed record into arc so a future bulk sweep
          // finds it via gf() fallback even if the main-db pointer is wiped
          // (see feedback_apr29_double_credit_incident.md).
          await sa(`payment:${p.id}`, p);
          await sa(`invoice:${invoice.id}`, invoice);

          await db.del(lockKey);

          const user = await g(`user:${p.uid}`);
          await completePayment(invoice, p, user);
        }
      }
      return c.json({});
    } catch (e: any) {
      console.log(e);
      warn(`problem processing ${txid}`, e?.message ?? String(e));
      return bail(c, e.message);
    }
  },

  async txWebhook(c) {
    const body = await c.req.json();
    const { txid, secret } = body || {};
    const headerSecret = c.req.header("x-hook-secret");
    const hookSecret = secret || headerSecret;

    try {
      if (config.txWebhookSecret && !safeEqual(hookSecret || "", config.txWebhookSecret))
        fail("unauthorized");
      if (!txid) fail("missing txid");

      const tx = await getTx(txid);
      await processWatchedTx(tx);

      return c.json({});
    } catch (e) {
      warn("problem processing tx webhook", e.message);
      return bail(c, e.message);
    }
  },

  async fee(c) {
    const body = await c.req.json();
    const user = c.get("user");
    try {
      return c.json(await build({ ...body, user }));
    } catch (e) {
      warn("problem estimating fee", e.message, user.username, body.amount, body.address);
      let msg = e.message;
      if (msg.includes("500")) msg = "";
      return bail(c, `Failed to prepare transaction ${msg}`);
    }
  },

  async send(c) {
    const body = await c.req.json();
    const user = c.get("user");
    try {
      await requirePin({ body, user });
      const { hash: txid } = await sendOnchain({ ...body, user });
      const pid = await g(`payment:${txid}`);
      const p = await g(`payment:${pid}`);

      return c.json(p);
    } catch (e) {
      warn(user.username, "payment failed", shortError(e.message));
      return c.json(e.message, 500);
    }
  },

  async freeze(c) {
    try {
      let body: any;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      const secret = body?.secret;
      if (typeof secret !== "string" || !secret) {
        return c.json({ error: "missing secret" }, 400);
      }
      if (!config.adminpass || secret !== config.adminpass) {
        return c.json({ error: "unauthorized" }, 401);
      }
      await s("freeze", true);
      return c.json({ ok: true });
    } catch (e: any) {
      console.log(e);
      return c.json({ error: e?.message ?? "internal error" }, 500);
    }
  },

  async print(c) {
    const body = await c.req.json();
    const { id } = body;
    const user = c.get("user");
    try {
      const p = await gf(`payment:${id}`);
      if (!p) fail("Payment not found");
      if (p.uid !== user.id) fail("unauthorized");
      emit(user.id, "payment", p);

      const { username } = user;

      mqtt.publish(username, `pay:${p.amount}:${p.tip}:${p.rate}:${p.created}:${p.id}`);

      return c.json({ ok: true });
    } catch (e) {
      return bail(c, e.message);
    }
  },

  async lnaddress(c) {
    const body = await c.req.json();
    const user = c.get("user");
    let lnaddress = c.req.param("lnaddress");
    let amount = c.req.param("amount");
    const { fee } = body;
    try {
      lnaddress = decodeURIComponent(lnaddress);
      await requirePin({ body, user });

      const [username, domain] = lnaddress.split("@");
      const { minSendable, maxSendable, callback, metadata } = (await got(
        `https://${domain}/.well-known/lnurlp/${username}`,
      ).json()) as any;

      if (amount * 1000 < minSendable || amount * 1000 > maxSendable) fail("amount out of range");

      // LNURL-pay metadata is a JSON-encoded array of [mime, value] tuples
      // (LUD-06). Extract text/plain if the recipient set one.
      let description = "";
      try {
        const arr = JSON.parse(metadata);
        description = arr.find((e: any) => Array.isArray(e) && e[0] === "text/plain")?.[1] || "";
      } catch {}
      const memo =
        description && description !== lnaddress
          ? `Paid to ${lnaddress}: ${description}`
          : `Paid to ${lnaddress}`;

      const r: any = await got(`${callback}?amount=${amount * 1000}`).json();
      if (r.reason) fail(r.reason);
      const { pr } = r;

      const { payee } = await ln.decode(pr);
      const { id } = await ln.getinfo();

      let p;
      if (payee === id) {
        p = await debit({ hash: pr, amount, memo, user });
        await credit({ hash: pr, amount, memo, ref: user.id, tip: p.tip });
      } else p = await sendLightning({ user, pr, amount, fee, memo });

      return c.json(p);
    } catch (e) {
      console.log(e);
      return bail(c, e.message);
    }
  },

  async bump(c) {
    const body = await c.req.json();
    const { id } = body;
    const user = c.get("user");
    try {
      const p = await gf(`payment:${id}`);
      if (!p) fail("Payment not found");
      if (p.uid !== user.id) fail("unauthorized");
      if (p.confirmed) fail("transaction already confirmed");
      if (p.type !== PaymentType.bitcoin) fail("only bitcoin transactions can be bumped");

      const fees: any = await fetch(api.fees).then((r) => r.json());
      const targetFeeRate = Math.max(Math.ceil(fees.fastestFee), (p.feeRate || 0) + 1);

      const bc = rpc(config.bitcoin);
      if (config["bitcoin"].walletpass)
        await bc.walletPassphrase(
          config["bitcoin"].walletpass,
          config["bitcoin"].walletpassSeconds,
        );
      const result = await bc.bumpfee(p.hash, { fee_rate: targetFeeRate });
      if (result.errors?.length) fail(result.errors[0]);

      const newFee = sats(result.fee);
      const oldFee = sats(result.origfee);
      const feeDiff = newFee - oldFee;

      const oldHash = p.hash;
      p.hash = result.txid;
      p.fee = newFee;
      p.feeRate = targetFeeRate;
      await s(`payment:${p.id}`, p);
      await s(`payment:${result.txid}`, p.id);
      await db.del(`payment:${oldHash}`);

      if (feeDiff > 0)
        await tbDebit(
          p.uid,
          p.uid,
          "bitcoin",
          0,
          0,
          feeDiff,
          0,
          0,
          "Insufficient funds for bump fee",
        );

      return c.json({ txid: result.txid, fee: newFee });
    } catch (e) {
      err("failed to bump payment", id, e.message);
      return bail(c, e.message);
    }
  },

  async internal(c) {
    const body = await c.req.json();
    const { username, amount } = body;
    const sender = c.get("user");

    try {
      // debit()'s own frozen check exempts type=internal outright (only
      // hardfreeze blocks it there) — tighten that here: a soft freeze
      // should still pause user-to-user transfers for non-whitelisted
      // accounts, since this is a fresh transfer of value between accounts,
      // not claiming an already-established fund (see create()'s fund
      // branch / take() for why those stay unaffected by a freeze).
      if ((await g("hardfreeze")) || (await g("freeze"))) {
        const whitelisted = await db.sIsMember("whitelist", sender.username?.toLowerCase().trim());
        if (!whitelisted) fail("Internal transfers temporarily disabled");
      }

      const recipient = await getUser(username);
      // sendInternal -> generate() throws the far less clear "user not
      // provided" for this same case, uncaught here until now — fail with a
      // reason a caller can actually act on.
      if (!recipient) fail("recipient not found");
      return c.json(await sendInternal({ amount, sender, recipient }));
    } catch (e: any) {
      warn(sender?.username, "internal send failed", username, e.message);
      return bail(c, e.message);
    }
  },

  async decode(c) {
    const bolt11 = c.req.param("bolt11");
    return c.json(await ln.decode(bolt11));
  },

  // The user's standing bolt12 offer (lno1...) — reusable receive code they
  // can publish (e.g. in a nostr kind 10058 list for bolt12 zaps)
  async offer(c) {
    try {
      const user = c.get("user");
      return c.json(await getUserOffer(user));
    } catch (e) {
      return bail(c, e.message);
    }
  },

  async fetchinvoice(c) {
    const body = await c.req.json();
    const { amount, offer, payer_note } = body;
    return c.json(
      await ln.fetchinvoice({
        offer,
        amount_msat: amount ? amount * 1000 : undefined,
        payer_note,
        timeout: 60,
      }),
    );
  },

  async auth(c) {
    const query = c.req.query();
    console.log(query);
    return c.json(query);
  },

  async order(c) {
    const body = await c.req.json();
    console.log(body);
    return c.json(body);
  },

  async sendinvoice(c) {
    try {
      const user = c.get("user");
      const body = await c.req.json();
      const { invreq } = body;

      const { amount_msat, bolt12, pay_index } = await ln.sendinvoice({
        invreq,
        label: v4(),
      });

      await generate({
        invoice: {
          amount: Math.round(amount_msat / 1000),
          type: "bolt12",
          bolt12,
        },
        user,
      });

      const p = await replay(pay_index);

      return c.json(p);
    } catch (e) {
      return bail(c, e.message);
    }
  },

  async bitcoinSync(c) {
    try {
      const user = c.get("user");
      const { aid } = await c.req.json();
      const { id: uid } = user;

      const pos = await db.lPos(`${uid}:accounts`, aid);
      if (pos === null) return bail(c, "account not found");

      const account = await g(`account:${aid}`);
      if (!account?.pubkey || !account?.fingerprint) return bail(c, "not a bitcoin vault");

      const lockKey = `btcsynclock:${aid}`;
      const gotLock = await db.set(lockKey, "1", { NX: true, EX: 30 });
      if (!gotLock) return c.json({ synced: 0, received: 0, payments: [] });

      try {
        const { pendingTotal, newPayments } = await syncBitcoinVault(account, user);

        let received = 0;
        const payments = [];

        for (const p of newPayments) {
          if (p.amount > 0) {
            received += p.amount;
            payments.push(p);

            const invoiceIds = await db.lRange(`${aid}:invoices`, 0, 20);
            for (const iid of invoiceIds) {
              const inv = await getInvoice(iid);
              if (!inv || inv.type !== "bitcoin") continue;
              if (inv.received >= inv.amount && inv.amount > 0) continue;
              if (inv.amount > 0 && p.amount < inv.amount) continue;
              inv.received = (inv.received || 0) + p.amount;
              p.iid = iid;
              await s(`invoice:${iid}`, inv);
              await s(`payment:${p.id}`, p);
              emit(uid, "payment", p);
              break;
            }
          }
        }

        // Compute balance from payments
        const paymentIds = await db.lRange(`${aid}:payments`, 0, -1);
        const paymentKeys = paymentIds.map((pid) => `payment:${pid}`);
        const allPayments = await gfAll(paymentKeys);
        let balance = 0;
        for (const pay of allPayments) {
          if (pay && pay.confirmed !== false) balance += pay.amount - (pay.fee || 0);
        }
        balance = Math.max(balance, 0);

        return c.json({
          synced: newPayments.length,
          received,
          payments,
          balance,
          pending: pendingTotal,
        });
      } finally {
        await db.del(lockKey);
      }
    } catch (e) {
      return bail(c, e.message);
    }
  },

  async sendUsdt(c) {
    const body = await c.req.json();
    const user = c.get("user");
    try {
      const p = await sendUsdt({ ...body, user });
      return c.json(p);
    } catch (e) {
      warn("usdt send failed", e.message, user.username);
      return bail(c, e.message);
    }
  },

  async usdtBalance(c) {
    try {
      const balances = await lq.getBalance();
      const assetId = (config.liquid as any).usdt;
      const amount = balances[assetId] || 0;
      return c.json({ amount });
    } catch (e) {
      return bail(c, e.message);
    }
  },

  async btcHotBalance(c) {
    try {
      const bc = rpc(config.bitcoin);
      const amount = sats(await bc.getBalance());
      return c.json({ amount });
    } catch (e) {
      return bail(c, e.message);
    }
  },

  async lbtcHotBalance(c) {
    try {
      const balances = await lq.getBalance();
      const amount = sats(balances.bitcoin || balances[config.liquid.btc] || 0);
      return c.json({ amount });
    } catch (e) {
      return bail(c, e.message);
    }
  },
};
