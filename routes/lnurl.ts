import { db, g, s } from "$lib/db";
import { generate } from "$lib/invoices";
import ln from "$lib/ln";
import { err, l, warn } from "$lib/logging";
import { serverPubkey2 } from "$lib/nostr";
import { assertFundWithdrawable, recordFundWithdrawal } from "$lib/payments";
import { getFundBalance, tbFundCredit, tbFundDebit } from "$lib/tb";
import { SATS, bail, fail, getClientIp, getInvoice, getUser } from "$lib/utils";
import { bech32 } from "bech32";
import { safeGot } from "$lib/safe-fetch";
import { verifyEvent } from "nostr-tools";
import { SocksProxyAgent } from "socks-proxy-agent";
import { v4 } from "uuid";

import { PaymentType } from "$lib/types";

// A payRequest callback id is fetched once, minutes after the metadata
// request, and never again; without an expiry these one-shot pointers were
// ~45% of all keys in the main db.
const LNURL_TTL = 7 * 24 * 60 * 60;

const { URL, LNURL_PROXY } = process.env;
const host = URL.split("/").at(-1);
const fiveMinutes = 1000 * 60 * 5;

const proxyAgent = LNURL_PROXY ? new SocksProxyAgent(LNURL_PROXY) : undefined;

// Every lnurl callback id we hand out is a v4 from lnurlp()/pay(), so an id
// that isn't one can only be a guess. Production logs show /api/lnurl/withdraw
// being walked repeatedly; each hit cost a redis lookup and left an info plus a
// warn line, which is a scanner setting the pace of our own log stream.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// v3 payment addresses (coinos v3 / halwallet) are registered here. Opt-in
// only — no hardcoded default — so a fork/self-hosted instance that isn't
// part of the coinos v3 migration doesn't pay a registrar round-trip (and a
// repeated timeout, since names.coinos.io doesn't know its users at all) on
// every single lnurlp lookup for a name that's obviously local.
const NAMES_URL = process.env.NAMES_URL;

// Does the v3 registrar serve this name? Returns its payRequest, or null.
// Cached briefly: claims change on the order of days, and this sits on the
// payment path for every coinos.io address lookup. Definitive answers
// (payRequest / 404) get the full TTL. A timeout/network failure also gets
// cached, but only for FAIL_TTL (a small fraction of the full TTL) — every
// lnurlp lookup for a purely-local name (e.g. an ops account never claimed
// on v3) was otherwise re-eating the full request timeout on EVERY single
// request during a registrar outage, since an uncached failure means the
// very next lookup pays the same timeout again with no backoff. A short
// failure cache absorbs a burst of requests during an outage without
// remembering a "sick registrar" anywhere near as long as a real answer.
const registrarCache = new Map();
const REGISTRAR_TTL = 60_000;
const REGISTRAR_FAIL_TTL = 10_000;
async function registrarLookup(name: string) {
  if (!NAMES_URL) return null;
  const hit = registrarCache.get(name);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.body;
  try {
    const r = await fetch(
      `${NAMES_URL}/.well-known/lnurlp/${encodeURIComponent(name)}?domain=${host}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (r.ok) {
      const body: any = await r.json();
      if (body?.tag === "payRequest") {
        registrarCache.set(name, { at: Date.now(), ttl: REGISTRAR_TTL, body });
        return body;
      }
    }
    if (r.status === 404) registrarCache.set(name, { at: Date.now(), ttl: REGISTRAR_TTL, body: null });
  } catch (e) {
    warn("names registrar lookup failed for", name, (e as any).message);
    registrarCache.set(name, { at: Date.now(), ttl: REGISTRAR_FAIL_TTL, body: null });
  }
  return null;
}

export default {
  async proxy(c) {
    const url = c.req.query("url");
    if (!url) return bail(c, "url required");
    try {
      const opts = proxyAgent
        ? { agent: { http: proxyAgent as any, https: proxyAgent as any } }
        : {};
      const r = await safeGot(url, opts);
      return c.json(r);
    } catch (e) {
      warn("lnurl proxy failed", url, e.message);
      return bail(c, e);
    }
  },

  async encode(c) {
    const address = c.req.query("address");
    const [name, domain] = address.split("@");
    const url = `https://${domain}/.well-known/lnurlp/${name.toLowerCase().replace(/\s/g, "")}`;

    try {
      const opts = proxyAgent
        ? { agent: { http: proxyAgent as any, https: proxyAgent as any } }
        : {};
      const r = await safeGot(url, opts);
      if (r.tag !== "payRequest") fail("not an ln address");
    } catch {
      const m = `failed to lookup lightning address ${address}`;
      warn(m);
      return bail(c, m);
    }

    const enc = bech32.encode("lnurl", bech32.toWords(Buffer.from(url)), 20000);
    return c.json(enc);
  },

  async decode(c) {
    const text = c.req.query("text");
    try {
      const url = Buffer.from(bech32.fromWords(bech32.decode(text, 20000).words)).toString();

      const opts = proxyAgent
        ? { agent: { http: proxyAgent as any, https: proxyAgent as any } }
        : {};
      const r = await safeGot(url, opts);
      return c.json(r);
    } catch (e) {
      return bail(c, e);
    }
  },

  async lnurlp(c) {
    const username = c.req.param("username");
    const minSendable = c.req.query("minSendable") || 1000;
    const maxSendable = c.req.query("maxSendable") || 100000000000;
    l("lnurlp", username);
    try {
      const name = username
        .replace("lightning:", "")
        .replace(/\s/g, "")
        .replace("=", "")
        .toLowerCase();

      // Resolution order for name@coinos.io — this has flip-flopped twice, so
      // the invariant, in full:
      //   1. A name CLAIMED in the v3 registrar is served by it. That is where
      //      migrated accounts live — their legacy user record still exists
      //      here, so "local account exists" does NOT mean the name is ours —
      //      and also v3-native custom names, which have no local account and
      //      only a npub1* Cloudflare rule redirecting for them today.
      //   2. Otherwise a local account is served locally. Never key this on
      //      `migrated`: register.ts stamps that flag on essentially every
      //      account (it means "don't reserve this name for v3", not "user
      //      moved away").
      //   3. Neither → not found.
      // No loop: step 1 defers only for names the registrar HAS, and the
      // registrar never queries this endpoint for those. If the registrar is
      // unreachable we fall through and serve the local account — a briefly
      // stale destination beats an unpayable address.
      const v3 = await registrarLookup(name);
      if (v3) return c.json(v3);

      const user = await getUser(name);
      if (!user) fail(`User ${username} not found`, 404);
      const { id: uid } = user;

      const metadata = JSON.stringify([
        ["text/plain", `Paying ${username}@${host}`],
        ["text/identifier", `${username}@${host}`],
      ]);

      const id = v4();
      await s(`lnurl:${id}`, uid, LNURL_TTL);

      return c.json({
        allowsNostr: true,
        minSendable,
        maxSendable,
        metadata,
        nostrPubkey: serverPubkey2,
        commentAllowed: 512,
        callback: `${URL}/api/lnurl/${id}`,
        tag: "payRequest",
      });
    } catch (e) {
      if (!e.message.includes("found"))
        warn("problem generating lnurlp request", username, e.message);
      return bail(c, e);
    }
  },

  async lnurl(c) {
    const id = c.req.param("id");
    const amount = c.req.query("amount");
    const comment = c.req.query("comment");
    const nostr = c.req.query("nostr");

    // Answer a guessed id before touching redis, with the exact response the
    // lookup would have produced anyway, so a prober learns nothing new.
    if (!uuid.test(id ?? "")) {
      l("lnurl callback probe", id);
      return bail(c, "user not found");
    }

    l(
      "lnurl callback",
      id,
      "amount",
      amount,
      "comment",
      comment,
      "nostr",
      nostr ? nostr.slice(0, 40) : undefined,
    );
    try {
      const uid = await g(`lnurl:${id}`);
      const user = await getUser(uid);

      if (!user) fail("user not found", 404);
      let { username } = user;
      username = username.replace(/\s/g, "").toLowerCase();

      const memo = comment ?? `Paying ${username}@${host}`;
      let metadata = JSON.stringify([
        ["text/plain", memo],
        ["text/identifier", `${username}@${host}`],
      ]);

      if (nostr) {
        try {
          const event = JSON.parse(decodeURIComponent(nostr));
          // NIP-57: must be a signed kind-9734 zap request. Reject anything
          // else so we can't be tricked into storing a forged zap receipt.
          if (event.kind !== 9734 || !verifyEvent(event))
            throw new Error("invalid zap request");
          await s(`zap:${id}`, event);
          metadata = decodeURIComponent(nostr);
        } catch (e) {
          err("problem handling zap", e.message);
        }
      }

      const invoice = await generate({
        invoice: {
          amount: Math.round(amount / 1000),
          memo: metadata,
          type: PaymentType.lightning,
        },
        user,
      });

      if (comment) {
        // Enforce the commentAllowed:512 we advertise in the lnurlp response.
        // This overwrite happens after generate()'s own memo validation, so an
        // uncapped comment would otherwise reach credit() at settlement time.
        invoice.memo = String(comment).slice(0, 512);
        await s(`invoice:${invoice.id}`, invoice);
      }

      l("lnurl invoice", invoice.id, "hash", invoice.hash?.slice(0, 20));
      return c.json({
        pr: invoice.text,
        routes: [],
        verify: `${URL}/api/lnurl/verify/${invoice.id}`,
      });
    } catch (e) {
      warn("lnurl callback error", id, e.message);
      return bail(c, e);
    }
  },

  async verify(c) {
    const id = c.req.param("id");
    const inv = await getInvoice(id);
    if (!inv) return c.json({ status: "ERROR", reason: "Not found" });

    const { hash, received, amount, preimage } = inv;
    const settled = received >= amount;

    return c.json({ pr: hash, status: "OK", settled, preimage: preimage || null });
  },

  async lnurlw(c) {
    const fundId = c.req.param("fundId");
    try {
      const balance = await getFundBalance(fundId);
      if (balance === null || balance <= 0)
        return c.json({ status: "ERROR", reason: "Fund not found or empty" });

      // Refuse at the request step too, so a disabled fund never advertises a
      // balance or hands out a k1 — the callback would reject the withdrawal
      // anyway, but only after the wallet had shown the user an amount it
      // could not actually take.
      if ((await g("fund:disabled")) || (await g(`fund:${fundId}:disabled`)))
        return c.json({ status: "ERROR", reason: "This fund has been disabled" });

      const k1 = v4();
      await s(`lnurlw:${k1}`, fundId);
      await db.expire(`lnurlw:${k1}`, 300);

      return c.json({
        tag: "withdrawRequest",
        callback: `${URL}/api/lnurlw/${fundId}/callback`,
        k1,
        defaultDescription: `Withdraw from fund ${fundId}`,
        minWithdrawable: 1000,
        maxWithdrawable: balance * 1000,
      });
    } catch (e) {
      warn("lnurlw request failed", fundId, e.message);
      return bail(c, e);
    }
  },

  async lnurlwCallback(c) {
    const fundId = c.req.param("fundId");
    const k1 = c.req.query("k1");
    const pr = c.req.query("pr");

    try {
      if (!k1 || !pr) fail("Missing k1 or pr");

      const storedFundId = await g(`lnurlw:${k1}`);
      if (storedFundId !== fundId)
        return c.json({ status: "ERROR", reason: "Invalid or expired k1" });

      // Claim the k1 atomically. The read above is not the claim: two callbacks
      // arriving together with the same k1 both saw it, both passed, and both
      // debited the fund — a single-use withdraw token paying twice whenever
      // the fund covered both invoices. DEL returns 1 to exactly one caller,
      // so the loser stops here. Deliberately not restored on payment failure:
      // the holder can request a fresh k1, and re-arming a spent token reopens
      // the same window.
      if (!(await db.del(`lnurlw:${k1}`)))
        return c.json({ status: "ERROR", reason: "Invalid or expired k1" });

      const decoded = await ln.decode(pr);
      const amount = Math.round(decoded?.amount_msat / 1000);
      // An amountless invoice, or anything ln.decode couldn't read, leaves
      // amount_msat undefined -> NaN, and NaN fails every comparison below:
      // `NaN <= 0` and `NaN > balance` are both false, so it sailed past the
      // amount and balance checks into tbFundDebit. BigInt(NaN) threw there,
      // which is the only reason this wasn't worse than a confusing log line.
      if (!Number.isFinite(amount) || amount <= 0) fail("Invalid invoice amount");

      const balance = await getFundBalance(fundId);
      if (amount > balance)
        return c.json({ status: "ERROR", reason: `Insufficient funds: ${balance} < ${amount}` });

      // Every stop control lives in debit(), which this path never calls — see
      // assertFundWithdrawable. Before this, a disabled fund (including one
      // auto-disabled because its founder was evicted), a global freeze, the
      // /locks kill files and the cumulative withdraw breaker were all
      // inoperative here.
      await assertFundWithdrawable(fundId, amount);

      const result: any = await tbFundDebit(fundId, amount, "Insufficient funds");
      if (result.err) return c.json({ status: "ERROR", reason: result.err });

      // Record who is taking the money, not just how much. A fund withdrawal
      // is unauthenticated by design, so the destination node and the client
      // IP are the only identity there is — and neither was kept, which left a
      // drained fund with nothing to trace it by.
      l(
        "lnurlw paying invoice from fund",
        fundId,
        amount,
        "to",
        decoded?.payee ?? "unknown",
        "ip",
        getClientIp(c) ?? "unknown",
      );

      try {
        await ln.xpay({
          invstring: pr.replace(/\s/g, "").toLowerCase(),
          maxfee: Math.max(5, Math.round(amount * 0.02)) * 1000,
          retry_for: 20,
        });

        recordFundWithdrawal(amount);
        await db.lPush(`fund:${fundId}:payments`, `lnurlw:${pr.slice(-8)}:${amount}`);
        l("lnurlw paid from fund", fundId, amount);
        return c.json({ status: "OK" });
      } catch (e) {
        warn("lnurlw payment failed, reversing fund debit", fundId, e.message);
        await tbFundCredit(fundId, amount);
        return c.json({ status: "ERROR", reason: "Payment failed" });
      }
    } catch (e) {
      warn("lnurlw callback failed", fundId, e.message);
      return c.json({ status: "ERROR", reason: e.message });
    }
  },

  async pay(c) {
    const amount = c.req.param("amount");
    const username = c.req.param("username");
    try {
      const user = await getUser(username);
      if (!user) fail(`User ${username} not found`, 404);

      const invoices = await db.lRange(`${user.id}:invoices`, 0, 10);
      let invoice;

      for (const iid of invoices) {
        const i = await getInvoice(iid);
        const paid = i.amount > 0 && i.received >= i.amount;
        const old = Date.now() - i.created > fiveMinutes;
        if (paid) break;
        if (i.own && !old) {
          invoice = i;
          break;
        }
      }

      if (invoice) {
        if (amount?.startsWith("+")) {
          const tip = invoice.amount * Number(amount.split("+")[1]);
          invoice = await generate({
            invoice: {
              ...invoice,
              tip,
            },
            user,
          });
        }
      } else {
        invoice = await generate({
          invoice: {
            amount,
            prompt: user.prompt,
            type: PaymentType.lightning,
          },
          user,
        });
      }

      const { id: uid } = user;

      const metadata = JSON.stringify([
        ["text/plain", `Paying ${username}@${host}`],
        ["text/identifier", `${username}@${host}`],
      ]);

      const id = v4();

      const total = (parseInt(invoice.amount || 0) + parseInt(invoice.tip || 0)) * 1000;

      await s(`lnurl:${id}`, uid, LNURL_TTL);
      if (total > 0) await s(`lnurl:${id}:invoice`, invoice.id, LNURL_TTL);

      return c.json({
        allowsNostr: true,
        minSendable: invoice.amount ? total : 1000,
        maxSendable: invoice.amount ? total : 10 * 1000 * SATS,
        metadata,
        nostrPubkey: serverPubkey2,
        commentAllowed: 512,
        callback: `${URL}/api/lnurl/${id}`,
        tag: "payRequest",
      });
    } catch (e) {
      if (!e.message.includes("found"))
        warn("problem generating lnurlp request", username, e.message);
      return bail(c, e);
    }
  },
};
