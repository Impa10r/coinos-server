import config from "$config";
import { archive, db, g, gf } from "$lib/db";
import { generate } from "$lib/invoices";
import ln from "$lib/ln";
import { err, l, warn } from "$lib/logging";
import { handleZap, serverPubkey, serverPubkey2, serverSecret, serverSecret2 } from "$lib/nostr";
import { sendInternal, sendKeysend, sendLightning } from "$lib/payments";
import { getBalance } from "$lib/tb";
import { fail, getInvoice, sleep } from "$lib/utils";
import { hexToBytes } from "@noble/hashes/utils.js";
import { Relay } from "nostr";
import { finalizeEvent, nip04, nip44 } from "nostr-tools";
import type { UnsignedEvent } from "nostr-tools";

const serverKeys = {
  [serverPubkey]: serverSecret,
  [serverPubkey2]: serverSecret2,
};

const result = (result) => ({ result });
const error = (error) => ({ error });

const methods = [
  "pay_keysend",
  "pay_invoice",
  "get_balance",
  "get_info",
  "make_invoice",
  "lookup_invoice",
  "list_transactions",
];

const week = 7 * 24 * 60 * 60;
const nwcEventMaxAgeSeconds = 5 * 60;
// Tolerated clock skew for future-dated events. Events further ahead than this
// are rejected so a captured, future-dated signed event can't be replayed later.
const nwcClockSkewSeconds = 60;
const handledKey = "handled:nwc";

// Per-pubkey rate limiting for NWC requests
const nwcRateLimit = config.nwcRateLimit ?? 60;
const nwcRateWindow = 60 * 1000; // 1 minute in ms
const nwcRequestTimes: Map<string, number[]> = new Map();

// Per-app async mutex for spends. checkBudget reads `${pubkey}:payments` and the
// spend is only recorded after the payment settles, so N concurrent requests on
// one connection would each read the same stale "spent" total and all pass —
// up to N × max_amount out. Serializing the check + send + record per app closes
// that window (same shape as withLimitLock for the asset-type limits).
const budgetLocks: Map<string, Promise<void>> = new Map();
const withBudgetLock = async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
  const prev = budgetLocks.get(key) || Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((res) => {
    release = res;
  });
  budgetLocks.set(key, prev.then(() => next));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
};
const budgetedMethods = new Set(["pay_invoice", "pay", "pay_keysend"]);

export default () => {
  let r: any;

  function connect() {
    r = new Relay(config.nostr, { reconnect: false });

    r.on("open", async (_) => {
      l("nwc connected to strfry");
      r.subscribe("nwc", {
        kinds: [23194],
        "#p": [serverPubkey, serverPubkey2],
        since: Math.floor(Date.now() / 1000) - nwcEventMaxAgeSeconds,
      });
      const info = await finalizeEvent(
        {
          created_at: Math.floor(Date.now() / 1000),
          kind: 13194,
          tags: [
            ["p", serverPubkey],
            ["notifications", "payment_received payment_sent"],
          ],
          content: methods.join(" "),
        },
        hexToBytes(serverSecret),
      );
      r.send(["EVENT", info]);

      const info2 = await finalizeEvent(
        {
          created_at: Math.floor(Date.now() / 1000),
          kind: 13194,
          tags: [
            ["p", serverPubkey2],
            ["notifications", "payment_received payment_sent"],
          ],
          content: methods.join(" "),
        },
        hexToBytes(serverSecret2),
      );
      r.send(["EVENT", info2]);
    });

    r.on("close", () => {
      warn("nwc strfry connection lost, reconnecting in 5s");
      setTimeout(connect, 5000);
    });

    r.on("error", () => {});

    r.on("event", async (sub, ev) => {
      try {
        if (sub !== "nwc") return;
        const now = Math.floor(Date.now() / 1000);
        const age = now - ev.created_at;
        l("nwc event", ev.id.slice(0, 8), "pubkey", ev.pubkey.slice(0, 8), "age", age);
        // Reject events outside the accepted window in BOTH directions. Old events
        // are stale; future-dated ones (beyond a small skew) could otherwise be
        // replayed indefinitely once a time-bounded dedup entry expired.
        if (ev.created_at) {
          if (age > nwcEventMaxAgeSeconds) {
            warn("nwc event too old", age, ev.id.slice(0, 8));
            return;
          }
          if (-age > nwcClockSkewSeconds) return;
        }
        // Atomic dedup claim. SET NX is a single-command check-and-set, so two
        // concurrent deliveries of the same signed event cannot both pass — the
        // previous zScore-then-(unawaited)-zAdd let duplicate relay deliveries each
        // reach handle() and pay twice. The claim outlives the accepted age window
        // so a future-dated event can't be replayed after it would have expired.
        if (
          !(await db.set(`${handledKey}:${ev.id}`, "1", {
            NX: true,
            EX: 2 * nwcEventMaxAgeSeconds,
          }))
        ) {
          warn("nwc event already handled", ev.id.slice(0, 8));
          return;
        }

        // Per-pubkey rate limiting
        const times = nwcRequestTimes.get(ev.pubkey) || [];
        const cutoff = Date.now() - nwcRateWindow;
        const recent = times.filter((t) => t > cutoff);
        if (recent.length >= nwcRateLimit) {
          warn("nwc rate limit", ev.pubkey);
          const rlPk = ev.tags.find((t) => t[0] === "p")[1];
          const rlSk = serverKeys[rlPk];
          const payload = JSON.stringify({
            result_type: "rate_limited",
            error: { code: "RATE_LIMITED", message: "Too many requests" },
          });
          const rlContent = await nip04.encrypt(rlSk, ev.pubkey, payload);
          let response: UnsignedEvent = {
            created_at: Math.floor(Date.now() / 1000),
            kind: 23195,
            pubkey: rlPk,
            tags: [
              ["p", ev.pubkey],
              ["e", ev.id],
            ],
            content: rlContent,
          };
          response = await finalizeEvent(response, hexToBytes(rlSk));
          r.send(["EVENT", response]);
          return;
        }
        recent.push(Date.now());
        nwcRequestTimes.set(ev.pubkey, recent);

        let { content, pubkey } = ev;
        const pk = ev.tags.find((t) => t[0] === "p")[1];
        const sk = serverKeys[pk];
        const skBytes = hexToBytes(sk);
        const convKey = nip44.v2.utils.getConversationKey(skBytes, pubkey);
        let isNip44 = ev.tags.some((t: string[]) => t[0] === "encryption" && t[1] === "nip44_v2");
        let decrypted: string;
        if (isNip44) {
          decrypted = nip44.v2.decrypt(content, convKey);
        } else {
          try {
            decrypted = await nip04.decrypt(sk, pubkey, content);
          } catch (e04) {
            try {
              decrypted = nip44.v2.decrypt(content, convKey);
              isNip44 = true;
            } catch (e44) {
              warn(
                "nwc decrypt failed nip04:",
                e04.message,
                "nip44:",
                e44.message,
                "content:",
                content.slice(0, 20),
              );
              throw e04;
            }
          }
        }
        const { params, method } = JSON.parse(decrypted);

        l("nwc method", method, "pubkey", pubkey.slice(0, 8), "params", JSON.stringify(params));

        if (!methods.includes(method)) return;

        try {
          const app = await g(`app:${pubkey}`);
          if (!app) {
            warn("nwc app not found for pubkey", pubkey.slice(0, 8));
            fail("pubkey not found");
          }
          const user = await g(`user:${app.uid}`);

          // Serialize budget-affecting methods per app so the budget check and the
          // resulting spend can't interleave with a concurrent request on the same
          // connection. Read-only methods run without contending for the lock.
          const run = () => handle(method, params, ev, app, user);
          const result = budgetedMethods.has(method)
            ? await withBudgetLock(app.pubkey, run)
            : await run();
          const payload = JSON.stringify({ result_type: method, ...result });
          const convKey = nip44.v2.utils.getConversationKey(skBytes, pubkey);
          content = isNip44
            ? nip44.v2.encrypt(payload, convKey)
            : await nip04.encrypt(sk, pubkey, payload);

          const responseTags: string[][] = [
            ["p", pubkey],
            ["e", ev.id],
          ];
          if (isNip44) responseTags.push(["encryption", "nip44_v2"]);

          let response: UnsignedEvent = {
            created_at: Math.floor(Date.now() / 1000),
            kind: 23195,
            pubkey: serverPubkey,
            tags: responseTags,
            content,
          };

          response = await finalizeEvent(response, hexToBytes(sk));
          r.send(["EVENT", response]);
        } catch (e) {
          err("problem with nwc", pubkey, method, JSON.stringify(params), e.message);
          try {
            const payload = JSON.stringify({
              result_type: method,
              error: { code: "INTERNAL", message: e.message },
            });
            content = isNip44
              ? nip44.v2.encrypt(payload, nip44.v2.utils.getConversationKey(skBytes, pubkey))
              : await nip04.encrypt(sk, pubkey, payload);
            const errTags: string[][] = [
              ["p", pubkey],
              ["e", ev.id],
            ];
            if (isNip44) errTags.push(["encryption", "nip44_v2"]);
            let response: UnsignedEvent = {
              created_at: Math.floor(Date.now() / 1000),
              kind: 23195,
              pubkey: serverPubkey,
              tags: errTags,
              content,
            };
            response = await finalizeEvent(response, hexToBytes(sk));
            r.send(["EVENT", response]);
          } catch {}
        }
      } catch (e) {
        err("problem with nwc", e.message);
      }
    });
  }

  connect();
};

// Connection validity + spending budget for an NWC app, shared by pay_invoice
// and pay_keysend. Returns a NIP-47 error payload, or null when the spend is allowed.
const checkBudget = async (app, amount) => {
  const { max_amount, budget_renewal, pubkey, created } = app;

  if (!created) {
    return error({
      code: "UNAUTHORIZED",
      message: `This NWC connection is no longer valid please create a new one at https://${config.domain}/settings/nostr`,
    });
  }

  const periods = {
    daily: 60 * 60 * 24 * 1000,
    weekly: 60 * 60 * 24 * 7 * 1000,
    monthly: 60 * 60 * 24 * 30 * 1000,
    yearly: 60 * 60 * 24 * 365 * 1000,
    never: 60 * 60 * 24 * 365 * 10 * 1000,
  };

  const pids = await db.lRange(`${pubkey}:payments`, 0, -1);
  let payments = await Promise.all(pids.map((pid) => g(`payment:${pid}`)));
  payments = payments.filter((p) => p?.created > Date.now() - periods[budget_renewal]);

  const spent = payments.reduce(
    (a, b) =>
      a +
      (Math.abs(Number.parseInt(b.amount || 0)) +
        Number.parseInt(b.tip || 0) +
        Number.parseInt(b.fee || 0) +
        Number.parseInt(b.ourfee || 0)),
    0,
  );

  if (max_amount > 0 && spent + amount > max_amount) {
    return error({
      code: "QUOTA_EXCEEDED",
      message: `Budget exceeded: ${spent + amount} of ${max_amount}`,
    });
  }

  return null;
};

const handle = (method, params, ev, app, user) =>
  ({
    async pay_invoice() {
      const { invoice: pr, metadata } = params;

      if (!pr) return error({ code: "OTHER", message: "invoice is required" });
      
      const { amount_msat, payee } = await ln.decode(pr);
      const { id } = await ln.getinfo();
      const amount = Math.round(amount_msat / 1000);
      const { max_amount, max_fee, budget_renewal, pubkey, created } = app;

      const periods = {
        daily: 60 * 60 * 24 * 1000,
        weekly: 60 * 60 * 24 * 7 * 1000,
        monthly: 60 * 60 * 24 * 30 * 1000,
        yearly: 60 * 60 * 24 * 365 * 1000,
        never: 60 * 60 * 24 * 365 * 10 * 1000,
      };

      const pids = await db.lRange(`${pubkey}:payments`, 0, -1);
      let payments = await Promise.all(pids.map((pid) => g(`payment:${pid}`)));
      payments = payments.filter((p) => p?.created > Date.now() - periods[budget_renewal]);

      const spent = payments.reduce(
        (a, b) =>
          a +
          (Math.abs(Number.parseInt(b.amount || 0)) +
            Number.parseInt(b.tip || 0) +
            Number.parseInt(b.fee || 0) +
            Number.parseInt(b.ourfee || 0)),
        0,
      );

      if (!created) {
        return error({
          code: "UNAUTHORIZED",
          message: `This NWC connection is no longer valid please create a new one at https://${config.domain}/settings/nostr`,
        });
      }

      if (max_amount > 0 && spent + amount > max_amount) {
        // warn(
        //   "budget exceeded",
        //   pubkey,
        //   user?.username,
        //   spent,
        //   amount,
        //   max_amount,
        // );
        return error({
          code: "QUOTA_EXCEEDED",
          message: `Budget exceeded: ${spent + amount} of ${max_amount}`,
        });
      }

      if (payee === id) {
        const invoice = await getInvoice(pr);
        const recipient = await g(`user:${invoice.uid}`);

        if (recipient?.username !== "mint") {
          const { id: pid } = await sendInternal({
            amount,
            invoice,
            recipient,
            sender: user,
          });

          const preimage = pid;
          if (pubkey !== user.pubkey) await db.lPush(`${pubkey}:payments`, pid);

          if (invoice.memo?.includes("9734")) {
            const { invoices } = await ln.listinvoices({ invstring: pr });
            const inv = invoices[0];
            inv.payment_preimage = preimage;
            inv.paid_at = Math.floor(Date.now() / 1000);
            try {
              await handleZap(inv, user.pubkey);
            } catch (e) {
              console.log("zap receipt failed", e);
            }
          }

          return result({ preimage });
        }
      }

      try {
        const { id: pid } = await sendLightning({
          amount,
          fee: max_fee > 0 ? max_fee : undefined,
          user,
          pr,
          memo: metadata && Object.keys(metadata).length > 0 ? JSON.stringify(metadata) : undefined,
          retryFor: 25,
        });

        await db.lPush(`${pubkey}:payments`, pid);

        // The preimage is attached asynchronously by the payment finalizer.
        // Poll the payment for up to 100 seconds to resolve the race condition
        // where NWC asks for the preimage before finalization has saved it.
        for (let i = 0; i < 100; i++) {
          const p = await g(`payment:${pid}`);
          if (p?.ref) return result({ preimage: p.ref });
          await sleep(1000);
        }
      } catch (e) {
        return error({ code: "INTERNAL", message: e.message });
      }

      return error({ code: "INTERNAL", message: "Preimage not available" });
    },

    async pay_keysend() {
      const { amount: amount_msat, pubkey, tlv_records } = params;
      const amount = Math.round(amount_msat / 1000);
      const extratlvs = {};

      // convert tlv_records to the extratlvs format
      // tlv_records: [{ type: 1, value: "asdf" }]
      // extratlvs: { "1": "asdf" }
      if (tlv_records && tlv_records.length) {
        for (const record of tlv_records) {
          extratlvs[record.type.toString()] = record.value;
        }
      }

      // Keysend spends the same custodial balance as pay_invoice, so it must be
      // subject to the same budget — otherwise a budget-limited connection string
      // is a full-drain credential. It also left no `${app.pubkey}:payments`
      // entry, so subsequent budgeted calls under-counted the spend.
      const budgetError = await checkBudget(app, amount);
      if (budgetError) return budgetError;

      try {
        const { payment_hash } = await sendKeysend({
          hash: ev.id,
          amount,
          pubkey,
          user,
          extratlvs,
          fee: app.max_fee,
        });

        // Record the debit against the app budget. debit() stored the payment id
        // under the keysend label (= ev.id); resolve and push it so checkBudget
        // counts this spend going forward.
        const pid = await g(`payment:${ev.id}`);
        if (pid) await db.lPush(`${app.pubkey}:payments`, pid);

        for (let i = 0; i < 10; i++) {
          const { pays } = await ln.listpays({ payment_hash });
          const p = pays.find((p) => p.status === "complete");
          if (p) {
            const { preimage } = p;
            return result({ preimage });
          }
          await sleep(2000);
        }

        return error({ code: "INTERNAL", message: "Payment timed out" });
      } catch {
        return error({ code: "INTERNAL", message: "Keysend payment failed" });
      }
    },

    async get_info() {
      const { alias, blockheight, color, id } = await ln.getinfo();

      return result({
        alias,
        block_height: blockheight,
        color,
        pubkey: id,
        network: "mainnet",
        methods,
        notifications: ["payment_received", "payment_sent"],
      });
    },

    async get_balance() {
      let balance = await getBalance(user.id);
      balance *= 1000;
      return result({ balance });
    },

    async make_invoice() {
      const { amount, description, description_hash, expiry } = params;
      // l("nwc make_invoice", user.username);

      const invoice = {
        amount: Math.round(amount / 1000),
        type: "lightning",
        memo: description,
        expiry,
      };

      const { hash, created: created_at, paymentHash } = await generate({ invoice, user });

      return result({
        type: "incoming",
        invoice: hash,
        description,
        description_hash,
        amount,
        created_at,
        expires_at: created_at + expiry,
        fees_paid: 0,
        payment_hash: paymentHash,
        metadata: {},
      });
    },

    async lookup_invoice() {
      let { invoice, payment_hash } = params;

      const { invoices } = await ln.listinvoices({
        invstring: invoice,
        payment_hash,
      });

      if (invoices.length) {
        const {
          amount_received_msat: amount,
          description,
          expires_at,
          paid_at: settled_at,
        } = invoices[0];

        ({ bolt11: invoice, payment_hash } = invoices[0]);
        const { preimage, settled } = await getInvoice(invoice);

        return result({
          type: "incoming",
          invoice,
          description,
          preimage,
          payment_hash,
          amount,
          fees_paid: 0,
          created_at: expires_at - week,
          expires_at,
          settled_at: settled_at || Math.round(settled / 1000),
          state: settled ? "settled" : "pending",
          status: settled ? "paid" : "pending",
        });
      }

      const { pays } = await ln.listpays({ bolt11: invoice, payment_hash });

      if (!pays.length) return error({ code: "NOT_FOUND", message: "Invoice not found" });

      const {
        amount_msat: amount,
        amount_sent_msat,
        created_at,
        preimage,
        completed_at: settled_at,
      } = pays[0];

      ({ bolt11: invoice, payment_hash } = pays[0]);

      return result({
        type: "outgoing",
        invoice,
        preimage,
        payment_hash,
        amount,
        fees_paid: amount_sent_msat - amount,
        created_at,
        settled_at,
      });
    },

    async list_transactions() {
      const { from, until, limit = 10, offset = 0, type } = params;

      const listKey = `${user.id}:payments`;
      const main = (await db.lRange(listKey, 0, -1)) || [];
      const archived = (await archive.lRange(listKey, 0, -1)) || [];
      const payments = [...new Set([...main, ...archived])];

      let transactions = [];
      for (const pid of payments) {
        const p = await gf(`payment:${pid}`);
        if (!p) continue;
        const created_at = Math.floor(p.created / 1000);
        if (created_at < from || created_at > until) continue;
        if (p.amount < 0 && type === "incoming") continue;
        if (p.amount > 0 && type === "outgoing") continue;

        let payment_hash = p.payment_hash;
        if (!payment_hash && p.type === "lightning") {
          try {
            if (p.amount > 0) {
              const { invoices } = await ln.listinvoices({ invstring: p.hash });
              payment_hash = invoices[0]?.payment_hash;
            } else {
              const { pays } = await ln.listpays({ bolt11: p.hash });
              payment_hash = pays[0]?.payment_hash;
            }
          } catch {}
        }
        payment_hash = payment_hash || pid;

        transactions.push({
          type: p.amount > 0 ? "incoming" : "outgoing",
          invoice: p.hash,
          description: p.memo,
          preimage: p.ref,
          payment_hash,
          amount: (Math.abs(p.amount) + (p.tip || 0)) * 1000,
          fees_paid: (p?.fee || 0) * 1000,
          created_at,
          expires_at: created_at + week,
          settled_at: created_at,
          state: "settled",
          metadata: {},
        });
      }

      transactions = transactions.slice(offset, offset + limit);
      return result({ transactions });
    },
  })[method](params);
